// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isNightCurrent, newNightId, windowFor } from './nightWindow.mjs';
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const W = { start: '01:00', end: '07:00' };
describe('newNightId', () => {
  it('formats local time', () => {
    expect(newNightId(new Date(2026, 10, 4, 23, 15, 9).getTime())).toBe('n20261104T231509');
  });
});
describe('windowFor', () => {
  it('before bed: the next 01:00', () => {
    expect(windowFor(at(4, 23), W)).toEqual({ startMs: at(5, 1), endMs: at(5, 7) });
  });
  it('inside the window: the current one', () => {
    expect(windowFor(at(5, 2), W)).toEqual({ startMs: at(5, 1), endMs: at(5, 7) });
  });
  it('exactly at the start is inside that window; exactly at the end counts as over', () => {
    expect(windowFor(at(5, 1), W)).toEqual({ startMs: at(5, 1), endMs: at(5, 7) });
    expect(windowFor(at(5, 7), W).startMs).toBe(at(6, 1));
  });
  it('a window that crosses midnight', () => {
    expect(windowFor(at(4, 23), { start: '22:00', end: '06:00' })).toEqual({ startMs: at(4, 22), endMs: at(5, 6) });
    expect(windowFor(at(4, 12), { start: '22:00', end: '06:00' }).startMs).toBe(at(4, 22));
    expect(windowFor(at(5, 3), { start: '22:00', end: '06:00' })).toEqual({ startMs: at(4, 22), endMs: at(5, 6) });   // 03:00 is inside the window that began the evening before
  });
});
describe('isNightCurrent', () => {
  it('valid until 12h after the targeted window start', () => {
    expect(isNightCurrent(at(5, 13), at(5, 1))).toBe(true);
    expect(isNightCurrent(at(5, 13, 1), at(5, 1))).toBe(false);
  });
});
