import type { CIFinding, CIFindingSeverity, CIVerifyReport } from './types.js';
import { c, heading, hr, success, warn, error, info, theme } from '../utils.js';

function severityRank(severity: CIFindingSeverity): number {
  if (severity === 'high') return 3;
  if (severity === 'warn') return 2;
  return 1;
}

function severityLabel(severity: CIFindingSeverity): string {
  if (severity === 'high') return `${theme.error}HIGH${c.reset}`;
  if (severity === 'warn') return `${theme.warning}WARN${c.reset}`;
  return `${theme.info}INFO${c.reset}`;
}

export function summarizeFindings(findings: CIFinding[], strict: boolean): CIVerifyReport['summary'] {
  const high = findings.filter((finding) => finding.severity === 'high').length;
  const warnCount = findings.filter((finding) => finding.severity === 'warn').length;
  const infoCount = findings.filter((finding) => finding.severity === 'info').length;
  const risk = high > 0 ? 'high' : warnCount > 0 ? 'medium' : 'low';
  const exitCode = high > 0 || (strict && warnCount > 0) ? 1 : 0;

  return {
    high,
    warn: warnCount,
    info: infoCount,
    risk,
    exitCode,
    strict,
  };
}

export function sortFindings(findings: CIFinding[]): CIFinding[] {
  return [...findings].sort((a, b) => {
    const severityDiff = severityRank(b.severity) - severityRank(a.severity);
    if (severityDiff !== 0) return severityDiff;
    return a.id.localeCompare(b.id);
  });
}

function printFinding(finding: CIFinding): void {
  const file = finding.file ? ` ${c.dim}${finding.file}${c.reset}` : '';
  console.log(`  ${severityLabel(finding.severity)} ${c.bold}${finding.id}${c.reset}${file}`);
  console.log(`    ${finding.title}`);

  if (finding.evidence.length > 0) {
    console.log(`    ${c.dim}Evidence:${c.reset}`);
    for (const item of finding.evidence.slice(0, 8)) {
      console.log(`      - ${item}`);
    }
    if (finding.evidence.length > 8) {
      console.log(`      - ... and ${finding.evidence.length - 8} more`);
    }
  }

  console.log(`    ${c.dim}Why:${c.reset} ${finding.why}`);
  console.log(`    ${c.dim}Recommendation:${c.reset} ${finding.recommendation}`);
  console.log();
}

export function printCIVerifyReport(report: CIVerifyReport, asJson = false): void {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(heading('Mythos CI Verification'));
  console.log(`  ${c.dim}Mode:${c.reset}     ${report.mode === 'mythos-receipts' ? 'Mythos receipt verification' : 'Generic PR review'}`);
  console.log(`  ${c.dim}Diff:${c.reset}     ${report.diff.range ?? report.diff.mode}`);
  console.log(`  ${c.dim}Changed:${c.reset}  ${report.diff.changedFileCount} file(s)`);
  console.log(`  ${c.dim}Risk:${c.reset}     ${report.summary.risk.toUpperCase()}`);
  console.log(`  ${c.dim}Strict:${c.reset}   ${report.summary.strict ? 'yes' : 'no'}`);

  if (report.receipt.checked) {
    console.log(
      `  ${c.dim}Receipts:${c.reset} ${report.receipt.validReceiptCount}/${report.receipt.changedReceiptCount} valid, ` +
      `${report.receipt.coveredChangedFileCount} changed file(s) covered`,
    );
    if (report.receipt.chainChecked) {
      console.log(
        `  ${c.dim}Chain:${c.reset}    ${report.receipt.chainOk ? 'intact' : 'BROKEN'} (${report.receipt.chainLength} linked receipt(s))`,
      );
    }
  } else {
    console.log(`  ${c.dim}Receipts:${c.reset} no changed Mythos receipts in this diff`);
  }

  console.log(`\n${hr()}`);

  if (report.findings.length === 0) {
    success('No high-impact CI verification findings.');
  } else {
    console.log(`${c.bold}Findings:${c.reset}\n`);
    for (const finding of report.findings) {
      printFinding(finding);
    }
  }

  console.log(hr());
  const summary = `${report.summary.high} high · ${report.summary.warn} warn · ${report.summary.info} info`;
  if (report.summary.exitCode === 0) {
    success(`CI verification passed (${summary}).`);
  } else if (report.summary.high > 0) {
    error(`CI verification failed (${summary}).`);
  } else {
    warn(`CI verification failed in strict mode (${summary}).`);
  }

  if (!report.receipt.checked) {
    info('Generic mode was used. Add/commit Mythos receipts only when you intentionally want receipt-level CI verification.');
  }
}
