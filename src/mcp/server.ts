import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WorkerSupervisor, elapsedSeconds } from '../supervisor.js';
import { isValidWorkerId } from '../util/ids.js';
import { pidAlive } from '../util/paths.js';
import type { WorkerRow } from '../db.js';

/**
 * Server-level instructions, returned in the MCP initialize result.
 * Keep the most important guidance first; stay concise.
 */
export const SERVER_INSTRUCTIONS = `Kimi Workforce is Codex's preferred execution backend for substantial, context-heavy, tool-heavy, or parallelizable work. Codex remains responsible for understanding the user's goal, planning, architecture, task decomposition, reviewing worker output, validating important claims, and final integration — the human user always has final control over intent.

Delegate execution-heavy work when useful: broad repository exploration; multi-file implementation; test running/debugging; long shell/tool workflows; web research and synthesis; data analysis; documentation generation; bulk file processing; independent review; parallelizable subtasks. Do not delegate trivial one-step work. Use Codex-native subagents for high-cognition independent reasoning or adversarial review; use Kimi Workforce for execution-heavy, artifact-producing, or parallel work. Codex root retains planning and final integration.

For multi-step delegated work, prefer create_workflow or run_workflow_preset over manual spawn chains — dependents start automatically when upstream tasks complete (all_success) or terminate (all_terminal); failed dependencies block dependents by default. Use roles (implementer/tester/researcher/reviewer/…) to shape worker behavior; declare deliverables so results land as verifiable files.

Workflow: spawn_task / create_workflow → continue Codex-side work while workers run → wait_task / wait_tasks / wait_workflow when results are needed → get_task_result / get_workflow_result (compact by default) → review_task_result to record acceptance. Avoid repeated get_worker polling; a wait timeout never cancels the worker. Fetch logs/diffs/artifact contents only when needed. For substantial corrections, prefer continue_worker on the same session. If delegated execution repeatedly fails with retries exhausted, tell the human (work is preserved) and let them choose: retry later, do it Codex-side, or abandon — never silently substitute expensive Codex-side execution.`;

function jsonResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function compactStatus(row: WorkerRow): Record<string, unknown> {
  return {
    worker_id: row.id,
    status: row.status,
    mode: row.mode,
    workspace_type: row.workspace_type,
    session_id: row.session_id,
    branch: row.branch || null,
    worktree: row.worktree_path,
    repo_path: row.repo_path || null,
    elapsed_seconds: elapsedSeconds(row),
    last_activity: row.last_progress ?? row.updated_at,
    supervision: row.supervision_state,
    process_alive: (row.status === 'running' || row.status === 'starting') && row.pid ? pidAlive(row.pid) : null,
    commit_hash: row.commit_hash ? row.commit_hash.slice(0, 7) : null,
    error: row.error,
    usage: {
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_read_tokens: row.cache_read_tokens,
      total_tokens_last: row.total_tokens_last,
    },
  };
}

function requireWorkerId(workerId: string): void {
  if (!isValidWorkerId(workerId)) {
    throw new Error(`invalid worker_id format: ${JSON.stringify(workerId)} (expected wk_xxxxxxxx)`);
  }
}

const READ_ONLY = { readOnlyHint: true } as const;

const ID_DESC = 'Task id returned by spawn_task / spawn_worker (wk_xxxxxxxx). Both id spaces are the same.';
const TASK_DESC =
  'A bounded, outcome-oriented assignment for the worker. Include the desired result and important constraints, but leave implementation-level exploration to the worker when appropriate.';
const TIMEOUT_DESC =
  'Max run time in seconds before the worker is terminated. Raise it for long builds, large test suites, or deep research; lower it for quick experiments.';
const DELIVERABLES_DESC =
  'Named files the worker must produce in its workspace (relative paths, verified on disk at completion). Prefer deliverables for substantial reports/data instead of returning large content inline.';
const CAPABILITIES_DESC =
  'Requested/intended capability set for the task (e.g. filesystem.read, filesystem.write, shell, web.search, web.fetch, git). Recorded on the task and injected into the worker prompt as advisory guidance — this is NOT a hard security sandbox.';
