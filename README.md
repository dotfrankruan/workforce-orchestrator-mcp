# Workforce Orchestrator MCP

*Formerly Kimi Workforce MCP.* A universal execution workforce for Codex.

MCP server that turns **Codex** (planner / architect / reviewer) into an
orchestrator over pluggable runtime backends — task DAGs, workflows, budgets,
role templates, acceptance tracking, metrics, and an artifact cache.

**Codex thinks. Workers execute. The orchestrator schedules. The supervisor owns state and Git. Humans retain final control.**

```
                         Codex Root
                             │
                             ▼
                   Workforce Orchestrator
                             │
                       Backend Router
                             │
            ┌────────────────┼───────────────┐
            ▼                ▼               ▼
           DSH          future Claude    future OpenCode
            │          Code adapter      adapter
       runtime config
            │
         current:
       Kimi K3 (via DSH headless profile)
```

## Zero-config guarantee (existing users: nothing to change)

If you used this project before v5: **you do not need to change anything.**
With no config file and no env vars, the orchestrator automatically uses:

```
/usr/local/bin/dsh --profile headless --json
```

(falling back to `dsh` on PATH). The runtime (DSH) owns its own provider
configuration and credentials (`~/.dsh/.env`) — the orchestrator never reads
them. Your Codex MCP config (`[mcp_servers.kimi]`, the name is yours) keeps
working unchanged. Old databases migrate automatically (schema v1→v6).

Optional configuration, only if you ever want it:

```jsonc
// ~/.workforce/config.json  (optional — never required)
{
  "default_backend": "dsh",
  "backends": { "dsh": { "command": "/usr/local/bin/dsh", "profile": "headless" } },
  "routing": { "roles": { "reviewer": "dsh" } }
}
```

Env overrides: `WORKFORCE_DEFAULT_BACKEND`, `WORKFORCE_DSH_COMMAND`,
`WORKFORCE_DSH_PROFILE` (legacy `KIMI_WORKER_*` env vars keep working).

## What's new in v5

- **Universal backend architecture**: Orchestrator ≠ runtime backend ≠ model
  provider. `WorkerBackend` interface with capabilities, local availability
  (no API calls), and runtime metadata (facts only — provider/model never
  guessed).
- **Backend registry + deterministic router**: explicit task backend > role
  routing rule > config default > env > built-in dsh. **No automatic
  expensive fallback** — exhaustion returns control to the human.
- **Normalized WorkerEvent model**: supervisor/budgets/metrics consume
  backend-agnostic events; DSH JSONL is just the first adapter (`thinking`
  never leaves the durable log).
- `spawn_task(..., backend)` + workflow task backends; `list_backends` /
  `get_backend`; CLI `backends` / `backend <id>`.
- `max_worker_tokens` (canonical; `max_kimi_tokens` remains a readable
  deprecated alias); per-backend metrics split; cache keys include
  backend_id.
- Zero-config compatibility: existing Kimi+DSH setups upgrade in place with
  no configuration migration.
- Schema v6: `backend_id` (old rows factually backfilled `dsh`) +
  `backend_metadata`.

## What's new in v4

- **Task DAG**: `depends_on` + `dependency_policy` (`all_success` /
  `all_terminal`), deterministic cycle detection, `waiting_dependencies`
  (pre-queue, no concurrency slot), `blocked` terminal state with `blocked_by`.
- **Workflows**: `create_workflow` (key-based DAG; one **shared workspace**;
  one shared branch for git workflows), `get_workflow` (transparent plan),
  `list_workflows`, `wait_workflow` (event-driven), `cancel_workflow`,
  `get_workflow_result` (structured aggregate — never LLM-summarized).
- **Failure policies**: `stop_dependents` (default) / `continue` /
  `cancel_remaining`.
- **Budgets**: per-task (`max_duration_seconds`, token caps, `max_tool_calls`,
  `max_iterations`) and per-workflow (`max_kimi_tokens`, `max_duration_seconds`,
  `max_concurrent_tasks`, `max_tasks`). Breach → terminal `budget_exceeded`;
  best-effort per-event granularity, not hard accounting.
