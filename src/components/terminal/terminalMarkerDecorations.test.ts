import { describe, it, expect, vi, afterEach } from 'vitest';
import { attachTerminalMarkers, type MarkerTerm } from './terminalMarkerDecorations';

interface FakeMarker { line: number; isDisposed: boolean; dispose(): void }
interface FakeDeco { opts: Record<string, unknown>; disposed: boolean; dispose(): void }

function makeTerm(initial: string[], cols = 20) {
  const rows = initial.map((t) => t.padEnd(cols));
  const handlers: Record<string, () => void> = {};
  const unsub: string[] = [];
  const decos: FakeDeco[] = [];
  const markers: FakeMarker[] = [];
  const state = { refuse: false };
  const on = (name: string) => (cb: () => void) => {
    handlers[name] = cb;
    return { dispose: () => { unsub.push(name); } };
  };
  const term: MarkerTerm = {
    cols, rows: 24,
    buffer: { onBufferChange: on('buffer'), active: {
      type: 'normal', baseY: 0, cursorY: 0,
      get length() { return rows.length; },
      getLine: (y) => (y < rows.length ? {
        isWrapped: false,
        getCell: (x) => ({ getChars: () => rows[y][x] ?? '', getWidth: () => 1 }),
      } : undefined),
    } },
    registerMarker(off = 0) {
      const m: FakeMarker = { line: off, isDisposed: false, dispose() { m.isDisposed = true; } };
      markers.push(m);
      return m;
    },
    registerDecoration(opts) {
      if (state.refuse) return undefined;
      const d: FakeDeco = { opts: opts as unknown as Record<string, unknown>, disposed: false, dispose() { d.disposed = true; } };
      decos.push(d);
      return d;
    },
    onWriteParsed: on('write'), onResize: on('resize'), onScroll: on('scroll'),
  };
  const setRow = (y: number, t: string) => { rows[y] = t.padEnd(cols); };
  return { term, handlers, unsub, decos, markers, state, setRow };
}

const live = (decos: FakeDeco[]) => decos.filter((d) => !d.disposed);

afterEach(() => { vi.unstubAllGlobals(); });

describe('attachTerminalMarkers', () => {
  it('starts disabled, then registers chip and rest decorations with the right colors', () => {
    const t = makeTerm(['[STOP] go', 'plain']);
    const m = attachTerminalMarkers(t.term);
    m.flush();
    expect(t.decos).toHaveLength(0);
    m.setEnabled(true);
    m.flush();
    expect(t.decos.map((d) => d.opts)).toMatchObject([
      { x: 0, width: 6, backgroundColor: '#ff5c57', foregroundColor: '#06141c', layer: 'bottom' },
      { x: 6, width: 14, foregroundColor: '#ff5c57' },
    ]);
    expect(t.decos[1].opts.backgroundColor).toBeUndefined();
  });

  it('disposes everything when disabled', () => {
    const t = makeTerm(['[WARN] a']);
    const m = attachTerminalMarkers(t.term);
    m.setEnabled(true);
    m.flush();
    expect(live(t.decos)).toHaveLength(2);
    m.setEnabled(false);
    expect(live(t.decos)).toHaveLength(0);
  });

  it('disposes the stale decoration when a row is rewritten to plain text', () => {
    const t = makeTerm(['[STOP] a', 'x']);
    const m = attachTerminalMarkers(t.term);
    m.setEnabled(true);
    m.flush();
    t.setRow(0, 'plain');
    m.flush();
    expect(live(t.decos)).toHaveLength(0);
  });

  it('does not re-register an unchanged row across flushes', () => {
    const t = makeTerm(['[ASK] a']);
    const m = attachTerminalMarkers(t.term);
    m.setEnabled(true);
    m.flush();
    m.flush();
    expect(t.decos).toHaveLength(2);
  });

  it('clears all decorations on buffer change', () => {
    const t = makeTerm(['[MANUAL] a']);
    const m = attachTerminalMarkers(t.term);
    m.setEnabled(true);
    m.flush();
    t.handlers.buffer();
    expect(live(t.decos)).toHaveLength(0);
  });

  it('tolerates registerDecoration returning undefined without retrying', () => {
    const t = makeTerm(['[STOP] a']);
    t.state.refuse = true;
    const m = attachTerminalMarkers(t.term);
    m.setEnabled(true);
    const spy = vi.spyOn(t.term, 'registerDecoration');
    expect(() => { m.flush(); m.flush(); }).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('coalesces triggers into one animation frame', () => {
    const raf = vi.fn(() => 1);
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const t = makeTerm(['x']);
    const m = attachTerminalMarkers(t.term);
    m.setEnabled(true);
    t.handlers.write(); t.handlers.resize(); t.handlers.scroll();
    expect(raf).toHaveBeenCalledTimes(1);
  });

  it('dispose removes decorations and unsubscribes every listener', () => {
    const t = makeTerm(['[STOP] a']);
    const m = attachTerminalMarkers(t.term);
    m.setEnabled(true);
    m.flush();
    m.dispose();
    expect(live(t.decos)).toHaveLength(0);
    expect(t.unsub.sort()).toEqual(['buffer', 'resize', 'scroll', 'write']);
  });
});
