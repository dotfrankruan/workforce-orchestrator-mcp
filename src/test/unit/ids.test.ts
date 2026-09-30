import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newWorkerId, isValidWorkerId, workerBranch } from '../../util/ids.js';

test('worker id has expected format', () => {
  const id = newWorkerId();
  assert.match(id, /^wk_[0-9a-f]{8}$/);
  assert.ok(isValidWorkerId(id));
});

test('worker ids are unique in practice', () => {
  const ids = new Set(Array.from({ length: 1000 }, () => newWorkerId()));
  assert.equal(ids.size, 1000);
});

test('isValidWorkerId rejects bad input', () => {
  for (const bad of ['', 'wk_', 'wk_ABCDEF12', 'wk_123', 'foo', 'wk_12345678; rm -rf /', 'WK_12345678']) {
    assert.equal(isValidWorkerId(bad), false, bad);
  }
});

test('workerBranch', () => {
  assert.equal(workerBranch('wk_ab12cd34'), 'kimi-worker/wk_ab12cd34');
});
