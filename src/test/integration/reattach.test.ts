import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WorkerStore } from '../../db.js';
import { WorkerSupervisor } from '../../supervisor.js';
import { pidAlive } from '../../proc.js';
import { ProcScriptBackend, makeProcHarness, makeTempRepo, makeTempDir, git, removeDir, type ProcStep } from '../helpers.js';

const slow = (ms: number, finalText = 'Summary:\n- done'): { steps: ProcStep[] } => ({
  steps: [
    { emit: { type: 'status', phase: 'turn_start', turn: 1 } },
    { sleep: Math.floor(ms / 2) },
    { emit: { type: 'text', text: 'halfway' } },
    { sleep: Math.ceil(ms / 2) },
    { emit: { type: 'final', text: finalText } },
  ],
});

test('regression: supervisor restart with live worker → reattach, never interrupted, single attempt', async () => {
  const h = makeProcHarness(() => slow(3000));
  try {
    const s = h.supervisor.spawnTask({ task: 'slow work', mode: 'general' });
    await new Promise((r) => setTimeout(r, 400));
    let row = h.store.getWorker(s.task_id)!;
    assert.equal(row.status, 'running');
    assert.ok(row.pid && pidAlive(row.pid));
    assert.ok(row.pid_identity, 'pid identity persisted');
    const pid = row.pid!;
    const offsetAtRestart = row.stdout_parse_offset;

    // Supervisor A "dies": detach WITHOUT killing the worker.
    await h.supervisor.shutdown();

    // Worker keeps running and writing.
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(pidAlive(pid), 'worker process survives supervisor death');

    // Supervisor B: same db, new in-memory state.
    const sup2 = new WorkerSupervisor(h.config, h.store, h.backend);
    sup2.init();

    row = h.store.getWorker(s.task_id)!;
    assert.equal(row.status, 'running', 'never interrupted');
    assert.equal(row.supervision_state, 'reattached');
    assert.equal(row.pid, pid, 'same process');

    // B finalizes the run when the worker finishes.
    const res = (await sup2.waitTask(s.task_id, 30)) as Record<string, any>;
    assert.equal(res.status, 'completed');
    assert.equal(res.wait.completed, true);

    row = h.store.getWorker(s.task_id)!;
    assert.equal(row.attempt, 1, 'no duplicate attempt');
    assert.ok(row.stdout_parse_offset > offsetAtRestart, 'B continued parsing from the checkpoint');
    const events = h.store.listEvents(s.task_id, 100);
    assert.ok(events.some((e) => e.type === 'reattach'));
    assert.equal(h.store.listAttempts(s.task_id).length, 1);
  } finally {
    h.cleanup();
  }
});

test('shutdown leaves workers running (durable by default)', async () => {
  const h = makeProcHarness(() => slow(5000));
  try {
    const s = h.supervisor.spawnTask({ task: 'x', mode: 'general' });
    await new Promise((r) => setTimeout(r, 300));
    const pid = h.store.getWorker(s.task_id)!.pid!;
    await h.supervisor.shutdown();
    assert.ok(pidAlive(pid), 'worker not killed on shutdown');
    assert.equal(h.store.getWorker(s.task_id)!.supervision_state, 'detached');
    // Cleanup: kill the child so the test exits promptly.
    process.kill(pid, 'SIGKILL');
  } finally {
    h.cleanup();
  }
});

