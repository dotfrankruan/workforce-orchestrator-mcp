import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FakeScenarios, type FakeScenario } from '../../backends/fake.js';
import { makeTempRepo, makeHarness, git, removeDir } from '../helpers.js';

test('full lifecycle: spawn → worktree → commit → compact result', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(() => FakeScenarios.successWithCommit('feature.txt', 'new feature\n', 'add feature'));
  try {
    const headBefore = git(['rev-parse', 'HEAD'], repo).trim();
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'add a feature file' });
    assert.equal(spawn.status, 'queued');
    assert.match(spawn.worker_id, /^wk_[0-9a-f]{8}$/);
    assert.equal(spawn.branch, `kimi-worker/${spawn.worker_id}`);

    const row = await h.supervisor.waitFor(spawn.worker_id);
    assert.equal(row.status, 'completed');
    assert.ok(row.session_id, 'session id persisted');
    assert.ok(row.session_id.startsWith('session-fake-'));
    assert.ok(row.commit_hash, 'commit hash recorded');
    assert.equal(row.input_tokens, 200);
    assert.equal(row.output_tokens, 80);
    assert.equal(row.cache_read_tokens, 100);

    // Worktree and branch exist.
    assert.ok(fs.existsSync(path.join(spawn.worktree, 'feature.txt')));
    const branches = git(['branch', '--list', 'kimi-worker/*'], repo);
    assert.ok(branches.includes(spawn.branch));

    // Main working tree untouched.
    assert.equal(git(['rev-parse', 'HEAD'], repo).trim(), headBefore);
    assert.ok(!fs.existsSync(path.join(repo, 'feature.txt')));
    assert.equal(git(['status', '--porcelain'], repo).trim(), '');

    // Compact result is verified from git.
    const result = h.supervisor.result(spawn.worker_id) as Record<string, unknown>;
    assert.equal(result['status'], 'completed');
    assert.deepEqual(result['changed_files'], ['feature.txt']);
    assert.equal(result['commit_hash'], (row.commit_hash as string).slice(0, 7));
    assert.deepEqual(result['uncommitted_changes'], []);
    const usage = result['usage'] as Record<string, unknown>;
    assert.equal(usage['input_tokens'], 200);
    const tests = result['tests'] as Record<string, unknown>;
    assert.equal(tests['status'], 'pass');
    assert.ok(Array.isArray(result['summary']));

    // Result must not contain thinking or transcripts.
    const json = JSON.stringify(result);
    assert.ok(!json.includes('planning the change'));

    // Log is available but compact.
    const log = h.supervisor.log(spawn.worker_id, 100);
    assert.ok(log.lines.includes('[session]'));
    assert.ok(log.lines.includes('[final]'));
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('queued worker waits when concurrency is exhausted', async () => {
  const repo = makeTempRepo();
  let releaseFirst!: () => void;
  const gate = new Promise<void>((r) => (releaseFirst = r));
  const h = makeHarness(
    ({ workerId }): FakeScenario => ({
      steps: [
        { emit: { type: 'status', phase: 'turn_start', turn: 1 } },
        { sleep: 50 },
        { emit: { type: 'final', text: `Summary:\n- done ${workerId}` } },
      ],
      exitCode: 0,
    }),
    { maxConcurrent: 1 },
  );
  try {
    const s1 = h.supervisor.spawn({ repo_path: repo, task: 'task one' });
    const s2 = h.supervisor.spawn({ repo_path: repo, task: 'task two' });
    // Give the scheduler a tick.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.store.getWorker(s1.worker_id)?.status, 'running');
    assert.equal(h.store.getWorker(s2.worker_id)?.status, 'queued');

    await h.supervisor.waitFor(s1.worker_id);
    await h.supervisor.waitFor(s2.worker_id);
    assert.equal(h.store.getWorker(s1.worker_id)?.status, 'completed');
    assert.equal(h.store.getWorker(s2.worker_id)?.status, 'completed');
    void gate;
  } finally {
    releaseFirst();
    h.cleanup();
    removeDir(repo);
  }
});

