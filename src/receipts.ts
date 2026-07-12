import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import * as path from 'node:path';
import { withFileLockSync } from './file-lock.js';
import { PathJail } from './path-jail.js';
import {
  atomicWriteTextInJail,
  digestJailedRegularFile,
  readRegularTextFileNoFollow,
} from './safe-file-io.js';
import type { SWDRollbackStatus, SWDRunResult } from './swd.js';

export const RECEIPTS_DIR = '.mythos/receipts';
export const RECEIPT_STORE_LOCK_FILE = '.receipt-store.lock';

const RECEIPT_ID_PATTERN = /^swd-[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MAX_RECEIPT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CHAIN_HEAD_BYTES = 64 * 1024;
const RECEIPT_FILE_MODE = 0o600;
const CHAIN_VERIFY_WAIT_MS = 5_000;
const CHAIN_VERIFY_RETRY_MS = 10;

export const RECEIPT_OUTPUT_TAIL_MAX_CHARS = 500;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-proj-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi,
];

const SECRET_ASSIGNMENT_PATTERN = /\b([A-Z][A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)(["']?)([^\s"'`]+)(\2)/gi;

export function redactReceiptSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED_SECRET]');
  }
  return redacted.replace(SECRET_ASSIGNMENT_PATTERN, (_match, prefix: string, quote: string, _value: string, closingQuote: string) => {
    return `${prefix}${quote}[REDACTED_SECRET]${closingQuote}`;
  });
}

export function sanitizeReceiptOutputTail(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return '';
  return redactReceiptSecrets(trimmed.slice(-RECEIPT_OUTPUT_TAIL_MAX_CHARS));
}

export interface ReceiptProvider {
  providerId: string;
  modelId: string;
  fallbackTriggered?: boolean;
  incomplete?: boolean;
  latencyMs?: number;
}

export interface ReceiptUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ReceiptBudget {
  sessionInputTokens: number;
  sessionOutputTokens: number;
  sessionTotalTokens: number;
  sessionTurns: number;
  estimatedCostUSD: number;
}

export interface ReceiptSkill {
  id: string;
  name: string;
  version: string;
  source: 'project' | 'global' | 'path';
  path?: string;
}

export type ReceiptTestStatus = string;

export interface ReceiptTestResult {
  command: string;
  passed: boolean;
  attempts: number;
  status: ReceiptTestStatus;
  outputTail?: string;
}

export interface ReceiptSnapshot {
  path: string;
  exists: boolean;
  size: number;
  mtime: number;
  sha256: string;
}

export interface ReceiptFileResult {
  path: string;
  operation: string;
  intent: string;
  status: string;
  detail: string;
  before?: ReceiptSnapshot;
  after?: ReceiptSnapshot;
  expected?: ReceiptSnapshot;
  expectedSource: 'before' | 'after' | 'none';
}

export interface ReceiptFileVerification {
  path: string;
  status: 'ok' | 'drifted' | 'missing' | 'unknown';
  detail: string;
  expected?: ReceiptSnapshot;
  actual?: ReceiptSnapshot;
}

export interface ReceiptVerification {
  /** Receipt self-integrity is checked before any referenced workspace path is opened. */
  integrityOk: boolean;
  ok: boolean;
  files: ReceiptFileVerification[];
}

export interface ReceiptSummary {
  id: string;
  timestamp: string;
  summary: string;
  fileCount: number;
  success: boolean;
  rolledBack: boolean;
  rollbackStatus?: SWDRollbackStatus;
  recoveryRequired?: boolean;
  provider?: string;
  model?: string;
  branch?: string;
  skills?: string[];
}

export interface SWDReceiptInput {
  request: string;
  summary: string;
  result: SWDRunResult;
  provider?: ReceiptProvider;
  usage?: Omit<ReceiptUsage, 'totalTokens'> | ReceiptUsage;
  budget?: ReceiptBudget;
  skills?: ReceiptSkill[];
  test?: ReceiptTestResult;
  git?: {
    branch?: string;
    commit?: string;
  };
}

export interface SWDReceipt {
  id: string;
  version: 1;
  timestamp: string;
  request: string;
  summary: string;
  fileCount: number;
  files: ReceiptFileResult[];
  swd: {
    success: boolean;
    rolledBack: boolean;
    rollbackStatus?: SWDRollbackStatus;
    recoveryRequired?: boolean;
    errors: string[];
    rollbackErrors: string[];
  };
  provider?: ReceiptProvider;
  usage?: ReceiptUsage;
  budget?: ReceiptBudget;
  skills?: ReceiptSkill[];
  git?: {
    branch?: string;
    commit?: string;
  };
  test?: ReceiptTestResult;
  /**
   * Append-only hash-chain linkage. `seq` is the receipt's position in the
   * chain (genesis = 0); `prevHash` is the integrity hash of the receipt at
   * `seq - 1` (empty string for genesis). Both fields are part of the hashed
   * payload, so editing either one breaks `integrity.sha256`. Together with
   * the local HEAD pointer this detects accidental edits, gaps, reordering, and
   * unsynchronized writers. It is not an authenticity proof against an actor
   * that can rewrite the complete local chain and HEAD.
   */
  chain?: ReceiptChain;
  integrity?: {
    sha256: string;
  };
}

