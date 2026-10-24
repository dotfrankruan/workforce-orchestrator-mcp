import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config.js';
import { DshBackend } from './dsh.js';
import { OpenCodeBackend } from './opencode.js';
import { OpenAIBackend, type OpenAIApiStyle } from './openai.js';
import { AnthropicBackend } from './anthropic.js';
import { FakeBackend, FakeScenarios } from './fake.js';
import { isExecutable, which } from '../util/executable.js';
import type { WorkerBackend } from './types.js';

/* ------------------------------------------------------------------ *
 * Backend registry + router.
 *
 * Resolution precedence (first hit wins):
 *   1. explicit task/workflow backend
 *   2. role routing rule (config file)
 *   3. routing default (config file)
 *   4. default_backend (config file)
 *   5. WORKFORCE_DEFAULT_BACKEND env var
 *   6. WORKFORCE_BACKEND env var / config.backend (unless "auto")
 *   7. first locally available backend in dsh → opencode → openai → anthropic
 *   8. "dsh" (so the error message names a concrete runtime)
 *
 * Nothing is ever auto-installed; unavailable backends fail explicitly.
 * ------------------------------------------------------------------ */

export interface DshFileConfig {
  command?: string;
  profile?: string;
}

export interface OpenCodeFileConfig {
  command?: string;
  model?: string;
  agent?: string;
  auto_approve?: boolean;
  args?: string[];
}

export interface OpenAIFileConfig {
  api_key?: string;
  api_key_env?: string;
  base_url?: string;
  model?: string;
  api?: OpenAIApiStyle;
  max_output_tokens?: number;
  temperature?: number;
  max_iterations?: number;
}

export interface AnthropicFileConfig {
  api_key?: string;
  api_key_env?: string;
  base_url?: string;
  model?: string;
  api_version?: string;
  max_output_tokens?: number;
  temperature?: number;
  max_iterations?: number;
}

export interface WorkforceFileConfig {
  default_backend?: string;
  backends?: {
    dsh?: DshFileConfig;
    opencode?: OpenCodeFileConfig;
    openai?: OpenAIFileConfig;
    anthropic?: AnthropicFileConfig;
    /** Local test backend; no config required. */
    fake?: Record<string, never>;
  };
  routing?: {
    default?: string;
    roles?: Record<string, string>;
  };
}

/** Fixed, documented config location: ~/.workforce/config.json */
export function defaultConfigPath(): string {
  return path.join(os.homedir(), '.workforce', 'config.json');
}

/** Optional user config. Absent file = built-in defaults. Never required. */
export function loadFileConfig(configPath?: string): WorkforceFileConfig | null {
  const p = configPath ?? defaultConfigPath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('config must be a JSON object');
    }
    return parsed as WorkforceFileConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`invalid workforce config at ${p}: ${(err as Error).message}`);
  }
}

export interface ResolvedDshExecutable {
  command: string | null;
  source: 'config' | 'env' | 'builtin-path' | 'path' | 'none';
}

/**
 * Resolve the dsh executable without required configuration:
 * explicit config/env → /usr/local/bin/dsh → dsh on PATH → unavailable.
 */
export function resolveDshExecutable(
  config: Config,
  fileConfig: WorkforceFileConfig | null,
  deps: { isExecutable?: (p: string) => boolean; which?: (cmd: string) => string | null } = {},
): ResolvedDshExecutable {
  const exeExists = deps.isExecutable ?? isExecutable;
  const whichFn = deps.which ?? which;
  const fromFile = fileConfig?.backends?.dsh?.command;
  if (fromFile) return { command: fromFile, source: 'config' };

  const env = process.env;
  if (env.WORKFORCE_DSH_COMMAND) return { command: env.WORKFORCE_DSH_COMMAND, source: 'env' };

  // config.dshBin carries the env-aware default already; treat explicit
  // non-default values as configured.
  if (config.dshBin !== '/usr/local/bin/dsh') return { command: config.dshBin, source: 'config' };

  if (exeExists('/usr/local/bin/dsh')) return { command: '/usr/local/bin/dsh', source: 'builtin-path' };
  const onPath = whichFn('dsh');
  if (onPath) return { command: onPath, source: 'path' };
  return { command: null, source: 'none' };
}

export interface RouteInput {
  backend?: string | undefined;
  role?: string | null | undefined;
  mode?: string | undefined;
}

const AUTO_ORDER = ['dsh', 'opencode', 'openai', 'anthropic'] as const;

export class BackendRegistry {
  private backends = new Map<string, WorkerBackend>();
  readonly defaultBackendId: string;
  private routingRoles: Record<string, string>;

