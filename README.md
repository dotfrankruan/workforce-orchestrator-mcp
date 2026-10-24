# Workforce Orchestrator MCP

A universal execution workforce for Codex and other MCP clients.

The orchestrator turns a planner (Codex, Claude, or any MCP-capable client) into
a supervisor over **pluggable worker backends**: task DAGs, workflows, budgets,
roles, presets, acceptance tracking, metrics, durable process supervision, git
isolation, and an artifact cache.

**The planner thinks. Workers execute. The orchestrator schedules. The
supervisor owns state and Git. Humans retain final control.**

```
                         Planner (Codex)
                              │
                              ▼
                    Workforce Orchestrator
                              │
                        Backend Router
                              │
        ┌──────────────┬──────┴───────┬──────────────┐
        ▼              ▼              ▼              ▼
   DeepSeek        OpenCode      OpenAI API     Anthropic API
   Harness         CLI           (direct)       (direct)
        │              │              │              │
        └──────────────┴──────────────┴──────────────┘
                              │
                     isolated workspaces
                     artifacts · metrics · git
```

## Backends

| Backend id | Runtime | Session continuation | Durable reattach | Credentials |
|---|---|---|---|---|
| `dsh` | DeepSeek Harness CLI (headless profile) | yes | yes | owned by dsh (`~/.dsh/.env`) |
| `opencode` | OpenCode CLI (`opencode run --format json`) | yes | yes | owned by OpenCode (`opencode auth`) |
| `openai` | Direct OpenAI Chat Completions or Responses API | yes | no (in-process) | `OPENAI_API_KEY` / config |
| `anthropic` | Direct Anthropic Messages API | yes | no (in-process) | `ANTHROPIC_API_KEY` / config |
| `fake` | Local test backend, no API calls | yes | no | none |

The registry is deterministic and never silently falls back. Selection order:

1. explicit `backend` on the task/workflow task
2. `routing.roles.<role>` from `~/.workforce/config.json`
3. `routing.default`
4. `default_backend`
5. `WORKFORCE_DEFAULT_BACKEND`
6. `WORKFORCE_BACKEND` (unless `auto`)
7. first locally available backend in order `dsh → opencode → openai → anthropic`
8. `dsh`

`auto` is the default, so a fresh install uses whichever runtime is actually
available on the machine. An unavailable explicitly-selected backend is a clear
error — nothing is auto-installed or silently substituted.

## What's new in v0.3

- Removed all vendor-specific naming. Environment variables,
  branches, state paths, package/bin names, and messages are now universal.
- Added **OpenCode** as a first-class CLI backend with durable JSONL logs,
  session continuation, usage/tool events, and reattach support.
- Added **direct OpenAI** backend: Chat Completions (`/chat/completions`) or
  Responses (`/responses`), with a tool loop.
- Added **direct Anthropic** backend: Messages API with a tool loop.
- Direct API backends expose `read_file`, `write_file`, `list_directory`, and
  `run_shell`, scoped to the task workspace.
- `WORKFORCE_BACKEND=auto` plus automatic local backend discovery.
- Workflow token budget is now `max_worker_tokens` (vendor alias removed).

## Quick start

```bash
npm install
npm run build

# Optional: see which backends are locally available
node dist/cli.js backends

# Start the MCP server on stdio
node dist/cli.js serve   # or: npx workforce-mcp serve
```

Zero-config behavior depends on what is installed:

- `dsh` on PATH (or `/usr/local/bin/dsh`) → DeepSeek Harness
- otherwise `opencode` on PATH → OpenCode
- otherwise an OpenAI/Anthropic API key in the environment → direct API
- otherwise the server starts and reports a clear availability error at spawn

## Installation

Requirements:

- macOS or Linux
- Node.js ≥ 22 (uses built-in `node:sqlite`; verified on Node 24)
- git
- at least one worker backend:
  - DeepSeek Harness CLI, or
  - OpenCode CLI, or
  - an OpenAI-compatible API key, or
  - an Anthropic API key

```bash
npm install
npm run build
```

## Codex MCP setup

