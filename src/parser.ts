import fs from 'node:fs';

/**
 * Parser for the dsh `--json` NDJSON event stream.
 *
 * Known event shapes (observed):
 *   {"type":"session","sessionId":"...","cwd":"..."}
 *   {"type":"status","phase":"turn_start","turn":1}
 *   {"type":"status","phase":"step_end","usage":{"inputTokens":N,"outputTokens":N,"totalTokens":N,"cacheReadTokens":N}}
 *   {"type":"thinking","text":"..."}
 *   {"type":"text","text":"..."}
 *   {"type":"tool_call","callId":"...","tool":"bash","input":{...}}
 *   {"type":"tool_result","callId":"...","status":"completed","result":"..."}
 *   {"type":"final","text":"..."}
 *
 * Parsing is deliberately lenient: unknown types and missing optional fields
 * are tolerated so a dsh upgrade does not break the worker supervisor.
 */

export type DshEventType =
  | 'session'
  | 'status'
  | 'thinking'
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'final'
  | 'unknown';

export interface DshUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
}

export interface DshEvent {
  type: DshEventType;
  rawType: string;
  sessionId?: string;
  cwd?: string;
  phase?: string;
  turn?: number;
  step?: number;
  usage?: DshUsage;
  text?: string;
  callId?: string;
  tool?: string;
  status?: string;
  /** Present when the raw line was not valid JSON. */
  malformed?: boolean;
  rawLine?: string;
}

const KNOWN_TYPES = new Set(['session', 'status', 'thinking', 'text', 'tool_call', 'tool_result', 'final']);

export interface ParseOptions {
  /** Max raw line length kept for malformed lines. */
  malformedPreviewChars?: number;
}

/** Parse one NDJSON line. Returns null for blank lines; never throws. */
export function parseDshLine(line: string, opts: ParseOptions = {}): DshEvent | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    const limit = opts.malformedPreviewChars ?? 500;
    return {
      type: 'unknown',
      rawType: 'malformed',
      malformed: true,
      rawLine: trimmed.length > limit ? trimmed.slice(0, limit) : trimmed,
    };
  }

  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { type: 'unknown', rawType: 'malformed', malformed: true, rawLine: trimmed.slice(0, 500) };
  }

  const rec = obj as Record<string, unknown>;
  const rawType = typeof rec.type === 'string' ? rec.type : 'unknown';
  const type = (KNOWN_TYPES.has(rawType) ? rawType : 'unknown') as DshEventType;

  const ev: DshEvent = { type, rawType };
  if (typeof rec.sessionId === 'string') ev.sessionId = rec.sessionId;
  if (typeof rec.cwd === 'string') ev.cwd = rec.cwd;
  if (typeof rec.phase === 'string') ev.phase = rec.phase;
  if (typeof rec.turn === 'number') ev.turn = rec.turn;
  if (typeof rec.step === 'number') ev.step = rec.step;
  if (typeof rec.text === 'string') ev.text = rec.text;
  if (typeof rec.callId === 'string') ev.callId = rec.callId;
  if (typeof rec.tool === 'string') ev.tool = rec.tool;
  if (typeof rec.status === 'string') ev.status = rec.status;

  if (typeof rec.usage === 'object' && rec.usage !== null) {
    const u = rec.usage as Record<string, unknown>;
    const usage: DshUsage = {};
    if (typeof u.inputTokens === 'number') usage.inputTokens = u.inputTokens;
    if (typeof u.outputTokens === 'number') usage.outputTokens = u.outputTokens;
    if (typeof u.totalTokens === 'number') usage.totalTokens = u.totalTokens;
    if (typeof u.cacheReadTokens === 'number') usage.cacheReadTokens = u.cacheReadTokens;
    ev.usage = usage;
  }

  return ev;
}

/**
 * Accumulates token usage across status events.
 *
 * Semantics decision: `usage` on each event describes that step, so
 * input/output/cacheRead are summed across steps. `totalTokens` includes the
 * full conversation context resubmitted each step (it overlaps with the
 * input counts), so it is NOT summed — only the last observed value is kept.
 */
export class UsageTracker {
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  lastTotalTokens: number | null = null;

  apply(usage: DshUsage | undefined): void {
    if (!usage) return;
    if (usage.inputTokens) this.inputTokens += usage.inputTokens;
    if (usage.outputTokens) this.outputTokens += usage.outputTokens;
    if (usage.cacheReadTokens) this.cacheReadTokens += usage.cacheReadTokens;
    if (typeof usage.totalTokens === 'number') this.lastTotalTokens = usage.totalTokens;
  }

  snapshot(): { input_tokens: number; output_tokens: number; cache_read_tokens: number; total_tokens_last: number | null } {
    return {
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      cache_read_tokens: this.cacheReadTokens,
      total_tokens_last: this.lastTotalTokens,
    };
  }
}

