import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  adjustCompressionBoundary,
  assistantMessageFromResponse,
  messageCharLength,
  normalizeMessage,
  normalizeMessages,
  serializeMessageForRouting,
  toolResultMessage,
} from '../src/providers/messages.js';
import type { Message } from '../src/providers/types.js';

describe('provider-neutral structured conversation messages', () => {
  it('preserves a tool-only assistant turn without creating empty text', () => {
    const message = assistantMessageFromResponse('', [{
      id: 'call_1',
      name: 'write_files',
      args: { actions: [{ path: 'src/a.ts', operation: 'CREATE' }] },
    }]);

    assert.deepEqual(message, {
      role: 'assistant',
      content: [{
        type: 'tool_call',
        id: 'call_1',
        name: 'write_files',
        args: { actions: [{ path: 'src/a.ts', operation: 'CREATE' }] },
      }],
    });
  });

  it('preserves mixed assistant text and multiple tool calls in order', () => {
    const message = assistantMessageFromResponse('Applying both changes.', [
      { id: 'call_1', name: 'write_files', args: { actions: [{ path: 'a.ts' }] } },
      { id: 'call_2', name: 'write_files', args: { actions: [{ path: 'b.ts' }] } },
    ]);

    assert.deepEqual(message, {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Applying both changes.' },
        { type: 'tool_call', id: 'call_1', name: 'write_files', args: { actions: [{ path: 'a.ts' }] } },
        { type: 'tool_call', id: 'call_2', name: 'write_files', args: { actions: [{ path: 'b.ts' }] } },
      ],
    });
  });

  it('creates one error-capable result block for every tool call', () => {
    const message = toolResultMessage([
      { toolCallId: 'call_1', name: 'write_files', content: '{"ok":true}', isError: false },
      { toolCallId: 'call_2', name: 'write_files', content: '{"ok":false}', isError: true },
    ]);

    assert.deepEqual(message, {
      role: 'user',
      content: [
        { type: 'tool_result', toolCallId: 'call_1', name: 'write_files', content: '{"ok":true}', isError: false },
        { type: 'tool_result', toolCallId: 'call_2', name: 'write_files', content: '{"ok":false}', isError: true },
      ],
    });
  });

  it('never creates an empty assistant or tool-result message', () => {
    assert.equal(assistantMessageFromResponse('   ', []), null);
    assert.equal(toolResultMessage([]), null);
    assert.equal(toolResultMessage([{ toolCallId: '', content: 'x' }]), null);
  });

  it('rejects role/block combinations that providers cannot replay', () => {
    assert.throws(
      () => normalizeMessage({
        role: 'user',
        content: [{ type: 'tool_call', id: 'c', name: 'write_files', args: {} }],
      }, 0),
      /tool_call blocks are only valid in assistant messages/,
    );

    assert.throws(
      () => normalizeMessage({
        role: 'assistant',
        content: [{ type: 'tool_result', toolCallId: 'c', content: 'ok' }],
      }, 0),
      /tool_result blocks are only valid in user messages/,
    );
  });

  it('includes structured blocks in size estimation and deterministic routing', () => {
    const first: Message = {
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'c', name: 'write_files', args: { b: 2, a: 1 } }],
    };
    const second: Message = {
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'c', name: 'write_files', args: { a: 1, b: 2 } }],
    };

    assert.ok(messageCharLength(first) > 0);
    assert.equal(serializeMessageForRouting(first), serializeMessageForRouting(second));
  });
  it('rejects missing, duplicate, and unknown tool-result links', () => {
    assert.throws(
      () => normalizeMessages([{
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'call_1', name: 'write_files', args: {} }],
      }]),
      /missing tool results for: call_1/,
    );

    assert.throws(
      () => normalizeMessages([
        {
          role: 'assistant',
          content: [
            { type: 'tool_call', id: 'call_1', name: 'write_files', args: {} },
            { type: 'tool_call', id: 'call_1', name: 'write_files', args: {} },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', toolCallId: 'call_1', content: 'ok' }] },
      ]),
      /duplicate tool call id/,
    );

    assert.throws(
      () => normalizeMessages([{
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'missing', content: 'ok' }],
      }]),
      /unknown or already-resolved tool call/,
    );
  });

  it('rejects non-JSON tool arguments before they reach a provider SDK', () => {
    assert.throws(
      () => normalizeMessage({
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'call_1', name: 'write_files', args: { value: BigInt(1) } }],
      }),
      /JSON-serializable/,
    );

    const args: Record<string, unknown> = {};
    args.self = args;
    assert.throws(
      () => normalizeMessage({
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'call_1', name: 'write_files', args }],
      }),
      /circular reference/,
    );
  });

  it('keeps assistant tool calls and their results on the same side of compression', () => {
    const history: Message[] = [
      { role: 'user', content: 'old text' },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'call_1', name: 'write_files', args: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'call_1', content: 'ok' }],
      },
      { role: 'user', content: 'next request' },
    ];

    assert.equal(adjustCompressionBoundary(history, 2), 1);
    assert.equal(adjustCompressionBoundary(history, 1), 1);
    assert.equal(adjustCompressionBoundary(history, 3), 3);
  });

});
