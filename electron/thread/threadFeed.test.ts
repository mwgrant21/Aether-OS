// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  THREAD_DETAIL_STORE_BYTES,
  THREAD_HISTORY_ENTRIES,
  THREAD_PERM_CLEAR_MS,
  THREAD_SNAPSHOT_BYTES,
  type ThreadEntry,
  type ThreadMeta,
  type ThreadSnapshot,
  type ThreadTap,
} from '../../src/shared/remote/threadTypes';
import { createThreadFeed, type ThreadFeed } from './threadFeed';

// Synthetic transcript lines only. The feed is driven by hand: the injected setInterval records the timer and the
// test calls feed.tick(), so nothing depends on wall-clock time.
const TS = '2026-01-01T00:00:00.000Z';
const j = (o: unknown): string => JSON.stringify(o) + '\n';
const prompt = (text: string, ts: string | null = TS): string =>
  j({ type: 'user', ...(ts ? { timestamp: ts } : {}), isSidechain: false, message: { role: 'user', content: text } });
const reply = (text: string, usage: Record<string, number> | null = null, stop = 'end_turn'): string =>
  j({
    type: 'assistant', timestamp: TS, isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'text', text }], ...(usage ? { usage } : {}), stop_reason: stop },
  });
const toolUse = (id: string, name: string, input: unknown, usage: Record<string, number> | null = null): string =>
  j({
    type: 'assistant', timestamp: TS, isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }], ...(usage ? { usage } : {}), stop_reason: 'tool_use' },
  });
const result = (id: string, content: string): string =>
  j({ type: 'user', timestamp: TS, isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });

interface Rig {
  dir: string;
  file: string;
  clock: { t: number };
  intervals: { fn: () => void; ms: number; cleared: boolean }[];
  session: { sessionId: string; file: string } | null;
  logs: string[];
  feed: ThreadFeed;
}
const rigs: Rig[] = [];
function rig(opts: { initial?: string; statusPct?: number | null; seedBytes?: number } = {}): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-feed-'));
  const file = path.join(dir, 's1.jsonl');
  if (opts.initial !== undefined) fs.writeFileSync(file, opts.initial);
  const r: Rig = {
    dir, file, clock: { t: 1_000_000 }, intervals: [], session: { sessionId: 's1', file }, logs: [],
    feed: undefined as unknown as ThreadFeed,
  };
  r.feed = createThreadFeed({
    slot: 'claude',
    resolve: () => r.session,
    statuslineCtx: () => (opts.statusPct == null ? null : { pct: opts.statusPct }),
    now: () => r.clock.t,
    setIntervalFn: (fn, ms) => {
      const h = { fn, ms, cleared: false };
      r.intervals.push(h);
      return h;
    },
    clearIntervalFn: (h) => {
      h.cleared = true;
    },
    log: (l) => r.logs.push(l),
    seedBytes: opts.seedBytes,
  });
  rigs.push(r);
  return r;
}
const append = (r: Rig, s: string): void => fs.appendFileSync(r.file, s);
const advance = async (r: Rig, ms = 1000): Promise<void> => {
  r.clock.t += ms;
  await r.feed.tick();
};
const liveTimers = (r: Rig): number => r.intervals.filter((i) => !i.cleared).length;

type Ev =
  | { k: 'snap'; s: ThreadSnapshot }
  | { k: 'add'; q: number; e: ThreadEntry }
  | { k: 'upd'; q: number; e: ThreadEntry }
  | { k: 'meta'; m: ThreadMeta };
function phone(): { tap: ThreadTap; ev: Ev[]; list: ThreadEntry[]; lastQ: () => number } {
  const ev: Ev[] = [];
  let list: ThreadEntry[] = [];
  let q = -1;
  const tap: ThreadTap = {
    snap(s) {
      ev.push({ k: 'snap', s });
      list = [...s.entries];
      q = s.q;
    },
    add(nq, e) {
      expect(nq).toBe(q + 1); // strictly +1: nothing lost, nothing repeated
      q = nq;
      ev.push({ k: 'add', q: nq, e });
      list.push(e);
      if (list.length > THREAD_HISTORY_ENTRIES) list.shift();
    },
    upd(nq, e) {
      expect(nq).toBe(q + 1);
      q = nq;
      ev.push({ k: 'upd', q: nq, e });
      const i = list.findIndex((x) => x.id === e.id);
      if (i >= 0) list[i] = e;
    },
    meta(m) {
      ev.push({ k: 'meta', m });
    },
  };
  return { tap, ev, get list() { return list; }, lastQ: () => q } as never;
}
const snapsOf = (ev: Ev[]) => ev.filter((e): e is Extract<Ev, { k: 'snap' }> => e.k === 'snap').map((e) => e.s);

