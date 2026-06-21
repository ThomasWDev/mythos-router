import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSessionMetrics } from '../src/commands/stats.js';
import type { SessionMetric } from '../src/metrics.js';

const base: Omit<SessionMetric, 'command'> = {
  project: 'proj',
  inputTokens: 0,
  outputTokens: 0,
  turns: 1,
  costUSD: 0,
  durationMs: 0,
  timestamp: new Date().toISOString(),
};

describe('aggregateSessionMetrics — SWD verification tally', () => {
  it('sums verified/failed/correction across sessions and computes the misreport rate', () => {
    const metrics: SessionMetric[] = [
      { ...base, command: 'chat', costUSD: 1, swd: { actionsVerified: 8, actionsFailed: 2, correctionTurns: 1 } },
      { ...base, command: 'run', costUSD: 1, swd: { actionsVerified: 10, actionsFailed: 0, correctionTurns: 0 } },
      { ...base, command: 'dream', costUSD: 1 }, // no swd field
    ];
    const agg = aggregateSessionMetrics(metrics);
    assert.equal(agg.swdVerified, 18);
    assert.equal(agg.swdFailed, 2);
    assert.equal(agg.swdCorrectionTurns, 1);
    assert.equal(agg.swdTotalActions, 20);
    assert.equal(Number(agg.swdFailRate.toFixed(2)), 10); // 2 / 20 = 10%
    assert.equal(agg.totalCost, 3);
    assert.deepEqual(agg.costByCommand, { chat: 1, run: 1, dream: 1 });
  });

  it('reports a zero misreport rate when no SWD actions were recorded', () => {
    const agg = aggregateSessionMetrics([{ ...base, command: 'dream', costUSD: 2 }]);
    assert.equal(agg.swdTotalActions, 0);
    assert.equal(agg.swdFailRate, 0);
    assert.equal(agg.totalCost, 2);
  });
});
