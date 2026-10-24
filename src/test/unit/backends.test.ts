import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../config.js';
import {
  BackendRegistry,
  resolveDshExecutable,
  loadFileConfig,
} from '../../backends/registry.js';
import { DshBackend } from '../../backends/dsh.js';
import { FakeBackend, FakeScenarios } from '../../backends/fake.js';
import { computeCacheKey } from '../../cache.js';
import { WorkerStore } from '../../db.js';
import { WorkerSupervisor } from '../../supervisor.js';
import { makeTempDir, removeDir } from '../helpers.js';

const baseConfig = (root: string) => loadConfig({ env: {}, workerRoot: root });

test('zero-config: default backend is dsh at /usr/local/bin/dsh with headless profile', () => {
  // The current machine compatibility contract: no config file, no env vars.
  const root = makeTempDir('kwm-b-');
  try {
    const config = baseConfig(root);
    const exe = resolveDshExecutable(config, null, {});
    // On Frank's machine /usr/local/bin/dsh exists → builtin-path.
    assert.equal(exe.command, '/usr/local/bin/dsh');
    assert.equal(exe.source, 'builtin-path');

    const registry = new BackendRegistry(new DshBackend({ dshBin: exe.command!, profile: config.dshProfile }));
    const backend = registry.resolveAvailable({});
    assert.equal(backend.id, 'dsh');
    assert.equal(backend.displayName, 'DeepSeek Harness');
    assert.equal(backend.capabilities.continuation, true);
    assert.equal(backend.capabilities.durableReattach, true);
    assert.ok(backend.isAvailable());
  } finally {
    removeDir(root);
  }
});

test('PATH fallback when /usr/local/bin/dsh is absent', () => {
  const root = makeTempDir('kwm-b-');
  try {
    const config = baseConfig(root);
    const exe = resolveDshExecutable(config, null, {
      isExecutable: (p) => p !== '/usr/local/bin/dsh',
      which: (cmd) => (cmd === 'dsh' ? '/opt/homebrew/bin/dsh' : null),
    });
    assert.equal(exe.command, '/opt/homebrew/bin/dsh');
    assert.equal(exe.source, 'path');
  } finally {
    removeDir(root);
  }
});

test('no dsh anywhere → clear error, nothing installed', () => {
  const root = makeTempDir('kwm-b-');
  try {
    const config = baseConfig(root);
    const exe = resolveDshExecutable(config, null, {
      isExecutable: () => false,
      which: () => null,
    });
    assert.equal(exe.command, null);
    assert.equal(exe.source, 'none');

    const registry = new BackendRegistry(new DshBackend({ dshBin: '/nonexistent/dsh', profile: 'headless' }));
    assert.equal(registry.get('dsh').isAvailable(), false);
    assert.throws(() => registry.resolveAvailable({}), /unavailable: could not find/);
  } finally {
    removeDir(root);
  }
});

test('explicit backend param wins; unknown backend is a clear error', async () => {
  const root = makeTempDir('kwm-b-');
  try {
    const config = baseConfig(root);
    const store = new WorkerStore(path.join(root, 'w.db'));
    const fakeA = new FakeBackend({ scenario: () => FakeScenarios.success() }, 'fake-a');
    const fakeB = new FakeBackend({ scenario: () => FakeScenarios.success() }, 'fake-b');
    const registry = new BackendRegistry(fakeA, { extraBackends: [fakeB] });
    const sup = new WorkerSupervisor(config, store, registry);

    const s = sup.spawnTask({ task: 'x', mode: 'general', backend: 'fake-b' });
    const row = await sup.waitFor(s.task_id);
    assert.equal(row.backend_id, 'fake-b');
    assert.throws(() => sup.spawnTask({ task: 'x', backend: 'nope' }), /unknown backend/);
    store.close();
  } finally {
    removeDir(root);
  }
});

test('role routing: reviewer→fake-b, default→fake-a; explicit overrides routing', async () => {
  const root = makeTempDir('kwm-b-');
  try {
    const config = baseConfig(root);
    const store = new WorkerStore(path.join(root, 'w.db'));
    const fakeA = new FakeBackend({ scenario: () => FakeScenarios.success() }, 'fake-a');
    const fakeB = new FakeBackend({ scenario: () => FakeScenarios.success() }, 'fake-b');
    const registry = new BackendRegistry(fakeA, {
      extraBackends: [fakeB],
      fileConfig: { routing: { default: 'fake-a', roles: { reviewer: 'fake-b' } } },
    });
    const sup = new WorkerSupervisor(config, store, registry);

    const review = sup.spawnTask({ task: 'review it', mode: 'review', role: 'reviewer' });
    const other = sup.spawnTask({ task: 'do it', mode: 'general' });
    const explicit = sup.spawnTask({ task: 'forced', mode: 'review', role: 'reviewer', backend: 'fake-a' });

    const [r1, r2, r3] = await Promise.all([sup.waitFor(review.task_id), sup.waitFor(other.task_id), sup.waitFor(explicit.task_id)]);
    assert.equal(r1.backend_id, 'fake-b', 'role rule applied');
    assert.equal(r2.backend_id, 'fake-a', 'default applied');
    assert.equal(r3.backend_id, 'fake-a', 'explicit wins over role rule');
    store.close();
  } finally {
    removeDir(root);
  }
});

