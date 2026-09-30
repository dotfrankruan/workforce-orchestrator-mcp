import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateUtf8, tailLines } from '../../util/truncate.js';

test('short input passes through', () => {
  const r = truncateUtf8('hello', 100);
  assert.equal(r.text, 'hello');
  assert.equal(r.truncated, false);
});

test('long input is truncated with marker within byte budget', () => {
  const input = 'a'.repeat(10_000);
  const r = truncateUtf8(input, 1024);
  assert.equal(r.truncated, true);
  assert.ok(r.text.endsWith('[output truncated]'));
  assert.ok(Buffer.byteLength(r.text, 'utf8') <= 1024);
});

test('multibyte characters are never split', () => {
  const input = '漢字'.repeat(500); // 3 bytes each
  const r = truncateUtf8(input, 100);
  assert.equal(r.truncated, true);
  // Must be valid UTF-8: re-encoding yields identical bytes.
  assert.equal(Buffer.from(r.text, 'utf8').toString('utf8'), r.text);
  assert.ok(!r.text.includes('�'));
  assert.ok(Buffer.byteLength(r.text, 'utf8') <= 100);
});

test('tailLines keeps last n lines', () => {
  const input = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
  assert.equal(tailLines(input, 3), 'line7\nline8\nline9');
  assert.equal(tailLines(input, 100), input);
  assert.equal(tailLines(input, 0), '');
});
