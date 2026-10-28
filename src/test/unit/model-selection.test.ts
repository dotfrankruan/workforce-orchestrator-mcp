import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModelPatch, parseDshDumpConfig } from '../../backends/dsh.js';
import { computeCacheKey } from '../../cache.js';

const DUMP_FIXTURE = `# == @deepseek-ai/dsh-base
- id: agent
  name: '@deepseek-ai/dsh-agent'
# == @deepseek-ai/dsh-base, patched by /Users/x/.dsh/profiles/headless/cordis.patch.yml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: kimi-coding
    model: k3
    reasoningEffort: max
# == @deepseek-ai/dsh-base
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      kimi-coding:
        models:
          - id: k3
            name: K3
          - id: k3-256k
            name: Kimi K3-256K
            contextWindow: 262144
            maxTokens: 131072
            input:
              - text
              - image
          - id: kimi-for-coding
            name: Kimi K2.7 Code
        apiKeyEnv: KIMI_CODING_API_KEY
      other-provider:
        models:
          - id: model-x
# == @deepseek-ai/dsh-base
- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'
`;

test('parseDshDumpConfig: discovers models + default selection from dsh --dump-config', () => {
  const parsed = parseDshDumpConfig(DUMP_FIXTURE);
  assert.ok(parsed);
  assert.deepEqual(parsed!.models, [
    { provider: 'kimi-coding', id: 'k3', name: 'K3' },
    { provider: 'kimi-coding', id: 'k3-256k', name: 'Kimi K3-256K' },
    { provider: 'kimi-coding', id: 'kimi-for-coding', name: 'Kimi K2.7 Code' },
    { provider: 'other-provider', id: 'model-x' },
  ]);
  assert.equal(parsed!.default.provider, 'kimi-coding');
  assert.equal(parsed!.default.model, 'k3');
  assert.equal(parsed!.default.reasoningEffort, 'max');
});

test('parseDshDumpConfig: degraded input is unknown, not invented', () => {
  assert.equal(parseDshDumpConfig(''), null);
  assert.equal(parseDshDumpConfig('not: [valid entry list'), null);
  const noModel = parseDshDumpConfig('- id: agent\n  name: x\n');
  assert.equal(noModel, null);
});

test('buildModelPatch: complete agent-default-model replacement, quoted when needed', () => {
  const plain = buildModelPatch({ provider: 'kimi-coding', model: 'k3-256k', reasoningEffort: 'max' });
  assert.match(plain, /- id: agent-default-model/);
  assert.match(plain, /^ {4}provider: kimi-coding$/m);
  assert.match(plain, /^ {4}model: k3-256k$/m);
  assert.match(plain, /^ {4}reasoningEffort: max$/m);

  const quoted = buildModelPatch({ provider: 'p', model: 'weird model/id' });
  assert.ok(quoted.includes('model: "weird model/id"'), 'non-plain scalars are JSON-quoted for YAML safety');
  assert.ok(!quoted.includes('reasoningEffort'), 'omitted when unknown');
});

test('cache keys isolate models (same task/backend, different model)', () => {
  const base = { mode: 'code', role: null, roleFragment: null, task: 't', fingerprint: 'fp', backendId: 'dsh' };
  const k1 = computeCacheKey({ ...base, model: 'k3' });
  const k2 = computeCacheKey({ ...base, model: 'k3-256k' });
  const k3 = computeCacheKey({ ...base, model: null });
  assert.notEqual(k1, k2);
  assert.notEqual(k1, k3);
});