- **Retries**: `retry: {max_attempts (≤5), retry_on}`; fresh session per
  attempt; never retries cancelled/budget_exceeded; intermediate failures do
  not wake waiters; attempts persisted in `task_attempts`.
- **Roles** (8 built-in): implementer, tester, researcher, reviewer,
  docs_writer, data_analyst, debugger, ops_analyst — prompt fragments +
  default deliverables/capabilities. Role ≠ mode.
- **Presets** (5 built-in): `bug_fix`, `feature_development`,
  `quality_audit`, `research_report`, `data_analysis` via
  `run_workflow_preset` (`options.dry_run` shows the expanded plan).
- **Acceptance**: `review_task_result` (accepted / rejected /
  needs_revision) — separate from execution status; `needs_revision` never
  auto-restarts the worker.
- **Metrics**: `get_task_metrics`, `get_workflow_metrics`,
  `get_system_metrics` (acceptance/revision/failure rates by mode+role,
  token totals, cache stats — pure SQL aggregation, no log scanning).
- **Artifact cache** (opt-in `cache_policy`): key = mode + role + normalized
  task + workspace fingerprint (git HEAD / dirty diff / directory listing) +
  prompt & schema versions. Hits reuse artifacts without a new DSH session.

```
                         Human
                           │
                           ▼
                      Codex Root
                planner / integrator
                           │
          ┌────────────────┴────────────────┐
          │                                 │
   Native Codex Subagents             Kimi Workforce
 high-cognition reviewers                   │
                                            ▼
                                  Workflow Orchestrator
                                            │
                                 dependency scheduler
                                            │
                         ┌──────────────────┼─────────────────┐
                         ▼                  ▼                 ▼
                     Research           Implement          Test
                       K3                  K3                K3
                         │                  │                 │
                         └──────────────────┼─────────────────┘
                                            ▼
                                          Review
                                            │
                                            ▼
                                  Supervisor Git finalize
                                            │
                                            ▼
                                      artifacts/result
                                            │
                                            ▼
                                          Codex
```
```
                   Codex
            planner / reviewer
                    │
                    │ MCP (stdio)
                    ▼
             Kimi Workforce
                    │
       ┌────────────┼─────────────┐
       ▼            ▼             ▼
    Research       Code          Data
       │            │             │
       ▼            ▼             ▼
     DSH K3       DSH K3        DSH K3
       │            │             │
       ▼            ▼             ▼
  temp workspace  worktree    directory
       │            │             │
       ▼            ▼             ▼
   artifacts      commits      artifacts
```

Every task runs through `/usr/local/bin/dsh --profile headless --json`
(spawned with an argv array — never a shell string). Token-expensive work —
reading repos, grepping, compiling, testing, web research, large datasets —
stays **inside** the worker. Codex only receives compact results:
status, summary, **artifact metadata** and usage. Large content is fetched
explicitly via `get_artifact` (capped, redacted).

## Concepts

```
Task
  ├── Mode        code | research | data | docs | file | ops | review | general
  ├── Workspace   GitWorktreeWorkspace | DirectoryWorkspace | TemporaryWorkspace
  ├── Runtime     DSH headless / Kimi K3
  └── Artifacts   reports, JSON, CSV, patches, source files, …
```

Git is no longer a requirement — it is one workspace type.

### Task modes

| Mode | Purpose | Default workspace |
|---|---|---|
| `code` | Implement, fix, test, debug, **commit** in an isolated worktree | git_worktree |
| `research` | Investigate (web when available), synthesize; **must** record sources in `sources.json` | temporary |
| `data` | Analyze CSV/JSON/SQLite/logs; inputs treated read-only, outputs as files | directory (if `path` given) |
| `docs` | README/architecture/migration docs; commits only inside git worktrees | any |
| `file` | Batch organize/classify/rename/convert **inside the workspace only**; no deletion unless explicitly requested | directory/temporary |
| `ops` | Logs/config/service diagnosis. **No sudo, no destructive commands, no SSH, no system config changes** — produces proposals (patch/script/report) instead | directory/temporary |
| `review` | Read-only code review (bugs, races, security, API, coverage); may run tests; writes only if task says "review and fix" | git_worktree |
| `general` | Generic knowledge work with file deliverables | temporary |

