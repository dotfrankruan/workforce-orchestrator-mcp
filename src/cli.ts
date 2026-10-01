#!/usr/bin/env node
import fs from 'node:fs';
import { loadConfig, ensureConfigDirs, type Config } from './config.js';
import { WorkerStore } from './db.js';
import { WorkerSupervisor, elapsedSeconds } from './supervisor.js';
import { DshBackend } from './backend/dsh.js';
import { FakeBackend, FakeScenarios } from './backend/fake.js';
import type { WorkerBackend } from './backend/types.js';
import { serveStdio } from './mcp/server.js';

function buildBackend(config: Config): WorkerBackend {
  if (config.backend === 'fake') {
    // For local experimentation only (KIMI_WORKER_BACKEND=fake).
    return new FakeBackend({ scenario: () => FakeScenarios.success() });
  }
  return new DshBackend({ dshBin: config.dshBin, profile: config.dshProfile });
}

function openSupervisor(): { supervisor: WorkerSupervisor; store: WorkerStore; config: Config } {
  const config = loadConfig();
  ensureConfigDirs(config);
  const store = new WorkerStore(config.dbPath);
  const supervisor = new WorkerSupervisor(config, store, buildBackend(config));
  return { supervisor, store, config };
}

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

const WF_STATUS_ICON: Record<string, string> = {
  completed: '✓',
  completed_uncommitted: '✓',
  running: '●',
  starting: '●',
  queued: '○',
  waiting_dependencies: '○',
  failed: '✗',
  timeout: '✗',
  budget_exceeded: '✗',
  interrupted: '✗',
  cancelled: '⊘',
  blocked: '⊘',
};

/** Simple ASCII rendering of a workflow DAG. */
function renderWorkflowAscii(overview: Record<string, unknown>): string {
  const tasks = (overview['tasks'] ?? []) as Array<Record<string, unknown>>;
  const lines: string[] = [
    `workflow ${overview['workflow_id']}  [${overview['status']}]${overview['name'] ? `  ${overview['name']}` : ''}`,
  ];
  if (tasks.length === 0) return lines.join('\n');

  interface Node {
    key: string;
    status: string;
    role: string | null;
    depends_on: string[];
  }
  const nodes: Node[] = tasks.map((t) => ({
    key: String(t['key']),
    status: String(t['status']),
    role: (t['role'] as string | null) ?? null,
    depends_on: (t['depends_on'] as string[]) ?? [],
  }));
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const n of nodes) {
    const parents = n.depends_on.filter((d) => byKey.has(d));
    if (parents.length === 0) roots.push(n.key);
    for (const p of parents) {
      const arr = children.get(p) ?? [];
      arr.push(n.key);
      children.set(p, arr);
    }
  }
  const printed = new Set<string>();
  const render = (key: string, prefix: string, connector: string) => {
    if (printed.has(key)) {
      lines.push(`${prefix}${connector}(↳ ${key} — see above)`);
      return;
    }
    printed.add(key);
    const n = byKey.get(key)!;
    const icon = WF_STATUS_ICON[n.status] ?? '?';
    lines.push(`${prefix}${connector}${n.key} ${icon}${n.role ? ` (${n.role})` : ''}  [${n.status}]`);
    const kids = children.get(key) ?? [];
    kids.forEach((child, i) => {
      const last = i === kids.length - 1;
      render(child, prefix + (connector === '' ? '' : last ? '    ' : '│   '), (kids.length > 1 || connector === '') ? (last ? '└── ' : '├── ') : last ? '└── ' : '├── ');
    });
  };
  roots.forEach((root, i) => {
    render(root, '', i === roots.length - 1 && roots.length > 1 ? '' : '');
  });
  // Orphans (defensive; shouldn't happen with validated DAGs).
  for (const n of nodes) {
    if (!printed.has(n.key)) {
      const icon = WF_STATUS_ICON[n.status] ?? '?';
      lines.push(`${n.key} ${icon}  [${n.status}]`);
    }
  }
  return lines.join('\n');
}

