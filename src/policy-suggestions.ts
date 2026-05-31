import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadProjectPolicy, normalizePolicyPath, type ProjectPolicy } from './project-policy.js';

export type PolicySuggestionRisk = 'block' | 'confirm';

export interface PolicySuggestion {
  risk: PolicySuggestionRisk;
  pattern: string;
  reason: string;
  evidence: string;
}

export interface PolicySuggestionResult {
  ok: boolean;
  rootDir: string;
  suggestions: PolicySuggestion[];
  policyPatch: Pick<ProjectPolicy, 'block' | 'confirm'>;
  notes: string[];
}

export function suggestProjectPolicy(rootDir = process.cwd()): PolicySuggestionResult {
  const suggestions = dedupeSuggestions([
    ...workflowSuggestions(rootDir),
    ...contractSuggestions(rootDir),
    ...envSuggestions(rootDir),
    ...deploySuggestions(rootDir),
    ...paymentSuggestions(rootDir),
    ...infraSuggestions(rootDir),
  ]).filter((suggestion) => !alreadyCovered(rootDir, suggestion));

  return {
    ok: true,
    rootDir,
    suggestions,
    policyPatch: {
      block: suggestions.filter((suggestion) => suggestion.risk === 'block').map((suggestion) => suggestion.pattern),
      confirm: suggestions.filter((suggestion) => suggestion.risk === 'confirm').map((suggestion) => suggestion.pattern),
    },
    notes: [
      'Suggestions are printed only; Mythos does not write .mythos/policy.json from this command.',
      'Review every pattern before copying it into project policy.',
    ],
  };
}

function workflowSuggestions(rootDir: string): PolicySuggestion[] {
  if (!isDir(rootDir, '.github/workflows')) return [];
  return [{
    risk: 'confirm',
    pattern: '.github/workflows/**',
    reason: 'Workflow changes can alter CI, release, or deployment behavior.',
    evidence: '.github/workflows/ exists',
  }];
}

function contractSuggestions(rootDir: string): PolicySuggestion[] {
  const suggestions: PolicySuggestion[] = [];
  if (isDir(rootDir, 'contracts/mainnet')) {
    suggestions.push({
      risk: 'block',
      pattern: 'contracts/mainnet/**',
      reason: 'Mainnet contract artifacts should not be changed by default agent runs.',
      evidence: 'contracts/mainnet/ exists',
    });
  }
  if (isDir(rootDir, 'contracts') || isDir(rootDir, 'src/contracts')) {
    const pattern = isDir(rootDir, 'contracts') ? 'contracts/**' : 'src/contracts/**';
    suggestions.push({
      risk: 'confirm',
      pattern,
      reason: 'Contract changes are high-impact and should require an explicit opt-in.',
      evidence: isDir(rootDir, 'contracts') ? 'contracts/ exists' : 'src/contracts/ exists',
    });
  }
  return suggestions;
}

function envSuggestions(rootDir: string): PolicySuggestion[] {
  const hasExample = existsPath(rootDir, '.env.example') ||
    findTopLevel(rootDir, (entry) => entry.endsWith('.env.example') || entry.endsWith('.env.sample'));
  if (!hasExample) return [];
  return [{
    risk: 'block',
    pattern: '**/.env*',
    reason: 'Environment files commonly contain secrets; examples imply real env files may exist nearby.',
    evidence: '.env example file detected',
  }];
}

