// ─────────────────────────────────────────────────────────────
//  mythos-router :: memory.ts
//  Self-Healing Memory — Authority-Based Derivative Indexing
// ─────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, statSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getDatabaseSync } from './sqlite-loader.js';
import { MEMORY_FILE, MEMORY_DB_FILE, MEMORY_MAX_LINES } from './config.js';
import { timestamp, c, info, success, warn, dryRunBadge, theme } from './utils.js';
import { resolveWorkspace, type WorkspaceInput } from './workspace.js';

// ── Types ────────────────────────────────────────────────────
export interface MemoryEntry {
  timestamp: string;
  action: string;
  result: string;
}

// ── Path resolution ──────────────────────────────────────────
export function getMemoryPath(workspaceInput?: WorkspaceInput): string {
  return resolve(resolveWorkspace(workspaceInput).rootDir, MEMORY_FILE);
}

export function getDbPath(workspaceInput?: WorkspaceInput): string {
  return resolve(resolveWorkspace(workspaceInput).rootDir, MEMORY_DB_FILE);
}

// ── Integrity & Signpost Check ────────────────────────────────
/**
 * Calculates a SHA-256 hash of the entire MEMORY.md file.
 * This is the "Sole Authority" for data integrity.
 */
function getMemoryHash(workspaceInput?: WorkspaceInput): string {
  const path = getMemoryPath(workspaceInput);
  if (!existsSync(path)) return 'none';
  const content = readFileSync(path, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

// ── Derivative Index Lifecycle (Non-authoritative) ────────────
/**
 * THE DERIVATIVE INDEX RULE:
 * 1. Authority: MEMORY.md is the ONLY source of truth.
 * 2. Purgeability: This SQLite database is fully disposable and non-authoritative.
 *    It can be deleted or rebuilt at any time without loss of information.
 * 3. Failure Isolation: A database failure MUST NEVER affect system correctness.
 *    If SQLite fails, the system continues with reduced search performance.
 */
type MemoryDatabase = InstanceType<ReturnType<typeof getDatabaseSync>>;
const databases = new Map<string, MemoryDatabase>();

/**
 * Returns the open SQLite database instance.
 * Initializes schema and triggers if needed.
 */
function getDb(workspaceInput?: WorkspaceInput): MemoryDatabase {
  const workspace = resolveWorkspace(workspaceInput);
  const existing = databases.get(workspace.rootDir);
  if (existing) return existing;

  const DatabaseSync = getDatabaseSync();
  const path = getDbPath(workspace);
  const db = new DatabaseSync(path);
  databases.set(workspace.rootDir, db);

  // WAL mode for better concurrency and safety
  db.exec('PRAGMA journal_mode=WAL;');

  /**
   * Authority Rule: SQLite is a derivative index.
   * We use a sync_cache table to store the last known manifest hash of MEMORY.md.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_cache (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      tags TEXT,
      metadata TEXT
    );

    -- FTS5 for intelligent retrieval
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      action, 
      result, 
      content='memory', 
      content_rowid='id',
      tokenize="unicode61"
    );

    -- Lifecycle Triggers
    CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, action, result) VALUES (new.id, new.action, new.result);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
      DELETE FROM memory_fts WHERE rowid = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
      DELETE FROM memory_fts WHERE rowid = old.id;
      INSERT INTO memory_fts(rowid, action, result) VALUES (new.id, new.action, new.result);
    END;
  `);

  return db;
}

/**
 * Unconditionally rebuilds the SQLite index artifact from MEMORY.md.
 * This is the "Recovery Path" for data integrity.
 */
export function rebuildIndex(dryRun = false, workspaceInput?: WorkspaceInput): void {
  const mdPath = getMemoryPath(workspaceInput);
  if (!existsSync(mdPath)) return;

  if (dryRun) {
    console.log(`${dryRunBadge()} ${c.dim}Would rebuild memory index from MEMORY.md${c.reset}`);
    return;
  }

  const db = getDb(workspaceInput);
  const entries = parseMemoryFile(workspaceInput);

  // Atomic Reconstruction
  db.exec('BEGIN;');
  try {
    db.exec('DELETE FROM memory;');
    db.exec('DELETE FROM memory_fts;');

    const insert = db.prepare(`
      INSERT INTO memory (timestamp, action, result)
      VALUES (?, ?, ?)
    `);

    for (const entry of entries) {
      insert.run(entry.timestamp, entry.action, entry.result);
    }

    // Update signpost (The "Truth Hash")
    const hash = getMemoryHash(workspaceInput);
    db.prepare('INSERT OR REPLACE INTO sync_cache (key, value) VALUES (?, ?)')
      .run('manifest_hash', hash);

    db.exec('COMMIT;');
    success(`Memory index rebuilt (${entries.length} entries)`);
  } catch (err: any) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

// ── Initialize MEMORY.md if it doesn't exist ─────────────────
export function initMemory(dryRun = false, workspaceInput?: WorkspaceInput): void {
  const path = getMemoryPath(workspaceInput);
  if (!existsSync(path)) {
    if (dryRun) {
      console.log(`${dryRunBadge()} ${c.dim}Would create MEMORY.md (not yet initialized)${c.reset}`);
      return;
    }
    const header =
      `# 🧠 MEMORY.md — mythos-router Agentic Memory\n\n` +
      `> Auto-managed by the Capybara tier. Each model turn is logged.\n` +
      `> When entries exceed ${MEMORY_MAX_LINES} entries, a "Dream" compresses older context.\n\n` +
      `---\n\n` +
      `| Timestamp | Action | Verified Result |\n` +
      `|-----------|--------|----------------|\n`;
    writeFileSync(path, header, 'utf-8');
  }

  // Authority Check: Startup-only reconciliation
  if (!dryRun) {
    try {
      const db = getDb(workspaceInput);
      const storedHashRow = db.prepare('SELECT value FROM sync_cache WHERE key = ?').get('manifest_hash') as { value: string } | undefined;
      const currentHash = getMemoryHash(workspaceInput);

      if (!storedHashRow || storedHashRow.value !== currentHash) {
        if (!storedHashRow) {
          info('Initializing memory index...');
        } else {
          warn('Memory index out of sync — rebuilding...');
        }
        rebuildIndex(false, workspaceInput);
      }
    } catch (err: any) {
      warn(`Failed to verify memory index: ${err.message}`);
    }
  }
}

// ── Append a single entry ────────────────────────────────────
export function appendEntry(action: string, result: string, dryRun = false, workspaceInput?: WorkspaceInput): void {
  initMemory(dryRun, workspaceInput);
  const path = getMemoryPath(workspaceInput);
  const ts = timestamp();
  const sanitizedAction = sanitize(action);
  const sanitizedResult = sanitize(result);
  const line = `| ${ts} | ${sanitizedAction} | ${sanitizedResult} |`;

  if (dryRun) {
    console.log(`${dryRunBadge()} ${c.dim}Would append to MEMORY.md:${c.reset} ${c.cyan}${sanitizedAction}${c.reset} → ${c.dim}${sanitizedResult}${c.reset}`);
    return;
  }

  // 1. Markdown First (Sole Authority)
  // Standard appendFileSync is O(1) and safer than rewriting the whole file.
  appendFileSync(path, line + '\n', 'utf-8');

  // 2. Best-effort DB Indexing (Failure Isolated)
  // If this step fails, system correctness is untouched.
  try {
    const db = getDb(workspaceInput);
    const insert = db.prepare('INSERT INTO memory (timestamp, action, result) VALUES (?, ?, ?)');
    insert.run(ts, sanitizedAction, sanitizedResult);

    // Update Signpost
    const hash = getMemoryHash(workspaceInput);
    db.prepare('INSERT OR REPLACE INTO sync_cache (key, value) VALUES (?, ?)')
      .run('manifest_hash', hash);
  } catch (err: any) {
    warn(`Failed to update memory index: ${err.message}`);
  }
}

/**
 * Appends a hidden metadata block to MEMORY.md for machine parsing.
 */
export function appendMetadataBlock(metadata: Record<string, string>, type: string = 'meta', dryRun = false, workspaceInput?: WorkspaceInput): void {
  initMemory(dryRun, workspaceInput);
  const path = getMemoryPath(workspaceInput);
  
  let block = `\n<!-- mythos:${type}\n`;
  for (const [key, value] of Object.entries(metadata)) {
    block += `${key}=${value}\n`;
  }
  block += '-->\n\n';

  if (dryRun) {
    console.log(`${dryRunBadge()} ${c.dim}Would append metadata block to MEMORY.md:${c.reset}`);
    const preview = block.trim().split('\n').map(l => `  ${l}`).join('\n');
    console.log(`${c.cyan}${preview}${c.reset}`);
    return;
  }

  appendFileSync(path, block, 'utf-8');

  // Update signpost so the next initMemory() doesn't think the index is out of sync
  try {
    const db = getDb(workspaceInput);
    const hash = getMemoryHash(workspaceInput);
    db.prepare('INSERT OR REPLACE INTO sync_cache (key, value) VALUES (?, ?)')
      .run('manifest_hash', hash);
  } catch {
    // Ignore, derivative index is non-authoritative
  }
}

/**
 * Turn an arbitrary user string into a safe FTS5 MATCH expression.
 *
 * FTS5 treats characters like `"`, `*`, `:`, `(`, `)`, `+`, `-`, `^` as query
 * syntax, so a raw query such as `c++`, `don't`, or `foo(bar` is a *syntax
 * error* — which previously surfaced as an empty result plus a scary warning
 * instead of a search. We tokenize on non-alphanumeric runs and wrap each
 * token as a quoted FTS5 string, OR-ing them together so any term can match.
 * Returns an empty string when the query has no usable tokens (caller then
 * skips the search and returns no results, without ever hitting FTS5).
 */
function toFtsMatchQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(token => token.length > 0)
    // Escape embedded double-quotes per FTS5 string rules ("" = literal ").
    .map(token => `"${token.replace(/"/g, '""')}"`);
  return tokens.join(' OR ');
}

/**
 * Surgical retrieval from the derivative SQLite index using FTS5.
 * Returns ranked results matching the query.
 */
export function searchMemory(query: string, options?: { createIfMissing?: boolean; workspace?: WorkspaceInput }): MemoryEntry[] {
  if (options?.createIfMissing === false) {
    if (!existsSync(getDbPath(options.workspace))) return [];
  }

  const matchQuery = toFtsMatchQuery(query);
  if (matchQuery === '') return [];

  try {
    const db = getDb(options?.workspace);
    // Use FTS5 ranked search
    const results = db.prepare(`
      SELECT m.* 
      FROM memory m
      JOIN memory_fts f ON m.id = f.rowid
      WHERE memory_fts MATCH ?
      ORDER BY rank
      LIMIT 20
    `).all(matchQuery) as any[];

    return results.map(r => ({
      timestamp: r.timestamp,
      action: r.action,
      result: r.result
    }));
  } catch (err: any) {
    warn(`search failed (falling back to empty): ${err.message}`);
    return [];
  }
}

/**
 * Classifies a MEMORY.md line as a real data row (not the column header or the
 * markdown separator). The previous heuristic dropped any row that merely
 * *contained* "---" or "Timestamp", which silently lost legitimate entries
 * whose action/result mentioned those substrings (e.g. diffs, rules).
 */
function isMemoryEntryRow(line: string): boolean {
  if (!line.startsWith('|')) return false;
  // Markdown separator row: only pipes, dashes, colons, and whitespace.
  if (/^[\s|:-]+$/.test(line)) return false;
  // Column header row.
  if (line.includes('Timestamp') && line.includes('Verified Result')) return false;
  return true;
}

/**
 * Lower-level helper to parse MEMORY.md content directly.
 * Used by rebuildIndex to avoid infinite recursion with initMemory.
 */
function parseMemoryFile(workspaceInput?: WorkspaceInput): MemoryEntry[] {
  const path = getMemoryPath(workspaceInput);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n');

  const entries: MemoryEntry[] = [];
  for (const line of lines) {
    if (isMemoryEntryRow(line)) {
      const cols = line.split('|').map((s) => s.trim()).filter(Boolean);
      if (cols.length >= 3) {
        entries.push({
          timestamp: cols[0]!,
          action: cols[1]!,
          result: cols[2]!,
        });
      }
    }
  }
  return entries;
}

function getLatestFileMetadataBlocks(workspaceInput?: WorkspaceInput): string[] {
  const path = getMemoryPath(workspaceInput);
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, 'utf-8');
  const blockRe = /<!-- mythos:file\n([\s\S]*?)-->/g;
  const byPath = new Map<string, string>();
  const order: string[] = [];

  for (const match of raw.matchAll(blockRe)) {
    const body = match[1] ?? '';
    const meta = parseMetadataBody(body);
    const filePath = meta.path;

    if (!filePath) continue;
    if (!byPath.has(filePath)) order.push(filePath);

    byPath.set(filePath, `<!-- mythos:file\n${body.trim()}\n-->`);
  }

  return order
    .map((filePath) => byPath.get(filePath))
    .filter((block): block is string => Boolean(block));
}

function parseMetadataBody(body: string): Record<string, string> {
  const meta: Record<string, string> = {};

  for (const line of body.trim().split('\n')) {
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();

    if (key) meta[key] = value;
  }

  return meta;
}

// ── Read all entries ─────────────────────────────────────────
export function readMemory(workspaceInput?: WorkspaceInput): { header: string; entries: MemoryEntry[]; raw: string } {
  const path = getMemoryPath(workspaceInput);

  // Do NOT call initMemory() here — reads must never create files.
  // This ensures dry-run commands stay truly non-mutating.
  if (!existsSync(path)) {
    return { header: '', entries: [], raw: '' };
  }

  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n');

  const entries = parseMemoryFile(workspaceInput);
  const headerLines: string[] = [];

  for (const line of lines) {
    if (isMemoryEntryRow(line)) {
      break;
    }
    headerLines.push(line);
  }

  return {
    header: headerLines.join('\n'),
    entries,
    raw,
  };
}

// ── Count entry lines ────────────────────────────────────────
export function getEntryCount(workspaceInput?: WorkspaceInput): number {
  const { entries } = readMemory(workspaceInput);
  return entries.length;
}

// ── Check if Dream is needed ─────────────────────────────────
export function needsDream(workspaceInput?: WorkspaceInput): boolean {
  return getEntryCount(workspaceInput) > MEMORY_MAX_LINES;
}

// ── Write compressed memory ──────────────────────────────────
export function writeCompressedMemory(
  summary: string,
  recentEntries: MemoryEntry[],
  dryRun = false,
  workspaceInput?: WorkspaceInput,
): void {
  const path = getMemoryPath(workspaceInput);
  const ts = timestamp();

  let content =
    `# 🧠 MEMORY.md — mythos-router Agentic Memory\n\n` +
    `> Auto-managed by the Capybara tier.\n\n` +
    `---\n\n` +
    `## 💤 Dream Summary (Compressed ${ts})\n\n` +
    `${summary}\n\n` +
    `---\n\n` +
    `## Recent Entries\n\n` +
    `| Timestamp | Action | Verified Result |\n` +
    `|-----------|--------|----------------|\n`;

  for (const entry of recentEntries) {
    content += `| ${entry.timestamp} | ${entry.action} | ${entry.result} |\n`;
  }

  const preservedFileMetadata = getLatestFileMetadataBlocks(workspaceInput);
  if (preservedFileMetadata.length > 0) {
    content += `\n${preservedFileMetadata.join('\n')}\n`;
  }

  if (dryRun) {
    console.log(`${dryRunBadge()} ${c.dim}Would compress MEMORY.md:${c.reset}`);
    console.log(`${c.dim}  Summary: ${summary.slice(0, 120)}...${c.reset}`);
    console.log(`${c.dim}  Keeping ${recentEntries.length} recent entries${c.reset}`);
    return;
  }

  writeFileSync(path, content, 'utf-8');

  // Rebuild search index to reflect the compressed memory
  try {
    rebuildIndex(false, workspaceInput);
  } catch (err: any) {
    warn(`Failed to rebuild memory index after dream: ${err.message}`);
  }
}

// ── Get memory context for system prompt injection ───────────
export function getMemoryContext(maxChars = 4000, workspaceInput?: WorkspaceInput): string {
  try {
    const { raw } = readMemory(workspaceInput);
    if (raw.length <= maxChars) return raw;
    // Return the last maxChars characters (most recent context)
    return '…[truncated]\n' + raw.slice(-maxChars);
  } catch {
    return '';
  }
}

// ── Print memory status ──────────────────────────────────────
export function printMemoryStatus(workspaceInput?: WorkspaceInput): void {
  const path = getMemoryPath(workspaceInput);
  if (!existsSync(path)) {
    info(`No MEMORY.md found at ${theme.muted}${path}${c.reset}`);
    return;
  }
  const { entries, raw } = readMemory(workspaceInput);
  const hasSummary = raw.includes('## 💤 Dream Summary');
  console.log(
    `${theme.muted}Memory:${c.reset} ${theme.info}${entries.length}${c.reset} entries` +
    (hasSummary ? ` ${theme.muted}(has dream summary)${c.reset}` : '') +
    (needsDream(workspaceInput) ? ` ${theme.warning}(dream recommended)${c.reset}` : ''),
  );
}

export function closeMemoryDatabase(workspaceInput?: WorkspaceInput): void {
  const workspace = resolveWorkspace(workspaceInput);
  const db = databases.get(workspace.rootDir);
  if (!db) return;
  try {
    db.close();
  } finally {
    databases.delete(workspace.rootDir);
  }
}

// ── Sanitize for table ───────────────────────────────────────
function sanitize(text: string): string {
  return text
    .replace(/\|/g, '∣')
    .replace(/\n/g, ' ')
    .slice(0, 120);
}
