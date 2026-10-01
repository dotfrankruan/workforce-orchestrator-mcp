import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { FakeScenario } from '../../backends/fake.js';
import { computeCacheKey, workspaceFingerprint, normalizeTaskText, CACHE_SCHEMA_VERSION } from '../../cache.js';
import { makeTempRepo, makeTempDir, makeHarness, git, removeDir } from '../helpers.js';

const researchScenario = (): FakeScenario => ({
  steps: [
    { writeFile: { path: 'report.md', content: '# Report\n\nFindings.\n' } },
    { writeFile: { path: 'sources.json', content: '[]\n' } },
    { emit: { type: 'status', phase: 'step_end', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0 } } },
    { emit: { type: 'final', text: 'Summary:\n- researched' } },
  ],
  exitCode: 0,
});

test('cache miss → run → write entry; identical task hits cache (no new backend run)', async () => {
  let backendRuns = 0;
  const h = makeHarness(() => {
    backendRuns++;
    return researchScenario();
  });
  try {
    const first = h.supervisor.spawnTask({
      task: 'TAG_CACHE research topic',
      mode: 'research',
      cache_policy: 'read_write',
    });
    const row1 = await h.supervisor.waitFor(first.task_id);
    assert.equal(row1.status, 'completed');
    assert.equal(backendRuns, 1);
    assert.equal(h.store.cacheStats().entries, 1);

    // Same task in another fresh temporary workspace → hit.
    const second = h.supervisor.spawnTask({
      task: 'TAG_CACHE research topic',
      mode: 'research',
      cache_policy: 'read_write',
    });
    assert.equal(second.status, 'completed', 'cache hit completes immediately');
    assert.equal(backendRuns, 1, 'no new DSH/backend run on cache hit');
    assert.ok(second.cache?.hit);
    assert.equal(second.cache?.source_task_id, first.task_id);
    assert.ok(typeof second.cache?.age_seconds === 'number');

    // Artifacts were copied and indexed for the new task.
    const artifacts = h.supervisor.listArtifacts(second.task_id);
    assert.deepEqual(artifacts.map((a) => a['path']).sort(), ['report.md', 'sources.json']);
    const content = h.supervisor.artifactContent(second.task_id, 'report.md');
    assert.ok(String(content['content']).includes('Findings'));
    // No fake session fabricated.
    assert.equal(h.store.getWorker(second.task_id)!.session_id, null);
    assert.equal(h.store.cacheStats().hits, 1);
  } finally {
    h.cleanup();
  }
});

test('cache_policy=off never reads or writes', async () => {
  let runs = 0;
  const h = makeHarness(() => {
    runs++;
    return researchScenario();
  });
  try {
    const a = h.supervisor.spawnTask({ task: 'TAG_OFF x', mode: 'research' });
    await h.supervisor.waitFor(a.task_id);
    const b = h.supervisor.spawnTask({ task: 'TAG_OFF x', mode: 'research' });
    await h.supervisor.waitFor(b.task_id);
    assert.equal(runs, 2);
    assert.equal(h.store.cacheStats().entries, 0);
  } finally {
    h.cleanup();
  }
});