  constructor(
    defaultBackend: WorkerBackend,
    opts: { extraBackends?: WorkerBackend[] | undefined; fileConfig?: WorkforceFileConfig | null | undefined; env?: NodeJS.ProcessEnv | undefined } = {},
  ) {
    this.register(defaultBackend);
    for (const b of opts.extraBackends ?? []) this.register(b);

    const env = opts.env ?? process.env;
    const fc = opts.fileConfig ?? null;
    const explicit =
      fc?.routing?.default ??
      fc?.default_backend ??
      env.WORKFORCE_DEFAULT_BACKEND ??
      undefined;
    const id = explicit !== undefined && explicit !== '' && explicit !== 'auto'
      ? explicit
      : this.firstAvailable(explicit === 'auto' || explicit === undefined) ?? defaultBackend.id;
    this.defaultBackendId = id;
    this.routingRoles = { ...(fc?.routing?.roles ?? {}) };

    if (!this.backends.has(this.defaultBackendId)) {
      throw new Error(
        `default backend ${JSON.stringify(this.defaultBackendId)} is not registered (available: ${[...this.backends.keys()].join(', ')})`,
      );
    }
    for (const [role, id2] of Object.entries(this.routingRoles)) {
      if (!this.backends.has(id2)) {
        throw new Error(`routing role ${JSON.stringify(role)} points at unknown backend ${JSON.stringify(id2)}`);
      }
    }
  }

  private firstAvailable(allowAuto: boolean): string | null {
    if (!allowAuto) return null;
    for (const id of AUTO_ORDER) {
      const b = this.backends.get(id);
      if (b?.isAvailable()) return id;
    }
    return null;
  }

  register(backend: WorkerBackend): void {
    if (this.backends.has(backend.id)) {
      throw new Error(`duplicate backend id: ${backend.id}`);
    }
    this.backends.set(backend.id, backend);
  }

  has(id: string): boolean {
    return this.backends.has(id);
  }

  get(id: string): WorkerBackend {
    const b = this.backends.get(id);
    if (!b) {
      throw new Error(`unknown backend: ${JSON.stringify(id)} (registered: ${[...this.backends.keys()].join(', ')})`);
    }
    return b;
  }

  list(): WorkerBackend[] {
    return [...this.backends.values()];
  }

  /** Deterministic routing; never falls back to another backend implicitly. */
  resolve(input: RouteInput): WorkerBackend {
    const id = input.backend ?? (input.role ? this.routingRoles[input.role] : undefined) ?? this.defaultBackendId;
    const backend = this.get(id);
    return backend;
  }

  /**
   * Resolve AND verify availability. Throws a clear, actionable error when
   * the selected backend's runtime is unavailable.
   */
  resolveAvailable(input: RouteInput): WorkerBackend {
    const backend = this.resolve(input);
    if (!backend.isAvailable()) {
      if (backend.id === 'dsh') {
        throw new Error(
          'backend "dsh" is unavailable: could not find /usr/local/bin/dsh or dsh in PATH. ' +
            'Install DeepSeek Harness or set WORKFORCE_DSH_COMMAND (or choose another backend).',
        );
      }
      if (backend.id === 'opencode') {
        throw new Error(
          'backend "opencode" is unavailable: executable not found. Install OpenCode or set WORKFORCE_OPENCODE_COMMAND.',
        );
      }
      if (backend.id === 'openai') {
        throw new Error(
          'backend "openai" is unavailable: no API key. Set WORKFORCE_OPENAI_API_KEY (or OPENAI_API_KEY) and optionally WORKFORCE_OPENAI_MODEL.',
        );
      }
      if (backend.id === 'anthropic') {
        throw new Error(
          'backend "anthropic" is unavailable: no API key. Set WORKFORCE_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY) and optionally WORKFORCE_ANTHROPIC_MODEL.',
        );
      }
      throw new Error(`backend "${backend.id}" is not available`);
    }
    return backend;
  }
}

