import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanChangedFilesForSecrets } from '../src/ci/secrets.js';
import type { ChangedFile } from '../src/ci/types.js';

// Synthetic, non-functional credential strings used only to exercise the
// detector. None are real keys.
const FAKE = {
  // 40 hex chars — DeepSeek / legacy-OpenAI style generic `sk-` key.
  deepseek: 'sk-' + 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  surplus: 'inf_' + 'A1b2C3d4E5f6A1b2C3d4E5f6',
  anthropic: 'sk-ant-' + 'api03dummydummydummydummy',
  openaiProject: 'sk-proj-' + 'dummydummydummydummydummy',
  github: 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
  npm: 'npm_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
  evmAssignment: 'PRIVATE_KEY="0x' + 'a'.repeat(64) + '"',
  pem: '-----BEGIN PRIVATE KEY-----',
};

function withFile(name: string, content: string, fn: (cwd: string, changed: ChangedFile[]) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mythos-secrets-'));
  try {
    writeFileSync(join(dir, name), content);
    fn(dir, [{ path: name, status: 'added' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('scanChangedFilesForSecrets', () => {
  it('detects a generic sk- key (DeepSeek / legacy OpenAI)', () => {
    withFile('config.ts', `const key = "${FAKE.deepseek}";\n`, (cwd, changed) => {
      const findings = scanChangedFilesForSecrets(cwd, changed);
      const ids = findings.map((f) => f.id);
      assert.ok(ids.includes('secret-generic-sk-key'), `expected generic-sk-key, got ${ids.join(', ')}`);
      // Evidence must be redacted, never the raw key.
      const evidence = findings.find((f) => f.id === 'secret-generic-sk-key')!.evidence.join('\n');
      assert.ok(evidence.includes('[API_KEY]'));
      assert.ok(!evidence.includes(FAKE.deepseek));
    });
  });

  it('detects a Surplus inf_ key', () => {
    withFile('.env', `SURPLUS_API_KEY=${FAKE.surplus}\n`, (cwd, changed) => {
      const findings = scanChangedFilesForSecrets(cwd, changed);
      const finding = findings.find((f) => f.id === 'secret-surplus-key');
      assert.ok(finding, 'expected surplus-key finding');
      assert.equal(finding!.severity, 'high');
      const evidence = finding!.evidence.join('\n');
      assert.ok(evidence.includes('[SURPLUS_API_KEY]'));
      assert.ok(!evidence.includes(FAKE.surplus));
    });
  });

  it('reports a branded Anthropic key exactly once (no generic double-count)', () => {
    withFile('leak.txt', `key=${FAKE.anthropic}\n`, (cwd, changed) => {
      const findings = scanChangedFilesForSecrets(cwd, changed);
      const ids = findings.map((f) => f.id);
      assert.ok(ids.includes('secret-anthropic-key'));
      assert.ok(!ids.includes('secret-generic-sk-key'), 'generic rule must not double-count sk-ant- keys');
      assert.equal(ids.filter((id) => id.startsWith('secret-')).length, 1);
    });
  });

  it('reports a branded OpenAI project key exactly once', () => {
    withFile('leak.txt', `key=${FAKE.openaiProject}\n`, (cwd, changed) => {
      const ids = scanChangedFilesForSecrets(cwd, changed).map((f) => f.id);
      assert.ok(ids.includes('secret-openai-project-key'));
      assert.ok(!ids.includes('secret-generic-sk-key'), 'generic rule must not double-count sk-proj- keys');
    });
  });

  it('still detects pre-existing patterns (github, npm, evm, pem)', () => {
    const body = [FAKE.github, FAKE.npm, FAKE.evmAssignment, FAKE.pem].join('\n');
    withFile('mixed.txt', body, (cwd, changed) => {
      const ids = scanChangedFilesForSecrets(cwd, changed).map((f) => f.id);
      assert.ok(ids.includes('secret-github-token'));
      assert.ok(ids.includes('secret-npm-auth-token'));
      assert.ok(ids.includes('secret-evm-private-key-assignment'));
      assert.ok(ids.includes('secret-private-key-block'));
    });
  });

  it('does not flag ordinary sk- identifiers below the entropy floor', () => {
    withFile('app.css', `.sk-button-large { color: red; }\nconst sk = 'short';\n`, (cwd, changed) => {
      const findings = scanChangedFilesForSecrets(cwd, changed);
      assert.equal(findings.length, 0);
    });
  });

  it('skips deleted files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mythos-secrets-'));
    try {
      // File is referenced as deleted and does not exist on disk.
      const findings = scanChangedFilesForSecrets(dir, [{ path: 'gone.env', status: 'deleted' }]);
      assert.equal(findings.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips binary-like files', () => {
    withFile('blob.bin', `${FAKE.surplus}\u0000binary`, (cwd, changed) => {
      const findings = scanChangedFilesForSecrets(cwd, changed);
      assert.equal(findings.length, 0);
    });
  });
});
