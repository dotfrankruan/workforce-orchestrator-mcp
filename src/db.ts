import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type WorkerStatus =
  | 'queued'
  | 'waiting_dependencies'
  | 'starting'
  | 'running'
  | 'completed'
  | 'completed_uncommitted'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'timeout'
  | 'blocked'
  | 'budget_exceeded';

/**
 * Terminal states. Note: 'blocked' (dependencies permanently failed) and
 * 'budget_exceeded' are terminal; 'waiting_dependencies' is NOT (it precedes
 * the queue and does not consume a concurrency slot).
 */
export const TERMINAL_STATUSES: ReadonlySet<WorkerStatus> = new Set([
  'completed',
  'completed_uncommitted',
  'failed',
  'cancelled',
  'interrupted',
  'timeout',
  'blocked',
  'budget_exceeded',
]);

/** Statuses that satisfy an all_success dependency. Crisp definition: the task's deliverables/commits were fully verified. */
export const SUCCESS_STATUSES: ReadonlySet<WorkerStatus> = new Set(['completed']);

/** Statuses that permanently fail a dependent under all_success. */
export const DEPENDENCY_FAILURE_STATUSES: ReadonlySet<WorkerStatus> = new Set([
  'failed',
  'cancelled',
  'interrupted',
  'timeout',
  'blocked',
  'budget_exceeded',
  'completed_uncommitted',
]);

export type DependencyPolicy = 'all_success' | 'all_terminal';
export type WorkflowStatus = 'running' | 'completed' | 'completed_with_failures' | 'failed' | 'cancelled';
export type FailurePolicy = 'continue' | 'stop_dependents' | 'cancel_remaining';
export type Acceptance = 'unreviewed' | 'accepted' | 'rejected' | 'needs_revision';
export type CachePolicy = 'off' | 'read' | 'read_write' | 'refresh';
export type Priority = 'low' | 'normal' | 'high';

