// Pure scroll math for keeping the terminal cursor inside the page viewport (F2a).
// offsetY = height of the wrapped history above the grid; scrollTop is then the container offset.
// The phone renders the PC's grid, which can be larger than the visible area.
const ok = (n) => Number.isFinite(n) && n > 0;

// Minimal scroll that brings [start, end] inside [scroll, scroll + view]; no move if already inside.
function axis(start, end, scroll, view, total) {
  let s = scroll;
  if (end > s + view) s = end - view;
  if (start < s) s = start;
  return Math.min(Math.max(0, s), Math.max(0, total - view));
}

export function followCursor({
  cursorX, cursorY, cols, rows, screenW, screenH, viewW, viewH, scrollLeft, scrollTop, followX, offsetY = 0,
}) {
  const same = { scrollLeft, scrollTop };
  if (!ok(cols) || !ok(rows) || !ok(screenW) || !ok(screenH) || !ok(viewW) || !ok(viewH)) return same;
  if (!Number.isFinite(cursorX) || !Number.isFinite(cursorY)) return same;
  const cw = screenW / cols;
  const ch = screenH / rows;
  const oy = Number.isFinite(offsetY) && offsetY > 0 ? offsetY : 0;
  const top = oy + cursorY * ch;
  const out = { scrollLeft, scrollTop: axis(top, top + ch, scrollTop, viewH, oy + screenH) };
  if (followX) {
    const left = cursorX * cw;
    out.scrollLeft = axis(left, left + cw, scrollLeft, viewW, screenW);
  }
  return out;
}
