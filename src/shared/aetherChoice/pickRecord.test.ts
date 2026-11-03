import { describe, expect, it } from 'vitest';
import {
  clearHalt,
  clearPendingStepDown,
  deriveReadoutState,
  markExited,
  markLaunched,
  markNotApplied,
  newRecord,
  planLaunch,
  setPendingStepDown,
  submitPick,
} from './pickRecord';
import type { LaunchPlan, ThreadPickRecord } from './pickRecord';
import type { Pick } from './types';

const META = { reason: 'r', trigger: 'new-thread', source: 'auto' } as const;
const LOW = { sessionPct: 0, weekPct: 0 };
const SONNET_MED: Pick = { model: 'sonnet', effort: 'medium' };

function live(source: 'auto' | 'manual' = 'auto'): ThreadPickRecord {
  const r = newRecord('t1', SONNET_MED, { ...META, source });
  return { ...r, live: true, lastLaunchedModel: 'sonnet' };
}
const sub = (r: ThreadPickRecord, p: Pick, source: 'auto' | 'manual', now = 1) =>
  submitPick(r, p, { reason: 'x', trigger: source === 'manual' ? 'manual' : 'miss', source, now });

describe('pickRecord', () => {
  it('Option R: a live model change goes to modelPending, never to the queue (A24)', () => {
    const { record } = sub(live(), { model: 'opus', effort: 'medium' }, 'manual');
    expect(record.modelPending).toBe('opus');
    expect(record.queue).toBeNull();
    expect(record.intended.model).toBe('sonnet');
  });

  it('an effort-only change on a live thread is queued', () => {
    const { record } = sub(live(), { model: 'sonnet', effort: 'high' }, 'auto', 42);
    expect(record.queue?.pick).toEqual({ model: 'sonnet', effort: 'high' });
    expect(record.queue?.queuedAt).toBe(42);
    expect(record.modelPending).toBeNull();
  });

  it('a mixed change splits: model to modelPending, effort to queue', () => {
    const { record } = sub(live(), { model: 'opus', effort: 'high' }, 'manual');
    expect(record.modelPending).toBe('opus');
    expect(record.queue?.pick).toEqual({ model: 'sonnet', effort: 'high' });
  });

  it('latest wins: one pending pick per thread', () => {
    const a = sub(live(), { model: 'opus', effort: 'high' }, 'auto').record;
    const b = sub(a, { model: 'sonnet', effort: 'low' }, 'auto').record;
    expect(b.modelPending).toBeNull();
    expect(b.queue?.pick.effort).toBe('low');
  });

  it('a manual submit replaces a pending auto pick', () => {
    const a = sub(live(), { model: 'opus', effort: 'high' }, 'auto').record;
    const b = sub(a, { model: 'sonnet', effort: 'medium' }, 'manual').record;
    expect(b.modelPending).toBeNull();
    expect(b.queue).toBeNull();
    expect(b.pendingSource).toBeNull();
  });

  it('an auto submit does not overwrite a pending manual pick', () => {
    const a = sub(live(), { model: 'opus', effort: 'high' }, 'manual').record;
    const res = sub(a, { model: 'haiku', effort: 'low' }, 'auto');
    expect(res.record).toBe(a);
    expect(res.rejected).not.toBeNull();
  });

  it('a rejected auto pick leaves the record unchanged', () => {
    const r = live();
    const res = sub(r, { model: 'sonnet', effort: 'max' }, 'auto');
    expect(res.record).toBe(r);
    expect(res.rejected).toContain('max');
  });

  it('a halted record applies nothing but retains the pick (A25)', () => {
    const r = markNotApplied(live(), { model: 'opus', effort: 'high' }, SONNET_MED);
    const { record } = sub(r, { model: 'haiku', effort: 'low' }, 'manual', 7);
    expect(record.intended).toEqual(SONNET_MED);
    expect(record.halted).not.toBeNull();
    expect(record.modelPending).toBe('haiku');
    expect(record.queue?.pick.effort).toBe('low');
  });

  it('clearHalt clears only the halt', () => {
    const r = markNotApplied(live(), { model: 'opus', effort: 'high' }, null);
    const c = clearHalt(r);
    expect(c.halted).toBeNull();
    expect({ ...c, halted: r.halted }).toEqual(r);
  });

  it('markExited keeps queue and modelPending (A4)', () => {
    const r = sub(live(), { model: 'opus', effort: 'high' }, 'manual').record;
    const e = markExited(r);
    expect(e.live).toBe(false);
    expect(e.queue).toEqual(r.queue);
    expect(e.modelPending).toBe('opus');
  });

  it('a non-live submit becomes the intent directly', () => {
    const r = markExited(live());
    const { record } = sub(r, { model: 'opus', effort: 'high' }, 'manual');
    expect(record.intended).toEqual({ model: 'opus', effort: 'high' });
    expect(record.modelPending).toBeNull();
  });

  it('planLaunch re-lowers per budget on every call without mutating (A12/A11)', () => {
    const r = setPendingStepDown(live());
    const frozen = JSON.stringify(r);
    const p = planLaunch(r, { sessionPct: 91, weekPct: 0 }) as LaunchPlan;
    expect(p.model).toBe('haiku');
    expect(p.effort).toBe('low');
    expect(p.resume).toBe(true);
    expect(JSON.stringify(r)).toBe(frozen);
    const again = planLaunch(r, LOW) as LaunchPlan;
    expect(again.model).toBe('sonnet');
  });

  it('planLaunch folds modelPending and queued effort, and resume is false before first launch', () => {
    const r = sub(live(), { model: 'opus', effort: 'high' }, 'manual').record;
    const p = planLaunch(r, LOW) as LaunchPlan;
    expect(p).toMatchObject({ model: 'opus', effort: 'high', resume: true });
    expect((planLaunch(newRecord('n', SONNET_MED, META), LOW) as LaunchPlan).resume).toBe(false);
  });

  it('planLaunch passes the last budget level so hysteresis holds', () => {
    const r = { ...live(), lastBudgetLevel: 'step' as const };
    const p = planLaunch(r, { sessionPct: 66, weekPct: 0 }) as LaunchPlan;
    expect(p.budgetLevel).toBe('step');
    expect(p.model).toBe('haiku');
  });

  it('planLaunch leaves a manual non-ladder pick unchanged under budget', () => {
    const r = newRecord('m', { model: 'opus', effort: 'xhigh' }, { ...META, source: 'manual' });
    expect(planLaunch(r, { sessionPct: 95, weekPct: 0 })).toMatchObject({
      model: 'opus',
      effort: 'xhigh',
    });
  });

  it('planLaunch does not budget-rewrite a non-ladder auto pick', () => {
    const r = newRecord('a', { model: 'sonnet', effort: 'low' }, META);
    expect(planLaunch(r, { sessionPct: 95, weekPct: 0 })).toMatchObject({
      model: 'sonnet',
      effort: 'low',
    });
  });

  it('planLaunch returns an error for an effort outside the launch set', () => {
    const r = newRecord('u', { model: 'sonnet', effort: 'bogus' as never }, { ...META, source: 'manual' });
    expect(planLaunch(r, LOW)).toEqual({ error: 'effort-not-launchable' });
  });

  it('markLaunched sets live, clears modelPending when launched with it, keeps it otherwise', () => {
    const r = sub(markExited(live()), SONNET_MED, 'manual').record;
    const pending = { ...r, modelPending: 'opus' as const, pendingSource: 'manual' as const };
    const ok = markLaunched(pending, planLaunch(pending, LOW) as LaunchPlan);
    expect(ok.live).toBe(true);
    expect(ok.lastLaunchedModel).toBe('opus');
    expect(ok.modelPending).toBeNull();
    expect(ok.intended.model).toBe('opus');
    const autoPend = { ...pending, intended: { model: 'sonnet' as const, effort: 'high' as const }, pendingSource: 'auto' as const };
    const lowered = markLaunched(autoPend, planLaunch(autoPend, { sessionPct: 95, weekPct: 0 }) as LaunchPlan);
    expect(lowered.lastLaunchedModel).toBe('haiku');
    expect(lowered.modelPending).toBe('opus');
  });

  it('markLaunched records the budget-lowered pick in launched; intended stays desired and recovers on a later resume', () => {
    const fresh = newRecord('t2', { model: 'sonnet', effort: 'high' }, META);
    const plan = planLaunch(fresh, { sessionPct: 95, weekPct: 0 }) as LaunchPlan;
    expect([plan.model, plan.effort]).toEqual(['haiku', 'low']);
    const launched = markLaunched(fresh, plan);
    expect(launched.launched).toEqual({ model: 'haiku', effort: 'low' });
    expect(launched.intended).toEqual({ model: 'sonnet', effort: 'high' });
    expect(planLaunch(markExited(launched), LOW)).toMatchObject({ model: 'sonnet', effort: 'high' });
    const { record } = sub(launched, { model: 'sonnet', effort: 'high' }, 'manual');
    expect(record.modelPending).toBe('sonnet');
    expect(record.queue?.pick.effort).toBe('high');
  });

  it('markLaunched promotes a consumed manual pending pick to source so later launches never budget-adjust it', () => {
    const live1 = { ...live(), intended: { model: 'sonnet', effort: 'high' } as Pick };
    const held = markExited(sub(live1, { model: 'opus', effort: 'high' }, 'manual').record);
    expect(held.modelPending).toBe('opus');
    const first = markLaunched(held, planLaunch(held, LOW) as LaunchPlan);
    expect(first.source).toBe('manual');
    expect(first.pendingSource).toBeNull();
    const second = planLaunch(markExited(first), { sessionPct: 95, weekPct: 0 }) as LaunchPlan;
    expect([second.model, second.effort]).toEqual(['opus', 'high']);
  });

  it('set/clearPendingStepDown toggle the flag', () => {
    const r = setPendingStepDown(live());
    expect(r.pendingStepDown).toBe(true);
    expect(clearPendingStepDown(r).pendingStepDown).toBe(false);
  });

  it('deriveReadoutState maps each kit row', () => {
    const base = live();
    expect(deriveReadoutState(base)).toBe('steady');
    expect(deriveReadoutState(sub(base, { model: 'sonnet', effort: 'high' }, 'auto').record)).toBe('queued');
    expect(deriveReadoutState(sub(base, { model: 'opus', effort: 'medium' }, 'manual').record)).toBe('queuedModel');
    const sent = { ...base, outcome: 'sent' as const };
    expect(deriveReadoutState(sent)).toBe('applying');
    expect(deriveReadoutState(sent, { hasReadback: false })).toBe('unconfirmed');
    expect(deriveReadoutState(base, { blocked: true })).toBe('blocked');
    expect(deriveReadoutState(markNotApplied(base, SONNET_MED, null))).toBe('notApplied');
  });
});

