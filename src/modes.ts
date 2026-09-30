/** Task modes supported by the workforce. */
export const TASK_MODES = [
  'code',
  'research',
  'data',
  'docs',
  'file',
  'ops',
  'review',
  'general',
] as const;

export type TaskMode = (typeof TASK_MODES)[number];

export function isTaskMode(s: string): s is TaskMode {
  return (TASK_MODES as readonly string[]).includes(s);
}

export function parseTaskMode(s: string | undefined): TaskMode | undefined {
  if (s === undefined) return undefined;
  if (!isTaskMode(s)) {
    throw new Error(`invalid mode: ${JSON.stringify(s)} (expected one of ${TASK_MODES.join(', ')})`);
  }
  return s;
}
