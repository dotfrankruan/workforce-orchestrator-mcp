import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { parseDshLine } from '../parser.js';
import type { WorkerBackend, WorkerBackendHandle, BackendStartOptions, BackendEvents } from './types.js';

export interface DshBackendOptions {
  dshBin: string;
  profile: string;
}

/**
 * Runs DeepSeek Harness as the worker runtime:
 *
 *   /usr/local/bin/dsh --profile headless --json [--session-id <id>] "<prompt>"
 *
 * Always spawned with an argv array — never through a shell — so the prompt
 * and session id cannot be used for shell injection. Credentials are left to
 * dsh itself (~/.dsh/.env); this process never reads or forwards them.
 */
export class DshBackend implements WorkerBackend {
  readonly name = 'dsh';
  /** Marker expected in the worker process command line (reattach identity). */
  readonly processMarker = 'dsh';

  constructor(private opts: DshBackendOptions) {}

  start(opts: BackendStartOptions, events: BackendEvents): WorkerBackendHandle {
    const args = ['--profile', this.opts.profile, '--json'];
    if (opts.sessionId) {
      args.push('--session-id', opts.sessionId);
    }
    // Note: our prompts always start with "You are" / "The supervising",
    // never with "-", so no option/operand separator is needed (and dsh does
    // not document one).
    args.push(opts.prompt);

    // Synchronous appends: the on-disk log stays consistent with the event
    // stream even if the process exits abruptly, and nothing is lost in a
    // half-flushed stream buffer.
    fs.closeSync(fs.openSync(opts.stdoutPath, 'a'));
    fs.closeSync(fs.openSync(opts.stderrPath, 'a'));

    let child: ChildProcess;
    try {
      child = spawn(this.opts.dshBin, args, {
        cwd: opts.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      // Defer so callers can finish wiring handlers.
      queueMicrotask(() => {
        events.onSpawnError?.(err as Error);
        events.onExit(null, null);
      });
      return new NullHandle();
    }

    let exited = false;
    let lineBuf = '';
    let byteOffset = 0;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      try {
        fs.appendFileSync(opts.stdoutPath, chunk);
      } catch {
        /* log dir gone — keep parsing regardless */
      }
      lineBuf += chunk;
      let idx: number;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        byteOffset += Buffer.byteLength(line, 'utf8') + 1;
        const ev = parseDshLine(line);
        if (ev) {
          ev.byteOffset = byteOffset;
          events.onEvent(ev);
        }
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      try {
        fs.appendFileSync(opts.stderrPath, chunk);
      } catch {
        /* log dir gone */
      }
      events.onStderr?.(chunk);
    });

    child.on('error', (err) => {
      // spawn failure (e.g. ENOENT) — 'close' may not fire reliably.
      if (exited) return;
      exited = true;
      events.onSpawnError?.(err);
      events.onExit(null, null);
    });

    child.on('close', (code, signal) => {
      if (exited) return;
      exited = true;
      // Flush any trailing line without a newline.
      if (lineBuf.trim() !== '') {
        const ev = parseDshLine(lineBuf);
        if (ev) events.onEvent(ev);
        lineBuf = '';
      }
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
        // Give the OS a moment to reap; 'close' will call done() anyway.
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
