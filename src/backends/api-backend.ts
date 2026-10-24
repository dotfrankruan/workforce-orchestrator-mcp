import fs from 'node:fs';
import { parseDshLine } from '../parser.js';
import type { WorkerBackend, WorkerBackendHandle, BackendStartOptions, BackendEvents } from './types.js';
import type { DshEvent } from '../parser.js';
import type { WorkerEvent } from './events.js';
import { normalizeDshEvent } from './events.js';
import { executeAgentTool } from './agent-tools.js';

/**
 * Shared foundation for direct provider API backends.
 *
 * These backends run in-process (no child process): they stream a small,
 * tool-using agent loop against an HTTP chat API and write the same durable
 * canonical JSONL event stream the rest of the supervisor already understands.
 *
 * They are intentionally not reattachable across a supervisor restart (there
 * is no OS process to reattach to); an in-flight request becomes `interrupted`
 * with the workspace/artifacts preserved.
 */

export interface ProviderUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  totalTokens?: number | undefined;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ProviderTurn {
  text: string;
  toolCalls: ProviderToolCall[];
  usage: ProviderUsage;
}

export interface ApiAgentOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** True when baseUrl was explicitly configured (local gateways may not need a key). */
  explicitBaseUrl?: boolean | undefined;
  maxOutputTokens?: number | undefined;
  temperature?: number | undefined;
  maxIterations?: number | undefined;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT = `You are an autonomous execution worker inside an orchestrated workforce.
You operate only inside the provided workspace directory. Use the available tools
to inspect files, edit/create files, run commands and tests, and complete the task
end-to-end. Keep large command output out of your final answer. Do not ask the user
questions. When you are done, reply with a concise final report: summary, files
changed/created, verification performed, and any known issues.`;

function statusLine(phase: string, turn: number): Record<string, unknown> {
  return { type: 'status', phase, turn };
}

/** Durable canonical event writer. */
class EventSink {
  private offset = 0;
  private fd: number;

  constructor(
    private stdoutPath: string,
    private events: BackendEvents,
  ) {
    this.fd = fs.openSync(stdoutPath, 'a');
    try {
      this.offset = fs.fstatSync(this.fd).size;
    } catch {
      this.offset = 0;
    }
  }

  emit(ev: Record<string, unknown>): void {
    const line = JSON.stringify(ev);
    fs.writeSync(this.fd, line + '\n');
    this.offset += Buffer.byteLength(line, 'utf8') + 1;
    const parsed = parseDshLine(line);
    if (!parsed) return;
    parsed.byteOffset = this.offset;
    this.events.onEvent(parsed);
  }

  session(sessionId: string): void {
    this.emit({ type: 'session', sessionId });
  }

  status(phase: string, turn?: number): void {
    this.emit(turn === undefined ? { type: 'status', phase } : statusLine(phase, turn));
  }

  text(text: string): void {
    if (text !== '') this.emit({ type: 'text', text });
  }

  usage(u: ProviderUsage): void {
    if (
      u.inputTokens === undefined &&
      u.outputTokens === undefined &&
      u.cacheReadTokens === undefined &&
      u.totalTokens === undefined
    ) {
      return;
    }
    this.emit({
      type: 'status',
      phase: 'usage',
      usage: {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        totalTokens: u.totalTokens,
      },
    });
  }

  toolCall(call: ProviderToolCall): void {
    this.emit({ type: 'tool_call', tool: call.name, callId: call.id });
  }

  toolResult(call: ProviderToolCall, output: string): void {
    this.emit({
      type: 'tool_result',
      callId: call.id,
      status: output.startsWith('tool error:') ? 'error' : 'completed',
    });
  }

  error(message: string): void {
    this.emit({ type: 'error', message });
  }

  final(text: string): void {
    this.emit({ type: 'final', text });
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* ignore */
    }
  }
}

