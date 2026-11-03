// Aether Mobile terminal page: display only in V2 (design spec 2.8, 4.4, D7).
// Every byte of I/O goes through the Kotlin-side bridge (addWebMessageListener); the
// page has no network (CSP connect-src 'none'). No clipboard addon (OSC 52 off), no
// link handling, no title handling. One xterm per slot, created on first use.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { installReplySuppression, applySnap, applySize } from './replySuppression.js';
import { shouldSend, applyStdin } from './inputFilter.js';
import { composeInputs } from './compose.js';
import { followCursor } from './cursorFollow.js';
import { settledLines, needsRebuild, renderHistory } from './wrapHistory.js';
import { THEME } from './theme.js';
import { chainDrag, toNotches, flushAlt, finishAlt, shouldIntercept, wheelBytes } from './altScroll.js';
import { diagMessage, throttle } from './pageDiag.js';
import { isPrimaryMouse, wheelPx, dragPan, MOUSE_SLOP_PX } from './mouseScroll.js';
import {
  cellAt, wordBounds, clampText, sliceLines, createLongPress, MAX_COPY_BYTES, TOUCH_SLOP_PX,
} from './selection.js';

const DEFAULT_SLOT = 'claude'; // the V0 demo source sends `out` for this slot with no snap/size
const FONT_FAMILY = 'ui-monospace, "Cascadia Mono", Menlo, monospace';
const MIN_FONT = 6;
const MAX_FONT = 24;
const HIST_DEBOUNCE_MS = 200; // settled region rebuild is coalesced (<= 250 ms)
const bridge = window.aetherBridge;
const send = (m) => bridge.postMessage(JSON.stringify(m));
const utf8Len = (s) => new TextEncoder().encode(s).length;
const root = document.getElementById('term');

const slots = new Map();
let visible = DEFAULT_SLOT;
let zoomPx = 14; // 0 = fit width
let wantX = false; // an input was sent: the next write completion may scroll sideways too
let stdinOn = false; // fail closed: Kotlin turns typing on with {t:'stdin', on:true}
let altTouchAt = -Infinity; // last intercepted alt-screen drag; follow() stays quiet briefly after
const ALT_FOLLOW_QUIET_MS = 600;
// Long-press selection (see the Selection block below). While it exists the settled region is not
// rebuilt (the DOM Range would die) and follow() stays quiet; both catch up when it clears.
let sel = null; // { kind: 'live'|'hist', slot, ... }
let selDragging = false; // a touch long-press fired and the finger is still down

function slotFor(id) {
  let slot = slots.get(id);
  if (slot) return slot;
  const el = document.createElement('div');
  el.className = 'slot';
  el.hidden = id !== visible;
  // .slot scrolls vertically; .hist is the wrapped settled region; .livex pans the PTY grid.
  const hist = document.createElement('div');
  hist.className = 'hist';
  hist.hidden = true;
  const livex = document.createElement('div');
  livex.className = 'livex';
  el.appendChild(hist);
  el.appendChild(livex);
  root.appendChild(el);
  const term = new Terminal({
    scrollback: 2000,
    cursorBlink: false,
    disableStdin: !stdinOn, // fail closed; the `stdin` bridge message flips it
    allowProposedApi: false,
    fontFamily: FONT_FAMILY,
    fontSize: zoomPx || 14,
    theme: { ...THEME },
  });
  installReplySuppression(term);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(livex);
  slot = { id, el, hist, livex, term, fit, sized: false, dirty: false, histKey: null, histTimer: 0 };
  // Input only while stdin is on, and never mouse/focus reports (inputFilter). Resize is
  // reported only while the page is fitting itself (V0 demo); titan owns the size otherwise.
  term.onData((d) => {
    if (shouldSend(d)) {
      clearSel();
      wantX = true;
      send({ t: 'input', s: id, d });
    }
  });
  term.onResize(({ cols, rows }) => {
    if (!slot.sized) send({ t: 'resize', s: id, cols, rows });
  });
  slots.set(id, slot);
  return slot;
}