Each mode has its own prompt template under [src/prompts/](src/prompts/)
(`base.ts` shared rules + one module per mode).

### Workspace types

- **git_worktree** — `repo_path` (+ optional `base_ref`, default `HEAD`).
  New branch `kimi-worker/<id>`, isolated worktree under
  `~/.kimi-workers/<repo>-<hash>/<id>/worktree`. The server never merges,
  pushes, or touches your main branch.
- **directory** — caller-designated existing directory (`path`), canonicalized
  via `realpath` (symlinks resolved). Workers are instructed (and artifact
  indexing is scoped) to stay inside it.
- **temporary** — fresh `~/.kimi-workers/tasks/<id>/workspace/`, kept after
  completion (no auto-delete).

## Parallel git isolation (v4.1)

**Invariant: two git-writing tasks never share a physical worktree. Parallel execution, serialized integration.**

```
                    workflow integration branch
                     kimi-workflow/<wf-id>
                             │  (integration worktree — supervisor only)
                 ┌───────────┴───────────┐
                 │                       │
             task branch B           task branch C
             kimi-task/<id-B>        kimi-task/<id-C>
             worktree B              worktree C          ← isolated, same snapshot
                 │                       │
              Kimi B                  Kimi C             ← truly parallel
                 │                       │
             commit B                commit C            ← supervisor commits
                 └───────────┬───────────┘
                             │
                 Supervisor serialized cherry-pick queue
                             │
                        workflow HEAD                    ← review target:
                                                           base_ref...kimi-workflow/<wf-id>
```

- Each git-workflow task is materialized at run start from the **current
  integration HEAD** (`workspace_base_commit` is recorded — reviewers always
  know exactly which repo state a task saw).
- After a task completes, the supervisor cherry-picks its commits onto the
  integration branch, serialized through a per-workflow async mutex.
- **Conflicts are surfaced, never auto-resolved**: the pick is aborted
  (integration branch restored clean), the task gets `integration=conflict`
  with conflicting files/commits recorded, and downstream dependents keep
  waiting — they never start from a HEAD missing their dependency.
- Resolution path: `continue_worker` on the conflicted task — it gets a
  fresh worktree branched from the latest integration HEAD (old branch kept
  for audit), re-implements against current state, and integration retries
  automatically.
- Read-only snapshots: every task's view is pinned to its
  `workspace_base_commit`; later integrations never mutate a running task's
  view.
- Non-git workflows (temporary/directory) keep shared-workspace semantics;
  parallel writers in a shared directory can still conflict — snapshot/
  copy-on-write is future work.
- Supervisor git command set: `status diff add commit rev-parse log
  cherry-pick(+--abort) worktree branch`. Never push/merge/reset/clean/rebase.

## Durable worker supervision (v4.1.1)

**Supervisor state is ephemeral. Worker execution state is durable.** Losing
the supervisor is NOT losing the worker.

- DSH child processes write stdout/stderr **directly to durable log files**
  (`stdout.jsonl` / `stderr.log`) — never through a supervisor-owned pipe —
  so a supervisor crash/restart never breaks the worker's output channel.
- Every active run persists: `pid`, process start token (ps `lstart`),
  `session_id`, `run_started_at`, and a byte-level `stdout_parse_offset`
  checkpoint (complete records only).
- On restart, reconciliation is a three-way decision:
  - **live pid + matching identity** → *reattach*: replay the log, restore
    token/tool/iteration counters, resume tailing from the checkpoint,
    re-arm the remaining execution timeout (computed from the original run
    start — never extended), and enforce budgets against merged usage.
  - **dead pid + durable `final` event** → full normal finalization (result,
    supervisor git commit, integration) with `exit_code: null` — never
    fabricated.
  - **dead pid + no terminal evidence** → `interrupted` (the only meaning of
    that status). Logs, worktrees, artifacts are preserved.
