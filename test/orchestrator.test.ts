import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderOrchestrator, isRetryableError } from '../src/providers/orchestrator.js';
import {
  type BaseProvider,
  type Message,
  type ProviderCapability,
  type SendOptions,
  type StreamOptions,
  type UnifiedResponse,
  ProviderError,
} from '../src/providers/types.js';

function makeResponse(providerId: string, text = 'ok'): UnifiedResponse {
  return {
    thinking: '',
    text,
    toolCalls: [],
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 20,
    },
    metadata: {
      providerId,
      modelId: `${providerId}-test-model`,
      fallbackTriggered: false,
      incomplete: false,
    },
  };
}

class FakeProvider implements BaseProvider {
  readonly capabilities: ReadonlySet<ProviderCapability>;
  sendCalls = 0;
  streamCalls = 0;

  constructor(
    readonly id: string,
    capabilities: ProviderCapability[] = ['streaming'],
    private readonly behavior: {
      send?: () => Promise<UnifiedResponse>;
      stream?: () => Promise<UnifiedResponse>;
    } = {},
  ) {
    this.capabilities = new Set(capabilities);
  }

  async sendMessage(_messages: Message[], _options: SendOptions): Promise<UnifiedResponse> {
    this.sendCalls++;
    if (this.behavior.send) return this.behavior.send();
    return makeResponse(this.id);
  }

  async streamMessage(_messages: Message[], _options: StreamOptions): Promise<UnifiedResponse> {
    this.streamCalls++;
    if (this.behavior.stream) return this.behavior.stream();
    return makeResponse(this.id);
  }
}

const messages: Message[] = [{ role: 'user', content: 'route this' }];
const sendOptions: SendOptions = { systemPrompt: 'test', effort: 'low' };
const noopTelemetry = {
  updateMetrics: () => {},
  logDecision: () => {},
  logFailure: () => {},
};

describe('ProviderOrchestrator', () => {
  it('uses provider priority as the startup tie-breaker', async () => {
    const orchestrator = new ProviderOrchestrator(noopTelemetry);
    const lowerPriority = new FakeProvider('lower-priority');
    const higherPriority = new FakeProvider('higher-priority');

    orchestrator.registerProvider(lowerPriority, { priority: 10 });
    orchestrator.registerProvider(higherPriority, { priority: 0 });

    const response = await orchestrator.sendMessage(messages, sendOptions);

    assert.equal(response.metadata.providerId, 'higher-priority');
    assert.equal(higherPriority.sendCalls, 1);
    assert.equal(lowerPriority.sendCalls, 0);
  });

  it('falls back to the next provider after a provider failure', async () => {
    const orchestrator = new ProviderOrchestrator(noopTelemetry);
    const failing = new FakeProvider('failing', ['streaming'], {
      send: async () => {
        throw new Error('provider rejected request');
      },
    });
    const fallback = new FakeProvider('fallback');

    orchestrator.registerProvider(failing, { priority: 0 });
    orchestrator.registerProvider(fallback, { priority: 1 });

    const response = await orchestrator.sendMessage(messages, sendOptions);

    assert.equal(response.metadata.providerId, 'fallback');
    assert.equal(response.metadata.fallbackTriggered, true);
    assert.equal(failing.sendCalls, 1);
    assert.equal(fallback.sendCalls, 1);
  });

  it('does not degrade a provider after one exhausted retryable request', async () => {
    const states: Array<{ id: string; degradedUntil: number }> = [];
    const telemetry = {
      updateMetrics: (state: { id: string; degradedUntil: number }) => {
        states.push({ id: state.id, degradedUntil: state.degradedUntil });
      },
      logDecision: () => {},
      logFailure: () => {},
    };
    const orchestrator = new ProviderOrchestrator(telemetry);
    const failing = new FakeProvider('failing', ['streaming'], {
      send: async () => {
        throw new Error('503 service unavailable');
      },
    });
    const fallback = new FakeProvider('fallback');

    orchestrator.registerProvider(failing, { priority: 0 });
    orchestrator.registerProvider(fallback, { priority: 1 });

    const response = await orchestrator.sendMessage(messages, sendOptions);
    const failingStates = states.filter((state) => state.id === 'failing');

    assert.equal(response.metadata.providerId, 'fallback');
    assert.equal(failing.sendCalls, 4);
    assert.equal(failingStates.some((state) => state.degradedUntil > 0), false);
  });

  it('preserves the exact fallback reason and separates retries from provider transitions', async () => {
    const failures: string[] = [];
    const telemetry = {
      updateMetrics: () => {},
      logDecision: () => {},
      logFailure: (failure: { errorType: string }) => failures.push(failure.errorType),
    };
    const orchestrator = new ProviderOrchestrator(telemetry);
    const rateLimited = new FakeProvider('rate-limited', ['streaming'], {
      send: async () => {
        throw new ProviderError('slow down', {
          kind: 'rate_limit',
          providerId: 'rate-limited',
          retryable: false,
        });
      },
    });
    const fallback = new FakeProvider('fallback');
    orchestrator.registerProvider(rateLimited, { priority: 0 });
    orchestrator.registerProvider(fallback, { priority: 1 });

    const response = await orchestrator.sendMessage(messages, sendOptions);
    const events = orchestrator.getEventLog();

    assert.equal(response.metadata.providerId, 'fallback');
    assert.deepEqual(failures, ['rate_limit']);
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((event) => ({
        provider: event.actualProvider,
        reason: event.fallbackReason,
        retries: event.retryCount,
        fallbacks: event.fallbackCount,
      })),
      [
        { provider: 'rate-limited', reason: 'rate_limit', retries: 0, fallbacks: 0 },
        { provider: 'fallback', reason: 'rate_limit', retries: 0, fallbacks: 1 },
      ],
    );
  });

  it('does not call fallback providers when fallback is disabled', async () => {
    const orchestrator = new ProviderOrchestrator(noopTelemetry);
    const failing = new FakeProvider('failing', ['streaming'], {
      send: async () => {
        throw new Error('hard failure');
      },
    });
    const fallback = new FakeProvider('fallback');

    orchestrator.registerProvider(failing, { priority: 0 });
    orchestrator.registerProvider(fallback, { priority: 1 });

    await assert.rejects(
      () => orchestrator.sendMessage(messages, { ...sendOptions, allowFallback: false }),
      /hard failure/,
    );

    assert.equal(failing.sendCalls, 1);
    assert.equal(fallback.sendCalls, 0);
  });
});

