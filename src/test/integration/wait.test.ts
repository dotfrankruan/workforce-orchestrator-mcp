import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeScenarios, type FakeScenario } from '../../backend/fake.js';
import { makeTempRepo, makeHarness, removeDir } from '../helpers.js';

const quick = (text = 'done'): FakeScenario => ({
  steps: [{ emit: { type: 'final', text: `Summary:\n- ${text}` } }],
  exitCode: 0,
});

test('wait_task on already-terminal task returns immediately', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(() => FakeScenarios.successWithCommit());
  try {
    const s = h.supervisor.spawn({ repo_path: repo, task: 'x' });
    await h.supervisor.waitFor(s.worker_id);

    const start = Date.now();
    const res = (await h.supervisor.waitTask(s.worker_id, 60)) as Record<string, any>;
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `immediate return expected, took ${elapsed}ms`);
    assert.equal(res.status, 'completed');
    assert.equal(res.wait.completed, true);
    assert.equal(res.wait.timed_out, false);
    assert.ok(res.result, 'compact result included');
    assert.ok(res.result.summary);
    assert.ok(typeof res.wait.waited_ms === 'number');
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('wait_task covers full lifecycle queued → running → completed', async () => {
  const h = makeHarness(() => FakeScenarios.delayed(300));
  try {
    const s = h.supervisor.spawnTask({ task: 'general work', mode: 'general' });
    const res = (await h.supervisor.waitTask(s.task_id, 30)) as Record<string, any>;
    assert.equal(res.status, 'completed');
    assert.equal(res.wait.completed, true);
    assert.ok(res.wait.waited_ms >= 250);
  } finally {
    h.cleanup();
  }
});

test('wait_task wakes on failure', async () => {
  const h = makeHarness(() => FakeScenarios.failure(2));
  try {
    const s = h.supervisor.spawnTask({ task: 'doomed', mode: 'general' });
    const res = (await h.supervisor.waitTask(s.task_id, 30)) as Record<string, any>;
    assert.equal(res.status, 'failed');
    assert.equal(res.wait.completed, true);
    assert.ok(res.result.error);
  } finally {
    h.cleanup();
  }
});

test('wait_task wakes immediately on cancel', async () => {
  const h = makeHarness(() => FakeScenarios.hang());
  try {
    const s = h.supervisor.spawnTask({ task: 'hangs', mode: 'general' });
    await new Promise((r) => setTimeout(r, 50));

    const waitPromise = h.supervisor.waitTask(s.task_id, 300);
    await new Promise((r) => setTimeout(r, 50));
    const start = Date.now();
    await h.supervisor.cancelWorker(s.task_id);
    const res = (await waitPromise) as Record<string, any>;
    const elapsed = Date.now() - start;
    assert.equal(res.status, 'cancelled');
    assert.equal(res.wait.completed, true);
    assert.ok(elapsed < 2000, `cancel should wake waiters fast, took ${elapsed}ms`);
  } finally {
    h.cleanup();
  }
});

test('wait_task wakes on worker execution timeout', async () => {
  const h = makeHarness(() => FakeScenarios.hang());
  try {
    const s = h.supervisor.spawnTask({ task: 'slow', mode: 'general', timeout_seconds: 1 });
    const res = (await h.supervisor.waitTask(s.task_id, 30)) as Record<string, any>;
    assert.equal(res.status, 'timeout', 'worker execution timeout');
    assert.equal(res.wait.completed, true);
  } finally {
    h.cleanup();
  }
});

test('wait_task wakes on interrupted (reconciled) tasks', async () => {
  const h = makeHarness(() => FakeScenarios.hang());
  try {
    const s = h.supervisor.spawnTask({ task: 'x', mode: 'general' });
    await new Promise((r) => setTimeout(r, 50));
    // Simulate an external reconciliation marking the row interrupted.
    h.store.updateWorker(s.task_id, { status: 'interrupted' });
    // No in-process notify happened (we bypassed supervisor), so the wait
    // relies on the low-frequency re-check fallback.
    const res = (await h.supervisor.waitTask(s.task_id, 30)) as Record<string, any>;
    assert.equal(res.status, 'interrupted');
    assert.equal(res.wait.completed, true);
  } finally {
    h.cleanup();
  }
});

test('wait_task timeout does NOT cancel or fail the worker', async () => {
  const h = makeHarness(() => FakeScenarios.delayed(2500));
  try {
    const s = h.supervisor.spawnTask({ task: 'slow but fine', mode: 'general' });
    const res = (await h.supervisor.waitTask(s.task_id, 1)) as Record<string, any>;
    assert.equal(res.wait.completed, false);
    assert.equal(res.wait.timed_out, true);
    assert.ok(['starting', 'running', 'queued'].includes(res.status));
    assert.ok(!('result' in res), 'no result on wait timeout');

    // Worker continues and eventually completes normally.
    const res2 = (await h.supervisor.waitTask(s.task_id, 30)) as Record<string, any>;
    assert.equal(res2.status, 'completed');
    assert.equal(res2.wait.completed, true);
  } finally {
    h.cleanup();
  }
});

test('wait_task validates id and timeout', async () => {
  const h = makeHarness(() => quick());
  try {
    await assert.rejects(() => h.supervisor.waitTask('wk_00000000'), /unknown worker/);
    const s = h.supervisor.spawnTask({ task: 'x', mode: 'general' });
    await assert.rejects(() => h.supervisor.waitTask(s.task_id, 0), /between 1 and 600/);
    await assert.rejects(() => h.supervisor.waitTask(s.task_id, 601), /between 1 and 600/);
    await h.supervisor.waitFor(s.task_id);
  } finally {
    h.cleanup();
  }
});

test('wait_tasks all: completed+completed and completed+failed both satisfy', async () => {
  const h = makeHarness(({ prompt }) =>
    prompt.includes('FAIL_ME') ? FakeScenarios.failure(1) : quick(),
  );
  try {
    const a = h.supervisor.spawnTask({ task: 'ok A', mode: 'general' });
    const b = h.supervisor.spawnTask({ task: 'ok B', mode: 'general' });
    const res = (await h.supervisor.waitTasks([a.task_id, b.task_id], 'all', 30)) as Record<string, any>;
    assert.equal(res.completed_condition, true);
    assert.equal(res.timed_out, false);
    assert.equal(res.tasks.length, 2);
    assert.ok(res.tasks.every((t: any) => t.terminal));

    const c = h.supervisor.spawnTask({ task: 'ok C', mode: 'general' });
    const d = h.supervisor.spawnTask({ task: 'FAIL_ME D', mode: 'general' });
    const res2 = (await h.supervisor.waitTasks([c.task_id, d.task_id], 'all', 30)) as Record<string, any>;
    assert.equal(res2.completed_condition, true, 'failed counts as terminal for all');
    const statuses = new Map(res2.tasks.map((t: any) => [t.task_id, t.status]));
    assert.equal(statuses.get(c.task_id), 'completed');
    assert.equal(statuses.get(d.task_id), 'failed');
    const failedEntry = res2.tasks.find((t: any) => t.task_id === d.task_id);
    assert.ok(failedEntry.error, 'failed task carries error');
  } finally {
    h.cleanup();
  }
});

test('wait_tasks all: times out when one task keeps running', async () => {
  const h = makeHarness(({ prompt }) =>
    prompt.includes('HANG') ? FakeScenarios.hang() : quick(),
  );
  try {
    const a = h.supervisor.spawnTask({ task: 'quick one', mode: 'general' });
    const b = h.supervisor.spawnTask({ task: 'HANG slow one', mode: 'general' });
    const res = (await h.supervisor.waitTasks([a.task_id, b.task_id], 'all', 1)) as Record<string, any>;
    assert.equal(res.completed_condition, false);
    assert.equal(res.timed_out, true);
    const byId = new Map(res.tasks.map((t: any) => [t.task_id, t]));
    assert.equal((byId.get(a.task_id) as any).terminal, true);
    assert.equal((byId.get(b.task_id) as any).terminal, false);
    // The still-running task is unaffected by the wait timeout.
    assert.equal(h.store.getWorker(b.task_id)!.status, 'running');
    await h.supervisor.cancelWorker(b.task_id);
  } finally {
    h.cleanup();
  }
});

test('wait_tasks any: returns as soon as the first task finishes', async () => {
  const h = makeHarness(({ prompt }) =>
    prompt.includes('SLOW') ? FakeScenarios.delayed(3000) : quick(),
  );
  try {
    const a = h.supervisor.spawnTask({ task: 'fast task', mode: 'general' });
    const b = h.supervisor.spawnTask({ task: 'SLOW task', mode: 'general' });
    const start = Date.now();
    const res = (await h.supervisor.waitTasks([a.task_id, b.task_id], 'any', 30)) as Record<string, any>;
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `any should return on first completion, took ${elapsed}ms`);
    assert.equal(res.completed_condition, true);
    assert.deepEqual(res.triggered_by, [a.task_id]);
    const byId = new Map(res.tasks.map((t: any) => [t.task_id, t]));
    assert.equal((byId.get(b.task_id) as any).terminal, false);
    await h.supervisor.waitFor(b.task_id);
  } finally {
    h.cleanup();
  }
});

