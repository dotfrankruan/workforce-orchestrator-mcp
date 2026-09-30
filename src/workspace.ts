import fs from 'node:fs';
import path from 'node:path';
import { canonicalize, safeJoinUnder, repoSlug } from './util/paths.js';
import { validateRepoPath, resolveRef, createWorktree, removeWorktree } from './worktree.js';
import { workerBranch } from './util/ids.js';
import type { TaskMode } from './modes.js';

/**
 * Workspace abstraction. Git is no longer a hard requirement for a task —
 * it is one workspace type among three.
 *
 *   git_worktree — isolated branch+worktree of a real repo (code/review)
 *   directory    — a caller-designated existing directory (data/file/ops…)
 *   temporary    — a fresh per-task directory under the worker root
 */

export type WorkspaceType = 'git_worktree' | 'directory' | 'temporary';

export interface WorkspaceInput {
  type?: WorkspaceType | undefined;
  /** For type=directory: the directory the worker operates in. */
  path?: string | undefined;
  /** For type=git_worktree: path inside the target git repository. */
  repo_path?: string | undefined;
  /** For type=git_worktree: git ref to branch from (default HEAD). */
  base_ref?: string | undefined;
}

export interface PlannedWorkspace {
  type: WorkspaceType;
  /** Absolute cwd the worker process runs in. */
  cwd: string;
  /** Absolute root that all artifacts must live under. */
  artifactRoot: string;
  /** Directory for this task's logs/metadata (outside the workspace itself). */
  logDir: string;
  /** git-only fields (empty strings otherwise, DB columns are NOT NULL). */
  repoPath: string;
  baseRef: string;
  branch: string;
}

export function isWorkspaceType(s: string): s is WorkspaceType {
  return s === 'git_worktree' || s === 'directory' || s === 'temporary';
}

/** Decide mode + workspace type from spawn input and defaults. */
export function resolveModeAndWorkspace(
  mode: TaskMode | undefined,
  ws: WorkspaceInput | undefined,
): { mode: TaskMode; type: WorkspaceType } {
  const resolvedMode: TaskMode = mode ?? (ws?.repo_path ? 'code' : 'general');
  let type = ws?.type;
  if (!type) {
    if (ws?.repo_path && (resolvedMode === 'code' || resolvedMode === 'review')) {
      type = 'git_worktree';
    } else if (ws?.path) {
      type = 'directory';
    } else {
      type = 'temporary';
    }
  }
  return { mode: resolvedMode, type };
}

export interface PlanContext {
  workerRoot: string;
  workerId: string;
}

/**
 * Resolve all paths for a workspace without creating anything.
 * Throws on invalid input (missing repo, nonexistent directory, traversal).
 */
export function planWorkspace(
  type: WorkspaceType,
  input: WorkspaceInput,
  ctx: PlanContext,
): PlannedWorkspace {
  switch (type) {
    case 'git_worktree': {
      if (!input.repo_path) throw new Error('workspace.repo_path is required for git_worktree');
      const { repoRoot } = validateRepoPath(input.repo_path);
      const baseSha = resolveRef(repoRoot, input.base_ref ?? 'HEAD');
      const logDir = safeJoinUnder(ctx.workerRoot, repoSlug(repoRoot), ctx.workerId);
      return {
        type,
        cwd: path.join(logDir, 'worktree'),
        artifactRoot: path.join(logDir, 'worktree'),
        logDir,
        repoPath: repoRoot,
        baseRef: baseSha,
        branch: workerBranch(ctx.workerId),
      };
    }
    case 'directory': {
      if (!input.path) throw new Error('workspace.path is required for directory workspace');
      let canonical: string;
      try {
        canonical = canonicalize(input.path);
      } catch {
        throw new Error(`workspace.path does not exist or is not readable: ${input.path}`);
      }
      if (!fs.statSync(canonical).isDirectory()) {
        throw new Error(`workspace.path is not a directory: ${canonical}`);
      }
      if (path.parse(canonical).root === canonical) {
        throw new Error('workspace.path must not be the filesystem root');
      }
      const logDir = safeJoinUnder(ctx.workerRoot, 'tasks', ctx.workerId);
      return {
        type,
        cwd: canonical,
        artifactRoot: canonical,
        logDir,
        repoPath: '',
        baseRef: '',
        branch: '',
      };
    }
    case 'temporary': {
      const logDir = safeJoinUnder(ctx.workerRoot, 'tasks', ctx.workerId);
      const cwd = path.join(logDir, 'workspace');
      return {
        type,
        cwd,
        artifactRoot: cwd,
        logDir,
        repoPath: '',
        baseRef: '',
        branch: '',
      };
    }
  }
}

/** Create whatever the workspace needs (dirs, git worktree). Cleans up on failure. */
export function prepareWorkspace(plan: PlannedWorkspace): void {
  fs.mkdirSync(plan.logDir, { recursive: true, mode: 0o700 });
  switch (plan.type) {
    case 'git_worktree':
      try {
        createWorktree({
          repoRoot: plan.repoPath,
          worktreePath: plan.cwd,
          branch: plan.branch,
          baseRef: plan.baseRef,
        });
      } catch (err) {
        removeWorktree({ repoRoot: plan.repoPath, worktreePath: plan.cwd, branch: plan.branch });
        throw new Error(`failed to create worktree: ${(err as Error).message}`);
      }
      break;
    case 'directory':
      // Must already exist (validated during planning); nothing to create.
      break;
    case 'temporary':
      fs.mkdirSync(plan.cwd, { recursive: true, mode: 0o700 });
      break;
  }
}

/* ------------------------------------------------------------------ *
 * Workflow workspaces: one shared workspace per workflow, so dependent
 * tasks see upstream artifacts and git tasks share one branch.
 * ------------------------------------------------------------------ */

export function planWorkflowWorkspace(
  type: WorkspaceType,
  input: WorkspaceInput,
  workerRoot: string,
  workflowId: string,
): PlannedWorkspace {
  const logDir = safeJoinUnder(workerRoot, 'workflows', workflowId);
  if (type === 'git_worktree') {
    if (!input.repo_path) throw new Error('workspace.repo_path is required for git_worktree workflow');
    const { repoRoot } = validateRepoPath(input.repo_path);
    const baseSha = resolveRef(repoRoot, input.base_ref ?? 'HEAD');
    return {
      type,
      cwd: path.join(logDir, 'worktree'),
      artifactRoot: path.join(logDir, 'worktree'),
      logDir,
      repoPath: repoRoot,
      baseRef: baseSha,
      branch: `kimi-worker/${workflowId}`,
    };
  }
  if (type === 'directory') {
    if (!input.path) throw new Error('workspace.path is required for directory workflow');
    let canonical: string;
    try {
      canonical = canonicalize(input.path);
    } catch {
      throw new Error(`workspace.path does not exist or is not readable: ${input.path}`);
    }
    if (!fs.statSync(canonical).isDirectory()) {
      throw new Error(`workspace.path is not a directory: ${canonical}`);
    }
    if (path.parse(canonical).root === canonical) {
      throw new Error('workspace.path must not be the filesystem root');
    }
    return { type, cwd: canonical, artifactRoot: canonical, logDir, repoPath: '', baseRef: '', branch: '' };
  }
  const cwd = path.join(logDir, 'workspace');
  return { type: 'temporary', cwd, artifactRoot: cwd, logDir, repoPath: '', baseRef: '', branch: '' };
}

export function prepareWorkflowWorkspace(plan: PlannedWorkspace): void {
  prepareWorkspace(plan);
}
