// Invariants I1-I5 of the AetherChoice pick-record state model, each with a direct test and
// each asserted inside one seeded randomized sweep over the real record functions + apply engine.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApplyEngine } from '../../../electron/aetherChoice/applyEngine';
import type { IdleReading } from '../../../electron/aetherChoice/applyEngine';
import { loadPicks, savePicks } from '../../../electron/aetherChoice/pickStore';
import { clearHalt, deriveReadoutState, markExited, markLaunched, newRecord, planLaunch, submitPick } from './pickRecord';
import { LADDER_RUNGS, applyBudget } from './pickPolicy';
import type { LaunchPlan, ThreadPickRecord } from './pickRecord';
import { LAUNCH_EFFORTS, MODEL_ALIASES } from './types';
import type { IdleReading as SharedIdleReading, ModelAlias, Pick, PickSource, PickTrigger } from './types';

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
    minWriteGapMs: 0,
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
// 'idle' is repeated so the idle share stays at least what it was with the original four non-idle readings.
const READINGS: readonly SharedIdleReading[] = [
  'idle', 'idle', 'idle', 'idle', 'idle', 'idle', 'idle', 'generating', 'busy', 'unknown', 'shell', 'draft', 'picker', 'modal', 'switch-model-modal',
];

const foldOf = (r: ThreadPickRecord): Pick => ({
  model: r.modelPending ?? r.intended.model,
  effort: r.queue && r.queue.trigger !== 'budget' ? r.queue.pick.effort : r.intended.effort,
});
// H3: reaching the desired effort from a lowered rung needs usage below the hysteresis band
// (65, or 70 when the last level was none). Only meaningful when the desired pick has a rung to step down to.
const reachedDesireNeedsBand = (base: Pick, desired: Pick, written: string, level: string, usage: number): boolean | null => {
  const idx = LADDER_RUNGS.findIndex((r) => r.model === base.model && r.effort === desired.effort);
  const ord = LAUNCH_EFFORTS as readonly string[];
  // A step that changes only the model leaves the effort equal to the desired one; that is not a step-up.
  if (idx <= 0 || LADDER_RUNGS[idx - 1].effort === desired.effort || written !== desired.effort || ord.indexOf(written) <= ord.indexOf(base.effort)) return null;
  return usage < (level === 'none' ? 70 : 65);
};
const same = (a: Pick | null, b: Pick | null) => JSON.stringify(a) === JSON.stringify(b);