// Width of one monospace cell per px of font size, measured once.
let cellRatio = 0;
function ratio() {
  if (!cellRatio) {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `100px ${FONT_FAMILY}`;
    cellRatio = ctx.measureText('W').width / 100 || 0.6;
  }
  return cellRatio;
}

function applyZoom(slot) {
  let px = zoomPx;
  if (!px) {
    const cols = slot.sized ? slot.term.cols : 0;
    px = cols ? Math.floor(root.clientWidth / (cols * ratio())) : 14;
    px = Math.min(MAX_FONT, Math.max(MIN_FONT, px));
  }
  if (slot.term.options.fontSize !== px) slot.term.options.fontSize = px;
  slot.hist.style.fontSize = `${px}px`;
}

// Settled region: rebuilt from settledLines when its key moved or anything was written since
// (see needsRebuild), coalesced by a short timer. Hidden while the alternate buffer is active.
function scheduleHist(slot) {
  slot.dirty = true;
  if (slot.histTimer) return;
  slot.histTimer = setTimeout(() => {
    slot.histTimer = 0;
    rebuildHist(slot);
  }, HIST_DEBOUNCE_MS);
}

function rebuildHist(slot) {
  if (sel) return; // slot.dirty stays set; clearSel() schedules the catch-up
  const res = settledLines(slot.term);
  if (needsRebuild(slot.histKey, res.key, slot.dirty)) {
    slot.histKey = res.key;
    slot.dirty = false;
    renderHistory(document, slot.hist, res.lines);
    slot.hist.hidden = res.lines.length === 0;
    follow(slot);
  }
}

// sized is set synchronously so the onResize wired above stays silent; the resize itself
// is applied in order behind pending output (see applySize / applySnap).
function setSize(slot, cols, rows) {
  slot.sized = true;
  applySize(slot.term, cols, rows, () => {
    applyZoom(slot);
    scheduleHist(slot);
    follow(slot);
  });
}

// Scroll the visible slot's container just enough to show the cursor; no-op when it is in view.
function follow(slot, followX = false) {
  if (sel || !slot || slot.el.hidden || Date.now() - altTouchAt < ALT_FOLLOW_QUIET_MS) return;
  const screen = slot.term.element && slot.term.element.querySelector('.xterm-screen');
  if (!screen) return;
  const b = slot.term.buffer.active;
  const r = followCursor({
    cursorX: b.cursorX, cursorY: b.cursorY, cols: slot.term.cols, rows: slot.term.rows,
    screenW: screen.clientWidth, screenH: screen.clientHeight,
    viewW: slot.livex.clientWidth, viewH: slot.el.clientHeight,
    scrollLeft: slot.livex.scrollLeft, scrollTop: slot.el.scrollTop, followX,
    offsetY: slot.hist.hidden ? 0 : slot.hist.offsetHeight,
  });
  if (r.scrollTop !== slot.el.scrollTop) slot.el.scrollTop = r.scrollTop;
  if (r.scrollLeft !== slot.livex.scrollLeft) slot.livex.scrollLeft = r.scrollLeft;
}

function show(id) {
  clearSel();
  visible = id;
  for (const [sid, slot] of slots) slot.el.hidden = sid !== id;
  const slot = slotFor(id);
  slot.el.hidden = false;
  applyZoom(slot);
  if (!slot.sized) slot.fit.fit();
  scheduleHist(slot);
  follow(slot);
}

const isSlot = (v) => typeof v === 'string' && v.length > 0;
const isDim = (v) => Number.isInteger(v) && v > 0;

