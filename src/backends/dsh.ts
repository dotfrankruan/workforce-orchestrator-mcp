import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { WorkerBackend, WorkerBackendHandle, BackendStartOptions, BackendEvents, BackendMetadata } from './types.js';

export interface DshBackendOptions {
  dshBin: string;
  profile: string;
}

/**
 * Runs DeepSeek Harness as the worker runtime:
 *
 *   /usr/local/bin/dsh --profile headless --json [--session-id <id>] "<prompt>"
 *
 * Durability by construction: the child's stdout/stderr are redirected
 * DIRECTLY to the durable log files (stdout.jsonl / stderr.log), never
 * through a pipe owned by this process — so the worker keeps writing even if
 * the supervisor dies. The supervisor parses the file via its tailer
 * (reattach path and live path share that machinery). Exit codes come from
 * the ChildProcess handle while attached; after a reattach they are
 * unavailable and left null (never fabricated).
 *
 * Always spawned with an argv array — never a shell string. Credentials are
 * left to dsh itself (~/.dsh/.env); this process never reads or forwards them.
 */
export class DshBackend implements WorkerBackend {
  readonly id = 'dsh';
  readonly displayName = 'DeepSeek Harness';
  readonly capabilities = {
    continuation: true,
    durableReattach: true,
    structuredEvents: true,
    usageReporting: true,
    toolCallEvents: true,
    artifacts: true,
  } as const;
  /** Marker expected in the worker process command line (reattach identity). */
  readonly processMarker = 'dsh';
  /** stdout/stderr go straight to files; the supervisor tails them. */
  readonly durableStdout = true;

  constructor(private opts: DshBackendOptions) {}

  /** Local availability only: executable exists and is runnable. No API calls. */
  isAvailable(): boolean {
    try {
      fs.accessSync(this.opts.dshBin, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Runtime facts known locally; provider/model intentionally null (never guessed). */
  metadata(): BackendMetadata {
    return {
      runtime: { name: 'DeepSeek Harness', version: this.version() ?? undefined },
      provider: { name: undefined, model: undefined },
    };
  }

  private versionCache: string | null | undefined;
  private version(): string | null {
    if (this.versionCache !== undefined) return this.versionCache;
    try {
      const out = execFileSync(this.opts.dshBin, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim();
      this.versionCache = out || null;
    } catch {
      this.versionCache = null;
    }
    return this.versionCache;
  }

  start(opts: BackendStartOptions, events: BackendEvents): WorkerBackendHandle {
    const args = ['--profile', this.opts.profile, '--json'];
    if (opts.sessionId) {
      args.push('--session-id', opts.sessionId);
    }
    // Note: our prompts always start with "You are" / "The supervising",
    // never with "-", so no option/operand separator is needed (and dsh does
    // not document one).
    args.push(opts.prompt);

    let outFd: number;
    let errFd: number;
    let child: ChildProcess;
    try {
      outFd = fs.openSync(opts.stdoutPath, 'a');
      errFd = fs.openSync(opts.stderrPath, 'a');
      child = spawn(this.opts.dshBin, args, {
        cwd: opts.cwd,
        env: process.env,
        stdio: ['ignore', outFd, errFd],
      });
    } catch (err) {
      queueMicrotask(() => {
        events.onSpawnError?.(err as Error);
        events.onExit(null, null);
      });
      return new NullHandle();
    }

    const closeFds = () => {
      try { fs.closeSync(outFd); } catch { /* ignore */ }
      try { fs.closeSync(errFd); } catch { /* ignore */ }
    };

    let exited = false;
    child.on('error', (err) => {
      if (exited) return;
      exited = true;
      closeFds();
      events.onSpawnError?.(err);
      events.onExit(null, null);
    });
    child.on('close', (code, signal) => {
      if (exited) return;
      exited = true;
      closeFds();
      events.onExit(code, signal);
    });

    return new DshHandle(child, () => exited);
  }
}

class NullHandle implements WorkerBackendHandle {
  readonly pid = null;
  async terminate(): Promise<void> {}
}

class DshHandle implements WorkerBackendHandle {
  private termPromise: Promise<void> | null = null;

  constructor(
    private child: ChildProcess,
    private isExited: () => boolean,
  ) {}

  get pid(): number | null {
    return this.child.pid ?? null;
  }

  terminate(graceMs: number): Promise<void> {
    if (this.termPromise) return this.termPromise;
    this.termPromise = this.doTerminate(graceMs);
    return this.termPromise;
  }

  private doTerminate(graceMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.isExited() || this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };
      const killTimer = setTimeout(() => {
        try {
          this.child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        setTimeout(done, 200).unref();
      }, graceMs);
      killTimer.unref();

      this.child.once('close', () => {
        clearTimeout(killTimer);
        done();
      });

      try {
        this.child.kill('SIGTERM');
      } catch {
        clearTimeout(killTimer);
        done();
      }
    });
  }
}
