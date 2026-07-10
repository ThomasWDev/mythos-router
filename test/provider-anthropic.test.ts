import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { ProviderError } from '../src/providers/types.js';

function withClient(provider: AnthropicProvider, client: unknown): void {
  Object.defineProperty(provider, 'client', {
    value: client,
    configurable: true,
  });
}

describe('AnthropicProvider error normalization', () => {
  it('preserves status, provider type, request id, and cause from SDK-shaped errors', async () => {
    const cause = Object.assign(new Error('Request was overloaded'), {
      name: 'InternalServerError',
      status: 529,
      type: 'overloaded_error',
      requestID: 'req_test_123',
    });
    const anthropic = new AnthropicProvider('test-key');
    withClient(anthropic, {
      messages: {
        create: async () => { throw cause; },
      },
    });

    await assert.rejects(
      () => anthropic.sendMessage(
        [{ role: 'user', content: 'hello' }],
        { systemPrompt: 'test', effort: 'low' },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.kind, 'overloaded');
        assert.equal(error.status, 529);
        assert.equal(error.providerId, 'anthropic');
        assert.equal(error.providerCode, 'overloaded_error');
        assert.equal(error.requestId, 'req_test_123');
        assert.equal(error.cause, cause);
        assert.match(error.message, /req_test_123/);
        return true;
      },
    );
  });

  it('preserves Anthropic connection timeout semantics', async () => {
    const cause = Object.assign(new Error('request timed out'), {
      name: 'APIConnectionTimeoutError',
    });
    const anthropic = new AnthropicProvider('test-key');
    withClient(anthropic, {
      messages: {
        create: async () => { throw cause; },
      },
    });

    await assert.rejects(
      () => anthropic.sendMessage(
        [{ role: 'user', content: 'hello' }],
        { systemPrompt: 'test', effort: 'low' },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.kind, 'timeout');
        assert.equal(error.retryable, true);
        assert.equal(error.cause, cause);
        return true;
      },
    );
  });
});

describe('AnthropicProvider structured history mapping', () => {
  it('replays tool-only and mixed tool turns without empty assistant content', async () => {
    let request: any;
    const anthropic = new AnthropicProvider('test-key');
    withClient(anthropic, {
      messages: {
        create: async (body: unknown) => {
          request = body;
          return {
            content: [{ type: 'text', text: 'continued' }],
            usage: { input_tokens: 20, output_tokens: 2 },
          };
        },
      },
    });

    await anthropic.sendMessage([
      { role: 'user', content: 'Apply the changes.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Applying two files.' },
          { type: 'tool_call', id: 'call_1', name: 'write_files', args: { actions: [{ path: 'a.ts' }] } },
          { type: 'tool_call', id: 'call_2', name: 'write_files', args: { actions: [{ path: 'b.ts' }] } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'call_1', name: 'write_files', content: '{"ok":true}', isError: false },
          { type: 'tool_result', toolCallId: 'call_2', name: 'write_files', content: '{"ok":false}', isError: true },
        ],
      },
      { role: 'user', content: 'Fix the failed one.' },
    ], { systemPrompt: 'test', effort: 'low' });

    assert.equal(request.messages[1].role, 'assistant');
    assert.deepEqual(request.messages[1].content, [
      { type: 'text', text: 'Applying two files.' },
      { type: 'tool_use', id: 'call_1', name: 'write_files', input: { actions: [{ path: 'a.ts' }] } },
      { type: 'tool_use', id: 'call_2', name: 'write_files', input: { actions: [{ path: 'b.ts' }] } },
    ]);
    assert.deepEqual(request.messages[2].content, [
      { type: 'tool_result', tool_use_id: 'call_1', content: '{"ok":true}', is_error: false },
      { type: 'tool_result', tool_use_id: 'call_2', content: '{"ok":false}', is_error: true },
    ]);
    assert.equal(request.messages[3].content, 'Fix the failed one.');
  });

  it('accepts a tool-only assistant message as non-empty structured content', async () => {
    let request: any;
    const anthropic = new AnthropicProvider('test-key');
    withClient(anthropic, {
      messages: {
        create: async (body: unknown) => {
          request = body;
          return {
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 4, output_tokens: 1 },
          };
        },
      },
    });

    await anthropic.sendMessage([
      { role: 'user', content: 'write it' },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'call_1', name: 'write_files', args: { actions: [] } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'call_1', content: '{"ok":true}' }],
      },
    ], { systemPrompt: 'test', effort: 'low' });

    assert.deepEqual(request.messages[1].content, [
      { type: 'tool_use', id: 'call_1', name: 'write_files', input: { actions: [] } },
    ]);
  });
});
