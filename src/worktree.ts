import { runGit, tryGit } from './util/git.js';
import { canonicalize } from './util/paths.js';

export interface RepoInfo {
  /** Canonical path the user pointed at (inside the repo). */
  canonicalPath: string;
  /** Canonical path of the repository top level. */
  repoRoot: string;
}

/**
 * Validate that `p` is inside a git working tree. Returns canonical paths.
 * Throws a descriptive error otherwise.
 */
export function validateRepoPath(p: string): RepoInfo {
  let canonicalPath: string;
  try {
    canonicalPath = canonicalize(p);
  } catch {
    throw new Error(`repo_path does not exist or is not readable: ${p}`);
  }
  const repoRoot = tryGit(['rev-parse', '--show-toplevel'], canonicalPath);
  if (!repoRoot) {
    throw new Error(`repo_path is not inside a git repository: ${canonicalPath}`);
  }
  return { canonicalPath, repoRoot: repoRoot.trim() };
}

/** Resolve a ref to a commit sha within a repo. Throws if unresolvable. */
export function resolveRef(repoPath: string, ref: string): string {
  const out = tryGit(['rev-parse', '--verify', `${ref}^{commit}`], repoPath);
  if (!out) throw new Error(`Cannot resolve git ref: ${ref}`);
  return out.trim();
}

export interface WorktreeSpec {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
}

/** Create a new branch + worktree. Never touches the main working tree. */
export function createWorktree(spec: WorktreeSpec): void {
  runGit(['worktree', 'add', '-b', spec.branch, spec.worktreePath, spec.baseRef], spec.repoRoot);
}

/** Remove a worktree (best effort; used only when spawn setup fails). */
export function removeWorktree(spec: Pick<WorktreeSpec, 'repoRoot' | 'worktreePath' | 'branch'>): void {
  tryGit(['worktree', 'remove', '--force', spec.worktreePath], spec.repoRoot);
  tryGit(['branch', '-D', spec.branch], spec.repoRoot);
}

/** porcelain status of the worktree (empty string = clean). */
export function statusPorcelain(worktreePath: string): string {
  return tryGit(['status', '--porcelain'], worktreePath)?.trim() ?? '';
}

export function currentHead(worktreePath: string): string | null {
  return tryGit(['rev-parse', 'HEAD'], worktreePath)?.trim() ?? null;
}

