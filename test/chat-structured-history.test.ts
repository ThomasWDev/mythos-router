import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatSession } from '../src/commands/chat.js';
import { normalizeMessages } from '../src/providers/messages.js';
import type { ChatUI } from '../src/commands/chat-ui.js';
import type { UnifiedResponse } from '../src/providers/types.js';

const quietUI: ChatUI = {
  startLoading() {},
  updateLoading() {},
  stopLoading() {},
  write() {},
  log() {},
  warn() {},
  error() {},
  success() {},
  divider() {},
};

function response(id: string, path: string): UnifiedResponse {
  return {
    thinking: '',
    text: '',
    toolCalls: [{
      id,
      name: 'write_files',
      args: {
        actions: [{
          path,
          operation: 'CREATE',
          content: 'ok',
          description: 'create file',
        }],
      },
    }],
    usage: { inputTokens: 1, outputTokens: 1, latencyMs: 1 },
    metadata: {
      providerId: 'test',
      modelId: 'test',
      fallbackTriggered: false,
      incomplete: false,
    },
  };
}

describe('ChatSession structured tool history', () => {
  it('keeps tool-only failures and correction results replayable on the next user turn', () => {
    const session = new ChatSession({ tools: true, maxTokens: '1000', maxTurns: '5' }, quietUI);
    const internals = session as unknown as {
      appendAssistantResponse(value: UnifiedResponse): void;
      appendToolResults(value: UnifiedResponse, report: Record<string, unknown>, isError: boolean): void;
    };

    session.history.push({ role: 'user', content: 'Create a.ts.' });
    const first = response('call_1', 'a.ts');
    internals.appendAssistantResponse(first);
    internals.appendToolResults(first, { ok: false, status: 'failed', message: 'verification failed' }, true);

    session.history.push({ role: 'user', content: 'Correct the failed write.' });
    const correction = response('call_2', 'a.ts');
    internals.appendAssistantResponse(correction);
    internals.appendToolResults(correction, { ok: true, status: 'verified' }, false);

    session.history.push({ role: 'user', content: 'What changed?' });

    assert.doesNotThrow(() => normalizeMessages(session.history));
    assert.equal(session.history.length, 7);
    assert.deepEqual(session.history[1], {
      role: 'assistant',
      content: [{
        type: 'tool_call',
        id: 'call_1',
        name: 'write_files',
        args: first.toolCalls[0].args,
      }],
    });
    assert.deepEqual(session.history[2], {
      role: 'user',
      content: [{
        type: 'tool_result',
        toolCallId: 'call_1',
        name: 'write_files',
        content: '{"ok":false,"status":"failed","message":"verification failed"}',
        isError: true,
      }],
    });
  });
});
