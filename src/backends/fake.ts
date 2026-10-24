import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseDshLine } from '../parser.js';
import type { WorkerBackend, WorkerBackendHandle, BackendStartOptions, BackendEvents } from './types.js';
import type { WorkerEvent } from './events.js';
import { normalizeDshEvent } from './events.js';
import type { DshEvent } from '../parser.js';

/**
 * FakeWorkerBackend — simulates a dsh run for tests and local development,
 * without calling a real provider API.
 *
 * A scenario is a list of steps executed in order. Steps can emit events,
 * write files into the worktree, make git commits, sleep, or hang forever
 * (until terminate() is called).
 */

export type FakeStep =
  | { emit: Record<string, unknown> } // emitted as a JSON event
  | { emitRaw: string } // emitted verbatim (for malformed JSON tests)
  | { writeFile: { path: string; content: string } }
  | { appendFile: { path: string; content: string } }
  | { git: string[] } // run git with these args inside the worktree
  | { sleep: number } // milliseconds
  | { hang: true }; // never finish (until terminated)

export interface FakeScenario {
  steps: FakeStep[];
  exitCode?: number; // default 0
}

export interface FakeBackendOptions {
  /** Scenario picker: receives whether this is a fresh run or a session resume. */
  scenario: (info: { workerId: string; resume: boolean; prompt: string; cwd: string }) => FakeScenario;
}

function stepToLine(step: FakeStep): string | null {
  if ('emit' in step) return JSON.stringify(step.emit);
  if ('emitRaw' in step) return step.emitRaw;
  return null;
}

export class FakeBackend implements WorkerBackend {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities = {
    continuation: true,
    durableReattach: false,
    structuredEvents: true,
    usageReporting: true,
    toolCallEvents: true,
    artifacts: true,
  } as const;

  constructor(
    private options: FakeBackendOptions,
    id = 'fake',
  ) {
    this.id = id;
    this.displayName = `FakeBackend(${id})`;
  }

  isAvailable(): boolean {
    return true;
  }

  normalizeEvent(raw: DshEvent): WorkerEvent[] {
    return normalizeDshEvent(raw);
  }

  start(opts: BackendStartOptions, events: BackendEvents): WorkerBackendHandle {
    const scenario = this.options.scenario({
      workerId: opts.workerId,
      resume: opts.sessionId !== null,
      prompt: opts.prompt,
      cwd: opts.cwd,
    });

    const state = {
      terminated: false,
      finished: false,
      timers: new Set<NodeJS.Timeout>(),
    };

    // Synchronous appends keep the on-disk log consistent with emitted
    // events (callers may read the log as soon as a run finishes).
    fs.closeSync(fs.openSync(opts.stdoutPath, 'a'));
    fs.closeSync(fs.openSync(opts.stderrPath, 'a'));

    const finish = (code: number | null, signal: string | null) => {
      if (state.finished) return;
      state.finished = true;
      for (const t of state.timers) clearTimeout(t);
      state.timers.clear();
      queueMicrotask(() => events.onExit(code, signal));
    };

    let byteOffset = 0;
    const emitLine = (line: string) => {
      fs.appendFileSync(opts.stdoutPath, line + '\n');
      byteOffset += Buffer.byteLength(line, 'utf8') + 1;
      const ev = parseDshLine(line);
      if (ev) {
        ev.byteOffset = byteOffset;
        events.onEvent(ev);
      }
    };

    const runSteps = async () => {
      const sessionId = opts.sessionId ?? `session-fake-${opts.workerId}`;
      // A fresh dsh run always starts with a session event; a resumed run
      // emits one for the adopted session too.
      emitLine(JSON.stringify({ type: 'session', sessionId, cwd: opts.cwd }));

      for (const step of scenario.steps) {
        if (state.terminated) return;

        const line = stepToLine(step);
        if (line !== null) {
          emitLine(line);
          continue;
        }
        if ('writeFile' in step) {
          const target = path.join(opts.cwd, step.writeFile.path);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, step.writeFile.content);
          continue;
        }
        if ('appendFile' in step) {
          const target = path.join(opts.cwd, step.appendFile.path);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.appendFileSync(target, step.appendFile.content);
          continue;
        }
        if ('git' in step) {
          execFileSync('git', step.git, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
          continue;
        }
        if ('sleep' in step) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, step.sleep);
            state.timers.add(t);
          });
          continue;
        }
        if ('hang' in step) {
          await new Promise<void>(() => {
            // Intentionally never resolves; terminate() short-circuits finish().
          });
          return;
        }
      }

      if (state.terminated) return;
      finish(scenario.exitCode ?? 0, null);
    };

    // Kick off asynchronously so callers can attach bookkeeping first.
    queueMicrotask(() => {
      runSteps().catch((err) => {
        events.onSpawnError?.(err as Error);
        finish(1, null);
      });
    });

    return {
      pid: null,
      terminate: async () => {
        if (state.finished) return;
        state.terminated = true;
        finish(null, 'SIGTERM');
      },
    };
  }
}

