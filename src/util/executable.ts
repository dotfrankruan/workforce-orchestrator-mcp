import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a command name on PATH (no shell). */
export function which(cmd: string): string | null {
  try {
    const out = execFileSync('/usr/bin/which', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return out && isExecutable(out) ? out : null;
  } catch {
    return null;
  }
}

/** Resolve an explicit executable path, or fall back to PATH lookup. */
export function resolveCommand(command: string): string | null {
  if (command.includes('/') || command.includes('\\')) {
    return isExecutable(command) ? command : null;
  }
  return which(command);
}
