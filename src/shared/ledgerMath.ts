import type { TranscriptEvent } from '../../electron/transcriptParser';
import type { CompletedDispatchUsage } from '../state/liveAgentsMath';
import { computeCacheHitRate } from './cacheHitRate';
import {
  costForEvent,
  costBreakdownForEvent,
  pricingTierForModel,
  PRICING_PER_MILLION_TOKENS,
  type PricingTier,
} from './modelPricing';

// ---------------------------------------------------------------------------
// The two cost types
// ---------------------------------------------------------------------------

/**
 * A cost derived from a full input/output/cache token split. Exact to the
 * pricing table -- the only exact dollar figure in this stage.
 *
 * ExactCost and EstimatedCost deliberately share NO supertype and no field
 * names. That is the point: the compiler must reject a place that renders one
 * where the other belongs. A single `isEstimate: boolean` on one shared type
 * would compile fine at exactly the call site that matters and produce a
 * ledger that looks precise and is wrong.
 */
export interface ExactCost {
  usd: number;
  breakdown: { input: number; output: number; cacheCreation: number; cacheRead: number };
}

/**
 * A cost derived from a scalar token count with no split available. Always
 * approximate. `basis` is carried on the value itself so a renderer showing
 * this figure can name *why* it is approximate without the caller having to
 * remember to pass that context alongside.
 */
export interface EstimatedCost {
  usdApprox: number;
  basis: 'blended-tier-rate';
  tokens: number;
  /** The tier the blend was taken from. */
  tier: PricingTier;
  /**
   * Whether that tier came from a recorded model name or from the fallback.
   *
   * `RealAgentDispatch.model` is `input.model || null` (liveAgentsMath.ts), and
   * the Agent tool's `model` is an OPTIONAL override that is omitted on most
   * dispatches -- so `pricingTierForModel(null)` returning 'sonnet' silently
   * prices an Opus run at the sonnet blend, roughly a 40% undercount. That is
   * a bigger error than the blend ratio itself, and unlike the blend ratio it
   * was invisible. Carried on the value so a renderer can mark it.
   */
  tierSource: 'observed' | 'defaulted';
}

// ---------------------------------------------------------------------------
// The blend ratio -- this assumption is the estimate's entire error term
// ---------------------------------------------------------------------------

/**
 * Share of a dispatch's scalar token count assumed to be OUTPUT tokens; the
 * remainder is priced as input. Output costs 5x input at every tier, so this
 * one number dominates every per-dispatch figure the Ledger renders.
 *
 * Why 0.8 rather than something even:
 *
 * `CompletedDispatchUsage.tokens` comes from `<subagent_tokens>` in a
 * task-notification (parsed in src/state/liveAgentsMath.ts). Claude Code does
 * not document what that scalar counts, and this repo has no upstream
 * statement of it either -- so the ratio is inferred from magnitude rather
 * than from a spec, and that inference is stated here rather than buried:
 *
 *   An observed dispatch reported ~83,000 tokens across 24 tool uses. If the
 *   scalar were a TOTAL including cache reads, that would be ~3,500 tokens per
 *   turn for an agent whose system prompt alone exceeds that -- implausible.
 *   A total-with-cache figure for that much tool work would run to millions.
 *   So the scalar behaves like generated tokens, not context tokens, which
 *   puts the true mix far closer to all-output than to an even split.
 *
 * 0.8 keeps a fifth of the count priced as input rather than asserting a
 * purity the evidence does not quite support.
 *
 * Error direction, stated plainly: a dispatch that is MORE output-heavy than
 * this is UNDER-estimated, and a more input-heavy one is OVER-estimated. If
 * the scalar turns out to be output tokens exactly, every estimate here is
 * ~16% low at every tier, and the correct fix is to raise this constant to
 * 1.0 -- not to adjust anything downstream.
 */
export const DISPATCH_OUTPUT_SHARE = 0.8;

/** The blended per-million rate applied to a dispatch's scalar token count. */
export function blendedRateForTier(tier: PricingTier): number {
  const rates = PRICING_PER_MILLION_TOKENS[tier];
  return DISPATCH_OUTPUT_SHARE * rates.output + (1 - DISPATCH_OUTPUT_SHARE) * rates.input;
}

// ---------------------------------------------------------------------------
// Tier 1 -- exact
// ---------------------------------------------------------------------------

/**
 * Sums every assistant event's cost into one ExactCost with the four-way
 * breakdown preserved. `usd` is the sum of `breakdown` by construction.
 */