describe('submitPick: auto budget never touches a manual record (F1)', () => {
  const liveManual = (): ThreadPickRecord =>
    markLaunched(newRecord('t1', { model: 'opus', effort: 'high' }, { reason: 'u', trigger: 'manual', source: 'manual' }), {
      model: 'opus', effort: 'high', resume: false, reasonSuffix: '', budgetLevel: 'none',
    });
  const budget = { reason: 'b', trigger: 'budget', source: 'auto', now: 1 } as const;

  it('a manual-source live record ignores an auto budget submit', () => {
    const rec = liveManual();
    const r = submitPick(rec, { model: 'haiku', effort: 'low' }, budget);
    expect(r.record).toEqual(rec);
    expect(r.record.queue).toBeNull();
  });

  it('a record with a pending manual pick ignores an auto budget submit', () => {
    const auto = markLaunched(newRecord('t1', { model: 'sonnet', effort: 'high' }, { reason: 'a', trigger: 'task-class', source: 'auto' }), {
      model: 'sonnet', effort: 'high', resume: false, reasonSuffix: '', budgetLevel: 'none',
    });
    const rec = submitPick(auto, { model: 'sonnet', effort: 'low' }, { reason: 'u', trigger: 'manual', source: 'manual', now: 1 }).record;
    expect(rec.pendingSource).toBe('manual');
    const r = submitPick(rec, { model: 'sonnet', effort: 'medium' }, budget);
    expect(r.record).toEqual(rec);
  });
});
