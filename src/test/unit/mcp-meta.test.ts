import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, SERVER_INSTRUCTIONS } from '../../mcp/server.js';
import { loadConfig } from '../../config.js';
import { WorkerStore } from '../../db.js';
import { WorkerSupervisor } from '../../supervisor.js';
import { FakeBackend, FakeScenarios } from '../../backend/fake.js';
import { makeTempDir, removeDir } from '../helpers.js';

async function connectClient(): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const root = makeTempDir('kwm-mcp-');
  const config = loadConfig({ env: {}, workerRoot: root });
  const store = new WorkerStore(':memory:');
  const supervisor = new WorkerSupervisor(config, store, new FakeBackend({ scenario: () => FakeScenarios.success() }));
  const server = createMcpServer(supervisor);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'meta-test', version: '0.0.1' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
      store.close();
      removeDir(root);
    },
  };
}

test('initialize result carries server instructions', async () => {
  const { client, cleanup } = await connectClient();
  try {
    const instructions = client.getInstructions();
    assert.ok(instructions, 'instructions present');
    assert.equal(instructions, SERVER_INSTRUCTIONS);
  } finally {
    await cleanup();
  }
});

test('server instructions lead with the most important guidance', async () => {
  // Core semantics: delegation guidance, Codex's retained responsibilities,
  // human final control, compact-first policy, continue-over-redo.
  assert.match(SERVER_INSTRUCTIONS, /preferred execution backend/);
  assert.match(SERVER_INSTRUCTIONS, /Codex remains responsible for/);
  assert.match(SERVER_INSTRUCTIONS, /human user always has final control/);
  assert.match(SERVER_INSTRUCTIONS, /Do not delegate trivial one-step work/);
  assert.match(SERVER_INSTRUCTIONS, /compact by default/);
  assert.match(SERVER_INSTRUCTIONS, /continue_worker/);
  // Concise: not a wall of text.
  assert.ok(SERVER_INSTRUCTIONS.length < 2000, 'instructions stay concise');
});

test('every tool has a meaningful description', async () => {
  const { client, cleanup } = await connectClient();
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 26, 'all 26 tools registered');
    for (const tool of tools) {
      const desc = tool.description ?? '';
      assert.ok(desc.length >= 60, `${tool.name} description too short (${desc.length} chars)`);
      // No secrets, no local machine paths, no credential names.
      assert.ok(!desc.includes('/Users/'), `${tool.name} leaks a local path`);
      assert.ok(!desc.includes('/usr/local/bin'), `${tool.name} leaks a binary path`);
      assert.ok(!/api[_-]?key/i.test(desc), `${tool.name} mentions API keys`);
      assert.ok(!desc.includes('sk-'), `${tool.name} contains a key-like token`);
    }
  } finally {
    await cleanup();
  }
});

test('delegation-critical descriptions carry when/when-not semantics', async () => {
  const { client, cleanup } = await connectClient();
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? '']));

    const spawnTask = byName.get('spawn_task')!;
    assert.match(spawnTask, /Use proactively when/);
    assert.match(spawnTask, /Avoid using this tool for tiny edits/);
    assert.match(spawnTask, /Codex should normally retain planning/);

    assert.match(byName.get('continue_worker')!, /same Kimi\/DSH session/);
    assert.match(byName.get('continue_worker')!, /prefer continuing the existing task/);
    assert.match(byName.get('get_task_result')!, /default first inspection step/);
    assert.match(byName.get('list_artifacts')!, /without loading their contents/);
    assert.match(byName.get('get_artifact')!, /selectively/);
    assert.match(byName.get('get_worker_diff')!, /during review before accepting/);
    assert.match(byName.get('get_worker_log')!, /Do not fetch logs routinely/);
    assert.match(byName.get('get_worker')!, /Do NOT repeatedly poll/);
    assert.match(byName.get('list_workers')!, /not use list_workers as a polling loop/i);
    assert.match(byName.get('wait_task')!, /over repeatedly polling get_worker/);
    assert.match(byName.get('wait_task')!, /does NOT cancel or fail the worker/);
    assert.match(byName.get('wait_tasks')!, /instead of repeatedly polling each task/);
    assert.match(byName.get('wait_tasks')!, /triggered_by/);
    assert.match(byName.get('spawn_tasks')!, /independent tasks/);
    assert.match(byName.get('spawn_worker')!, /Legacy alias of spawn_task/);
  } finally {
    await cleanup();
  }
});

test('key parameter descriptions are present and accurate', async () => {
  const { client, cleanup } = await connectClient();
  try {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const spawnTask = byName.get('spawn_task')!;
    const props = (spawnTask.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
    assert.match(props['task']?.description ?? '', /bounded, outcome-oriented/);
    assert.match(props['mode']?.description ?? '', /research/);
    assert.match(props['deliverables']?.description ?? '', /must produce/);
    // capabilities must not over-promise a sandbox
    const cap = props['capabilities']?.description ?? '';
    assert.match(cap, /advisory/i);
    assert.match(cap, /NOT a hard security sandbox/);
    assert.match(props['timeout_seconds']?.description ?? '', /long builds/);

    const getArtifact = byName.get('get_artifact')!;
    const gaProps = (getArtifact.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
    assert.match(gaProps['max_bytes']?.description ?? '', /truncated/);
  } finally {
    await cleanup();
  }
});

test('instructions themselves contain no secrets or machine-local paths', () => {
  assert.ok(!SERVER_INSTRUCTIONS.includes('/Users/'));
  assert.ok(!SERVER_INSTRUCTIONS.includes('/usr/local/'));
  assert.ok(!/api[_-]?key/i.test(SERVER_INSTRUCTIONS));
});
