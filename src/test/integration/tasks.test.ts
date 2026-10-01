import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { FakeScenario } from '../../backends/fake.js';
import { makeTempRepo, makeHarness, makeTempDir, git, removeDir } from '../helpers.js';

/** Scenario: write research-style deliverables into the workspace. */
function researchScenario(): FakeScenario {
  return {
    steps: [
      { emit: { type: 'status', phase: 'turn_start', turn: 1 } },
      { emit: { type: 'tool_call', callId: 'c1', tool: 'web_search', input: { q: 'x' } } },
      { emit: { type: 'tool_result', callId: 'c1', status: 'completed', result: 'results' } },
      { writeFile: { path: 'report.md', content: '# Report\n\nFindings here.\n' } },
      { writeFile: { path: 'sources.json', content: '[{"url":"https://example.com","title":"Example"}]\n' } },
      { emit: { type: 'status', phase: 'step_end', usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700, cacheReadTokens: 100 } } },
      { emit: { type: 'final', text: 'Summary:\n- Wrote report.md\n- Recorded 1 source in sources.json' } },
    ],
    exitCode: 0,
  };
}

test('spawn_task general/research in temporary workspace: artifacts indexed, deliverables verified', async () => {
  const h = makeHarness(() => researchScenario());
  try {
    const spawn = h.supervisor.spawnTask({
      task: 'research something',
      mode: 'research',
      deliverables: ['report.md', 'sources.json'],
      capabilities: ['web.search', 'filesystem.write'],
    });
    assert.equal(spawn.mode, 'research');
    assert.equal(spawn.workspace.type, 'temporary');
    assert.equal(spawn.branch, null);
    assert.ok(spawn.workspace.path.includes(path.join('tasks', spawn.task_id)));

    const row = await h.supervisor.waitFor(spawn.task_id);
    assert.equal(row.status, 'completed');
    assert.equal(row.deliverables_missing, null, 'all deliverables present');

    const result = h.supervisor.taskResult(spawn.task_id) as Record<string, unknown>;
    assert.equal(result['mode'], 'research');
    assert.equal(result['status'], 'completed');
    const artifacts = result['artifacts'] as Array<Record<string, unknown>>;
    const paths = artifacts.map((a) => a['path']).sort();
    assert.deepEqual(paths, ['report.md', 'sources.json']);
    const report = artifacts.find((a) => a['path'] === 'report.md')!;
    assert.equal(report['mime_type'], 'text/markdown');
    assert.ok((report['size_bytes'] as number) > 0);
    assert.match(String(report['sha256']), /^[0-9a-f]{64}$/);
    // git fields must not leak into non-git results
    assert.ok(!('commit_hash' in result));
    // compact: the report body is NOT inlined in the result
    assert.ok(!JSON.stringify(result).includes('Findings here.'));

    // list_artifacts / get_artifact
    const listed = h.supervisor.listArtifacts(spawn.task_id);
    assert.equal(listed.length, 2);
    const content = h.supervisor.artifactContent(spawn.task_id, 'report.md') as Record<string, unknown>;
    assert.equal(content['binary'], false);
    assert.ok(String(content['content']).includes('Findings here.'));
    assert.equal(content['truncated'], false);

    const meta = h.supervisor.artifactMetadata(spawn.task_id, 'sources.json');
    assert.equal(meta['mime_type'], 'application/json');
    assert.equal(meta['exists'], true);

    // usage counters
    const usage = h.supervisor.taskUsage(spawn.task_id) as Record<string, unknown>;
    assert.equal(usage['input_tokens'], 500);
    assert.equal(usage['tool_calls'], 1);
    assert.deepEqual(usage['tool_calls_by_tool'], { web_search: 1 });
    assert.equal(usage['steps'], 1);
  } finally {
    h.cleanup();
  }
});

test('missing deliverables are recorded (status still completed)', async () => {
  const h = makeHarness(() => ({
    steps: [
      { writeFile: { path: 'report.md', content: 'only this one\n' } },
      { emit: { type: 'final', text: 'Summary:\n- wrote report but forgot sources' } },
    ],
    exitCode: 0,
  }));
  try {
    const spawn = h.supervisor.spawnTask({
      task: 'research with missing deliverable',
      mode: 'research',
      deliverables: ['report.md', 'sources.json'],
    });
    const row = await h.supervisor.waitFor(spawn.task_id);
    assert.equal(row.status, 'completed');
    assert.deepEqual(JSON.parse(row.deliverables_missing!), ['sources.json']);
    const result = h.supervisor.taskResult(spawn.task_id) as Record<string, unknown>;
    assert.deepEqual(result['deliverables_missing'], ['sources.json']);
  } finally {
    h.cleanup();
  }
});

