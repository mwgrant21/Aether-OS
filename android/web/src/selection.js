// Pure helpers for long-press text selection in the Raw page (no DOM, no clock: timers are
// injectable). main.js owns the wiring; the clipboard write happens only in Kotlin.
export const LONG_PRESS_MS = 500;
export const TOUCH_SLOP_PX = 10;
export const MAX_COPY_BYTES = 60000;

// Cell under (x,y) of a grid drawn in the rect left/top/width/height. Clamped inside the grid;
// null when any input is not a usable number.
export function cellAt({ x, y, left, top, width, height, cols, rows }) {
  for (const v of [x, y, left, top, width, height, cols, rows]) if (!Number.isFinite(v)) return null;
  if (width <= 0 || height <= 0 || cols < 1 || rows < 1) return null;
  const col = Math.floor(((x - left) / width) * cols);
  const row = Math.floor(((y - top) / height) * rows);
  return {
    col: Math.min(cols - 1, Math.max(0, col)),
    row: Math.min(rows - 1, Math.max(0, row)),
  };
}

// Order two {row,col} points so the first is not after the second.
export function orderRange(a, b) {
  return a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
}

// Word around index i as {start,end} (end exclusive): a run of non-space characters, or, when i is
// on a space, the run of spaces. i is clamped into the text; empty text gives {0,0}.
export function wordBounds(text, i) {
  if (!text) return { start: 0, end: 0 };
  const at = Math.min(text.length - 1, Math.max(0, i));
  const blank = (c) => /\s/.test(c);
  const kind = blank(text[at]);
  let start = at;
  let end = at + 1;
  while (start > 0 && blank(text[start - 1]) === kind) start--;
  while (end < text.length && blank(text[end]) === kind) end++;
  return { start, end };
}

// Longest prefix of text that fits maxBytes of UTF-8, cut on a code-point boundary.
export function clampText(text, maxBytes) {
  let bytes = 0;
  let out = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > maxBytes) break;
    bytes += n;
    out += ch.length;
  }
  return text.slice(0, out);
}

// Text between two {line,off} boundaries (off is a caret offset, so the end is exclusive), in either
// order; lines joined with \n. Offsets past a line's end clamp to it.
export function sliceLines(lines, a, b) {
  const [s, e] = a.line < b.line || (a.line === b.line && a.off <= b.off) ? [a, b] : [b, a];
  if (!lines.length) return '';
  const last = lines.length - 1;
  const sl = Math.min(last, Math.max(0, s.line));
  const el = Math.min(last, Math.max(0, e.line));
  if (sl === el) return lines[sl].slice(s.off, e.off);
  const parts = [lines[sl].slice(s.off)];
  for (let i = sl + 1; i < el; i++) parts.push(lines[i]);
  parts.push(lines[el].slice(0, e.off));
  return parts.join('\n');
}

// One-shot long-press timer. start() arms it (re-arming replaces); move() cancels it when the finger
// or pointer left the slop box and returns true only for that cancel; end() cancels it. onFire runs
// at most once per start().
export function createLongPress({
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  slopPx = TOUCH_SLOP_PX,
  delayMs = LONG_PRESS_MS,
  onFire,
}) {
  let timer = null;
  let sx = 0;
  let sy = 0;
  const clear = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  return {
    start(x, y) {
      clear();
      sx = x;
      sy = y;
      timer = setTimer(() => {
        timer = null;
        onFire(sx, sy);
      }, delayMs);
    },
    move(x, y) {
      if (timer === null) return false;
      if (Math.max(Math.abs(x - sx), Math.abs(y - sy)) < slopPx) return false;
      clear();
      return true;
    },
    end() {
      clear();
    },
  };
}
