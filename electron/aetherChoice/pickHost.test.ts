// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createPickHost } from './pickHost';
import type { OwnedSlot, PickHost, PickHostDeps } from './pickHost';
import { newRecord } from '../../src/shared/aetherChoice/pickRecord';
import type { ThreadPickRecord } from '../../src/shared/aetherChoice/pickRecord';
import type { IdleReading, Pick } from '../../src/shared/aetherChoice/types';
import type { FailureInfo } from './applyEngine';

const SID = '123e4567-e89b-42d3-a456-426614174000';
const SONNET_MED: Pick = { model: 'sonnet', effort: 'medium' };
const HIGH: Pick = { model: 'sonnet', effort: 'high' };
const LOW: Pick = { model: 'sonnet', effort: 'low' };

const blank = (id: string): ThreadPickRecord =>
  newRecord(id, SONNET_MED, { reason: 'default', trigger: 'new-thread', source: 'auto' });

type Rig = {
  host: PickHost;
  t: { now: number };
  writes: { slot: string; d: string }[];
  saves: Record<string, ThreadPickRecord>[];
  logs: string[];
  failures: FailureInfo[];
  scheduled: { fn: () => void; ms: number; cancelled: boolean }[];
  scheduleCalls: () => number;
  reading: { v: IdleReading };
  reads: () => number;
  runNext: () => Promise<void>;
  last: () => Promise<Record<string, ThreadPickRecord>>;
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function rig(o: { loaded?: Record<string, ThreadPickRecord>; deps?: Partial<PickHostDeps> } = {}): Rig {
  const t = { now: 1_000_000 };
  const writes: Rig['writes'] = [];
  const saves: Rig['saves'] = [];
  const logs: string[] = [];
  const failures: FailureInfo[] = [];
  const scheduled: Rig['scheduled'] = [];
  const reading = { v: 'idle' as IdleReading };
  let reads = 0;
  const host = createPickHost({
    writePort: { write: (slot, d) => (writes.push({ slot, d }), true) },
    readScreen: async () => {
      reads += 1;
      return reading.v;
    },
    loadRecords: () => o.loaded ?? {},
    save: async (r) => {
      saves.push(r);
    },
    initialPick: SONNET_MED,
    now: () => t.now,
    schedule: (fn, ms) => {
      const e = { fn, ms, cancelled: false };
      scheduled.push(e);
      return () => {
        e.cancelled = true;
      };
    },
    log: (l) => logs.push(l),
    notifyFailure: (i) => failures.push(i),
    ...o.deps,
  });
  const runNext = async (): Promise<void> => {
    const e = scheduled.find((s) => !s.cancelled);
    if (e) {
      e.cancelled = true;
      e.fn();
    }
    await settle();
  };
  return {
    host, t, writes, saves, logs, failures, scheduled, reading,
    scheduleCalls: () => scheduled.length,
    reads: () => reads,
    runNext,
    last: async () => (await host.flush(), saves[saves.length - 1]),
  };
}

function launch(r: Rig, slot: OwnedSlot = 'claude'): void {
  const d = r.host.launchFor(slot, slot === 'claude' ? { sessionId: SID } : undefined);
  expect(d.command).not.toBeNull();
  r.host.onLaunched(slot);
}

/** A launched claude slot with a manual high effort queued, output last seen `outputAgo` ms ago (null = never). */
function queued(r: Rig, outputAgo: number | null = 2000): void {
  launch(r);
  r.t.now += 20_000;
  if (outputAgo !== null) {
    r.host.noteOutput('claude');
    r.t.now += outputAgo;
  }
  expect(r.host.submitPick('claude', HIGH, 'test').rejected).toBeNull();
}

describe('pickHost', () => {
  it('1: builds Aether launch commands and never derives resume', async () => {
    const r = rig();
    expect(r.host.launchFor('claude', { sessionId: SID })).toEqual({
      command: `claude --session-id ${SID} --model sonnet --effort medium\r`,
    });
    expect(r.host.launchFor('terminal2')).toEqual({ command: 'claude --model sonnet --effort medium\r' });
    r.host.onLaunched('terminal2');
    r.host.onSlotExit('terminal2');
    const again = r.host.launchFor('terminal2');
    expect(again).toEqual({ command: 'claude --model sonnet --effort medium\r' });
    expect(JSON.stringify(again)).not.toContain('--continue');
  });

  it('2: a live model pick is held, zero writes, and folds into the next launch', async () => {
    const r = rig();
    launch(r);
    r.host.submitPick('claude', { model: 'opus', effort: 'medium' }, 'manual');
    expect(r.writes).toEqual([]);
    expect(r.host.state('claude')?.readout).toBe('queuedModel');
    r.host.onSlotExit('claude');
    const d = r.host.launchFor('claude', { sessionId: SID });
    expect(d).toEqual({ command: `claude --session-id ${SID} --model opus --effort medium\r` });
    r.host.onLaunched('claude');
    const rec = (await r.last()).claude;
    expect(rec.modelPending).toBeNull();
    expect(rec.intended.model).toBe('opus');
    expect(r.writes).toEqual([]);
  });

  it('3: a halted record launches plain (no command) and onLaunched is a no-op', async () => {
    const halted = { ...blank('claude'), halted: { wanted: HIGH, actual: null }, outcome: 'not-applied' as const };
    const r = rig({ loaded: { claude: halted } });
    expect(r.host.launchFor('claude', { sessionId: SID })).toEqual({ command: null, reason: 'halted' });
    r.host.onLaunched('claude');
    expect(r.logs.filter((l) => l === 'launch-unmanaged claude halted')).toHaveLength(1);
    expect(r.logs).toContain('launched-without-plan claude');
    expect(r.saves).toEqual([]);
    expect(r.host.state('claude')?.readout).toBe('notApplied');
  });

  it('4: launchFor on a live record exits it first; no onLaunched leaves it not live', async () => {
    const r = rig();
    launch(r);
    expect((await r.last()).claude.live).toBe(true);
    r.host.launchFor('claude', { sessionId: SID });
    expect((await r.last()).claude.live).toBe(false);
    const n = r.saves.length;
    r.host.onSlotExit('terminal2');
    r.host.onLaunched('terminal2');
    expect(r.saves).toHaveLength(n);
    expect(r.logs).toContain('launched-without-plan terminal2');
  });

  it('5: codex and unknown slots are never owned', async () => {
    const r = rig();
    const codex = 'codex' as unknown as OwnedSlot;
    expect(r.host.launchFor(codex)).toEqual({ command: null, reason: 'not-owned' });
    expect(r.host.state(codex)).toBeNull();
    expect(r.host.submitPick(codex, HIGH, 'x').rejected).toBe('invalid pick');
    r.host.noteOutput(codex);
    r.host.noteUserInput(codex);
    r.host.onLaunched(codex);
    r.host.onSlotExit(codex);
    await r.host.flush();
    expect(r.saves).toEqual([]);
  });

  it('6: a live effort pick on a settled idle screen writes exactly one /effort', async () => {
    const r = rig();
    queued(r);
    await r.runNext();
    expect(r.writes).toEqual([{ slot: 'claude', d: '/effort high\r' }]);
    await r.runNext();
    expect(r.writes).toHaveLength(1);
    const rec = (await r.last()).claude;
    expect(rec.launched?.effort).toBe('high');
    expect(rec.outcome).toBe('sent');
  });

  it('7: every non-idle reading causes zero writes', async () => {
    for (const v of ['unknown', 'shell', 'draft', 'generating', 'busy', 'picker', 'modal', 'switch-model-modal'] as IdleReading[]) {
      const r = rig();
      r.reading.v = v;
      queued(r);
      for (let i = 0; i < 4; i++) {
        r.t.now += 600;
        await r.runNext();
      }
      expect(r.writes, v).toEqual([]);
    }
  });

  it('8: quiet window on output, and fail closed when noteOutput was never called', async () => {
    const recent = rig();
    queued(recent, 500);
    await recent.runNext();
    expect(recent.writes).toEqual([]);

    const settled = rig();
    queued(settled, 1600);
    await settled.runNext();
    expect(settled.writes).toHaveLength(1);

    const never = rig();
    queued(never, null);
    for (let i = 0; i < 4; i++) {
      never.t.now += 5000;
      await never.runNext();
    }
    expect(never.writes).toEqual([]);

    // output that arrives while the read is in flight cancels the idle reading
    let release: (v: IdleReading) => void = () => undefined;
    const during = rig({
      deps: { readScreen: () => new Promise<IdleReading>((res) => { release = res; }) },
    });
    queued(during, 2000);
    const p = during.runNext();
    during.t.now += 100;
    during.host.noteOutput('claude');
    release('idle');
    await p;
    await settle();
    expect(during.writes).toEqual([]);
  });

  it('9: user input blocks the write until quietMs has passed', async () => {
    const typed = rig();
    queued(typed, 2000);
    typed.host.noteUserInput('claude');
    typed.t.now += 500;
    await typed.runNext();
    expect(typed.writes).toEqual([]);

    const later = rig();
    queued(later, 2000);
    later.host.noteUserInput('claude');
    later.t.now += 1600;
    await later.runNext();
    expect(later.writes).toHaveLength(1);
  });

  it('10: a stale read, or a read that outlives its epoch, is discarded', async () => {
    let release: (v: IdleReading) => void = () => undefined;
    const slow = rig({ deps: { readScreen: () => new Promise<IdleReading>((res) => { release = res; }) } });
    queued(slow);
    const p1 = slow.runNext();
    slow.t.now += 2500;
    release('idle');
    await p1;
    expect(slow.writes).toEqual([]);

    const epochs = rig({ deps: { readScreen: () => new Promise<IdleReading>((res) => { release = res; }) } });
    queued(epochs);
    const p2 = epochs.runNext();
    epochs.host.onSlotExit('claude');
    epochs.host.launchFor('claude', { sessionId: SID });
    epochs.host.onLaunched('claude');
    epochs.host.submitPick('claude', LOW, 'later');
    epochs.t.now += 100;
    release('idle');
    await p2;
    await settle();
    expect(epochs.writes).toEqual([]);
  });

  it('11: a persisted live record is normalized at construction and cannot be written to', async () => {
    const loaded: ThreadPickRecord = {
      ...blank('claude'),
      live: true,
      queue: { pick: HIGH, reason: 'x', trigger: 'manual', source: 'manual', queuedAt: 1 },
      pendingSource: 'manual',
      outcome: 'sent',
    };
    const r = rig({ loaded: { claude: loaded } });
    expect(r.host.state('claude')?.readout).toBe('queued');
    expect((await r.last()).claude.live).toBe(false);
    r.host.noteOutput('claude');
    r.t.now += 5000;
    r.host.submitPick('claude', HIGH, 'again');
    await r.runNext();
    expect(r.scheduleCalls()).toBe(0);
    expect(r.writes).toEqual([]);
  });

  it('12: the tick is bounded: no polling when idle, one scheduled call, no overlap, cancelled on dispose', async () => {
    const quiet = rig();
    launch(quiet);
    quiet.host.onSlotExit('claude');
    expect(quiet.scheduleCalls()).toBe(0);

    const r = rig();
    launch(r);
    launch(r, 'terminal2');
    r.t.now += 20_000;
    r.host.noteOutput('claude');
    r.host.noteOutput('terminal2');
    r.t.now += 2000;
    r.host.submitPick('claude', HIGH, 'a');
    r.host.submitPick('terminal2', HIGH, 'b');
    expect(r.scheduleCalls()).toBe(1);
    await r.runNext();
    expect(r.writes).toHaveLength(2);
    expect(r.scheduleCalls()).toBe(1);

    let release: (v: IdleReading) => void = () => undefined;
    let dReads = 0;
    const d = rig({ deps: { readScreen: () => new Promise<IdleReading>((res) => { dReads += 1; release = res; }) } });
    queued(d);
    const first = d.scheduled[0].fn;
    const p = d.runNext();
    first();
    await settle();
    expect(dReads).toBe(1);
    release('idle');
    await p;

    const z = rig({ deps: { readScreen: () => new Promise<IdleReading>((res) => { release = res; }) } });
    queued(z);
    const pz = z.runNext();
    z.host.dispose();
    z.host.dispose();
    release('idle');
    await pz;
    await settle();
    expect(z.writes).toEqual([]);
    const y = rig();
    queued(y);
    y.host.dispose();
    expect(y.scheduled.every((s) => s.cancelled)).toBe(true);
  });

  it('13: a settled shell reading demotes the record only after the launch grace', async () => {
    const late = rig();
    late.reading.v = 'shell';
    launch(late);
    late.host.noteOutput('claude');
    late.t.now += 11_000;
    late.host.submitPick('claude', HIGH, 'x');
    await late.runNext();
    expect((await late.last()).claude.live).toBe(false);
    expect(late.writes).toEqual([]);

    const early = rig();
    early.reading.v = 'shell';
    launch(early);
    early.host.noteOutput('claude');
    early.t.now += 5_000;
    early.host.submitPick('claude', HIGH, 'x');
    await early.runNext();
    expect((await early.last()).claude.live).toBe(true);
    expect(early.writes).toEqual([]);
  });

  it('14: exit and foreign launch stop writes; queue and model pick survive; relaunch restores writes', async () => {
    for (const how of ['onSlotExit', 'onForeignLaunch'] as const) {
      const r = rig();
      queued(r);
      r.host.submitPick('claude', { model: 'opus', effort: 'high' }, 'm');
      r.host[how]('claude');
      expect((await r.last()).claude.live).toBe(false);
      expect(r.host.state('claude')?.target).toBeDefined();
      expect((await r.last()).claude.modelPending).toBe('opus');
      r.t.now += 5000;
      await r.runNext();
      expect(r.writes).toEqual([]);
      launch(r);
      r.host.noteOutput('claude');
      r.t.now += 5000;
      r.host.submitPick('claude', LOW, 'again');
      await r.runNext();
      expect(r.writes).toEqual([{ slot: 'claude', d: '/effort low\r' }]);
    }
  });

  it('15: persistence is serial, coalesced, failure-tolerant and keeps unowned ids', async () => {
    const other = blank('other-thread');
    const resolvers: (() => void)[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const saved: Record<string, ThreadPickRecord>[] = [];
    const r = rig({
      loaded: { 'other-thread': other },
      deps: {
        save: (rec) => {
          saved.push(rec);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          return new Promise<void>((res) => {
            resolvers.push(() => {
              inFlight -= 1;
              res();
            });
          });
        },
      },
    });
    expect(saved).toHaveLength(0);
    r.host.submitPick('claude', HIGH, 'one');
    r.host.submitPick('claude', LOW, 'two');
    expect(saved).toHaveLength(1);
    resolvers[0]();
    await settle();
    expect(saved).toHaveLength(2);
    expect(saved[1].claude.intended.effort).toBe('low');
    expect(saved[1]['other-thread']).toBe(other);
    resolvers[1]();
    await r.host.flush();
    expect(saved).toHaveLength(2);
    expect(maxInFlight).toBe(1);

    let fail = true;
    const f = rig({
      deps: {
        save: async (rec) => {
          if (fail) throw new Error('disk');
          f.saves.push(rec);
        },
      },
    });
    f.host.submitPick('claude', HIGH, 'one');
    await f.host.flush();
    expect(f.logs.filter((l) => l === 'save-failed')).toHaveLength(1);
    expect(f.host.state('claude')?.effort).toBe('high');
    fail = false;
    f.host.submitPick('claude', LOW, 'two');
    await f.host.flush();
    expect(f.saves).toHaveLength(1);
    expect(f.saves[0].claude.intended.effort).toBe('low');
  });

  it('16: state() carries enums and numbers only', async () => {
    const r = rig();
    expect(r.host.state('claude')).toEqual({ readout: 'steady', tier: 'sonnet', effort: 'medium', reason: 'default', auto: true });
    const halted = { ...blank('claude'), halted: { wanted: { model: 'opus', effort: 'high' } as Pick, actual: LOW }, outcome: 'not-applied' as const };
    const h = rig({ loaded: { claude: halted } });
    const s = h.host.state('claude');
    expect(s?.readout).toBe('notApplied');
    expect(s?.haltedText).toBe('wanted opus/high, running sonnet/low');
    expect(Object.keys(s ?? {}).sort()).toEqual(['auto', 'effort', 'haltedText', 'readout', 'reason', 'tier']);
    const unk = rig({ loaded: { terminal2: { ...blank('terminal2'), halted: { wanted: HIGH, actual: null }, outcome: 'not-applied' as const } } });
    expect(unk.host.state('terminal2')?.haltedText).toBe('wanted sonnet/high, running unknown');
  });

  it('17: source scan of pickHost.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, 'pickHost.ts'), 'utf8');
    for (const bad of [/console/, /setTimeout/, /setInterval/, /\bDate\./, /\.write\(/, /\/effort/, /\\x1b/, /\\u001b/, /\/model\b/]) {
      expect(src, String(bad)).not.toMatch(bad);
    }
    const specs = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s).not.toMatch(/ptyManager|ptyLifecycle|node-pty|electron|node:fs|pickStore|screenWatcher|terminalHub/);
  });

  it('18: with the quiet signal absent, random readings, clock jumps and lifecycle never write', async () => {
    let seed = 20261104;
    const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const readings: IdleReading[] = ['idle', 'generating', 'busy', 'picker', 'modal', 'switch-model-modal', 'draft', 'shell', 'unknown'];
    const loaded = { claude: { ...blank('claude'), live: true, outcome: 'sent' as const } };
    const r = rig({ loaded });
    for (let i = 0; i < 300; i++) {
      r.reading.v = readings[Math.floor(rnd() * readings.length)];
      r.t.now += Math.floor(rnd() * 20_000);
      const slot: OwnedSlot = rnd() < 0.5 ? 'claude' : 'terminal2';
      const k = rnd();
      if (k < 0.2) r.host.submitPick(slot, rnd() < 0.5 ? HIGH : LOW, 'r');
      else if (k < 0.3) { if (r.host.launchFor(slot).command !== null) r.host.onLaunched(slot); }
      else if (k < 0.4) r.host.onSlotExit(slot);
      else if (k < 0.45) r.host.onForeignLaunch(slot);
      else if (k < 0.5) r.host.noteUserInput(slot);
      await r.runNext();
    }
    expect(r.writes).toEqual([]);
  });
});
