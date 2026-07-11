import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { AtomicFileWriter } from './atomic-writer.js';
import { PathJail } from './path-jail.js';
import { isSafeRelativePathShape } from './path-safety.js';
import type { FileAction, FileSnapshot } from './swd.js';

const JOURNAL_VERSION = 1;
const JOURNAL_ROOT = '.mythos/transactions';
const JOURNAL_FILE = 'journal.json';
const MAX_JOURNAL_BYTES = 2_000_000;
const HASH_BUFFER_BYTES = 64 * 1024;
const TRANSACTION_ID_PATTERN = /^[a-z0-9]+-[0-9]+-[a-f0-9-]{12}$/;
const BACKUP_FILE_PATTERN = /^backups\/[0-9]+-[a-zA-Z0-9._-]{1,84}\.bin$/;

export type TransactionState =
  | 'prepared'
  | 'writing'
  | 'verifying'
  | 'committed'
  | 'rolled-back'
  | 'recovery-required';

export type TransactionEntryState = 'planned' | 'applying' | 'applied';

export interface TransactionFileState {
  exists: boolean;
  size: number;
  hash: string;
  mode: number | null;
}

export interface TransactionEntry {
  index: number;
  path: string;
  operation: Exclude<FileAction['operation'], 'READ'>;
  status: TransactionEntryState;
  before: TransactionFileState;
  expectedAfter: Pick<TransactionFileState, 'exists' | 'hash'>;
  backupFile?: string;
}

export interface TransactionJournalData {
  version: typeof JOURNAL_VERSION;
  id: string;
  root: string;
  createdAt: string;
  updatedAt: string;
  owner: {
    pid: number;
    hostname: string;
  };
  state: TransactionState;
  currentEntry?: number;
  entries: TransactionEntry[];
  createdDirs: string[];
  recoveryErrors: string[];
  integrityHash: string;
}

export interface TransactionInspection {
  id: string;
  state: TransactionState | 'invalid';
  active: boolean;
  path: string;
  journal?: TransactionJournalData;
  error?: string;
}

export interface TransactionRecoveryResult {
  id: string;
  recovered: boolean;
  cleaned: boolean;
  errors: string[];
}

/** Durable per-run rollback material for recovering interrupted SWD batches. */
export class SWDTransactionJournal {
  private readonly jail: PathJail;
  private readonly writer = new AtomicFileWriter();
  private readonly transactionRelativeDir: string;
  private readonly journalRelativePath: string;
  private data: TransactionJournalData;

  private constructor(jail: PathJail, data: TransactionJournalData) {
    this.jail = jail;
    this.data = data;
    this.transactionRelativeDir = `${JOURNAL_ROOT}/${data.id}`;
    this.journalRelativePath = `${this.transactionRelativeDir}/${JOURNAL_FILE}`;
  }

  public static create(
    rootDir: string,
    actions: FileAction[],
    snapshots: ReadonlyMap<string, FileSnapshot>,
  ): SWDTransactionJournal | null {
    const jail = new PathJail(rootDir);
    const writable = actions.filter(
      (action): action is FileAction & { operation: Exclude<FileAction['operation'], 'READ'> } => {
        if (action.operation === 'READ') return false;
        const before = snapshots.get(jail.resolve(action.path));
        if (!before) return false;
        if (action.operation === 'CREATE') return !before.exists && action.content !== undefined;
        if (action.operation === 'MODIFY') return before.exists && action.content !== undefined;
        return before.exists;
      },
    );
    if (writable.length === 0) return null;

    const id = `${Date.now().toString(36)}-${process.pid}-${randomUUID().slice(0, 12)}`;
    const relativeDir = `${JOURNAL_ROOT}/${id}`;
    const journalPath = `${relativeDir}/${JOURNAL_FILE}`;
    jail.ensureParentDirectories(jail.resolve(journalPath));
    const absoluteDir = jail.resolve(relativeDir);
    try {
      chmodSync(absoluteDir, 0o700);
    } catch {
      // Best effort on filesystems that do not support POSIX modes.
    }

    const now = new Date().toISOString();
    const entries: TransactionEntry[] = writable.map((action, index) => {
      const absolutePath = jail.resolve(action.path);
      const before = snapshots.get(absolutePath);
      if (!before) throw new Error(`Missing before-snapshot for transaction path ${action.path}.`);
      const expectedAfter = expectedAfterState(action);
      const entry: TransactionEntry = {
        index,
        path: action.path,
        operation: action.operation,
        status: 'planned',
        before: summarizeFileState(before),
        expectedAfter,
      };

      if (before.exists) {
        if (!before.content) {
          throw new Error(`Rollback content is unavailable for transaction path ${action.path}.`);
        }
        entry.backupFile = `backups/${index}-${safeName(basename(action.path))}.bin`;
      }
      return entry;
    });

    const data = withIntegrity({
      version: JOURNAL_VERSION,
      id,
      root: jail.root,
      createdAt: now,
      updatedAt: now,
      owner: { pid: process.pid, hostname: hostname() },
      state: 'prepared',
      entries,
      createdDirs: [],
      recoveryErrors: [],
    });
    const journal = new SWDTransactionJournal(jail, data);

    try {
      for (const entry of entries) {
        if (!entry.backupFile) continue;
        const before = snapshots.get(jail.resolve(entry.path))!;
        journal.writeBackup(entry.backupFile, before.content!);
      }
      journal.persist(true);
      return journal;
    } catch (error) {
      try {
        rmSync(absoluteDir, { recursive: true, force: true });
        pruneEmptyJournalParents(jail);
      } catch {
        // Keep the original setup failure.
      }
      throw error;
    }
  }