```toml
[mcp_servers.workforce]
command = "node"
args = ["/absolute/path/to/workforce-orchestrator-mcp/dist/cli.js", "serve"]
```

Each argv element must be its own TOML string. A single
`"…/cli.js serve"` string makes node look for a file literally named
`cli.js serve`.

Optional environment overrides:

```toml
[mcp_servers.workforce.env]
WORKFORCE_BACKEND = "auto"
WORKFORCE_MAX_CONCURRENT = "4"
WORKFORCE_ROOT = "~/.workforce/workers"
# Direct API backends:
# OPENAI_API_KEY = "..."
# ANTHROPIC_API_KEY = "..."
```

## Backend configuration (`~/.workforce/config.json`)

The orchestrator works with zero configuration. The optional config file is the
single place to pin executables, choose models, and route roles.

- **Absent** → built-in defaults and `auto` backend selection.
- **Present** → strict JSON (no comments, no YAML), read once at startup.
- Copy the template:

  ```bash
  mkdir -p ~/.workforce
  cp config.example.json ~/.workforce/config.json
  node dist/cli.js backends
  ```

### Schema

```jsonc
{
  "default_backend": "auto",
  "backends": {
    "dsh": {
      "command": "/usr/local/bin/dsh",
      "profile": "headless"
    },
    "opencode": {
      "command": "opencode",
      "model": "anthropic/claude-sonnet-4-5",
      "agent": "build",
      "auto_approve": true,
      "args": []
    },
    "openai": {
      "api_key_env": "OPENAI_API_KEY",
      "base_url": "https://api.openai.com/v1",
      "model": "gpt-4.1",
      "api": "chat_completions",     // or "responses"
      "max_output_tokens": 8192,
      "temperature": 0.2,
      "max_iterations": 48
    },
    "anthropic": {
      "api_key_env": "ANTHROPIC_API_KEY",
      "base_url": "https://api.anthropic.com",
      "model": "claude-sonnet-4-5",
      "api_version": "2023-06-01",
      "max_output_tokens": 8192,
      "max_iterations": 48
    }
  },
  "routing": {
    "default": "dsh",
    "roles": {
      "reviewer": "openai",
      "researcher": "anthropic"
    }
  }
}
```

All fields are optional. Unknown keys are ignored for forward compatibility.
Backend ids referenced in `default_backend` / routing must be registered,
otherwise startup fails with an explicit error.

### Credentials

Prefer environment variables over storing secrets in the config file:

| Backend | Primary env | Alternate env |
|---|---|---|
| OpenAI | `WORKFORCE_OPENAI_API_KEY` | `OPENAI_API_KEY` |
| Anthropic | `WORKFORCE_ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` |

`api_key_env` lets you name a different environment variable. A custom
`base_url` can point at a local OpenAI-compatible gateway that does not require
a key; in that case the backend is considered available even with an empty key.

