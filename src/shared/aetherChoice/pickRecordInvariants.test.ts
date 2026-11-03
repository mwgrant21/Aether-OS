// Invariants I1-I5 of the AetherChoice pick-record state model, each with a direct test and
// each asserted inside one seeded randomized sweep over the real record functions + apply engine.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApplyEngine } from '../../../electron/aetherChoice/applyEngine';
import type { IdleReading } from '../../../electron/aetherChoice/applyEngine';
import { loadPicks, savePicks } from '../../../electron/aetherChoice/pickStore';
import { markExited, markLaunched, newRecord, planLaunch } from './pickRecord';
import type { LaunchPlan, ThreadPickRecord } from './pickRecord';
import { LAUNCH_EFFORTS, MODEL_ALIASES } from './types';
import type { ModelAlias, Pick, PickSource, PickTrigger } from './types';

const T = 't1';
const LOW0 = { sessionPct: 0, weekPct: 0 };
const HI = { sessionPct: 95, weekPct: 0 };
const AUTO = { reason: 'a', trigger: 'task-class', source: 'auto' } as const;
const WRITE_RE = /^\/effort (low|medium|high|xhigh|max)\r$/;

type Harness = ReturnType<typeof harness>;
function harness(start: ThreadPickRecord, init: { usage?: number; reading?: IdleReading } = {}) {
  const writes: string[] = [];
  const logs: string[] = [];
  const st = { rec: start, usage: init.usage ?? 0, reading: (init.reading ?? 'idle') as IdleReading };
  const engine = createApplyEngine({
    writePort: { write: (_s, d) => { writes.push(d); return true; } },
    slotFor: () => 'claude',
    idle: () => st.reading,
    now: () => 1_700_000_000_000,
    log: (l) => logs.push(l),
    notifyFailure: () => {},
    awayMode: () => false,
    usage: () => ({ sessionPct: st.usage, weekPct: 0 }),
    getRecord: () => st.rec,
    setRecord: (_id, r) => { st.rec = r; },
  });
  return { st, engine, writes, logs };
}
function launch(h: Harness, usage = LOW0): LaunchPlan {
  const plan = planLaunch(h.st.rec, usage) as LaunchPlan;
  h.st.rec = markLaunched(h.st.rec, plan);
  return plan;
}
const pk = (model: ModelAlias, effort: Pick['effort']): Pick => ({ model, effort });

describe('I1 recovery: budget lowering never changes intended', () => {
  it('engine path: budget write at 95% then exit then resume at 10% returns sonnet/high', () => {
    const h = harness(newRecord(T, pk('sonnet', 'high'), AUTO), { usage: 95 });
    launch(h);
    h.engine.onPick(T, pk('sonnet', 'low'), { reason: 'b', trigger: 'budget', source: 'auto' });
    expect(h.engine.onIdleCheck(T)).toBe('sent');
    expect(h.writes).toEqual(['/effort low\r']);
    expect(h.st.rec.launched).toEqual(pk('sonnet', 'low'));
    expect(h.st.rec.intended).toEqual(pk('sonnet', 'high'));
    h.st.rec = markExited(h.st.rec);
    expect(planLaunch(h.st.rec, LOW0)).toMatchObject({ model: 'sonnet', effort: 'high' });
  });

  it('launch path: a launch at 95% leaves intended; resume at 10% returns the desired pick', () => {
    const h = harness(newRecord(T, pk('opus', 'high'), AUTO));
    const plan = launch(h, HI);
    expect([plan.model, plan.effort]).toEqual(['haiku', 'low']);
    expect(h.st.rec.intended).toEqual(pk('opus', 'high'));
    h.st.rec = markExited(h.st.rec);
    expect(planLaunch(h.st.rec, LOW0)).toMatchObject({ model: 'opus', effort: 'high' });
  });

  it('a budget-queued effort is never folded into a resume plan or consumed as intent', () => {
    const h = harness(newRecord(T, pk('sonnet', 'high'), AUTO));
    launch(h);
    h.engine.onPick(T, pk('sonnet', 'low'), { reason: 'b', trigger: 'budget', source: 'auto' });
    expect(h.st.rec.queue?.trigger).toBe('budget');
    h.st.rec = markExited(h.st.rec);
    expect(planLaunch(h.st.rec, LOW0)).toMatchObject({ model: 'sonnet', effort: 'high' });
    launch(h, LOW0);
    expect(h.st.rec.intended).toEqual(pk('sonnet', 'high'));
  });

  it('a desired (non-budget) effort lowered by the engine keeps the desire in intended', () => {
    const h = harness(newRecord(T, pk('sonnet', 'medium'), AUTO), { usage: 95 });
    launch(h, LOW0);
    h.engine.onPick(T, pk('sonnet', 'high'), { reason: 'm', trigger: 'miss', source: 'auto' });
    h.engine.onIdleCheck(T);
    expect(h.writes).toEqual(['/effort low\r']);
    expect(h.st.rec.launched?.effort).toBe('low');
    expect(h.st.rec.intended.effort).toBe('high');
  });
});

