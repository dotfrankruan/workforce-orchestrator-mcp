import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeScenarios, type FakeScenario } from '../../backends/fake.js';
import { makeHarness } from '../helpers.js';

const bigUsage = (inputTokens: number): FakeScenario => ({
  steps: [
    { emit: { type: 'status', phase: 'turn_start', turn: 1 } },
    { emit: { type: 'status', phase: 'step_end', usage: { inputTokens, outputTokens: 10, totalTokens: inputTokens + 10, cacheReadTokens: 0 } } },
    { emit: { type: 'final', text: 'Summary:\n- done' } },
  ],
  exitCode: 0,
});

test('task token budget: exceeding max_total_tokens terminates run as budget_exceeded', async () => {
  const h = makeHarness(() => ({
    steps: [
      { emit: { type: 'status', phase: 'step_end', usage: { inputTokens: 5000, outputTokens: 2000, totalTokens: 7000, cacheReadTokens: 0 } } },
      { hang: true }, // would run forever; budget terminates it
    ],
  }));
  try {
    const s = h.supervisor.spawnTask({
      task: 'expensive',
      mode: 'general',
      budget: { max_total_tokens: 1000 },
    });
    const res = (await h.supervisor.waitTask(s.task_id, 30)) as Record<string, any>;
    assert.equal(res.status, 'budget_exceeded');
    assert.equal(res.wait.completed, true, 'budget breach wakes waiters');
    const budget = JSON.parse(h.store.getWorker(s.task_id)!.error!);
    assert.equal(budget.budget.reason, 'max_total_tokens');
    assert.equal(budget.budget.limit, 1000);
    assert.ok(budget.budget.used > 1000);
  } finally {
    h.cleanup();
  }
});

test('task tool-call budget: max_tool_calls terminates run', async () => {
  const h = makeHarness(() => ({
    steps: [
      { emit: { type: 'tool_call', callId: 'c1', tool: 'bash', input: {} } },
      { emit: { type: 'tool_call', callId: 'c2', tool: 'bash', input: {} } },
      { emit: { type: 'tool_call', callId: 'c3', tool: 'bash', input: {} } },
      { hang: true },
    ],
  }));
  try {
    const s = h.supervisor.spawnTask({ task: 'loopy', mode: 'general', budget: { max_tool_calls: 2 } });
    const row = await h.supervisor.waitFor(s.task_id);
    assert.equal(row.status, 'budget_exceeded');
    assert.ok(row.error!.includes('max_tool_calls'));
  } finally {
    h.cleanup();
  }
});

test('task duration budget maps to execution timeout', async () => {
  const h = makeHarness(() => FakeScenarios.hang());
  try {
    const s = h.supervisor.spawnTask({ task: 'slow', mode: 'general', budget: { max_duration_seconds: 1 }, timeout_seconds: 300 });
    const row = await h.supervisor.waitFor(s.task_id);
    assert.equal(row.status, 'timeout', 'max_duration_seconds caps the execution timeout');
  } finally {
    h.cleanup();
  }
});

test('workflow token budget: exceeding max_worker_tokens fails the workflow', async () => {
  const h = makeHarness(() => bigUsage(600));
  try {
    const wf = h.supervisor.createWorkflow({
      budget: { max_worker_tokens: 1000 },
      tasks: [
        { key: 'a', task: 'TAG_A', mode: 'general' },
        { key: 'b', task: 'TAG_B', mode: 'general', depends_on: ['a'] },
      ],
    }) as Record<string, any>;
    const done = await h.supervisor.waitWorkflow(wf.workflow_id, 30);
    assert.equal(done['status'], 'failed');
    const rows = h.store.workersInWorkflow(wf.workflow_id);
    const bRow = rows.find((r) => r.task_key === 'b')!;
    assert.equal(bRow.status, 'budget_exceeded');
    // b started, emitted usage pushing the workflow total over budget, and
    // was terminated mid-run (best-effort, per-event granularity).
    // max_worker_tokens still accepted as deprecated alias; canonical reason reported.
    assert.ok(JSON.parse(bRow.error!).budget.reason.includes('worker_tokens'));
  } finally {
    h.cleanup();
  }
});

