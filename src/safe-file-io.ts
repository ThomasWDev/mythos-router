import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { AtomicFileWriter } from './atomic-writer.js';
import { PathJail } from './path-jail.js';

const HASH_BUFFER_BYTES = 64 * 1024;
const atomicWriter = new AtomicFileWriter();

export interface RegularFileDigest {
  exists: boolean;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface AtomicJailedTextWriteOptions {
  createOnly: boolean;
  defaultMode?: number;
  expectedExistingContent?: string | null;
  maxExistingBytes?: number;
}

/** Read a bounded regular file without following a final-component symlink. */
export function readRegularTextFileNoFollow(filePath: string, maxBytes: number): string {
  const beforeOpen = lstatSync(filePath);
  if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
    throw new Error(`Refusing to read non-regular file: ${filePath}`);
  }
  if (beforeOpen.size > maxBytes) {
    throw new Error(`File exceeds ${maxBytes} bytes: ${filePath}`);
  }

  let fd: number | null = null;
  try {
    fd = openSync(filePath, constants.O_RDONLY | noFollowFlag());
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes) {
      throw new Error(`File is unsafe or too large: ${filePath}`);
    }
    assertSameOpenedFile(beforeOpen, opened, filePath);
    return readFileSync(fd, 'utf8');
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Hash a regular file through an established PathJail without loading the
 * complete file into memory. Missing targets return an explicit absent digest.
 */
export function digestJailedRegularFile(jail: PathJail, filePath: string): RegularFileDigest {
  const absolutePath = jail.resolve(filePath);
  let beforeOpen: Stats;
  try {
    beforeOpen = lstatSync(absolutePath);
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return { exists: false, size: 0, mtimeMs: 0, sha256: '' };
    }
    throw error;
  }

  if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
    throw new Error(`Target is not a regular file: ${filePath}`);
  }

  let fd: number | null = null;
  try {
    fd = openSync(absolutePath, constants.O_RDONLY | noFollowFlag());
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`Target is not a regular file: ${filePath}`);
    assertSameOpenedFile(beforeOpen, opened, filePath);

    // Re-run the complete component check after opening. This catches an
    // ancestor or final path component replaced with a symlink during open.
    jail.resolve(filePath);

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let position = 0;
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    return {
      exists: true,
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      sha256: hash.digest('hex'),
    };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Commit text through the shared same-directory atomic writer and PathJail. */
export function atomicWriteTextInJail(
  jail: PathJail,
  relativePath: string,
  content: string,
  options: AtomicJailedTextWriteOptions,
): void {
  const targetPath = jail.resolve(relativePath);
  let mode = options.defaultMode ?? 0o600;
  if (existsSync(targetPath)) {
    const existing = lstatSync(targetPath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`Refusing to replace non-regular file ${relativePath}.`);
    }
    mode = existing.mode;
  }

  atomicWriter.write(targetPath, content, {
    createOnly: options.createOnly,
    mode,
    afterTempCreated: (tempPath) => {
      jail.resolve(tempPath);
    },
    beforeCommit: () => {
      jail.resolve(relativePath);
      if (!options.createOnly) {
        const current = existsSync(targetPath)
          ? readRegularTextFileNoFollow(
            targetPath,
            options.maxExistingBytes ?? Number.MAX_SAFE_INTEGER,
          )
          : null;
        if (current !== (options.expectedExistingContent ?? null)) {
          throw new Error(`Concurrent modification detected for ${relativePath}.`);
        }
      }
    },
  });
}

function noFollowFlag(): number {
  return 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
}

function assertSameOpenedFile(
  beforeOpen: Stats,
  opened: Stats,
  filePath: string,
): void {
  if (
    beforeOpen.dev !== 0
    && beforeOpen.ino !== 0
    && (beforeOpen.dev !== opened.dev || beforeOpen.ino !== opened.ino)
  ) {
    throw new Error(`File changed while it was being opened: ${filePath}`);
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