describe('I2 baseline: launched equals what is running', () => {
  it('markLaunched sets launched to the plan; a write sets only launched.effort', () => {
    const h = harness(newRecord(T, pk('sonnet', 'high'), AUTO), { usage: 95 });
    launch(h, HI);
    expect(h.st.rec.launched).toEqual(pk('haiku', 'low'));
    h.engine.onPick(T, pk('opus', 'medium'), { reason: 'x', trigger: 'manual', source: 'manual' });
    h.st.usage = 0;
    h.engine.onIdleCheck(T);
    expect(h.st.rec.launched).toEqual(pk('haiku', 'medium'));
  });
});

describe('I3 manual is never silently reverted', () => {
  function lowered() {
    const h = harness(newRecord(T, pk('sonnet', 'high'), AUTO));
    launch(h, HI);
    return h;
  }
  const manual = (h: Harness, p: Pick) => h.engine.onPick(T, p, { reason: 'u', trigger: 'manual', source: 'manual' });

  it('(a) manual equal to the lowered running pick becomes intended', () => {
    const h = lowered();
    manual(h, pk('haiku', 'low'));
    const r = h.st.rec;
    expect(r.intended).toEqual(pk('haiku', 'low'));
    expect(r.source).toBe('manual');
    expect(r.queue).toBeNull();
    expect(r.modelPending).toBeNull();
    expect(planLaunch(markExited(r), LOW0)).toMatchObject({ model: 'haiku', effort: 'low' });
  });

  it('(b) manual haiku/medium: model equals launched so intended.model=haiku, effort queued', () => {
    const h = lowered();
    manual(h, pk('haiku', 'medium'));
    const r = h.st.rec;
    expect(r.intended.model).toBe('haiku');
    expect(r.modelPending).toBeNull();
    expect(r.queue?.pick.effort).toBe('medium');
    expect(r.source).toBe('manual');
    expect(planLaunch(markExited(r), LOW0)).toMatchObject({ model: 'haiku', effort: 'medium' });
  });

  it('a manual part that differs from launched stays pending as before', () => {
    const h = lowered();
    manual(h, pk('sonnet', 'high'));
    expect(h.st.rec.modelPending).toBe('sonnet');
    expect(h.st.rec.queue?.pick.effort).toBe('high');
    expect(h.st.rec.pendingSource).toBe('manual');
  });

  it('finding 2: a consumed manual opus/high on an auto sonnet/high thread stays opus/high at 95%', () => {
    const h = harness(newRecord(T, pk('sonnet', 'high'), AUTO));
    launch(h);
    manual(h, pk('opus', 'high'));
    h.st.rec = markExited(h.st.rec);
    launch(h, LOW0);
    h.st.rec = markExited(h.st.rec);
    expect(planLaunch(h.st.rec, HI)).toMatchObject({ model: 'opus', effort: 'high' });
  });
});

describe('I4 manual is never budget-lowered at planLaunch', () => {
  it('holds for source manual and for a manual pending pick', () => {
    const m = newRecord(T, pk('opus', 'high'), { ...AUTO, source: 'manual' });
    expect(planLaunch(m, HI)).toMatchObject({ model: 'opus', effort: 'high' });
    const h = harness(newRecord(T, pk('sonnet', 'high'), AUTO));
    launch(h);
    h.engine.onPick(T, pk('opus', 'high'), { reason: 'u', trigger: 'manual', source: 'manual' });
    expect(h.st.rec.pendingSource).toBe('manual');
    expect(planLaunch(markExited(h.st.rec), HI)).toMatchObject({ model: 'opus', effort: 'high' });
  });
});

