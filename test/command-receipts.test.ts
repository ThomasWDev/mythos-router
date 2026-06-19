import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { receiptsCommand } from '../src/commands/receipts.js';
import { createSWDReceipt, saveSWDReceipt } from '../src/receipts.js';
import type { SWDRunResult } from '../src/swd.js';
import { captureRun, withTempCwd, stripAnsi } from './support.js';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('receiptsCommand', () => {
  async function withSeededReceipt(fn: (id: string, dir: string) => Promise<void>): Promise<void> {
    await withTempCwd(async (dir) => {
      const rel = 'index.ts';
      const content = 'export const ok = true;\n';
      writeFileSync(join(dir, rel), content);

      const result: SWDRunResult = {
        success: true,
        rolledBack: false,
        rollbackErrors: [],
        errors: [],
        results: [{
          action: { path: rel, operation: 'MODIFY', intent: 'MUTATE', description: 'edit' },
          status: 'verified',
          detail: `Verified: MODIFY ${rel}`,
          after: { path: join(dir, rel), exists: true, size: content.length, mtime: 1, hash: sha256(content) },
        }],
      };
      const receipt = createSWDReceipt({ request: 'edit', summary: `MODIFY: ${rel}`, result });
      saveSWDReceipt(receipt);
      await fn(receipt.id, dir);
    });
  }

  it('lists receipts as JSON', async () => {
    await withSeededReceipt(async (id) => {
      const { output } = await captureRun(() => receiptsCommand('list', undefined, { json: true }));
      const list = JSON.parse(output);
      assert.ok(Array.isArray(list));
      assert.ok(list.some((r: { id: string }) => r.id === id));
    });
  });

  it('shows a receipt as JSON', async () => {
    await withSeededReceipt(async (id) => {
      const { output } = await captureRun(() => receiptsCommand('show', id, { json: true }));
      const receipt = JSON.parse(output);
      assert.equal(receipt.id, id);
    });
  });

  it('shows a receipt as markdown', async () => {
    await withSeededReceipt(async (id) => {
      const { output } = await captureRun(() => receiptsCommand('show', id, { markdown: true }));
      assert.ok(output.includes('### Mythos SWD Receipt'));
      assert.ok(output.includes(id));
    });
  });

  it('renders the human-readable receipt view', async () => {
    await withSeededReceipt(async (id) => {
      const { output } = await captureRun(() => receiptsCommand('show', id, {}));
      assert.ok(stripAnsi(output).includes(id));
    });
  });

  it('verifies a single receipt as JSON', async () => {
    await withSeededReceipt(async (id) => {
      const { output, exitCode } = await captureRun(() => receiptsCommand('verify', id, { json: true }));
      const verification = JSON.parse(output);
      assert.equal(verification.ok, true);
      assert.equal(verification.integrityOk, true);
      assert.notEqual(exitCode, 1);
    });
  });

  it('verifies all receipts when no target is given', async () => {
    await withSeededReceipt(async () => {
      const { output } = await captureRun(() => receiptsCommand('verify', undefined, { json: true }));
      const summary = JSON.parse(output);
      assert.ok(summary.count >= 1);
      assert.equal(summary.ok, true);
    });
  });

  it('rejects an unsupported --format', async () => {
    await withSeededReceipt(async (id) => {
      const { exitCode } = await captureRun(() => receiptsCommand('show', id, { format: 'xml' }));
      assert.equal(exitCode, 1);
    });
  });

  it('warns on an unknown action', async () => {
    await withSeededReceipt(async () => {
      const { output } = await captureRun(() => receiptsCommand('frobnicate', undefined, {}));
      assert.ok(stripAnsi(output).includes('Unknown receipts action'));
    });
  });
});
