// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createMinInterval } from './minInterval';

function setup(minMs = 2000) {
  let t = 10_000;
  const fn = vi.fn();
  const m = createMinInterval(fn, minMs, () => t);
  return { m, fn, advance: (ms: number) => { t += ms; } };
}

describe('createMinInterval', () => {
  it('runs the first call', () => {
    const { m, fn } = setup();
    m.run();
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('skips a call inside the interval', () => {
    const { m, fn, advance } = setup();
    m.run();
    advance(1999);
    m.run();
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('runs again once the interval has passed', () => {
    const { m, fn, advance } = setup();
    m.run();
    advance(2000);
    m.run();
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('reset makes the next call run at once', () => {
    const { m, fn } = setup();
    m.run();
    m.reset();
    m.run();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
