import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, ensureConfigDirs, type Config } from '../config.js';
import { WorkerStore } from '../db.js';
import { WorkerSupervisor } from '../supervisor.js';
import { FakeBackend, type FakeScenario } from '../backends/fake.js';

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_PAGER: 'cat' },
  });
}

/** Create a temporary git repo with one committed file. Returns its path. */
export function makeTempRepo(): string {
  const dir = makeTempDir('kwm-repo-');
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.name', 'test'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  // Test commits must not depend on the host's GPG agent.
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial commit'], dir);
  return dir;
}

export interface TestHarness {
  config: Config;
  store: WorkerStore;
  supervisor: WorkerSupervisor;
  root: string;
  cleanup: () => void;
}

export function makeHarness(
  scenario: (info: { workerId: string; resume: boolean; prompt: string; cwd: string }) => FakeScenario,
  overrides: { maxConcurrent?: number } = {},
): TestHarness {
  const root = makeTempDir('kwm-root-');
  const config = loadConfig({
    env: {
      WORKFORCE_MAX_CONCURRENT: String(overrides.maxConcurrent ?? 4),
      WORKFORCE_TERMINATE_GRACE_MS: '200',
    },
    workerRoot: root,
  });
  ensureConfigDirs(config);
  const store = new WorkerStore(config.dbPath);
  const backend = new FakeBackend({ scenario });
  const supervisor = new WorkerSupervisor(config, store, backend);
  return {
    config,
    store,
    supervisor,
    root,
    cleanup: () => {
      try {
        store.close();
      } catch {
        /* already closed */
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Harness backed by real child processes (for durable-supervision tests). */
export function makeProcHarness(
  scenario: (info: { workerId: string; resume: boolean }) => { steps: ProcStep[]; exitCode?: number },
  overrides: { maxConcurrent?: number } = {},
): TestHarness & { backend: ProcScriptBackend } {
  const root = makeTempDir('kwm-root-');
  const config = loadConfig({
    env: {
      WORKFORCE_MAX_CONCURRENT: String(overrides.maxConcurrent ?? 4),
      WORKFORCE_TERMINATE_GRACE_MS: '200',
    },
    workerRoot: root,
  });
  ensureConfigDirs(config);
  const store = new WorkerStore(config.dbPath);
  const backend = new ProcScriptBackend(scenario);
  const supervisor = new WorkerSupervisor(config, store, backend);
  return {
    config,
    store,
    supervisor,
    backend,
    root,
    cleanup: () => {
      try {
        store.close();
      } catch {
        /* already closed */
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/* ------------------------------------------------------------------ *
 * ProcScriptBackend — test backend spawning REAL child processes
 * (node -e scripts) so supervision tests get genuine PIDs, real files,
 * real process death, and real ps identity.
 * ------------------------------------------------------------------ */

import { spawn, type ChildProcess } from 'node:child_process';
import type {
  WorkerBackend,
  WorkerBackendHandle,
  BackendStartOptions,
  BackendEvents,
} from '../backends/types.js';
import { parseDshLine, type DshEvent } from '../parser.js';
import { normalizeDshEvent as normalizeDshEventForTest } from '../backends/events.js';

export interface ProcStep {
  emit?: Record<string, unknown>;
  sleep?: number; // ms
  write?: { path: string; content: string };
}

const CHILD_MARKER = 'workforce-worker-proc-script';

/**
 * The child writes DSH-shaped JSONL to its stdout (which the backend pipes
 * through to the supervisor AND appends to stdoutPath — durable log),
 * executing write steps in the worktree. Exits with the scenario exit code.
 */
export class ProcScriptBackend implements WorkerBackend {
  readonly name = 'procscript';
  readonly id = 'procscript';
  readonly displayName = 'ProcScriptBackend';
  readonly capabilities = {
    modelSelection: true,
    continuation: true,
    durableReattach: true,
    structuredEvents: true,
    usageReporting: true,
    toolCallEvents: true,
    artifacts: true,
  } as const;
  readonly processMarker = CHILD_MARKER;

  isAvailable(): boolean {
    return true;
  }

  normalizeEvent(raw: import('../parser.js').DshEvent) {
    return normalizeDshEventForTest(raw);
  }

  constructor(private scenario: (info: { workerId: string; resume: boolean }) => { steps: ProcStep[]; exitCode?: number }) {}

  start(opts: BackendStartOptions, events: BackendEvents): WorkerBackendHandle {
    fs.closeSync(fs.openSync(opts.stdoutPath, 'a'));
    fs.closeSync(fs.openSync(opts.stderrPath, 'a'));

    const scenario = this.scenario({ workerId: opts.workerId, resume: opts.sessionId !== null });
    const script = `
      // ${CHILD_MARKER}
      const fs = require('fs');
      const path = require('path');
      const s = JSON.parse(process.env.KWM_SCENARIO);
      const line = (o) => { const l = JSON.stringify(o); fs.appendFileSync(process.env.KWM_STDOUT, l + '\\n'); process.stdout.write(l + '\\n'); };
      (async () => {
        line({ type: 'session', sessionId: 'session-${opts.workerId}', cwd: process.cwd() });
        for (const st of s.steps) {
          if (st.sleep) await new Promise((r) => setTimeout(r, st.sleep));
          if (st.write) {
            const t = path.join(process.cwd(), st.write.path);
            fs.mkdirSync(path.dirname(t), { recursive: true });
            fs.writeFileSync(t, st.write.content);
          }
          if (st.emit) line(st.emit);
        }
        process.exit(s.exitCode ?? 0);
      })();
    `;

    let child: ChildProcess;
    let byteOffset = 0;
    let lineBuf = '';
    let exited = false;

    const drain = (chunk: string) => {
      if (exited) return;
      lineBuf += chunk;
      let idx: number;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const l = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        byteOffset += Buffer.byteLength(l, 'utf8') + 1;
        const ev = parseDshLine(l);
        if (ev) {
          ev.byteOffset = byteOffset;
          events.onEvent(ev);
        }
      }
    };

    try {
      child = spawn(process.execPath, ['-e', script], {
        cwd: opts.cwd,
        env: {
          ...process.env,
          KWM_SCENARIO: JSON.stringify(scenario),
          KWM_STDOUT: opts.stdoutPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      queueMicrotask(() => {
        events.onSpawnError?.(err as Error);
        events.onExit(null, null);
      });
      return { pid: null, terminate: async () => {} };
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', drain);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => fs.appendFileSync(opts.stderrPath, c));

    child.on('error', (err) => {
      if (exited) return;
      exited = true;
      events.onSpawnError?.(err);
      events.onExit(null, null);
    });
    child.on('close', (code, signal) => {
      if (exited) return;
      exited = true;
      if (lineBuf.trim()) {
        const ev = parseDshLine(lineBuf);
        if (ev) events.onEvent(ev);
      }
      events.onExit(code, signal);
    });

    return {
      get pid() {
        return child.pid ?? null;
      },
      terminate: async (graceMs: number) => {
        if (exited) return;
        try {
          child.kill('SIGTERM');
        } catch {
          return;
        }
        const deadline = Date.now() + graceMs;
        while (!exited && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        if (!exited) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* gone */
          }
        }
      },
    };
  }
}
