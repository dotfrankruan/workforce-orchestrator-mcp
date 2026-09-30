import type { TaskMode } from '../modes.js';
import type { PromptContext } from './base.js';
import { codePrompt } from './code.js';
import {
  researchPrompt,
  dataPrompt,
  docsPrompt,
  filePrompt,
  opsPrompt,
  reviewPrompt,
  generalPrompt,
} from './modes.js';

export type { PromptContext } from './base.js';

export function buildModePrompt(mode: TaskMode, ctx: PromptContext): string {
  switch (mode) {
    case 'code':
      return codePrompt(ctx);
    case 'research':
      return researchPrompt(ctx);
    case 'data':
      return dataPrompt(ctx);
    case 'docs':
      return docsPrompt(ctx);
    case 'file':
      return filePrompt(ctx);
    case 'ops':
      return opsPrompt(ctx);
    case 'review':
      return reviewPrompt(ctx);
    case 'general':
      return generalPrompt(ctx);
  }
}
