/** Shared building blocks for worker prompts. */

export interface PromptContext {
  task: string;
  deliverables: string[];
  capabilities: string[];
  workspaceDescription: string;
  subagentsNote?: string | undefined;
}

/** Shared rules injected into every worker prompt (no task text). */
export function rulesBlock(ctx: PromptContext): string {
  const parts: string[] = [];
  parts.push(`General rules:
- Do the execution work yourself; prefer tools and concrete actions over lengthy explanations.
- Keep large logs local — do not paste long command output into your final response.
- Do not return chain-of-thought.
- Do not dump full source files unless explicitly required.
- Store substantial deliverables as files in the workspace.
- Your final response should be concise because the supervising planner will inspect artifacts separately.

${ctx.workspaceDescription}

- Do not modify files outside the workspace described above.
- Do not expose secrets. Never print the contents of credential files or environment variables containing API keys.`);

  if (ctx.capabilities.length > 0) {
    parts.push(`Intended capabilities for this task (advisory — stay within them):
${ctx.capabilities.map((c) => `- ${c}`).join('\n')}`);
  }

  if (ctx.subagentsNote) {
    parts.push(ctx.subagentsNote);
  }

  if (ctx.deliverables.length > 0) {
    parts.push(`You must produce the following deliverables as real files in the workspace (the planner will verify they exist on disk):
${ctx.deliverables.map((d) => `- ${d}`).join('\n')}`);
  }

  return parts.join('\n\n');
}

export function taskBlock(task: string): string {
  return `Assigned task:

<TASK>
${task}
</TASK>`;
}

export const FINAL_REPORT_GUIDE = `When finished, provide a concise final report containing:
- Summary (bullet points)
- Artifacts produced (file paths relative to the workspace)
- What was done and key decisions
- Reviewer attention areas
- Known issues`;
