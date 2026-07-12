import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { mirrorWorkspaceForSandbox } from '../src/sandbox-files.js';

function withDirs(run: (root: string, dest: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'mythos-sandbox-source-'));
  const dest = mkdtempSync(join(tmpdir(), 'mythos-sandbox-dest-'));
  try { run(root, dest); } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
}

describe('sandbox file mirroring', () => {
  it('respects ignore files and excludes common secret material', () => withDirs((root, dest) => {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'cache'));
    writeFileSync(join(root, 'src', 'app.ts'), 'export {};');
    writeFileSync(join(root, 'cache', 'ignored.txt'), 'ignored');
    writeFileSync(join(root, '.gitignore'), 'cache/\n');
    writeFileSync(join(root, '.mythosignore'), 'private.txt\n');
    writeFileSync(join(root, 'private.txt'), 'private');
    writeFileSync(join(root, '.env'), 'SECRET=yes');
    writeFileSync(join(root, '.env.example'), 'SECRET=example');
    writeFileSync(join(root, 'server.key'), 'key');

    const result = mirrorWorkspaceForSandbox(root, dest);
    assert.equal(existsSync(join(dest, 'src', 'app.ts')), true);
    assert.equal(existsSync(join(dest, 'cache', 'ignored.txt')), false);
    assert.equal(existsSync(join(dest, 'private.txt')), false);
    assert.equal(existsSync(join(dest, '.env')), false);
    assert.equal(existsSync(join(dest, 'server.key')), false);
    assert.equal(readFileSync(join(dest, '.env.example'), 'utf8'), 'SECRET=example');
    assert.deepEqual(result.skippedSensitive.sort(), ['.env', 'server.key']);
  }));

  it('includes an ignored existing action target unless it is sensitive', () => withDirs((root, dest) => {
    mkdirSync(join(root, 'generated'));
    writeFileSync(join(root, '.gitignore'), 'generated/\n');
    writeFileSync(join(root, 'generated', 'target.txt'), 'old');

    mirrorWorkspaceForSandbox(root, dest, [{
      path: 'generated/target.txt',
      operation: 'MODIFY',
      intent: 'MUTATE',
      content: 'new',
    }]);
    assert.equal(readFileSync(join(dest, 'generated', 'target.txt'), 'utf8'), 'old');
  }));
});
