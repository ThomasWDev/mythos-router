import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider } from '../src/providers/openai.js';
import { ProviderError } from '../src/providers/types.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function provider(): OpenAIProvider {
  return new OpenAIProvider({
    id: 'openai-test',
    apiKey: 'test-key',
    baseUrl: 'https://example.invalid/v1',
    defaultModel: 'gpt-4o',
  });
}

describe('OpenAIProvider base URL normalization', () => {
  it('removes trailing slashes without a backtracking regular expression', () => {
    const instance = new OpenAIProvider({
      id: 'openai-test',
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid/v1////',
      defaultModel: 'gpt-4o',
    });

    assert.equal(
      (instance as unknown as { baseUrl: string }).baseUrl,
      'https://example.invalid/v1',
    );
  });

  it('handles adversarial slash-heavy library input in linear time semantics', () => {
    const slashHeavy = '/'.repeat(250_000) + 'x';
    const instance = new OpenAIProvider({
      id: 'openai-test',
      apiKey: 'test-key',
      baseUrl: slashHeavy,
      defaultModel: 'gpt-4o',
    });

    assert.equal((instance as unknown as { baseUrl: string }).baseUrl, slashHeavy);
  });
});

describe('OpenAIProvider response normalization', () => {
  it('treats a non-streaming tool-call-only response as complete', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: 'src/a.ts', content: 'ok' }),
            },
          }],
        },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const response = await provider().sendMessage(
      [{ role: 'user', content: 'use the tool' }],
      { systemPrompt: 'test' },
    );

    assert.equal(response.text, '');
    assert.equal(response.toolCalls.length, 1);
    assert.deepEqual(response.toolCalls[0], {
      id: 'call_1',
      name: 'write_file',
      args: { path: 'src/a.ts', content: 'ok' },
    });
    assert.equal(response.metadata.incomplete, false);
  });

  it('preserves HTTP status and provider request ids', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { message: 'rate limited' },
    }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req_openai_123',
      },
    });

    await assert.rejects(
      () => provider().sendMessage(
        [{ role: 'user', content: 'hello' }],
        { systemPrompt: 'test' },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.kind, 'rate_limit');
        assert.equal(error.status, 429);
        assert.equal(error.requestId, 'req_openai_123');
        return true;
      },
    );
  });

  it('normalizes fetch failures into typed network errors with the original cause', async () => {
    const cause = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
    globalThis.fetch = async () => { throw cause; };

    await assert.rejects(
      () => provider().sendMessage(
        [{ role: 'user', content: 'hello' }],
        { systemPrompt: 'test' },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.kind, 'network');
        assert.equal(error.providerId, 'openai-test');
        assert.equal(error.cause, cause);
        return true;
      },
    );
  });

  it('classifies malformed successful JSON as a retryable provider response failure', async () => {
    globalThis.fetch = async () => new Response('{not-json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    await assert.rejects(
      () => provider().sendMessage(
        [{ role: 'user', content: 'hello' }],
        { systemPrompt: 'test' },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.kind, 'server_error');
        assert.equal(error.retryable, true);
        return true;
      },
    );
  });
});

describe('OpenAIProvider structured history mapping', () => {
  it('maps tool calls and results to native assistant/tool messages across turns', async () => {
    let requestBody: any;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'continued' } }],
        usage: { prompt_tokens: 30, completion_tokens: 2 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await provider().sendMessage([
      { role: 'user', content: 'Apply both.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Applying both.' },
          { type: 'tool_call', id: 'call_1', name: 'write_files', args: { actions: [{ path: 'a.ts' }] } },
          { type: 'tool_call', id: 'call_2', name: 'write_files', args: { actions: [{ path: 'b.ts' }] } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'call_1', content: '{"ok":true}', isError: false },
          { type: 'tool_result', toolCallId: 'call_2', content: '{"ok":false}', isError: true },
        ],
      },
      { role: 'user', content: 'Correct the failure.' },
    ], { systemPrompt: 'system' });

    assert.deepEqual(requestBody.messages, [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Apply both.' },
      {
        role: 'assistant',
        content: 'Applying both.',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'write_files', arguments: '{"actions":[{"path":"a.ts"}]}' } },
          { id: 'call_2', type: 'function', function: { name: 'write_files', arguments: '{"actions":[{"path":"b.ts"}]}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      { role: 'tool', tool_call_id: 'call_2', content: '{"ok":false}' },
      { role: 'user', content: 'Correct the failure.' },
    ]);
  });

  it('uses null content for a tool-only assistant turn instead of an empty string', async () => {
    let requestBody: any;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    await provider().sendMessage([
      { role: 'user', content: 'write' },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'call_1', name: 'write_files', args: { actions: [] } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolCallId: 'call_1', content: '{"ok":true}' }],
      },
    ], { systemPrompt: '' });

    assert.equal(requestBody.messages[1].role, 'assistant');
    assert.equal(requestBody.messages[1].content, null);
    assert.equal(requestBody.messages[1].tool_calls[0].id, 'call_1');
  });
});