bridge.onmessage = (ev) => {
  let m;
  try {
    m = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'snap': {
      if (!isSlot(m.s) || !isDim(m.cols) || !isDim(m.rows) || typeof m.d !== 'string') return;
      clearSel();
      const slot = slotFor(m.s);
      slot.sized = true;
      applySnap(slot.term, m.cols, m.rows, m.d, () => {
        applyZoom(slot);
        scheduleHist(slot);
        follow(slot);
      });
      return;
    }
    case 'out': {
      if (!isSlot(m.s) || typeof m.d !== 'string') return;
      const { d, s } = m;
      // Credit back to Kotlin once xterm has consumed the chunk (flow control).
      const slot = slotFor(s);
      slot.term.write(d, () => {
        send({ t: 'consumed', s, bytes: utf8Len(d) });
        scheduleHist(slot);
        if (s === visible) {
          follow(slot, wantX);
          wantX = false;
        }
      });
      return;
    }
    case 'size':
      if (isSlot(m.s) && isDim(m.cols) && isDim(m.rows)) {
        clearSel();
        setSize(slotFor(m.s), m.cols, m.rows);
      }
      return;
    case 'show':
      if (isSlot(m.s)) show(m.s);
      return;
    case 'stdin':
      stdinOn = applyStdin(
        [...slots.values()].map((s) => s.term),
        m.on,
        stdinOn,
      );
      if (!stdinOn) clearSel();
      return;
    case 'diag':
      diagOn = m.on === true;
      return;
    case 'zoom':
      if (m.px === 0 || (Number.isFinite(m.px) && m.px >= 8 && m.px <= MAX_FONT)) {
        clearSel();
        zoomPx = m.px;
        for (const slot of slots.values()) applyZoom(slot);
        follow(slots.get(visible));
        for (const slot of slots.values()) scheduleHist(slot);
      }
      return;
    case 'compose': {
      clearSel();
      if (!isSlot(m.s) || typeof m.d !== 'string' || typeof m.enter !== 'boolean' || !stdinOn) return;
      const slot = slots.get(m.s);
      if (!slot) return;
      for (const msg of composeInputs(m.s, m.d, m.enter, slot.term.modes.bracketedPasteMode)) {
        if (shouldSend(msg.d)) {
          wantX = true;
          send(msg);
        }
      }
      return;
    }
    case 'copyreq': {
      // Kotlin asks only after an explicit native COPY tap; the answer is one 'copy' or nothing.
      if (!sel || !isSlot(m.s) || m.s !== sel.slot.id) return;
      const text = clampText(selectedText(), MAX_COPY_BYTES);
      if (!text) return;
      send({ t: 'copy', text });
      clearSel();
      return;
    }
    case 'selclear':
      clearSel();
      return;
    default:
  }
};

// ---- Selection: long-press (touch, or held mouse) then drag, inside the region it started in.
// LIVE grid: cell hit-test + term.select. SETTLED history: caretRangeFromPoint + the CSS Custom
// Highlight API (no native DOM selection, so no WebView handles). Reporting is only sel on/off.
const inRect = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const histApi = () => typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';
const cmpPt = (a, b) => (a.line - b.line) || (a.off - b.off);

function liveCell(slot, x, y) {
  const screen = slot.term.element && slot.term.element.querySelector('.xterm-screen');
  if (!screen) return null;
  const r = screen.getBoundingClientRect();
  return cellAt({ x, y, left: r.left, top: r.top, width: r.width, height: r.height, cols: slot.term.cols, rows: slot.term.rows });
}

function histLines(slot) {
  const rows = [...slot.hist.querySelectorAll('.hl')];
  // A blank row holds a single nbsp as direct text; it is an empty line, not a character.
  return { rows, lines: rows.map((r) => (r.firstElementChild ? r.textContent : '')) };
}

function histPoint(slot, rows, x, y) {
  const hr = slot.hist.getBoundingClientRect();
  const r = document.caretRangeFromPoint(clamp(x, hr.left + 1, hr.right - 1), clamp(y, hr.top + 1, hr.bottom - 1));
  if (!r) return null;
  const line = rows.findIndex((row) => row.contains(r.startContainer));
  if (line < 0) return null;
  const pre = document.createRange();
  pre.setStart(rows[line], 0);
  pre.setEnd(r.startContainer, r.startOffset);
  return { line, off: pre.toString().length };
}

