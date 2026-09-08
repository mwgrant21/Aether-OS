// Seven-day rate-limit percentage readings, oldest first. Extracted to its own
// pure module (no `electron` import) so it can be unit tested directly --
// main.ts itself cannot be imported by a test: it calls `app.whenReady()` at
// module scope, and the `electron` package resolves to a path string outside
// the real Electron runtime.
//
// In memory only, and deliberately: this is a live series whose whole value is
// being current. A persisted copy rehydrated after a restart would date from
// a window that has since reset, which is the same dishonesty
// persistence.ts's `statusline` exclusion already refuses.
//
// Retention is by AGE, not by count, because the consumer's window is an age:
// deriveQuotaEfficiency is called with a seven-day windowMs (main.ts), and a
// bucket whose percentage reading has been evicted falls to
// `outcome: 'no-quota-sample'` -- excluded from the fit while its tokens still
// count in observedTokens. A count cap silently narrowed the basis: the
// statusline writes roughly every render and the watcher polls every 10s
// (statuslineWatcher.ts's WATCH_INTERVAL_MS), so the previous cap of 4000
// readings held ~11 hours of active use, not the seven days the card and its
// tooltip both name. External usage under-reported for the same reason -- every
// evicted hour's percentage movement went unattributed.
export const QUOTA_SAMPLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// A pure memory backstop, no longer the retention rule. At one reading per 10s
// a full seven days is ~60k samples, so this bounds a pathological write rate
// (a statusline rewriting far faster than the watcher's poll interval) without
// ever being the thing that decides what the window contains. Sized with
// headroom over the ~60,480 readings a full seven days of 10s polling
// produces, so normal operation never reaches it -- the age prune below stays
// the binding constraint, and its own test asserts that ordering. A first
// draft used a round 60,000 and that test caught it: 60,000 is BELOW seven
// days of polling and would have re-narrowed the window by hours.
export const MAX_QUOTA_SAMPLES = 80000;

export interface QuotaSample {
  atMs: number;
  usedPercentage: number;
}

export interface QuotaSampleBuffer {
  samples: QuotaSample[];
  maxSamples: number;
  /** Retention window. A sample older than `newest - windowMs` is pruned. */
  windowMs: number;
}

export function createQuotaSampleBuffer(
  maxSamples: number = MAX_QUOTA_SAMPLES,
  windowMs: number = QUOTA_SAMPLE_WINDOW_MS,
): QuotaSampleBuffer {
  return { samples: [], maxSamples, windowMs };
}

/**
 * Records a reading, rejecting only a genuine duplicate re-emit -- the same
 * capture timestamp AND the same reading as the last accepted sample. This is
 * an EQUALITY check, not a high-water mark: `deriveQuotaEfficiency` sorts
 * bucket keys itself and takes each bucket's latest `atMs` via its own
 * `closing` map, so it does not depend on this buffer's array being in any
 * particular order, and an out-of-order sample (a backward clock step after
 * sleep/resume, or `statuslineWatcher`'s own mtime-vs-self-reported-timestamp
 * fallback regressing between two reads) is safe to accept.
 *
 * A prior version used `>=` here, intending to reject a stalled statusline
 * file re-emitting an unchanged payload. That made the buffer a monotonic
 * high-water mark instead: any backward timestamp movement poisoned it
 * permanently, silently rejecting every later sample until wall time caught
 * back up. Comparing only to the immediately preceding entry (not the whole
 * buffer) is enough, because the watcher emits sequentially -- a duplicate
 * re-emit always immediately follows the reading it repeats.
 *
 * Returns whether the sample was accepted, so a caller can make a rejection
 * observable instead of silent.
 */
export function recordQuotaSample(buffer: QuotaSampleBuffer, atMs: number, usedPercentage: number): boolean {
  const last = buffer.samples[buffer.samples.length - 1];
  if (last && last.atMs === atMs && last.usedPercentage === usedPercentage) return false;
  buffer.samples.push({ atMs, usedPercentage });
  // Age prune, relative to the sample just accepted: anything at the leading
  // edge that has fallen out of the retention window is no longer joinable to
  // a bucket deriveQuotaEfficiency will consider. Only the leading PREFIX is
  // scanned (amortized O(1)), not the whole array -- an out-of-order sample in
  // the middle is rare, harmless (deriveQuotaEfficiency applies its own
  // `inWindow` filter regardless), and not worth an O(n) sweep on every poll.
  const cutoff = atMs - buffer.windowMs;
  while (buffer.samples.length > 0 && buffer.samples[0].atMs < cutoff) buffer.samples.shift();
  if (buffer.samples.length > buffer.maxSamples) buffer.samples.shift();
  return true;
}
