// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { PtyLike } from './ptyLifecycle';
import { createTerminalHub } from './terminalHub';
import type { TerminalMirror } from './terminalMirror';
import { createDesktopFeed } from './desktopFeed';

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
/** Fake mirror whose snapshot() stays pending until resolved, reporting the writes seen when it was called. */
function fakeMirrors() {
  const resolvers: Array<() => void> = [];
  const create = ({ cols, rows }: { cols: number; rows: number }): TerminalMirror => {
    const writes: string[] = [];
    return {
      write: (d) => { writes.push(d); },
      resize: () => undefined,
      snapshot: () => {
        const upTo = writes.length;
        return new Promise((resolve) => { resolvers.push(() => resolve({ cols, rows, d: writes.slice(0, upTo).join('') })); });
      },
      viewportText: () => Promise.resolve([]),
      dispose: () => undefined,
      pendingBytes: () => 0,
    };
  };
  return { resolvers, create };
}
const handlers = () => ({ onData: vi.fn(), onAlive: vi.fn(), onExit: vi.fn() });
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const CH = { data: 'term:data', snap: 'term:snap', exit: 'term:exit' };

function setup(o: { real?: boolean; retain?: boolean } = {}) {
  const fm = fakeMirrors();
  const hub = createTerminalHub(o.real ? {} : { createMirror: fm.create });
  const port = hub.readPort();
  const detaches: Array<ReturnType<typeof vi.fn>> = [];
  const realAttach = port.attach.bind(port);
  port.attach = (...a: Parameters<typeof port.attach>) => {
    const att = realAttach(...a); const detach = vi.fn(() => att.detach()); detaches.push(detach);
    return { ...att, detach };
  };
  if (o.retain !== false) port.retain();
  const slot = hub.slot('claude');
  const pty = fakePty();
  slot.start(() => pty, handlers(), { cols: 40, rows: 5 });
  const sent: Array<[string, unknown]> = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const feed = createDesktopFeed({
    port, slot: 'claude', channels: CH,
    send: (c, p) => { sent.push([c, p]); },
    setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
  });
  // main feeds the hub (via the pty) and the feed with the same chunk
  const emit = (d: string) => { pty.fireData(d); feed.data(d); };
  return { fm, feed, pty, sent, timers, emit, detaches, slot };
}

describe('desktopFeed', () => {
  it('delivers the snapshot, then chunks held meanwhile, each exactly once and in order', async () => {
    const { fm, feed, sent, emit } = setup();
    emit('a');                               // before attach: live-sent, and in the snap
    expect(sent).toEqual([[CH.data, 'a']]);
    sent.length = 0;
    feed.reattach();
    emit('b'); emit('c');                    // while the snapshot is pending
    expect(sent).toEqual([]);
    fm.resolvers[0]();
    await flush();
    emit('d');
    expect(sent).toEqual([
      [CH.snap, { cols: 40, rows: 5, d: 'a' }],
      [CH.data, 'b'], [CH.data, 'c'], [CH.data, 'd'],
    ]);
  });

  it('an exit while the snapshot is pending is sent after the snapshot and held data; an exit with no snapshot pending is sent at once', async () => {
    const { fm, feed, sent, emit } = setup();
    feed.exit();
    expect(sent).toEqual([[CH.exit, undefined]]);
    sent.length = 0;
    feed.reattach();
    emit('b');
    feed.exit();
    expect(sent).toEqual([]);
    fm.resolvers[0]();
    await flush();
    expect(sent).toEqual([[CH.snap, { cols: 40, rows: 5, d: '' }], [CH.data, 'b'], [CH.exit, undefined]]);
  });

  it('an exit held behind the snapshot is dropped when the slot restarts before release; held data still flushes', () => {
    const { feed, pty, sent, slot, emit } = setup();
    feed.reattach();
    emit('x');
    pty.fireExit(); feed.exit();
    slot.start(() => fakePty(), handlers(), { cols: 40, rows: 5 });
    expect(sent).toEqual([[CH.snap, { cols: 40, rows: 5, d: '' }], [CH.data, 'x']]);
    feed.exit();
    expect(sent[sent.length - 1]).toEqual([CH.exit, undefined]);
  });

  it('when the hub is not retained the snap is empty and live data still flows', () => {
    const { feed, sent, emit } = setup({ retain: false });
    emit('a');
    sent.length = 0;
    feed.reattach();
    expect(sent).toEqual([[CH.snap, { cols: 40, rows: 5, d: '' }]]);
    emit('b');
    expect(sent[1]).toEqual([CH.data, 'b']);
  });

  it('a slot that exits while the snapshot is pending is released by the timeout, held data flushed once', async () => {
    const { feed, pty, sent, timers, emit } = setup();
    feed.reattach();
    emit('x');
    pty.fireExit();
    await flush();
    expect(sent).toEqual([]);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(2000);
    timers[0].fn();
    expect(sent).toEqual([[CH.data, 'x']]);
    timers[0].fn(); // firing again does not re-flush
    emit('y');
    expect(sent).toEqual([[CH.data, 'x'], [CH.data, 'y']]);
  });

  it('the timeout path also detaches the hub tap, so it does not linger', async () => {
    const { feed, pty, timers, detaches } = setup();
    feed.reattach();
    pty.fireExit();
    await flush();
    expect(detaches[0]).not.toHaveBeenCalled();
    timers[0].fn();
    expect(detaches[0]).toHaveBeenCalledOnce();
  });

  it('a second reattach supersedes the first: one snap, no duplicates', async () => {
    const { fm, feed, sent, timers, emit } = setup();
    feed.reattach();
    emit('a');
    feed.reattach();
    emit('b');
    expect(timers[0].cancelled).toBe(true);
    fm.resolvers.forEach((r) => r());
    await flush();
    const snaps = sent.filter(([c]) => c === CH.snap);
    expect(snaps).toHaveLength(1);
    expect(snaps[0][1]).toMatchObject({ d: 'a' });
    expect(sent.filter(([c]) => c === CH.data).map(([, d]) => d)).toEqual(['b']);
  });

  it('dispose releases the gate and flushes held data', () => {
    const { feed, sent, emit } = setup();
    feed.reattach();
    emit('a');
    feed.dispose();
    expect(sent).toEqual([[CH.data, 'a']]);
  });

  it('real mirror: snapshot content is the output up to the attach instant, later chunks arrive once after it', async () => {
    const { feed, sent, emit } = setup({ real: true });
    emit('one\r\n');
    sent.length = 0;
    feed.reattach();
    emit('two\r\n');
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2));
    const [snapCh, snap] = sent[0] as [string, { d: string }];
    expect(snapCh).toBe(CH.snap);
    expect(snap.d).toContain('one');
    expect(snap.d).not.toContain('two');
    expect(sent.slice(1)).toEqual([[CH.data, 'two\r\n']]);
  });
});
