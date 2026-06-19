// ─────────────────────────────────────────────────────────────
//  mythos-router :: test/support.ts
//  Shared helpers for exercising command-layer entrypoints.
//
//  NOTE: this file intentionally does NOT end in `.test.ts`, so the
//  `test/**/*.test.ts` runner glob never collects it as a suite. It is a
//  plain module imported by the command tests.
// ─────────────────────────────────────────────────────────────

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CapturedRun<T> {
  result: T;
  /** Everything written to console.log/info/warn/error during the run. */
  output: string;
  /** process.exitCode observed immediately after the run (before restore). */
  exitCode: typeof process.exitCode;
}

/**
 * Run `fn` with console output captured and `process.exitCode` isolated.
 *
 * Command handlers signal failure via `process.exitCode = N` rather than
 * throwing, so we snapshot it, let the handler set it, report the observed
 * value, and then restore the original — otherwise a single failing-path test
 * would leave the whole test process exiting non-zero.
 */
export async function captureRun<T>(fn: () => Promise<T> | T): Promise<CapturedRun<T>> {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    exitCode: process.exitCode,
  };

  let output = '';
  const sink = (...args: unknown[]): void => {
    output += args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
  };

  console.log = sink as typeof console.log;
  console.info = sink as typeof console.info;
  console.warn = sink as typeof console.warn;
  console.error = sink as typeof console.error;
  process.exitCode = undefined;

  try {
    const result = await fn();
    return { result, output, exitCode: process.exitCode };
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
    process.exitCode = original.exitCode;
  }
}

/**
 * Create a throwaway directory, chdir into it for the duration of `fn`, then
 * restore the previous cwd and delete the directory — even on failure.
 * Command handlers resolve paths against process.cwd(), so tests must run
 * inside an isolated tree.
 */
export async function withTempCwd<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const previousCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'mythos-cmd-'));
  try {
    process.chdir(dir);
    return await fn(dir);
  } finally {
    process.chdir(previousCwd);
    // Best-effort teardown. On Windows a directory that just held a git repo
    // or a subprocess working dir can keep open handles for a moment, making
    // rmSync throw EBUSY/EPERM/ENOTEMPTY (which `force` alone does not retry).
    // Retry briefly, then ignore — a cleanup hiccup must never fail an
    // otherwise-passing test; the OS reclaims the temp dir regardless.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* ignore */
    }
  }
}

/** Strip ANSI color/style escapes so assertions match on plain text. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}
