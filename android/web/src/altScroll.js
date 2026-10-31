// Alt-screen touch scroll (pure logic, no DOM). In the alternate buffer xterm has no
// scrollback, so a vertical drag first pans the slot natively, then the leftover drag is
// turned into mouse-wheel notches sent to the pty so the remote app scrolls its own history.
// Sign convention: dy > 0 = finger moved down (user wants OLDER content). A positive
// leftover therefore yields NEGATIVE notches = wheel up (SGR button 64).

export const NOTCH_CELLS = 2;
export const MAX_NOTCHES_PER_TICK = 8;
export const PAGE_EVERY_NOTCHES = 8;

const ESC = '\x1b';
const fin = Number.isFinite;

// Pan consumes dy inside [0, maxScrollTop]; leftover is the signed rest (same sign as dy).
export function chainDrag({ dy, scrollTop, maxScrollTop }) {
  if (!fin(dy) || !fin(scrollTop) || !fin(maxScrollTop)) return { scrollTop: fin(scrollTop) ? scrollTop : 0, leftover: 0 };
  const max = Math.max(0, maxScrollTop);
  const cur = Math.min(Math.max(scrollTop, 0), max);
  const next = Math.min(Math.max(cur - dy, 0), max);
  return { scrollTop: next, leftover: dy - (cur - next) };
}

// leftover px + sub-notch carry (px) -> signed whole notches (negative = wheel up).
// Excess beyond MAX_NOTCHES_PER_TICK is dropped, not carried.
export function toNotches({ leftover, carry, cellH }) {
  const c = fin(carry) ? carry : 0;
  if (!fin(leftover) || !fin(cellH) || cellH <= 0) return { notches: 0, carry: c };
  const step = cellH * NOTCH_CELLS;
  const total = c + leftover;
  const whole = Math.trunc(total / step);
  const n = Math.max(-MAX_NOTCHES_PER_TICK, Math.min(MAX_NOTCHES_PER_TICK, -whole));
  return { notches: n === 0 ? 0 : n, carry: total - whole * step };
}

const pos = (v) => (fin(v) ? Math.max(1, Math.floor(v)) : 1);

// Bytes for the pty, or null. Not for xterm.onData: inputFilter drops SGR mouse reports.
export function wheelBytes({ notches, trackingMode, col, row }) {
  if (!fin(notches) || notches === 0) return null;
  const count = Math.abs(Math.trunc(notches));
  if (count === 0) return null;
  const up = notches < 0;
  if (trackingMode !== 'none') {
    const seq = `${ESC}[<${up ? 64 : 65};${pos(col)};${pos(row)}M`;
    return seq.repeat(count);
  }
  if (count < PAGE_EVERY_NOTCHES) return null;
  return `${ESC}${up ? '[5~' : '[6~'}`.repeat(Math.floor(count / PAGE_EVERY_NOTCHES));
}

// Decide once at gesture start: alt buffer and vertical-dominant.
export function shouldIntercept({ bufferType, dx, dy }) {
  return bufferType === 'alternate' && fin(dx) && fin(dy) && Math.abs(dy) > Math.abs(dx);
}
