// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { isPrimaryMouse, wheelPx, dragPan, MOUSE_SLOP_PX } from './mouseScroll.js';
import { toNotches } from './altScroll.js';

describe('isPrimaryMouse', () => {
  it('accepts a mouse with button 0 or buttons bit 1', () => {
    expect(isPrimaryMouse({ pointerType: 'mouse', button: 0, buttons: 1 })).toBe(true);
    expect(isPrimaryMouse({ pointerType: 'mouse', button: -1, buttons: 1 })).toBe(true);
    expect(isPrimaryMouse({ pointerType: 'mouse', button: 0 })).toBe(true);
  });
  it('rejects touch, pen, other buttons and missing fields', () => {
    expect(isPrimaryMouse({ pointerType: 'touch', button: 0, buttons: 1 })).toBe(false);
    expect(isPrimaryMouse({ pointerType: 'pen', button: 0, buttons: 1 })).toBe(false);
    expect(isPrimaryMouse({ pointerType: 'mouse', button: 2, buttons: 2 })).toBe(false);
    expect(isPrimaryMouse({})).toBe(false);
    expect(isPrimaryMouse(null)).toBe(false);
  });
  it('slop is positive', () => expect(MOUSE_SLOP_PX).toBeGreaterThan(0));
});

describe('wheelPx', () => {
  const base = { deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, cellW: 8, cellH: 17, viewH: 400 };
  it('pixel mode passes through', () => {
    expect(wheelPx({ ...base, deltaX: 3, deltaY: 40 })).toEqual({ dx: 3, dy: 40 });
  });
  it('line mode scales by cell size', () => {
    expect(wheelPx({ ...base, deltaMode: 1, deltaX: 2, deltaY: 3 })).toEqual({ dx: 16, dy: 51 });
  });
  it('page mode scales by view height', () => {
    expect(wheelPx({ ...base, deltaMode: 2, deltaY: 1 })).toEqual({ dx: 0, dy: 400 });
  });
  it('shift turns a vertical wheel horizontal, but not when deltaX is real', () => {
    expect(wheelPx({ ...base, shiftKey: true, deltaY: 40 })).toEqual({ dx: 40, dy: 0 });
    expect(wheelPx({ ...base, shiftKey: true, deltaX: 5, deltaY: 40 })).toEqual({ dx: 5, dy: 40 });
  });
  it('non-finite is zero', () => {
    expect(wheelPx({ ...base, deltaX: NaN, deltaY: Infinity })).toEqual({ dx: 0, dy: 0 });
  });
  it('sign: wheel down (deltaY > 0) is positive notches (SGR 65)', () => {
    const { dy } = wheelPx({ ...base, deltaY: 40 });
    expect(toNotches({ leftover: -dy, carry: 0, cellH: 17 }).notches).toBeGreaterThan(0);
  });
});

describe('dragPan', () => {
  const s = { scrollTop: 50, maxScrollTop: 100, scrollLeft: 20, maxScrollLeft: 60 };
  it('content follows the pointer on both axes', () => {
    expect(dragPan({ ...s, dx: 10, dy: 10 })).toEqual({ scrollTop: 40, scrollLeft: 10 });
    expect(dragPan({ ...s, dx: -10, dy: -10 })).toEqual({ scrollTop: 60, scrollLeft: 30 });
  });
  it('clamps to the range', () => {
    expect(dragPan({ ...s, dx: 999, dy: 999 })).toEqual({ scrollTop: 0, scrollLeft: 0 });
    expect(dragPan({ ...s, dx: -999, dy: -999 })).toEqual({ scrollTop: 100, scrollLeft: 60 });
  });
  it('non-finite input leaves the axis unchanged', () => {
    expect(dragPan({ ...s, dx: NaN, dy: Infinity })).toEqual({ scrollTop: 50, scrollLeft: 20 });
  });
});
