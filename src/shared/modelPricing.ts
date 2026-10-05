//
// Per-million-token USD pricing for the Claude tiers this viewer encounters in
// Claude Code transcripts. These are NOT placeholders. They were checked by the
// operator against Anthropic's published pricing on the date stamped below, and
// the Ledger's PricingBasisFooter renders that date so the table cannot age into
// being wrong without saying so.
//
// What the verification changed:
//   opus   $5 / $25   Opus 5, 4.8, 4.7 and 4.6 all share this rate. The
//                     pre-verification table carried $15 / $75 -- the retired
//                     Opus 3 rate -- and overstated every Opus dollar figure
//                     this app has ever rendered by 3x.
//   sonnet $3 / $15   The tier rate, still right for Sonnet 4.6. Sonnet 5 and
//                     5.5 are $2 / $10 (not an introductory rate, as this
//                     comment used to claim) -- see MODEL_RATE_OVERRIDES.
//   haiku  $1 / $5    Was $0.80 / $4, understating Haiku by ~20%.
//   fable  $10 / $50  New tier, covering the Fable and Mythos families. These
//                     previously fell through to the sonnet default and billed a
//                     $10 / $50 model at $3 / $15 -- a 3.3x undercount, silent.
//
// Deliberately no full model-ID literals below: noApiCalls.test.ts guards on
// /claude-[a-z]+-\d/, and naming tiers rather than IDs keeps this file out of
// that test's LITERAL_EXCEPTIONS set.
export const PRICING_VERIFIED_AT = '2026-10-04';

export const PRICING_PER_MILLION_TOKENS = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
  fable: { input: 10, output: 50 },
} as const;

// Cache reads are priced at 10% of the tier's input rate. Confirmed at the same
// verification as the table above -- this is the published multiplier, not the
// approximation the previous comment admitted to.
// Exported so the Ledger's PricingBasisFooter can render the actual multiplier
// in force rather than a hardcoded "10%" that could drift away from it.
export const CACHE_READ_DISCOUNT = 0.1;

// Cache WRITES cost more than a fresh input token, not the same: 1.25x the input
// rate for the 5-minute TTL and 2x for the 1-hour TTL. Claude Code writes
// 5-minute ephemeral entries, and a transcript records no TTL, so 1.25 is the
// only defensible constant here. A workload using 1-hour caching would be
// under-reported by this factor; that is a known limitation, not an oversight.
export const CACHE_WRITE_MULTIPLIER = 1.25;

export type PricingTier = keyof typeof PRICING_PER_MILLION_TOKENS;

// Models whose published price diverges from their tier's rate above, keyed by
// family-version with no "claude-" prefix (see the noApiCalls note at the top).
// Re-verified 2026-10-04 against the official per-model table:
//   sonnet-5, sonnet-5-5  $2 / $10 -- billed at the $3 / $15 sonnet tier before,
//                         50% high. Sonnet 5's rate is not introductory.
//   opus-5-5              $4 / $20, cache reads $0.20/M (0.05x input).
//   fable-5-1, mythos-5-1 cache reads $0.25/M (0.025x input), not $1.00.
// cacheRead is an absolute $/M, present only where it is not
// input * CACHE_READ_DISCOUNT. At a ~0.98 cache-hit ratio cache reads are most
// of a session's tokens, so those overrides carry the largest dollar correction.
// Ported from TokenMonitorV2's KNOWN_VERSIONS (same date, same figures).
export const MODEL_RATE_OVERRIDES: Record<string, { input?: number; output?: number; cacheRead?: number }> = {
  'sonnet-5': { input: 2, output: 10 },
  'sonnet-5-5': { input: 2, output: 10 },
  'opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'fable-5-1': { cacheRead: 0.25 },
  'mythos-5-1': { cacheRead: 0.25 },
};

// Strips the leading "claude-" prefix, a trailing "[1m]" long-context marker and
// a trailing "-YYYYMMDD" snapshot date, so a transcript's model name meets the
// MODEL_RATE_OVERRIDES keys (e.g. an opus 5.5 [1m] name -> "opus-5-5").
export function normalizeModelId(modelName: string | null): string {
  let id = (modelName || '').toLowerCase().trim();
  if (id.startsWith('claude-')) id = id.slice('claude-'.length);
  return id.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');
}

export interface ModelRate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Every $/M rate for one model: its tier rate, with any per-model override applied. */
export function rateForModel(modelName: string | null): ModelRate {
  const tier = PRICING_PER_MILLION_TOKENS[pricingTierForModel(modelName)];
  const o = MODEL_RATE_OVERRIDES[normalizeModelId(modelName)] ?? {};
  const input = o.input ?? tier.input;
  return {
    input,
    output: o.output ?? tier.output,
    cacheRead: o.cacheRead ?? input * CACHE_READ_DISCOUNT,
    cacheWrite: input * CACHE_WRITE_MULTIPLIER,
  };
}

export function pricingTierForModel(modelName: string | null): PricingTier {
  const lower = (modelName || '').toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('fable') || lower.includes('mythos')) return 'fable';
  return 'sonnet';
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface PricedEvent {
  model: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number } | null;
}

/**
 * The four-way USD split behind costForEvent.
 *
 * This exists so the Ledger's session card can show a breakdown that provably
 * sums to the total it displays. Deriving the split anywhere else would mean a
 * second copy of CACHE_WRITE_MULTIPLIER and CACHE_READ_DISCOUNT, which is
 * exactly the kind of duplicate arithmetic that drifts apart silently -- so
 * costForEvent is defined as the sum of this, rather than the two being
 * computed independently and trusted to agree.
 */
export function costBreakdownForEvent(event: PricedEvent): CostBreakdown {
  if (!event || !event.usage) return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  const rate = rateForModel(event.model);
  return {
    input: (event.usage.inputTokens / 1_000_000) * rate.input,
    output: (event.usage.outputTokens / 1_000_000) * rate.output,
    cacheCreation: (event.usage.cacheCreationInputTokens / 1_000_000) * rate.cacheWrite,
    cacheRead: (event.usage.cacheReadInputTokens / 1_000_000) * rate.cacheRead,
  };
}

export function costForEvent(event: PricedEvent): number {
  const b = costBreakdownForEvent(event);
  return b.input + b.output + b.cacheCreation + b.cacheRead;
}
