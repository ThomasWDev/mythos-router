// ─────────────────────────────────────────────────────────────
//  mythos-router :: providers/anthropic.ts
//  Anthropic SDK provider — wraps Claude into BaseProvider
//
//  This is the reference implementation. All future providers
//  (OpenAI, DeepSeek) must conform to the same contract.
// ─────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';
import {
  type BaseProvider,
  type Message,
  type StreamOptions,
  type SendOptions,
  type UnifiedResponse,
  type ProviderCapability,
  type RequestOptions,
} from './types.js';
import { toAnthropicTool, extractAnthropicToolCalls } from './tools.js';
import { normalizeMessages } from './messages.js';
import { normalizeProviderError } from './errors.js';
import { MODELS, CAPYBARA_SYSTEM_PROMPT } from '../config.js';

// ── SDK delta types (not exported by Anthropic SDK) ──────────
interface ThinkingDelta {
  type: 'thinking_delta';
  thinking: string;
}

interface TextDelta {
  type: 'text_delta';
  text: string;
}

type ContentDelta = ThinkingDelta | TextDelta;

// ── Anthropic Provider ───────────────────────────────────────
export class AnthropicProvider implements BaseProvider {
  readonly id = 'anthropic';
  readonly capabilities: ReadonlySet<ProviderCapability> = new Set([
    'thinking',
    'streaming',
    'tools',
  ]);

  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  // ── Build the optional tools request fragment ────────────
  // Returns {} unless the caller passed tools, so default (text FILE_ACTION)
  // requests are byte-for-byte unchanged.
  private toolRequest(options: RequestOptions): Record<string, unknown> {
    if (!options.tools || options.tools.length === 0) return {};
    const tools = options.tools.map(toAnthropicTool);
    const tc = options.toolChoice;
    let tool_choice: Record<string, unknown> | undefined;
    if (tc === 'required') tool_choice = { type: 'any' };
    else if (tc && typeof tc === 'object') tool_choice = { type: 'tool', name: tc.name };
    else if (tc === 'auto') tool_choice = { type: 'auto' };
    return tool_choice ? { tools, tool_choice } : { tools };
  }

  // ── Provider-neutral history → Anthropic Messages API ─────
  private buildMessages(messages: Message[]): Anthropic.MessageParam[] {
    return normalizeMessages(messages).map((message) => {
      if (typeof message.content === 'string') {
        return { role: message.role, content: message.content };
      }

      const content = message.content.map((block) => {
        if (block.type === 'text') {
          return { type: 'text' as const, text: block.text };
        }
        if (block.type === 'tool_call') {
          return {
            type: 'tool_use' as const,
            id: block.id,
            name: block.name,
            input: block.args,
          };
        }
        return {
          type: 'tool_result' as const,
          tool_use_id: block.toolCallId,
          content: block.content,
          ...(block.isError !== undefined ? { is_error: block.isError } : {}),
        };
      });

      return { role: message.role, content } as Anthropic.MessageParam;
    });
  }

  // ── Resolve model from effort level ──────────────────────
  private resolveModel(effort?: string): string {
    if (effort && effort in MODELS) return MODELS[effort];
    return MODELS.high;
  }

  // ── Extended-thinking budget from effort level ───────────
  // The real Anthropic Messages API expects
  //   thinking: { type: 'enabled', budget_tokens: N }
  // where budget_tokens is >= 1024 and STRICTLY less than max_tokens
  // (the thinking budget is drawn from the max_tokens pool).
  // 'low' effort — and any case without enough headroom for both a
  // minimal think and a minimal answer — disables extended thinking.
  private resolveThinking(
    effort: string,
    maxTokens: number,
  ): { type: 'enabled'; budget_tokens: number } | undefined {
    const target = effort === 'high' ? 10_000 : effort === 'medium' ? 4_000 : 0;
    if (target <= 0) return undefined;

    // Reserve at least 1024 tokens for the actual answer.
    const budget = Math.min(target, maxTokens - 1024);
    if (budget < 1024) return undefined;

    return { type: 'enabled', budget_tokens: budget };
  }

