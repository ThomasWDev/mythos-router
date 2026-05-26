import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangedFile, CIFinding, DiffInfo } from './types.js';
import { readPackageJsonBeforeChange } from './git.js';
import { scanChangedFilesForSecrets } from './secrets.js';
import { PROJECT_POLICY_FILE } from '../config.js';

const DANGEROUS_LIFECYCLE_SCRIPTS = new Set(['preinstall', 'install', 'postinstall']);
const REVIEW_LIFECYCLE_SCRIPTS = new Set(['prepare', 'prepublish', 'prepublishOnly', 'publish', 'postpublish', 'postpack']);

function normalized(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isEnvExample(filePath: string): boolean {
  return /(^|\/)\.env\.example$/i.test(filePath) || /(^|\/)\.env\.sample$/i.test(filePath) || /(^|\/)\.env\.template$/i.test(filePath);
}

function isDotEnv(filePath: string): boolean {
  return /(^|\/)\.env(?:\.|$)/i.test(filePath) && !isEnvExample(filePath);
}

function isPrivateKeyPath(filePath: string): boolean {
  return /(?:^|\/)(?:id_rsa|id_ed25519)$/i.test(filePath) || /\.(?:pem|key|p12|pfx)$/i.test(filePath) || /(?:^|\/)wallet\.dat$/i.test(filePath) || /(?:^|\/)seed(?:s|_phrase)?\.txt$/i.test(filePath);
}

function isWorkflow(filePath: string): boolean {
  return /^\.github\/workflows\//i.test(filePath);
}

function isShellOrScriptSurface(filePath: string): boolean {
  return /^scripts\//i.test(filePath) || /\.(?:sh|bash|zsh|fish|ps1|bat|cmd)$/i.test(filePath);
}

function isDockerSurface(filePath: string): boolean {
  return /^Dockerfile$/i.test(filePath) || /^docker-compose\.ya?ml$/i.test(filePath);
}

function isLockfile(filePath: string): boolean {
  return /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/i.test(filePath);
}

function isProjectPolicy(filePath: string): boolean {
  return filePath.toLowerCase() === PROJECT_POLICY_FILE.toLowerCase();
}

function createFinding(partial: Omit<CIFinding, 'evidence'> & { evidence?: string[] }): CIFinding {
  return { ...partial, evidence: partial.evidence ?? [] };
}

export function analyzePathRules(changedFiles: ChangedFile[]): CIFinding[] {
  const findings: CIFinding[] = [];

  for (const file of changedFiles) {
    const path = normalized(file.path);

    if (isEnvExample(path)) {
      findings.push(createFinding({
        id: 'env-example-changed',
        severity: 'info',
        title: 'Environment example file changed',
        file: path,
        evidence: [`${path} was ${file.status}`],
        why: 'Environment example files document required variables. This is usually normal, but reviewers should make sure examples do not contain real credentials.',
        recommendation: 'Keep only placeholder values in env example files.',
      }));
      continue;
    }

    if (isDotEnv(path)) {
      findings.push(createFinding({
        id: 'dotenv-file-touched',
        severity: 'high',
        title: 'Environment file touched',
        file: path,
        evidence: [`${path} was ${file.status}`],
        why: 'Real .env files often contain API keys, database credentials, private keys, or deployment secrets.',
        recommendation: 'Do not commit real .env files. Use .env.example for placeholders and configure secrets in the runtime or CI provider.',
      }));
      continue;
    }

    if (path.toLowerCase().endsWith('.npmrc')) {
      findings.push(createFinding({
        id: 'npmrc-file-touched',
        severity: 'warn',
        title: 'Npm config file touched',
        file: path,
        evidence: [`${path} was ${file.status}`],
        why: '.npmrc can affect registry resolution and may contain npm authentication tokens.',
        recommendation: 'Review registry/auth changes carefully. Keep auth tokens in CI secrets, not source control.',
      }));
      continue;
    }

    if (isPrivateKeyPath(path)) {
      findings.push(createFinding({
        id: 'private-key-file-touched',
        severity: 'high',
        title: 'Private-key-like file touched',
        file: path,
        evidence: [`${path} was ${file.status}`],
        why: 'Private keys, wallet files, and seed phrase files should not be committed to application repositories.',
        recommendation: 'Remove the file from the repository and rotate the credential or wallet if it was real.',
      }));
      continue;
    }

    if (isWorkflow(path)) {
      findings.push(createFinding({
        id: 'github-workflow-changed',
        severity: 'warn',
        title: 'GitHub Actions workflow changed',
        file: path,
        evidence: [`${path} was ${file.status}`],
        why: 'Workflow files control CI, release, deploy, and secret-access behavior for the repository.',
        recommendation: 'Review permissions, secret usage, publish/deploy steps, and third-party actions before merge.',
      }));
      continue;
    }

    if (isShellOrScriptSurface(path)) {
      findings.push(createFinding({
        id: 'script-surface-changed',
        severity: 'warn',
        title: 'Shell or script surface changed',
        file: path,
        evidence: [`${path} was ${file.status}`],
        why: 'Shell and script files can execute commands in local, CI, deploy, or publish workflows.',
        recommendation: 'Review command execution, downloads, environment variable handling, and deploy/publish behavior before merge.',
      }));
      continue;
    }

    if (isDockerSurface(path)) {
      findings.push(createFinding({
        id: 'container-surface-changed',
        severity: 'warn',
        title: 'Container execution surface changed',
        file: path,
        evidence: [`${path} was ${file.status}`],
        why: 'Docker files define build-time and runtime commands, dependencies, environment, exposed ports, and filesystem behavior.',
        recommendation: 'Review install commands, copied files, secrets handling, and runtime entrypoints.',
      }));
      continue;
    }

    if (isLockfile(path)) {
      findings.push(createFinding({
        id: 'lockfile-changed',
        severity: 'info',
        title: 'Package lockfile changed',
        file: path,
        evidence: [`${path} was ${file.status}`],
        why: 'Lockfiles control the exact dependency tree installed by package managers.',
        recommendation: 'Confirm the lockfile change matches the intended dependency update.',
      }));
      continue;
    }

    if (isProjectPolicy(path)) {
      findings.push(createFinding({
        id: 'mythos-policy-changed',
        severity: 'warn',
        title: 'Mythos project policy changed',
        file: path,
        evidence: [`${path} was ${file.status}`],
        why: 'Project policy controls repo-local SWD blocks, confirmations, operation limits, and batch limits.',
        recommendation: 'Review policy changes carefully before trusting external-agent or MCP writes in this repository.',
      }));
    }
  }

  return findings;
}

type Scripts = Record<string, string>;

function parseScripts(jsonText: string | null): { scripts: Scripts; error?: string } {
  if (!jsonText) return { scripts: {} };
  try {
    const parsed = JSON.parse(jsonText) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) {
      return { scripts: {} };
    }

    const scripts: Scripts = {};
    for (const [key, value] of Object.entries(parsed.scripts as Record<string, unknown>)) {
      if (typeof value === 'string') scripts[key] = value;
    }
    return { scripts };
  } catch (err) {
    return { scripts: {}, error: err instanceof Error ? err.message : 'Invalid JSON' };
  }
}

