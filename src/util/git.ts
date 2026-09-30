import { execFileSync } from 'node:child_process';

export interface GitResult {
  stdout: string;
}

/** Run git with an argv array (never a shell string). Throws on non-zero exit. */
export function runGit(args: string[], cwd: string): string {
  const out = execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat' },
  });
  return out;
}

/** Run git, returning null instead of throwing on failure. */
export function tryGit(args: string[], cwd: string): string | null {
  try {
    return runGit(args, cwd);
  } catch {
    return null;
  }
}