function deploySuggestions(rootDir: string): PolicySuggestion[] {
  const suggestions: PolicySuggestion[] = [];
  if (isDir(rootDir, 'scripts') && hasDeployLikeEntry(rootDir, 'scripts')) {
    suggestions.push({
      risk: 'confirm',
      pattern: 'scripts/**',
      reason: 'Deploy/release scripts can change production behavior.',
      evidence: 'deploy-like file under scripts/',
    });
  }
  if (isDir(rootDir, 'deploy')) {
    suggestions.push({
      risk: 'confirm',
      pattern: 'deploy/**',
      reason: 'Deployment files should require an explicit opt-in.',
      evidence: 'deploy/ exists',
    });
  }

  const packageScripts = packageJsonScripts(rootDir);
  if (packageScripts.some((name) => /deploy|release|publish|migrate/i.test(name))) {
    suggestions.push({
      risk: 'confirm',
      pattern: 'package.json',
      reason: 'Package scripts include deploy/release/publish/migrate commands.',
      evidence: `package scripts: ${packageScripts.join(', ')}`,
    });
  }
  return suggestions;
}

function paymentSuggestions(rootDir: string): PolicySuggestion[] {
  const candidates = [
    'payments',
    'billing',
    'src/payments',
    'src/billing',
    'app/payments',
    'apps/payments',
  ];
  return candidates
    .filter((candidate) => isDir(rootDir, candidate))
    .map((candidate) => ({
      risk: 'confirm' as const,
      pattern: `${normalizePolicyPath(candidate)}/**`,
      reason: 'Payment and billing paths should require explicit review.',
      evidence: `${candidate}/ exists`,
    }));
}

function infraSuggestions(rootDir: string): PolicySuggestion[] {
  const suggestions: PolicySuggestion[] = [];
  if (isDir(rootDir, 'infra/prod')) {
    suggestions.push({
      risk: 'block',
      pattern: 'infra/prod/**',
      reason: 'Production infrastructure should stay blocked unless a human narrows the policy.',
      evidence: 'infra/prod/ exists',
    });
  }
  if (isDir(rootDir, 'terraform') || isDir(rootDir, 'infra')) {
    suggestions.push({
      risk: 'confirm',
      pattern: isDir(rootDir, 'terraform') ? 'terraform/**' : 'infra/**',
      reason: 'Infrastructure changes are high-impact and should require confirmation.',
      evidence: isDir(rootDir, 'terraform') ? 'terraform/ exists' : 'infra/ exists',
    });
  }
  return suggestions;
}

function alreadyCovered(rootDir: string, suggestion: PolicySuggestion): boolean {
  const state = loadProjectPolicy(rootDir);
  if (!state.policy || state.errors.length > 0) return false;
  const current = suggestion.risk === 'block' ? state.policy.block ?? [] : state.policy.confirm ?? [];
  const pattern = normalizePolicyPath(suggestion.pattern);
  return current.some((existing) => normalizePolicyPath(existing) === pattern);
}

function dedupeSuggestions(suggestions: PolicySuggestion[]): PolicySuggestion[] {
  const seen = new Set<string>();
  const result: PolicySuggestion[] = [];
  for (const suggestion of suggestions) {
    const key = `${suggestion.risk}:${normalizePolicyPath(suggestion.pattern)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(suggestion);
  }
  return result;
}

function existsPath(rootDir: string, relativePath: string): boolean {
  return existsSync(join(rootDir, ...relativePath.split('/')));
}

function isDir(rootDir: string, relativePath: string): boolean {
  try {
    return statSync(join(rootDir, ...relativePath.split('/'))).isDirectory();
  } catch {
    return false;
  }
}

function findTopLevel(rootDir: string, predicate: (entry: string) => boolean): boolean {
  try {
    return readdirSync(rootDir).some(predicate);
  } catch {
    return false;
  }
}

function hasDeployLikeEntry(rootDir: string, relativePath: string): boolean {
  try {
    return readdirSync(join(rootDir, ...relativePath.split('/')))
      .some((entry) => /deploy|release|publish|migrate/i.test(entry));
  } catch {
    return false;
  }
}

function packageJsonScripts(rootDir: string): string[] {
  const packageJsonPath = join(rootDir, 'package.json');
  if (!existsSync(packageJsonPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { scripts?: unknown };
    if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) return [];
    return Object.keys(parsed.scripts);
  } catch {
    return [];
  }
}