function scriptDiffEvidence(before: Scripts, after: Scripts): string[] {
  const evidence: string[] = [];
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

  for (const name of names) {
    if (!(name in before) && name in after) {
      evidence.push(`scripts.${name} added`);
    } else if (name in before && !(name in after)) {
      evidence.push(`scripts.${name} removed`);
    } else if (before[name] !== after[name]) {
      evidence.push(`scripts.${name} changed`);
    }
  }

  return evidence;
}

export function analyzePackageJsonScripts(diff: DiffInfo): CIFinding[] {
  const packageChange = diff.changedFiles.find((file) => normalized(file.path) === 'package.json');
  if (!packageChange) return [];

  const findings: CIFinding[] = [];
  const currentPath = join(diff.cwd, 'package.json');
  const beforeText = readPackageJsonBeforeChange(diff);
  const afterText = existsSync(currentPath) ? readFileSync(currentPath, 'utf-8') : null;

  const before = parseScripts(beforeText);
  const after = parseScripts(afterText);

  if (after.error) {
    findings.push(createFinding({
      id: 'package-json-parse-failed',
      severity: 'warn',
      title: 'package.json could not be parsed',
      file: 'package.json',
      evidence: [after.error],
      why: 'Invalid package metadata can break installs, scripts, builds, and publishing.',
      recommendation: 'Fix package.json syntax before merge.',
    }));
    return findings;
  }

  const evidence = scriptDiffEvidence(before.scripts, after.scripts);

  if (evidence.length === 0) {
    findings.push(createFinding({
      id: 'package-json-changed',
      severity: 'info',
      title: 'package.json changed',
      file: 'package.json',
      evidence: ['package.json changed, but package scripts were not modified.'],
      why: 'package.json controls package metadata, dependencies, exports, and command configuration.',
      recommendation: 'Review the package metadata/dependency change before merge.',
    }));
    return findings;
  }

  findings.push(createFinding({
    id: 'package-json-scripts-changed',
    severity: 'warn',
    title: 'package.json scripts changed',
    file: 'package.json',
    evidence,
    why: 'Package scripts can execute commands during test, build, install, publish, or CI workflows.',
    recommendation: 'Review script changes before merge and make sure they match the PR intent.',
  }));

  const addedScripts = Object.keys(after.scripts).filter((name) => !(name in before.scripts));
  const dangerousAdded = addedScripts.filter((name) => DANGEROUS_LIFECYCLE_SCRIPTS.has(name));
  if (dangerousAdded.length > 0) {
    findings.push(createFinding({
      id: 'npm-lifecycle-script-added',
      severity: 'high',
      title: 'Npm install lifecycle script added',
      file: 'package.json',
      evidence: dangerousAdded.map((name) => `scripts.${name} added`),
      why: 'Npm install lifecycle scripts can execute during dependency installation and are a common supply-chain review point.',
      recommendation: 'Avoid install lifecycle scripts unless absolutely necessary. If required, keep them minimal and review every command.',
    }));
  }

  const reviewAdded = addedScripts.filter((name) => REVIEW_LIFECYCLE_SCRIPTS.has(name));
  if (reviewAdded.length > 0) {
    findings.push(createFinding({
      id: 'npm-publish-lifecycle-script-added',
      severity: 'warn',
      title: 'Npm publish/build lifecycle script added',
      file: 'package.json',
      evidence: reviewAdded.map((name) => `scripts.${name} added`),
      why: 'Publish/build lifecycle scripts can run during package packing or publishing.',
      recommendation: 'Review the lifecycle script and confirm it cannot publish unintended files or run unexpected commands.',
    }));
  }

  return findings;
}

export function analyzeChangedFiles(diff: DiffInfo): CIFinding[] {
  return [
    ...analyzePackageJsonScripts(diff),
    ...analyzePathRules(diff.changedFiles),
    ...scanChangedFilesForSecrets(diff.cwd, diff.changedFiles),
  ];
}
