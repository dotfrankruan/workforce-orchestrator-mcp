import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import {
  WorkerStore,
  isTerminal,
  DEPENDENCY_FAILURE_STATUSES,
  type WorkerRow,
  type WorkerStatus,
  type ListFilter,
  type ArtifactRow,
  type WorkflowRow,
  type TaskBudget,
  type WorkflowBudget,
} from './db.js';
import { newWorkerId, isValidWorkerId } from './util/ids.js';
import { pidAlive } from './util/paths.js';
import { isExpectedWorkerProcess, captureProcessIdentity } from './proc.js';
import { redactSecrets } from './util/redact.js';
import { tailLines, truncateUtf8 } from './util/truncate.js';
import {
  UsageTracker,
  parseDshLine,
  renderLogLine,
  replayLogFile,
  summarizeFinalText,
  type DshEvent,
} from './parser.js';
import {
  statusPorcelain,
  currentHead,
  currentBranch,
  commitsAhead,
  supervisorCommitAll,
  changedFilesCommitted,
  uncommittedPaths,
  diffStat,
  diffFull,
  lastCommit,
  revListRange,
  cherryPickCommit,
  createWorktreeAtCommit,
} from './worktree.js';
import { buildContinuePrompt } from './prompt.js';
import { buildModePrompt } from './prompts/index.js';
import { parseTaskMode, type TaskMode } from './modes.js';
import {
  isWorkspaceType,
  planWorkspace,
  prepareWorkspace,
  planWorkflowWorkspace,
  prepareWorkflowWorkspace,
  resolveModeAndWorkspace,
  type WorkspaceInput,
  type WorkspaceType,
  type PlannedWorkspace,
} from './workspace.js';
import {
  guessMimeType,
  sha256File,
  validateRelativePath,
  resolveUnderRoot,
  walkArtifacts,
  isProbablyBinary,
  type CollectedFile,
} from './artifacts.js';
import type { WorkerBackend, WorkerBackendHandle } from './backends/types.js';
import type { WorkerEvent } from './backends/events.js';
import { normalizeDshEvent } from './backends/events.js';
import { BackendRegistry } from './backends/registry.js';
import { getRole, BUILT_IN_ROLES } from './roles.js';
import { getPreset, presetNames, WORKFLOW_PRESETS } from './presets.js';
import {
  computeCacheKey,
  workspaceFingerprint,
  PROMPT_TEMPLATE_VERSION,
} from './cache.js';

/* ------------------------------------------------------------------ *
 * Spawn inputs
 * ------------------------------------------------------------------ */

/** Legacy code-worker spawn (backward compatible). */
export interface SpawnParams {
  repo_path: string;
  task: string;
  base_ref?: string | undefined;
  timeout_seconds?: number | undefined;
}

export interface SpawnResult {
  worker_id: string;
  status: WorkerStatus;
  branch: string;
  worktree: string;
  session_id: string | null;
  queued: boolean;
}

/** Generic task spawn. */
export interface SpawnTaskParams {
  task: string;
  mode?: TaskMode | string | undefined;
  workspace?: WorkspaceInput | undefined;
  deliverables?: string[] | undefined;
  capabilities?: string[] | undefined;
  timeout_seconds?: number | undefined;
  // v3 orchestration
  depends_on?: string[] | undefined;
  dependency_policy?: 'all_success' | 'all_terminal' | undefined;
  role?: string | undefined;
  priority?: 'low' | 'normal' | 'high' | undefined;
  cache_policy?: 'off' | 'read' | 'read_write' | 'refresh' | undefined;
  execution_class?: string | undefined;
  budget?: TaskBudget | undefined;
  retry?: { max_attempts: number; retry_on?: string[] } | undefined;
  /** Explicit runtime backend id (see list_backends). Default: router → dsh. */
  backend?: string | undefined;
  /** Per-task model override (backend must advertise capabilities.modelSelection). */
  model?: string | undefined;
}

export interface SpawnTaskResult {
  task_id: string;
  status: WorkerStatus;
  mode: TaskMode;
  workspace: { type: WorkspaceType; path: string };
  branch: string | null;
  session_id: string | null;
  queued: boolean;
  backend: string;
  /** Effective per-task model (null = backend/profile default). */
  model: string | null;
  cache?: { hit: boolean; source_task_id?: string; age_seconds?: number; artifacts_reused?: number; artifact_bytes?: number } | undefined;
}

/** Workflow task spec: dependencies use per-workflow keys, not task ids. */
export interface WorkflowTaskInput {
  key: string;
  depends_on?: string[] | undefined; // keys within the same workflow
  dependency_policy?: 'all_success' | 'all_terminal' | undefined;
}

interface ActiveRun {
  handle: WorkerBackendHandle;
  usage: UsageTracker;
  intent: 'run' | 'cancel' | 'timeout' | 'budget';
  timeoutTimer: NodeJS.Timeout | null;
  /** HEAD captured when this run started (run-level git tracking). */
  headBeforeRun: string | null;
  /** Run-local counters for budget enforcement. */
  toolCalls: number;
  lastTurn: number;
  startedAt: string;
  budgetInfo?: { reason: string; limit: number; used: number };
  done: Promise<void>;
  resolveDone: () => void;
  /** Reattached run: no ChildProcess handle, monitored via pid + JSONL tail. */
  detached?: boolean;
  tailTimer?: NodeJS.Timeout | null;
  /** Current durable-log tail offset (bytes). */
  tailOffset?: number;
  /** Backend that owns this run (for event normalization). */
  backend?: WorkerBackend;
}

