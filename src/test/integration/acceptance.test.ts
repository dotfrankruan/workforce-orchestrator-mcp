import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeScenarios } from '../../backends/fake.js';
import { makeHarness } from '../helpers.js';

const ok = (tag: string) => ({
  steps: [
    { emit: { type: 'tool_call', callId: 'c1', tool: 'bash', input: {} } },
    { emit: { type: 'status', phase: 'step_end', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheReadTokens: 20 } } },
    { emit: { type: 'final', text: `Summary:\n- ${tag}` } },
  ],
  exitCode: 0,
});

test('review_task_result: acceptance states recorded and queryable', async () => {
  const h = makeHarness(() => ok('x'));
  try {
    const s = h.supervisor.spawnTask({ task: 't', mode: 'general', role: 'implementer' });
    await h.supervisor.waitFor(s.task_id);

    const r = h.supervisor.reviewTaskResult(s.task_id, 'accepted', 'looks good');
    assert.equal(r['acceptance'], 'accepted');
    assert.equal(h.store.getWorker(s.task_id)!.acceptance, 'accepted');

    const reviews = h.store.listReviews(s.task_id);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]!.feedback, 'looks good');

    // Change of mind updates the current acceptance but keeps history.
    h.supervisor.reviewTaskResult(s.task_id, 'needs_revision', 'missed edge case');
    assert.equal(h.store.getWorker(s.task_id)!.acceptance, 'needs_revision');
    assert.equal(h.store.listReviews(s.task_id).length, 2);

    const result = h.supervisor.taskResult(s.task_id) as Record<string, any>;
    assert.equal(result['acceptance'], 'needs_revision');
  } finally {
    h.cleanup();
  }
});

test('review_task_result validation: terminal only, valid decisions only', async () => {
  const h = makeHarness(() => FakeScenarios.hang());
  try {
    const s = h.supervisor.spawnTask({ task: 't', mode: 'general' });
    assert.throws(() => h.supervisor.reviewTaskResult(s.task_id, 'accepted'), /still running/);
    await h.supervisor.cancelWorker(s.task_id);
    assert.throws(() => h.supervisor.reviewTaskResult(s.task_id, 'meh'), /invalid decision/);
    assert.doesNotThrow(() => h.supervisor.reviewTaskResult(s.task_id, 'rejected'));
  } finally {
    h.cleanup();
  }
});

test('get_task_metrics reports objective counters', async () => {
  const h = makeHarness(() => ok('metrics'));
  try {
    const s = h.supervisor.spawnTask({ task: 't', mode: 'general', role: 'implementer' });
    await h.supervisor.waitFor(s.task_id);
    const m = h.supervisor.taskMetrics(s.task_id) as Record<string, any>;
    assert.equal(m['input_tokens'], 100);
    assert.equal(m['output_tokens'], 50);
    assert.equal(m['tool_calls'], 1);
    assert.deepEqual(m['tool_calls_by_tool'], { bash: 1 });
    assert.equal(m['steps'], 1);
    assert.equal(m['attempts'], 1);
    assert.equal(m['acceptance'], 'unreviewed');
    assert.ok(m['duration_seconds'] !== null);
  } finally {
    h.cleanup();
  }
});

test('workflow metrics aggregate across tasks', async () => {
  const h = makeHarness(() => ok('x'));
  try {
    const wf = h.supervisor.createWorkflow({
      tasks: [
        { key: 'a', task: 'TAG_A', mode: 'general', role: 'implementer' },
        { key: 'b', task: 'TAG_B', mode: 'general', role: 'reviewer', depends_on: ['a'] },
      ],
    }) as Record<string, any>;
    await h.supervisor.waitWorkflow(wf.workflow_id, 30);
    const m = h.supervisor.workflowMetrics(wf.workflow_id) as Record<string, any>;
    assert.equal(m['tokens']['input'], 200);
    assert.equal(m['tokens']['output'], 100);
    assert.equal(m['per_task'].length, 2);
    assert.equal(m['per_task'][0]['role'], 'implementer');
  } finally {
    h.cleanup();
  }
});

test('system metrics: counts, tokens, acceptance rates by mode/role', async () => {
  const h = makeHarness(() => ok('x'));
  try {
    const a = h.supervisor.spawnTask({ task: 'TAG_A', mode: 'general', role: 'implementer' });
    const b = h.supervisor.spawnTask({ task: 'TAG_B', mode: 'general', role: 'implementer' });
    await h.supervisor.waitTasks([a.task_id, b.task_id], 'all', 30);
    h.supervisor.reviewTaskResult(a.task_id, 'accepted');
    h.supervisor.reviewTaskResult(b.task_id, 'needs_revision');

    const sys = h.supervisor.systemMetrics() as Record<string, any>;
    assert.equal(sys['period'], 'all_time');
    assert.equal(sys['tasks']['by_status']['completed'], 2);
    assert.equal(sys['tokens']['input'], 200);
    const quality = sys['acceptance']['by_mode_and_role'] as Array<Record<string, any>>;
    const g = quality.find((q) => q['role'] === 'implementer')!;
    assert.equal(g['tasks'], 2);
    assert.equal(g['acceptance_rate'], 0.5);
    assert.equal(g['revision_rate'], 0.5);
    assert.equal(g['failure_rate'], 0);
  } finally {
    h.cleanup();
  }
});