function domPos(row, off) {
  const w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let left = off;
  let last = null;
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    last = n;
    if (left <= n.length) return [n, left];
    left -= n.length;
  }
  return last ? [last, last.length] : [row, 0];
}

function beginSel(x, y) {
  const slot = slots.get(visible);
  if (!slot || slot.el.hidden) return false;
  clearSel();
  altEnd(); // no wheel bytes while selecting
  const screen = slot.term.element && slot.term.element.querySelector('.xterm-screen');
  if (screen && inRect(screen.getBoundingClientRect(), x, y) && inRect(slot.livex.getBoundingClientRect(), x, y)) {
    const c = liveCell(slot, x, y);
    if (!c) return false;
    const { cols } = slot.term;
    const buf = slot.term.buffer.active;
    const row = buf.viewportY + c.row;
    const line = buf.getLine(row);
    const text = line ? line.translateToString(true) : '';
    const w = c.col < text.length ? wordBounds(text, c.col) : { start: c.col, end: c.col + 1 };
    sel = { kind: 'live', slot, cols, a: row * cols + w.start, e: row * cols + w.end - 1 };
    applyLive(x, y);
  } else if (histApi() && !slot.hist.hidden && inRect(slot.hist.getBoundingClientRect(), x, y)) {
    const { rows, lines } = histLines(slot);
    const p = histPoint(slot, rows, x, y);
    if (!p) return false;
    const w = wordBounds(lines[p.line], p.off);
    sel = { kind: 'hist', slot, rows, lines, a: { line: p.line, off: w.start }, e: { line: p.line, off: w.end } };
    applyHist(x, y);
  } else {
    return false;
  }
  window.getSelection().removeAllRanges(); // the WebView's own long-press selection must not show
  send({ t: 'sel', s: slot.id, on: true });
  return true;
}

function applyLive(x, y) {
  const c = liveCell(sel.slot, x, y);
  if (!c) return;
  const f = (sel.slot.term.buffer.active.viewportY + c.row) * sel.cols + c.col;
  const start = f >= sel.a ? sel.a : f;
  const end = f >= sel.a ? Math.max(f, sel.e) : sel.e;
  sel.slot.term.select(start % sel.cols, Math.floor(start / sel.cols), end - start + 1);
}

function applyHist(x, y) {
  const f = histPoint(sel.slot, sel.rows, x, y);
  if (!f) return;
  const [s, e] = cmpPt(f, sel.a) >= 0 ? [sel.a, cmpPt(f, sel.e) > 0 ? f : sel.e] : [f, sel.e];
  const range = document.createRange();
  range.setStart(...domPos(sel.rows[s.line], s.off));
  range.setEnd(...domPos(sel.rows[e.line], e.off));
  CSS.highlights.set('aether-sel', new Highlight(range));
  sel.s = s;
  sel.f = e;
}

function extendSel(x, y) {
  if (!sel) return;
  if (sel.kind === 'live') applyLive(x, y);
  else applyHist(x, y);
}

function selectedText() {
  if (sel.kind === 'live') return sel.slot.term.getSelection();
  return sliceLines(sel.lines, sel.s || sel.a, sel.f || sel.e);
}

function clearSel() {
  if (!sel) return;
  const cur = sel;
  sel = null;
  selDragging = false;
  if (cur.kind === 'live') cur.slot.term.clearSelection();
  else if (histApi()) CSS.highlights.delete('aether-sel');
  send({ t: 'sel', s: cur.slot.id, on: false });
  for (const slot of slots.values()) scheduleHist(slot);
  follow(cur.slot);
}