const streamOptions: StreamOptions = { systemPrompt: 'test', effort: 'low' };

describe('ProviderOrchestrator — selection & resilience', () => {
  it('forceProvider selects the named provider even at lower priority', async () => {
    const orchestrator = new ProviderOrchestrator(noopTelemetry);
    const primary = new FakeProvider('primary');
    const forced = new FakeProvider('forced');
    orchestrator.registerProvider(primary, { priority: 0 });
    orchestrator.registerProvider(forced, { priority: 5 });

    const response = await orchestrator.sendMessage(messages, { ...sendOptions, forceProvider: 'forced' });

    assert.equal(response.metadata.providerId, 'forced');
    assert.equal(forced.sendCalls, 1);
    assert.equal(primary.sendCalls, 0);
  });

  it('throws when forceProvider names an unavailable provider', async () => {
    const orchestrator = new ProviderOrchestrator(noopTelemetry);
    orchestrator.registerProvider(new FakeProvider('only'), { priority: 0 });

    await assert.rejects(
      () => orchestrator.sendMessage(messages, { ...sendOptions, forceProvider: 'ghost' }),
      /not available/,
    );
  });

  it('throws a clear error when no providers are registered', async () => {
    const orchestrator = new ProviderOrchestrator(noopTelemetry);

    await assert.rejects(
      () => orchestrator.sendMessage(messages, sendOptions),
      /No providers available/,
    );
  });

  it('deterministic selection is stable across repeated calls', async () => {
    const orchestrator = new ProviderOrchestrator(noopTelemetry);
    orchestrator.registerProvider(new FakeProvider('det-a'), { priority: 0 });
    orchestrator.registerProvider(new FakeProvider('det-b'), { priority: 1 });
    orchestrator.registerProvider(new FakeProvider('det-c'), { priority: 2 });

    const first = await orchestrator.sendMessage(messages, { ...sendOptions, deterministic: true });
    const second = await orchestrator.sendMessage(messages, { ...sendOptions, deterministic: true });

    assert.equal(first.metadata.providerId, second.metadata.providerId);
  });

  it('deterministic mode does not fall back on failure', async () => {
    const orchestrator = new ProviderOrchestrator(noopTelemetry);
    const failing = new FakeProvider('det-fail', ['streaming'], {
      send: async () => {
        throw new Error('bad request');
      },
    });
    const other = new FakeProvider('det-other');
    orchestrator.registerProvider(failing, { priority: 0 });
    orchestrator.registerProvider(other, { priority: 1 });

    await assert.rejects(
      () => orchestrator.sendMessage(messages, { ...sendOptions, deterministic: true, forceProvider: 'det-fail' }),
      /Deterministic mode/,
    );
    assert.equal(other.sendCalls, 0);
  });

  it('retries a retryable failure and then succeeds on the same provider', async () => {
    let attempts = 0;
    const flaky = new FakeProvider('flaky', ['streaming'], {
      send: async () => {
        attempts++;
        if (attempts < 3) throw new Error('503 service unavailable');
        return makeResponse('flaky');
      },
    });
    const orchestrator = new ProviderOrchestrator(noopTelemetry);
    orchestrator.registerProvider(flaky, { priority: 0 });

    const response = await orchestrator.sendMessage(messages, sendOptions);

    assert.equal(response.metadata.providerId, 'flaky');
    assert.equal(attempts, 3); // two retryable failures, then success
    const [event] = orchestrator.getEventLog();
    assert.equal(event.retryCount, 2);
    assert.equal(event.fallbackCount, 0);
    assert.equal(event.fallbackReason, undefined);
  });

  it('enforces the non-streaming timeout as a typed timeout failure', async () => {
    const hanging: BaseProvider = {
      id: 'hanging',
      capabilities: new Set(['streaming']),
      sendMessage: async (_messages, options) => new Promise<UnifiedResponse>((_resolve, reject) => {
        const onAbort = () => reject(options.signal?.reason ?? new Error('aborted'));
        options.signal?.addEventListener('abort', onAbort, { once: true });
      }),
      streamMessage: async () => makeResponse('hanging'),
    };
    const orchestrator = new ProviderOrchestrator(noopTelemetry);
    orchestrator.registerProvider(hanging, { priority: 0 });

    await assert.rejects(
      () => orchestrator.sendMessage(messages, {
        ...sendOptions,
        timeoutMs: 15,
        allowFallback: false,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.kind, 'timeout');
        return true;
      },
    );
  });

  it('does not retry a non-retryable failure before falling back', async () => {
    let attempts = 0;
    const failing = new FakeProvider('nonretry', ['streaming'], {
      send: async () => {
        attempts++;
        throw new Error('invalid request');
      },
    });
    const fallback = new FakeProvider('nr-fallback');
    const orchestrator = new ProviderOrchestrator(noopTelemetry);
    orchestrator.registerProvider(failing, { priority: 0 });
    orchestrator.registerProvider(fallback, { priority: 1 });

    const response = await orchestrator.sendMessage(messages, sendOptions);

    assert.equal(response.metadata.providerId, 'nr-fallback');
    assert.equal(attempts, 1); // non-retryable: a single attempt, no backoff retries
  });

  it('trips the circuit breaker after the consecutive retryable failure threshold', async () => {
    const degradedUntilById = new Map<string, number>();
    const telemetry = {
      updateMetrics: (state: { id: string; degradedUntil: number }) => {
        degradedUntilById.set(state.id, state.degradedUntil);
      },
      logDecision: () => {},
      logFailure: () => {},
    };
    const orchestrator = new ProviderOrchestrator(telemetry);
    const failing = new FakeProvider('cb', ['streaming'], {
      send: async () => {
        throw new Error('503 service unavailable');
      },
    });
    orchestrator.registerProvider(failing, { priority: 0 });

    // First exhausted retryable request: one consecutive failure, breaker stays closed.
    await assert.rejects(
      () => orchestrator.sendMessage(messages, { ...sendOptions, forceProvider: 'cb', allowFallback: false }),
    );
    assert.equal(degradedUntilById.get('cb') ?? 0, 0);

    // Second exhausted retryable request: threshold reached, breaker trips.
    await assert.rejects(
      () => orchestrator.sendMessage(messages, { ...sendOptions, forceProvider: 'cb', allowFallback: false }),
    );
    assert.equal((degradedUntilById.get('cb') ?? 0) > 0, true);
  });

  it('releases the concurrency slot after a successful request', async () => {
    const orchestrator = new ProviderOrchestrator(noopTelemetry);
    orchestrator.registerProvider(new FakeProvider('conc-ok'), { priority: 0 });

    await orchestrator.sendMessage(messages, sendOptions);
    const slot = orchestrator.getProviderHealth().find((h) => h.id === 'conc-ok');

    assert.equal(slot?.concurrency, 0);
  });

  it('rejects invalid maxConcurrency values at registration', () => {
    const orchestrator = new ProviderOrchestrator(noopTelemetry);
    assert.throws(
      () => orchestrator.registerProvider(new FakeProvider('invalid'), { maxConcurrency: 0 }),
      /positive integer/,
    );
  });

  it('stores normalized cost rather than request-total cost in routing metrics', async () => {
    const makeSizedProvider = (id: string, inputTokens: number) => new FakeProvider(id, ['streaming'], {
      send: async () => ({
        ...makeResponse(id),
        usage: { inputTokens, outputTokens: 0, latencyMs: 20 },
        metadata: {
          ...makeResponse(id).metadata,
          modelId: 'gpt-4o',
        },
      }),
    });

    const small = new ProviderOrchestrator(noopTelemetry);
    small.registerProvider(makeSizedProvider('small', 1_000));
    await small.sendMessage(messages, sendOptions);

    const large = new ProviderOrchestrator(noopTelemetry);
    large.registerProvider(makeSizedProvider('large', 100_000));
    await large.sendMessage(messages, sendOptions);

    const smallMetric = small.getProviderHealth()[0].metrics.costPer1k;
    const largeMetric = large.getProviderHealth()[0].metrics.costPer1k;
    assert.equal(largeMetric, smallMetric);
  });

  it('excludes disabled providers from routing and provider count', async () => {
    const orchestrator = new ProviderOrchestrator(noopTelemetry);
    const disabled = new FakeProvider('disabled');
    const active = new FakeProvider('active');
    orchestrator.registerProvider(disabled, { priority: 0, enabled: false });
    orchestrator.registerProvider(active, { priority: 1 });

    const response = await orchestrator.sendMessage(messages, sendOptions);

    assert.equal(response.metadata.providerId, 'active');
    assert.equal(disabled.sendCalls, 0);
    assert.equal(orchestrator.providerCount, 1);
  });

  it('falls back to the next provider on the streaming path', async () => {
    const orchestrator = new ProviderOrchestrator(noopTelemetry);
    const failing = new FakeProvider('stream-fail', ['streaming'], {
      stream: async () => {
        throw new Error('stream backend rejected');
      },
    });
    const fallback = new FakeProvider('stream-ok');
    orchestrator.registerProvider(failing, { priority: 0 });
    orchestrator.registerProvider(fallback, { priority: 1 });

    // Small watchdog so any timer left pending by the failed slot resolves fast.
    const response = await orchestrator.streamMessage(messages, { ...streamOptions, timeoutMs: 100 });

    assert.equal(response.metadata.providerId, 'stream-ok');
    assert.equal(response.metadata.fallbackTriggered, true);
    assert.equal(failing.streamCalls, 1);
  });
});

