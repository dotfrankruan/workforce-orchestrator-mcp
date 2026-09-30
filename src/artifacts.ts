import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeJoinUnder } from './util/paths.js';

/**
 * Artifact system: files produced inside a task workspace, indexed with
 * metadata (size, sha256, mime) so the planner can list them cheaply and
 * fetch content only on explicit request.
 */

const MIME_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.py': 'text/x-python',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java-source',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.sh': 'text/x-shellscript',
  '.sql': 'application/sql',
  '.db': 'application/x-sqlite3',
  '.sqlite': 'application/x-sqlite3',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.patch': 'text/x-diff',
  '.diff': 'text/x-diff',
};

export function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/**
 * Validate a caller-supplied artifact/deliverable path: must be relative,
 * inside the workspace, no traversal, no NUL.
 */
export function validateRelativePath(p: string): string {
  if (p.trim() === '') throw new Error('path must not be empty');
  if (p.includes('\0')) throw new Error('path contains NUL byte');
  if (path.isAbsolute(p)) throw new Error(`path must be relative, got: ${p}`);
  const normalized = path.normalize(p);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return normalized;
}

/** Resolve a validated relative path under root (symlink-safe at resolution time). */
export function resolveUnderRoot(root: string, relative: string): string {
  return safeJoinUnder(root, relative);
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg']);
const MAX_ARTIFACTS = 500;
const MAX_INDEX_FILE_BYTES = 256 * 1024 * 1024; // skip hashing/indexing beyond this

export interface CollectedFile {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
}

/** Recursively list candidate artifact files under root. */
export function walkArtifacts(
  root: string,
  opts: { minMtimeMs?: number | undefined; onlyPaths?: string[] | undefined } = {},
): CollectedFile[] {
  const out: CollectedFile[] = [];

  if (opts.onlyPaths) {
    for (const rel of opts.onlyPaths) {
      try {
        const abs = resolveUnderRoot(root, rel);
        const st = fs.statSync(abs);
        if (st.isFile() && st.size <= MAX_INDEX_FILE_BYTES) {
          out.push({ relativePath: toPosix(rel), absolutePath: abs, sizeBytes: st.size });
        }
      } catch {
        /* missing or invalid — skip */
      }
      if (out.length >= MAX_ARTIFACTS) break;
    }
    return out;
  }

  const walk = (dir: string) => {
    if (out.length >= MAX_ARTIFACTS) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_ARTIFACTS) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(abs);
          if (st.size > MAX_INDEX_FILE_BYTES) continue;
          if (opts.minMtimeMs !== undefined && st.mtimeMs < opts.minMtimeMs) continue;
          out.push({
            relativePath: toPosix(path.relative(root, abs)),
            absolutePath: abs,
            sizeBytes: st.size,
          });
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  };
  walk(root);
  return out;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function isProbablyBinary(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).includes(0);
  } catch {
    return true;
  }
}