test('data task in directory workspace: only files touched during run are indexed', async () => {
  const dataDir = makeTempDir('kwm-data-');
  fs.writeFileSync(path.join(dataDir, 'dataset.csv'), 'a,b\n1,2\n');
  // Make the pre-existing dataset look old so it is not mistaken for an output.
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(dataDir, 'dataset.csv'), past, past);

  const h = makeHarness(() => ({
    steps: [
      { emit: { type: 'tool_call', callId: 'c1', tool: 'bash', input: { command: 'python3 analysis.py' } } },
      { writeFile: { path: 'analysis.md', content: '# Analysis\n\nNo regressions.\n' } },
      { writeFile: { path: 'results.csv', content: 'metric,value\nrows,1\n' } },
      { emit: { type: 'final', text: 'Summary:\n- analyzed dataset.csv' } },
    ],
    exitCode: 0,
  }));
  try {
    const spawn = h.supervisor.spawnTask({
      task: 'analyze the dataset',
      mode: 'data',
      workspace: { type: 'directory', path: dataDir },
      deliverables: ['analysis.md', 'results.csv'],
    });
    assert.equal(spawn.workspace.type, 'directory');
    assert.equal(spawn.workspace.path, fs.realpathSync(dataDir));

    const row = await h.supervisor.waitFor(spawn.task_id);
    assert.equal(row.status, 'completed');

    const artifacts = h.supervisor.listArtifacts(spawn.task_id);
    const paths = artifacts.map((a) => a['path']).sort();
    assert.deepEqual(paths, ['analysis.md', 'results.csv'], 'pre-existing dataset not indexed');

    // dataset untouched
    assert.equal(fs.readFileSync(path.join(dataDir, 'dataset.csv'), 'utf8'), 'a,b\n1,2\n');
  } finally {
    h.cleanup();
    removeDir(dataDir);
  }
});

test('get_artifact caps size and refuses binary inline content', async () => {
  const h = makeHarness(() => ({
    steps: [
      { writeFile: { path: 'big.md', content: 'x'.repeat(200_000) } },
      { writeFile: { path: 'raw.bin', content: Buffer.from([0, 1, 2, 3]).toString('latin1') } },
      { emit: { type: 'final', text: 'Summary:\n- wrote files' } },
    ],
    exitCode: 0,
  }));
  try {
    const spawn = h.supervisor.spawnTask({ task: 'make files', mode: 'general' });
    await h.supervisor.waitFor(spawn.task_id);

    const capped = h.supervisor.artifactContent(spawn.task_id, 'big.md', 1024) as Record<string, unknown>;
    assert.equal(capped['truncated'], true);
    assert.ok(Buffer.byteLength(String(capped['content']), 'utf8') <= 1024);
    assert.equal(capped['size_bytes'], 200_000);

    const bin = h.supervisor.artifactContent(spawn.task_id, 'raw.bin') as Record<string, unknown>;
    assert.equal(bin['binary'], true);
    assert.equal(bin['content'], null);

    assert.throws(() => h.supervisor.artifactContent(spawn.task_id, '../escape'), /relative|escapes/);
    assert.throws(() => h.supervisor.artifactContent(spawn.task_id, 'missing.md'), /no such artifact/);
  } finally {
    h.cleanup();
  }
});