export function isTerminal(status: WorkerStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface WorkerRow {
  id: string;
  repo_path: string;
  base_ref: string;
  branch: string;
  worktree_path: string;
  log_dir: string;
  status: WorkerStatus;
  task: string;
  mode: string;
  workspace_type: string;
  deliverables: string; // JSON array
  capabilities: string; // JSON array
  deliverables_missing: string | null; // JSON array
  session_id: string | null;
  pid: number | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  commit_hash: string | null;
  final_text: string | null;
  last_progress: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  total_tokens_last: number | null;
  error: string | null;
  continue_count: number;
  commit_followup_used: number;
  timeout_seconds: number | null;
  // v3: orchestration
  workflow_id: string | null;
  task_key: string | null;
  depends_on: string; // JSON array of task ids
  dependency_policy: string;
  role: string | null;
  priority: string;
  cache_policy: string;
  execution_class: string | null;
  acceptance: string;
  budget: string | null; // JSON TaskBudget
  attempt: number;
  max_attempts: number;
  retry_on: string; // JSON array of statuses
  // v4: parallel git isolation & integration
  task_branch: string | null; // kimi-task/<id> branch for git-workflow tasks
  workspace_base_commit: string | null; // immutable snapshot commit the task started from
  task_commits: string; // JSON array of commit shas created by this task (all runs)
  integration_status: string | null; // null | pending | integrating | integrated | conflict | skipped
  integration_error: string | null; // JSON {conflicting_commits, files}
  integrated_commits: string; // JSON array of shas already cherry-picked
  // v5: durable supervision
  run_started_at: string | null; // start time of the CURRENT attempt
  supervision_state: string; // attached | reattached | detached
  stdout_parse_offset: number; // bytes of stdout.jsonl already parsed
  pid_identity: string | null; // process start token (ps lstart) at spawn
  // v6: universal backend
  backend_id: string; // runtime backend that executes the task (default dsh)
  backend_metadata: string | null; // JSON {runtime:{...}, provider:{...}} — facts only
}

export interface WorkflowRow {
  id: string;
  name: string | null;
  status: WorkflowStatus;
  failure_policy: string;
  budget: string | null; // JSON WorkflowBudget
  metadata: string | null; // JSON object
  preset: string | null;
  workspace_type: string;
  workspace_path: string;
  repo_path: string;
  base_ref: string;
  branch: string;
  log_dir: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface AttemptRow {
  id: number;
  task_id: string;
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  status: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  error: string | null;
}

export interface ReviewRow {
  id: number;
  task_id: string;
  decision: string;
  feedback: string | null;
  created_at: string;
}

export interface CacheRow {
  cache_key: string;
  task_id: string;
  mode: string;
  role: string | null;
  workspace_fingerprint: string;
  prompt_version: string;
  artifact_count: number;
  artifact_bytes: number;
  hits: number;
  created_at: string;
}

export interface WorkerPatch {
  status?: WorkerStatus;
  session_id?: string | null;
  pid?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
  exit_code?: number | null;
  commit_hash?: string | null;
  final_text?: string | null;
  last_progress?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  total_tokens_last?: number | null;
  error?: string | null;
  continue_count?: number;
  commit_followup_used?: number;
  deliverables_missing?: string | null;
  acceptance?: string;
  attempt?: number;
  max_attempts?: number;
  task_branch?: string | null;
  workspace_base_commit?: string | null;
  task_commits?: string;
  integration_status?: string | null;
  integration_error?: string | null;
  integrated_commits?: string;
  worktree_path?: string;
  base_ref?: string;
  branch?: string;
  run_started_at?: string | null;
  supervision_state?: string;
  stdout_parse_offset?: number;
  pid_identity?: string | null;
  backend_metadata?: string | null;
}

export interface NewWorker {
  id: string;
  repo_path: string;
  base_ref: string;
  branch: string;
  worktree_path: string;
  log_dir: string;
  task: string;
  mode: string;
  workspace_type: string;
  deliverables: string;
  capabilities: string;
  timeout_seconds: number | null;
  // v3 (all optional — old call sites keep working)
  workflow_id?: string | null;
  task_key?: string | null;
  depends_on?: string;
  dependency_policy?: string;
  role?: string | null;
  priority?: string;
  cache_policy?: string;
  execution_class?: string | null;
  budget?: string | null;
  max_attempts?: number;
  retry_on?: string;
  initialStatus?: WorkerStatus;
  backend_id?: string;
  backend_metadata?: string | null;
}

export interface NewWorkflow {
  id: string;
  name: string | null;
  failure_policy: string;
  budget: string | null;
  metadata: string | null;
  preset: string | null;
  workspace_type: string;
  workspace_path: string;
  repo_path: string;
  base_ref: string;
  branch: string;
  log_dir: string;
}

export interface TaskBudget {
  max_duration_seconds?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_total_tokens?: number;
  max_tool_calls?: number;
  max_iterations?: number;
}

export interface WorkflowBudget {
  max_duration_seconds?: number;
  /** Canonical: max total worker tokens (input+output+cache) across the workflow. */
  max_worker_tokens?: number;
  /** Deprecated alias of max_worker_tokens (kept readable for old clients). */
  max_kimi_tokens?: number;
  max_concurrent_tasks?: number;
  max_tasks?: number;
}

export interface ListFilter {
  status?: WorkerStatus | undefined;
  repo_path?: string | undefined;
  limit?: number | undefined;
}

export interface ArtifactRow {
  id: number;
  task_id: string;
  relative_path: string;
  absolute_path: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

export interface NewArtifact {
  task_id: string;
  relative_path: string;
  absolute_path: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
}

/** Exported for migration tests. */
export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  branch TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  log_dir TEXT NOT NULL,
  status TEXT NOT NULL,
  task TEXT NOT NULL,
  session_id TEXT,
  pid INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  commit_hash TEXT,
  final_text TEXT,
  last_progress TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens_last INTEGER,
  error TEXT,
  continue_count INTEGER NOT NULL DEFAULT 0,
  commit_followup_used INTEGER NOT NULL DEFAULT 0,
  timeout_seconds INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);
CREATE INDEX IF NOT EXISTS idx_workers_repo ON workers(repo_path);
CREATE INDEX IF NOT EXISTS idx_workers_created ON workers(created_at DESC);

CREATE TABLE IF NOT EXISTS worker_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_worker_events_worker ON worker_events(worker_id, id);
`;

const SCHEMA_V2_ARTIFACTS = `
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, relative_path)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);
`;

const SCHEMA_V3_TABLES = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  failure_policy TEXT NOT NULL DEFAULT 'stop_dependents',
  budget TEXT,
  metadata TEXT,
  preset TEXT,
  workspace_type TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  repo_path TEXT NOT NULL DEFAULT '',
  base_ref TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  log_dir TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);

CREATE TABLE IF NOT EXISTS workflow_tasks (
  workflow_id TEXT NOT NULL,
  task_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  PRIMARY KEY (workflow_id, task_key)
);
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_task ON workflow_tasks(task_id);

CREATE TABLE IF NOT EXISTS task_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  status TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON task_attempts(task_id);

CREATE TABLE IF NOT EXISTS task_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  feedback TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_task ON task_reviews(task_id);

CREATE TABLE IF NOT EXISTS artifact_cache (
  cache_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  role TEXT,
  workspace_fingerprint TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  artifact_count INTEGER NOT NULL DEFAULT 0,
  artifact_bytes INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`;