`dsh` and `opencode` own their credentials (for example `~/.dsh/.env` and
`opencode auth`); the orchestrator does not read or manage them.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `WORKFORCE_BACKEND` | `auto` | `auto`, `dsh`, `opencode`, `openai`, `anthropic`, `fake` |
| `WORKFORCE_DEFAULT_BACKEND` | — | Routing default (overrides `WORKFORCE_BACKEND`) |
| `WORKFORCE_ROOT` | `~/.workforce/workers` | State root (worktrees, task workspaces, db) |
| `WORKFORCE_DB` | `<root>/workers.db` | SQLite database |
| `WORKFORCE_MAX_CONCURRENT` | `4` | Max parallel tasks |
| `WORKFORCE_DEFAULT_TIMEOUT` | `3600` | Default per-task timeout (s) |
| `WORKFORCE_MAX_TIMEOUT` | `21600` | Timeout ceiling (s) |
| `WORKFORCE_LOG_MAX_BYTES` | `32768` | `get_worker_log` cap |
| `WORKFORCE_DIFF_MAX_BYTES` | `65536` | Full-diff cap |
| `WORKFORCE_FINAL_TEXT_MAX_CHARS` | `8000` | Final report text cap |
| `WORKFORCE_TERMINATE_GRACE_MS` | `5000` | SIGTERM→SIGKILL grace |
| `WORKFORCE_DSH_COMMAND` | `/usr/local/bin/dsh` or PATH | dsh executable |
| `WORKFORCE_DSH_PROFILE` | `headless` | dsh profile |
| `WORKFORCE_OPENCODE_COMMAND` | `opencode` | OpenCode executable |
| `WORKFORCE_OPENCODE_MODEL` | OpenCode default | `provider/model` |
| `WORKFORCE_OPENCODE_AGENT` | OpenCode default | Agent name |
| `WORKFORCE_OPENCODE_AUTO` | `true` | Pass `--auto` |
| `WORKFORCE_OPENCODE_ARGS` | — | Extra CLI flags (space-separated) |
| `WORKFORCE_OPENAI_API_KEY` | — | OpenAI key |
| `WORKFORCE_OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI base URL |
| `WORKFORCE_OPENAI_MODEL` | `gpt-4.1` | OpenAI model |
| `WORKFORCE_OPENAI_API` | `chat_completions` | `chat_completions` or `responses` |
| `WORKFORCE_ANTHROPIC_API_KEY` | — | Anthropic key |
| `WORKFORCE_ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Anthropic base URL |
| `WORKFORCE_ANTHROPIC_MODEL` | `claude-sonnet-4-5` | Anthropic model |
| `WORKFORCE_ANTHROPIC_VERSION` | `2023-06-01` | API version header |
| `WORKFORCE_ENABLE_SUBAGENTS` | `false` | Allow research/general subagent delegation |
| `WORKFORCE_MAX_SUBAGENT_DEPTH` | `1` | Subagent depth limit |
| `WORKFORCE_MAX_SUBAGENTS_PER_TASK` | `3` | Subagent count limit |

## MCP tools

### Orchestration

| Tool | Purpose |
|---|---|
| `create_workflow` | Key-based task DAG; shared workspace; budgets; failure policy; cycles rejected. |
| `run_workflow_preset` | Expand a built-in preset around a goal (`options.dry_run` = plan only). |
| `list_presets` / `list_roles` | Built-in presets and role templates. |
| `get_workflow` / `list_workflows` | Transparent plan and live status. |
| `wait_workflow` | Event-driven wait for terminal state. |
| `cancel_workflow` | Cancel all non-terminal tasks; preserves workspaces/artifacts. |
| `get_workflow_result` | Compact aggregate: outcomes, artifacts, metrics, warnings. |
| `get_workflow_diff` | Integrated diff vs base (stat by default). |
| `review_task_result` | Record acceptance (`accepted`/`rejected`/`needs_revision`). |
| `get_task_metrics` / `get_workflow_metrics` / `get_system_metrics` | Objective counters and quality stats. |

### Tasks

| Tool | Purpose |
|---|---|
| `spawn_task` | Spawn any mode with any workspace, deliverables, capabilities, backend. |
| `spawn_tasks` | Batch-spawn up to 16 independent tasks. |
| `wait_task` / `wait_tasks` | Efficient event-driven waiting (`all`/`any`). |
| `get_task_result` | Compact result: status, summary, artifacts, deliverables, usage. |
| `list_artifacts` / `get_artifact` / `get_artifact_metadata` | Artifact metadata and capped content. |
| `get_task_usage` | Tokens, steps, tool calls by tool, runs, duration. |
| `list_backends` / `get_backend` | Backend availability, capabilities, factual metadata. |

### Workers (legacy aliases, fully supported)

| Tool | Purpose |
|---|---|
| `spawn_worker` | `spawn_task(mode=code, git_worktree)`. |
| `get_worker` / `list_workers` | Compact worker status. |
| `continue_worker` | Resume the task in the same workspace/backend session. |
| `cancel_worker` | Graceful terminate; workspace and changes preserved. |
| `get_worker_result` | Legacy git-focused compact result. |
| `get_worker_log` / `get_worker_diff` | Redacted, capped diagnostics. |

## Task modes