describe('I5 fail-closed', () => {
  it('xhigh/max are written live only for a manual source; auto never reaches them', () => {
    const h = harness(newRecord(T, pk('sonnet', 'medium'), AUTO));
    launch(h);
    const auto = h.engine.onPick(T, pk('sonnet', 'xhigh'), { reason: 'a', trigger: 'miss', source: 'auto' });
    expect(auto.rejected).not.toBeNull();
    expect(h.engine.onIdleCheck(T)).toBe('skipped');
    h.engine.onPick(T, pk('sonnet', 'xhigh'), { reason: 'u', trigger: 'manual', source: 'manual' });
    expect(h.engine.onIdleCheck(T)).toBe('sent');
    expect(h.writes).toEqual(['/effort xhigh\r']);
  });
});

describe('log "from" is the running pick', () => {
  it('onPick logs launched, not intended', () => {
    const h = harness(newRecord(T, pk('sonnet', 'high'), AUTO));
    launch(h, HI);
    h.engine.onPick(T, pk('sonnet', 'high'), { reason: 'u', trigger: 'manual', source: 'manual' });
    expect(h.logs[0]).toContain(' haiku/low -> sonnet/high ');
  });
});

// ---- seeded randomized sweep ----
const SEED = 0xae7c0de1;
const SEQUENCES = 3000;
const OPS = 25;
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TRIGGERS: readonly PickTrigger[] = ['new-thread', 'miss', 'budget', 'task-class', 'think-harder', 'manual'];
const READINGS: readonly IdleReading[] = ['idle', 'idle', 'idle', 'generating', 'busy', 'unknown'];

const foldOf = (r: ThreadPickRecord): Pick => ({
  model: r.modelPending ?? r.intended.model,
  effort: r.queue && r.queue.trigger !== 'budget' ? r.queue.pick.effort : r.intended.effort,
});
const same = (a: Pick | null, b: Pick | null) => JSON.stringify(a) === JSON.stringify(b);

