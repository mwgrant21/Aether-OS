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
  const listeners = new Set<(e: SlotEvent) => void>();
  const observe = vi.fn((l: (e: SlotEvent) => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  });
  const slot: ObservableSlot = {
    observe,
    info: () => ({ s: 'claude', label: 'x', state: 'running', cols: 100, rows: 30, q: 0 }),
  };
  return {
    slot,
    observe,
    count: () => listeners.size,
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
  const t = { now: 1_000_000 };
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
    now: () => t.now,
    schedule: (fn) => {
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
