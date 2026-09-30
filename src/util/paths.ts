import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Resolve a path to its canonical absolute form (symlinks resolved). */
export function canonicalize(p: string): string {
  const abs = path.resolve(p);
  return fs.realpathSync(abs);
}

/**
 * Join path segments under root and guarantee the result stays inside root.
 * Protects against path traversal in any caller-influenced path component.
 */
export function safeJoinUnder(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const joined = path.resolve(resolvedRoot, ...segments);
  if (joined !== resolvedRoot && !joined.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path escapes worker root: ${segments.join('/')}`);
  }
  for (const seg of segments) {
    if (seg.includes('\0')) throw new Error('NUL byte in path segment');
  }
  return joined;
}

/**
 * Stable directory slug for a repo: <basename>-<hash(canonical path)>.
 * Lets multiple repos with the same basename coexist under the worker root.
 */
export function repoSlug(canonicalRepoRoot: string): string {
  const base = path.basename(canonicalRepoRoot).replace(/[^A-Za-z0-9._-]/g, '_') || 'repo';
  const hash = crypto.createHash('sha1').update(canonicalRepoRoot).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

/** Check whether a pid appears to be alive (and owned/observable by us). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we cannot signal it.
    return code === 'EPERM';
  }
}
