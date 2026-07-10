import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost, estimateCost } from '../src/providers/pricing.js';

const originalMultiplier = process.env.MYTHOS_PRICE_MULTIPLIER_OPENAI;

afterEach(() => {
  if (originalMultiplier === undefined) {
    delete process.env.MYTHOS_PRICE_MULTIPLIER_OPENAI;
  } else {
    process.env.MYTHOS_PRICE_MULTIPLIER_OPENAI = originalMultiplier;
  }
});

describe('provider pricing estimates', () => {
  it('keeps blended cost per 1k independent of request size for the same token mix', () => {
    const small = estimateCost('gpt-4o', 1_000, 0, 'openai');
    const large = estimateCost('gpt-4o', 100_000, 0, 'openai');

    assert.equal(small.costPer1k, 0.0025);
    assert.equal(large.costPer1k, small.costPer1k);
    assert.equal(large.totalCost, small.totalCost * 100);
  });

  it('returns an auditable input/output cost breakdown', () => {
    const cost = estimateCost('gpt-4o', 2_000, 1_000, 'openai');

    assert.equal(cost.inputCost, 0.005);
    assert.equal(cost.outputCost, 0.01);
    assert.equal(cost.totalCost, 0.015);
    assert.equal(cost.totalTokens, 3_000);
    assert.ok(Math.abs(cost.costPer1k - 0.005) < 1e-12);
    assert.equal(calculateCost('gpt-4o', 2_000, 1_000, 'openai'), cost.totalCost);
  });

  it('applies provider multipliers to both total and normalized costs', () => {
    process.env.MYTHOS_PRICE_MULTIPLIER_OPENAI = '0.5';
    const cost = estimateCost('gpt-4o', 1_000, 0, 'openai');

    assert.equal(cost.totalCost, 0.00125);
    assert.equal(cost.costPer1k, 0.00125);
  });

  it('sanitizes negative and non-finite token counts', () => {
    assert.deepEqual(estimateCost('gpt-4o', -10, Number.NaN, 'openai'), {
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
      totalTokens: 0,
      costPer1k: 0,
    });
  });
});
