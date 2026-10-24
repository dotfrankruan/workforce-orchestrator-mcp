import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FakeScenarios, type FakeScenario } from '../../backends/fake.js';
import { makeTempRepo, makeHarness, git, removeDir } from '../helpers.js';

const COMMIT_ENV_ARGS = ['-c', 'user.name=workforce-worker', '-c', 'user.email=workforce-worker@localhost', '-c', 'commit.gpgsign=false'];

/** Fake worker that modifies files and exits 0 WITHOUT committing. */
function editOnlyScenario(edits: Array<{ path: string; content: string }>, finalText?: string): FakeScenario {
  return {
    steps: [
      { emit: { type: 'status', phase: 'turn_start', turn: 1 } },
      ...edits.map((e) => ({ writeFile: { path: e.path, content: e.content } }) as const),
      {
        emit: {
          type: 'final',
          text: finalText ?? `Summary:\n- edited files\n\nsuggested_commit_message: apply requested changes`,
        },
      },
    ],
    exitCode: 0,
  };
}

test('supervisor commits worker changes; main tree untouched; both files in commit', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(() =>
    editOnlyScenario([
      { path: 'hello.txt', content: 'hello world\n' },
      { path: 'new.txt', content: 'new file\n' },
    ]),
  );
  try {
    const headBefore = git(['rev-parse', 'HEAD'], repo).trim();
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'edit files' });
    const row = await h.supervisor.waitFor(spawn.worker_id);

    assert.equal(row.status, 'completed');
    assert.ok(row.commit_hash);

    // Worktree clean, branch contains both files.
    assert.equal(git(['status', '--porcelain'], spawn.worktree).trim(), '');
    const files = git(['show', '--name-only', '--format=', 'HEAD'], spawn.worktree).trim().split('\n').sort();
    assert.deepEqual(files, ['hello.txt', 'new.txt']);

    // Commit message from worker suggestion.
    const subject = git(['log', '-1', '--format=%s'], spawn.worktree).trim();
    assert.equal(subject, 'apply requested changes');

    // Main repo untouched.
    assert.equal(git(['rev-parse', 'HEAD'], repo).trim(), headBefore);
    assert.equal(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8'), 'hello\n');
    assert.ok(!fs.existsSync(path.join(repo, 'new.txt')));
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('worker already committed → supervisor does not duplicate', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(() => FakeScenarios.successWithCommit('feat.txt', 'f\n', 'worker commit'));
  try {
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'x' });
    const row = await h.supervisor.waitFor(spawn.worker_id);
    assert.equal(row.status, 'completed');
    const result = h.supervisor.taskResult(spawn.worker_id) as Record<string, any>;
    assert.equal(result['git']['commit_count'], 1);
    assert.equal(result['git']['commit_created_by'], 'worker');
    assert.equal(result['git']['supervisor_created_commit'], false);
    assert.equal(git(['log', '-1', '--format=%s'], spawn.worktree).trim(), 'worker commit');
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('worker commit + remaining dirty changes → supervisor adds second commit', async () => {
  const repo = makeTempRepo();
  const scenario: FakeScenario = {
    steps: [
      { writeFile: { path: 'a.txt', content: 'a\n' } },
      { git: ['add', '-A'] },
      { git: [...COMMIT_ENV_ARGS, 'commit', '-m', 'worker commit A'] },
      { writeFile: { path: 'b.txt', content: 'b\n' } }, // left uncommitted
      { emit: { type: 'final', text: 'Summary:\n- did a and b' } },
    ],
    exitCode: 0,
  };
  const h = makeHarness(() => scenario);
  try {
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'x' });
    const row = await h.supervisor.waitFor(spawn.worker_id);
    assert.equal(row.status, 'completed');
    assert.equal(git(['status', '--porcelain'], spawn.worktree).trim(), '');

    const result = h.supervisor.taskResult(spawn.worker_id) as Record<string, any>;
    assert.equal(result['git']['commit_count'], 2);
    assert.equal(result['git']['commit_created_by'], 'worker+supervisor');
    assert.equal(result['git']['supervisor_created_commit'], true);
    // commit_hash points at the latest HEAD (the supervisor commit).
    assert.equal(result['commit_hash'], git(['rev-parse', '--short', 'HEAD'], spawn.worktree).trim());
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('continue_worker: supervisor creates one commit per run', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(({ resume }) =>
    resume
      ? editOnlyScenario([{ path: 'b.txt', content: 'b\n' }], 'Summary:\n- added b\n\nsuggested_commit_message: add b.txt')
      : editOnlyScenario([{ path: 'a.txt', content: 'a\n' }], 'Summary:\n- added a\n\nsuggested_commit_message: add a.txt'),
  );
  try {
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'first run' });
    await h.supervisor.waitFor(spawn.worker_id);

    const log1 = git(['log', '--format=%s'], spawn.worktree).trim().split('\n');
    assert.equal(log1[0], 'add a.txt');

    await h.supervisor.continueWorker(spawn.worker_id, 'now add b.txt');
    const row2 = await h.supervisor.waitFor(spawn.worker_id);
    assert.equal(row2.status, 'completed');

    const log2 = git(['log', '--format=%s'], spawn.worktree).trim().split('\n');
    assert.equal(log2[0], 'add b.txt');
    assert.equal(log2[1], 'add a.txt');
    assert.equal(git(['status', '--porcelain'], spawn.worktree).trim(), '');

    const result = h.supervisor.taskResult(spawn.worker_id) as Record<string, any>;
    assert.equal(result['git']['commit_count'], 2);
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('no changes → completed without empty commit', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(() => ({
    steps: [{ emit: { type: 'final', text: 'Summary:\n- nothing to do' } }],
    exitCode: 0,
  }));
  try {
    const base = git(['rev-parse', 'HEAD'], repo).trim();
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'noop' });
    const row = await h.supervisor.waitFor(spawn.worker_id);
    assert.equal(row.status, 'completed');
    assert.equal(row.commit_hash, null);
    assert.equal(git(['rev-parse', 'HEAD'], spawn.worktree).trim(), base, 'no empty commit created');
    const result = h.supervisor.taskResult(spawn.worker_id) as Record<string, any>;
    assert.equal(result['git']['commit_created'], false);
    assert.equal(result['git']['commit_count'], 0);
    assert.equal(result['git']['working_tree_clean'], true);
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('supervisor commit failure → completed_uncommitted, worktree preserved', async () => {
  const repo = makeTempRepo();
  // Break commits with a failing pre-commit hook (shared by worktrees).
  const hooksDir = path.join(repo, '.git', 'hooks');
  fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  const h = makeHarness(() => editOnlyScenario([{ path: 'x.txt', content: 'x\n' }]));
  try {
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'will not commit' });
    const row = await h.supervisor.waitFor(spawn.worker_id);
    assert.equal(row.status, 'completed_uncommitted');
    assert.ok(row.error?.includes('supervisor commit failed'));
    // Changes are preserved, not lost.
    assert.equal(fs.readFileSync(path.join(spawn.worktree, 'x.txt'), 'utf8'), 'x\n');
    const result = h.supervisor.taskResult(spawn.worker_id) as Record<string, any>;
    assert.equal(result['git']['working_tree_clean'], false);
    assert.ok(result['git']['error']);
    assert.equal(result['git']['commit_created'], false);
  } finally {
    fs.rmSync(path.join(hooksDir, 'pre-commit'), { force: true });
    h.cleanup();
    removeDir(repo);
  }
});