describe('randomized invariant sweep', () => {
  it(`holds I1-I5 and G1-G3 over ${SEQUENCES} sequences x ${OPS} ops (seed 0x${SEED.toString(16)})`, async () => {
    const rand = rng(SEED);
    const int = (n: number) => Math.floor(rand() * n);
    const pick1 = <T>(l: readonly T[]): T => l[int(l.length)];
    const dir = mkdtempSync(join(tmpdir(), 'pickinv-'));
    let writesTotal = 0;
    let highWrites = 0;
    let manualLive = 0;
    let roundTrips = 0;
    let notLiveChecks = 0;
    let g1Checks = 0;
    let g2Checks = 0;
    let g2Retries = 0;
    let g3Checks = 0;
    let h1Trips = 0;
    let h2Checks = 0;
    let h3Checks = 0;
    let ownerChecks = 0;
    let ownerRetries = 0;
    let haltedPlanChecks = 0;
    let queueModelChecks = 0;
    let launchHookChecks = 0;
    let exitHookChecks = 0;
    let deadSentChecks = 0;
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
            // G3: an accepted pick that leaves something pending reads as pending, never as a stale sent.
            if (res.rejected === null && r !== rec0 && rec0.live && !r.halted && (r.queue || r.modelPending)) {
              expect(['queued', 'queuedModel'], where + ' G3').toContain(deriveReadoutState(r, { hasReadback: false }));
              g3Checks++;
            }
            // F1: an auto budget submit never touches a manual-sourced record or one with a pending manual pick.
            if (source === 'auto' && trigger === 'budget' && (rec0.source === 'manual' || rec0.pendingSource === 'manual')) {
              expect(r, where + ' F1 submit').toEqual(rec0);
            }
          } else if (op === 4 || op === 5) {
            if (!rec0.live && rec0.halted) {
              // A halted thread gets no launch plan until an explicit clear.
              expect(planLaunch(rec0, { sessionPct: int(100), weekPct: int(100) }), where + ' halted plan').toEqual({ error: 'halted' });
              expect(h.st.rec, where + ' halted plan record').toBe(rec0);
              haltedPlanChecks++;
            } else if (!rec0.live) {
              const usage = { sessionPct: int(100), weekPct: int(100) };
              const plan = planLaunch(rec0, usage) as LaunchPlan;
              const fold = foldOf(rec0);
              const pendingNow = rec0.modelPending !== null || (rec0.queue !== null && rec0.queue.trigger !== 'budget');
              const manualNow = pendingNow ? rec0.pendingSource === 'manual' : rec0.source === 'manual';
              if (manualNow) expect([plan.model, plan.effort], where + ' I4').toEqual([fold.model, fold.effort]);
              const writesBefore = h.writes.length;
              h.engine.onLaunched(T, plan);
              running = { model: plan.model, effort: plan.effort };
              const r = h.st.rec;
              // T7b: the hook marks live, never masks a held pick with sent, mirrors the budget level, writes nothing.
              expect(r.live, where + ' launch live').toBe(true);
              expect(r.outcome, where + ' launch outcome').toBe(r.queue === null && r.modelPending === null ? 'sent' : 'none');
              expect(r.pendingStepDown, where + ' launch pendingStepDown').toBe(plan.budgetLevel !== 'none');
              expect(r.halted, where + ' launch halted').toBe(rec0.halted);
              expect(h.writes.length, where + ' launch writes').toBe(writesBefore);
              launchHookChecks++;
              if (!pendingNow) expect(r.intended, where + ' I1 launch').toEqual(rec0.intended);
              expect(r.intended.model === rec0.intended.model || rec0.modelPending === r.intended.model, where).toBe(true);
            }
          } else if (op === 6) {
            if (rec0.live) {
              const writesBefore = h.writes.length;
              h.engine.onExited(T);
              const r = h.st.rec;
              expect(r.live, where + ' exit live').toBe(false);
              expect(r.queue, where + ' exit queue').toEqual(rec0.queue);
              expect(r.modelPending, where + ' exit modelPending').toBe(rec0.modelPending);
              expect(r.halted, where + ' exit halted').toBe(rec0.halted);
              expect(h.writes.length, where + ' exit writes').toBe(writesBefore);
              exitHookChecks++;
            }
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
              let rec1 = rec0;
              // Policy-shaped budget submit: the one-rung step from the desired pick at the current usage.
              if (rand() < 0.6) {
                const b0 = rec1.launched ?? rec1.intended;
                const step = applyBudget({ model: b0.model, effort: rec1.intended.effort }, { sessionPct: h.st.usage, weekPct: 0 }, 'auto', rec1.lastBudgetLevel).pick;
                h.engine.onPick(T, step, { reason: 'b', trigger: 'budget', source: 'auto' });
              }
              rec1 = h.st.rec;
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
                  expect(rec1.queue?.source, where + ' I5 manual-only effort').toBe('manual');
                }
                running = { model: (rec1.launched ?? rec1.intended).model, effort: bytes.slice(8, -1) as Pick['effort'] };
                if (rec1.queue?.trigger === 'budget') {
                  expect(r.intended, where + ' I1 idle').toEqual(rec1.intended);
                  // G1: a budget-triggered write is applyBudget of the desired pick, applied exactly once.
                  const base = rec1.launched ?? rec1.intended;
                  const want = applyBudget(
                    { model: base.model, effort: rec1.intended.effort },
                    { sessionPct: h.st.usage, weekPct: 0 },
                    rec1.queue.source,
                    rec1.lastBudgetLevel,
                  ).pick.effort;
                  expect(bytes, where + ' G1').toBe('/effort ' + want + String.fromCharCode(13));
                  g1Checks++;
                  // H3: no step-up while the hysteresis band (or the 70 threshold) still holds the level.
                  const band = reachedDesireNeedsBand(base, rec1.intended, bytes.slice(8, -1), rec1.lastBudgetLevel, h.st.usage);
                  if (band !== null) {
                    expect(band, where + ' H3').toBe(true);
                    h3Checks++;
                  }
                }
              } else {
                expect(h.writes.length, where).toBe(before);
              }
            }
          } else if (rec0.halted && rand() < 0.5) {
            h.engine.clearHalt(T);
          } else if (rec0.live) {
            const notApplied = rand() >= 0.7;
            const bad = [{ model: 'fable', effort: 'low' }, { model: 'sonnet', effort: 'ultra' }, { model: 'opus', effort: 'max', extra: 1 }];
            const actual = (notApplied && rand() < 0.5
              ? rand() < 0.3 ? pick1(bad) : pk(pick1(MODEL_ALIASES), pick1(LAUNCH_EFFORTS))
              : null) as Pick | null;
            const valid = actual !== null && (MODEL_ALIASES as readonly string[]).includes(actual.model) && (LAUNCH_EFFORTS as readonly string[]).includes(actual.effort);
            h.engine.reportOutcome(T, notApplied ? 'not-applied' : 'confirmed', actual);
            if (notApplied && actual && !rec0.halted) {
              // G2: the reported actual pick becomes the baseline; the desire is kept and can be retried.
              const r = h.st.rec;
              const want = valid ? { model: actual.model, effort: actual.effort } : rec0.launched;
              expect(r.launched, where + ' G2 launched').toStrictEqual(want);
              expect(r.halted?.actual ?? null, where + ' H1 halted.actual').toStrictEqual(valid ? want : null);
              expect(r.intended, where + ' G2 intended').toEqual(rec0.intended);
              running = want ? { ...want } : null;
              g2Checks++;
              // H1: a halted record survives save/load unchanged, whatever the report carried.
              await savePicks(dir, { [T]: r });
              expect(loadPicks(dir)[T], where + ' H1 round trip').toEqual(r);
              h1Trips++;
              if (valid && !same(r.intended, want)) {
                const retry = submitPick(clearHalt(r), r.intended, { reason: 'r', trigger: 'manual', source: 'manual', now: 1 });
                expect(retry.record.queue !== null || retry.record.modelPending !== null, where + ' G2 retry').toBe(true);
                g2Retries++;
              }
            }
          }
          const r = h.st.rec;
          // F1: a manual-sourced record (or one with a pending manual pick) never carries a budget queue.
          if (r.queue?.trigger === 'budget') {
            expect(r.source, where + ' F1 source').toBe('auto');
            expect(r.pendingSource, where + ' F1 pendingSource').not.toBe('manual');
          }
          // Ownership: pendingSource exists only while a queue or a held model remains; with nothing
          // pending, an auto pick must queue normally instead of losing to a phantom manual owner.
          if (r.queue === null && r.modelPending === null) {
            expect(r.pendingSource, where + ' stale pendingSource').toBeNull();
            ownerChecks++;
            if (r.live && !r.halted) {
              const eff = r.launched?.effort === 'low' ? 'medium' : 'low';
              const probe = submitPick(r, { model: (r.launched ?? r.intended).model, effort: eff }, { reason: 'p', trigger: 'miss', source: 'auto', now: 1 });
              expect(probe.rejected, where + ' auto pick rejected').toBeNull();
              ownerRetries++;
            }
          }
          // Q: a queued pick names the model that is running (or intended, before any launch).
          if (r.queue !== null) {
            expect(r.queue.pick.model, where + ' Q queue model').toBe((r.launched ?? r.intended).model);
            queueModelChecks++;
          }
          // H2: a held model pick is never masked by a sent outcome.
          if (r.modelPending && !r.halted) {
            expect(['queued', 'queuedModel'], where + ' H2').toContain(deriveReadoutState(r, { hasReadback: false }));
            h2Checks++;
          }
          // T7b: a dead thread never reads as sent, in any order of launch, exit and clearHalt.
          if (!r.live) {
            expect(r.outcome, where + ' dead outcome').not.toBe('sent');
            deadSentChecks++;
          }
          // I2: launched is exactly what is running.
          expect(r.launched, where + ' I2').toEqual(running);
          // I1: the desired pick is always recoverable at low usage.
          const back = planLaunch(r.halted ? clearHalt(r) : r, LOW0) as LaunchPlan;
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
    expect(g1Checks, 'G1 checks').toBeGreaterThan(30);
    expect(g2Checks, 'G2 checks').toBeGreaterThan(300);
    expect(g2Retries, 'G2 retries').toBeGreaterThan(300);
    expect(g3Checks, 'G3 checks').toBeGreaterThan(300);
    expect(h1Trips, 'H1 round trips').toBeGreaterThan(300);
    expect(h2Checks, 'H2 checks').toBeGreaterThan(300);
    expect(h3Checks, 'H3 checks').toBeGreaterThan(0);
    expect(ownerChecks, 'ownership checks').toBeGreaterThan(300);
    expect(ownerRetries, 'ownership probes').toBeGreaterThan(300);
    expect(haltedPlanChecks, 'halted plan checks').toBeGreaterThan(100);
    expect(queueModelChecks, 'queue model checks').toBeGreaterThan(300);
    expect(launchHookChecks, 'launch hook checks').toBeGreaterThan(300);
    expect(exitHookChecks, 'exit hook checks').toBeGreaterThan(300);
    expect(deadSentChecks, 'dead record checks').toBeGreaterThan(300);
  }, 120_000);
});

