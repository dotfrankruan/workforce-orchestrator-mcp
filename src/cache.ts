import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tryGit } from './util/git.js';

/**
 * Conservative artifact/analysis cache.
 *
 * Only caches knowledge products (research reports, reviews, repo analyses,
 * data summaries) — never execution side effects. Cache lookup is opt-in via
 * per-task cache_policy; code implementation defaults to off.
 *
 * Key = sha256(schemaVersion + promptVersion + mode + role + normalizedTask
 * + workspaceFingerprint). Any change (git HEAD moves, dirty diff, role or
 * prompt-template change, cache schema bump) is a cache miss.
 */

export const CACHE_SCHEMA_VERSION = 1;
/** Bump when prompt templates change in ways that should invalidate cache. */
export const PROMPT_TEMPLATE_VERSION = 1;

export function normalizeTaskText(task: string): string {
  return task.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Fingerprint a workspace: what the worker would see before it starts. */
export function workspaceFingerprint(workspaceType: string, workspacePath: string): string {
  if (workspaceType === 'git_worktree') {
    const head = tryGit(['rev-parse', 'HEAD'], workspacePath)?.trim() ?? 'nohead';
    const porcelain = tryGit(['status', '--porcelain'], workspacePath) ?? '';
    if (porcelain.trim() === '') return `git:${head}`;
    // Dirty tree: HEAD + hash of the pending diff.
    const diff = tryGit(['diff', 'HEAD'], workspacePath) ?? porcelain;
    const diffHash = crypto.createHash('sha256').update(diff).digest('hex').slice(0, 16);
    return `git:${head}+dirty:${diffHash}`;
  }
  if (workspaceType === 'temporary') {
    return 'empty';
  }
  // directory: hash the file listing (relative path + size + mtime).
  const lines: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || lines.length > 5000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '.git' && e.name !== 'node_modules') walk(abs, depth + 1);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(abs);
          lines.push(`${path.relative(workspacePath, abs)}:${st.size}:${Math.round(st.mtimeMs)}`);
        } catch {
          /* vanished */
        }
      }
    }
  };
  walk(workspacePath, 0);
  lines.sort();
  const hash = crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
  return `dir:${hash}`;
}

export interface CacheKeyInput {
  mode: string;
  role: string | null;
  roleFragment: string | null;
  task: string;
  fingerprint: string;
}

export function computeCacheKey(input: CacheKeyInput): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        v: CACHE_SCHEMA_VERSION,
        pv: PROMPT_TEMPLATE_VERSION,
        mode: input.mode,
        role: input.role,
        rf: input.roleFragment ? crypto.createHash('sha256').update(input.roleFragment).digest('hex').slice(0, 12) : null,
        task: normalizeTaskText(input.task),
        ws: input.fingerprint,
      }),
    )
    .digest('hex');
}