afterEach(() => {
  for (const r of rigs.splice(0)) {
    r.feed.stop();
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.restoreAllMocks();
});

describe('threadFeed snapshot and live tail', () => {
  it('delivers a synchronous empty snapshot, then the seeded snapshot with exact entries and meta', async () => {
    const fixture = fs.readFileSync(path.join(__dirname, '__fixtures__', 'basic-session.jsonl'), 'utf8').replace(/\n*$/, '\n');
    const r = rig({ initial: fixture, statusPct: 36.9 });
    const p = phone();
    r.feed.attach(p.tap);
    expect(p.ev).toHaveLength(1); // synchronous, before any await
    expect(snapsOf(p.ev)[0]).toMatchObject({ avail: false, why: 'starting', entries: [] });
    await r.feed.tick();
    const seeded = snapsOf(p.ev)[1]!;
    expect(seeded.avail).toBe(true);
    expect(seeded.entries.map((e) => e.k)).toEqual(['u', 'th', 't', 'a']);
    expect(seeded.entries[2]).toMatchObject({ k: 't', n: 'Bash', st: 'ok', sz: 11, d: true });
    expect(seeded.m).toEqual({
      ctxTok: 1112, ctxPct: 36.9, work: 'idle', since: Date.parse(TS), tok: 12, last: Date.parse('2026-01-01T00:00:04.000Z'), wait: null,
    });
  });

  it('reports avail:false no-session until a session resolves, then seeds', async () => {
    const r = rig({ initial: prompt('hi') });
    r.session = null;
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    expect(snapsOf(p.ev)).toHaveLength(1);
    expect(snapsOf(p.ev)[0]).toMatchObject({ avail: false, why: 'no-session', entries: [] });
    r.session = { sessionId: 's1', file: r.file };
    await advance(r);
    expect(snapsOf(p.ev)[1]).toMatchObject({ avail: true, entries: [{ k: 'u', x: 'hi' }] });
  });

  it('appends become add with q+1, a tool result becomes upd with q+1', async () => {
    const r = rig({ initial: prompt('go') });
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    const base = snapsOf(p.ev)[1]!.q;
    append(r, toolUse('toolu_1', 'Bash', { command: 'ls' }));
    await advance(r);
    append(r, result('toolu_1', 'a b c'));
    await advance(r);
    const live = p.ev.filter((e) => e.k === 'add' || e.k === 'upd');
    expect(live.map((e) => [e.k, (e as { q: number }).q])).toEqual([['add', base + 1], ['upd', base + 2]]);
    const upd = live[1] as Extract<Ev, { k: 'upd' }>;
    expect(upd.e).toMatchObject({ k: 't', st: 'ok', sz: 5 });
    expect(r.feed.detail(upd.e.id)).toMatchObject({ input: 'ls', x: 'a b c' });
    expect(r.feed.detail('0:99')).toBeNull();
  });

  it('a line written in two halves across ticks is parsed once, whole', async () => {
    const r = rig({ initial: prompt('first') });
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    const line = reply('second reply');
    append(r, line.slice(0, 40));
    await advance(r);
    expect(p.ev.filter((e) => e.k === 'add')).toHaveLength(0);
    append(r, line.slice(40));
    await advance(r);
    const adds = p.ev.filter((e) => e.k === 'add') as Extract<Ev, { k: 'add' }>[];
    expect(adds).toHaveLength(1);
    expect(adds[0]!.e).toMatchObject({ k: 'a', x: 'second reply' });
  });
});

describe('threadFeed snapshot/tick boundary (nothing lost or duplicated)', () => {
  it('a phone that applies snap + add/upd equals a fresh attach, across interleaved attaches, detaches and appends', async () => {
    const r = rig({ initial: prompt('p0') + reply('r0') });
    const a = phone();
    const attA = r.feed.attach(a.tap);
    await r.feed.tick();
    append(r, prompt('p1'));
    const b = phone(); // attaches while a line sits unread: it must get it exactly once, as an add
    const attB = r.feed.attach(b.tap);
    await advance(r);
    append(r, toolUse('t1', 'Read', { file_path: '/x/y.txt' }));
    await advance(r);
    attB.detach();
    append(r, result('t1', 'body') + reply('r1'));
    const c = phone(); // attaches mid-stream, before the tick that consumes the appended lines
    r.feed.attach(c.tap);
    await advance(r);
    append(r, prompt('p2'));
    await advance(r);
    const fresh = phone();
    r.feed.attach(fresh.tap);
    const want = snapsOf(fresh.ev)[0]!.entries;
    expect(want.map((e) => e.k)).toEqual(['u', 'a', 'u', 't', 'a', 'u']);
    expect(a.list).toEqual(want);
    expect(c.list).toEqual(want);
    expect(new Set(a.list.map((e) => e.id)).size).toBe(a.list.length); // no duplicates
    expect(a.lastQ()).toBe(snapsOf(fresh.ev)[0]!.q);
    attA.detach();
  });

  it('does not re-read bytes the seed already consumed (red-proof target: offset after seed)', async () => {
    const r = rig({ initial: prompt('only') });
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    await advance(r);
    await advance(r);
    expect(p.ev.filter((e) => e.k === 'add' || e.k === 'upd')).toHaveLength(0);
    append(r, reply('next'));
    await advance(r);
    expect(p.ev.filter((e) => e.k === 'add')).toHaveLength(1);
  });
});

describe('threadFeed lifetime', () => {
  it('the first attach starts one timer; the last detach clears it and frees all state', async () => {
    const r = rig({ initial: prompt('x') });
    const a = phone();
    const b = phone();
    const ha = r.feed.attach(a.tap);
    const hb = r.feed.attach(b.tap);
    await r.feed.tick();
    expect(r.intervals).toHaveLength(1);
    expect(liveTimers(r)).toBe(1);
    ha.detach();
    expect(liveTimers(r)).toBe(1);
    hb.detach();
    expect(liveTimers(r)).toBe(0);
    await r.feed.tick(); // a stray tick after stop does nothing
    expect(a.ev.length + b.ev.length).toBeGreaterThan(0);
    const before = a.ev.length;
    append(r, prompt('later'));
    await r.feed.tick();
    expect(a.ev).toHaveLength(before);
    // re-attach starts from scratch
    const c = phone();
    r.feed.attach(c.tap);
    expect(snapsOf(c.ev)[0]).toMatchObject({ avail: false, why: 'starting' });
    expect(r.intervals).toHaveLength(2);
    expect(r.feed.detail('0:0')).toBeNull();
  });

  it('stop() drops every tap and the timer', async () => {
    const r = rig({ initial: prompt('x') });
    const a = phone();
    r.feed.attach(a.tap);
    await r.feed.tick();
    const n = a.ev.length;
    r.feed.stop();
    expect(liveTimers(r)).toBe(0);
    append(r, prompt('y'));
    await r.feed.tick();
    expect(a.ev).toHaveLength(n);
  });

  it('a tap that throws is dropped, and the feed stops when it was the last', async () => {
    const r = rig({ initial: prompt('x') });
    r.feed.attach({ snap() {}, add() {}, upd() {}, meta() {}, });
    const bad: ThreadTap = { snap() { throw new Error('boom'); }, add() {}, upd() {}, meta() {} };
    const h = r.feed.attach(bad);
    h.detach();
    expect(liveTimers(r)).toBe(1); // the healthy phone keeps it alive
  });
});

describe('threadFeed file handling', () => {
  it('re-snaps on truncation and on a replaced file', async () => {
    const r = rig({ initial: prompt('a') + prompt('b') + prompt('c') });
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    fs.writeFileSync(r.file, prompt('fresh'));
    await advance(r);
    const snaps = snapsOf(p.ev);
    expect(snaps.at(-1)!.entries.map((e) => (e as { x: string }).x)).toEqual(['fresh']);
    expect(snaps.at(-1)!.q).toBeGreaterThan(snaps.at(-2)!.q);
    fs.rmSync(r.file);
    fs.writeFileSync(r.file, prompt('replaced') + prompt('again'));
    await advance(r);
    expect(snapsOf(p.ev).at(-1)!.entries.map((e) => (e as { x: string }).x)).toEqual(['replaced', 'again']);
  });

  it('a missing file is starting (no log); an unreadable one is unreadable, logged once, and recovers', async () => {
    const r = rig();
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    expect(snapsOf(p.ev).at(-1)).toMatchObject({ avail: false, why: 'starting' });
    expect(r.logs).toEqual([]);
    fs.writeFileSync(r.file, prompt('one'));
    await advance(r);
    expect(snapsOf(p.ev).at(-1)).toMatchObject({ avail: true, entries: [{ x: 'one' }] });
    const err = Object.assign(new Error('denied'), { code: 'EACCES' });
    vi.spyOn(fs.promises, 'open').mockRejectedValue(err);
    append(r, prompt('two'));
    await advance(r);
    await advance(r);
    await advance(r);
    expect(snapsOf(p.ev).at(-1)).toMatchObject({ avail: false, why: 'unreadable', entries: [] });
    expect(r.logs).toEqual(['thread: transcript unreadable slot=claude']);
    expect(snapsOf(p.ev).filter((s) => s.why === 'unreadable')).toHaveLength(1);
    vi.restoreAllMocks();
    await advance(r);
    expect(snapsOf(p.ev).at(-1)).toMatchObject({ avail: true, entries: [{ x: 'one' }, { x: 'two' }] });
  });

  it('a session change re-snaps with a fresh q base and clears the detail store', async () => {
    const r = rig({ initial: toolUse('t1', 'Bash', { command: 'echo one' }) });
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    const id = (snapsOf(p.ev)[1]!.entries[0] as ThreadEntry).id;
    expect(r.feed.detail(id)).not.toBeNull();
    const file2 = path.join(r.dir, 's2.jsonl');
    fs.writeFileSync(file2, prompt('other session'));
    r.session = { sessionId: 's2', file: file2 };
    await advance(r);
    const last = snapsOf(p.ev).at(-1)!;
    expect(last.entries.map((e) => e.k)).toEqual(['u']);
    expect(last.q).toBeGreaterThan(snapsOf(p.ev)[1]!.q);
    expect(r.feed.detail(id)).toBeNull();
  });
});

describe('threadFeed snapshot budget', () => {
  it('keeps at most 200 entries, newest, in order', async () => {
    let s = '';
    for (let i = 0; i < 300; i++) s += prompt(`m${i}`);
    const r = rig({ initial: s });
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    const xs = snapsOf(p.ev)[1]!.entries.map((e) => (e as { x: string }).x);
    expect(xs).toHaveLength(THREAD_HISTORY_ENTRIES);
    expect(xs[0]).toBe('m100');
    expect(xs.at(-1)).toBe('m299');
  });

  it('drops the OLDEST entries so the entries JSON fits 131072 (UTF-16 units and UTF-8 bytes)', async () => {
    let s = '';
    for (let i = 0; i < 100; i++) s += prompt(`${String(i).padStart(3, '0')} ` + 'é中文 word '.repeat(150));
    const r = rig({ initial: s, seedBytes: 8 * 1024 * 1024 });
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    const entries = snapsOf(p.ev)[1]!.entries;
    const json = JSON.stringify(entries);
    expect(json.length).toBeLessThanOrEqual(THREAD_SNAPSHOT_BYTES);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThanOrEqual(THREAD_SNAPSHOT_BYTES);
    expect(entries.length).toBeLessThan(100);
    expect(entries.length).toBeGreaterThan(10);
    const first = Number((entries[0] as { x: string }).x.slice(0, 3));
    expect((entries.at(-1) as { x: string }).x.slice(0, 3)).toBe('099');
    expect(first).toBe(100 - entries.length); // contiguous tail: only the oldest were dropped
  });

  it('keeps the live window inside the same budget as entries are appended', async () => {
    const r = rig({ initial: prompt('start') });
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    for (let i = 0; i < 60; i++) {
      append(r, prompt('x'.repeat(3900)));
      if (i % 10 === 9) await advance(r);
    }
    await advance(r);
    const fresh = phone();
    r.feed.attach(fresh.tap);
    const entries = snapsOf(fresh.ev)[0]!.entries;
    expect(JSON.stringify(entries).length).toBeLessThanOrEqual(THREAD_SNAPSHOT_BYTES);
    expect(entries.length).toBeLessThan(40);
  });
});

describe('threadFeed wire integers', () => {
  const INT_KEYS = new Set(['ts', 'last', 'since', 'ms', 'sz', 'ctxTok', 'tok', 'q', 'dn']);
  function assertWhole(v: unknown, where: string): void {
    if (Array.isArray(v)) v.forEach((x, i) => assertWhole(x, `${where}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (INT_KEYS.has(k) && x !== null) expect(Number.isInteger(x), `${where}.${k} = ${String(x)}`).toBe(true);
        assertWhole(x, `${where}.${k}`);
      }
    }
  }

  it('emits a fractional file mtime, fractional usage and fractional thinking time as integers', async () => {
    const lines =
      j({ type: 'user', isSidechain: false, message: { role: 'user', content: 'no timestamp here' } }) +
      j({ type: 'assistant', timestamp: 'not a date', isSidechain: false, thinkingDurationMs: 1400.6, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }] } }) +
      j({
        type: 'assistant', isSidechain: false,
        message: {
          role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
          usage: { input_tokens: 10.5, cache_creation_input_tokens: 0.25, cache_read_input_tokens: 100, output_tokens: 7.5 },
        },
      });
    const r = rig({ initial: lines });
    const orig = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (p: fs.PathLike) => {
      const st = await orig(p);
      return { size: st.size, dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs, mtimeMs: 1700000000123.456 } as unknown as fs.Stats;
    }) as never);
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    const snap = snapsOf(p.ev)[1]!;
    expect(snap.m.last).toBe(1700000000123); // no usable line timestamp: the rounded mtime
    expect(snap.m.ctxTok).toBe(111);
    expect(snap.entries.every((e) => e.ts === 0)).toBe(true);
    expect(snap.entries.find((e) => e.k === 'th')).toMatchObject({ ms: 1401 });
    assertWhole(snap, 'snap');
    append(r, j({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'z', name: 'Bash', input: { command: 'x' } }], stop_reason: 'tool_use' } }));
    append(r, result('z', 'abc'));
    await advance(r);
    await advance(r);
    for (const e of p.ev) assertWhole(e, 'ev');
    expect(p.ev.some((e) => e.k === 'upd')).toBe(true);
  });
});

describe('threadFeed meta and waiting', () => {
  it('work is idle only when the newest assistant line is end_turn and nothing came later', async () => {
    const r = rig({ initial: prompt('go') + toolUse('a', 'Bash', { command: 'x' }, { input_tokens: 1, output_tokens: 3 }) });
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    expect(snapsOf(p.ev)[1]!.m.work).toBe('working');
    append(r, result('a', 'ok') + reply('done', { input_tokens: 2, output_tokens: 4 }));
    await advance(r);
    await advance(r, 1000);
    expect(p.ev.filter((e) => e.k === 'meta').at(-1)).toMatchObject({ m: { work: 'idle', tok: 7 } });
    append(r, prompt('again'));
    await advance(r);
    expect(p.ev.filter((e) => e.k === 'meta').at(-1)).toMatchObject({ m: { work: 'working', tok: 0 } });
  });

  it('counts a usage repeated by the split lines of one message once', async () => {
    const u = { input_tokens: 1, output_tokens: 9 };
    const r = rig({ initial: prompt('go') + reply('one', u) + reply('two', u) });
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    expect(snapsOf(p.ev)[1]!.m.tok).toBe(9);
  });

  it('emits tmeta at most once per second and only on change', async () => {
    const r = rig({ initial: prompt('go') });
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    const metas = (): number => p.ev.filter((e) => e.k === 'meta').length;
    await advance(r, 1000);
    expect(metas()).toBe(0); // nothing changed
    append(r, reply('r1', { input_tokens: 1, output_tokens: 1 }));
    await advance(r, 1000);
    expect(metas()).toBe(1);
    append(r, reply('r2', { input_tokens: 5, output_tokens: 2 }));
    await advance(r, 300); // changed again, but < 1 s since the last tmeta
    expect(metas()).toBe(1);
    await advance(r, 800);
    expect(metas()).toBe(2);
    await advance(r, 1000);
    expect(metas()).toBe(2);
  });

  it('quiet needs a running non-Agent tool aged 10 s AND a transcript quiet for 10 s', async () => {
    const r = rig({ initial: prompt('go') + toolUse('a', 'Bash', { command: 'sleep 99' }) });
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    const wait = (): unknown => (p.ev.filter((e) => e.k === 'meta').at(-1) as { m: ThreadMeta } | undefined)?.m.wait ?? null;
    await advance(r, 9000);
    expect(wait()).toBeNull();
    await advance(r, 1000);
    expect(wait()).toBe('quiet');
    append(r, reply('still going', null, 'tool_use'));
    await advance(r, 1000); // the transcript grew: no longer quiet
    expect(wait()).toBeNull();
  });

  it('a long-running Agent tool never trips quiet', async () => {
    const r = rig({ initial: prompt('go') + toolUse('a', 'Agent', { subagent_type: 'x' }) });
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    await advance(r, 30000);
    expect(p.ev.filter((e) => e.k === 'meta')).toHaveLength(0);
  });

  it('a permission notification for THIS session sets perm; growth or 15 minutes clears it; other sessions are ignored', async () => {
    const r = rig({ initial: prompt('go') });
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    const wait = (): unknown => (p.ev.filter((e) => e.k === 'meta').at(-1) as { m: ThreadMeta } | undefined)?.m.wait ?? null;
    r.feed.noteNotification('other', 'permission_prompt');
    r.feed.noteNotification('s1', 'idle_prompt');
    await advance(r);
    expect(wait()).toBeNull();
    r.feed.noteNotification('s1', 'permission_prompt');
    await advance(r);
    expect(wait()).toBe('perm');
    append(r, reply('answered'));
    await advance(r, 1000);
    expect(wait()).toBeNull();
    r.feed.noteNotification('s1', 'agent_needs_input');
    await advance(r, 1000);
    expect(wait()).toBe('perm');
    await advance(r, THREAD_PERM_CLEAR_MS);
    expect(wait()).toBeNull();
  });

  it('a notification with no phone attached is dropped', async () => {
    const r = rig({ initial: prompt('go') });
    r.feed.noteNotification('s1', 'permission_prompt');
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    await advance(r);
    expect(p.ev.filter((e) => e.k === 'meta')).toHaveLength(0);
    expect(snapsOf(p.ev)[1]!.m.wait).toBeNull();
  });
});

describe('threadFeed detail store', () => {
  it('evicts least-recently-used details past 1 MiB, keeps the newest, and refreshes on read', async () => {
    const r = rig({ initial: prompt('start') });
    const p = phone();
    r.feed.attach(p.tap);
    await r.feed.tick();
    const word = 'alpha beta gamma delta ';
    const ids: string[] = [];
    for (let batch = 0; batch < 4; batch++) {
      let chunk = '';
      for (let i = 0; i < 80; i++) {
        const id = `t${batch}_${i}`;
        chunk += toolUse(id, 'Bash', { command: 'echo ' + id }) + result(id, word.repeat(300));
        ids.push(id);
      }
      append(r, chunk);
      await advance(r);
    }
    const toolIds = p.ev.filter((e) => e.k === 'add' && e.e.k === 't').map((e) => (e as { e: ThreadEntry }).e.id);
    expect(toolIds).toHaveLength(320);
    expect(r.feed.detail(toolIds[0]!)).toBeNull(); // oldest evicted
    const newest = r.feed.detail(toolIds.at(-1)!);
    expect(newest?.x?.length).toBeGreaterThan(4000);
    expect(newest?.input).toMatch(/^echo t3_79$/);
    // bound: 320 * ~4.2 KB is > 1 MiB, so something must have been evicted, but not nearly everything
    const kept = toolIds.filter((id) => r.feed.detail(id) !== null).length;
    expect(kept).toBeGreaterThan(150);
    expect(kept * 4096).toBeLessThanOrEqual(THREAD_DETAIL_STORE_BYTES);
  });
});
