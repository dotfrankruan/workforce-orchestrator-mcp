import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_ROLES, getRole, roleNames } from '../../roles.js';
import { WORKFLOW_PRESETS, getPreset, presetNames } from '../../presets.js';
import { buildModePrompt } from '../../prompts/index.js';
import { makeTempRepo, makeHarness, removeDir } from '../helpers.js';

test('built-in roles: 8 roles with required fields', () => {
  assert.equal(BUILT_IN_ROLES.length, 8);
  for (const r of BUILT_IN_ROLES) {
    assert.ok(r.name && r.description && r.promptFragment && r.preferredMode, r.name);
  }
  assert.deepEqual(roleNames().sort(), [
    'data_analyst', 'debugger', 'docs_writer', 'implementer', 'ops_analyst', 'researcher', 'reviewer', 'tester',
  ]);
  assert.equal(getRole('nope'), null);
});

test('role fragment is injected into the prompt after the mode intro', () => {
  const role = getRole('reviewer')!;
  const p = buildModePrompt('review', {
    task: 'TAG_TASK review this',
    deliverables: [],
    capabilities: [],
    workspaceDescription: 'Workspace: x.',
    roleFragment: role.promptFragment,
  });
  assert.ok(p.includes('Your role: reviewer.'));
  assert.ok(p.includes('TAG_TASK'));
  // Fragment appears before the task block.
  assert.ok(p.indexOf('Your role: reviewer.') < p.indexOf('<TASK>'));
});

test('role defaults merge into deliverables/capabilities; unknown role rejected', async () => {
  const h = makeHarness(() => ({
    steps: [
      { writeFile: { path: 'review.md', content: '# review\n' } },
      { writeFile: { path: 'sources.json', content: '[]\n' } },
      { emit: { type: 'final', text: 'Summary:\n- done' } },
    ],
    exitCode: 0,
  }));
  try {
    assert.throws(() => h.supervisor.spawnTask({ task: 'x', role: 'wizard' }), /unknown role/);
    const s = h.supervisor.spawnTask({ task: 'review something', mode: 'review', role: 'reviewer' });
    const row = await h.supervisor.waitFor(s.task_id);
    assert.equal(row.role, 'reviewer');
    // reviewer default deliverable review.md merged and verified present.
    assert.equal(row.deliverables_missing, null);
    assert.deepEqual(JSON.parse(row.deliverables), ['review.md']);
    assert.ok(JSON.parse(row.capabilities).includes('filesystem.read'));
  } finally {
    h.cleanup();
  }
});

test('all built-in presets produce valid acyclic graphs', () => {
  assert.deepEqual(presetNames(), ['bug_fix', 'feature_development', 'quality_audit', 'research_report', 'data_analysis']);
  for (const p of WORKFLOW_PRESETS) {
    const tasks = p.build('GOAL_XYZ');
    assert.ok(tasks.length >= 3, p.name);
    const keys = new Set(tasks.map((t) => t.key));
    assert.equal(keys.size, tasks.length, `${p.name} duplicate keys`);
    for (const t of tasks) {
      for (const d of t.depends_on ?? []) assert.ok(keys.has(d), `${p.name}: ${t.key} dep ${d} missing`);
      assert.ok(t.task.includes('GOAL_XYZ'), `${p.name}: ${t.key} task embeds goal`);
      assert.ok(t.role && getRole(t.role), `${p.name}: ${t.key} has valid role`);
      assert.ok(t.mode, `${p.name}: ${t.key} has mode`);
    }
  }
});

