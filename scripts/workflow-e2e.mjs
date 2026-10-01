// Real Kimi workflow E2E: A (analysis.md) → B (modify hello.txt) → C (review.md)
// in a temporary git repo. Verifies DAG scheduling, artifacts, supervisor
// commits, wait_workflow, compact workflow result.
// Usage: node scripts/workflow-e2e.mjs   (calls the live Kimi API)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kwm-wf-repo-'));
const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kwm-wf-root-'));
const git = (args, cwd = repoPath) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'e2e']);
git(['config', 'user.email', 'e2e@example.com']);
git(['config', 'commit.gpgsign', 'false']);
fs.writeFileSync(path.join(repoPath, 'hello.txt'), 'hello\n');
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
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wf-e2e', version: '0.1' } });

  console.log('→ creating 3-task workflow on a temp repo (live Kimi K3)…');
  const wf = await tool('create_workflow', {
    name: 'mini-e2e',
    workspace: { type: 'git_worktree', repo_path: repoPath },
    tasks: [
      {
        key: 'analyze',
        mode: 'code',
        role: 'researcher',
        task: 'Inspect this repository and write analysis.md describing what it contains (it is tiny). Do NOT create git commits.',
        deliverables: ['analysis.md'],
      },
      {
        key: 'modify',
        mode: 'code',
        role: 'implementer',
        depends_on: ['analyze'],
        task: 'Read analysis.md, then change hello.txt content from "hello" to "hello world". Do NOT create git commits.',
      },
      {
        key: 'review',
        mode: 'review',
        role: 'reviewer',
        depends_on: ['modify'],
        task: 'Review the changes on this branch vs its base (hello.txt content change and analysis.md). Write review.md with your verdict. Do NOT create git commits.',
        deliverables: ['review.md'],
      },
    ],
  });
  console.log('✓ create_workflow:', JSON.stringify({ workflow_id: wf.workflow_id, tasks: wf.tasks, branch: wf.branch }));

  // Verify B/C start blocked on dependencies.
  const early = await tool('get_workflow', { workflow_id: wf.workflow_id });
  const earlyStatus = Object.fromEntries(early.tasks.map((t) => [t.key, t.status]));
  console.log('✓ initial task states:', JSON.stringify(earlyStatus));

  console.log('→ wait_workflow…');
  const done = await tool('wait_workflow', { workflow_id: wf.workflow_id, timeout_seconds: 600 });
  console.log('✓ workflow status:', done.status, '| progress:', JSON.stringify(done.progress));

  const result = await tool('get_workflow_result', { workflow_id: wf.workflow_id });
  const ws = done.workspace.path;

  const checks = [];
  checks.push(['workflow completed', done.status === 'completed']);
  checks.push(['B waited for A initially', earlyStatus['modify'] === 'waiting_dependencies']);
  checks.push(['analysis.md exists', fs.existsSync(path.join(ws, 'analysis.md'))]);
  checks.push(['hello.txt updated', fs.readFileSync(path.join(ws, 'hello.txt'), 'utf8').trim() === 'hello world']);
  checks.push(['review.md exists', fs.existsSync(path.join(ws, 'review.md'))]);
  checks.push(['worktree clean', result.git && result.git.working_tree_clean === true]);
  const commitCount = Number(git(['rev-list', '--count', `${mainHeadBefore}..${result.git.branch}`], repoPath).trim());
  checks.push(['supervisor commits on workflow branch (>=2)', commitCount >= 2]);
  checks.push(['main untouched', git(['rev-parse', 'HEAD']).trim() === mainHeadBefore]);
  checks.push(['compact result has no full report inline', !JSON.stringify(result).includes(fs.readFileSync(path.join(ws, 'analysis.md'), 'utf8').trim().slice(0, 80))]);
  checks.push(['artifacts aggregated', (result.artifacts || []).length >= 3]);

  const metrics = await tool('get_workflow_metrics', { workflow_id: wf.workflow_id });
  console.log('✓ workflow metrics:', JSON.stringify({ duration: metrics.duration_seconds, tokens: metrics.tokens, tasks: metrics.tasks }));

  let failed = false;
  for (const [name, ok2] of checks) {
    console.log(`${ok2 ? '✓' : '✗'} ${name}`);
    if (!ok2) failed = true;
  }
  if (failed) exitCode = 1;
  else console.log('\nWORKFLOW E2E PASSED');
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
