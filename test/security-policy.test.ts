import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyActionRisk,
  reviewActions,
  touchesCommandSurface,
} from '../src/security-policy.js';
import type { FileAction } from '../src/swd.js';

function action(path: string, operation: FileAction['operation'] = 'MODIFY'): FileAction {
  return {
    path,
    operation,
    intent: 'MUTATE',
    content: 'content',
    description: 'test action',
  };
}

const NO_PROJECT_POLICY = { found: false, path: '', errors: [] };

async function withTempProject<T>(prefix: string, fn: (dir: string) => Promise<T> | T): Promise<T> {
  const original = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(original);
    rmSync(dir, { recursive: true, force: true });
  }
}

function writePolicy(policy: unknown): void {
  mkdirSync('.mythos', { recursive: true });
  writeFileSync('.mythos/policy.json', `${JSON.stringify(policy, null, 2)}\n`, 'utf-8');
}

describe('security policy', () => {
  it('auto-approves ordinary source files', () => {
    const verdict = classifyActionRisk(action('src/example.ts'), NO_PROJECT_POLICY);
    assert.equal(verdict.risk, 'safe');
  });

  it('requires confirmation for command-affecting files', () => {
    const verdict = classifyActionRisk(action('package.json'), NO_PROJECT_POLICY);
    assert.equal(verdict.risk, 'confirm');
    assert.equal(touchesCommandSurface([action('package.json')]), true);
  });

  it('requires confirmation for deletes', () => {
    const verdict = classifyActionRisk(action('src/old.ts', 'DELETE'), NO_PROJECT_POLICY);
    assert.equal(verdict.risk, 'confirm');
  });

  it('blocks sensitive files by default', () => {
    const verdict = classifyActionRisk(action('.env'), NO_PROJECT_POLICY);
    assert.equal(verdict.risk, 'block');
  });

  it('blocks sensitive files in subdirectories by default', () => {
    assert.equal(classifyActionRisk(action('apps/api/.env'), NO_PROJECT_POLICY).risk, 'block');
    assert.equal(classifyActionRisk(action('packages/shared/.npmrc'), NO_PROJECT_POLICY).risk, 'block');
    assert.equal(classifyActionRisk(action('services/web/.git/config'), NO_PROJECT_POLICY).risk, 'block');
  });

  it('requires confirmation for command surfaces in subdirectories', () => {
    assert.equal(classifyActionRisk(action('services/web/Dockerfile'), NO_PROJECT_POLICY).risk, 'confirm');
    assert.equal(classifyActionRisk(action('backend/scripts/deploy.sh'), NO_PROJECT_POLICY).risk, 'confirm');
    assert.equal(classifyActionRisk(action('packages/app/package.json'), NO_PROJECT_POLICY).risk, 'confirm');
    assert.equal(touchesCommandSurface([action('services/api/Makefile')]), true);
  });

  it('separates safe, confirm, and blocked actions', async () => {
    await withTempProject('mythos-policy-base-', () => {
      const review = reviewActions([
        action('src/ok.ts'),
        action('package.json'),
        action('.npmrc'),
      ]);

      assert.equal(review.approved.length, 1);
      assert.equal(review.needsConfirmation.length, 1);
      assert.equal(review.blocked.length, 1);
    });
  });

  it('blocks project-specific paths from .mythos/policy.json', async () => {
    await withTempProject('mythos-policy-block-', () => {
      writePolicy({
        version: 1,
        block: ['contracts/mainnet/**'],
      });

      const verdict = classifyActionRisk(action('contracts/mainnet/Vault.sol'));
      assert.equal(verdict.risk, 'block');
      assert.match(verdict.reason, /Project policy blocks/);
    });
  });

  it('normalizes slash-heavy project policy paths without regex trimming', async () => {
    await withTempProject('mythos-policy-slashes-', () => {
      writePolicy({
        version: 1,
        block: ['.////contracts/mainnet/**////'],
      });

      const verdict = classifyActionRisk(action(`.////contracts/mainnet/Vault.sol${'/'.repeat(4096)}`));
      assert.equal(verdict.risk, 'block');
      assert.match(verdict.reason, /Project policy blocks/);
    });
  });

  it('requires confirmation for project-specific paths', async () => {
    await withTempProject('mythos-policy-confirm-', () => {
      writePolicy({
        version: 1,
        confirm: ['src/payments/**'],
      });

      const verdict = classifyActionRisk(action('src/payments/checkout.ts'));
      assert.equal(verdict.risk, 'confirm');
      assert.match(verdict.reason, /Project policy requires confirmation/);
    });
  });

  it('can block deletes through project policy limits', async () => {
    await withTempProject('mythos-policy-deletes-', () => {
      writePolicy({
        version: 1,
        limits: {
          allowDeletes: false,
        },
      });

      const verdict = classifyActionRisk(action('src/old.ts', 'DELETE'));
      assert.equal(verdict.risk, 'block');
      assert.match(verdict.reason, /blocks deletes/);
    });
  });

  it('fails closed when project policy is malformed', async () => {
    await withTempProject('mythos-policy-malformed-', () => {
      writePolicy({
        version: 1,
        block: 'src/private/**',
      });

      const review = reviewActions([action('src/ok.ts')]);
      assert.equal(review.approved.length, 0);
      assert.equal(review.blocked.length, 1);
      assert.match(review.blocked[0]!.verdict.reason, /Project policy is invalid/);
    });
  });

  it('can limit action batch size through project policy', async () => {
    await withTempProject('mythos-policy-max-actions-', () => {
      writePolicy({
        version: 1,
        limits: {
          maxActions: 1,
        },
      });

      const review = reviewActions([
        action('src/a.ts'),
        action('src/b.ts'),
      ]);

      assert.equal(review.approved.length, 0);
      assert.equal(review.blocked.length, 2);
      assert.match(review.blocked[0]!.verdict.reason, /exceeds maxActions 1/);
    });
  });
});