// Auto records are a minority of the main sweep (any manual pick sticks), so G1 also gets its own
// seeded sweep over auto-sourced threads whose usage crosses the 70/75/90 thresholds and hysteresis band.
describe('G1 budget sweep: one threshold crossing is one step', () => {
  it('every budget-triggered write equals applyBudget(desired, usage) over 1500 sequences x 20 ops', () => {
    const rand = rng(SEED ^ 0x9e3779b1);
    const int = (n: number) => Math.floor(rand() * n);
    let checks = 0;
    let stepUps = 0;
    for (let s = 0; s < 1500; s++) {
      const h = harness(newRecord(T, pk(['haiku', 'sonnet', 'opus'][int(3)] as ModelAlias, ['low', 'medium', 'high'][int(3)] as Pick['effort']), AUTO));
      launch(h);
      for (let o = 0; o < 20; o++) {
        const where = 'g1 seq ' + s + ' op ' + o;
        h.st.usage = [0, 30, 64, 66, 69, 70, 72, 75, 80, 88, 90, 95][int(12)];
        h.st.reading = 'idle';
        if (!h.st.rec.live) { launch(h, { sessionPct: h.st.usage, weekPct: 0 }); continue; }
        if (rand() < 0.2) h.engine.onPick(T, pk(['haiku', 'sonnet', 'opus'][int(3)] as ModelAlias, ['low', 'medium', 'high'][int(3)] as Pick['effort']), AUTO);
        const r0 = h.st.rec;
        const b0 = r0.launched ?? r0.intended;
        const step = applyBudget({ model: b0.model, effort: r0.intended.effort }, { sessionPct: h.st.usage, weekPct: 0 }, 'auto', r0.lastBudgetLevel).pick;
        h.engine.onPick(T, step, { reason: 'b', trigger: 'budget', source: 'auto' });
        const r1 = h.st.rec;
        const before = h.writes.length;
        if (h.engine.onIdleCheck(T) === 'sent' && r1.queue?.trigger === 'budget') {
          const want = applyBudget({ model: b0.model, effort: r1.intended.effort }, { sessionPct: h.st.usage, weekPct: 0 }, 'auto', r1.lastBudgetLevel).pick.effort;
          expect(h.writes[before], where).toBe('/effort ' + want + String.fromCharCode(13));
          checks++;
          const band = reachedDesireNeedsBand(b0, r1.intended, h.writes[before].slice(8, -1), r1.lastBudgetLevel, h.st.usage);
          if (band !== null) {
            expect(band, where + ' H3').toBe(true);
            stepUps++;
          }
        }
        if (rand() < 0.15) h.st.rec = markExited(h.st.rec);
      }
    }
    expect(checks).toBeGreaterThan(300);
    expect(stepUps, 'H3 step-ups').toBeGreaterThan(100);
  }, 120_000);
});
