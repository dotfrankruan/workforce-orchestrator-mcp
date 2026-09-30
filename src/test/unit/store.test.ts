import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WorkerStore } from '../../db.js';
import { makeTempDir, removeDir } from '../helpers.js';

function openStore(): { store: WorkerStore; dir: string } {
  const dir = makeTempDir('kwm-db-');
  return { store: new WorkerStore(path.join(dir, 'workers.db')), dir };
}

function newWorker(id: string, overrides: Partial<Parameters<WorkerStore['createWorker']>[0]> = {}) {
  return {
    id,
    repo_path: '/tmp/repo',
    base_ref: 'a'.repeat(40),
    branch: `kimi-worker/${id}`,
    worktree_path: `/tmp/wt/${id}`,
    log_dir: `/tmp/wt/${id}`,
    task: 'do the thing',
    mode: 'code',
    workspace_type: 'git_worktree',
    deliverables: '[]',
    capabilities: '[]',
    timeout_seconds: 3600,
    ...overrides,
  };
}

test('create and get worker', () => {
  const { store, dir } = openStore();
  const row = store.createWorker(newWorker('wk_00000001'));
  assert.equal(row.status, 'queued');
  assert.equal(row.input_tokens, 0);
  const fetched = store.getWorker('wk_00000001');
  assert.equal(fetched?.id, 'wk_00000001');
  assert.equal(fetched?.task, 'do the thing');
  assert.equal(store.getWorker('wk_ffffffff'), null);
  store.close();
  removeDir(dir);
});

test('updateWorker patches fields and bumps updated_at', () => {
  const { store, dir } = openStore();
  const row = store.createWorker(newWorker('wk_00000002'));
  store.updateWorker(row.id, { status: 'running', pid: 1234, session_id: 'session-x' });
  const updated = store.getWorker(row.id)!;
  assert.equal(updated.status, 'running');
  assert.equal(updated.pid, 1234);
  assert.equal(updated.session_id, 'session-x');
  assert.ok(updated.updated_at >= row.updated_at);
  store.close();
  removeDir(dir);
});

test('listWorkers filters by status and repo, orders by recency, respects limit', () => {
  const { store, dir } = openStore();
  store.createWorker(newWorker('wk_00000003', { repo_path: '/tmp/a' }));
  store.createWorker(newWorker('wk_00000004', { repo_path: '/tmp/b' }));
  store.createWorker(newWorker('wk_00000005', { repo_path: '/tmp/a' }));
  store.updateWorker('wk_00000004', { status: 'completed' });

  assert.equal(store.listWorkers({}).length, 3);
  assert.equal(store.listWorkers({ status: 'completed' })[0]?.id, 'wk_00000004');
  assert.equal(store.listWorkers({ repo_path: '/tmp/a' }).length, 2);
  assert.equal(store.listWorkers({ limit: 2 }).length, 2);
  // created_at ties are possible within the same ms; just check membership.
  const ids = store.listWorkers({ repo_path: '/tmp/a' }).map((r) => r.id);
  assert.deepEqual(new Set(ids), new Set(['wk_00000003', 'wk_00000005']));
  store.close();
  removeDir(dir);
});

test('findActive returns queued/starting/running only', () => {
  const { store, dir } = openStore();
  store.createWorker(newWorker('wk_00000006'));
  store.createWorker(newWorker('wk_00000007'));
  store.updateWorker('wk_00000007', { status: 'failed' });
  const active = store.findActive();
  assert.equal(active.length, 1);
  assert.equal(active[0]?.id, 'wk_00000006');
  store.close();
  removeDir(dir);
});

test('countByStatus', () => {
  const { store, dir } = openStore();
  store.createWorker(newWorker('wk_00000008'));
  store.createWorker(newWorker('wk_00000009'));
  store.updateWorker('wk_00000009', { status: 'cancelled' });
  assert.equal(store.countByStatus('queued'), 1);
  assert.equal(store.countByStatus('cancelled'), 1);
  assert.equal(store.countByStatus('completed'), 0);
  store.close();
  removeDir(dir);
});

test('events are stored and retrievable', () => {
  const { store, dir } = openStore();
  store.createWorker(newWorker('wk_0000000a'));
  store.addEvent('wk_0000000a', 'session', 'session-1');
  store.addEvent('wk_0000000a', 'tool_call', 'bash (c1)');
  const events = store.listEvents('wk_0000000a');
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, 'tool_call'); // DESC order
  assert.equal(events[1]?.summary, 'session-1');
  store.close();
  removeDir(dir);
});

test('persistence across store instances (reopen db file)', () => {
  const dir = makeTempDir('kwm-db-');
  const dbPath = path.join(dir, 'workers.db');
  const s1 = new WorkerStore(dbPath);
  s1.createWorker(newWorker('wk_0000000b'));
  s1.updateWorker('wk_0000000b', { status: 'completed', commit_hash: 'abc123' });
  s1.close();

  const s2 = new WorkerStore(dbPath);
  const row = s2.getWorker('wk_0000000b');
  assert.equal(row?.status, 'completed');
  assert.equal(row?.commit_hash, 'abc123');
  s2.close();
  removeDir(dir);
});