- Graceful server shutdown **detaches** workers instead of killing them;
  only `cancel_worker` / `cancel_workflow` / timeout / budget terminate
  worker processes.
- Reattachment never creates duplicate attempts, commits, cherry-picks, or
  artifact entries (attempt guard + `integrated_commits` dedupe + upserts).
- `get_system_metrics().supervision` reports `supervisor_restarts_observed`,
  `workers_reattached`, `workers_genuinely_interrupted`.
- `get_worker` exposes `supervision` (`attached`/`reattached`/`detached`) and
  `process_alive`; CLI `inspect` has a `process` diagnostics block.

## Backend failure handoff

Retries follow the configured policy (`retry.max_attempts`, `retry_on`) and
nothing is guessed from provider-specific error strings or HTTP codes. When
attempts are exhausted, the task result carries `attempts`,
`retries_exhausted: true`, `work_preserved: true` — and server instructions
tell Codex to **return control to the human** (report the failure, note the
preserved work, ask: retry later / do it Codex-side / abandon), never
silently substituting expensive Codex-side execution.

## Requirements

- macOS (developed on) / Linux (should work)
- Node.js ≥ 22 (uses built-in `node:sqlite`; verified on Node 24)
- git
- DeepSeek Harness CLI at `/usr/local/bin/dsh` with a working `headless` profile
  (Kimi credentials live in `~/.dsh/.env`, handled **only** by dsh — this
  server never reads, copies, prints or manages API keys)

## Installation

```bash
npm install
npm run build        # compiles to dist/
```

## Codex MCP setup

```toml
[mcp_servers.kimi]
command = "node"
args = ["/absolute/path/to/kimi-worker-mcp/dist/cli.js", "serve"]
```

> **Important**: each argv element must be its own TOML string. A single
> `"…/cli.js serve"` string makes node look for a file literally named
> `cli.js serve` and the server dies during `initialize`.

Optional environment overrides:

```toml
[mcp_servers.kimi.env]
KIMI_WORKER_MAX_CONCURRENT = "4"
KIMI_WORKER_ROOT = "~/.kimi-workers"
```

### MCP tools

**Orchestration API (v4)**

| Tool | Purpose |
|---|---|
| `create_workflow` | Key-based task DAG; shared workspace; budget + failure_policy; cycles rejected. |
| `run_workflow_preset` | Expand a built-in preset around a goal and start it (`options.dry_run` = plan only). |
| `list_presets` / `list_roles` | Built-in workflow presets and role templates. |
| `get_workflow` / `list_workflows` | Transparent plan + live status. |
| `wait_workflow` | Event-driven wait for workflow terminal state. |
| `cancel_workflow` | Cancel all non-terminal tasks; preserves workspaces/artifacts. |
| `get_workflow_result` | Compact aggregate: per-task outcomes, artifacts, metrics, warnings. |
| `get_workflow_diff` | base…integration-HEAD diff (stat default, capped). |
| `review_task_result` | Record acceptance (accepted/rejected/needs_revision). |
| `get_task_metrics` / `get_workflow_metrics` / `get_system_metrics` | Objective counters and quality stats. |

**Efficient waiting (new)**

| Tool | Purpose |
|---|---|
| `wait_task` | Block until one task is terminal (or the wait timeout expires). Returns the compact result on completion. |
| `wait_tasks` | Block until `all` (or `any`) of up to 32 tasks are terminal. `triggered_by` tells you which finished first. |
| `spawn_tasks` | Batch-spawn up to 16 independent tasks (per-item success/error, no rollback). |

**Task API**

| Tool | Purpose |
|---|---|
| `spawn_task` | Spawn any mode with any workspace, optional `deliverables` + `capabilities`. Returns immediately. |
| `get_task_result` | Compact result: status, mode, summary, **artifact metadata**, deliverables verification, usage (+ git facts for git tasks). |
| `list_artifacts` | Artifact metadata list (path, mime, size, sha256). |
| `get_artifact` | Fetch artifact content — default cap 64 KiB (hard cap 1 MiB), redacted; binary → metadata only. |
| `get_artifact_metadata` | Metadata only, for very large files. |
| `get_task_usage` | Tokens + steps + tool calls (grouped by tool) + runs + duration. |