| Mode | Purpose | Default workspace |
|---|---|---|
| `code` | Implement, fix, test, debug, commit in an isolated worktree | git_worktree |
| `research` | Investigate (web when available), synthesize, record `sources.json` | temporary |
| `data` | Analyze CSV/JSON/SQLite/logs; inputs read-only, outputs as files | directory (if path given) |
| `docs` | README/architecture/migration docs | any |
| `file` | Batch organize/classify/rename/convert inside the workspace | directory/temporary |
| `ops` | Logs/config/service diagnosis; proposals, no destructive changes | directory/temporary |
| `review` | Read-only code review; may run tests | git_worktree |
| `general` | Generic knowledge work with file deliverables | temporary |

Each mode has its own prompt template under [src/prompts/](src/prompts/).

## Workspaces

- **git_worktree** — isolated branch `workforce/worker/<id>` and worktree under
  `~/.workforce/workers/<repo>-<hash>/<id>/worktree`. The orchestrator never
  merges, pushes, or touches your main branch.
- **directory** — existing caller directory, canonicalized; artifact indexing is
  scoped to it.
- **temporary** — fresh per-task directory under the state root, kept after
  completion.

## Workflows, DAGs, and git isolation

- Workflows share one workspace; git workflows share one integration branch
  (`workforce/workflow/<wf-id>`).
- Each git workflow task gets its own worktree and branch
  (`workforce/task/<id>`), materialized from the current integration HEAD.
- Task commits are cherry-picked onto the integration branch through a
  per-workflow async mutex. Conflicts abort cleanly and are surfaced with the
  conflicting files/commits — never auto-resolved.
- `continue_worker` on a conflicted task creates a fresh worktree from the
  latest integration HEAD (`workforce/task/<id>-r<N>`) and retries integration.
- Failure policies: `stop_dependents` (default), `continue`,
  `cancel_remaining`.
- Budgets: per-task token/time/tool/iteration caps and per-workflow
  `max_worker_tokens`, `max_duration_seconds`, `max_concurrent_tasks`,
  `max_tasks`. Breaches produce terminal `budget_exceeded`.

## Durable supervision

- Child-process backends (`dsh`, `opencode`) write stdout/stderr directly to
  durable log files, so a supervisor crash does not break the worker.
- On restart: a live PID with matching identity is reattached (log replay,
  counters, timeout, budgets); a dead PID with a durable terminal event is
  finalized normally; a dead PID with no terminal evidence becomes
  `interrupted`. Exit codes are never fabricated.
- Graceful server shutdown detaches workers instead of killing them. Only
  `cancel_worker`, `cancel_workflow`, timeout, or budget terminate them.
- Direct API backends (`openai`, `anthropic`) run in-process and cannot be
  reattached; an in-flight request becomes `interrupted` on restart, with the
  workspace and artifacts preserved.

## Git ownership

Workers edit and test files. The supervisor verifies and commits successful
changes on git worktrees:

- commit message from a `suggested_commit_message:` line in the final report,
  or `workforce/worker/<task-id>: apply delegated changes`;
- worker-created commits are accepted, remaining dirty files are finalized in a
  follow-up commit;
- cancelled / timed-out / failed runs are never auto-committed;
- commit identity uses the repo's existing `user.name`/`user.email`, with a
  fallback identity only when missing;
- supervisor git commands: `status`, `diff`, `add`, `commit`, `rev-parse`,
  `log`, `cherry-pick` (+`--abort`), `worktree`, `branch`. Never push, merge,
  reset, clean, or rebase.

## Waiting and compact context

Do not poll. `wait_task` / `wait_tasks` / `wait_workflow` are event-driven and
return as soon as terminal state is reached (or the wait budget expires). A wait
timeout never cancels a worker.

Compact results contain status, summary, artifact metadata, usage, and
warnings. Thinking, raw tool output, full logs, full datasets, and giant diffs
never enter context automatically. Fetch them explicitly with `get_artifact`,
`get_worker_log`, or `get_worker_diff`; all are capped and redacted.

## Deliverables and artifacts

