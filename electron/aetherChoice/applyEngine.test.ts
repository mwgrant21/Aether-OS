import { describe, expect, it, vi } from 'vitest';
import type { TerminalSlotId } from '../../src/shared/remote/types';
import type { Pick } from '../../src/shared/aetherChoice/types';
import { markExited, markLaunched, newRecord } from '../../src/shared/aetherChoice/pickRecord';
import { applyBudget } from '../../src/shared/aetherChoice/pickPolicy';
import type { BudgetLevel } from '../../src/shared/aetherChoice/pickPolicy';
import type { ThreadPickRecord } from '../../src/shared/aetherChoice/pickRecord';
import { createApplyEngine, formatPickLine, unknownIdle } from './applyEngine';
import type { IdleReading } from './applyEngine';

const T = 't1';
const META = { reason: 'r', trigger: 'miss' as const, source: 'manual' as const };

function setup(opts: { slot?: TerminalSlotId | null; reading?: IdleReading; usage?: number; writeOk?: boolean } = {}) {
  const writes: Array<[string, string]> = [];
  const logs: string[] = [];
  const state = { reading: opts.reading ?? 'idle', usage: opts.usage ?? 0, writeOk: opts.writeOk ?? true };
  const records = new Map<string, ThreadPickRecord>();
  const live = markLaunched(newRecord(T, { model: 'sonnet', effort: 'medium' }, { reason: 'x', trigger: 'new-thread', source: 'auto' }), {
    model: 'sonnet', effort: 'medium', resume: false, reasonSuffix: '', budgetLevel: 'none',
  });
  records.set(T, live);
  const notifyFailure = vi.fn();
  const awayMode = vi.fn(() => false);
  const engine = createApplyEngine({
    writePort: { write: (s, d) => { writes.push([s, d]); return state.writeOk; } },
    slotFor: () => (opts.slot === undefined ? 'claude' : opts.slot),
    idle: () => state.reading,
    now: () => 1_700_000_000_000,
    log: (l) => logs.push(l),
    notifyFailure,
    awayMode,
    usage: () => ({ sessionPct: state.usage, weekPct: 0 }),
    getRecord: (id) => records.get(id),
    setRecord: (id, r) => { records.set(id, r); },
  });
  return { engine, writes, logs, state, records, notifyFailure, awayMode };
}

const HIGH: Pick = { model: 'sonnet', effort: 'high' };

