import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { PathJail } from './path-jail.js';
import type { FileAction } from './swd.js';

const EXCLUDED_SEGMENTS = new Set(['.git', 'node_modules', 'dist']);
const MAX_SANDBOX_FILES = 20_000;

interface IgnoreRule {
  pattern: string;
  negated: boolean;
}

export interface SandboxMirrorResult {
  filesCopied: number;
  skippedSensitive: string[];
}

/** Mirror tracked/non-ignored files without importing secrets or symlinks. */
export function mirrorWorkspaceForSandbox(
  root: string,
  destination: string,
  actions: FileAction[] = [],
): SandboxMirrorResult {
  const jail = new PathJail(root);
  const mythosRules = readIgnoreRules(join(jail.root, '.mythosignore'));
  const gitFiles = listGitVisibleFiles(jail.root);
  const candidates = gitFiles ?? walkFallback(jail.root, [
    ...readIgnoreRules(join(jail.root, '.gitignore')),
    ...mythosRules,
  ]);

  for (const action of actions) {
    try {
      const absolute = jail.resolve(action.path);
      if (!existsSync(absolute)) continue;
      const normalized = relative(jail.root, absolute).split(sep).join('/');
      candidates.add(normalized);
    } catch {
      // SWD will report invalid action paths. Mirroring must not follow them.
    }
  }

  let copied = 0;
  const skippedSensitive: string[] = [];
  for (const relativePath of [...candidates].sort()) {
    const normalized = normalizeCandidate(relativePath);
    if (!normalized || hasExcludedSegment(normalized)) continue;
    if (isSensitivePath(normalized)) {
      skippedSensitive.push(normalized);
      continue;
    }
    if (isIgnored(normalized, mythosRules)) continue;

    const source = jail.resolve(normalized);
    const stat = lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    if (++copied > MAX_SANDBOX_FILES) {
      throw new Error(
        `Project exceeds the sandbox file cap (${MAX_SANDBOX_FILES}). ` +
        'Add large directories to .gitignore/.mythosignore or skip isolated runs.',
      );
    }
    const target = join(destination, ...normalized.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
  }

  return { filesCopied: copied, skippedSensitive };
}

function listGitVisibleFiles(root: string): Set<string> | null {
  const result = spawnSync(
    'git',
    ['-C', root, 'ls-files', '-c', '-o', '--exclude-standard', '-z'],
    { encoding: 'buffer', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0 || result.error) return null;
  return new Set(
    result.stdout
      .toString('utf8')
      .split('\0')
      .map(normalizeCandidate)
      .filter((path): path is string => Boolean(path)),
  );
}

function walkFallback(root: string, rules: IgnoreRule[]): Set<string> {
  const files = new Set<string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const normalized = relative(root, absolute).split(sep).join('/');
      if (!normalized || hasExcludedSegment(normalized)) continue;
      if (entry.isSymbolicLink()) continue;
      if (isIgnored(normalized, rules)) continue;
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.add(normalized);
    }
  };
  walk(root);
  return files;
}

function readIgnoreRules(filePath: string): IgnoreRule[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .map(line => ({
      negated: line.startsWith('!'),
      pattern: (line.startsWith('!') ? line.slice(1) : line).replace(/\\/g, '/'),
    }))
    .filter(rule => rule.pattern.length > 0);
}

function isIgnored(path: string, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (matchesIgnorePattern(path, rule.pattern)) ignored = !rule.negated;
  }
  return ignored;
}

function matchesIgnorePattern(path: string, rawPattern: string): boolean {
  let pattern = rawPattern;
  const anchored = pattern.startsWith('/');
  if (anchored) pattern = pattern.slice(1);
  if (pattern.endsWith('/')) pattern += '**';
  const candidates = anchored || pattern.includes('/')
    ? [pattern]
    : [pattern, `**/${pattern}`];
  return candidates.some(candidate => globMatches(path, candidate));
}

function globMatches(path: string, pattern: string): boolean {
  const pathSegments = path.split('/');
  const patternSegments = pattern.split('/');
  const memo = new Map<string, boolean>();

  const match = (pathIndex: number, patternIndex: number): boolean => {
    const key = `${pathIndex}:${patternIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result: boolean;
    if (patternIndex === patternSegments.length) {
      result = pathIndex === pathSegments.length;
    } else if (patternSegments[patternIndex] === '**') {
      result = match(pathIndex, patternIndex + 1)
        || (pathIndex < pathSegments.length && match(pathIndex + 1, patternIndex));
    } else {
      result = pathIndex < pathSegments.length
        && segmentMatches(pathSegments[pathIndex]!, patternSegments[patternIndex]!)
        && match(pathIndex + 1, patternIndex + 1);
    }
    memo.set(key, result);
    return result;
  };

  return match(0, 0);
}

function segmentMatches(value: string, pattern: string): boolean {
  const previous = new Array<boolean>(value.length + 1).fill(false);
  previous[0] = true;

  for (const token of pattern) {
    const current = new Array<boolean>(value.length + 1).fill(false);
    if (token === '*') current[0] = previous[0]!;
    for (let index = 1; index <= value.length; index += 1) {
      if (token === '*') {
        current[index] = previous[index]! || current[index - 1]!;
      } else if (token === '?' || token === value[index - 1]) {
        current[index] = previous[index - 1]!;
      }
    }
    for (let index = 0; index <= value.length; index += 1) previous[index] = current[index]!;
  }
  return previous[value.length]!;
}

function isSensitivePath(path: string): boolean {
  const lower = path.toLowerCase();
  const name = lower.split('/').at(-1) ?? lower;
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) return true;
  if (['.npmrc', '.pypirc', 'credentials.json', 'service-account.json'].includes(name)) return true;
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/.test(name)) return true;
  return ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore'].some(ext => name.endsWith(ext));
}

function hasExcludedSegment(path: string): boolean {
  const segments = path.split('/');
  if (segments.some(segment => EXCLUDED_SEGMENTS.has(segment))) return true;
  return path === '.mythos/transactions' || path.startsWith('.mythos/transactions/');
}

function normalizeCandidate(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return null;
  const segments = normalized.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null;
  return normalized;
}
