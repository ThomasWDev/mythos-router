import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suggestProjectPolicy } from '../src/policy-suggestions.js';

describe('policy suggestions', () => {
  it('suggests high-impact guardrails from repo structure without writing policy files', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mythos-policy-suggest-'));

    try {
      mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
      mkdirSync(join(tempDir, 'contracts', 'mainnet'), { recursive: true });
      mkdirSync(join(tempDir, 'scripts'), { recursive: true });
      writeFileSync(join(tempDir, '.env.example'), 'API_KEY=\n', 'utf-8');
      writeFileSync(join(tempDir, 'scripts', 'deploy.ts'), 'console.log("deploy");\n', 'utf-8');

      const result = suggestProjectPolicy(tempDir);
      const patterns = result.suggestions.map((suggestion) => `${suggestion.risk}:${suggestion.pattern}`);

      assert.equal(result.ok, true);
      assert.ok(patterns.includes('confirm:.github/workflows/**'));
      assert.ok(patterns.includes('block:contracts/mainnet/**'));
      assert.ok(patterns.includes('block:**/.env*'));
      assert.ok(patterns.includes('confirm:scripts/**'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