`deliverables: ["report.md", ...]` is written into the worker prompt as a hard
requirement and verified on disk at completion. Missing files are recorded as
`deliverables_missing` (the task can still be `completed`).

Every produced file is indexed in SQLite with path, mime type, size, and
sha256. Artifacts must live inside the task workspace; arbitrary paths are
rejected. Binary artifacts return metadata only.

## Roles and presets

Built-in roles: `implementer`, `tester`, `researcher`, `reviewer`,
`docs_writer`, `data_analyst`, `debugger`, `ops_analyst`.

Built-in presets: `bug_fix`, `feature_development`, `quality_audit`,
`research_report`, `data_analysis`. Presets are transparent DAGs — inspect them
with `list_presets` / `get_workflow`, or dry-run with
`run_workflow_preset({options:{dry_run:true}})`.

## CLI

```bash
node dist/cli.js serve
node dist/cli.js workers|tasks [--status S] [--limit N]
node dist/cli.js task <id>
node dist/cli.js inspect <id>
node dist/cli.js artifacts <id>
node dist/cli.js artifact <id> <path> [--max-bytes N]
node dist/cli.js usage <id>
node dist/cli.js logs <id> [--lines N]
node dist/cli.js diff <id> [--full]
node dist/cli.js cancel <id>
node dist/cli.js workflows
node dist/cli.js workflow <id>
node dist/cli.js workflow-wait <id> [--timeout S]
node dist/cli.js workflow-cancel <id>
node dist/cli.js review-task <id> <accepted|rejected|needs_revision> [--feedback "..."]
node dist/cli.js task-metrics <id> | workflow-metrics <id> | metrics
node dist/cli.js roles | presets | cache-stats
node dist/cli.js backends | backend <id>
```

## Development

```bash
npm run build
npm test                 # unit + integration (fake/local backends, temp repos)
npm run test:unit
npm run test:integration
```

Smoke / live E2E scripts:

```bash
node scripts/mcp-smoke.mjs /path/to/git/repo   # MCP protocol smoke (fake backend)
node scripts/real-dsh-e2e.mjs                  # live dsh coding E2E
node scripts/research-e2e.mjs                  # live research E2E
node scripts/wait-e2e.mjs                      # live parallel wait E2E
node scripts/workflow-e2e.mjs                  # live 3-task DAG E2E
node scripts/parallel-e2e.mjs                  # live parallel git writers E2E
node scripts/reattach-e2e.mjs                  # live supervisor-restart reattach E2E
```

## Security

- **Subprocess backends**: argv-array spawn only; prompts/session ids cannot
  inject shell commands.
- **Direct API backends**: file tools resolve paths strictly inside the task
  workspace. `run_shell` is an intentional agent capability and executes in
  that workspace; do not run untrusted models on machines you cannot afford to
  lose.
- **Credentials**: dsh/OpenCode credentials are never read. API keys are read
  only from the configured environment variables and are never emitted in
  results, logs, diffs, artifacts, or errors (all output passes a redaction
  filter).
- **Paths**: `repo_path`/`workspace.path` are canonicalized and validated; all
  state lives under the worker root; artifact/deliverable/diff paths must be
  relative and traversal-free.
- **Ops mode**: prompt-level prohibition of sudo/destructive commands/SSH/system
  changes; proposals over direct modification. Advisory, not a hard sandbox.
- **Process ownership**: PID-tracked with start-token identity; reconciliation
  never assumes liveness from a bare PID.

## Known limitations

- Direct API backends are in-process: no durable reattach across supervisor
  restarts, and their shell tool inherits the server's permissions.
- Token budgets are best-effort, checked per backend event; a run can overshoot
  within one step.
- Test pass/fail in compact results is heuristic (from the final report); git
  facts and deliverables are verified directly.
- Directory-workspace artifact discovery is mtime-based.
- Capabilities are advisory (prompt-level), not a security sandbox.
- Artifact cache is opt-in and only for dependency-free tasks.
- Subagent support is prompt/config only; the runtime manages subagents.
- No automatic worktree/workspace garbage collection (manual, by design).

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
Copyright 2026 Frank Ruan.
