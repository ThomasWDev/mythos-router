import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangedFile, CIFinding } from './types.js';

const MAX_SCAN_BYTES = 1024 * 1024;

interface SecretPattern {
  id: string;
  title: string;
  regex: RegExp;
  recommendation: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    id: 'private-key-block',
    title: 'Private key block found',
    regex: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----/i,
    recommendation: 'Remove the private key from the repository, rotate it, and store it in a secret manager.',
  },
  {
    id: 'npm-auth-token',
    title: 'Npm auth token found',
    regex: /(?:\/\/registry\.npmjs\.org\/:_authToken\s*=\s*\S+|\bnpm_[A-Za-z0-9]{20,}\b)/,
    recommendation: 'Remove the npm token, rotate it in npm, and use CI secrets instead.',
  },
  {
    id: 'github-token',
    title: 'GitHub token found',
    regex: /\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    recommendation: 'Remove the GitHub token, rotate it, and use GitHub Actions secrets or a fine-scoped token.',
  },
  {
    id: 'anthropic-key',
    title: 'Anthropic API key found',
    regex: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/,
    recommendation: 'Remove the API key, rotate it, and load it from a local environment variable or CI secret.',
  },
  {
    id: 'openai-project-key',
    title: 'OpenAI project API key found',
    regex: /\bsk-proj-[A-Za-z0-9_-]{16,}\b/,
    recommendation: 'Remove the API key, rotate it, and load it from a local environment variable or CI secret.',
  },
  {
    // Catch-all for OpenAI-compatible `sk-` keys that are NOT the branded
    // variants above (e.g. DeepSeek, legacy OpenAI `sk-`/`sk-svcacct-`, and
    // other OpenAI-compatible providers). The negative lookahead skips
    // `sk-ant-`/`sk-proj-` so those are reported once by their dedicated rule
    // rather than double-counted here. Alphanumeric-only with a 20-char floor
    // keeps this high-confidence: ordinary identifiers like `sk-button-large`
    // never reach the required run length.
    id: 'generic-sk-key',
    title: 'Generic API key found (sk- prefix)',
    regex: /\bsk-(?!ant-|proj-)[A-Za-z0-9]{20,}\b/,
    recommendation: 'Remove the API key (e.g. OpenAI or DeepSeek), rotate it, and load it from a local environment variable or CI secret.',
  },
  {
    id: 'surplus-key',
    title: 'Surplus API key found',
    regex: /\binf_[A-Za-z0-9]{20,}\b/,
    recommendation: 'Remove the Surplus API key, rotate it, and load it from a local environment variable or CI secret.',
  },
  {
    id: 'evm-private-key-assignment',
    title: 'EVM private key assignment found',
    regex: /\b(?:PRIVATE_KEY|WALLET_PRIVATE_KEY|DEPLOYER_PRIVATE_KEY)\s*=\s*["']?0x[a-fA-F0-9]{64}\b/,
    recommendation: 'Remove the private key, rotate the wallet, and use an encrypted secret store or CI secret.',
  },
];

function isBinaryLike(content: Buffer): boolean {
  return content.includes(0);
}

function redactEvidence(line: string): string {
  return line
    .replace(/-----BEGIN (?:RSA |OPENSSH |EC |DSA |)?PRIVATE KEY-----/gi, '[PRIVATE_KEY_BLOCK]')
    .replace(/\/\/registry\.npmjs\.org\/:_authToken\s*=\s*\S+/gi, '//registry.npmjs.org/:_authToken=[REDACTED]')
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, '[NPM_TOKEN]')
    .replace(/\bghp_[A-Za-z0-9_]{20,}\b/g, '[GITHUB_TOKEN]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[GITHUB_TOKEN]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, '[ANTHROPIC_API_KEY]')
    .replace(/\bsk-proj-[A-Za-z0-9_-]{16,}\b/g, '[OPENAI_API_KEY]')
    // Must run after the branded sk- rules above so `sk-ant-`/`sk-proj-` are
    // already redacted to their specific labels and never fall through to the
    // generic one. The lookahead is a second line of defense if reordered.
    .replace(/\bsk-(?!ant-|proj-)[A-Za-z0-9]{20,}\b/g, '[API_KEY]')
    .replace(/\binf_[A-Za-z0-9]{20,}\b/g, '[SURPLUS_API_KEY]')
    .replace(/0x[a-fA-F0-9]{64}\b/g, '[EVM_PRIVATE_KEY]');
}

function firstMatchingLine(content: string, pattern: RegExp): string {
  const lines = content.split(/\r?\n/);
  for (const [idx, line] of lines.entries()) {
    if (pattern.test(line)) {
      pattern.lastIndex = 0;
      return `line ${idx + 1}: ${redactEvidence(line.trim()).slice(0, 180)}`;
    }
  }
  pattern.lastIndex = 0;
  return 'matched high-confidence secret pattern';
}

export function scanChangedFilesForSecrets(cwd: string, changedFiles: ChangedFile[]): CIFinding[] {
  const findings: CIFinding[] = [];

  for (const file of changedFiles) {
    if (file.status === 'deleted') continue;

    const absPath = join(cwd, file.path);
    let raw: Buffer;
    try {
      const stat = statSync(absPath);
      if (stat.size > MAX_SCAN_BYTES) continue;
      raw = readFileSync(absPath);
    } catch {
      continue;
    }

    if (isBinaryLike(raw)) continue;
    const content = raw.toString('utf-8');

    for (const pattern of SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0;
      if (!pattern.regex.test(content)) continue;
      pattern.regex.lastIndex = 0;

      findings.push({
        id: `secret-${pattern.id}`,
        severity: 'high',
        title: pattern.title,
        file: file.path,
        evidence: [firstMatchingLine(content, pattern.regex)],
        why: 'High-confidence credentials or private keys in source control can be copied by anyone with repository access and may remain in git history after removal.',
        recommendation: pattern.recommendation,
      });
    }
  }

  return findings;
}
