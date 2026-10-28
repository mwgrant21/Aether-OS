// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { PtyLike } from './ptyLifecycle';
import { createTerminalHub, splitUtf8, type SlotEvent } from './terminalHub';
import { createTerminalMirror, type TerminalMirror } from './terminalMirror';
import {
  TERMINAL_CHUNK_MAX_BYTES, TERMINAL_SNAPSHOT_BYTES, type TerminalAttachment, type TerminalTap,
} from '../src/shared/remote/types';

function fakePty(): PtyLike & { fireExit: () => void; fireData: (d: string) => void } {
  let exitCb: (() => void) | null = null;
  let dataCb: ((d: string) => void) | null = null;
  return {
    onData: (cb) => { dataCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    kill: vi.fn(), write: vi.fn(), resize: vi.fn(),
    fireExit: () => exitCb?.(),
    fireData: (d) => dataCb?.(d),
  };
}
const handlers = () => ({ onData: vi.fn(), onAlive: vi.fn(), onExit: vi.fn() });
function setup() {
  const slot = createTerminalHub().slot('claude');
  const events: SlotEvent[] = [];
  slot.observe((e) => events.push(e));
  return { slot, events };
}

describe('terminalHub', () => {
  it('hands out three distinct slots that start not-started at 0x0', () => {
    const hub = createTerminalHub();
    const ids = ['claude', 'terminal2', 'codex'] as const;
    expect(new Set(ids.map((id) => hub.slot(id))).size).toBe(3);
    expect(hub.slot('terminal2').info()).toEqual({ s: 'terminal2', label: 'Terminal 2', state: 'not-started', cols: 0, rows: 0, q: 0 });
  });

  it('start -> running with the given size; invalid size falls back to 100x30', () => {
    const { slot } = setup();
    slot.start(() => fakePty(), handlers(), { cols: 80, rows: 24 });
    expect(slot.info()).toMatchObject({ state: 'running', cols: 80, rows: 24 });
    slot.start(() => fakePty(), handlers(), { cols: 0, rows: 24 });
    expect(slot.info()).toMatchObject({ cols: 100, rows: 30 });
    slot.start(() => fakePty(), handlers());
    expect(slot.info()).toMatchObject({ cols: 100, rows: 30 });
  });

  it('exit -> exited; a superseded pty produces no events', () => {
    const { slot, events } = setup();
    const first = fakePty(), second = fakePty();
    slot.start(() => first, handlers());
    slot.start(() => second, handlers());
    events.length = 0;
    first.fireData('stale'); first.fireExit();
    expect(events).toEqual([]);
    expect(slot.info().state).toBe('running');
    second.fireExit();
    expect(slot.info().state).toBe('exited');
    expect(events).toEqual([{ kind: 'state', state: 'exited' }]);
  });

  it('replacement bumps q exactly once and emits start', () => {
    const { slot, events } = setup();
    slot.start(() => fakePty(), handlers());
    expect(slot.info().q).toBe(1);
    events.length = 0;
    slot.start(() => fakePty(), handlers(), { cols: 90, rows: 20 });
    expect(slot.info().q).toBe(2);
    expect(events.filter((e) => e.kind === 'start')).toEqual([{ kind: 'start', q: 2, cols: 90, rows: 20 }]);
  });

  it('q is strictly +1 across chunks and a 40 KiB chunk becomes 3 pieces', () => {
    const { slot, events } = setup();
    const pty = fakePty();
    slot.start(() => pty, handlers());
    const base = slot.info().q;
    pty.fireData('a'); pty.fireData('b');
    pty.fireData('x'.repeat(40 * 1024));
    const outs = events.filter((e): e is Extract<SlotEvent, { kind: 'out' }> => e.kind === 'out');
    expect(outs.map((o) => o.q)).toEqual([base + 1, base + 2, base + 3, base + 4, base + 5]);
    expect(outs.slice(2).map((o) => o.d.length)).toEqual([TERMINAL_CHUNK_MAX_BYTES, TERMINAL_CHUNK_MAX_BYTES, 8 * 1024]);
    expect(slot.info().q).toBe(base + 5);
  });

  it('never splits a surrogate pair at the byte boundary', () => {
    const emoji = '\u{1F600}'; // 4 bytes
    const data = 'a'.repeat(TERMINAL_CHUNK_MAX_BYTES - 3) + emoji + 'b';
    const pieces = splitUtf8(data, TERMINAL_CHUNK_MAX_BYTES);
    expect(pieces).toEqual(['a'.repeat(TERMINAL_CHUNK_MAX_BYTES - 3), emoji + 'b']);
    expect(pieces.join('')).toBe(data);
    for (const p of pieces) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(TERMINAL_CHUNK_MAX_BYTES);
  });

  it('runs the renderer handler before observers; a throwing observer stops neither', () => {
    const slot = createTerminalHub().slot('codex');
    const order: string[] = [];
    const h = { onData: () => order.push('renderer'), onAlive: () => order.push('orig-alive'), onExit: () => order.push('orig-exit') };
    slot.observe(() => { order.push('bad'); throw new Error('boom'); });
    slot.observe((e) => order.push(`good:${e.kind}`));
    const pty = fakePty();
    slot.start(() => pty, h);
    pty.fireData('hi');
    expect(order).toEqual(['bad', 'good:start', 'bad', 'good:state', 'orig-alive', 'renderer', 'bad', 'good:out']);
  });

  it('calls the original onAlive exactly once per start, after hub state is running', () => {
    const { slot } = setup();
    let stateAtAlive = '';
    const h = handlers();
    h.onAlive.mockImplementation(() => { stateAtAlive = slot.info().state; });
    slot.start(() => fakePty(), h);
    expect(h.onAlive).toHaveBeenCalledTimes(1);
    expect(stateAtAlive).toBe('running');
  });

  it('resize records size and emits; a throwing resize records nothing; invalid dims ignored', () => {
    const { slot, events } = setup();
    const pty = fakePty();
    slot.start(() => pty, handlers(), { cols: 80, rows: 24 });
    events.length = 0;
    slot.resize(120, 40);
    expect(slot.info()).toMatchObject({ cols: 120, rows: 40 });
    expect(events).toEqual([{ kind: 'size', cols: 120, rows: 40 }]);
    (pty.resize as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error('native'); });
    events.length = 0;
    expect(() => slot.resize(10, 10)).toThrow('native');
    slot.resize(0, 10); slot.resize(1.5, 10); slot.resize(10, -1);
    expect(slot.info()).toMatchObject({ cols: 120, rows: 40 });
    expect(events).toEqual([]);
  });

  it('resize with no live pty does not invent a size', () => {
    const { slot } = setup();
    slot.resize(120, 40);
    expect(slot.info()).toMatchObject({ cols: 0, rows: 0 });
  });
});

