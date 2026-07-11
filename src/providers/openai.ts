import { createHash } from 'node:crypto';
import {
  type BaseProvider,
  type Message,
  type StreamOptions,
  type SendOptions,
  type UnifiedResponse,
  type ProviderCapability,
  type UnifiedToolCall,
  type ProviderTelemetryIdentity,
  ProviderError,
  kindFromStatus,
} from './types.js';
import {
  toOpenAITool,
  toOpenAIToolChoice,
  extractOpenAIToolCalls,
  OpenAIToolCallAccumulator,
} from './tools.js';
import { normalizeProviderError } from './errors.js';
import { messagesCharLength, normalizeMessages } from './messages.js';

// ── Provider Configuration ───────────────────────────────────
export interface OpenAIProviderConfig {
  id: string;                // e.g. 'openai', 'deepseek', 'grok'
  apiKey: string;
  baseUrl: string;           // e.g. 'https://api.openai.com/v1'
  defaultModel: string;      // e.g. 'gpt-4o', 'deepseek-chat'
  supportsThinking?: boolean; // DeepSeek reasoner, o1/o3 have reasoning
  /**
   * Whether to send `stream_options: { include_usage: true }` on streaming
   * requests. OpenAI and DeepSeek support it (so we get real token counts),
   * but some OpenAI-compatible servers reject unknown fields. Defaults to true.
   */
  includeUsageStreamOption?: boolean;
  /**
   * Reasoning models (OpenAI o1/o3/o4 family) require `max_completion_tokens`
   * instead of `max_tokens` and reject the `system` role. Auto-detected from
   * the model name when omitted; set explicitly to override detection.
   */
  reasoningModel?: boolean;
}

