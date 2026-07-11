// ─────────────────────────────────────────────────────────────
//  mythos-router :: providers/messages.ts
//  Provider-neutral structured conversation helpers
// ─────────────────────────────────────────────────────────────

import type {
  Message,
  MessageContentBlock,
  ToolResultMessageBlock,
  UnifiedToolCall,
} from './types.js';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJsonValue(value: unknown, label: string, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== 'object') {
    throw new Error(`${label} must contain only JSON-serializable values`);
  }
  if (seen.has(value)) throw new Error(`${label} contains a circular reference`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => cloneJsonValue(entry, `${label}[${index}]`, seen));
    }
    if (!isPlainRecord(value)) {
      throw new Error(`${label} must contain only plain JSON objects`);
    }
    const cloned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      cloned[key] = cloneJsonValue(entry, `${label}.${key}`, seen);
    }
    return cloned;
  } finally {
    seen.delete(value);
  }
}

function cloneToolArgs(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be an object`);
  return cloneJsonValue(value, label, new Set()) as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Validate and clone one provider-neutral message.
 *
 * Legacy text messages remain valid. Structured blocks are deliberately strict:
 * assistant messages may contain text/tool_call blocks, while user messages may
 * contain text/tool_result blocks. This keeps malformed provider histories from
 * reaching an SDK where they would fail with less actionable errors.
 */
export function normalizeMessage(message: Message, index = 0): Message {
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
    throw new Error(`Invalid role at message[${index}]: ${String((message as Message | undefined)?.role)}`);
  }

  if (typeof message.content === 'string') {
    requireNonEmptyString(message.content, `Message[${index}] content`);
    return { role: message.role, content: message.content };
  }

  if (!Array.isArray(message.content) || message.content.length === 0) {
    throw new Error(`Message[${index}] content must be a non-empty string or block array`);
  }

  const blocks: MessageContentBlock[] = message.content.map((block, blockIndex) => {
    const label = `Message[${index}] block[${blockIndex}]`;
    if (!block || typeof block !== 'object') {
      throw new Error(`${label} must be an object`);
    }

    if (block.type === 'text') {
      return {
        type: 'text',
        text: requireNonEmptyString(block.text, `${label}.text`),
      };
    }

    if (block.type === 'tool_call') {
      if (message.role !== 'assistant') {
        throw new Error(`${label} tool_call blocks are only valid in assistant messages`);
      }
      return {
        type: 'tool_call',
        id: requireNonEmptyString(block.id, `${label}.id`),
        name: requireNonEmptyString(block.name, `${label}.name`),
        args: cloneToolArgs(block.args, `${label}.args`),
      };
    }

    if (block.type === 'tool_result') {
      if (message.role !== 'user') {
        throw new Error(`${label} tool_result blocks are only valid in user messages`);
      }
      if (block.isError !== undefined && typeof block.isError !== 'boolean') {
        throw new Error(`${label}.isError must be a boolean when provided`);
      }
      if (block.name !== undefined && (typeof block.name !== 'string' || block.name.trim().length === 0)) {
        throw new Error(`${label}.name must be a non-empty string when provided`);
      }
      return {
        type: 'tool_result',
        toolCallId: requireNonEmptyString(block.toolCallId, `${label}.toolCallId`),
        ...(block.name !== undefined ? { name: block.name } : {}),
        content: requireNonEmptyString(block.content, `${label}.content`),
        ...(block.isError !== undefined ? { isError: block.isError } : {}),
      };
    }

    throw new Error(`${label} has unsupported type ${JSON.stringify((block as { type?: unknown }).type)}`);
  });

  return { role: message.role, content: blocks };
}

export function normalizeMessages(messages: readonly Message[]): Message[] {
  if (!Array.isArray(messages)) throw new Error('Messages must be an array');
  const normalized = messages.map((message, index) => normalizeMessage(message, index));
  const pendingToolCalls = new Set<string>();

  for (let messageIndex = 0; messageIndex < normalized.length; messageIndex++) {
    const message = normalized[messageIndex]!;
    if (typeof message.content === 'string') {
      if (pendingToolCalls.size > 0) {
        throw new Error(`Message[${messageIndex}] must provide tool results before ordinary conversation continues`);
      }
      continue;
    }

    if (message.role === 'assistant') {
      if (pendingToolCalls.size > 0) {
        throw new Error(`Message[${messageIndex}] starts a new assistant turn before all tool results were provided`);
      }
      for (const block of message.content) {
        if (block.type !== 'tool_call') continue;
        if (pendingToolCalls.has(block.id)) {
          throw new Error(`Message[${messageIndex}] contains duplicate tool call id ${JSON.stringify(block.id)}`);
        }
        pendingToolCalls.add(block.id);
      }
      continue;
    }

    let hasOrdinaryText = false;
    for (const block of message.content) {
      if (block.type === 'text') {
        hasOrdinaryText = true;
        continue;
      }
      if (block.type === 'tool_call') {
        throw new Error(`Message[${messageIndex}] contains an assistant-only tool_call block`);
      }
      if (!pendingToolCalls.delete(block.toolCallId)) {
        throw new Error(`Message[${messageIndex}] references unknown or already-resolved tool call ${JSON.stringify(block.toolCallId)}`);
      }
    }
    if (hasOrdinaryText && pendingToolCalls.size > 0) {
      throw new Error(`Message[${messageIndex}] includes user text before all tool results were provided`);
    }
  }

  if (pendingToolCalls.size > 0) {
    throw new Error(`Conversation is missing tool results for: ${[...pendingToolCalls].join(', ')}`);
  }
  return normalized;
}

/** Build an assistant history entry without ever creating an empty message. */
export function assistantMessageFromResponse(
  text: string,
  toolCalls: readonly UnifiedToolCall[] | undefined,
): Message | null {
  const blocks: MessageContentBlock[] = [];
  if (typeof text === 'string' && text.trim().length > 0) {
    blocks.push({ type: 'text', text });
  }

  for (const call of toolCalls ?? []) {
    if (!call || typeof call.id !== 'string' || call.id.trim().length === 0) continue;
    if (typeof call.name !== 'string' || call.name.trim().length === 0) continue;
    let args: Record<string, unknown>;
    try {
      args = cloneToolArgs(call.args, `Tool call ${call.id} args`);
    } catch {
      continue;
    }
    blocks.push({
      type: 'tool_call',
      id: call.id,
      name: call.name,
      args,
    });
  }

  if (blocks.length === 0) return null;
  if (blocks.length === 1 && blocks[0].type === 'text') {
    return { role: 'assistant', content: blocks[0].text };
  }
  return { role: 'assistant', content: blocks };
}

export interface ToolResultInput {
  toolCallId: string;
  name?: string;
  content: string;
  isError?: boolean;
}

/** Build one user-role tool-result message containing one block per tool call. */
export function toolResultMessage(results: readonly ToolResultInput[]): Message | null {
  const blocks: ToolResultMessageBlock[] = [];
  for (const result of results) {
    if (!result || typeof result.toolCallId !== 'string' || result.toolCallId.trim().length === 0) continue;
    if (typeof result.content !== 'string' || result.content.trim().length === 0) continue;
    blocks.push({
      type: 'tool_result',
      toolCallId: result.toolCallId,
      ...(result.name && result.name.trim() ? { name: result.name } : {}),
      content: result.content,
      ...(result.isError !== undefined ? { isError: result.isError } : {}),
    });
  }
  return blocks.length > 0 ? { role: 'user', content: blocks } : null;
}


/**
 * Move a history compression boundary backward when it would separate an
 * assistant tool-call turn from one of its user-role tool results. Keeping the
 * complete exchange in the uncompressed tail guarantees the tail remains a
 * valid provider conversation after summarization or hard truncation.
 */
export function adjustCompressionBoundary(messages: readonly Message[], requested: number): number {
  const boundary = Math.max(0, Math.min(Math.trunc(requested), messages.length));
  if (boundary === 0 || boundary >= messages.length) return boundary;

  const next = messages[boundary];
  if (!next || typeof next.content === 'string' || next.role !== 'user') return boundary;
  const resultIds = new Set(
    next.content
      .filter((block) => block.type === 'tool_result')
      .map((block) => block.type === 'tool_result' ? block.toolCallId : ''),
  );
  if (resultIds.size === 0) return boundary;

  for (let index = boundary - 1; index >= 0; index--) {
    const candidate = messages[index]!;
    if (candidate.role !== 'assistant' || typeof candidate.content === 'string') continue;
    const hasMatchingCall = candidate.content.some(
      (block) => block.type === 'tool_call' && resultIds.has(block.id),
    );
    if (hasMatchingCall) return index;
  }
  return boundary;
}

/** Approximate serialized request size for routing and context guards. */
export function messageCharLength(message: Message): number {
  if (typeof message.content === 'string') return message.content.length;
  let total = 0;
  for (const block of message.content) {
    if (block.type === 'text') total += block.text.length;
    else if (block.type === 'tool_call') total += block.id.length + block.name.length + stableStringify(block.args).length;
    else total += block.toolCallId.length + (block.name?.length ?? 0) + block.content.length + 8;
  }
  return total;
}

export function messagesCharLength(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + messageCharLength(message), 0);
}

/** Stable representation used by deterministic provider selection. */
export function serializeMessageForRouting(message: Message): string {
  return `${message.role}:${stableStringify(message.content)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
