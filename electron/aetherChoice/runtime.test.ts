// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createAetherChoiceRuntime } from './runtime';
import type { AetherChoiceRuntime } from './runtime';
import type { ObservableSlot } from './screenWatcher';
import type { SlotEvent } from '../terminalHub';
import type { IdleReading } from '../../src/shared/aetherChoice/types';
import { newRecord } from '../../src/shared/aetherChoice/pickRecord';
import type { ThreadPickRecord } from '../../src/shared/aetherChoice/pickRecord';
import type { StatuslineSnapshot } from '../../src/shared/statuslinePayload';
import type { TerminalWritePort } from '../../src/shared/remote/types';

const SID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_SID = '223e4567-e89b-42d3-a456-426614174999';
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function fakeSlot() {
  let state: 'running' | 'exited' = 'running';
  const listeners = new Set<(e: SlotEvent) => void>();
  const observe = vi.fn((l: (e: SlotEvent) => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  });
  const slot: ObservableSlot = {
    observe,
    info: () => ({ s: 'claude', label: 'x', state, cols: 100, rows: 30, q: 0 }),
  };
  return {
    slot,
    observe,
    count: () => listeners.size,
    setState: (s: 'running' | 'exited') => {
      state = s;
    },
    fire: (e: SlotEvent) => {
      for (const l of [...listeners]) l(e);
    },
  };
}

const startEv: SlotEvent = { kind: 'start', q: 0, cols: 100, rows: 30 };
const outEv: SlotEvent = { kind: 'out', q: 1, d: 'x' };
const exitEv: SlotEvent = { kind: 'state', state: 'exited' };

type Mode = 'ok' | 'false' | 'throw';
function rig(opts: { env?: Record<string, string | undefined>; records?: Record<string, ThreadPickRecord> } = {}) {
  const t = { now: 1_000_000, throwNow: false, throwSchedule: false };
  const claude = fakeSlot();
  const terminal2 = fakeSlot();
  const writes: { slot: string; d: string }[] = [];
  const mode = { v: 'ok' as Mode };
  const reading = { v: 'idle' as IdleReading };
  const saves: Record<string, ThreadPickRecord>[] = [];
  const logs: string[] = [];
  const scheduled: { fn: () => void; cancelled: boolean }[] = [];
  const loadRecords = vi.fn(() => opts.records ?? {});
  const writePort: TerminalWritePort = {
    write: (slot, d) => {
      if (mode.v === 'throw') throw new Error('port down');
      if (mode.v === 'false') return false;
      writes.push({ slot, d });
      return true;
    },
  };
  const rt = createAetherChoiceRuntime({
    env: opts.env ?? { AETHER_CHOICE_HOST: '1' },
    slots: { claude: claude.slot, terminal2: terminal2.slot },
    writePort,
    loadRecords,
    save: async (r) => {
      saves.push(r);
    },
    now: () => {
      if (t.throwNow) throw new Error('clock');
      return t.now;
    },
    schedule: (fn) => {
      if (t.throwSchedule) throw new Error('timer');
      const e = { fn, cancelled: false };
      scheduled.push(e);
      return () => {
        e.cancelled = true;
      };
    },
    log: (l) => logs.push(l),
    sendToWindow: () => {},
    watcher: {
      createMirror: () => ({
        write: () => {},
        resize: () => {},
        viewportText: () => Promise.resolve(['row']),
        dispose: () => {},
      }),
      classify: () => reading.v,
    },
    host: { minWriteGapMs: 0 },
  });
  const runNext = async (): Promise<void> => {
    const e = scheduled.find((s) => !s.cancelled);
    if (e) {
      e.cancelled = true;
      e.fn();
    }
    await settle();
  };
  const lastSave = async (): Promise<Record<string, ThreadPickRecord> | undefined> => {
    await rt?.flush();
    return saves[saves.length - 1];
  };
  return { t, rt, claude, terminal2, writes, mode, reading, saves, logs, loadRecords, runNext, lastSave, scheduled };
}
type Rig = ReturnType<typeof rig>;
const must = (r: Rig): AetherChoiceRuntime => {
  if (!r.rt) throw new Error('runtime is null');
  return r.rt;
};