root.addEventListener('contextmenu', (e) => e.preventDefault());
const TAP_MAX_MS = 300;
let tapTouch = null; // { x, y, at }: a touch that began while a selection existed (a tap clears it)
const lpTouch = createLongPress({
  slopPx: TOUCH_SLOP_PX,
  onFire: (x, y) => {
    tapTouch = null;
    if (beginSel(x, y)) selDragging = true;
  },
});
const lpMouse = createLongPress({
  slopPx: MOUSE_SLOP_PX,
  onFire: (x, y) => {
    if (mouse && beginSel(x, y)) mouse.sel = true;
  },
});

// Alt-screen touch scroll: a vertical drag pans the slot natively, then the leftover is sent as
// wheel input so the remote app scrolls its own history. Sent directly, not via shouldSend
// (inputFilter drops mouse reports on purpose).
root.dataset.altScroll = 'aether-alt-scroll-v1';
const ALT_DECIDE_PX = 8;
const ALT_FLUSH_MS = 50;
let alt = null; // { slot, x, y, decided, on, carry, pending, timer }
const altKeep = { carry: 0, pending: 0 }; // sub-notch px + unsent notches carried into the next gesture

function altFlush() {
  flushAlt(alt, { stdinOn, send });
}

// commit = normal gesture end (flush pending notches first); default discards (cancel/abort/reset).
function altEnd(commit = false) {
  finishAlt(alt, { commit, stdinOn, send, keep: altKeep });
  alt = null;
}

root.addEventListener('touchstart', (ev) => {
  altEnd();
  lpTouch.end();
  selDragging = false;
  tapTouch = null;
  if (ev.touches.length !== 1) return;
  const slot = slots.get(visible);
  if (!slot || slot.el.hidden) return;
  const t = ev.touches[0];
  lpTouch.start(t.clientX, t.clientY);
  if (sel) tapTouch = { x: t.clientX, y: t.clientY, at: Date.now() };
  alt = { slot, x: t.clientX, y: t.clientY, decided: false, on: false, carry: altKeep.carry, pending: altKeep.pending, timer: 0 };
});

root.addEventListener('touchmove', (ev) => {
  if (ev.touches.length !== 1) {
    lpTouch.end();
    selDragging = false;
  } else {
    const p = ev.touches[0];
    lpTouch.move(p.clientX, p.clientY);
    if (tapTouch && Math.max(Math.abs(p.clientX - tapTouch.x), Math.abs(p.clientY - tapTouch.y)) >= TOUCH_SLOP_PX) tapTouch = null;
    if (selDragging) {
      ev.preventDefault();
      extendSel(p.clientX, p.clientY);
      return;
    }
  }
  if (!alt) return;
  if (ev.touches.length !== 1) {
    altEnd();
    return;
  }
  const t = ev.touches[0];
  const slot = alt.slot;
  if (!alt.decided) {
    const dx = t.clientX - alt.x;
    const dy = t.clientY - alt.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < ALT_DECIDE_PX) return;
    alt.decided = true;
    alt.on = stdinOn && slot.term.buffer.active.type === 'alternate' && shouldIntercept({ bufferType: slot.term.buffer.active.type, dx, dy });
    if (!alt.on) return;
  }
  if (!alt.on) return;
  ev.preventDefault();
  altTouchAt = Date.now();
  const dy = t.clientY - alt.y;
  alt.y = t.clientY;
  const el = slot.el;
  const r = chainDrag({ dy, scrollTop: el.scrollTop, maxScrollTop: el.scrollHeight - el.clientHeight });
  if (r.scrollTop !== el.scrollTop) el.scrollTop = r.scrollTop;
  const screen = slot.term.element && slot.term.element.querySelector('.xterm-screen');
  const rows = slot.term.rows;
  const cellH = screen && rows > 0 ? screen.clientHeight / rows : 0;
  const nn = toNotches({ leftover: r.leftover, carry: alt.carry, cellH });
  alt.carry = nn.carry;
  alt.pending = Math.max(-8, Math.min(8, alt.pending + nn.notches));
  if (alt.pending !== 0 && !alt.timer) alt.timer = setTimeout(altFlush, ALT_FLUSH_MS);
}, { passive: false });

