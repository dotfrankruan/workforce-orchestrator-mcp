import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Config } from '../config.js';
import { DshBackend } from './dsh.js';
import type { WorkerBackend } from './types.js';

/* ------------------------------------------------------------------ *
 * Backend registry + router.
 *
 * Resolution precedence (first hit wins):
 *   1. explicit task/workflow backend
 *   2. role routing rule (config file)
 *   3. routing default (config file)
 *   4. environment override (WORKFORCE_DEFAULT_BACKEND)
 *   5. built-in default: dsh
 *
 * Zero-config guarantee: with no config file and no env vars, everything
 * resolves to the built-in DSH backend — exactly the pre-v5 behavior.
 * ------------------------------------------------------------------ */

export interface WorkforceFileConfig {
  default_backend?: string;
  backends?: {
    dsh?: { command?: string; profile?: string };
  };
  routing?: {
    default?: string;
    roles?: Record<string, string>;
  };
}

const CONFIG_PATH = path.join(os.homedir(), '.workforce', 'config.json');

/** Optional user config. Absent file = built-in defaults. Never required. */
export function loadFileConfig(configPath?: string): WorkforceFileConfig | null {
  const p = configPath ?? CONFIG_PATH;
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

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(cmd: string): string | null {
  try {
    const out = execFileSync('/usr/bin/which', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return out && isExecutable(out) ? out : null;
  } catch {
    return null;
  }
}

export interface ResolvedDshExecutable {
  command: string | null;
  source: 'config' | 'env' | 'env-legacy' | 'builtin-path' | 'path' | 'none';
}

/**
 * Resolve the dsh executable without any required configuration:
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
  if (env.KIMI_WORKER_DSH_BIN) return { command: env.KIMI_WORKER_DSH_BIN, source: 'env-legacy' };

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
    this.defaultBackendId =
      fc?.routing?.default ?? fc?.default_backend ?? env.WORKFORCE_DEFAULT_BACKEND ?? defaultBackend.id;
    this.routingRoles = { ...(fc?.routing?.roles ?? {}) };

    if (!this.backends.has(this.defaultBackendId)) {
      throw new Error(
        `default backend ${JSON.stringify(this.defaultBackendId)} is not registered (available: ${[...this.backends.keys()].join(', ')})`,
      );
    }
    for (const [role, id] of Object.entries(this.routingRoles)) {
      if (!this.backends.has(id)) {
        throw new Error(`routing role ${JSON.stringify(role)} points at unknown backend ${JSON.stringify(id)}`);
      }
    }
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
          'Default backend "dsh" is unavailable: could not find /usr/local/bin/dsh or dsh in PATH. ' +
            'Install DeepSeek Harness or set WORKFORCE_DSH_COMMAND.',
        );
      }
      throw new Error(`backend "${backend.id}" is not available`);
    }
    return backend;
  }
}

/** Build the production registry with the zero-config DSH default. */
export function createDefaultRegistry(
  config: Config,
  opts: { extraBackends?: WorkerBackend[] | undefined; env?: NodeJS.ProcessEnv | undefined; configPath?: string | undefined } = {},
): BackendRegistry {
  const fileConfig = loadFileConfig(opts.configPath);
  const exe = resolveDshExecutable(config, fileConfig);
  const profile =
    fileConfig?.backends?.dsh?.profile ?? opts.env?.WORKFORCE_DSH_PROFILE ?? process.env.WORKFORCE_DSH_PROFILE ?? config.dshProfile;
  const dsh = new DshBackend({ dshBin: exe.command ?? '/usr/local/bin/dsh', profile });
  return new BackendRegistry(dsh, { extraBackends: opts.extraBackends, fileConfig, env: opts.env });
}
