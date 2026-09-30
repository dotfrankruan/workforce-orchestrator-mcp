/** Prompt construction for dsh worker sessions.
 *
 * Backward-compatible facade: the code-mode prompt and the continue /
 * commit-reminder prompts live here; the full per-mode prompt system is in
 * ./prompts/.
 */

import type { PromptContext } from './prompts/index.js';
import { codePrompt } from './prompts/code.js';

const DEFAULT_WORKSPACE_DESC = 'Workspace: an isolated git worktree dedicated to this task.';

export function buildWorkerPrompt(task: string): string {
  const ctx: PromptContext = {
    task,
    deliverables: [],
    capabilities: [],
    workspaceDescription: DEFAULT_WORKSPACE_DESC,
  };
  return codePrompt(ctx);
}

export function buildContinuePrompt(instruction: string): string {
  return `The supervising planner reviewed your work and requests changes.

Follow-up instruction:

<INSTRUCTION>
${instruction}
</INSTRUCTION>

Apply the requested changes in this same workspace, verify your work (run relevant tests when applicable), and persist deliverables as files. Do NOT create git commits — the supervising process verifies and commits changes after you finish. Finish with an updated concise final report (summary, artifacts/changed files, verification results, implementation decisions, reviewer attention areas, known issues, and an optional one-line suggested_commit_message).`;
}