**Worker API (stable, unchanged)**

| Tool | Purpose |
|---|---|
| `spawn_worker` | Legacy code worker = `spawn_task(mode=code, git_worktree)`. |
| `get_worker` | Compact status (no logs). |
| `list_workers` | Recent tasks, filterable. |
| `continue_worker` | Resume the task's original dsh session in the same workspace. |
| `cancel_worker` | SIGTERM → grace → SIGKILL. Workspace/logs/changes preserved. |
| `get_worker_result` | Legacy git-focused compact result. |
| `get_worker_log` | Redacted, capped log tail (100 lines / 32 KiB). |
| `get_worker_diff` | `--stat` default; full diff on explicit request (git tasks only). |

### spawn_task examples

```jsonc
// Research
{
  "mode": "research",
  "task": "Compare modern open-source WireGuard userspace implementations.",
  "deliverables": ["report.md", "sources.json"]
}

// Data analysis in an existing directory
{
  "mode": "data",
  "workspace": { "type": "directory", "path": "/path/to/dataset" },
  "task": "Analyze benchmark JSON files and identify performance regressions.",
  "deliverables": ["analysis.md", "results.csv"]
}

// Review a commit
{
  "mode": "review",
  "workspace": { "type": "git_worktree", "repo_path": "/path/to/repo", "base_ref": "main" },
  "task": "Review commit abc123 for concurrency bugs and API regressions.",
  "deliverables": ["review.md"]
}
```

Defaults: `mode` = `general` (or `code` when `repo_path` is given);
`workspace.type` = `temporary` (or `git_worktree` for `code`/`review` with
`repo_path`, `directory` when `path` is given).

### Typical Codex workflow

1. `spawn_task({mode, task, deliverables})` (or `spawn_tasks` for several) → `{task_id, workspace, …}`
2. Codex continues its own independent planning/review work while workers run
3. `wait_task({task_id})` / `wait_tasks({task_ids, return_when})` when results are actually needed
4. `get_task_result({task_id})` → summary + artifact metadata + deliverables check
5. `get_artifact({task_id, path: "report.md"})` only if content is needed
6. rework: `continue_worker({worker_id: task_id, instruction})` (same session)
7. for code tasks, Codex/you decide whether to merge the branch — the server
   never merges or pushes.

## Efficient waiting

Don't poll. Waiting is event-driven inside the server (a terminal transition
wakes waiters immediately), so a wait call costs one MCP round-trip instead of
dozens of `get_worker` calls.

**Bad:**

```text
spawn A
spawn B
get_worker A
get_worker B
get_worker A
get_worker B
…
```

**Good:**

```text
spawn_tasks([A, B])          # or two spawn_task calls

# Codex continues independent planner/reviewer work here

wait_tasks({task_ids: [A, B], return_when: "all"})
get_task_result A
get_task_result B
```

Semantics:

- `wait_task({task_id, timeout_seconds=60})` — returns the moment the task
  reaches a terminal state (completed / completed_uncommitted / failed /
  cancelled / timeout / interrupted), with the compact result attached.
  Already-terminal tasks return immediately.
- `wait_tasks({task_ids, return_when="all", timeout_seconds=120})` — `"all"`
  means **all terminal** (a mix of completed and failed satisfies it);
  `"any"` returns on the first completion and lists `triggered_by`.
- **A wait timeout never cancels or fails the worker.** It only means
  "still running" — the worker's own execution timeout is a separate setting
  (`timeout_seconds` at spawn). You can safely call `wait_task` again.
- Cancellation, failure, and worker timeouts all wake waiters immediately.
  Queued tasks are fine to wait on — one wait call covers
  `queued → starting → running → completed`.
- Cross-process changes (e.g. `kimi-worker-mcp cancel` from a shell) are picked
  up by a low-frequency (≤5s) fallback re-check.

## Deliverables contract

`deliverables: ["report.md", …]` is written into the worker prompt as a hard
requirement, and **verified on disk** (`fs.stat`) at completion — model claims
don't count. Missing files are recorded as `deliverables_missing` (status
stays `completed`).

