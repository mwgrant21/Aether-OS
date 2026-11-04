import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearHalt,
  markNotApplied,
  newRecord,
  planLaunch,
  setPendingStepDown,
} from '../../src/shared/aetherChoice/pickRecord';
import { MAX_PICKS_FILE_BYTES, PICKS_FILE, loadPicks, savePicks } from './pickStore';

const meta = { reason: 'new thread', trigger: 'new-thread', source: 'auto' } as const;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pickstore-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = () => join(dir, PICKS_FILE);
const rec = (id = 't1') => newRecord(id, { model: 'sonnet', effort: 'medium' }, meta, '2.1.0');
const write = (threads: unknown) => writeFileSync(file(), JSON.stringify({ v: 1, threads }));

describe('pickStore', () => {
  it('round-trips records including lastBudgetLevel, pendingSource and halted', async () => {
    const r = markNotApplied(
      { ...rec(), lastBudgetLevel: 'step', pendingSource: 'manual', modelPending: 'opus' },
      { model: 'sonnet', effort: 'high' },
      null,
    );
    await savePicks(dir, { t1: r });
    expect(loadPicks(dir)).toEqual({ t1: r });
  });

  it('round-trips launched; a file without it loads as null; a bad launched drops the record', async () => {
    const r = { ...rec(), launched: { model: 'haiku', effort: 'low' } } as const;
    await savePicks(dir, { t1: r });
    expect(loadPicks(dir).t1.launched).toEqual({ model: 'haiku', effort: 'low' });
    const { launched: _drop, ...old } = rec('o');
    write({ o: old, f: { ...rec('f'), launched: { model: 'fable', effort: 'low' } }, u: { ...rec('u'), launched: { model: 'sonnet', effort: 'ultra' } } });
    const out = loadPicks(dir);
    expect(Object.keys(out)).toEqual(['o']);
    expect(out.o.launched).toBeNull();
  });

  it('drops a record with model fable or an unlaunchable effort, keeping the good one', () => {
    write({
      ok: rec('ok'),
      f: { ...rec('f'), intended: { model: 'fable', effort: 'low' } },
      u: { ...rec('u'), intended: { model: 'sonnet', effort: 'ultra' } },
      q: {
        ...rec('q'),
        queue: { pick: { model: 'sonnet', effort: 'ultra' }, reason: 'r', trigger: 'manual', source: 'manual', queuedAt: 1 },
      },
      mp: { ...rec('mp'), modelPending: 'fable' },
    });
    expect(Object.keys(loadPicks(dir))).toEqual(['ok']);
  });

  it('drops malformed new fields and unknown extra fields', () => {
    write({
      a: { ...rec('a'), lastBudgetLevel: 'bogus' },
      b: { ...rec('b'), pendingSource: 'robot' },
      c: { ...rec('c'), reason: 'x'.repeat(201) },
      d: { ...rec('d'), prompt: 'secret' },
    });
    const out = loadPicks(dir);
    expect(Object.keys(out)).toEqual(['d']);
    expect(out.d).not.toHaveProperty('prompt');
  });

  it('ignores an oversize file', () => {
    write({ t1: rec(), pad: 'x'.repeat(MAX_PICKS_FILE_BYTES) });
    expect(loadPicks(dir)).toEqual({});
  });

  it('ignores garbage, a wrong version and a missing file', () => {
    expect(loadPicks(dir)).toEqual({});
    writeFileSync(file(), '{not json');
    expect(loadPicks(dir)).toEqual({});
    writeFileSync(file(), JSON.stringify({ v: 2, threads: { t1: rec() } }));
    expect(loadPicks(dir)).toEqual({});
  });

  it('A12: pendingStepDown and halted survive reload and the plan still steps down', async () => {
    const stepped = setPendingStepDown({ ...rec(), halted: { wanted: { model: 'opus', effort: 'high' }, actual: null } });
    await savePicks(dir, { t1: stepped });
    const loaded = loadPicks(dir).t1;
    expect(loaded.pendingStepDown).toBe(true);
    expect(loaded.halted).not.toBeNull();
    expect(planLaunch(loaded, { sessionPct: 91, weekPct: 0 })).toEqual({ error: 'halted' });
    expect(planLaunch(clearHalt(loaded), { sessionPct: 91, weekPct: 0 })).toMatchObject({ model: 'haiku', effort: 'low' });
    expect(readFileSync(file(), 'utf8')).not.toContain('settings');
  });

  it('writes no prompt, text or transcript keys', async () => {
    await savePicks(dir, { t1: { ...rec(), prompt: 'hi', text: 'hi', transcript: 'hi' } as never });
    const raw = readFileSync(file(), 'utf8');
    for (const k of ['"prompt"', '"text"', '"transcript"']) expect(raw).not.toContain(k);
  });

  it('drops a __proto__ id on load and on save, keeping Object.prototype', async () => {
    writeFileSync(file(), '{"v":1,"threads":{"__proto__":' + JSON.stringify(rec('__proto__')) + ',"ok":' + JSON.stringify(rec('ok')) + '}}');
    const loaded = loadPicks(dir);
    expect(Object.getPrototypeOf(loaded)).toBe(Object.prototype);
    expect(Object.keys(loaded)).toEqual(['ok']);
    const evil = JSON.parse('{"__proto__":' + JSON.stringify(rec('__proto__')) + ',"ok":' + JSON.stringify(rec('ok')) + '}');
    await savePicks(dir, evil);
    expect(Object.keys(JSON.parse(readFileSync(file(), 'utf8')).threads)).toEqual(['ok']);
  });
});

describe('pickStore size cap (F3)', () => {
  const many = (n: number) => {
    const out: Record<string, ReturnType<typeof rec>> = {};
    for (let i = 0; i < n; i++) out[`thread-${i}`] = rec(`thread-${i}`);
    return out;
  };

  it('a save over the load cap throws naming size and cap, and leaves the previous file untouched', async () => {
    let n = 1;
    await savePicks(dir, many(n));
    for (;;) {
      const bytes = readFileSync(file());
      let threw: unknown = null;
      try {
        await savePicks(dir, many(n + 1));
      } catch (e) {
        threw = e;
      }
      if (threw) {
        expect(String((threw as Error).message)).toContain(String(MAX_PICKS_FILE_BYTES));
        expect(readFileSync(file()).equals(bytes)).toBe(true);
        expect(Object.keys(loadPicks(dir))).toHaveLength(n);
        expect(loadPicks(dir)).toEqual(many(n));
        break;
      }
      n++;
      expect(n).toBeLessThan(2000);
    }
    expect(n).toBeGreaterThan(50);
  });
});

describe('pickStore: a halted record with an unlaunchable reported actual survives save/load (H1)', () => {
  it('stores no actual for fable/ultra/junk, keeps the halt, and loads unchanged', async () => {
    for (const actual of [{ model: 'fable', effort: 'low' }, { model: 'sonnet', effort: 'ultra' }, { model: 1, effort: null }]) {
      const live = { ...rec(), live: true, launched: { model: 'sonnet', effort: 'medium' } } as const;
      const r = markNotApplied(live, { model: 'sonnet', effort: 'high' }, actual as never);
      expect(r.halted?.actual).toBeNull();
      await savePicks(dir, { t1: r });
      expect(loadPicks(dir)).toEqual({ t1: r });
    }
  });
});
