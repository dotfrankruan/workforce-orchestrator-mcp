import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Single source of truth for the release/package version.
 *
 * Read from package.json at runtime (dist/version.js → ../package.json) so the
 * MCP server identity, CLI and docs can never drift from the released tag.
 */
let cached: string | null = null;

export function packageVersion(): string {
  if (cached !== null) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../package.json', '../../package.json']) {
    const candidate = path.resolve(here, rel);
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof raw.version === 'string' && raw.version.trim() !== '') {
        cached = raw.version.trim();
        return cached;
      }
    } catch {
      // try the next candidate
    }
  }
  cached = 'unknown';
  return cached;
}
