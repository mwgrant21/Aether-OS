import { describe, it, expect } from 'vitest';
import {
  createQuotaSampleBuffer,
  recordQuotaSample,
  QUOTA_SAMPLE_WINDOW_MS,
} from './quotaSampleBuffer';

describe('quotaSampleBuffer', () => {
  it('accepts a sample whose timestamp is LOWER than the last accepted one', () => {
    // Regression test for a real bug: a prior version used `last.atMs >= atMs`
    // to reject re-emitted duplicates, which made the buffer a monotonic
    // high-water mark. A backward clock step (sleep/resume NTP correction, or
    // statuslineWatcher's own mtime-vs-self-reported-timestamp fallback
    // regressing between two reads) would then poison the buffer permanently:
    // every later sample compares against a now-too-high last.atMs and is
    // silently rejected until wall time exceeds it again.
    const buffer = createQuotaSampleBuffer();
    expect(recordQuotaSample(buffer, 2000, 10)).toBe(true);
    const acceptedEarlier = recordQuotaSample(buffer, 1000, 12);
    expect(acceptedEarlier).toBe(true);
    expect(buffer.samples).toEqual([
      { atMs: 2000, usedPercentage: 10 },
      { atMs: 1000, usedPercentage: 12 },
    ]);
    // And the buffer keeps accepting AFTER the backward step -- the bug would
    // have poisoned it so every later sample below 2000 also got rejected.
    expect(recordQuotaSample(buffer, 1500, 13)).toBe(true);
  });

  it('rejects an exact re-emit (same timestamp AND same reading) of the last accepted sample', () => {
    // The guard's actual intent, preserved by the fix: a stalled statusline
    // file re-emitting an unchanged payload should not fill the buffer with
    // copies of one reading.
    const buffer = createQuotaSampleBuffer();
    expect(recordQuotaSample(buffer, 1000, 42)).toBe(true);
    const acceptedDuplicate = recordQuotaSample(buffer, 1000, 42);
    expect(acceptedDuplicate).toBe(false);
    expect(buffer.samples).toEqual([{ atMs: 1000, usedPercentage: 42 }]);
  });

  // Whole-branch review, FIX 1: retention used to be a COUNT cap of 4000, which
  // at the watcher's 10s poll is ~11 hours -- so deriveQuotaEfficiency, called
  // with a seven-day window, joined a series that only reached back half a day.
  // Every older bucket lost its percentage reading and fell to
  // 'no-quota-sample': excluded from the fit, while its tokens still counted in
  // observedTokens. Retention is now by AGE and must match the consumer's
  // window.
  it('prunes a sample older than the retention window while keeping one inside it', () => {
    const buffer = createQuotaSampleBuffer();
    const now = 10 * QUOTA_SAMPLE_WINDOW_MS; // far from 0, so "older" is real
    // Six days back: inside a seven-day window, must survive.
    expect(recordQuotaSample(buffer, now - 6 * 24 * 60 * 60 * 1000, 11)).toBe(true);
    expect(buffer.samples.map((s) => s.usedPercentage)).toEqual([11]);
    expect(recordQuotaSample(buffer, now, 42)).toBe(true);
    // Both still present: nothing has aged out yet.
    expect(buffer.samples.map((s) => s.usedPercentage)).toEqual([11, 42]);

    // Two more days pass. The six-day-old reading is now eight days old and
    // must go; the one recorded at `now` is two days old and must stay.
    expect(recordQuotaSample(buffer, now + 2 * 24 * 60 * 60 * 1000, 55)).toBe(true);
    expect(buffer.samples.map((s) => s.usedPercentage)).toEqual([42, 55]);
  });

  // The count cap is a memory backstop, not the retention rule, and must be
  // large enough that a full seven days of 10s polling never reaches it --
  // ~60,480 readings. A cap that evicts before the age prune does would
  // reintroduce exactly the narrowing FIX 1 removed.
  it('sizes the count cap so a full seven days of 10s polling is never evicted by count', () => {
    const pollsInSevenDays = QUOTA_SAMPLE_WINDOW_MS / 10_000;
    const buffer = createQuotaSampleBuffer();
    expect(buffer.maxSamples).toBeGreaterThanOrEqual(pollsInSevenDays);
    expect(buffer.windowMs).toBe(QUOTA_SAMPLE_WINDOW_MS);
  });

  it('evicts the oldest sample once the buffer exceeds its cap, and acceptance never depends on fullness', () => {
    const buffer = createQuotaSampleBuffer(3);
    expect(recordQuotaSample(buffer, 1, 1)).toBe(true);
    expect(recordQuotaSample(buffer, 2, 2)).toBe(true);
    expect(recordQuotaSample(buffer, 3, 3)).toBe(true);
    // Buffer is now full. A new, non-duplicate sample must still be accepted --
    // fullness evicts the oldest entry, it never rejects the incoming one.
    expect(recordQuotaSample(buffer, 4, 4)).toBe(true);
    expect(buffer.samples).toEqual([
      { atMs: 2, usedPercentage: 2 },
      { atMs: 3, usedPercentage: 3 },
      { atMs: 4, usedPercentage: 4 },
    ]);
  });
});
