import type { DshEvent } from '../parser.js';

export interface BackendStartOptions {
  workerId: string;
  /** Working directory = the worker's git worktree. */
  cwd: string;
  /** Full prompt passed to the worker runtime. */
  prompt: string;
  /** Existing dsh session id to resume, or null for a fresh session. */
  sessionId: string | null;
  /** File to append raw JSONL stdout to. */
  stdoutPath: string;
  /** File to append stderr to. */
  stderrPath: string;
}

export interface BackendEvents {
  /** Called for every parsed stdout line (including malformed ones). */
  onEvent(ev: DshEvent): void;
  /** Called exactly once when the backend run ends. */
  onExit(code: number | null, signal: string | null): void;
  /** Called for stderr chunks (already written to stderrPath by the backend). */
  onStderr?(chunk: string): void;
  /** Called when the process itself failed to start. */
  onSpawnError?(err: Error): void;
}

export interface WorkerBackendHandle {
  /** OS pid of the worker process, or null for in-process (fake) backends. */
  readonly pid: number | null;
  /**
   * Gracefully terminate: SIGTERM (or fake equivalent), wait graceMs,
   * then SIGKILL. Resolves once the process is gone. Idempotent.
   */
  terminate(graceMs: number): Promise<void>;
}

export interface WorkerBackend {
  readonly name: string;
  /** Marker expected in a worker process command line (used by reattach
   * identity checks; omit for in-process backends without real pids). */
  readonly processMarker?: string;
  start(opts: BackendStartOptions, events: BackendEvents): WorkerBackendHandle;
}
