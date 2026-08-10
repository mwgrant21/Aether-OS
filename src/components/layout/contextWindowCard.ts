import type { StatuslineSnapshot } from '../../shared/statuslinePayload';
import { STATUSLINE_STALE_AFTER_MS } from '../../shared/depletion';

export interface ContextWindowCard {
  available: boolean;
  pct: number | null;
  ringPct: number;
  usedTokens: number | null;
  windowSize: number | null;
  /** The statusline feed has not been written recently -- the reading is old, not current. */
  stale: boolean;
  parts: { label: string; value: number }[];
}

const UNAVAILABLE: ContextWindowCard = {
  available: false,
  pct: null,
  ringPct: 0,
  usedTokens: null,
  windowSize: null,
  stale: false,
  parts: [],
};

/**
 * Derives the footer's CONTEXT WINDOW card from the real Claude Code
 * statusline payload -- the same source ReactorStatusCard's CONTEXT tile
 * already uses.
 *
 * Three rules this encodes, each fixing a defect from issue #20:
 *
 * 1. The window size comes from the payload, never a hardcoded constant. The
 *    card previously divided by 125000 while the machine's real window was
 *    200000, so the percentage was wrong on its face.
 * 2. Used tokens are input + cache-creation + cache-read, matching
 *    contextUsedPercentage's own input-only definition. Output tokens are not
 *    resident context; summing them against the same denominator produced the
 *    663% reading.
 * 3. Every part traces to a real payload field. The card previously rendered
 *    Input as `ctxUsed * 0.58` and Output as `ctxUsed * 0.42` -- invented
 *    numbers shown as measured.
 *
 * `pct` stays truthful even above 100 so a future data defect stays visible;
 * only `ringPct` is clamped, because a ring cannot render more than full.
 */
export function deriveContextWindowCard(
  snap: StatuslineSnapshot | null,
  nowMs: number = Date.now(),
): ContextWindowCard {
  if (!snap) return UNAVAILABLE;

  const pct = snap.contextUsedPercentage;
  const usage = snap.contextUsage;
  // Both are null before the first API call and right after a /compact.
  // "No reading yet" is not "0% full" -- report it as unavailable.
  if (pct === null || usage === null) return UNAVAILABLE;

  const parts = [
    { label: 'Input', value: usage.inputTokens },
    { label: 'Cache write', value: usage.cacheCreationInputTokens },
    { label: 'Cache read', value: usage.cacheReadInputTokens },
  ];

  return {
    available: true,
    pct,
    ringPct: Math.max(0, Math.min(100, pct)),
    usedTokens: parts.reduce((n, p) => n + p.value, 0),
    windowSize: snap.contextWindowSize,
    stale: nowMs - snap.capturedAtMs > STATUSLINE_STALE_AFTER_MS,
    parts,
  };
}
