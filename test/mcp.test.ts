import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMCPMessage } from '../src/mcp.js';
import { createMCPServerConfig, renderMCPConfig } from '../src/mcp-config.js';
import { createSWDReceipt, saveSWDReceipt } from '../src/receipts.js';

async function withTempProject<T>(prefix: string, fn: (dir: string) => Promise<T> | T): Promise<T> {
  const original = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(original);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('MCP adapter', () => {
  it('renders paste-ready MCP client config', () => {
    const config = createMCPServerConfig();
    assert.equal(config.mcpServers['mythos-router'].command, 'mythos');
    assert.deepEqual(config.mcpServers['mythos-router'].args, ['mcp']);

    const rendered = renderMCPConfig('cursor');
    assert.match(rendered, /Mythos MCP config \(Cursor\)/);
    assert.match(rendered, /"mythos-router"/);
    assert.match(rendered, /"args": \[\s+"mcp"\s+\]/);
  });

  it('initializes with tool capability metadata', async () => {
    const response = await handleMCPMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.0' },
      },
    });

    assert.equal(response?.jsonrpc, '2.0');
    assert.equal(response?.id, 1);
    assert.ok(response && 'result' in response);
    assert.equal(response.result.protocolVersion, '2025-06-18');
    assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
  });

  it('lists SWD, receipt, and skill tools with safety annotations', async () => {
    const response = await handleMCPMessage({
      jsonrpc: '2.0',
      id: 'tools',
      method: 'tools/list',
    });

    assert.ok(response && 'result' in response);
    const tools = response.result.tools as Array<{ name: string; annotations?: Record<string, unknown> }>;
    const names = tools.map((tool) => tool.name);

    assert.ok(names.includes('swd_validate'));
    assert.ok(names.includes('swd_dry_run'));
    assert.ok(names.includes('swd_apply'));
    assert.ok(names.includes('receipts_list'));
    assert.ok(names.includes('receipts_show'));
    assert.ok(names.includes('receipts_verify'));
    assert.ok(names.includes('skills_list'));
    assert.equal(tools.find((tool) => tool.name === 'swd_dry_run')?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((tool) => tool.name === 'swd_validate')?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((tool) => tool.name === 'swd_apply')?.annotations?.destructiveHint, true);
  });

  it('validates external actions through MCP without writing files', async () => {
    await withTempProject('mythos-mcp-validate-', async () => {
      const response = await handleMCPMessage({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'swd_validate',
          arguments: {
            contract: {
              allowedPaths: ['src/**'],
              expectedOutputs: ['src/mcp-validated.ts'],
            },
            actions: [
              {
                path: 'src/mcp-validated.ts',
                operation: 'CREATE',
                description: 'Validate MCP action',
                content: 'export const ok = true;\n',
              },
            ],
          },
        },
      });

      assert.ok(response && 'result' in response);
      assert.equal(response.result.isError, false);
      const structured = response.result.structuredContent as { ok: boolean; contract?: { ok: boolean } };
      assert.equal(structured.ok, true);
      assert.equal(structured.contract?.ok, true);
      assert.equal(existsSync(join('src', 'mcp-validated.ts')), false);
    });
  });

  it('dry-runs external actions without writing files', async () => {
    await withTempProject('mythos-mcp-dryrun-', async () => {
      const response = await handleMCPMessage({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'swd_dry_run',
          arguments: {
            actions: [
              {
                path: 'planned.txt',
                operation: 'CREATE',
                intent: 'MUTATE',
                description: 'Plan a file write',
                content: 'planned only',
              },
            ],
            agentId: 'mcp-test',
            modelId: 'manual',
          },
        },
      });

      assert.ok(response && 'result' in response);
      assert.equal(response.result.isError, false);
      const structured = response.result.structuredContent as { ok: boolean; mode: string };
      assert.equal(structured.ok, true);
      assert.equal(structured.mode, 'dry-run');
      assert.equal(existsSync('planned.txt'), false);
    });
  });

  it('returns tool errors for blocked sensitive paths', async () => {
    await withTempProject('mythos-mcp-blocked-', async () => {
      const response = await handleMCPMessage({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'swd_apply',
          arguments: {
            actions: [
              {
                path: '.env',
                operation: 'CREATE',
                description: 'Attempt secret write',
                content: 'SECRET=bad',
              },
            ],
          },
        },
      });

      assert.ok(response && 'result' in response);
      assert.equal(response.result.isError, true);
      const structured = response.result.structuredContent as { ok: boolean; rejected: Array<{ risk: string }> };
      assert.equal(structured.ok, false);
      assert.equal(structured.rejected[0]?.risk, 'block');
      assert.equal(existsSync('.env'), false);
    });
  });

  it('returns PR-ready receipt markdown through receipts_show', async () => {
    await withTempProject('mythos-mcp-receipt-md-', async () => {
      const receipt = createSWDReceipt({
        request: 'external agent failed write',
        summary: 'MODIFY: failed.txt',
        provider: {
          providerId: 'external:mcp-agent',
          modelId: 'manual',
        },
        result: {
          success: false,
          rolledBack: true,
          rollbackErrors: [],
          errors: ['Hash mismatch after write'],
          results: [
            {
              action: {
                path: 'failed.txt',
                operation: 'MODIFY',
                intent: 'MUTATE',
                description: 'Update failed file',
              },
              status: 'drift',
              detail: 'Hash mismatch after MODIFY failed.txt',
            },
          ],
        },
      });
      saveSWDReceipt(receipt);

      const response = await handleMCPMessage({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'receipts_show',
          arguments: {
            target: receipt.id,
            format: 'markdown',
          },
        },
      });

      assert.ok(response && 'result' in response);
      assert.equal(response.result.isError, false);
      const structured = response.result.structuredContent as { ok: boolean; markdown: string };
      assert.equal(structured.ok, true);
      assert.match(structured.markdown, /### Mythos SWD Receipt/);
      assert.match(structured.markdown, /\| Status \| failed \(rolled back\) \|/);
      assert.match(structured.markdown, /Hash mismatch after write/);
      const content = response.result.content as Array<{ type: string; text: string }>;
      assert.match(content[0]!.text, new RegExp(`mythos receipts verify ${receipt.id}`));
    });
  });
});