describe('applyEngine', () => {
  it('a successful /effort write updates launched.effort and leaves the desired intended model alone', () => {
    const s = setup();
    s.records.set(T, { ...s.records.get(T)!, launched: { model: 'haiku', effort: 'low' }, intended: { model: 'sonnet', effort: 'medium' } });
    s.engine.onPick(T, HIGH, META);
    expect(s.engine.onIdleCheck(T)).toBe('sent');
    expect(s.records.get(T)?.launched).toEqual({ model: 'haiku', effort: 'high' });
    expect(s.records.get(T)?.intended.model).toBe('sonnet');
  });

  it('writes exactly /effort <level>\\r at idle', () => {
    const s = setup();
    s.engine.onPick(T, HIGH, META);
    expect(s.engine.onIdleCheck(T)).toBe('sent');
    expect(s.writes).toEqual([['claude', '/effort high\r']]);
  });

  it('never writes /model across a sequence with a live model pick', () => {
    const s = setup();
    s.engine.onPick(T, { model: 'opus', effort: 'high' }, META);
    s.engine.onIdleCheck(T);
    s.engine.onIdleCheck(T);
    expect(s.writes.every(([, d]) => !d.includes('/model') && d.startsWith('/effort '))).toBe(true);
    expect(s.records.get(T)?.modelPending).toBe('opus');
  });

  it('latest wins: two queued picks, one write', () => {
    const s = setup();
    s.engine.onPick(T, HIGH, META);
    s.engine.onPick(T, { model: 'sonnet', effort: 'low' }, META);
    s.engine.onIdleCheck(T);
    s.engine.onIdleCheck(T);
    expect(s.writes).toEqual([['claude', '/effort low\r']]);
  });

  it('logs one line per pick change in the A17 field order', () => {
    const s = setup();
    s.engine.onPick(T, HIGH, META);
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]).toBe(
      formatPickLine({ time: new Date(1_700_000_000_000).toISOString(), from: 'sonnet/medium', to: 'sonnet/high', source: 'manual', trigger: 'miss', outcome: 'queued' }),
    );
    expect(formatPickLine({ time: 'T', from: 'a', to: 'b', source: 'auto', trigger: 'budget', outcome: 'sent' })).toBe('T a -> b auto budget sent');
  });

  it('keeps the pick when the port returns false: no throw, no retry, no log', () => {
    const s = setup({ writeOk: false });
    s.engine.onPick(T, HIGH, META);
    const before = s.logs.length;
    expect(s.engine.onIdleCheck(T)).toBe('skipped');
    expect(s.writes).toHaveLength(1);
    expect(s.logs).toHaveLength(before);
    expect(s.records.get(T)?.queue?.pick.effort).toBe('high');
  });

  it('halted slot gets zero bytes until clearHalt, then the next idle writes', () => {
    const s = setup();
    s.engine.onPick(T, HIGH, META);
    s.engine.onIdleCheck(T);
    s.engine.reportOutcome(T, 'not-applied', null);
    s.writes.length = 0;
    s.engine.onPick(T, { model: 'sonnet', effort: 'low' }, META);
    s.engine.onIdleCheck(T);
    expect(s.writes).toHaveLength(0);
    s.engine.clearHalt(T);
    s.engine.onIdleCheck(T);
    expect(s.writes).toEqual([['claude', '/effort low\r']]);
  });

  it('not-applied notifies exactly once regardless of awayMode', () => {
    for (const away of [true, false]) {
      const s = setup();
      s.awayMode.mockReturnValue(away);
      s.engine.onPick(T, HIGH, META);
      s.engine.onIdleCheck(T);
      s.engine.reportOutcome(T, 'not-applied', null);
      s.engine.reportOutcome(T, 'not-applied', null);
      expect(s.notifyFailure).toHaveBeenCalledTimes(1);
    }
  });

  it('confirmed sets lastConfirmed and clears pendingStepDown', () => {
    const s = setup({ usage: 72 });
    s.engine.onPick(T, { model: 'sonnet', effort: 'low' }, { ...META, trigger: 'budget', source: 'auto' });
    s.engine.onIdleCheck(T);
    expect(s.records.get(T)?.pendingStepDown).toBe(true);
    s.engine.reportOutcome(T, 'confirmed');
    expect(s.records.get(T)?.lastConfirmed?.effort).toBe('low');
    expect(s.records.get(T)?.pendingStepDown).toBe(false);
  });

  it('sent without readback reads as unconfirmed, never applied', () => {
    const s = setup();
    s.engine.onPick(T, HIGH, META);
    s.engine.onIdleCheck(T);
    expect(s.engine.readoutState(T)).toBe('unconfirmed');
  });

  it('never writes to the codex slot or an unmapped thread', () => {
    for (const slot of ['codex', null] as const) {
      const s = setup({ slot });
      s.engine.onPick(T, HIGH, META);
      s.engine.onIdleCheck(T);
      expect(s.writes).toHaveLength(0);
    }
  });

  it('non-idle readings write nothing; a following idle writes exactly once', () => {
    const s = setup();
    s.engine.onPick(T, HIGH, META);
    for (const r of ['busy', 'picker', 'modal', 'switch-model-modal', 'draft', 'unknown', 'generating'] as const) {
      s.state.reading = r;
      s.engine.onIdleCheck(T);
    }
    expect(s.writes).toHaveLength(0);
    s.state.reading = 'idle';
    s.engine.onIdleCheck(T);
    s.engine.onIdleCheck(T);
    expect(s.writes).toHaveLength(1);
  });

  it('the default stub reading writes zero bytes', () => {
    expect(unknownIdle('claude')).toBe('unknown');
  });

  it('mid-turn: budget step-down writes, non-budget does not', () => {
    const s = setup({ reading: 'generating', usage: 72 });
    s.engine.onPick(T, { model: 'sonnet', effort: 'low' }, { ...META, trigger: 'miss' });
    s.engine.onIdleCheck(T);
    expect(s.writes).toHaveLength(0);
    const b = setup({ reading: 'generating', usage: 72 });
    b.engine.onPick(T, { model: 'sonnet', effort: 'low' }, { ...META, trigger: 'budget', source: 'auto' });
    b.engine.onIdleCheck(T);
    expect(b.writes).toEqual([['claude', '/effort low\r']]);
  });

  it('re-runs the budget on the queued pick and reads only its effort', () => {
    const s = setup({ usage: 91 });
    s.engine.onPick(T, { model: 'opus', effort: 'high' }, { ...META, trigger: 'think-harder', source: 'auto' });
    s.engine.onIdleCheck(T);
    expect(s.writes).toEqual([['claude', '/effort low\r']]);
  });

  function liveAs(s: ReturnType<typeof setup>, model: 'opus' | 'haiku', effort: 'high' | 'low') {
    s.records.set(T, markLaunched(newRecord(T, { model, effort }, { reason: 'x', trigger: 'new-thread', source: 'auto' }), {
      model, effort, resume: false, reasonSuffix: '', budgetLevel: 'none',
    }));
  }

  it('a hybrid auto repick is budgeted against the live model (floor)', () => {
    const s = setup({ usage: 95 });
    liveAs(s, 'opus', 'high');
    s.engine.onPick(T, { model: 'sonnet', effort: 'medium' }, { ...META, trigger: 'budget', source: 'auto' });
    s.engine.onIdleCheck(T);
    expect(s.writes).toEqual([['claude', '/effort low\r']]);
  });

  it('a hybrid auto repick at the step level steps one rung from the desired pick (opus/high -> sonnet/high, effort unchanged)', () => {
    const s = setup({ usage: 72 });
    liveAs(s, 'opus', 'high');
    s.engine.onPick(T, { model: 'sonnet', effort: 'medium' }, { ...META, trigger: 'budget', source: 'auto' });
    expect(s.engine.onIdleCheck(T)).toBe('skipped');
    expect(s.writes).toEqual([]);
    expect(s.records.get(T)?.queue).toBeNull();
  });

  it('a budget-lowered effort equal to the live effort writes nothing but clears the queue', () => {
    const s = setup({ usage: 95 });
    liveAs(s, 'haiku', 'low');
    s.engine.onPick(T, { model: 'sonnet', effort: 'medium' }, { ...META, trigger: 'budget', source: 'auto' });
    expect(s.engine.onIdleCheck(T)).toBe('skipped');
    expect(s.writes).toHaveLength(0);
    expect(s.records.get(T)?.queue).toBeNull();
  });

  it('manual non-ladder picks are not lowered by the budget', () => {
    const s = setup({ usage: 91 });
    s.engine.onPick(T, { model: 'sonnet', effort: 'xhigh' }, META);
    s.engine.onIdleCheck(T);
    expect(s.writes).toEqual([['claude', '/effort xhigh\r']]);
  });

  it('xhigh/max are written live only for a manual source; an auto pick never reaches them', () => {
    const s = setup();
    s.engine.onPick(T, { model: 'sonnet', effort: 'max' }, META);
    s.engine.onIdleCheck(T);
    expect(s.writes).toEqual([['claude', '/effort max\r']]);
    for (const effort of ['xhigh', 'max'] as const) {
      const a = setup();
      expect(a.engine.onPick(T, { model: 'sonnet', effort }, { ...META, source: 'auto' }).rejected).not.toBeNull();
      a.engine.onIdleCheck(T);
      expect(a.writes).toEqual([]);
    }
  });

  it('a rejected auto pick queues nothing and logs nothing', () => {
    const s = setup();
    const r = s.engine.onPick(T, { model: 'sonnet', effort: 'max' }, { ...META, source: 'auto' });
    expect(r.rejected).not.toBeNull();
    expect(s.logs).toHaveLength(0);
    s.engine.onIdleCheck(T);
    expect(s.writes).toHaveLength(0);
  });
});

