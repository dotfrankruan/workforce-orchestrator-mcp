import type { DshEvent } from '../parser.js';
import type { WorkerEvent } from './events.js';
import type { TaskMode } from '../modes.js';

/* ------------------------------------------------------------------ *
 * Universal backend model.
 *
 * Three distinct concepts, never conflated:
 *   Orchestrator — this MCP (scheduling, DAG, git, budgets, metrics)
 *   Runtime backend — the process that executes tasks (e.g. DeepSeek Harness)
 *   Model provider — whoever the runtime is configured to call (e.g. OpenAI, Anthropic)
 *
 * Runtime backends normally own their credentials; direct API backends read
 * only their explicitly configured API-key environment variables.
 * ------------------------------------------------------------------ */

export interface BackendStartOptions {
  workerId: string;
  /** Per-run model override (backend-specific). Undefined = backend default. */
  model?: string | undefined;
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

/** One model a runtime is configured to serve (facts read from runtime config). */
export interface BackendModelEntry {
  provider: string;
  id: string;
  name?: string | undefined;
}

/** Runtime-discovered model/provider facts. Never guessed. */
export interface BackendRuntimeInfo {
  models: BackendModelEntry[];
  default?: {
    provider?: string | undefined;
    model?: string | undefined;
    reasoningEffort?: string | undefined;
  } | undefined;
}

export interface BackendCapabilities {
  /** Accepts a per-run model override (spawn_task { model }). */
  modelSelection: boolean;
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
  /**
   * Discover the runtime's configured models/default selection WITHOUT any
   * network call (e.g. dsh --dump-config). null/undefined = unknown.
   */
  inspectRuntime?(): BackendRuntimeInfo | null;
  /**
   * Parse one durable stdout line into the normalized raw event shape.
   * Defaults to the DSH JSONL parser. Backends whose wire format differs
   * (e.g. OpenCode) override this so durable logs remain backend-agnostic.
   * May return canonical `{type:"final"}` lines emitted by the backend itself.
   */
  parseLine?(line: string): DshEvent | null;
  start(opts: BackendStartOptions, events: BackendEvents): WorkerBackendHandle;
  /** Adapt one raw backend event into normalized worker events (may drop:
   *  thinking never reaches the supervisor). */
  normalizeEvent(raw: DshEvent): WorkerEvent[];
}
