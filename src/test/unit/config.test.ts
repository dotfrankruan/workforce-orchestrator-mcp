import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../config.js';

test('defaults when env is empty', () => {
  const c = loadConfig({ env: {}, workerRoot: '/tmp/kwm-test-root' });
  assert.equal(c.dshBin, '/usr/local/bin/dsh');
  assert.equal(c.dshProfile, 'headless');
  assert.equal(c.maxConcurrent, 4);
  assert.equal(c.defaultTimeoutSeconds, 3600);
  assert.equal(c.backend, 'auto');
  assert.equal(c.logMaxBytes, 32 * 1024);
  assert.equal(c.workerRoot, path.resolve('/tmp/kwm-test-root'));
  assert.equal(c.dbPath, path.join(path.resolve('/tmp/kwm-test-root'), 'workers.db'));
});

test('env overrides are honored', () => {
  const c = loadConfig({
    env: {
      WORKFORCE_MAX_CONCURRENT: '2',
      WORKFORCE_DEFAULT_TIMEOUT: '60',
      WORKFORCE_BACKEND: 'fake',
      WORKFORCE_DSH_COMMAND: '/custom/dsh',
      WORKFORCE_DB: '/tmp/custom.db',
    },
    workerRoot: '/tmp/kwm-x',
  });
  assert.equal(c.maxConcurrent, 2);
  assert.equal(c.defaultTimeoutSeconds, 60);
  assert.equal(c.backend, 'fake');
  assert.equal(c.dshBin, '/custom/dsh');
  assert.equal(c.dbPath, path.resolve('/tmp/custom.db'));
});

test('~ expansion in worker root and db path', () => {
  const c = loadConfig({ env: { WORKFORCE_DB: '~/foo/bar.db' }, workerRoot: '~/kwroot' });
  assert.equal(c.workerRoot, path.join(os.homedir(), 'kwroot'));
  assert.equal(c.dbPath, path.join(os.homedir(), 'foo', 'bar.db'));
});

test('invalid integers are rejected', () => {
  assert.throws(() => loadConfig({ env: { WORKFORCE_MAX_CONCURRENT: 'zero' }, workerRoot: '/tmp/x' }));
  assert.throws(() => loadConfig({ env: { WORKFORCE_MAX_CONCURRENT: '-3' }, workerRoot: '/tmp/x' }));
  assert.throws(() => loadConfig({ env: { WORKFORCE_DEFAULT_TIMEOUT: '1.5' }, workerRoot: '/tmp/x' }));
});

test('invalid backend is rejected', () => {
  assert.throws(() => loadConfig({ env: { WORKFORCE_BACKEND: 'magic' }, workerRoot: '/tmp/x' }));
});

test('default timeout must not exceed max timeout', () => {
  assert.throws(() =>
    loadConfig({
      env: { WORKFORCE_DEFAULT_TIMEOUT: '100', WORKFORCE_MAX_TIMEOUT: '50' },
      workerRoot: '/tmp/x',
    }),
  );
});
