import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { verifyCommand } from '../src/commands/verify.js';
import { captureRun, withTempCwd } from './support.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', [
    '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.autocrlf=false',  // keep LF fixtures byte-identical so diffs are deterministic on Windows
    '-c', 'core.fsmonitor=false', // no background fsmonitor process holding .git handles
    '-c', 'gc.auto=0',            // no background gc locking .git during teardown
    ...args,
  ], {
    cwd,
    stdio: 'ignore',
  });
}

function initRepo(dir: string): void {
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Mythos Test']);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node t.js' } }, null, 2));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const ok = true;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
}

describe('verifyCommand (--ci)', () => {
  it('emits machine-readable JSON and exits 0 on a clean diff', async () => {
    await withTempCwd(async (dir) => {
      initRepo(dir);
      writeFileSync(join(dir, 'src', 'index.ts'), 'export const ok = false;\n');

      const { output, exitCode } = await captureRun(() => verifyCommand({ ci: true, json: true }));
      const report = JSON.parse(output);

      assert.equal(report.mode, 'generic');
      assert.equal(report.summary.exitCode, 0);
      assert.equal(exitCode, 0);
    });
  });

  it('exits 1 and reports a finding when a risky lifecycle script is added', async () => {
    await withTempCwd(async (dir) => {
      initRepo(dir);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        scripts: { test: 'node t.js', postinstall: 'node scripts/x.js' },
      }, null, 2));

      const { output, exitCode } = await captureRun(() => verifyCommand({ ci: true, json: true }));
      const report = JSON.parse(output);

      assert.equal(report.summary.exitCode, 1);
      assert.equal(exitCode, 1);
      assert.ok(report.findings.some((f: { id: string }) => f.id === 'npm-lifecycle-script-added'));
    });
  });

  it('reports a structured error object (exit 2) when run outside a git repo', async () => {
    await withTempCwd(async () => {
      const { output, exitCode } = await captureRun(() => verifyCommand({ ci: true, json: true }));
      const payload = JSON.parse(output);
      assert.equal(payload.tool, 'mythos-verify-ci');
      assert.equal(payload.exitCode, 2);
      assert.equal(exitCode, 2);
    });
  });
});
