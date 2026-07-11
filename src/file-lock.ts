import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 20;
const DEFAULT_STALE_MS = 30_000;

export interface FileLockOptions {
  /** Maximum time to wait for a live lock before failing. */
  timeoutMs?: number;
  /** Delay between acquisition attempts. */
  retryDelayMs?: number;
  /** Age after which an unverifiable lock may be reclaimed. */
  staleMs?: number;
}

interface FileLockRecord {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

export class FileLockTimeoutError extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for file lock: ${lockPath}`);
    this.name = 'FileLockTimeoutError';
  }
}

/**
 * Execute a synchronous critical section guarded by an exclusive lock file.
 *
 * Lock ownership is represented by a random token. A lock owned by a dead
 * process on the same host may be reclaimed immediately; malformed or remote
 * locks are reclaimed only after `staleMs`. Release removes the lock only when
 * the on-disk token still belongs to this caller.
 */
export function withFileLockSync<T>(
  lockPath: string,
  callback: () => T,
  options: FileLockOptions = {},
): T {
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const retryDelayMs = positiveInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS, 'retryDelayMs');
  const staleMs = positiveInteger(options.staleMs, DEFAULT_STALE_MS, 'staleMs');
  const deadline = Date.now() + timeoutMs;
  const record: FileLockRecord = {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  };

  while (!tryAcquire(lockPath, record)) {
    tryReclaimStaleLock(lockPath, staleMs);
    if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath, timeoutMs);
    sleepSync(Math.min(retryDelayMs, Math.max(1, deadline - Date.now())));
  }

  let callbackFailed = false;
  try {
    return callback();
  } catch (error: unknown) {
    callbackFailed = true;
    throw error;
  } finally {
    try {
      releaseOwnedLock(lockPath, record.token);
    } catch (releaseError: unknown) {
      if (!callbackFailed) throw releaseError;
    }
  }
}

function tryAcquire(lockPath: string, record: FileLockRecord): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    fsyncSync(fd);
    return true;
  } catch (error: unknown) {
    if (isAlreadyExistsError(error)) return false;
    throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function tryReclaimStaleLock(lockPath: string, staleMs: number): void {
  const first = inspectLock(lockPath);
  if (!first || !isStale(first, staleMs)) return;

  // Re-read immediately before deletion. This cannot provide kernel-level
  // compare-and-delete semantics, but token/content + inode metadata checks
  // prevent deleting a lock that was normally replaced between inspections.
  const second = inspectLock(lockPath);
  if (!second || !sameObservedLock(first, second) || !isStale(second, staleMs)) return;

  try {
    unlinkSync(lockPath);
  } catch (error: unknown) {
    if (!isMissingPathError(error)) throw error;
  }
}

interface InspectedLock {
  content: string;
  mtimeMs: number;
  size: number;
  dev: bigint;
  ino: bigint;
  symbolicLink: boolean;
  record: FileLockRecord | null;
}

function inspectLock(lockPath: string): InspectedLock | null {
  try {
    const stat = lstatSync(lockPath, { bigint: true });
    if (stat.isSymbolicLink()) {
      return {
        content: '',
        mtimeMs: Number(stat.mtimeMs),
        size: Number(stat.size),
        dev: stat.dev,
        ino: stat.ino,
        symbolicLink: true,
        record: null,
      };
    }

    const content = readFileSync(lockPath, 'utf8');
    return {
      content,
      mtimeMs: Number(stat.mtimeMs),
      size: Number(stat.size),
      dev: stat.dev,
      ino: stat.ino,
      symbolicLink: false,
      record: parseRecord(content),
    };
  } catch (error: unknown) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function parseRecord(content: string): FileLockRecord | null {
  try {
    const value = JSON.parse(content) as Partial<FileLockRecord>;
    if (
      value.version === 1
      && typeof value.token === 'string'
      && value.token.length > 0
      && Number.isSafeInteger(value.pid)
      && (value.pid ?? 0) > 0
      && typeof value.hostname === 'string'
      && value.hostname.length > 0
      && typeof value.createdAt === 'string'
      && Number.isFinite(Date.parse(value.createdAt))
    ) {
      return value as FileLockRecord;
    }
  } catch {
    // Invalid records are treated as unverifiable, not immediately stale.
  }
  return null;
}

function isStale(lock: InspectedLock, staleMs: number): boolean {
  if (lock.symbolicLink) return false;

  if (lock.record?.hostname === hostname()) {
    const alive = isProcessAlive(lock.record.pid);
    if (alive !== null) return !alive;
  }

  return Date.now() - lock.mtimeMs >= staleMs;
}

function isProcessAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error)) return null;
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    return null;
  }
}

function sameObservedLock(left: InspectedLock, right: InspectedLock): boolean {
  return left.content === right.content
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size
    && left.dev === right.dev
    && left.ino === right.ino
    && left.symbolicLink === right.symbolicLink;
}

function releaseOwnedLock(lockPath: string, token: string): void {
  if (!existsSync(lockPath)) return;
  const observed = inspectLock(lockPath);
  if (!observed) return;
  if (observed.record?.token !== token) {
    throw new Error(`Refusing to release a file lock no longer owned by this process: ${lockPath}`);
  }
  unlinkSync(lockPath);
}

function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
