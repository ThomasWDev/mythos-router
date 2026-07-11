import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { runDoctor } from '../src/doctor.js';
import { TelemetryStore } from '../src/providers/telemetry.js';
import { WorkspaceContext } from '../src/workspace.js';

function workspaceFixture(): { root: string; home: string; workspace: WorkspaceContext; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'mythos-doctor-'));
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const workspace = new WorkspaceContext({ rootDir: root, homeDir: home });
  return {
    root,
    home,
    workspace,
    cleanup: () => {
      TelemetryStore.closeAll();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test('doctor reports a clean workspace as healthy', () => {
  const fixture = workspaceFixture();
  try {
    const report = runDoctor({ workspace: fixture.workspace });
    assert.equal(report.ok, true);
    assert.equal(report.exitCode, 0);
    assert.equal(report.checks.some(check => check.id === 'telemetry' && check.status === 'pass'), true);
    assert.equal(report.checks.some(check => check.id === 'transactions' && check.status === 'pass'), true);
  } finally {
    fixture.cleanup();
  }
});

test('doctor fails closed for an invalid project policy and malformed session', () => {
  const fixture = workspaceFixture();
  try {
    mkdirSync(join(fixture.root, '.mythos'), { recursive: true });
    writeFileSync(join(fixture.root, '.mythos', 'policy.json'), '{"version":1,"blok":["**"]}\n');
    const sessionPath = join(fixture.workspace.sessionsDir, 'latest.json');
    mkdirSync(dirname(sessionPath), { recursive: true });
    writeFileSync(sessionPath, '{not-json');

    const report = runDoctor({ workspace: fixture.workspace });
    assert.equal(report.ok, false);
    assert.equal(report.exitCode, 1);
    assert.equal(report.checks.find(check => check.id === 'project-policy')?.status, 'fail');
    assert.equal(report.checks.find(check => check.id === 'session')?.status, 'fail');
  } finally {
    fixture.cleanup();
  }
});

test('doctor --repair recovers a transaction left by a terminated process', () => {
  const fixture = workspaceFixture();
  try {
    const target = join(fixture.root, 'target.txt');
    writeFileSync(target, 'before');
    const journalModule = pathToFileURL(join(process.cwd(), 'src', 'transaction-journal.ts')).href;
    const swdModule = pathToFileURL(join(process.cwd(), 'src', 'swd.ts')).href;
    const script = `
      import { writeFileSync } from 'node:fs';
      import { SWDTransactionJournal } from ${JSON.stringify(journalModule)};
      import { snapshotFile } from ${JSON.stringify(swdModule)};
      const root = ${JSON.stringify(fixture.root)};
      const path = ${JSON.stringify(target)};
      const action = { path: 'target.txt', operation: 'MODIFY', intent: 'MUTATE', content: 'after' };
      const snapshots = new Map([[path, snapshotFile(path)]]);
      const journal = SWDTransactionJournal.create(root, [action], snapshots);
      journal.markApplying(action);
      writeFileSync(path, 'after');
      journal.markApplied(action);
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--eval', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(readFileSync(target, 'utf8'), 'after');

    const beforeRepair = runDoctor({ workspace: fixture.workspace });
    assert.equal(beforeRepair.checks.find(check => check.id === 'transactions')?.status, 'fail');

    const repaired = runDoctor({ workspace: fixture.workspace, repair: true });
    assert.equal(repaired.ok, true);
    assert.equal(repaired.repaired, 1);
    assert.equal(readFileSync(target, 'utf8'), 'before');
  } finally {
    fixture.cleanup();
  }
});
