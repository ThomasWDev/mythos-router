import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ProviderOrchestrator } from '../src/providers/orchestrator.js';
import { TelemetryStore, type ProviderState } from '../src/providers/telemetry.js';
import type { BaseProvider, Message, SendOptions, StreamOptions, UnifiedResponse } from '../src/providers/types.js';
import { WorkspaceContext } from '../src/workspace.js';

class ScopedProvider implements BaseProvider {
  readonly capabilities = new Set(['streaming'] as const);
  readonly telemetryIdentity = { modelId: 'model-a', endpointHash: 'endpoint-a' };
  constructor(readonly id: string) {}
  async sendMessage(_messages: Message[], _options: SendOptions): Promise<UnifiedResponse> { throw new Error('unused'); }
  async streamMessage(_messages: Message[], _options: StreamOptions): Promise<UnifiedResponse> { throw new Error('unused'); }
}

const roots: string[] = [];
afterEach(() => {
  TelemetryStore.closeAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(name: string, home: string): WorkspaceContext {
  const parent = mkdtempSync(join(tmpdir(), 'mythos-telemetry-root-'));
  roots.push(parent);
  const root = join(parent, name);
  mkdirSync(root);
  return new WorkspaceContext({ rootDir: root, homeDir: home });
}

function state(scopeKey: string): ProviderState {
  return {
    id: 'provider-a',
    scopeKey,
    modelId: 'model-a',
    endpointHash: 'endpoint-a',
    successRate: 0.72,
    avgLatency: 432,
    prevSuccessRate: 0.8,
    prevAvgLatency: 500,
    costPer1k: 0.004,
    totalCalls: 25,
    totalFailures: 4,
    degradedUntil: Date.now() + 60_000,
  };
}

describe('workspace-scoped provider telemetry', () => {
  it('keeps same-name repositories in different telemetry databases', () => {
    const home = mkdtempSync(join(tmpdir(), 'mythos-telemetry-home-'));
    roots.push(home);
    const a = workspace('repo', home);
    const b = workspace('repo', home);
    const storeA = TelemetryStore.getInstance(a);
    const storeB = TelemetryStore.getInstance(b);
    assert.notEqual(storeA.path, storeB.path);
  });

  it('persists normalized metrics and rehydrates a new orchestrator slot', () => {
    const home = mkdtempSync(join(tmpdir(), 'mythos-telemetry-home-'));
    roots.push(home);
    const ws = workspace('repo', home);
    const scope = 'provider-a:model-a:endpoint-a';
    const store = TelemetryStore.getInstance(ws);
    const expected = state(scope);
    store.updateMetrics(expected);
    store.flush();
    TelemetryStore.closeAll();

    const reopened = TelemetryStore.getInstance(ws);
    assert.deepEqual(reopened.getProviderMetric(scope), expected);

    const orchestrator = new ProviderOrchestrator(undefined, ws);
    orchestrator.registerProvider(new ScopedProvider('provider-a'));
    const health = orchestrator.getProviderHealth()[0]!;
    assert.equal(health.metrics.totalCalls, 25);
    assert.equal(health.metrics.avgLatency, 432);
    assert.equal(health.metrics.costPer1k, 0.004);
    assert.equal(health.status, 'degraded');
  });
});
