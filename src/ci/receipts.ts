import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangedFile, CIFinding } from './types.js';
import { verifyReceiptIntegrity, verifyReceiptChain, RECEIPTS_DIR, type SWDReceipt } from '../receipts.js';

export interface ReceiptReview {
  checked: boolean;
  changedReceiptCount: number;
  validReceiptCount: number;
  coveredChangedFileCount: number;
  uncoveredChangedFiles: string[];
  chainChecked: boolean;
  chainOk: boolean;
  chainLength: number;
  findings: CIFinding[];
}

function normalized(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

// A real receipt file: `.mythos/receipts/swd-*.json`. Used for counting and
// integrity/chain verification.
function isReceiptPath(filePath: string): boolean {
  return /^\.mythos\/receipts\/swd-[^/]*\.json$/i.test(normalized(filePath));
}

// Any JSON under the receipts dir — receipts plus the chain-head pointer. These
// are Mythos's own bookkeeping, never project files that need receipt coverage,
// so they are excluded from the coverage set.
function isReceiptArtifactPath(filePath: string): boolean {
  return /^\.mythos\/receipts\/.*\.json$/i.test(normalized(filePath));
}

function isReceiptFileChanged(file: ChangedFile): boolean {
  return isReceiptPath(file.path);
}

function parseReceipt(cwd: string, filePath: string): SWDReceipt | null {
  try {
    return JSON.parse(readFileSync(join(cwd, filePath), 'utf-8')) as SWDReceipt;
  } catch {
    return null;
  }
}

export function reviewChangedReceipts(cwd: string, changedFiles: ChangedFile[]): ReceiptReview {
  const receiptFiles = changedFiles.filter(isReceiptFileChanged);
  const findings: CIFinding[] = [];
  const coveredFiles = new Set<string>();
  let validReceiptCount = 0;

  for (const file of receiptFiles) {
    if (file.status === 'deleted') {
      findings.push({
        id: 'mythos-receipt-deleted',
        severity: 'warn',
        title: 'Mythos receipt deleted',
        file: file.path,
        evidence: [`${file.path} was deleted`],
        why: 'Receipts are local audit records for SWD-verified file actions. Deleting a committed receipt removes audit context.',
        recommendation: 'Confirm the receipt was intentionally removed, or keep receipts private and gitignored if they should not be committed.',
      });
      continue;
    }

    if (!existsSync(join(cwd, file.path))) continue;
    const receipt = parseReceipt(cwd, file.path);
    if (!receipt) {
      findings.push({
        id: 'mythos-receipt-invalid-json',
        severity: 'warn',
        title: 'Mythos receipt is not valid JSON',
        file: file.path,
        evidence: [`${file.path} could not be parsed`],
        why: 'Invalid receipt files cannot be used to verify SWD-covered changes.',
        recommendation: 'Regenerate the receipt or remove it from the PR if it was not intended to be committed.',
      });
      continue;
    }

    validReceiptCount++;
    for (const receiptFile of receipt.files ?? []) {
      if (receiptFile.path) coveredFiles.add(normalized(receiptFile.path));
    }

    if (!verifyReceiptIntegrity(receipt)) {
      findings.push({
        id: 'mythos-receipt-integrity-mismatch',
        severity: 'warn',
        title: 'Mythos receipt integrity mismatch',
        file: file.path,
        evidence: [`${file.path} integrity hash does not match its payload`],
        why: 'A receipt integrity mismatch means the receipt may have been edited after it was created.',
        recommendation: 'Regenerate the receipt from a fresh Mythos run or review why the committed receipt was edited.',
      });
    }
  }

  const changedNonReceiptFiles = changedFiles
    .filter((file) => file.status !== 'deleted')
    .map((file) => normalized(file.path))
    .filter((filePath) => !isReceiptArtifactPath(filePath));
  const uncoveredChangedFiles = receiptFiles.length === 0
    ? []
    : changedNonReceiptFiles.filter((filePath) => !coveredFiles.has(filePath));

  if (receiptFiles.length > 0 && uncoveredChangedFiles.length > 0) {
    findings.push({
      id: 'mythos-receipt-coverage-mismatch',
      severity: 'warn',
      title: 'Changed files are not covered by changed Mythos receipts',
      evidence: uncoveredChangedFiles.slice(0, 12),
      why: 'When receipts are committed with a PR, they should cover the SWD-generated files they are meant to verify.',
      recommendation: 'Regenerate receipts for the final set of Mythos-generated changes, or keep receipts uncommitted if they are private/local only.',
    });
  }

  // Append-only chain verification. Only meaningful when receipts changed in
  // this diff; verifies the full chain present in the checked-out tree so a
  // deleted, reordered, or forged receipt is caught — not just an in-place edit.
  let chain = { present: false, ok: true, length: 0 } as ReturnType<typeof verifyReceiptChain>;
  if (receiptFiles.length > 0) {
    chain = verifyReceiptChain(join(cwd, RECEIPTS_DIR));
    if (chain.present && !chain.ok) {
      findings.push({
        id: 'mythos-receipt-chain-broken',
        severity: 'high',
        title: 'Mythos receipt chain is broken',
        evidence: [chain.reason ?? 'The receipt hash chain failed verification.', `Break near seq ${chain.brokenAt ?? 'unknown'}`],
        why: 'Receipts are an append-only, hash-chained audit trail. A broken chain means a receipt was deleted, reordered, forged, or edited after the fact — the audit trail can no longer be trusted as complete.',
        recommendation: 'Investigate why the receipt chain changed. Restore the removed/edited receipt, or regenerate the chain from fresh Mythos runs if the history was rewritten intentionally.',
      });
    }
  }

  return {
    checked: receiptFiles.length > 0,
    changedReceiptCount: receiptFiles.length,
    validReceiptCount,
    coveredChangedFileCount: changedNonReceiptFiles.length - uncoveredChangedFiles.length,
    uncoveredChangedFiles,
    chainChecked: chain.present,
    chainOk: chain.ok,
    chainLength: chain.length,
    findings,
  };
}