export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export abstract class ApiAgentBackend implements WorkerBackend {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly providerName: string;
  readonly capabilities = {
    continuation: true,
    durableReattach: false,
    structuredEvents: true,
    usageReporting: true,
    toolCallEvents: true,
    artifacts: true,
  } as const;
  readonly processMarker: string | undefined = undefined;
  readonly durableStdout = false;

  protected readonly maxIterations: number;
  protected readonly fetchImpl: typeof fetch;

  constructor(protected opts: ApiAgentOptions) {
    this.maxIterations = opts.maxIterations ?? 48;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  normalizeEvent(raw: DshEvent): WorkerEvent[] {
    return normalizeDshEvent(raw);
  }

  isAvailable(): boolean {
    return this.opts.apiKey.trim() !== '' || this.opts.explicitBaseUrl === true;
  }

  /** Provider-specific conversation state setup. */
  protected abstract begin(prompt: string, sessionId: string | null): void;
  /** Perform one API request (must append the assistant turn to state). */
  protected abstract requestTurn(signal: AbortSignal): Promise<ProviderTurn>;
  /** Append tool results so the next request sees them. */
  protected abstract addToolResults(calls: ProviderToolCall[], outputs: string[]): void;

  protected basePrompt(): string {
    return SYSTEM_PROMPT;
  }

  start(opts: BackendStartOptions, events: BackendEvents): WorkerBackendHandle {
    fs.closeSync(fs.openSync(opts.stderrPath, 'a'));
    const sink = new EventSink(opts.stdoutPath, events);
    const controller = new AbortController();
    const sessionId = opts.sessionId ?? `${this.id}-${opts.workerId}`;

    let finished = false;
    const finish = (code: number | null, signal: string | null) => {
      if (finished) return;
      finished = true;
      sink.close();
      queueMicrotask(() => events.onExit(code, signal));
    };

    const run = async () => {
      sink.session(sessionId);
      this.begin(opts.prompt, opts.sessionId);
      let lastText = '';
      for (let turn = 1; turn <= this.maxIterations; turn++) {
        if (controller.signal.aborted) return;
        sink.status('turn_start', turn);
        let t: ProviderTurn;
        try {
          t = await this.requestTurn(controller.signal);
        } catch (err) {
          if (controller.signal.aborted) return;
          const message = (err as Error).message;
          events.onStderr?.(message + '\n');
          try {
            fs.appendFileSync(opts.stderrPath, message + '\n');
          } catch {
            /* ignore */
          }
          sink.error(message.slice(0, 2000));
          finish(1, null);
          return;
        }
        if (t.text !== '') {
          lastText = t.text;
          sink.text(t.text);
        }
        sink.usage(t.usage);
        sink.status('step_end', turn);

        if (t.toolCalls.length === 0) {
          sink.final(lastText || 'Completed.');
          finish(0, null);
          return;
        }

        const outputs: string[] = [];
        for (const call of t.toolCalls) {
          if (controller.signal.aborted) return;
          sink.toolCall(call);
          const output = await executeAgentTool(call.name, call.arguments, opts.cwd, controller.signal);
          sink.toolResult(call, output);
          outputs.push(output);
        }
        this.addToolResults(t.toolCalls, outputs);
      }

      // Iteration cap reached — preserve work and return a factual report.
      const message = `Reached the maximum of ${this.maxIterations} agent iterations before completion.`;
      sink.status('step_end');
      sink.final(`${lastText ? lastText + '\n\n' : ''}${message}`);
      finish(0, null);
    };

    queueMicrotask(() => {
      void run().catch((err) => {
        if (controller.signal.aborted) return;
        try {
          sink.error((err as Error).message.slice(0, 2000));
        } catch {
          /* ignore */
        }
        finish(1, null);
      });
    });

    return {
      pid: null,
      terminate: async () => {
        controller.abort();
        finish(null, 'SIGTERM');
      },
    };
  }

  protected async postJson(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const detail =
        parsed && typeof parsed === 'object'
          ? JSON.stringify((parsed as Record<string, unknown>)['error'] ?? parsed).slice(0, 1500)
          : text.slice(0, 1500);
      throw new Error(`${this.providerName} API error ${res.status} ${res.statusText}: ${detail}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${this.providerName} API returned a non-object response`);
    }
    return parsed as Record<string, unknown>;
  }

  protected endpoint(suffix: string): string {
    const base = this.opts.baseUrl.replace(/\/+$/, '');
    return `${base}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
  }
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
