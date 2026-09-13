// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { PtyLifecycle, type PtyLike } from './ptyLifecycle';

/** A pty stand-in whose exit can be fired on demand, so the asynchronous
 *  ordering that causes the real bug (old pty's exit landing after the
 *  replacement is already active) can be reproduced deterministically. */
function fakePty(): PtyLike & { fireExit: () => void; fireData: (d: string) => void; killed: boolean } {
  let exitCb: (() => void) | null = null;
  let dataCb: ((d: string) => void) | null = null;
  const pty = {
    killed: false,
    onData: (cb: (d: string) => void) => { dataCb = cb; },
    onExit: (cb: () => void) => { exitCb = cb; },
    kill: () => { pty.killed = true; },
    write: vi.fn(),
    resize: vi.fn(),
    fireExit: () => exitCb?.(),
    fireData: (d: string) => dataCb?.(d),
  };
  return pty;
}

function handlers() {
  return { onData: vi.fn(), onAlive: vi.fn(), onExit: vi.fn() };
}

describe('PtyLifecycle', () => {
  it('preserves the current terminal if replacement spawning fails', () => {
    const lifecycle = new PtyLifecycle(), first = fakePty();
    lifecycle.start(() => first, handlers());
    expect(() => lifecycle.start(() => { throw new Error('spawn'); }, handlers())).toThrow('spawn');
    expect(lifecycle.current).toBe(first); expect(first.killed).toBe(false);
    first.fireExit(); expect(lifecycle.current).toBeNull();
  });
  it('announces alive once a pty is spawned and wired', () => {
    const lifecycle = new PtyLifecycle();
    const h = handlers();
    const pty = fakePty();

    lifecycle.start(() => pty, h);

    expect(h.onAlive).toHaveBeenCalledTimes(1);
    expect(h.onExit).not.toHaveBeenCalled();
    expect(lifecycle.current).toBe(pty);
  });

  it('reports the exit of the live pty', () => {
    const lifecycle = new PtyLifecycle();
    const h = handlers();
    const pty = fakePty();
    lifecycle.start(() => pty, h);

    pty.fireExit();

    expect(h.onExit).toHaveBeenCalledTimes(1);
  });

  it('does NOT report the exit of a superseded pty', () => {
    // The real ordering: pty:start is called a second time (renderer reload),
    // which kills the first pty; the first pty's onExit then fires
    // asynchronously, after the second pty is already active. Reporting it
    // would flip terminalAlive false for a session that is still running, and
    // no later event would ever correct it.
    const lifecycle = new PtyLifecycle();
    const h = handlers();
    const first = fakePty();
    const second = fakePty();

    lifecycle.start(() => first, h);
    lifecycle.start(() => second, h);
    expect(first.killed).toBe(true);
    expect(lifecycle.current).toBe(second);

    first.fireExit(); // lands late, after the replacement is live

    expect(h.onExit).not.toHaveBeenCalled();
    expect(h.onAlive).toHaveBeenCalledTimes(2); // once per start

    second.fireExit(); // the live one -- this must be honored

    expect(h.onExit).toHaveBeenCalledTimes(1);
  });

  it('routes data only through the handler given for that pty', () => {
    const lifecycle = new PtyLifecycle();
    const h = handlers();
    const pty = fakePty();
    lifecycle.start(() => pty, h);

    pty.fireData('hello');

    expect(h.onData).toHaveBeenCalledWith('hello');
  });

  it('write and resize target the active pty and no-op when there is none', () => {
    const lifecycle = new PtyLifecycle();
    expect(() => lifecycle.write('x')).not.toThrow();
    expect(() => lifecycle.resize(80, 24)).not.toThrow();

    const pty = fakePty();
    lifecycle.start(() => pty, handlers());
    lifecycle.write('x');
    lifecycle.resize(80, 24);

    expect(pty.write).toHaveBeenCalledWith('x');
    expect(pty.resize).toHaveBeenCalledWith(80, 24);
  });
});

// These tests control event order; they do not reproduce native node-pty timing.
describe('PtyLifecycle callback ownership', () => {
  it('drops old data and exits after replacement, and drops current data after exit', () => {
    const lifecycle = new PtyLifecycle(), first = fakePty(), second = fakePty();
    const oldHandlers = handlers(), currentHandlers = handlers();
    lifecycle.start(() => first, oldHandlers);
    first.fireData('old current');
    lifecycle.start(() => second, currentHandlers);
    first.fireData('late old'); first.fireExit();
    second.fireData('new current'); second.fireExit();
    second.fireData('after exit'); second.fireExit();
    expect(oldHandlers.onData.mock.calls).toEqual([['old current']]);
    expect(oldHandlers.onExit).not.toHaveBeenCalled();
    expect(currentHandlers.onData.mock.calls).toEqual([['new current']]);
    expect(currentHandlers.onExit).toHaveBeenCalledTimes(1);
    expect(lifecycle.current).toBeNull();
  });

  it('honors synchronous old exit during kill before announcing the replacement alive', () => {
    const lifecycle = new PtyLifecycle(), first = fakePty(), second = fakePty();
    const events: string[] = [];
    lifecycle.start(() => first, { onData: () => events.push('data'), onAlive: () => events.push('old alive'), onExit: () => events.push('old exit') });
    first.kill = () => { first.fireExit(); first.fireData('after exit'); };
    lifecycle.start(() => second, { ...handlers(), onAlive: () => events.push('new alive') });
    expect(events).toEqual(['old alive', 'old exit', 'new alive']);
    expect(lifecycle.current).toBe(second);
  });

  it('continues delivering from the old owner after failed spawn', () => {
    const lifecycle = new PtyLifecycle(), first = fakePty(), h = handlers(), next = handlers();
    lifecycle.start(() => first, h);
    expect(() => lifecycle.start(() => { throw new Error('spawn failed'); }, next)).toThrow('spawn failed');
    first.fireData('still current');
    expect(h.onData).toHaveBeenCalledWith('still current');
    expect(next.onAlive).not.toHaveBeenCalled();
    expect(lifecycle.current).toBe(first);
  });

  it('kills the unadopted replacement and retains old ownership when old kill throws', () => {
    const lifecycle = new PtyLifecycle(), first = fakePty(), second = fakePty();
    const h = handlers(), next = handlers();
    lifecycle.start(() => first, h);
    first.kill = () => { throw new Error('old kill failed'); };
    expect(() => lifecycle.start(() => second, next)).toThrow('old kill failed');
    expect(second.killed).toBe(true);
    expect(lifecycle.current).toBe(first);
    first.fireData('still current'); first.fireExit();
    expect(h.onData).toHaveBeenCalledWith('still current');
    expect(h.onExit).toHaveBeenCalledTimes(1);
    expect(next.onAlive).not.toHaveBeenCalled();
    expect(lifecycle.current).toBeNull();
  });

  it('does not revive an old owner that exits synchronously before its kill throws', () => {
    const lifecycle = new PtyLifecycle(), first = fakePty(), second = fakePty(), h = handlers();
    lifecycle.start(() => first, h);
    first.kill = () => { first.fireExit(); throw new Error('kill failed after exit'); };
    expect(() => lifecycle.start(() => second, handlers())).toThrow('kill failed after exit');
    expect(second.killed).toBe(true);
    expect(lifecycle.current).toBeNull();
    first.fireData('after exit');
    expect(h.onData).not.toHaveBeenCalled();
    expect(h.onExit).toHaveBeenCalledTimes(1);
  });
});
