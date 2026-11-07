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

// Word around terminal CELL col, as {start,end} cells (end exclusive). cells[i] is {chars,width} for
// buffer cell i: chars '' on an empty cell (a blank), width 0 on the continuation cell of a wide
// character (no text of its own; a hit on it counts as its base cell), and chars longer than one
// unit for a combining sequence or astral character. wordBounds works in UTF-16 offsets, so the line
// is built as a string with an offset-to-cell map and converted back. Trailing empty cells are not
// text: a col past the last character gives the single cell at col.
export function cellWordBounds(cells, col) {
  let n = cells.length;
  while (n > 0 && cells[n - 1].chars === '' && cells[n - 1].width !== 0) n--;
  if (col >= n) return { start: col, end: col + 1 };
  let text = '';
  const cellOf = [];
  const offOf = [];
  for (let i = 0; i < n; i++) {
    const { chars, width } = cells[i];
    if (width === 0) {
      offOf[i] = Math.max(0, text.length - 1);
      continue;
    }
    const t = chars === '' ? ' ' : chars;
    offOf[i] = text.length;
    for (let k = 0; k < t.length; k++) cellOf.push(i);
    text += t;
  }
  if (!text) return { start: col, end: col + 1 };
  const w = wordBounds(text, offOf[Math.max(0, col)]);
  const last = cellOf[w.end - 1];
  return { start: cellOf[w.start], end: last + Math.max(1, cells[last].width) };
}

// Pin a handle anchor {x,y} into the slot rect {left,right,top,bottom}: x clamps to the left/right
// edges, so a caret past the visible width (a whole-row word on a grid wider than the slot) keeps a
// reachable handle; y outside the rect gives null (the row is scrolled out, so there is no handle).
// `inset` keeps x that many px inside each edge, so a handle dot drawn up to `inset` px to either
// side of the anchor still lands on screen.
export function clampAnchor(a, r, inset = 0) {
  if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) return null;
  if (a.y < r.top || a.y > r.bottom) return null;
  const lo = r.left + inset;
  const hi = r.right - inset;
  return { x: hi < lo ? (r.left + r.right) / 2 : Math.min(hi, Math.max(lo, a.x)), y: a.y };
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

// Combined-selection points. A point is {line, off}: line < histCount is a history logical line
// (off = UTF-16 caret offset), line >= histCount is live row line - histCount (off = cell column
// caret 0..cols). Carets are boundaries, so a span's end is exclusive.
export function cmpPoint(a, b) {
  return a.line - b.line || a.off - b.off;
}

export function orderPoints(a, b) {
  return cmpPoint(a, b) <= 0 ? [a, b] : [b, a];
}

// Caret boundary 0..cols nearest to x on a grid starting at left; null on unusable input.
export function caretInCell({ x, left, width, cols }) {
  for (const v of [x, left, width, cols]) if (!Number.isFinite(v)) return null;
  if (width <= 0 || cols < 1) return null;
  const c = Math.round(((x - left) / width) * cols);
  return Math.min(cols, Math.max(0, c));
}

// Selection grown from a long-pressed word {s,e} toward a dragged point: at or after the word start
// the word start stays and the end follows the point; before it the start follows the point.
export function extendFromWord(word, pt) {
  if (cmpPoint(pt, word.s) >= 0) return { s: word.s, e: cmpPoint(pt, word.e) > 0 ? pt : word.e };
  return { s: pt, e: word.e };
}

// Move the held handle ('start' | 'end') of {s,e} to pt. Crossing the other handle swaps the two and
// flips `which`, so the held finger now owns the other end. s is never after e.
export function dragHandle({ s, e }, which, pt) {
  if (which === 'start') {
    return cmpPoint(pt, e) > 0 ? { s: e, e: pt, which: 'end' } : { s: pt, e, which: 'start' };
  }
  return cmpPoint(pt, s) < 0 ? { s: pt, e: s, which: 'start' } : { s, e: pt, which: 'end' };
}

// Split an ordered span at the history/live boundary. hist keeps {line,off} points; live gets
// {row,col}. A crossing span ends hist at the last history line (off Infinity, for sliceLines to
// clamp) and starts live at the top-left cell.
export function splitSelection(s, e, histCount) {
  const toLive = (p) => ({ row: p.line - histCount, col: p.off });
  if (e.line < histCount) return { hist: { s, e }, live: null };
  if (s.line >= histCount) return { hist: null, live: { s: toLive(s), e: toLive(e) } };
  return {
    hist: { s, e: { line: histCount - 1, off: Infinity } },
    live: { s: { row: 0, col: 0 }, e: toLive(e) },
  };
}

// Arguments for xterm's select(col, row, length) from a live part; null when empty or absent.
export function liveSpan(live, cols) {
  if (!live) return null;
  const len = live.e.row * cols + live.e.col - (live.s.row * cols + live.s.col);
  return len > 0 ? { col: live.s.col, row: live.s.row, len } : null;
}

// History and live text joined with \n, or directly when the logical line wraps across the seam.
// An empty part contributes nothing.
export function joinSelectionText(histText, liveText, wrapped) {
  if (!histText) return liveText;
  if (!liveText) return histText;
  return histText + (wrapped ? '' : '\n') + liveText;
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
