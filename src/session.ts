// ─────────────────────────────────────────────────────────────
//  mythos-router :: session.ts
//  Session persistence — save/resume conversation state
//  Single JSON file, atomic writes, versioned format
// ─────────────────────────────────────────────────────────────

import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Message } from './providers/types.js';
import { normalizeMessages } from './providers/messages.js';

const SESSION_VERSION = 2;
const LEGACY_SESSION_VERSION = 1;
const SESSIONS_DIR = join(homedir(), '.mythos-router', 'sessions');
const SESSION_FILE = join(SESSIONS_DIR, 'latest.json');
const SESSION_TMP = join(SESSIONS_DIR, 'latest.tmp');

// ── Serialized Session Format ────────────────────────────────
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

// ── Save Session (atomic write) ──────────────────────────────
export function saveSession(
  history: Message[],
  budget: { inputTokens: number; outputTokens: number; turns: number },
  project: string,
): void {
  const serialized = serializeSessionData({
    timestamp: new Date().toISOString(),
    project,
    history,
    budget,
  });

  mkdirSync(SESSIONS_DIR, { recursive: true });

  // Write to tmp first, then atomic rename
  writeFileSync(SESSION_TMP, serialized, 'utf-8');
  renameSync(SESSION_TMP, SESSION_FILE);
}

// ── Load Session ─────────────────────────────────────────────
export function loadSession(): SessionData | null {
  if (!existsSync(SESSION_FILE)) return null;

  try {
    return parseSessionData(readFileSync(SESSION_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

// ── Format resume info for terminal ──────────────────────────
export function formatResumeInfo(session: SessionData): string {
  const date = new Date(session.timestamp);
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = date.toLocaleDateString();
  const totalTokens = session.budget.inputTokens + session.budget.outputTokens;
  return `Resuming session from ${dateStr} ${timeStr} (${session.history.length} messages, ${totalTokens.toLocaleString()} tokens, ${session.budget.turns} turns)`;
}
