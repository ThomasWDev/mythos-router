import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSWDReceipt,
  listReceipts,
  readReceipt,
  saveSWDReceipt,
  verifyReceipt,
  verifyReceiptIntegrity,
  verifyReceiptChain,
  sanitizeReceiptOutputTail,
  RECEIPT_OUTPUT_TAIL_MAX_CHARS,
} from '../src/receipts.js';
import { formatReceiptMarkdown } from '../src/receipt-markdown.js';
import type { SWDRunResult } from '../src/swd.js';

const originalCwd = process.cwd();
let tempDir = '';

describe('SWD receipts', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mythos-receipts-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('saves, lists, reads, and verifies a receipt', () => {
    const beforeContent = 'before';
    const afterContent = 'after';
    const filePath = 'sample.txt';
    const absPath = join(tempDir, filePath);

    writeFileSync(absPath, afterContent, 'utf-8');

    const runResult: SWDRunResult = {
      success: true,
      rolledBack: false,
      rollbackErrors: [],
      rollbackStatus: 'not-needed',
      recoveryRequired: false,
      errors: [],
      results: [
        {
          action: {
            path: filePath,
            operation: 'MODIFY',
            intent: 'MUTATE',
            description: 'Update sample file',
          },
          status: 'verified',
          detail: `Verified: MODIFY ${filePath}`,
          before: {
            path: absPath,
            exists: true,
            size: beforeContent.length,
            mtime: 1,
            hash: sha256(beforeContent),
          },
          after: {
            path: absPath,
            exists: true,
            size: afterContent.length,
            mtime: 2,
            hash: sha256(afterContent),
          },
        },
      ],
    };

    const receipt = createSWDReceipt({
      request: 'change sample',
      summary: 'MODIFY: sample.txt',
      result: runResult,
      usage: {
        inputTokens: 100,
        outputTokens: 25,
      },
      skills: [
        {
          id: 'repo',
          name: 'repo',
          version: '1.0.0',
          source: 'project',
          path: '.mythos/skills/repo/SKILL.md',
        },
        {
          id: 'personal',
          name: 'personal',
          version: '0.1.0',
          source: 'global',
          path: join(tmpdir(), 'personal', 'SKILL.md'),
        },
      ],
    });

    const savedPath = saveSWDReceipt(receipt);
    assert.ok(savedPath?.endsWith(`${receipt.id}.json`));

    const listed = listReceipts();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, receipt.id);
    assert.equal(listed[0]!.rollbackStatus, 'not-needed');
    assert.equal(listed[0]!.recoveryRequired, false);

    const loaded = readReceipt(receipt.id);
    assert.equal(loaded?.id, receipt.id);
    assert.equal(loaded?.swd.rollbackStatus, 'not-needed');
    assert.equal(loaded?.swd.recoveryRequired, false);
    assert.equal(loaded ? verifyReceiptIntegrity(loaded) : false, true);

    const verification = verifyReceipt(receipt);
    assert.equal(verification.ok, true);
    assert.equal(verification.files[0]!.status, 'ok');
    assert.equal(receipt.files[0]!.after?.path, filePath);
    assert.equal(receipt.skills?.[0]?.id, 'repo');
    assert.equal(receipt.skills?.[0]?.source, 'project');
    assert.equal(receipt.skills?.[0]?.path, '.mythos/skills/repo/SKILL.md');
    assert.equal(receipt.skills?.[1]?.id, 'personal');
    assert.equal(receipt.skills?.[1]?.path, undefined);
  });

  it('refuses to read receipts from outside the receipts directory', () => {
    const receipt = createSWDReceipt({
      request: 'jail check',
      summary: 'jail check',
      result: { success: true, results: [], rolledBack: false, rollbackErrors: [], errors: [] },
    });
    saveSWDReceipt(receipt);

    // A JSON file outside .mythos/receipts must not be readable by path.
    const outside = join(tempDir, 'outside.json');
    writeFileSync(outside, JSON.stringify({ id: 'evil', secret: 'do-not-read' }), 'utf-8');

    assert.equal(readReceipt(outside), null, 'absolute path outside receipts dir must be rejected');
    assert.equal(readReceipt('../../outside'), null, 'parent-traversal id must be rejected');

    // The legitimate id still resolves inside the jail.
    assert.equal(readReceipt(receipt.id)?.id, receipt.id);
  });


  it('does not follow symlinked receipt files during reads or chain verification', (t) => {
    const receipt = createSWDReceipt({
      request: 'receipt symlink',
      summary: 'receipt symlink',
      result: { success: true, rolledBack: false, rollbackErrors: [], errors: [], results: [] },
    });
    const savedPath = saveSWDReceipt(receipt);
    const outsideReceipt = join(tempDir, 'outside-receipt.json');
    writeFileSync(outsideReceipt, readFileSync(savedPath, 'utf8'));
    const linkedId = 'swd-linked-receipt';
    const linkedPath = join(tempDir, '.mythos', 'receipts', `${linkedId}.json`);
    try {
      symlinkSync(outsideReceipt, linkedPath, 'file');
    } catch {
      t.skip('File symlinks are not available in this environment');
      return;
    }

    assert.equal(readReceipt(linkedId), null);
    const chain = verifyReceiptChain();
    assert.equal(chain.ok, false);
    assert.match(chain.reason ?? '', /unreadable|invalid JSON/i);
  });

  it('normalizes receipt paths even when cwd is a symlinked project root', (t) => {
    const filePath = 'linked-root.txt';
    const absPath = join(tempDir, filePath);
    const linkParent = mkdtempSync(join(tmpdir(), 'mythos-receipts-link-'));
    const linkDir = join(linkParent, 'project');

    try {
      symlinkSync(tempDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      rmSync(linkParent, { recursive: true, force: true });
      t.skip('Directory symlinks are not available in this environment');
      return;
    }

    try {
      process.chdir(linkDir);
      writeFileSync(absPath, 'linked content', 'utf-8');

      const receipt = createSWDReceipt({
        request: 'change linked file',
        summary: 'MODIFY: linked-root.txt',
        result: {
          success: true,
          rolledBack: false,
          rollbackErrors: [],
          errors: [],
          results: [
            {
              action: {
                path: filePath,
                operation: 'MODIFY',
                intent: 'MUTATE',
                description: 'Update linked-root file',
              },
              status: 'verified',
              detail: `Verified: MODIFY ${filePath}`,
              before: {
                path: absPath,
                exists: true,
                size: 0,
                mtime: 1,
                hash: sha256(''),
              },
              after: {
                path: absPath,
                exists: true,
                size: 'linked content'.length,
                mtime: 2,
                hash: sha256('linked content'),
              },
            },
          ],
        },
      });

      assert.equal(receipt.files[0]!.path, filePath);
      assert.equal(receipt.files[0]!.before?.path, filePath);
      assert.equal(receipt.files[0]!.after?.path, filePath);
      assert.equal(verifyReceipt(receipt).ok, true);
    } finally {
      process.chdir(tempDir);
      rmSync(linkParent, { recursive: true, force: true });
    }
  });

  it('detects drift from the expected receipt state', () => {
    const filePath = 'drift.txt';
    const absPath = join(tempDir, filePath);
    writeFileSync(absPath, 'expected', 'utf-8');

    const receipt = createSWDReceipt({
      request: 'create drift file',
      summary: 'CREATE: drift.txt',
      result: {
        success: true,
        rolledBack: false,
        rollbackErrors: [],
        errors: [],
        results: [
          {
            action: {
              path: filePath,
              operation: 'CREATE',
              intent: 'MUTATE',
              description: 'Create drift file',
            },
            status: 'verified',
            detail: `Verified: CREATE ${filePath}`,
            before: {
              path: absPath,
              exists: false,
              size: 0,
              mtime: 0,
              hash: '',
            },
            after: {
              path: absPath,
              exists: true,
              size: 'expected'.length,
              mtime: 1,
              hash: sha256('expected'),
            },
          },
        ],
      },
    });

    writeFileSync(absPath, 'changed', 'utf-8');

    const verification = verifyReceipt(receipt);
    assert.equal(verification.ok, false);
    assert.equal(verification.files[0]!.status, 'drifted');
  });


  it('treats existing receipt ids as append-only while allowing idempotent re-save', () => {
    const receipt = createSWDReceipt({
      request: 'append only',
      summary: 'append only',
      result: { success: true, rolledBack: false, rollbackErrors: [], errors: [], results: [] },
    });

    const firstPath = saveSWDReceipt(receipt);
    const firstBytes = readFileSync(firstPath, 'utf8');
    assert.equal(saveSWDReceipt(receipt), firstPath);
    assert.equal(readFileSync(firstPath, 'utf8'), firstBytes);

    receipt.summary = 'attempted rewrite';
    assert.throws(() => saveSWDReceipt(receipt), /append-only|overwrite existing receipt/i);
    assert.equal(readFileSync(firstPath, 'utf8'), firstBytes);
  });

  it('rejects unsafe receipt ids before constructing a store path', () => {
    const receipt = createSWDReceipt({
      request: 'unsafe id',
      summary: 'unsafe id',
      result: { success: true, rolledBack: false, rollbackErrors: [], errors: [], results: [] },
    });
    receipt.id = '../../outside';

    assert.throws(() => saveSWDReceipt(receipt), /invalid receipt id/i);
    assert.equal(readdirSync(tempDir).includes('outside.json'), false);
  });

  it('refuses to use a symlinked receipts directory', (t) => {
    const outside = mkdtempSync(join(tmpdir(), 'mythos-receipts-outside-'));
    mkdirSync(join(tempDir, '.mythos'));
    try {
      symlinkSync(outside, join(tempDir, '.mythos', 'receipts'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      rmSync(outside, { recursive: true, force: true });
      t.skip('Directory symlinks are not available in this environment');
      return;
    }

    try {
      const receipt = createSWDReceipt({
        request: 'store jail',
        summary: 'store jail',
        result: { success: true, rolledBack: false, rollbackErrors: [], errors: [], results: [] },
      });
      assert.throws(() => saveSWDReceipt(receipt), /SECURITY VIOLATION|symlink/i);
      assert.deepEqual(readdirSync(outside), []);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('checks receipt integrity before resolving or opening referenced paths', () => {
    const outside = join(tempDir, '..', `outside-${Date.now()}.txt`);
    writeFileSync(outside, 'secret outside content', 'utf8');
    try {
      const receipt = createSWDReceipt({
        request: 'integrity first',
        summary: 'integrity first',
        result: { success: true, rolledBack: false, rollbackErrors: [], errors: [], results: [] },
      });
      receipt.files = [{
        path: outside,
        operation: 'MODIFY',
        intent: 'MUTATE',
        status: 'verified',
        detail: 'malicious path',
        expectedSource: 'after',
        expected: {
          path: outside,
          exists: true,
          size: 22,
          mtime: 1,
          sha256: sha256('secret outside content'),
        },
      }];
      // Deliberately leave the old integrity hash in place.
      const verification = verifyReceipt(receipt);
      assert.equal(verification.integrityOk, false);
      assert.equal(verification.ok, false);
      assert.equal(verification.files[0]!.status, 'unknown');
      assert.match(verification.files[0]!.detail, /were not opened/i);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('rejects a self-consistent receipt path that escapes the project', () => {
    const outside = join(tempDir, '..', `outside-${Date.now()}.txt`);
    writeFileSync(outside, 'outside', 'utf8');
    try {
      const receipt = createSWDReceipt({
        request: 'path jail',
        summary: 'path jail',
        result: { success: true, rolledBack: false, rollbackErrors: [], errors: [], results: [] },
      });
      receipt.files = [{
        path: '../outside.txt',
        operation: 'MODIFY',
        intent: 'MUTATE',
        status: 'verified',
        detail: 'malicious path',
        expectedSource: 'after',
        expected: {
          path: '../outside.txt',
          exists: true,
          size: 7,
          mtime: 1,
          sha256: sha256('outside'),
        },
      }];
      rehashReceipt(receipt);

      const verification = verifyReceipt(receipt);
      assert.equal(verification.integrityOk, true);
      assert.equal(verification.ok, false);
      assert.equal(verification.files[0]!.status, 'unknown');
      assert.match(verification.files[0]!.detail, /SECURITY VIOLATION|path traversal/i);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('refuses to hash a receipt target reached through a symlink', (t) => {
    const outside = join(tempDir, '..', `outside-${Date.now()}.txt`);
    const link = join(tempDir, 'linked.txt');
    writeFileSync(outside, 'outside', 'utf8');
    try {
      symlinkSync(outside, link, 'file');
    } catch {
      rmSync(outside, { force: true });
      t.skip('File symlinks are not available in this environment');
      return;
    }

    try {
      const receipt = createSWDReceipt({
        request: 'symlink target',
        summary: 'symlink target',
        result: {
          success: true,
          rolledBack: false,
          rollbackErrors: [],
          errors: [],
          results: [{
            action: { path: 'linked.txt', operation: 'MODIFY', intent: 'MUTATE', description: 'linked' },
            status: 'verified',
            detail: 'linked',
            after: { path: link, exists: true, size: 7, mtime: 1, hash: sha256('outside') },
          }],
        },
      });

      const verification = verifyReceipt(receipt);
      assert.equal(verification.integrityOk, true);
      assert.equal(verification.ok, false);
      assert.equal(verification.files[0]!.status, 'unknown');
      assert.match(verification.files[0]!.detail, /symlink|path traversal|SECURITY VIOLATION/i);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('streams large-file hashes without changing verification semantics', () => {
    const content = Buffer.alloc(8 * 1024 * 1024, 0x61);
    const filePath = 'large.bin';
    const absPath = join(tempDir, filePath);
    writeFileSync(absPath, content);

    const receipt = createSWDReceipt({
      request: 'verify large file',
      summary: 'MODIFY: large.bin',
      result: {
        success: true,
        rolledBack: false,
        rollbackErrors: [],
        errors: [],
        results: [{
          action: { path: filePath, operation: 'MODIFY', intent: 'MUTATE', description: 'large' },
          status: 'verified',
          detail: 'large',
          after: { path: absPath, exists: true, size: content.length, mtime: 1, hash: createHash('sha256').update(content).digest('hex') },
        }],
      },
    });

    const verification = verifyReceipt(receipt);
    assert.equal(verification.integrityOk, true);
    assert.equal(verification.ok, true);
  });

  it('sanitizes receipt test output tails before storage', () => {
    const longPrefix = 'a'.repeat(RECEIPT_OUTPUT_TAIL_MAX_CHARS + 25);
    const output = `${longPrefix}
OPENAI_API_KEY=sk-proj-${'x'.repeat(32)}
Authorization: Bearer ${'y'.repeat(40)}
`;

    const tail = sanitizeReceiptOutputTail(output);

    assert.ok(tail.length <= RECEIPT_OUTPUT_TAIL_MAX_CHARS + '[REDACTED_SECRET]'.length * 2);
    assert.doesNotMatch(tail, /sk-proj-/);
    assert.doesNotMatch(tail, /Bearer y/);
    assert.match(tail, /\[REDACTED_SECRET\]/);
  });

  it('formats failed receipts as PR-ready markdown', () => {
    const filePath = 'failed.txt';
    const absPath = join(tempDir, filePath);

    const receipt = createSWDReceipt({
      request: 'external agent failed write',
      summary: 'MODIFY: failed.txt',
      provider: {
        providerId: 'external:review-agent',
        modelId: 'manual',
      },
      git: {
        branch: 'main',
        commit: '91f4c2a8d3b1',
      },
      result: {
        success: false,
        rolledBack: true,
        rollbackErrors: [],
        errors: ['Hash mismatch after write'],
        results: [
          {
            action: {
              path: filePath,
              operation: 'MODIFY',
              intent: 'MUTATE',
              description: 'Update failed file',
            },
            status: 'drift',
            detail: `Hash mismatch after MODIFY ${filePath}`,
            before: {
              path: absPath,
              exists: true,
              size: 6,
              mtime: 1,
              hash: sha256('before'),
            },
            after: {
              path: absPath,
              exists: true,
              size: 5,
              mtime: 2,
              hash: sha256('after'),
            },
          },
        ],
      },
    });

    const markdown = formatReceiptMarkdown(receipt);

    assert.match(markdown, /### Mythos SWD Receipt/);
    assert.match(markdown, /\| Status \| failed \(rolled back\) \|/);
    assert.match(markdown, /\| Provider \| `external:review-agent\/manual` \|/);
    assert.match(markdown, /\| drift \| MODIFY \| `failed\.txt` \|/);
    assert.match(markdown, /#### SWD Errors/);
    assert.match(markdown, /Hash mismatch after write/);
    assert.match(markdown, new RegExp(`mythos receipts verify ${receipt.id}`));
  });

  it('escapes receipt markdown code spans without leaving backslash escape gaps', () => {
    const receipt = createSWDReceipt({
      request: 'format markdown edge cases',
      summary: 'CREATE: text\\slash|pipe',
      provider: {
        providerId: 'external:agent\\with`tick|pipe',
        modelId: 'manual\\model`pipe|',
      },
      result: {
        success: true,
        rolledBack: false,
        rollbackErrors: [],
        errors: [],
        results: [],
      },
    });

    const markdown = formatReceiptMarkdown(receipt);

    assert.ok(markdown.includes('| Summary | CREATE: text\\\\slash\\|pipe |'));
    assert.ok(markdown.includes('| Provider | `external:agent\\\\with\\`tick\\|pipe/manual\\\\model\\`pipe\\|` |'));
  });

});

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function rehashReceipt(receipt: import('../src/receipts.js').SWDReceipt): void {
  const { integrity: _integrity, ...payload } = receipt;
  receipt.integrity = { sha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}