  public markApplying(action: FileAction): void {
    const entry = this.findEntry(action);
    if (!entry) return;
    entry.status = 'applying';
    this.data.state = 'writing';
    this.data.currentEntry = entry.index;
    this.persist(false);
  }

  public markApplied(action: FileAction): void {
    const entry = this.findEntry(action);
    if (!entry) return;
    entry.status = 'applied';
    this.data.state = 'writing';
    this.data.currentEntry = entry.index;
    this.persist(false);
  }

  public recordCreatedDirectory(absolutePath: string): void {
    const fromRoot = relative(this.jail.root, absolutePath).replace(/\\/g, '/');
    if (!fromRoot || fromRoot.startsWith('../')) return;
    if (!this.data.createdDirs.includes(fromRoot)) {
      this.data.createdDirs.push(fromRoot);
      this.data.createdDirs.sort((a, b) => b.length - a.length);
      this.persist(false);
    }
  }

  public markVerifying(): void {
    this.data.state = 'verifying';
    delete this.data.currentEntry;
    this.persist(false);
  }

  public finish(state: 'committed' | 'rolled-back' | 'recovery-required', errors: string[] = []): void {
    this.data.state = state;
    this.data.recoveryErrors = [...errors];
    delete this.data.currentEntry;
    this.persist(false);
    if (state !== 'recovery-required') {
      try {
        this.cleanup();
      } catch {
        // The terminal state is already durable. Doctor can remove residue.
      }
    }
  }

  public cleanup(): void {
    const transactionDir = this.jail.resolve(this.transactionRelativeDir);
    rmSync(transactionDir, { recursive: true, force: true });
    pruneEmptyJournalParents(this.jail);
  }

  private findEntry(action: FileAction): TransactionEntry | undefined {
    return this.data.entries.find(
      entry => entry.path === action.path && entry.operation === action.operation,
    );
  }

  private writeBackup(relativeBackup: string, content: Buffer): void {
    const relativePath = `${this.transactionRelativeDir}/${relativeBackup}`;
    const target = this.jail.resolve(relativePath);
    this.jail.ensureParentDirectories(target);
    this.writer.write(target, content, {
      createOnly: true,
      mode: 0o600,
      afterTempCreated: tempPath => this.jail.resolve(tempPath),
    });
  }

  private persist(createOnly: boolean): void {
    this.data.updatedAt = new Date().toISOString();
    this.data = withIntegrity(withoutIntegrity(this.data));
    const target = this.jail.resolve(this.journalRelativePath);
    this.writer.write(target, `${JSON.stringify(this.data, null, 2)}\n`, {
      createOnly,
      mode: 0o600,
      afterTempCreated: tempPath => this.jail.resolve(tempPath),
      beforeCommit: () => this.jail.resolve(this.journalRelativePath),
    });
  }
}

