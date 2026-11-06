// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import {
  edgeDelta, createAutoScroll, EDGE_ZONE_PX, EDGE_MAX_PX_PER_TICK, EDGE_TICK_MS,
} from './edgeScroll.js';

describe('edgeDelta', () => {
  const v = { top: 100, bottom: 700 };
  it('exposes the tuning constants', () => {
    expect([EDGE_ZONE_PX, EDGE_MAX_PX_PER_TICK, EDGE_TICK_MS]).toEqual([48, 28, 16]);
  });
  it('is 0 between the zones, including exactly at the zone borders', () => {
    expect(edgeDelta({ ...v, y: 400 })).toBe(0);
    expect(edgeDelta({ ...v, y: 148 })).toBe(0);
    expect(edgeDelta({ ...v, y: 652 })).toBe(0);
  });
  it('scrolls up (negative) near the top and down (positive) near the bottom', () => {
    expect(edgeDelta({ ...v, y: 120 })).toBeLessThan(0);
    expect(edgeDelta({ ...v, y: 680 })).toBeGreaterThan(0);
  });
  it('ramps up monotonically with depth', () => {
    const a = edgeDelta({ ...v, y: 140 });
    const b = edgeDelta({ ...v, y: 120 });
    const c = edgeDelta({ ...v, y: 105 });
    expect(Math.abs(a)).toBeLessThan(Math.abs(b));
    expect(Math.abs(b)).toBeLessThan(Math.abs(c));
    expect(edgeDelta({ ...v, y: 124 })).toBeCloseTo(-14);
  });
  it('saturates at max at the edge and beyond it (finger off the page)', () => {
    expect(edgeDelta({ ...v, y: 100 })).toBe(-EDGE_MAX_PX_PER_TICK);
    expect(edgeDelta({ ...v, y: -300 })).toBe(-EDGE_MAX_PX_PER_TICK);
    expect(edgeDelta({ ...v, y: 9999 })).toBe(EDGE_MAX_PX_PER_TICK);
    expect(edgeDelta({ ...v, y: 120, max: 10 })).toBeGreaterThan(-10.0001);
  });
  it('is 0 for non-finite input and for a viewport smaller than two zones', () => {
    expect(edgeDelta({ ...v, y: NaN })).toBe(0);
    expect(edgeDelta({ y: 5, top: NaN, bottom: 700 })).toBe(0);
    expect(edgeDelta({ y: 105, top: 100, bottom: 190 })).toBe(0);
  });
});

function fakeInterval() {
  let fn = null;
  let sets = 0;
  return {
    setTimer: (f) => { fn = f; sets++; return 7; },
    clearTimer: vi.fn(() => { fn = null; }),
    tick: () => { if (fn) fn(); },
    armed: () => fn !== null,
    sets: () => sets,
  };
}

describe('createAutoScroll', () => {
  const make = (point = { x: 5, y: 105 }) => {
    const t = fakeInterval();
    const scrollBy = vi.fn(() => true);
    const state = { point };
    const as = createAutoScroll({
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      getPoint: () => state.point,
      getBounds: () => ({ top: 100, bottom: 700 }),
      scrollBy,
    });
    return { t, scrollBy, as, state };
  };
  it('start is idempotent: one timer, running() true', () => {
    const { t, as } = make();
    as.start();
    as.start();
    expect(t.sets()).toBe(1);
    expect(as.running()).toBe(true);
  });
  it('a tick in the edge zone calls scrollBy with the delta', () => {
    const { t, as, scrollBy } = make({ x: 5, y: 105 });
    as.start();
    t.tick();
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy.mock.calls[0][0]).toBe(edgeDelta({ y: 105, top: 100, bottom: 700 }));
  });
  it('an idle tick does nothing, and the loop resumes when the finger returns to the edge', () => {
    const { t, as, scrollBy, state } = make({ x: 5, y: 400 });
    as.start();
    t.tick();
    expect(scrollBy).not.toHaveBeenCalled();
    expect(as.running()).toBe(true);
    state.point = { x: 5, y: 690 };
    t.tick();
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy.mock.calls[0][0]).toBeGreaterThan(0);
  });
  it('a null point does nothing', () => {
    const { t, as, scrollBy } = make(null);
    as.start();
    t.tick();
    expect(scrollBy).not.toHaveBeenCalled();
  });
  it('stop clears the timer, is safe twice, and prevents a late tick', () => {
    const { t, as, scrollBy } = make();
    as.start();
    as.stop();
    as.stop();
    expect(t.clearTimer).toHaveBeenCalledTimes(1);
    expect(as.running()).toBe(false);
    t.tick();
    expect(scrollBy).not.toHaveBeenCalled();
  });
  it('a late tick callback after stop does not scroll', () => {
    const { as, scrollBy } = make();
    let captured = null;
    const as2 = createAutoScroll({
      setTimer: (f) => { captured = f; return 1; },
      clearTimer: () => {},
      getPoint: () => ({ x: 0, y: 105 }),
      getBounds: () => ({ top: 100, bottom: 700 }),
      scrollBy,
    });
    as2.start();
    as2.stop();
    captured();
    expect(scrollBy).not.toHaveBeenCalled();
    expect(as.running()).toBe(false);
  });
});