export interface ReceiptChain {
  seq: number;
  prevHash: string;
}

/** Pointer to the chain tip, stored alongside receipts so a deleted/replaced
 *  latest receipt is also detectable. Not itself a receipt. */
export interface ChainHead {
  id: string;
  seq: number;
  hash: string;
  updatedAt: string;
}

export interface ChainVerification {
  /** True when at least one chained receipt exists on disk. */
  present: boolean;
  /** True when the chain is intact (no edits, gaps, or broken links). */
  ok: boolean;
  /** Number of chained receipts inspected. */
  length: number;
  /** seq at which a break was detected, if any. */
  brokenAt?: number;
  /** Human-readable explanation of the break, if any. */
  reason?: string;
  /** Whether the HEAD pointer matches the latest receipt (undefined if no HEAD). */
  headMatches?: boolean;
}

/** prevHash value for the genesis receipt (seq 0). */
export const GENESIS_PREV_HASH = '';

/** Filename of the chain-tip pointer inside the receipts dir. */
export const CHAIN_HEAD_FILE = 'chain-head.json';

type SnapshotLike = {
  path: string;
  exists: boolean;
  size: number;
  mtime: number;
  hash: string;
};

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function toNativePath(filePath: string): string {
  return filePath.split(/[\\/]/g).join(path.sep);
}

function toPortablePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function realPathForComparison(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    const parentDir = path.dirname(filePath);
    try {
      return path.join(realpathSync(parentDir), path.basename(filePath));
    } catch {
      return filePath;
    }
  }
}

function toReceiptPath(rootDir: string, filePath: string): string {
  if (!filePath) return filePath;

  const nativePath = toNativePath(filePath);
  const absoluteRoot = path.resolve(rootDir);
  const absoluteFile = path.isAbsolute(nativePath)
    ? path.normalize(nativePath)
    : path.resolve(absoluteRoot, nativePath);
  const canonicalRoot = realPathForComparison(absoluteRoot);
  const canonicalFile = realPathForComparison(absoluteFile);
  const relativePath = path.relative(canonicalRoot, canonicalFile);

  if (relativePath && !path.isAbsolute(relativePath)) {
    return toPortablePath(relativePath);
  }

  return toPortablePath(filePath);
}

function toProjectReceiptPath(rootDir: string, filePath: string): string | undefined {
  if (!filePath) return undefined;

  const nativePath = toNativePath(filePath);
  const absoluteRoot = path.resolve(rootDir);
  const absoluteFile = path.isAbsolute(nativePath)
    ? path.normalize(nativePath)
    : path.resolve(absoluteRoot, nativePath);
  const canonicalRoot = realPathForComparison(absoluteRoot);
  const canonicalFile = realPathForComparison(absoluteFile);
  const relativePath = path.relative(canonicalRoot, canonicalFile);

  const escapesProject = relativePath === '..' || relativePath.startsWith(`..${path.sep}`);
  if (!relativePath || escapesProject || path.isAbsolute(relativePath)) {
    return undefined;
  }

  return toPortablePath(relativePath);
}

function resolveReceiptPath(rootDir: string, filePath: string): string {
  const nativePath = toNativePath(filePath);
  return path.isAbsolute(nativePath) ? nativePath : path.resolve(rootDir, nativePath);
}

export function getReceiptsDir(rootDir = process.cwd()): string {
  return path.join(rootDir, RECEIPTS_DIR);
}

function ensureReceiptsDir(rootDir = process.cwd()): { dir: string; jail: PathJail } {
  const jail = new PathJail(rootDir);
  const sentinel = path.join(RECEIPTS_DIR, '.receipt-store-sentinel');
  jail.ensureParentDirectories(sentinel);
  const dir = getReceiptsDir(jail.root);
  // Resolve a child path so PathJail verifies every existing directory
  // component, including `.mythos/receipts`, without requiring a sentinel file.
  jail.resolve(sentinel);
  return { dir, jail };
}