export function sessionLedger(events: TranscriptEvent[]): ExactCost {
  const breakdown = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  for (const e of events) {
    if (e.kind !== 'assistant' || !e.usage) continue;
    const b = costBreakdownForEvent(e);
    breakdown.input += b.input;
    breakdown.output += b.output;
    breakdown.cacheCreation += b.cacheCreation;
    breakdown.cacheRead += b.cacheRead;
  }
  return {
    usd: breakdown.input + breakdown.output + breakdown.cacheCreation + breakdown.cacheRead,
    breakdown,
  };
}

/** Distinct pricing tiers seen across a set of assistant events. */
export function tiersInSession(events: TranscriptEvent[]): PricingTier[] {
  const seen = new Set<PricingTier>();
  for (const e of events) {
    if (e.kind !== 'assistant' || !e.usage) continue;
    seen.add(pricingTierForModel(e.model));
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Tier 2 -- estimated
// ---------------------------------------------------------------------------

export function estimateDispatchCost(dispatch: CompletedDispatchUsage): EstimatedCost {
  const tokens = Number.isFinite(dispatch.tokens) && dispatch.tokens > 0 ? dispatch.tokens : 0;
  const tier = pricingTierForModel(dispatch.model);
  return {
    usdApprox: (tokens / 1_000_000) * blendedRateForTier(tier),
    basis: 'blended-tier-rate',
    tokens,
    tier,
    tierSource: dispatch.model ? 'observed' : 'defaulted',
  };
}

// ---------------------------------------------------------------------------
// Reconciliation -- the residual is rendered, never normalized
// ---------------------------------------------------------------------------

export interface Reconciliation {
  /** The exact session total. */
  sessionUsd: number;
  /** Sum of the per-dispatch estimates. Approximate. */
  attributedUsdApprox: number;
  /**
   * sessionUsd - attributedUsdApprox. NOT clamped and NOT absolute.
   *
   * Negative is a real, meaningful outcome: it means the dispatch estimates
   * claim more than the session actually cost, which is evidence the blend
   * ratio is too high. Clamping it to zero -- or reporting |residual| -- would
   * destroy exactly the signal that tells the operator the estimator is off.
   */
  residualUsd: number;
}

/**
 * Takes the exact side as a plain number rather than an ExactCost, because the
 * only defensible reconciliation compares a WINDOW to the dispatches in that
 * same window.
 *
 * The whole-branch review caught this: reconciling the all-transcripts total
 * against the handful of dispatches this app has tracked live produced a
 * residual that was always ~the entire total, which reads as "the estimator is
 * catastrophically broken" when the two sides simply measured different
 * things. Passing a day's figure and that day's dispatches makes the residual
 * mean what the spec intended.
 */
export function reconcile(exactUsd: number, estimates: EstimatedCost[]): Reconciliation {
  const attributedUsdApprox = estimates.reduce((sum, e) => sum + e.usdApprox, 0);
  return {
    sessionUsd: exactUsd,
    attributedUsdApprox,
    residualUsd: exactUsd - attributedUsdApprox,
  };
}

// ---------------------------------------------------------------------------
// Rollups -- null and 0 are different answers
// ---------------------------------------------------------------------------

/**
 * Every bucket is `number | null`. `null` means no priced event fell in the
 * period at all (the collector wasn't running, the machine was off); `0` means
 * events were observed and they cost nothing. Rendering the first as the
 * second is the single most misleading thing this view could do, so the type
 * forces every renderer to handle them separately.
 */
export interface RollupBuckets {
  today: number | null;
  week: number | null;
  month: number | null;
}

/**
 * Bucket assistant-event cost into today / week / month.
 *
 * `timeZone` (an IANA name) and `nowMs` are both taken explicitly rather than
 * read from the environment, so these are pure and the tests are deterministic
 * regardless of the machine's clock or locale.
 *
 * Period definitions, stated because "week" in particular is ambiguous:
 *   today -- the calendar day containing nowMs, in timeZone.
 *   week  -- a ROLLING 7-day window ending today (inclusive). Calendar weeks
 *            would require picking a week-start convention, which is
 *            locale-dependent and would silently differ between machines.
 *   month -- the calendar month containing nowMs, in timeZone. Calendar rather
 *            than rolling, because billing periods are calendar months and
 *            that is the comparison an operator actually wants to make.
 */
export function bucketByDay(events: TranscriptEvent[], timeZone: string, nowMs: number): RollupBuckets {
  const now = new Date(nowMs);
  const todayKey = localDayKey(now, timeZone);
  const monthKey = todayKey.slice(0, 7);

  // Rolling 7-day window: today plus the six preceding calendar days.
  const weekKeys = new Set(recentDayKeys(todayKey, 7));

  // null until something lands in the bucket, so an untouched period stays
  // distinguishable from one that genuinely totalled zero.
  let today: number | null = null;
  let week: number | null = null;
  let month: number | null = null;

  for (const e of events) {
    if (e.kind !== 'assistant' || !e.usage || !e.timestamp) continue;
    const t = e.timestamp.getTime();
    if (Number.isNaN(t)) continue;

    const key = localDayKey(e.timestamp, timeZone);
    const cost = costForEvent(e);

    if (key === todayKey) today = (today ?? 0) + cost;
    if (weekKeys.has(key)) week = (week ?? 0) + cost;
    if (key.slice(0, 7) === monthKey) month = (month ?? 0) + cost;
  }

  return { today, week, month };
}

// ---------------------------------------------------------------------------
// The snapshot shipped to the renderer
// ---------------------------------------------------------------------------

/**
 * Everything the Ledger needs that the renderer cannot compute for itself.
 *
 * The renderer has never received raw TranscriptEvents and must not start:
 * docs/privacy-and-data.md's "store the signal, not the payload" rule keeps
 * transcript content out of the store, and per-event usage would drag the
 * whole event across the IPC boundary. So the aggregation happens in main --
 * on the TranscriptEvent[] main already scans each tick for Optimize -- and
 * only derived numbers cross.
 *
 * Deliberately NOT included: per-dispatch estimates. The renderer can already
 * build those from state it holds (recentCompletedDispatches joined with
 * dispatchUsage) and calling estimateDispatchCost there keeps the estimate
 * next to the row that renders it.
 */
export interface LedgerSnapshot {
  /**
   * The total across every transcript the scan covered -- ALL projects and ALL
   * history, because that is what electron/historyScanner.ts's scanAllProjects
   * returns (it walks every .jsonl under the projects root with no time
   * bound). Named `total` rather than `session` after the whole-branch review
   * found the view labelling it "SESSION COST", which would have read a year
   * of accumulated spend as the current session's.
   */
  total: ExactCost;
  tiers: PricingTier[];
  rollups: RollupBuckets;
  cache: CacheImpact;
  /**
   * Computed over the same events as `cache`, so the impact card's saving and
   * its hit rate cannot come from different datasets. state.cacheHitRatio is
   * the live session's ring-buffer ratio and is deliberately NOT used here.
   */
  cacheHitRate: number;
  /**
   * The zone main bucketed with. Carried so the renderer scopes "today" the
   * same way rather than resolving the zone a second time and risking a
   * disagreement about which day it is.
   */
  timeZone: string;
  /** When main computed this, so both sides agree on "now". */
  computedAtMs: number;
}

export function buildLedgerSnapshot(
  events: TranscriptEvent[],
  timeZone: string,
  nowMs: number,
): LedgerSnapshot {
  return {
    total: sessionLedger(events),
    tiers: tiersInSession(events),
    rollups: bucketByDay(events, timeZone, nowMs),
    cache: cacheImpact(events),
    cacheHitRate: computeCacheHitRate(events),
    timeZone,
    computedAtMs: nowMs,
  };
}

/**
 * True when `iso` falls on the same local day as `nowMs` in `timeZone`.
 * Exported so the view can scope dispatches to the same day the rollup used.
 */
export function isSameLocalDay(iso: string, timeZone: string, nowMs: number): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return localDayKey(d, timeZone) === localDayKey(new Date(nowMs), timeZone);
}

/**
 * The [startMs, endMs] instants (inclusive) covering the local calendar day
 * containing `nowMs` in `timeZone`.
 *
 * Exported so the view can test interval OVERLAP against today rather than
 * "does either endpoint land on today" -- a dispatch that starts before local
 * midnight and doesn't end until after the FOLLOWING local midnight has
 * neither endpoint on today, but its interval still fully contains today and
 * must not be excluded from the reconciliation.
 *
 * No IANA-aware date library is available here, so the boundary is found by
 * bisection rather than computed algebraically: search around `nowMs` for the
 * ms instants where `localDayKey` flips away from today's key. This is exact
 * to within the 1000ms bisection tolerance, which is far finer than anything
 * a dispatch span needs.
 */
export function localDayBoundsMs(timeZone: string, nowMs: number): { startMs: number; endMs: number } {
  const todayKey = localDayKey(new Date(nowMs), timeZone);
  const dayMs = 24 * 60 * 60 * 1000;

  // startMs: the earliest instant, searching back up to 2 days, still keyed
  // today. lo stays keyed before today, hi stays keyed today.
  let lo = nowMs - 2 * dayMs;
  let hi = nowMs;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDayKey(new Date(mid), timeZone) === todayKey) hi = mid;
    else lo = mid;
  }
  const startMs = hi;

  // endMs: the latest instant, searching forward up to 2 days, still keyed
  // today. lo stays keyed today, hi stays keyed after today.
  let lo2 = nowMs;
  let hi2 = nowMs + 2 * dayMs;
  while (hi2 - lo2 > 1000) {
    const mid = Math.floor((lo2 + hi2) / 2);
    if (localDayKey(new Date(mid), timeZone) === todayKey) lo2 = mid;
    else hi2 = mid;
  }
  const endMs = lo2;

  return { startMs, endMs };
}

