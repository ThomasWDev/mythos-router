import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLockTimeoutError, withFileLockSync } from '../src/file-lock.js';

let tempDir = '';
let lockPath = '';

describe('file lock', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mythos-file-lock-'));
    lockPath = join(tempDir, 'store.lock');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates an exclusive lock for the callback and removes it afterward', () => {
    const result = withFileLockSync(lockPath, () => {
      assert.equal(existsSync(lockPath), true);
      const record = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number; token: string };
      assert.equal(record.pid, process.pid);
      assert.ok(record.token.length > 0);
      return 42;
    });

    assert.equal(result, 42);
    assert.equal(existsSync(lockPath), false);
  });

  it('does not reclaim a lock owned by a live process', () => {
    writeFileSync(lockPath, JSON.stringify({
      version: 1,
      token: 'live-owner',
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date(0).toISOString(),
    }));

    assert.throws(
      () => withFileLockSync(lockPath, () => undefined, {
        timeoutMs: 30,
        retryDelayMs: 5,
        staleMs: 1,
      }),
      FileLockTimeoutError,
    );
    assert.equal(existsSync(lockPath), true);
  });

  it('reclaims a valid lock whose same-host owner has exited', () => {
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
    });
    assert.equal(child.status, 0);
    const deadPid = Number(child.stdout);
    assert.ok(Number.isSafeInteger(deadPid) && deadPid > 0);

    writeFileSync(lockPath, JSON.stringify({
      version: 1,
      token: 'dead-owner',
      pid: deadPid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    }));

    let entered = false;
    withFileLockSync(lockPath, () => {
      entered = true;
    }, { timeoutMs: 250, retryDelayMs: 5, staleMs: 60_000 });

    assert.equal(entered, true);
    assert.equal(existsSync(lockPath), false);
  });

  it('reclaims a malformed lock only after it is old enough', () => {
    writeFileSync(lockPath, 'not-json');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    withFileLockSync(lockPath, () => {
      const record = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number };
      assert.equal(record.pid, process.pid);
    }, { timeoutMs: 250, retryDelayMs: 5, staleMs: 10 });

    assert.equal(existsSync(lockPath), false);
  });

  it('refuses to remove a lock whose ownership token changed', () => {
    assert.throws(
      () => withFileLockSync(lockPath, () => {
        writeFileSync(lockPath, JSON.stringify({
          version: 1,
          token: 'replacement-owner',
          pid: process.pid,
          hostname: hostname(),
          createdAt: new Date().toISOString(),
        }));
      }),
      /no longer owned/i,
    );
    assert.equal(existsSync(lockPath), true);
  });
});
