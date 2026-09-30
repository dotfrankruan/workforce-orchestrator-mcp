import crypto from 'node:crypto';

const WORKER_ID_RE = /^wk_[0-9a-f]{8}$/;

/** Generate a short random worker id, e.g. "wk_ab12cd34". */
export function newWorkerId(): string {
  return `wk_${crypto.randomBytes(4).toString('hex')}`;
}

export function isValidWorkerId(id: string): boolean {
  return WORKER_ID_RE.test(id);
}

/** Branch name used for a worker's worktree. */
export function workerBranch(workerId: string): string {
  return `kimi-worker/${workerId}`;
}