test('workflow duration budget: deadline fails the workflow', async () => {
  const h = makeHarness(() => FakeScenarios.hang());
  try {
    const wf = h.supervisor.createWorkflow({
      budget: { max_duration_seconds: 1 },
      tasks: [{ key: 'a', task: 'TAG_HANG', mode: 'general' }],
    }) as Record<string, any>;
    const done = await h.supervisor.waitWorkflow(wf.workflow_id, 30);
    assert.equal(done['status'], 'failed');
    const row = h.store.workersInWorkflow(wf.workflow_id)[0]!;
    assert.equal(row.status, 'budget_exceeded');
  } finally {
    h.cleanup();
  }
});

test('retry on failure: second attempt succeeds, attempts recorded', async () => {
  let calls = 0;
  const h = makeHarness(() => {
    calls++;
    return calls === 1 ? FakeScenarios.failure(1) : FakeScenarios.success('Summary:\n- recovered');
  });
  try {
    const s = h.supervisor.spawnTask({
      task: 'flaky',
      mode: 'general',
      retry: { max_attempts: 2, retry_on: ['failed'] },
    });
    const row = await h.supervisor.waitFor(s.task_id);
    assert.equal(row.status, 'completed');
    assert.equal(row.attempt, 2);
    assert.equal(calls, 2);

    const attempts = h.store.listAttempts(s.task_id);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]!.status, 'failed');
    assert.equal(attempts[1]!.status, 'completed');
  } finally {
    h.cleanup();
  }
});

test('retry on timeout with fresh session each attempt', async () => {
  let calls = 0;
  const resumes: boolean[] = [];
  const h = makeHarness(({ resume }) => {
    calls++;
    resumes.push(resume);
    return calls === 1 ? FakeScenarios.hang() : FakeScenarios.success();
  });
  try {
    const s = h.supervisor.spawnTask({
      task: 'flaky timeout',
      mode: 'general',
      timeout_seconds: 1,
      retry: { max_attempts: 2, retry_on: ['timeout'] },
    });
    const row = await h.supervisor.waitFor(s.task_id);
    assert.equal(row.status, 'completed');
    assert.equal(row.attempt, 2);
    assert.deepEqual(resumes, [false, false], 'retries use new sessions (MVP)');
  } finally {
    h.cleanup();
  }
});

test('attempts exhausted → terminal failure, no endless retry', async () => {
  let calls = 0;
  const h = makeHarness(() => {
    calls++;
    return FakeScenarios.failure(7);
  });
  try {
    const s = h.supervisor.spawnTask({ task: 'always fails', mode: 'general', retry: { max_attempts: 3 } });
    const row = await h.supervisor.waitFor(s.task_id);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempt, 3);
    assert.equal(calls, 3);
    assert.equal(h.store.listAttempts(s.task_id).length, 3);
  } finally {
    h.cleanup();
  }
});

test('no retry on budget_exceeded or cancelled by default', async () => {
  let calls = 0;
  const h = makeHarness(() => {
    calls++;
    return {
      steps: [
        { emit: { type: 'status', phase: 'step_end', usage: { inputTokens: 9999, outputTokens: 0, totalTokens: 9999, cacheReadTokens: 0 } } },
        { hang: true },
      ],
    } as FakeScenario;
  });
  try {
    const s = h.supervisor.spawnTask({
      task: 'budget breach',
      mode: 'general',
      budget: { max_input_tokens: 10 },
      retry: { max_attempts: 3 },
    });
    const row = await h.supervisor.waitFor(s.task_id);
    assert.equal(row.status, 'budget_exceeded');
    assert.equal(calls, 1, 'no retry after budget_exceeded');
  } finally {
    h.cleanup();
  }
});

test('retry validation rejects bad max_attempts', () => {
  const h = makeHarness(() => FakeScenarios.success());
  try {
    assert.throws(() => h.supervisor.spawnTask({ task: 'x', retry: { max_attempts: 0 } }), /between 1 and 5/);
    assert.throws(() => h.supervisor.spawnTask({ task: 'x', retry: { max_attempts: 9 } }), /between 1 and 5/);
  } finally {
    h.cleanup();
  }
});
