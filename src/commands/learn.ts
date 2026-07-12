import * as os from 'node:os';
import * as path from 'node:path';
import {
  learnRepoSkill,
  type LearnRepoSkillResult,
} from '../learn.js';
import { c, error, heading, hr, success, theme, warn } from '../utils.js';
import { resolveWorkspace } from '../workspace.js';

interface LearnOptions {
  name?: string;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export async function learnCommand(options: LearnOptions = {}): Promise<void> {
  const workspace = resolveWorkspace();
  let result: LearnRepoSkillResult;

  try {
    result = learnRepoSkill({
      name: options.name,
      force: options.force,
      dryRun: options.dryRun,
      cwd: workspace.rootDir,
    });
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    if (result.issues.some((issue) => issue.level === 'error')) process.exitCode = 1;
    return;
  }

  console.log(heading('Mythos Learn'));
  console.log(`${c.dim}Skill:${c.reset}   ${result.skillName}`);
  console.log(`${c.dim}Path:${c.reset}    ${formatPath(result.filePath, workspace.rootDir)}`);
  console.log(`${c.dim}Project:${c.reset} ${result.profile.packageName ?? result.profile.rootName}`);
  if (result.profile.projectTypes.length > 0) {
    console.log(`${c.dim}Detected:${c.reset} ${result.profile.projectTypes.join(', ')}`);
  }

  if (options.dryRun) {
    warn('Dry-run: no files were written.');
    console.log(hr());
    console.log(result.content);
  } else {
    success(`${result.existed ? 'Updated' : 'Created'} project skill: ${result.skillName}`);
    console.log(`  ${c.dim}${formatPath(result.filePath, workspace.rootDir)}${c.reset}`);
  }

  printLearnSummary(result);
  printValidation(result, workspace.rootDir);
}

function printLearnSummary(result: LearnRepoSkillResult): void {
  console.log();
  console.log(`${c.bold}Read first${c.reset}`);
  for (const item of result.profile.readFirst.slice(0, 6)) {
    console.log(`  ${theme.info}${item}${c.reset}`);
  }

  if (result.profile.commandSurfaces.length > 0 || result.profile.securitySurfaces.length > 0) {
    console.log();
    console.log(`${c.bold}Risk surfaces${c.reset}`);
    for (const item of [...result.profile.commandSurfaces, ...result.profile.securitySurfaces].slice(0, 6)) {
      console.log(`  ${theme.warning}${item}${c.reset}`);
    }
  }

  if (result.profile.suggestedChecks.length > 0) {
    console.log();
    console.log(`${c.bold}Suggested human-run checks${c.reset}`);
    for (const item of result.profile.suggestedChecks) {
      console.log(`  ${theme.info}${item}${c.reset}`);
    }
  }

  console.log();
  console.log(`${c.dim}Use it:${c.reset} mythos run --file TASK.md -s ${result.skillName}`);
}

function printValidation(result: LearnRepoSkillResult, rootDir: string): void {
  if (result.issues.length === 0 && result.profile.warnings.length === 0) return;

  console.log();
  for (const warning of result.profile.warnings) {
    warn(warning);
  }

  for (const issue of result.issues) {
    const text = `${formatPath(issue.path, rootDir)} - ${issue.message}`;
    if (issue.level === 'error') {
      error(text);
      process.exitCode = 1;
    } else {
      warn(text);
    }
  }
}

function formatPath(filePath: string, rootDir: string): string {
  const home = os.homedir();
  if (filePath === home || filePath.startsWith(home + path.sep)) {
    return '~' + filePath.slice(home.length);
  }

  const relative = path.relative(rootDir, filePath);
  const escapesCwd = relative === '..' || relative.startsWith(`..${path.sep}`);
  if (relative && !escapesCwd && !path.isAbsolute(relative)) {
    return relative || '.';
  }

  return filePath;
}