const MODE_DESC =
  'Task mode: code (implement/fix/test/commit in a git worktree), research (investigate and synthesize; writes report + sources.json), data (analyze datasets; inputs read-only), docs (documentation), file (batch file ops, no deletion unless asked), ops (diagnostics; no sudo/destructive changes, produces proposals), review (read-only code review), general (default).';

export function createMcpServer(supervisor: WorkerSupervisor): McpServer {
  const server = new McpServer(
    { name: 'kimi-workforce-mcp', version: '0.2.0' },
    { capabilities: { logging: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    'spawn_task',
    {
      title: 'Spawn Kimi task (any mode)',
      description:
        'Delegate substantial execution work to a Kimi K3 worker.\n\n' +
        'Use proactively when a task involves significant repository exploration, implementation, testing/debugging, long tool trajectories, research, data analysis, documentation, file processing, independent review, or work that can beneficially run in parallel. Multiple independent tasks may run in parallel.\n\n' +
        'Codex should normally retain planning, architectural decisions, review, validation, and final integration.\n\n' +
        'Avoid using this tool for tiny edits or trivial one-step operations where delegation overhead exceeds the task. If delegated execution repeatedly fails and its retry policy is exhausted, return control to the human instead of silently substituting expensive Codex-side execution.\n\n' +
        'Returns immediately with a task id; when the result is needed use wait_task / wait_tasks (not get_worker polling), then inspect get_task_result. Workers write substantial output to workspace files (see deliverables) instead of returning it inline.\n\n' +
        'For isolated git coding tasks the worker modifies and tests the worktree; the workforce supervisor finalizes successful changes into a worker-branch commit automatically — no commit instructions needed in the task text.',
      inputSchema: {
        task: z.string().describe(TASK_DESC),
        mode: z.enum(['code', 'research', 'data', 'docs', 'file', 'ops', 'review', 'general']).optional().describe(MODE_DESC),
        workspace: z
          .object({
            type: z
              .enum(['git_worktree', 'directory', 'temporary'])
              .optional()
              .describe('Where the worker operates. Default: git_worktree for code/review with repo_path, directory when path is given, otherwise temporary.'),
            path: z.string().optional().describe('For directory workspace: an existing directory the worker may operate in (canonicalized; nothing outside it is touched).'),
            repo_path: z.string().optional().describe('For git_worktree: path inside the target git repository.'),
            base_ref: z.string().optional().describe('For git_worktree: git ref to branch from (default: current HEAD).'),
          })
          .optional()
          .describe('Where the worker runs. Omit for a fresh temporary workspace.'),
        deliverables: z.array(z.string()).optional().describe(DELIVERABLES_DESC),
        capabilities: z.array(z.string()).optional().describe(CAPABILITIES_DESC),
        timeout_seconds: z.number().int().positive().optional().describe(TIMEOUT_DESC),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ task, mode, workspace, deliverables, capabilities, timeout_seconds }) => {
      try {
        const result = supervisor.spawnTask({ task, mode, workspace, deliverables, capabilities, timeout_seconds });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'wait_task',
    {
      title: 'Wait for one task (efficient)',
      description:
        'Efficiently wait for one delegated task to reach a terminal state (completed / completed_uncommitted / failed / cancelled / timeout / interrupted).\n\n' +
        'Prefer this over repeatedly polling get_worker after spawning a task. The call returns when the task finishes or the wait timeout expires. While waiting, Codex can simply not call anything — do independent planner/reviewer work first, then wait when the result is actually needed.\n\n' +
        'A wait timeout does NOT cancel or fail the worker; it only means "still running, decide whether to wait again". On completion the compact task result is included.',
      inputSchema: {
        task_id: z.string().describe(ID_DESC),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(600)
          .optional()
          .describe('How long to wait (default 60, max 600). This is only the wait budget — it does not affect the worker\'s own execution timeout.'),
      },
      annotations: READ_ONLY,
    },
    async ({ task_id, timeout_seconds }) => {
      try {
        requireWorkerId(task_id);
        return jsonResult(await supervisor.waitTask(task_id, timeout_seconds));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'wait_tasks',
    {
      title: 'Wait for multiple tasks (efficient)',
      description:
        'Efficiently wait for multiple delegated tasks.\n\n' +
        'Use this after spawning independent tasks in parallel instead of repeatedly polling each task with get_worker.\n\n' +
        'Use return_when="all" when all delegated tracks are needed before review (note: "all" means all terminal — a mix of completed and failed still satisfies it). Use return_when="any" when Codex can begin processing whichever task finishes first; triggered_by lists the task(s) that finished.\n\n' +
        'The wait timeout does not cancel unfinished workers — it only bounds this call.',
      inputSchema: {
        task_ids: z.array(z.string()).min(1).max(32).describe('Task ids to wait on (duplicates are removed).'),
        return_when: z.enum(['all', 'any']).optional().describe('"all" (default): wait until every task is terminal. "any": return as soon as one task is terminal.'),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(600)
          .optional()
          .describe('How long to wait (default 120, max 600). Does not affect the workers\' own execution timeouts.'),
      },
      annotations: READ_ONLY,
    },
    async ({ task_ids, return_when, timeout_seconds }) => {
      try {
        for (const id of task_ids) requireWorkerId(id);
        return jsonResult(await supervisor.waitTasks(task_ids, return_when ?? 'all', timeout_seconds));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'spawn_tasks',
    {
      title: 'Spawn multiple Kimi tasks',
      description:
        'Batch-spawn several independent tasks in one call (each gets its own workspace and session). Combine with wait_tasks for parallel delegation: spawn_tasks → do Codex-side work → wait_tasks(return_when="all") → review each result.\n\n' +
        'Per-item success/error is returned; one invalid item does not roll back the others.',
      inputSchema: {
        tasks: z
          .array(
            z.object({
              task: z.string().describe(TASK_DESC),
              mode: z.enum(['code', 'research', 'data', 'docs', 'file', 'ops', 'review', 'general']).optional().describe(MODE_DESC),
              workspace: z
                .object({
                  type: z.enum(['git_worktree', 'directory', 'temporary']).optional(),
                  path: z.string().optional(),
                  repo_path: z.string().optional(),
                  base_ref: z.string().optional(),
                })
                .optional(),
              deliverables: z.array(z.string()).optional().describe(DELIVERABLES_DESC),
              capabilities: z.array(z.string()).optional().describe(CAPABILITIES_DESC),
              timeout_seconds: z.number().int().positive().optional().describe(TIMEOUT_DESC),
            }),
          )
          .min(1)
          .max(16)
          .describe('Independent task specifications (max 16 per call).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ tasks }) => {
      try {
        return jsonResult(supervisor.spawnTasks(tasks));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'create_workflow',
    {
      title: 'Create workflow (task DAG)',
      description:
        'Create a multi-task workflow: a dependency DAG of Kimi tasks sharing one workspace. Dependencies reference per-task keys (not ids); cycles are rejected. Tasks without dependencies start immediately (parallel), dependents start automatically when their dependencies complete (all_success) or terminate (all_terminal).\n\n' +
        'Use for multi-track delegated work: research → implement → test → review pipelines, parallel analysis with a synthesis step, etc. Then wait_workflow / get_workflow_result.\n\n' +
        'failure_policy: stop_dependents (default; downstream of a failed task is blocked) | continue (independent branches proceed; all_terminal dependents still run) | cancel_remaining. If delegated execution repeatedly fails and retries are exhausted, return control to the human rather than silently substituting Codex-side execution.',
      inputSchema: {
        name: z.string().optional(),
        tasks: z
          .array(
            z.object({
              key: z.string().describe('Per-workflow task key ([a-zA-Z0-9_-], referenced by depends_on).'),
              task: z.string().describe(TASK_DESC),
              mode: z.enum(['code', 'research', 'data', 'docs', 'file', 'ops', 'review', 'general']).optional().describe(MODE_DESC),
              role: z.string().optional().describe('Built-in role template name (see list_roles) — shapes the worker prompt.'),
              depends_on: z.array(z.string()).optional().describe('Keys of tasks in this workflow that must finish first.'),
              dependency_policy: z.enum(['all_success', 'all_terminal']).optional().describe('all_success (default): every dependency must complete successfully. all_terminal: dependencies just need to be terminal (even failed).'),
              deliverables: z.array(z.string()).optional().describe(DELIVERABLES_DESC),
              capabilities: z.array(z.string()).optional().describe(CAPABILITIES_DESC),
              priority: z.enum(['low', 'normal', 'high']).optional(),
              timeout_seconds: z.number().int().positive().optional().describe(TIMEOUT_DESC),
              budget: z
                .object({
                  max_duration_seconds: z.number().int().positive().optional(),
                  max_input_tokens: z.number().int().positive().optional(),
                  max_output_tokens: z.number().int().positive().optional(),
                  max_total_tokens: z.number().int().positive().optional().describe('input+output+cache_read, checked per DSH status event (best-effort, not hard accounting)'),
                  max_tool_calls: z.number().int().positive().optional(),
                  max_iterations: z.number().int().positive().optional(),
                })
                .optional(),
              retry: z
                .object({
                  max_attempts: z.number().int().min(1).max(5),
                  retry_on: z.array(z.enum(['failed', 'timeout'])).optional(),
                })
                .optional(),
            }),
          )
          .min(1)
          .max(32),
        workspace: z
          .object({
            type: z.enum(['git_worktree', 'directory', 'temporary']).optional(),
            path: z.string().optional(),
            repo_path: z.string().optional(),
            base_ref: z.string().optional(),
          })
          .optional()
          .describe('Shared workspace for ALL tasks in the workflow (default: temporary; git_worktree when repo_path given — one shared branch, supervisor commits per task).'),
        budget: z
          .object({
            max_duration_seconds: z.number().int().positive().optional(),
            max_kimi_tokens: z.number().int().positive().optional().describe('Sum of input+output+cache_read tokens across all workflow tasks (best-effort).'),
            max_concurrent_tasks: z.number().int().positive().optional(),
            max_tasks: z.number().int().positive().optional(),
          })
          .optional(),
        failure_policy: z.enum(['continue', 'stop_dependents', 'cancel_remaining']).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return jsonResult(supervisor.createWorkflow(args as Parameters<typeof supervisor.createWorkflow>[0]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_workflow',
    {
      title: 'Get workflow',
      description: 'Full workflow overview incl. the task graph (keys, dependencies, roles, modes, per-task status) — the plan is always transparent, never opaque.',
      inputSchema: { workflow_id: z.string() },
      annotations: READ_ONLY,
    },
    async ({ workflow_id }) => {
      try {
        return jsonResult(supervisor.getWorkflow(workflow_id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'list_workflows',
    {
      title: 'List workflows',
      description: 'List recent workflows with per-task status summaries. For waiting on a specific workflow, use wait_workflow instead of polling this.',
      inputSchema: { limit: z.number().int().positive().max(100).optional() },
      annotations: READ_ONLY,
    },
    async ({ limit }) => {
      try {
        return jsonResult({ workflows: supervisor.listWorkflows(limit) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'wait_workflow',
    {
      title: 'Wait for workflow (efficient)',
      description:
        'Efficiently wait for a workflow to reach a terminal state (completed / completed_with_failures / failed / cancelled). Event-driven — returns as soon as all tasks are terminal. A wait timeout does not cancel the workflow or its tasks.',
      inputSchema: {
        workflow_id: z.string(),
        timeout_seconds: z.number().int().min(1).max(600).optional().describe('Wait budget in seconds (default 120, max 600). Not the workflow execution timeout.'),
      },
      annotations: READ_ONLY,
    },
    async ({ workflow_id, timeout_seconds }) => {
      try {
        return jsonResult(await supervisor.waitWorkflow(workflow_id, timeout_seconds));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'cancel_workflow',
    {
      title: 'Cancel workflow',
      description: 'Cancel a running workflow: all non-terminal tasks are cancelled (running tasks get graceful termination). Workspaces, branches and artifacts are preserved.',
      inputSchema: { workflow_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ workflow_id }) => {
      try {
        return jsonResult(await supervisor.cancelWorkflow(workflow_id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_workflow_diff',
    {
      title: 'Get workflow diff',
      description:
        'Inspect the integrated changes of a git workflow: diff of the integration branch vs its base ref (all integrated task commits combined). Defaults to --stat; request stat_only=false for the full patch (size-capped, redacted). Use for final review before Codex decides how to integrate the workflow branch.',
      inputSchema: {
        workflow_id: z.string(),
        stat_only: z.boolean().optional().describe('Default true.'),
        path: z.string().optional().describe('Restrict to one relative path.'),
      },
      annotations: READ_ONLY,
    },
    async ({ workflow_id, stat_only, path }) => {
      try {
        return jsonResult(supervisor.workflowDiff(workflow_id, { stat_only, path }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_workflow_result',
    {
      title: 'Get workflow result (compact)',
      description:
        'Compact structured synthesis of a workflow: status, per-task outcomes, aggregated artifact metadata, aggregate metrics (duration, tokens, attempts), git branch state, and warnings. No LLM summarization — Codex performs the final review and synthesis.',
      inputSchema: { workflow_id: z.string() },
      annotations: READ_ONLY,
    },
    async ({ workflow_id }) => {
      try {
        return jsonResult(supervisor.workflowResult(workflow_id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'run_workflow_preset',
    {
      title: 'Run workflow preset',
      description:
        'Expand a built-in workflow preset (bug_fix, feature_development, quality_audit, research_report, data_analysis — see list_presets) into a task DAG around one goal and start it. Returns workflow_id + task mapping immediately. The expanded plan is always visible via get_workflow; pass options.dry_run=true to inspect the plan without spawning.',
      inputSchema: {
        preset: z.string().describe('Preset name (see list_presets).'),
        goal: z.string().describe('The concrete goal the preset orchestrates, e.g. "fix the flaky reconnect in transport.ts".'),
        workspace: z
          .object({
            type: z.enum(['git_worktree', 'directory', 'temporary']).optional(),
            path: z.string().optional(),
            repo_path: z.string().optional(),
            base_ref: z.string().optional(),
          })
          .optional()
          .describe('Shared workspace for the whole workflow. Required (repo_path) for git-based presets like bug_fix/feature_development/quality_audit.'),
        budget: z
          .object({
            max_duration_seconds: z.number().int().positive().optional(),
            max_kimi_tokens: z.number().int().positive().optional(),
            max_concurrent_tasks: z.number().int().positive().optional(),
            max_tasks: z.number().int().positive().optional(),
          })
          .optional(),
        failure_policy: z.enum(['continue', 'stop_dependents', 'cancel_remaining']).optional(),
        options: z.object({ dry_run: z.boolean().optional() }).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return jsonResult(supervisor.runWorkflowPreset(args as Parameters<typeof supervisor.runWorkflowPreset>[0]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'list_roles',
    {
      title: 'List role templates',
      description: 'List built-in worker role templates (implementer, tester, researcher, reviewer, docs_writer, data_analyst, debugger, ops_analyst) with their defaults. Roles shape worker prompts; modes select workspace/runtime behavior.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return jsonResult({ roles: supervisor.listRoles() });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'list_presets',
    {
      title: 'List workflow presets',
      description: 'List built-in workflow presets with their task graphs (keys, modes, roles, dependencies). Use run_workflow_preset to execute one around a concrete goal.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return jsonResult({ presets: supervisor.listPresets() });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'review_task_result',
    {
      title: 'Review task result (acceptance)',
      description:
        'Record Codex\'s review decision for a finished task: accepted | rejected | needs_revision (with optional feedback). This is acceptance state, separate from execution status — a completed task can be rejected. needs_revision does NOT auto-restart the worker; call continue_worker with rework instructions when ready. Acceptance history feeds get_system_metrics quality stats.',
      inputSchema: {
        task_id: z.string().describe(ID_DESC),
        decision: z.enum(['accepted', 'rejected', 'needs_revision']),
        feedback: z.string().optional().describe('Short review note; for needs_revision, what to fix (also pass the details to continue_worker).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ task_id, decision, feedback }) => {
      try {
        requireWorkerId(task_id);
        return jsonResult(supervisor.reviewTaskResult(task_id, decision, feedback));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_task_metrics',
    {
      title: 'Get task metrics',
      description: 'Objective run metrics for one task: duration, tokens, steps, tool calls (by tool), continues, attempts, artifact count/bytes, git commits, acceptance. Facts only — no scoring.',
      inputSchema: { task_id: z.string().describe(ID_DESC) },
      annotations: READ_ONLY,
    },
    async ({ task_id }) => {
      try {
        requireWorkerId(task_id);
        return jsonResult(supervisor.taskMetrics(task_id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_workflow_metrics',
    {
      title: 'Get workflow metrics',
      description: 'Aggregate metrics for a workflow: duration, token sums, attempts/continues, and per-task breakdown.',
      inputSchema: { workflow_id: z.string() },
      annotations: READ_ONLY,
    },
    async ({ workflow_id }) => {
      try {
        return jsonResult(supervisor.workflowMetrics(workflow_id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_system_metrics',
    {
      title: 'Get system metrics',
      description:
        'System-wide compact aggregate: task counts by status, token totals, active/queued workers, workflow counts, acceptance quality stats (acceptance/revision/failure rates by mode+role, average continues), cache stats. SQL aggregation — cheap to call.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return jsonResult(supervisor.systemMetrics());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_task_result',
    {
      title: 'Get task result (compact)',
      description:
        'Retrieve the compact result of a delegated task.\n\n' +
        'Use this as the default first inspection step after task completion. It intentionally returns condensed status, summary, artifact metadata, deliverables verification, usage, and warnings without flooding Codex context with full logs or large deliverables. Git tasks additionally include the verified commit hash and changed files.\n\n' +
        'Fetch artifact contents (get_artifact), logs (get_worker_log), or diffs (get_worker_diff) only when the compact result is insufficient for review.',
      inputSchema: {
        task_id: z.string().describe(ID_DESC),
      },
      annotations: READ_ONLY,
    },
    async ({ task_id }) => {
      try {
        requireWorkerId(task_id);
        return jsonResult(supervisor.taskResult(task_id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'list_artifacts',
    {
      title: 'List task artifacts',
      description:
        'List deliverables produced by a task without loading their contents.\n\n' +
        'Prefer this before fetching artifacts when you need to understand what a worker produced while keeping context usage low. Returns metadata only: path, mime type, size, sha256.',
      inputSchema: {
        task_id: z.string().describe(ID_DESC),
      },
      annotations: READ_ONLY,
    },
    async ({ task_id }) => {
      try {
        requireWorkerId(task_id);
        return jsonResult({ task_id, artifacts: supervisor.listArtifacts(task_id) });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_artifact',
    {
      title: 'Get artifact content',
      description:
        'Read a specific worker deliverable.\n\n' +
        'Fetch artifacts selectively when their actual contents are necessary for review, synthesis, or final integration. Avoid loading large artifacts merely to inspect whether they exist — use list_artifacts / get_artifact_metadata for that. Content is capped (default 64 KiB) and secret-redacted; binary artifacts return metadata only.',
      inputSchema: {
        task_id: z.string().describe(ID_DESC),
        path: z.string().describe('Artifact path relative to the task workspace, exactly as returned by list_artifacts.'),
        max_bytes: z.number().int().positive().optional().describe('Max content bytes to return (default 65536, hard cap 1 MiB; larger content is truncated with a marker).'),
      },
      annotations: READ_ONLY,
    },
    async ({ task_id, path, max_bytes }) => {
      try {
        requireWorkerId(task_id);
        return jsonResult(supervisor.artifactContent(task_id, path, max_bytes));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_artifact_metadata',
    {
      title: 'Get artifact metadata',
      description:
        'Metadata only for an artifact (path, mime type, size, sha256, whether the file still exists). Use this for very large files whose content should not enter context.',
      inputSchema: {
        task_id: z.string().describe(ID_DESC),
        path: z.string().describe('Artifact path relative to the task workspace.'),
      },
      annotations: READ_ONLY,
    },
    async ({ task_id, path }) => {
      try {
        requireWorkerId(task_id);
        return jsonResult(supervisor.artifactMetadata(task_id, path));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_task_usage',
    {
      title: 'Get task usage',
      description:
        'Token usage and activity counters for a delegated task: input/output/cache tokens, steps, tool calls grouped by tool, session runs, and duration. Useful for cost awareness and for understanding how a worker spent its effort.',
      inputSchema: {
        task_id: z.string().describe(ID_DESC),
      },
      annotations: READ_ONLY,
    },
    async ({ task_id }) => {
      try {
        requireWorkerId(task_id);
        return jsonResult(supervisor.taskUsage(task_id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'spawn_worker',
    {
      title: 'Spawn Kimi code worker (legacy)',
      description:
        '[Legacy alias of spawn_task with mode=code and a git_worktree workspace — prefer spawn_task for new work.]\n\n' +
        'Delegate a substantial coding task to a Kimi K3 worker: it runs in an isolated git worktree on its own branch, explores the repo, implements, and runs/debugs tests autonomously. The workforce supervisor verifies and commits successful changes onto the worker branch automatically. Use for implementation work spanning multiple files or long test/debug trajectories; avoid for tiny one-line edits.\n\n' +
        'Returns immediately; when the result is needed use wait_task (not get_worker polling), then review get_worker_result / get_worker_diff. The server never merges or pushes — Codex decides whether to accept the branch.',
      inputSchema: {
        repo_path: z.string().describe('Absolute path inside the target git repository.'),
        task: z.string().describe(TASK_DESC),
        base_ref: z.string().optional().describe('Git ref to branch from (default: current HEAD).'),
        timeout_seconds: z.number().int().positive().optional().describe(TIMEOUT_DESC),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ repo_path, task, base_ref, timeout_seconds }) => {
      try {
        const result = supervisor.spawn({ repo_path, task, base_ref, timeout_seconds });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_worker',
    {
      title: 'Get worker status',
      description:
        'Inspect the current state of one delegated task (compact: state, mode, session, branch/workspace, elapsed time, token usage — no logs).\n\n' +
        'Use for one-off status inspection. Do NOT repeatedly poll this tool while waiting for a worker to finish — prefer wait_task or wait_tasks for efficient waiting.',
      inputSchema: {
        worker_id: z.string().describe(ID_DESC),
      },
      annotations: READ_ONLY,
    },
    async ({ worker_id }) => {
      try {
        requireWorkerId(worker_id);
        return jsonResult(compactStatus(supervisor.get(worker_id)));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'list_workers',
    {
      title: 'List workers',
      description:
        'Get an overview of delegated work (recent tasks, compact status only), optionally filtered by status and/or repo path.\n\n' +
        'Do not use list_workers as a polling loop while waiting for completion — use wait_task / wait_tasks for that.',
      inputSchema: {
        status: z
          .enum(['queued', 'starting', 'running', 'completed', 'completed_uncommitted', 'failed', 'cancelled', 'interrupted', 'timeout'])
          .optional()
          .describe('Only return tasks in this state.'),
        repo_path: z.string().optional().describe('Only return tasks for this repository (canonicalized path).'),
        limit: z.number().int().positive().max(100).optional().describe('Max tasks to return (default 20, most recent first).'),
      },
      annotations: READ_ONLY,
    },
    async ({ status, repo_path, limit }) => {
      try {
        const rows = supervisor.list({ status, repo_path, limit });
        return jsonResult({ workers: rows.map(compactStatus), count: rows.length });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'continue_worker',
    {
      title: 'Continue worker session',
      description:
        'Continue an existing delegated task in the same Kimi/DSH session and the same workspace.\n\n' +
        'Prefer this when Codex reviews worker output and finds problems, missing requirements, failed tests, or additional closely-related work. For substantial corrections to worker-owned execution, prefer continuing the existing task rather than recreating the work from scratch.\n\n' +
        'The task must be in a terminal state and have a recorded session; it re-queues and runs again with the follow-up instruction.',
      inputSchema: {
        worker_id: z.string().describe(ID_DESC),
        instruction: z.string().describe('Follow-up instruction, e.g. review feedback to apply. Be specific about what to change; the worker retains full context of its previous work in this session.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ worker_id, instruction }) => {
      try {
        requireWorkerId(worker_id);
        const result = await supervisor.continueWorker(worker_id, instruction);
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'cancel_worker',
    {
      title: 'Cancel worker',
      description:
        'Terminate a running or queued delegated task (graceful SIGTERM, then SIGKILL after a grace period). The workspace, logs, and any committed/uncommitted changes are preserved — cancellation stops execution, not data.',
      inputSchema: {
        worker_id: z.string().describe(ID_DESC),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ worker_id }) => {
      try {
        requireWorkerId(worker_id);
        const result = await supervisor.cancelWorker(worker_id);
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_worker_result',
    {
      title: 'Get worker result (legacy, git-focused)',
      description:
        'Legacy compact result for code workers (equivalent git-verified facts also appear in get_task_result).\n\n' +
        'Use as the default first inspection step after a coding task completes: condensed summary, verified changed files, commit hash, reported tests, usage — never thinking, transcripts, or large diffs. For non-code tasks or artifact-centric results, prefer get_task_result.',
      inputSchema: {
        worker_id: z.string().describe(ID_DESC),
      },
      annotations: READ_ONLY,
    },
    async ({ worker_id }) => {
      try {
        requireWorkerId(worker_id);
        return jsonResult(supervisor.result(worker_id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_worker_log',
    {
      title: 'Get worker log tail',
      description:
        'Inspect recent worker execution logs for diagnosis.\n\n' +
        'Use primarily when a task failed, stalled, or its compact result does not explain an issue. Do not fetch logs routinely after successful tasks. Returns a redacted, size-capped, human-readable tail of the event stream.',
      inputSchema: {
        worker_id: z.string().describe(ID_DESC),
        tail_lines: z.number().int().positive().max(1000).optional().describe('Number of trailing log lines (default 100, output capped at 32 KiB total).'),
      },
      annotations: READ_ONLY,
    },
    async ({ worker_id, tail_lines }) => {
      try {
        requireWorkerId(worker_id);
        return jsonResult(supervisor.log(worker_id, tail_lines ?? 100));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'get_worker_diff',
    {
      title: 'Get worker diff',
      description:
        'Inspect delegated code changes (git tasks only).\n\n' +
        'Start with the default diff statistics, or focus on specific paths with the path parameter; request the full diff (stat_only=false) only when review requires it. Use this during review before accepting worker-generated code. Avoid loading unnecessarily large diffs into context — full diffs are size-capped and redacted.',
      inputSchema: {
        worker_id: z.string().describe(ID_DESC),
        stat_only: z.boolean().optional().describe('Default true: return only diff --stat. Set false for the full patch (size-capped).'),
        path: z.string().optional().describe('Restrict the diff to one relative path inside the repo.'),
      },
      annotations: READ_ONLY,
    },
    async ({ worker_id, stat_only, path }) => {
      try {
        requireWorkerId(worker_id);
        return jsonResult(supervisor.diff(worker_id, { stat_only, path }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

export async function serveStdio(supervisor: WorkerSupervisor): Promise<void> {
  const server = createMcpServer(supervisor);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the process alive; stderr is safe for diagnostics on stdio transport.
  process.stderr.write('kimi-worker-mcp: MCP server listening on stdio\n');
}
