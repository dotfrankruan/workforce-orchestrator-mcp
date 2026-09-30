import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FakeScenarios, type FakeScenario } from '../../backend/fake.js';
import { WorkerSupervisor } from '../../supervisor.js';
import { makeTempRepo, makeHarness, git, removeDir } from '../helpers.js';

const quick = (tag: string): FakeScenario => ({
  steps: [
    { writeFile: { path: `${tag}.md`, content: `# ${tag}\n` } },
    { emit: { type: 'final', text: `Summary:\n- did ${tag}` } },
  ],
  exitCode: 0,
});

const fail = (): FakeScenario => FakeScenarios.failure(1);

test('linear DAG: A → B → C execute in order', async () => {
  const order: string[] = [];
  const h = makeHarness(({ prompt }) => {
    const tag = prompt.includes('task-a') ? 'a' : prompt.includes('task-b') ? 'b' : 'c';
    order.push(tag);
    return quick(tag);
  });
  try {
    const wf = h.supervisor.createWorkflow({
      name: 'linear',
      tasks: [
        { key: 'a', task: 'task-a', mode: 'general' },
        { key: 'b', task: 'task-b', mode: 'general', depends_on: ['a'] },
        { key: 'c', task: 'task-c', mode: 'general', depends_on: ['b'] },
      ],
    }) as Record<string, any>;
    const ids = wf.tasks as Record<string, string>;

    // Only A is eligible at creation; B/C wait without consuming slots.
    assert.equal(h.store.getWorker(ids['a']!)!.status === 'waiting_dependencies', false);
    assert.equal(h.store.getWorker(ids['b']!)!.status, 'waiting_dependencies');
    assert.equal(h.store.getWorker(ids['c']!)!.status, 'waiting_dependencies');

    const done = await h.supervisor.waitWorkflow(wf.workflow_id, 30);
    assert.equal(done['status'], 'completed');
    assert.deepEqual(order, ['a', 'b', 'c']);

    // Shared workspace: each task's artifact visible to the next.
    const ws = (wf.workspace as any).path as string;
    for (const f of ['a.md', 'b.md', 'c.md']) {
      assert.ok(fs.existsSync(path.join(ws, f)), f);
    }
  } finally {
    h.cleanup();
  }
});

test('fan-out + fan-in: A → {B,C} → D, B and C run in parallel', async () => {
  const started: string[] = [];
  const h = makeHarness(({ prompt }) => {
    const tag = prompt.includes('TAG_ROOT') ? 'a' : prompt.includes('TAG_LEFT') ? 'b' : prompt.includes('TAG_RIGHT') ? 'c' : 'd';
    started.push(tag);
    return quick(tag);
  });
  try {
    const wf = h.supervisor.createWorkflow({
      tasks: [
        { key: 'a', task: 'TAG_ROOT', mode: 'general' },
        { key: 'b', task: 'TAG_LEFT', mode: 'general', depends_on: ['a'] },
        { key: 'c', task: 'TAG_RIGHT', mode: 'general', depends_on: ['a'] },
        { key: 'd', task: 'TAG_JOIN', mode: 'general', depends_on: ['b', 'c'] },
      ],
    }) as Record<string, any>;
    const done = await h.supervisor.waitWorkflow(wf.workflow_id, 30);
    assert.equal(done['status'], 'completed');
    assert.equal(started[0], 'a');
    assert.equal(started[3], 'd');
    assert.deepEqual(new Set(started.slice(1, 3)), new Set(['b', 'c']));
    const progress = done['progress'] as Record<string, number>;
    assert.equal(progress['completed'], 4);
  } finally {
    h.cleanup();
  }
});

test('cycle detection rejects A→B→C→A', () => {
  const h = makeHarness(() => quick('x'));
  try {
    assert.throws(
      () =>
        h.supervisor.createWorkflow({
          tasks: [
            { key: 'a', task: 'x', depends_on: ['c'] },
            { key: 'b', task: 'x', depends_on: ['a'] },
            { key: 'c', task: 'x', depends_on: ['b'] },
          ],
        }),
      /cycle/,
    );
    assert.throws(
      () =>
        h.supervisor.createWorkflow({
          tasks: [
            { key: 'a', task: 'x', depends_on: ['nope'] },
          ],
        }),
      /unknown key/,
    );
    assert.throws(
      () =>
        h.supervisor.createWorkflow({
          tasks: [
            { key: 'a', task: 'x' },
            { key: 'a', task: 'y' },
          ],
        }),
      /duplicate task key/,
    );
  } finally {
    h.cleanup();
  }
});

test('all_success: failed dependency blocks dependents (terminal blocked)', async () => {
  const h = makeHarness(({ prompt }) => (prompt.includes('TAG_BOOM') ? fail() : quick('ok')));
  try {
    const wf = h.supervisor.createWorkflow({
      tasks: [
        { key: 'a', task: 'TAG_BOOM', mode: 'general' },
        { key: 'b', task: 'dependent', mode: 'general', depends_on: ['a'] },
      ],
    }) as Record<string, any>;
    const ids = wf.tasks as Record<string, string>;
    const done = await h.supervisor.waitWorkflow(wf.workflow_id, 30);
    assert.equal(done['status'], 'completed_with_failures');
    const b = h.store.getWorker(ids['b']!)!;
    assert.equal(b.status, 'blocked');
    const err = JSON.parse(b.error!);
    assert.equal(err.blocked_by[0].task_id, ids['a']);
    assert.equal(err.blocked_by[0].status, 'failed');
    // B never ran.
    assert.equal(b.started_at, null);
  } finally {
    h.cleanup();
  }
});

