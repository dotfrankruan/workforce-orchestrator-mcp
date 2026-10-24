import { execFileSync } from 'node:child_process';

/**
 * Durable process identity. A PID alone is not enough (PIDs are reused), so
 * we pair liveness with the process start token (`ps lstart`) and a command
 * marker (the dsh executable name, or a test marker).
 */

export interface ProcessIdentity {
  /** Raw ps lstart string, e.g. "Tue Sep 30 16:20:01 2026". */
  startToken: string;
  /** Full command line (best-effort; may be truncated by ps). */
  command: string;
}

/** Read the identity of a live process. Returns null if the process is gone. */
export function captureProcessIdentity(pid: number): ProcessIdentity | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!out) return null;
    // lstart is 5 tokens, but BSD/macOS orders them as
    // "Sat 24 Oct 13:40:42 2026" while GNU/Linux uses
    // "Tue Sep 30 16:20:01 2026". Accept both; the rest is the command.
    const m =
      /^(\w{3}\s+(?:\w{3}\s+\d+|\d+\s+\w{3})\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(out);
    if (!m) return null;
    return { startToken: m[1]!, command: m[2] ?? '' };
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Verify a live PID is the worker process we spawned: start token must match
 * exactly (PID-reuse protection) and the command must contain the expected
 * marker (dsh binary basename by default — not a byte-for-byte match, since
 * wrapper scripts/args may vary).
 */
export function isExpectedWorkerProcess(
  pid: number | null,
  storedStartToken: string | null,
  commandMarker: string,
): boolean {
  if (!pid || !pidAlive(pid)) return false;
  const live = captureProcessIdentity(pid);
  if (!live) return false;
  // Start token is the primary identity. If we never recorded one (older
  // rows), fall back to the marker check alone.
  if (storedStartToken && live.startToken !== storedStartToken) return false;
  return live.command.includes(commandMarker);
}
