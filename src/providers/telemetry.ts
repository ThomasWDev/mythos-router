// ─────────────────────────────────────────────────────────────
//  mythos-router :: providers/telemetry.ts
//  Workspace-scoped SQLite telemetry and persisted routing state.
// ─────────────────────────────────────────────────────────────

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDatabaseSync } from '../sqlite-loader.js';
import { resolveWorkspace, type WorkspaceInput } from '../workspace.js';

export interface ProviderState {
  /** Human-readable provider id. */
  id: string;
  /** Stable provider/model/endpoint scope used as the persistence key. */
  scopeKey: string;
  modelId: string;
  endpointHash: string;
  successRate: number;
  avgLatency: number;
  prevSuccessRate: number;
  prevAvgLatency: number;
  costPer1k: number;
  totalCalls: number;
  totalFailures: number;
  degradedUntil: number;
}

export interface RoutingDecision {
  timestamp: number;
  selectedProvider: string;
  selectedScope?: string;
  taskType: 'chat' | 'code' | 'analysis' | 'unknown';
  inputSizeBucket: string;
  reasoning: string;
}

export interface FailureEvent {
  timestamp: number;
  provider: string;
  providerScope?: string;
  errorType: string;
  shortMessage: string;
  fullStack: string;
}

const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_EVENT_COUNT = 10;
const RETENTION_LIMIT = 1_000;

export class TelemetryStore {
  private static readonly instances = new Map<string, TelemetryStore>();
  private readonly db: InstanceType<ReturnType<typeof getDatabaseSync>>;
  private readonly databasePath: string;
  private metricUpdates = new Map<string, ProviderState>();
  private decisionQueue: RoutingDecision[] = [];
  private failureQueue: FailureEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private exitHandler: (() => void) | null = null;

  private constructor(workspaceInput?: WorkspaceInput) {
    const workspace = resolveWorkspace(workspaceInput);
    const telemetryDir = join(workspace.userStateDir, 'telemetry');
    mkdirSync(telemetryDir, { recursive: true });
    this.databasePath = join(telemetryDir, `${workspace.projectId}.db`);

    const DatabaseSync = getDatabaseSync();
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=NORMAL;');
    this.initSchema();
    this.setupGracefulShutdown();
    this.startFlushTimer();
  }

  public static getInstance(workspaceInput?: WorkspaceInput): TelemetryStore {
    const workspace = resolveWorkspace(workspaceInput);
    const key = join(workspace.userStateDir, 'telemetry', `${workspace.projectId}.db`);
    const existing = TelemetryStore.instances.get(key);
    if (existing) return existing;
    const store = new TelemetryStore(workspace);
    TelemetryStore.instances.set(key, store);
    return store;
  }

  public static closeAll(): void {
    for (const store of TelemetryStore.instances.values()) store.close();
    TelemetryStore.instances.clear();
  }

  public get path(): string {
    return this.databasePath;
  }