/** Columns added to workers in schema v3 (name → DDL). */
const WORKERS_V3_COLUMNS: Array<[string, string]> = [
  ['workflow_id', `ALTER TABLE workers ADD COLUMN workflow_id TEXT`],
  ['task_key', `ALTER TABLE workers ADD COLUMN task_key TEXT`],
  ['depends_on', `ALTER TABLE workers ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'`],
  ['dependency_policy', `ALTER TABLE workers ADD COLUMN dependency_policy TEXT NOT NULL DEFAULT 'all_success'`],
  ['role', `ALTER TABLE workers ADD COLUMN role TEXT`],
  ['priority', `ALTER TABLE workers ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`],
  ['cache_policy', `ALTER TABLE workers ADD COLUMN cache_policy TEXT NOT NULL DEFAULT 'off'`],
  ['execution_class', `ALTER TABLE workers ADD COLUMN execution_class TEXT`],
  ['acceptance', `ALTER TABLE workers ADD COLUMN acceptance TEXT NOT NULL DEFAULT 'unreviewed'`],
  ['budget', `ALTER TABLE workers ADD COLUMN budget TEXT`],
  ['attempt', `ALTER TABLE workers ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1`],
  ['max_attempts', `ALTER TABLE workers ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 1`],
  ['retry_on', `ALTER TABLE workers ADD COLUMN retry_on TEXT NOT NULL DEFAULT '["failed","timeout"]'`],
];

/** Columns added to workers in schema v4 (parallel git isolation & integration). */
const WORKERS_V4_COLUMNS: Array<[string, string]> = [
  ['task_branch', `ALTER TABLE workers ADD COLUMN task_branch TEXT`],
  ['workspace_base_commit', `ALTER TABLE workers ADD COLUMN workspace_base_commit TEXT`],
  ['task_commits', `ALTER TABLE workers ADD COLUMN task_commits TEXT NOT NULL DEFAULT '[]'`],
  ['integration_status', `ALTER TABLE workers ADD COLUMN integration_status TEXT`],
  ['integration_error', `ALTER TABLE workers ADD COLUMN integration_error TEXT`],
  ['integrated_commits', `ALTER TABLE workers ADD COLUMN integrated_commits TEXT NOT NULL DEFAULT '[]'`],
];

/** Columns added in schema v5 (durable worker supervision). */
const WORKERS_V5_COLUMNS: Array<[string, string]> = [
  ['run_started_at', `ALTER TABLE workers ADD COLUMN run_started_at TEXT`],
  ['supervision_state', `ALTER TABLE workers ADD COLUMN supervision_state TEXT NOT NULL DEFAULT 'attached'`],
  ['stdout_parse_offset', `ALTER TABLE workers ADD COLUMN stdout_parse_offset INTEGER NOT NULL DEFAULT 0`],
  ['pid_identity', `ALTER TABLE workers ADD COLUMN pid_identity TEXT`],
];

/** Columns added in schema v6 (universal backend architecture). */
const WORKERS_V6_COLUMNS: Array<[string, string]> = [
  // All pre-existing rows were executed by the dsh backend — a safe fact.
  ['backend_id', `ALTER TABLE workers ADD COLUMN backend_id TEXT NOT NULL DEFAULT 'dsh'`],
  ['backend_metadata', `ALTER TABLE workers ADD COLUMN backend_metadata TEXT`],
];

const CURRENT_SCHEMA_VERSION = 6;

