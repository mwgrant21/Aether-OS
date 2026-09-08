import type { TranscriptEvent } from '../../electron/transcriptParser';

// ---------------------------------------------------------------------------
// Tokens per quota point -- an empirical fit, not a rate table
// ---------------------------------------------------------------------------
//
// Nothing published says how many tokens move a rate-limit percentage point.
// The only way to know is to watch: bucket this machine's token consumption
// and the account's reported percentage over the same intervals, and divide.
//
// That makes this correlation, not causation, and the type says so by carrying
// every bucket's outcome rather than only the fitted total. The two ways this
// can be wrong are both visible in the output:
//   - The account is shared with work this machine never saw (another machine,
//     another project). Those buckets are identified, excluded, and COUNTED --
//     see 'external-usage' below.
//   - The fit is too thin to mean anything. Below MIN_FIT_BUCKETS the rate is
//     withheld entirely (null) rather than published with a caveat, because a
//     caveat next to a number does not stop the number from being read.

export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

/** One hour. Short enough that a burst of work and the percentage move it
 *  caused land together; long enough that the statusline's ~10s poll
 *  (statuslineWatcher.ts's WATCH_INTERVAL_MS) reliably supplies at least one
 *  reading per bucket while the app is running. */
export const DEFAULT_BUCKET_MS = 60 * 60 * 1000;

/** Buckets carrying BOTH signals required before a rate is published.
 *  Three is the spec's resolved minimum: below it, show points only. */
export const MIN_FIT_BUCKETS = 3;

export interface QuotaSample {
  atMs: number;
  /** 0-100, from the statusline payload's seven_day window. */
  usedPercentage: number;
}

export interface TokenSample {
  atMs: number;
  tokens: number;
}

export type BucketOutcome =
  /** Both signals present and positive -- this bucket is in the fit. */
  | 'fitted'
  /** The account moved; this machine logged nothing. Excluded, and counted. */
  | 'external-usage'
  /** The percentage did not move. Says nothing about tokens per point. */
  | 'no-quota-movement'
  /** The first bucket in the series: a level with nothing to difference against. */
  | 'no-prior-sample'
  /** This machine logged tokens but the statusline was never polled in this
   *  bucket (e.g. the app was closed) -- the inverse of 'external-usage'.
   *  No quota reading means no delta to fit against; excluded from the fit,
   *  but its tokens still count in observedTokens. */
  | 'no-quota-sample';

export interface QuotaBucket {
  /** Bucket start, floored to bucketMs. */
  startMs: number;
  /** Percentage points consumed in this bucket. Never negative. */
  points: number;
  /** Tokens this machine logged in this bucket. */
  tokens: number;
  outcome: BucketOutcome;
}

export interface QuotaEfficiency {
  /** The cost basis, fixed by the spec. The five-hour window is a live
   *  depletion gauge and is deliberately never fitted here. */
  basis: 'seven_day';
  /** What `tokens` counts. Named on the value so a consumer pricing a
   *  dispatch can see it is comparing like with like -- see the note on
   *  tokenSamplesFromEvents. */
  tokenBasis: 'input-output-cachewrite';
  bucketMs: number;
  windowMs: number;
  computedAtMs: number;
  /** null until MIN_FIT_BUCKETS buckets carry both signals. */
  tokensPerPoint: number | null;
  fittedBuckets: number;
  externalUsageBuckets: number;
  fittedTokens: number;
  fittedPoints: number;
  /** Tokens across EVERY bucket in the window, fitted or not. This is what the
   *  window actually cost in tokens; fittedTokens is only the subset the rate
   *  was derived from. */
  observedTokens: number;
  buckets: QuotaBucket[];
}

/**
 * The token count a quota fit should use.
 *
 * Cache READS are excluded. They are the largest token category in a long
 * Claude Code session by an order of magnitude and are priced at a tenth of an
 * input token (modelPricing.ts's CACHE_READ_DISCOUNT); including them would
 * make tokens-per-point a measure of how much context gets re-read rather than
 * of how much work was done, and two sessions doing identical work would fit
 * wildly different rates purely from cache behaviour.
 *
 * Cache WRITES are included: they are billed above a fresh input token
 * (CACHE_WRITE_MULTIPLIER, 1.25x) and represent real new content.
 *
 * Stated plainly, because it bounds what the per-dispatch quota figure means:
 * the per-dispatch scalar this rate is later applied to comes from
 * `<subagent_tokens>`, whose own basis Claude Code does not document -- see the
 * DISPATCH_OUTPUT_SHARE comment in ledgerMath.ts, which reasons it behaves like
 * generated tokens. So a per-dispatch quota figure inherits that uncertainty on
 * top of this one. The window-level figure (observedTokens against the
 * statusline's own percentage) does not, and is the more trustworthy of the two.
 */
