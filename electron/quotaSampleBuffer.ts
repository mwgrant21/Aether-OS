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

// Tolerance for the future-timestamp guard in recordQuotaSample: how far
// `atMs` may lead the local clock (`nowMs`) before it is treated as bogus
// rather than ordinary skew between whatever process stamps the statusline
// payload and this process reading it. Both run on the same machine, so
// this only needs to absorb IO/scheduling lag, not a plausible outage -- see
// recordQuotaSample's doc for why a window-sized tolerance here was the
// mistake that caused a permanent lockout in an earlier version of this fix.
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes

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
 * A second guard rejects an implausible timestamp using a TRUSTED SECOND
 * REFERENCE -- the local system clock (`nowMs`) -- never the last accepted
 * sample. An earlier version of this fix compared `atMs` to `last.atMs` and
 * rejected any forward jump bigger than the retention window. That
 * conflates two cases that look identical from inside the series alone: a
 * bogus future stamp, and a genuine multi-day gap (sleep/resume, or the app
 * simply left running while the statusline goes quiet for a week). Worse,
 * once that guard fired the sample was never pushed, so `last` never
 * advanced -- every later sample was then ALSO "more than a window ahead"
 * of that same frozen `last`, and was rejected too, forever. A gap longer
 * than one window killed the series permanently: exactly the silent,
 * unrecoverable loss this module exists to prevent.
 *
 * Comparing `atMs` to `nowMs` instead resolves this: a payload timestamp far
 * ahead of the ACTUAL current moment is bogus regardless of buffer history,
 * while a payload timestamp far ahead of `last` but consistent with `nowMs`
 * is a genuine gap -- accepted, with the now-stale series pruned by the age
 * prune below exactly as it should be (those samples really are outside the
 * window). No rejection here reads or depends on buffer state, so no
 * rejection can ever make a later, clock-consistent sample harder to
 * accept -- see this file's "never lets a rejection leave state..." test.
 *
 * `nowMs` defaults to `Date.now()` so production call sites don't need to
 * pass it, but stays an explicit parameter rather than a bare `Date.now()`
 * call in the body, so this function is exercised identically in tests and
 * in production -- no faking globals to control "now".
 *
 * `MAX_CLOCK_SKEW_MS` is deliberately tight, unlike `buffer.windowMs` used
 * above: it only needs to absorb ordinary lag between whatever stamps the
 * statusline payload and this process reading it (both on the same
 * machine), not a plausible outage. A window-sized tolerance against a
 * trusted clock would make this guard nearly useless -- almost any bogus
 * stamp still "looks recent enough."
 *
 * Returns whether the sample was accepted, so a caller can make a rejection
 * observable instead of silent. main.ts's statusline-snapshot handler
 * already treats this return value as the sole rejection signal (its
 * edge-triggered `[diag] quota sample rejected` log covers both rejection
 * reasons uniformly).
 */
export function recordQuotaSample(
  buffer: QuotaSampleBuffer,
  atMs: number,
  usedPercentage: number,
  nowMs: number = Date.now(),
): boolean {
  const last = buffer.samples[buffer.samples.length - 1];
  if (last && last.atMs === atMs && last.usedPercentage === usedPercentage) return false;
  if (atMs - nowMs > MAX_CLOCK_SKEW_MS) return false;
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