test('mixed-backend workflow: DAG + wait + metrics split by backend', async () => {
  const root = makeTempDir('kwm-b-');
  try {
    const config = baseConfig(root);
    const store = new WorkerStore(path.join(root, 'w.db'));
    const fakeA = new FakeBackend({ scenario: () => FakeScenarios.success() }, 'fake-a');
    const fakeB = new FakeBackend({ scenario: () => FakeScenarios.success() }, 'fake-b');
    const registry = new BackendRegistry(fakeA, { extraBackends: [fakeB] });
    const sup = new WorkerSupervisor(config, store, registry);

    const wf = sup.createWorkflow({
      tasks: [
        { key: 'a', task: 'TAG_A', mode: 'general', backend: 'fake-a' },
        { key: 'b', task: 'TAG_B', mode: 'general', backend: 'fake-b' },
        { key: 'c', task: 'TAG_C', mode: 'general', depends_on: ['a', 'b'] }, // default → fake-a
      ],
    }) as Record<string, any>;
    const done = await sup.waitWorkflow(wf.workflow_id, 30);
    assert.equal(done['status'], 'completed');

    const rows = store.workersInWorkflow(wf.workflow_id);
    const byKey = Object.fromEntries(rows.map((r) => [r.task_key, r]));
    assert.equal(byKey['a']!.backend_id, 'fake-a');
    assert.equal(byKey['b']!.backend_id, 'fake-b');
    assert.equal(byKey['c']!.backend_id, 'fake-a');

    const sys = sup.systemMetrics() as Record<string, any>;
    const byBackend = Object.fromEntries((sys['backends'] as any[]).map((b) => [b.backend, b]));
    assert.equal(byBackend['fake-a']['tasks'], 2);
    assert.equal(byBackend['fake-b']['tasks'], 1);
    assert.ok(byBackend['fake-a']['tokens']['output'] > 0);
    store.close();
  } finally {
    removeDir(root);
  }
});

test('cache keys isolate backends', () => {
  const k1 = computeCacheKey({ mode: 'research', role: null, roleFragment: null, task: 't', fingerprint: 'x', backendId: 'fake-a' });
  const k2 = computeCacheKey({ mode: 'research', role: null, roleFragment: null, task: 't', fingerprint: 'x', backendId: 'fake-b' });
  assert.notEqual(k1, k2);
});

test('file config: optional, validated, never required', () => {
  const root = makeTempDir('kwm-b-');
  try {
    // Absent → null (defaults).
    assert.equal(loadFileConfig(path.join(root, 'nope.json')), null);
    // Valid JSON object.
    const p = path.join(root, 'config.json');
    fs.writeFileSync(p, JSON.stringify({ default_backend: 'fake', routing: { roles: { reviewer: 'fake' } } }));
    const cfg = loadFileConfig(p);
    assert.equal(cfg?.default_backend, 'fake');
    // Invalid JSON → clear error.
    fs.writeFileSync(p, '{not json');
    assert.throws(() => loadFileConfig(p), /invalid workforce config/);
  } finally {
    removeDir(root);
  }
});

test('env override WORKFORCE_DEFAULT_BACKEND changes the default', () => {
  const fakeA = new FakeBackend({ scenario: () => FakeScenarios.success() }, 'fake-a');
  const fakeB = new FakeBackend({ scenario: () => FakeScenarios.success() }, 'fake-b');
  const registry = new BackendRegistry(fakeA, { extraBackends: [fakeB], env: { WORKFORCE_DEFAULT_BACKEND: 'fake-b' } });
  assert.equal(registry.defaultBackendId, 'fake-b');
  assert.equal(registry.resolve({}).id, 'fake-b');
});

test('config file is read from ~/.workforce/config.json (documented path)', () => {
  const tmpHome = makeTempDir('kwm-home-');
  const prevHome = process.env.HOME;
  try {
    fs.mkdirSync(path.join(tmpHome, '.workforce'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.workforce', 'config.json'),
      JSON.stringify({ backends: { dsh: { command: '/opt/homebrew/bin/dsh', profile: 'headless' } } }),
    );
    process.env.HOME = tmpHome;

    // Lazy path resolution follows HOME (documentation-verified behavior).
    const cfg = loadFileConfig();
    assert.equal(cfg?.backends?.dsh?.command, '/opt/homebrew/bin/dsh');

    const config = baseConfig(tmpHome);
    const exe = resolveDshExecutable(config, cfg);
    assert.equal(exe.command, '/opt/homebrew/bin/dsh');
    assert.equal(exe.source, 'config');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    removeDir(tmpHome);
  }
});
