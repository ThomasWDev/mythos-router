// ─────────────────────────────────────────────────────────────
//  mythos-router :: session.ts
//  Workspace-scoped session persistence — atomic, versioned, resumable.
// ─────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from './providers/types.js';
import { normalizeMessages } from './providers/messages.js';
import { AtomicFileWriter } from './atomic-writer.js';
import { resolveWorkspace, type WorkspaceInput } from './workspace.js';

const SESSION_VERSION = 2;
const LEGACY_SESSION_VERSION = 1;
const SESSION_FILE_NAME = 'latest.json';
const sessionWriter = new AtomicFileWriter();

export interface SessionData {
  version: number;
  timestamp: string;
  project: string;
  history: Message[];
  budget: {
    inputTokens: number;
    outputTokens: number;
    turns: number;
  };
}

export interface SessionPaths {
  dir: string;
  file: string;
  legacyFile: string;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseBudget(value: unknown): SessionData['budget'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const budget = value as Record<string, unknown>;
  if (!isNonNegativeFiniteNumber(budget.inputTokens)) return null;
  if (!isNonNegativeFiniteNumber(budget.outputTokens)) return null;
  if (!isNonNegativeFiniteNumber(budget.turns)) return null;
  return {
    inputTokens: budget.inputTokens,
    outputTokens: budget.outputTokens,
    turns: budget.turns,
  };
}

export function getSessionPaths(workspaceInput?: WorkspaceInput): SessionPaths {
  const workspace = resolveWorkspace(workspaceInput);
  const legacyDir = join(workspace.userStateDir, 'sessions');
  return {
    dir: workspace.sessionsDir,
    file: join(workspace.sessionsDir, SESSION_FILE_NAME),
    legacyFile: join(legacyDir, SESSION_FILE_NAME),
  };
}

/** Parse v2 structured sessions and migrate legacy v1 text-only sessions. */
export function parseSessionData(raw: string): SessionData | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    if (data.version !== SESSION_VERSION && data.version !== LEGACY_SESSION_VERSION) return null;
    if (typeof data.timestamp !== 'string' || Number.isNaN(Date.parse(data.timestamp))) return null;
    if (typeof data.project !== 'string') return null;
    if (!Array.isArray(data.history)) return null;
    const budget = parseBudget(data.budget);
    if (!budget) return null;

    const history = normalizeMessages(data.history as Message[]);
    return {
      version: SESSION_VERSION,
      timestamp: data.timestamp,
      project: data.project,
      history,
      budget,
    };
  } catch {
    return null;
  }
}

export function serializeSessionData(data: Omit<SessionData, 'version'>): string {
  const history = normalizeMessages(data.history);
  return JSON.stringify({
    version: SESSION_VERSION,
    timestamp: data.timestamp,
    project: data.project,
    history,
    budget: data.budget,
  }, null, 2);
}

export function saveSession(
  history: Message[],
  budget: { inputTokens: number; outputTokens: number; turns: number },
  project: string,
  workspaceInput?: WorkspaceInput,
): void {
  const paths = getSessionPaths(workspaceInput);
  const serialized = serializeSessionData({
    timestamp: new Date().toISOString(),
    project,
    history,
    budget,
  });

  mkdirSync(paths.dir, { recursive: true });
  sessionWriter.write(paths.file, serialized, {
    createOnly: false,
    mode: 0o600,
  });
}

export function loadSession(workspaceInput?: WorkspaceInput): SessionData | null {
  const workspace = resolveWorkspace(workspaceInput);
  const paths = getSessionPaths(workspace);
  const scoped = readSessionFile(paths.file);
  if (scoped) return scoped;

  // One-way compatibility bridge for pre-workspace releases. The old location
  // was global and keyed only by project basename, so migrate only when that
  // basename matches the current canonical workspace.
  const legacy = readSessionFile(paths.legacyFile);
  if (!legacy || legacy.project !== workspace.projectName) return null;

  try {
    saveSession(legacy.history, legacy.budget, legacy.project, workspace);
  } catch {
    // A read remains useful even when migration cannot be persisted.
  }
  return legacy;
}

function readSessionFile(filePath: string): SessionData | null {
  if (!existsSync(filePath)) return null;
  try {
    return parseSessionData(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function formatResumeInfo(session: SessionData): string {
  const date = new Date(session.timestamp);
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = date.toLocaleDateString();
  const totalTokens = session.budget.inputTokens + session.budget.outputTokens;
  return `Resuming session from ${dateStr} ${timeStr} (${session.history.length} messages, ${totalTokens.toLocaleString()} tokens, ${session.budget.turns} turns)`;
}