test('wait_tasks any: near-simultaneous completions all appear in triggered_by', async () => {
  const h = makeHarness(() => quick());
  try {
    const a = h.supervisor.spawnTask({ task: 'A', mode: 'general' });
    const b = h.supervisor.spawnTask({ task: 'B', mode: 'general' });
    await h.supervisor.waitForAll();
    const res = (await h.supervisor.waitTasks([a.task_id, b.task_id], 'any', 5)) as Record<string, any>;
    assert.equal(res.completed_condition, true);
    assert.deepEqual(new Set(res.triggered_by), new Set([a.task_id, b.task_id]));
  } finally {
    h.cleanup();
  }
});

test('wait_tasks validation: dedupes, rejects empty/oversized/unknown', async () => {
  const h = makeHarness(() => quick());
  try {
    await assert.rejects(() => h.supervisor.waitTasks([], 'all', 5), /at least one/);
    const many = Array.from({ length: 33 }, (_, i) => `wk_${String(i).padStart(8, '0')}`);
    await assert.rejects(() => h.supervisor.waitTasks(many, 'all', 5), /max 32/);

    const s = h.supervisor.spawnTask({ task: 'x', mode: 'general' });
    await assert.rejects(() => h.supervisor.waitTasks([s.task_id, 'wk_ffffffff'], 'all', 5), /unknown worker/);
    // Dedup: same id twice is fine.
    const res = (await h.supervisor.waitTasks([s.task_id, s.task_id], 'all', 30)) as Record<string, any>;
    assert.equal(res.tasks.length, 1);
  } finally {
    h.cleanup();
  }
});

