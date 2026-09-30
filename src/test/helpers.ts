import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, ensureConfigDirs, type Config } from '../config.js';
import { WorkerStore } from '../db.js';
import { WorkerSupervisor } from '../supervisor.js';
import { FakeBackend, type FakeScenario } from '../backend/fake.js';

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_PAGER: 'cat' },
  });
}

/** Create a temporary git repo with one committed file. Returns its path. */
export function makeTempRepo(): string {
  const dir = makeTempDir('kwm-repo-');
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.name', 'test'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  // Test commits must not depend on the host's GPG agent.
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'initial commit'], dir);
  return dir;
}

export interface TestHarness {
  config: Config;
  store: WorkerStore;
  supervisor: WorkerSupervisor;
  root: string;
  cleanup: () => void;
}

export function makeHarness(
  scenario: (info: { workerId: string; resume: boolean; prompt: string; cwd: string }) => FakeScenario,
  overrides: { maxConcurrent?: number } = {},
): TestHarness {
  const root = makeTempDir('kwm-root-');
  const config = loadConfig({
    env: {
      KIMI_WORKER_MAX_CONCURRENT: String(overrides.maxConcurrent ?? 4),
      KIMI_WORKER_TERMINATE_GRACE_MS: '200',
    },
    workerRoot: root,
  });
  ensureConfigDirs(config);
  const store = new WorkerStore(config.dbPath);
  const backend = new FakeBackend({ scenario });
  const supervisor = new WorkerSupervisor(config, store, backend);
  return {
    config,
    store,
    supervisor,
    root,
    cleanup: () => {
      try {
        store.close();
      } catch {
        /* already closed */
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