export function inspectTransactionJournals(rootDir: string): TransactionInspection[] {
  const jail = new PathJail(rootDir);
  let root: string;
  try {
    root = jail.resolve(JOURNAL_ROOT);
  } catch {
    return [];
  }
  if (!existsSync(root)) return [];
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return [{
      id: 'unknown',
      state: 'invalid',
      active: false,
      path: root,
      error: 'Transaction journal root is not a safe directory.',
    }];
  }

  const inspections: TransactionInspection[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const id = entry.name;
    const path = join(root, id, JOURNAL_FILE);
    try {
      if (!TRANSACTION_ID_PATTERN.test(id)) throw new Error('Transaction directory name is invalid.');
      const journal = readJournalFile(path, jail.root, id);
      inspections.push({
        id,
        state: journal.state,
        active: isJournalOwnerAlive(journal),
        path,
        journal,
      });
    } catch (error) {
      inspections.push({
        id,
        state: 'invalid',
        active: false,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return inspections.sort((a, b) => a.id.localeCompare(b.id));
}

export function recoverInterruptedTransactions(
  rootDir: string,
  transactionId?: string,
  options: { allowActive?: boolean } = {},
): TransactionRecoveryResult[] {
  const jail = new PathJail(rootDir);
  const inspections = inspectTransactionJournals(rootDir)
    .filter(item => !transactionId || item.id === transactionId);
  return inspections.map(inspection => recoverOne(jail, inspection, options.allowActive ?? false));
}

function recoverOne(
  jail: PathJail,
  inspection: TransactionInspection,
  allowActive: boolean,
): TransactionRecoveryResult {
  const errors: string[] = [];
  if (!inspection.journal) {
    return { id: inspection.id, recovered: false, cleaned: false, errors: [inspection.error ?? 'Invalid journal.'] };
  }
  const journal = inspection.journal;
  if (inspection.active && !allowActive) {
    return { id: journal.id, recovered: false, cleaned: false, errors: ['Transaction owner process is still active.'] };
  }

  const transactionDir = `${JOURNAL_ROOT}/${journal.id}`;
  if (journal.state === 'committed' || journal.state === 'rolled-back') {
    try {
      rmSync(jail.resolve(transactionDir), { recursive: true, force: true });
      pruneEmptyJournalParents(jail);
      return { id: journal.id, recovered: true, cleaned: true, errors: [] };
    } catch (error) {
      return { id: journal.id, recovered: false, cleaned: false, errors: [String(error)] };
    }
  }

  for (const entry of [...journal.entries].reverse()) {
    if (entry.status === 'planned') continue;
    try {
      recoverEntry(jail, transactionDir, entry);
    } catch (error) {
      errors.push(`${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const relativeDir of journal.createdDirs) {
    try {
      const dir = jail.resolve(relativeDir);
      if (existsSync(dir)) rmdirSync(dir);
    } catch (error) {
      if (!isMissingPathError(error) && !isDirectoryNotEmptyError(error)) {
        errors.push(`${relativeDir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (errors.length > 0) {
    persistRecoveredState(jail, journal, 'recovery-required', errors);
    return { id: journal.id, recovered: false, cleaned: false, errors };
  }

  persistRecoveredState(jail, journal, 'rolled-back', []);
  rmSync(jail.resolve(transactionDir), { recursive: true, force: true });
  pruneEmptyJournalParents(jail);
  return { id: journal.id, recovered: true, cleaned: true, errors: [] };
}

function recoverEntry(jail: PathJail, transactionDir: string, entry: TransactionEntry): void {
  const current = snapshotPath(jail, entry.path);
  if (sameState(current, entry.before)) return;

  const matchesExpectedAfter = current.exists === entry.expectedAfter.exists
    && (!current.exists || current.hash === entry.expectedAfter.hash);
  if (!matchesExpectedAfter) {
    throw new Error('Current file has drifted from both the before-state and Mythos intended after-state; refusing to overwrite it.');
  }

  const target = jail.resolve(entry.path);
  if (!entry.before.exists) {
    if (current.exists) unlinkSync(target);
    return;
  }

  if (!entry.backupFile) throw new Error('Rollback backup is missing from the journal.');
  const backupPath = jail.resolve(`${transactionDir}/${entry.backupFile}`);
  const backup = readBoundedRegularFile(backupPath, Math.max(entry.before.size, 1));
  const backupHash = createHash('sha256').update(backup).digest('hex');
  if (backupHash !== entry.before.hash) throw new Error('Rollback backup hash does not match the recorded before-state.');

  jail.ensureParentDirectories(target);
  new AtomicFileWriter().write(target, backup, {
    createOnly: !current.exists,
    mode: entry.before.mode ?? 0o600,
    afterTempCreated: tempPath => jail.resolve(tempPath),
    beforeCommit: () => {
      const latest = snapshotPath(jail, entry.path);
      if (!sameState(latest, current)) throw new Error('Concurrent modification detected during recovery.');
    },
  });
}

function persistRecoveredState(
  jail: PathJail,
  journal: TransactionJournalData,
  state: TransactionState,
  errors: string[],
): void {
  const updated = withIntegrity({
    ...withoutIntegrity(journal),
    state,
    updatedAt: new Date().toISOString(),
    recoveryErrors: errors,
    currentEntry: undefined,
  });
  const path = jail.resolve(`${JOURNAL_ROOT}/${journal.id}/${JOURNAL_FILE}`);
  new AtomicFileWriter().write(path, `${JSON.stringify(updated, null, 2)}\n`, {
    createOnly: false,
    mode: 0o600,
    afterTempCreated: tempPath => jail.resolve(tempPath),
  });
}

function readJournalFile(path: string, expectedRoot: string, expectedId: string): TransactionJournalData {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Journal is not a regular file.');
  if (stat.size > MAX_JOURNAL_BYTES) throw new Error('Journal exceeds the maximum safe size.');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as TransactionJournalData;
  if (
    parsed.version !== JOURNAL_VERSION
    || parsed.id !== expectedId
    || !TRANSACTION_ID_PATTERN.test(parsed.id)
    || parsed.root !== expectedRoot
  ) {
    throw new Error('Journal metadata is invalid or belongs to another workspace.');
  }
  if (!Array.isArray(parsed.entries) || !Array.isArray(parsed.createdDirs) || !Array.isArray(parsed.recoveryErrors)) {
    throw new Error('Journal structure is invalid.');
  }
  const expectedHash = hashJournal(withoutIntegrity(parsed));
  if (parsed.integrityHash !== expectedHash) throw new Error('Journal integrity hash is invalid.');
  validateJournalStructure(parsed);
  return parsed;
}

function validateJournalStructure(journal: TransactionJournalData): void {
  const states: TransactionState[] = [
    'prepared', 'writing', 'verifying', 'committed', 'rolled-back', 'recovery-required',
  ];
  const entryStates: TransactionEntryState[] = ['planned', 'applying', 'applied'];
  const operations: TransactionEntry['operation'][] = ['CREATE', 'MODIFY', 'DELETE'];
  if (!states.includes(journal.state)) throw new Error('Journal state is invalid.');
  if (!journal.owner || !Number.isSafeInteger(journal.owner.pid) || journal.owner.pid <= 0 || typeof journal.owner.hostname !== 'string') {
    throw new Error('Journal owner metadata is invalid.');
  }
  if (Number.isNaN(Date.parse(journal.createdAt)) || Number.isNaN(Date.parse(journal.updatedAt))) {
    throw new Error('Journal timestamps are invalid.');
  }
  if (journal.currentEntry !== undefined && (!Number.isSafeInteger(journal.currentEntry) || journal.currentEntry < 0)) {
    throw new Error('Journal current entry is invalid.');
  }

  const paths = new Set<string>();
  for (let index = 0; index < journal.entries.length; index += 1) {
    const entry = journal.entries[index]!;
    if (entry.index !== index || paths.has(entry.path) || !isSafeRelativePathShape(entry.path)) {
      throw new Error('Journal action paths or indexes are invalid.');
    }
    paths.add(entry.path);
    if (!operations.includes(entry.operation) || !entryStates.includes(entry.status)) {
      throw new Error('Journal action metadata is invalid.');
    }
    validateFileState(entry.before, 'before-state');
    if (typeof entry.expectedAfter?.exists !== 'boolean' || typeof entry.expectedAfter?.hash !== 'string') {
      throw new Error('Journal expected after-state is invalid.');
    }
    if (entry.expectedAfter.exists && !/^[a-f0-9]{64}$/.test(entry.expectedAfter.hash)) {
      throw new Error('Journal expected after hash is invalid.');
    }
    if (!entry.expectedAfter.exists && entry.expectedAfter.hash !== '') {
      throw new Error('Journal deleted after-state must use an empty hash.');
    }
    if (entry.before.exists) {
      if (typeof entry.backupFile !== 'string' || !BACKUP_FILE_PATTERN.test(entry.backupFile)) {
        throw new Error('Journal rollback backup path is invalid.');
      }
    } else if (entry.backupFile !== undefined) {
      throw new Error('Journal contains an unexpected rollback backup.');
    }
  }
  if (journal.currentEntry !== undefined && journal.currentEntry >= journal.entries.length) {
    throw new Error('Journal current entry is out of range.');
  }
  if (journal.createdDirs.some(path => !isSafeRelativePathShape(path))) {
    throw new Error('Journal created-directory path is invalid.');
  }
  if (journal.recoveryErrors.some(error => typeof error !== 'string')) {
    throw new Error('Journal recovery errors are invalid.');
  }
}

function validateFileState(state: TransactionFileState, label: string): void {
  if (!state || typeof state.exists !== 'boolean' || !Number.isSafeInteger(state.size) || state.size < 0) {
    throw new Error(`Journal ${label} is invalid.`);
  }
  if (state.mode !== null && (!Number.isSafeInteger(state.mode) || state.mode < 0)) {
    throw new Error(`Journal ${label} mode is invalid.`);
  }
  if (state.exists) {
    if (!/^[a-f0-9]{64}$/.test(state.hash)) throw new Error(`Journal ${label} hash is invalid.`);
  } else if (state.size !== 0 || state.hash !== '' || state.mode !== null) {
    throw new Error(`Journal missing ${label} must be empty.`);
  }
}

function expectedAfterState(action: FileAction): Pick<TransactionFileState, 'exists' | 'hash'> {
  if (action.operation === 'DELETE') return { exists: false, hash: '' };
  if (action.content !== undefined) {
    return { exists: true, hash: createHash('sha256').update(action.content).digest('hex') };
  }
  return { exists: true, hash: action.contentHash ?? '' };
}

function summarizeFileState(snapshot: FileSnapshot): TransactionFileState {
  return {
    exists: snapshot.exists,
    size: snapshot.size,
    hash: snapshot.hash,
    mode: snapshot.mode,
  };
}

function snapshotPath(jail: PathJail, relativePath: string): TransactionFileState {
  const path = jail.resolve(relativePath);
  if (!existsSync(path)) return { exists: false, size: 0, hash: '', mode: null };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Target is not a regular file.');
  return { exists: true, size: stat.size, hash: hashFile(path), mode: stat.mode };
}

function hashFile(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, constants.O_RDONLY | noFollowFlag());
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    while (true) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function readBoundedRegularFile(path: string, maxBytes: number): Buffer {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Backup is not a regular file.');
  if (stat.size > maxBytes) throw new Error('Backup exceeds its recorded size.');
  return readFileSync(path);
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file';
}

function sameState(left: TransactionFileState, right: TransactionFileState): boolean {
  return left.exists === right.exists
    && left.hash === right.hash
    && left.mode === right.mode;
}

function withIntegrity(
  data: Omit<TransactionJournalData, 'integrityHash'>,
): TransactionJournalData {
  return { ...data, integrityHash: hashJournal(data) };
}

function withoutIntegrity(
  data: TransactionJournalData,
): Omit<TransactionJournalData, 'integrityHash'> {
  const { integrityHash: _ignored, ...rest } = data;
  return rest;
}

function hashJournal(data: Omit<TransactionJournalData, 'integrityHash'>): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

function isJournalOwnerAlive(journal: TransactionJournalData): boolean {
  if (journal.owner.hostname !== hostname()) return false;
  try {
    process.kill(journal.owner.pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function pruneEmptyJournalParents(jail: PathJail): void {
  for (const relativePath of [JOURNAL_ROOT, '.mythos']) {
    try {
      const path = jail.resolve(relativePath);
      if (existsSync(path)) rmdirSync(path);
    } catch (error) {
      if (!isDirectoryNotEmptyError(error) && !isMissingPathError(error)) throw error;
    }
  }
}

function noFollowFlag(): number {
  return 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isDirectoryNotEmptyError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && ['ENOTEMPTY', 'EEXIST'].includes(String(error.code));
}
