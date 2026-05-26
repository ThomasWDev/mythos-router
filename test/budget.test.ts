import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionBudget } from '../src/budget.js';

describe('SessionBudget', () => {

  it('initializes with default values', () => {
    const budget = new SessionBudget();
    const snap = budget.status();
    assert.equal(snap.totalTokens, 0);
    assert.equal(snap.turns, 0);
    assert.equal(snap.maxTokens, 500_000);
    assert.equal(snap.maxTurns, 25);
    assert.equal(snap.estimatedCostUSD, 0);
  });

  it('accepts custom configuration', () => {
    const budget = new SessionBudget({ maxTokens: 100_000, maxTurns: 10 });
    const snap = budget.status();
    assert.equal(snap.maxTokens, 100_000);
    assert.equal(snap.maxTurns, 10);
  });

  it('falls back to defaults for invalid budget limits', () => {
    const budget = new SessionBudget({
      maxTokens: 0,
      maxTurns: -5,
      warnAtPercent: Number.NaN,
    });
    const snap = budget.status();
    const check = budget.check();

    assert.equal(snap.maxTokens, 500_000);
    assert.equal(snap.maxTurns, 25);
    assert.equal(Number.isFinite(check.tokensPercent), true);
    assert.equal(Number.isFinite(check.turnsPercent), true);
  });

  it('sanitizes non-finite and negative restored usage', () => {
    const budget = new SessionBudget();

    budget.restore(Number.NaN, -100, Number.POSITIVE_INFINITY);
    let snap = budget.status();
    assert.equal(snap.inputTokens, 0);
    assert.equal(snap.outputTokens, 0);
    assert.equal(snap.turns, 0);

    budget.record(Number.NaN, -50);
    snap = budget.status();
    assert.equal(snap.inputTokens, 0);
    assert.equal(snap.outputTokens, 0);
    assert.equal(snap.turns, 1);
  });


  it('records token usage correctly', () => {
    const budget = new SessionBudget();
    budget.record(1000, 500);
    const snap = budget.status();
    assert.equal(snap.inputTokens, 1000);
    assert.equal(snap.outputTokens, 500);
    assert.equal(snap.totalTokens, 1500);
    assert.equal(snap.turns, 1);
  });

  it('accumulates across multiple records', () => {
    const budget = new SessionBudget();
    budget.record(1000, 500);
    budget.record(2000, 1000);
    budget.record(500, 200);
    const snap = budget.status();
    assert.equal(snap.inputTokens, 3500);
    assert.equal(snap.outputTokens, 1700);
    assert.equal(snap.totalTokens, 5200);
    assert.equal(snap.turns, 3);
  });


  it('returns ok=true when under budget', () => {
    const budget = new SessionBudget({ maxTokens: 10_000, maxTurns: 5 });
    budget.record(1000, 500);
    const check = budget.check();
    assert.equal(check.ok, true);
    assert.equal(check.exhausted, false);
    assert.equal(check.warning, false);
  });

  it('triggers warning at 80% token consumption', () => {
    const budget = new SessionBudget({ maxTokens: 10_000, maxTurns: 25 });
    budget.record(7000, 1500);
    const check = budget.check();
    assert.equal(check.ok, true);
    assert.equal(check.warning, true);
    assert.equal(check.exhausted, false);
  });

  it('triggers warning at 80% turn consumption', () => {
    const budget = new SessionBudget({ maxTokens: 500_000, maxTurns: 10 });
    for (let i = 0; i < 9; i++) {
      budget.record(100, 50);
    }
    const check = budget.check();
    assert.equal(check.ok, true);
    assert.equal(check.warning, true);
  });

  it('returns exhausted when token limit exceeded', () => {
    const budget = new SessionBudget({ maxTokens: 1000, maxTurns: 25 });
    budget.record(800, 300);
    const check = budget.check();
    assert.equal(check.ok, false);
    assert.equal(check.exhausted, true);
    assert.ok(check.reason?.includes('exhausted'));
  });

  it('returns exhausted when turn limit exceeded', () => {
    const budget = new SessionBudget({ maxTokens: 500_000, maxTurns: 2 });
    budget.record(100, 50);
    budget.record(100, 50);
    const check = budget.check();
    assert.equal(check.ok, false);
    assert.equal(check.exhausted, true);
    assert.ok(check.reason?.includes('turn limit'));
  });


  it('always returns ok=true when disabled', () => {
    const budget = new SessionBudget({ maxTokens: 100, maxTurns: 1 }, false);
    budget.record(99999, 99999); // Way over limits
    budget.record(99999, 99999);
    const check = budget.check();
    assert.equal(check.ok, true);
    assert.equal(check.exhausted, false);
  });

  it('reports enabled state correctly', () => {
    const enabled = new SessionBudget({}, true);
    const disabled = new SessionBudget({}, false);
    assert.equal(enabled.isEnabled(), true);
    assert.equal(disabled.isEnabled(), false);
  });


  it('calculates estimated cost based on token pricing', () => {
    const budget = new SessionBudget({
      costPerInputToken: 15 / 1_000_000,
      costPerOutputToken: 75 / 1_000_000,
    });
    budget.record(1_000_000, 100_000);
    const snap = budget.status();
    assert.ok(Math.abs(snap.estimatedCostUSD - 22.5) < 0.001);
  });


  it('formatBar returns a string with budget info', () => {
    const budget = new SessionBudget({ maxTokens: 10_000, maxTurns: 10 });
    budget.record(5000, 500);
    const bar = budget.formatBar();
    assert.ok(typeof bar === 'string');
    assert.ok(bar.includes('tokens'));
    assert.ok(bar.includes('turns'));
  });

  it('formatBar shows disabled message when budget is off', () => {
    const budget = new SessionBudget({}, false);
    const bar = budget.formatBar();
    assert.ok(bar.includes('disabled'));
  });

  it('formatSessionSummary includes token count and cost', () => {
    const budget = new SessionBudget();
    budget.record(10000, 5000);
    const summary = budget.formatSessionSummary();
    assert.ok(summary.includes('15,000'));
    assert.ok(summary.includes('1 turns'));
    assert.ok(summary.includes('$'));
  });

  it('formatWarning returns null when not at threshold', () => {
    const budget = new SessionBudget({ maxTokens: 100_000, maxTurns: 25 });
    budget.record(100, 50);
    const warning = budget.formatWarning();
    assert.equal(warning, null);
  });

  it('formatWarning returns a string at threshold', () => {
    const budget = new SessionBudget({ maxTokens: 10_000, maxTurns: 25 });
    budget.record(7000, 2000); // 90%
    const warning = budget.formatWarning();
    assert.ok(warning !== null);
    assert.ok(warning!.includes('consumed'));
  });

  it('formatWarning returns graceful save message when exhausted', () => {
    const budget = new SessionBudget({ maxTokens: 1000, maxTurns: 25 });
    budget.record(800, 300); // 110%
    const warning = budget.formatWarning();
    assert.ok(warning !== null);
    assert.ok(warning!.includes('BUDGET REACHED'));
  });


  it('tracks elapsed time', () => {
    const budget = new SessionBudget();
    const snap = budget.status();
    assert.ok(snap.elapsedMs >= 0);
    assert.ok(snap.startedAt > 0);
  });
});