function usage(): never {
  process.stderr.write(
    `kimi-worker-mcp — delegate engineering tasks to Kimi workers via DeepSeek Harness

Usage:
  kimi-worker-mcp serve                 Start the MCP server on stdio
  kimi-worker-mcp workers [--status S] [--repo PATH] [--limit N]
                                        List workers
  kimi-worker-mcp tasks [--status S] [--limit N]
                                        List tasks (alias of workers)
  kimi-worker-mcp task <id>             Show compact task result (with artifacts)
  kimi-worker-mcp inspect <worker-id>   Show compact worker result (git-focused)
  kimi-worker-mcp artifacts <id>        List task artifacts
  kimi-worker-mcp artifact <id> <path> [--max-bytes N]
                                        Print artifact content (capped)
  kimi-worker-mcp usage <id>            Show task token/tool usage
  kimi-worker-mcp logs <worker-id> [--lines N]
                                        Show worker log tail
  kimi-worker-mcp diff <worker-id> [--full]
                                        Show worker diff stat (or full diff)
  kimi-worker-mcp cancel <worker-id>    Cancel a running worker

Configuration (environment variables):
  KIMI_WORKER_DSH_BIN         dsh binary path (default /usr/local/bin/dsh)
  KIMI_WORKER_DSH_PROFILE     dsh profile (default headless)
  KIMI_WORKER_ROOT            worker state root (default ~/.kimi-workers)
  KIMI_WORKER_DB              SQLite db path (default <root>/workers.db)
  KIMI_WORKER_MAX_CONCURRENT  max parallel workers (default 4)
  KIMI_WORKER_DEFAULT_TIMEOUT default per-worker timeout seconds (default 3600)
  KIMI_WORKER_BACKEND         "dsh" (default) or "fake" for local testing
`,
  );
  process.exit(2);
}

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) usage();

  switch (command) {
    case 'serve': {
      const { supervisor } = openSupervisor();
      supervisor.init();

      const shutdown = async () => {
        process.stderr.write('kimi-worker-mcp: shutting down, terminating workers…\n');
        await supervisor.shutdown();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());

      await serveStdio(supervisor);
      break;
    }

    case 'workers':
    case 'tasks': {
      const { supervisor, store } = openSupervisor();
      const status = argValue(rest, '--status') as Parameters<typeof supervisor.list>[0]['status'];
      const repo = argValue(rest, '--repo');
      const limitRaw = argValue(rest, '--limit');
      const rows = supervisor.list({
        status: status ?? undefined,
        repo_path: repo ?? undefined,
        limit: limitRaw ? Number(limitRaw) : 20,
      });
      printJson(
        rows.map((r) => ({
          worker_id: r.id,
          status: r.status,
          mode: r.mode,
          workspace_type: r.workspace_type,
          repo_path: r.repo_path || null,
          branch: r.branch || null,
          created_at: r.created_at,
          elapsed_seconds: elapsedSeconds(r),
          commit_hash: r.commit_hash?.slice(0, 7) ?? null,
          error: r.error,
        })),
      );
      store.close();
      break;
    }

    case 'task': {
      const id = rest[0];
      if (!id) usage();
      const { supervisor, store } = openSupervisor();
      printJson(supervisor.taskResult(id));
      store.close();
      break;
    }

    case 'artifacts': {
      const id = rest[0];
      if (!id) usage();
      const { supervisor, store } = openSupervisor();
      printJson(supervisor.listArtifacts(id));
      store.close();
      break;
    }

    case 'artifact': {
      const id = rest[0];
      const artifactPath = rest[1];
      if (!id || !artifactPath) usage();
      const maxRaw = argValue(rest, '--max-bytes');
      const { supervisor, store } = openSupervisor();
      const out = supervisor.artifactContent(id, artifactPath, maxRaw ? Number(maxRaw) : undefined);
      if (out['binary']) {
        process.stderr.write(`binary artifact (${out['mime_type']}, ${out['size_bytes']} bytes) — not printed\n`);
      } else {
        process.stdout.write(String(out['content'] ?? '') + '\n');
        if (out['truncated']) process.stderr.write('[artifact truncated]\n');
      }
      store.close();
      break;
    }

    case 'usage': {
      const id = rest[0];
      if (!id) usage();
      const { supervisor, store } = openSupervisor();
      printJson(supervisor.taskUsage(id));
      store.close();
      break;
    }

    case 'workflows': {
      const { supervisor, store } = openSupervisor();
      const wfs = supervisor.listWorkflows(argValue(rest, '--limit') ? Number(argValue(rest, '--limit')) : 20);
      printJson(
        wfs.map((w) => ({
          workflow_id: w['workflow_id'],
          name: w['name'],
          status: w['status'],
          preset: w['preset'],
          progress: w['progress'],
          created_at: w['created_at'],
        })),
      );
      store.close();
      break;
    }

    case 'workflow': {
      const id = rest[0];
      if (!id) usage();
      const { supervisor, store } = openSupervisor();
      process.stdout.write(renderWorkflowAscii(supervisor.getWorkflow(id)) + '\n');
      store.close();
      break;
    }

    case 'workflow-wait': {
      const id = rest[0];
      if (!id) usage();
      const { supervisor, store } = openSupervisor();
      supervisor.init();
      const timeout = argValue(rest, '--timeout');
      printJson(await supervisor.waitWorkflow(id, timeout ? Number(timeout) : undefined));
      store.close();
      break;
    }

    case 'workflow-cancel': {
      const id = rest[0];
      if (!id) usage();
      const { supervisor, store } = openSupervisor();
      printJson(await supervisor.cancelWorkflow(id));
      store.close();
      break;
    }

    case 'roles': {
      const { supervisor, store } = openSupervisor();
      printJson(supervisor.listRoles());
      store.close();
      break;
    }

    case 'presets': {
      const { supervisor, store } = openSupervisor();
      printJson(supervisor.listPresets());
      store.close();
      break;
    }

    case 'review-task': {
      const id = rest[0];
      const decision = rest[1];
      if (!id || !decision) usage();
      const { supervisor, store } = openSupervisor();
      printJson(supervisor.reviewTaskResult(id, decision, argValue(rest, '--feedback')));
      store.close();
      break;
    }

    case 'task-metrics': {
      const id = rest[0];
      if (!id) usage();
      const { supervisor, store } = openSupervisor();
      printJson(supervisor.taskMetrics(id));
      store.close();
      break;
    }

    case 'workflow-metrics': {
      const id = rest[0];
      if (!id) usage();
      const { supervisor, store } = openSupervisor();
      printJson(supervisor.workflowMetrics(id));
      store.close();
      break;
    }

    case 'metrics': {
      const { supervisor, store } = openSupervisor();
      printJson(supervisor.systemMetrics());
      store.close();
      break;
    }

    case 'inspect': {
      const id = rest[0];
      if (!id) usage();
      const { supervisor, store } = openSupervisor();
      printJson(supervisor.result(id));
      store.close();
      break;
    }

    case 'logs': {
      const id = rest[0];
      if (!id) usage();
      const linesRaw = argValue(rest, '--lines');
      const { supervisor, store } = openSupervisor();
      const out = supervisor.log(id, linesRaw ? Number(linesRaw) : 100);
      process.stdout.write(out.lines + '\n');
      if (out.truncated) process.stderr.write('[log truncated]\n');
      store.close();
      break;
    }

    case 'diff': {
      const id = rest[0];
      if (!id) usage();
      const full = rest.includes('--full');
      const { supervisor, store } = openSupervisor();
      printJson(supervisor.diff(id, { stat_only: !full }));
      store.close();
      break;
    }

    case 'cancel': {
      const id = rest[0];
      if (!id) usage();
      const { supervisor, store } = openSupervisor();
      const result = await supervisor.cancelWorker(id);
      printJson(result);
      store.close();
      break;
    }

    case 'help':
    case '--help':
    case '-h':
      usage();
      break;

    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      usage();
  }
}

main().catch((err) => {
  process.stderr.write(`kimi-worker-mcp: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
