// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  chainDrag, toNotches, wheelBytes, shouldIntercept,
  MAX_NOTCHES_PER_TICK, PAGE_EVERY_NOTCHES,
} from './altScroll.js';
import { shouldSend } from './inputFilter.js';

describe('chainDrag', () => {
  it('pans inside the range and leaves no leftover', () => {
    expect(chainDrag({ dy: 10, scrollTop: 50, maxScrollTop: 100 })).toEqual({ scrollTop: 40, leftover: 0 });
    expect(chainDrag({ dy: -10, scrollTop: 50, maxScrollTop: 100 })).toEqual({ scrollTop: 60, leftover: 0 });
  });
  it('finger down at the top edge leaves a positive leftover', () => {
    expect(chainDrag({ dy: 30, scrollTop: 0, maxScrollTop: 100 })).toEqual({ scrollTop: 0, leftover: 30 });
    expect(chainDrag({ dy: 30, scrollTop: 10, maxScrollTop: 100 })).toEqual({ scrollTop: 0, leftover: 20 });
  });
  it('finger up at the bottom edge leaves a negative leftover', () => {
    expect(chainDrag({ dy: -30, scrollTop: 100, maxScrollTop: 100 })).toEqual({ scrollTop: 100, leftover: -30 });
    expect(chainDrag({ dy: -30, scrollTop: 90, maxScrollTop: 100 })).toEqual({ scrollTop: 100, leftover: -20 });
  });
  it('a slot with no pan range passes everything through', () => {
    expect(chainDrag({ dy: 12, scrollTop: 0, maxScrollTop: 0 })).toEqual({ scrollTop: 0, leftover: 12 });
  });
  it('non-finite input is a no-op', () => {
    expect(chainDrag({ dy: NaN, scrollTop: 5, maxScrollTop: 100 })).toEqual({ scrollTop: 5, leftover: 0 });
    expect(chainDrag({ dy: Infinity, scrollTop: 5, maxScrollTop: 100 })).toEqual({ scrollTop: 5, leftover: 0 });
  });
});

describe('toNotches', () => {
  it('sign: finger down (positive leftover) is negative notches = wheel up', () => {
    expect(toNotches({ leftover: 34, carry: 0, cellH: 17 }).notches).toBe(-1);
    expect(toNotches({ leftover: -34, carry: 0, cellH: 17 }).notches).toBe(1);
  });
  it('carry accumulates sub-notch drags into one notch', () => {
    let carry = 0;
    let total = 0;
    for (let i = 0; i < 3; i++) {
      const r = toNotches({ leftover: 12, carry, cellH: 17 }); // 36 px total, step 34
      carry = r.carry;
      total += r.notches;
    }
    expect(total).toBe(-1);
    expect(carry).toBe(2);
  });
  it('caps at MAX_NOTCHES_PER_TICK both ways', () => {
    expect(toNotches({ leftover: 10000, carry: 0, cellH: 17 }).notches).toBe(-MAX_NOTCHES_PER_TICK);
    expect(toNotches({ leftover: -10000, carry: 0, cellH: 17 }).notches).toBe(MAX_NOTCHES_PER_TICK);
  });
  it('bad cellH or non-finite leftover yields 0 and keeps carry', () => {
    expect(toNotches({ leftover: 100, carry: 5, cellH: 0 })).toEqual({ notches: 0, carry: 5 });
    expect(toNotches({ leftover: 100, carry: 5, cellH: NaN })).toEqual({ notches: 0, carry: 5 });
    expect(toNotches({ leftover: NaN, carry: 5, cellH: 17 })).toEqual({ notches: 0, carry: 5 });
  });
});

describe('wheelBytes', () => {
  it('negative notches send SGR button 64 (up), positive 65 (down), exact bytes', () => {
    expect(wheelBytes({ notches: -2, trackingMode: 'any', col: 41, row: 13 }))
      .toBe('\x1b[<64;41;13M\x1b[<64;41;13M');
    expect(wheelBytes({ notches: 1, trackingMode: 'vt200', col: 41, row: 13 })).toBe('\x1b[<65;41;13M');
  });
  it('clamps col/row to integers >= 1', () => {
    expect(wheelBytes({ notches: 1, trackingMode: 'x10', col: 0, row: -3.5 })).toBe('\x1b[<65;1;1M');
    expect(wheelBytes({ notches: 1, trackingMode: 'x10', col: 7.9, row: 2.2 })).toBe('\x1b[<65;7;2M');
  });
  it('mode none sends PgUp/PgDn only at the threshold', () => {
    expect(wheelBytes({ notches: -(PAGE_EVERY_NOTCHES - 1), trackingMode: 'none', col: 1, row: 1 })).toBeNull();
    expect(wheelBytes({ notches: -PAGE_EVERY_NOTCHES, trackingMode: 'none', col: 1, row: 1 })).toBe('\x1b[5~');
    expect(wheelBytes({ notches: PAGE_EVERY_NOTCHES, trackingMode: 'none', col: 1, row: 1 })).toBe('\x1b[6~');
  });
  it('zero or non-finite notches give null', () => {
    expect(wheelBytes({ notches: 0, trackingMode: 'any', col: 1, row: 1 })).toBeNull();
    expect(wheelBytes({ notches: NaN, trackingMode: 'any', col: 1, row: 1 })).toBeNull();
  });
  it('inputFilter.shouldSend rejects the SGR output, so it must bypass the filter', () => {
    expect(shouldSend(wheelBytes({ notches: -1, trackingMode: 'any', col: 5, row: 5 }))).toBe(false);
    expect(shouldSend(wheelBytes({ notches: 1, trackingMode: 'any', col: 5, row: 5 }))).toBe(false);
  });
});

describe('shouldIntercept', () => {
  it('only alternate buffer and vertical-dominant', () => {
    expect(shouldIntercept({ bufferType: 'alternate', dx: 2, dy: 9 })).toBe(true);
    expect(shouldIntercept({ bufferType: 'alternate', dx: 9, dy: 2 })).toBe(false);
    expect(shouldIntercept({ bufferType: 'normal', dx: 2, dy: 9 })).toBe(false);
    expect(shouldIntercept({ bufferType: 'alternate', dx: NaN, dy: 9 })).toBe(false);
  });
});
