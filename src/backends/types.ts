import type { DshEvent } from '../parser.js';
import type { TaskMode } from '../modes.js';

/* ------------------------------------------------------------------ *
 * Universal backend model.
 *
 * Three distinct concepts, never conflated:
 *   Orchestrator — this MCP (scheduling, DAG, git, budgets, metrics)
 *   Runtime backend — the process that executes tasks (e.g. DeepSeek Harness)
 *   Model provider — whoever the runtime is configured to call (e.g. Kimi)
 *
 * The orchestrator never reads provider credentials; runtimes own those.
 * ------------------------------------------------------------------ */

export interface BackendStartOptions {
  workerId: string;
  /** Working directory = the task's workspace. */
  cwd: string;
  /** Full prompt passed to the worker runtime. */
  prompt: string;
  /** Existing backend session id to resume, or null for a fresh session. */
  sessionId: string | null;
  /** File to append the raw durable event stream to. */
  stdoutPath: string;
  /** File to append stderr to. */
  stderrPath: string;
}

export interface BackendEvents {
  /** Called for every parsed raw event (including malformed ones). */
  onEvent(ev: DshEvent): void;
  /** Called exactly once when the backend run ends. */
  onExit(code: number | null, signal: string | null): void;
  onStderr?(chunk: string): void;
  onSpawnError?(err: Error): void;
}

export interface WorkerBackendHandle {
  /** OS pid of the worker process, or null for in-process (fake) backends. */
  readonly pid: number | null;
  /** Graceful terminate → force kill after graceMs. Idempotent. */
  terminate(graceMs: number): Promise<void>;
}

export interface BackendCapabilities {
  /** Session continuation (continue_worker). */
  continuation: boolean;
  /** Can be reattached after a supervisor restart (pid + durable logs). */
  durableReattach: boolean;
  /** Emits structured machine-readable events. */
  structuredEvents: boolean;
  /** Emits token usage information. */
  usageReporting: boolean;
  /** Emits tool call/result events. */
  toolCallEvents: boolean;
  /** Produces file artifacts in the workspace. */
  artifacts: boolean;
  supportedModes?: TaskMode[];
}

/** Optional runtime/provider metadata — only facts, never guesses. */
export interface BackendMetadata {
  runtime?: { name?: string | undefined; version?: string | undefined };
  provider?: { name?: string | undefined; model?: string | undefined };
}

export interface WorkerBackend {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: BackendCapabilities;
  /** Marker expected in the worker process command line (reattach identity). */
  readonly processMarker?: string | undefined;
  /**
   * When true, the backend redirects child stdout/stderr directly to the
   * durable log files and does NOT emit parsed events — the supervisor tails
   * the files instead (shared with the reattach path).
   */
  readonly durableStdout?: boolean | undefined;
  /** Local runtime availability (no API calls, no quota usage). */
  isAvailable(): boolean;
  /** Optional runtime/provider facts known without contacting the provider. */
  metadata?(): BackendMetadata;
  start(opts: BackendStartOptions, events: BackendEvents): WorkerBackendHandle;
}
