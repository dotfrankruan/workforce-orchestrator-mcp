import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ensureConfigDirs } from '../../config.js';
import { WorkerStore } from '../../db.js';
import { WorkerSupervisor } from '../../supervisor.js';
import { DshBackend } from '../../backends/dsh.js';
import { BackendRegistry } from '../../backends/registry.js';
import type { WorkerBackend } from '../../backends/types.js';
import { makeTempDir, removeDir } from '../helpers.js';

const DUMP = `- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      kimi-coding:
        models:
          - id: k3
            name: K3
          - id: k3-256k
            name: Kimi K3-256K
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: kimi-coding
    model: k3
    reasoningEffort: max
`;

/**
 * A fake `dsh` executable: answers --version / --dump-config, otherwise
 * records its argv and emits a canonical final event. Lets tests assert the
 * REAL command line the backend builds (including --patch) without the network.
 */
function makeFakeDsh(dir: string): { bin: string; argsFile: string; dumpFile: string } {
  const argsFile = path.join(dir, 'argv.log');
  const dumpFile = path.join(dir, 'dump.yml');
  fs.writeFileSync(dumpFile, DUMP);
  const bin = path.join(dir, 'fake-dsh');
  fs.writeFileSync(
    bin,
    `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "--version" ]; then echo "9.9.9-test"; exit 0; fi
  if [ "$a" = "--dump-config" ]; then cat "${dumpFile}"; exit 0; fi
done
echo "$@" >> "${argsFile}"
printf '%s\\n' '{"type":"session","sessionId":"session-fake"}' '{"type":"status","phase":"turn_start","turn":1}' '{"type":"final","text":"Summary:\\n- ok"}' > /dev/stdout
exit 0
`,
    { mode: 0o755 },
  );
  return { bin, argsFile, dumpFile };
}

function makeHarness(root: string) {
  const config = loadConfig({ env: {}, workerRoot: root });
  ensureConfigDirs(config);
  const store = new WorkerStore(config.dbPath);
  const fake = makeFakeDsh(root);
  const backend = new DshBackend({ dshBin: fake.bin, profile: 'headless' });
  const supervisor = new WorkerSupervisor(config, store, backend);
  return { config, store, supervisor, fake, backend };
}

test('per-task model: generated --patch overlay pins the model for that run', async () => {
  const root = makeTempDir('kwm-modelsel-');
  const h = makeHarness(root);
  try {
    const s = h.supervisor.spawnTask({ task: 'do it', mode: 'general', model: 'k3-256k' });
    assert.equal(s.model, 'k3-256k');
    const row = await h.supervisor.waitFor(s.task_id);
    assert.equal(row.status, 'completed', row.error ?? '');
    assert.equal(row.model, 'k3-256k');

    // Real argv contains --patch pointing at the generated overlay.
    const argv = fs.readFileSync(h.fake.argsFile, 'utf8').trim();
    assert.match(argv, /--profile headless/);
    const patchPath = path.join(row.log_dir, 'dsh-model.yml');
    assert.ok(argv.includes(`--patch ${patchPath}`), `argv should reference the patch: ${argv}`);

    // Overlay replaces the full agent-default-model entry (profile base + override).
    const patch = fs.readFileSync(patchPath, 'utf8');
    assert.match(patch, /- id: agent-default-model/);
    assert.match(patch, /provider: kimi-coding/);
    assert.match(patch, /model: k3-256k/);
    assert.match(patch, /reasoningEffort: max/);

    // Facts persisted for results/metrics.
    const result = h.supervisor.taskResult(s.task_id) as Record<string, unknown>;
    assert.equal(result['model'], 'k3-256k');
    const meta = result['backend_metadata'] as Record<string, any>;
    assert.equal(meta['provider']['model'], 'k3-256k');
    assert.equal(meta['provider']['name'], 'kimi-coding');

    // Sessions/continuations keep the model.
    await h.supervisor.waitTask(s.task_id, 5);
  } finally {
    h.store.close();
    removeDir(root);
  }
});

test('no model override → no --patch flag (profile default untouched)', async () => {
  const root = makeTempDir('kwm-modelsel-');
  const h = makeHarness(root);
  try {
    const s = h.supervisor.spawnTask({ task: 'do it', mode: 'general' });
    const row = await h.supervisor.waitFor(s.task_id);
    assert.equal(row.status, 'completed');
    assert.equal(row.model, null);
    const argv = fs.readFileSync(h.fake.argsFile, 'utf8').trim();
    assert.ok(!argv.includes('--patch'), `no patch expected: ${argv}`);
    assert.ok(!fs.existsSync(path.join(row.log_dir, 'dsh-model.yml')));
  } finally {
    h.store.close();
    removeDir(root);
  }
});

test('list_models: real model catalog + default from runtime config', () => {
  const root = makeTempDir('kwm-modelsel-');
  const h = makeHarness(root);
  try {
    const models = h.supervisor.listModels() as Record<string, any>;
    assert.equal(models['backend'], 'dsh');
    assert.equal(models['model_selection'], true);
    assert.deepEqual(
      models['models'].map((m: any) => m.id),
      ['k3', 'k3-256k'],
    );
    assert.deepEqual(models['default'], { provider: 'kimi-coding', model: 'k3', reasoningEffort: 'max' });
    const backend = h.supervisor.getBackend('dsh') as Record<string, any>;
    assert.equal(backend['default_model']['model'], 'k3');
    assert.equal(backend['capabilities']['modelSelection'], true);
  } finally {
    h.store.close();
    removeDir(root);
  }
});

test('model rejected on a backend without modelSelection', () => {
  const root = makeTempDir('kwm-modelsel-');
  try {
    const config = loadConfig({ env: {}, workerRoot: root });
    ensureConfigDirs(config);
    const store = new WorkerStore(config.dbPath);
    const noModel: WorkerBackend = {
      id: 'no-model',
      displayName: 'NoModel',
      capabilities: {
        modelSelection: false,
        continuation: false,
        durableReattach: false,
        structuredEvents: true,
        usageReporting: false,
        toolCallEvents: false,
        artifacts: false,
      },
      isAvailable: () => true,
      start: () => ({ pid: null, terminate: async () => {} }),
      normalizeEvent: () => [],
    };
    const supervisor = new WorkerSupervisor(config, store, new BackendRegistry(noModel));
    assert.throws(
      () => supervisor.spawnTask({ task: 'x', mode: 'general', model: 'k3' }),
      /does not support per-task model selection/,
    );
    store.close();
  } finally {
    removeDir(root);
  }
});
