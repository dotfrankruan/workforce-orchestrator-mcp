import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import {
  WorkerStore,
  isTerminal,
  type WorkerRow,
  type WorkerStatus,
  type ListFilter,
  type ArtifactRow,
} from './db.js';
import { newWorkerId, isValidWorkerId } from './util/ids.js';
import { pidAlive } from './util/paths.js';
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
} from './worktree.js';
import { buildContinuePrompt } from './prompt.js';
import { buildModePrompt } from './prompts/index.js';
import { parseTaskMode, type TaskMode } from './modes.js';
import {
  isWorkspaceType,
  planWorkspace,
  prepareWorkspace,
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
import type { WorkerBackend, WorkerBackendHandle } from './backend/types.js';

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
}

export interface SpawnTaskResult {
  task_id: string;
  status: WorkerStatus;
  mode: TaskMode;
  workspace: { type: WorkspaceType; path: string };
  branch: string | null;
  session_id: string | null;
  queued: boolean;
}

interface ActiveRun {
  handle: WorkerBackendHandle;
  usage: UsageTracker;
  intent: 'run' | 'cancel' | 'timeout';
  timeoutTimer: NodeJS.Timeout | null;
  /** HEAD captured when this run started (run-level git tracking). */
  headBeforeRun: string | null;
  done: Promise<void>;
  resolveDone: () => void;
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
  /**
   * Event-driven wait support: terminal-state waiters per task id.
   * No locks are held while waiting — waiter callbacks are invoked
   * synchronously from the same code paths that mark a worker terminal,
   * so worker completion can never deadlock behind a pending wait.
   */
  private waiters = new Map<string, Set<() => void>>();

  constructor(
    private config: Config,
    private store: WorkerStore,
    private backend: WorkerBackend,
  ) {}

  /** Startup reconciliation: fix statuses of workers whose processes are gone. */
  init(): void {
    const activeRows = this.store.findActive();
    for (const row of activeRows) {
      if (row.status === 'queued') continue; // will be scheduled below
      this.reconcileRow(row);
    }
    this.schedule();
  }

  private reconcileRow(row: WorkerRow): void {
    if (row.pid && pidAlive(row.pid)) {
      // The process still exists but this server instance has no pipes to it
      // (server restart). We cannot observe its events anymore; be honest.
      this.store.updateWorker(row.id, {
        status: 'interrupted',
        finished_at: new Date().toISOString(),
        error: 'server restarted while worker was running; process may still exist but is no longer supervised',
      });
      this.store.addEvent(row.id, 'reconcile', 'live pid but unsupervised after restart → interrupted');
      this.notifyWaiters(row.id);
      return;
    }

    // Process is gone. Recover what we can from logs, git and artifacts.
    const replay = replayLogFile(path.join(row.log_dir, 'stdout.jsonl'));
    const patch: Partial<WorkerRow> = {
      pid: null,
      finished_at: row.finished_at ?? new Date().toISOString(),
      input_tokens: replay.usage.inputTokens,
      output_tokens: replay.usage.outputTokens,
      cache_read_tokens: replay.usage.cacheReadTokens,
      total_tokens_last: replay.usage.lastTotalTokens,
    };
    if (replay.sessionId && !row.session_id) patch.session_id = replay.sessionId;
    if (replay.finalText && !row.final_text) {
      patch.final_text = replay.finalText.slice(0, this.config.finalTextMaxChars);
    }

    const git = this.collectGitFacts(row);
    if (git.commitHash) patch.commit_hash = git.commitHash;

    let status: WorkerStatus;
    if (row.workspace_type !== 'git_worktree') {
      status = replay.finalText ? 'completed' : 'interrupted';
    } else if (git.commitHash && !git.dirty) {
      status = 'completed';
    } else if (git.commitHash && git.dirty) {
      status = 'completed_uncommitted';
    } else if (replay.finalText) {
      status = git.dirty ? 'completed_uncommitted' : 'interrupted';
    } else {
      status = 'interrupted';
    }
    this.store.updateWorker(row.id, {
      ...patch,
      status,
      error: status === 'interrupted' ? 'worker process disappeared before completion' : null,
    });
    this.store.addEvent(row.id, 'reconcile', `dead pid → ${status}`);
    this.finalizeArtifacts(this.get(row.id));
    this.notifyWaiters(row.id);
  }