function pickEnv(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const n of names) {
    const v = env[n];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

function parseNum(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeOpenAiStyle(raw: string | undefined): OpenAIApiStyle {
  if (raw === 'responses' || raw === 'response') return 'responses';
  return 'chat_completions';
}

/** Build the production registry with dsh/opencode/openai/anthropic backends. */
export function createDefaultRegistry(
  config: Config,
  opts: { extraBackends?: WorkerBackend[] | undefined; env?: NodeJS.ProcessEnv | undefined; configPath?: string | undefined } = {},
): BackendRegistry {
  const env = opts.env ?? process.env;
  const fileConfig = loadFileConfig(opts.configPath);

  // dsh
  const exe = resolveDshExecutable(config, fileConfig);
  const profile =
    fileConfig?.backends?.dsh?.profile ?? env.WORKFORCE_DSH_PROFILE ?? config.dshProfile;
  const dsh = new DshBackend({ dshBin: exe.command ?? config.dshBin, profile });

  // OpenCode
  const oc = fileConfig?.backends?.opencode;
  const ocCommand = oc?.command ?? env.WORKFORCE_OPENCODE_COMMAND ?? 'opencode';
  const ocArgsRaw = env.WORKFORCE_OPENCODE_ARGS;
  const opencode = new OpenCodeBackend({
    command: ocCommand,
    model: oc?.model ?? env.WORKFORCE_OPENCODE_MODEL,
    agent: oc?.agent ?? env.WORKFORCE_OPENCODE_AGENT,
    autoApprove: oc?.auto_approve ?? env.WORKFORCE_OPENCODE_AUTO !== 'false',
    extraArgs: oc?.args ?? (ocArgsRaw ? ocArgsRaw.split(/\s+/).filter(Boolean) : []),
  });

  // OpenAI
  const oa = fileConfig?.backends?.openai;
  const oaKeyEnv = oa?.api_key_env;
  const oaKey = oa?.api_key ?? (oaKeyEnv ? env[oaKeyEnv] : undefined) ?? pickEnv(env, ['WORKFORCE_OPENAI_API_KEY', 'OPENAI_API_KEY']) ?? '';
  const oaBase = oa?.base_url ?? pickEnv(env, ['WORKFORCE_OPENAI_BASE_URL', 'OPENAI_BASE_URL']);
  const openai = new OpenAIBackend({
    apiKey: oaKey,
    baseUrl: oaBase ?? 'https://api.openai.com/v1',
    explicitBaseUrl: oaBase !== undefined,
    model: oa?.model ?? pickEnv(env, ['WORKFORCE_OPENAI_MODEL', 'OPENAI_MODEL']) ?? 'gpt-4.1',
    api: normalizeOpenAiStyle(oa?.api ?? pickEnv(env, ['WORKFORCE_OPENAI_API', 'OPENAI_API'])),
    maxOutputTokens: oa?.max_output_tokens ?? parseNum(env.WORKFORCE_OPENAI_MAX_OUTPUT_TOKENS),
    temperature: oa?.temperature ?? parseNum(env.WORKFORCE_OPENAI_TEMPERATURE),
    maxIterations: oa?.max_iterations ?? parseNum(env.WORKFORCE_OPENAI_MAX_ITERATIONS),
  });

  // Anthropic
  const an = fileConfig?.backends?.anthropic;
  const anKeyEnv = an?.api_key_env;
  const anKey = an?.api_key ?? (anKeyEnv ? env[anKeyEnv] : undefined) ?? pickEnv(env, ['WORKFORCE_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY']) ?? '';
  const anBase = an?.base_url ?? pickEnv(env, ['WORKFORCE_ANTHROPIC_BASE_URL', 'ANTHROPIC_BASE_URL']);
  const anthropic = new AnthropicBackend({
    apiKey: anKey,
    baseUrl: anBase ?? 'https://api.anthropic.com',
    explicitBaseUrl: anBase !== undefined,
    model: an?.model ?? pickEnv(env, ['WORKFORCE_ANTHROPIC_MODEL', 'ANTHROPIC_MODEL']) ?? 'claude-sonnet-4-5',
    apiVersion: an?.api_version ?? env.WORKFORCE_ANTHROPIC_VERSION,
    maxOutputTokens: an?.max_output_tokens ?? parseNum(env.WORKFORCE_ANTHROPIC_MAX_OUTPUT_TOKENS),
    temperature: an?.temperature ?? parseNum(env.WORKFORCE_ANTHROPIC_TEMPERATURE),
    maxIterations: an?.max_iterations ?? parseNum(env.WORKFORCE_ANTHROPIC_MAX_ITERATIONS),
  });

  // Explicit WORKFORCE_BACKEND (non-auto) participates in routing unless a
  // more specific config-file / env default is set.
  const hasExplicitDefault =
    fileConfig?.routing?.default !== undefined ||
    fileConfig?.default_backend !== undefined ||
    env.WORKFORCE_DEFAULT_BACKEND !== undefined;
  const effectiveFileConfig =
    config.backend !== 'auto' && !hasExplicitDefault
      ? { ...(fileConfig ?? {}), default_backend: config.backend }
      : fileConfig;

  const fake = new FakeBackend({ scenario: () => FakeScenarios.success() });

  return new BackendRegistry(dsh, {
    extraBackends: [opencode, openai, anthropic, fake, ...(opts.extraBackends ?? [])],
    fileConfig: effectiveFileConfig,
    env,
  });
}