describe('applyEngine: queued effort needs a live thread (F2)', () => {
  const exited = (s: ReturnType<typeof setup>) => {
    s.records.set(T, markExited(s.records.get(T)!));
  };

  it('a not-live record gets no write and keeps its queue', () => {
    const s = setup();
    s.engine.onPick(T, HIGH, META);
    exited(s);
    const before = s.records.get(T);
    expect(before?.queue).not.toBeNull();
    expect(s.engine.onIdleCheck(T)).toBe('skipped');
    expect(s.writes).toEqual([]);
    expect(s.records.get(T)).toEqual(before);
  });

  it('a not-live record whose queue equals the running effort keeps the queue (no-op path)', () => {
    const s = setup({ usage: 95 });
    s.engine.onPick(T, { model: 'sonnet', effort: 'medium' }, { ...META, trigger: 'budget', source: 'auto' });
    s.records.set(T, { ...s.records.get(T)!, launched: { model: 'sonnet', effort: 'low' }, queue: { pick: { model: 'sonnet', effort: 'medium' }, reason: 'b', trigger: 'budget', source: 'auto', queuedAt: 1 } });
    exited(s);
    const before = s.records.get(T);
    expect(s.engine.onIdleCheck(T)).toBe('skipped');
    expect(s.writes).toEqual([]);
    expect(s.records.get(T)?.queue).toEqual(before?.queue);
  });
});

