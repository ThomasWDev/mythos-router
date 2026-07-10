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
  ProviderError,
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

    // The second request is queued. maxConcurrency is a hard cap, even when no
    // fallback provider exists.
    assert.equal(only.calls, 1);
    assert.equal(only.peak, 1);

    gate.resolve();
    const results = await Promise.all(inflight);

    assert.equal(results.length, 2);
    assert.equal(only.calls, 2);
    assert.equal(only.peak, 1);
    assert.equal(orch.getProviderHealth()[0].concurrency, 0);
  });

  it('queues a saturated forced provider instead of silently routing elsewhere', async () => {
    const gate = deferred<void>();
    const forced = new GatedProvider('forced', gate.promise);
    const alternative = new GatedProvider('alternative', Promise.resolve());
    const orch = new ProviderOrchestrator(noopTelemetry);
    orch.registerProvider(forced, { priority: 0, maxConcurrency: 1 });
    orch.registerProvider(alternative, { priority: 1, maxConcurrency: 1 });

    const options = { ...sendOptions, forceProvider: 'forced' };
    const first = orch.sendMessage(messages, options);
    await new Promise((r) => setTimeout(r, 10));
    const second = orch.sendMessage(messages, options);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(forced.calls, 1);
    assert.equal(alternative.calls, 0);
    assert.equal(forced.peak, 1);

    gate.resolve();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((result) => result.metadata.providerId), ['forced', 'forced']);
    assert.equal(forced.calls, 2);
    assert.equal(forced.peak, 1);
  });

  it('removes an aborted request from the capacity queue without calling the provider', async () => {
    const gate = deferred<void>();
    const only = new GatedProvider('only', gate.promise);
    const orch = new ProviderOrchestrator(noopTelemetry);
    orch.registerProvider(only, { priority: 0, maxConcurrency: 1 });

    const first = orch.sendMessage(messages, sendOptions);
    await new Promise((r) => setTimeout(r, 10));

    const controller = new AbortController();
    const queued = orch.sendMessage(messages, { ...sendOptions, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort(new Error('caller stopped waiting'));

    await assert.rejects(queued, (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'cancelled');
      return true;
    });
    assert.equal(only.calls, 1);

    gate.resolve();
    await first;
    assert.equal(orch.getProviderHealth()[0].concurrency, 0);
  });
});