const autoHigh = (): Record<string, ThreadPickRecord> => ({
  claude: newRecord('claude', { model: 'sonnet', effort: 'high' }, { reason: 'seed', trigger: 'new-thread', source: 'auto' }),
});

const snap = (r: Rig, session: number, sessionId: string = SID): StatuslineSnapshot => ({
  capturedAtMs: r.t.now,
  sessionId,
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

/** Planned launch of claude, output seen, `quiet` ms of silence, then a budget step-down is queued. */
function queued(r: Rig, opts: { output?: boolean; quiet?: number; sessionId?: string } = {}): void {
  const rt = must(r);
  rt.launchCommandFor('claude', { sessionId: SID });
  r.claude.fire(startEv);
  r.t.now += 20_000;
  if (opts.output !== false) r.claude.fire(outEv);
  r.t.now += opts.quiet ?? 2000;
  rt.onStatusline(snap(r, 72, opts.sessionId));
}

describe('aetherChoice runtime', () => {
  it('1: only AETHER_CHOICE_HOST=1 enables it, and a disabled runtime touches nothing', () => {
    for (const env of [{}, { AETHER_CHOICE_HOST: '0' }, { AETHER_CHOICE_HOST: 'true' }]) {
      const r = rig({ env });
      expect(r.rt).toBeNull();
      expect(r.claude.observe).not.toHaveBeenCalled();
      expect(r.terminal2.observe).not.toHaveBeenCalled();
      expect(r.loadRecords).not.toHaveBeenCalled();
    }
    const on = rig();
    expect(on.rt).not.toBeNull();
    expect(on.claude.count()).toBe(2);
    expect(on.terminal2.count()).toBe(2);
  });

  it('2: launch lines carry the default model and effort and never --continue', () => {
    const r = rig();
    const rt = must(r);
    const a = rt.launchCommandFor('claude', { sessionId: SID });
    const b = rt.launchCommandFor('terminal2');
    expect(a).toBe(`claude --session-id ${SID} --model sonnet --effort medium\r`);
    expect(b).toBe('claude --model sonnet --effort medium\r');
    expect(a).not.toContain('--continue');
    expect(b).not.toContain('--continue');
  });

  it('3: only a start after a planned launch makes the record live', async () => {
    const r = rig();
    must(r).launchCommandFor('claude', { sessionId: SID });
    r.claude.fire(startEv);
    const live = (await r.lastSave())?.claude;
    expect(live?.live).toBe(true);
    expect(live?.launched).toEqual({ model: 'sonnet', effort: 'medium' });

    // connected-bridge case: a start with no launchCommandFor is foreign
    const r2 = rig({ records: autoHigh() });
    r2.claude.fire(startEv);
    r2.t.now += 30_000;
    r2.claude.fire(outEv);
    r2.t.now += 2000;
    must(r2).onStatusline(snap(r2, 72));
    await settle();
    expect(r2.scheduled).toHaveLength(0);
    expect((await r2.lastSave())?.claude?.live ?? false).toBe(false);
    expect(r2.writes).toEqual([]);

    // refused launch: the seeded halted record stays halted and not live
    const halted = autoHigh();
    halted.claude = { ...halted.claude, halted: { wanted: { model: 'sonnet', effort: 'high' }, actual: null } };
    const r3 = rig({ records: halted });
    expect(must(r3).launchCommandFor('claude', { sessionId: SID })).toBeUndefined();
    r3.claude.fire(startEv);
    const rec = (await r3.lastSave())?.claude ?? halted.claude;
    expect(rec.live).toBe(false);
    expect(rec.halted).not.toBeNull();
  });

  it('4: the out observer is what lets the host write /effort', async () => {
    const r = rig({ records: autoHigh() });
    queued(r);
    await r.runNext();
    expect(r.writes).toEqual([{ slot: 'claude', d: '/effort medium\r' }]);

    const silent = rig({ records: autoHigh() });
    queued(silent, { output: false });
    for (let i = 0; i < 4; i++) {
      silent.t.now += 500;
      await silent.runNext();
    }
    expect(silent.writes).toEqual([]);
  });

  it('5: an exit makes the record not live and stops all writes', async () => {
    const r = rig({ records: autoHigh() });
    queued(r);
    r.claude.fire(exitEv);
    expect((await r.lastSave())?.claude.live).toBe(false);
    r.t.now += 5000;
    await r.runNext();
    await r.runNext();
    expect(r.writes).toEqual([]);
  });

  it('6: a throwing or refusing port neither throws, logs tick-failed, nor loses the queue', async () => {
    for (const bad of ['throw', 'false'] as const) {
      const r = rig({ records: autoHigh() });
      queued(r);
      r.mode.v = bad;
      await expect(r.runNext()).resolves.toBeUndefined();
      expect(r.logs.some((l) => l.includes('tick-failed'))).toBe(false);
      expect((await r.lastSave())?.claude.queue).not.toBeNull();
      expect(r.writes).toEqual([]);
      r.mode.v = 'ok';
      r.t.now += 500;
      await r.runNext();
      expect(r.writes).toEqual([{ slot: 'claude', d: '/effort medium\r' }]);
      expect((await r.lastSave())?.claude.queue).toBeNull();
    }
  });

  it('7: the user wrapper notes input first and delegates, and the engine write does not count as input', async () => {
    const r = rig({ records: autoHigh() });
    const rt = must(r);
    queued(r, { quiet: 2000 });
    const inner: TerminalWritePort = { write: vi.fn(() => false) };
    const wrapped = rt.wrapUserWritePort(inner);
    expect(Object.keys(wrapped)).toEqual(['write']);
    r.t.now += 1500;
    expect(wrapped.write('claude', 'x')).toBe(false);
    expect(inner.write).toHaveBeenCalledWith('claude', 'x');
    r.t.now += 500;
    await r.runNext();
    expect(r.writes).toEqual([]); // draft
    r.t.now += 1100;
    await r.runNext();
    expect(r.writes).toEqual([{ slot: 'claude', d: '/effort medium\r' }]);
    // a second step-down right after the engine write is not blocked as a draft
    r.t.now += 100;
    rt.onStatusline(snap(r, 95));
    r.t.now += 500;
    await r.runNext();
    expect(r.writes.length).toBe(2);
  });

  it('8: statusline usage is account-wide, not filtered to the launched session', async () => {
    const r = rig({ records: autoHigh() });
    queued(r, { sessionId: OTHER_SID });
    expect((await r.lastSave())?.claude.queue?.trigger).toBe('budget');
  });

  it('9: dispose is idempotent and silences everything', async () => {
    const r = rig({ records: autoHigh() });
    const rt = must(r);
    rt.dispose();
    expect(() => rt.dispose()).not.toThrow();
    expect(r.claude.count()).toBe(0);
    expect(r.terminal2.count()).toBe(0);
    const before = r.saves.length;
    r.claude.fire(startEv);
    r.claude.fire(outEv);
    r.claude.fire(exitEv);
    expect(rt.launchCommandFor('claude', { sessionId: SID })).toBeUndefined();
    rt.onForeignLaunch('claude');
    rt.noteUserInput('claude');
    rt.onStatusline(snap(r, 72));
    rt.wrapUserWritePort({ write: () => true }).write('claude', 'x');
    await expect(rt.flush()).resolves.toBeUndefined();
    expect(r.saves.length).toBe(before);
    expect(r.writes).toEqual([]);
  });

  it('10: runtime.ts source stays pure and has exactly two write delegations', () => {
    const src = fs
      .readFileSync(path.join(__dirname, 'runtime.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const bad of ['console', 'setTimeout', 'setInterval', 'Date.', '/effort', '\\x1b']) {
      expect(src.includes(bad), bad).toBe(false);
    }
    const specs = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const s of specs) expect(s).not.toMatch(/ptyManager|ptyLifecycle|node-pty|electron|node:fs|pickStore/);
    expect(src.match(/\.write\(/g)).toHaveLength(2);
  });
});

const SONNET_HIGH = { model: 'sonnet', effort: 'high' } as const;
const EFFORT_ONLY = /^\/effort (low|medium|high|xhigh|max)\r$/;

const haltedRec = (slot: string): ThreadPickRecord => ({
  ...newRecord(slot, { model: 'sonnet', effort: 'medium' }, { reason: 'seed', trigger: 'new-thread', source: 'auto' }),
  halted: { wanted: { model: 'sonnet', effort: 'medium' }, actual: { model: 'haiku', effort: 'low' } },
});

/** Planned launch of claude, start, output, then `quiet` ms of silence: the idle gate can open. */
function liveClaude(r: Rig, quiet = 2000): void {
  must(r).launchCommandFor('claude', { sessionId: SID });
  r.claude.fire(startEv);
  r.t.now += 20_000;
  r.claude.fire(outEv);
  r.t.now += quiet;
}

describe('aetherChoice runtime: state, submitPick, clearHalt', () => {
  it('11: state reports a fresh owned slot and null for an unowned one', () => {
    const r = rig();
    const s = must(r).state('claude');
    expect(s).toMatchObject({ readout: 'steady', tier: 'sonnet', effort: 'medium', auto: true });
    expect(must(r).state('codex')).toBeNull();
    expect(must(r).state('x')).toBeNull();
  });

  it('12: a seeded halted claude reads notApplied with both picks named, terminal2 unaffected', () => {
    const r = rig({ records: { claude: haltedRec('claude') } });
    const s = must(r).state('claude');
    expect(s?.readout).toBe('notApplied');
    expect(s?.haltedText).toContain('sonnet/medium');
    expect(s?.haltedText).toContain('haiku/low');
    expect(must(r).state('terminal2')?.readout).toBe('steady');
  });

  it('13: clearHalt clears only that slot, ignores unowned slots and never writes', async () => {
    const r = rig({ records: { claude: haltedRec('claude'), terminal2: haltedRec('terminal2') } });
    const rt = must(r);
    expect(() => rt.clearHalt('codex')).not.toThrow();
    expect(() => rt.clearHalt('')).not.toThrow();
    expect(rt.state('claude')?.readout).toBe('notApplied');
    rt.clearHalt('claude');
    expect(rt.state('claude')?.readout).not.toBe('notApplied');
    const saved = await r.lastSave();
    expect(saved?.claude.halted).toBeNull();
    expect(saved?.terminal2.halted).not.toBeNull();
    expect(rt.state('terminal2')?.readout).toBe('notApplied');
    expect(r.writes).toEqual([]);
  });

  it('14: a manual pick on a not-live record edits the record only', async () => {
    const r = rig();
    const rt = must(r);
    expect(rt.submitPick('claude', { ...SONNET_HIGH })).toEqual({ rejected: null });
    expect(rt.state('claude')).toMatchObject({ effort: 'high', auto: false, reason: 'manual pick' });
    expect((await r.lastSave())?.claude.source).toBe('manual');
    expect(r.writes).toEqual([]);
  });

  it('15: a manual pick on a live idle slot types exactly one /effort, once', async () => {
    const r = rig();
    const rt = must(r);
    liveClaude(r);
    // an ignored running-state event must not disturb the pick
    r.claude.fire({ kind: 'state', state: 'running' });
    expect(rt.submitPick('claude', { ...SONNET_HIGH })).toEqual({ rejected: null });
    expect(rt.state('claude')).toMatchObject({ readout: 'queued', target: { tier: 'sonnet', effort: 'high' } });
    await r.runNext();
    expect(r.writes).toEqual([{ slot: 'claude', d: '/effort high\r' }]);
    r.t.now += 500;
    await r.runNext();
    expect(r.writes).toHaveLength(1);
  });

  it('16: a model pick is held back (Option R) and every byte ever written is an /effort line', async () => {
    const r = rig();
    const rt = must(r);
    liveClaude(r);
    expect(rt.submitPick('claude', { model: 'opus', effort: 'medium' })).toEqual({ rejected: null });
    expect(rt.state('claude')?.readout).toBe('queuedModel');
    for (let i = 0; i < 4; i++) {
      r.t.now += 500;
      await r.runNext();
    }
    expect(r.writes).toEqual([]);
    rt.submitPick('claude', { ...SONNET_HIGH });
    r.t.now += 500;
    await r.runNext();
    expect(r.writes.length).toBeGreaterThan(0);
    for (const w of r.writes) expect(w.d).toMatch(EFFORT_ONLY);
  });

  it('17: a halted live slot receives zero bytes until clearHalt, then exactly one /effort', async () => {
    const r = rig();
    const rt = must(r);
    liveClaude(r);
    rt.submitPick('claude', { ...SONNET_HIGH });
    await r.runNext();
    expect(r.writes).toHaveLength(1);
    // readback shows a different model than the one launched: the engine halts the slot
    rt.onStatusline({ ...snap(r, 10), modelDisplayName: 'Haiku' });
    await settle();
    expect(rt.state('claude')?.readout).toBe('notApplied');
    expect(rt.submitPick('claude', { model: 'sonnet', effort: 'max' })).toEqual({ rejected: null });
    for (let i = 0; i < 4; i++) {
      r.t.now += 500;
      await r.runNext();
    }
    expect(r.writes).toHaveLength(1);
    rt.clearHalt('claude');
    r.t.now += 500;
    await r.runNext();
    await r.runNext();
    expect(r.writes.map((w) => w.d)).toEqual(['/effort high\r', '/effort max\r']);
  });

  it('18: invalid picks are rejected without a save or a write', async () => {
    const r = rig();
    const rt = must(r);
    await r.lastSave();
    const before = r.saves.length;
    const bad = [
      rt.submitPick('claude', { model: 'fable', effort: 'high' } as never),
      rt.submitPick('claude', { model: 'sonnet', effort: 'ul' + 'tra' } as never),
      rt.submitPick('claude', { model: 'Sonnet', effort: 'high' } as never),
      rt.submitPick('codex', { ...SONNET_HIGH }),
    ];
    for (const b of bad) expect(b).toEqual({ rejected: 'invalid pick' });
    await r.lastSave();
    expect(r.saves.length).toBe(before);
    expect(r.writes).toEqual([]);
  });

  it('19: after dispose, state is null, submitPick is disposed and clearHalt is inert', async () => {
    const r = rig();
    const rt = must(r);
    liveClaude(r);
    expect(rt.submitPick('claude', { ...SONNET_HIGH })).toEqual({ rejected: null });
    await r.lastSave();
    rt.dispose();
    const before = r.saves.length;
    expect(rt.state('claude')).toBeNull();
    expect(rt.submitPick('claude', { ...SONNET_HIGH })).toEqual({ rejected: 'disposed' });
    expect(() => rt.clearHalt('claude')).not.toThrow();
    r.t.now += 1000;
    await r.runNext();
    expect(r.saves.length).toBe(before);
    expect(r.writes).toEqual([]);
  });

  it('20: replacing a running slot keeps the new plan when the old process exit fires first', async () => {
    const r = rig({ records: autoHigh() });
    const rt = must(r);
    rt.launchCommandFor('claude', { sessionId: SID });
    r.claude.fire(startEv);
    // replacement: the plan is recorded, then the kill reports the old process's exit before the new start
    rt.launchCommandFor('claude', { sessionId: OTHER_SID });
    r.claude.fire(exitEv);
    r.claude.fire(startEv);
    expect((await r.lastSave())?.claude.live).toBe(true);
    r.t.now += 20_000;
    r.claude.fire(outEv);
    r.t.now += 2000;
    rt.onStatusline(snap(r, 72, OTHER_SID));
    await r.runNext();
    expect(r.writes).toEqual([{ slot: 'claude', d: '/effort medium\r' }]);
  });

  it('20b: the replacement start arms launch readback for the new session', async () => {
    const r = rig();
    const rt = must(r);
    rt.launchCommandFor('claude', { sessionId: SID });
    r.claude.fire(startEv);
    rt.launchCommandFor('claude', { sessionId: OTHER_SID });
    r.claude.fire(exitEv);
    r.claude.fire(startEv);
    rt.onStatusline({ ...snap(r, 10, OTHER_SID), modelDisplayName: 'Haiku' });
    await settle();
    expect(rt.state('claude')?.readout).toBe('notApplied');
  });

  it('21: an exit with no replacement in flight clears the plan, so a later start is foreign', async () => {
    const r = rig({ records: autoHigh() });
    const rt = must(r);
    rt.launchCommandFor('claude', { sessionId: SID });
    r.claude.fire(startEv);
    r.claude.fire(exitEv);
    r.claude.fire(startEv);
    expect((await r.lastSave())?.claude?.live ?? false).toBe(false);

    // planned but never started, then an exit: also cleared
    const r2 = rig({ records: autoHigh() });
    must(r2).launchCommandFor('claude', { sessionId: SID });
    r2.claude.fire(exitEv);
    r2.claude.fire(startEv);
    expect((await r2.lastSave())?.claude?.live ?? false).toBe(false);
  });

  it('22: after a replacement flow, a further start with no launch is foreign', async () => {
    const r = rig({ records: autoHigh() });
    const rt = must(r);
    rt.launchCommandFor('claude', { sessionId: SID });
    r.claude.fire(startEv);
    rt.launchCommandFor('claude', { sessionId: OTHER_SID });
    r.claude.fire(exitEv);
    r.claude.fire(startEv);
    expect((await r.lastSave())?.claude.live).toBe(true);
    r.claude.fire(startEv);
    expect((await r.lastSave())?.claude?.live ?? false).toBe(false);
  });

  it('23: a start reported after a synchronous exit is not "running", so a later exit is not a retiring exit', async () => {
    const r = rig({ records: autoHigh() });
    const rt = must(r);
    r.claude.setState('exited');
    r.claude.fire(exitEv);
    r.claude.fire(startEv); // the synchronously exited pty's late start: state is still exited
    rt.launchCommandFor('claude', { sessionId: SID });
    r.claude.fire(exitEv); // the new pty's own synchronous exit
    r.claude.fire(startEv);
    expect((await r.lastSave())?.claude?.live ?? false).toBe(false);
    r.t.now += 20_000;
    r.claude.fire(outEv);
    r.t.now += 2000;
    rt.onStatusline(snap(r, 72));
    await r.runNext();
    expect(r.writes).toEqual([]);
  });

  it('24: start, exit, a new launch and a second exit leave the next start foreign', async () => {
    const r = rig({ records: autoHigh() });
    const rt = must(r);
    rt.launchCommandFor('claude', { sessionId: SID });
    r.claude.fire(startEv);
    r.claude.fire(exitEv);
    rt.launchCommandFor('claude', { sessionId: OTHER_SID });
    r.claude.fire(exitEv);
    r.claude.fire(startEv);
    expect((await r.lastSave())?.claude?.live ?? false).not.toBe(true);
  });

  it('25: submitPick with a throwing host reports an error and the runtime survives', async () => {
    const r = rig();
    const rt = must(r);
    liveClaude(r);
    await r.lastSave();
    const before = r.saves.length;
    r.t.throwNow = true;
    expect(rt.submitPick('claude', { ...SONNET_HIGH })).toEqual({ rejected: 'error' });
    await r.lastSave();
    expect(r.saves.length).toBe(before);
    expect(r.writes).toEqual([]);
    r.t.throwNow = false;
    expect(rt.submitPick('claude', { ...SONNET_HIGH })).toEqual({ rejected: null });
  });

  it('26: state swallows a host that cannot read its record', () => {
    const r = rig({ records: { claude: {} as ThreadPickRecord } });
    expect(() => must(r).state('claude')).not.toThrow();
    expect(must(r).state('claude')).toBeNull();
  });

  it('27: clearHalt swallows a host whose scheduler throws', async () => {
    const r = rig();
    const rt = must(r);
    liveClaude(r);
    rt.submitPick('claude', { ...SONNET_HIGH });
    await r.runNext();
    rt.onStatusline({ ...snap(r, 10), modelDisplayName: 'Haiku' }); // readback mismatch halts the slot
    await settle();
    rt.submitPick('claude', { model: 'sonnet', effort: 'max' }); // queued behind the halt
    for (let i = 0; i < 4; i++) {
      r.t.now += 500;
      await r.runNext();
    }
    expect(rt.state('claude')?.readout).toBe('notApplied');
    r.t.throwSchedule = true;
    expect(() => rt.clearHalt('claude')).not.toThrow();
    r.t.throwSchedule = false;
    expect(rt.state('claude')?.readout).not.toBe('notApplied'); // the halt was cleared before the timer threw
  });
});