  public healthCheck(): { ok: boolean; error?: string } {
    try {
      const rows = this.db.prepare('PRAGMA quick_check;').all() as Array<Record<string, unknown>>;
      const values = rows.flatMap(row => Object.values(row).map(value => String(value)));
      return values.length > 0 && values.every(value => value.toLowerCase() === 'ok')
        ? { ok: true }
        : { ok: false, error: values.join('; ') || 'SQLite quick_check returned no result.' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_metrics (
        scope_key TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        endpoint_hash TEXT NOT NULL,
        success_rate REAL NOT NULL,
        avg_latency REAL NOT NULL,
        prev_success_rate REAL NOT NULL,
        prev_avg_latency REAL NOT NULL,
        cost_per_1k REAL NOT NULL,
        total_calls INTEGER NOT NULL,
        total_failures INTEGER NOT NULL,
        degraded_until INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS routing_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        selected_provider TEXT NOT NULL,
        selected_scope TEXT NOT NULL,
        task_type TEXT NOT NULL,
        input_size_bucket TEXT NOT NULL,
        reasoning TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        provider TEXT NOT NULL,
        provider_scope TEXT NOT NULL,
        error_type TEXT NOT NULL,
        short_message TEXT NOT NULL,
        full_stack TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telemetry_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  public updateMetrics(state: ProviderState): void {
    this.metricUpdates.set(state.scopeKey, { ...state });
    this.checkFlushQueue();
  }

  public getProviderMetric(scopeKey: string): ProviderState | null {
    const pending = this.metricUpdates.get(scopeKey);
    if (pending) return { ...pending };
    try {
      const row = this.db.prepare(
        'SELECT * FROM provider_metrics WHERE scope_key = ?',
      ).get(scopeKey) as Record<string, unknown> | undefined;
      return row ? rowToProviderState(row) : null;
    } catch {
      return null;
    }
  }

  public logDecision(decision: RoutingDecision): void {
    this.decisionQueue.push({ ...decision });
    this.checkFlushQueue();
  }

  public logFailure(failure: FailureEvent): void {
    this.failureQueue.push({ ...failure });
    this.checkFlushQueue();
  }

  private checkFlushQueue(): void {
    if (this.shuttingDown) return;
    const total = this.metricUpdates.size + this.decisionQueue.length + this.failureQueue.length;
    if (total >= FLUSH_EVENT_COUNT) this.flush();
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  public flush(): void {
    if (this.metricUpdates.size === 0 && this.decisionQueue.length === 0 && this.failureQueue.length === 0) return;

    try {
      this.db.exec('BEGIN IMMEDIATE;');
      const now = Date.now();
      const metricStatement = this.db.prepare(`
        INSERT INTO provider_metrics (
          scope_key, provider_id, model_id, endpoint_hash,
          success_rate, avg_latency, prev_success_rate, prev_avg_latency,
          cost_per_1k, total_calls, total_failures, degraded_until, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key) DO UPDATE SET
          provider_id = excluded.provider_id,
          model_id = excluded.model_id,
          endpoint_hash = excluded.endpoint_hash,
          success_rate = excluded.success_rate,
          avg_latency = excluded.avg_latency,
          prev_success_rate = excluded.prev_success_rate,
          prev_avg_latency = excluded.prev_avg_latency,
          cost_per_1k = excluded.cost_per_1k,
          total_calls = excluded.total_calls,
          total_failures = excluded.total_failures,
          degraded_until = excluded.degraded_until,
          updated_at = excluded.updated_at
      `);
      for (const state of this.metricUpdates.values()) {
        metricStatement.run(
          state.scopeKey,
          state.id,
          state.modelId,
          state.endpointHash,
          state.successRate,
          state.avgLatency,
          state.prevSuccessRate,
          state.prevAvgLatency,
          state.costPer1k,
          state.totalCalls,
          state.totalFailures,
          state.degradedUntil,
          now,
        );
      }

      const decisionStatement = this.db.prepare(`
        INSERT INTO routing_decisions
          (timestamp, selected_provider, selected_scope, task_type, input_size_bucket, reasoning)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const decision of this.decisionQueue) {
        decisionStatement.run(
          decision.timestamp,
          decision.selectedProvider,
          decision.selectedScope ?? decision.selectedProvider,
          decision.taskType,
          decision.inputSizeBucket,
          decision.reasoning,
        );
      }

      const failureStatement = this.db.prepare(`
        INSERT INTO failures
          (timestamp, provider, provider_scope, error_type, short_message, full_stack)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const failure of this.failureQueue) {
        failureStatement.run(
          failure.timestamp,
          failure.provider,
          failure.providerScope ?? failure.provider,
          failure.errorType,
          failure.shortMessage,
          failure.fullStack.slice(0, 4_096),
        );
      }

      this.db.prepare(`
        INSERT INTO telemetry_meta (key, value) VALUES ('updated_at', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(now));
      this.db.exec('COMMIT;');

      this.metricUpdates.clear();
      this.decisionQueue = [];
      this.failureQueue = [];
      this.enforceRetention();
    } catch {
      try { this.db.exec('ROLLBACK;'); } catch { /* best effort */ }
    }
  }

  private enforceRetention(): void {
    try {
      this.db.exec(`
        DELETE FROM routing_decisions WHERE id NOT IN (
          SELECT id FROM routing_decisions ORDER BY id DESC LIMIT ${RETENTION_LIMIT}
        );
        DELETE FROM failures WHERE id NOT IN (
          SELECT id FROM failures ORDER BY id DESC LIMIT ${RETENTION_LIMIT}
        );
      `);
    } catch {
      // Retention failure must not affect routing.
    }
  }

  private setupGracefulShutdown(): void {
    this.exitHandler = () => {
      this.shuttingDown = true;
      if (this.flushTimer) clearInterval(this.flushTimer);
      this.flush();
    };
    process.on('exit', this.exitHandler);
    process.on('beforeExit', this.exitHandler);
  }

  public close(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flush();
    if (this.exitHandler) {
      process.removeListener('exit', this.exitHandler);
      process.removeListener('beforeExit', this.exitHandler);
    }
    try { this.db.close(); } catch { /* best effort */ }
  }

  public getProviderMetrics(): ProviderState[] {
    try {
      const rows = this.db.prepare('SELECT * FROM provider_metrics').all() as Record<string, unknown>[];
      return rows.map(rowToProviderState);
    } catch {
      return [];
    }
  }

  public getRecentDecisions(limit = 3): RoutingDecision[] {
    try {
      const rows = this.db.prepare(
        'SELECT * FROM routing_decisions ORDER BY id DESC LIMIT ?',
      ).all(limit) as Record<string, unknown>[];
      return rows.map(row => ({
        timestamp: Number(row.timestamp),
        selectedProvider: String(row.selected_provider),
        selectedScope: String(row.selected_scope),
        taskType: String(row.task_type) as RoutingDecision['taskType'],
        inputSizeBucket: String(row.input_size_bucket),
        reasoning: String(row.reasoning),
      }));
    } catch {
      return [];
    }
  }

  public getRecentFailures(limit = 5): FailureEvent[] {
    try {
      const rows = this.db.prepare(
        'SELECT * FROM failures ORDER BY id DESC LIMIT ?',
      ).all(limit) as Record<string, unknown>[];
      return rows.map(row => ({
        timestamp: Number(row.timestamp),
        provider: String(row.provider),
        providerScope: String(row.provider_scope),
        errorType: String(row.error_type),
        shortMessage: String(row.short_message),
        fullStack: String(row.full_stack),
      }));
    } catch {
      return [];
    }
  }

  public getLastUpdatedTime(): number {
    try {
      const row = this.db.prepare(
        "SELECT value FROM telemetry_meta WHERE key = 'updated_at'",
      ).get() as { value?: string } | undefined;
      return Number(row?.value ?? 0);
    } catch {
      return 0;
    }
  }
}

function rowToProviderState(row: Record<string, unknown>): ProviderState {
  return {
    id: String(row.provider_id),
    scopeKey: String(row.scope_key),
    modelId: String(row.model_id),
    endpointHash: String(row.endpoint_hash),
    successRate: Number(row.success_rate),
    avgLatency: Number(row.avg_latency),
    prevSuccessRate: Number(row.prev_success_rate),
    prevAvgLatency: Number(row.prev_avg_latency),
    costPer1k: Number(row.cost_per_1k),
    totalCalls: Number(row.total_calls),
    totalFailures: Number(row.total_failures),
    degradedUntil: Number(row.degraded_until),
  };
}
