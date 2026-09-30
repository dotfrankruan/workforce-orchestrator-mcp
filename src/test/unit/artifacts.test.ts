import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  guessMimeType,
  sha256File,
  validateRelativePath,
  resolveUnderRoot,
  walkArtifacts,
  isProbablyBinary,
} from '../../artifacts.js';
import { makeTempDir, removeDir } from '../helpers.js';

test('guessMimeType covers common types', () => {
  assert.equal(guessMimeType('report.md'), 'text/markdown');
  assert.equal(guessMimeType('data.csv'), 'text/csv');
  assert.equal(guessMimeType('sources.json'), 'application/json');
  assert.equal(guessMimeType('analysis.py'), 'text/x-python');
  assert.equal(guessMimeType('image.PNG'), 'image/png');
  assert.equal(guessMimeType('archive.xyz'), 'application/octet-stream');
});

test('sha256File hashes content', () => {
  const dir = makeTempDir('kwm-art-');
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, 'hello');
  assert.equal(
    sha256File(f),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
  removeDir(dir);
});

test('validateRelativePath rejects traversal and absolutes', () => {
  assert.equal(validateRelativePath('report.md'), 'report.md');
  assert.equal(validateRelativePath('sub/dir/file.txt'), path.join('sub', 'dir', 'file.txt'));
  assert.equal(validateRelativePath('./ok.md'), 'ok.md');
  for (const bad of ['../escape', 'sub/../../escape', '/etc/passwd', '', 'a\0b']) {
    assert.throws(() => validateRelativePath(bad), JSON.stringify(bad));
  }
});

test('resolveUnderRoot stays inside root', () => {
  const root = '/tmp/some-root';
  assert.equal(resolveUnderRoot(root, 'a/b.txt'), path.join('/tmp/some-root', 'a', 'b.txt'));
  assert.throws(() => resolveUnderRoot(root, '..'));
});

test('walkArtifacts respects minMtime and skips .git / node_modules', () => {
  const dir = makeTempDir('kwm-art-');
  fs.writeFileSync(path.join(dir, 'old.txt'), 'old');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'ignored'), 'x');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'ignored.js'), 'x');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'deep.md'), 'x');

  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(dir, 'old.txt'), past, past);

  const all = walkArtifacts(dir, {});
  const names = all.map((f) => f.relativePath).sort();
  assert.deepEqual(names, ['new.txt', 'old.txt', 'sub/deep.md']);

  const recent = walkArtifacts(dir, { minMtimeMs: Date.now() - 60_000 });
  assert.deepEqual(recent.map((f) => f.relativePath).sort(), ['new.txt', 'sub/deep.md']);

  const only = walkArtifacts(dir, { onlyPaths: ['old.txt', 'missing.txt'] });
  assert.deepEqual(only.map((f) => f.relativePath), ['old.txt']);

  removeDir(dir);
});

test('isProbablyBinary detects NUL bytes', () => {
  const dir = makeTempDir('kwm-art-');
  const text = path.join(dir, 't.txt');
  const bin = path.join(dir, 'b.bin');
  fs.writeFileSync(text, 'plain text');
  fs.writeFileSync(bin, Buffer.from([0x89, 0x00, 0x50, 0x4e, 0x47]));
  assert.equal(isProbablyBinary(text), false);
  assert.equal(isProbablyBinary(bin), true);
  removeDir(dir);
});
