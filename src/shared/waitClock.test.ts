import { describe, it, expect } from 'vitest';
import {
  createWaitClock,
  beginWait,
  endWait,
  waitMsWithin,
  activeDurationMs,
  MAX_RETAINED_WAITS,
} from './waitClock';

const T = 1_000_000;

describe('waitMsWithin', () => {
  it('is zero with no waits recorded', () => {
    expect(waitMsWithin(createWaitClock(), T, T + 10_000, T + 10_000)).toBe(0);
  });

  it('counts a wait fully inside the span', () => {
    const clock = createWaitClock();
    beginWait(clock, 'a', T + 2_000);
    endWait(clock, 'a', T + 5_000);
    expect(waitMsWithin(clock, T, T + 10_000, T + 10_000)).toBe(3_000);
  });

  it('counts only the overlapping portion of a wait that starts before the span', () => {
    const clock = createWaitClock();
    beginWait(clock, 'a', T - 4_000);
    endWait(clock, 'a', T + 1_000);
    expect(waitMsWithin(clock, T, T + 10_000, T + 10_000)).toBe(1_000);
  });

  it('ignores a wait entirely outside the span', () => {
    const clock = createWaitClock();
    beginWait(clock, 'a', T + 20_000);
    endWait(clock, 'a', T + 25_000);
    expect(waitMsWithin(clock, T, T + 10_000, T + 30_000)).toBe(0);
  });

  it('treats a still-open wait as running up to now', () => {
    const clock = createWaitClock();
    beginWait(clock, 'a', T + 3_000);
    expect(waitMsWithin(clock, T, T + 10_000, T + 8_000)).toBe(5_000);
  });

  it('merges overlapping waits rather than double-counting the overlap', () => {
    const clock = createWaitClock();
    beginWait(clock, 'a', T + 1_000);
    beginWait(clock, 'b', T + 2_000);
    endWait(clock, 'a', T + 4_000);
    endWait(clock, 'b', T + 5_000);
    // Union is [T+1000, T+5000] = 4000ms, not 3000 + 3000.
    expect(waitMsWithin(clock, T, T + 10_000, T + 10_000)).toBe(4_000);
  });

  it('ignores a duplicate begin and an end for an id that was never begun', () => {
    const clock = createWaitClock();
    beginWait(clock, 'a', T + 1_000);
    beginWait(clock, 'a', T + 2_000); // duplicate -- must not restart the clock
    endWait(clock, 'ghost', T + 3_000); // never begun -- must be a no-op
    endWait(clock, 'a', T + 4_000);
    expect(waitMsWithin(clock, T, T + 10_000, T + 10_000)).toBe(3_000);
  });

  it('clamps a backward-moving clock at endWait so the interval never goes negative', () => {
    const clock = createWaitClock();
    beginWait(clock, 'a', T + 5_000);
    endWait(clock, 'a', T + 1_000); // atMs before startMs -- backward clock movement
    // Must clamp to a zero-length interval, not a negative-width one.
    expect(waitMsWithin(clock, T, T + 10_000, T + 10_000)).toBe(0);
  });
});

describe('activeDurationMs', () => {
  it('subtracts the user wait from the wall-clock duration', () => {
    const clock = createWaitClock();
    beginWait(clock, 'a', T + 10_000);
    endWait(clock, 'a', T + 40_000);
    // A 60s wall clock containing a 30s approval prompt is 30s of real work.
    expect(activeDurationMs(clock, T, 60_000, T + 60_000)).toBe(30_000);
  });

  it('returns the wall duration untouched when nothing was waiting', () => {
    expect(activeDurationMs(createWaitClock(), T, 60_000, T + 60_000)).toBe(60_000);
  });

  it('never returns a negative duration', () => {
    const clock = createWaitClock();
    beginWait(clock, 'a', T - 100_000);
    endWait(clock, 'a', T + 100_000);
    expect(activeDurationMs(clock, T, 5_000, T + 5_000)).toBe(0);
  });

  it('passes a non-finite or negative wall duration straight through as zero', () => {
    const clock = createWaitClock();
    expect(activeDurationMs(clock, T, Number.NaN, T)).toBe(0);
    expect(activeDurationMs(clock, T, -5, T)).toBe(0);
  });

  it('falls back to the full wall duration when startedAtMs is not finite', () => {
    // No usable anchor to compute overlap against -- treat as no measured wait
    // rather than silently returning zero for a duration we do have.
    const clock = createWaitClock();
    beginWait(clock, 'a', T);
    endWait(clock, 'a', T + 90_000);
    expect(activeDurationMs(clock, Number.NaN, 60_000, T + 60_000)).toBe(60_000);
  });

  it('stays frozen while a wait is still open, even as wall-clock time advances', () => {
    // Simulates a caller re-deriving wallDurationMs = nowMs - startedAtMs on
    // every tick while a prompt is still open: active time must not advance.
    const clock = createWaitClock();
    beginWait(clock, 'a', T + 5_000); // work ran 5s, then a prompt opened
    const activeAtOpen = activeDurationMs(clock, T, 5_000, T + 5_000);
    expect(activeAtOpen).toBe(5_000);
    const activeTenSecondsLater = activeDurationMs(clock, T, 15_000, T + 15_000);
    expect(activeTenSecondsLater).toBe(5_000);
    const activeThirtySecondsLater = activeDurationMs(clock, T, 35_000, T + 35_000);
    expect(activeThirtySecondsLater).toBe(5_000);
  });
});

describe('retention', () => {
  it('bounds closed intervals without ever discarding an open one', () => {
    const clock = createWaitClock();
    beginWait(clock, 'open', T);
    for (let i = 0; i < MAX_RETAINED_WAITS + 50; i += 1) {
      beginWait(clock, `w${i}`, T + i * 10);
      endWait(clock, `w${i}`, T + i * 10 + 1);
    }
    expect(clock.intervals.length).toBeLessThanOrEqual(MAX_RETAINED_WAITS + 1);
    expect(clock.intervals.some((iv) => iv.endMs === null)).toBe(true);
  });

  it('keeps the most recently closed waits, not the oldest', () => {
    const clock = createWaitClock();
    for (let i = 0; i < MAX_RETAINED_WAITS + 10; i += 1) {
      beginWait(clock, `w${i}`, T + i * 10);
      endWait(clock, `w${i}`, T + i * 10 + 1);
    }
    // The earliest waits (w0..w9) should have been pruned; the union over the
    // whole timeline should reflect only the retained (most recent) intervals.
    const totalPossible = (MAX_RETAINED_WAITS + 10) * 1; // each interval is 1ms wide, non-overlapping
    const counted = waitMsWithin(clock, T, T + (MAX_RETAINED_WAITS + 10) * 10 + 1, T + (MAX_RETAINED_WAITS + 10) * 10 + 1);
    expect(counted).toBeLessThan(totalPossible);
    expect(counted).toBe(MAX_RETAINED_WAITS);
  });
});
