// ─────────────────────────────────────────────────────────────
//  mythos-router :: providers/pricing.ts
//  Internal Pricing Registry — provider-agnostic cost engine
//
//  Why: Different APIs report tokens differently (or not at all).
//  This registry decouples financial metrics from provider quirks.
// ─────────────────────────────────────────────────────────────

// ── Per-Model Pricing (USD per token) ────────────────────────
// Source: https://docs.anthropic.com/en/docs/about-claude/pricing
// Source: https://openai.com/api/pricing
// Source: https://api-docs.deepseek.com/pricing
//
// Update these when providers change rates.
interface ModelPricing {
  inputPer1M: number;   // USD per 1M input tokens
  outputPer1M: number;  // USD per 1M output tokens
}

const PRICING_TABLE: Record<string, ModelPricing> = {
  // ── Anthropic ────────────────────────────────────────────
  'claude-opus-4-8':      { inputPer1M: 5.00,   outputPer1M: 25.00 },
  'claude-opus-4-7':      { inputPer1M: 5.00,   outputPer1M: 25.00 },
  'claude-opus-4-6':      { inputPer1M: 5.00,   outputPer1M: 25.00 },
  'claude-sonnet-4-6':    { inputPer1M: 3.00,   outputPer1M: 15.00 },
  'claude-sonnet-3-5':    { inputPer1M: 3.00,   outputPer1M: 15.00 },
  'claude-haiku-4-5-20251001': { inputPer1M: 1.00,   outputPer1M: 5.00 },
  'claude-haiku-3':       { inputPer1M: 0.25,   outputPer1M: 1.25 },

  // ── OpenAI ───────────────────────────────────────────────
  'gpt-4o':               { inputPer1M: 2.50,   outputPer1M: 10.00 },
  'gpt-4o-mini':          { inputPer1M: 0.15,   outputPer1M: 0.60 },
  'o1':                   { inputPer1M: 15.00,  outputPer1M: 60.00 },
  'o3':                   { inputPer1M: 10.00,  outputPer1M: 40.00 },
  'o3-mini':              { inputPer1M: 1.10,   outputPer1M: 4.40 },

  // ── DeepSeek ─────────────────────────────────────────────
  'deepseek-chat':        { inputPer1M: 0.27,   outputPer1M: 1.10 },
  'deepseek-reasoner':    { inputPer1M: 0.55,   outputPer1M: 2.19 },
};

// Fallback pricing for unknown models (conservative estimate)
const FALLBACK_PRICING: ModelPricing = { inputPer1M: 5.00, outputPer1M: 20.00 };

// ── Per-Provider Price Adjustment ────────────────────────────
// The PRICING_TABLE above is the published *base* (list) price for each model.
// The same model can cost a different amount depending on WHICH provider serves
// it — e.g. an inference marketplace like Surplus resells the same model at a
// discount. A multiplier scales the base price for a given provider id:
//
//     1.0  = base/list price (default — behaviour is unchanged for everyone)
//     0.7  = 30% cheaper than base
//     1.2  = 20% more expensive than base
//
// IMPORTANT: this engine only changes the cost the router *estimates* (used for
// ranking providers and for the budget/telemetry numbers it displays). It never
// changes what you are actually billed — that always follows whichever provider
// key served the request.
//
// Defaults are deliberately 1.0 (no assumed discount) so we never invent
// numbers. Set the real rate you get via an env var so routing + budget reflect
// reality, e.g.:
//
//     MYTHOS_PRICE_MULTIPLIER_SURPLUS=0.7     # Surplus is 30% cheaper for you
//     MYTHOS_PRICE_MULTIPLIER_DEEPSEEK=1.0
//
// (Env var name = MYTHOS_PRICE_MULTIPLIER_<PROVIDER_ID_UPPERCASE>.)
const PROVIDER_PRICE_MULTIPLIER: Record<string, number> = {
  // surplus: 0.7,  // uncomment / set via env to your real Surplus discount
};

/**
 * Resolve the price multiplier for a provider. Env vars take precedence over
 * the built-in defaults; anything missing or invalid falls back to 1.0 (base
 * price), so an unknown or unconfigured provider behaves exactly as before.
 */
export function getProviderMultiplier(providerId?: string): number {
  if (!providerId) return 1;
  const envKey = `MYTHOS_PRICE_MULTIPLIER_${providerId.toUpperCase()}`;
  const envVal = process.env[envKey];
  if (envVal !== undefined && envVal !== '') {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const preset = PROVIDER_PRICE_MULTIPLIER[providerId];
  return Number.isFinite(preset) && preset > 0 ? preset : 1;
}

// ── Public API ───────────────────────────────────────────────

export interface CostEstimate {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  totalTokens: number;
  costPer1k: number;
}

function normalizeTokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Return both the estimated request total and a request-size-neutral blended
 * cost per 1,000 processed tokens. The blended rate still reflects the actual
 * input/output mix, but it no longer grows merely because a request was large.
 */
export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  providerId?: string,
): CostEstimate {
  const pricing = PRICING_TABLE[modelId] ?? FALLBACK_PRICING;
  const multiplier = getProviderMultiplier(providerId);
  const normalizedInput = normalizeTokenCount(inputTokens);
  const normalizedOutput = normalizeTokenCount(outputTokens);
  const inputCost = (normalizedInput / 1_000_000) * pricing.inputPer1M * multiplier;
  const outputCost = (normalizedOutput / 1_000_000) * pricing.outputPer1M * multiplier;
  const totalCost = inputCost + outputCost;
  const totalTokens = normalizedInput + normalizedOutput;

  return {
    inputCost,
    outputCost,
    totalCost,
    totalTokens,
    costPer1k: totalTokens > 0 ? (totalCost / totalTokens) * 1_000 : 0,
  };
}

/**
 * Calculate the estimated total cost of a request. Kept as the compact,
 * backwards-compatible API; use `estimateCost` when normalized routing cost is
 * also required.
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  providerId?: string,
): number {
  return estimateCost(modelId, inputTokens, outputTokens, providerId).totalCost;
}

/**
 * Get the per-token costs for a specific model.
 * Falls back to conservative estimates when the model is not in the registry.
 */
export function getModelPricing(modelId: string): { inputPerToken: number; outputPerToken: number } {
  const pricing = PRICING_TABLE[modelId] ?? FALLBACK_PRICING;
  return {
    inputPerToken: pricing.inputPer1M / 1_000_000,
    outputPerToken: pricing.outputPer1M / 1_000_000,
  };
}

/**
 * Check if a model has known pricing.
 */
export function hasKnownPricing(modelId: string): boolean {
  return modelId in PRICING_TABLE;
}

/**
 * Get all known model IDs for a given provider prefix.
 */
export function getModelsForProvider(providerPrefix: string): string[] {
  return Object.keys(PRICING_TABLE).filter(id => id.startsWith(providerPrefix));
}