const ALL_COLUMNS = [
  'id', 'repo_path', 'base_ref', 'branch', 'worktree_path', 'log_dir', 'status', 'task',
  'mode', 'workspace_type', 'deliverables', 'capabilities', 'deliverables_missing',
  'session_id', 'pid', 'created_at', 'updated_at', 'started_at', 'finished_at', 'exit_code',
  'commit_hash', 'final_text', 'last_progress', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'total_tokens_last', 'error', 'continue_count',
  'commit_followup_used', 'timeout_seconds',
  'workflow_id', 'task_key', 'depends_on', 'dependency_policy', 'role', 'priority',
  'cache_policy', 'execution_class', 'acceptance', 'budget', 'attempt', 'max_attempts', 'retry_on',
  'task_branch', 'workspace_base_commit', 'task_commits', 'integration_status',
  'integration_error', 'integrated_commits',
  'run_started_at', 'supervision_state', 'stdout_parse_offset', 'pid_identity',
  'backend_id', 'backend_metadata',
] as const;

function rowToWorker(row: Record<string, unknown>): WorkerRow {
  const w: Record<string, unknown> = {};
  for (const col of ALL_COLUMNS) w[col] = row[col];
  return w as unknown as WorkerRow;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  return row !== undefined;
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

/**
 * Schema versioning. v1 = original workers/worker_events layout.
 * v2 adds task metadata (mode/workspace_type/deliverables/capabilities) and
 * the artifacts table. Existing v1 databases are migrated in place; rows
 * created before v2 read as mode=code / workspace_type=git_worktree.
 */
function migrate(db: DatabaseSync): void {
  let version = 0;
  if (tableExists(db, 'schema_meta')) {
    const row = db.prepare(`SELECT version FROM schema_meta WHERE id = 1`).get() as
      | { version: number }
      | undefined;
    version = row?.version ?? 0;
  } else if (tableExists(db, 'workers')) {
    version = 1;
  }

  if (version < 1) {
    db.exec(SCHEMA_V1);
    version = 1;
  }

  if (version < 2) {
    if (!columnExists(db, 'workers', 'mode')) {
      db.exec(`ALTER TABLE workers ADD COLUMN mode TEXT NOT NULL DEFAULT 'code'`);
    }
    if (!columnExists(db, 'workers', 'workspace_type')) {
      db.exec(`ALTER TABLE workers ADD COLUMN workspace_type TEXT NOT NULL DEFAULT 'git_worktree'`);
    }
    if (!columnExists(db, 'workers', 'deliverables')) {
      db.exec(`ALTER TABLE workers ADD COLUMN deliverables TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!columnExists(db, 'workers', 'capabilities')) {
      db.exec(`ALTER TABLE workers ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!columnExists(db, 'workers', 'deliverables_missing')) {
      db.exec(`ALTER TABLE workers ADD COLUMN deliverables_missing TEXT`);
    }
    db.exec(SCHEMA_V2_ARTIFACTS);
    version = 2;
  }

  if (version < 3) {
    for (const [col, ddl] of WORKERS_V3_COLUMNS) {
      if (!columnExists(db, 'workers', col)) db.exec(ddl);
    }
    db.exec(SCHEMA_V3_TABLES);
    version = 3;
  }

  if (version < 4) {
    for (const [col, ddl] of WORKERS_V4_COLUMNS) {
      if (!columnExists(db, 'workers', col)) db.exec(ddl);
    }
    version = 4;
  }

  if (version < 5) {
    for (const [col, ddl] of WORKERS_V5_COLUMNS) {
      if (!columnExists(db, 'workers', col)) db.exec(ddl);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS server_meta (key TEXT PRIMARY KEY, value TEXT)`);
    version = 5;
  }

  if (version < 6) {
    for (const [col, ddl] of WORKERS_V6_COLUMNS) {
      if (!columnExists(db, 'workers', col)) db.exec(ddl);
    }
    version = 6;
  }

  db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  db.prepare(
    `INSERT INTO schema_meta (id, version) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET version = excluded.version`,
  ).run(CURRENT_SCHEMA_VERSION);
}

export class WorkerStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    migrate(this.db);
  }

  schemaVersion(): number {
    const row = this.db.prepare(`SELECT version FROM schema_meta WHERE id = 1`).get() as {
      version: number;
    };
    return row.version;
  }

  close(): void {
    this.db.close();
  }

  createWorker(w: NewWorker): WorkerRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workers (id, repo_path, base_ref, branch, worktree_path, log_dir, status, task, mode, workspace_type, deliverables, capabilities, created_at, updated_at, timeout_seconds,
           workflow_id, task_key, depends_on, dependency_policy, role, priority, cache_policy, execution_class, budget, max_attempts, retry_on,
           backend_id, backend_metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        w.id, w.repo_path, w.base_ref, w.branch, w.worktree_path, w.log_dir,
        w.initialStatus ?? 'queued', w.task, w.mode, w.workspace_type, w.deliverables, w.capabilities,
        now, now, w.timeout_seconds,
        w.workflow_id ?? null, w.task_key ?? null, w.depends_on ?? '[]',
        w.dependency_policy ?? 'all_success', w.role ?? null, w.priority ?? 'normal',
        w.cache_policy ?? 'off', w.execution_class ?? null, w.budget ?? null,
        w.max_attempts ?? 1, w.retry_on ?? '["failed","timeout"]',
        w.backend_id ?? 'dsh', w.backend_metadata ?? null,
      );
    return this.getWorker(w.id)!;
  }

  getWorker(id: string): WorkerRow | null {
    const row = this.db.prepare(`SELECT * FROM workers WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToWorker(row) : null;
  }

  updateWorker(id: string, patch: WorkerPatch): void {
    const keys = Object.keys(patch) as Array<keyof WorkerPatch>;
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => patch[k] ?? null);
    this.db
      .prepare(`UPDATE workers SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...(values as Array<string | number | null>), new Date().toISOString(), id);
  }

  listWorkers(filter: ListFilter = {}): WorkerRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.repo_path) {
      where.push('repo_path = ?');
      params.push(filter.repo_path);
    }
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 500);
    const sql = `SELECT * FROM workers ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToWorker);
  }

  /** Workers that may still have a live process attached. */
  findActive(): WorkerRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM workers WHERE status IN ('queued', 'starting', 'running') ORDER BY created_at ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToWorker);
  }

  workersByStatus(status: WorkerStatus): WorkerRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM workers WHERE status = ? ORDER BY created_at ASC`)
      .all(status) as Array<Record<string, unknown>>;
    return rows.map(rowToWorker);
  }

  workersInWorkflow(workflowId: string): WorkerRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM workers WHERE workflow_id = ? ORDER BY created_at ASC`)
      .all(workflowId) as Array<Record<string, unknown>>;
    return rows.map(rowToWorker);
  }

  /** Distinct active (running/starting) task counts per workflow. */
  activeCountByWorkflow(): Map<string, number> {
    const rows = this.db
      .prepare(`SELECT workflow_id AS wf, COUNT(*) AS n FROM workers WHERE workflow_id IS NOT NULL AND status IN ('starting','running') GROUP BY workflow_id`)
      .all() as Array<{ wf: string; n: number }>;
    return new Map(rows.map((r) => [r.wf, r.n]));
  }

  countByStatus(status: WorkerStatus): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM workers WHERE status = ?`).get(status) as { n: number };
    return row.n;
  }

  addEvent(workerId: string, type: string, summary: string | null): void {
    this.db
      .prepare(`INSERT INTO worker_events (worker_id, ts, type, summary) VALUES (?, ?, ?, ?)`)
      .run(workerId, new Date().toISOString(), type, summary);
  }

  listEvents(workerId: string, limit = 200): Array<{ id: number; ts: string; type: string; summary: string | null }> {
    return this.db
      .prepare(`SELECT id, ts, type, summary FROM worker_events WHERE worker_id = ? ORDER BY id DESC LIMIT ?`)
      .all(workerId, limit) as Array<{ id: number; ts: string; type: string; summary: string | null }>;
  }

  countEvents(workerId: string, type: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM worker_events WHERE worker_id = ? AND type = ?`)
      .get(workerId, type) as { n: number };
    return row.n;
  }

  /* ------------------------------ workflows ------------------------------ */

  createWorkflow(w: NewWorkflow): WorkflowRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workflows (id, name, status, failure_policy, budget, metadata, preset, workspace_type, workspace_path, repo_path, base_ref, branch, log_dir, created_at, updated_at)
         VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        w.id, w.name, w.failure_policy, w.budget, w.metadata, w.preset,
        w.workspace_type, w.workspace_path, w.repo_path, w.base_ref, w.branch, w.log_dir, now, now,
      );
    return this.getWorkflow(w.id)!;
  }

  getWorkflow(id: string): WorkflowRow | null {
    const row = this.db.prepare(`SELECT * FROM workflows WHERE id = ?`).get(id) as WorkflowRow | undefined;
    return row ?? null;
  }

  updateWorkflow(id: string, patch: { status?: WorkflowStatus; finished_at?: string | null }): void {
    const sets: string[] = [];
    const vals: Array<string | null> = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      vals.push(patch.status);
    }
    if (patch.finished_at !== undefined) {
      sets.push('finished_at = ?');
      vals.push(patch.finished_at);
    }
    if (sets.length === 0) return;
    this.db
      .prepare(`UPDATE workflows SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...vals, new Date().toISOString(), id);
  }

  listWorkflows(limit = 50): WorkflowRow[] {
    return this.db
      .prepare(`SELECT * FROM workflows ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as unknown as WorkflowRow[];
  }

  runningWorkflows(): WorkflowRow[] {
    return this.db.prepare(`SELECT * FROM workflows WHERE status = 'running'`).all() as unknown as WorkflowRow[];
  }

  addWorkflowTask(workflowId: string, taskKey: string, taskId: string): void {
    this.db
      .prepare(`INSERT INTO workflow_tasks (workflow_id, task_key, task_id) VALUES (?, ?, ?)`)
      .run(workflowId, taskKey, taskId);
  }

  workflowTaskMap(workflowId: string): Array<{ task_key: string; task_id: string }> {
    return this.db
      .prepare(`SELECT task_key, task_id FROM workflow_tasks WHERE workflow_id = ? ORDER BY rowid ASC`)
      .all(workflowId) as Array<{ task_key: string; task_id: string }>;
  }

  /* ------------------------------ attempts ------------------------------ */

  addAttempt(a: {
    task_id: string;
    attempt: number;
    started_at: string | null;
    finished_at: string | null;
    exit_code: number | null;
    status: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    error: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO task_attempts (task_id, attempt, started_at, finished_at, exit_code, status, input_tokens, output_tokens, cache_read_tokens, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.task_id, a.attempt, a.started_at, a.finished_at, a.exit_code, a.status, a.input_tokens, a.output_tokens, a.cache_read_tokens, a.error);
  }

  listAttempts(taskId: string): AttemptRow[] {
    return this.db
      .prepare(`SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt ASC`)
      .all(taskId) as unknown as AttemptRow[];
  }

  /* ------------------------------ reviews ------------------------------ */

  addReview(taskId: string, decision: string, feedback: string | null): void {
    this.db
      .prepare(`INSERT INTO task_reviews (task_id, decision, feedback, created_at) VALUES (?, ?, ?, ?)`)
      .run(taskId, decision, feedback, new Date().toISOString());
  }

  listReviews(taskId: string): ReviewRow[] {
    return this.db
      .prepare(`SELECT * FROM task_reviews WHERE task_id = ? ORDER BY id ASC`)
      .all(taskId) as unknown as ReviewRow[];
  }

  /** Acceptance/quality aggregation grouped by mode and role. */
  acceptanceAgg(): Array<{
    grp_mode: string;
    grp_role: string;
    total: number;
    accepted: number;
    rejected: number;
    needs_revision: number;
    failed: number;
    avg_continues: number;
  }> {
    return this.db
      .prepare(
        `SELECT mode AS grp_mode, COALESCE(role, '') AS grp_role,
           COUNT(*) AS total,
           SUM(CASE WHEN acceptance = 'accepted' THEN 1 ELSE 0 END) AS accepted,
           SUM(CASE WHEN acceptance = 'rejected' THEN 1 ELSE 0 END) AS rejected,
           SUM(CASE WHEN acceptance = 'needs_revision' THEN 1 ELSE 0 END) AS needs_revision,
           SUM(CASE WHEN status IN ('failed','timeout','budget_exceeded') THEN 1 ELSE 0 END) AS failed,
           AVG(continue_count) AS avg_continues
         FROM workers
         GROUP BY mode, COALESCE(role, '')`,
      )
      .all() as unknown as Array<{
      grp_mode: string; grp_role: string; total: number; accepted: number;
      rejected: number; needs_revision: number; failed: number; avg_continues: number;
    }>;
  }

  /* ------------------------------ cache ------------------------------ */

  cacheGet(key: string): CacheRow | null {
    const row = this.db.prepare(`SELECT * FROM artifact_cache WHERE cache_key = ?`).get(key) as CacheRow | undefined;
    return row ?? null;
  }

  cachePut(c: Omit<CacheRow, 'hits'>): void {
    this.db
      .prepare(
        `INSERT INTO artifact_cache (cache_key, task_id, mode, role, workspace_fingerprint, prompt_version, artifact_count, artifact_bytes, hits, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           task_id = excluded.task_id,
           artifact_count = excluded.artifact_count,
           artifact_bytes = excluded.artifact_bytes,
           created_at = excluded.created_at`,
      )
      .run(c.cache_key, c.task_id, c.mode, c.role, c.workspace_fingerprint, c.prompt_version, c.artifact_count, c.artifact_bytes, c.created_at);
  }

  cacheHit(key: string): void {
    this.db.prepare(`UPDATE artifact_cache SET hits = hits + 1 WHERE cache_key = ?`).run(key);
  }

  cacheStats(): { entries: number; hits: number; artifact_bytes: number } {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS entries, COALESCE(SUM(hits),0) AS hits, COALESCE(SUM(artifact_bytes),0) AS artifact_bytes FROM artifact_cache`)
      .get() as { entries: number; hits: number; artifact_bytes: number };
    return row;
  }

  /* ------------------------------ aggregates ------------------------------ */

  statusCounts(): Record<string, number> {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM workers GROUP BY status`).all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  tokenSums(): { input: number; output: number; cache_read: number } {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, COALESCE(SUM(cache_read_tokens),0) AS cache_read FROM workers`)
      .get() as { input: number; output: number; cache_read: number };
    return row;
  }

  avgContinues(): number {
    const row = this.db.prepare(`SELECT COALESCE(AVG(continue_count),0) AS a FROM workers WHERE continue_count > 0 OR status IN ('completed','completed_uncommitted')`).get() as { a: number };
    return row.a;
  }

  /* ------------------------------ server meta counters ------------------------------ */

  metaIncrement(key: string, by = 1): void {
    this.db
      .prepare(`INSERT INTO server_meta (key, value) VALUES (?, '0') ON CONFLICT(key) DO NOTHING`)
      .run(key);
    this.db
      .prepare(`UPDATE server_meta SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT) WHERE key = ?`)
      .run(by, key);
  }

  metaGet(key: string): number {
    const row = this.db.prepare(`SELECT value FROM server_meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  }

  /** Token totals + task counts grouped by backend. */
  backendAgg(): Array<{ backend_id: string; tasks: number; input: number; output: number; cache_read: number }> {
    return this.db
      .prepare(
        `SELECT backend_id, COUNT(*) AS tasks,
           COALESCE(SUM(input_tokens),0) AS input,
           COALESCE(SUM(output_tokens),0) AS output,
           COALESCE(SUM(cache_read_tokens),0) AS cache_read
         FROM workers GROUP BY backend_id`,
      )
      .all() as unknown as Array<{ backend_id: string; tasks: number; input: number; output: number; cache_read: number }>;
  }

  tokenSumsForWorkflow(wfId: string): { input: number; output: number; cache_read: number } {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, COALESCE(SUM(cache_read_tokens),0) AS cache_read FROM workers WHERE workflow_id = ?`)
      .get(wfId) as { input: number; output: number; cache_read: number };
    return row;
  }

  /* ------------------------------ artifacts ------------------------------ */

  upsertArtifact(a: NewArtifact): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (task_id, relative_path, absolute_path, mime_type, size_bytes, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, relative_path)
         DO UPDATE SET absolute_path = excluded.absolute_path,
                       mime_type = excluded.mime_type,
                       size_bytes = excluded.size_bytes,
                       sha256 = excluded.sha256,
                       created_at = excluded.created_at`,
      )
      .run(a.task_id, a.relative_path, a.absolute_path, a.mime_type, a.size_bytes, a.sha256, new Date().toISOString());
  }

  /** Remove artifact rows whose files vanished from the workspace. */
  deleteArtifact(taskId: string, relativePath: string): void {
    this.db.prepare(`DELETE FROM artifacts WHERE task_id = ? AND relative_path = ?`).run(taskId, relativePath);
  }

  listArtifacts(taskId: string): ArtifactRow[] {
    return this.db
      .prepare(`SELECT * FROM artifacts WHERE task_id = ? ORDER BY relative_path ASC`)
      .all(taskId) as unknown as ArtifactRow[];
  }

  getArtifact(taskId: string, relativePath: string): ArtifactRow | null {
    const row = this.db
      .prepare(`SELECT * FROM artifacts WHERE task_id = ? AND relative_path = ?`)
      .get(taskId, relativePath) as ArtifactRow | undefined;
    return row ?? null;
  }
}
