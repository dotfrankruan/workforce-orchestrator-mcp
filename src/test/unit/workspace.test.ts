import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  planWorkspace,
  prepareWorkspace,
  resolveModeAndWorkspace,
  isWorkspaceType,
} from '../../workspace.js';
import { makeTempDir, makeTempRepo, removeDir, git } from '../helpers.js';

const ctx = (root: string, id = 'wk_test0001') => ({ workerRoot: root, workerId: id });

test('resolveModeAndWorkspace defaults', () => {
  assert.deepEqual(resolveModeAndWorkspace(undefined, undefined), { mode: 'general', type: 'temporary' });
  assert.deepEqual(resolveModeAndWorkspace(undefined, {}), { mode: 'general', type: 'temporary' });
  assert.deepEqual(resolveModeAndWorkspace('code', { repo_path: '/x' }), { mode: 'code', type: 'git_worktree' });
  assert.deepEqual(resolveModeAndWorkspace(undefined, { repo_path: '/x' }), { mode: 'code', type: 'git_worktree' });
  assert.deepEqual(resolveModeAndWorkspace('research', { repo_path: '/x' }), { mode: 'research', type: 'temporary' });
  assert.deepEqual(resolveModeAndWorkspace('data', { path: '/data' }), { mode: 'data', type: 'directory' });
  assert.deepEqual(resolveModeAndWorkspace('general', { type: 'directory', path: '/d' }), { mode: 'general', type: 'directory' });
});

test('temporary workspace is created under the worker root', () => {
  const root = makeTempDir('kwm-ws-');
  const plan = planWorkspace('temporary', {}, ctx(root));
  assert.equal(plan.type, 'temporary');
  assert.ok(plan.cwd.startsWith(path.resolve(root) + path.sep));
  assert.ok(plan.artifactRoot === plan.cwd);
  prepareWorkspace(plan);
  assert.ok(fs.statSync(plan.cwd).isDirectory());
  assert.ok(fs.statSync(plan.logDir).isDirectory());
  removeDir(root);
});

test('directory workspace canonicalizes and validates', () => {
  const root = makeTempDir('kwm-ws-');
  const target = makeTempDir('kwm-dir-');
  // Resolve macOS /var → /private/var symlink difference.
  const canonical = fs.realpathSync(target);

  const plan = planWorkspace('directory', { path: target + '/.' }, ctx(root));
  assert.equal(plan.cwd, canonical);
  assert.equal(plan.artifactRoot, canonical);
  // Logs stay in the worker root, not in the user's directory.
  assert.ok(plan.logDir.startsWith(path.resolve(root) + path.sep));
  prepareWorkspace(plan); // no-op, must not throw

  assert.throws(() => planWorkspace('directory', {}, ctx(root)), /path is required/);
  assert.throws(() => planWorkspace('directory', { path: path.join(target, 'nope') }, ctx(root)), /does not exist/);
  assert.throws(() => planWorkspace('directory', { path: '/' }, ctx(root)), /filesystem root/);
  const file = path.join(target, 'afile');
  fs.writeFileSync(file, 'x');
  assert.throws(() => planWorkspace('directory', { path: file }, ctx(root)), /not a directory/);

  removeDir(root);
  removeDir(target);
});

test('directory workspace follows symlinks to their real target', () => {
  const root = makeTempDir('kwm-ws-');
  const target = makeTempDir('kwm-dir-');
  const link = path.join(os.tmpdir(), `kwm-link-${process.pid}`);
  fs.symlinkSync(fs.realpathSync(target), link);
  try {
    const plan = planWorkspace('directory', { path: link }, ctx(root));
    assert.equal(plan.cwd, fs.realpathSync(target), 'symlink resolved to canonical target');
  } finally {
    fs.rmSync(link, { force: true });
    removeDir(root);
    removeDir(target);
  }
});

test('git_worktree workspace plans branch and creates worktree', () => {
  const root = makeTempDir('kwm-ws-');
  const repo = makeTempRepo();
  const base = git(['rev-parse', 'HEAD'], repo).trim();

  const plan = planWorkspace('git_worktree', { repo_path: repo }, ctx(root));
  assert.equal(plan.repoPath, fs.realpathSync(repo));
  assert.equal(plan.baseRef, base);
  assert.equal(plan.branch, 'kimi-worker/wk_test0001');
  prepareWorkspace(plan);
  assert.ok(fs.existsSync(path.join(plan.cwd, 'hello.txt')));

  // Missing repo path rejected.
  assert.throws(() => planWorkspace('git_worktree', {}, ctx(root)), /repo_path is required/);
  assert.throws(() => planWorkspace('git_worktree', { repo_path: '/nonexistent-xyz' }, ctx(root)));

  removeDir(root);
  removeDir(repo);
});

test('invalid workspace type rejected by isWorkspaceType', () => {
  assert.equal(isWorkspaceType('nonsense'), false);
  assert.equal(isWorkspaceType('git_worktree'), true);
  assert.equal(isWorkspaceType('directory'), true);
  assert.equal(isWorkspaceType('temporary'), true);
});
