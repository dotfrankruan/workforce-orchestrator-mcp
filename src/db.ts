import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type WorkerStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'completed'
  | 'completed_uncommitted'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'timeout';

export const TERMINAL_STATUSES: ReadonlySet<WorkerStatus> = new Set([
  'completed',
  'completed_uncommitted',
  'failed',
  'cancelled',
  'interrupted',
  'timeout',
]);

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

const CURRENT_SCHEMA_VERSION = 2;

const ALL_COLUMNS = [
  'id', 'repo_path', 'base_ref', 'branch', 'worktree_path', 'log_dir', 'status', 'task',
  'mode', 'workspace_type', 'deliverables', 'capabilities', 'deliverables_missing',
  'session_id', 'pid', 'created_at', 'updated_at', 'started_at', 'finished_at', 'exit_code',
  'commit_hash', 'final_text', 'last_progress', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'total_tokens_last', 'error', 'continue_count',
  'commit_followup_used', 'timeout_seconds',
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
        `INSERT INTO workers (id, repo_path, base_ref, branch, worktree_path, log_dir, status, task, mode, workspace_type, deliverables, capabilities, created_at, updated_at, timeout_seconds)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        w.id, w.repo_path, w.base_ref, w.branch, w.worktree_path, w.log_dir, w.task,
        w.mode, w.workspace_type, w.deliverables, w.capabilities, now, now, w.timeout_seconds,
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
