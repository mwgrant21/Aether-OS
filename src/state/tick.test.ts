import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeTick } from './tick';
import { initialState } from './initialState';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('computeTick', () => {
  it('clamps rate to [20000, 168000] regardless of inputs', () => {
    const result = computeTick({ ...initialState, rate: 200000, cfg: { ...initialState.cfg, autoThrottle: false } });
    expect(result.rate).toBeLessThanOrEqual(168000);
    expect(result.rate).toBeGreaterThanOrEqual(20000);
  });

  it('auto-throttle caps rate at 80% of the alarm threshold', () => {
    const result = computeTick({
      ...initialState,
      rate: 168000,
      cfg: { ...initialState.cfg, autoThrottle: true, alarm: 120 },
    });
    expect(result.rate).toBeLessThanOrEqual(96000);
  });

  it('is fully deterministic with Math.random pinned to 0.5', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const state = { ...initialState, agents: [], cfg: { ...initialState.cfg, opMode: 'EDITS' as const, autoThrottle: true, alarm: 120 } };
    const result = computeTick(state);
    expect(result.rate).toBeCloseTo(84080, 5);
    expect(result.alarmLevel).toBe('ok');
    expect(result.approvals).toEqual(state.approvals);
  });

  it('flips alarmLevel to crit and fires a notification when the burn rate crosses the alarm threshold', () => {
    const state = { ...initialState, rate: 168000, agents: [], cfg: { ...initialState.cfg, alarm: 50, autoThrottle: false } };
    const result = computeTick(state);
    expect(result.alarmLevel).toBe('crit');
    expect(result.notifs).toHaveLength(1);
    expect(result.notifs![0].m).toContain('BURN ALARM');
    expect(result.unread).toBe(1);
  });

  it('never grows the approvals queue past 3 pending requests', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01);
    const state = {
      ...initialState,
      approvals: [...initialState.approvals, { id: 99, agent: 'X', i: 'X', hue: '#fff', action: 'a', detail: 'b', risk: 'LOW' as const }],
    };
    const result = computeTick(state);
    expect(result.approvals!.length).toBeLessThanOrEqual(3);
  });
});
