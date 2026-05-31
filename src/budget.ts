// ─────────────────────────────────────────────────────────────
//  mythos-router :: budget.ts
//  Session Budget Limiter — Financial safety switch
// ─────────────────────────────────────────────────────────────

import {
  DEFAULT_MAX_TOKENS_PER_SESSION,
  DEFAULT_MAX_TURNS,
  BUDGET_WARN_PERCENT,
  COST_PER_INPUT_TOKEN,
  COST_PER_OUTPUT_TOKEN,
} from './config.js';
import { calculateCost } from './providers/pricing.js';
import { c, progressBar, theme } from './utils.js';

// ── Types ────────────────────────────────────────────────────
export interface BudgetConfig {
  maxTokens: number;
  maxTurns: number;
  warnAtPercent: number;
  /** Cost per input token in USD (update when Anthropic changes pricing) */
  costPerInputToken: number;
  /** Cost per output token in USD (update when Anthropic changes pricing) */
  costPerOutputToken: number;
}

export interface BudgetCheck {
  ok: boolean;
  reason?: string;
  tokensPercent: number;
  turnsPercent: number;
  warning: boolean;
  /** True when budget is exhausted — signals the caller to perform a graceful save */
  exhausted: boolean;
}

export interface BudgetSnapshot {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  maxTokens: number;
  maxTurns: number;
  startedAt: number;
  elapsedMs: number;
  /** Estimated cost in USD based on configured token pricing */
  estimatedCostUSD: number;
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function percentOrDefault(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) {
    return fallback;
  }
  return value;
}