test('cancel terminates a running worker and preserves worktree', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(() => FakeScenarios.hang());
  try {
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'never-ending task' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.store.getWorker(spawn.worker_id)?.status, 'running');

    const res = await h.supervisor.cancelWorker(spawn.worker_id);
    assert.equal(res.status, 'cancelled');
    const row = h.store.getWorker(spawn.worker_id)!;
    assert.equal(row.status, 'cancelled');
    assert.ok(row.finished_at);
    // Worktree and logs preserved.
    assert.ok(fs.existsSync(spawn.worktree));
    assert.ok(fs.existsSync(path.join(row.log_dir, 'stdout.jsonl')));
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('worker exceeding timeout is terminated and marked timeout', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(() => FakeScenarios.hang());
  try {
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'slow task', timeout_seconds: 1 });
    const row = await h.supervisor.waitFor(spawn.worker_id);
    assert.equal(row.status, 'timeout');
    assert.ok(row.error?.includes('timeout'));
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('worker leaves changes uncommitted → supervisor commits them (no follow-up run)', async () => {
  const repo = makeTempRepo();
  // Fake modifies files but never commits — the supervisor finalizes git.
  const h = makeHarness(() => FakeScenarios.noCommit('dirty.txt', 'dirty\n'));
  try {
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'change without commit' });
    const row = await h.supervisor.waitFor(spawn.worker_id);
    assert.equal(row.status, 'completed');
    assert.equal(row.commit_followup_used, 0, 'no wasteful follow-up run anymore');
    assert.ok(row.commit_hash, 'supervisor commit recorded');

    const result = h.supervisor.result(spawn.worker_id) as Record<string, any>;
    assert.deepEqual(result['changed_files'], ['dirty.txt']);
    assert.deepEqual(result['uncommitted_changes'], []);
    assert.ok(result['commit_hash']);
    assert.equal(result['git']['commit_created_by'], 'supervisor');
    assert.equal(result['git']['working_tree_clean'], true);
    assert.equal(result['git']['commit_count'], 1);
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('malformed stdout lines are logged, not fatal', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(() => FakeScenarios.malformed());
  try {
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'noisy output' });
    const row = await h.supervisor.waitFor(spawn.worker_id);
    assert.equal(row.status, 'completed');
    const events = h.store.listEvents(spawn.worker_id, 50);
    assert.ok(events.some((e) => e.type === 'malformed'));
    const log = h.supervisor.log(spawn.worker_id);
    assert.ok(log.lines.includes('[malformed]'));
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('failed run (non-zero exit) is marked failed', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(() => FakeScenarios.failure(3));
  try {
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'doomed task' });
    const row = await h.supervisor.waitFor(spawn.worker_id);
    assert.equal(row.status, 'failed');
    assert.equal(row.exit_code, 3);
    assert.ok(row.error?.includes('code=3'));
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('continue_worker resumes the same session in the same worktree', async () => {
  const repo = makeTempRepo();
  const seen: Array<{ resume: boolean; cwd: string }> = [];
  const h = makeHarness(({ resume, cwd }) => {
    seen.push({ resume, cwd });
    return resume
      ? FakeScenarios.successWithCommit('rework.txt', 'rework\n', 'apply review feedback')
      : FakeScenarios.successWithCommit('feature.txt', 'v1\n', 'initial work');
  });
  try {
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'initial task' });
    const row = await h.supervisor.waitFor(spawn.worker_id);
    assert.equal(row.status, 'completed');
    const sessionId = row.session_id!;

    const cont = await h.supervisor.continueWorker(spawn.worker_id, 'please add rework.txt');
    assert.equal(cont.session_id, sessionId);
    const row2 = await h.supervisor.waitFor(spawn.worker_id);
    assert.equal(row2.status, 'completed');
    assert.equal(row2.continue_count, 1);
    assert.equal(row2.session_id, sessionId, 'same session reused');

    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.resume, false);
    assert.equal(seen[1]?.resume, true);
    assert.equal(seen[0]?.cwd, seen[1]?.cwd, 'same worktree');

    const result = h.supervisor.result(spawn.worker_id) as Record<string, unknown>;
    assert.deepEqual(result['changed_files'], ['feature.txt', 'rework.txt']);

    // Continuing an active worker is rejected.
    const h2id = spawn.worker_id;
    await assert.rejects(() => h.supervisor.continueWorker('wk_ffffffff', 'nope'), /unknown worker/);
    void h2id;
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('get_worker_diff defaults to stat and can return full diff capped', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(() => FakeScenarios.successWithCommit('big.txt', 'line\n'.repeat(5000), 'big change'));
  try {
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'big change' });
    await h.supervisor.waitFor(spawn.worker_id);

    const stat = h.supervisor.diff(spawn.worker_id, {}) as Record<string, unknown>;
    assert.equal(stat['stat_only'], true);
    assert.ok(String(stat['diff_stat']).includes('big.txt'));
    assert.ok(!('diff' in stat));

    const full = h.supervisor.diff(spawn.worker_id, { stat_only: false }) as Record<string, unknown>;
    assert.equal(full['stat_only'], false);
    assert.ok(String(full['diff']).includes('+line'));
    assert.ok(Buffer.byteLength(String(full['diff']), 'utf8') <= h.config.diffMaxBytes);

    // path traversal rejected
    assert.throws(() => h.supervisor.diff(spawn.worker_id, { path: '../outside' }));
    assert.throws(() => h.supervisor.diff(spawn.worker_id, { path: '/etc/passwd' }));
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('log tail is capped at configured byte limit', async () => {
  const repo = makeTempRepo();
  const longText = 'y'.repeat(100_000);
  const h = makeHarness(() => ({
    steps: [
      { emit: { type: 'thinking', text: longText } },
      { emit: { type: 'final', text: 'done' } },
    ],
    exitCode: 0,
  }));
  try {
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'loud task' });
    await h.supervisor.waitFor(spawn.worker_id);
    const log = h.supervisor.log(spawn.worker_id, 100);
    assert.ok(Buffer.byteLength(log.lines, 'utf8') <= h.config.logMaxBytes);
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});
