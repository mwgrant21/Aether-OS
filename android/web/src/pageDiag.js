// Input diagnostic, page side. Pure: builds bridge messages from numbers and enums ONLY.
// It never reads ev.key, ev.data, ev.target, text or value, so nothing typed can leave through it.

const KINDS = new Set(['p', 't', 'w']);
const ACTIONS = new Set(['down', 'move', 'up', 'cancel', 'wheel']);
const POINTERS = new Set(['mouse', 'touch', 'pen']);

const num = (v, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};

/** kind 'p' | 't' | 'w'; action 'down'|'move'|'up'|'cancel'|'wheel'; ev any event-like object. */
export function diagMessage(kind, action, ev) {
  const e = ev || {};
  const pt = typeof e.pointerType === 'string' && POINTERS.has(e.pointerType) ? e.pointerType : '';
  let x = e.clientX;
  let y = e.clientY;
  if (kind === 't') {
    const t = e.touches && e.touches[0] ? e.touches[0] : e.changedTouches && e.changedTouches[0];
    x = t ? t.clientX : 0;
    y = t ? t.clientY : 0;
  }
  return {
    t: 'diag',
    k: KINDS.has(kind) ? kind : 'p',
    a: ACTIONS.has(action) ? action : 'move',
    pt,
    b: num(e.button, -1, 31),
    bs: num(e.buttons, 0, 63),
    dx: num(e.deltaX, -100000, 100000),
    dy: num(e.deltaY, -100000, 100000),
    dm: num(e.deltaMode, 0, 2),
    x: num(x, -10000, 20000),
    y: num(y, -10000, 20000),
    n: num(e.touches ? e.touches.length : 0, 0, 20),
  };
}

/** Returns true when the action may be sent now. Moves are limited to one per `min` ms; others always pass. */
export function throttle(lastAt, now, action, min = 40) {
  if (action !== 'move') return true;
  return now - lastAt >= min;
}
