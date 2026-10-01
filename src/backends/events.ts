import type { DshEvent } from '../parser.js';

/**
 * Normalized worker event model. The supervisor (budgets, metrics, waiters,
 * DAG) consumes ONLY this shape — backend-specific wire formats (e.g. the
 * DSH JSONL stream) are adapted at the backend boundary.
 */
export type WorkerEvent =
  | { type: 'session'; sessionId?: string | undefined; cwd?: string | undefined; offset?: number | undefined }
  | { type: 'status'; phase: string; turn?: number | undefined; step?: number | undefined; offset?: number | undefined }
  | {
      type: 'usage';
      inputTokens?: number | undefined;
      outputTokens?: number | undefined;
      cacheReadTokens?: number | undefined;
      totalTokens?: number | undefined;
      offset?: number | undefined;
    }
  | { type: 'tool_call'; tool?: string | undefined; callId?: string | undefined; offset?: number | undefined }
  | { type: 'tool_result'; callId?: string | undefined; status?: string | undefined; offset?: number | undefined }
  | { type: 'text'; text: string; offset?: number | undefined }
  | { type: 'final'; text: string; offset?: number | undefined }
  | { type: 'error'; message: string; offset?: number | undefined }
  | { type: 'malformed'; preview: string; offset?: number | undefined };

/**
 * DSH JSONL → WorkerEvent. `thinking` events deliberately produce NOTHING
 * (they stay in the durable log file, never reach the supervisor or Codex).
 * A status event carrying usage splits into status + usage events.
 */
export function normalizeDshEvent(ev: DshEvent): WorkerEvent[] {
  const offset = ev.byteOffset;
  switch (ev.type) {
    case 'session':
      return [{ type: 'session', sessionId: ev.sessionId, cwd: ev.cwd, offset }];
    case 'status': {
      const out: WorkerEvent[] = [];
      if (ev.phase) out.push({ type: 'status', phase: ev.phase, turn: ev.turn, step: ev.step, offset });
      if (ev.usage) {
        out.push({
          type: 'usage',
          inputTokens: ev.usage.inputTokens,
          outputTokens: ev.usage.outputTokens,
          cacheReadTokens: ev.usage.cacheReadTokens,
          totalTokens: ev.usage.totalTokens,
          offset,
        });
      }
      return out;
    }
    case 'thinking':
      return [];
    case 'text':
      return ev.text !== undefined ? [{ type: 'text', text: ev.text, offset }] : [];
    case 'tool_call':
      return [{ type: 'tool_call', tool: ev.tool, callId: ev.callId, offset }];
    case 'tool_result':
      return [{ type: 'tool_result', callId: ev.callId, status: ev.status, offset }];
    case 'final':
      return ev.text !== undefined ? [{ type: 'final', text: ev.text, offset }] : [];
    default:
      if (ev.malformed) return [{ type: 'malformed', preview: (ev.rawLine ?? '').slice(0, 200), offset }];
      return [];
  }
}
