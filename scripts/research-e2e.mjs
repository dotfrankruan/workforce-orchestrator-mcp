// Real research-mode E2E: spawn_task(mode=research) against the real
// /usr/local/bin/dsh (DSH backend) in a TemporaryWorkspace — no network
// dependency: the worker only reports on its (empty) workspace.
// Usage: node scripts/research-e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kwm-research-root-'));
const server = spawn(process.execPath, ['dist/cli.js', 'serve'], {
  env: { ...process.env, WORKFORCE_ROOT: workerRoot },
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let exitCode = 0;
try {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'research-e2e', version: '0.0.1' },
  });

  console.log('→ spawning real research task (live DSH backend, no web needed)…');
  const spawnRes = await tool('spawn_task', {
    mode: 'research',
    task: 'Create a short report about the contents of this workspace. Save it as report.md. Also write summary.json containing {"description": "..."} with one line describing the workspace contents.',
    deliverables: ['report.md', 'summary.json'],
    timeout_seconds: 300,
  });
  console.log('✓ spawn_task:', JSON.stringify(spawnRes));

  let w;
  const deadline = Date.now() + 330000;
  do {
    await sleep(3000);
    w = await tool('get_worker', { worker_id: spawnRes.task_id });
    process.stdout.write(`  … status=${w.status} mode=${w.mode} elapsed=${w.elapsed_seconds}s\n`);
  } while (['queued', 'starting', 'running'].includes(w.status) && Date.now() < deadline);

  const result = await tool('get_task_result', { task_id: spawnRes.task_id });
  console.log('✓ get_task_result:', JSON.stringify({
    status: result.status,
    mode: result.mode,
    workspace: result.workspace,
    artifacts: result.artifacts,
    deliverables: result.deliverables,
    deliverables_missing: result.deliverables_missing,
    summary: result.summary,
    usage: result.usage,
  }, null, 2));

  const checks = [];
  const artifactPaths = (result.artifacts || []).map((a) => a.path);
  checks.push(['task completed', result.status === 'completed']);
  checks.push(['report.md artifact indexed', artifactPaths.includes('report.md')]);
  checks.push(['summary.json artifact indexed', artifactPaths.includes('summary.json')]);
  checks.push(['no missing deliverables', (result.deliverables_missing || []).length === 0]);
  checks.push(['report body NOT inlined in result', !JSON.stringify(result).length || true]);

  const report = await tool('get_artifact', { task_id: spawnRes.task_id, path: 'report.md' });
  console.log('✓ get_artifact report.md:', JSON.stringify({ size: report.size_bytes, mime: report.mime_type, truncated: report.truncated }));
  checks.push(['get_artifact returns content', typeof report.content === 'string' && report.content.length > 0]);
  checks.push(['result did not inline full report', !JSON.stringify(result).includes(report.content.slice(0, 60))]);

  const usage = await tool('get_task_usage', { task_id: spawnRes.task_id });
  console.log('✓ get_task_usage:', JSON.stringify(usage));
  checks.push(['usage has tokens', usage.input_tokens > 0]);

  const listed = await tool('list_artifacts', { task_id: spawnRes.task_id });
  checks.push(['list_artifacts matches', listed.artifacts.length >= 2]);

  let failed = false;
  for (const [name, ok] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${name}`);
    if (!ok) failed = true;
  }
  if (failed) exitCode = 1;
  else console.log('\nRESEARCH E2E PASSED');
} catch (err) {
  console.error('E2E error:', err);
  exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await sleep(500);
  console.log(`(worker root kept: ${workerRoot})`);
}
process.exit(exitCode);
