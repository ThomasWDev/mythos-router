import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AtomicFileWriter } from '../src/atomic-writer.js';
import { snapshotFile, type FileAction } from '../src/swd.js';
import {
  SWDTransactionJournal,
  inspectTransactionJournals,
  recoverInterruptedTransactions,
} from '../src/transaction-journal.js';

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mythos-transaction-'));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function snapshots(root: string, actions: FileAction[]): Map<string, ReturnType<typeof snapshotFile>> {
  return new Map(actions.map(action => {
    const absolute = join(root, action.path);
    return [absolute, snapshotFile(absolute)];
  }));
}

describe('SWD transaction journal recovery', () => {
  it(
    'normalizes snapshot paths created through a workspace root alias',
    { skip: process.platform === 'win32' },
    () => withTempDir((parent) => {
      const actualRoot = join(parent, 'actual');
      const aliasRoot = join(parent, 'alias');
      mkdirSync(actualRoot);
      symlinkSync(actualRoot, aliasRoot, 'dir');

      const target = join(aliasRoot, 'file.txt');
      writeFileSync(target, 'before', 'utf8');
      const action: FileAction = {
        path: 'file.txt',
        operation: 'MODIFY',
        intent: 'MUTATE',
        content: 'after',
      };
      const journal = SWDTransactionJournal.create(
        aliasRoot,
        [action],
        snapshots(aliasRoot, [action]),
      );

      assert.ok(journal);
      journal.finish('rolled-back');
    }),
  );

  it('restores a modified file after an interrupted applied action', () => withTempDir((root) => {
    const target = join(root, 'file.txt');
    writeFileSync(target, 'before', 'utf8');
    const action: FileAction = { path: 'file.txt', operation: 'MODIFY', intent: 'MUTATE', content: 'after' };
    const journal = SWDTransactionJournal.create(root, [action], snapshots(root, [action]));
    assert.ok(journal);

    journal.markApplying(action);
    new AtomicFileWriter().write(target, 'after', { createOnly: false });
    journal.markApplied(action);

    const pending = inspectTransactionJournals(root);
    assert.equal(pending.length, 1);
    const recovered = recoverInterruptedTransactions(root, pending[0]!.id, { allowActive: true });
    assert.equal(recovered[0]!.recovered, true);
    assert.equal(readFileSync(target, 'utf8'), 'before');
    assert.equal(inspectTransactionJournals(root).length, 0);
  }));

  it('removes an interrupted CREATE even when the journal stopped at applying', () => withTempDir((root) => {
    const action: FileAction = { path: 'nested/new.txt', operation: 'CREATE', intent: 'MUTATE', content: 'new' };
    const journal = SWDTransactionJournal.create(root, [action], snapshots(root, [action]));
    assert.ok(journal);
    journal.markApplying(action);
    const target = join(root, action.path);
    mkdirSync(join(root, 'nested'));
    writeFileSync(target, 'new', 'utf8');

    const id = inspectTransactionJournals(root)[0]!.id;
    const result = recoverInterruptedTransactions(root, id, { allowActive: true })[0]!;
    assert.equal(result.recovered, true);
    assert.equal(existsSync(target), false);
  }));

  it('fails closed when current content drifted from both recorded states', () => withTempDir((root) => {
    const target = join(root, 'file.txt');
    writeFileSync(target, 'before', 'utf8');
    const action: FileAction = { path: 'file.txt', operation: 'MODIFY', intent: 'MUTATE', content: 'after' };
    const journal = SWDTransactionJournal.create(root, [action], snapshots(root, [action]));
    assert.ok(journal);
    journal.markApplying(action);
    writeFileSync(target, 'unexpected external edit', 'utf8');

    const id = inspectTransactionJournals(root)[0]!.id;
    const result = recoverInterruptedTransactions(root, id, { allowActive: true })[0]!;
    assert.equal(result.recovered, false);
    assert.match(result.errors.join('\n'), /refusing to overwrite/i);
    assert.equal(readFileSync(target, 'utf8'), 'unexpected external edit');
    assert.equal(inspectTransactionJournals(root)[0]!.state, 'recovery-required');
  }));
});