test('git workspace fingerprint: HEAD change invalidates; dirty diff invalidates', async () => {
  const repo = makeTempRepo();
  let runs = 0;
  const h = makeHarness(() => {
    runs++;
    return researchScenario();
  });
  try {
    const mk = () =>
      h.supervisor.spawnTask({
        task: 'TAG_GITCACHE review',
        mode: 'review',
        cache_policy: 'read_write',
        workspace: { type: 'git_worktree', repo_path: repo },
      });

    const t1 = mk();
    await h.supervisor.waitFor(t1.task_id);
    assert.equal(runs, 1);

    // Same HEAD, clean → hit. (worktree has artifacts from t1 but those are
    // in t1's own worktree; the new task's worktree starts clean at HEAD.)
    const t2 = mk();
    assert.equal(t2.status, 'completed');
    assert.ok(t2.cache?.hit);
    assert.equal(runs, 1);

    // Move HEAD → miss.
    fs.writeFileSync(path.join(repo, 'hello.txt'), 'changed\n');
    git(['add', '-A'], repo);
    git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'move head'], repo);
    const t3 = mk();
    await h.supervisor.waitFor(t3.task_id);
    assert.ok(!t3.cache?.hit, 'HEAD change is a cache miss');
    assert.equal(runs, 2);

    // Dirty MAIN repo does not affect worktree fingerprints: the worker
    // always gets a clean worktree at HEAD — same HEAD → hit.
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n');
    const t4 = mk();
    assert.ok(t4.cache?.hit, 'same worktree HEAD → hit (main-repo dirt is invisible to workers)');
    assert.equal(runs, 2, 'no new run');

    // But a dirty SHARED workflow workspace fingerprint includes the diff.
    const wt = (t3.workspace as { path: string }).path;
    const fClean = workspaceFingerprint('git_worktree', wt);
    fs.writeFileSync(path.join(wt, 'dirty.txt'), 'x\n');
    const fDirty = workspaceFingerprint('git_worktree', wt);
    assert.notEqual(fClean, fDirty, 'dirty worktree diff invalidates');
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('role/mode/task text all participate in the cache key', () => {
  const fp = workspaceFingerprint('temporary', '/nonexistent');
  const base = { fingerprint: fp, roleFragment: null };
  const k1 = computeCacheKey({ ...base, mode: 'research', role: null, task: 'Analyze X' });
  assert.equal(k1, computeCacheKey({ ...base, mode: 'research', role: null, task: '  analyze   x ' }), 'normalized task text');
  assert.notEqual(k1, computeCacheKey({ ...base, mode: 'data', role: null, task: 'Analyze X' }), 'mode matters');
  assert.notEqual(k1, computeCacheKey({ ...base, mode: 'research', role: 'researcher', task: 'Analyze X' }), 'role matters');
  assert.notEqual(k1, computeCacheKey({ ...base, mode: 'research', role: null, task: 'Analyze Y' }), 'task matters');
  assert.notEqual(k1, computeCacheKey({ ...base, mode: 'research', role: null, task: 'Analyze X', fingerprint: 'other' }), 'fingerprint matters');
});

test('refresh policy always executes and rewrites the entry', async () => {
  let runs = 0;
  const h = makeHarness(() => {
    runs++;
    return researchScenario();
  });
  try {
    const a = h.supervisor.spawnTask({ task: 'TAG_REFRESH x', mode: 'research', cache_policy: 'read_write' });
    await h.supervisor.waitFor(a.task_id);
    const b = h.supervisor.spawnTask({ task: 'TAG_REFRESH x', mode: 'research', cache_policy: 'refresh' });
    await h.supervisor.waitFor(b.task_id);
    assert.equal(runs, 2, 'refresh bypasses the read');
    assert.equal(h.store.cacheStats().entries, 1, 'entry rewritten in place');
  } finally {
    h.cleanup();
  }
});

test('read policy never writes', async () => {
  const h = makeHarness(() => researchScenario());
  try {
    const a = h.supervisor.spawnTask({ task: 'TAG_READ x', mode: 'research', cache_policy: 'read' });
    await h.supervisor.waitFor(a.task_id);
    assert.equal(h.store.cacheStats().entries, 0);
  } finally {
    h.cleanup();
  }
});

test('normalizeTaskText + schema version in key', () => {
  assert.equal(normalizeTaskText('  Hello\n World  '), 'hello world');
  assert.ok(CACHE_SCHEMA_VERSION >= 1);
});

test('directory fingerprint changes when files change', () => {
  const dir = makeTempDir('kwm-fp-');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  const f1 = workspaceFingerprint('directory', dir);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  const f2 = workspaceFingerprint('directory', dir);
  assert.notEqual(f1, f2);
  const f3 = workspaceFingerprint('directory', dir);
  assert.equal(f2, f3, 'stable when unchanged');
  removeDir(dir);
});