root.addEventListener('touchend', () => {
  lpTouch.end();
  selDragging = false;
  if (tapTouch && Date.now() - tapTouch.at < TAP_MAX_MS) clearSel(); // a tap leaves selection mode
  tapTouch = null;
  altEnd(true);
});
root.addEventListener('touchcancel', () => {
  lpTouch.end();
  selDragging = false;
  tapTouch = null;
  altEnd();
});

// Mouse (Phone Link etc.): Pointer Events drag + wheel. Touch pointers are left to the touch
// handlers above. Wheel bytes go straight through send(), never term.onData.
let mouse = null; // { id, slot, x, y, sx, sy, decided, sel, hadSel }
let wheelCarry = 0;
let wheelPending = 0;

function cellSize(slot) {
  const screen = slot.term.element && slot.term.element.querySelector('.xterm-screen');
  const { rows, cols } = slot.term;
  return {
    cellH: screen && rows > 0 ? screen.clientHeight / rows : 0,
    cellW: screen && cols > 0 ? screen.clientWidth / cols : 0,
  };
}

function mouseEnd(commit = false) {
  if (!mouse) return; // never touch the touch gesture's alt state
  lpMouse.end();
  mouse = null;
  altEnd(commit);
}

root.addEventListener('pointerdown', (ev) => {
  if (!isPrimaryMouse(ev)) return;
  const slot = slots.get(visible);
  if (!slot || slot.el.hidden) return;
  mouseEnd();
  altEnd();
  ev.preventDefault();
  try { root.setPointerCapture(ev.pointerId); } catch (e) { /* pointer already gone */ }
  mouse = { id: ev.pointerId, slot, x: ev.clientX, y: ev.clientY, sx: ev.clientX, sy: ev.clientY, decided: false, sel: false, hadSel: sel !== null };
  lpMouse.start(ev.clientX, ev.clientY);
});

root.addEventListener('pointermove', (ev) => {
  if (!mouse || ev.pointerId !== mouse.id) return;
  if ((ev.buttons & 1) !== 1) {
    mouseEnd(true); // button released outside the page: a normal end
    return;
  }
  const slot = mouse.slot;
  if (mouse.sel) {
    ev.preventDefault();
    extendSel(ev.clientX, ev.clientY);
    return;
  }
  lpMouse.move(ev.clientX, ev.clientY);
  if (!mouse.decided) {
    const tx = ev.clientX - mouse.sx;
    const ty = ev.clientY - mouse.sy;
    if (Math.max(Math.abs(tx), Math.abs(ty)) < MOUSE_SLOP_PX) return;
    mouse.decided = true;
    const type = slot.term.buffer.active.type;
    if (stdinOn && shouldIntercept({ bufferType: type, dx: tx, dy: ty })) {
      alt = { slot, x: 0, y: 0, decided: true, on: true, carry: altKeep.carry, pending: altKeep.pending, timer: 0 };
    }
  }
  ev.preventDefault();
  altTouchAt = Date.now();
  const dx = ev.clientX - mouse.x;
  const dy = ev.clientY - mouse.y;
  mouse.x = ev.clientX;
  mouse.y = ev.clientY;
  const el = slot.el;
  const lx = slot.livex;
  if (alt && alt.on) {
    const r = chainDrag({ dy, scrollTop: el.scrollTop, maxScrollTop: el.scrollHeight - el.clientHeight });
    if (r.scrollTop !== el.scrollTop) el.scrollTop = r.scrollTop;
    const nn = toNotches({ leftover: r.leftover, carry: alt.carry, cellH: cellSize(slot).cellH });
    alt.carry = nn.carry;
    alt.pending = Math.max(-8, Math.min(8, alt.pending + nn.notches));
    if (alt.pending !== 0 && !alt.timer) alt.timer = setTimeout(altFlush, ALT_FLUSH_MS);
    return;
  }
  const r = dragPan({
    dx, dy,
    scrollTop: el.scrollTop, maxScrollTop: el.scrollHeight - el.clientHeight,
    scrollLeft: lx.scrollLeft, maxScrollLeft: lx.scrollWidth - lx.clientWidth,
  });
  if (r.scrollTop !== el.scrollTop) el.scrollTop = r.scrollTop;
  if (r.scrollLeft !== lx.scrollLeft) lx.scrollLeft = r.scrollLeft;
});