test('dead worker + durable final event → finalized as completed (not interrupted)', async () => {
  const h = makeProcHarness(() => slow(0));
  try {
    // Run the child entirely OUTSIDE any supervisor: write a durable log with
    // a final event, exit, then reconcile a stale running row.
    const id = 'wk_deadfin01';
    const logDir = path.join(h.root, 'tasks', id);
    fs.mkdirSync(logDir, { recursive: true });
    const stdoutPath = path.join(logDir, 'stdout.jsonl');
    fs.writeFileSync(stdoutPath, '');
    const child = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      const line = (o) => fs.appendFileSync(${JSON.stringify(stdoutPath)}, JSON.stringify(o) + '\\n');
      line({ type: 'session', sessionId: 'session-dead', cwd: process.cwd() });
      line({ type: 'status', phase: 'step_end', usage: { inputTokens: 42, outputTokens: 7, totalTokens: 49, cacheReadTokens: 0 } });
      line({ type: 'final', text: 'Summary:\\n- done' });
      process.exit(0);
    `], { cwd: logDir, stdio: ['ignore', 'ignore', 'ignore'] });
    const pid = child.pid!;
    await new Promise((r) => child.on('exit', r));
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!pidAlive(pid));

    h.store.createWorker({
      id, repo_path: '', base_ref: '', branch: '', worktree_path: logDir, log_dir: logDir,
      task: 't', mode: 'general', workspace_type: 'temporary',
      deliverables: '[]', capabilities: '[]', timeout_seconds: 60,
    });
    h.store.updateWorker(id, { status: 'running', pid });

    const sup2 = new WorkerSupervisor(h.config, h.store, h.backend);
    sup2.init();
    const row = h.store.getWorker(id)!;
    assert.equal(row.status, 'completed');
    assert.equal(row.supervision_state, 'detached');
    assert.equal(row.exit_code, null, 'exit code unknown — never fabricated');
    assert.equal(row.input_tokens, 42, 'usage recovered from log');
    assert.ok(row.final_text?.includes('done'));
  } finally {
    h.cleanup();
  }
});

test('dead worker + no terminal evidence → genuinely interrupted', async () => {
  const h = makeProcHarness(() => slow(0));
  try {
    // Craft a stale row manually: dead pid, partial log without final.
    const id = 'wk_deadproc1';
    const logDir = path.join(h.root, 'tasks', id);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'stdout.jsonl'),
      JSON.stringify({ type: 'session', sessionId: 'session-x', cwd: '/tmp' }) + '\n' +
        JSON.stringify({ type: 'status', phase: 'turn_start', turn: 1 }) + '\n',
    );
    h.store.createWorker({
      id,
      repo_path: '',
      base_ref: '',
      branch: '',
      worktree_path: logDir,
      log_dir: logDir,
      task: 't',
      mode: 'general',
      workspace_type: 'temporary',
      deliverables: '[]',
      capabilities: '[]',
      timeout_seconds: 60,
    });
    h.store.updateWorker(id, { status: 'running', pid: 99999998 });

    const sup2 = new WorkerSupervisor(h.config, h.store, h.backend);
    sup2.init();
    const row = h.store.getWorker(id)!;
    assert.equal(row.status, 'interrupted');
    assert.match(row.error!, /no final/);
    assert.equal(h.store.metaGet('workers_genuinely_interrupted'), 1);
  } finally {
    h.cleanup();
  }
});

test('PID reuse protection: alive pid with wrong identity is not attached', async () => {
  const h = makeProcHarness(() => slow(0));
  try {
    const id = 'wk_reuse001';
    const logDir = path.join(h.root, 'tasks', id);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'stdout.jsonl'), JSON.stringify({ type: 'session', sessionId: 's', cwd: '/tmp' }) + '\n');
    h.store.createWorker({
      id, repo_path: '', base_ref: '', branch: '', worktree_path: logDir, log_dir: logDir,
      task: 't', mode: 'general', workspace_type: 'temporary',
      deliverables: '[]', capabilities: '[]', timeout_seconds: 60,
    });
    // Our own pid is alive but is NOT the worker (wrong start token).
    h.store.updateWorker(id, { status: 'running', pid: process.pid, pid_identity: 'bogus-token' });

    const sup2 = new WorkerSupervisor(h.config, h.store, h.backend);
    sup2.init();
    assert.equal(h.store.getWorker(id)!.status, 'interrupted');
  } finally {
    h.cleanup();
  }
});

test('timeout survives restart: remaining time, not a fresh budget', async () => {
  // Child runs 30s; task timeout 3s; restart after ~1s → should die ≈3s from start.
  const h = makeProcHarness(() => slow(30000));
  try {
    const s = h.supervisor.spawnTask({ task: 'slow', mode: 'general', timeout_seconds: 3 });
    await new Promise((r) => setTimeout(r, 1000));
    const startMs = Date.parse(h.store.getWorker(s.task_id)!.run_started_at!);
    const pid = h.store.getWorker(s.task_id)!.pid!;

    await h.supervisor.shutdown();
    const sup2 = new WorkerSupervisor(h.config, h.store, h.backend);
    sup2.init();

    const res = (await sup2.waitTask(s.task_id, 30)) as Record<string, any>;
    assert.equal(res.status, 'timeout');
    const totalMs = Date.now() - startMs;
    assert.ok(totalMs >= 2800 && totalMs < 8000, `timeout honored across restart (took ${totalMs}ms from original start)`);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!pidAlive(pid));
  } finally {
    h.cleanup();
  }
});

test('token budget survives restart: usage before + after restart is merged', async () => {
  const scenario = () => ({
    steps: [
      { emit: { type: 'status', phase: 'step_end', usage: { inputTokens: 600, outputTokens: 0, totalTokens: 600, cacheReadTokens: 0 } } },
      { sleep: 1500 }, // supervisor restart happens during this window
      { emit: { type: 'status', phase: 'step_end', usage: { inputTokens: 600, outputTokens: 0, totalTokens: 1200, cacheReadTokens: 0 } } },
      { sleep: 5000 },
    ] as ProcStep[],
  });
  const h = makeProcHarness(scenario);
  try {
    const s = h.supervisor.spawnTask({
      task: 'budgeted',
      mode: 'general',
      budget: { max_total_tokens: 1000 },
      timeout_seconds: 60,
    });
    // Wait for first usage event (600 < 1000, under budget).
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(h.store.getWorker(s.task_id)!.input_tokens, 600);

    await h.supervisor.shutdown();
    const sup2 = new WorkerSupervisor(h.config, h.store, h.backend);
    sup2.init();
    assert.equal(h.store.getWorker(s.task_id)!.supervision_state, 'reattached');

    // Child emits +600 → 1200 > 1000 → B terminates it as budget_exceeded.
    const res = (await sup2.waitTask(s.task_id, 30)) as Record<string, any>;
    assert.equal(res.status, 'budget_exceeded', 'usage merged across restart (600+600>1000)');
  } finally {
    h.cleanup();
  }
});

test('workflow task: restart reattaches without duplicate attempt or duplicate integration', async () => {
  const repo = makeTempRepo();
  const h = makeProcHarness(() => ({
    steps: [
      { write: { path: 'f.txt', content: 'f\n' } },
      { sleep: 1500 },
      { emit: { type: 'final', text: 'Summary:\n- wrote f' } },
    ],
  }));
  try {
    const wf = h.supervisor.createWorkflow({
      workspace: { type: 'git_worktree', repo_path: repo },
      tasks: [{ key: 'a', task: 'TAG_A', mode: 'code' }],
    }) as Record<string, any>;
    await new Promise((r) => setTimeout(r, 500));
    const aId = (wf.tasks as Record<string, string>)['a']!;
    assert.equal(h.store.getWorker(aId)!.status, 'running');

    await h.supervisor.shutdown();
    const sup2 = new WorkerSupervisor(h.config, h.store, h.backend);
    sup2.init();

    const done = await sup2.waitWorkflow(wf.workflow_id, 30);
    assert.equal(done['status'], 'completed');
    const row = h.store.getWorker(aId)!;
    assert.equal(row.attempt, 1, 'no duplicate attempt');
    assert.deepEqual(JSON.parse(row.task_commits).length, 1, 'exactly one commit');
    assert.equal(row.integration_status, 'integrated');
    assert.deepEqual(JSON.parse(row.integrated_commits).length, 1, 'integrated exactly once');
    assert.equal(h.store.listAttempts(aId).length, 1);
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('git finalization idempotency across restarts', async () => {
  const repo = makeTempRepo();
  const base = git(['rev-parse', 'HEAD'], repo).trim();

  // Simulate: worker finished (final in log), dirty worktree, supervisor died
  // before committing. B reconciles → commits + integrates. C reconciles → no dup.
  const h = makeProcHarness(() => ({
    steps: [
      { write: { path: 'f.txt', content: 'f\n' } },
      { emit: { type: 'final', text: 'Summary:\n- wrote f' } },
    ],
  }));
  try {
    const wf = h.supervisor.createWorkflow({
      workspace: { type: 'git_worktree', repo_path: repo },
      tasks: [{ key: 'a', task: 'TAG_A', mode: 'code' }],
    }) as Record<string, any>;

    // Let it complete normally (supervisor commits + integrates), then
    // simulate a second reconciliation pass and assert no double integration.
    const done = await h.supervisor.waitWorkflow(wf.workflow_id, 30);
    assert.equal(done['status'], 'completed');
    const headAfter = git(['rev-parse', 'HEAD'], h.store.getWorkflow(wf.workflow_id)!.workspace_path).trim();

    const sup2 = new WorkerSupervisor(h.config, h.store, h.backend);
    sup2.init();
    const headAfterReconcile = git(['rev-parse', 'HEAD'], h.store.getWorkflow(wf.workflow_id)!.workspace_path).trim();
    assert.equal(headAfterReconcile, headAfter, 'no duplicate commits/picks after restart');
    assert.equal(git(['rev-list', '--count', `${base}..HEAD`], h.store.getWorkflow(wf.workflow_id)!.workspace_path).trim(), '1');
  } finally {
    h.cleanup();
    removeDir(repo);
  }
});

test('get_worker exposes supervision state and liveness', async () => {
  const h = makeProcHarness(() => slow(2000));
  try {
    const s = h.supervisor.spawnTask({ task: 'x', mode: 'general' });
    await new Promise((r) => setTimeout(r, 300));
    const diag = h.supervisor.processDiagnostics(s.task_id);
    assert.equal(diag['process_alive'], true);
    assert.equal(diag['identity_matches'], true);
    assert.equal(diag['supervision'], 'attached');
    assert.ok(typeof diag['stdout_parse_offset'] === 'number');
    await h.supervisor.waitFor(s.task_id);
  } finally {
    h.cleanup();
  }
});

test('reattach handles worker that exits DURING tailing (race)', async () => {
  // Very short child; restart immediately — by init() time the process may
  // be alive or dead depending on timing; either way we must end completed.
  const h = makeProcHarness(() => slow(150));
  try {
    const s = h.supervisor.spawnTask({ task: 'racy', mode: 'general' });
    await new Promise((r) => setTimeout(r, 50));
    await h.supervisor.shutdown();
    await new Promise((r) => setTimeout(r, 300)); // let it exit
    const sup2 = new WorkerSupervisor(h.config, h.store, h.backend);
    sup2.init();
    const res = (await sup2.waitTask(s.task_id, 30)) as Record<string, any>;
    assert.equal(res.status, 'completed');
  } finally {
    h.cleanup();
  }
});

// Keep node from complaining about unused imports in case of refactors.
void spawn;
void ProcScriptBackend;
void makeTempDir;
