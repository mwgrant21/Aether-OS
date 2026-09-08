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

  // `capturedAtMs` is external and untrusted (statuslineWatcher.ts validates
  // only Number.isFinite). A single payload stamped far in the future must
  // not be allowed to evict the whole retained series. The trusted reference
  // for "implausible" is the local clock (`nowMs`), not the last accepted
  // sample -- see the lockout regression test below for why comparing only
  // to `last` is unsound.
  it('does not let an implausible future timestamp evict the whole retained series', () => {
    const buffer = createQuotaSampleBuffer();
    const now = 10 * QUOTA_SAMPLE_WINDOW_MS;
    expect(recordQuotaSample(buffer, now, 10, now)).toBe(true);
    expect(recordQuotaSample(buffer, now + 10_000, 11, now + 10_000)).toBe(true);
    expect(recordQuotaSample(buffer, now + 20_000, 12, now + 20_000)).toBe(true);
    expect(recordQuotaSample(buffer, now + 30_000, 13, now + 30_000)).toBe(true);
    expect(recordQuotaSample(buffer, now + 40_000, 14, now + 40_000)).toBe(true);

    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    // The local clock (nowMs) still reads `now + 40_000` -- the payload's own
    // timestamp disagreeing with it by a year is what makes this bogus,
    // rather than a genuine gap the machine actually experienced.
    const rejected = recordQuotaSample(buffer, now + 40_000 + oneYearMs, 99, now + 40_000);

    // The bogus sample must be observably rejected, not silently retained --
    // and the five real readings must still be there.
    expect(rejected).toBe(false);
    expect(buffer.samples.map((s) => s.usedPercentage)).toEqual([10, 11, 12, 13, 14]);
  });

  // Coordinator-proved regression against commit 3bbfd5a: that fix's guard,
  // `atMs - last.atMs > buffer.windowMs`, compares only to the last ACCEPTED
  // sample. Once it fires, the sample is not pushed, so `last` never
  // advances -- every later sample is then also "more than a window ahead"
  // of that same frozen `last` and is rejected too, forever. A statusline
  // payload that goes quiet while the app keeps running (sleep/resume, or
  // just a week away from the machine) reproduces this: the watcher keeps
  // polling every 10s, real time keeps moving, and the series is
  // permanently dead the moment the gap exceeds one window.
  it('recovers after a genuine multi-day gap instead of a permanent lockout', () => {
    const buffer = createQuotaSampleBuffer();
    const start = 10 * QUOTA_SAMPLE_WINDOW_MS;
    expect(recordQuotaSample(buffer, start, 10, start)).toBe(true);
    expect(recordQuotaSample(buffer, start + 10_000, 11, start + 10_000)).toBe(true);

    // Nine real days pass -- genuinely outside the seven-day retention
    // window, and consistent with the local clock the whole way (nowMs
    // tracks atMs exactly; nothing here disagrees with reality).
    const nineDaysMs = 9 * 24 * 60 * 60 * 1000;
    const resumeStart = start + 10_000 + nineDaysMs;
    const results = [
      recordQuotaSample(buffer, resumeStart, 20, resumeStart),
      recordQuotaSample(buffer, resumeStart + 10_000, 21, resumeStart + 10_000),
      recordQuotaSample(buffer, resumeStart + 20_000, 22, resumeStart + 20_000),
    ];

    expect(results).toEqual([true, true, true]);
    // The pre-gap samples are genuinely nine days old now and correctly
    // pruned; the resumed samples are accepted, not locked out.
    expect(buffer.samples.map((s) => s.usedPercentage)).toEqual([20, 21, 22]);
  });

  // The invariant the lockout bug violated, stated directly so a future
  // change to the threshold can't reintroduce a different trap: rejecting
  // one sample must never leave behind any state that a later sample has to
  // climb over. Each call's accept/reject decision must be self-contained.
  it('never lets a rejection leave state that blocks a later, clock-consistent sample', () => {
    const buffer = createQuotaSampleBuffer();
    const now = 10 * QUOTA_SAMPLE_WINDOW_MS;
    expect(recordQuotaSample(buffer, now, 10, now)).toBe(true);
    expect(recordQuotaSample(buffer, now + 10_000, 11, now + 10_000)).toBe(true);

    // Repeated bogus-future rejections against a clock that hasn't moved --
    // each one is an independent "no", not an accumulating lockout.
    const bogusFarFuture = now + 10_000 + 365 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 5; i++) {
      expect(recordQuotaSample(buffer, bogusFarFuture + i, 99, now + 10_000)).toBe(false);
    }

    // A genuine nine-day gap, consistent with the local clock, must be
    // accepted immediately -- no lockout survived the rejections above.
    const resumed = now + 10_000 + 9 * 24 * 60 * 60 * 1000;
    expect(recordQuotaSample(buffer, resumed, 30, resumed)).toBe(true);
    expect(buffer.samples.map((s) => s.usedPercentage)).toEqual([30]);
  });

  // Guards the fix above against overcorrecting into "never prune to be
  // safe" -- real polling advances the clock forward by WATCH_INTERVAL_MS
  // (10s) every call, and that normal forward progression must still prune
  // once a reading falls outside the window.
  it('keeps pruning correctly under normal small forward steps, not just skipping oversized jumps', () => {
    const stepMs = 10_000; // the watcher's real poll interval
    const windowMs = 5 * stepMs; // small window so the test runs fast
    const buffer = createQuotaSampleBuffer(undefined, windowMs);
    const start = 10 * windowMs;
    for (let i = 0; i <= 20; i++) {
      expect(recordQuotaSample(buffer, start + i * stepMs, i)).toBe(true);
    }
    // 20 steps of stepMs is far more than one window's worth of normal
    // progression -- only the readings within one window of the latest may
    // remain.
    expect(buffer.samples.map((s) => s.usedPercentage)).toEqual([15, 16, 17, 18, 19, 20]);
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
