import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { WorkerBackend, WorkerBackendHandle, BackendStartOptions, BackendEvents, BackendMetadata } from './types.js';
import type { WorkerEvent } from './events.js';
import { normalizeDshEvent } from './events.js';
import { parseDshLine, type DshEvent } from '../parser.js';
import { isExecutable, resolveCommand } from '../util/executable.js';

export interface OpenCodeBackendOptions {
  /** Executable name/path. Default: opencode on PATH. */
  command: string;
  /** Optional provider/model passed as --model (e.g. anthropic/claude-sonnet-4-5). */
  model?: string | undefined;
  /** Optional agent name passed as --agent. */
  agent?: string | undefined;
  /** Auto-approve permissions not explicitly denied (--auto). Default true for headless workers. */
  autoApprove?: boolean | undefined;
  /** Additional CLI flags appended before the prompt (advanced). */
  extraArgs?: string[] | undefined;
}

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Parse one `opencode run --format json` NDJSON line into the canonical event
 * shape. Also accepts canonical lines emitted by this backend (e.g. the final
 * report synthesized at process exit).
 */
export function parseOpenCodeLine(line: string): DshEvent | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let obj: Json | null = null;
  try {
    obj = asObject(JSON.parse(trimmed));
  } catch {
    obj = null;
  }
  if (obj) {
    const part = asObject(obj['part']);
    const sessionId = typeof obj['sessionID'] === 'string' ? obj['sessionID'] : undefined;
    if (part && sessionId) {
      const type = typeof obj['type'] === 'string' ? obj['type'] : '';
      const base: DshEvent = { type: 'unknown', rawType: type, sessionId };
      switch (type) {
        case 'step_start': {
          base.type = 'status';
          base.phase = 'turn_start';
          return base;
        }
        case 'step_finish': {
          base.type = 'status';
          base.phase = 'step_end';
          const tokens = asObject(part['tokens']);
          if (tokens) {
            const cache = asObject(tokens['cache']);
            base.usage = {
              inputTokens: num(tokens['input']),
              outputTokens: num(tokens['output']),
              cacheReadTokens: cache ? num(cache['read']) : undefined,
              totalTokens:
                num(tokens['input']) !== undefined && num(tokens['output']) !== undefined
                  ? num(tokens['input'])! + num(tokens['output'])!
                  : undefined,
            };
          }
          return base;
        }
        case 'text': {
          const text = typeof part['text'] === 'string' ? part['text'] : undefined;
          return text === undefined ? null : { type: 'text', rawType: 'text', text, sessionId };
        }
        case 'tool_use': {
          const state = asObject(part['state']);
          const tool = typeof part['tool'] === 'string' ? part['tool'] : undefined;
          const callId = typeof part['callID'] === 'string' ? part['callID'] : undefined;
          const status = state && typeof state['status'] === 'string' ? state['status'] : undefined;
          return {
            type: 'tool_call',
            rawType: 'tool_use',
            ...(tool !== undefined ? { tool } : {}),
            ...(callId !== undefined ? { callId } : {}),
            ...(status !== undefined ? { status } : {}),
            sessionId,
          };
        }
        case 'error': {
          const err = asObject(obj['error']);
          const data = err ? asObject(err['data']) : null;
          const message =
            (data && typeof data['message'] === 'string' ? data['message'] : undefined) ??
            (err && typeof err['name'] === 'string' ? err['name'] : undefined) ??
            'opencode reported an error';
          return { type: 'error', rawType: 'error', message, sessionId };
        }
        default:
          return null;
      }
    }
    // Canonical DSH-shaped line (including the synthesized final event).
    const canonical = parseDshLine(trimmed);
    if (canonical && !canonical.malformed) return canonical;
  }
  return null;
}

function lastTextAndFinal(stdoutPath: string, fromOffset: number): { text: string | null; hasFinal: boolean } {
  let content = '';
  try {
    const size = fs.statSync(stdoutPath).size;
    if (size <= fromOffset) return { text: null, hasFinal: false };
    const fd = fs.openSync(stdoutPath, 'r');
    const buf = Buffer.alloc(size - fromOffset);
    fs.readSync(fd, buf, 0, buf.length, fromOffset);
    fs.closeSync(fd);
    content = buf.toString('utf8');
  } catch {
    return { text: null, hasFinal: false };
  }
  let text: string | null = null;
  let hasFinal = false;
  for (const line of content.split('\n')) {
    const ev = parseOpenCodeLine(line);
    if (!ev) continue;
    if (ev.type === 'text' && ev.text) text = ev.text;
    if (ev.type === 'final') hasFinal = true;
  }
  return { text, hasFinal };
}

