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
// The statusline writes roughly every render and the watcher polls every 10s
// (statuslineWatcher.ts's WATCH_INTERVAL_MS), so a full 7 days of continuous
// running is ~60k readings. The cap keeps that bounded at a size the hourly
// bucketing cannot even use -- two readings per hour would be plenty; the
// headroom just means a burst never evicts the far end of the window.
export const MAX_QUOTA_SAMPLES = 4000;

export interface QuotaSample {
  atMs: number;
  usedPercentage: number;
}

export interface QuotaSampleBuffer {
  samples: QuotaSample[];
  maxSamples: number;
}

export function createQuotaSampleBuffer(maxSamples: number = MAX_QUOTA_SAMPLES): QuotaSampleBuffer {
  return { samples: [], maxSamples };
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
  if (buffer.samples.length > buffer.maxSamples) buffer.samples.shift();
  return true;
}
