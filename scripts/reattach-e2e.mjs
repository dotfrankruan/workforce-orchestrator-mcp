// Real DSH reattach E2E (v4.1.1 durability hotfix validation):
//   1. spawn a real worker task that takes ~20-30s
//   2. kill the MCP supervisor process (NOT the dsh worker)
//   3. verify the dsh process is still alive
//   4. restart the MCP server → reconciliation reattaches
//   5. task completes → supervisor git-finalizes → commit verified
//   6. main repo untouched
// Usage: node scripts/reattach-e2e.mjs   (live provider API)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kwm-reattach-repo-'));
const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kwm-reattach-root-'));
const git = (args, cwd = repoPath) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'e2e']);
git(['config', 'user.email', 'e2e@example.com']);
git(['config', 'commit.gpgsign', 'false']);
fs.writeFileSync(path.join(repoPath, 'hello.txt'), 'hello\n');
git(['add', '-A']);
git(['commit', '-qm', 'init']);
const mainHead = git(['rev-parse', 'HEAD']).trim();

const env = { ...process.env, WORKFORCE_ROOT: workerRoot };

function startServer() {
  const srv = spawn(process.execPath, ['dist/cli.js', 'serve'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: srv.stdout });
  const pending = new Map();
  let nextId = 1;
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const request = (method, params = {}, timeoutMs = 600000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
    });
  const toolC = (name, args) =>
    request('tools/call', { name, arguments: args ?? {} }).then((r) => {
      const text = r.result?.content?.[0]?.text;
      if (r.result?.isError) throw new Error(`${name}: ${text}`);
      return text ? JSON.parse(text) : r.result;
    });
  return { srv, request, tool: toolC };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok) => { checks.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}`); };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

let exitCode = 0;
let serverA = null;
let serverB = null;
try {
  serverA = startServer();
  await serverA.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reattach-e2e', version: '1' } });

  console.log('→ spawning real worker task (~20-30s: edit + sleep)…');
  const spawnRes = await serverA.tool('spawn_task', {
    mode: 'code',
    workspace: { type: 'git_worktree', repo_path: repoPath },
    task: 'Create a file durable.txt containing exactly "durable". Then run `sleep 20` in the shell to simulate a long verification step. Do NOT create any git commit.',
    timeout_seconds: 180,
  });
  console.log('✓ spawned:', spawnRes.task_id);

  // Wait until running with a live pid.
  let w;
  for (let i = 0; i < 30; i++) {
    w = await serverA.tool('get_worker', { worker_id: spawnRes.task_id });
    if (w.status === 'running' && w.process_alive) break;
    await sleep(500);
  }
  check('worker running under supervisor A', w.status === 'running');

  // Get the worker pid via the CLI (reads the shared DB).
  const inspectOut = execFileSync(process.execPath, ['dist/cli.js', 'inspect', spawnRes.task_id], { env, encoding: 'utf8' });
  const workerPid = JSON.parse(inspectOut).process.pid;
  check('pid persisted', Number.isInteger(workerPid) && pidAlive(workerPid));

  // Kill supervisor A (graceful → detach), NOT the worker.
  console.log('→ terminating supervisor A (worker keeps running)…');
  serverA.srv.kill('SIGTERM');
  await sleep(1500);
  check('supervisor A dead', !pidAlive(serverA.srv.pid) || serverA.srv.exitCode !== null);
  check('worker STILL ALIVE after supervisor death', pidAlive(workerPid));

  // Restart supervisor B.
  console.log('→ starting supervisor B (reattach)…');
  serverB = startServer();
  await serverB.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reattach-e2e-b', version: '1' } });

  const w2 = await serverB.tool('get_worker', { worker_id: spawnRes.task_id });
  console.log('  after reattach:', JSON.stringify({ status: w2.status, supervision: w2.supervision, process_alive: w2.process_alive }));
  check('status still running (never interrupted)', w2.status === 'running');
  check('supervision = reattached', w2.supervision === 'reattached');
  check('process alive under B', w2.process_alive === true);

  console.log('→ waiting for worker completion via B…');
  const done = await serverB.tool('wait_task', { task_id: spawnRes.task_id, timeout_seconds: 240 });
  check('task completed via reattached supervisor', done.status === 'completed');

  const result = await serverB.tool('get_task_result', { task_id: spawnRes.task_id });
  check('commit created by supervisor', result.git && result.git.commit_created_by === 'supervisor');
  check('durable.txt in changed files', (result.changed_files || []).includes('durable.txt'));
  check('attempts = 1 (no duplicate run)', result.attempts === 1);
  check('main untouched', git(['rev-parse', 'HEAD']).trim() === mainHead);

  const events = execFileSync(process.execPath, ['dist/cli.js', 'logs', spawnRes.task_id], { env, encoding: 'utf8' });
  check('log intact after reattach', events.length > 50);

  const okAll = checks.every(([, ok]) => ok);
  console.log(okAll ? '\nREATTACH E2E PASSED' : '\nREATTACH E2E FAILED');
  if (!okAll) exitCode = 1;
} catch (err) {
  console.error('E2E error:', err);
  exitCode = 1;
} finally {
  try { serverA?.srv.kill('SIGKILL'); } catch {}
  try { serverB?.srv.kill('SIGKILL'); } catch {}
  await sleep(500);
  fs.rmSync(repoPath, { recursive: true, force: true });
  fs.rmSync(workerRoot, { recursive: true, force: true });
}
process.exit(exitCode);
