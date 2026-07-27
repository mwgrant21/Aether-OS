//
// Approximate per-million-token USD pricing. These are PLACEHOLDERS to make the
// spend/cost math concrete and testable end to end — verify against current
// published rates before trusting the dollar figures in production, same as the
// budget defaults in budgets.default.json.
export const PRICING_PER_MILLION_TOKENS = {
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 0.8, output: 4 },
} as const;

// Cache reads are priced far below a fresh input token; 10% of the tier's input
// rate is a reasonable approximation for v1.
const CACHE_READ_DISCOUNT = 0.1;

export function pricingTierForModel(modelName: string | null): 'opus' | 'sonnet' | 'haiku' {
  const lower = (modelName || '').toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('haiku')) return 'haiku';
  return 'sonnet';
}

export function costForEvent(event: {
  model: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number } | null;
}): number {
  if (!event || !event.usage) return 0;
  const tier = pricingTierForModel(event.model);
  const rates = PRICING_PER_MILLION_TOKENS[tier];
  const inputCost = ((event.usage.inputTokens + event.usage.cacheCreationInputTokens) / 1_000_000) * rates.input;
  const cacheReadCost = (event.usage.cacheReadInputTokens / 1_000_000) * rates.input * CACHE_READ_DISCOUNT;
  const outputCost = (event.usage.outputTokens / 1_000_000) * rates.output;
  return inputCost + cacheReadCost + outputCost;
}
