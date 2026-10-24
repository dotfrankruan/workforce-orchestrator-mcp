import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OpenCodeBackend, parseOpenCodeLine } from '../../backends/opencode.js';
import { OpenAIBackend } from '../../backends/openai.js';
import { AnthropicBackend } from '../../backends/anthropic.js';
import { BackendRegistry, createDefaultRegistry } from '../../backends/registry.js';
import { FakeBackend, FakeScenarios } from '../../backends/fake.js';
import { loadConfig } from '../../config.js';
import type { DshEvent } from '../../parser.js';
import { makeTempDir, removeDir } from '../helpers.js';

type Json = Record<string, unknown>;

function tmpFiles(): { root: string; cwd: string; stdoutPath: string; stderrPath: string } {
  const root = makeTempDir('kwm-provider-');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  return {
    root,
    cwd,
    stdoutPath: path.join(root, 'stdout.jsonl'),
    stderrPath: path.join(root, 'stderr.log'),
  };
}

test('opencode parser maps text/tool/usage/error events and canonical finals', () => {
  const sessionID = 'ses_test';
  const text = parseOpenCodeLine(
    JSON.stringify({ type: 'text', sessionID, part: { type: 'text', text: 'hello' } }),
  );
  assert.equal(text?.type, 'text');
  assert.equal(text?.text, 'hello');

  const tool = parseOpenCodeLine(
    JSON.stringify({
      type: 'tool_use',
      sessionID,
      part: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed' } },
    }),
  );
  assert.equal(tool?.type, 'tool_call');
  assert.equal(tool?.tool, 'bash');
  assert.equal(tool?.callId, 'c1');

  const finish = parseOpenCodeLine(
    JSON.stringify({
      type: 'step_finish',
      sessionID,
      part: { type: 'step-finish', tokens: { input: 10, output: 5, cache: { read: 3 } } },
    }),
  );
  assert.equal(finish?.type, 'status');
  assert.equal(finish?.usage?.inputTokens, 10);
  assert.equal(finish?.usage?.cacheReadTokens, 3);

  const err = parseOpenCodeLine(
    JSON.stringify({ type: 'error', sessionID, error: { name: 'APIError', data: { message: 'boom' } } }),
  );
  assert.equal(err?.type, 'error');
  assert.equal(err?.message, 'boom');

  const canonical = parseOpenCodeLine(JSON.stringify({ type: 'final', text: 'done' }));
  assert.equal(canonical?.type, 'final');
  assert.equal(canonical?.text, 'done');

  assert.equal(parseOpenCodeLine('not json'), null);
});

test('openai backend runs a tool loop against the Chat Completions API', async () => {
  const f = tmpFiles();
  try {
    const requests: Json[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Json;
      requests.push(body);
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'write_file', arguments: JSON.stringify({ path: 'out.txt', content: 'hi\n' }) },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Done.' } }],
          usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const backend = new OpenAIBackend({
      apiKey: 'test-key',
      baseUrl: 'http://example.invalid/v1',
      model: 'test-model',
      fetchImpl,
    });
    const events: DshEvent[] = [];
    const code = await new Promise<number | null>((resolve) => {
      backend.start(
        { workerId: 'wk_test0001', cwd: f.cwd, prompt: 'write out.txt', sessionId: null, stdoutPath: f.stdoutPath, stderrPath: f.stderrPath },
        { onEvent: (ev) => events.push(ev), onExit: (c) => resolve(c) },
      );
    });

    assert.equal(code, 0);
    assert.equal(fs.readFileSync(path.join(f.cwd, 'out.txt'), 'utf8'), 'hi\n');
    assert.ok(events.some((e) => e.type === 'tool_call' && e.tool === 'write_file'));
    assert.ok(events.some((e) => e.type === 'final' && e.text === 'Done.'));
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.['model'], 'test-model');
    const messages = requests[1]?.['messages'] as Json[];
    assert.equal(messages.some((m) => m['role'] === 'tool'), true);
  } finally {
    removeDir(f.root);
  }
});

test('anthropic backend runs a tool loop against the Messages API', async () => {
  const f = tmpFiles();
  try {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            content: [
              { type: 'text', text: 'working' },
              { type: 'tool_use', id: 'tu_1', name: 'write_file', input: { path: 'note.md', content: 'ok\n' } },
            ],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'Finished.' }],
          usage: { input_tokens: 15, output_tokens: 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const backend = new AnthropicBackend({
      apiKey: 'test-key',
      baseUrl: 'http://example.invalid',
      model: 'test-model',
      fetchImpl,
    });
    const events: DshEvent[] = [];
    const code = await new Promise<number | null>((resolve) => {
      backend.start(
        { workerId: 'wk_test0002', cwd: f.cwd, prompt: 'write note', sessionId: null, stdoutPath: f.stdoutPath, stderrPath: f.stderrPath },
        { onEvent: (ev) => events.push(ev), onExit: (c) => resolve(c) },
      );
    });

    assert.equal(code, 0);
    assert.equal(fs.readFileSync(path.join(f.cwd, 'note.md'), 'utf8'), 'ok\n');
    assert.ok(events.some((e) => e.type === 'tool_call' && e.tool === 'write_file'));
    assert.ok(events.some((e) => e.type === 'final' && e.text === 'Finished.'));
    assert.equal(calls, 2);
  } finally {
    removeDir(f.root);
  }
});

test('registry registers all backends and honors an explicit default', () => {
  const root = makeTempDir('kwm-reg-');
  try {
    const config = loadConfig({ env: {}, workerRoot: root });
    const registry = createDefaultRegistry(config, {
      env: {
        WORKFORCE_DEFAULT_BACKEND: 'openai',
        WORKFORCE_OPENAI_API_KEY: 'test-key',
      },
      configPath: path.join(root, 'missing.json'),
    });
    assert.equal(registry.defaultBackendId, 'openai');
    assert.ok(registry.has('dsh'));
    assert.ok(registry.has('opencode'));
    assert.ok(registry.has('openai'));
    assert.ok(registry.has('anthropic'));
    assert.equal(registry.resolveAvailable({}).id, 'openai');
  } finally {
    removeDir(root);
  }
});

test('explicit fake-only registry keeps auto default behavior', () => {
  const a = new FakeBackend({ scenario: () => FakeScenarios.success() }, 'fake-a');
  const registry = new BackendRegistry(a);
  assert.equal(registry.defaultBackendId, 'fake-a');
});

test('opencode availability follows the configured executable', () => {
  assert.equal(new OpenCodeBackend({ command: '/definitely/not/opencode' }).isAvailable(), false);
});