test('all_terminal: dependent runs even when dependency failed (standalone)', async () => {
  const h = makeHarness(({ prompt }) => (prompt.includes('TAG_BOOM') ? fail() : quick('postmortem')));
  try {
    const a = h.supervisor.spawnTask({ task: 'TAG_BOOM', mode: 'general' });
    const b = h.supervisor.spawnTask({ task: 'TAG_POSTMORTEM', mode: 'general', depends_on: [a.task_id], dependency_policy: 'all_terminal' });
    const res = await h.supervisor.waitTasks([a.task_id, b.task_id], 'all', 30);
    assert.equal(res['completed_condition'], true);
    assert.equal(h.store.getWorker(a.task_id)!.status, 'failed');
    assert.equal(h.store.getWorker(b.task_id)!.status, 'completed');
    assert.ok(h.store.getWorker(b.task_id)!.started_at, 'b actually ran');
  } finally {
    h.cleanup();
  }
});

test('failure_policy=stop_dependents blocks transitive downstream even under all_terminal', async () => {
  const h = makeHarness(({ prompt }) => (prompt.includes('TAG_BOOM') ? fail() : quick('x')));
  try {
    const wf = h.supervisor.createWorkflow({
      failure_policy: 'stop_dependents',
      tasks: [
        { key: 'a', task: 'TAG_BOOM', mode: 'general' },
        { key: 'b', task: 'downstream', mode: 'general', depends_on: ['a'], dependency_policy: 'all_terminal' },
      ],
    }) as Record<string, any>;
    const ids = wf.tasks as Record<string, string>;
    await h.supervisor.waitWorkflow(wf.workflow_id, 30);
    assert.equal(h.store.getWorker(ids['b']!)!.status, 'blocked');
  } finally {
    h.cleanup();
  }
});

test('failure_policy=continue lets all_terminal dependents proceed', async () => {
  const h = makeHarness(({ prompt }) => (prompt.includes('TAG_BOOM') ? fail() : quick('x')));
  try {
    const wf = h.supervisor.createWorkflow({
      failure_policy: 'continue',
      tasks: [
        { key: 'a', task: 'TAG_BOOM', mode: 'general' },
        { key: 'b', task: 'downstream', mode: 'general', depends_on: ['a'], dependency_policy: 'all_terminal' },
      ],
    }) as Record<string, any>;
    const ids = wf.tasks as Record<string, string>;
    await h.supervisor.waitWorkflow(wf.workflow_id, 30);
    assert.equal(h.store.getWorker(ids['b']!)!.status, 'completed');
  } finally {
    h.cleanup();
  }
});

test('failure_policy=cancel_remaining cancels queued/running siblings', async () => {
  const h = makeHarness(({ prompt }) =>
    prompt.includes('TAG_BOOM') ? fail() : prompt.includes('TAG_SLOW') ? FakeScenarios.hang() : quick('x'),
    { maxConcurrent: 2 },
  );
  try {
    const wf = h.supervisor.createWorkflow({
      failure_policy: 'cancel_remaining',
      tasks: [
        { key: 'a', task: 'TAG_BOOM', mode: 'general' },
        { key: 'b', task: 'TAG_SLOW', mode: 'general' },
      ],
    }) as Record<string, any>;
    const ids = wf.tasks as Record<string, string>;
    const done = await h.supervisor.waitWorkflow(wf.workflow_id, 30);
    assert.equal(done['status'], 'completed_with_failures');
    const b = h.store.getWorker(ids['b']!)!;
    assert.ok(['cancelled'].includes(b.status), `b cancelled, got ${b.status}`);
  } finally {
    h.cleanup();
  }
});

test('cancel_workflow cancels everything non-terminal and wakes waiters', async () => {
  const h = makeHarness(() => FakeScenarios.hang());
  try {
    const wf = h.supervisor.createWorkflow({
      tasks: [
        { key: 'a', task: 'hangs', mode: 'general' },
        { key: 'b', task: 'waits', mode: 'general', depends_on: ['a'] },
      ],
    }) as Record<string, any>;
    await new Promise((r) => setTimeout(r, 50));
    const waitP = h.supervisor.waitWorkflow(wf.workflow_id, 60);
    const res = await h.supervisor.cancelWorkflow(wf.workflow_id);
    assert.equal(res['status'], 'cancelled');
    const done = (await waitP) as Record<string, any>;
    assert.equal(done['status'], 'cancelled');
    assert.equal(done['wait'].completed, true);
  } finally {
    h.cleanup();
  }
});