test('preset graph snapshots', () => {
  const shape = (name: string) =>
    getPreset(name)!
      .build('G')
      .map((t) => `${t.key}<${t.mode}/${t.role}>deps:[${(t.depends_on ?? []).join(',')}]`)
      .join(' | ');

  assert.equal(
    shape('bug_fix'),
    'investigate<code/debugger>deps:[] | implement<code/implementer>deps:[investigate] | test<code/tester>deps:[implement] | review<review/reviewer>deps:[test]',
  );
  assert.equal(
    shape('feature_development'),
    'research<research/researcher>deps:[] | implement<code/implementer>deps:[research] | test<code/tester>deps:[implement] | review<review/reviewer>deps:[test] | docs<docs/docs_writer>deps:[review]',
  );
  assert.equal(
    shape('quality_audit'),
    'review_code<review/reviewer>deps:[] | review_tests<review/tester>deps:[] | review_docs<review/docs_writer>deps:[] | fixes<code/implementer>deps:[review_code,review_tests,review_docs] | verification<code/tester>deps:[fixes]',
  );
  assert.equal(
    shape('research_report'),
    'gather_sources<research/researcher>deps:[] | independent_comparison<research/researcher>deps:[] | synthesis<research/researcher>deps:[gather_sources,independent_comparison]',
  );
  assert.equal(
    shape('data_analysis'),
    'inspect<data/data_analyst>deps:[] | analyze<data/data_analyst>deps:[inspect] | validate<data/data_analyst>deps:[analyze] | report<data/data_analyst>deps:[validate]',
  );
});

test('run_workflow_preset: dry_run shows the plan without spawning', async () => {
  const h = makeHarness(() => ({ steps: [{ emit: { type: 'final', text: 'ok' } }], exitCode: 0 }));
  try {
    const plan = h.supervisor.runWorkflowPreset({
      preset: 'research_report',
      goal: 'compare X and Y',
      options: { dry_run: true },
    }) as Record<string, any>;
    assert.equal(plan['dry_run'], true);
    assert.equal(plan['tasks'].length, 3);
    assert.equal(plan['tasks'][2]['depends_on'].length, 2);
    assert.equal(h.store.listWorkflows().length, 0, 'nothing spawned');
  } finally {
    h.cleanup();
  }
});

test('run_workflow_preset: research_report executes end-to-end with shared temporary workspace', async () => {
  const h = makeHarness(({ prompt }) => ({
    steps: [
      { writeFile: { path: 'out.md', content: '# x\n' } },
      { writeFile: { path: 'sources.json', content: '[]\n' } },
      { emit: { type: 'final', text: 'Summary:\n- done' } },
    ],
    exitCode: 0,
  }));
  try {
    const res = h.supervisor.runWorkflowPreset({ preset: 'research_report', goal: 'TAG_GOAL compare' }) as Record<string, any>;
    assert.equal(res['preset'], 'research_report');
    assert.ok(res['workflow_id']);
    const done = await h.supervisor.waitWorkflow(res['workflow_id'], 30);
    assert.equal(done['status'], 'completed');
    const wf = h.store.getWorkflow(res['workflow_id'])!;
    assert.equal(wf.preset, 'research_report');
  } finally {
    h.cleanup();
  }
});

test('run_workflow_preset: git preset without repo_path errors clearly', () => {
  const h = makeHarness(() => ({ steps: [], exitCode: 0 }));
  try {
    assert.throws(
      () => h.supervisor.runWorkflowPreset({ preset: 'bug_fix', goal: 'fix it' }),
      /needs a git workspace/,
    );
  } finally {
    h.cleanup();
  }
});

test('run_workflow_preset: bug_fix on a repo walks the full chain', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(() => ({
    steps: [
      { writeFile: { path: 'investigation.md', content: '# inv\n' } },
      { writeFile: { path: 'review.md', content: '# rev\n' } },
      { emit: { type: 'final', text: 'Summary:\n- done' } },
    ],
    exitCode: 0,
  }));
  try {
    const res = h.supervisor.runWorkflowPreset({
      preset: 'bug_fix',
      goal: 'TAG_GOAL fix flaky test',
      workspace: { type: 'git_worktree', repo_path: repo },
    }) as Record<string, any>;
    const done = await h.supervisor.waitWorkflow(res['workflow_id'], 60);
    assert.equal(done['status'], 'completed');
    const result = h.supervisor.workflowResult(res['workflow_id']) as Record<string, any>;
    assert.equal(result['tasks']['completed'], 4);
    assert.ok(result['git']['integration_branch'].startsWith('kimi-workflow/wf_'));
    // Each task wrote the same two files with identical content — only the
    // first task produces new commits; artifacts are indexed from the task
    // that actually changed them.
    assert.ok(result['artifacts'].length >= 2);
    assert.equal(result['git']['integration_conflicts'], 0);
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});
