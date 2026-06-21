import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSWDReceipt,
  saveSWDReceipt,
  verifyReceiptChain,
  verifyReceiptIntegrity,
  getReceiptsDir,
  type SWDReceipt,
} from '../src/receipts.js';
import type { SWDRunResult } from '../src/swd.js';

const originalCwd = process.cwd();
let tempDir = '';

// Build + persist a receipt for a single MODIFY action. Each call appends to
// the chain, since saveSWDReceipt links to the current tip.
function appendReceipt(label: string): SWDReceipt {
  const result: SWDRunResult = {
    success: true,
    rolledBack: false,
    rollbackErrors: [],
    errors: [],
    results: [
      {
        action: { path: `file-${label}.txt`, operation: 'MODIFY', intent: 'MUTATE', description: label },
        status: 'verified',
        detail: `Verified: MODIFY file-${label}.txt`,
        after: { path: join(tempDir, `file-${label}.txt`), exists: true, size: 3, mtime: 1, hash: 'a'.repeat(64) },
      },
    ],
  };
  const receipt = createSWDReceipt({ request: label, summary: `MODIFY: file-${label}.txt`, result });
  const filePath = saveSWDReceipt(receipt);
  // The chain + integrity are finalized at save time, so read back the stored
  // receipt rather than the pre-save in-memory object.
  return JSON.parse(readFileSync(filePath, 'utf-8')) as SWDReceipt;
}

// Receipt files (swd-*.json) sorted by chain seq, ascending.
function receiptFilesBySeq(): string[] {
  const dir = getReceiptsDir();
  return readdirSync(dir)
    .filter((f) => f.startsWith('swd-') && f.endsWith('.json'))
    .map((f) => join(dir, f))
    .sort((a, b) => {
      const ra = JSON.parse(readFileSync(a, 'utf-8')) as SWDReceipt;
      const rb = JSON.parse(readFileSync(b, 'utf-8')) as SWDReceipt;
      return (ra.chain?.seq ?? 0) - (rb.chain?.seq ?? 0);
    });
}

describe('receipt hash chain', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mythos-chain-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports no chain when there are no receipts', () => {
    const chain = verifyReceiptChain();
    assert.equal(chain.present, false);
    assert.equal(chain.ok, true);
    assert.equal(chain.length, 0);
  });

  it('assigns contiguous seqs starting at genesis and links each to the previous', () => {
    const a = appendReceipt('a');
    const b = appendReceipt('b');
    const c = appendReceipt('c');

    assert.equal(a.chain?.seq, 0);
    assert.equal(a.chain?.prevHash, ''); // genesis
    assert.equal(b.chain?.seq, 1);
    assert.equal(b.chain?.prevHash, a.integrity?.sha256);
    assert.equal(c.chain?.seq, 2);
    assert.equal(c.chain?.prevHash, b.integrity?.sha256);

    const chain = verifyReceiptChain();
    assert.equal(chain.present, true);
    assert.equal(chain.ok, true);
    assert.equal(chain.length, 3);
    assert.equal(chain.headMatches, true);
  });

  it('detects an in-place edit of a receipt (integrity break)', () => {
    appendReceipt('a');
    appendReceipt('b');
    appendReceipt('c');

    // Tamper with the middle receipt without recomputing its integrity hash.
    const files = receiptFilesBySeq();
    const victim = JSON.parse(readFileSync(files[1], 'utf-8')) as SWDReceipt;
    assert.equal(verifyReceiptIntegrity(victim), true); // sanity: was valid
    victim.summary = 'TAMPERED';
    writeFileSync(files[1], JSON.stringify(victim, null, 2));

    const chain = verifyReceiptChain();
    assert.equal(chain.ok, false);
    assert.equal(chain.brokenAt, 1);
    assert.match(chain.reason ?? '', /edited after creation/i);
  });

  it('detects a deleted middle receipt (chain gap)', () => {
    appendReceipt('a');
    appendReceipt('b');
    appendReceipt('c');

    const files = receiptFilesBySeq();
    unlinkSync(files[1]); // remove seq 1

    const chain = verifyReceiptChain();
    assert.equal(chain.ok, false);
    assert.equal(chain.brokenAt, 1);
    assert.match(chain.reason ?? '', /gap|deleted|reordered|inserted/i);
  });

  it('detects deletion of the latest receipt via the HEAD pointer', () => {
    appendReceipt('a');
    appendReceipt('b');
    appendReceipt('c');

    const files = receiptFilesBySeq();
    unlinkSync(files[files.length - 1]); // remove tip (seq 2); HEAD still points at it

    const chain = verifyReceiptChain();
    assert.equal(chain.ok, false);
    assert.equal(chain.headMatches, false);
    assert.match(chain.reason ?? '', /HEAD|latest|deleted|replaced/i);
  });

  it('detects a broken prevHash link without recomputing integrity', () => {
    appendReceipt('a');
    appendReceipt('b');

    // Rewrite seq 1 with a bogus prevHash AND a matching integrity hash, so the
    // per-receipt integrity check passes but the link to seq 0 is broken.
    const files = receiptFilesBySeq();
    const r = JSON.parse(readFileSync(files[1], 'utf-8')) as SWDReceipt;
    r.chain!.prevHash = 'deadbeef'.repeat(8);
    // Recompute a self-consistent integrity hash over the tampered payload.
    const { integrity: _omit, ...payload } = r;
    r.integrity = { sha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
    writeFileSync(files[1], JSON.stringify(r, null, 2));

    assert.equal(verifyReceiptIntegrity(r), true); // self-consistent, yet...
    const chain = verifyReceiptChain();
    assert.equal(chain.ok, false); // ...the link is broken
    assert.match(chain.reason ?? '', /link|prevHash/i);
  });

  it('ignores legacy receipts that predate chaining', () => {
    // A receipt with no `chain` field (as written by older versions) must not
    // be treated as a broken chain.
    const legacy = createSWDReceipt({
      request: 'legacy',
      summary: 'MODIFY: legacy.txt',
      result: {
        success: true,
        rolledBack: false,
        rollbackErrors: [],
        errors: [],
        results: [
          {
            action: { path: 'legacy.txt', operation: 'MODIFY', intent: 'MUTATE', description: 'legacy' },
            status: 'verified',
            detail: 'Verified',
            after: { path: join(tempDir, 'legacy.txt'), exists: true, size: 1, mtime: 1, hash: 'b'.repeat(64) },
          },
        ],
      },
    });
    delete legacy.chain;
    const dir = getReceiptsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${legacy.id}.json`), JSON.stringify(legacy, null, 2));

    const chain = verifyReceiptChain();
    assert.equal(chain.present, false);
    assert.equal(chain.ok, true);
  });
});
