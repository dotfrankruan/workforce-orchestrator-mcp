import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDshLine, UsageTracker, renderLogLine, summarizeFinalText } from '../../parser.js';

test('parses session event', () => {
  const ev = parseDshLine('{"type":"session","sessionId":"session-1","cwd":"/tmp/x"}');
  assert.equal(ev?.type, 'session');
  assert.equal(ev?.sessionId, 'session-1');
  assert.equal(ev?.cwd, '/tmp/x');
});

test('parses status event with usage', () => {
  const ev = parseDshLine(
    '{"type":"status","phase":"step_end","usage":{"inputTokens":169,"outputTokens":120,"totalTokens":4897,"cacheReadTokens":4608}}',
  );
  assert.equal(ev?.type, 'status');
  assert.equal(ev?.phase, 'step_end');
  assert.deepEqual(ev?.usage, { inputTokens: 169, outputTokens: 120, totalTokens: 4897, cacheReadTokens: 4608 });
});

test('parses thinking/text/tool_call/tool_result/final', () => {
  assert.equal(parseDshLine('{"type":"thinking","text":"hmm"}')?.type, 'thinking');
  assert.equal(parseDshLine('{"type":"text","text":"hi"}')?.text, 'hi');
  const call = parseDshLine('{"type":"tool_call","callId":"c1","tool":"bash","input":{"command":"ls"}}');
  assert.equal(call?.type, 'tool_call');
  assert.equal(call?.tool, 'bash');
  const res = parseDshLine('{"type":"tool_result","callId":"c1","status":"completed","result":"ok"}');
  assert.equal(res?.type, 'tool_result');
  assert.equal(res?.status, 'completed');
  assert.equal(parseDshLine('{"type":"final","text":"done"}')?.type, 'final');
});

test('blank lines yield null', () => {
  assert.equal(parseDshLine(''), null);
  assert.equal(parseDshLine('   '), null);
});

test('malformed JSON is tolerated', () => {
  const ev = parseDshLine('not json at all');
  assert.equal(ev?.malformed, true);
  assert.equal(ev?.type, 'unknown');
  const half = parseDshLine('{"type":"text","text":"cut off');
  assert.equal(half?.malformed, true);
});

test('non-object JSON is treated as malformed', () => {
  assert.equal(parseDshLine('[1,2,3]')?.malformed, true);
  assert.equal(parseDshLine('"hello"')?.malformed, true);
  assert.equal(parseDshLine('42')?.malformed, true);
});

test('unknown event types are preserved as unknown without throwing', () => {
  const ev = parseDshLine('{"type":"future_event","foo":1}');
  assert.equal(ev?.type, 'unknown');
  assert.equal(ev?.rawType, 'future_event');
  assert.equal(ev?.malformed, undefined);
});

test('UsageTracker sums per-step usage but keeps last totalTokens', () => {
  const t = new UsageTracker();
  t.apply({ inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 50 });
  t.apply({ inputTokens: 200, outputTokens: 20, totalTokens: 330, cacheReadTokens: 60 });
  t.apply({ outputTokens: 5 });
  const snap = t.snapshot();
  assert.equal(snap.input_tokens, 300);
  assert.equal(snap.output_tokens, 35);
  assert.equal(snap.cache_read_tokens, 110);
  // totalTokens is context-inclusive and must NOT be summed.
  assert.equal(snap.total_tokens_last, 330);
});

test('renderLogLine clips long text', () => {
  const long = 'x'.repeat(1000);
  const line = renderLogLine(parseDshLine(JSON.stringify({ type: 'thinking', text: long }))!);
  assert.ok(line.length < 400);
  assert.ok(line.startsWith('[thinking]'));
});

test('summarizeFinalText extracts sections', () => {
  const final = [
    'Implemented the thing.',
    '',
    '## Summary',
    '- Added TCP fallback',
    '- Added timeout handling',
    '',
    '## Tests',
    'Ran `go test ./...` — all tests pass.',
    '',
    '## Reviewer attention',
    '- Check retry logic in tcp.go',
    '',
    '## Known issues',
    '- None',
  ].join('\n');
  const s = summarizeFinalText(final);
  assert.deepEqual(s.summary, ['Added TCP fallback', 'Added timeout handling']);
  assert.equal(s.tests.status, 'pass');
  assert.deepEqual(s.tests.commands, ['go test ./...']);
  assert.deepEqual(s.review_attention, ['Check retry logic in tcp.go']);
  assert.deepEqual(s.known_issues, ['None']);
});

test('summarizeFinalText falls back to bullets and detects failures', () => {
  const s = summarizeFinalText('- did a\n- did b\n\n2 tests failed, fix needed');
  assert.deepEqual(s.summary, ['did a', 'did b']);
  assert.equal(s.tests.status, 'fail');
});

test('summarizeFinalText handles null', () => {
  const s = summarizeFinalText(null);
  assert.deepEqual(s.summary, []);
  assert.equal(s.tests.status, 'unknown');
});

test('DSH adapter: normalizeDshEvent maps wire events to WorkerEvents', async () => {
  const { normalizeDshEvent } = await import('../../backends/events.js');

  // session
  assert.deepEqual(normalizeDshEvent(parseDshLine('{"type":"session","sessionId":"s1"}')!), [
    { type: 'session', sessionId: 's1', cwd: undefined, offset: undefined },
  ]);
  // status with usage splits into status + usage
  const norm = normalizeDshEvent(
    parseDshLine('{"type":"status","phase":"step_end","usage":{"inputTokens":5,"outputTokens":3}}')!,
  );
  assert.equal(norm.length, 2);
  assert.equal(norm[0]!.type, 'status');
  assert.equal(norm[1]!.type, 'usage');
  // thinking never reaches the supervisor
  assert.deepEqual(normalizeDshEvent(parseDshLine('{"type":"thinking","text":"secret thoughts"}')!), []);
  // malformed surfaces as such
  assert.equal(normalizeDshEvent(parseDshLine('not json')!)[0]!.type, 'malformed');
  // final/text/tool events map through
  assert.equal(normalizeDshEvent(parseDshLine('{"type":"final","text":"done"}')!)[0]!.type, 'final');
  assert.equal(normalizeDshEvent(parseDshLine('{"type":"tool_call","tool":"bash","callId":"c"}')!)[0]!.type, 'tool_call');
  assert.equal(normalizeDshEvent(parseDshLine('{"type":"tool_result","callId":"c","status":"completed"}')!)[0]!.type, 'tool_result');
});