test('review task on git worktree gets git fields in task result', async () => {
  const repo = makeTempRepo();
  const h = makeHarness(() => ({
    steps: [
      { writeFile: { path: 'review.md', content: '# Review\n\nNo findings.\n' } },
      { git: ['add', '-A'] },
      { git: ['-c', 'user.name=k', '-c', 'user.email=k@l', '-c', 'commit.gpgsign=false', 'commit', '-m', 'add review notes'] },
      { emit: { type: 'final', text: 'Summary:\n- reviewed code, no findings' } },
    ],
    exitCode: 0,
  }));
  try {
    const spawn = h.supervisor.spawnTask({
      task: 'review HEAD for bugs',
      mode: 'review',
      workspace: { type: 'git_worktree', repo_path: repo },
      deliverables: ['review.md'],
    });
    assert.equal(spawn.workspace.type, 'git_worktree');
    assert.ok(spawn.branch);

    const row = await h.supervisor.waitFor(spawn.task_id);
    assert.equal(row.status, 'completed');

    const result = h.supervisor.taskResult(spawn.task_id) as Record<string, unknown>;
    assert.equal(result['mode'], 'review');
    assert.ok(result['commit_hash']);
    assert.deepEqual(result['changed_files'], ['review.md']);

    // Legacy APIs work against the same task id.
    const legacy = h.supervisor.result(spawn.task_id) as Record<string, unknown>;
    assert.equal(legacy['worker_id'], spawn.task_id);
    assert.ok(legacy['commit_hash']);
    const diff = h.supervisor.diff(spawn.task_id, {});
    assert.ok(String(diff['diff_stat']).includes('review.md'));
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('diff on non-git workspace gives a clear error', async () => {
  const h = makeHarness(() => researchScenario());
  try {
    const spawn = h.supervisor.spawnTask({ task: 'research', mode: 'research' });
    await h.supervisor.waitFor(spawn.task_id);
    assert.throws(() => h.supervisor.diff(spawn.task_id, {}), /does not use a git worktree/);
  } finally {
    h.cleanup();
  }
});

test('continue_worker works on a temporary-workspace task (same session, same workspace)', async () => {
  const seen: Array<{ resume: boolean; cwd: string }> = [];
  const h = makeHarness(({ resume, cwd }) => {
    seen.push({ resume, cwd });
    return resume
      ? {
          steps: [
            { appendFile: { path: 'report.md', content: '\nAddendum.\n' } },
            { emit: { type: 'final', text: 'Summary:\n- added addendum' } },
          ],
          exitCode: 0,
        }
      : researchScenario();
  });
  try {
    const spawn = h.supervisor.spawnTask({ task: 'research', mode: 'research' });
    const row = await h.supervisor.waitFor(spawn.task_id);
    const session = row.session_id!;

    await h.supervisor.continueWorker(spawn.task_id, 'add an addendum');
    const row2 = await h.supervisor.waitFor(spawn.task_id);
    assert.equal(row2.status, 'completed');
    assert.equal(row2.session_id, session);
    assert.equal(row2.continue_count, 1);

    assert.equal(seen.length, 2);
    assert.equal(seen[1]?.resume, true);
    assert.equal(seen[0]?.cwd, seen[1]?.cwd);

    const content = h.supervisor.artifactContent(spawn.task_id, 'report.md');
    assert.ok(String(content['content']).includes('Addendum.'));
  } finally {
    h.cleanup();
  }
});

test('invalid spawn_task inputs are rejected', () => {
  const h = makeHarness(() => researchScenario());
  try {
    assert.throws(() => h.supervisor.spawnTask({ task: '' }), /non-empty/);
    assert.throws(() => h.supervisor.spawnTask({ task: 'x', mode: 'wizard' }), /invalid mode/);
    assert.throws(
      () => h.supervisor.spawnTask({ task: 'x', workspace: { type: 'nope' as 'temporary' } }),
      /invalid workspace.type/,
    );
    assert.throws(
      () => h.supervisor.spawnTask({ task: 'x', mode: 'data', workspace: { type: 'directory' } }),
      /path is required/,
    );
    assert.throws(
      () => h.supervisor.spawnTask({ task: 'x', deliverables: ['../evil'] }),
      /escapes|relative/,
    );
    // git_worktree without repo_path
    assert.throws(
      () => h.supervisor.spawnTask({ task: 'x', mode: 'code', workspace: { type: 'git_worktree' } }),
      /repo_path is required/,
    );
  } finally {
    h.cleanup();
  }
});

test('legacy spawn_worker maps to code + git_worktree with mode recorded', async () => {
  const repo = makeTempRepo();
  const { FakeScenarios } = await import('../../backends/fake.js');
  const h = makeHarness(() => FakeScenarios.successWithCommit('feat.txt', 'f\n', 'feat'));
  try {
    const spawn = h.supervisor.spawn({ repo_path: repo, task: 'legacy spawn' });
    const row = await h.supervisor.waitFor(spawn.worker_id);
    assert.equal(row.mode, 'code');
    assert.equal(row.workspace_type, 'git_worktree');
    assert.equal(row.status, 'completed');
    // taskResult works for legacy tasks too and includes git fields
    const result = h.supervisor.taskResult(spawn.worker_id) as Record<string, unknown>;
    assert.equal(result['mode'], 'code');
    assert.ok(result['commit_hash']);
    const artifacts = result['artifacts'] as Array<Record<string, unknown>>;
    assert.deepEqual(artifacts.map((a) => a['path']), ['feat.txt']);
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});