## Artifact system

Every file a task produces is indexed in SQLite (`artifacts` table:
task_id, relative/absolute path, mime type, size, sha256) at every terminal
transition:

- **git_worktree**: files changed vs base ref (committed + uncommitted)
- **temporary**: everything in the fresh workspace
- **directory**: files modified since the task started (inputs are not indexed)

Artifacts must live inside the task workspace — arbitrary paths are rejected.
`get_artifact` serves content capped (64 KiB default / 1 MiB max), redacted;
binary files return metadata only.

## Capability model

`capabilities: ["filesystem.read", "shell", "web.search", …]` is recorded on
the task record and injected into the worker prompt as **advisory** intent.
DSH cannot yet precisely disable individual tools per run, so enforcement
today is: prompt injection + workspace path scoping + output redaction. This
is **not** a security sandbox — the architecture leaves room for real
sandbox/preset enforcement later.

Experimental subagent delegation (off by default):

```bash
ENABLE_DSH_SUBAGENTS=false     # set "true" to allow research/general workers to delegate
MAX_SUBAGENT_DEPTH=1
MAX_SUBAGENTS_PER_TASK=3
```

Subagents are managed by DSH itself; this server only injects the allowance
into the prompt and keeps the config surface.

## Compact context policy

Codex never automatically receives: thinking, raw tool calls, raw web pages,
full logs, full datasets, full reports, or giant diffs. Defaults are:
status, summary, artifact metadata, usage, warnings. Everything large requires
an explicit `get_artifact` / `get_worker_log` / `get_worker_diff(stat_only=false)`
call, all size-capped and redacted.

## Git ownership model

**Worker owns execution. Supervisor owns git metadata. Codex owns review and integration.**

A git worktree's `.git` is a pointer file — the real metadata lives in the
original repo's `.git/worktrees/…`, which is typically **outside the worker's
writable sandbox**. Workers therefore edit and test files but cannot reliably
commit. So the division of labor is:

```text
Kimi worker:  inspect → edit → test → debug → final report (no commits)
Supervisor:   verify git state → git add -A → git commit → verify HEAD
Codex:        review compact result / diff → decide whether to integrate
```

Details:

- The supervisor commits with the worker's `suggested_commit_message`
  (sanitized: single line, ≤120 chars, no control chars) or a stable fallback
  (`kimi-worker/<task-id>: apply delegated changes`).
- If the worker still manages to commit itself (e.g. non-sandboxed runtime),
  the supervisor accepts that commit and only finalizes any remaining dirty
  changes into a follow-up commit (`commit_created_by: worker+supervisor`).
- `continue_worker` runs commit per round: run-level HEAD tracking
  (`head_before_run`) ensures each rework becomes its own commit on top of the
  previous one.
- Commit identity respects the repo's existing `user.name`/`user.email`; only
  when missing does the supervisor use per-command
  `-c user.name="Kimi Workforce"` fallback (never touches global config).
- **Cancelled / timed-out / failed** runs are never auto-committed — the dirty
  worktree is preserved for inspection (`git.auto_commit_skipped` explains why).
- If the supervisor's commit itself fails (e.g. a rejecting pre-commit hook),
  the task becomes `completed_uncommitted` with the error recorded; nothing is
  reset or deleted.
- The supervisor only ever runs: `status`, `diff`, `add`, `commit`,
  `rev-parse`, `log`. **Never** push/merge/cherry-pick/reset/clean/rebase.

The compact result's `git` object reports: `base_ref`, `branch`,
`head_before_run`, `head_after`, `commit_hash`, `commit_created`,
`commit_created_by`, `commit_count`, `working_tree_clean`.

## Worker lifecycle

```
queued ──► starting ──► running ──► completed
                          │  ├────► completed_uncommitted   (git tasks only)
                          │  ├────► failed
                          │  ├────► cancelled
                          │  ├────► timeout
                          └────► interrupted                (process lost / restart)
```

