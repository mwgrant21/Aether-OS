import { describe, it, expect } from 'vitest';
import { createQuotaSampleBuffer, recordQuotaSample } from './quotaSampleBuffer';

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