test('standalone spawn_task with depends_on waits for the dependency', async () => {
  const order: string[] = [];
  const h = makeHarness(({ prompt }) => {
    order.push(prompt.includes('TAG_FIRST') ? 'first' : 'second');
    return FakeScenarios.delayed(200);
  });
  try {
    const a = h.supervisor.spawnTask({ task: 'TAG_FIRST', mode: 'general' });
    const b = h.supervisor.spawnTask({ task: 'TAG_SECOND', mode: 'general', depends_on: [a.task_id] });
    assert.equal(b.status, 'waiting_dependencies');
    assert.throws(() => h.supervisor.spawnTask({ task: 'x', depends_on: ['wk_ffffffff'] }), /unknown dependency/);

    const res = await h.supervisor.waitTasks([a.task_id, b.task_id], 'all', 30);
    assert.equal(res['completed_condition'], true);
    assert.deepEqual(order, ['first', 'second']);
  } finally {
    h.cleanup();
  }
});

test('git workflow: sequential code tasks commit onto one workflow branch', async () => {
  const repo = makeTempRepo();
  const base = git(['rev-parse', 'HEAD'], repo).trim();
  const h = makeHarness(({ prompt }) =>
    editOnly(prompt.includes('second') ? 'b' : 'a'),
  );
  try {
    const wf = h.supervisor.createWorkflow({
      name: 'git-wf',
      workspace: { type: 'git_worktree', repo_path: repo },
      tasks: [
        { key: 'a', task: 'first code change', mode: 'code' },
        { key: 'b', task: 'second code change', mode: 'code', depends_on: ['a'] },
      ],
    }) as Record<string, any>;
    const done = await h.supervisor.waitWorkflow(wf.workflow_id, 30);
    assert.equal(done['status'], 'completed');

    const result = h.supervisor.workflowResult(wf.workflow_id) as Record<string, any>;
    const branch = result['git']['branch'] as string;
    assert.match(branch, /^kimi-worker\/wf_/);
    assert.equal(result['git']['working_tree_clean'], true);
    // Two supervisor commits on top of base, one per task.
    const count = Number(git(['rev-list', '--count', `${base}..${branch}`], repo).trim());
    assert.equal(count, 2);
    // Main untouched.
    assert.equal(git(['rev-parse', 'HEAD'], repo).trim(), base);
    // Both task artifacts present in shared worktree.
    const wsPath = (wf.workspace as any).path as string;
    assert.ok(fs.existsSync(path.join(wsPath, 'a.md')));
    assert.ok(fs.existsSync(path.join(wsPath, 'b.md')));
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

function editOnly(tag: string): FakeScenario {
  return {
    steps: [
      { writeFile: { path: `${tag}.md`, content: `# ${tag}\n` } },
      { emit: { type: 'final', text: `Summary:\n- wrote ${tag}.md\n\nsuggested_commit_message: add ${tag}.md` } },
    ],
    exitCode: 0,
  };
}

test('waiting_dependencies does not consume concurrency slots', async () => {
  const started: string[] = [];
  const h = makeHarness(({ prompt }) => {
    started.push(prompt.includes('TAG_SLOW') ? 'slow' : 'fast');
    return prompt.includes('TAG_SLOW') ? FakeScenarios.delayed(400) : quick('f');
  }, { maxConcurrent: 1 });
  try {
    const slow = h.supervisor.spawnTask({ task: 'TAG_SLOW', mode: 'general' });
    const dependent = h.supervisor.spawnTask({ task: 'fast dependent', mode: 'general', depends_on: [slow.task_id] });
    const independent = h.supervisor.spawnTask({ task: 'fast independent', mode: 'general' });

    // dependent is waiting (not queued) — but independent is queued behind slow
    // with maxConcurrent=1. Verify waiting_dependencies never occupied a slot:
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.store.getWorker(dependent.task_id)!.status, 'waiting_dependencies');

    await h.supervisor.waitTasks([slow.task_id, dependent.task_id, independent.task_id], 'all', 30);
    assert.deepEqual(started, ['slow', 'fast', 'fast']);
  } finally {
    h.cleanup();
  }
});

test('workflow state reconciled on init when server stopped between task terminal and wf update', async () => {
  const h = makeHarness(() => quick('a'));
  try {
    const wf = h.supervisor.createWorkflow({ tasks: [{ key: 'a', task: 'task-a', mode: 'general' }] }) as Record<string, any>;
    await h.supervisor.waitWorkflow(wf.workflow_id, 30);
    // Simulate crash-before-wf-update: force status back to running, then init.
    h.store.updateWorkflow(wf.workflow_id, { status: 'running', finished_at: null });
    h.supervisor.init();
    assert.equal(h.store.getWorkflow(wf.workflow_id)!.status, 'completed');
  } finally {
    h.cleanup();
  }
});

test('detectCycle unit behavior', () => {
  assert.equal(WorkerSupervisor.detectCycle(new Map([['a', ['b']], ['b', []]])), null);
  const selfLoop = WorkerSupervisor.detectCycle(new Map([['a', ['a']]]));
  assert.ok(selfLoop && selfLoop.includes('a'));
  const cyc = WorkerSupervisor.detectCycle(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]]));
  assert.ok(cyc);
  assert.ok(cyc!.includes('a'));
});
