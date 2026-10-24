import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { FakeScenario } from '../../backends/fake.js';
import { makeTempRepo, makeHarness, git, removeDir } from '../helpers.js';

/** Fake worker that writes files and lets the supervisor commit. */
const writer = (files: Array<[string, string]>, finalText?: string): FakeScenario => ({
  steps: [
    ...files.map(([p, c]) => ({ writeFile: { path: p, content: c } }) as const),
    { emit: { type: 'final', text: finalText ?? 'Summary:\n- wrote files' } },
  ],
  exitCode: 0,
});

function gitWorkflow(
  h: ReturnType<typeof makeHarness>,
  repo: string,
  tasks: Array<Record<string, unknown>>,
) {
  return h.supervisor.createWorkflow({
    workspace: { type: 'git_worktree', repo_path: repo },
    tasks: tasks as never,
  }) as Record<string, any>;
}

test('parallel git writers: isolated worktrees, branches, integration contains both', async () => {
  const repo = makeTempRepo();
  const base = git(['rev-parse', 'HEAD'], repo).trim();
  const h = makeHarness(({ prompt }) =>
    prompt.includes('TAG_B') ? writer([['b.txt', 'B\n']]) : prompt.includes('TAG_C') ? writer([['c.txt', 'C\n']]) : writer([['a.txt', 'A\n']]),
  );
  try {
    const wf = gitWorkflow(h, repo, [
      { key: 'a', task: 'TAG_A write a.txt', mode: 'code' },
      { key: 'b', task: 'TAG_B write b.txt', mode: 'code', depends_on: ['a'] },
      { key: 'c', task: 'TAG_C write c.txt', mode: 'code', depends_on: ['a'] },
    ]);
    const done = await h.supervisor.waitWorkflow(wf.workflow_id, 30);
    assert.equal(done['status'], 'completed');

    const rows = h.store.workersInWorkflow(wf.workflow_id);
    const b = rows.find((r) => r.task_key === 'b')!;
    const c = rows.find((r) => r.task_key === 'c')!;

    // Physical isolation invariant.
    assert.notEqual(b.worktree_path, c.worktree_path);
    assert.notEqual(b.task_branch, c.task_branch);
    assert.match(b.task_branch!, /^workforce\/task\//);
    assert.match(c.task_branch!, /^workforce\/task\//);

    // Same starting point: A's integrated commit.
    assert.equal(b.workspace_base_commit, c.workspace_base_commit);
    assert.notEqual(b.workspace_base_commit, base);

    // Integration branch contains A+B+C; main untouched.
    const wfRow = h.store.getWorkflow(wf.workflow_id)!;
    const iwt = wfRow.workspace_path;
    assert.ok(fs.existsSync(path.join(iwt, 'a.txt')));
    assert.ok(fs.existsSync(path.join(iwt, 'b.txt')));
    assert.ok(fs.existsSync(path.join(iwt, 'c.txt')));
    assert.equal(git(['status', '--porcelain'], iwt).trim(), '');
    assert.equal(git(['rev-parse', 'HEAD'], repo).trim(), base);

    // Integration metadata.
    assert.equal(b.integration_status, 'integrated');
    assert.equal(c.integration_status, 'integrated');
    assert.deepEqual(JSON.parse(b.task_commits).length, 1);

    // workflow diff = A+B+C content.
    const wd = h.supervisor.workflowDiff(wf.workflow_id, {}) as Record<string, any>;
    assert.ok(wd['diff_stat'].includes('b.txt'));
    assert.ok(wd['diff_stat'].includes('c.txt'));
    assert.equal(wd['integration_branch'], wfRow.branch);
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('same-file conflict: abort, clean integration branch, C=conflict, downstream never starts', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(({ prompt }) =>
    prompt.includes('TAG_B') ? writer([['foo.txt', 'B\n']])
      : prompt.includes('TAG_C') ? writer([['foo.txt', 'C\n']])
        : prompt.includes('TAG_D') ? writer([['d.txt', 'D\n']])
          : writer([['a.txt', 'A\n']]),
  );
  try {
    const wf = gitWorkflow(h, repo, [
      { key: 'a', task: 'TAG_A base', mode: 'code' },
      { key: 'b', task: 'TAG_B writes foo', mode: 'code', depends_on: ['a'] },
      { key: 'c', task: 'TAG_C writes foo', mode: 'code', depends_on: ['a'] },
      { key: 'd', task: 'TAG_D downstream', mode: 'code', depends_on: ['c'] },
    ]);
    // Wait until C reaches a terminal execution state; the workflow itself
    // stays running because D remains waiting on a conflicted dependency.
    const rows0 = h.store.workersInWorkflow(wf.workflow_id);
    const cId = rows0.find((r) => r.task_key === 'c')!.id;
    const dId = rows0.find((r) => r.task_key === 'd')!.id;
    await h.supervisor.waitTask(cId, 30);

    const c = h.store.getWorker(cId)!;
    assert.equal(c.status, 'completed', 'execution itself completed');
    assert.equal(c.integration_status, 'conflict');

    // Integration branch: clean, contains B's content, no cherry-pick residue.
    const wfRow = h.store.getWorkflow(wf.workflow_id)!;
    const iwt = wfRow.workspace_path;
    assert.equal(fs.readFileSync(path.join(iwt, 'foo.txt'), 'utf8'), 'B\n');
    assert.equal(git(['status', '--porcelain'], iwt).trim(), '');
    assert.ok(!fs.existsSync(path.join(iwt, '.git', 'CHERRY_PICK_HEAD')));

    // Conflict metadata records files and commit.
    const err = JSON.parse(c.integration_error!);
    assert.deepEqual(err.files, ['foo.txt']);
    assert.ok(err.conflicting_commits.length === 1);

    // D must NOT start (conflicted dep keeps dependents waiting).
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.store.getWorker(dId)!.status, 'waiting_dependencies');
    const wfState = h.supervisor.getWorkflow(wf.workflow_id) as Record<string, any>;
    assert.equal(wfState['status'], 'running', 'workflow stays open until conflict resolved');
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('conflict recovery: continue_worker reworks C from latest integration HEAD', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(({ prompt }) => {
    if (prompt.includes('Re-apply')) {
      // Rework run: keeps B's line, adds its own (resolves the conflict).
      return writer([['foo.txt', 'B\nC\n']], 'Summary:\n- reworked on top of B');
    }
    if (prompt.includes('TAG_B')) return writer([['foo.txt', 'B\n']]);
    if (prompt.includes('TAG_C')) return writer([['foo.txt', 'C\n']]);
    return writer([['a.txt', 'A\n']]);
  });
  try {
    const wf = gitWorkflow(h, repo, [
      { key: 'a', task: 'TAG_A base', mode: 'code' },
      { key: 'b', task: 'TAG_B writes foo', mode: 'code', depends_on: ['a'] },
      { key: 'c', task: 'TAG_C writes foo', mode: 'code', depends_on: ['a'] },
    ]);
    const rows0 = h.store.workersInWorkflow(wf.workflow_id);
    const cId = rows0.find((r) => r.task_key === 'c')!.id;
    await h.supervisor.waitTask(cId, 30);
    assert.equal(h.store.getWorker(cId)!.integration_status, 'conflict');

    // Codex resolves: continue C with rework instruction.
    await h.supervisor.continueWorker(cId, 'Re-apply your change on top of the integrated state (foo.txt already contains B).');
    const row = await h.supervisor.waitFor(cId);
    assert.equal(row.status, 'completed');
    assert.equal(row.integration_status, 'integrated');

    const wfRow = h.store.getWorkflow(wf.workflow_id)!;
    assert.equal(fs.readFileSync(path.join(wfRow.workspace_path, 'foo.txt'), 'utf8'), 'B\nC\n');
    const done = await h.supervisor.waitWorkflow(wf.workflow_id, 30);
    assert.equal(done['status'], 'completed');
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('fan-in: D materializes only after B AND C are integrated', async () => {
  const repo = makeTempRepo();
  const base = git(['rev-parse', 'HEAD'], repo).trim();
  const h = makeHarness(({ prompt }) =>
    prompt.includes('TAG_B') ? writer([['b.txt', 'B\n']])
      : prompt.includes('TAG_C') ? writer([['c.txt', 'C\n']])
        : prompt.includes('TAG_D') ? writer([['d.txt', 'D\n']])
          : writer([['a.txt', 'A\n']]),
  );
  try {
    const wf = gitWorkflow(h, repo, [
      { key: 'a', task: 'TAG_A', mode: 'code' },
      { key: 'b', task: 'TAG_B', mode: 'code', depends_on: ['a'] },
      { key: 'c', task: 'TAG_C', mode: 'code', depends_on: ['a'] },
      { key: 'd', task: 'TAG_D', mode: 'code', depends_on: ['b', 'c'] },
    ]);
    const done = await h.supervisor.waitWorkflow(wf.workflow_id, 30);
    assert.equal(done['status'], 'completed');

    const d = h.store.workersInWorkflow(wf.workflow_id).find((r) => r.task_key === 'd')!;
    // D's snapshot contains both B and C.
    assert.ok(d.workspace_base_commit);
    const files = git(['ls-tree', '--name-only', '-r', d.workspace_base_commit!], repo).trim().split('\n').sort();
    assert.deepEqual(files, ['a.txt', 'b.txt', 'c.txt', 'hello.txt']);
    assert.notEqual(d.workspace_base_commit, base);
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('read-only snapshot: review task pinned to commit X while integration moves on', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(({ prompt }) =>
    prompt.includes('TAG_W1') ? writer([['w1.txt', 'w1\n']])
      : prompt.includes('TAG_W2') ? writer([['w2.txt', 'w2\n']])
        : writer([['review.md', '# review\n']]),
  );
  try {
    // w1 → review (snapshot) ; w2 (independent of review) keeps going.
    const wf = gitWorkflow(h, repo, [
      { key: 'w1', task: 'TAG_W1', mode: 'code' },
      { key: 'w2', task: 'TAG_W2', mode: 'code', depends_on: ['w1'] },
      { key: 'rev', task: 'TAG_REVIEW', mode: 'review', depends_on: ['w1'] },
    ]);
    const done = await h.supervisor.waitWorkflow(wf.workflow_id, 30);
    assert.equal(done['status'], 'completed');

    const rows = h.store.workersInWorkflow(wf.workflow_id);
    const rev = rows.find((r) => r.task_key === 'rev')!;
    const w2 = rows.find((r) => r.task_key === 'w2')!;

    // rev and w2 both started from the same snapshot (post-w1).
    assert.equal(rev.workspace_base_commit, w2.workspace_base_commit);
    // rev's snapshot does NOT contain w2's file even though w2 integrated later.
    const revFiles = git(['ls-tree', '--name-only', '-r', rev.workspace_base_commit!], repo);
    assert.ok(!revFiles.includes('w2.txt'));
    // Integration HEAD has both.
    const wfRow = h.store.getWorkflow(wf.workflow_id)!;
    assert.ok(fs.existsSync(path.join(wfRow.workspace_path, 'w2.txt')));
    assert.ok(fs.existsSync(path.join(wfRow.workspace_path, 'review.md')));
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('continue after sibling integration: continuation starts from integrated HEAD (A+B)', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(({ prompt }) => {
    if (prompt.includes('TAG_B')) return writer([['b.txt', 'B\n']]);
    // Continuation prompt carries the instruction (fresh session by design).
    if (prompt.includes('add a2.txt')) return writer([['a2.txt', 'A2\n']]);
    return writer([['a.txt', 'A\n']]);
  });
  try {
    const wf = gitWorkflow(h, repo, [
      { key: 'a', task: 'TAG_A', mode: 'code' },
      { key: 'b', task: 'TAG_B', mode: 'code' },
    ]);
    await h.supervisor.waitWorkflow(wf.workflow_id, 30);

    const aId = h.store.workersInWorkflow(wf.workflow_id).find((r) => r.task_key === 'a')!.id;
    await h.supervisor.continueWorker(aId, 'add a2.txt');
    const row = await h.supervisor.waitFor(aId);
    assert.equal(row.status, 'completed');

    // Continuation snapshot contains BOTH A and B.
    const files = git(['ls-tree', '--name-only', '-r', row.workspace_base_commit!], repo);
    assert.ok(files.includes('a.txt'));
    assert.ok(files.includes('b.txt'));
    // New worktree path & branch (old preserved for audit).
    assert.ok(row.worktree_path.includes('worktree-r1'));
    assert.match(row.task_branch!, /^workforce\/task\/.+-r1$/);
    assert.equal(row.integration_status, 'integrated');

    const wfRow = h.store.getWorkflow(wf.workflow_id)!;
    assert.ok(fs.existsSync(path.join(wfRow.workspace_path, 'a2.txt')));
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('integration serialization: per-workflow mutex never overlaps', async () => {
  const h = makeHarness(() => writer([['x.txt', 'x\n']]));
  try {
    // Unit-level: overlapping critical sections are impossible.
    const sup = h.supervisor as unknown as {
      withIntegrationLock<T>(id: string, fn: () => Promise<T> | T): Promise<T>;
    };
    let inSection = 0;
    let maxConcurrent = 0;
    const job = () =>
      sup.withIntegrationLock('wf_x', async () => {
        inSection++;
        maxConcurrent = Math.max(maxConcurrent, inSection);
        await new Promise((r) => setTimeout(r, 30));
        inSection--;
      });
    await Promise.all([job(), job(), job(), job()]);
    assert.equal(maxConcurrent, 1);
  } finally {
    h.cleanup();
  }
});

test('retries exhausted → failure metadata for Codex/human handoff', async () => {
  let runs = 0;
  const h = makeHarness(() => {
    runs++;
    return { steps: [{ emit: { type: 'text', text: 'boom' } }], exitCode: 1 } as FakeScenario;
  });
  try {
    const s = h.supervisor.spawnTask({
      task: 'TAG_FAIL always',
      mode: 'general',
      retry: { max_attempts: 2, retry_on: ['failed'] },
    });
    const row = await h.supervisor.waitFor(s.task_id);
    assert.equal(row.status, 'failed');
    assert.equal(runs, 2);

    const result = h.supervisor.taskResult(s.task_id) as Record<string, any>;
    assert.equal(result['attempts'], 2);
    assert.equal(result['retries_exhausted'], true);
    assert.equal(result['work_preserved'], true);
    assert.ok(result['error']);
  } finally {
    h.cleanup();
  }
});
