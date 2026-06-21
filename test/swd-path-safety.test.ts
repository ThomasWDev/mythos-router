import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSafePath } from '../src/swd.js';

const originalCwd = process.cwd();
let tempDir = '';

describe('resolveSafePath traversal vs. filenames containing ".."', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mythos-path-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('allows a legitimate filename that merely contains ".."', () => {
    writeFileSync(join(tempDir, '..foo.txt'), 'x'); // exists, so realpath resolves
    const resolved = resolveSafePath('..foo.txt');
    assert.ok(resolved.endsWith('..foo.txt'), `expected to resolve inside cwd, got ${resolved}`);

    // Also works for a not-yet-existing file with the same shape (CREATE path).
    const resolvedNew = resolveSafePath('backup..old.ts');
    assert.ok(resolvedNew.endsWith('backup..old.ts'));
  });

  it('still rejects genuine parent-directory traversal', () => {
    assert.throws(() => resolveSafePath('../escape.txt'), /Path traversal/);
    assert.throws(() => resolveSafePath('a/../../b.txt'), /Path traversal/);
  });

  it('rejects absolute paths outside the project', () => {
    assert.throws(() => resolveSafePath('/etc/passwd'), /Path traversal/);
  });
});
