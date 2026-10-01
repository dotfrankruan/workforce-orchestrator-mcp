import type { SpawnTaskParams, WorkflowTaskInput } from './supervisor.js';

/**
 * Built-in workflow presets. Each preset expands a goal into a task DAG
 * (keys + dependencies + roles + modes). Presets are transparent: the full
 * graph is visible via get_workflow before and during execution.
 */

export type PresetTask = WorkflowTaskInput & SpawnTaskParams;

export interface PresetDefinition {
  name: string;
  description: string;
  /** Recommended workspace type for this preset. */
  workspace: 'git_worktree' | 'directory' | 'temporary';
  build(goal: string): PresetTask[];
}

export const WORKFLOW_PRESETS: readonly PresetDefinition[] = [
  {
    name: 'bug_fix',
    description: 'investigate → implement → test → review (sequential; one shared workspace)',
    workspace: 'git_worktree',
    build: (goal) => [
      {
        key: 'investigate',
        mode: 'code',
        role: 'debugger',
        task: `Investigate this bug without fixing it yet: ${goal}\n\nReproduce if possible, isolate the root cause, and write findings to investigation.md.`,
        deliverables: ['investigation.md'],
      },
      {
        key: 'implement',
        mode: 'code',
        role: 'implementer',
        depends_on: ['investigate'],
        task: `Fix the bug: ${goal}\n\nRead investigation.md from the workspace first, then implement the minimal fix. Run relevant tests.`,
      },
      {
        key: 'test',
        mode: 'code',
        role: 'tester',
        depends_on: ['implement'],
        task: `Strengthen tests for the fix of: ${goal}\n\nAdd a regression test that fails without the fix and passes with it. Run the test suite.`,
      },
      {
        key: 'review',
        mode: 'review',
        role: 'reviewer',
        depends_on: ['test'],
        task: `Review the complete change set for: ${goal}\n\nCheck correctness, regressions, concurrency, security, and test coverage. Write review.md with findings by severity.`,
        deliverables: ['review.md'],
        cache_policy: 'read_write',
      },
    ],
  },
  {
    name: 'feature_development',
    description: 'research → implement → test → review → docs (sequential)',
    workspace: 'git_worktree',
    build: (goal) => [
      {
        key: 'research',
        mode: 'research',
        role: 'researcher',
        task: `Research the design space for this feature: ${goal}\n\nInspect the codebase (if present in the workspace) and write findings.md with a recommended approach. Record sources in sources.json.`,
        deliverables: ['findings.md'],
        cache_policy: 'read_write',
      },
      {
        key: 'implement',
        mode: 'code',
        role: 'implementer',
        depends_on: ['research'],
        task: `Implement the feature: ${goal}\n\nFollow findings.md. Run relevant tests.`,
      },
      {
        key: 'test',
        mode: 'code',
        role: 'tester',
        depends_on: ['implement'],
        task: `Add thorough tests for the feature: ${goal}\n\nCover edge cases. Run the full relevant test suite.`,
      },
      {
        key: 'review',
        mode: 'review',
        role: 'reviewer',
        depends_on: ['test'],
        task: `Review the feature implementation: ${goal}\n\nWrite review.md with findings ordered by severity.`,
        deliverables: ['review.md'],
        cache_policy: 'read_write',
      },
      {
        key: 'docs',
        mode: 'docs',
        role: 'docs_writer',
        depends_on: ['review'],
        task: `Write/update documentation for the feature: ${goal}\n\nUpdate README or docs to reflect the new behavior. Address any documentation-relevant findings in review.md.`,
      },
    ],
  },
  {
    name: 'quality_audit',
    description: 'parallel reviews (code/tests/docs) → fixes → verification',
    workspace: 'git_worktree',
    build: (goal) => [
      {
        key: 'review_code',
        mode: 'review',
        role: 'reviewer',
        task: `Audit code quality for: ${goal}\n\nFocus on correctness, security, maintainability. Write review-code.md.`,
        deliverables: ['review-code.md'],
        cache_policy: 'read_write',
      },
      {
        key: 'review_tests',
        mode: 'review',
        role: 'tester',
        task: `Audit test coverage for: ${goal}\n\nIdentify missing/weak tests. Write review-tests.md. Do not change code.`,
        deliverables: ['review-tests.md'],
        cache_policy: 'read_write',
      },
      {
        key: 'review_docs',
        mode: 'review',
        role: 'docs_writer',
        task: `Audit documentation for: ${goal}\n\nCheck accuracy and completeness. Write review-docs.md. Do not change code.`,
        deliverables: ['review-docs.md'],
        cache_policy: 'read_write',
      },
      {
        key: 'fixes',
        mode: 'code',
        role: 'implementer',
        depends_on: ['review_code', 'review_tests', 'review_docs'],
        task: `Address the audit findings for: ${goal}\n\nRead review-code.md, review-tests.md and review-docs.md. Implement the high-severity fixes. Run tests.`,
      },
      {
        key: 'verification',
        mode: 'code',
        role: 'tester',
        depends_on: ['fixes'],
        task: `Verify the fixes for: ${goal}\n\nRun the full test suite and confirm the audit findings are resolved. Write verification.md.`,
        deliverables: ['verification.md'],
      },
    ],
  },
  {
    name: 'research_report',
    description: 'parallel source gathering + independent comparison → synthesis',
    workspace: 'temporary',
    build: (goal) => [
      {
        key: 'gather_sources',
        mode: 'research',
        role: 'researcher',
        task: `Gather and summarize sources for: ${goal}\n\nWrite sources.json (url+title per source) and notes.md.`,
        deliverables: ['sources.json', 'notes.md'],
        cache_policy: 'read_write',
      },
      {
        key: 'independent_comparison',
        mode: 'research',
        role: 'researcher',
        task: `Independently analyze and compare the options for: ${goal}\n\nWrite comparison.md with a comparison table and trade-offs. Record sources in comparison-sources.json.`,
        deliverables: ['comparison.md'],
        cache_policy: 'read_write',
      },
      {
        key: 'synthesis',
        mode: 'research',
        role: 'researcher',
        depends_on: ['gather_sources', 'independent_comparison'],
        task: `Synthesize the final report for: ${goal}\n\nRead notes.md, sources.json and comparison.md from the workspace. Write the final report.md and merge all sources into sources.json.`,
        deliverables: ['report.md', 'sources.json'],
      },
    ],
  },
  {
    name: 'data_analysis',
    description: 'inspect → analyze → validate → report (directory workspace)',
    workspace: 'directory',
    build: (goal) => [
      {
        key: 'inspect',
        mode: 'data',
        role: 'data_analyst',
        task: `Inspect the dataset for: ${goal}\n\nProfile files, schemas, sizes, obvious data-quality issues. Write inspection.md.`,
        deliverables: ['inspection.md'],
        cache_policy: 'read_write',
      },
      {
        key: 'analyze',
        mode: 'data',
        role: 'data_analyst',
        depends_on: ['inspect'],
        task: `Analyze the data for: ${goal}\n\nRead inspection.md first. Keep analysis scripts (e.g. analysis.py) as artifacts and write results.csv.`,
        deliverables: ['results.csv'],
      },
      {
        key: 'validate',
        mode: 'data',
        role: 'data_analyst',
        depends_on: ['analyze'],
        task: `Validate the analysis results for: ${goal}\n\nSanity-check results.csv against the raw data; recompute key numbers independently. Write validation.md.`,
        deliverables: ['validation.md'],
      },
      {
        key: 'report',
        mode: 'data',
        role: 'data_analyst',
        depends_on: ['validate'],
        task: `Write the final analysis report for: ${goal}\n\nCombine inspection.md, results.csv and validation.md into report.md with clear conclusions.`,
        deliverables: ['report.md'],
      },
    ],
  },
] as const;

export function getPreset(name: string): PresetDefinition | null {
  return WORKFLOW_PRESETS.find((p) => p.name === name) ?? null;
}

export function presetNames(): string[] {
  return WORKFLOW_PRESETS.map((p) => p.name);
}