- Concurrency: `KIMI_WORKER_MAX_CONCURRENT` (default 4), FIFO queue.
- Timeout: per-task `timeout_seconds` (default 3600, capped at 6h).
- Git tasks: the supervisor verifies and commits successful changes itself
  (see "Git ownership model"); a failed supervisor commit yields
  `completed_uncommitted`.
- `continue_worker` resumes the persisted dsh session (`--session-id`) in the
  same workspace — works for every mode.
- Startup reconciliation repairs `running` rows with dead PIDs from logs +
  workspace state (completed / completed_uncommitted / interrupted), recovers
  session id + token usage, and re-indexes artifacts.

## Backward compatibility

- All eight original tools work unchanged; `spawn_worker` now maps internally
  to `spawn_task(mode=code, git_worktree)` with identical behavior and result
  shape.
- Task ids share the original `wk_xxxxxxxx` id space — every new tool accepts
  ids created by old tools and vice versa.
- Existing SQLite databases **migrate automatically** (schema_meta v1→v2→v3:
  v2 adds mode/workspace/deliverables/artifacts; v3 adds orchestration columns
  on workers plus workflows/workflow_tasks/task_attempts/task_reviews/
  artifact_cache tables; v4 adds task_branch/workspace_base_commit/
  task_commits/integration_* for parallel git isolation). Pre-upgrade rows read as `mode=code`,
  `workspace_type=git_worktree`, `workflow_id=null`. No manual migration, no
  data loss.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `KIMI_WORKER_DSH_BIN` | `/usr/local/bin/dsh` | dsh binary path |
| `KIMI_WORKER_DSH_PROFILE` | `headless` | dsh profile |
| `KIMI_WORKER_ROOT` | `~/.kimi-workers` | state root (worktrees, task workspaces, db) |
| `KIMI_WORKER_DB` | `<root>/workers.db` | SQLite database |
| `KIMI_WORKER_MAX_CONCURRENT` | `4` | max parallel tasks |
| `KIMI_WORKER_DEFAULT_TIMEOUT` | `3600` | default per-task timeout (s) |
| `KIMI_WORKER_MAX_TIMEOUT` | `21600` | timeout upper bound (s) |
| `KIMI_WORKER_LOG_MAX_BYTES` | `32768` | `get_worker_log` cap |
| `KIMI_WORKER_DIFF_MAX_BYTES` | `65536` | full-diff cap |
| `KIMI_WORKER_TERMINATE_GRACE_MS` | `5000` | SIGTERM→SIGKILL grace |
| `KIMI_WORKER_BACKEND` | `dsh` | `dsh` or `fake` (local testing) |
| `ENABLE_DSH_SUBAGENTS` | `false` | experimental subagent delegation |
| `MAX_SUBAGENT_DEPTH` | `1` | subagent depth limit |
| `MAX_SUBAGENTS_PER_TASK` | `3` | subagent count limit |

Model selection (e.g. a newer Kimi model) is done in your dsh profile — this
server invokes the profile and never hardcodes a model.

## Development

```bash
npm run build
npm test                 # 80+ tests: unit + integration (fake backend, temp repos)
npm run test:unit
npm run test:integration
```

Debug CLI:

```bash
node dist/cli.js serve
node dist/cli.js workers|tasks [--status S] [--limit N]
node dist/cli.js task <id>             # compact task result with artifacts
node dist/cli.js inspect <id>          # legacy git-focused result
node dist/cli.js artifacts <id>
node dist/cli.js artifact <id> <path> [--max-bytes N]
node dist/cli.js usage <id>
node dist/cli.js logs <id> [--lines N]
node dist/cli.js diff <id> [--full]
node dist/cli.js cancel <id>
node dist/cli.js workflows             # list workflows
node dist/cli.js workflow <id>         # ASCII DAG with status icons
node dist/cli.js workflow-wait <id> [--timeout S]
node dist/cli.js workflow-cancel <id>
node dist/cli.js review-task <id> <accepted|rejected|needs_revision> [--feedback "..."]
node dist/cli.js task-metrics <id> | workflow-metrics <id> | metrics
node dist/cli.js roles | presets | cache-stats
```

