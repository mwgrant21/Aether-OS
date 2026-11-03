import { describe, expect, it } from 'vitest';
import {
  applyBudget,
  isMiss,
  ladderPick,
  opusUnlocked,
  registerMiss,
  rejectAuto,
  shouldRepick,
} from './pickPolicy';
import type { MissCounter } from './pickPolicy';
import type { Pick } from './types';

const SONNET_MED: Pick = { model: 'sonnet', effort: 'medium' };
const usage = (sessionPct: number, weekPct = 0) => ({ sessionPct, weekPct });

describe('ladderPick', () => {
  it('maps task classes to the ladder', () => {
    expect(ladderPick('mechanical', { opusUnlocked: false })).toEqual({ model: 'haiku', effort: 'low' });
    expect(ladderPick('default', { opusUnlocked: false })).toEqual(SONNET_MED);
    expect(ladderPick('judgment', { opusUnlocked: false })).toEqual({ model: 'sonnet', effort: 'high' });
  });
  it('gates opus on opusUnlocked and never for mechanical', () => {
    const opus = { model: 'opus', effort: 'high' };
    expect(ladderPick('judgment', { opusUnlocked: true })).toEqual(opus);
    expect(ladderPick('default', { opusUnlocked: true })).toEqual(opus);
    expect(ladderPick('mechanical', { opusUnlocked: true })).toEqual({ model: 'haiku', effort: 'low' });
  });
});

describe('rejectAuto', () => {
  it('accepts a ladder pick', () => {
    expect(rejectAuto(SONNET_MED)).toEqual({ ok: true });
  });
  it('rejects fable, naming it', () => {
    const r = rejectAuto({ model: 'fable', effort: 'low' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('fable');
  });
  it.each(['xhigh', 'max'])('rejects effort %s, naming it', (effort) => {
    const r = rejectAuto({ model: 'sonnet', effort });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(effort);
  });
});

describe('miss counting', () => {
  const start: MissCounter = { taskClass: 'judgment', count: 0 };
  it('counts a miss in the same class', () => {
    expect(registerMiss(start, 'judgment', 'thumbs-down').count).toBe(1);
  });
  it('resets on a task-class change', () => {
    expect(registerMiss({ taskClass: 'judgment', count: 1 }, 'default', 'thumbs-down')).toEqual({
      taskClass: 'default',
      count: 0,
    });
  });
  it.each(['new-request', 'direction-change', 'agent-self-reported-failure'] as const)(
    'ignores non-miss %s',
    (signal) => {
      expect(isMiss(signal)).toBe(false);
      expect(registerMiss({ taskClass: 'judgment', count: 1 }, 'judgment', signal).count).toBe(1);
    },
  );
  it('unlocks opus at two misses, not one', () => {
    const one = registerMiss(start, 'judgment', 'phrase-wrong');
    expect(opusUnlocked(one)).toBe(false);
    expect(opusUnlocked(registerMiss(one, 'judgment', 'stop-then-reprompt'))).toBe(true);
  });
});

describe('applyBudget', () => {
  it('steps one rung down at session 70', () => {
    const r = applyBudget({ model: 'opus', effort: 'high' }, usage(70), 'auto');
    expect(r.pick).toEqual({ model: 'sonnet', effort: 'high' });
    expect(r.level).toBe('step');
    expect(r.banner).toBe(false);
    expect(r.reason).toContain('session 70%');
  });
  it('steps down at week 75 with week reason', () => {
    const r = applyBudget(SONNET_MED, usage(0, 75), 'auto');
    expect(r.pick).toEqual({ model: 'haiku', effort: 'low' });
    expect(r.reason).toContain('week 75%');
  });
  it('does nothing under thresholds', () => {
    const r = applyBudget(SONNET_MED, usage(69, 74), 'auto');
    expect(r).toMatchObject({ pick: SONNET_MED, level: 'none', banner: false });
  });
  it('floors to haiku/low with banner at 90, and session alone is enough', () => {
    const r = applyBudget({ model: 'opus', effort: 'high' }, usage(91, 0), 'auto');
    expect(r).toMatchObject({ pick: { model: 'haiku', effort: 'low' }, level: 'floor', banner: true });
    expect(applyBudget(SONNET_MED, usage(0, 90), 'auto').level).toBe('floor');
  });
  it('keeps haiku/low at the bottom rung', () => {
    const low: Pick = { model: 'haiku', effort: 'low' };
    expect(applyBudget(low, usage(80), 'auto').pick).toEqual(low);
  });
  it('never changes a manual pick', () => {
    const manual: Pick = { model: 'opus', effort: 'xhigh' };
    expect(applyBudget(manual, usage(95, 95), 'manual')).toMatchObject({
      pick: manual,
      level: 'none',
      banner: false,
    });
  });
  it('holds the step inside the hysteresis band and clears below it', () => {
    expect(applyBudget(SONNET_MED, usage(72), 'auto', 'step').level).toBe('step');
    expect(applyBudget(SONNET_MED, usage(65), 'auto', 'step').level).toBe('step');
    expect(applyBudget(SONNET_MED, usage(64), 'auto', 'step').level).toBe('none');
    expect(applyBudget(SONNET_MED, usage(0, 69), 'auto', 'step').level).toBe('none');
  });
  it('holds floor down to 85 then releases to step', () => {
    expect(applyBudget(SONNET_MED, usage(86), 'auto', 'floor').level).toBe('floor');
    expect(applyBudget(SONNET_MED, usage(84), 'auto', 'floor').level).toBe('step');
  });
});

describe('shouldRepick', () => {
  const prev = { taskClass: 'default' as const, budgetLevel: 'none' as const };
  const next = { ...prev, trigger: null, turnInFlight: false };
  it('is false mid-turn or without a trigger', () => {
    expect(shouldRepick(prev, { ...next, trigger: 'miss', turnInFlight: true })).toBe(false);
    expect(shouldRepick(prev, next)).toBe(false);
  });
  it('is true for new-thread, miss and think-harder', () => {
    for (const trigger of ['new-thread', 'miss', 'think-harder'] as const) {
      expect(shouldRepick(prev, { ...next, trigger })).toBe(true);
    }
  });
  it('is true on a real task-class or budget change only', () => {
    expect(shouldRepick(prev, { ...next, trigger: 'task-class', taskClass: 'judgment' })).toBe(true);
    expect(shouldRepick(prev, { ...next, trigger: 'task-class' })).toBe(false);
    expect(shouldRepick(prev, { ...next, trigger: 'budget', budgetLevel: 'step' })).toBe(true);
    expect(shouldRepick(prev, { ...next, trigger: 'budget' })).toBe(false);
  });
  it('is false for a manual trigger', () => {
    expect(shouldRepick(prev, { ...next, trigger: 'manual' })).toBe(false);
  });
});