root.addEventListener('pointerup', () => {
  // A press-release with no drag and no long-press, while a selection existed, leaves selection mode.
  if (mouse && mouse.hadSel && !mouse.sel && !mouse.decided) clearSel();
  mouseEnd(true);
});
root.addEventListener('pointercancel', () => mouseEnd());
root.addEventListener('lostpointercapture', () => mouseEnd());

root.addEventListener('wheel', (ev) => {
  const slot = slots.get(visible);
  if (!slot || slot.el.hidden) return;
  ev.preventDefault();
  ev.stopPropagation();
  altTouchAt = Date.now();
  const { cellH, cellW } = cellSize(slot);
  const { dx, dy } = wheelPx({
    deltaX: ev.deltaX, deltaY: ev.deltaY, deltaMode: ev.deltaMode, shiftKey: ev.shiftKey,
    cellW, cellH, viewH: slot.el.clientHeight,
  });
  if (stdinOn && slot.term.buffer.active.type === 'alternate') {
    const nn = toNotches({ leftover: -dy, carry: wheelCarry, cellH });
    wheelCarry = nn.carry;
    wheelPending = Math.max(-8, Math.min(8, wheelPending + nn.notches));
    if (wheelPending !== 0) {
      const d = wheelBytes({
        notches: wheelPending,
        trackingMode: slot.term.modes.mouseTrackingMode,
        col: Math.floor(slot.term.cols / 2) + 1,
        row: Math.floor(slot.term.rows / 2) + 1,
      });
      if (d !== null) {
        wheelPending = 0;
        send({ t: 'input', s: slot.id, d });
      }
    }
    if (dx !== 0) slot.livex.scrollLeft += dx;
    return;
  }
  slot.el.scrollTop += dy;
  slot.livex.scrollLeft += dx;
}, { capture: true, passive: false });

// Input diagnostic (T4b): metadata of the page's own pointer/touch/wheel events, only while Kotlin
// has switched it on. Capture + passive, never preventDefault/stopPropagation: observation only.
let diagOn = false;
function diagListen(type, kind, action) {
  let last = 0; // per listener, so touchmove is not starved by the pointermove before it
  root.addEventListener(type, (ev) => {
    if (!diagOn) return;
    const now = Date.now();
    if (!throttle(last, now, action)) return;
    if (action === 'move') last = now;
    send(diagMessage(kind, action, ev));
  }, { capture: true, passive: true });
}
for (const [type, action] of [['pointerdown', 'down'], ['pointermove', 'move'], ['pointerup', 'up'], ['pointercancel', 'cancel']]) diagListen(type, 'p', action);
for (const [type, action] of [['touchstart', 'down'], ['touchmove', 'move'], ['touchend', 'up'], ['touchcancel', 'cancel']]) diagListen(type, 't', action);
diagListen('wheel', 'w', 'wheel');

// V0 fit behaviour, only for slots that never received a size or snap.
new ResizeObserver(() => {
  for (const slot of slots.values()) {
    if (!slot.sized && !slot.el.hidden) slot.fit.fit();
    else if (zoomPx === 0) applyZoom(slot);
  }
  follow(slots.get(visible));
}).observe(root);

show(DEFAULT_SLOT);
send({ t: 'ready' });
