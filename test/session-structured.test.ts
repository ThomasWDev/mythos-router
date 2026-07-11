import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionData, serializeSessionData } from '../src/session.js';
import type { Message } from '../src/providers/types.js';

const structuredHistory: Message[] = [
  { role: 'user', content: 'Create the file.' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'I will apply it.' },
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'write_files',
        args: { actions: [{ path: 'src/a.ts', operation: 'CREATE', content: 'x' }] },
      },
    ],
  },
  {
    role: 'user',
    content: [{
      type: 'tool_result',
      toolCallId: 'call_1',
      name: 'write_files',
      content: '{"ok":true,"status":"verified"}',
      isError: false,
    }],
  },
];

describe('structured session persistence', () => {
  it('round-trips mixed text, tool calls, and tool results', () => {
    const raw = serializeSessionData({
      timestamp: '2026-07-11T12:00:00.000Z',
      project: 'mythos-router',
      history: structuredHistory,
      budget: { inputTokens: 120, outputTokens: 40, turns: 2 },
    });

    const loaded = parseSessionData(raw);
    assert.ok(loaded);
    assert.equal(loaded.version, 2);
    assert.deepEqual(loaded.history, structuredHistory);
    assert.deepEqual(loaded.budget, { inputTokens: 120, outputTokens: 40, turns: 2 });
  });

  it('migrates valid v1 text-only sessions into the v2 in-memory shape', () => {
    const loaded = parseSessionData(JSON.stringify({
      version: 1,
      timestamp: '2026-07-11T12:00:00.000Z',
      project: 'mythos-router',
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      budget: { inputTokens: 10, outputTokens: 5, turns: 1 },
    }));

    assert.ok(loaded);
    assert.equal(loaded.version, 2);
    assert.deepEqual(loaded.history, [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
  });

  it('rejects malformed structured history instead of resuming poisoned state', () => {
    const loaded = parseSessionData(JSON.stringify({
      version: 2,
      timestamp: '2026-07-11T12:00:00.000Z',
      project: 'mythos-router',
      history: [{
        role: 'assistant',
        content: [{ type: 'tool_result', toolCallId: 'call_1', content: 'wrong role' }],
      }],
      budget: { inputTokens: 10, outputTokens: 5, turns: 1 },
    }));

    assert.equal(loaded, null);
  });
});
