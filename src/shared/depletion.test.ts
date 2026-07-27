import { describe, it, expect } from 'vitest';
import { deriveDepletion, formatResetCountdown, STATUSLINE_STALE_AFTER_MS } from './depletion';
import type { StatuslineSnapshot, RateLimitWindow } from './statuslinePayload';

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

function snapshot(overrides: Partial<StatuslineSnapshot> & { fiveHour?: RateLimitWindow | null } = {}): StatuslineSnapshot {
  return {
    capturedAtMs: 0,
    sessionId: null,
    modelId: null,
    modelDisplayName: null,
    fiveHour: null,
    sevenDay: null,
    contextUsedPercentage: null,
    contextWindowSize: null,
    contextUsage: null,
    totalCostUsd: null,
    currentDir: null,
    projectDir: null,
    ...overrides,
  };
}

describe('deriveDepletion', () => {
  it('returns source none for a null snapshot', () => {
    const readout = deriveDepletion(null, null, 1000);
    expect(readout).toEqual({
      source: 'none',
      usedPercentage: null,
      resetsAtMs: null,
      msUntilReset: null,
      msUntilDepleted: null,
      depletesBeforeReset: false,
      stale: false,
    });
  });

  it('returns source none when fiveHour is null', () => {
    const snap = snapshot({ capturedAtMs: 0, fiveHour: null });
    const readout = deriveDepletion(snap, null, 1000);
    expect(readout.source).toBe('none');
    expect(readout.usedPercentage).toBeNull();
    expect(readout.resetsAtMs).toBeNull();
    expect(readout.msUntilReset).toBeNull();
    expect(readout.msUntilDepleted).toBeNull();
    expect(readout.depletesBeforeReset).toBe(false);
  });

  it('still reports staleness when fiveHour is null but snapshot is old', () => {
    const snap = snapshot({ capturedAtMs: 0, fiveHour: null });
    const readout = deriveDepletion(snap, null, STATUSLINE_STALE_AFTER_MS + 1);
    expect(readout.source).toBe('none');
    expect(readout.stale).toBe(true);
  });

  it('projects depletion at the 4h mark for 50% used at the 2h mark of a 5h window', () => {
    // windowStart = 0, now = 2h in, resetsAt = 5h.
    const windowStartMs = 0;
    const nowMs = 2 * HOUR;
    const resetsAtMs = 5 * HOUR;
    const snap = snapshot({
      capturedAtMs: nowMs,
      fiveHour: { usedPercentage: 50, resetsAtMs },
    });

    const readout = deriveDepletion(snap, windowStartMs, nowMs);

    // Hand computation: elapsedMs = 2h = 7,200,000ms. pacePerMs = 50 / 7,200,000.
    // msUntilDepleted = 50 / pacePerMs = 50 * 7,200,000 / 50 = 7,200,000ms (2h),
    // landing exactly at the 4h mark of the window (2h elapsed + 2h projected).
    expect(readout.msUntilDepleted).toBe(2 * HOUR);
    // msUntilReset = 5h - 2h = 3h = 10,800,000ms; 7,200,000 < 10,800,000.
    expect(readout.msUntilReset).toBe(3 * HOUR);
    expect(readout.depletesBeforeReset).toBe(true);
    expect(readout.source).toBe('statusline');
    expect(readout.usedPercentage).toBe(50);
  });

  it('does not project depletion before reset for 10% used at the 4h mark of a 5h window', () => {
    const windowStartMs = 0;
    const nowMs = 4 * HOUR;
    const resetsAtMs = 5 * HOUR;
    const snap = snapshot({
      capturedAtMs: nowMs,
      fiveHour: { usedPercentage: 10, resetsAtMs },
    });

    const readout = deriveDepletion(snap, windowStartMs, nowMs);

    // Hand computation: elapsedMs = 4h = 14,400,000ms. pacePerMs = 10 / 14,400,000.
    // msUntilDepleted = 90 / pacePerMs = 90 * 14,400,000 / 10 = 129,600,000ms (36h).
    // msUntilReset = 1h = 3,600,000ms. 129,600,000 > 3,600,000, so it does not
    // deplete before reset.
    expect(readout.msUntilDepleted).toBe(36 * HOUR);
    expect(readout.msUntilReset).toBe(1 * HOUR);
    expect(readout.depletesBeforeReset).toBe(false);
  });

  it('returns msUntilDepleted null when usedPercentage is 0', () => {
    const nowMs = 2 * HOUR;
    const snap = snapshot({
      capturedAtMs: nowMs,
      fiveHour: { usedPercentage: 0, resetsAtMs: 5 * HOUR },
    });
    const readout = deriveDepletion(snap, 0, nowMs);
    expect(readout.msUntilDepleted).toBeNull();
    expect(readout.depletesBeforeReset).toBe(false);
  });

  it('returns msUntilDepleted 0 and depletesBeforeReset true when usedPercentage is 100', () => {
    const nowMs = 2 * HOUR;
    const snap = snapshot({
      capturedAtMs: nowMs,
      fiveHour: { usedPercentage: 100, resetsAtMs: 5 * HOUR },
    });
    const readout = deriveDepletion(snap, 0, nowMs);
    expect(readout.msUntilDepleted).toBe(0);
    expect(readout.depletesBeforeReset).toBe(true);
  });

  it('returns msUntilDepleted null when elapsedMs <= 0 (clock skew)', () => {
    // windowStart is in the future relative to now.
    const nowMs = 1 * HOUR;
    const windowStartMs = 2 * HOUR;
    const snap = snapshot({
      capturedAtMs: nowMs,
      fiveHour: { usedPercentage: 50, resetsAtMs: 6 * HOUR },
    });
    const readout = deriveDepletion(snap, windowStartMs, nowMs);
    expect(readout.msUntilDepleted).toBeNull();
    expect(readout.depletesBeforeReset).toBe(false);
  });

  it('computes windowStart from resetsAtMs when windowStartMs is null', () => {
    // resetsAtMs = 5h, so the derived windowStart is 0. now = 2h in -> same as
    // the explicit-windowStart case above.
    const nowMs = 2 * HOUR;
    const snap = snapshot({
      capturedAtMs: nowMs,
      fiveHour: { usedPercentage: 50, resetsAtMs: 5 * HOUR },
    });
    const readout = deriveDepletion(snap, null, nowMs);
    expect(readout.msUntilDepleted).toBe(2 * HOUR);
    expect(readout.depletesBeforeReset).toBe(true);
  });

  it('marks stale false at the freshness threshold and true just past it, keeping numbers', () => {
    const capturedAtMs = 0;
    const fiveHour: RateLimitWindow = { usedPercentage: 50, resetsAtMs: 5 * HOUR };

    const fresh = deriveDepletion(snapshot({ capturedAtMs, fiveHour }), 0, STATUSLINE_STALE_AFTER_MS);
    expect(fresh.stale).toBe(false);
    expect(fresh.usedPercentage).toBe(50);
    expect(fresh.msUntilDepleted).not.toBeNull();

    const staleReadout = deriveDepletion(snapshot({ capturedAtMs, fiveHour }), 0, STATUSLINE_STALE_AFTER_MS + 1);
    expect(staleReadout.stale).toBe(true);
    // A stale snapshot still returns its real numbers -- only the flag changes.
    expect(staleReadout.usedPercentage).toBe(50);
    expect(staleReadout.msUntilDepleted).not.toBeNull();
    expect(staleReadout.depletesBeforeReset).toBe(fresh.depletesBeforeReset);
  });
});

describe('formatResetCountdown', () => {
  it('returns an em dash for null', () => {
    expect(formatResetCountdown(null)).toBe('—');
  });

  it('returns "now" for zero', () => {
    expect(formatResetCountdown(0)).toBe('now');
  });

  it('returns "now" for negative values', () => {
    expect(formatResetCountdown(-1000)).toBe('now');
  });

  it('formats sub-hour durations as minutes only', () => {
    expect(formatResetCountdown(42 * MIN)).toBe('42m');
  });

  it('formats hour-plus durations as hours and minutes', () => {
    expect(formatResetCountdown(3 * HOUR + 12 * MIN)).toBe('3h 12m');
  });
});
