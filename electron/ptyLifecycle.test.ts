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
