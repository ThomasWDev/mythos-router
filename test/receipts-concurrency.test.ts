import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CHAIN_HEAD_FILE,
  RECEIPT_STORE_LOCK_FILE,
  getReceiptsDir,
  verifyReceiptChain,
  type SWDReceipt,
} from '../src/receipts.js';

const originalCwd = process.cwd();
const receiptsModuleUrl = pathToFileURL(join(originalCwd, 'src', 'receipts.ts')).href;
let tempDir = '';

describe('concurrent receipt writers', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mythos-receipts-concurrent-'));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('serializes independent processes into one contiguous chain', async () => {
    const writerCount = 12;
    await Promise.all(Array.from({ length: writerCount }, (_, index) => runWriter(index)));

    process.chdir(tempDir);
    const verification = verifyReceiptChain();
    assert.equal(verification.ok, true, verification.reason);
    assert.equal(verification.length, writerCount);
    assert.equal(verification.headMatches, true);

    const dir = getReceiptsDir();
    const receiptFiles = readdirSync(dir)
      .filter((entry) => entry.startsWith('swd-') && entry.endsWith('.json'));
    assert.equal(receiptFiles.length, writerCount);

    const sequences = receiptFiles
      .map((entry) => JSON.parse(readFileSync(join(dir, entry), 'utf8')) as SWDReceipt)
      .map((receipt) => receipt.chain!.seq)
      .sort((left, right) => left - right);
    assert.deepEqual(sequences, Array.from({ length: writerCount }, (_, index) => index));

    assert.equal(existsSync(join(dir, RECEIPT_STORE_LOCK_FILE)), false);
    assert.equal(existsSync(join(dir, CHAIN_HEAD_FILE)), true);
    assert.deepEqual(
      readdirSync(dir).filter((entry) => entry.startsWith('.mythos-atomic-')),
      [],
    );
  });
});

function runWriter(index: number): Promise<void> {
  const script = `
    const { createSWDReceipt, saveSWDReceipt } = await import(${JSON.stringify(receiptsModuleUrl)});
    process.chdir(process.env.MYTHOS_TEST_PROJECT);
    const label = process.env.MYTHOS_TEST_LABEL;
    const file = 'file-' + label + '.txt';
    const result = {
      success: true,
      rolledBack: false,
      rollbackErrors: [],
      errors: [],
      results: [{
        action: { path: file, operation: 'CREATE', intent: 'MUTATE', description: label },
        status: 'verified',
        detail: 'Verified: CREATE ' + file,
        after: { path: file, exists: true, size: 1, mtime: 1, hash: 'a'.repeat(64) },
      }],
    };
    const receipt = createSWDReceipt({ request: 'writer-' + label, summary: 'CREATE: ' + file, result });
    saveSWDReceipt(receipt, false);
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: originalCwd,
      env: {
        ...process.env,
        MYTHOS_TEST_PROJECT: tempDir,
        MYTHOS_TEST_LABEL: String(index),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`receipt writer ${index} exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
}