  // ── Streaming Message ────────────────────────────────────
  async streamMessage(
    messages: Message[],
    options: StreamOptions,
  ): Promise<UnifiedResponse> {
    const apiMessages = this.buildMessages(messages);
    const effort = options.effort ?? 'high';
    const model = this.resolveModel(effort);
    const maxTokens = options.maxTokens ?? 16384;
    const systemPrompt = options.systemPrompt || CAPYBARA_SYSTEM_PROMPT;
    const startTime = Date.now();

    let thinkingText = '';
    let responseText = '';
    let inputTokens = 0;
    let outputTokens = 0;

    let stream;
    try {
      const supportsThinking = model.includes('opus') || model.includes('sonnet');
      const thinking = supportsThinking ? this.resolveThinking(effort, maxTokens) : undefined;
      stream = await this.client.messages.stream({
        model,
        max_tokens: maxTokens,
        ...(thinking ? { thinking } : {}),
        ...this.toolRequest(options),
        system: systemPrompt,
        messages: apiMessages,
      }, { signal: options.signal });
    } catch (error) {
      throw normalizeProviderError(error, {
        providerId: this.id,
        operation: 'failed to start stream',
        signal: options.signal,
      });
    }

    try {
      for await (const event of stream) {
        // Check abort signal
        if (options.signal?.aborted) {
          throw new Error('Stream aborted by signal');
        }

        if (event.type === 'content_block_delta') {
          const delta = event.delta as ContentDelta;

          if (delta.type === 'thinking_delta') {
            thinkingText += delta.thinking;
            options.onThinkingDelta?.(delta.thinking);
          } else if (delta.type === 'text_delta') {
            responseText += delta.text;
            options.onTextDelta?.(delta.text);
          }
        }
      }
    } catch (err) {
      // If aborted, return partial result
      if (options.signal?.aborted) {
        return {
          thinking: thinkingText,
          text: responseText,
          toolCalls: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: Date.now() - startTime,
          },
          metadata: {
            providerId: this.id,
            modelId: model,
            fallbackTriggered: false,
            incomplete: true,
          },
        };
      }
      throw normalizeProviderError(err, {
        providerId: this.id,
        operation: 'stream interrupted',
        signal: options.signal,
      });
    }

    let finalMessage: Awaited<ReturnType<typeof stream.finalMessage>>;
    try {
      finalMessage = await stream.finalMessage();
    } catch (error) {
      throw normalizeProviderError(error, {
        providerId: this.id,
        operation: 'failed to finalize stream',
        signal: options.signal,
      });
    }
    inputTokens = finalMessage.usage?.input_tokens ?? 0;
    outputTokens = finalMessage.usage?.output_tokens ?? 0;
    const toolCalls = extractAnthropicToolCalls(finalMessage.content as never);

    return {
      thinking: thinkingText,
      text: responseText,
      toolCalls,
      usage: {
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - startTime,
      },
      metadata: {
        providerId: this.id,
        modelId: model,
        fallbackTriggered: false,
        // No text, no reasoning, and no tool call is an unusable success.
        incomplete:
          responseText.trim().length === 0 &&
          thinkingText.trim().length === 0 &&
          toolCalls.length === 0,
      },
    };
  }

  // ── Non-Streaming Message ────────────────────────────────
  async sendMessage(
    messages: Message[],
    options: SendOptions,
  ): Promise<UnifiedResponse> {
    const apiMessages = this.buildMessages(messages);
    const effort = options.effort ?? 'low';
    const model = this.resolveModel(effort);
    const maxTokens = options.maxTokens ?? 8192;
    const systemPrompt = options.systemPrompt || CAPYBARA_SYSTEM_PROMPT;
    const startTime = Date.now();

    let response;
    try {
      const supportsThinking = model.includes('opus') || model.includes('sonnet');
      const thinking = supportsThinking ? this.resolveThinking(effort, maxTokens) : undefined;
      response = await this.client.messages.create({
        model,
        max_tokens: maxTokens,
        ...(thinking ? { thinking } : {}),
        ...this.toolRequest(options),
        system: systemPrompt,
        messages: apiMessages,
      }, { signal: options.signal });
    } catch (error) {
      throw normalizeProviderError(error, {
        providerId: this.id,
        operation: 'API request failed',
        signal: options.signal,
      });
    }

    let thinkingText = '';
    let responseText = '';

    for (const block of response.content) {
      if (block.type === 'thinking') {
        thinkingText += block.thinking ?? '';
      } else if (block.type === 'text') {
        responseText += block.text;
      }
    }
    const toolCalls = extractAnthropicToolCalls(response.content as never);

    return {
      thinking: thinkingText,
      text: responseText,
      toolCalls,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        latencyMs: Date.now() - startTime,
      },
      metadata: {
        providerId: this.id,
        modelId: model,
        fallbackTriggered: false,
        incomplete:
          responseText.trim().length === 0 &&
          thinkingText.trim().length === 0 &&
          toolCalls.length === 0,
      },
    };
  }
}