/** Files changed between baseRef and HEAD (committed changes only). */
export function changedFilesCommitted(worktreePath: string, baseRef: string): string[] {
  const out = tryGit(['diff', '--name-only', `${baseRef}...HEAD`], worktreePath);
  if (!out) return [];
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Untracked + modified-but-uncommitted paths in the worktree. */
export function uncommittedPaths(worktreePath: string): string[] {
  const out = tryGit(['status', '--porcelain'], worktreePath);
  if (!out) return [];
  return out
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

export function diffStat(worktreePath: string, baseRef: string, path?: string): string {
  const args = ['diff', '--stat', `${baseRef}...HEAD`];
  if (path) args.push('--', path);
  return tryGit(args, worktreePath) ?? '';
}

export function diffFull(worktreePath: string, baseRef: string, path?: string): string {
  // Prefer committed diff; if nothing committed yet, fall back to working-tree diff vs base.
  const committed = tryGit(['diff', `${baseRef}...HEAD`, ...(path ? ['--', path] : [])], worktreePath);
  if (committed && committed.trim() !== '') return committed;
  const worktreeDiff = tryGit(['diff', baseRef, ...(path ? ['--', path] : [])], worktreePath);
  return worktreeDiff ?? '';
}

export function lastCommit(worktreePath: string): { hash: string; subject: string } | null {
  const out = tryGit(['log', '-1', '--format=%H%x00%s'], worktreePath);
  if (!out) return null;
  const [hash, subject] = out.trim().split('\0');
  if (!hash) return null;
  return { hash, subject: subject ?? '' };
}

/* ------------------------------------------------------------------ *
 * Supervisor-owned git finalization.
 *
 * Git worktree metadata lives in the ORIGINAL repo's .git/worktrees/…,
 * which is outside the worker's writable sandbox — so workers cannot
 * reliably commit. The supervisor (host Node process) owns a small,
 * fixed set of git mutations: status/diff/add/commit/rev-parse/log/
 * cherry-pick/worktree/branch. Never push/merge/reset/clean/rebase.
 * ------------------------------------------------------------------ */

export function currentBranch(worktreePath: string): string | null {
  return tryGit(['branch', '--show-current'], worktreePath)?.trim() || null;
}

/** Number of commits in baseRef..HEAD. */
export function commitsAhead(worktreePath: string, baseRef: string): number {
  const out = tryGit(['rev-list', '--count', `${baseRef}..HEAD`], worktreePath);
  const n = Number(out?.trim());
  return Number.isFinite(n) ? n : 0;
}

function hasIdentity(worktreePath: string): boolean {
  const name = tryGit(['config', 'user.name'], worktreePath)?.trim();
  const email = tryGit(['config', 'user.email'], worktreePath)?.trim();
  return Boolean(name && email);
}

export interface SupervisorCommitResult {
  ok: boolean;
  error?: string;
}

/**
 * Stage everything in the worktree and commit it (argv arrays only).
 *
 * Identity policy: respect existing git config; only when user.name/email
 * are missing, use per-command -c fallback (never touches global config).
 * Signing: attempt the commit as configured; if it fails, retry once with
 * commit.gpgsign=false (gpg agents are often unavailable to sandboxes).
 */
export function supervisorCommitAll(worktreePath: string, message: string): SupervisorCommitResult {
  try {
    runGit(['add', '-A'], worktreePath);
  } catch (err) {
    return { ok: false, error: `git add failed: ${(err as Error).message}` };
  }

  const identityArgs = hasIdentity(worktreePath)
    ? []
    : ['-c', 'user.name=Workforce Orchestrator', '-c', 'user.email=workforce@localhost'];

  try {
    runGit([...identityArgs, 'commit', '-m', message], worktreePath);
    return { ok: true };
  } catch (first) {
    try {
      runGit([...identityArgs, '-c', 'commit.gpgsign=false', 'commit', '-m', message], worktreePath);
      return { ok: true };
    } catch (second) {
      return { ok: false, error: (second as Error).message || (first as Error).message };
    }
  }
}

/* ------------------------------------------------------------------ *
 * Workflow integration ops (supervisor-only, serialized per workflow).
 * ------------------------------------------------------------------ */

/** Commit shas in `from..HEAD`, oldest first. */
export function revListRange(worktreePath: string, from: string): string[] {
  const out = tryGit(['rev-list', '--reverse', `${from}..HEAD`], worktreePath);
  if (!out) return [];
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

export interface CherryPickResult {
  ok: boolean;
  /** Conflicted paths when the pick failed due to conflicts. */
  conflictFiles: string[];
  error?: string;
}

/**
 * Cherry-pick ONE validated commit into the integration worktree.
 * On conflict: capture conflicted paths, immediately `cherry-pick --abort`
 * (integration branch returns to its pre-pick clean state), then report.
 * Never auto-resolves with --ours/--theirs.
 */
export function cherryPickCommit(worktreePath: string, sha: string): CherryPickResult {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    return { ok: false, conflictFiles: [], error: `invalid commit sha: ${sha}` };
  }
  try {
    runGit(['cherry-pick', sha], worktreePath);
    return { ok: true, conflictFiles: [] };
  } catch (err) {
    const conflictFiles = (tryGit(['diff', '--name-only', '--diff-filter=U'], worktreePath) ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    // Always abort back to the pre-pick clean state.
    tryGit(['cherry-pick', '--abort'], worktreePath);
    return {
      ok: false,
      conflictFiles,
      error: (err as Error).message.slice(0, 500),
    };
  }
}

/** Create a task worktree+branch rooted at an explicit commit sha. */
export function createWorktreeAtCommit(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  commitSha: string,
): void {
  runGit(['worktree', 'add', '-b', branch, worktreePath, commitSha], repoRoot);
}
