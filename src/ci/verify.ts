import { getDiffInfo } from './git.js';
import { analyzeChangedFiles } from './rules.js';
import { reviewChangedReceipts } from './receipts.js';
import { sortFindings, summarizeFindings } from './report.js';
import type { CIVerifyOptions, CIVerifyReport } from './types.js';

export function runCIVerification(options: CIVerifyOptions = {}): CIVerifyReport {
  const cwd = options.cwd ?? process.cwd();
  const strict = options.strict === true;
  const diff = getDiffInfo(cwd, options.base);
  const receiptReview = reviewChangedReceipts(cwd, diff.changedFiles);
  const findings = sortFindings([
    ...receiptReview.findings,
    ...analyzeChangedFiles(diff),
  ]);
  const summary = summarizeFindings(findings, strict);

  return {
    tool: 'mythos-verify-ci',
    version: 1,
    mode: receiptReview.checked ? 'mythos-receipts' : 'generic',
    cwd,
    diff: {
      mode: diff.mode,
      baseRef: diff.baseRef,
      range: diff.range,
      changedFileCount: diff.changedFiles.length,
    },
    changedFiles: diff.changedFiles,
    receipt: {
      checked: receiptReview.checked,
      changedReceiptCount: receiptReview.changedReceiptCount,
      validReceiptCount: receiptReview.validReceiptCount,
      coveredChangedFileCount: receiptReview.coveredChangedFileCount,
      uncoveredChangedFiles: receiptReview.uncoveredChangedFiles,
      chainChecked: receiptReview.chainChecked,
      chainOk: receiptReview.chainOk,
      chainLength: receiptReview.chainLength,
    },
    findings,
    summary,
  };
}
