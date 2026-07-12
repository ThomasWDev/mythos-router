// ─────────────────────────────────────────────────────────────
//  mythos-router :: providers/types.ts
//  Universal provider contract — zero provider leakage
// ─────────────────────────────────────────────────────────────

// ── Unified Message Format ───────────────────────────────────
// Plain string messages remain supported for backward compatibility. Native
// tool conversations use structured blocks so assistant tool calls and their
// user-role results survive provider fallback, correction turns, and resume.
export interface TextMessageBlock {
  type: 'text';
  text: string;
}

export interface ToolCallMessageBlock {
  type: 'tool_call';
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultMessageBlock {
  type: 'tool_result';
  toolCallId: string;
  name?: string;
  content: string;
  isError?: boolean;
}

export type MessageContentBlock =
  | TextMessageBlock
  | ToolCallMessageBlock
  | ToolResultMessageBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: string | MessageContentBlock[];
}

// ── Streaming Chunks ─────────────────────────────────────────
// Every provider MUST normalize its raw stream into this format.
// Invariant: thinking chunks MUST arrive before text chunks.
export interface UnifiedChunk {
  type: 'thinking' | 'text' | 'tool_call_delta';
  content: string;
}

// ── Tool Calls ───────────────────────────────────────────────
export interface UnifiedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// ── Tool Definition (provider-neutral) ───────────────────────
// A tool the model may call. `inputSchema` is a JSON Schema object. Each
// provider adapter maps this onto its own native tool format.
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ── Unified Response ─────────────────────────────────────────
// The final output of any provider call, whether streamed or not.
// Invariant: Must perfectly match concatenated streamed chunks.
export interface UnifiedResponse {
  thinking: string;
  text: string;
  toolCalls: UnifiedToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  };
  metadata: {
    providerId: string;
    modelId: string;
    fallbackTriggered: boolean;
    incomplete: boolean;
  };
}

// ── Request Options ──────────────────────────────────────────
export interface RequestOptions {
  taskType?: 'chat' | 'code' | 'analysis' | 'unknown';
  deterministic?: boolean;
  forceProvider?: string;
  allowFallback?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  // Optional native tool-calling. When provided, a provider that supports tools
  // will offer them to the model and populate UnifiedResponse.toolCalls. Leave
  // unset to use the text-based FILE_ACTION protocol (the default).
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'required' | { name: string };
}

// ── Stream Options (extends Request with callbacks) ──────────
export interface StreamOptions extends RequestOptions {
  systemPrompt: string;
  maxTokens?: number;
  effort?: string;
  onThinkingDelta?: (text: string) => void;
  onTextDelta?: (text: string) => void;
}

// ── Send Options (non-streaming) ─────────────────────────────
export interface SendOptions extends RequestOptions {
  systemPrompt: string;
  maxTokens?: number;
  effort?: string;
}

// ── Provider Capabilities ────────────────────────────────────
// Descriptive metadata: documents what a backend supports. The default file
// path is still the provider-agnostic text FILE_ACTION protocol (see swd.ts);
// 'tools' additionally advertises native tool-calling, an opt-in path that
// emits the same FILE_ACTION envelope as structured tool input and is verified
// against the filesystem the same way.
export type ProviderCapability = 'thinking' | 'streaming' | 'tools';

// ── Provider Health Status ───────────────────────────────────
export type ProviderStatus = 'healthy' | 'degraded' | 'down';

// ── Base Provider Interface ──────────────────────────────────
// Every LLM backend MUST implement this contract.
// The orchestrator never touches raw provider APIs directly.
export interface ProviderTelemetryIdentity {
  modelId: string;
  endpointHash: string;
}

export interface BaseProvider {
  readonly id: string;
  readonly capabilities: ReadonlySet<ProviderCapability>;
  readonly telemetryIdentity?: ProviderTelemetryIdentity;

  streamMessage(
    messages: Message[],
    options: StreamOptions,
  ): Promise<UnifiedResponse>;

  sendMessage(
    messages: Message[],
    options: SendOptions,
  ): Promise<UnifiedResponse>;
}

// ── Provider Registration Config ─────────────────────────────
export interface ProviderConfig {
  id: string;
  priority: number;         // Lower = higher priority in fallback chain
  enabled: boolean;
  maxConcurrency: number;   // Hard per-provider in-flight request limit
}

// ── Orchestration Event (for observability) ──────────────────
export type ProviderFailureReason =
  | 'timeout'
  | 'rate_limit'
  | 'overloaded'
  | 'server_error'
  | 'network_error'
  | 'client_error'
  | 'incomplete_response'
  | 'capability_mismatch'
  | 'cancelled'
  | 'unknown';

export interface OrchestrationEvent {
  timestamp: string;
  sessionId: string;
  command: string;
  primaryProvider: string;
  actualProvider: string;
  fallbackReason?: ProviderFailureReason;
  latencyMs: number;
  cost: number;             // Estimated total request cost in USD
  costPer1k?: number;       // Estimated blended USD per 1,000 processed tokens
  retryCount: number;       // Same-provider retries, excluding first attempts
  fallbackCount?: number;   // Provider transitions, excluding the primary
}

// ── Structured Provider Errors ───────────────────────────────
// A typed error so retry/circuit-breaker decisions key off an explicit `kind`
// instead of scanning the message string (where a byte count or request id can
// masquerade as a status code). Providers throw these; the orchestrator reads
// `.retryable` / `.kind` directly and only falls back to heuristics for raw
// SDK/network errors that aren't ProviderError instances.
export type ProviderErrorKind =
  | 'rate_limit'    // HTTP 429
  | 'overloaded'    // provider-signalled overload (e.g. Anthropic 529)
  | 'server_error'  // HTTP 5xx
  | 'network'       // connection refused/reset, DNS, fetch failed
  | 'timeout'             // request/watchdog timeout
  | 'client_error'        // HTTP 4xx (non-retryable)
  | 'incomplete_response' // syntactically valid but unusable success payload
  | 'cancelled'           // caller-requested cancellation (non-retryable)
  | 'unknown';

export function isRetryableKind(kind: ProviderErrorKind): boolean {
  return kind === 'rate_limit'
    || kind === 'overloaded'
    || kind === 'server_error'
    || kind === 'network'
    || kind === 'timeout'
    || kind === 'incomplete_response';
}

export interface ProviderErrorOptions {
  kind: ProviderErrorKind;
  status?: number;
  providerId?: string;
  retryable?: boolean;
  cause?: unknown;
  requestId?: string;
  providerCode?: string;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly providerId?: string;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly providerCode?: string;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message);
    this.name = 'ProviderError';
    this.kind = options.kind;
    this.status = options.status;
    this.providerId = options.providerId;
    this.retryable = options.retryable ?? isRetryableKind(options.kind);
    this.requestId = options.requestId;
    this.providerCode = options.providerCode;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Classify an HTTP status code into a ProviderErrorKind. */
export function kindFromStatus(status: number): ProviderErrorKind {
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status === 499) return 'cancelled';
  if (status === 529) return 'overloaded';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return 'unknown';
}