describe('randomized invariant sweep', () => {
  it(`holds I1-I5 over ${SEQUENCES} sequences x ${OPS} ops (seed 0x${SEED.toString(16)})`, async () => {
    const rand = rng(SEED);
    const int = (n: number) => Math.floor(rand() * n);
    const pick1 = <T>(l: readonly T[]): T => l[int(l.length)];
    const dir = mkdtempSync(join(tmpdir(), 'pickinv-'));
    let writesTotal = 0;
    let highWrites = 0;
    let manualLive = 0;
    let roundTrips = 0;
    let notLiveChecks = 0;
    try {
      for (let s = 0; s < SEQUENCES; s++) {
        const start = pk(pick1(MODEL_ALIASES), pick1(LAUNCH_EFFORTS));
        const startSrc: PickSource = start.effort === 'xhigh' || start.effort === 'max' || rand() < 0.4 ? 'manual' : 'auto';
        const h = harness(newRecord(T, start, { reason: 'n', trigger: 'new-thread', source: startSrc }));
        let desired: Pick = { ...start };
        let running: Pick | null = null;
        for (let o = 0; o < OPS; o++) {
          const rec0 = h.st.rec;
          const op = int(10);
          const where = `seq ${s} op ${o} (${op})`;
          if (op <= 3) {
            const source: PickSource = rand() < 0.5 ? 'auto' : 'manual';
            const trigger = source === 'manual' ? 'manual' : pick1(TRIGGERS);
            const p = pk(pick1(MODEL_ALIASES), pick1(source === 'manual' ? LAUNCH_EFFORTS : LAUNCH_EFFORTS.slice(0, 4)));
            const res = h.engine.onPick(T, p, { reason: 'r', trigger, source });
            const r = h.st.rec;
            if (res.rejected === null && !(source === 'auto' && trigger === 'budget')) desired = { ...p };
            if (source === 'manual' && res.rejected === null && (rec0.live || rec0.halted)) {
              manualLive++;
              expect(r.source, where).toBe('manual');
              const base = rec0.launched ?? rec0.intended;
              for (const part of ['model', 'effort'] as const) {
                if (p[part] === base[part]) {
                  expect(r.intended[part], where + ' I3 ' + part).toBe(p[part]);
                  if (part === 'model') expect(r.modelPending, where).toBeNull();
                  else expect(r.queue, where).toBeNull();
                }
              }
            }
            if (source === 'auto' && trigger === 'budget') expect(r.intended, where + ' I1 submit').toEqual(rec0.intended);
            // F1: an auto budget submit never touches a manual-sourced record or one with a pending manual pick.
            if (source === 'auto' && trigger === 'budget' && (rec0.source === 'manual' || rec0.pendingSource === 'manual')) {
              expect(r, where + ' F1 submit').toEqual(rec0);
            }
          } else if (op === 4 || op === 5) {
            if (!rec0.live) {
              const usage = { sessionPct: int(100), weekPct: int(100) };
              const plan = planLaunch(rec0, usage) as LaunchPlan;
              const fold = foldOf(rec0);
              const pendingNow = rec0.modelPending !== null || (rec0.queue !== null && rec0.queue.trigger !== 'budget');
              const manualNow = pendingNow ? rec0.pendingSource === 'manual' : rec0.source === 'manual';
              if (manualNow) expect([plan.model, plan.effort], where + ' I4').toEqual([fold.model, fold.effort]);
              h.st.rec = markLaunched(rec0, plan);
              running = { model: plan.model, effort: plan.effort };
              const r = h.st.rec;
              if (!pendingNow) expect(r.intended, where + ' I1 launch').toEqual(rec0.intended);
              expect(r.intended.model === rec0.intended.model || rec0.modelPending === r.intended.model, where).toBe(true);
            }
          } else if (op === 6) {
            if (rec0.live) h.st.rec = markExited(rec0);
          } else if (op <= 8) {
            h.st.usage = int(100);
            h.st.reading = pick1(READINGS);
            if (!rec0.live) {
              // F2: a not-live record gets no write and no queue change at any reading.
              const before = h.writes.length;
              expect(h.engine.onIdleCheck(T), where + ' F2').toBe('skipped');
              expect(h.writes.length, where + ' F2 writes').toBe(before);
              expect(h.st.rec, where + ' F2 record').toEqual(rec0);
              notLiveChecks++;
            }
            if (rec0.live) {
              const before = h.writes.length;
              const result = h.engine.onIdleCheck(T);
              const r = h.st.rec;
              if (result === 'sent') {
                writesTotal++;
                const bytes = h.writes[h.writes.length - 1];
                expect(bytes, where).toMatch(WRITE_RE);
                if (/xhigh|max/.test(bytes)) {
                  highWrites++;
                  // xhigh/max are manual-only: only a manual-sourced queued pick can carry them.
                  expect(rec0.queue?.source, where + ' I5 manual-only effort').toBe('manual');
                }
                running = { model: (rec0.launched ?? rec0.intended).model, effort: bytes.slice(8, -1) as Pick['effort'] };
                if (rec0.queue?.trigger === 'budget') expect(r.intended, where + ' I1 idle').toEqual(rec0.intended);
              } else {
                expect(h.writes.length, where).toBe(before);
              }
            }
          } else if (rec0.live) {
            h.engine.reportOutcome(T, rand() < 0.7 ? 'confirmed' : 'not-applied', null);
          }
          const r = h.st.rec;
          // F1: a manual-sourced record (or one with a pending manual pick) never carries a budget queue.
          if (r.queue?.trigger === 'budget') {
            expect(r.source, where + ' F1 source').toBe('auto');
            expect(r.pendingSource, where + ' F1 pendingSource').not.toBe('manual');
          }
          // I2: launched is exactly what is running.
          expect(r.launched, where + ' I2').toEqual(running);
          // I1: the desired pick is always recoverable at low usage.
          const back = planLaunch(r, LOW0) as LaunchPlan;
          expect([back.model, back.effort], where + ' I1 recovery').toEqual([desired.model, desired.effort]);
          // I5: no fable/ultra anywhere; models are launchable aliases.
          const json = JSON.stringify(r);
          expect(/fable|ultra/i.test(json), where + ' I5 names').toBe(false);
          expect((MODEL_ALIASES as readonly string[]).includes(r.intended.model), where).toBe(true);
          if (r.launched) expect((LAUNCH_EFFORTS as readonly string[]).includes(r.launched.effort), where).toBe(true);
        }
        for (const w of h.writes) expect(w).toMatch(WRITE_RE);
        // I5: save/load of the reachable record is identity (sampled).
        if (s % 10 === 0) {
          await savePicks(dir, { [T]: h.st.rec });
          expect(loadPicks(dir)[T]).toEqual(h.st.rec);
          roundTrips++;
        }
        expect(same(h.st.rec.launched, running)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Guard against a vacuous sweep.
    expect(writesTotal).toBeGreaterThan(300);
    expect(highWrites).toBeGreaterThan(0);
    expect(manualLive).toBeGreaterThan(1000);
    expect(roundTrips).toBe(SEQUENCES / 10);
    expect(notLiveChecks).toBeGreaterThan(300);
  }, 120_000);
});
