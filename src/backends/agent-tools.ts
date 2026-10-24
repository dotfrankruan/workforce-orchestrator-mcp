import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';

/**
 * Minimal, provider-agnostic tool surface for direct API backends
 * (OpenAI / Anthropic). These are the same spirit as an agent runtime's
 * built-in tools: inspect and modify the workspace, run commands.
 *
 * The orchestrator already treats the workspace as the worker's sandbox;
 * these helpers enforce that the model cannot escape it through path
 * traversal. `run_shell` intentionally executes a shell in that workspace.
 */

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const MAX_READ_BYTES = 256 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 24 * 1024;
const SHELL_TIMEOUT_MS = 120_000;
const SHELL_MAX_BUFFER = 1024 * 1024;

function resolveInside(cwd: string, p: unknown): string {
  if (typeof p !== 'string' || p.trim() === '') {
    throw new Error('path must be a non-empty relative path');
  }
  const abs = path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return abs;
  throw new Error(`path escapes the workspace: ${p}`);
}

function truncate(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_TOOL_OUTPUT_BYTES) return text;
  return Buffer.from(text, 'utf8').subarray(0, MAX_TOOL_OUTPUT_BYTES).toString('utf8') + '\n...[truncated]';
}

export const AGENT_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the workspace. Returns at most 256 KiB.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path relative to the workspace root.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a UTF-8 text file inside the workspace (parent directories are created).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories inside the workspace (non-recursive unless recursive=true).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to the workspace root (default ".").' },
        recursive: { type: 'boolean', description: 'Recurse into subdirectories (default false).' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'run_shell',
    description:
      'Run a shell command in the workspace root. Returns exit code, stdout and stderr (output capped). Use for builds, tests, git inspection, grep, etc.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell command to execute.' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
] as const;

function listDirectory(cwd: string, target: string, recursive: boolean): string {
  const root = resolveInside(cwd, target);
  const out: string[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 8 || out.length > 2000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      out.push(`${prefix}[error: ${(err as Error).message}]`);
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        if (recursive) walk(path.join(dir, entry.name), rel, depth + 1);
      } else {
        let size = '';
        try {
          size = ` (${fs.statSync(path.join(dir, entry.name)).size} B)`;
        } catch {
          /* ignore */
        }
        out.push(`${rel}${size}`);
      }
    }
  };
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error(`not a directory: ${target}`);
  walk(root, '', 0);
  return out.length === 0 ? '(empty)' : out.join('\n');
}

function runShell(cwd: string, command: unknown, signal?: AbortSignal): Promise<string> {
  if (typeof command !== 'string' || command.trim() === '') {
    return Promise.reject(new Error('command must be a non-empty string'));
  }
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout: SHELL_TIMEOUT_MS,
        maxBuffer: SHELL_MAX_BUFFER,
        signal,
        env: process.env,
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
        const parts = [`exit_code: ${code}`];
        if (stdout) parts.push(`stdout:\n${stdout}`);
        if (stderr) parts.push(`stderr:\n${stderr}`);
        if (err && !stdout && !stderr) parts.push(`error: ${err.message}`);
        resolve(truncate(parts.join('\n')));
      },
    );
  });
}

/** Execute one tool call. Always returns a string suitable for a tool result. */
export async function executeAgentTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    switch (name) {
      case 'read_file': {
        const abs = resolveInside(cwd, args['path']);
        const fd = fs.openSync(abs, 'r');
        const buf = Buffer.alloc(MAX_READ_BYTES + 1);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const text = buf.subarray(0, Math.min(n, MAX_READ_BYTES)).toString('utf8');
        return n > MAX_READ_BYTES ? `${text}\n...[truncated at ${MAX_READ_BYTES} bytes]` : text;
      }
      case 'write_file': {
        const abs = resolveInside(cwd, args['path']);
        const content = typeof args['content'] === 'string' ? args['content'] : String(args['content'] ?? '');
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
        return `wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${String(args['path'])}`;
      }
      case 'list_directory': {
        const target = typeof args['path'] === 'string' && args['path'] !== '' ? args['path'] : '.';
        return truncate(listDirectory(cwd, target, args['recursive'] === true));
      }
      case 'run_shell':
        return await runShell(cwd, args['command'], signal);
      default:
        return `unknown tool: ${name}`;
    }
  } catch (err) {
    return `tool error: ${(err as Error).message}`;
  }
}