// Intl.DateTimeFormat construction is among the most expensive calls in the
// Intl surface, and localDayKey runs once per assistant event. main.ts feeds
// bucketByDay every transcript event on the machine, on the main thread, every
// scan tick -- constructing a formatter per event stalls IPC to the renderer
// on a machine with a long history. One formatter per zone, reused.
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    // 'en-CA' formats as YYYY-MM-DD, which sorts and slices correctly.
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** `YYYY-MM-DD` for a Date as observed in the given IANA time zone. */
function localDayKey(date: Date, timeZone: string): string {
  return dayFormatter(timeZone).format(date);
}

/**
 * The `count` calendar day keys ending at `todayKey`, walking the CALENDAR
 * rather than subtracting fixed 24h offsets.
 *
 * Subtracting 86_400_000ms repeatedly is not a local day across a DST
 * transition: in America/New_York from 2026-03-10, it skips 2026-03-08
 * entirely, so every dollar spent on the transition day silently vanishes from
 * the week bucket. Fall-back produces the mirror bug -- a duplicate key
 * collapses and the window covers six days. Date.UTC arithmetic on a date-only
 * value has no such edge, because no zone is involved.
 */
function recentDayKeys(todayKey: string, count: number): string[] {
  const [y, m, d] = todayKey.split('-').map(Number);
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const dt = new Date(Date.UTC(y, m - 1, d - i));
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    keys.push(`${dt.getUTCFullYear()}-${mm}-${dd}`);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Cache impact -- the counterfactual
// ---------------------------------------------------------------------------

export interface CacheImpact {
  /** Total cache-read tokens observed. */
  cacheReadTokens: number;
  /** What those tokens would have cost at the full input rate for their tier. */
  wouldHaveCostUsd: number;
  /** What they actually cost at the discounted cache-read rate. */
  actuallyCostUsd: number;
  /** wouldHaveCostUsd - actuallyCostUsd. The Ledger's most actionable number. */
  savedUsd: number;
}

/**
 * The counterfactual: what the cache reads would have cost had every one of
 * them been a fresh input token, minus what they did cost.
 *
 * Priced per tier rather than at a single blended rate, because a session that
 * mixes tiers reads cache at different prices and averaging them would quietly
 * misreport the saving.
 */
export function cacheImpact(events: TranscriptEvent[]): CacheImpact {
  let cacheReadTokens = 0;
  let wouldHaveCostUsd = 0;
  let actuallyCostUsd = 0;

  for (const e of events) {
    if (e.kind !== 'assistant' || !e.usage) continue;
    const tokens = e.usage.cacheReadInputTokens;
    if (!tokens) continue;
    const rates = PRICING_PER_MILLION_TOKENS[pricingTierForModel(e.model)];
    cacheReadTokens += tokens;
    wouldHaveCostUsd += (tokens / 1_000_000) * rates.input;
    // Taken from the shared breakdown rather than re-applying the discount, so
    // this can never disagree with what the session card charges for cache.
    actuallyCostUsd += costBreakdownForEvent(e).cacheRead;
  }

  return {
    cacheReadTokens,
    wouldHaveCostUsd,
    actuallyCostUsd,
    savedUsd: wouldHaveCostUsd - actuallyCostUsd,
  };
}