function normalizeSnapshot(rootDir: string, snapshot?: SnapshotLike): ReceiptSnapshot | undefined {
  if (!snapshot) return undefined;

  return {
    path: toReceiptPath(rootDir, snapshot.path),
    exists: snapshot.exists,
    size: snapshot.size,
    mtime: snapshot.mtime,
    sha256: snapshot.hash,
  };
}

function expectedSnapshot(file: ReceiptFileResult): { expected?: ReceiptSnapshot; source: 'before' | 'after' | 'none' } {
  if (file.operation === 'DELETE') {
    return { expected: file.after, source: file.after ? 'after' : 'none' };
  }

  if (file.after) return { expected: file.after, source: 'after' };
  if (file.before) return { expected: file.before, source: 'before' };
  return { source: 'none' };
}

function normalizeFileResult(rootDir: string, result: SWDRunResult['results'][number]): ReceiptFileResult {
  const file: ReceiptFileResult = {
    path: toReceiptPath(rootDir, result.action.path),
    operation: result.action.operation,
    intent: result.action.intent,
    status: result.status,
    detail: redactReceiptSecrets(result.detail),
    before: normalizeSnapshot(rootDir, result.before),
    after: normalizeSnapshot(rootDir, result.after),
    expectedSource: 'none',
  };
  const expected = expectedSnapshot(file);
  file.expected = expected.expected;
  file.expectedSource = expected.source;
  return file;
}

function normalizeReceiptSkill(rootDir: string, skill: ReceiptSkill): ReceiptSkill {
  const projectPath = skill.path ? toProjectReceiptPath(rootDir, skill.path) : undefined;
  const normalized: ReceiptSkill = {
    id: skill.id,
    name: skill.name,
    version: skill.version,
    source: skill.source,
  };
  if (projectPath) normalized.path = projectPath;
  return normalized;
}

function receiptPayload(receipt: SWDReceipt): Omit<SWDReceipt, 'integrity'> {
  const { integrity: _integrity, ...payload } = receipt;
  return payload;
}

function integrityHash(receipt: SWDReceipt): string {
  return sha256(JSON.stringify(receiptPayload(receipt)));
}

function withIntegrity(receipt: Omit<SWDReceipt, 'integrity'>): SWDReceipt {
  const integrity = { sha256: '' };
  const next: SWDReceipt = {
    ...receipt,
    integrity,
  };
  integrity.sha256 = integrityHash(next);
  return next;
}

function createReceiptId(timestamp: string, request: string, files: ReceiptFileResult[]): string {
  const stamp = timestamp.replace(/[-:.TZ]/g, '').slice(0, 14);
  const digest = sha256(`${timestamp}\n${request}\n${JSON.stringify(files)}`).slice(0, 10);
  return `swd-${stamp}-${digest}`;
}

function normalizeUsage(usage?: SWDReceiptInput['usage']): ReceiptUsage | undefined {
  if (!usage) return undefined;
  const totalTokens = 'totalTokens' in usage
    ? usage.totalTokens
    : usage.inputTokens + usage.outputTokens;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens,
  };
}

export function createSWDReceipt(input: SWDReceiptInput, rootDir = process.cwd()): SWDReceipt {
  const timestamp = new Date().toISOString();
  const files = input.result.results.map((result) => normalizeFileResult(rootDir, result));
  const safeRequest = redactReceiptSecrets(input.request);
  const safeSummary = redactReceiptSecrets(input.summary);
  const base: Omit<SWDReceipt, 'integrity'> = {
    id: createReceiptId(timestamp, safeRequest, files),
    version: 1,
    timestamp,
    request: safeRequest,
    summary: safeSummary,
    fileCount: files.length,
    files,
    swd: {
      success: input.result.success,
      rolledBack: input.result.rolledBack,
      rollbackStatus: input.result.rollbackStatus,
      recoveryRequired: input.result.recoveryRequired,
      errors: input.result.errors.map(redactReceiptSecrets),
      rollbackErrors: input.result.rollbackErrors.map(redactReceiptSecrets),
    },
  };

  if (input.provider) base.provider = input.provider;
  const usage = normalizeUsage(input.usage);
  if (usage) base.usage = usage;
  if (input.budget) base.budget = input.budget;
  if (input.skills && input.skills.length > 0) {
    base.skills = input.skills.map((skill) => normalizeReceiptSkill(rootDir, skill));
  }
  if (input.git) base.git = input.git;
  if (input.test) base.test = input.test;

  return withIntegrity(base);
}

