import { readFile } from 'node:fs/promises';
import { requireThat } from './core.mjs';

// Pricing is configuration, not a constant: rates change and a stale rate must be
// visible in the ledger rather than silently wrong. Amounts are USD per 1M tokens.
export const defaultPricingPath = '/opt/buena-multilogin/private/frontier-pricing.json';
export const defaultModelId = 'accounts/fireworks/models/deepseek-v4p1-flash';

export const defaultPricing = {
  model: defaultModelId,
  currency: 'USD',
  unit: 'per_1m_tokens',
  uncachedInput: 0.22,
  cachedInput: 0.007,
  output: 0.66,
  effectiveFrom: '2026-09-22',
  source: 'Fireworks AI serverless pricing (operator-provided)',
};

// Order of precedence: explicit value, then the configured file, then the default.
export async function loadPricing({ path = null, model = null, fallback = defaultPricing,
  fs = null } = {}) {
  const io = fs || { readFile };
  let file = null;
  if (path) {
    try { file = JSON.parse(await io.readFile(path, 'utf8')); }
    catch { file = null; }
  }
  const merged = { ...fallback, ...(file && typeof file === 'object' ? file : {}) };
  if (model) merged.model = model;
  requireThat(Number.isFinite(merged.uncachedInput) && merged.uncachedInput >= 0, 'invalid_pricing_rate');
  requireThat(Number.isFinite(merged.cachedInput) && merged.cachedInput >= 0, 'invalid_pricing_rate');
  requireThat(Number.isFinite(merged.output) && merged.output >= 0, 'invalid_pricing_rate');
  requireThat(typeof merged.currency === 'string' && merged.currency.length > 0, 'invalid_pricing_currency');
  return { pricing: merged, pricingPath: path, pricingSource: file ? 'file' : 'default' };
}

// Map the provider's usage fields. When the provider reports nothing, the cost is
// null: it is never estimated from image size or text length.
export function mapUsage(usage = null) {
  if (!usage || typeof usage !== 'object') return { available: false, uncachedInputTokens: null,
    cachedInputTokens: null, outputTokens: null, totalTokens: null };
  const details = usage.prompt_tokens_details || usage.prompt_tokens_detail || usage.input_tokens_details || {};
  const input = Number.isSafeInteger(usage.prompt_tokens) ? usage.prompt_tokens
    : Number.isSafeInteger(usage.input_tokens) ? usage.input_tokens : null;
  const output = Number.isSafeInteger(usage.completion_tokens) ? usage.completion_tokens
    : Number.isSafeInteger(usage.output_tokens) ? usage.output_tokens : null;
  const cached = Number.isSafeInteger(details.cached_tokens) ? details.cached_tokens
    : Number.isSafeInteger(usage.cached_tokens) ? usage.cached_tokens : null;
  if (input === null && output === null) return { available: false, uncachedInputTokens: null,
    cachedInputTokens: null, outputTokens: null, totalTokens: null };
  const cachedTokens = cached === null ? 0 : Math.min(cached, input ?? cached);
  return { available: true, uncachedInputTokens: Math.max(0, (input ?? 0) - cachedTokens),
    cachedInputTokens: cachedTokens, outputTokens: output ?? 0,
    totalTokens: Number.isSafeInteger(usage.total_tokens) ? usage.total_tokens
      : (input ?? 0) + (output ?? 0) };
}

export function estimatedUsd({ uncachedInputTokens = 0, cachedInputTokens = 0, outputTokens = 0 } = {},
  pricing = defaultPricing) {
  const value = (uncachedInputTokens / 1e6) * pricing.uncachedInput
    + (cachedInputTokens / 1e6) * pricing.cachedInput
    + (outputTokens / 1e6) * pricing.output;
  // Six decimals keeps a per-call figure meaningful without pretending precision.
  return Math.round(value * 1e6) / 1e6;
}