/** Handle for a worker process we did not spawn (reattached after restart). */
class DetachedHandle implements WorkerBackendHandle {
  constructor(public readonly pid: number) {}
  async terminate(graceMs: number): Promise<void> {
    if (!pidAlive(this.pid)) return;
    try {
      process.kill(this.pid, 'SIGTERM');
    } catch {
      return;
    }
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && pidAlive(this.pid)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (pidAlive(this.pid)) {
      try {
        process.kill(this.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

const MAX_EVENT_SUMMARY = 400;
const MAX_PROGRESS_CHARS = 300;
const MAX_DELIVERABLES = 50;
const MAX_CAPABILITIES = 20;
const ARTIFACT_READ_CAP = 1024 * 1024; // hard ceiling for get_artifact
const ARTIFACT_DEFAULT_BYTES = 64 * 1024;

/** Wait-tool bounds (seconds). Waiting is decoupled from worker timeouts. */
const WAIT_DEFAULT_SECONDS = 60;
const WAIT_TASKS_DEFAULT_SECONDS = 120;
const WAIT_MAX_SECONDS = 600;
const WAIT_MAX_TASKS = 32;
const WAIT_RECHECK_MS = 5000; // safety re-check cadence (cross-process changes)
const SPAWN_TASKS_MAX = 16;

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function sanitizeCapabilities(input: string[] | undefined): string[] {
  if (!input) return [];
  const out: string[] = [];
  for (const c of input) {
    if (typeof c !== 'string') continue;
    const trimmed = c.trim();
    if (trimmed === '' || trimmed.length > 64) continue;
    out.push(trimmed);
    if (out.length >= MAX_CAPABILITIES) break;
  }
  return [...new Set(out)];
}

function sanitizeDeliverables(input: string[] | undefined): string[] {
  if (!input) return [];
  const out: string[] = [];
  for (const d of input) {
    const rel = validateRelativePath(String(d));
    out.push(rel.split(path.sep).join('/'));
    if (out.length >= MAX_DELIVERABLES) break;
  }
  return [...new Set(out)];
}

export class WorkerSupervisor {
  private active = new Map<string, ActiveRun>();
  private scheduling = false;
  /** Set by shutdown(): no further scheduling (workers are detached, not killed). */
  private shutDown = false;
  /**
   * Event-driven wait support: terminal-state waiters per task id.
   * No locks are held while waiting — waiter callbacks are invoked
   * synchronously from the same code paths that mark a worker terminal,
   * so worker completion can never deadlock behind a pending wait.
   */
  private waiters = new Map<string, Set<() => void>>();

  private registry: BackendRegistry;

  constructor(
    private config: Config,
    private store: WorkerStore,
    backend: WorkerBackend | BackendRegistry,
  ) {
    this.registry = backend instanceof BackendRegistry ? backend : new BackendRegistry(backend);
  }

  /**
   * Facts-only backend metadata for a run: runtime identity plus the provider
   * and effective model. Values come from the backend's configured/discovered
   * runtime config — never guessed, never from provider APIs.
   */
  private backendMetadataFor(backend: WorkerBackend, model: string | null): Record<string, unknown> {
    const base = backend.metadata?.() ?? {};
    const rt = backend.inspectRuntime?.() ?? null;
    const provider = rt?.default?.provider ?? base.provider?.name;
    const effectiveModel = model ?? rt?.default?.model ?? base.provider?.model;
    return {
      ...base,
      provider: {
        ...(provider ? { name: provider } : {}),
        ...(effectiveModel ? { model: effectiveModel } : {}),
      },
    };
  }

  /** Bounded tail of stderr.log for failure reporting (credentials redacted). */
  private stderrTail(row: WorkerRow, maxChars = 400): string | null {
    try {
      const p = path.join(row.log_dir, 'stderr.log');
      const size = fs.statSync(p).size;
      if (size === 0) return null;
      const readBytes = Math.min(size, 4096);
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(readBytes);
      fs.readSync(fd, buf, 0, readBytes, size - readBytes);
      fs.closeSync(fd);
      const text = redactSecrets(buf.toString('utf8')).replace(/\s+/g, ' ').trim();
      if (!text) return null;
      return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
    } catch {
      return null;
    }
  }

  private safeJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** The backend assigned to a task row (tolerant: unknown/legacy ids fall
   * back to the registry default so old rows keep working). */
  private backendFor(row: WorkerRow): WorkerBackend {
    const id = row.backend_id || this.registry.defaultBackendId;
    return this.registry.has(id) ? this.registry.get(id) : this.registry.get(this.registry.defaultBackendId);
  }

  /** Startup reconciliation: reattach live workers, finalize finished ones,
   *  mark only genuinely-vanished workers interrupted. */
  init(): void {
    this.store.metaIncrement('supervisor_restarts_observed');
    const activeRows = this.store.findActive();
    for (const row of activeRows) {
      if (row.status === 'queued') continue; // will be scheduled below
      this.reconcileRow(row);
    }
    // Workflows: recompute terminal state and re-arm duration budgets.
    for (const wf of this.store.runningWorkflows()) {
      const budget = this.workflowBudget(wf);
      if (budget?.max_duration_seconds) {
        const elapsedMs = Date.now() - Date.parse(wf.created_at);
        const remainingMs = budget.max_duration_seconds * 1000 - elapsedMs;
        if (remainingMs <= 0) {
          this.failWorkflowForBudget(wf.id, `max_duration_seconds: ${budget.max_duration_seconds}s`);
          continue;
        }
        const timer = setTimeout(() => this.failWorkflowForBudget(wf.id, `max_duration_seconds: ${budget.max_duration_seconds}s`), remainingMs);
        timer.unref();
        this.wfDeadlineTimers.set(wf.id, timer);
      }
      this.updateWorkflowState(wf.id);
      // Integration catch-up: tasks that completed but were never integrated
      // (e.g. server stopped between finalize and integration).
      for (const t of this.store.workersInWorkflow(wf.id)) {
        if (
          (t.status === 'completed' || t.status === 'completed_uncommitted') &&
          t.integration_status === 'pending' &&
          t.workspace_type === 'git_worktree' &&
          fs.existsSync(t.worktree_path)
        ) {
          void this.integrateTask(t.id);
        }
      }
    }
    this.schedule();
  }

  /**
   * Durable supervision reconciliation. Losing the in-memory handle is NOT
   * losing the worker:
   *
   *   live pid + matching identity → reattach (keep running)
   *   dead pid + durable final event → finalize normally from the log
   *   dead pid + no terminal evidence → genuinely interrupted
   */
  private reconcileRow(row: WorkerRow): void {
    const stdoutPath = path.join(row.log_dir, 'stdout.jsonl');
    const backend = this.backendFor(row);
    const replay = replayLogFile(stdoutPath, (line) => (backend.parseLine ? backend.parseLine(line) : parseDshLine(line)));

    const marker = backend.processMarker ?? backend.id;
    const alive = isExpectedWorkerProcess(row.pid, row.pid_identity, marker);

    if (alive) {
      // Case 1: worker still running → reattach, never interrupted.
      this.reattachRun(row, replay);
      return;
    }

    if (replay.hasFinal || row.final_text) {
      // Case 2: worker finished while unsupervised → normal finalization.
      this.finalizeFromLog(row, replay);
      return;
    }

    // Case 3: genuinely gone with no terminal evidence → interrupted.
    const patch: Partial<WorkerRow> = {
      pid: null,
      supervision_state: 'detached',
      finished_at: row.finished_at ?? new Date().toISOString(),
      input_tokens: replay.usage.inputTokens,
      output_tokens: replay.usage.outputTokens,
      cache_read_tokens: replay.usage.cacheReadTokens,
      total_tokens_last: replay.usage.lastTotalTokens,
      stdout_parse_offset: replay.offsetBytes,
    };
    if (replay.sessionId && !row.session_id) patch.session_id = replay.sessionId;
    const git = this.collectGitFacts(row);
    if (git.commitHash) patch.commit_hash = git.commitHash;

    this.store.updateWorker(row.id, {
      ...patch,
      status: 'interrupted',
      error: 'worker process disappeared before completion (no final event in durable log)',
    });
    this.store.addEvent(row.id, 'reconcile', 'dead pid, no final evidence → interrupted');
    this.store.metaIncrement('workers_genuinely_interrupted');
    this.finalizeArtifacts(this.get(row.id));
    this.notifyWaiters(row.id);
    this.onTaskTerminal(this.get(row.id));
  }

  /** Case 2: dead process but durable final event → full normal finalization. */
  private finalizeFromLog(row: WorkerRow, replay: ReturnType<typeof replayLogFile>): void {
    const patch: Partial<WorkerRow> = {
      pid: null,
      supervision_state: 'detached',
      input_tokens: replay.usage.inputTokens,
      output_tokens: replay.usage.outputTokens,
      cache_read_tokens: replay.usage.cacheReadTokens,
      total_tokens_last: replay.usage.lastTotalTokens,
      stdout_parse_offset: replay.offsetBytes,
    };
    if (replay.sessionId && !row.session_id) patch.session_id = replay.sessionId;
    if (replay.finalText && !row.final_text) {
      patch.final_text = replay.finalText.slice(0, this.config.finalTextMaxChars);
    }
    this.store.updateWorker(row.id, patch);
    let cur = this.get(row.id);

    // Git finalization (idempotent): commit outstanding changes, integrate.
    if (cur.workspace_type === 'git_worktree' && fs.existsSync(cur.worktree_path)) {
      const headBefore = cur.workspace_base_commit ?? cur.base_ref;
      const fin = this.finalizeGitChanges(cur, headBefore, cur.final_text);
      this.recordGitFinalize(cur.id, {
        headBefore,
        headAfter: currentHead(cur.worktree_path),
        workerCommitted: fin.workerCommitted,
        supervisorCommitted: fin.supervisorCommitted,
        createdBy: fin.workerCommitted && fin.supervisorCommitted ? 'worker+supervisor' : fin.workerCommitted ? 'worker' : fin.supervisorCommitted ? 'supervisor' : null,
        error: fin.commitError,
        reconciled: true,
      });
      cur = this.get(row.id);
      const git = this.collectGitFacts(cur);

      // Record run commits + integrate (idempotent via integrated_commits).
      if (cur.workflow_id && headBefore) {
        const newCommits = revListRange(cur.worktree_path, headBefore);
        if (newCommits.length > 0) {
          const prevCommits = parseJsonArray(cur.task_commits);
          const merged = [...new Set([...prevCommits, ...newCommits])];
          this.store.updateWorker(cur.id, { task_commits: JSON.stringify(merged) });
        }
      }
      const gitStatus: WorkerStatus = fin.commitError && git.dirty
        ? 'completed_uncommitted'
        : git.dirty
          ? 'completed_uncommitted'
          : 'completed';
      this.store.updateWorker(cur.id, {
        status: gitStatus,
        commit_hash: git.commitHash ?? cur.commit_hash,
        error: fin.commitError,
        finished_at: new Date().toISOString(),
        exit_code: null, // unknown — process was already gone; never fabricate
      });
      this.store.addEvent(cur.id, 'reconcile', `durable final found → ${gitStatus}`);
    } else {
      this.store.updateWorker(cur.id, {
        status: 'completed',
        finished_at: new Date().toISOString(),
        exit_code: null,
      });
      this.store.addEvent(cur.id, 'reconcile', 'durable final found → completed');
    }

    // Attempt record (idempotent: once per attempt number).
    const attempts = this.store.listAttempts(row.id);
    if (!attempts.some((a) => a.attempt === row.attempt)) {
      this.store.addAttempt({
        task_id: row.id,
        attempt: row.attempt,
        started_at: row.run_started_at ?? row.started_at,
        finished_at: new Date().toISOString(),
        exit_code: null,
        status: this.get(row.id).status,
        input_tokens: replay.usage.inputTokens,
        output_tokens: replay.usage.outputTokens,
        cache_read_tokens: replay.usage.cacheReadTokens,
        error: null,
      });
    }

    this.finalizeArtifacts(this.get(row.id));
    this.notifyWaiters(row.id);
    const done = this.get(row.id);
    if (
      done.workflow_id &&
      done.workspace_type === 'git_worktree' &&
      (done.status === 'completed' || done.status === 'completed_uncommitted')
    ) {
      // Integration AFTER status, before dependents promote.
      void this.integrateTask(row.id).finally(() => this.onTaskTerminal(this.get(row.id)));
    } else {
      this.onTaskTerminal(done);
    }
  }

  /** Case 1: the worker process is still alive — reattach supervision. */
  private reattachRun(row: WorkerRow, replay: ReturnType<typeof replayLogFile>): void {
    const usage = new UsageTracker();
    usage.inputTokens = replay.usage.inputTokens;
    usage.outputTokens = replay.usage.outputTokens;
    usage.cacheReadTokens = replay.usage.cacheReadTokens;
    usage.lastTotalTokens = replay.usage.lastTotalTokens;

    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));

    const handle = new DetachedHandle(row.pid!);
    const run: ActiveRun = {
      handle,
      usage,
      intent: 'run',
      timeoutTimer: null,
      headBeforeRun: row.workspace_base_commit ?? row.base_ref ?? null,
      toolCalls: replay.toolCalls,
      lastTurn: replay.lastTurn,
      startedAt: row.run_started_at ?? row.started_at ?? new Date().toISOString(),
      done,
      resolveDone,
      detached: true,
      tailTimer: null,
      tailOffset: replay.offsetBytes,
      backend: this.backendFor(row),
    };
    this.active.set(row.id, run);

    this.store.updateWorker(row.id, {
      supervision_state: 'reattached',
      status: 'running',
      session_id: row.session_id ?? replay.sessionId,
      stdout_parse_offset: replay.offsetBytes,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_tokens: usage.cacheReadTokens,
      total_tokens_last: usage.lastTotalTokens,
    });
    this.store.addEvent(row.id, 'reattach', `pid=${row.pid} offset=${replay.offsetBytes}`);
    this.store.metaIncrement('workers_reattached');

    // Restore execution timeout from the ORIGINAL run start (never reset).
    const timeoutSeconds = row.timeout_seconds ?? this.config.defaultTimeoutSeconds;
    const deadlineMs = Date.parse(run.startedAt) + timeoutSeconds * 1000;
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      run.intent = 'timeout';
      this.store.addEvent(row.id, 'timeout', `deadline passed during supervisor downtime; terminating`);
      void handle.terminate(this.config.terminateGraceMs);
    } else {
      run.timeoutTimer = setTimeout(() => {
        const r = this.active.get(row.id);
        if (!r) return;
        r.intent = 'timeout';
        this.store.addEvent(row.id, 'timeout', `exceeded ${timeoutSeconds}s (incl. supervisor downtime); terminating`);
        void r.handle.terminate(this.config.terminateGraceMs);
      }, remaining);
      run.timeoutTimer.unref();
    }

    // Reattached: no ChildProcess handle — detect exit via pid liveness.
    this.startTailer(row.id, run, true);
  }

  /**
   * Shared durable-log tailer: parses complete JSONL records from the file
   * from the run's tailOffset (never mid-line), updates counters, and
   * optionally detects process exit via pid liveness (reattached runs).
   * Correctness over purity: 500ms poll, no fragile fs.watch assumptions.
   */
  /** Drain new complete JSONL records from the durable log into the run. */
  private drainLog(workerId: string, run: ActiveRun): void {
    const row = this.store.getWorker(workerId);
    if (!row) return;
    const stdoutPath = path.join(row.log_dir, 'stdout.jsonl');
    const size = fs.existsSync(stdoutPath) ? fs.statSync(stdoutPath).size : 0;
    let offset = run.tailOffset ?? 0;
    if (size <= offset) return;
    const fd = fs.openSync(stdoutPath, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    const chunk = buf.toString('utf8');
    const lines = chunk.split('\n');
    // Last element is the partial/empty tail — leave it for next time.
    const parseLine =
      run.backend?.parseLine ? (line: string) => run.backend!.parseLine!(line) : parseDshLine;
    for (const line of lines.slice(0, -1)) {
      offset += Buffer.byteLength(line, 'utf8') + 1;
      const ev = parseLine(line);
      if (ev) {
        ev.byteOffset = offset;
        this.handleEvent(workerId, ev, run.usage);
      }
    }
    run.tailOffset = offset;
    this.store.updateWorker(workerId, { stdout_parse_offset: offset });
  }

  private startTailer(workerId: string, run: ActiveRun, watchPid: boolean): void {
    const row = this.store.getWorker(workerId);
    if (!row) return;
    const pid = row.pid;

    const drain = () => this.drainLog(workerId, run);

    const poll = () => {
      if (this.shutDown) return;
      if (this.active.get(workerId) !== run) return; // superseded
      try {
        drain();
      } catch {
        /* read race — retry next poll */
      }
      if (watchPid && pid && !pidAlive(pid)) {
        // Process gone: final drain on the next tick, then finalize with an
        // UNKNOWN exit code (null — never fabricated).
        setTimeout(() => {
          try {
            drain();
          } catch {
            /* ignore */
          }
          void this.finalize(workerId, null, null).finally(() => {
            if (this.active.get(workerId) === run) this.active.delete(workerId);
            if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
            run.resolveDone();
            this.schedule();
          });
        }, 100).unref();
        return;
      }
      run.tailTimer = setTimeout(poll, 500);
      run.tailTimer.unref();
    };
    poll();
  }

  /* ------------------------------------------------------------------ *
   * Spawning
   * ------------------------------------------------------------------ */

  spawnTask(params: SpawnTaskParams): SpawnTaskResult {
    return this.spawnTaskInternal(params, null);
  }

  /**
   * Internal spawn. When `workflowWorkspace` is given, the task uses the
   * workflow's shared workspace instead of planning its own.
   */
  spawnTaskInternal(
    params: SpawnTaskParams,
    workflowCtx: {
      workflow: WorkflowRow;
      taskKey: string;
      dependsOnIds: string[];
      dependencyPolicy: string;
    } | null,
  ): SpawnTaskResult {
    if (!params.task || params.task.trim() === '') {
      throw new Error('task must be a non-empty string');
    }
    const mode = parseTaskMode(params.mode);
    const wsInput = params.workspace ?? {};
    if (wsInput.type !== undefined && !isWorkspaceType(wsInput.type)) {
      throw new Error(`invalid workspace.type: ${JSON.stringify(wsInput.type)}`);
    }
    const resolved = resolveModeAndWorkspace(mode, wsInput);

    let timeoutSeconds = params.timeout_seconds ?? this.config.defaultTimeoutSeconds;
    if (params.budget?.max_duration_seconds) {
      timeoutSeconds = Math.min(timeoutSeconds, params.budget.max_duration_seconds);
    }
    if (timeoutSeconds <= 0) throw new Error('timeout_seconds must be positive');
    if (timeoutSeconds > this.config.maxTimeoutSeconds) timeoutSeconds = this.config.maxTimeoutSeconds;

    const deliverables = sanitizeDeliverables(params.deliverables);
    const capabilities = sanitizeCapabilities(params.capabilities);

    // Role template: validates the name and merges role defaults
    // (explicit caller values win on duplicates via Set semantics).
    if (params.role !== undefined && params.role !== null) {
      const role = getRole(params.role);
      if (!role) throw new Error(`unknown role: ${JSON.stringify(params.role)} (see list_roles)`);
      for (const d of role.defaultDeliverables) if (!deliverables.includes(d)) deliverables.push(d);
      for (const c of role.defaultCapabilities) if (!capabilities.includes(c)) capabilities.push(c);
    }

    // Dependencies (standalone tasks reference existing task ids directly).
    const dependsOn = workflowCtx ? workflowCtx.dependsOnIds : [...new Set(params.depends_on ?? [])];
    const dependencyPolicy = workflowCtx
      ? workflowCtx.dependencyPolicy
      : (params.dependency_policy ?? 'all_success');
    if (dependencyPolicy !== 'all_success' && dependencyPolicy !== 'all_terminal') {
      throw new Error(`invalid dependency_policy: ${JSON.stringify(dependencyPolicy)}`);
    }
    for (const dep of dependsOn) {
      const depRow = this.store.getWorker(dep);
      if (!depRow) throw new Error(`unknown dependency task: ${dep}`);
      if (depRow.status === 'cancelled' && dependencyPolicy === 'all_success') {
        // Still allowed: the dependency will simply never succeed → this task
        // becomes blocked. Validated upfront for clearer feedback.
      }
    }

    const priority = params.priority ?? 'normal';
    if (!['low', 'normal', 'high'].includes(priority)) {
      throw new Error(`invalid priority: ${JSON.stringify(priority)}`);
    }
    const cachePolicy = params.cache_policy ?? 'off';
    if (!['off', 'read', 'read_write', 'refresh'].includes(cachePolicy)) {
      throw new Error(`invalid cache_policy: ${JSON.stringify(cachePolicy)}`);
    }
    const maxAttempts = params.retry?.max_attempts ?? 1;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
      throw new Error('retry.max_attempts must be an integer between 1 and 5');
    }
    const retryOn = params.retry?.retry_on ?? ['failed', 'timeout'];

    // Backend routing: explicit task choice > role rule > config default > dsh.
    // Availability is verified here (local check only, no API calls). There
    // is deliberately NO automatic fallback to another backend.
    const backend = this.registry.resolveAvailable({ backend: params.backend, role: params.role ?? null });

    // Per-task model selection (backend capability gated — never silently ignored).
    const model = params.model?.trim() || null;
    if (model && !backend.capabilities.modelSelection) {
      throw new Error(`backend "${backend.id}" does not support per-task model selection`);
    }

    // Unique worker id (collision-proof against the db).
    let id = newWorkerId();
    while (this.store.getWorker(id) !== null) id = newWorkerId();

    let plan: PlannedWorkspace;
    let taskBranch: string | null = null;
    let integrationStatus: string | null = null;
    if (workflowCtx) {
      const wf = workflowCtx.workflow;
      if (wf.workspace_type === 'git_worktree') {
        // Parallel Git isolation: every workflow task gets its OWN worktree
        // and branch (workforce/task/<id>), materialized lazily at run start from
        // the then-current integration HEAD. The workflow-level workspace is
        // the integration worktree (workforce/workflow/<wf>) — workers never touch
        // it directly.
        plan = {
          type: 'git_worktree',
          cwd: path.join(wf.log_dir, 'tasks', id, 'worktree'),
          artifactRoot: path.join(wf.log_dir, 'tasks', id, 'worktree'),
          logDir: path.join(wf.log_dir, 'tasks', id),
          repoPath: wf.repo_path,
          baseRef: wf.base_ref, // refined to the snapshot commit at materialization
          branch: '',
        };
        taskBranch = `workforce/task/${id}`;
        integrationStatus = 'pending';
      } else {
        // Non-git workflows: shared workspace (unchanged semantics).
        plan = {
          type: wf.workspace_type as WorkspaceType,
          cwd: wf.workspace_path,
          artifactRoot: wf.workspace_path,
          logDir: path.join(wf.log_dir, 'tasks', id),
          repoPath: wf.repo_path,
          baseRef: wf.base_ref,
          branch: wf.branch,
        };
      }
    } else {
      plan = planWorkspace(resolved.type, wsInput, { workerRoot: this.config.workerRoot, workerId: id });
      prepareWorkspace(plan);
    }
    fs.mkdirSync(plan.logDir, { recursive: true, mode: 0o700 });

    this.store.createWorker({
      id,
      repo_path: plan.repoPath,
      base_ref: plan.baseRef,
      branch: plan.branch,
      worktree_path: plan.cwd,
      log_dir: plan.logDir,
      task: params.task,
      mode: resolved.mode,
      workspace_type: plan.type,
      deliverables: JSON.stringify(deliverables),
      capabilities: JSON.stringify(capabilities),
      timeout_seconds: timeoutSeconds,
      workflow_id: workflowCtx?.workflow.id ?? null,
      task_key: workflowCtx?.taskKey ?? null,
      depends_on: JSON.stringify(dependsOn),
      dependency_policy: dependencyPolicy,
      role: params.role ?? null,
      priority,
      cache_policy: cachePolicy,
      execution_class: params.execution_class ?? null,
      budget: params.budget ? JSON.stringify(params.budget) : null,
      max_attempts: maxAttempts,
      retry_on: JSON.stringify(retryOn),
      initialStatus: dependsOn.length > 0 ? 'waiting_dependencies' : 'queued',
      backend_id: backend.id,
      backend_metadata: JSON.stringify(this.backendMetadataFor(backend, model)),
      model,
    });
    if (taskBranch || integrationStatus) {
      this.store.updateWorker(id, {
        ...(taskBranch ? { task_branch: taskBranch } : {}),
        ...(integrationStatus ? { integration_status: integrationStatus } : {}),
      });
    }
    this.store.addEvent(
      id,
      'spawn',
      `mode=${resolved.mode} workspace=${plan.type}${plan.branch ? ` branch=${plan.branch}` : ''}${dependsOn.length ? ` deps=${dependsOn.join(',')}` : ''}${params.role ? ` role=${params.role}` : ''}`,
    );

    // Artifact/analysis cache (opt-in). Only for dependency-free tasks —
    // the fingerprint cannot capture upstream artifacts of dependencies.
    let cacheInfo: SpawnTaskResult['cache'];
    if (cachePolicy !== 'off') {
      const fingerprint = workspaceFingerprint(plan.type, plan.cwd);
      const key = computeCacheKey({
        mode: resolved.mode,
        role: params.role ?? null,
        roleFragment: params.role ? (getRole(params.role)?.promptFragment ?? null) : null,
        task: params.task,
        fingerprint,
        backendId: backend.id,
        model,
      });
      // Persisted so finalize can write the entry even after a restart.
      this.store.addEvent(id, 'cache_key', JSON.stringify({ key, fingerprint }));

      if (cachePolicy === 'read' || cachePolicy === 'read_write') {
        const hit = this.store.cacheGet(key);
        if (hit) {
          const src = this.store.getWorker(hit.task_id);
          const srcRoot = src?.worktree_path;
          if (src && src.status === 'completed' && srcRoot && fs.existsSync(srcRoot)) {
            // Reuse the source task's artifacts: copy them into this task's
            // workspace and index them. No new DSH session is created.
            let copied = 0;
            let bytes = 0;
            for (const a of this.store.listArtifacts(src.id)) {
              if (!fs.existsSync(a.absolute_path)) continue;
              try {
                const dest = resolveUnderRoot(plan.artifactRoot, a.relative_path);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.copyFileSync(a.absolute_path, dest);
                const st = fs.statSync(dest);
                this.store.upsertArtifact({
                  task_id: id,
                  relative_path: a.relative_path,
                  absolute_path: dest,
                  mime_type: a.mime_type,
                  size_bytes: st.size,
                  sha256: sha256File(dest),
                });
                copied++;
                bytes += st.size;
              } catch {
                /* skip single artifact copy failure */
              }
            }
            this.store.cacheHit(key);
            const now = new Date().toISOString();
            this.store.updateWorker(id, {
              status: 'completed',
              started_at: now,
              finished_at: now,
              final_text: src.final_text,
            });
            this.store.addEvent(id, 'cache_hit', `source=${hit.task_id} artifacts=${copied}`);
            this.notifyWaiters(id);
            this.onTaskTerminal(this.get(id));
            cacheInfo = {
              hit: true,
              source_task_id: hit.task_id,
              age_seconds: Math.round((Date.now() - Date.parse(hit.created_at)) / 1000),
              artifacts_reused: copied,
              artifact_bytes: bytes,
            };
          } else {
            this.store.addEvent(id, 'cache_stale', `source task ${hit.task_id} unusable; executing normally`);
          }
        }
      }
    }

    let row = this.get(id)!;
    if (!cacheInfo) {
      this.schedule();
    }

    return {
      task_id: id,
      status: row.status,
      mode: resolved.mode,
      workspace: { type: plan.type, path: plan.cwd },
      branch: plan.branch || null,
      session_id: row.session_id,
      queued: row.status === 'queued',
      backend: backend.id,
      model,
      ...(cacheInfo ? { cache: cacheInfo } : {}),
    };
  }

  /** Legacy code-worker spawn — identical behavior to the original API. */
  spawn(params: SpawnParams): SpawnResult {
    const r = this.spawnTask({
      task: params.task,
      mode: 'code',
      workspace: { type: 'git_worktree', repo_path: params.repo_path, base_ref: params.base_ref },
      timeout_seconds: params.timeout_seconds,
    });
    return {
      worker_id: r.task_id,
      status: r.status,
      branch: r.branch ?? '',
      worktree: r.workspace.path,
      session_id: null,
      queued: r.queued,
    };
  }

  get(workerId: string): WorkerRow {
    const row = this.store.getWorker(workerId);
    if (!row) throw new Error(`unknown worker: ${workerId}`);
    return row;
  }

  list(filter: ListFilter): WorkerRow[] {
    return this.store.listWorkers(filter);
  }

  /** Used by tests/CLI: resolves when the worker's runs (incl. chained follow-ups) finalize. */
  async waitFor(workerId: string): Promise<WorkerRow> {
    for (;;) {
      const run = this.active.get(workerId);
      if (!run) break;
      await run.done;
    }
    return this.get(workerId);
  }

  async waitForAll(): Promise<void> {
    await Promise.all([...this.active.values()].map((r) => r.done));
  }

  /* ------------------------------------------------------------------ *
   * Event-driven waiting (wait_task / wait_tasks)
   *
   * Waiters are notified synchronously from every terminal-state
   * transition (finalize, cancel, spawn-failure, reconciliation).
   * No locks are involved and waiters never hold supervisor state, so a
   * pending wait can never block worker completion (no deadlock).
   *
   * A low-frequency re-check (every WAIT_RECHECK_MS at most) is kept as a
   * fallback for terminal transitions performed by OTHER processes
   * (e.g. `workforce-mcp cancel` from the CLI), which cannot notify
   * this process's in-memory waiters.
   * ------------------------------------------------------------------ */

  private notifyWaiters(workerId: string): void {
    const set = this.waiters.get(workerId);
    if (!set) return;
    this.waiters.delete(workerId);
    for (const cb of set) cb();
  }

  private addWaiter(workerId: string, cb: () => void): () => void {
    let set = this.waiters.get(workerId);
    if (!set) {
      set = new Set();
      this.waiters.set(workerId, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.waiters.delete(workerId);
    };
  }

  /** Wait until `workerId` is terminal or the deadline passes. Never throws for unknown ids (get() does that first). */
  private async waitForRowTerminal(workerId: string, deadlineMs: number): Promise<WorkerRow> {
    for (;;) {
      const row = this.get(workerId);
      if (isTerminal(row.status) || Date.now() >= deadlineMs) return row;
      await new Promise<void>((resolve) => {
        const remaining = deadlineMs - Date.now();
        let remove: () => void = () => {};
        const timer = setTimeout(() => {
          remove();
          resolve();
        }, Math.min(remaining, WAIT_RECHECK_MS));
        timer.unref();
        remove = this.addWaiter(workerId, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Wait until the set condition is met (all/any terminal) or the deadline passes. */
  private async waitForRowSet(
    workerIds: string[],
    returnWhen: 'all' | 'any',
    deadlineMs: number,
  ): Promise<{ rows: WorkerRow[]; triggered: string[] }> {
    for (;;) {
      const rows = workerIds.map((id) => this.get(id));
      const terminalIds = rows.filter((r) => isTerminal(r.status)).map((r) => r.id);
      const done = returnWhen === 'all' ? terminalIds.length === rows.length : terminalIds.length > 0;
      if (done || Date.now() >= deadlineMs) {
        return { rows, triggered: terminalIds };
      }
      await new Promise<void>((resolve) => {
        const remaining = deadlineMs - Date.now();
        const removes: Array<() => void> = [];
        let fired = false;
        const finish = () => {
          if (fired) return;
          fired = true;
          clearTimeout(timer);
          for (const rm of removes) rm();
          resolve();
        };
        const timer = setTimeout(finish, Math.min(remaining, WAIT_RECHECK_MS));
        timer.unref();
        for (const id of workerIds) {
          removes.push(this.addWaiter(id, finish));
        }
      });
    }
  }

  /** wait_task: block until one task is terminal or the wait times out. */
  async waitTask(taskId: string, timeoutSeconds?: number): Promise<Record<string, unknown>> {
    this.get(taskId); // validates existence (throws on unknown id)
    const timeout = validateWaitTimeout(timeoutSeconds, WAIT_DEFAULT_SECONDS);
    const start = Date.now();
    const deadline = start + timeout * 1000;

    const row = await this.waitForRowTerminal(taskId, deadline);
    const waitedMs = Date.now() - start;
    const terminal = isTerminal(row.status);

    const out: Record<string, unknown> = {
      task_id: row.id,
      status: row.status,
      wait: {
        completed: terminal,
        timed_out: !terminal,
        waited_seconds: Math.round(waitedMs / 100) / 10,
        waited_ms: waitedMs,
      },
    };
    if (terminal) {
      out['result'] = this.taskResult(taskId);
    }
    return out;
  }

  /** wait_tasks: block until all/any of a set of tasks reach terminal state. */
  async waitTasks(
    taskIds: string[],
    returnWhen: 'all' | 'any' = 'all',
    timeoutSeconds?: number,
  ): Promise<Record<string, unknown>> {
    const ids = [...new Set(taskIds)];
    if (ids.length === 0) throw new Error('task_ids must contain at least one id');
    if (ids.length > WAIT_MAX_TASKS) throw new Error(`task_ids too large: max ${WAIT_MAX_TASKS}`);
    for (const id of ids) this.get(id); // validates existence

    const timeout = validateWaitTimeout(timeoutSeconds, WAIT_TASKS_DEFAULT_SECONDS);
    const start = Date.now();
    const deadline = start + timeout * 1000;

    const { rows, triggered } = await this.waitForRowSet(ids, returnWhen, deadline);
    const waitedMs = Date.now() - start;
    const terminalCount = rows.filter((r) => isTerminal(r.status)).length;
    const completedCondition = returnWhen === 'all' ? terminalCount === rows.length : terminalCount > 0;

    const out: Record<string, unknown> = {
      return_when: returnWhen,
      completed_condition: completedCondition,
      timed_out: !completedCondition,
      waited_seconds: Math.round(waitedMs / 100) / 10,
      waited_ms: waitedMs,
      tasks: rows.map((r) => {
        const entry: Record<string, unknown> = {
          task_id: r.id,
          status: r.status,
          terminal: isTerminal(r.status),
        };
        if (isTerminal(r.status)) {
          entry['summary'] = summarizeFinalText(r.final_text).summary;
        }
        if (r.error) entry['error'] = redactSecrets(r.error);
        return entry;
      }),
    };
    if (returnWhen === 'any') {
      out['triggered_by'] = triggered;
    }
    return out;
  }

  /** spawn_tasks: batch spawn of independent tasks. Per-item success/error, no rollback. */
  spawnTasks(tasks: SpawnTaskParams[]): Record<string, unknown> {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error('tasks must be a non-empty array');
    }
    if (tasks.length > SPAWN_TASKS_MAX) {
      throw new Error(`too many tasks in one batch: max ${SPAWN_TASKS_MAX}`);
    }
    const results = tasks.map((t, i) => {
      try {
        const r = this.spawnTask(t);
        return { index: i, ok: true as const, task_id: r.task_id, status: r.status, mode: r.mode, workspace: r.workspace, branch: r.branch };
      } catch (err) {
        return { index: i, ok: false as const, error: (err as Error).message };
      }
    });
    return {
      spawned: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      tasks: results,
    };
  }

  /* ------------------------------------------------------------------ *
   * Workflows: orchestration containers over task DAGs
   * ------------------------------------------------------------------ */

  private wfDeadlineTimers = new Map<string, NodeJS.Timeout>();

  /** Detect cycles in a key→dependency-keys graph. Returns a cycle path or null. */
  static detectCycle(edges: Map<string, string[]>): string[] | null {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    const stack: string[] = [];
    const dfs = (node: string): string[] | null => {
      color.set(node, GRAY);
      stack.push(node);
      for (const dep of edges.get(node) ?? []) {
        const c = color.get(dep) ?? WHITE;
        if (c === GRAY) {
          const idx = stack.indexOf(dep);
          return [...stack.slice(idx), dep];
        }
        if (c === WHITE) {
          const found = dfs(dep);
          if (found) return found;
        }
      }
      stack.pop();
      color.set(node, BLACK);
      return null;
    };
    for (const node of edges.keys()) {
      if ((color.get(node) ?? WHITE) === WHITE) {
        const found = dfs(node);
        if (found) return found;
      }
    }
    return null;
  }

  createWorkflow(input: {
    name?: string | undefined;
    tasks: Array<WorkflowTaskInput & SpawnTaskParams>;
    budget?: WorkflowBudget | undefined;
    metadata?: Record<string, unknown> | undefined;
    preset?: string | undefined;
    failure_policy?: string | undefined;
    workspace?: WorkspaceInput | undefined;
  }): Record<string, unknown> {
    const tasks = input.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('tasks must be a non-empty array');
    const budget = input.budget ?? {};
    if (budget.max_tasks && tasks.length > budget.max_tasks) {
      throw new Error(`workflow has ${tasks.length} tasks, exceeding budget.max_tasks=${budget.max_tasks}`);
    }

    // Key validation + deterministic cycle detection on the key graph.
    const keys = new Set<string>();
    for (const t of tasks) {
      if (!t.key || !/^[a-zA-Z0-9_-]{1,64}$/.test(t.key)) {
        throw new Error(`invalid task key: ${JSON.stringify(t.key)} (use 1-64 chars of [a-zA-Z0-9_-])`);
      }
      if (keys.has(t.key)) throw new Error(`duplicate task key: ${t.key}`);
      keys.add(t.key);
    }
    const edges = new Map<string, string[]>();
    for (const t of tasks) {
      const deps = t.depends_on ?? [];
      for (const d of deps) {
        if (!keys.has(d)) throw new Error(`task ${t.key} depends on unknown key: ${d}`);
      }
      edges.set(t.key, [...deps]);
    }
    const cycle = WorkerSupervisor.detectCycle(edges);
    if (cycle) {
      throw new Error(`dependency cycle detected: ${cycle.join(' → ')}`);
    }

    const failurePolicy = input.failure_policy ?? 'stop_dependents';
    if (!['continue', 'stop_dependents', 'cancel_remaining'].includes(failurePolicy)) {
      throw new Error(`invalid failure_policy: ${JSON.stringify(failurePolicy)}`);
    }

    let wfId = `wf_${newWorkerId().slice(3)}`;
    while (this.store.getWorkflow(wfId) !== null) wfId = `wf_${newWorkerId().slice(3)}`;

    // One shared workspace per workflow — dependents see upstream artifacts,
    // and git workflows get a single branch the supervisor commits onto.
    const wsInput = input.workspace ?? {};
    const wsType = wsInput.type ?? (wsInput.repo_path ? 'git_worktree' : wsInput.path ? 'directory' : 'temporary');
    const plan = planWorkflowWorkspace(wsType, wsInput, this.config.workerRoot, wfId);
    prepareWorkflowWorkspace(plan);

    const wf = this.store.createWorkflow({
      id: wfId,
      name: input.name ?? null,
      failure_policy: failurePolicy,
      budget: Object.keys(budget).length ? JSON.stringify(budget) : null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      preset: input.preset ?? null,
      workspace_type: plan.type,
      workspace_path: plan.cwd,
      repo_path: plan.repoPath,
      base_ref: plan.baseRef,
      branch: plan.branch,
      log_dir: plan.logDir,
    });

    const mapping: Record<string, string> = {};
    try {
      for (const t of tasks) {
        const depIds = (t.depends_on ?? []).map((k) => mapping[k]!);
        const spawned = this.spawnTaskInternal(
          { ...t },
          {
            workflow: wf,
            taskKey: t.key,
            dependsOnIds: depIds,
            dependencyPolicy: t.dependency_policy ?? 'all_success',
          },
        );
        mapping[t.key] = spawned.task_id;
        this.store.addWorkflowTask(wf.id, t.key, spawned.task_id);
      }
    } catch (err) {
      for (const id of Object.values(mapping)) {
        void this.cancelWorker(id).catch(() => {});
      }
      this.store.updateWorkflow(wf.id, { status: 'failed', finished_at: new Date().toISOString() });
      throw err;
    }

    if (budget.max_duration_seconds) {
      const timer = setTimeout(
        () => this.failWorkflowForBudget(wf.id, `max_duration_seconds: ${budget.max_duration_seconds}s`),
        budget.max_duration_seconds * 1000,
      );
      timer.unref();
      this.wfDeadlineTimers.set(wf.id, timer);
    }

    this.store.addEvent(wf.id, 'workflow', `created with ${tasks.length} tasks`);
    return {
      workflow_id: wf.id,
      status: wf.status,
      tasks: mapping,
      workspace: { type: plan.type, path: plan.cwd },
      branch: plan.branch || null,
    };
  }

  private workflowOverview(wf: WorkflowRow): Record<string, unknown> {
    const mapping = this.store.workflowTaskMap(wf.id);
    const rows = this.store.workersInWorkflow(wf.id);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const progress = { total: rows.length, completed: 0, running: 0, queued: 0, waiting: 0, blocked: 0, other_terminal: 0 };
    const tasks = mapping.map(({ task_key, task_id }) => {
      const r = byId.get(task_id);
      if (!r) return { key: task_key, task_id, status: 'missing' };
      if (r.status === 'completed' || r.status === 'completed_uncommitted') progress.completed++;
      else if (r.status === 'running' || r.status === 'starting') progress.running++;
      else if (r.status === 'queued') progress.queued++;
      else if (r.status === 'waiting_dependencies') progress.waiting++;
      else if (r.status === 'blocked') progress.blocked++;
      else progress.other_terminal++;
      return {
        key: task_key,
        task_id,
        mode: r.mode,
        role: r.role,
        status: r.status,
        acceptance: r.acceptance,
        attempt: r.attempt,
        depends_on: parseJsonArray(r.depends_on).map((d) => mapping.find((m) => m.task_id === d)?.task_key ?? d),
        commit_hash: r.commit_hash ? r.commit_hash.slice(0, 7) : null,
        error: r.error,
      };
    });
    return {
      workflow_id: wf.id,
      name: wf.name,
      status: wf.status,
      preset: wf.preset,
      failure_policy: wf.failure_policy,
      budget: wf.budget ? (JSON.parse(wf.budget) as WorkflowBudget) : null,
      workspace: { type: wf.workspace_type, path: wf.workspace_path },
      branch: wf.branch || null,
      progress,
      tasks,
      created_at: wf.created_at,
      finished_at: wf.finished_at,
    };
  }

  getWorkflow(id: string): Record<string, unknown> {
    const wf = this.store.getWorkflow(id);
    if (!wf) throw new Error(`unknown workflow: ${id}`);
    return this.workflowOverview(wf);
  }

  listWorkflows(limit = 20): Array<Record<string, unknown>> {
    return this.store.listWorkflows(limit).map((wf) => this.workflowOverview(wf));
  }

  async waitWorkflow(id: string, timeoutSeconds?: number): Promise<Record<string, unknown>> {
    const wf0 = this.store.getWorkflow(id);
    if (!wf0) throw new Error(`unknown workflow: ${id}`);
    const timeout = validateWaitTimeout(timeoutSeconds, WAIT_TASKS_DEFAULT_SECONDS);
    const start = Date.now();
    const deadline = start + timeout * 1000;

    let wf = wf0;
    for (;;) {
      wf = this.store.getWorkflow(id)!;
      if (wf.status !== 'running' || Date.now() >= deadline) break;
      await new Promise<void>((resolve) => {
        const remaining = deadline - Date.now();
        let remove: () => void = () => {};
        const timer = setTimeout(() => {
          remove();
          resolve();
        }, Math.min(remaining, WAIT_RECHECK_MS));
        timer.unref();
        remove = this.addWaiter(id, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const waitedMs = Date.now() - start;
    return {
      ...this.workflowOverview(wf),
      wait: {
        completed: wf.status !== 'running',
        timed_out: wf.status === 'running',
        waited_seconds: Math.round(waitedMs / 100) / 10,
        waited_ms: waitedMs,
      },
    };
  }

  async cancelWorkflow(id: string): Promise<Record<string, unknown>> {
    const wf = this.store.getWorkflow(id);
    if (!wf) throw new Error(`unknown workflow: ${id}`);
    if (wf.status === 'running') {
      this.store.updateWorkflow(id, { status: 'cancelled', finished_at: new Date().toISOString() });
      for (const t of this.store.workersInWorkflow(id)) {
        if (isTerminal(t.status)) continue;
        await this.cancelWorker(t.id);
      }
      this.store.addEvent(id, 'workflow', 'cancelled');
      this.notifyWaiters(id);
      const timer = this.wfDeadlineTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.wfDeadlineTimers.delete(id);
      }
    }
    return { workflow_id: id, status: this.store.getWorkflow(id)!.status };
  }

  /** Compact structured synthesis — no LLM summary; Codex does the final review. */
  workflowResult(id: string): Record<string, unknown> {
    const wf = this.store.getWorkflow(id);
    if (!wf) throw new Error(`unknown workflow: ${id}`);
    const overview = this.workflowOverview(wf);
    const rows = this.store.workersInWorkflow(id);

    const artifacts = rows.flatMap((r) =>
      this.store.listArtifacts(r.id).map((a) => ({
        task_key: r.task_key,
        task_id: r.id,
        path: a.relative_path,
        size_bytes: a.size_bytes,
        mime_type: a.mime_type,
        sha256: a.sha256,
      })),
    );

    const tokens = this.store.tokenSumsForWorkflow(id);
    const warnings: string[] = [];
    for (const r of rows) {
      if (r.status === 'blocked' && r.error) {
        warnings.push(`${r.task_key ?? r.id}: blocked ${redactSecrets(r.error)}`);
      } else if (isTerminal(r.status) && r.status !== 'completed' && r.status !== 'completed_uncommitted') {
        warnings.push(`${r.task_key ?? r.id}: ${r.status}${r.error ? ` — ${redactSecrets(r.error)}` : ''}`);
      }
      const missing = parseJsonArray(r.deliverables_missing);
      if (missing.length) warnings.push(`${r.task_key ?? r.id}: missing deliverables ${missing.join(', ')}`);
    }

    const elapsed = Math.round(((wf.finished_at ? Date.parse(wf.finished_at) : Date.now()) - Date.parse(wf.created_at)) / 1000);

    return {
      workflow_id: wf.id,
      name: wf.name,
      status: wf.status,
      preset: wf.preset,
      tasks: {
        total: rows.length,
        completed: rows.filter((r) => r.status === 'completed' || r.status === 'completed_uncommitted').length,
        failed: rows.filter((r) => isTerminal(r.status) && r.status !== 'completed' && r.status !== 'completed_uncommitted').length,
      },
      task_details: overview['tasks'],
      artifacts,
      metrics: {
        duration_seconds: elapsed,
        tokens: { input: tokens.input, output: tokens.output, cache_read: tokens.cache_read },
        continues: rows.reduce((s, r) => s + r.continue_count, 0),
        attempts: rows.reduce((s, r) => s + r.attempt, 0),
      },
      git: wf.workspace_type === 'git_worktree'
        ? {
            integration_branch: wf.branch,
            repo_path: wf.repo_path,
            base_ref: wf.base_ref,
            integration_head: fs.existsSync(wf.workspace_path) ? currentHead(wf.workspace_path) : null,
            working_tree_clean: fs.existsSync(wf.workspace_path) ? statusPorcelain(wf.workspace_path) === '' : null,
            tasks_integrated: rows.filter((r) => r.integration_status === 'integrated').length,
            integration_conflicts: rows.filter((r) => r.integration_status === 'conflict').length,
          }
        : null,
      warnings,
    };
  }

  /** git diff of a workflow: base ref … integration HEAD. stat-only by default. */
  workflowDiff(wfId: string, opts: { stat_only?: boolean | undefined; path?: string | undefined }): Record<string, unknown> {
    const wf = this.store.getWorkflow(wfId);
    if (!wf) throw new Error(`unknown workflow: ${wfId}`);
    if (wf.workspace_type !== 'git_worktree') {
      throw new Error(`workflow ${wfId} does not use a git worktree (workspace=${wf.workspace_type})`);
    }
    if (!fs.existsSync(wf.workspace_path)) {
      throw new Error(`integration worktree no longer exists for workflow ${wfId}`);
    }
    const statOnly = opts.stat_only ?? true;
    if (opts.path && (opts.path.includes('..') || path.isAbsolute(opts.path))) {
      throw new Error('diff path must be a relative path inside the repo');
    }
    if (statOnly) {
      return {
        workflow_id: wfId,
        stat_only: true,
        base_ref: wf.base_ref,
        integration_branch: wf.branch,
        diff_stat: redactSecrets(diffStat(wf.workspace_path, wf.base_ref, opts.path).trim()),
      };
    }
    const full = diffFull(wf.workspace_path, wf.base_ref, opts.path);
    const t = truncateUtf8(redactSecrets(full), this.config.diffMaxBytes);
    return {
      workflow_id: wfId,
      stat_only: false,
      base_ref: wf.base_ref,
      integration_branch: wf.branch,
      diff: t.text,
      truncated: t.truncated,
    };
  }

  /* ------------------------------ backends ------------------------------ */

  private backendSummary(b: WorkerBackend): Record<string, unknown> {
    const runtime = b.inspectRuntime?.() ?? null;
    return {
      id: b.id,
      display_name: b.displayName,
      available: b.isAvailable(),
      default: b.id === this.registry.defaultBackendId,
      capabilities: b.capabilities,
      metadata: b.metadata?.() ?? null,
      // Model catalog discovered from the runtime's own config (facts only).
      models: runtime?.models ?? [],
      default_model: runtime?.default ?? null,
    };
  }

  listBackends(): Array<Record<string, unknown>> {
    return this.registry.list().map((b) => this.backendSummary(b));
  }

  getBackend(id: string): Record<string, unknown> {
    return this.backendSummary(this.registry.get(id));
  }

  /**
   * Models a backend is configured to serve (local runtime config only — no
   * provider API call, no quota usage). `backend_id` defaults to the router
   * default.
   */
  listModels(backendId?: string): Record<string, unknown> {
    const id = backendId?.trim() || this.registry.defaultBackendId;
    const b = this.registry.get(id);
    const runtime = b.inspectRuntime?.() ?? null;
    return {
      backend: b.id,
      model_selection: b.capabilities.modelSelection,
      available: b.isAvailable(),
      models: runtime?.models ?? [],
      default: runtime?.default ?? null,
      ...(runtime ? {} : { note: 'runtime model catalog unavailable (backend has no local config discovery)' }),
    };
  }

  /* ------------------------------ roles & presets ------------------------------ */

  listRoles(): Array<Record<string, unknown>> {
    return BUILT_IN_ROLES.map((r) => ({
      name: r.name,
      description: r.description,
      preferred_mode: r.preferredMode,
      default_deliverables: r.defaultDeliverables,
      default_capabilities: r.defaultCapabilities,
    }));
  }

  listPresets(): Array<Record<string, unknown>> {
    return WORKFLOW_PRESETS.map((p) => ({
      name: p.name,
      description: p.description,
      workspace: p.workspace,
      task_count: p.build('<goal>').length,
      graph: p.build('<goal>').map((t) => ({ key: t.key, mode: t.mode, role: t.role, depends_on: t.depends_on ?? [] })),
    }));
  }

  runWorkflowPreset(input: {
    preset: string;
    goal: string;
    workspace?: WorkspaceInput | undefined;
    budget?: WorkflowBudget | undefined;
    failure_policy?: string | undefined;
    options?: { dry_run?: boolean } | undefined;
  }): Record<string, unknown> {
    const preset = getPreset(input.preset);
    if (!preset) {
      throw new Error(`unknown preset: ${JSON.stringify(input.preset)} (available: ${presetNames().join(', ')})`);
    }
    if (!input.goal || input.goal.trim() === '') {
      throw new Error('goal must be a non-empty string');
    }
    const tasks = preset.build(input.goal);
    const workspace = input.workspace ?? (preset.workspace === 'git_worktree'
      ? null
      : { type: preset.workspace });
    if (workspace === null) {
      throw new Error(`preset ${preset.name} needs a git workspace: pass workspace.repo_path`);
    }

    if (input.options?.dry_run) {
      return {
        dry_run: true,
        preset: preset.name,
        description: preset.description,
        workspace,
        tasks: tasks.map((t) => ({
          key: t.key,
          mode: t.mode,
          role: t.role,
          depends_on: t.depends_on ?? [],
          dependency_policy: t.dependency_policy ?? 'all_success',
          deliverables: t.deliverables ?? [],
          cache_policy: t.cache_policy ?? 'off',
          task: t.task,
        })),
      };
    }

    const wf = this.createWorkflow({
      name: `${preset.name}: ${input.goal.slice(0, 80)}`,
      preset: preset.name,
      tasks,
      workspace,
      budget: input.budget,
      failure_policy: input.failure_policy,
    });
    return { preset: preset.name, ...wf };
  }

  /* ------------------------------ acceptance & metrics ------------------------------ */

  /**
   * Record a review decision for a completed task. This is Codex's
   * acceptance state, NOT the execution status. needs_revision never
   * auto-continues the worker — Codex decides and calls continue_worker.
   */
  reviewTaskResult(taskId: string, decision: string, feedback?: string): Record<string, unknown> {
    const row = this.get(taskId);
    if (!isTerminal(row.status)) {
      throw new Error(`task ${taskId} is still ${row.status}; review only terminal tasks`);
    }
    if (!['accepted', 'rejected', 'needs_revision'].includes(decision)) {
      throw new Error(`invalid decision: ${JSON.stringify(decision)} (accepted|rejected|needs_revision)`);
    }
    this.store.addReview(taskId, decision, feedback ?? null);
    this.store.updateWorker(taskId, { acceptance: decision });
    this.store.addEvent(taskId, 'review', `${decision}${feedback ? `: ${feedback.slice(0, 200)}` : ''}`);
    return {
      task_id: taskId,
      acceptance: decision,
      status: row.status,
      note: decision === 'needs_revision' ? 'call continue_worker with rework instructions when ready' : null,
    };
  }

  taskMetrics(taskId: string): Record<string, unknown> {
    const row = this.get(taskId);
    const events = this.store.listEvents(taskId, 100000);
    const toolCalls = events.filter((e) => e.type === 'tool_call');
    const byTool: Record<string, number> = {};
    for (const e of toolCalls) {
      const tool = (e.summary ?? '?').split(' (')[0] ?? '?';
      byTool[tool] = (byTool[tool] ?? 0) + 1;
    }
    const artifacts = this.store.listArtifacts(taskId);
    const gitCommits = row.workspace_type === 'git_worktree' && row.base_ref && fs.existsSync(row.worktree_path)
      ? commitsAhead(row.worktree_path, row.base_ref)
      : 0;
    return {
      task_id: taskId,
      mode: row.mode,
      role: row.role,
      status: row.status,
      acceptance: row.acceptance,
      duration_seconds: elapsedSeconds(row),
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_read_tokens: row.cache_read_tokens,
      total_tokens_last: row.total_tokens_last,
      steps: events.filter((e) => e.type === 'status' && e.summary === 'step_end').length,
      tool_calls: toolCalls.length,
      tool_calls_by_tool: byTool,
      continues: row.continue_count,
      attempts: row.attempt,
      artifact_count: artifacts.length,
      artifact_bytes: artifacts.reduce((s, a) => s + a.size_bytes, 0),
      git_commits: gitCommits,
      budget: row.budget ? JSON.parse(row.budget) : null,
    };
  }

  workflowMetrics(wfId: string): Record<string, unknown> {
    const wf = this.store.getWorkflow(wfId);
    if (!wf) throw new Error(`unknown workflow: ${wfId}`);
    const rows = this.store.workersInWorkflow(wfId);
    const tokens = this.store.tokenSumsForWorkflow(wfId);
    const perTask = rows.map((r) => ({
      key: r.task_key,
      task_id: r.id,
      mode: r.mode,
      role: r.role,
      status: r.status,
      acceptance: r.acceptance,
      duration_seconds: elapsedSeconds(r),
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens,
      attempts: r.attempt,
      continues: r.continue_count,
    }));
    return {
      workflow_id: wfId,
      status: wf.status,
      duration_seconds: Math.round(((wf.finished_at ? Date.parse(wf.finished_at) : Date.now()) - Date.parse(wf.created_at)) / 1000),
      tokens: { input: tokens.input, output: tokens.output, cache_read: tokens.cache_read },
      tasks: perTask.length,
      attempts: rows.reduce((s, r) => s + r.attempt, 0),
      continues: rows.reduce((s, r) => s + r.continue_count, 0),
      per_task: perTask,
    };
  }

  /** System-wide aggregate, SQL-driven (no log scanning). */
  systemMetrics(): Record<string, unknown> {
    const counts = this.store.statusCounts();
    const tokens = this.store.tokenSums();
    const active = (counts['running'] ?? 0) + (counts['starting'] ?? 0);
    const quality = this.store.acceptanceAgg().map((g) => {
      const reviewed = g.accepted + g.rejected + g.needs_revision;
      return {
        mode: g.grp_mode,
        role: g.grp_role || null,
        tasks: g.total,
        acceptance_rate: reviewed > 0 ? Math.round((g.accepted / reviewed) * 1000) / 1000 : null,
        revision_rate: reviewed > 0 ? Math.round((g.needs_revision / reviewed) * 1000) / 1000 : null,
        failure_rate: g.total > 0 ? Math.round((g.failed / g.total) * 1000) / 1000 : null,
        average_continues: Math.round(g.avg_continues * 100) / 100,
      };
    });
    const cache = this.store.cacheStats();
    return {
      period: 'all_time',
      tasks: {
        total: Object.values(counts).reduce((s, n) => s + n, 0),
        by_status: counts,
      },
      tokens: { input: tokens.input, output: tokens.output, cache_read: tokens.cache_read },
      workers: {
        active,
        queued: counts['queued'] ?? 0,
        waiting_dependencies: counts['waiting_dependencies'] ?? 0,
      },
      workflows: {
        total: this.store.listWorkflows(100000).length,
        running: this.store.runningWorkflows().length,
      },
      acceptance: {
        average_continues: Math.round(this.store.avgContinues() * 100) / 100,
        by_mode_and_role: quality,
      },
      cache: {
        entries: cache.entries,
        hits: cache.hits,
        artifact_bytes: cache.artifact_bytes,
      },
      supervision: {
        supervisor_restarts_observed: this.store.metaGet('supervisor_restarts_observed'),
        workers_reattached: this.store.metaGet('workers_reattached'),
        workers_genuinely_interrupted: this.store.metaGet('workers_genuinely_interrupted'),
      },
      backends: this.store.backendAgg().map((b) => ({
        backend: b.backend_id,
        tasks: b.tasks,
        tokens: { input: b.input, output: b.output, cache_read: b.cache_read },
      })),
      models: this.store.modelAgg().map((m) => ({
        backend: m.backend_id,
        model: m.model ?? 'default',
        tasks: m.tasks,
        tokens: { input: m.input, output: m.output, cache_read: m.cache_read },
      })),
    };
  }

  /* ------------------------------------------------------------------ */

  async continueWorker(
    workerId: string,
    instruction: string,
    opts: { model?: string | undefined } = {},
  ): Promise<{ worker_id: string; status: WorkerStatus; session_id: string | null }> {
    if (!instruction || instruction.trim() === '') {
      throw new Error('instruction must be a non-empty string');
    }
    const row = this.get(workerId);
    const continueModel = opts.model?.trim() || null;
    if (continueModel && !this.backendFor(row).capabilities.modelSelection) {
      throw new Error(`backend "${row.backend_id}" does not support per-task model selection`);
    }
    if (this.active.has(workerId) || row.status === 'running' || row.status === 'starting' || row.status === 'queued' || row.status === 'waiting_dependencies') {
      throw new Error(`worker ${workerId} is still active; cancel it or wait for completion before continuing`);
    }
    if (!row.session_id) {
      throw new Error(`worker ${workerId} has no recorded backend session id; cannot resume`);
    }

    // Continue after integration: the task's old worktree branched from an
    // outdated snapshot. Create a continuation worktree from the CURRENT
    // workflow integration HEAD (which may include siblings' changes), on a
    // new branch, with a fresh session (a dsh session is bound to its cwd —
    // correctness beats session reuse).
    let resumeSession = true;
    if (
      row.workflow_id &&
      row.workspace_type === 'git_worktree' &&
      (row.integration_status === 'integrated' || row.integration_status === 'skipped' || row.integration_status === 'conflict')
    ) {
      const wf = this.store.getWorkflow(row.workflow_id);
      if (!wf) throw new Error(`workflow ${row.workflow_id} missing`);
      const integrationHead = currentHead(wf.workspace_path);
      if (!integrationHead) throw new Error('integration worktree has no HEAD');
      const n = row.continue_count + 1;
      const newBranch = `workforce/task/${row.id}-r${n}`;
      const newPath = path.join(wf.log_dir, 'tasks', row.id, `worktree-r${n}`);
      createWorktreeAtCommit(wf.repo_path, newPath, newBranch, integrationHead);
      this.store.updateWorker(workerId, {
        worktree_path: newPath,
        task_branch: newBranch,
        base_ref: integrationHead,
        workspace_base_commit: integrationHead,
        session_id: null,
        integration_status: 'pending',
      });
      this.store.addEvent(workerId, 'continue_workspace', `fresh snapshot from integration HEAD ${integrationHead.slice(0, 12)} (new session)`);
      resumeSession = false;
    } else if (!fs.existsSync(row.worktree_path)) {
      throw new Error(`worker ${workerId} workspace no longer exists: ${row.worktree_path}`);
    }

    const updated = this.get(workerId);
    this.store.updateWorker(workerId, {
      status: 'queued',
      error: null,
      continue_count: row.continue_count + 1,
      ...(continueModel ? { model: continueModel } : {}),
    });
    this.store.addEvent(workerId, 'continue', instruction.slice(0, MAX_EVENT_SUMMARY));
    this.schedule();
    return { worker_id: workerId, status: 'queued', session_id: resumeSession ? updated.session_id : null };
  }

  async cancelWorker(workerId: string): Promise<{ worker_id: string; status: WorkerStatus }> {
    const row = this.get(workerId);
    const run = this.active.get(workerId);

    if (run) {
      run.intent = 'cancel';
      if (run.timeoutTimer) {
        clearTimeout(run.timeoutTimer);
        run.timeoutTimer = null;
      }
      await run.handle.terminate(this.config.terminateGraceMs);
      // finalize() runs via onExit and marks the row cancelled.
      await run.done;
      return { worker_id: workerId, status: this.get(workerId).status };
    }

    // Not supervised in this process. Maybe a stale running row with a pid.
    if (row.status === 'queued' || row.status === 'waiting_dependencies') {
      this.store.updateWorker(workerId, { status: 'cancelled', finished_at: new Date().toISOString() });
      this.store.addEvent(workerId, 'cancel', 'cancelled while queued');
      this.notifyWaiters(workerId);
      return { worker_id: workerId, status: 'cancelled' };
    }
    if ((row.status === 'running' || row.status === 'starting') && row.pid) {
      try {
        process.kill(row.pid, 'SIGTERM');
      } catch {
        /* already dead */
      }
      const deadline = Date.now() + this.config.terminateGraceMs;
      while (Date.now() < deadline && pidAlive(row.pid)) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (pidAlive(row.pid)) {
        try {
          process.kill(row.pid, 'SIGKILL');
        } catch {
          /* already dead */
        }
      }
      this.store.updateWorker(workerId, {
        status: 'cancelled',
        pid: null,
        finished_at: new Date().toISOString(),
      });
      this.store.addEvent(workerId, 'cancel', 'cancelled via stored pid');
      this.notifyWaiters(workerId);
      return { worker_id: workerId, status: 'cancelled' };
    }
    if (isTerminal(row.status)) {
      return { worker_id: workerId, status: row.status };
    }
    // starting/running without pid and without an active run: mark cancelled.
    this.store.updateWorker(workerId, { status: 'cancelled', finished_at: new Date().toISOString() });
    this.store.addEvent(workerId, 'cancel', 'cancelled (no live process found)');
    this.notifyWaiters(workerId);
    return { worker_id: workerId, status: 'cancelled' };
  }

  /* ------------------------------------------------------------------ */

  private schedule(): void {
    if (this.scheduling || this.shutDown) return;
    this.scheduling = true;
    try {
      this.promoteWaitingTasks();
      const wfActive = this.store.activeCountByWorkflow();
      while (this.active.size < this.config.maxConcurrent) {
        const next = this.oldestQueued(wfActive);
        if (!next) break;
        if (next.workflow_id) {
          wfActive.set(next.workflow_id, (wfActive.get(next.workflow_id) ?? 0) + 1);
        }
        this.startRun(next, { resumeSessionId: next.session_id });
      }
    } finally {
      this.scheduling = false;
    }
  }

  /**
   * Dependency resolution pass: waiting_dependencies tasks move to queued
   * when eligible, or to blocked (terminal) when a dependency permanently
   * failed under their dependency policy.
   */
  private promoteWaitingTasks(): void {
    for (const row of this.store.workersByStatus('waiting_dependencies')) {
      const deps = parseJsonArray(row.depends_on);
      const depRows = deps.map((d) => this.store.getWorker(d));
      if (depRows.some((d) => !d)) {
        // Dependency row vanished (shouldn't happen) → block.
        this.blockTask(row, deps.map((d, i) => ({ task_id: d, status: depRows[i]?.status ?? 'missing' })));
        continue;
      }
      const typedDeps = depRows as WorkerRow[];
      const statuses = typedDeps.map((d) => d.status);
      const allTerminal = statuses.every((s) => isTerminal(s));
      if (!allTerminal) continue; // still waiting

      // Git-workflow gating: downstream tasks must only observe INTEGRATED
      // dependency results. A dependency with integration=conflict keeps
      // dependents waiting (not blocked) until the conflict is resolved.
      if (row.workflow_id) {
        const wf = this.store.getWorkflow(row.workflow_id);
        if (wf?.workspace_type === 'git_worktree') {
          const integrated = (d: WorkerRow) =>
            d.integration_status === 'integrated' || d.integration_status === 'skipped';
          if (typedDeps.some((d) => d.integration_status === 'conflict' || d.integration_status === 'integrating')) {
            continue; // keep waiting; conflict resolution is a Codex/human decision
          }
          if (typedDeps.some((d) => d.status === 'completed' && !integrated(d))) {
            continue; // completed but integration pending
          }
        }
      }

      const allSuccess = statuses.every((s) => s === 'completed');
      const failedDeps = deps
        .map((d, i) => ({ task_id: d, status: statuses[i]! }))
        .filter((d) => DEPENDENCY_FAILURE_STATUSES.has(d.status as WorkerStatus));

      if (row.dependency_policy === 'all_terminal') {
        this.store.updateWorker(row.id, { status: 'queued' });
        this.store.addEvent(row.id, 'deps_ready', `all_terminal satisfied (${deps.length} deps)`);
      } else if (allSuccess) {
        this.store.updateWorker(row.id, { status: 'queued' });
        this.store.addEvent(row.id, 'deps_ready', `all_success satisfied (${deps.length} deps)`);
      } else if (failedDeps.length > 0) {
        this.blockTask(row, failedDeps);
      }
    }
  }

  /** Permanently block a task whose dependencies failed. */
  private blockTask(row: WorkerRow, blockedBy: Array<{ task_id: string; status: string }>): void {
    this.store.updateWorker(row.id, {
      status: 'blocked',
      error: JSON.stringify({ blocked_by: blockedBy }),
      finished_at: new Date().toISOString(),
    });
    this.store.addEvent(row.id, 'blocked', blockedBy.map((b) => `${b.task_id}:${b.status}`).join(', '));
    this.notifyWaiters(row.id);
    this.onTaskTerminal(this.get(row.id));
  }

  private oldestQueued(wfActive?: Map<string, number>): WorkerRow | null {
    // Priority first (high > normal > low), then FIFO by creation time.
    const all = this.store.listWorkers({ status: 'queued', limit: 500 });
    const prio = (p: string) => (p === 'high' ? 0 : p === 'normal' ? 1 : 2);
    all.sort((a, b) => prio(a.priority) - prio(b.priority) || a.created_at.localeCompare(b.created_at));
    if (!wfActive) return all[0] ?? null;
    // Honor per-workflow concurrency caps when selecting the next task.
    for (const row of all) {
      if (!row.workflow_id) return row;
      const wf = this.store.getWorkflow(row.workflow_id);
      const cap = this.workflowBudget(wf)?.max_concurrent_tasks;
      if (!cap || (wfActive.get(row.workflow_id) ?? 0) < cap) return row;
    }
    return null;
  }

  private workspaceDescription(row: WorkerRow): string {
    switch (row.workspace_type) {
      case 'git_worktree':
        return `Workspace: an isolated git worktree at ${row.worktree_path} (branch ${row.branch}, repo ${row.repo_path}).`;
      case 'directory':
        return `Workspace: the directory ${row.worktree_path}. Only operate inside this directory.`;
      default:
        return `Workspace: a fresh temporary directory at ${row.worktree_path}. Place all deliverables here.`;
    }
  }

  private workflowBudget(wf: WorkflowRow | null): WorkflowBudget | null {
    if (!wf?.budget) return null;
    try {
      return JSON.parse(wf.budget) as WorkflowBudget;
    } catch {
      return null;
    }
  }

  /* ------------------------- budget enforcement ------------------------- */

  /**
   * Best-effort budget checks driven by real DSH events (per status/tool
   * event granularity — NOT hard accounting). On exceed, the run is
   * terminated and the task lands in budget_exceeded.
   */
  private checkBudgets(workerId: string, run: ActiveRun): void {
    if (run.intent !== 'run') return;
    const row = this.store.getWorker(workerId);
    if (!row) return;
    const snap = run.usage.snapshot();

    const setBudgetBreach = (reason: string, limit: number, used: number) => {
      run.intent = 'budget';
      run.budgetInfo = { reason, limit, used };
      this.store.addEvent(workerId, 'budget', `${reason}: ${used}/${limit}; terminating`);
      void run.handle.terminate(this.config.terminateGraceMs);
    };

    if (row.budget) {
      let b: TaskBudget | null = null;
      try {
        b = JSON.parse(row.budget) as TaskBudget;
      } catch {
        b = null;
      }
      if (b) {
        if (b.max_input_tokens && snap.input_tokens > b.max_input_tokens) {
          return setBudgetBreach('max_input_tokens', b.max_input_tokens, snap.input_tokens);
        }
        if (b.max_output_tokens && snap.output_tokens > b.max_output_tokens) {
          return setBudgetBreach('max_output_tokens', b.max_output_tokens, snap.output_tokens);
        }
        if (b.max_total_tokens && snap.input_tokens + snap.output_tokens + snap.cache_read_tokens > b.max_total_tokens) {
          return setBudgetBreach('max_total_tokens', b.max_total_tokens, snap.input_tokens + snap.output_tokens + snap.cache_read_tokens);
        }
        if (b.max_tool_calls && run.toolCalls > b.max_tool_calls) {
          return setBudgetBreach('max_tool_calls', b.max_tool_calls, run.toolCalls);
        }
        if (b.max_iterations && run.lastTurn > b.max_iterations) {
          return setBudgetBreach('max_iterations', b.max_iterations, run.lastTurn);
        }
      }
    }

    // Workflow-level token budget (sum of input+output+cache across tasks).
    if (row.workflow_id) {
      const wf = this.store.getWorkflow(row.workflow_id);
      const wb = this.workflowBudget(wf);
      const maxWorkerTokens = wb?.max_worker_tokens;
      if (wf && maxWorkerTokens) {
        const sums = this.store.tokenSumsForWorkflow(wf.id);
        const used = sums.input + sums.output + sums.cache_read;
        if (used > maxWorkerTokens) {
          this.store.addEvent(wf.id, 'budget', `workflow max_worker_tokens exceeded: ${used}/${maxWorkerTokens}`);
          this.failWorkflowForBudget(wf.id, `max_worker_tokens: ${used}/${maxWorkerTokens}`);
          return setBudgetBreach('workflow_max_worker_tokens', maxWorkerTokens, used);
        }
      }
    }
  }

  private failWorkflowForBudget(wfId: string, reason: string): void {
    const wf = this.store.getWorkflow(wfId);
    if (!wf || wf.status !== 'running') return;
    // Cancel everything not finished, then mark the workflow failed.
    for (const t of this.store.workersInWorkflow(wfId)) {
      if (isTerminal(t.status)) continue;
      if (t.status === 'running' || t.status === 'starting') {
        const run = this.active.get(t.id);
        if (run) {
          run.intent = 'budget';
          run.budgetInfo = { reason: `workflow budget: ${reason}`, limit: 0, used: 0 };
          void run.handle.terminate(this.config.terminateGraceMs);
        }
      } else {
        this.store.updateWorker(t.id, { status: 'budget_exceeded', finished_at: new Date().toISOString(), error: JSON.stringify({ budget: { reason } }) });
        this.notifyWaiters(t.id);
      }
    }
    this.store.updateWorkflow(wfId, { status: 'failed', finished_at: new Date().toISOString() });
    this.store.addEvent(wfId, 'workflow', `failed: budget exceeded (${reason})`);
    this.notifyWaiters(wfId);
  }

  private buildPrompt(row: WorkerRow): string {
    // Continuation runs always get the latest continue instruction —
    // regardless of whether the dsh session is resumed (same cwd) or fresh
    // (workspace refreshed to the current integration HEAD).
    if (row.continue_count > 0) return buildContinuePrompt(this.peekContinueInstruction(row));
    const subagentsNote =
      this.config.enableSubagents && (row.mode === 'research' || row.mode === 'general')
        ? `You may delegate independent sub-investigations to subagents when your runtime supports it (depth ≤ ${this.config.maxSubagentDepth}, at most ${this.config.maxSubagentsPerTask} subagents). Keep delegation minimal and integrate the results yourself.`
        : undefined;
    return buildModePrompt(row.mode as TaskMode, {
      task: row.task,
      deliverables: parseJsonArray(row.deliverables),
      capabilities: parseJsonArray(row.capabilities),
      workspaceDescription: this.workspaceDescription(row),
      roleFragment: row.role ? (getRole(row.role)?.promptFragment ?? undefined) : undefined,
      subagentsNote,
    });
  }

  private startRun(
    row: WorkerRow,
    opts: { resumeSessionId: string | null },
  ): void {
    // Materialize the per-task worktree for git-workflow tasks: branch from
    // the CURRENT integration HEAD (all integrated dependencies included).
    // This snapshot stays immutable for the run's whole lifetime.
    if (row.workflow_id && row.workspace_type === 'git_worktree' && !fs.existsSync(row.worktree_path)) {
      const wf = this.store.getWorkflow(row.workflow_id);
      if (!wf) throw new Error(`workflow ${row.workflow_id} missing for task ${row.id}`);
      const integrationHead = currentHead(wf.workspace_path);
      if (!integrationHead) throw new Error(`integration worktree has no HEAD: ${wf.workspace_path}`);
      createWorktreeAtCommit(wf.repo_path, row.worktree_path, row.task_branch ?? `workforce/task/${row.id}`, integrationHead);
      this.store.updateWorker(row.id, { workspace_base_commit: integrationHead, base_ref: integrationHead });
      this.store.addEvent(row.id, 'workspace', `snapshot=${integrationHead.slice(0, 12)} branch=${row.task_branch}`);
      row = this.get(row.id);
    }

    const isResume = opts.resumeSessionId !== null;
    const prompt = this.buildPrompt(row);

    const stdoutPath = path.join(row.log_dir, 'stdout.jsonl');
    const stderrPath = path.join(row.log_dir, 'stderr.log');

    const usage = new UsageTracker();
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));

    this.store.updateWorker(row.id, {
      status: 'starting',
      started_at: row.started_at ?? new Date().toISOString(),
      run_started_at: new Date().toISOString(),
      supervision_state: 'attached',
      error: null,
    });

    let handle: WorkerBackendHandle;
    const runRef: { current: ActiveRun | null } = { current: null };
    const backend = this.backendFor(row);

    try {
      handle = backend.start(
        {
          workerId: row.id,
          cwd: row.worktree_path,
          prompt,
          sessionId: opts.resumeSessionId,
          stdoutPath,
          stderrPath,
          ...(row.model ? { model: row.model } : {}),
        },
        {
          onEvent: (ev) => this.handleEvent(row.id, ev, usage),
          onStderr: () => {},
          onSpawnError: (err) => {
            this.store.addEvent(row.id, 'spawn_error', redactSecrets(err.message).slice(0, MAX_EVENT_SUMMARY));
          },
          onExit: (code, signal) => {
            if (this.shutDown) return; // detached: worker state stays in the db
            const run0 = runRef.current;
            if (run0?.tailTimer) clearTimeout(run0.tailTimer);
            if (run0 && this.backendFor(this.get(row.id)).durableStdout) {
              // Final drain of the durable log before finalizing (the tailer
              // may lag a few hundred ms behind the process).
              try {
                this.drainLog(row.id, run0);
              } catch {
                /* ignore */
              }
            }
            void this.finalize(row.id, code, signal).finally(() => {
              const run = runRef.current;
              // finalize() may have chained a follow-up run which already
              // replaced this entry in the active map — only remove our own.
              if (run && this.active.get(row.id) === run) {
                this.active.delete(row.id);
              }
              if (run?.timeoutTimer) clearTimeout(run.timeoutTimer);
              resolveDone();
              this.schedule();
            });
          },
        },
      );
    } catch (err) {
      this.store.updateWorker(row.id, {
        status: 'failed',
        error: `backend start failed: ${redactSecrets((err as Error).message)}`,
        finished_at: new Date().toISOString(),
      });
      this.store.addEvent(row.id, 'error', 'backend start failed');
      this.notifyWaiters(row.id);
      resolveDone();
      this.schedule();
      return;
    }

    const run: ActiveRun = {
      handle,
      usage,
      intent: 'run',
      timeoutTimer: null,
      // Run-level HEAD tracking: continue_worker runs must compare against
      // the previous run's HEAD, not the task's original base ref.
      headBeforeRun: row.workspace_type === 'git_worktree' ? currentHead(row.worktree_path) : null,
      toolCalls: 0,
      lastTurn: 0,
      startedAt: new Date().toISOString(),
      done,
      resolveDone,
      backend,
    };
    runRef.current = run;
    this.active.set(row.id, run);

    if (this.backendFor(row).durableStdout) {
      // Events flow exclusively through the durable log tailer.
      run.tailOffset = (() => {
        try {
          return fs.statSync(stdoutPath).size;
        } catch {
          return 0;
        }
      })();
      this.startTailer(row.id, run, false);
    }

    const pidIdentity = handle.pid ? (captureProcessIdentity(handle.pid)?.startToken ?? null) : null;
    this.store.updateWorker(row.id, { status: 'running', pid: handle.pid, pid_identity: pidIdentity });
    this.store.addEvent(row.id, 'start', `pid=${handle.pid ?? 'n/a'} resume=${isResume}`);

    const timeoutSeconds = row.timeout_seconds ?? this.config.defaultTimeoutSeconds;
    run.timeoutTimer = setTimeout(() => {
      const r = this.active.get(row.id);
      if (!r) return;
      r.intent = 'timeout';
      this.store.addEvent(row.id, 'timeout', `exceeded ${timeoutSeconds}s; terminating`);
      void r.handle.terminate(this.config.terminateGraceMs);
    }, timeoutSeconds * 1000);
    run.timeoutTimer.unref();
  }

  /** Best-effort recovery of the latest continue instruction for the prompt. */
  private peekContinueInstruction(row: WorkerRow): string {
    const events = this.store.listEvents(row.id, 50);
    const ev = events.find((e) => e.type === 'continue');
    return ev?.summary ?? 'Please review and improve your previous work.';
  }

  private handleEvent(workerId: string, raw: DshEvent, usage: UsageTracker): void {
    if (this.shutDown) return; // detached — worker outlives us; drop late events
    if (raw.byteOffset !== undefined) {
      // Durable parse checkpoint (complete JSONL records only).
      this.store.updateWorker(workerId, { stdout_parse_offset: raw.byteOffset });
    }
    const run = this.active.get(workerId);
    const backend = run?.backend;
    let events: WorkerEvent[];
    try {
      events = backend ? backend.normalizeEvent(raw) : normalizeDshEvent(raw);
    } catch {
      events = [];
    }
    for (const ev of events) {
      this.applyWorkerEvent(workerId, ev, usage, run);
    }
    // Best-effort budget enforcement after usage/tool/status events.
    if (run && events.some((e) => e.type === 'usage' || e.type === 'tool_call' || e.type === 'status')) {
      this.checkBudgets(workerId, run);
    }
  }

  private applyWorkerEvent(workerId: string, ev: WorkerEvent, usage: UsageTracker, run: ActiveRun | undefined): void {
    switch (ev.type) {
      case 'session': {
        if (ev.sessionId) {
          // Backends may report the same session on every step (e.g. OpenCode
          // step_start); persist it once so run metrics stay accurate.
          const current = this.store.getWorker(workerId);
          if (current?.session_id !== ev.sessionId) {
            this.store.updateWorker(workerId, { session_id: ev.sessionId });
            this.store.addEvent(workerId, 'session', ev.sessionId);
          }
        }
        break;
      }
      case 'status': {
        const snap = usage.snapshot();
        this.store.updateWorker(workerId, {
          input_tokens: snap.input_tokens,
          output_tokens: snap.output_tokens,
          cache_read_tokens: snap.cache_read_tokens,
          total_tokens_last: snap.total_tokens_last,
        });
        this.store.addEvent(workerId, 'status', ev.phase);
        if (ev.turn && run) run.lastTurn = Math.max(run.lastTurn, ev.turn);
        break;
      }
      case 'usage': {
        usage.apply({
          ...(ev.inputTokens !== undefined ? { inputTokens: ev.inputTokens } : {}),
          ...(ev.outputTokens !== undefined ? { outputTokens: ev.outputTokens } : {}),
          ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
          ...(ev.totalTokens !== undefined ? { totalTokens: ev.totalTokens } : {}),
        });
        const snap = usage.snapshot();
        this.store.updateWorker(workerId, {
          input_tokens: snap.input_tokens,
          output_tokens: snap.output_tokens,
          cache_read_tokens: snap.cache_read_tokens,
          total_tokens_last: snap.total_tokens_last,
        });
        break;
      }
      case 'text': {
        const progress = ev.text.replace(/\s+/g, ' ').trim().slice(0, MAX_PROGRESS_CHARS);
        this.store.updateWorker(workerId, { last_progress: progress });
        break;
      }
      case 'tool_call': {
        this.store.addEvent(workerId, 'tool_call', `${ev.tool ?? '?'} (${ev.callId ?? '?'})`);
        if (run) run.toolCalls++;
        break;
      }
      case 'tool_result': {
        this.store.addEvent(workerId, 'tool_result', `${ev.status ?? '?'} (${ev.callId ?? '?'})`);
        break;
      }
      case 'final': {
        this.store.updateWorker(workerId, {
          final_text: ev.text.slice(0, this.config.finalTextMaxChars),
        });
        this.store.addEvent(workerId, 'final', 'received');
        break;
      }
      case 'malformed': {
        this.store.addEvent(workerId, 'malformed', ev.preview.slice(0, 120));
        break;
      }
      case 'error': {
        this.store.addEvent(workerId, 'error', ev.message.slice(0, MAX_EVENT_SUMMARY));
        break;
      }
    }
  }


  /* ------------------------------------------------------------------ */

  private collectGitFacts(row: WorkerRow): {
    commitHash: string | null;
    head: string | null;
    dirty: boolean;
    changedFiles: string[];
    uncommitted: string[];
  } {
    const empty = { commitHash: null, head: null, dirty: false, changedFiles: [] as string[], uncommitted: [] as string[] };
    if (row.workspace_type !== 'git_worktree') return empty;
    const wt = row.worktree_path;
    if (!fs.existsSync(wt) || !row.base_ref) return empty;
    const head = currentHead(wt);
    const dirty = statusPorcelain(wt) !== '';
    const hasNewCommit = head !== null && head !== row.base_ref;
    return {
      commitHash: hasNewCommit ? head : null,
      head,
      dirty,
      changedFiles: hasNewCommit ? changedFilesCommitted(wt, row.base_ref) : [],
      uncommitted: dirty ? uncommittedPaths(wt) : [],
    };
  }

  /**
   * Index workspace files as artifacts and verify declared deliverables.
   * Called on every terminal transition (any intent) — artifact collection
   * is best-effort and never changes the worker status.
   */
  private finalizeArtifacts(row: WorkerRow): void {
    const root = row.worktree_path;
    if (!root || !fs.existsSync(root)) return;
    try {
      let files: CollectedFile[];
      if (row.workspace_type === 'git_worktree') {
        const git = this.collectGitFacts(row);
        files = walkArtifacts(root, { onlyPaths: [...git.changedFiles, ...git.uncommitted] });
      } else if (row.workspace_type === 'temporary') {
        files = walkArtifacts(root, {});
      } else {
        // directory: index files touched since the first run started.
        const since = row.started_at ? Date.parse(row.started_at) - 2000 : undefined;
        files = walkArtifacts(root, { minMtimeMs: since });
      }
      const seen = new Set<string>();
      for (const f of files) {
        seen.add(f.relativePath);
        this.store.upsertArtifact({
          task_id: row.id,
          relative_path: f.relativePath,
          absolute_path: f.absolutePath,
          mime_type: guessMimeType(f.absolutePath),
          size_bytes: f.sizeBytes,
          sha256: sha256File(f.absolutePath),
        });
      }
      // Prune indexed artifacts whose files disappeared.
      for (const a of this.store.listArtifacts(row.id)) {
        if (!seen.has(a.relative_path) && !fs.existsSync(a.absolute_path)) {
          this.store.deleteArtifact(row.id, a.relative_path);
        }
      }
      if (files.length > 0) {
        this.store.addEvent(row.id, 'artifacts', `${files.length} artifact(s) indexed`);
      }
    } catch (err) {
      this.store.addEvent(
        row.id,
        'artifacts_error',
        redactSecrets((err as Error).message).slice(0, MAX_EVENT_SUMMARY),
      );
    }

    const deliverables = parseJsonArray(row.deliverables);
    if (deliverables.length > 0) {
      const missing = deliverables.filter((d) => {
        try {
          return !fs.statSync(resolveUnderRoot(root, d)).isFile();
        } catch {
          return true;
        }
      });
      this.store.updateWorker(row.id, {
        deliverables_missing: missing.length > 0 ? JSON.stringify(missing) : null,
      });
      if (missing.length > 0) {
        this.store.addEvent(row.id, 'deliverables_missing', missing.join(', '));
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Supervisor-owned git finalization
   *
   * Worker owns execution; supervisor owns git metadata. The worker's
   * writable sandbox covers the worktree's files but NOT the original
   * repo's .git/worktrees/… metadata, so the supervisor performs the
   * (small, fixed) git mutations: status/diff/add/commit/rev-parse/log.
   * ------------------------------------------------------------------ */

  /** Extract and sanitize the worker's suggested commit message. */
  private suggestedCommitMessage(finalText: string | null): string | null {
    if (!finalText) return null;
    const m = /suggested[_ ]commit[_ ]message\s*:\s*(.+)/i.exec(finalText);
    if (!m || !m[1]) return null;
    // Single line, no control chars, bounded length.
    let msg = m[1].split('\n')[0]!.replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim();
    if (msg.startsWith('- ')) msg = msg.slice(2).trim();
    if (msg.startsWith('`') && msg.endsWith('`') && msg.length > 1) msg = msg.slice(1, -1);
    if (msg === '') return null;
    return msg.slice(0, 120);
  }

  private fallbackCommitMessage(row: WorkerRow, remainder: boolean): string {
    return remainder
      ? `workforce/worker/${row.id}: finalize remaining changes`
      : `workforce/worker/${row.id}: apply delegated changes`;
  }

  /**
   * After a successful worker run on a git worktree: verify state, accept any
   * worker-created commit, and supervisor-commit remaining changes.
   */
  private finalizeGitChanges(
    row: WorkerRow,
    headBeforeRun: string | null,
    finalText: string | null,
  ): {
    workerCommitted: boolean;
    supervisorCommitted: boolean;
    commitError: string | null;
  } {
    const wt = row.worktree_path;
    const headAfterWorker = currentHead(wt);
    const workerCommitted = headAfterWorker !== null && headAfterWorker !== headBeforeRun;
    let supervisorCommitted = false;
    let commitError: string | null = null;

    const branchNow = currentBranch(wt);
    const expectedBranch = row.task_branch ?? row.branch;
    if (branchNow !== expectedBranch) {
      commitError = `worker left worktree on unexpected ref ${branchNow ?? '(detached)'} (expected ${expectedBranch}); refusing to commit`;
    } else if (statusPorcelain(wt) !== '') {
      const suggested = this.suggestedCommitMessage(finalText);
      const message = suggested ?? this.fallbackCommitMessage(row, workerCommitted);
      const res = supervisorCommitAll(wt, message);
      if (res.ok) {
        supervisorCommitted = true;
      } else {
        commitError = `supervisor commit failed: ${res.error}`;
      }
    }

    return { workerCommitted, supervisorCommitted, commitError };
  }

  private recordGitFinalize(workerId: string, info: Record<string, unknown>): void {
    this.store.addEvent(workerId, 'git_finalize', JSON.stringify(info).slice(0, 1000));
  }

  /** Latest persisted git finalization info (survives restarts via events). */
  private lastGitFinalize(workerId: string): Record<string, unknown> | null {
    const ev = this.store.listEvents(workerId, 100).find((e) => e.type === 'git_finalize');
    if (!ev?.summary) return null;
    try {
      return JSON.parse(ev.summary) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private gitInfo(row: WorkerRow): Record<string, unknown> {
    const git = this.collectGitFacts(row);
    const fin = this.lastGitFinalize(row.id) ?? {};
    const head = fs.existsSync(row.worktree_path) ? currentHead(row.worktree_path) : null;
    const commitCount = row.base_ref && fs.existsSync(row.worktree_path)
      ? commitsAhead(row.worktree_path, row.base_ref)
      : 0;
    const info: Record<string, unknown> = {
      base_ref: row.base_ref,
      branch: row.branch,
      head_before_run: fin['headBefore'] ?? null,
      head_after: head,
      commit_hash: git.commitHash ? git.commitHash.slice(0, 7) : null,
      commit_created: commitCount > 0,
      commit_count: commitCount,
      commit_created_by: fin['createdBy'] ?? null,
      supervisor_created_commit: fin['supervisorCommitted'] ?? false,
      working_tree_clean: !git.dirty,
    };
    if (git.dirty) info['uncommitted_changes'] = git.uncommitted;
    if (fin['error']) info['error'] = fin['error'];
    if (fin['autoCommitSkipped']) info['auto_commit_skipped'] = fin['autoCommitSkipped'];
    return info;
  }

  private async finalize(workerId: string, exitCode: number | null, signal: string | null): Promise<void> {
    const run = this.active.get(workerId);
    if (!run) {
      // Exit for a run we no longer track (e.g. a detached worker whose
      // process ended after supervisor shutdown); ignore without DB access.
      return;
    }
    const row = this.get(workerId);

    // Respect a terminal status set concurrently (e.g. cancel via CLI in
    // another process): keep the status, only refresh observed facts.
    const presetTerminal = isTerminal(row.status) ? row.status : null;

    const usageSnap = run.usage.snapshot();
    const usagePatch = {
      pid: null as number | null,
      exit_code: exitCode,
      input_tokens: usageSnap.input_tokens,
      output_tokens: usageSnap.output_tokens,
      cache_read_tokens: usageSnap.cache_read_tokens,
      total_tokens_last: usageSnap.total_tokens_last,
    };

    const finishTerminal = (status: WorkerStatus, error: string | null) => {
      const now = new Date().toISOString();
      this.store.addAttempt({
        task_id: workerId,
        attempt: row.attempt,
        started_at: run.startedAt,
        finished_at: now,
        exit_code: exitCode,
        status,
        input_tokens: usageSnap.input_tokens,
        output_tokens: usageSnap.output_tokens,
        cache_read_tokens: usageSnap.cache_read_tokens,
        error,
      });
      this.store.updateWorker(workerId, {
        ...usagePatch,
        commit_hash: this.collectGitFacts(row).commitHash ?? row.commit_hash,
        status,
        error,
        finished_at: now,
      });
      this.store.addEvent(workerId, 'finish', `status=${status} exit=${exitCode ?? 'null'} attempt=${row.attempt}`);
      this.finalizeArtifacts(this.get(workerId));
      this.notifyWaiters(workerId);
      this.onTaskTerminal(this.get(workerId));
    };

    if (run.intent === 'cancel' || presetTerminal !== null) {
      if (row.workspace_type === 'git_worktree') {
        const dirty = statusPorcelain(row.worktree_path) !== '';
        this.recordGitFinalize(workerId, {
          autoCommitSkipped: 'cancelled — dirty working tree preserved',
          workingTreeDirty: dirty,
          headBefore: run.headBeforeRun,
        });
      }
      finishTerminal(presetTerminal ?? 'cancelled', presetTerminal ? row.error : null);
      return;
    }

    if (run.intent === 'budget') {
      const info = run.budgetInfo ?? { reason: 'unknown', limit: 0, used: 0 };
      finishTerminal(
        'budget_exceeded',
        JSON.stringify({ budget: { limit: info.limit, used: info.used, reason: info.reason } }),
      );
      return;
    }

    // Provisional outcome for run/timeout intents.
    let provisional: WorkerStatus;
    let provisionalError: string | null = null;
    let gitFin: { workerCommitted: boolean; supervisorCommitted: boolean; commitError: string | null } | null = null;

    if (run.intent === 'timeout') {
      provisional = 'timeout';
      provisionalError = `exceeded timeout of ${row.timeout_seconds ?? this.config.defaultTimeoutSeconds}s`;
    } else if (exitCode !== null && exitCode !== 0) {
      provisional = 'failed';
      const stderrTail = this.stderrTail(row);
      provisionalError =
        `backend exited with code=${exitCode} signal=${signal ?? 'null'}` + (stderrTail ? `; stderr: ${stderrTail}` : '');
    } else if (run.detached && exitCode === null) {
      // Reattached run: no ChildProcess handle, so no exit code. Durable
      // evidence decides — a final event means normal completion; otherwise
      // the worker genuinely vanished mid-run.
      if (row.final_text) {
        if (row.workspace_type === 'git_worktree') {
          gitFin = this.finalizeGitChanges(row, run.headBeforeRun, row.final_text);
          this.recordGitFinalize(workerId, {
            headBefore: run.headBeforeRun,
            headAfter: currentHead(row.worktree_path),
            workerCommitted: gitFin.workerCommitted,
            supervisorCommitted: gitFin.supervisorCommitted,
            createdBy: gitFin.workerCommitted && gitFin.supervisorCommitted
              ? 'worker+supervisor'
              : gitFin.workerCommitted
                ? 'worker'
                : gitFin.supervisorCommitted
                ? 'supervisor'
                : null,
            error: gitFin.commitError,
          });
        }
        const git = this.collectGitFacts(row);
        if (row.workspace_type !== 'git_worktree') {
          provisional = 'completed';
        } else if (gitFin?.commitError && git.dirty) {
          provisional = 'completed_uncommitted';
          provisionalError = gitFin.commitError;
        } else if (git.dirty) {
          provisional = 'completed_uncommitted';
          provisionalError = 'worker finished but uncommitted modifications remain in the worktree';
        } else {
          provisional = 'completed';
        }
      } else {
        provisional = 'interrupted';
        provisionalError = 'worker process disappeared without terminal evidence';
      }
    } else {
      // Clean exit — supervisor-owned git finalization for git worktrees.
      if (row.workspace_type === 'git_worktree') {
        gitFin = this.finalizeGitChanges(row, run.headBeforeRun, row.final_text);
        this.recordGitFinalize(workerId, {
          headBefore: run.headBeforeRun,
          headAfter: currentHead(row.worktree_path),
          workerCommitted: gitFin.workerCommitted,
          supervisorCommitted: gitFin.supervisorCommitted,
          createdBy: gitFin.workerCommitted && gitFin.supervisorCommitted
            ? 'worker+supervisor'
            : gitFin.workerCommitted
              ? 'worker'
              : gitFin.supervisorCommitted
                ? 'supervisor'
                : null,
          error: gitFin.commitError,
        });
      }
      const git = this.collectGitFacts(row);
      if (row.workspace_type !== 'git_worktree') {
        provisional = 'completed';
        provisionalError = row.final_text ? null : 'worker produced no final report';
      } else if (gitFin?.commitError && git.dirty) {
        provisional = 'completed_uncommitted';
        provisionalError = gitFin.commitError;
      } else if (git.dirty) {
        provisional = 'completed_uncommitted';
        provisionalError = 'worker finished but uncommitted modifications remain in the worktree';
      } else {
        provisional = 'completed';
        if (!git.commitHash && !row.final_text) {
          provisionalError = 'worker made no changes and produced no final report';
        }
      }
    }

    // Retry gate: failed/timeout runs may be re-queued as a NEW run/session.
    // Never retries cancelled/budget_exceeded. The task stays non-terminal
    // (queued), so waiters are NOT woken for intermediate failures.
    if (provisional === 'failed' || provisional === 'timeout') {
      const retryOn = parseJsonArray(row.retry_on);
      if (row.attempt < row.max_attempts && retryOn.includes(provisional)) {
        this.store.addAttempt({
          task_id: workerId,
          attempt: row.attempt,
          started_at: run.startedAt,
          finished_at: new Date().toISOString(),
          exit_code: exitCode,
          status: provisional,
          input_tokens: usageSnap.input_tokens,
          output_tokens: usageSnap.output_tokens,
          cache_read_tokens: usageSnap.cache_read_tokens,
          error: provisionalError,
        });
        this.store.updateWorker(workerId, {
          ...usagePatch,
          exit_code: null,
          status: 'queued',
          error: null,
          attempt: row.attempt + 1,
          session_id: null, // MVP: retries always use a fresh session
          started_at: row.started_at,
        });
        this.store.addEvent(workerId, 'retry', `attempt ${row.attempt} → ${row.attempt + 1} after ${provisional}`);
        return;
      }
    }

    if ((provisional === 'failed' || provisional === 'timeout') && row.workspace_type === 'git_worktree') {
      this.recordGitFinalize(workerId, {
        autoCommitSkipped: provisional === 'failed' ? 'worker execution failed' : 'worker execution timed out — dirty working tree preserved',
        workingTreeDirty: statusPorcelain(row.worktree_path) !== '',
        headBefore: run.headBeforeRun,
      });
    }

    // Git-workflow tasks: record this run's commits, then serialize
    // integration into the workflow branch BEFORE waiters wake — a task is
    // only "done" for dependency purposes once its commits are integrated.
    if (
      (provisional === 'completed' || provisional === 'completed_uncommitted') &&
      row.workspace_type === 'git_worktree' &&
      row.workflow_id &&
      run.headBeforeRun
    ) {
      const newCommits = revListRange(row.worktree_path, run.headBeforeRun);
      if (newCommits.length > 0) {
        const prev = parseJsonArray(row.task_commits);
        this.store.updateWorker(workerId, { task_commits: JSON.stringify([...prev, ...newCommits]) });
      }
      await this.integrateTask(workerId);
    }

    finishTerminal(provisional, provisionalError);
    this.maybeWriteCache(workerId, provisional);
  }

  /* -------------------- serialized workflow integration -------------------- */

  private integrationLocks = new Map<string, Promise<unknown>>();

  /** Lightweight per-workflow async mutex: integration is never concurrent. */
  private withIntegrationLock<T>(wfId: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.integrationLocks.get(wfId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.integrationLocks.set(
      wfId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /**
   * Cherry-pick the task's not-yet-integrated commits onto the workflow
   * integration branch. Conflicts abort immediately (clean state restored)
   * and are surfaced — never auto-resolved.
   */
  private async integrateTask(workerId: string): Promise<void> {
    const row = this.get(workerId);
    if (!row.workflow_id || row.workspace_type !== 'git_worktree') return;
    if (row.integration_status === 'integrated' || row.integration_status === 'skipped') return;
    const wf = this.store.getWorkflow(row.workflow_id);
    if (!wf) return;
    const integrationWt = wf.workspace_path;
    if (!fs.existsSync(integrationWt)) {
      this.store.updateWorker(workerId, {
        integration_status: 'conflict',
        integration_error: JSON.stringify({ error: 'integration worktree missing' }),
      });
      return;
    }

    await this.withIntegrationLock(wf.id, () => {
      const baseCommit = row.workspace_base_commit;
      if (!baseCommit) {
        this.store.updateWorker(workerId, { integration_status: 'skipped' });
        return;
      }
      const all = revListRange(row.worktree_path, baseCommit);
      const already = new Set(parseJsonArray(row.integrated_commits));
      const pending = all.filter((s) => !already.has(s));
      if (pending.length === 0) {
        this.store.updateWorker(workerId, { integration_status: 'skipped' });
        this.store.addEvent(workerId, 'integrate', 'no new commits → skipped');
        return;
      }

      this.store.updateWorker(workerId, { integration_status: 'integrating' });
      const picked: string[] = [];
      for (const sha of pending) {
        const res = cherryPickCommit(integrationWt, sha);
        if (!res.ok) {
          // Aborted back to clean state inside cherryPickCommit. Picks that
          // already succeeded in this batch ARE on the branch — record them
          // so a later retry never re-picks them.
          this.store.updateWorker(workerId, {
            integration_status: 'conflict',
            integrated_commits: JSON.stringify([...already, ...picked]),
            integration_error: JSON.stringify({
              conflicting_commits: [sha],
              remaining_commits: pending.slice(pending.indexOf(sha) + 1),
              files: res.conflictFiles,
              error: res.error,
            }),
          });
          this.store.addEvent(workerId, 'integrate_conflict', `commit ${sha.slice(0, 7)} conflicts on ${res.conflictFiles.join(', ') || 'unknown files'}`);
          this.store.addEvent(wf.id, 'workflow', `integration conflict in task ${row.task_key ?? row.id}`);
          return;
        }
        picked.push(sha);
      }

      this.store.updateWorker(workerId, {
        integration_status: 'integrated',
        integrated_commits: JSON.stringify([...already, ...picked]),
        integration_error: null,
      });
      this.store.addEvent(workerId, 'integrate', `integrated ${picked.length} commit(s) into ${wf.branch}`);
    });
  }

  /** Write the artifact-cache entry after a successful cacheable run. */
  private maybeWriteCache(workerId: string, status: WorkerStatus): void {
    if (status !== 'completed') return;
    const row = this.get(workerId);
    if (row.cache_policy !== 'read_write' && row.cache_policy !== 'refresh') return;
    const keyEvent = this.store.listEvents(workerId, 100).find((e) => e.type === 'cache_key');
    if (!keyEvent?.summary) return;
    try {
      const { key, fingerprint } = JSON.parse(keyEvent.summary) as { key: string; fingerprint: string };
      const artifacts = this.store.listArtifacts(workerId);
      if (artifacts.length === 0) return;
      this.store.cachePut({
        cache_key: key,
        task_id: workerId,
        mode: row.mode,
        role: row.role,
        workspace_fingerprint: fingerprint,
        prompt_version: String(PROMPT_TEMPLATE_VERSION),
        artifact_count: artifacts.length,
        artifact_bytes: artifacts.reduce((s, a) => s + a.size_bytes, 0),
        created_at: new Date().toISOString(),
      });
      this.store.addEvent(workerId, 'cache_write', `${artifacts.length} artifacts cached`);
    } catch {
      /* cache write is best-effort */
    }
  }

  cacheStats(): Record<string, unknown> {
    return this.store.cacheStats();
  }

  /** Workflow bookkeeping after any task reaches a terminal state. */
  private onTaskTerminal(row: WorkerRow): void {
    const wfId = row.workflow_id;
    if (!wfId) return;
    const wf = this.store.getWorkflow(wfId);
    if (!wf || wf.status !== 'running') return;

    // Crisp workflow health: only completed/completed_uncommitted are OK.
    const failedTask = row.status !== 'completed' && row.status !== 'completed_uncommitted';

    if (failedTask && wf.failure_policy === 'cancel_remaining') {
      for (const t of this.store.workersInWorkflow(wfId)) {
        if (t.id === row.id || isTerminal(t.status)) continue;
        if (t.status === 'running' || t.status === 'starting') {
          const r = this.active.get(t.id);
          if (r) {
            r.intent = 'cancel';
            void r.handle.terminate(this.config.terminateGraceMs);
          }
        } else {
          this.store.updateWorker(t.id, { status: 'cancelled', finished_at: new Date().toISOString(), error: 'cancelled: workflow failure_policy=cancel_remaining' });
          this.store.addEvent(t.id, 'cancel', 'cancel_remaining policy');
          this.notifyWaiters(t.id);
        }
      }
    } else if (failedTask && wf.failure_policy === 'stop_dependents') {
      // Transitively block downstream tasks still waiting on dependencies.
      const tasks = this.store.workersInWorkflow(wfId);
      const downstream = new Set<string>();
      let changed = true;
      downstream.add(row.id);
      while (changed) {
        changed = false;
        for (const t of tasks) {
          if (downstream.has(t.id) || isTerminal(t.status)) continue;
          const deps = parseJsonArray(t.depends_on);
          if (deps.some((d) => downstream.has(d))) {
            downstream.add(t.id);
            changed = true;
          }
        }
      }
      downstream.delete(row.id);
      for (const id of downstream) {
        const t = tasks.find((x) => x.id === id)!;
        if (t.status === 'waiting_dependencies' || t.status === 'queued') {
          this.blockTask(t, [{ task_id: row.id, status: row.status }]);
        }
      }
    }

    this.updateWorkflowState(wfId);
  }

  private updateWorkflowState(wfId: string): void {
    const wf = this.store.getWorkflow(wfId);
    if (!wf || wf.status !== 'running') return;
    const tasks = this.store.workersInWorkflow(wfId);
    if (tasks.length === 0) return;
    if (tasks.some((t) => !isTerminal(t.status as WorkerStatus))) return;

    const bad = tasks.filter((t) => t.status !== 'completed' && t.status !== 'completed_uncommitted');
    const status = bad.length === 0 ? 'completed' : 'completed_with_failures';
    this.store.updateWorkflow(wfId, { status, finished_at: new Date().toISOString() });
    this.store.addEvent(wfId, 'workflow', `terminal: ${status} (${tasks.length - bad.length}/${tasks.length} ok)`);
    this.notifyWaiters(wfId);
  }

  /* ------------------------------------------------------------------ */

  /** Compact, verified result. Never includes thinking or raw tool output. */
  result(workerId: string): Record<string, unknown> {
    const row = this.get(workerId);
    const git = this.collectGitFacts(row);
    const summary = summarizeFinalText(row.final_text);

    const commit = git.commitHash ?? row.commit_hash;
    let commitShort: string | null = null;
    let commitSubject: string | null = null;
    if (commit && fs.existsSync(row.worktree_path)) {
      commitShort = commit.slice(0, 7);
      commitSubject = lastCommit(row.worktree_path)?.subject ?? null;
    }

    const result: Record<string, unknown> = {
      worker_id: row.id,
      status: row.status,
      mode: row.mode,
      session_id: row.session_id,
      branch: row.branch || null,
      worktree: row.worktree_path,
      repo_path: row.repo_path || null,
      base_ref: row.base_ref || null,
      summary: summary.summary,
      changed_files: git.changedFiles.length > 0 ? git.changedFiles : git.uncommitted,
      uncommitted_changes: git.dirty ? git.uncommitted : [],
      commit_hash: commitShort,
      commit_subject: commitSubject,
      tests: summary.tests,
      review_attention: summary.review_attention,
      known_issues: summary.known_issues,
      git: row.workspace_type === 'git_worktree' ? this.gitInfo(row) : null,
      final_report: row.final_text
        ? truncateUtf8(redactSecrets(row.final_text), 16 * 1024).text
        : null,
      usage: {
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cache_read_tokens: row.cache_read_tokens,
        total_tokens_last: row.total_tokens_last,
      },
      timing: {
        created_at: row.created_at,
        started_at: row.started_at,
        finished_at: row.finished_at,
        elapsed_seconds: elapsedSeconds(row),
      },
      continue_count: row.continue_count,
    };
    if (row.error) result['error'] = redactSecrets(row.error);
    if (row.exit_code !== null) result['exit_code'] = row.exit_code;
    // Backend-exhaustion handoff metadata (facts only, no cause guessing).
    result['attempts'] = row.attempt;
    result['retries_exhausted'] =
      (row.status === 'failed' || row.status === 'timeout') &&
      parseJsonArray(row.retry_on).includes(row.status) &&
      row.attempt >= row.max_attempts;
    if (isTerminal(row.status)) result['work_preserved'] = fs.existsSync(row.worktree_path);
    return result;
  }

  /** Task-oriented result: mode/workspace/artifacts/deliverables first-class. */
  taskResult(workerId: string): Record<string, unknown> {
    const row = this.get(workerId);
    const summary = summarizeFinalText(row.final_text);
    const artifacts = this.store.listArtifacts(workerId).map((a) => artifactSummary(a));

    const out: Record<string, unknown> = {
      task_id: row.id,
      mode: row.mode,
      status: row.status,
      acceptance: row.acceptance,
      role: row.role,
      backend: row.backend_id,
      model: row.model,
      session_id: row.session_id,
      backend_session_id: row.session_id,
      workspace: { type: row.workspace_type, path: row.worktree_path },
      summary: summary.summary,
      artifacts,
      deliverables: parseJsonArray(row.deliverables),
      deliverables_missing: parseJsonArray(row.deliverables_missing),
      usage: {
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cache_read_tokens: row.cache_read_tokens,
        total_tokens_last: row.total_tokens_last,
      },
      review_attention: summary.review_attention,
      known_issues: summary.known_issues,
      final_report: row.final_text
        ? truncateUtf8(redactSecrets(row.final_text), 16 * 1024).text
        : null,
      timing: {
        created_at: row.created_at,
        started_at: row.started_at,
        finished_at: row.finished_at,
        elapsed_seconds: elapsedSeconds(row),
      },
      continue_count: row.continue_count,
    };

    if (row.workspace_type === 'git_worktree') {
      const git = this.collectGitFacts(row);
      const commit = git.commitHash ?? row.commit_hash;
      out['repo_path'] = row.repo_path;
      out['branch'] = row.branch;
      out['base_ref'] = row.base_ref;
      out['changed_files'] = git.changedFiles.length > 0 ? git.changedFiles : git.uncommitted;
      out['uncommitted_changes'] = git.dirty ? git.uncommitted : [];
      out['commit_hash'] = commit ? commit.slice(0, 7) : null;
      out['commit_subject'] = commit && fs.existsSync(row.worktree_path)
        ? (lastCommit(row.worktree_path)?.subject ?? null)
        : null;
      out['tests'] = summary.tests;
      out['git'] = {
        ...this.gitInfo(row),
        task_branch: row.task_branch,
        workspace_base_commit: row.workspace_base_commit,
        commits: parseJsonArray(row.task_commits),
        integration: row.workflow_id
          ? {
              status: row.integration_status,
              error: row.integration_error ? JSON.parse(row.integration_error) : null,
              integrated_commits: parseJsonArray(row.integrated_commits),
            }
          : null,
      };
    }
    out['backend_metadata'] = row.backend_metadata ? this.safeJson(row.backend_metadata) : null;
    if (row.error) out['error'] = redactSecrets(row.error);
    if (row.exit_code !== null) out['exit_code'] = row.exit_code;
    // Backend-exhaustion handoff metadata (Part 26): facts only, no guessing.
    const retryOn = parseJsonArray(row.retry_on);
    const retriable = (s: string) => retryOn.includes(s);
    out['attempts'] = row.attempt;
    out['retries_exhausted'] =
      (row.status === 'failed' || row.status === 'timeout') &&
      retriable(row.status) &&
      row.attempt >= row.max_attempts;
    if (isTerminal(row.status)) out['work_preserved'] = fs.existsSync(row.worktree_path);
    return out;
  }

  /* ------------------------------ artifacts ------------------------------ */

  listArtifacts(workerId: string): Array<Record<string, unknown>> {
    this.get(workerId);
    return this.store.listArtifacts(workerId).map((a) => artifactSummary(a));
  }

  private lookupArtifact(workerId: string, relPath: string): ArtifactRow {
    const row = this.get(workerId);
    const rel = validateRelativePath(relPath).split(path.sep).join('/');
    let art = this.store.getArtifact(workerId, rel);
    if (!art) {
      // Not indexed yet — index on the fly if it genuinely lives in the workspace.
      const abs = resolveUnderRoot(row.worktree_path, rel);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        this.store.upsertArtifact({
          task_id: workerId,
          relative_path: rel,
          absolute_path: abs,
          mime_type: guessMimeType(abs),
          size_bytes: fs.statSync(abs).size,
          sha256: sha256File(abs),
        });
        art = this.store.getArtifact(workerId, rel);
      }
    }
    if (!art) throw new Error(`no such artifact for task ${workerId}: ${relPath}`);
    return art;
  }

  artifactMetadata(workerId: string, relPath: string): Record<string, unknown> {
    const art = this.lookupArtifact(workerId, relPath);
    const exists = fs.existsSync(art.absolute_path);
    return { ...artifactSummary(art), exists };
  }

  artifactContent(workerId: string, relPath: string, maxBytes?: number): Record<string, unknown> {
    const art = this.lookupArtifact(workerId, relPath);
    if (!fs.existsSync(art.absolute_path)) {
      throw new Error(`artifact file no longer exists: ${art.relative_path}`);
    }
    const limit = Math.min(Math.max(maxBytes ?? ARTIFACT_DEFAULT_BYTES, 1), ARTIFACT_READ_CAP);
    const meta = artifactSummary(art);

    if (isProbablyBinary(art.absolute_path)) {
      return {
        ...meta,
        binary: true,
        truncated: false,
        content: null,
        note: 'binary artifact — content not served inline; fetch it from the workspace path directly',
      };
    }

    const fd = fs.openSync(art.absolute_path, 'r');
    const buf = Buffer.alloc(limit + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const raw = buf.subarray(0, Math.min(n, limit)).toString('utf8');
    const t = truncateUtf8(redactSecrets(raw), limit);
    return {
      ...meta,
      binary: false,
      truncated: n > limit || t.truncated,
      content: t.text,
    };
  }

  /* ------------------------------ usage ------------------------------ */

  taskUsage(workerId: string): Record<string, unknown> {
    const row = this.get(workerId);
    const events = this.store.listEvents(workerId, 100000);
    const toolCalls = events.filter((e) => e.type === 'tool_call');
    const byTool: Record<string, number> = {};
    for (const e of toolCalls) {
      const tool = (e.summary ?? '?').split(' (')[0] ?? '?';
      byTool[tool] = (byTool[tool] ?? 0) + 1;
    }
    return {
      task_id: workerId,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_read_tokens: row.cache_read_tokens,
      total_tokens_last: row.total_tokens_last,
      steps: events.filter((e) => e.type === 'status' && e.summary === 'step_end').length,
      tool_calls: toolCalls.length,
      tool_calls_by_tool: byTool,
      runs: events.filter((e) => e.type === 'session').length,
      duration_seconds: elapsedSeconds(row),
    };
  }

  /* ------------------------------------------------------------------ */

  /** Human-readable tail of the worker log, redacted and size-capped. */
  log(workerId: string, tail = 100): { worker_id: string; lines: string; truncated: boolean } {
    const row = this.get(workerId);
    const stdoutPath = path.join(row.log_dir, 'stdout.jsonl');
    let content = '';
    try {
      content = fs.readFileSync(stdoutPath, 'utf8');
    } catch {
      content = '';
    }
    const backend = this.backendFor(row);
    const parseLine = backend.parseLine ? (line: string) => backend.parseLine!(line) : parseDshLine;
    const rendered: string[] = [];
    for (const line of tailLines(content, tail).split('\n')) {
      const ev = parseLine(line);
      if (ev) rendered.push(renderLogLine(ev));
    }
    let out = rendered.join('\n');
    const stderrPath = path.join(row.log_dir, 'stderr.log');
    try {
      const stderr = fs.readFileSync(stderrPath, 'utf8').trim();
      if (stderr !== '') {
        out += `\n--- stderr (tail) ---\n` + tailLines(stderr, 20);
      }
    } catch {
      /* no stderr log */
    }
    const t = truncateUtf8(redactSecrets(out), this.config.logMaxBytes);
    return { worker_id: workerId, lines: t.text, truncated: t.truncated };
  }

  /** git diff vs base. stat_only=true (default) returns --stat only. */
  diff(workerId: string, opts: { stat_only?: boolean | undefined; path?: string | undefined }): Record<string, unknown> {
    const row = this.get(workerId);
    if (row.workspace_type !== 'git_worktree') {
      throw new Error(`worker ${workerId} does not use a git worktree (workspace=${row.workspace_type})`);
    }
    if (!fs.existsSync(row.worktree_path)) {
      throw new Error(`worktree no longer exists for worker ${workerId}`);
    }
    const statOnly = opts.stat_only ?? true;
    if (opts.path && (opts.path.includes('..') || path.isAbsolute(opts.path))) {
      throw new Error('diff path must be a relative path inside the repo');
    }
    if (statOnly) {
      const stat = diffStat(row.worktree_path, row.base_ref, opts.path);
      const uncommitted = uncommittedPaths(row.worktree_path);
      return {
        worker_id: workerId,
        stat_only: true,
        diff_stat: redactSecrets(stat.trim()),
        uncommitted_changes: uncommitted,
      };
    }
    const full = diffFull(row.worktree_path, row.base_ref, opts.path);
    const t = truncateUtf8(redactSecrets(full), this.config.diffMaxBytes);
    return {
      worker_id: workerId,
      stat_only: false,
      diff: t.text,
      truncated: t.truncated,
    };
  }

  /**
   * Graceful server shutdown: DETACH, never kill. Workers are durable —
   * they outlive the supervisor and will be reattached by the next server
   * instance via reconciliation. Only cancel_worker/cancel_workflow/
   * timeout/budget terminate worker processes.
   */
  async shutdown(): Promise<void> {
    this.shutDown = true;
    for (const [id, run] of this.active.entries()) {
      if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
      if (run.tailTimer) clearTimeout(run.tailTimer);
      this.store.updateWorker(id, { supervision_state: 'detached' });
      this.store.addEvent(id, 'shutdown', 'supervisor exiting; worker left running (durable)');
    }
    this.active.clear();
  }

  /** Process diagnostics for CLI inspect / debugging. */
  processDiagnostics(workerId: string): Record<string, unknown> {
    const row = this.get(workerId);
    const backend = this.backendFor(row);
    const marker = backend.processMarker ?? backend.id;
    const alive = row.pid ? pidAlive(row.pid) : false;
    const identityOk = row.pid ? isExpectedWorkerProcess(row.pid, row.pid_identity, marker) : false;
    let lastEventAt: string | null = null;
    const events = this.store.listEvents(workerId, 1);
    if (events.length > 0) lastEventAt = events[0]!.ts;
    return {
      task_id: workerId,
      status: row.status,
      pid: row.pid,
      process_alive: alive,
      identity_matches: row.pid ? identityOk : null,
      supervision: row.supervision_state,
      stdout_parse_offset: row.stdout_parse_offset,
      run_started_at: row.run_started_at,
      last_event_at: lastEventAt,
    };
  }
}

function validateWaitTimeout(raw: number | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!Number.isFinite(raw) || raw < 1 || raw > WAIT_MAX_SECONDS) {
    throw new Error(`timeout_seconds must be between 1 and ${WAIT_MAX_SECONDS}`);
  }
  return Math.floor(raw);
}

function artifactSummary(a: ArtifactRow): Record<string, unknown> {  return {
    path: a.relative_path,
    mime_type: a.mime_type,
    size_bytes: a.size_bytes,
    sha256: a.sha256,
    indexed_at: a.created_at,
  };
}

export function elapsedSeconds(row: WorkerRow): number | null {
  if (!row.started_at) return null;
  const start = Date.parse(row.started_at);
  const end = row.finished_at ? Date.parse(row.finished_at) : Date.now();
  return Math.max(0, Math.round((end - start) / 1000));
}
