// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { PtyLike } from './ptyLifecycle';
import { createTerminalHub, splitUtf8, type SlotEvent } from './terminalHub';
import { TERMINAL_CHUNK_MAX_BYTES } from '../src/shared/remote/types';

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
    const data = 'a'.repeat(TERMINAL_CHUNK_MAX_BYTES - 2) + emoji + 'b';
    const pieces = splitUtf8(data, TERMINAL_CHUNK_MAX_BYTES);
    expect(pieces).toEqual(['a'.repeat(TERMINAL_CHUNK_MAX_BYTES - 2), emoji + 'b']);
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
