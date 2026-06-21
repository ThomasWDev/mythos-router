import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderOrchestrator } from '../src/providers/orchestrator.js';
import {
  type BaseProvider,
  type Message,
  type ProviderCapability,
  type SendOptions,
  type StreamOptions,
  type UnifiedResponse,
} from '../src/providers/types.js';

function makeResponse(providerId: string): UnifiedResponse {
  return {
    thinking: '',
    text: 'ok',
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5, latencyMs: 20 },
    metadata: { providerId, modelId: `${providerId}-model`, fallbackTriggered: false, incomplete: false },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// A provider that blocks inside the call until a shared gate resolves, while
// tracking how many calls are in flight (so the test can observe peak
// concurrency) and how many it received in total.
class GatedProvider implements BaseProvider {
  readonly capabilities: ReadonlySet<ProviderCapability> = new Set(['streaming']);
  active = 0;
  peak = 0;
  calls = 0;

  constructor(readonly id: string, private readonly gate: Promise<void>) {}

  async sendMessage(_messages: Message[], _options: SendOptions): Promise<UnifiedResponse> {
    this.calls++;
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      await this.gate;
      return makeResponse(this.id);
    } finally {
      this.active--;
    }
  }

  async streamMessage(_messages: Message[], _options: StreamOptions): Promise<UnifiedResponse> {
    return this.sendMessage(_messages, _options as SendOptions);
  }
}

const messages: Message[] = [{ role: 'user', content: 'route this' }];
const sendOptions: SendOptions = { systemPrompt: 'test', effort: 'low' };
const noopTelemetry = { updateMetrics: () => {}, logDecision: () => {}, logFailure: () => {} };

describe('orchestrator concurrency admission', () => {
  it('routes parallel calls to providers with capacity and never exceeds maxConcurrency', async () => {
    const gate = deferred<void>();
    const a = new GatedProvider('a', gate.promise);
    const b = new GatedProvider('b', gate.promise);
    const orch = new ProviderOrchestrator(noopTelemetry);
    orch.registerProvider(a, { priority: 0, maxConcurrency: 1 });
    orch.registerProvider(b, { priority: 1, maxConcurrency: 1 });

    const inflight = [orch.sendMessage(messages, sendOptions), orch.sendMessage(messages, sendOptions)];
    await new Promise((r) => setTimeout(r, 25)); // let both reach the gate

    // The second call must land on the provider with headroom, not pile onto a
    // full one — so neither provider exceeds its cap of 1.
    assert.ok(a.peak <= 1, `provider a peaked at ${a.peak}`);
    assert.ok(b.peak <= 1, `provider b peaked at ${b.peak}`);
    assert.equal(a.calls + b.calls, 2);

    gate.resolve();
    await Promise.all(inflight);

    const health = orch.getProviderHealth();
    assert.equal(health.find((h) => h.id === 'a')!.concurrency, 0);
    assert.equal(health.find((h) => h.id === 'b')!.concurrency, 0);
  });

  it('still serves every call when a single provider is the only option', async () => {
    const gate = deferred<void>();
    const only = new GatedProvider('only', gate.promise);
    const orch = new ProviderOrchestrator(noopTelemetry);
    orch.registerProvider(only, { priority: 0, maxConcurrency: 1 });

    const inflight = [orch.sendMessage(messages, sendOptions), orch.sendMessage(messages, sendOptions)];
    await new Promise((r) => setTimeout(r, 25));
    gate.resolve();
    const results = await Promise.all(inflight);

    // No alternative provider: the last-resort path admits both rather than
    // failing, and the slot is still released afterwards.
    assert.equal(results.length, 2);
    assert.equal(only.calls, 2);
    assert.equal(orch.getProviderHealth()[0].concurrency, 0);
  });
});
