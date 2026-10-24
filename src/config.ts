import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Backend kind selected by environment/config.
 *
 * - `auto` (default): first available backend in the deterministic order
 *   dsh → opencode → openai → anthropic, then `dsh` as the documented fallback.
 * - explicit ids select one backend; availability is validated at spawn time.
 * - `fake` is a local test backend (no API calls).
 */
export type BackendKind = 'auto' | 'dsh' | 'opencode' | 'openai' | 'anthropic' | 'fake';

export interface Config {
  /** Path to the dsh binary. Never invoked through a shell. */
  dshBin: string;
  /** dsh profile to run (headless). */
  dshProfile: string;
  /** Root directory that contains all worker state (worktrees, logs, db). */
  workerRoot: string;
  /** SQLite database file. */
  dbPath: string;
  /** Maximum number of concurrently running workers. */
  maxConcurrent: number;
  /** Default per-worker timeout in seconds. */
  defaultTimeoutSeconds: number;
  /** Hard upper bound for a caller-provided timeout. */
  maxTimeoutSeconds: number;
  /** Worker backend implementation (auto = first locally available). */
  backend: BackendKind;
  /** Max bytes returned by get_worker_log. */
  logMaxBytes: number;
  /** Max bytes returned by get_worker_diff (full diff). */
  diffMaxBytes: number;
  /** Max chars of final report text kept in the compact result. */
  finalTextMaxChars: number;
  /** Grace period (ms) between SIGTERM and SIGKILL on cancel. */
  terminateGraceMs: number;
  /** Experimental: allow research/general workers to delegate to subagents. */
  enableSubagents: boolean;
  maxSubagentDepth: number;
  maxSubagentsPerTask: number;
}

const DEFAULTS = {
  dshBin: '/usr/local/bin/dsh',
  dshProfile: 'headless',
  maxConcurrent: 4,
  defaultTimeoutSeconds: 3600,
  maxTimeoutSeconds: 6 * 3600,
  backend: 'auto' as BackendKind,
  logMaxBytes: 32 * 1024,
  diffMaxBytes: 64 * 1024,
  finalTextMaxChars: 8000,
  terminateGraceMs: 5000,
  enableSubagents: false,
  maxSubagentDepth: 1,
  maxSubagentsPerTask: 3,
};

const BACKEND_KINDS: readonly BackendKind[] = ['auto', 'dsh', 'opencode', 'openai', 'anthropic', 'fake'];

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid value for ${name}: expected a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseBackend(raw: string | undefined): BackendKind {
  if (raw === undefined || raw === '') return DEFAULTS.backend;
  const normalized = raw.trim().toLowerCase();
  if ((BACKEND_KINDS as readonly string[]).includes(normalized)) return normalized as BackendKind;
  throw new Error(
    `Invalid WORKFORCE_BACKEND: ${JSON.stringify(raw)} (expected one of ${BACKEND_KINDS.join(', ')})`,
  );
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export interface ConfigOverrides {
  env?: NodeJS.ProcessEnv;
  workerRoot?: string;
}

/**
 * Build a Config from environment variables (with optional explicit overrides,
 * mainly for tests). Credentials for direct API backends are read by those
 * backends from the environment/config and are never printed.
 */
export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const env = overrides.env ?? process.env;

  const workerRootRaw =
    overrides.workerRoot ?? env.WORKFORCE_ROOT ?? path.join(os.homedir(), '.workforce', 'workers');
  const workerRoot = path.resolve(expandHome(workerRootRaw));

  const dbPath = path.resolve(expandHome(env.WORKFORCE_DB ?? path.join(workerRoot, 'workers.db')));

  const maxConcurrent = parsePositiveInt(
    'WORKFORCE_MAX_CONCURRENT',
    env.WORKFORCE_MAX_CONCURRENT,
    DEFAULTS.maxConcurrent,
  );
  const defaultTimeoutSeconds = parsePositiveInt(
    'WORKFORCE_DEFAULT_TIMEOUT',
    env.WORKFORCE_DEFAULT_TIMEOUT,
    DEFAULTS.defaultTimeoutSeconds,
  );
  const maxTimeoutSeconds = parsePositiveInt(
    'WORKFORCE_MAX_TIMEOUT',
    env.WORKFORCE_MAX_TIMEOUT,
    DEFAULTS.maxTimeoutSeconds,
  );
  if (defaultTimeoutSeconds > maxTimeoutSeconds) {
    throw new Error('WORKFORCE_DEFAULT_TIMEOUT must not exceed WORKFORCE_MAX_TIMEOUT');
  }

  const config: Config = {
    dshBin: env.WORKFORCE_DSH_COMMAND ?? DEFAULTS.dshBin,
    dshProfile: env.WORKFORCE_DSH_PROFILE ?? DEFAULTS.dshProfile,
    workerRoot,
    dbPath,
    maxConcurrent,
    defaultTimeoutSeconds,
    maxTimeoutSeconds,
    backend: parseBackend(env.WORKFORCE_BACKEND),
    logMaxBytes: parsePositiveInt('WORKFORCE_LOG_MAX_BYTES', env.WORKFORCE_LOG_MAX_BYTES, DEFAULTS.logMaxBytes),
    diffMaxBytes: parsePositiveInt('WORKFORCE_DIFF_MAX_BYTES', env.WORKFORCE_DIFF_MAX_BYTES, DEFAULTS.diffMaxBytes),
    finalTextMaxChars: parsePositiveInt(
      'WORKFORCE_FINAL_TEXT_MAX_CHARS',
      env.WORKFORCE_FINAL_TEXT_MAX_CHARS,
      DEFAULTS.finalTextMaxChars,
    ),
    terminateGraceMs: parsePositiveInt(
      'WORKFORCE_TERMINATE_GRACE_MS',
      env.WORKFORCE_TERMINATE_GRACE_MS,
      DEFAULTS.terminateGraceMs,
    ),
    enableSubagents: env.WORKFORCE_ENABLE_SUBAGENTS === 'true',
    maxSubagentDepth: parsePositiveInt(
      'WORKFORCE_MAX_SUBAGENT_DEPTH',
      env.WORKFORCE_MAX_SUBAGENT_DEPTH,
      DEFAULTS.maxSubagentDepth,
    ),
    maxSubagentsPerTask: parsePositiveInt(
      'WORKFORCE_MAX_SUBAGENTS_PER_TASK',
      env.WORKFORCE_MAX_SUBAGENTS_PER_TASK,
      DEFAULTS.maxSubagentsPerTask,
    ),
  };
  return config;
}

/** Ensure the worker root and db directory exist. */
export function ensureConfigDirs(config: Config): void {
  fs.mkdirSync(config.workerRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
}