describe('applyEngine: budget write is one step from the desired pick (G1)', () => {
  const BUDGET = { reason: 'b', trigger: 'budget' as const, source: 'auto' as const };
  function autoHigh(usage: number, lastBudgetLevel: BudgetLevel = 'none') {
    const s = setup({ usage });
    s.records.set(T, { ...s.records.get(T)!, intended: HIGH, launched: HIGH, lastBudgetLevel });
    return s;
  }

  it('usage 72 with the policy sonnet/medium budget pick writes /effort medium, not low', () => {
    const s = autoHigh(72);
    s.engine.onPick(T, { model: 'sonnet', effort: 'medium' }, BUDGET);
    expect(s.engine.onIdleCheck(T)).toBe('sent');
    expect(s.writes).toEqual([['claude', '/effort medium\r']]);
    expect(s.records.get(T)?.intended).toEqual(HIGH);
  });

  it('across 70/75/90 and hysteresis the write equals applyBudget(desired, usage) exactly once', () => {
    let checked = 0;
    for (const prev of ['none', 'step', 'floor'] as const) {
      for (const pct of [0, 64, 65, 69, 70, 72, 74, 75, 79, 85, 89, 90, 95, 100]) {
        const s = autoHigh(pct, prev);
        const want = applyBudget(HIGH, { sessionPct: pct, weekPct: 0 }, 'auto', prev).pick;
        s.engine.onPick(T, want, BUDGET);
        if (want.effort === HIGH.effort) { expect(s.records.get(T)?.queue).toBeNull(); continue; }
        expect(s.engine.onIdleCheck(T)).toBe('sent');
        expect(s.writes).toEqual([['claude', `/effort ${want.effort}\r`]]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe('applyEngine: a reported apply failure reconciles the live baseline (G2)', () => {
  it('not-applied with an actual pick sets launched to it, keeps intended, and a retry queues again', () => {
    const s = setup();
    s.engine.onPick(T, HIGH, META);
    expect(s.engine.onIdleCheck(T)).toBe('sent');
    expect(s.records.get(T)?.launched?.effort).toBe('high');
    s.engine.reportOutcome(T, 'not-applied', { model: 'sonnet', effort: 'medium' });
    expect(s.records.get(T)?.launched).toEqual({ model: 'sonnet', effort: 'medium' });
    expect(s.records.get(T)?.intended).toEqual(HIGH);
    s.engine.clearHalt(T);
    s.engine.onPick(T, HIGH, META);
    expect(s.records.get(T)?.queue?.pick.effort).toBe('high');
    expect(s.engine.onIdleCheck(T)).toBe('sent');
    expect(s.writes).toHaveLength(2);
  });

  it('an invalid actual pick is ignored and launched stays as it was', () => {
    const s = setup();
    s.engine.onPick(T, HIGH, META);
    s.engine.onIdleCheck(T);
    s.engine.reportOutcome(T, 'not-applied', { model: 'fable', effort: 'ultra' } as unknown as Pick);
    expect(s.records.get(T)?.launched).toEqual(HIGH);
  });
});

describe('applyEngine: a sent write keeps a held model pick visible (H2)', () => {
  it('manual opus/high on sonnet/medium: after the effort write the readout is still queuedModel', () => {
    const s = setup();
    s.engine.onPick(T, { model: 'opus', effort: 'high' }, META);
    expect(s.engine.readoutState(T)).toBe('queued');
    expect(s.engine.onIdleCheck(T)).toBe('sent');
    expect(s.records.get(T)?.modelPending).toBe('opus');
    expect(s.engine.readoutState(T)).toBe('queuedModel');
  });

  it('with nothing held, a sent write still reads unconfirmed', () => {
    const s = setup();
    s.engine.onPick(T, HIGH, META);
    s.engine.onIdleCheck(T);
    expect(s.engine.readoutState(T)).toBe('unconfirmed');
  });
});

describe('applyEngine: budget hysteresis survives the engine writes (H3)', () => {
  it('real policy over 0,72,76,91,86,71,66,65,64,0 follows T2 thresholds', () => {
    const s = setup();
    s.records.set(T, { ...s.records.get(T)!, intended: HIGH, launched: HIGH });
    const seen: string[] = [];
    for (const pct of [0, 72, 76, 91, 86, 71, 66, 65, 64, 0]) {
      s.state.usage = pct;
      const r = s.records.get(T)!;
      const want = applyBudget({ model: 'sonnet', effort: r.intended.effort }, { sessionPct: pct, weekPct: 0 }, 'auto', r.lastBudgetLevel).pick;
      s.engine.onPick(T, want, { reason: 'b', trigger: 'budget', source: 'auto' });
      s.engine.onIdleCheck(T);
      seen.push(s.records.get(T)!.launched!.effort);
    }
    expect(seen).toEqual(['high', 'medium', 'medium', 'low', 'low', 'medium', 'medium', 'medium', 'high', 'high']);
  });
});

describe('applyEngine: consuming a no-op queue releases pending ownership (round 3)', () => {
  it('manual high sent, medium queued, high reported not applied (actual medium), halt cleared: the no-op clear drops pendingSource and an auto pick queues', () => {
    const s = setup();
    s.engine.onPick(T, HIGH, META);
    expect(s.engine.onIdleCheck(T)).toBe('sent');
    s.engine.onPick(T, { model: 'sonnet', effort: 'medium' }, META);
    expect(s.records.get(T)?.pendingSource).toBe('manual');
    s.engine.reportOutcome(T, 'not-applied', { model: 'sonnet', effort: 'medium' });
    s.engine.clearHalt(T);
    expect(s.engine.onIdleCheck(T)).toBe('skipped');
    const r = s.records.get(T)!;
    expect(r.queue).toBeNull();
    expect(r.pendingSource).toBeNull();
    const res = s.engine.onPick(T, HIGH, { reason: 'm', trigger: 'miss', source: 'auto' });
    expect(res.rejected).toBeNull();
    expect(s.records.get(T)?.queue?.pick.effort).toBe('high');
  });
});
