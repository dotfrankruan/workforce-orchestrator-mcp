import type { WorkerBackend } from './types.js';
import {
  ApiAgentBackend,
  num,
  parseToolArguments,
  str,
  type ApiAgentOptions,
  type ProviderToolCall,
  type ProviderTurn,
  type ProviderUsage,
} from './api-backend.js';
import { AGENT_TOOLS } from './agent-tools.js';

export type OpenAIApiStyle = 'chat_completions' | 'responses';

export interface OpenAIBackendOptions extends ApiAgentOptions {
  /** Wire API. Default: chat_completions. */
  api?: OpenAIApiStyle | undefined;
}

type Json = Record<string, unknown>;

/**
 * Direct OpenAI (or OpenAI-compatible) API backend.
 *
 * No agent runtime is involved: the worker prompt is sent straight to
 * `POST /chat/completions` or `POST /responses`, with a small function-tool
 * loop that reads/writes files and runs commands inside the task workspace.
 */
export class OpenAIBackend extends ApiAgentBackend implements WorkerBackend {
  readonly id = 'openai';
  readonly displayName = 'OpenAI API';
  readonly providerName = 'OpenAI';
  readonly apiStyle: OpenAIApiStyle;

  private messages: Json[] = [];
  private input: Json[] = [];

  constructor(opts: OpenAIBackendOptions) {
    super(opts);
    this.apiStyle = opts.api ?? 'chat_completions';
  }

  metadata() {
    return {
      runtime: { name: 'OpenAI API' },
      provider: { name: 'openai', model: this.opts.model },
    };
  }

  protected begin(prompt: string, _sessionId: string | null): void {
    this.messages = [
      { role: 'system', content: this.basePrompt() },
      { role: 'user', content: prompt },
    ];
    this.input = [{ role: 'user', content: prompt }];
  }

  protected async requestTurn(signal: AbortSignal, model: string): Promise<ProviderTurn> {
    return this.apiStyle === 'responses' ? this.responsesTurn(signal, model) : this.chatTurn(signal, model);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.apiKey !== '') headers['authorization'] = `Bearer ${this.opts.apiKey}`;
    return headers;
  }

  private async chatTurn(signal: AbortSignal, model: string): Promise<ProviderTurn> {
    const body: Json = {
      model,
      messages: this.messages,
      tools: AGENT_TOOLS.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: 'auto',
    };
    if (this.opts.maxOutputTokens) body['max_tokens'] = this.opts.maxOutputTokens;
    if (this.opts.temperature !== undefined) body['temperature'] = this.opts.temperature;

    const data = await this.postJson(this.endpoint('/chat/completions'), this.headers(), body, signal);
    const choices = Array.isArray(data['choices']) ? (data['choices'] as Json[]) : [];
    const message = (choices[0]?.['message'] ?? {}) as Json;
    const rawCalls = Array.isArray(message['tool_calls']) ? (message['tool_calls'] as Json[]) : [];
    const toolCalls: ProviderToolCall[] = rawCalls.map((raw, i) => {
      const fn = (raw['function'] ?? {}) as Json;
      return {
        id: str(raw['id']) || `call_${i}`,
        name: str(fn['name']),
        arguments: parseToolArguments(fn['arguments']),
      };
    });

    const assistant: Json = { role: 'assistant', content: message['content'] ?? null };
    if (rawCalls.length > 0) assistant['tool_calls'] = rawCalls;
    this.messages.push(assistant);

    return {
      text: this.chatText(message['content']),
      toolCalls,
      usage: this.chatUsage(data['usage']),
    };
  }

  private chatText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part === 'object' && part !== null) {
          const p = part as Json;
          if (typeof p['text'] === 'string') return p['text'];
        }
        return '';
      })
      .join('');
  }

  private chatUsage(raw: unknown): ProviderUsage {
    const u = typeof raw === 'object' && raw !== null ? (raw as Json) : {};
    const details = typeof u['prompt_tokens_details'] === 'object' && u['prompt_tokens_details'] !== null
      ? (u['prompt_tokens_details'] as Json)
      : {};
    return {
      inputTokens: num(u['prompt_tokens']),
      outputTokens: num(u['completion_tokens']),
      cacheReadTokens: num(details['cached_tokens']),
      totalTokens: num(u['total_tokens']),
    };
  }

  private responsesToolDefinitions(): Json[] {
    return AGENT_TOOLS.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  private async responsesTurn(signal: AbortSignal, model: string): Promise<ProviderTurn> {
    const body: Json = {
      model: this.opts.model,
      instructions: this.basePrompt(),
      input: this.input,
      tools: this.responsesToolDefinitions(),
    };
    if (this.opts.maxOutputTokens) body['max_output_tokens'] = this.opts.maxOutputTokens;
    if (this.opts.temperature !== undefined) body['temperature'] = this.opts.temperature;

    const data = await this.postJson(this.endpoint('/responses'), this.headers(), body, signal);
    const output = Array.isArray(data['output']) ? (data['output'] as Json[]) : [];

    const textParts: string[] = [];
    const toolCalls: ProviderToolCall[] = [];
    for (const item of output) {
      const type = str(item['type']);
      if (type === 'message') {
        const content = Array.isArray(item['content']) ? (item['content'] as Json[]) : [];
        for (const part of content) {
          if (str(part['type']) === 'output_text' && typeof part['text'] === 'string') {
            textParts.push(part['text']);
          }
        }
      } else if (type === 'function_call') {
        toolCalls.push({
          id: str(item['call_id']) || str(item['id']) || `call_${toolCalls.length}`,
          name: str(item['name']),
          arguments: parseToolArguments(item['arguments']),
        });
      }
    }

    // Preserve message + function_call items as conversation state for the
    // next request. Reasoning items are intentionally not replayed.
    for (const item of output) {
      const type = str(item['type']);
      if (type === 'message' || type === 'function_call') this.input.push(item);
    }

    return { text: textParts.join(''), toolCalls, usage: this.responsesUsage(data['usage']) };
  }

  private responsesUsage(raw: unknown): ProviderUsage {
    const u = typeof raw === 'object' && raw !== null ? (raw as Json) : {};
    const details = typeof u['input_tokens_details'] === 'object' && u['input_tokens_details'] !== null
      ? (u['input_tokens_details'] as Json)
      : {};
    return {
      inputTokens: num(u['input_tokens']),
      outputTokens: num(u['output_tokens']),
      cacheReadTokens: num(details['cached_tokens']),
      totalTokens: num(u['total_tokens']),
    };
  }

  protected addToolResults(calls: ProviderToolCall[], outputs: string[]): void {
    if (this.apiStyle === 'responses') {
      calls.forEach((call, i) => {
        this.input.push({ type: 'function_call_output', call_id: call.id, output: outputs[i] ?? '' });
      });
      return;
    }
    calls.forEach((call, i) => {
      this.messages.push({ role: 'tool', tool_call_id: call.id, content: outputs[i] ?? '' });
    });
  }
}
