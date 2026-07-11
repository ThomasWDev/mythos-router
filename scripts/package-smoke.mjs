import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), 'mythos-package-smoke-'));
let tarballPath;

try {
  const packed = JSON.parse(execFileSync(npm, ['pack', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }));
  const filename = packed?.[0]?.filename;
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('npm pack did not return a package filename.');
  }
  tarballPath = join(root, filename);

  execFileSync(npm, [
    'install',
    '--prefix', temporary,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tarballPath,
  ], { stdio: 'inherit' });

  const installedRoot = join(temporary, 'node_modules', 'mythos-router');
  const pkg = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
  const sdk = await import(pathToFileURL(join(installedRoot, 'dist', 'index.js')).href);
  if (typeof sdk.SWDEngine !== 'function' || typeof sdk.runDoctor !== 'function') {
    throw new Error('Installed SDK is missing required public exports.');
  }

  const cliOutput = execFileSync(process.execPath, [join(installedRoot, 'dist', 'cli.js'), '--version'], {
    encoding: 'utf8',
  }).trim();
  if (cliOutput !== pkg.version) {
    throw new Error(`Installed CLI reported ${cliOutput || '<empty>'}; expected ${pkg.version}.`);
  }

  console.log(`Package smoke passed for mythos-router@${pkg.version}.`);
} finally {
  if (tarballPath) rmSync(tarballPath, { force: true });
  rmSync(temporary, { recursive: true, force: true });
}
