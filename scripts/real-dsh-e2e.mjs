// Real end-to-end test: spawn a worker backed by the real /usr/local/bin/dsh
// (Kimi K3) in a temporary git repo, wait for completion, print the compact
// result and verify continue_worker resumes the session.
// Usage: node scripts/real-dsh-e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kwm-real-repo-'));
const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kwm-real-root-'));

const git = (args, cwd = repoPath) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'e2e']);
git(['config', 'user.email', 'e2e@example.com']);
git(['config', 'commit.gpgsign', 'false']);
fs.writeFileSync(path.join(repoPath, 'README.md'), '# e2e test repo\n');
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
    clientInfo: { name: 'real-e2e', version: '0.0.1' },
  });

  console.log('→ spawning real Kimi worker (this calls the live API)…');
  const spawnRes = await tool('spawn_worker', {
    repo_path: repoPath,
    task: 'Change README.md title from "# e2e test repo" to "# e2e test repo (updated)". Verify the file contents afterwards. Do NOT create any git commit.',
    timeout_seconds: 300,
  });
  console.log('✓ spawn_worker:', JSON.stringify(spawnRes));

  let w;
  const deadline = Date.now() + 330000;
  do {
    await sleep(3000);
    w = await tool('get_worker', { worker_id: spawnRes.worker_id });
    process.stdout.write(`  … status=${w.status} elapsed=${w.elapsed_seconds}s usage(in=${w.usage.input_tokens},out=${w.usage.output_tokens},cache=${w.usage.cache_read_tokens})\n`);
  } while (['queued', 'starting', 'running'].includes(w.status) && Date.now() < deadline);

  console.log('✓ final status:', w.status, '| session:', w.session_id);
  const result = await tool('get_worker_result', { worker_id: spawnRes.worker_id });
  console.log('✓ result:', JSON.stringify({
    status: result.status,
    changed_files: result.changed_files,
    commit_hash: result.commit_hash,
    commit_subject: result.commit_subject,
    summary: result.summary,
    tests: result.tests,
    usage: result.usage,
  }, null, 2));

  const checks = [];
  checks.push(['worker completed', result.status === 'completed']);
  checks.push(['session id recorded', Boolean(result.session_id)]);
  checks.push(['commit recorded', Boolean(result.commit_hash)]);
  checks.push(['README.md changed', (result.changed_files || []).includes('README.md')]);
  checks.push(['supervisor created the commit', result.git && result.git.commit_created_by === 'supervisor']);
  checks.push(['worktree clean after supervisor commit', result.git && result.git.working_tree_clean === true]);
  checks.push(['main repo untouched', git(['rev-parse', 'HEAD']).trim() === mainHeadBefore]);
  checks.push(['worktree has updated file', fs.readFileSync(path.join(result.worktree, 'README.md'), 'utf8').includes('(updated)')]);

  // continue_worker: resume the same session with a tiny follow-up.
  console.log('→ testing continue_worker (session resume)…');
  await tool('continue_worker', {
    worker_id: spawnRes.worker_id,
    instruction: 'Also create a file goodbye.txt containing exactly "goodbye". Do NOT create any git commit.',
  });
  let w2;
  const deadline2 = Date.now() + 330000;
  do {
    await sleep(3000);
    w2 = await tool('get_worker', { worker_id: spawnRes.worker_id });
    process.stdout.write(`  … status=${w2.status} elapsed=${w2.elapsed_seconds}s\n`);
  } while (['queued', 'starting', 'running'].includes(w2.status) && Date.now() < deadline2);

  const result2 = await tool('get_worker_result', { worker_id: spawnRes.worker_id });
  checks.push(['continue completed', result2.status === 'completed']);
  checks.push(['same session kept', result2.session_id === result.session_id]);
  checks.push(['continue_count=1', result2.continue_count === 1]);
  checks.push(['follow-up applied', fs.existsSync(path.join(result.worktree, 'goodbye.txt'))]);
  checks.push(['second commit by supervisor', result2.git && result2.git.commit_count === 2]);

  let failed = false;
  for (const [name, ok] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${name}`);
    if (!ok) failed = true;
  }
  if (failed) exitCode = 1;
  else console.log('\nREAL DSH E2E PASSED');
} catch (err) {
  console.error('E2E error:', err);
  exitCode = 1;
} finally {
  server.kill('SIGTERM');
  await sleep(500);
  console.log(`(artifacts kept for inspection: repo=${repoPath} root=${workerRoot})`);
}
process.exit(exitCode);
