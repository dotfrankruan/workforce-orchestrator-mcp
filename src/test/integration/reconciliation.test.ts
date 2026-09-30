import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WorkerStore } from '../../db.js';
import { WorkerSupervisor } from '../../supervisor.js';
import { FakeBackend, FakeScenarios } from '../../backend/fake.js';
import { loadConfig, ensureConfigDirs } from '../../config.js';
import { makeTempRepo, makeHarness, makeTempDir, git, removeDir } from '../helpers.js';

test('reconciliation: dead pid + committed work → completed', async () => {
  const repo = makeTempRepo();
  const root = makeTempDir('kwm-root-');
  const config = loadConfig({ env: {}, workerRoot: root });
  ensureConfigDirs(config);

  // Simulate a worker that finished (with a commit) while the server was down.
  const workerId = 'wk_dead0001';
  const branch = `kimi-worker/${workerId}`;
  const workerDir = path.join(root, 'sim-repo', workerId);
  const worktreePath = path.join(workerDir, 'worktree');
  fs.mkdirSync(workerDir, { recursive: true });
  const base = git(['rev-parse', 'HEAD'], repo).trim();
  git(['worktree', 'add', '-b', branch, worktreePath, base], repo);
  fs.writeFileSync(path.join(worktreePath, 'done.txt'), 'done\n');
  git(['add', '-A'], worktreePath);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'finished work'], worktreePath);
  fs.writeFileSync(
    path.join(workerDir, 'stdout.jsonl'),
    [
      JSON.stringify({ type: 'session', sessionId: 'session-dead', cwd: worktreePath }),
      JSON.stringify({ type: 'status', phase: 'step_end', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
      JSON.stringify({ type: 'final', text: 'Summary:\n- finished before crash' }),
    ].join('\n') + '\n',
  );

  const store = new WorkerStore(config.dbPath);
  store.createWorker({
    id: workerId,
    repo_path: repo,
    base_ref: base,
    branch,
    worktree_path: worktreePath,
    log_dir: workerDir,
    task: 'simulated',
    mode: 'code',
    workspace_type: 'git_worktree',
    deliverables: '[]',
    capabilities: '[]',
    timeout_seconds: 3600,
  });
  store.updateWorker(workerId, { status: 'running', pid: 99999999, started_at: new Date().toISOString() });
  store.close();

  // Restart: a new supervisor instance reconciles.
  const store2 = new WorkerStore(config.dbPath);
  const supervisor = new WorkerSupervisor(config, store2, new FakeBackend({ scenario: () => FakeScenarios.success() }));
  supervisor.init();

  const row = store2.getWorker(workerId)!;
  assert.equal(row.status, 'completed');
  assert.equal(row.session_id, 'session-dead', 'session recovered from log');
  assert.equal(row.input_tokens, 10, 'usage recovered from log');
  assert.ok(row.commit_hash, 'commit recovered from git');
  assert.equal(row.final_text, 'Summary:\n- finished before crash');

  const result = supervisor.result(workerId) as Record<string, unknown>;
  assert.deepEqual(result['changed_files'], ['done.txt']);

  store2.close();
  removeDir(root);
  removeDir(repo);
});

test('reconciliation: dead pid with no commit and no final → interrupted', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(() => FakeScenarios.success());
  try {
    const workerId = 'wk_dead0002';
    const workerDir = path.join(h.root, 'sim', workerId);
    fs.mkdirSync(workerDir, { recursive: true });
    h.store.createWorker({
      id: workerId,
      repo_path: repo,
      base_ref: git(['rev-parse', 'HEAD'], repo).trim(),
      branch: `kimi-worker/${workerId}`,
      worktree_path: path.join(workerDir, 'worktree'),
      log_dir: workerDir,
      task: 'simulated',
      mode: 'code',
      workspace_type: 'git_worktree',
      deliverables: '[]',
      capabilities: '[]',
      timeout_seconds: 3600,
    });
    h.store.updateWorker(workerId, { status: 'running', pid: 99999998 });
    h.store.close();

    const store2 = new WorkerStore(h.config.dbPath);
    const supervisor = new WorkerSupervisor(h.config, store2, new FakeBackend({ scenario: () => FakeScenarios.success() }));
    supervisor.init();
    const row = store2.getWorker(workerId)!;
    assert.equal(row.status, 'interrupted');
    assert.ok(row.error);
    store2.close();
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('reconciliation: live pid (not ours) → interrupted, not left running', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(() => FakeScenarios.success());
  try {
    const workerId = 'wk_live001';
    const workerDir = path.join(h.root, 'sim', workerId);
    fs.mkdirSync(workerDir, { recursive: true });
    h.store.createWorker({
      id: workerId,
      repo_path: repo,
      base_ref: git(['rev-parse', 'HEAD'], repo).trim(),
      branch: `kimi-worker/${workerId}`,
      worktree_path: path.join(workerDir, 'worktree'),
      log_dir: workerDir,
      task: 'simulated',
      mode: 'code',
      workspace_type: 'git_worktree',
      deliverables: '[]',
      capabilities: '[]',
      timeout_seconds: 3600,
    });
    h.store.updateWorker(workerId, { status: 'running', pid: process.pid });
    h.store.close();

    const store2 = new WorkerStore(h.config.dbPath);
    const supervisor = new WorkerSupervisor(h.config, store2, new FakeBackend({ scenario: () => FakeScenarios.success() }));
    supervisor.init();
    const row = store2.getWorker(workerId)!;
    assert.equal(row.status, 'interrupted');
    assert.match(row.error ?? '', /server restarted/);
    store2.close();
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('reconciliation: queued workers survive restart and get scheduled', async () => {
  const repo = makeTempRepo();
  const root = makeTempDir('kwm-root-');
  const config = loadConfig({ env: {}, workerRoot: root });
  ensureConfigDirs(config);
  const base = git(['rev-parse', 'HEAD'], repo).trim();

  const workerId = 'wk_queued01';
  const workerDir = path.join(root, 'sim', workerId);
  const worktreePath = path.join(workerDir, 'worktree');
  fs.mkdirSync(workerDir, { recursive: true });
  git(['worktree', 'add', '-b', `kimi-worker/${workerId}`, worktreePath, base], repo);

  const store = new WorkerStore(config.dbPath);
  store.createWorker({
    id: workerId,
    repo_path: repo,
    base_ref: base,
    branch: `kimi-worker/${workerId}`,
    worktree_path: worktreePath,
    log_dir: workerDir,
    task: 'still queued',
    mode: 'code',
    workspace_type: 'git_worktree',
    deliverables: '[]',
    capabilities: '[]',
    timeout_seconds: 3600,
  });
  store.close();

  const store2 = new WorkerStore(config.dbPath);
  const supervisor = new WorkerSupervisor(config, store2, new FakeBackend({ scenario: () => FakeScenarios.successWithCommit() }));
  supervisor.init();
  const row = await supervisor.waitFor(workerId);
  assert.equal(row.status, 'completed');
  store2.close();
  removeDir(root);
  removeDir(repo);
});
