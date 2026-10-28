import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { packageVersion } from '../../version.js';

test('packageVersion is the single source of truth for the MCP identity', () => {
  const pkg = JSON.parse(
    fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  assert.equal(packageVersion(), pkg.version);
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
  // Release line: v5 ≠ npm-style 0.x — the package must track the latest tag.
  assert.ok(!packageVersion().startsWith('0.'), 'package version must follow the release line (v5.x)');
});