test('cancelled worker with dirty worktree → no auto commit', async () => {
  const repo = makeTempRepo();
  const scenario: FakeScenario = {
    steps: [
      { writeFile: { path: 'dirty.txt', content: 'dirty\n' } },
      { hang: true },
    ],
  };
  const h = makeHarness(() => scenario);
  try {
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'hangs dirty' });
    await new Promise((r) => setTimeout(r, 100));
    await h.supervisor.cancelWorker(spawn.worker_id);
    const row = h.store.getWorker(spawn.worker_id)!;
    assert.equal(row.status, 'cancelled');
    assert.equal(row.commit_hash, null);
    // Dirty file preserved, uncommitted.
    assert.ok(fs.existsSync(path.join(spawn.worktree, 'dirty.txt')));
    const result = h.supervisor.taskResult(spawn.worker_id) as Record<string, any>;
    assert.equal(result['git']['working_tree_clean'], false);
    assert.match(String(result['git']['auto_commit_skipped']), /cancelled/);
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('timed-out worker with dirty worktree → no auto commit', async () => {
  const repo = makeTempRepo();
  const scenario: FakeScenario = {
    steps: [
      { writeFile: { path: 'dirty.txt', content: 'dirty\n' } },
      { hang: true },
    ],
  };
  const h = makeHarness(() => scenario);
  try {
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'times out', timeout_seconds: 1 });
    const row = await h.supervisor.waitFor(spawn.worker_id);
    assert.equal(row.status, 'timeout');
    assert.equal(row.commit_hash, null);
    const result = h.supervisor.taskResult(spawn.worker_id) as Record<string, any>;
    assert.match(String(result['git']['auto_commit_skipped']), /timed out/);
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('failed worker with dirty worktree → no auto commit', async () => {
  const repo = makeTempRepo();
  const scenario: FakeScenario = {
    steps: [
      { writeFile: { path: 'dirty.txt', content: 'dirty\n' } },
      { emit: { type: 'text', text: 'boom' } },
    ],
    exitCode: 5,
  };
  const h = makeHarness(() => scenario);
  try {
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'fails dirty' });
    const row = await h.supervisor.waitFor(spawn.worker_id);
    assert.equal(row.status, 'failed');
    assert.equal(row.commit_hash, null);
    const result = h.supervisor.taskResult(spawn.worker_id) as Record<string, any>;
    assert.match(String(result['git']['auto_commit_skipped']), /failed/);
    assert.equal(result['git']['working_tree_clean'], false);
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('identity fallback: repo without user.name/email commits via -c, global config untouched', async () => {
  const dir = makeTempRepo();
  // Remove identity at the repo level (globals may exist on the host).
  git(['config', '--unset', 'user.name'], dir);
  git(['config', '--unset', 'user.email'], dir);
  // Empty-string local overrides force the fallback path deterministically.
  git(['config', 'user.name', ''], dir);
  git(['config', 'user.email', ''], dir);

  const h = makeHarness(() => editOnlyScenario([{ path: 'id.txt', content: 'id\n' }]));
  try {
    const spawn = h.supervisor.spawn({ repo_path: dir, task: 'x' });
    const row = await h.supervisor.waitFor(spawn.worker_id);
    assert.equal(row.status, 'completed');
    assert.ok(row.commit_hash);
    const author = git(['log', '-1', '--format=%an <%ae>'], spawn.worktree).trim();
    assert.equal(author, 'Workforce Orchestrator <workforce@localhost>');
  } finally {
    h.cleanup();
    removeDir(dir);
  }
});

test('suggested commit message is sanitized (single line, length-capped)', async () => {
  const repo = makeTempRepo();
  const long = 'x'.repeat(300);
  const h = makeHarness(() =>
    editOnlyScenario([{ path: 'm.txt', content: 'm\n' }], `Summary:\n- ok\n\nsuggested_commit_message: ${long}\nsecond line injection`),
  );
  try {
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'x' });
    await h.supervisor.waitFor(spawn.worker_id);
    const subject = git(['log', '-1', '--format=%s'], spawn.worktree).trim();
    assert.ok(subject.length <= 120);
    assert.ok(!subject.includes('second line'));
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('worker switching branches is refused (no commit on wrong branch)', async () => {
  const repo = makeTempRepo();
  const scenario: FakeScenario = {
    steps: [
      { git: ['checkout', '-b', 'evil-branch'] },
      { writeFile: { path: 'evil.txt', content: 'evil\n' } },
      { emit: { type: 'final', text: 'Summary:\n- switched branches' } },
    ],
    exitCode: 0,
  };
  const h = makeHarness(() => scenario);
  try {
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'x' });
    const row = await h.supervisor.waitFor(spawn.worker_id);
    assert.equal(row.status, 'completed_uncommitted');
    assert.match(row.error ?? '', /unexpected ref/);
    // Nothing committed on the rogue branch — it still points at the base.
    const base = git(['rev-parse', 'HEAD'], repo).trim();
    assert.equal(git(['rev-parse', 'evil-branch'], repo).trim(), base);
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});