function nonNegativeFiniteOrDefault(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

function nonNegativeIntegerOrZero(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

// ── Session Budget Class ─────────────────────────────────────
export class SessionBudget {
  private config: BudgetConfig;
  private totalInput = 0;
  private totalOutput = 0;
  private turnCount = 0;
  private startedAt: number;
  private enabled: boolean;
  // Accurate per-call cost. Populated only when record() is given a model id,
  // so BYOK providers (OpenAI/DeepSeek) are billed at their real rates instead
  // of the Anthropic fixed-rate fallback. When no model id is ever supplied
  // (e.g. raw SDK usage), status() falls back to the fixed-rate estimate.
  private accumulatedModelCost = 0;
  private hasModelCost = false;

  constructor(config?: Partial<BudgetConfig>, enabled = true) {
    this.config = {
      maxTokens: positiveIntegerOrDefault(config?.maxTokens, DEFAULT_MAX_TOKENS_PER_SESSION),
      maxTurns: positiveIntegerOrDefault(config?.maxTurns, DEFAULT_MAX_TURNS),
      warnAtPercent: percentOrDefault(config?.warnAtPercent, BUDGET_WARN_PERCENT),
      costPerInputToken: nonNegativeFiniteOrDefault(config?.costPerInputToken, COST_PER_INPUT_TOKEN),
      costPerOutputToken: nonNegativeFiniteOrDefault(config?.costPerOutputToken, COST_PER_OUTPUT_TOKEN),
    };
    this.startedAt = Date.now();
    this.enabled = enabled;
  }

  // ── Record token usage after an API call ─────────────────
  record(inputTokens: number, outputTokens: number, modelId?: string): void {
    const input = nonNegativeIntegerOrZero(inputTokens);
    const output = nonNegativeIntegerOrZero(outputTokens);
    this.totalInput += input;
    this.totalOutput += output;
    if (modelId) {
      this.accumulatedModelCost += calculateCost(modelId, input, output);
      this.hasModelCost = true;
    }
    this.turnCount++;
  }

  // ── Restore state from a saved session ───────────────────
  restore(inputTokens: number, outputTokens: number, turns: number): void {
    this.totalInput = nonNegativeIntegerOrZero(inputTokens);
    this.totalOutput = nonNegativeIntegerOrZero(outputTokens);
    this.turnCount = nonNegativeIntegerOrZero(turns);
    // Seed the accurate-cost accumulator with a fixed-rate estimate of the
    // restored tokens so cost stays continuous if the resumed session then
    // records model-tagged turns. hasModelCost stays false until a real
    // model-tagged call arrives, preserving fixed-rate behavior otherwise.
    this.accumulatedModelCost =
      this.totalInput * this.config.costPerInputToken +
      this.totalOutput * this.config.costPerOutputToken;
  }

  // ── Check if budget is still ok ──────────────────────────
  check(): BudgetCheck {
    if (!this.enabled) {
      return { ok: true, tokensPercent: 0, turnsPercent: 0, warning: false, exhausted: false };
    }

    const totalTokens = this.totalInput + this.totalOutput;
    const tokensPercent = (totalTokens / this.config.maxTokens) * 100;
    const turnsPercent = (this.turnCount / this.config.maxTurns) * 100;
    const warning =
      tokensPercent >= this.config.warnAtPercent ||
      turnsPercent >= this.config.warnAtPercent;

    // Token limit exceeded
    if (totalTokens >= this.config.maxTokens) {
      return {
        ok: false,
        exhausted: true,
        reason:
          `Session budget exhausted: ${totalTokens.toLocaleString()}/${this.config.maxTokens.toLocaleString()} tokens ` +
          `used across ${this.turnCount} turns. ` +
          `Use --max-tokens <n> to increase or --no-budget to disable.`,
        tokensPercent: Math.min(tokensPercent, 100),
        turnsPercent,
        warning: true,
      };
    }

    // Turn limit exceeded
    if (this.turnCount >= this.config.maxTurns) {
      return {
        ok: false,
        exhausted: true,
        reason:
          `Session turn limit reached: ${this.turnCount}/${this.config.maxTurns} turns. ` +
          `Use --max-turns <n> to increase or --no-budget to disable.`,
        tokensPercent,
        turnsPercent: Math.min(turnsPercent, 100),
        warning: true,
      };
    }

    return { ok: true, tokensPercent, turnsPercent, warning, exhausted: false };
  }

  // ── Get current snapshot ─────────────────────────────────
  status(): BudgetSnapshot {
    const estimatedCostUSD = this.hasModelCost
      ? this.accumulatedModelCost
      : this.totalInput * this.config.costPerInputToken +
        this.totalOutput * this.config.costPerOutputToken;
    return {
      totalTokens: this.totalInput + this.totalOutput,
      inputTokens: this.totalInput,
      outputTokens: this.totalOutput,
      turns: this.turnCount,
      maxTokens: this.config.maxTokens,
      maxTurns: this.config.maxTurns,
      startedAt: this.startedAt,
      elapsedMs: Date.now() - this.startedAt,
      estimatedCostUSD,
    };
  }

  // ── Is budget enforcement enabled? ───────────────────────
  isEnabled(): boolean {
    return this.enabled;
  }

  // ── Format a visual budget bar for the terminal ──────────
  formatBar(width = 20): string {
    if (!this.enabled) {
      return `${theme.muted}Budget: ${theme.warning}disabled${theme.muted} (expert mode)${c.reset}`;
    }

    const snap = this.status();
    const tokPct = Math.min(
      (snap.totalTokens / snap.maxTokens) * 100,
      100
    );
    const turnPct = Math.min(
      (snap.turns / snap.maxTurns) * 100,
      100
    );

    const tokBar = progressBar(tokPct, width);
    const turnBar = progressBar(turnPct, Math.floor(width / 2));

    const tokColor = tokPct >= 90 ? theme.error : tokPct >= this.config.warnAtPercent ? theme.warning : theme.success;
    const turnColor = turnPct >= 90 ? theme.error : turnPct >= this.config.warnAtPercent ? theme.warning : theme.success;

    const elapsed = formatElapsed(snap.elapsedMs);

    return (
      `${theme.muted}Budget:${c.reset} ` +
      `${tokColor}${tokBar}${c.reset} ` +
      `${tokColor}${snap.totalTokens.toLocaleString()}${theme.muted}/${snap.maxTokens.toLocaleString()} tokens${c.reset} · ` +
      `${turnColor}${turnBar}${c.reset} ` +
      `${turnColor}${snap.turns}${theme.muted}/${snap.maxTurns} turns${c.reset} · ` +
      `${theme.muted}~$${snap.estimatedCostUSD.toFixed(4)} · ${elapsed}${c.reset}`
    );
  }

  // ── Format warning message if at threshold ───────────────
  formatWarning(): string | null {
    if (!this.enabled) return null;

    const { warning, ok, tokensPercent, turnsPercent } = this.check();

    if (!ok) {
      const snap = this.status();
      return (
        `${c.yellow}${c.bold}⏸ BUDGET REACHED — Graceful Save${c.reset}\n` +
        `${c.dim}  ${snap.totalTokens.toLocaleString()} tokens consumed across ${snap.turns} turns (~$${snap.estimatedCostUSD.toFixed(4)}).${c.reset}\n` +
        `${c.green}  Progress saved to MEMORY.md. Resume with ${c.cyan}mythos chat${c.green} to continue.${c.reset}\n` +
        `${c.dim}  Increase limits: ${c.cyan}mythos chat --max-tokens 1000000 --max-turns 50${c.reset}\n` +
        `${c.dim}  Disable limits:  ${c.cyan}mythos chat --no-budget${c.reset}`
      );
    }

    if (warning) {
      const higher = Math.max(tokensPercent, turnsPercent);
      const snap = this.status();
      return (
        `${c.yellow}⚠ Budget ${Math.round(higher)}% consumed${c.reset} — ` +
        `${c.dim}${snap.totalTokens.toLocaleString()} tokens · ${snap.turns} turns${c.reset}`
      );
    }

    return null;
  }

  // ── Graceful session summary for MEMORY.md ────────────────
  formatSessionSummary(): string {
    const snap = this.status();
    const elapsed = formatElapsed(snap.elapsedMs);
    return (
      `budget-save: ${snap.totalTokens.toLocaleString()} tokens · ` +
      `${snap.turns} turns · ~$${snap.estimatedCostUSD.toFixed(4)} · ${elapsed}`
    );
  }
}



// ── Elapsed Time Formatter ───────────────────────────────────
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}
