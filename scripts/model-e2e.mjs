// Real-DSH model selection E2E (v5.1):
//   1. list_models discovers real models from the dsh profile config
//   2. spawn_task({ model }) actually runs on that model (patch overlay)
//   3. invalid model surfaces the runtime's UNKNOWN_MODEL error
// Uses the zero-config default backend (dsh, headless profile).
// Usage: node scripts/model-e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kwm-model-repo-'));
const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kwm-model-root-'));
const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kwm-model-cfg-')), 'config.json');
const git = (args, cwd = repoPath) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'e2e']);
git(['config', 'user.email', 'e2e@example.com']);
git(['config', 'commit.gpgsign', 'false']);
fs.writeFileSync(path.join(repoPath, 'README.md'), 'model e2e\n');
git(['add', '-A']);
git(['commit', '-qm', 'init']);
const mainHead = git(['rev-parse', 'HEAD']).trim();

const env = { ...process.env, WORKFORCE_ROOT: workerRoot, WORKFORCE_CONFIG: configPath };

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
  const tool = (name, args) =>
    request('tools/call', { name, arguments: args ?? {} }).then((r) => {
      const text = r.result?.content?.[0]?.text;
      if (r.result?.isError) throw new Error(`${name}: ${text}`);
      return text ? JSON.parse(text) : r.result;
    });
  return { srv, request, tool };
}

const checks = [];
const check = (name, ok, extra) => {
  checks.push([name, ok]);
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
};

let server = null;
let exitCode = 0;
try {
  server = startServer();
  await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'model-e2e', version: '1' } });

  console.log('→ discovering models');
  const models = await server.tool('list_models');
  const ids = (models.models || []).map((m) => m.id);
  check('list_models returns dsh catalog', ids.length > 0, ids.join(', '));
  check('catalog includes k3-256k', ids.includes('k3-256k'));
  check('default reported', models.default?.model === 'k3', JSON.stringify(models.default));
  check('model_selection capability', models.model_selection === true);

  console.log('→ running real task on model k3-256k');
  const spawned = await server.tool('spawn_task', {
    mode: 'code',
    workspace: { type: 'git_worktree', repo_path: repoPath },
    model: 'k3-256k',
    timeout_seconds: 240,
    task: 'Create a file model-check.txt containing exactly the text: k3-256k. Do not commit.',
  });
  check('spawn reports model', spawned.model === 'k3-256k');

  const done = await server.tool('wait_task', { task_id: spawned.task_id, timeout_seconds: 300 });
  const result = await server.tool('get_task_result', { task_id: spawned.task_id });
  check('task completed on selected model', done.status === 'completed', `status=${done.status}`);
  check('result records model', result.model === 'k3-256k');
  check('patch overlay recorded provider', result.backend_metadata?.provider?.model === 'k3-256k', JSON.stringify(result.backend_metadata?.provider));
  check('supervisor committed the change', result.git?.commit_created_by === 'supervisor');
  check('main untouched', git(['rev-parse', 'HEAD']).trim() === mainHead);

  // log_dir varies by workspace kind: <root>/tasks/<id> (temporary/directory)
  // or <root>/<repoSlug>/<id> (git worktrees).
  const walk = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(full));
      else out.push(full);
    }
    return out;
  };
  const allFiles = walk(workerRoot);
  const foundPath = allFiles.find((f) => f.endsWith('/dsh-model.yml'));
  const patchPath = foundPath ?? null;
  if (!patchPath) console.log('  debug: files under workerRoot:', allFiles.slice(0, 40).join(', '));
  check('durable patch overlay on disk', patchPath !== null, patchPath ?? '(missing)');
  if (patchPath) {
    const patch = fs.readFileSync(patchPath, 'utf8');
    check('patch pins provider+model', /model: k3-256k/.test(patch) && /provider: kimi-coding|provider: \S+/.test(patch));
  }

  console.log('→ invalid model surfaces the runtime error');
  const bad = await server.tool('spawn_task', {
    mode: 'general',
    model: 'definitely-not-a-model',
    timeout_seconds: 60,
    task: 'reply with ok',
  });
  const badDone = await server.tool('wait_task', { task_id: bad.task_id, timeout_seconds: 120 });
  const badResult = await server.tool('get_task_result', { task_id: bad.task_id });
  check('invalid model fails the task', badDone.status === 'failed', `status=${badDone.status}`);
  check('error surfaces UNKNOWN_MODEL', /UNKNOWN_MODEL|no configured model/.test(badResult.error ?? ''), (badResult.error ?? '').slice(0, 120));

  const okAll = checks.every(([, ok]) => ok);
  console.log(okAll ? '\nMODEL SELECTION E2E PASSED' : '\nMODEL SELECTION E2E FAILED');
  if (!okAll) exitCode = 1;
} catch (err) {
  console.error('E2E error:', err);
  exitCode = 1;
} finally {
  try { server?.srv.kill('SIGKILL'); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  for (const p of [repoPath, workerRoot, path.dirname(configPath)]) fs.rmSync(p, { recursive: true, force: true });
}
process.exit(exitCode);
