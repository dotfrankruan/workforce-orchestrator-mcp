// MCP stdio smoke test: speaks JSON-RPC to `workforce-mcp serve` directly.
// Usage: node scripts/mcp-smoke.mjs <repo_path>   (uses WORKFORCE_BACKEND=fake)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const repoPath = process.argv[2];
if (!repoPath) {
  console.error('usage: node scripts/mcp-smoke.mjs <repo_path>');
  process.exit(2);
}

const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kwm-smoke-root-'));
const server = spawn(process.execPath, ['dist/cli.js', 'serve'], {
  env: {
    ...process.env,
    WORKFORCE_BACKEND: 'fake',
    WORKFORCE_ROOT: workerRoot,
    WORKFORCE_TERMINATE_GRACE_MS: '200',
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const rl = readline.createInterface({ input: server.stdout });
const pending = new Map();
let nextId = 1;

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
  });
}

function notify(method, params = {}) {
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const tool = (name, args) =>
  request('tools/call', { name, arguments: args ?? {} }).then((r) => {
    const text = r.result?.content?.[0]?.text;
    if (r.result?.isError) throw new Error(`${name}: ${text}`);
    return text ? JSON.parse(text) : r.result;
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '0.0.1' },
  });
  console.log('✓ initialize:', init.result.serverInfo);
  if (typeof init.result.instructions !== 'string' || init.result.instructions.length < 100) {
    throw new Error('initialize result missing server instructions');
  }
  console.log('✓ server instructions present:', init.result.instructions.slice(0, 90) + '…');
  notify('notifications/initialized');

  const tools = await request('tools/list');
  const names = tools.result.tools.map((t) => t.name).sort();
  console.log('✓ tools/list:', names.join(', '));

  const spawnRes = await tool('spawn_worker', { repo_path: repoPath, task: 'smoke test task: say hi' });
  console.log('✓ spawn_worker:', JSON.stringify(spawnRes));

  let status;
  for (let i = 0; i < 100; i++) {
    const w = await tool('get_worker', { worker_id: spawnRes.worker_id });
    status = w.status;
    if (!['queued', 'starting', 'running'].includes(status)) break;
    await sleep(100);
  }
  console.log('✓ final status:', status);

  const result = await tool('get_worker_result', { worker_id: spawnRes.worker_id });
  console.log('✓ get_worker_result keys:', Object.keys(result).join(', '));

  const log = await tool('get_worker_log', { worker_id: spawnRes.worker_id, tail_lines: 20 });
  console.log('✓ get_worker_log first line:', log.lines.split('\n')[0]);

  const diff = await tool('get_worker_diff', { worker_id: spawnRes.worker_id });
  console.log('✓ get_worker_diff stat_only:', diff.stat_only);

  const list = await tool('list_workers', { limit: 5 });
  console.log('✓ list_workers count:', list.count);

  // New workforce tools (fake backend writes nothing, but the calls must work).
  const task = await tool('spawn_task', {
    task: 'smoke research task',
    mode: 'research',
    deliverables: ['report.md'],
  });
  console.log('✓ spawn_task:', JSON.stringify(task));
  let t;
  for (let i = 0; i < 100; i++) {
    t = await tool('get_task_result', { task_id: task.task_id });
    if (!['queued', 'starting', 'running'].includes(t.status)) break;
    await sleep(100);
  }
  console.log('✓ get_task_result:', t.status, '| mode:', t.mode, '| workspace:', t.workspace.type, '| missing:', JSON.stringify(t.deliverables_missing));
  const arts = await tool('list_artifacts', { task_id: task.task_id });
  console.log('✓ list_artifacts count:', arts.artifacts.length);
  const tu = await tool('get_task_usage', { task_id: task.task_id });
  console.log('✓ get_task_usage tool_calls:', tu.tool_calls);

  // Parallel spawn + efficient waiting (the anti-polling flow).
  const batch = await tool('spawn_tasks', {
    tasks: [
      { task: 'parallel task A', mode: 'general' },
      { task: 'parallel task B', mode: 'research' },
    ],
  });
  console.log('✓ spawn_tasks:', batch.spawned, 'spawned,', batch.failed, 'failed');
  const ids = batch.tasks.filter((t) => t.ok).map((t) => t.task_id);
  const waited = await tool('wait_tasks', { task_ids: ids, return_when: 'all', timeout_seconds: 60 });
  console.log('✓ wait_tasks all:', waited.completed_condition, '| statuses:', waited.tasks.map((t) => t.status).join(','), '| waited_ms:', waited.waited_ms);
  if (!waited.completed_condition) throw new Error('wait_tasks did not complete');

  const single = await tool('wait_task', { task_id: ids[0], timeout_seconds: 10 });
  console.log('✓ wait_task (already terminal):', single.wait.completed === true && single.wait.waited_ms < 2000 ? 'immediate' : 'slow', '| has result:', Boolean(single.result));

  // Workflow orchestration (fake backend).
  const wfx = await tool('create_workflow', {
    name: 'smoke-wf',
    tasks: [
      { key: 'a', task: 'smoke A', mode: 'general', role: 'researcher' },
      { key: 'b', task: 'smoke B', mode: 'general', depends_on: ['a'] },
    ],
  });
  console.log('✓ create_workflow:', wfx.workflow_id, JSON.stringify(wfx.tasks));
  const wfDone = await tool('wait_workflow', { workflow_id: wfx.workflow_id, timeout_seconds: 60 });
  console.log('✓ wait_workflow:', wfDone.status, '| progress:', JSON.stringify(wfDone.progress));
  const wfRes = await tool('get_workflow_result', { workflow_id: wfx.workflow_id });
  console.log('✓ get_workflow_result: tasks', JSON.stringify(wfRes.tasks), '| warnings:', wfRes.warnings.length);
  const review = await tool('review_task_result', { task_id: wfx.tasks.a, decision: 'accepted', feedback: 'smoke' });
  console.log('✓ review_task_result:', review.acceptance);
  const roles = await tool('list_roles');
  const presets = await tool('list_presets');
  console.log('✓ list_roles:', roles.roles.length, '| list_presets:', presets.presets.length);
  const dryRun = await tool('run_workflow_preset', { preset: 'research_report', goal: 'smoke', options: { dry_run: true } });
  console.log('✓ run_workflow_preset dry_run:', dryRun.tasks.length, 'tasks planned, nothing spawned');
  const backends = await tool('list_backends');
  console.log('✓ list_backends:', backends.backends.map((b) => `${b.id}${b.default ? '(default)' : ''}${b.available ? '' : '(unavailable)'}`).join(', '));
  const sys = await tool('get_system_metrics');
  console.log('✓ get_system_metrics: tasks.total =', sys.tasks.total, '| cache:', JSON.stringify(sys.cache));

  console.log('\nSMOKE TEST PASSED');
} finally {
  server.kill('SIGTERM');
  fs.rmSync(workerRoot, { recursive: true, force: true });
}
process.exit(0);
