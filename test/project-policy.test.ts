import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROJECT_POLICY_SCHEMA,
  loadProjectPolicy,
  validateProjectPolicy,
} from '../src/project-policy.js';

function withTempPolicy(policy: unknown, fn: (rootDir: string) => void): void {
  const rootDir = mkdtempSync(join(tmpdir(), 'mythos-project-policy-'));
  try {
    mkdirSync(join(rootDir, '.mythos'), { recursive: true });
    writeFileSync(join(rootDir, '.mythos', 'policy.json'), `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
    fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

describe('project policy validation', () => {
  it('keeps the published JSON schema synchronized with the runtime schema', () => {
    const published = JSON.parse(readFileSync('schemas/project-policy.schema.json', 'utf8'));
    assert.deepEqual(published, PROJECT_POLICY_SCHEMA);
  });

  it('accepts a valid strict policy', () => {
    const errors = validateProjectPolicy({
      version: 1,
      block: ['infra/prod/**'],
      confirm: ['src/payments/**'],
      limits: {
        allowDeletes: false,
        maxActions: 25,
        maxActionContentBytes: 120_000,
        allowedOperations: ['CREATE', 'MODIFY', 'READ'],
      },
      checks: [{ name: 'test', command: 'npm test' }],
    });

    assert.deepEqual(errors, []);
  });

  it('rejects an unknown top-level key and suggests the intended field', () => {
    const errors = validateProjectPolicy({ version: 1, blok: ['**'] });
    assert.match(errors.join('\n'), /Unknown project policy key "blok"/);
    assert.match(errors.join('\n'), /Did you mean "block"/);
  });

  it('rejects unknown nested limit and check keys', () => {
    const errors = validateProjectPolicy({
      version: 1,
      limits: { maxActions: 2, maxActionz: 3 },
      checks: [{ name: 'test', command: 'npm test', commnd: 'npm run hidden' }],
    });

    assert.match(errors.join('\n'), /Unknown project policy limits key "maxActionz"/);
    assert.match(errors.join('\n'), /Did you mean "maxActions"/);
    assert.match(errors.join('\n'), /Unknown project policy check key "commnd"/);
    assert.match(errors.join('\n'), /Did you mean "command"/);
  });

  it('fails closed when a loaded policy contains an unknown key', () => {
    withTempPolicy({ version: 1, blok: ['**'] }, (rootDir) => {
      const state = loadProjectPolicy(rootDir);
      assert.equal(state.found, true);
      assert.equal(state.policy, undefined);
      assert.match(state.errors.join('\n'), /Unknown project policy key "blok"/);
    });
  });

  it('rejects parent traversal in policy path patterns', () => {
    const errors = validateProjectPolicy({ version: 1, block: ['src/../secrets/**'] });
    assert.match(errors.join('\n'), /unsafe or overlong pattern/);
  });
});
