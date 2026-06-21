import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProviderError,
  isRetryableKind,
  kindFromStatus,
} from '../src/providers/types.js';
import { isRetryableError } from '../src/providers/orchestrator.js';

describe('ProviderError + retryability', () => {
  it('maps status codes to kinds', () => {
    assert.equal(kindFromStatus(429), 'rate_limit');
    assert.equal(kindFromStatus(529), 'overloaded');
    assert.equal(kindFromStatus(503), 'server_error');
    assert.equal(kindFromStatus(500), 'server_error');
    assert.equal(kindFromStatus(404), 'client_error');
    assert.equal(kindFromStatus(401), 'client_error');
    assert.equal(kindFromStatus(200), 'unknown');
  });

  it('classifies which kinds are retryable', () => {
    for (const kind of ['rate_limit', 'overloaded', 'server_error', 'network', 'timeout'] as const) {
      assert.equal(isRetryableKind(kind), true, `${kind} should retry`);
    }
    assert.equal(isRetryableKind('client_error'), false);
    assert.equal(isRetryableKind('unknown'), false);
  });

  it('derives retryable from kind by default', () => {
    assert.equal(new ProviderError('rl', { kind: 'rate_limit' }).retryable, true);
    assert.equal(new ProviderError('bad', { kind: 'client_error' }).retryable, false);
  });

  it('lets an explicit retryable flag override the kind default', () => {
    const forcedNoRetry = new ProviderError('overloaded but giving up', { kind: 'overloaded', retryable: false });
    assert.equal(forcedNoRetry.retryable, false);
  });

  it('isRetryableError trusts ProviderError over message heuristics', () => {
    // A client error whose message happens to contain "503" must NOT retry,
    // because the typed kind is authoritative.
    const tricky = new ProviderError('upstream returned 503 in body text', { kind: 'client_error' });
    assert.equal(isRetryableError(tricky), false);

    // And a typed rate-limit retries even with an otherwise-bland message.
    const rl = new ProviderError('slow down', { kind: 'rate_limit' });
    assert.equal(isRetryableError(rl), true);
  });

  it('still falls back to heuristics for raw (non-typed) errors', () => {
    assert.equal(isRetryableError(new Error('fetch failed')), true);
    assert.equal(isRetryableError(new Error('ECONNRESET while reading')), true);
    assert.equal(isRetryableError(new Error('totally fine, nothing to see')), false);
    // A 429 as a standalone token is retryable; embedded in an id it is not.
    assert.equal(isRetryableError(new Error('rate limited (429)')), true);
    assert.equal(isRetryableError(new Error('request req_4290 failed validation')), false);
  });

  it('preserves status and providerId on the error', () => {
    const err = new ProviderError('boom', { kind: 'server_error', status: 503, providerId: 'openai' });
    assert.equal(err.status, 503);
    assert.equal(err.providerId, 'openai');
    assert.equal(err.name, 'ProviderError');
    assert.ok(err instanceof Error);
  });
});
