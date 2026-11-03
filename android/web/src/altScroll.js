// Alt-screen touch scroll (pure logic, no DOM). In the alternate buffer xterm has no
// scrollback, so a vertical drag first pans the slot natively, then the leftover drag is
// turned into mouse-wheel notches sent to the pty so the remote app scrolls its own history.
// Sign convention: dy > 0 = finger moved down (user wants OLDER content). A positive
// leftover therefore yields NEGATIVE notches = wheel up (SGR button 64).

export const NOTCH_CELLS = 2;
export const MAX_NOTCHES_PER_TICK = 8;
export const PAGE_EVERY_NOTCHES = 8;
// Mode none, below a page: one notch = NOTCH_CELLS cells of finger travel, so send that many
// cursor-key lines per notch and the text follows the finger.
export const ARROWS_PER_NOTCH = NOTCH_CELLS;

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
export function wheelBytes({ notches, trackingMode, col, row, appCursor = false }) {
  if (!fin(notches) || notches === 0) return null;
  const count = Math.abs(Math.trunc(notches));
  if (count === 0) return null;
  const up = notches < 0;
  if (trackingMode !== 'none') {
    const seq = `${ESC}[<${up ? 64 : 65};${pos(col)};${pos(row)}M`;
    return seq.repeat(count);
  }
  // No mouse tracking: a short swipe sends cursor keys (less, man, vim scroll on them), a long
  // one pages. Tracking-mode output above is untouched.
  // Application cursor mode (DECCKM) wants SS3 keys (ESC O A), which ncurses apps expect.
  if (count < PAGE_EVERY_NOTCHES) return `${ESC}${appCursor ? 'O' : '['}${up ? 'A' : 'B'}`.repeat(count * ARROWS_PER_NOTCH);
  return `${ESC}${up ? '[5~' : '[6~'}`.repeat(Math.floor(count / PAGE_EVERY_NOTCHES));
}

// Send the accumulated whole notches of an alt-screen gesture. Disarms the pending timer first,
// so a flush from gesture end can never double-send with a still-armed timer. Sub-threshold
// remainders (null from wheelBytes) stay in alt.pending.
export function flushAlt(alt, { stdinOn, send, clear = clearTimeout }) {
  if (!alt) return;
  if (alt.timer) clear(alt.timer);
  alt.timer = 0;
  const slot = alt.slot;
  if (alt.pending === 0 || !stdinOn || slot.el.hidden || alt.on === false) return;
  const n = Math.max(-MAX_NOTCHES_PER_TICK, Math.min(MAX_NOTCHES_PER_TICK, alt.pending));
  const d = wheelBytes({
    notches: n,
    trackingMode: slot.term.modes.mouseTrackingMode,
    appCursor: slot.term.modes.applicationCursorKeysMode === true,
    col: Math.floor(slot.term.cols / 2) + 1,
    row: Math.floor(slot.term.rows / 2) + 1,
  });
  if (d === null) return;
  alt.pending = 0;
  send({ t: 'input', s: slot.id, d });
}

// End a gesture. commit = a normal finish (touchend, pointerup): flush what is pending first so a
// quick swipe still scrolls. Cancel/abort/reset paths leave commit false and discard pending.
// `keep` (optional) receives the sub-notch px carry so the next gesture continues it. Pending
// notches are never carried: a stale batch could fire into whatever is visible on the next touch.
export function finishAlt(alt, { commit, stdinOn, send, clear = clearTimeout, keep }) {
  if (!alt) return;
  if (commit) flushAlt(alt, { stdinOn, send, clear });
  else if (alt.timer) clear(alt.timer);
  alt.timer = 0;
  if (keep) {
    keep.carry = fin(alt.carry) ? alt.carry : 0;
  }
}

// Decide once at gesture start: alt buffer and vertical-dominant.
export function shouldIntercept({ bufferType, dx, dy }) {
  return bufferType === 'alternate' && fin(dx) && fin(dy) && Math.abs(dy) > Math.abs(dx);
}