export function saveSWDReceipt(receipt: SWDReceipt, overwrite = true, rootDir = process.cwd()): string {
  assertReceiptId(receipt.id);
  const { dir, jail } = ensureReceiptsDir(rootDir);
  const relativeReceiptPath = path.join(RECEIPTS_DIR, `${receipt.id}.json`);
  const relativeLockPath = path.join(RECEIPTS_DIR, RECEIPT_STORE_LOCK_FILE);
  const filePath = jail.resolve(relativeReceiptPath);
  const lockPath = jail.resolve(relativeLockPath);

  return withFileLockSync(lockPath, () => {
    // A writer that acquired the lock still revalidates the store path. This
    // catches a receipts directory or target swapped to a symlink after setup.
    jail.resolve(relativeLockPath);
    jail.resolve(relativeReceiptPath);

    const alreadyExists = existsSync(filePath);
    if (alreadyExists) {
      const stored = readReceiptFile(filePath);
      if (!stored || !verifyReceiptIntegrity(stored)) {
        throw new Error(`Refusing to reuse unreadable or integrity-invalid receipt ${receipt.id}.`);
      }

      const payload = normalizedReceiptPayload(jail.root, receipt, stored.chain);
      const normalized = withIntegrity(payload);
      if (normalized.integrity?.sha256 === stored.integrity?.sha256) {
        return filePath;
      }

      const reason = overwrite
        ? 'receipt storage is append-only'
        : 'an existing receipt with the same id has different content';
      throw new Error(`Refusing to reuse existing receipt ${receipt.id}: ${reason}.`);
    }

    const chainState = verifyReceiptChainUnlocked(dir);
    if (chainState.present && !chainState.ok) {
      throw new Error(`Refusing to append to a broken receipt chain: ${chainState.reason}`);
    }

    const headState = inspectChainHead(dir);
    if (headState.exists && !headState.head) {
      throw new Error('Refusing to append: receipt chain HEAD is unreadable or invalid.');
    }
    const head = headState.head;
    const chain: ReceiptChain = {
      seq: head ? head.seq + 1 : 0,
      prevHash: head ? head.hash : GENESIS_PREV_HASH,
    };

    const normalized = withIntegrity(normalizedReceiptPayload(jail.root, receipt, chain));
    const serializedReceipt = `${JSON.stringify(normalized, null, 2)}\n`;
    atomicWriteTextInJail(jail, relativeReceiptPath, serializedReceipt, {
      createOnly: true,
      defaultMode: RECEIPT_FILE_MODE,
    });

    const nextHead: ChainHead = {
      id: normalized.id,
      seq: chain.seq,
      hash: normalized.integrity!.sha256,
      updatedAt: new Date().toISOString(),
    };
    const relativeHeadPath = path.join(RECEIPTS_DIR, CHAIN_HEAD_FILE);
    const headPath = jail.resolve(relativeHeadPath);
    const previousHeadContent = existsSync(headPath)
      ? readRegularTextFileNoFollow(headPath, MAX_CHAIN_HEAD_BYTES)
      : null;

    try {
      atomicWriteTextInJail(jail, relativeHeadPath, `${JSON.stringify(nextHead, null, 2)}
`, {
        createOnly: previousHeadContent === null,
        defaultMode: RECEIPT_FILE_MODE,
        expectedExistingContent: previousHeadContent,
        maxExistingBytes: MAX_CHAIN_HEAD_BYTES,
      });
    } catch (error: unknown) {
      // Keep the two-file append transaction consistent when the process is
      // still alive. A process crash between these commits remains detectable
      // by chain verification and is addressed by the later journal phase.
      removeReceiptIfUnchanged(filePath, normalized.integrity!.sha256);
      throw error;
    }

    return filePath;
  });
}

function normalizedReceiptPayload(
  rootDir: string,
  receipt: SWDReceipt,
  chain: ReceiptChain | undefined,
): Omit<SWDReceipt, 'integrity'> {
  const payload: Omit<SWDReceipt, 'integrity'> = {
    ...receiptPayload(receipt),
    files: receipt.files.map((file) => normalizeStoredFile(rootDir, file)),
    skills: receipt.skills?.map((skill) => normalizeReceiptSkill(rootDir, skill)),
  };
  if (chain) payload.chain = chain;
  else delete payload.chain;
  return payload;
}

function removeReceiptIfUnchanged(filePath: string, expectedHash: string): void {
  try {
    const stored = readReceiptFile(filePath);
    if (stored?.integrity?.sha256 !== expectedHash || !verifyReceiptIntegrity(stored)) return;
    unlinkSync(filePath);
  } catch {
    // Preserve the original HEAD commit failure. Chain verification will report
    // any receipt that could not be removed and is not represented by HEAD.
  }
}

function assertReceiptId(receiptId: string): void {
  if (!RECEIPT_ID_PATTERN.test(receiptId)) {
    throw new Error(`Invalid receipt id '${receiptId}'.`);
  }
}

