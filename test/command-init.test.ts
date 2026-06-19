import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { initCommand } from '../src/commands/init.js';
import { captureRun, withTempCwd, stripAnsi } from './support.js';

describe('initCommand', () => {
  it('check mode is read-only and writes no files', async () => {
    await withTempCwd(async (dir) => {
      const { output } = await captureRun(() => initCommand({ check: true }));
      const text = stripAnsi(output);
      assert.ok(text.includes('PROJECT CHECK'));
      assert.ok(text.includes('Environment'));
      assert.ok(text.includes('Providers'));
      // No scaffolding should have happened.
      assert.equal(existsSync(join(dir, '.mythosignore')), false);
      assert.equal(existsSync(join(dir, 'MEMORY.md')), false);
      assert.equal(existsSync(join(dir, '.mythos')), false);
    });
  });

  it('warns that --force is ignored in check mode', async () => {
    await withTempCwd(async () => {
      const { output } = await captureRun(() => initCommand({ check: true, force: true }));
      assert.ok(stripAnsi(output).includes('--force is ignored'));
    });
  });

  it('scaffolds the project surface on a fresh repo', async () => {
    await withTempCwd(async (dir) => {
      const { output } = await captureRun(() => initCommand({}));
      assert.ok(stripAnsi(output).includes('PROJECT INITIALIZATION'));
      assert.equal(existsSync(join(dir, '.mythosignore')), true);
      assert.equal(existsSync(join(dir, 'MEMORY.md')), true);
      assert.equal(existsSync(join(dir, '.mythos')), true);
    });
  });

  it('is idempotent: a second run reports existing files rather than failing', async () => {
    await withTempCwd(async (dir) => {
      await captureRun(() => initCommand({}));
      const { exitCode } = await captureRun(() => initCommand({}));
      assert.notEqual(exitCode, 1);
      assert.equal(existsSync(join(dir, '.mythosignore')), true);
    });
  });
});