  /* ------------------------------------------------------------------ *
   * Spawning
   * ------------------------------------------------------------------ */

  spawnTask(params: SpawnTaskParams): SpawnTaskResult {
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
    if (timeoutSeconds <= 0) throw new Error('timeout_seconds must be positive');
    if (timeoutSeconds > this.config.maxTimeoutSeconds) timeoutSeconds = this.config.maxTimeoutSeconds;

    const deliverables = sanitizeDeliverables(params.deliverables);
    const capabilities = sanitizeCapabilities(params.capabilities);

    // Unique worker id (collision-proof against the db).
    let id = newWorkerId();
    while (this.store.getWorker(id) !== null) id = newWorkerId();

    let plan: PlannedWorkspace;
    try {
      plan = planWorkspace(resolved.type, wsInput, { workerRoot: this.config.workerRoot, workerId: id });
      prepareWorkspace(plan);
    } catch (err) {
      throw err;
    }

    const row = this.store.createWorker({
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
    });
    this.store.addEvent(
      id,
      'spawn',
      `mode=${resolved.mode} workspace=${plan.type}${plan.branch ? ` branch=${plan.branch} base=${plan.baseRef.slice(0, 12)}` : ''}`,
    );

    this.schedule();

    return {
      task_id: id,
      status: row.status,
      mode: resolved.mode,
      workspace: { type: plan.type, path: plan.cwd },
      branch: plan.branch || null,
      session_id: null,
      queued: true,
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
   * (e.g. `kimi-worker-mcp cancel` from the CLI), which cannot notify
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

  /* ------------------------------------------------------------------ */

  async continueWorker(workerId: string, instruction: string): Promise<{ worker_id: string; status: WorkerStatus; session_id: string | null }> {
    if (!instruction || instruction.trim() === '') {
      throw new Error('instruction must be a non-empty string');
    }
    const row = this.get(workerId);
    if (this.active.has(workerId) || row.status === 'running' || row.status === 'starting' || row.status === 'queued') {
      throw new Error(`worker ${workerId} is still active; cancel it or wait for completion before continuing`);
    }
    if (!row.session_id) {
      throw new Error(`worker ${workerId} has no recorded dsh session id; cannot resume`);
    }
    if (!fs.existsSync(row.worktree_path)) {
      throw new Error(`worker ${workerId} workspace no longer exists: ${row.worktree_path}`);
    }
    this.store.updateWorker(workerId, {
      status: 'queued',
      error: null,
      continue_count: row.continue_count + 1,
    });
    this.store.addEvent(workerId, 'continue', instruction.slice(0, MAX_EVENT_SUMMARY));
    this.schedule();
    return { worker_id: workerId, status: 'queued', session_id: row.session_id };
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
    if (row.status === 'queued') {
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
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      while (this.active.size < this.config.maxConcurrent) {
        const next = this.oldestQueued();
        if (!next) break;
        this.startRun(next, { resumeSessionId: next.session_id });
      }
    } finally {
      this.scheduling = false;
    }
  }

  private oldestQueued(): WorkerRow | null {
    // Queue is small in practice; pick the oldest queued worker (FIFO).
    const all = this.store.listWorkers({ status: 'queued', limit: 500 });
    all.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return all[0] ?? null;
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

  private buildPrompt(row: WorkerRow, isResume: boolean): string {
    if (isResume) return buildContinuePrompt(this.peekContinueInstruction(row));
    const subagentsNote =
      this.config.enableDshSubagents && (row.mode === 'research' || row.mode === 'general')
        ? `You may delegate independent sub-investigations to subagents when your runtime supports it (depth ≤ ${this.config.maxSubagentDepth}, at most ${this.config.maxSubagentsPerTask} subagents). Keep delegation minimal and integrate the results yourself.`
        : undefined;
    return buildModePrompt(row.mode as TaskMode, {
      task: row.task,
      deliverables: parseJsonArray(row.deliverables),
      capabilities: parseJsonArray(row.capabilities),
      workspaceDescription: this.workspaceDescription(row),
      subagentsNote,
    });
  }

  private startRun(
    row: WorkerRow,
    opts: { resumeSessionId: string | null },
  ): void {
    const isResume = opts.resumeSessionId !== null;
    const prompt = this.buildPrompt(row, isResume);

    const stdoutPath = path.join(row.log_dir, 'stdout.jsonl');
    const stderrPath = path.join(row.log_dir, 'stderr.log');

    const usage = new UsageTracker();
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));

    this.store.updateWorker(row.id, {
      status: 'starting',
      started_at: row.started_at ?? new Date().toISOString(),
      error: null,
    });

    let handle: WorkerBackendHandle;
    const runRef: { current: ActiveRun | null } = { current: null };

    try {
      handle = this.backend.start(
        {
          workerId: row.id,
          cwd: row.worktree_path,
          prompt,
          sessionId: opts.resumeSessionId,
          stdoutPath,
          stderrPath,
        },
        {
          onEvent: (ev) => this.handleEvent(row.id, ev, usage),
          onStderr: () => {},
          onSpawnError: (err) => {
            this.store.addEvent(row.id, 'spawn_error', redactSecrets(err.message).slice(0, MAX_EVENT_SUMMARY));
          },
          onExit: (code, signal) => {
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
      done,
      resolveDone,
    };
    runRef.current = run;
    this.active.set(row.id, run);

    this.store.updateWorker(row.id, { status: 'running', pid: handle.pid });
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

  private handleEvent(workerId: string, ev: DshEvent, usage: UsageTracker): void {
    if (ev.usage) usage.apply(ev.usage);

    switch (ev.type) {
      case 'session': {
        if (ev.sessionId) {
          this.store.updateWorker(workerId, { session_id: ev.sessionId });
          this.store.addEvent(workerId, 'session', ev.sessionId);
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
        if (ev.phase) this.store.addEvent(workerId, 'status', ev.phase);
        break;
      }
      case 'text': {
        if (ev.text) {
          const progress = ev.text.replace(/\s+/g, ' ').trim().slice(0, MAX_PROGRESS_CHARS);
          this.store.updateWorker(workerId, { last_progress: progress });
        }
        break;
      }
      case 'tool_call': {
        this.store.addEvent(workerId, 'tool_call', `${ev.tool ?? '?'} (${ev.callId ?? '?'})`);
        break;
      }
      case 'tool_result': {
        this.store.addEvent(workerId, 'tool_result', `${ev.status ?? '?'} (${ev.callId ?? '?'})`);
        break;
      }
      case 'final': {
        if (ev.text) {
          this.store.updateWorker(workerId, {
            final_text: ev.text.slice(0, this.config.finalTextMaxChars),
          });
        }
        this.store.addEvent(workerId, 'final', 'received');
        break;
      }
      default: {
        if (ev.malformed) {
          this.store.addEvent(workerId, 'malformed', (ev.rawLine ?? '').slice(0, 120));
        }
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
      ? `kimi-worker/${row.id}: finalize remaining changes`
      : `kimi-worker/${row.id}: apply delegated changes`;
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
    if (branchNow !== row.branch) {
      commitError = `worker left worktree on unexpected ref ${branchNow ?? '(detached)'} (expected ${row.branch}); refusing to commit`;
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
    const row = this.get(workerId);
    if (!run) {
      // Exit for a run we no longer track (shouldn't happen); ignore.
      return;
    }

    // Respect a terminal status set concurrently (e.g. cancel via CLI in
    // another process): keep the status, only refresh observed facts.
    const presetTerminal = isTerminal(row.status) ? row.status : null;

    const usageSnap = run.usage.snapshot();

    const basePatch = {
      pid: null,
      exit_code: exitCode,
      input_tokens: usageSnap.input_tokens,
      output_tokens: usageSnap.output_tokens,
      cache_read_tokens: usageSnap.cache_read_tokens,
      total_tokens_last: usageSnap.total_tokens_last,
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
      this.store.updateWorker(workerId, {
        ...basePatch,
        commit_hash: this.collectGitFacts(row).commitHash ?? row.commit_hash,
        status: presetTerminal ?? 'cancelled',
        finished_at: row.finished_at ?? new Date().toISOString(),
        error: presetTerminal ? row.error : null,
      });
      this.store.addEvent(workerId, 'cancel', `terminated (signal=${signal ?? 'n/a'})`);
      this.finalizeArtifacts(this.get(workerId));
      this.notifyWaiters(workerId);
      return;
    }

    if (run.intent === 'timeout') {
      if (row.workspace_type === 'git_worktree') {
        const dirty = statusPorcelain(row.worktree_path) !== '';
        this.recordGitFinalize(workerId, {
          autoCommitSkipped: 'worker execution timed out — dirty working tree preserved',
          workingTreeDirty: dirty,
          headBefore: run.headBeforeRun,
        });
      }
      this.store.updateWorker(workerId, {
        ...basePatch,
        commit_hash: this.collectGitFacts(row).commitHash ?? row.commit_hash,
        status: 'timeout',
        finished_at: new Date().toISOString(),
        error: `exceeded timeout of ${row.timeout_seconds ?? this.config.defaultTimeoutSeconds}s`,
      });
      this.finalizeArtifacts(this.get(workerId));
      this.notifyWaiters(workerId);
      return;
    }

    const exitedCleanly = exitCode === 0;

    let gitFin: { workerCommitted: boolean; supervisorCommitted: boolean; commitError: string | null } | null = null;
    if (exitedCleanly && row.workspace_type === 'git_worktree') {
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

    // Recompute after any supervisor commit.
    const git = this.collectGitFacts(row);

    let status: WorkerStatus;
    let error: string | null = null;
    if (!exitedCleanly) {
      status = 'failed';
      error = `dsh exited with code=${exitCode ?? 'null'} signal=${signal ?? 'null'}`;
      if (row.workspace_type === 'git_worktree') {
        this.recordGitFinalize(workerId, {
          autoCommitSkipped: 'worker execution failed',
          workingTreeDirty: git.dirty,
          headBefore: run.headBeforeRun,
        });
      }
    } else if (row.workspace_type !== 'git_worktree') {
      status = 'completed';
      error = row.final_text ? null : 'worker produced no final report';
    } else if (gitFin?.commitError && git.dirty) {
      status = 'completed_uncommitted';
      error = gitFin.commitError;
    } else if (git.dirty) {
      status = 'completed_uncommitted';
      error = 'worker finished but uncommitted modifications remain in the worktree';
    } else {
      status = 'completed';
      if (!git.commitHash && !row.final_text) {
        error = 'worker made no changes and produced no final report';
      }
    }

    this.store.updateWorker(workerId, {
      ...basePatch,
      commit_hash: git.commitHash ?? row.commit_hash,
      status,
      error,
      finished_at: new Date().toISOString(),
    });
    this.store.addEvent(workerId, 'finish', `status=${status} exit=${exitCode ?? 'null'}`);
    this.finalizeArtifacts(this.get(workerId));
    this.notifyWaiters(workerId);
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
      session_id: row.session_id,
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
      out['git'] = this.gitInfo(row);
    }
    if (row.error) out['error'] = redactSecrets(row.error);
    if (row.exit_code !== null) out['exit_code'] = row.exit_code;
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
    const rendered: string[] = [];
    for (const line of tailLines(content, tail).split('\n')) {
      const ev = parseDshLine(line);
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

  /** Terminate all active runs (server shutdown). */
  async shutdown(): Promise<void> {
    const runs = [...this.active.entries()];
    await Promise.all(
      runs.map(async ([id, run]) => {
        run.intent = 'cancel';
        if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
        await run.handle.terminate(this.config.terminateGraceMs);
        await run.done.catch(() => {});
        this.store.addEvent(id, 'shutdown', 'server shutdown');
      }),
    );
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