/** Render one event as a compact human-readable log line (for get_worker_log). */
export function renderLogLine(ev: DshEvent, maxTextChars = 300): string {
  const clip = (s: string) => {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > maxTextChars ? flat.slice(0, maxTextChars) + '…' : flat;
  };
  switch (ev.type) {
    case 'session':
      return `[session] ${ev.sessionId ?? '?'} cwd=${ev.cwd ?? '?'}`;
    case 'status':
      return `[status] ${ev.phase ?? '?'}${ev.turn !== undefined ? ` turn=${ev.turn}` : ''}${ev.usage ? ` usage(in=${ev.usage.inputTokens ?? 0},out=${ev.usage.outputTokens ?? 0},cache=${ev.usage.cacheReadTokens ?? 0})` : ''}`;
    case 'thinking':
      return `[thinking] ${clip(ev.text ?? '')}`;
    case 'text':
      return `[text] ${clip(ev.text ?? '')}`;
    case 'tool_call':
      return `[tool_call] ${ev.tool ?? '?'} (${ev.callId ?? '?'})`;
    case 'tool_result':
      return `[tool_result] ${ev.status ?? '?'} (${ev.callId ?? '?'})`;
    case 'final':
      return `[final] ${clip(ev.text ?? '')}`;
    default:
      return ev.malformed ? `[malformed] ${clip(ev.rawLine ?? '')}` : `[${ev.rawType}]`;
  }
}

export interface LogReplay {
  sessionId: string | null;
  cwd: string | null;
  usage: UsageTracker;
  finalText: string | null;
  lastText: string | null;
  eventCount: number;
  malformedCount: number;
}

/** Replay a stored stdout.jsonl file to recover session id, usage and final text. */
export function replayLogFile(path: string): LogReplay {
  const usage = new UsageTracker();
  const out: LogReplay = {
    sessionId: null,
    cwd: null,
    usage,
    finalText: null,
    lastText: null,
    eventCount: 0,
    malformedCount: 0,
  };
  let content: string;
  try {
    content = fs.readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of content.split('\n')) {
    const ev = parseDshLine(line);
    if (!ev) continue;
    out.eventCount++;
    if (ev.malformed) out.malformedCount++;
    if (ev.type === 'session') {
      out.sessionId = ev.sessionId ?? out.sessionId;
      out.cwd = ev.cwd ?? out.cwd;
    }
    if (ev.usage) usage.apply(ev.usage);
    if (ev.type === 'final' && ev.text) out.finalText = ev.text;
    if (ev.type === 'text' && ev.text) out.lastText = ev.text;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Heuristic extraction of the compact result from the worker's final
 * report. Verified facts (commit, changed files) always come from git;
 * these helpers only structure what the worker *claims*.
 * ------------------------------------------------------------------ */

export interface FinalSummary {
  /** Up to `maxBullets` short bullet/action lines from the report. */
  summary: string[];
  tests: {
    status: 'pass' | 'fail' | 'unknown';
    commands: string[];
  };
  review_attention: string[];
  known_issues: string[];
}

const TEST_COMMAND_RE = /\b(npm (?:run )?test[^\n,;`]*|pnpm (?:run )?test[^\n,;`]*|yarn test[^\n,;`]*|go test[^\n,;`]*|pytest[^\n,;`]*|cargo test[^\n,;`]*|make test[^\n,;`]*|vitest[^\n,;`]*|jest[^\n,;`]*|mvn test[^\n,;`]*|gradle(?:w)? test[^\n,;`]*)/gi;
const TEST_PASS_RE = /\b(all tests pass\w*|tests?\s+(?:all\s+)?pass\w*|test suite pass\w*|\d+ tests? pass\w*|build succeed\w*|passing)\b/i;
const TEST_FAIL_RE = /\b(tests? (?:are )?fail\w*|failing tests?|test suite fail\w*|\d+ tests? fail\w*)\b/i;

function clipLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function sectionLines(text: string, headingRe: RegExp): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line) ?? /^\s*\*\*([^*]+)\*\*\s*:?\s*$/.exec(line);
    if (heading) {
      inSection = headingRe.test(heading[1] ?? '');
      continue;
    }
    if (inSection) {
      const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
      if (bullet && bullet[1]) out.push(clipLine(bullet[1], 200));
      else if (line.trim() && out.length === 0) out.push(clipLine(line, 200));
    }
  }
  return out;
}

export function summarizeFinalText(finalText: string | null, maxBullets = 12): FinalSummary {
  const result: FinalSummary = {
    summary: [],
    tests: { status: 'unknown', commands: [] },
    review_attention: [],
    known_issues: [],
  };
  if (!finalText) return result;

  // Summary: prefer an explicit "Summary" section, fall back to leading bullets.
  let summary = sectionLines(finalText, /summary|what changed|changes made|done/i);
  if (summary.length === 0) {
    summary = finalText
      .split('\n')
      .map((l) => /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(l)?.[1])
      .filter((s): s is string => Boolean(s))
      .map((s) => clipLine(s, 200));
  }
  result.summary = summary.slice(0, maxBullets);

  // Tests: claimed status + detected commands.
  const commands = new Set<string>();
  for (const m of finalText.matchAll(TEST_COMMAND_RE)) {
    if (m[1]) commands.add(clipLine(m[1], 120));
  }
  result.tests.commands = [...commands].slice(0, 10);
  if (TEST_FAIL_RE.test(finalText)) result.tests.status = 'fail';
  else if (TEST_PASS_RE.test(finalText)) result.tests.status = 'pass';

  result.review_attention = sectionLines(finalText, /review|attention|look at|careful/i).slice(0, 8);
  result.known_issues = sectionLines(finalText, /known issues?|limitations?|caveats?|risks?/i).slice(0, 8);

  return result;
}