test('concurrency: wait_tasks never blocks worker completion (no deadlock)', async () => {
  // Two workers with real work + one waiting caller, maxConcurrent=2.
  const h = makeHarness(() => FakeScenarios.successWithCommit('out.txt', 'x\n', 'out'), { maxConcurrent: 2 });
  const repo = makeTempRepo();
  try {
    const a = h.supervisor.spawn({ repo_path: repo, task: 'task A' });
    const b = h.supervisor.spawn({ repo_path: repo, task: 'task B' });
    const res = (await h.supervisor.waitTasks([a.worker_id, b.worker_id], 'all', 30)) as Record<string, any>;
    assert.equal(res.completed_condition, true);
    assert.ok(res.tasks.every((t: any) => t.status === 'completed'));
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('spawn_tasks: batch spawn with per-item success/error', async () => {
  const h = makeHarness(() => quick());
  const repo = makeTempRepo();
  try {
    const res = h.supervisor.spawnTasks([
      { task: 'task one', mode: 'general' },
      { task: 'task two', mode: 'research' },
      { task: 'bad', mode: 'wizard' },
      { task: '', mode: 'general' },
    ]) as Record<string, any>;
    assert.equal(res.spawned, 2);
    assert.equal(res.failed, 2);
    assert.equal(res.tasks[0].ok, true);
    assert.equal(res.tasks[2].ok, false);
    assert.match(res.tasks[2].error, /invalid mode/);
    assert.equal(res.tasks[3].ok, false);

    const ids = res.tasks.filter((t: any) => t.ok).map((t: any) => t.task_id);
    const waited = (await h.supervisor.waitTasks(ids, 'all', 30)) as Record<string, any>;
    assert.equal(waited.completed_condition, true);

    assert.throws(() => h.supervisor.spawnTasks([]), /non-empty/);
    void repo;
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});