// OpenAI reasoning models (o1, o3, o4-mini, …) use a different request shape
// than chat models: they require `max_completion_tokens` instead of
// `max_tokens` and do not accept the `system` role. Detect them by the
// canonical "o<digit>" model-name prefix.
function detectReasoningModel(model: string): boolean {
  return /^o[0-9]/i.test(model);
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

function parseSSELine(line: string): Record<string, unknown> | null {
  if (!line.startsWith('data: ')) return null;
  const data = line.slice(6).trim();
  if (data === '[DONE]') return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// ── OpenAI-Compatible Provider ───────────────────────────────
export class OpenAIProvider implements BaseProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<ProviderCapability>;
  readonly telemetryIdentity: ProviderTelemetryIdentity;

  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  private supportsThinking: boolean;
  private reasoningModel: boolean;
  private includeUsage: boolean;

  constructor(config: OpenAIProviderConfig) {
    this.id = config.id;
    this.apiKey = config.apiKey;
    this.baseUrl = stripTrailingSlashes(config.baseUrl);
    this.defaultModel = config.defaultModel;
    this.telemetryIdentity = {
      modelId: config.defaultModel,
      endpointHash: createHash('sha256').update(this.baseUrl).digest('hex').slice(0, 16),
    };
    this.supportsThinking = config.supportsThinking ?? false;
    this.reasoningModel = config.reasoningModel ?? detectReasoningModel(config.defaultModel);
    this.includeUsage = config.includeUsageStreamOption ?? true;

    const caps: ProviderCapability[] = ['streaming', 'tools'];
    if (this.supportsThinking) caps.push('thinking');
    this.capabilities = new Set(caps);
  }

  // ── Request Construction ─────────────────────────────────
  // Reasoning models reject the `system` role; the documented replacement is
  // the `developer` role. Chat models keep `system`. The system prompt is only
  // added when present.
  private buildChatMessages(
    messages: Message[],
    systemPrompt?: string,
  ): Array<Record<string, unknown>> {
    const turns: Array<Record<string, unknown>> = [];

    for (const message of normalizeMessages(messages)) {
      if (typeof message.content === 'string') {
        turns.push({ role: message.role, content: message.content });
        continue;
      }

      if (message.role === 'assistant') {
        const text = message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.type === 'text' ? block.text : '')
          .join('');
        const toolCalls = message.content
          .filter((block) => block.type === 'tool_call')
          .map((block) => {
            if (block.type !== 'tool_call') throw new Error('unreachable');
            return {
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.args),
              },
            };
          });

        turns.push({
          role: 'assistant',
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
        continue;
      }

      // OpenAI represents tool results as dedicated `tool` role messages. Keep
      // them immediately after the corresponding assistant tool-call message,
      // then emit any ordinary user text from the same neutral message.
      const textParts: string[] = [];
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          turns.push({
            role: 'tool',
            tool_call_id: block.toolCallId,
            content: block.content,
          });
        } else if (block.type === 'text') {
          textParts.push(block.text);
        }
      }
      if (textParts.length > 0) {
        turns.push({ role: 'user', content: textParts.join('') });
      }
    }

    const sys = systemPrompt?.trim();
    if (!sys) return turns;
    const systemRole = this.reasoningModel ? 'developer' : 'system';
    return [{ role: systemRole, content: sys }, ...turns];
  }

  private buildRequestBody(
    messages: Message[],
    options: StreamOptions | SendOptions,
    defaultMaxTokens: number,
    stream: boolean,
  ): Record<string, unknown> {
    const maxTokens = options.maxTokens ?? defaultMaxTokens;
    const body: Record<string, unknown> = {
      model: this.defaultModel,
      messages: this.buildChatMessages(messages, options.systemPrompt),
    };

    // Reasoning models require `max_completion_tokens`; chat models use `max_tokens`.
    if (this.reasoningModel) {
      body.max_completion_tokens = maxTokens;
    } else {
      body.max_tokens = maxTokens;
    }

    if (stream) {
      body.stream = true;
      // Ask OpenAI-compatible APIs to emit a final usage chunk so we report
      // real token counts instead of a char/4 estimate. Disabled via config
      // for servers that reject unknown request fields.
      if (this.includeUsage) {
        body.stream_options = { include_usage: true };
      }
    }

    // Native tool-calling (opt-in). Omitted entirely unless the caller passes
    // tools, so default requests are unchanged.
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(toOpenAITool);
      const choice = toOpenAIToolChoice(options.toolChoice);
      if (choice !== undefined) body.tool_choice = choice;
    }

    return body;
  }

  private async processSSEStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    options: StreamOptions
  ) {
    const decoder = new TextDecoder();
    let buffer = '';
    let thinkingText = '';
    let responseText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const toolAcc = new OpenAIToolCallAccumulator();

    try {
      while (true) {
        if (options.signal?.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const parsed = parseSSELine(line);
          if (!parsed) continue;

          const choices = parsed.choices as Array<{
            delta?: {
              content?: string;
              reasoning_content?: string;
              tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
            };
          }> | undefined;

          if (choices?.[0]?.delta) {
            const delta = choices[0].delta;
            if (delta.reasoning_content) {
              thinkingText += delta.reasoning_content;
              options.onThinkingDelta?.(delta.reasoning_content);
            }
            if (delta.content) {
              responseText += delta.content;
              options.onTextDelta?.(delta.content);
            }
            if (delta.tool_calls) {
              toolAcc.add(delta.tool_calls);
            }
          }

          const usage = parsed.usage as { prompt_tokens?: number; completion_tokens?: number; } | undefined;
          if (usage) {
            inputTokens = usage.prompt_tokens ?? inputTokens;
            outputTokens = usage.completion_tokens ?? outputTokens;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { thinkingText, responseText, inputTokens, outputTokens, toolCalls: toolAcc.finalize() };
  }

  // ── Streaming Message ────────────────────────────────────
  async streamMessage(
    messages: Message[],
    options: StreamOptions,
  ): Promise<UnifiedResponse> {
    const model = this.defaultModel;
    const startTime = Date.now();

    const body = this.buildRequestBody(messages, options, 16384, true);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      throw normalizeProviderError(error, {
        providerId: this.id,
        operation: 'stream request failed',
        signal: options.signal,
      });
    }

    if (!response.ok) {
      const errorText = (await response.text().catch(() => 'Unknown error')).slice(0, 4096);
      const requestId = response.headers.get('x-request-id')
        ?? response.headers.get('request-id')
        ?? undefined;
      throw new ProviderError(
        `[${this.id}] API error ${response.status}: ${errorText}`,
        {
          kind: kindFromStatus(response.status),
          status: response.status,
          providerId: this.id,
          requestId,
        },
      );
    }

    if (!response.body) {
      throw new ProviderError(`[${this.id}] No response body received`, {
        kind: 'server_error',
        providerId: this.id,
      });
    }

    let streamResult: Awaited<ReturnType<OpenAIProvider['processSSEStream']>>;
    try {
      streamResult = await this.processSSEStream(response.body.getReader(), options);
    } catch (error) {
      throw normalizeProviderError(error, {
        providerId: this.id,
        operation: 'stream interrupted',
        signal: options.signal,
      });
    }
    const { thinkingText, responseText, inputTokens: parsedInputTokens, outputTokens: parsedOutputTokens, toolCalls } = streamResult;

    let inputTokens = parsedInputTokens;
    let outputTokens = parsedOutputTokens;

    // Estimate tokens if not provided by the API
    if (inputTokens === 0) {
      inputTokens = Math.ceil(
        messagesCharLength(messages) / 4
      );
    }
    if (outputTokens === 0) {
      outputTokens = Math.ceil((responseText.length + thinkingText.length) / 4);
    }

    // A response with no text, no reasoning, and no tool call is not a usable
    // success; flag it incomplete so the orchestrator falls back.
    const aborted = !!options.signal?.aborted;
    const empty = responseText.trim().length === 0 && thinkingText.trim().length === 0 && toolCalls.length === 0;

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
        incomplete: aborted || empty,
      },
    };
  }

  // ── Non-Streaming Message ────────────────────────────────
  async sendMessage(
    messages: Message[],
    options: SendOptions,
  ): Promise<UnifiedResponse> {
    const model = this.defaultModel;
    const startTime = Date.now();

    const body = this.buildRequestBody(messages, options, 8192, false);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      throw normalizeProviderError(error, {
        providerId: this.id,
        operation: 'API request failed',
        signal: options.signal,
      });
    }

    if (!response.ok) {
      const errorText = (await response.text().catch(() => 'Unknown error')).slice(0, 4096);
      const requestId = response.headers.get('x-request-id')
        ?? response.headers.get('request-id')
        ?? undefined;
      throw new ProviderError(
        `[${this.id}] API error ${response.status}: ${errorText}`,
        {
          kind: kindFromStatus(response.status),
          status: response.status,
          providerId: this.id,
          requestId,
        },
      );
    }

    let data: {
      choices?: Array<{
        message?: {
          content?: string;
          reasoning_content?: string;
          tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
    };
    try {
      data = await response.json() as typeof data;
    } catch (error) {
      throw new ProviderError(`[${this.id}] API returned invalid JSON`, {
        kind: 'server_error',
        providerId: this.id,
        cause: error,
      });
    }

    const choice = data.choices?.[0]?.message;
    const thinkingText = choice?.reasoning_content ?? '';
    const responseText = choice?.content ?? '';
    const toolCalls: UnifiedToolCall[] = extractOpenAIToolCalls(choice);
    const inputTokens = data.usage?.prompt_tokens ?? Math.ceil(
      messagesCharLength(messages) / 4
    );
    const outputTokens = data.usage?.completion_tokens ?? Math.ceil(
      (responseText.length + thinkingText.length) / 4
    );

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
        incomplete:
          responseText.trim().length === 0 &&
          thinkingText.trim().length === 0 &&
          toolCalls.length === 0,
      },
    };
  }
}