export function tokenSamplesFromEvents(events: TranscriptEvent[]): TokenSample[] {
  const samples: TokenSample[] = [];
  for (const e of events) {
    if (e.kind !== 'assistant' || !e.usage || !e.timestamp) continue;
    const atMs = e.timestamp.getTime();
    if (Number.isNaN(atMs)) continue;
    samples.push({
      atMs,
      tokens: e.usage.inputTokens + e.usage.outputTokens + e.usage.cacheCreationInputTokens,
    });
  }
  return samples;
}

export function deriveQuotaEfficiency(
  quotaSamples: QuotaSample[],
  tokenSamples: TokenSample[],
  opts: { nowMs: number; bucketMs?: number; windowMs?: number },
): QuotaEfficiency {
  const bucketMs = opts.bucketMs ?? DEFAULT_BUCKET_MS;
  const windowMs = opts.windowMs ?? SEVEN_DAY_MS;
  const since = opts.nowMs - windowMs;
  const bucketOf = (atMs: number) => Math.floor(atMs / bucketMs) * bucketMs;
  const inWindow = (atMs: number) => Number.isFinite(atMs) && atMs >= since && atMs <= opts.nowMs;

  // Each bucket's CLOSING reading. Closing rather than opening: the next
  // bucket's delta is measured against where this one ended, and using the
  // opening level would silently drop everything consumed inside the bucket.
  const closing = new Map<number, { atMs: number; usedPercentage: number }>();
  for (const s of quotaSamples) {
    if (!inWindow(s.atMs) || !Number.isFinite(s.usedPercentage)) continue;
    const key = bucketOf(s.atMs);
    const prev = closing.get(key);
    if (prev === undefined || s.atMs >= prev.atMs) {
      closing.set(key, { atMs: s.atMs, usedPercentage: s.usedPercentage });
    }
  }

  const tokensByBucket = new Map<number, number>();
  for (const t of tokenSamples) {
    if (!inWindow(t.atMs) || !Number.isFinite(t.tokens)) continue;
    const key = bucketOf(t.atMs);
    tokensByBucket.set(key, (tokensByBucket.get(key) ?? 0) + t.tokens);
  }

  const buckets: QuotaBucket[] = [];
  let previousPct: number | null = null;
  let fittedBuckets = 0;
  let externalUsageBuckets = 0;
  let fittedTokens = 0;
  let fittedPoints = 0;
  let observedTokens = 0;

  // The union of every bucket key with EITHER signal -- not just closing.keys().
  // Quota samples only exist while the app was actually polling the statusline
  // (i.e. running); token samples come from persistent transcript files and
  // keep accruing while the app is closed. A token-only bucket is the normal
  // case for that gap, not an edge case, and observedTokens is documented as
  // covering every bucket in the window -- iterating only closing.keys() would
  // silently drop those tokens from a figure Tasks 7/8 render as dollars.
  const allBucketKeys = new Set<number>([...closing.keys(), ...tokensByBucket.keys()]);

  for (const startMs of [...allBucketKeys].sort((a, b) => a - b)) {
    const closingEntry = closing.get(startMs);
    const tokens = tokensByBucket.get(startMs) ?? 0;
    observedTokens += tokens;

    if (closingEntry === undefined) {
      // No quota reading landed in this bucket at all: nothing to difference
      // against, and previousPct must NOT advance -- the next bucket that does
      // carry a reading should still diff against the last real level, not
      // this gap.
      buckets.push({ startMs, points: 0, tokens, outcome: 'no-quota-sample' });
      continue;
    }
    const pct = closingEntry.usedPercentage;

    if (previousPct === null) {
      buckets.push({ startMs, points: 0, tokens, outcome: 'no-prior-sample' });
      previousPct = pct;
      continue;
    }

    // A DROP means the window rolled over, so everything now showing was
    // consumed inside this bucket -- never a negative delta. A negative would
    // subtract real consumption from the fit and inflate tokensPerPoint.
    const points = pct < previousPct ? pct : pct - previousPct;
    previousPct = pct;

    if (points <= 0) {
      buckets.push({ startMs, points: 0, tokens, outcome: 'no-quota-movement' });
      continue;
    }

    if (tokens <= 0) {
      // The account moved and this machine logged nothing: another machine, or
      // another project on the same account. Fitting it would attribute
      // someone else's consumption to zero local tokens and drag the rate
      // toward zero, making every local figure look cheaper than it is.
      externalUsageBuckets += 1;
      buckets.push({ startMs, points, tokens: 0, outcome: 'external-usage' });
      continue;
    }

    fittedBuckets += 1;
    fittedTokens += tokens;
    fittedPoints += points;
    buckets.push({ startMs, points, tokens, outcome: 'fitted' });
  }

  return {
    basis: 'seven_day',
    tokenBasis: 'input-output-cachewrite',
    bucketMs,
    windowMs,
    computedAtMs: opts.nowMs,
    tokensPerPoint: fittedBuckets >= MIN_FIT_BUCKETS && fittedPoints > 0 ? fittedTokens / fittedPoints : null,
    fittedBuckets,
    externalUsageBuckets,
    fittedTokens,
    fittedPoints,
    observedTokens,
    buckets,
  };
}