describe('terminalHub slot hardening', () => {
  it('a throwing renderer handler does not skip the hub fan-out', () => {
    const { slot, events } = setup();
    const pty = fakePty();
    slot.start(() => pty, { ...handlers(), onData: () => { throw new Error('renderer'); } });
    events.length = 0;
    expect(() => pty.fireData('hi')).toThrow('renderer');
    expect(events).toEqual([{ kind: 'out', q: slot.info().q, d: 'hi' }]);
  });

  it('an exit firing synchronously inside start leaves the slot exited, with the start marker kept', () => {
    const { slot, events } = setup();
    const h = handlers();
    const pty = fakePty();
    pty.onExit = (cb) => { cb(); }; // exits while being wired
    slot.start(() => pty, h);
    expect(slot.info()).toMatchObject({ state: 'exited', q: 1, cols: 100, rows: 30 });
    expect(events.map((e) => e.kind)).toEqual(['state', 'start']);
    expect(h.onExit).toHaveBeenCalledTimes(1);
    expect(h.onAlive).toHaveBeenCalledTimes(1);
  });
});

// ---- read path ----

interface MadeMirror { writes: string[]; resolvers: Array<() => void>; resizes: Array<[number, number]>; disposed: boolean; cols: number; rows: number }
/** Controllable fake mirror: snapshot() stays pending until the test resolves it, and reports the writes seen when it was called. */
function fakeMirrors() {
  const made: MadeMirror[] = [];
  const create = ({ cols, rows }: { cols: number; rows: number }): TerminalMirror => {
    const st: MadeMirror = { writes: [], resolvers: [], resizes: [], disposed: false, cols, rows };
    made.push(st);
    return {
      write: (d) => { st.writes.push(d); },
      resize: (c, r) => { st.resizes.push([c, r]); st.cols = c; st.rows = r; },
      snapshot: () => {
        const upTo = st.writes.length;
        return new Promise((resolve) => {
          st.resolvers.push(() => resolve({ cols: st.cols, rows: st.rows, d: st.writes.slice(0, upTo).join('') }));
        });
      },
      dispose: () => { st.disposed = true; },
      pendingBytes: () => 0,
    };
  };
  return { made, create };
}
function recorder() {
  const ev: string[] = [];
  const tap: TerminalTap = {
    snap: (e) => { ev.push(`snap ${e.q} ${e.cols}x${e.rows} ${JSON.stringify(e.d)}`); },
    out: (e) => { ev.push(`out ${e.q} ${e.d}`); },
    size: (e) => { ev.push(`size ${e.cols}x${e.rows}`); },
  };
  return { ev, tap };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
function readSetup(real = false) {
  const fm = fakeMirrors();
  const hub = createTerminalHub(real ? {} : { createMirror: fm.create });
  const slot = hub.slot('claude');
  const port = hub.readPort();
  const pty = fakePty();
  const start = (size = { cols: 80, rows: 24 }) => slot.start(() => pty, handlers(), size);
  return { hub, slot, port, pty, fm, start };
}

describe('terminalHub read port', () => {
  it('exposes exactly list/attach/onState/retain', () => {
    const port = createTerminalHub().readPort();
    expect(Object.keys(port).sort()).toEqual(['attach', 'list', 'onState', 'retain']);
  });

  it('list reflects state, size and q for all three slots', () => {
    const { port, start } = readSetup();
    start({ cols: 90, rows: 20 });
    const list = port.list();
    expect(list.map((i) => i.s)).toEqual(['claude', 'terminal2', 'codex']);
    expect(list[0]).toEqual({ s: 'claude', label: 'Terminal', state: 'running', cols: 90, rows: 20, q: 1 });
    expect(list[1]).toMatchObject({ state: 'not-started', cols: 0, rows: 0, q: 0 });
  });

  it('retain: nothing is mirrored before it; two retains need two releases; release is idempotent; 0 drops taps', () => {
    const { port, pty, fm, start } = readSetup();
    start();
    pty.fireData('before');
    expect(fm.made).toHaveLength(0);
    const unretained = recorder();
    port.attach('claude', null, unretained.tap);
    expect(unretained.ev).toEqual(['snap 2 80x24 ""']);
    pty.fireData('later');
    expect(unretained.ev).toHaveLength(1); // not registered while unretained

    const r1 = port.retain();
    const r2 = port.retain();
    expect(fm.made).toHaveLength(1); // one running slot
    expect(fm.made[0]).toMatchObject({ cols: 80, rows: 24 });
    const rec = recorder();
    port.attach('claude', 3, rec.tap); // q after 'before','later' + start = 3: resumes to nothing
    r1(); r1(); // idempotent: does not consume r2's retain
    expect(fm.made[0].disposed).toBe(false);
    pty.fireData('x');
    expect(rec.ev).toEqual(['out 4 x']);
    r2();
    expect(fm.made[0].disposed).toBe(true);
    pty.fireData('y');
    expect(rec.ev).toEqual(['out 4 x']); // dropped at 0: no callbacks after
    expect(fm.made[0].writes).toEqual(['x']);
  });

  it('snapshot-then-live: output between attach and snapshot completion has no gap and no duplicate', async () => {
    const { port, pty, fm, start } = readSetup();
    port.retain();
    start();                       // q=1
    pty.fireData('a');            // q=2
    const rec = recorder();
    port.attach('claude', null, rec.tap);
    pty.fireData('b');            // q=3, arrives while the snapshot is pending
    pty.fireData('c');            // q=4
    expect(rec.ev).toEqual([]);
    fm.made[0].resolvers[0]();
    await flush();
    pty.fireData('d');            // q=5, live
    expect(rec.ev).toEqual(['snap 2 80x24 "a"', 'out 3 b', 'out 4 c', 'out 5 d']);
  });

  it('same guarantee with the real mirror and a resize inside the await', async () => {
    const { port, slot, pty, start } = readSetup(true);
    port.retain();
    start({ cols: 40, rows: 5 });
    pty.fireData('one\r\n');
    const rec = recorder();
    const seen: string[] = [];
    port.attach('claude', null, { ...rec.tap, snap: (e) => { seen.push(e.d); rec.tap.snap(e); } });
    pty.fireData('two\r\n');
    slot.resize(50, 6);
    pty.fireData('three\r\n');
    await vi.waitFor(() => expect(rec.ev.length).toBeGreaterThanOrEqual(4));
    expect(rec.ev[0]).toMatch(/^snap 2 40x5 /);
    expect(seen[0]).toContain('one');
    expect(seen[0]).not.toContain('two');
    expect(rec.ev.slice(1)).toEqual(['out 3 two\r\n', 'size 50x6', 'out 4 three\r\n']);
  });

  it('output injected during the replay loop keeps order and does not duplicate', () => {
    const { port, pty, start } = readSetup();
    port.retain();
    start();
    pty.fireData('a'); pty.fireData('b'); pty.fireData('c'); // q 2,3,4
    const got: number[] = [];
    port.attach('claude', 1, {
      snap: () => undefined, size: () => undefined,
      out: (e) => { got.push(e.q); if (e.q === 2) pty.fireData('late'); }, // re-enters the slot mid-replay
    });
    expect(got).toEqual([2, 3, 4, 5]);
  });

  it('two attaches racing on one slot each get a gapless stream', async () => {
    const { port, pty, fm, start } = readSetup();
    port.retain();
    start();
    pty.fireData('a');
    const t1 = recorder(), t2 = recorder();
    port.attach('claude', null, t1.tap);
    pty.fireData('b');
    port.attach('claude', null, t2.tap);
    pty.fireData('c');
    fm.made[0].resolvers[1](); fm.made[0].resolvers[0]();
    await flush();
    pty.fireData('d');
    expect(t1.ev).toEqual(['snap 2 80x24 "a"', 'out 3 b', 'out 4 c', 'out 5 d']);
    expect(t2.ev).toEqual(['snap 3 80x24 "ab"', 'out 4 c', 'out 5 d']);
  });

  it('exact resume continues at lastQ+1', () => {
    const { port, pty, start } = readSetup();
    port.retain();
    start();
    ['a', 'b', 'c'].forEach((d) => pty.fireData(d)); // q 2..4
    const rec = recorder();
    port.attach('claude', 2, rec.tap);
    pty.fireData('d');
    expect(rec.ev).toEqual(['out 3 b', 'out 4 c', 'out 5 d']);
  });

  it('refuses resume after ring trim, a resize, a restart, or a client ahead of the hub', async () => {
    const { port, slot, pty, fm, start } = readSetup();
    port.retain();
    start();
    const snapshotOnly = async (lastQ: number): Promise<string> => {
      const rec = recorder();
      port.attach('claude', lastQ, rec.tap);
      const m = fm.made[fm.made.length - 1];
      m.resolvers.splice(0).forEach((r) => r());
      await flush();
      return rec.ev[0]?.split(' ')[0] ?? 'none';
    };
    // (a) trim: 60 ESC-dense chunks are ~360K escaped, over the 256K budget
    for (let i = 0; i < 60; i++) pty.fireData('\x1b'.repeat(1000));
    expect(await snapshotOnly(1)).toBe('snap');
    expect(await snapshotOnly(slot.info().q - 40)).not.toBe('snap'); // still inside the ring
    // (d) client ahead
    expect(await snapshotOnly(slot.info().q + 5)).toBe('snap');
    // (b) resize after lastQ
    const q0 = slot.info().q;
    slot.resize(100, 40);
    pty.fireData('after');
    expect(await snapshotOnly(q0)).toBe('snap');
    expect(await snapshotOnly(slot.info().q)).not.toBe('snap'); // saw output after the resize
    // (c) restart
    const before = slot.info().q;
    slot.start(() => fakePty(), handlers(), { cols: 80, rows: 24 });
    expect(await snapshotOnly(before)).toBe('snap');
  });

  it('refuses resume across a resize that happened while the port was unretained', async () => {
    const { port, slot, pty, fm, start } = readSetup();
    const release = port.retain();
    start();
    pty.fireData('a');
    const q = slot.info().q;
    release();
    slot.resize(120, 40);
    port.retain();
    const rec = recorder();
    port.attach('claude', q, rec.tap);
    expect(rec.ev).toEqual([]); // not resumed to nothing: a snapshot is pending
    fm.made[fm.made.length - 1].resolvers[0]();
    await flush();
    expect(rec.ev).toEqual([`snap ${q} 120x40 ""`]); // content was dropped at release
  });

  it('trims the ring at the JSON-escaped budget', () => {
    const { port, pty, fm, start } = readSetup();
    port.retain();
    start();
    for (let i = 0; i < 100; i++) pty.fireData('\x1b'.repeat(1000)); // 6002 escaped each: 43 fit in 256 KiB
    const q = port.list()[0].q;
    const fits = recorder();
    port.attach('claude', q - 43, fits.tap);
    expect(fits.ev).toHaveLength(43);
    const trimmed = recorder();
    port.attach('claude', q - 44, trimmed.tap);
    expect(trimmed.ev).toEqual([]); // refused: a snapshot was requested instead of a replay
    expect(fm.made[0].resolvers).toHaveLength(1);
  });

  it('exited slot: ring and mirror are gone, lastQ == q resumes to nothing, a fresh attach gets an empty snap', () => {
    const { port, pty, fm, start } = readSetup();
    port.retain();
    start();
    pty.fireData('secret');
    pty.fireExit();
    expect(fm.made[0].disposed).toBe(true);
    const q = port.list()[0].q;
    const same = recorder();
    port.attach('claude', q, same.tap);
    expect(same.ev).toEqual([]);
    const stale = recorder();
    port.attach('claude', q - 1, stale.tap);
    expect(stale.ev).toEqual([`snap ${q} 80x24 ""`]);
    const fresh = recorder();
    port.attach('claude', null, fresh.tap);
    expect(fresh.ev).toEqual([`snap ${q} 80x24 ""`]);
  });

  it('attach to a not-started slot reports 0x0 with an empty d, then start delivers an empty snap at the new q', () => {
    const { port, slot } = readSetup();
    port.retain();
    const rec = recorder();
    port.attach('claude', null, rec.tap);
    expect(rec.ev).toEqual(['snap 0 0x0 ""']);
    slot.start(() => fakePty(), handlers(), { cols: 70, rows: 20 });
    expect(rec.ev[1]).toBe('snap 1 70x20 ""');
  });

  it('a restart while a snapshot is pending delivers only the new empty snap', async () => {
    const { port, slot, pty, fm, start } = readSetup();
    port.retain();
    start();
    pty.fireData('old');
    const rec = recorder();
    port.attach('claude', null, rec.tap);
    slot.start(() => fakePty(), handlers(), { cols: 80, rows: 24 });
    fm.made[0].resolvers[0]();
    await flush();
    expect(rec.ev).toEqual(['snap 3 80x24 ""']);
    expect(fm.made[0].disposed).toBe(true);
  });

  it('a snapshot pending at exit still completes with its content', async () => {
    const { port, pty, fm, start } = readSetup();
    port.retain();
    start();
    pty.fireData('last words');
    const rec = recorder();
    port.attach('claude', null, rec.tap);
    pty.fireExit();
    fm.made[0].resolvers[0]();
    await flush();
    expect(rec.ev).toEqual(['snap 2 80x24 "last words"']);
    expect(fm.made[0].disposed).toBe(true);
  });

  it('a throwing tap is dropped without affecting other taps, observers or the renderer', () => {
    const { port, slot, pty } = readSetup();
    port.retain();
    const h = handlers();
    slot.start(() => pty, h, { cols: 80, rows: 24 });
    const seen: SlotEvent[] = [];
    slot.observe((e) => seen.push(e));
    const good = recorder();
    let calls = 0;
    port.attach('claude', 1, { snap: () => undefined, size: () => undefined, out: () => { calls += 1; throw new Error('tap'); } });
    port.attach('claude', 1, good.tap);
    pty.fireData('a'); pty.fireData('b');
    expect(calls).toBe(1);
    expect(good.ev).toEqual(['out 2 a', 'out 3 b']);
    expect(seen.filter((e) => e.kind === 'out')).toHaveLength(2);
    expect(h.onData).toHaveBeenCalledTimes(2);
  });

  it('detach stops delivery immediately, is idempotent, and works from inside a callback', () => {
    const { port, pty, start } = readSetup();
    port.retain();
    start();
    const rec = recorder();
    const a = port.attach('claude', 1, rec.tap);
    pty.fireData('a');
    a.detach(); a.detach();
    pty.fireData('b');
    expect(rec.ev).toEqual(['out 2 a']);
    const got: number[] = [];
    const att: { a?: TerminalAttachment } = {};
    att.a = port.attach('claude', 3, {
      snap: () => undefined, size: () => undefined,
      out: (e) => { got.push(e.q); att.a?.detach(); },
    });
    pty.fireData('c'); pty.fireData('d');
    expect(got).toEqual([4]); // detached inside the callback: nothing after it
  });

  it('onState fires for every slot and unsubscribes', () => {
    const hub = createTerminalHub();
    const port = hub.readPort();
    const seen: string[] = [];
    const off = port.onState((e) => seen.push(`${e.s}:${e.state}`));
    const p1 = fakePty(), p2 = fakePty();
    hub.slot('claude').start(() => p1, handlers());
    hub.slot('codex').start(() => p2, handlers());
    p1.fireExit();
    expect(seen).toEqual(['claude:running', 'codex:running', 'claude:exited']);
    off();
    p2.fireExit();
    expect(seen).toHaveLength(3);
  });

  it('honours the snapshot byte cap end to end with ESC-dense output', async () => {
    const { port, pty, start } = readSetup(true);
    port.retain();
    start({ cols: 200, rows: 30 });
    for (let r = 0; r < 400; r++) {
      let line = '';
      for (let c = 0; c < 200; c++) line += `\x1b[38;5;${(r + c) % 256}m\x1b[48;5;${(r * 7 + c) % 256}m${String.fromCharCode(65 + ((r + c) % 26))}`;
      pty.fireData(`${line}\x1b[0m\r\n`);
    }
    const sizes: number[] = [];
    port.attach('claude', null, { snap: (e) => { sizes.push(JSON.stringify(e.d).length); }, out: () => undefined, size: () => undefined });
    await vi.waitFor(() => expect(sizes).toHaveLength(1));
    expect(sizes[0]).toBeLessThanOrEqual(TERMINAL_SNAPSHOT_BYTES);
    expect(sizes[0]).toBeGreaterThan(1000);
  });

  it('LOAD (report only): 50 MB through one slot with mirror and ring on', async () => {
    let peak = 0;
    const live: TerminalMirror[] = [];
    const hub = createTerminalHub({
      createMirror: (o) => {
        const real = createTerminalMirror(o);
        const wrapped: TerminalMirror = {
          ...real,
          write: (d) => { real.write(d); peak = Math.max(peak, real.pendingBytes()); },
        };
        live.push(wrapped);
        return wrapped;
      },
    });
    const slot = hub.slot('claude');
    const port = hub.readPort();
    port.retain();
    const pty = fakePty();
    slot.start(() => pty, handlers(), { cols: 120, rows: 40 });
    const unit = 'plain text line of output \x1b[32mgreen\x1b[0m tail\r\n';
    const chunk = unit.repeat(Math.ceil(16384 / unit.length));
    const total = 50 * 1024 * 1024;
    const t0 = performance.now();
    for (let fed = 0, sinceYield = 0; fed < total; fed += chunk.length) {
      pty.fireData(chunk);
      sinceYield += chunk.length;
      if (sinceYield >= 1024 * 1024) { sinceYield = 0; await flush(); } // the PTY delivers ~1 MB per tick
    }
    const rec = recorder();
    port.attach('claude', null, rec.tap);
    await vi.waitFor(() => expect(rec.ev.length).toBeGreaterThan(0), { timeout: 240_000, interval: 50 });
    const ms = performance.now() - t0;
    console.log(`LOAD 50 MB through one slot in ${ms.toFixed(0)} ms, peak buffered write units ${peak}`);
    expect(rec.ev[0]).toMatch(/^snap /);
  }, 300_000);
});

describe('terminalHub writePort', () => {
  it('writes to a running slot and reports true', () => {
    const hub = createTerminalHub();
    const pty = fakePty();
    hub.slot('codex').start(() => pty, handlers());
    expect(hub.writePort().write('codex', 'hi\r')).toBe(true);
    expect(vi.mocked(pty.write).mock.calls).toEqual([['hi\r']]);
  });

  it('returns false for not-started and exited slots, without touching the pty', () => {
    const hub = createTerminalHub();
    expect(hub.writePort().write('claude', 'x')).toBe(false);
    const pty = fakePty();
    hub.slot('claude').start(() => pty, handlers());
    pty.fireExit();
    expect(hub.writePort().write('claude', 'x')).toBe(false);
    expect(pty.write).not.toHaveBeenCalled();
  });

  it('returns false when the pty write throws', () => {
    const hub = createTerminalHub();
    const pty = fakePty();
    (pty.write as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('dead pty'); });
    hub.slot('terminal2').start(() => pty, handlers());
    expect(hub.writePort().write('terminal2', 'x')).toBe(false);
  });

  // terminal2 slot with a restarter that respawns, already exited
  function exitedT2() {
    const hub = createTerminalHub();
    const slot = hub.slot('terminal2');
    const old = fakePty(), fresh = fakePty();
    const spawn = vi.fn(() => fresh);
    const restarter = vi.fn(() => { slot.start(spawn, handlers(), { cols: 80, rows: 24 }); });
    slot.setRestarter(restarter);
    slot.start(() => old, handlers(), { cols: 80, rows: 24 });
    old.fireExit();
    return { hub, slot, old, fresh, spawn, restarter };
  }

  it('a bare Enter on an exited slot respawns it, via the writePort and via slot.write', () => {
    const a = exitedT2();
    const q = a.slot.info().q;
    expect(a.hub.writePort().write('terminal2', '\r')).toBe(true);
    expect(a.spawn).toHaveBeenCalledTimes(1);
    expect(a.slot.info().state).toBe('running');
    expect(a.slot.info().q).toBeGreaterThan(q);
    expect(a.old.write).not.toHaveBeenCalled();
    const b = exitedT2();
    b.slot.write('\r');
    expect(b.spawn).toHaveBeenCalledTimes(1);
    expect(b.slot.info().state).toBe('running');
  });

  it('ignores any input but a bare Enter on an exited slot', () => {
    const t = exitedT2();
    for (const d of ['x', '\r\n', 'a\r', '\n', '\u001b']) {
      expect(t.hub.writePort().write('terminal2', d)).toBe(false);
      t.slot.write(d);
    }
    expect(t.restarter).not.toHaveBeenCalled();
    expect(t.old.write).not.toHaveBeenCalled();
    expect(t.slot.info().state).toBe('exited');
  });

  it('Enter on a live slot is a plain write, and an exited slot without a restarter stays dead', () => {
    const hub = createTerminalHub();
    const slot = hub.slot('terminal2');
    const restarter = vi.fn();
    slot.setRestarter(restarter);
    const pty = fakePty();
    slot.start(() => pty, handlers());
    expect(hub.writePort().write('terminal2', '\r')).toBe(true);
    expect(vi.mocked(pty.write).mock.calls).toEqual([['\r']]);
    expect(restarter).not.toHaveBeenCalled();
    const claude = hub.slot('claude');
    const cp = fakePty();
    const spawn = vi.fn(() => cp);
    claude.start(spawn, handlers());
    cp.fireExit();
    expect(hub.writePort().write('claude', '\r')).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('desktop and phone Enter back to back restart once, in either order', () => {
    for (const phoneFirst of [false, true]) {
      const t = exitedT2();
      const phone = () => t.hub.writePort().write('terminal2', '\r');
      const desktop = () => t.slot.write('\r');
      (phoneFirst ? phone : desktop)();
      (phoneFirst ? desktop : phone)();
      expect(t.spawn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(t.fresh.write).mock.calls).toEqual([['\r']]);
      expect(t.old.write).not.toHaveBeenCalled();
    }
  });

  it('a throwing restarter reports false, leaves the slot exited, and a later Enter retries', () => {
    const t = exitedT2();
    t.restarter.mockImplementationOnce(() => { throw new Error('spawn failed'); });
    expect(t.hub.writePort().write('terminal2', '\r')).toBe(false);
    expect(t.slot.info().state).toBe('exited');
    expect(t.hub.writePort().write('terminal2', '\r')).toBe(true);
    expect(t.slot.info().state).toBe('running');
  });

  it('exposes only write', () => {
    expect(Object.keys(createTerminalHub().writePort())).toEqual(['write']);
  });
});
