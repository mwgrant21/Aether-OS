// Mouse scroll for the xterm page (pure logic, no DOM). Phone Link / desktop-style mice arrive
// as Pointer Events (pointerType 'mouse') and wheel events, not touch. Alt-screen vertical
// scrolling reuses chainDrag/toNotches/wheelBytes from altScroll.js; this module only adds the
// mouse-specific conversions.

export const MOUSE_SLOP_PX = 4;

const fin = Number.isFinite;
const num = (v) => (fin(v) ? v : 0);

export function isPrimaryMouse(ev) {
  if (!ev || ev.pointerType !== 'mouse') return false;
  return ev.button === 0 || (ev.buttons & 1) === 1;
}

// Wheel delta -> CSS px, DOM sign (positive = scroll down/right).
export function wheelPx({ deltaX, deltaY, deltaMode, shiftKey, cellW, cellH, viewH }) {
  let dx = num(deltaX);
  let dy = num(deltaY);
  if (shiftKey && dx === 0) {
    dx = dy;
    dy = 0;
  }
  if (deltaMode === 1) {
    dx *= num(cellW);
    dy *= num(cellH);
  } else if (deltaMode === 2) {
    const h = num(viewH);
    dx *= h;
    dy *= h;
  }
  return { dx, dy };
}

// Content follows the pointer: moving the pointer down (dy > 0) scrolls toward the top.
export function dragPan({ dx, dy, scrollTop, maxScrollTop, scrollLeft, maxScrollLeft }) {
  const axis = (cur, d, max) => {
    if (!fin(cur)) return 0;
    if (!fin(d) || !fin(max)) return cur;
    const m = Math.max(0, max);
    return Math.min(Math.max(cur - d, 0), m);
  };
  return {
    scrollTop: axis(scrollTop, dy, maxScrollTop),
    scrollLeft: axis(scrollLeft, dx, maxScrollLeft),
  };
}
