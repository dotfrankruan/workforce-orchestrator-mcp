import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export type BackendKind = 'dsh' | 'fake';

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
  /** Worker backend implementation. */
  backend: BackendKind;
  /** Max bytes returned by get_worker_log. */
  logMaxBytes: number;
  /** Max bytes returned by get_worker_diff (full diff). */
  diffMaxBytes: number;
  /** Max chars of final report text kept in the compact result. */
  finalTextMaxChars: number;
  /** Grace period (ms) between SIGTERM and SIGKILL on cancel. */
  terminateGraceMs: number;
  /** Experimental: allow research/general workers to use dsh subagents. */
  enableDshSubagents: boolean;
  maxSubagentDepth: number;
  maxSubagentsPerTask: number;
}

const DEFAULTS = {
  dshBin: '/usr/local/bin/dsh',
  dshProfile: 'headless',
  maxConcurrent: 4,
  defaultTimeoutSeconds: 3600,
  maxTimeoutSeconds: 6 * 3600,
  backend: 'dsh' as BackendKind,
  logMaxBytes: 32 * 1024,
  diffMaxBytes: 64 * 1024,
  finalTextMaxChars: 8000,
  terminateGraceMs: 5000,
  enableDshSubagents: false,
  maxSubagentDepth: 1,
  maxSubagentsPerTask: 3,
};

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
  if (raw === 'dsh' || raw === 'fake') return raw;
  throw new Error(`Invalid KIMI_WORKER_BACKEND: ${JSON.stringify(raw)} (expected "dsh" or "fake")`);
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
 * mainly for tests). Never reads ~/.dsh/.env — credentials are dsh's business.
 */
export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const env = overrides.env ?? process.env;

  const workerRootRaw =
    overrides.workerRoot ?? env.KIMI_WORKER_ROOT ?? path.join(os.homedir(), '.kimi-workers');
  const workerRoot = path.resolve(expandHome(workerRootRaw));

  const dbPath = path.resolve(expandHome(env.KIMI_WORKER_DB ?? path.join(workerRoot, 'workers.db')));

  const maxConcurrent = parsePositiveInt(
    'KIMI_WORKER_MAX_CONCURRENT',
    env.KIMI_WORKER_MAX_CONCURRENT,
    DEFAULTS.maxConcurrent,
  );
  const defaultTimeoutSeconds = parsePositiveInt(
    'KIMI_WORKER_DEFAULT_TIMEOUT',
    env.KIMI_WORKER_DEFAULT_TIMEOUT,
    DEFAULTS.defaultTimeoutSeconds,
  );
  const maxTimeoutSeconds = parsePositiveInt(
    'KIMI_WORKER_MAX_TIMEOUT',
    env.KIMI_WORKER_MAX_TIMEOUT,
    DEFAULTS.maxTimeoutSeconds,
  );
  if (defaultTimeoutSeconds > maxTimeoutSeconds) {
    throw new Error('KIMI_WORKER_DEFAULT_TIMEOUT must not exceed KIMI_WORKER_MAX_TIMEOUT');
  }

  const config: Config = {
    dshBin: env.KIMI_WORKER_DSH_BIN ?? DEFAULTS.dshBin,
    dshProfile: env.KIMI_WORKER_DSH_PROFILE ?? DEFAULTS.dshProfile,
    workerRoot,
    dbPath,
    maxConcurrent,
    defaultTimeoutSeconds,
    maxTimeoutSeconds,
    backend: parseBackend(env.KIMI_WORKER_BACKEND),
    logMaxBytes: parsePositiveInt('KIMI_WORKER_LOG_MAX_BYTES', env.KIMI_WORKER_LOG_MAX_BYTES, DEFAULTS.logMaxBytes),
    diffMaxBytes: parsePositiveInt('KIMI_WORKER_DIFF_MAX_BYTES', env.KIMI_WORKER_DIFF_MAX_BYTES, DEFAULTS.diffMaxBytes),
    finalTextMaxChars: parsePositiveInt(
      'KIMI_WORKER_FINAL_TEXT_MAX_CHARS',
      env.KIMI_WORKER_FINAL_TEXT_MAX_CHARS,
      DEFAULTS.finalTextMaxChars,
    ),
    terminateGraceMs: parsePositiveInt(
      'KIMI_WORKER_TERMINATE_GRACE_MS',
      env.KIMI_WORKER_TERMINATE_GRACE_MS,
      DEFAULTS.terminateGraceMs,
    ),
    enableDshSubagents: env.ENABLE_DSH_SUBAGENTS === 'true',
    maxSubagentDepth: parsePositiveInt('MAX_SUBAGENT_DEPTH', env.MAX_SUBAGENT_DEPTH, DEFAULTS.maxSubagentDepth),
    maxSubagentsPerTask: parsePositiveInt(
      'MAX_SUBAGENTS_PER_TASK',
      env.MAX_SUBAGENTS_PER_TASK,
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
