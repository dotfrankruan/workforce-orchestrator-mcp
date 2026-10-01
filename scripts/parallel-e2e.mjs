// Real Kimi E2E for v4.1: parallel git writers + fan-in integration.
// A modifies a.txt, B modifies b.txt (truly parallel, isolated worktrees),
// C depends on A+B and writes summary.txt. Verifies isolation, serialized
// integration, snapshot correctness, supervisor commits, main untouched.
// Usage: node scripts/parallel-e2e.mjs   (calls the live Kimi API)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kwm-par-repo-'));
const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kwm-par-root-'));
const git = (args, cwd = repoPath) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'e2e']);
git(['config', 'user.email', 'e2e@example.com']);
git(['config', 'commit.gpgsign', 'false']);
fs.writeFileSync(path.join(repoPath, 'a.txt'), 'a\n');
fs.writeFileSync(path.join(repoPath, 'b.txt'), 'b\n');
git(['add', '-A']);
git(['commit', '-qm', 'init']);
const mainHeadBefore = git(['rev-parse', 'HEAD']).trim();

const server = spawn(process.execPath, ['dist/cli.js', 'serve'], {
  env: { ...process.env, KIMI_WORKER_ROOT: workerRoot },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const rl = readline.createInterface({ input: server.stdout });
const pending = new Map();
let nextId = 1;
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const request = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 600000);
  });
const tool = (name, args) =>
  request('tools/call', { name, arguments: args }).then((r) => {
    const text = r.result?.content?.[0]?.text;
    if (r.result?.isError) throw new Error(`${name}: ${text}`);
    return text ? JSON.parse(text) : r.result;
  });

let exitCode = 0;
try {
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'par-e2e', version: '0.1' } });

  console.log('→ creating parallel workflow (live Kimi K3)…');
  const wf = await tool('create_workflow', {
    name: 'parallel-e2e',
    workspace: { type: 'git_worktree', repo_path: repoPath },
    tasks: [
      { key: 'A', mode: 'code', role: 'implementer', task: 'Change a.txt content from "a" to "a-modified". Nothing else. Do NOT commit.' },
      { key: 'B', mode: 'code', role: 'implementer', task: 'Change b.txt content from "b" to "b-modified". Nothing else. Do NOT commit.' },
      { key: 'C', mode: 'code', role: 'implementer', depends_on: ['A', 'B'], task: 'Create summary.txt listing the exact contents of a.txt and b.txt as you see them in this workspace. Do NOT commit.', deliverables: ['summary.txt'] },
    ],
  });
  console.log('✓ create_workflow:', JSON.stringify(wf.tasks));

  const done = await tool('wait_workflow', { workflow_id: wf.workflow_id, timeout_seconds: 600 });
  const result = await tool('get_workflow_result', { workflow_id: wf.workflow_id });
  const diff = await tool('get_workflow_diff', { workflow_id: wf.workflow_id });

  const checks = [];
  const byKey = Object.fromEntries(done.tasks.map((t) => [t.key, t]));
  checks.push(['workflow completed', done.status === 'completed']);
  checks.push(['A integrated', byKey['A'].status === 'completed']);
  checks.push(['B integrated', byKey['B'].status === 'completed']);
  checks.push(['C completed after A+B', byKey['C'].status === 'completed']);

  // Physical isolation (from DB via task results).
  const rA = await tool('get_task_result', { task_id: byKey['A'].task_id });
  const rB = await tool('get_task_result', { task_id: byKey['B'].task_id });
  const rC = await tool('get_task_result', { task_id: byKey['C'].task_id });
  checks.push(['A/B different worktrees', rA.workspace.path !== rB.workspace.path]);
  checks.push(['A/B different task branches', rA.git.task_branch !== rB.git.task_branch]);
  checks.push(['A integrated', rA.git.integration.status === 'integrated']);
  checks.push(['B integrated', rB.git.integration.status === 'integrated']);
  checks.push(['C integrated', rC.git.integration.status === 'integrated']);

  // C's snapshot contains both A and B changes.
  const cSnap = rC.git.workspace_base_commit;
  const snapFiles = git(['ls-tree', '--name-only', '-r', cSnap]).trim();
  const aAtSnap = git(['show', `${cSnap}:a.txt`]).trim();
  const bAtSnap = git(['show', `${cSnap}:b.txt`]).trim();
  checks.push(['C snapshot has a-modified', aAtSnap === 'a-modified']);
  checks.push(['C snapshot has b-modified', bAtSnap === 'b-modified']);

  // Integration branch has everything; summary.txt written by C.
  const iwt = done.workspace.path;
  checks.push(['integration has a-modified', fs.readFileSync(path.join(iwt, 'a.txt'), 'utf8').trim() === 'a-modified']);
  checks.push(['integration has b-modified', fs.readFileSync(path.join(iwt, 'b.txt'), 'utf8').trim() === 'b-modified']);
  checks.push(['summary.txt exists', fs.existsSync(path.join(iwt, 'summary.txt'))]);
  checks.push(['summary mentions both', fs.readFileSync(path.join(iwt, 'summary.txt'), 'utf8').includes('a-modified') && fs.readFileSync(path.join(iwt, 'summary.txt'), 'utf8').includes('b-modified')]);
  checks.push(['integration worktree clean', result.git.working_tree_clean === true]);
  checks.push(['integration conflicts = 0', result.git.integration_conflicts === 0]);
  checks.push(['tasks_integrated = 3', result.git.tasks_integrated === 3]);
  checks.push(['main untouched', git(['rev-parse', 'HEAD']).trim() === mainHeadBefore]);
  checks.push(['workflow diff shows 3 files', ['a.txt', 'b.txt', 'summary.txt'].every((f) => diff.diff_stat.includes(f))]);

  let failed = false;
  for (const [name, ok] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${name}`);
    if (!ok) failed = true;
  }
  if (failed) exitCode = 1;
  else console.log('\nPARALLEL WORKFLOW E2E PASSED');
} catch (err) {
  console.error('E2E error:', err);
  exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(repoPath, { recursive: true, force: true });
  fs.rmSync(workerRoot, { recursive: true, force: true });
}
process.exit(exitCode);
