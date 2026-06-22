import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FILE_ACTION_TOOL,
  FILE_ACTION_TOOL_NAME,
  toAnthropicTool,
  toOpenAITool,
  toOpenAIToolChoice,
  extractAnthropicToolCalls,
  extractOpenAIToolCalls,
  OpenAIToolCallAccumulator,
  toolCallsToActions,
} from '../src/providers/tools.js';

describe('FILE_ACTION_TOOL schema + mappers', () => {
  it('describes a write_files tool with an actions array', () => {
    assert.equal(FILE_ACTION_TOOL.name, FILE_ACTION_TOOL_NAME);
    const schema = FILE_ACTION_TOOL.inputSchema as any;
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties.actions);
    assert.equal(schema.properties.actions.type, 'array');
  });

  it('maps to the Anthropic tool shape (input_schema)', () => {
    const t = toAnthropicTool(FILE_ACTION_TOOL) as any;
    assert.equal(t.name, 'write_files');
    assert.ok(t.input_schema);
    assert.equal(t.input_schema.type, 'object');
  });

  it('maps to the OpenAI function-tool shape (parameters)', () => {
    const t = toOpenAITool(FILE_ACTION_TOOL) as any;
    assert.equal(t.type, 'function');
    assert.equal(t.function.name, 'write_files');
    assert.ok(t.function.parameters);
  });

  it('maps tool choice for OpenAI', () => {
    assert.equal(toOpenAIToolChoice('auto'), 'auto');
    assert.equal(toOpenAIToolChoice('required'), 'required');
    assert.deepEqual(toOpenAIToolChoice({ name: 'write_files' }), { type: 'function', function: { name: 'write_files' } });
    assert.equal(toOpenAIToolChoice(undefined), undefined);
  });
});

describe('extractAnthropicToolCalls', () => {
  it('pulls tool_use blocks out of mixed content', () => {
    const content = [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'here you go' },
      { type: 'tool_use', id: 'tu_1', name: 'write_files', input: { actions: [{ path: 'a.ts', operation: 'CREATE', content: 'x', description: 'd' }] } },
    ];
    const calls = extractAnthropicToolCalls(content as never);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, 'tu_1');
    assert.equal(calls[0].name, 'write_files');
    assert.ok(Array.isArray((calls[0].args as any).actions));
  });

  it('returns [] for content without tool_use or for undefined', () => {
    assert.deepEqual(extractAnthropicToolCalls([{ type: 'text', text: 'hi' }] as never), []);
    assert.deepEqual(extractAnthropicToolCalls(undefined), []);
  });
});

describe('extractOpenAIToolCalls', () => {
  it('parses tool_calls and JSON-decodes arguments', () => {
    const message = {
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'write_files', arguments: JSON.stringify({ actions: [{ path: 'b.ts', operation: 'CREATE', content: 'y', description: 'd' }] }) } },
      ],
    };
    const calls = extractOpenAIToolCalls(message);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'write_files');
    assert.equal((calls[0].args as any).actions[0].path, 'b.ts');
  });

  it('treats malformed argument JSON as empty args (never feeds junk downstream)', () => {
    const calls = extractOpenAIToolCalls({ tool_calls: [{ id: 'c', function: { name: 'write_files', arguments: '{ not json' } }] });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, {});
  });

  it('returns [] when there are no tool calls', () => {
    assert.deepEqual(extractOpenAIToolCalls({}), []);
    assert.deepEqual(extractOpenAIToolCalls(undefined), []);
  });
});

describe('OpenAIToolCallAccumulator (streaming)', () => {
  it('reassembles fragmented argument deltas keyed by index', () => {
    const acc = new OpenAIToolCallAccumulator();
    acc.add([{ index: 0, id: 'c1', function: { name: 'write_files', arguments: '{"actions":[' } }]);
    acc.add([{ index: 0, function: { arguments: '{"path":"x.ts","operation":"CREATE",' } }]);
    acc.add([{ index: 0, function: { arguments: '"content":"z","description":"d"}]}' } }]);
    const calls = acc.finalize();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'write_files');
    assert.equal((calls[0].args as any).actions[0].path, 'x.ts');
  });

  it('handles multiple concurrent tool calls by index', () => {
    const acc = new OpenAIToolCallAccumulator();
    acc.add([
      { index: 0, id: 'a', function: { name: 'write_files', arguments: '{"actions":[]}' } },
      { index: 1, id: 'b', function: { name: 'other', arguments: '{}' } },
    ]);
    const calls = acc.finalize();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => c.name), ['write_files', 'other']);
  });

  it('skips entries that never received a name', () => {
    const acc = new OpenAIToolCallAccumulator();
    acc.add([{ index: 0, function: { arguments: '{}' } }]);
    assert.equal(acc.finalize().length, 0);
  });
});

describe('toolCallsToActions bridge', () => {
  it('validates write_files actions with the same rules as the text parser', () => {
    const actions = toolCallsToActions([
      {
        id: 'c', name: 'write_files', args: {
          actions: [
            { path: 'src/ok.ts', operation: 'CREATE', content: 'x', description: 'good' },
            { path: '../escape.ts', operation: 'CREATE', content: 'x', description: 'traversal' }, // dropped
            { path: '/etc/passwd', operation: 'MODIFY', content: 'x', description: 'absolute' },    // dropped
          ],
        },
      },
    ]);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].path, 'src/ok.ts');
    assert.equal(actions[0].operation, 'CREATE');
  });

  it('ignores tool calls that are not write_files', () => {
    assert.equal(toolCallsToActions([{ id: 'x', name: 'search_web', args: { q: 'hi' } }]).length, 0);
  });

  it('returns [] for empty/undefined input', () => {
    assert.equal(toolCallsToActions([]).length, 0);
    assert.equal(toolCallsToActions(undefined).length, 0);
  });
});