describe('isRetryableError: status precedence and digit-token matching', () => {
  it('retries on a real retryable status property', () => {
    const err = Object.assign(new Error('Too Many Requests'), { status: 429 });
    assert.equal(isRetryableError(err), true);
  });

  it('does NOT retry on a non-retryable status property even if the message has digits', () => {
    const err = Object.assign(new Error('bad request 400 for req 529things'), { status: 400 });
    assert.equal(isRetryableError(err), false);
  });

  it('reads status from a nested response object', () => {
    const err = Object.assign(new Error('server error'), { response: { status: 503 } });
    assert.equal(isRetryableError(err), true);
  });

  it('does NOT treat an embedded digit run as a status code', () => {
    // "15029 bytes" contains "529"; "req_5290" contains "529" — neither is a 529.
    assert.equal(isRetryableError(new Error('file is 15029 bytes, too large')), false);
    assert.equal(isRetryableError(new Error('request req_5290 failed validation')), false);
  });

  it('matches a standalone status token in the message when no status property exists', () => {
    assert.equal(isRetryableError(new Error('upstream returned 500 Internal Server Error')), true);
    assert.equal(isRetryableError(new Error('upstream returned 503 Service Unavailable')), true);
    assert.equal(isRetryableError(new Error('HTTP 429: rate limited')), true);
  });

  it('still matches network and overload phrasings', () => {
    assert.equal(isRetryableError(new Error('fetch failed: ECONNRESET')), true);
    assert.equal(isRetryableError(new Error('Service is overloaded, try again')), true);
  });

  it('does not retry a plain non-retryable error', () => {
    assert.equal(isRetryableError(new Error('invalid api key')), false);
    assert.equal(isRetryableError('not even an error'), false);
  });
});
