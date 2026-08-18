import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeTick } from './tick';
import { initialState } from './initialState';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('computeTick', () => {
  it('does not return a rate field — rate is owned by SET_REAL_USAGE, not TICK', () => {
    const result = computeTick({ ...initialState, rate: 92000, cfg: { ...initialState.cfg, autoThrottle: false } });
    expect(result.rate).toBeUndefined();
  });

  it('auto-throttle caps the effective rate used for budget math at 80% of the alarm threshold', () => {
    const uncapped = computeTick({
      ...initialState,
      rate: 168000,
      cfg: { ...initialState.cfg, autoThrottle: false, alarm: 120 },
    });
    const capped = computeTick({
      ...initialState,
      rate: 168000,
      cfg: { ...initialState.cfg, autoThrottle: true, alarm: 120 },
    });
    expect(capped.used!).toBeLessThan(uncapped.used!);
  });

  it('is fully deterministic with Math.random pinned to 0.5', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const state = { ...initialState, rate: 84000, cfg: { ...initialState.cfg, opMode: 'EDITS' as const, autoThrottle: true, alarm: 120 } };
    const result = computeTick(state);
    expect(result.used).toBeCloseTo(state.used + (84000 / 60) * 0.9 * 0.05, 5);
    expect(result.alarmLevel).toBe('ok');
  });

  function statuslineWith(fiveHourPct: number | null, sevenDayPct: number | null) {
    return {
      capturedAtMs: 0,
      sessionId: null,
      modelId: null,
      modelDisplayName: null,
      fiveHour: fiveHourPct === null ? null : { usedPercentage: fiveHourPct, resetsAtMs: 0 },
      sevenDay: sevenDayPct === null ? null : { usedPercentage: sevenDayPct, resetsAtMs: 0 },
      contextUsedPercentage: null,
      contextWindowSize: null,
      contextUsage: null,
      totalCostUsd: null,
      currentDir: null,
      projectDir: null,
    };
  }

  it('alarmLevel stays ok when statusline is null (no rate-limit data yet)', () => {
    const state = { ...initialState, statusline: null };
    const result = computeTick(state);
    expect(result.alarmLevel).toBe('ok');
  });

  it('alarmLevel flips to warn at 75% rate-limit usage', () => {
    const state = { ...initialState, statusline: statuslineWith(80, 10) };
    const result = computeTick(state);
    expect(result.alarmLevel).toBe('warn');
  });

  it('flips alarmLevel to crit and fires a notification when rate-limit usage crosses 90%', () => {
    const state = { ...initialState, statusline: statuslineWith(95, 10) };
    const result = computeTick(state);
    expect(result.alarmLevel).toBe('crit');
    expect(result.notifs).toHaveLength(1);
    expect(result.notifs![0].m).toContain('RATE LIMIT ALARM');
    expect(result.unread).toBe(1);
  });

  it('uses the higher of fiveHour/sevenDay usedPercentage', () => {
    const state = { ...initialState, statusline: statuslineWith(20, 95) };
    const result = computeTick(state);
    expect(result.alarmLevel).toBe('crit');
  });

  it('does not touch memories at all (decay was retired -- see Memory Layer 2 Phase D; memories are a live collector-sourced snapshot now, not locally ticked)', () => {
    const state = { ...initialState, memories: [] };
    const result = computeTick(state);
    expect(result.memories).toBeUndefined();
  });
});