function normalizeStoredFile(rootDir: string, file: ReceiptFileResult): ReceiptFileResult {
  const normalized: ReceiptFileResult = {
    ...file,
    path: toReceiptPath(rootDir, file.path),
    before: normalizeStoredSnapshot(rootDir, file.before),
    after: normalizeStoredSnapshot(rootDir, file.after),
    expected: normalizeStoredSnapshot(rootDir, file.expected),
  };
  return normalized;
}

function normalizeStoredSnapshot(rootDir: string, snapshot?: ReceiptSnapshot): ReceiptSnapshot | undefined {
  if (!snapshot) return undefined;
  return {
    ...snapshot,
    path: toReceiptPath(rootDir, snapshot.path),
  };
}

function receiptFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    // Receipt ids are always `swd-<stamp>-<digest>`, so this naturally excludes
    // the chain-head pointer and any other JSON that isn't a receipt.
    .filter((entry) => entry.startsWith('swd-') && entry.endsWith('.json'))
    .map((entry) => path.join(dir, entry))
    .sort((a, b) => safeLstatMtime(b) - safeLstatMtime(a));
}

function safeLstatMtime(filePath: string): number {
  try {
    return lstatSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function receiptFiles(rootDir = process.cwd()): string[] {
  return receiptFilesIn(getReceiptsDir(rootDir));
}

function chainHeadPath(dir: string): string {
  return path.join(dir, CHAIN_HEAD_FILE);
}

interface ChainHeadInspection {
  exists: boolean;
  head: ChainHead | null;
}

function inspectChainHead(dir: string): ChainHeadInspection {
  const filePath = chainHeadPath(dir);
  if (!existsSync(filePath)) return { exists: false, head: null };
  try {
    const parsed = JSON.parse(readRegularTextFileNoFollow(filePath, MAX_CHAIN_HEAD_BYTES)) as Partial<ChainHead>;
    if (
      typeof parsed.id === 'string'
      && RECEIPT_ID_PATTERN.test(parsed.id)
      && Number.isSafeInteger(parsed.seq)
      && (parsed.seq ?? -1) >= 0
      && typeof parsed.hash === 'string'
      && /^[a-f0-9]{64}$/.test(parsed.hash)
      && typeof parsed.updatedAt === 'string'
      && Number.isFinite(Date.parse(parsed.updatedAt))
    ) {
      return { exists: true, head: parsed as ChainHead };
    }
  } catch {
    // Report invalid JSON through the explicit inspection result.
  }
  return { exists: true, head: null };
}

function readReceiptFile(filePath: string): SWDReceipt | null {
  try {
    const parsed = JSON.parse(readRegularTextFileNoFollow(filePath, MAX_RECEIPT_FILE_BYTES)) as unknown;
    return isStoredReceipt(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isStoredReceipt(value: unknown): value is SWDReceipt {
  if (!isPlainRecord(value)) return false;
  const receipt = value as Partial<SWDReceipt>;
  if (
    typeof receipt.id !== 'string'
    || receipt.version !== 1
    || typeof receipt.timestamp !== 'string'
    || !Number.isFinite(Date.parse(receipt.timestamp))
    || typeof receipt.request !== 'string'
    || typeof receipt.summary !== 'string'
    || !Number.isSafeInteger(receipt.fileCount)
    || (receipt.fileCount ?? -1) < 0
    || !Array.isArray(receipt.files)
    || receipt.fileCount !== receipt.files.length
    || !receipt.files.every(isReceiptFileResult)
    || !isPlainRecord(receipt.swd)
  ) {
    return false;
  }

  const swd = receipt.swd;
  if (
    typeof swd.success !== 'boolean'
    || typeof swd.rolledBack !== 'boolean'
    || !isStringArray(swd.errors)
    || !isStringArray(swd.rollbackErrors)
  ) {
    return false;
  }

  if (receipt.chain !== undefined && (
    !isPlainRecord(receipt.chain)
    || !Number.isSafeInteger(receipt.chain.seq)
    || receipt.chain.seq < 0
    || typeof receipt.chain.prevHash !== 'string'
  )) {
    return false;
  }
  if (receipt.integrity !== undefined && (
    !isPlainRecord(receipt.integrity)
    || typeof receipt.integrity.sha256 !== 'string'
  )) {
    return false;
  }
  if (receipt.skills !== undefined && (
    !Array.isArray(receipt.skills)
    || !receipt.skills.every((skill) => isPlainRecord(skill)
      && typeof skill.id === 'string'
      && typeof skill.name === 'string'
      && typeof skill.version === 'string'
      && ['project', 'global', 'path'].includes(String(skill.source))
      && (skill.path === undefined || typeof skill.path === 'string'))
  )) {
    return false;
  }
  return true;
}

function isReceiptFileResult(value: unknown): value is ReceiptFileResult {
  if (!isPlainRecord(value)) return false;
  return typeof value.path === 'string'
    && typeof value.operation === 'string'
    && typeof value.intent === 'string'
    && typeof value.status === 'string'
    && typeof value.detail === 'string'
    && ['before', 'after', 'none'].includes(String(value.expectedSource))
    && isOptionalReceiptSnapshot(value.before)
    && isOptionalReceiptSnapshot(value.after)
    && isOptionalReceiptSnapshot(value.expected);
}

function isOptionalReceiptSnapshot(value: unknown): value is ReceiptSnapshot | undefined {
  if (value === undefined) return true;
  if (!isPlainRecord(value)) return false;
  return typeof value.path === 'string'
    && typeof value.exists === 'boolean'
    && typeof value.size === 'number'
    && Number.isFinite(value.size)
    && value.size >= 0
    && typeof value.mtime === 'number'
    && Number.isFinite(value.mtime)
    && value.mtime >= 0
    && typeof value.sha256 === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWithinReceiptsDir(dir: string, candidate: string): boolean {
  const realDir = realPathForComparison(dir);
  const realCandidate = realPathForComparison(candidate);
  const rel = path.relative(realDir, realCandidate);
  // Must resolve to a real file *inside* the receipts dir: non-empty, not a
  // parent-escape, and not an absolute path (which would mean a different root).
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function receiptPathFor(target: string, rootDir = process.cwd()): string | null {
  const files = receiptFiles(rootDir);
  if (target === 'latest') return files[0] ?? null;

  const dir = getReceiptsDir(rootDir);
  const id = target.endsWith('.json') ? target.slice(0, -5) : target;

  // Build candidates, then require each to resolve *inside* the receipts dir.
  // This blocks both `..` traversal smuggled into an id and arbitrary absolute
  // paths pointing elsewhere on disk (receipts are local artifacts by design).
  const candidates: string[] = [path.resolve(dir, `${toNativePath(id)}.json`)];
  const nativeTarget = toNativePath(target);
  if (path.isAbsolute(nativeTarget)) {
    candidates.unshift(path.normalize(nativeTarget));
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (!isWithinReceiptsDir(dir, candidate)) continue;
    return candidate;
  }

  return null;
}

export function readReceipt(target = 'latest', rootDir = process.cwd()): SWDReceipt | null {
  const filePath = receiptPathFor(target, rootDir);
  return filePath ? readReceiptFile(filePath) : null;
}

export function listReceipts(limit = 10, rootDir = process.cwd()): ReceiptSummary[] {
  return receiptFiles(rootDir)
    .slice(0, limit)
    .map((filePath) => readReceiptFile(filePath))
    .filter((receipt): receipt is SWDReceipt => receipt !== null)
    .map((receipt) => ({
      id: receipt.id,
      timestamp: receipt.timestamp,
      summary: receipt.summary,
      fileCount: receipt.fileCount,
      success: receipt.swd.success,
      rolledBack: receipt.swd.rolledBack,
      rollbackStatus: receipt.swd.rollbackStatus,
      recoveryRequired: receipt.swd.recoveryRequired,
      provider: receipt.provider?.providerId,
      model: receipt.provider?.modelId,
      branch: receipt.git?.branch,
      skills: receipt.skills?.map((skill) => `${skill.id}@${skill.version}`),
    }));
}

/**
 * Read the most recent receipts as full records (newest first), bounded by
 * `limit`. Unlike `listReceipts`, this returns the complete file-action detail,
 * which callers such as skill-learning need to inspect verification outcomes.
 */
export function readReceipts(limit = 50, rootDir = process.cwd()): SWDReceipt[] {
  return receiptFiles(rootDir)
    .slice(0, limit)
    .map((filePath) => readReceiptFile(filePath))
    .filter((receipt): receipt is SWDReceipt => receipt !== null);
}

function snapshotCurrentFile(jail: PathJail, filePath: string): ReceiptSnapshot {
  const digest = digestJailedRegularFile(jail, filePath);
  return {
    path: filePath,
    exists: digest.exists,
    size: digest.size,
    mtime: digest.mtimeMs,
    sha256: digest.sha256,
  };
}

export function verifyReceipt(receipt: SWDReceipt, rootDir = process.cwd()): ReceiptVerification {
  const integrityOk = verifyReceiptIntegrity(receipt);
  if (!integrityOk) {
    return {
      integrityOk: false,
      ok: false,
      files: receipt.files.map((file) => ({
        path: file.path,
        status: 'unknown',
        detail: 'Receipt integrity check failed; referenced workspace paths were not opened.',
        expected: file.expected,
      })),
    };
  }

  let jail: PathJail;
  try {
    jail = new PathJail(rootDir);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      integrityOk: true,
      ok: false,
      files: receipt.files.map((file) => ({
        path: file.path,
        status: 'unknown',
        detail: `Unable to establish the project verification boundary: ${detail}`,
        expected: file.expected,
      })),
    };
  }

  const files = receipt.files.map((file): ReceiptFileVerification => {
    const expected = file.expected;

    if (!expected) {
      return {
        path: file.path,
        status: 'unknown',
        detail: 'No expected final snapshot was recorded.',
      };
    }

    if (expected.path !== file.path) {
      return {
        path: file.path,
        status: 'unknown',
        detail: 'Receipt file path does not match its expected snapshot path.',
        expected,
      };
    }

    let actual: ReceiptSnapshot;
    try {
      actual = snapshotCurrentFile(jail, file.path);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        path: file.path,
        status: 'unknown',
        detail: `Receipt target could not be verified safely: ${detail}`,
        expected,
      };
    }

    if (expected.exists && !actual.exists) {
      return {
        path: file.path,
        status: 'missing',
        detail: 'Expected file is missing.',
        expected,
        actual,
      };
    }

    if (!expected.exists && actual.exists) {
      return {
        path: file.path,
        status: 'drifted',
        detail: 'Expected file to be absent, but it exists.',
        expected,
        actual,
      };
    }

    if (expected.exists && actual.exists && expected.sha256 !== actual.sha256) {
      return {
        path: file.path,
        status: 'drifted',
        detail: 'File hash differs from the receipt snapshot.',
        expected,
        actual,
      };
    }

    return {
      path: file.path,
      status: 'ok',
      detail: 'Current file matches the receipt snapshot.',
      expected,
      actual,
    };
  });

  return {
    integrityOk: true,
    ok: files.every((file) => file.status === 'ok'),
    files,
  };
}

export function verifyReceiptIntegrity(receipt: SWDReceipt): boolean {
  try {
    return typeof receipt.integrity?.sha256 === 'string'
      && /^[a-f0-9]{64}$/.test(receipt.integrity.sha256)
      && receipt.integrity.sha256 === integrityHash(receipt);
  } catch {
    return false;
  }
}

/**
 * Verify the locally append-only receipt chain in `dir`.
 *
 * This detects malformed records, duplicate sequences, local forks, gaps,
 * broken links, edits, and a missing/mismatched HEAD pointer. Because both the
 * receipts and HEAD live under the same local account, this is tamper-evidence
 * for accidental or partial history changes — not cryptographic authenticity
 * against an actor able to rewrite the complete store.
 *
 * Receipts written before chaining was introduced have no `chain` field and are
 * ignored, so upgrading an existing repo starts a new local chain at seq 0.
 */
export function verifyReceiptChain(dir = getReceiptsDir()): ChainVerification {
  if (!existsSync(dir)) return verifyReceiptChainUnlocked(dir);

  const lockPath = path.join(dir, RECEIPT_STORE_LOCK_FILE);
  const deadline = Date.now() + CHAIN_VERIFY_WAIT_MS;
  while (true) {
    if (!existsSync(lockPath)) {
      const headBefore = chainHeadFingerprint(dir);
      const verification = verifyReceiptChainUnlocked(dir);
      const headAfter = chainHeadFingerprint(dir);
      if (!existsSync(lockPath) && headBefore === headAfter) return verification;
    }

    if (Date.now() >= deadline) {
      return {
        present: receiptFilesIn(dir).length > 0 || existsSync(chainHeadPath(dir)),
        ok: false,
        length: 0,
        brokenAt: 0,
        reason: 'Receipt store remained busy while chain verification waited for an active writer.',
      };
    }
    sleepForChainVerification(CHAIN_VERIFY_RETRY_MS);
  }
}

function chainHeadFingerprint(dir: string): string {
  const filePath = chainHeadPath(dir);
  if (!existsSync(filePath)) return 'missing';
  try {
    return sha256(readRegularTextFileNoFollow(filePath, MAX_CHAIN_HEAD_BYTES));
  } catch {
    try {
      const stat = lstatSync(filePath);
      return `invalid:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return 'missing';
    }
  }
}

function sleepForChainVerification(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function verifyReceiptChainUnlocked(dir: string): ChainVerification {
  const files = receiptFilesIn(dir);
  const headState = inspectChainHead(dir);
  const chained: Array<{ filePath: string; receipt: SWDReceipt }> = [];

  const broken = (
    brokenAt: number,
    reason: string,
    headMatches?: boolean,
    length = chained.length,
  ): ChainVerification => ({
    present: true,
    ok: false,
    length,
    brokenAt,
    reason,
    headMatches,
  });

  for (const filePath of files) {
    const receipt = readReceiptFile(filePath);
    if (!receipt) {
      return broken(0, `Receipt file ${path.basename(filePath)} is unreadable or invalid JSON.`);
    }

    const expectedFilename = `${receipt.id}.json`;
    if (!RECEIPT_ID_PATTERN.test(receipt.id) || path.basename(filePath) !== expectedFilename) {
      return broken(
        receipt.chain?.seq ?? 0,
        `Receipt filename/id mismatch for ${path.basename(filePath)}.`,
      );
    }

    if (receipt.chain === undefined) continue;
    if (
      !Number.isSafeInteger(receipt.chain.seq)
      || receipt.chain.seq < 0
      || typeof receipt.chain.prevHash !== 'string'
      || (receipt.chain.prevHash !== '' && !/^[a-f0-9]{64}$/.test(receipt.chain.prevHash))
    ) {
      return broken(receipt.chain.seq ?? 0, `Receipt ${receipt.id} has invalid chain metadata.`);
    }

    chained.push({ filePath, receipt });
  }

  if (chained.length === 0) {
    if (headState.exists) {
      return broken(0, 'Receipt chain HEAD exists, but no chained receipts are present.', false, 0);
    }
    return { present: false, ok: true, length: 0 };
  }

  if (!headState.exists) {
    return broken(
      Math.max(...chained.map(({ receipt }) => receipt.chain!.seq)),
      'Receipt chain HEAD is missing while chained receipts are present.',
      false,
    );
  }
  if (!headState.head) {
    return broken(0, 'Receipt chain HEAD is unreadable or invalid.', false);
  }

  chained.sort((left, right) => {
    const seqDifference = left.receipt.chain!.seq - right.receipt.chain!.seq;
    return seqDifference !== 0 ? seqDifference : left.receipt.id.localeCompare(right.receipt.id);
  });

  const seenSequences = new Map<number, string>();
  const seenIds = new Set<string>();
  const childrenByPrevHash = new Map<string, string>();
  for (const { receipt } of chained) {
    const seq = receipt.chain!.seq;
    const priorAtSequence = seenSequences.get(seq);
    if (priorAtSequence) {
      return broken(seq, `Duplicate chain sequence ${seq} is used by ${priorAtSequence} and ${receipt.id}.`);
    }
    seenSequences.set(seq, receipt.id);

    if (seenIds.has(receipt.id)) {
      return broken(seq, `Duplicate receipt id ${receipt.id} appears in the chain.`);
    }
    seenIds.add(receipt.id);

    if (seq > 0) {
      const existingChild = childrenByPrevHash.get(receipt.chain!.prevHash);
      if (existingChild) {
        return broken(
          seq,
          `Receipt chain fork: ${existingChild} and ${receipt.id} share the same prevHash.`,
        );
      }
      childrenByPrevHash.set(receipt.chain!.prevHash, receipt.id);
    }
  }

  const first = chained[0]!.receipt.chain!;
  if (first.seq !== 0) {
    return broken(0, `The earliest receipts are missing — the chain starts at seq ${first.seq} instead of genesis (seq 0).`);
  }
  if (first.prevHash !== GENESIS_PREV_HASH) {
    return broken(0, 'The genesis receipt has a non-empty prevHash, so it is not a valid chain start.');
  }

  let prevHash: string | null = null;
  let expectedSeq = 0;
  for (const { receipt } of chained) {
    const seq = receipt.chain!.seq;

    if (!verifyReceiptIntegrity(receipt)) {
      return broken(seq, `Receipt ${receipt.id} (seq ${seq}) was edited after creation — its integrity hash no longer matches.`);
    }
    if (seq !== expectedSeq) {
      return broken(expectedSeq, `Chain gap at seq ${expectedSeq}: a receipt is missing or out of order.`);
    }
    if (prevHash !== null && receipt.chain!.prevHash !== prevHash) {
      return broken(seq, `Broken link at seq ${seq}: prevHash does not match the previous receipt's hash.`);
    }

    prevHash = receipt.integrity!.sha256;
    expectedSeq += 1;
  }

  const head = headState.head;
  const tip = chained[chained.length - 1]!.receipt;
  const headMatches = head.id === tip.id
    && head.seq === tip.chain!.seq
    && head.hash === tip.integrity!.sha256;

  if (!headMatches) {
    return broken(
      tip.chain!.seq,
      'The chain HEAD pointer does not match the latest receipt — the tip may be missing, replaced, or incompletely committed.',
      false,
    );
  }

  return { present: true, ok: true, length: chained.length, headMatches: true };
}


function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export const createReceipt = createSWDReceipt;
export const saveReceipt = saveSWDReceipt;
