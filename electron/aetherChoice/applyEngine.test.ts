import { describe, expect, it, vi } from 'vitest';
import type { TerminalSlotId } from '../../src/shared/remote/types';
import type { Pick } from '../../src/shared/aetherChoice/types';
import { markLaunched, newRecord } from '../../src/shared/aetherChoice/pickRecord';
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

  it('a hybrid auto repick at the step level steps down from the live rung', () => {
    const s = setup({ usage: 72 });
    liveAs(s, 'opus', 'high');
    s.engine.onPick(T, { model: 'sonnet', effort: 'medium' }, { ...META, trigger: 'budget', source: 'auto' });
    s.engine.onIdleCheck(T);
    expect(s.writes).toEqual([['claude', '/effort medium\r']]);
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
