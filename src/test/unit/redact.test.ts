import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../../util/redact.js';

test('redacts KEY=value style secrets', () => {
  const out = redactSecrets('KIMI_CODING_API_KEY=sk-abcdef123456 more text');
  assert.ok(!out.includes('sk-abcdef123456'));
  assert.ok(out.includes('KIMI_CODING_API_KEY=[REDACTED]'));
});

test('redacts sk- style keys anywhere', () => {
  const out = redactSecrets('the key is sk-XY1234567890abcdef ok?');
  assert.ok(!out.includes('sk-XY1234567890abcdef'));
});

test('redacts authorization headers', () => {
  const out = redactSecrets('Authorization: Bearer abcdef123456789');
  assert.ok(!out.includes('abcdef123456789'));
});

test('redacts generic api_key assignments', () => {
  const out = redactSecrets('api_key: "hunter2hunter2"');
  assert.ok(!out.includes('hunter2hunter2'));
});

test('leaves normal text untouched', () => {
  const text = 'Implemented retry logic. Tests: 7 passed. commit 4fa01cd';
  assert.equal(redactSecrets(text), text);
});