Smoke / e2e scripts:

```bash
node scripts/mcp-smoke.mjs /path/to/git/repo   # MCP protocol smoke (fake backend, all 17 tools incl. wait)
node scripts/real-dsh-e2e.mjs                  # real coding E2E (live API, temp repo)
node scripts/research-e2e.mjs                  # real research E2E (live API, no web dependency)
node scripts/wait-e2e.mjs                      # real parallel wait E2E (two live tasks + wait_tasks)
node scripts/workflow-e2e.mjs                  # real 3-task DAG E2E (live API)
node scripts/parallel-e2e.mjs                  # real parallel git writers E2E (live API)
node scripts/reattach-e2e.mjs                  # real supervisor-restart reattach E2E (live API)
```

## Security

- **Subprocess**: argv-array spawn only — prompts/session ids cannot inject
  shell commands.
- **Credentials**: `~/.dsh/.env` never read; all outbound text (results, logs,
  diffs, artifacts, errors) passes a secret-redaction filter.
- **Paths**: `repo_path`/`workspace.path` canonicalized and validated; all
  state lives under the worker root; artifact/deliverable/diff paths must be
  relative and traversal-free; task ids validated (`wk_[0-9a-f]{8}`).
- **Artifacts**: only files inside the task workspace are indexed/served;
  binary files are never inlined.
- **Ops mode safety**: prompt-level prohibition of sudo/destructive
  commands/SSH/system changes; proposals over direct modification. Advisory
  only — do not point ops workers at systems you cannot afford to lose.
- **Process ownership**: pid-tracked; reconciliation never assumes liveness
  without a matching pid.

## Troubleshooting

| Symptom | Check |
|---|---|
| `spawn_task` fails with "not inside a git repository" | `workspace.repo_path` must be inside a git working tree. |
| `spawn_task` fails "workspace.path does not exist" | directory workspaces must exist beforehand; use `temporary` for a fresh one. |
| Codex says the server closed during `initialize` | Malformed `args` in `config.toml`: use `[".../dist/cli.js", "serve"]` (two strings), not one joined string. |
| MCP tool calls "cancelled" in `codex exec` | Known Codex upstream behavior ([openai/codex#29857](https://github.com/openai/codex/issues/29857), [openai/codex#24135](https://github.com/openai/codex/issues/24135)): non-interactive exec auto-cancels MCP calls needing approval. Use interactive sessions or `--dangerously-bypass-approvals-and-sandbox`. |
| Task instantly `failed` | `node dist/cli.js logs <id>` — includes dsh stderr tail. Verify `/usr/local/bin/dsh --profile headless "Reply with exactly: OK"` works. |
| `deliverables_missing` non-empty | Worker didn't write the required files. `continue_worker` asking for them, or inspect the workspace path from `get_task_result`. |
| `completed_uncommitted` | The supervisor's commit failed (e.g. a rejecting git hook) — changes are preserved in the worktree; check `git.error` in the result. |
| Old worktrees piling up | `git -C <repo> worktree list` → `git worktree remove` + `git branch -D kimi-worker/<id>`. |
| Zero API usage while developing | `KIMI_WORKER_BACKEND=fake`. |

## Known limitations

- Live-pid workers lose supervision across a server restart → `interrupted`
  (workspace/artifacts/logs remain); workflows recompute terminal state on
  restart and duration budgets re-arm.
- Token budgets are best-effort (checked per DSH status/tool event); a run can
  overshoot within one step. Not hard accounting.
- Test pass/fail in compact results is heuristic (from the final report); git
  facts and deliverables are verified directly.
- Directory-workspace artifact discovery is mtime-based (files touched since
  task start); pre-existing files are not indexed.
- Capabilities are advisory (prompt-level), not a hard sandbox.
- Cache is opt-in and only for dependency-free tasks; a cache hit reuses
  artifact files and does not create a new session.
- Subagent support is config/documentation only (DSH manages subagents).
- Priority scheduling is simple (high/normal/low then FIFO); no fairness or
  preemption.
- No worktree/workspace garbage collection (manual, by design).
