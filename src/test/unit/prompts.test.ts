import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModePrompt } from '../../prompts/index.js';
import { TASK_MODES } from '../../modes.js';
import { buildWorkerPrompt } from '../../prompt.js';

const ctx = {
  task: 'do something useful',
  deliverables: ['report.md', 'sources.json'],
  capabilities: ['web.search', 'shell'],
  workspaceDescription: 'Workspace: a fresh temporary directory at /tmp/x.',
};

test('every mode produces a prompt containing the task and deliverables', () => {
  for (const mode of TASK_MODES) {
    const p = buildModePrompt(mode, ctx);
    assert.ok(p.includes('do something useful'), mode);
    assert.ok(p.includes('<TASK>'), mode);
    assert.ok(p.includes('report.md'), mode);
    assert.ok(p.includes('sources.json'), mode);
    assert.ok(p.includes('web.search'), mode);
    assert.ok(p.includes('/tmp/x'), mode);
  }
});

test('mode-specific guidance is present', () => {
  assert.ok(buildModePrompt('research', ctx).includes('sources.json'));
  assert.ok(/read-only/i.test(buildModePrompt('review', ctx)));
  assert.ok(/no sudo/i.test(buildModePrompt('ops', ctx)));
  assert.ok(/do not delete/i.test(buildModePrompt('file', ctx)));
  assert.ok(buildModePrompt('code', ctx).includes('commit'));
  assert.ok(buildModePrompt('data', ctx).includes('read-only'));
});

test('prompts omit deliverables block when none declared', () => {
  const p = buildModePrompt('general', { ...ctx, deliverables: [] });
  assert.ok(!p.includes('You must produce the following deliverables'));
  assert.ok(p.includes('do something useful'));
});

test('legacy buildWorkerPrompt keeps working (code mode)', () => {
  const p = buildWorkerPrompt('legacy task text');
  assert.ok(p.includes('legacy task text'));
  assert.ok(p.includes('isolated git worktree'));
});

test('subagent note only injected when provided', () => {
  const withNote = buildModePrompt('research', { ...ctx, subagentsNote: 'You may delegate to subagents.' });
  assert.ok(withNote.includes('You may delegate to subagents.'));
  const without = buildModePrompt('research', ctx);
  assert.ok(!without.includes('delegate to subagents'));
});
