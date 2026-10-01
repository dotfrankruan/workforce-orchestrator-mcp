import type { TaskMode } from './modes.js';

/**
 * Role templates. A role is NOT a mode: mode selects the workspace/runtime
 * behavior (code/research/…), the role shapes the worker's stance within it
 * (e.g. mode=code with role=tester vs role=implementer).
 */

export interface RoleTemplate {
  name: string;
  description: string;
  preferredMode: TaskMode;
  /** Injected into the prompt after the mode intro. */
  promptFragment: string;
  defaultDeliverables: string[];
  defaultCapabilities: string[];
}

export const BUILT_IN_ROLES: readonly RoleTemplate[] = [
  {
    name: 'implementer',
    description: 'Implements requested changes, runs tests, leaves a reviewable worktree.',
    preferredMode: 'code',
    promptFragment: `Your role: implementer.
- Implement the requested changes directly and completely.
- Run the relevant tests and debug failures.
- Keep changes focused on the task; leave the working tree in a cleanly reviewable state.`,
    defaultDeliverables: [],
    defaultCapabilities: ['filesystem.read', 'filesystem.write', 'shell', 'git'],
  },
  {
    name: 'tester',
    description: 'Finds missing coverage, writes tests, reproduces failures — without unrelated refactoring.',
    preferredMode: 'code',
    promptFragment: `Your role: tester.
- Focus on test coverage: find untested paths and write tests for them.
- Reproduce reported failures before writing fixes.
- Do NOT refactor production code unless the task explicitly asks for it.`,
    defaultDeliverables: [],
    defaultCapabilities: ['filesystem.read', 'filesystem.write', 'shell'],
  },
  {
    name: 'researcher',
    description: 'Investigates public sources and files; produces reports with recorded sources.',
    preferredMode: 'research',
    promptFragment: `Your role: researcher.
- Gather evidence broadly before synthesizing.
- Record every significant source (URL + title) in sources.json.
- Distinguish verified facts from inference; mark uncertainty explicitly.`,
    defaultDeliverables: ['report.md', 'sources.json'],
    defaultCapabilities: ['web.search', 'web.fetch', 'filesystem.read', 'filesystem.write'],
  },
  {
    name: 'reviewer',
    description: 'Read-only review: correctness, regressions, concurrency, security, maintainability.',
    preferredMode: 'review',
    promptFragment: `Your role: reviewer.
- Read-only intent: do not modify the code under review (unless the task explicitly says "review and fix").
- Look for correctness bugs, regressions, concurrency issues, security problems, API design flaws, and test gaps.
- Order findings by severity, each with file/line references, saved as a review file.`,
    defaultDeliverables: ['review.md'],
    defaultCapabilities: ['filesystem.read', 'shell', 'git'],
  },
  {
    name: 'docs_writer',
    description: 'Documentation only; avoids code changes unless explicitly needed.',
    preferredMode: 'docs',
    promptFragment: `Your role: docs writer.
- Produce or improve documentation only; avoid changing code unless the task explicitly requires it.
- Match the existing documentation style and terminology.`,
    defaultDeliverables: [],
    defaultCapabilities: ['filesystem.read', 'filesystem.write', 'shell'],
  },
  {
    name: 'data_analyst',
    description: 'Analyzes structured datasets; inputs read-only, results as files.',
    preferredMode: 'data',
    promptFragment: `Your role: data analyst.
- Treat input datasets as read-only; write all outputs to new files.
- Show your method in a script artifact when analysis is non-trivial.
- Summarize results; never dump large tables into the final response.`,
    defaultDeliverables: ['analysis.md'],
    defaultCapabilities: ['filesystem.read', 'filesystem.write', 'shell'],
  },
  {
    name: 'debugger',
    description: 'Reproduces issues, isolates root causes, applies minimal fixes with regression tests.',
    preferredMode: 'code',
    promptFragment: `Your role: debugger.
- First reproduce the problem; document the repro steps.
- Isolate the root cause before changing anything.
- Apply the minimal fix; add a regression test proving the bug is fixed.`,
    defaultDeliverables: [],
    defaultCapabilities: ['filesystem.read', 'filesystem.write', 'shell', 'git'],
  },
  {
    name: 'ops_analyst',
    description: 'Diagnoses operational issues; produces proposals, never destructive changes.',
    preferredMode: 'ops',
    promptFragment: `Your role: ops analyst.
- Diagnose and propose; do not mutate system state.
- Deliverables are proposals: reports, patches, scripts for a human to review and run.`,
    defaultDeliverables: ['report.md'],
    defaultCapabilities: ['filesystem.read', 'shell'],
  },
] as const;

export function getRole(name: string): RoleTemplate | null {
  return BUILT_IN_ROLES.find((r) => r.name === name) ?? null;
}

export function roleNames(): string[] {
  return BUILT_IN_ROLES.map((r) => r.name);
}
