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

export interface AnthropicBackendOptions extends ApiAgentOptions {
  /** Anthropic API version header. Default: 2023-06-01. */
  apiVersion?: string | undefined;
}

type Json = Record<string, unknown>;

/**
 * Direct Anthropic Messages API backend.
 *
 * The worker prompt is sent straight to `POST /v1/messages` with a small
 * function-tool loop that reads/writes files and runs commands inside the
 * task workspace. No agent runtime is involved.
 */
export class AnthropicBackend extends ApiAgentBackend implements WorkerBackend {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic API';
  readonly providerName = 'Anthropic';

  private messages: Json[] = [];
  private readonly apiVersion: string;

  constructor(opts: AnthropicBackendOptions) {
    super(opts);
    this.apiVersion = opts.apiVersion ?? '2023-06-01';
  }

  metadata() {
    return {
      runtime: { name: 'Anthropic API' },
      provider: { name: 'anthropic', model: this.opts.model },
    };
  }

  protected begin(prompt: string, _sessionId: string | null): void {
    this.messages = [{ role: 'user', content: prompt }];
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': this.apiVersion,
    };
    if (this.opts.apiKey !== '') headers['x-api-key'] = this.opts.apiKey;
    return headers;
  }

  protected async requestTurn(signal: AbortSignal): Promise<ProviderTurn> {
    const body: Json = {
      model: this.opts.model,
      max_tokens: this.opts.maxOutputTokens ?? 8192,
      system: this.basePrompt(),
      messages: this.messages,
      tools: AGENT_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
    };
    if (this.opts.temperature !== undefined) body['temperature'] = this.opts.temperature;

    const url = this.opts.baseUrl.replace(/\/+$/, '').endsWith('/v1')
      ? this.endpoint('/messages')
      : this.endpoint('/v1/messages');
    const data = await this.postJson(url, this.headers(), body, signal);

    const content = Array.isArray(data['content']) ? (data['content'] as Json[]) : [];
    const textParts: string[] = [];
    const toolCalls: ProviderToolCall[] = [];
    const assistantBlocks: Json[] = [];
    for (const block of content) {
      const type = str(block['type']);
      if (type === 'text') {
        const text = str(block['text']);
        textParts.push(text);
        assistantBlocks.push({ type: 'text', text });
      } else if (type === 'tool_use') {
        const id = str(block['id']) || `call_${toolCalls.length}`;
        const name = str(block['name']);
        toolCalls.push({
          id,
          name,
          arguments: parseToolArguments(block['input']),
        });
        assistantBlocks.push({ type: 'tool_use', id, name, input: block['input'] ?? {} });
      }
    }
    this.messages.push({ role: 'assistant', content: assistantBlocks });

    return { text: textParts.join(''), toolCalls, usage: this.usage(data['usage']) };
  }

  private usage(raw: unknown): ProviderUsage {
    const u = typeof raw === 'object' && raw !== null ? (raw as Json) : {};
    const input = num(u['input_tokens']);
    const output = num(u['output_tokens']);
    return {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: num(u['cache_read_input_tokens']),
      totalTokens: input !== undefined && output !== undefined ? input + output : undefined,
    };
  }

  protected addToolResults(calls: ProviderToolCall[], outputs: string[]): void {
    this.messages.push({
      role: 'user',
      content: calls.map((call, i) => ({
        type: 'tool_result',
        tool_use_id: call.id,
        content: outputs[i] ?? '',
      })),
    });
  }
}