/**
 * Runs OpenCode CLI as a worker runtime:
 *
 *   opencode run --format json --auto [--model M] [--agent A] [--session S] "<prompt>"
 *
 * stdout/stderr are redirected directly to durable log files (the supervisor
 * tails them via `parseLine`), so a supervisor restart can reattach while the
 * process is alive. Credentials/provider configuration stay with OpenCode.
 */
export class OpenCodeBackend implements WorkerBackend {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode';
  readonly capabilities = {
    continuation: true,
    durableReattach: true,
    structuredEvents: true,
    usageReporting: true,
    toolCallEvents: true,
    artifacts: true,
  } as const;
  readonly processMarker = 'opencode';
  readonly durableStdout = true;

  constructor(private opts: OpenCodeBackendOptions) {}

  isAvailable(): boolean {
    return resolveCommand(this.opts.command) !== null;
  }

  metadata(): BackendMetadata {
    return {
      runtime: { name: 'OpenCode', version: this.version() ?? undefined },
      provider: { name: undefined, model: this.opts.model },
    };
  }

  private versionCache: string | null | undefined;
  private version(): string | null {
    if (this.versionCache !== undefined) return this.versionCache;
    const command = resolveCommand(this.opts.command);
    if (!command) return (this.versionCache = null);
    try {
      const out = execFileSync(command, ['--version'], {
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

  parseLine(line: string): DshEvent | null {
    return parseOpenCodeLine(line);
  }

  normalizeEvent(raw: DshEvent): WorkerEvent[] {
    return normalizeDshEvent(raw);
  }

  start(opts: BackendStartOptions, events: BackendEvents): WorkerBackendHandle {
    const command = resolveCommand(this.opts.command);
    if (!command) {
      queueMicrotask(() => {
        events.onSpawnError?.(new Error(`opencode executable not found: ${this.opts.command}`));
        events.onExit(null, null);
      });
      return { pid: null, terminate: async () => {} };
    }

    const args = ['run', '--format', 'json'];
    if (this.opts.autoApprove !== false) args.push('--auto');
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.agent) args.push('--agent', this.opts.agent);
    if (opts.sessionId) args.push('--session', opts.sessionId);
    for (const extra of this.opts.extraArgs ?? []) args.push(extra);
    args.push(opts.prompt);

    fs.closeSync(fs.openSync(opts.stdoutPath, 'a'));
    fs.closeSync(fs.openSync(opts.stderrPath, 'a'));
    const startOffset = (() => {
      try {
        return fs.statSync(opts.stdoutPath).size;
      } catch {
        return 0;
      }
    })();

    let outFd: number;
    let errFd: number;
    let child: ChildProcess;
    try {
      outFd = fs.openSync(opts.stdoutPath, 'a');
      errFd = fs.openSync(opts.stderrPath, 'a');
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: process.env,
        stdio: ['ignore', outFd, errFd],
      });
    } catch (err) {
      queueMicrotask(() => {
        events.onSpawnError?.(err as Error);
        events.onExit(null, null);
      });
      return { pid: null, terminate: async () => {} };
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
      if (code === 0) {
        // OpenCode emits text/tool/step events but no terminal "final" line.
        // Persist the accumulated final answer so the supervisor sees a
        // normal completion with a report (never a fabricated success).
        try {
          const { text, hasFinal } = lastTextAndFinal(opts.stdoutPath, startOffset);
          if (!hasFinal && text) {
            fs.appendFileSync(opts.stdoutPath, JSON.stringify({ type: 'final', text }) + '\n');
          }
        } catch {
          /* best effort */
        }
      }
      closeFds();
      events.onExit(code, signal);
    });

    return new OpenCodeHandle(child, () => exited);
  }
}

class OpenCodeHandle implements WorkerBackendHandle {
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

/** Exported for availability diagnostics/tests. */
export function openCodeExecutable(command: string): boolean {
  return isExecutable(command) || resolveCommand(command) !== null;
}
