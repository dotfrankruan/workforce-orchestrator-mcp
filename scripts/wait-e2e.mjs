// Real DSH smoke: two parallel worker tasks + wait_tasks(all).
// Verifies lifecycle and waiting only — each task gets its own isolated
// temporary workspace. Usage: node scripts/wait-e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kwm-wait-root-'));
const server = spawn(process.execPath, ['dist/cli.js', 'serve'], {
  env: { ...process.env, WORKFORCE_ROOT: workerRoot, WORKFORCE_CONFIG: path.join(workerRoot, 'config.json') },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const rl = readline.createInterface({ input: server.stdout });
const pending = new Map();
let nextId = 1;
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

const request = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 600000);
  });

const tool = (name, args) =>
  request('tools/call', { name, arguments: args }).then((r) => {
    const text = r.result?.content?.[0]?.text;
    if (r.result?.isError) throw new Error(`${name}: ${text}`);
    return text ? JSON.parse(text) : r.result;
  });

let exitCode = 0;
try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'wait-e2e', version: '0.0.1' },
  });
  console.log('✓ initialize (instructions:', init.result.instructions ? 'present' : 'MISSING', ')');

  console.log('→ spawning two parallel real worker tasks…');
  const batch = await tool('spawn_tasks', {
    tasks: [
      { task: 'Create a file named A.txt containing exactly the letter A. Nothing else.', mode: 'general', timeout_seconds: 240 },
      { task: 'Create a file named B.txt containing exactly the letter B. Nothing else.', mode: 'general', timeout_seconds: 240 },
    ],
  });
  const ids = batch.tasks.map((t) => t.task_id);
  console.log('✓ spawn_tasks:', JSON.stringify(batch.tasks.map((t) => ({ id: t.task_id, status: t.status }))));

  console.log('→ wait_tasks(all) — single call instead of polling…');
  const start = Date.now();
  const waited = await tool('wait_tasks', { task_ids: ids, return_when: 'all', timeout_seconds: 300 });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`✓ wait_tasks returned after ${elapsed}s:`, JSON.stringify(waited.tasks.map((t) => ({ id: t.task_id, status: t.status, terminal: t.terminal }))));

  const checks = [];
  checks.push(['both terminal', waited.tasks.every((t) => t.terminal)]);
  checks.push(['completed_condition', waited.completed_condition === true]);
  checks.push(['not timed out', waited.timed_out === false]);

  for (const id of ids) {
    const r = await tool('get_task_result', { task_id: id });
    const files = (r.artifacts || []).map((a) => a.path);
    console.log(`✓ ${id}: status=${r.status} artifacts=${JSON.stringify(files)}`);
    checks.push([`${id} completed`, r.status === 'completed']);
  }

  let failed = false;
  for (const [name, ok] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${name}`);
    if (!ok) failed = true;
  }
  if (failed) exitCode = 1;
  else console.log('\nREAL WAIT E2E PASSED');
} catch (err) {
  console.error('E2E error:', err);
  exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(workerRoot, { recursive: true, force: true });
}
process.exit(exitCode);
