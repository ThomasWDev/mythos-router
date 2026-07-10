import {
  ProviderError,
  kindFromStatus,
  type ProviderErrorKind,
  type ProviderFailureReason,
} from './types.js';

interface ErrorShape {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  type?: unknown;
  requestID?: unknown;
  requestId?: unknown;
  response?: unknown;
  cause?: unknown;
}

export interface NormalizeProviderErrorOptions {
  providerId: string;
  operation: string;
  signal?: AbortSignal;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

export function extractStatusCode(error: unknown): number | undefined {
  const shape = asRecord(error) as ErrorShape | undefined;
  if (!shape) return undefined;

  const response = asRecord(shape.response);
  const candidates = [shape.status, shape.statusCode, response?.status];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function extractString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function classifyByShape(error: unknown, signal?: AbortSignal): ProviderErrorKind {
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof ProviderError) return reason.kind;
    return 'cancelled';
  }

  const shape = asRecord(error) as ErrorShape | undefined;
  const name = extractString(shape?.name) ?? (error instanceof Error ? error.name : '');
  const type = extractString(shape?.type)?.toLowerCase();
  const code = extractString(shape?.code)?.toLowerCase();
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

  if (name === 'APIConnectionTimeoutError' || name === 'TimeoutError' || code === 'etimedout') {
    return 'timeout';
  }
  if (name === 'APIUserAbortError' || name === 'AbortError') {
    return 'cancelled';
  }
  if (type === 'overloaded_error' || message.includes('overloaded')) {
    return 'overloaded';
  }
  if (type === 'rate_limit_error' || message.includes('rate limit')) {
    return 'rate_limit';
  }

  const status = extractStatusCode(error);
  if (status !== undefined) return kindFromStatus(status);

  for (const codeValue of [408, 429, 500, 501, 502, 503, 504, 529]) {
    const tokenRe = new RegExp(`(?<![0-9])${codeValue}(?![0-9])`);
    if (tokenRe.test(message)) return kindFromStatus(codeValue);
  }
  if (message.includes('timed out') || message.includes('timeout')) {
    return 'timeout';
  }

  if (
    name === 'APIConnectionError' ||
    code === 'econnrefused' ||
    code === 'econnreset' ||
    code === 'enotfound' ||
    code === 'eai_again' ||
    message.includes('fetch failed') ||
    message.includes('network error') ||
    message.includes('network unavailable')
  ) {
    return 'network';
  }

  return 'unknown';
}

export function normalizeProviderError(
  error: unknown,
  options: NormalizeProviderErrorOptions,
): ProviderError {
  if (error instanceof ProviderError) return error;

  if (options.signal?.reason instanceof ProviderError) {
    return options.signal.reason;
  }

  const shape = asRecord(error) as ErrorShape | undefined;
  const status = extractStatusCode(error);
  const kind = classifyByShape(error, options.signal);
  const originalMessage = error instanceof Error ? error.message : String(error);
  const requestId = extractString(shape?.requestID) ?? extractString(shape?.requestId);
  const providerCode = extractString(shape?.type) ?? extractString(shape?.code);
  const suffix = requestId ? ` (request ${requestId})` : '';

  return new ProviderError(
    `[${options.providerId}] ${options.operation}: ${originalMessage}${suffix}`,
    {
      kind,
      status,
      providerId: options.providerId,
      cause: error,
      requestId,
      providerCode,
    },
  );
}

export function failureReasonFromError(error: unknown): ProviderFailureReason {
  const kind = error instanceof ProviderError
    ? error.kind
    : classifyByShape(error);

  switch (kind) {
    case 'network': return 'network_error';
    case 'rate_limit': return 'rate_limit';
    case 'overloaded': return 'overloaded';
    case 'server_error': return 'server_error';
    case 'timeout': return 'timeout';
    case 'client_error': return 'client_error';
    case 'incomplete_response': return 'incomplete_response';
    case 'cancelled': return 'cancelled';
    default: return 'unknown';
  }
}
