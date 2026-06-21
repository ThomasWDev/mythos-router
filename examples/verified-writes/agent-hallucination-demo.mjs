// ─────────────────────────────────────────────────────────────
//  examples/verified-writes/agent-hallucination-demo.mjs
//
//  Demonstrates the *model-free* core of mythos-router: route ANY agent's
//  file claims through Strict Write Discipline and let the filesystem — not
//  the model's self-report — be the source of truth.
//
//  Run it:
//      npm run build           # produces dist/ that the SDK is imported from
//      node examples/verified-writes/agent-hallucination-demo.mjs
//
//  No API key, no provider call. SWD only ever verifies file effects.
// ─────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SWDEngine,
  parseActions,
  createSWDReceipt,
  saveSWDReceipt,
  verifyReceiptChain,
} from 'mythos-router';

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const originalCwd = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'mythos-demo-'));
process.chdir(dir);

try {
  mkdirSync('src', { recursive: true });
  const ORIGINAL = 'export const rate = 0.05;\n';
  writeFileSync('src/config.ts', ORIGINAL);

  const engine = new SWDEngine({ strict: true, enableRollback: true });

  // ── Scenario 1: an honest agent ────────────────────────────
  // It claims two real edits, and the bytes it writes match its claim.
  console.log(bold('\nScenario 1 — honest agent (two real edits)'));
  const honest = `
[FILE_ACTION: src/config.ts]
OPERATION: MODIFY
INTENT: MUTATE
DESCRIPTION: bump the rate
CONTENT:
export const rate = 0.08;
[/FILE_ACTION]

[FILE_ACTION: src/util.ts]
OPERATION: CREATE
INTENT: MUTATE
DESCRIPTION: add a helper
CONTENT:
export const ok = true;
[/FILE_ACTION]
`;
  const honestResult = await engine.run(parseActions(honest));
  console.log(`  success: ${honestResult.success ? green('true') : red('false')}`);
  for (const r of honestResult.results) {
    console.log(`  ${r.status === 'verified' ? green('✔') : red('✘')} ${r.action.operation} ${r.action.path} ${dim('— ' + r.detail)}`);
  }
  console.log(dim(`  src/config.ts now: ${JSON.stringify(readFileSync('src/config.ts', 'utf-8'))}`));

  // A trust receipt is written for the verified batch (hash-chained).
  const receipt = createSWDReceipt({ request: 'demo: honest edits', summary: 'MODIFY/CREATE', result: honestResult });
  saveSWDReceipt(receipt);

  // ── Scenario 2: a hallucinating agent ──────────────────────
  // It *claims* it changed config.ts (INTENT: MUTATE) but the content it
  // emits is byte-identical to what's already there — a change it never
  // actually made. It also pairs that with one genuine edit.
  console.log(bold('\nScenario 2 — agent hallucinates a change'));
  const current = readFileSync('src/config.ts', 'utf-8');
  const lying = `
[FILE_ACTION: src/config.ts]
OPERATION: MODIFY
INTENT: MUTATE
DESCRIPTION: "fixed" the rate (but actually wrote the same bytes)
CONTENT:
${current.trimEnd()}
[/FILE_ACTION]

[FILE_ACTION: src/feature.ts]
OPERATION: CREATE
INTENT: MUTATE
DESCRIPTION: a real new file, in the same batch
CONTENT:
export const feature = true;
[/FILE_ACTION]
`;
  const lyingResult = await engine.run(parseActions(lying));
  console.log(`  success: ${lyingResult.success ? green('true') : red('false')}`);
  for (const r of lyingResult.results) {
    const mark = r.status === 'verified' ? green('✔') : (r.status === 'failed' ? red('✘ CAUGHT') : yellow('drift'));
    console.log(`  ${mark} ${r.action.operation} ${r.action.path} ${dim('— ' + r.detail)}`);
  }
  console.log(`  rolled back: ${lyingResult.rolledBack ? yellow('yes') : 'no'}`);
  // Because one action failed verification, the whole batch was reverted — the
  // genuine sibling edit never reaches your tree half-applied.
  console.log(dim(`  src/feature.ts exists after rollback? ${existsSync('src/feature.ts')}`));

  // ── The audit trail is tamper-evident ──────────────────────
  console.log(bold('\nAudit trail'));
  const chain = verifyReceiptChain();
  console.log(`  receipt chain: ${chain.ok ? green('intact') : red('BROKEN')} (${chain.length} linked receipt(s))`);
  console.log(dim('  Delete, reorder, or edit any receipt and `mythos receipts verify` reports the break.\n'));
} finally {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
}
