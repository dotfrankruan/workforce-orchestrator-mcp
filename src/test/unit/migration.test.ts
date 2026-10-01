import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkerStore, SCHEMA_V1 } from '../../db.js';
import { makeTempDir, removeDir } from '../helpers.js';

test('fresh database is created at current schema version', () => {
  const dir = makeTempDir('kwm-mig-');
  const store = new WorkerStore(path.join(dir, 'workers.db'));
  assert.equal(store.schemaVersion(), 6);
  store.close();
  removeDir(dir);
});

test('v1 database migrates automatically and old rows stay readable', () => {
  const dir = makeTempDir('kwm-mig-');
  const dbPath = path.join(dir, 'workers.db');

  // Build a genuine v1 fixture with the old schema only.
  const raw = new DatabaseSync(dbPath);
  raw.exec(SCHEMA_V1);
  raw
    .prepare(
      `INSERT INTO workers (id, repo_path, base_ref, branch, worktree_path, log_dir, status, task, created_at, updated_at, commit_hash, final_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'wk_legacy01', '/tmp/oldrepo', 'a'.repeat(40), 'kimi-worker/wk_legacy01',
      '/tmp/oldrepo-wt', '/tmp/oldrepo-logs', 'completed', 'legacy task',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 'deadbeef'.padEnd(40, '0'), 'done',
    );
  raw.close();

  // Opening with the new store must migrate in place.
  const store = new WorkerStore(dbPath);
  assert.equal(store.schemaVersion(), 6);

  const row = store.getWorker('wk_legacy01');
  assert.ok(row, 'legacy row still readable');
  assert.equal(row!.status, 'completed');
  assert.equal(row!.mode, 'code', 'legacy rows map to code mode');
  assert.equal(row!.workspace_type, 'git_worktree', 'legacy rows map to git_worktree');
  assert.equal(row!.deliverables, '[]');
  assert.equal(row!.capabilities, '[]');
  assert.equal(row!.deliverables_missing, null);
  assert.equal(row!.commit_hash, 'deadbeef'.padEnd(40, '0'));
  assert.equal(row!.final_text, 'done');

  // Artifacts table exists and works.
  store.upsertArtifact({
    task_id: 'wk_legacy01',
    relative_path: 'report.md',
    absolute_path: '/tmp/oldrepo-wt/report.md',
    mime_type: 'text/markdown',
    size_bytes: 10,
    sha256: 'abc',
  });
  assert.equal(store.listArtifacts('wk_legacy01').length, 1);

  // New-style rows can be inserted into the migrated db.
  store.createWorker({
    id: 'wk_new00001',
    repo_path: '',
    base_ref: '',
    branch: '',
    worktree_path: '/tmp/x',
    log_dir: '/tmp/x',
    task: 'new task',
    mode: 'research',
    workspace_type: 'temporary',
    deliverables: '["report.md"]',
    capabilities: '["web.search"]',
    timeout_seconds: 60,
  });
  assert.equal(store.getWorker('wk_new00001')!.mode, 'research');

  store.close();
  removeDir(dir);
});
