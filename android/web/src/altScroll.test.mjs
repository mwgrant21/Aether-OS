// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  chainDrag, toNotches, wheelBytes, shouldIntercept, flushAlt, finishAlt,
  MAX_NOTCHES_PER_TICK, PAGE_EVERY_NOTCHES, ARROWS_PER_NOTCH,
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
  it('mode none pages at the threshold and below it sends cursor keys', () => {
    expect(wheelBytes({ notches: -(PAGE_EVERY_NOTCHES - 1), trackingMode: 'none', col: 1, row: 1 }))
      .toBe('[A'.repeat((PAGE_EVERY_NOTCHES - 1) * ARROWS_PER_NOTCH));
    expect(wheelBytes({ notches: -PAGE_EVERY_NOTCHES, trackingMode: 'none', col: 1, row: 1 })).toBe('[5~');
    expect(wheelBytes({ notches: PAGE_EVERY_NOTCHES, trackingMode: 'none', col: 1, row: 1 })).toBe('[6~');
  });
  it('mode none: a 200 px drag at 17 px cells (5 notches) yields up/down arrows', () => {
    const up = toNotches({ leftover: 200, carry: 0, cellH: 17 }); // finger down = older content
    expect(up.notches).toBe(-5);
    expect(wheelBytes({ notches: up.notches, trackingMode: 'none', col: 1, row: 1 })).toBe('[A'.repeat(5 * ARROWS_PER_NOTCH));
    const down = toNotches({ leftover: -200, carry: 0, cellH: 17 });
    expect(wheelBytes({ notches: down.notches, trackingMode: 'none', col: 1, row: 1 })).toBe('[B'.repeat(5 * ARROWS_PER_NOTCH));
  });
  it('mode none with appCursor sends SS3 up/down; paging ignores the flag', () => {
    expect(wheelBytes({ notches: -2, trackingMode: 'none', appCursor: true, col: 1, row: 1 })).toBe('OA'.repeat(2 * ARROWS_PER_NOTCH));
    expect(wheelBytes({ notches: 2, trackingMode: 'none', appCursor: true, col: 1, row: 1 })).toBe('OB'.repeat(2 * ARROWS_PER_NOTCH));
    expect(wheelBytes({ notches: -PAGE_EVERY_NOTCHES, trackingMode: 'none', appCursor: true, col: 1, row: 1 })).toBe('[5~');
  });
  it('tracking modes are byte-for-byte unchanged for every notch count', () => {
    for (const mode of ['x10', 'vt200', 'drag', 'any']) {
      for (let n = 1; n <= MAX_NOTCHES_PER_TICK; n++) {
        expect(wheelBytes({ notches: -n, trackingMode: mode, col: 41, row: 13 })).toBe('[<64;41;13M'.repeat(n));
        expect(wheelBytes({ notches: n, trackingMode: mode, col: 41, row: 13 })).toBe('[<65;41;13M'.repeat(n));
        expect(wheelBytes({ notches: -n, trackingMode: mode, col: 41, row: 13, appCursor: true })).toBe('[<64;41;13M'.repeat(n));
        expect(wheelBytes({ notches: n, trackingMode: mode, col: 41, row: 13, appCursor: true })).toBe('[<65;41;13M'.repeat(n));
      }
    }
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

describe('flushAlt / finishAlt', () => {
  const mkAlt = (pending, mode = 'any', hidden = false) => ({
    slot: { id: 'claude', el: { hidden }, term: { cols: 80, rows: 24, modes: { mouseTrackingMode: mode } } },
    pending, timer: 0,
  });
  const rig = () => {
    const sent = [];
    const cleared = [];
    return { sent, cleared, send: (m) => sent.push(m), clear: (t) => cleared.push(t) };
  };

  it('a normal end flushes pending notches the 50 ms timer has not sent yet', () => {
    const r = rig();
    const alt = mkAlt(3);
    alt.timer = 42;
    finishAlt(alt, { commit: true, stdinOn: true, send: r.send, clear: r.clear });
    expect(r.sent).toEqual([{ t: 'input', s: 'claude', d: wheelBytes({ notches: 3, trackingMode: 'any', col: 41, row: 13 }) }]);
    expect(r.cleared).toEqual([42]);
    expect(alt.timer).toBe(0);
    expect(alt.pending).toBe(0);
  });
  it('a cancel or abort discards pending notches and disarms the timer', () => {
    const r = rig();
    const alt = mkAlt(3);
    alt.timer = 42;
    finishAlt(alt, { commit: false, stdinOn: true, send: r.send, clear: r.clear });
    expect(r.sent).toEqual([]);
    expect(r.cleared).toEqual([42]);
    expect(alt.timer).toBe(0);
  });
  it('the end flush never double-sends: the timer is cleared and a later flush has nothing left', () => {
    const r = rig();
    const alt = mkAlt(-2);
    alt.timer = 7;
    finishAlt(alt, { commit: true, stdinOn: true, send: r.send, clear: r.clear });
    flushAlt(alt, { stdinOn: true, send: r.send, clear: r.clear });
    expect(r.sent).toHaveLength(1);
    expect(r.cleared).toEqual([7]);
  });
  it('a normal end does not send when stdin is off or the slot is hidden', () => {
    const r = rig();
    finishAlt(mkAlt(3), { commit: true, stdinOn: false, send: r.send, clear: r.clear });
    finishAlt(mkAlt(3, 'any', true), { commit: true, stdinOn: true, send: r.send, clear: r.clear });
    expect(r.sent).toEqual([]);
  });
  it('a sub-page swipe in mode none flushes as cursor keys', () => {
    const r = rig();
    const alt = mkAlt(PAGE_EVERY_NOTCHES - 1, 'none');
    finishAlt(alt, { commit: true, stdinOn: true, send: r.send, clear: r.clear });
    expect(r.sent).toEqual([{ t: 'input', s: 'claude', d: '[B'.repeat((PAGE_EVERY_NOTCHES - 1) * ARROWS_PER_NOTCH) }]);
    expect(alt.pending).toBe(0);
  });
  it('keep receives only the px carry; unsent notches are never carried', () => {
    const r = rig();
    const keep = { carry: 0 };
    const a = mkAlt(2, 'none');
    a.carry = 20;
    finishAlt(a, { commit: true, stdinOn: false, send: r.send, clear: r.clear, keep }); // stdin off: not sent
    expect(r.sent).toEqual([]);
    expect(keep).toEqual({ carry: 20 }); // pending 2 is dropped, not carried
    // next gesture starts from keep; 20 px carry + 14 px drag crosses one 34 px notch
    const nn = toNotches({ leftover: 14, carry: keep.carry, cellH: 17 });
    expect(nn.notches).toBe(-1);
    // abort keeps the px carry but drops pending
    const b = mkAlt(3, 'none');
    b.carry = 5;
    finishAlt(b, { commit: false, stdinOn: true, send: r.send, clear: r.clear, keep });
    expect(keep).toEqual({ carry: 5 });
  });
  it('flushAlt sends nothing for a gesture that never took over (on === false)', () => {
    const r = rig();
    const alt = mkAlt(3, 'none');
    alt.on = false;
    flushAlt(alt, { stdinOn: true, send: r.send, clear: r.clear });
    expect(r.sent).toEqual([]);
  });
  it('flushAlt uses SS3 arrows when the term is in application cursor mode, and not otherwise', () => {
    const r = rig();
    const a = mkAlt(-1, 'none');
    a.slot.term.modes.applicationCursorKeysMode = true;
    flushAlt(a, { stdinOn: true, send: r.send, clear: r.clear });
    expect(r.sent[0].d).toBe('OA'.repeat(ARROWS_PER_NOTCH));
    const b = mkAlt(1, 'none');
    flushAlt(b, { stdinOn: true, send: r.send, clear: r.clear });
    expect(r.sent[1].d).toBe('[B'.repeat(ARROWS_PER_NOTCH));
  });
  it('clamps the flushed batch to the per-tick maximum', () => {
    const r = rig();
    finishAlt(mkAlt(MAX_NOTCHES_PER_TICK + 5), { commit: true, stdinOn: true, send: r.send, clear: r.clear });
    expect(r.sent[0].d).toBe(wheelBytes({ notches: MAX_NOTCHES_PER_TICK, trackingMode: 'any', col: 41, row: 13 }));
  });
  it('a null gesture is a no-op', () => {
    const r = rig();
    expect(() => finishAlt(null, { commit: true, stdinOn: true, send: r.send })).not.toThrow();
    expect(r.sent).toEqual([]);
  });
});