/** Convenience builders for common scenarios used by tests and docs. */
export const FakeScenarios = {
  /** Emits a realistic event sequence and finishes successfully. */
  success(finalText = 'Done.\n\nSummary:\n- implemented the change\n\nTests: all tests pass (npm test)'): FakeScenario {
    return {
      steps: [
        { emit: { type: 'status', phase: 'turn_start', turn: 1 } },
        { emit: { type: 'thinking', text: 'planning the change' } },
        { emit: { type: 'tool_call', callId: 'call-1', tool: 'bash', input: { command: 'ls' } } },
        { emit: { type: 'tool_result', callId: 'call-1', status: 'completed', result: 'ok' } },
        { emit: { type: 'text', text: 'implemented' } },
        {
          emit: {
            type: 'status',
            phase: 'step_end',
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheReadTokens: 40 },
          },
        },
        { emit: { type: 'final', text: finalText } },
      ],
      exitCode: 0,
    };
  },

  /** Writes a file and commits it, like a real successful worker would. */
  successWithCommit(
    file = 'hello.txt',
    content = 'hello from worker\n',
    message = 'worker change',
  ): FakeScenario {
    return {
      steps: [
        { emit: { type: 'status', phase: 'turn_start', turn: 1 } },
        { writeFile: { path: file, content } },
        { git: ['add', '-A'] },
        { git: ['-c', 'user.name=workforce-worker', '-c', 'user.email=workforce-worker@localhost', 'commit', '-m', message] },
        {
          emit: {
            type: 'status',
            phase: 'step_end',
            usage: { inputTokens: 200, outputTokens: 80, totalTokens: 280, cacheReadTokens: 100 },
          },
        },
        {
          emit: {
            type: 'final',
            text: `Summary:\n- updated ${file}\n\nTests: all tests pass (npm test)\n\nCommit: see git log`,
          },
        },
      ],
      exitCode: 0,
    };
  },

  /** Exits non-zero without a final event. */
  failure(exitCode = 1): FakeScenario {
    return {
      steps: [
        { emit: { type: 'status', phase: 'turn_start', turn: 1 } },
        { emit: { type: 'text', text: 'something broke' } },
      ],
      exitCode,
    };
  },

  /** Makes uncommitted changes and exits 0 — no commit. */
  noCommit(file = 'hello.txt', content = 'uncommitted change\n'): FakeScenario {
    return {
      steps: [
        { emit: { type: 'status', phase: 'turn_start', turn: 1 } },
        { writeFile: { path: file, content } },
        { emit: { type: 'final', text: 'Summary:\n- changed files but forgot to commit' } },
      ],
      exitCode: 0,
    };
  },

  /** Includes malformed stdout lines between valid events. */
  malformed(): FakeScenario {
    return {
      steps: [
        { emit: { type: 'status', phase: 'turn_start', turn: 1 } },
        { emitRaw: 'this is not json at all' },
        { emitRaw: '{"type":"text","text":"broken half' },
        { emit: { type: 'final', text: 'Summary:\n- survived malformed output' } },
      ],
      exitCode: 0,
    };
  },

  /** Runs forever until terminated (timeout / cancellation tests). */
  hang(): FakeScenario {
    return {
      steps: [
        { emit: { type: 'status', phase: 'turn_start', turn: 1 } },
        { emit: { type: 'thinking', text: 'working…' } },
        { hang: true },
      ],
    };
  },

  /** Completes only after a delay. */
  delayed(delayMs: number): FakeScenario {
    return {
      steps: [
        { sleep: delayMs },
        { emit: { type: 'final', text: 'Summary:\n- finished after delay' } },
      ],
      exitCode: 0,
    };
  },
};
