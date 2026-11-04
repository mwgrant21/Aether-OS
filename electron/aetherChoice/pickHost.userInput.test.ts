// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createPickHost } from './pickHost';
import type { PickHost } from './pickHost';
import type { IdleReading, Pick } from '../../src/shared/aetherChoice/types';
import type { StatuslineSnapshot } from '../../src/shared/statuslinePayload';

const SID = '123e4567-e89b-42d3-a456-426614174000';
const SONNET_MED: Pick = { model: 'sonnet', effort: 'medium' };
const HIGH: Pick = { model: 'sonnet', effort: 'high' };

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

type Rig = {
  host: PickHost;
  t: { now: number };
  writes: { slot: string; d: string }[];
  reading: { v: IdleReading };
  hold: { res: ((v: IdleReading) => void) | null; on: boolean };
  runNext: () => Promise<void>;
  pending: () => Promise<void>;
};

/** A launched claude slot at HIGH with output last seen 2 s ago (quiet). */
function liveQuiet(init: Pick = HIGH): Rig {
  const t = { now: 1_000_000 };
  const writes: Rig['writes'] = [];
  const reading = { v: 'idle' as IdleReading };
  const hold: Rig['hold'] = { res: null, on: false };
  const scheduled: { fn: () => void; cancelled: boolean }[] = [];
  const host = createPickHost({
    writePort: { write: (slot, d) => (writes.push({ slot, d }), true) },
    readScreen: () => {
      if (!hold.on) return Promise.resolve(reading.v);
      hold.on = false;
      return new Promise<IdleReading>((res) => {
        hold.res = res;
      });
    },
    loadRecords: () => ({}),
    save: async () => {},
    initialPick: init,
    now: () => t.now,
    schedule: (fn) => {
      const e = { fn, cancelled: false };
      scheduled.push(e);
      return () => {
        e.cancelled = true;
      };
    },
    log: () => {},
    notifyFailure: () => {},
  });
  const runNext = async (): Promise<void> => {
    const e = scheduled.find((s) => !s.cancelled);
    if (e) {
      e.cancelled = true;
      e.fn();
    }
    await settle();
  };
  host.launchFor('claude', { sessionId: SID });
  host.onLaunched('claude');
  t.now += 20_000;
  host.noteOutput('claude');
  t.now += 2000;
  return { host, t, writes, reading, hold, runNext, pending: settle };
}

const snap = (r: Rig, session: number): StatuslineSnapshot => ({
  capturedAtMs: r.t.now,
  sessionId: SID,
  modelId: null,
  modelDisplayName: 'Sonnet',
  fiveHour: { usedPercentage: session, resetsAtMs: r.t.now + 3_600_000 },
  sevenDay: null,
  contextUsedPercentage: null,
  contextWindowSize: null,
  contextUsage: null,
  totalCostUsd: null,
  currentDir: null,
  projectDir: null,
});

const STEP = [{ slot: 'claude', d: '/effort medium\r' }];

describe('pickHost user input guard for generating readings', () => {
  it('u1: input that lands while the read is in flight blocks the mid-turn write, then it lands once quiet', async () => {
    const r = liveQuiet();
    r.reading.v = 'generating';
    r.host.onStatusline(snap(r, 72));
    r.hold.on = true;
    const p = r.runNext();
    r.t.now += 100;
    r.host.noteUserInput('claude');
    r.hold.res?.('generating');
    await p;
    await r.pending();
    expect(r.writes).toEqual([]);
    r.t.now += 1600;
    await r.runNext();
    expect(r.writes).toEqual(STEP);
  });

  it('u2: input shortly before the read blocks the mid-turn write until quietMs has passed', async () => {
    const r = liveQuiet();
    r.reading.v = 'generating';
    r.host.onStatusline(snap(r, 72));
    r.host.noteUserInput('claude');
    r.t.now += 500;
    await r.runNext();
    expect(r.writes).toEqual([]);
    r.t.now += 1600;
    await r.runNext();
    expect(r.writes).toEqual(STEP);
  });

  it('u3: with no typing a mid-turn budget step-down still writes on the first tick', async () => {
    const r = liveQuiet();
    r.reading.v = 'generating';
    r.host.onStatusline(snap(r, 72));
    await r.runNext();
    expect(r.writes).toEqual(STEP);
  });

  it('u4: a manual effort pick over a generating reading still writes nothing', async () => {
    const r = liveQuiet(SONNET_MED);
    r.reading.v = 'generating';
    r.host.submitPick('claude', HIGH, 'manual');
    r.host.noteUserInput('claude');
    r.t.now += 2000;
    await r.runNext();
    expect(r.writes).toEqual([]);
  });
});
