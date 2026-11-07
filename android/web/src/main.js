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
import { createAutoScroll } from './edgeScroll.js';
import {
  cellAt, cellWordBounds, wordBounds, clampText, clampAnchor, sliceLines, createLongPress, MAX_COPY_BYTES, TOUCH_SLOP_PX,
  caretInCell, extendFromWord, dragHandle, splitSelection, liveSpan, joinSelectionText,
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
let sel = null; // { slot, base, cols, histCount, rows, lines, word, s, e }: one span over hist + live
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
  // Handles ride the text, so they re-place when either scroller moves.
  const replace = () => { if (sel && sel.slot === slot) placeHandles(); };
  el.addEventListener('scroll', replace, { passive: true });
  livex.addEventListener('scroll', replace, { passive: true });
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

// ---- Selection: long-press (touch, or held mouse) then drag; one span that may cross from settled
// history into the live grid. LIVE grid: cell hit-test + term.select. SETTLED history:
// caretRangeFromPoint + the CSS Custom Highlight API (no native DOM selection, so no WebView
// handles). Reporting is only sel on/off.
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const histApi = () => typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

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
  // caretRangeFromPoint returns null outside the window, so clamp to hist rect and window both.
  const r = document.caretRangeFromPoint(
    clamp(x, Math.max(hr.left, 0) + 1, Math.min(hr.right, window.innerWidth) - 1),
    clamp(y, Math.max(hr.top, 0) + 1, Math.min(hr.bottom, window.innerHeight) - 1),
  );
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

// Which region (x,y) is in: the live grid when y is at or below its top (or history is unavailable,
// histCount 0), else settled history. null when neither exists.
function regionOf(ctx, x, y) {
  const screen = ctx.slot.term.element && ctx.slot.term.element.querySelector('.xterm-screen');
  if (screen && (ctx.histCount === 0 || y >= screen.getBoundingClientRect().top)) return 'live';
  return ctx.histCount > 0 ? 'hist' : null;
}

// Combined point under (x,y): history logical line + UTF-16 caret, or histCount + live row (relative
// to ctx.base) + cell-column caret. null when nothing usable is there.
function pointAt(ctx, x, y) {
  const region = regionOf(ctx, x, y);
  if (region === 'hist') return histPoint(ctx.slot, ctx.rows, x, y);
  if (region !== 'live') return null;
  const c = liveCell(ctx.slot, x, y);
  if (!c) return null;
  const screen = ctx.slot.term.element.querySelector('.xterm-screen');
  const r = screen.getBoundingClientRect();
  const off = caretInCell({ x, left: r.left, width: r.width, cols: ctx.cols });
  if (off === null) return null;
  const abs = Math.max(ctx.base, ctx.slot.term.buffer.active.viewportY + c.row);
  return { line: ctx.histCount + abs - ctx.base, off };
}

function beginSel(x, y) {
  const slot = slots.get(visible);
  if (!slot || slot.el.hidden) return false;
  clearSel();
  altEnd(); // no wheel bytes while selecting
  const { rows, lines } = histApi() && !slot.hist.hidden ? histLines(slot) : { rows: [], lines: [] };
  const buf = slot.term.buffer.active;
  const ctx = { slot, base: buf.baseY, cols: slot.term.cols, histCount: rows.length, rows, lines };
  const region = regionOf(ctx, x, y);
  let word;
  if (region === 'live') {
    const p = pointAt(ctx, x, y);
    const c = liveCell(slot, x, y);
    if (!p || !c) return false;
    const line = buf.getLine(Math.max(ctx.base, buf.viewportY + c.row));
    const cells = [];
    for (let i = 0; line && i < ctx.cols; i++) {
      const cell = line.getCell(i);
      if (!cell) break;
      cells.push({ chars: cell.getChars(), width: cell.getWidth() });
    }
    const w = cellWordBounds(cells, c.col);
    word = { s: { line: p.line, off: w.start }, e: { line: p.line, off: w.end } };
  } else if (region === 'hist') {
    const p = pointAt(ctx, x, y);
    if (!p) return false;
    const w = wordBounds(lines[p.line], p.off);
    word = { s: { line: p.line, off: w.start }, e: { line: p.line, off: w.end } };
  } else {
    return false;
  }
  sel = { ...ctx, word, s: word.s, e: word.e };
  render();
  window.getSelection().removeAllRanges(); // the WebView's own long-press selection must not show
  send({ t: 'sel', s: slot.id, on: true });
  return true;
}

// Paint sel.s..sel.e: the history part as a DOM Range under the Custom Highlight, the live part
// through term.select. A part the span does not cover is cleared.
function render() {
  const parts = splitSelection(sel.s, sel.e, sel.histCount);
  if (histApi()) {
    if (parts.hist) {
      const at = (p) => domPos(sel.rows[p.line], Math.min(p.off, sel.lines[p.line].length));
      const range = document.createRange();
      range.setStart(...at(parts.hist.s));
      range.setEnd(...at(parts.hist.e));
      CSS.highlights.set('aether-sel', new Highlight(range));
    } else {
      CSS.highlights.delete('aether-sel');
    }
  }
  const span = liveSpan(parts.live, sel.cols);
  if (span) sel.slot.term.select(span.col, sel.base + span.row, span.len);
  else sel.slot.term.clearSelection();
  placeHandles();
}

// ---- Selection handles (touch only): two draggable carets in an overlay OUTSIDE #term, so a touch
// on one never reaches the root listeners (tap-to-clear, long-press, alt scroll). Geometry is
// DEVICE-UNVERIFIED: history uses one-character Range rects with fallbacks, live uses cell math.
const HANDLE_LIFT_PX = 20; // the probe sits above the finger so the caret stays visible
const HANDLE_BOX_PX = 44;
let handlesArmed = false; // a touch long-press created the current selection
let heldHandle = null; // 'start' | 'end' while a handle is being dragged
let handleEls = null; // { box, start, end }

function ensureHandles() {
  if (handleEls) return handleEls;
  const box = document.createElement('div');
  box.id = 'selhandles';
  box.style.display = 'none';
  const make = (which) => {
    const el = document.createElement('div');
    el.className = `selhandle ${which}`;
    el.style.display = 'none';
    const dot = document.createElement('div');
    dot.className = 'selhandle-dot';
    el.appendChild(dot);
    el.addEventListener('touchstart', (ev) => {
      if (!sel || ev.touches.length !== 1) return;
      ev.preventDefault();
      ev.stopPropagation();
      heldHandle = which;
      const t = ev.touches[0];
      dragTo(t.clientX, t.clientY - HANDLE_LIFT_PX, false);
    }, { passive: false });
    el.addEventListener('touchmove', (ev) => {
      if (!heldHandle || !sel) return;
      ev.preventDefault();
      ev.stopPropagation();
      const t = ev.touches[0];
      if (!t) return;
      dragTo(t.clientX, t.clientY - HANDLE_LIFT_PX);
    }, { passive: false });
    const release = () => {
      heldHandle = null;
      stopDrag();
    };
    el.addEventListener('touchend', release);
    el.addEventListener('touchcancel', release);
    box.appendChild(el);
    return el;
  };
  const start = make('start');
  const end = make('end');
  document.body.appendChild(box);
  handleEls = { box, start, end };
  return handleEls;
}

// Screen anchor { x, y } (caret x, row bottom) of a selection point, or null when it is off-screen.
function handleAnchor(pt, which) {
  const slot = sel.slot;
  const sr = slot.el.getBoundingClientRect();
  let a = null;
  if (pt.line < sel.histCount) {
    const row = sel.rows[pt.line];
    const text = sel.lines[pt.line];
    const off = clamp(pt.off, 0, text.length);
    // One-character range beside the caret: start prefers the char after it (its left edge), end the
    // char before it (its right edge); the other side and then the row box are the fallbacks.
    const edge = (from, to, useLast) => {
      if (from < 0 || to > text.length || from >= to) return null;
      const range = document.createRange();
      range.setStart(...domPos(row, from));
      range.setEnd(...domPos(row, to));
      const rects = range.getClientRects();
      if (!rects.length) return null;
      const rc = useLast ? rects[rects.length - 1] : rects[0];
      return { x: useLast ? rc.right : rc.left, y: rc.bottom };
    };
    const after = () => edge(off, off + 1, false);
    const before = () => edge(off - 1, off, true);
    a = (which === 'start' ? after() || before() : before() || after());
    if (!a) {
      const rc = row.getBoundingClientRect(); // blank row, or a Range with no rects
      a = { x: rc.left, y: rc.bottom };
    }
  } else {
    const screen = sel.slot.term.element && sel.slot.term.element.querySelector('.xterm-screen');
    if (!screen) return null;
    const buf = sel.slot.term.buffer.active;
    const vr = sel.base + (pt.line - sel.histCount) - buf.viewportY;
    const rows = sel.slot.term.rows;
    if (vr < 0 || vr >= rows || !sel.cols) return null;
    const r = screen.getBoundingClientRect();
    a = { x: r.left + (clamp(pt.off, 0, sel.cols) * r.width) / sel.cols, y: r.top + ((vr + 1) * r.height) / rows };
  }
  return clampAnchor(a, sr);
}

function placeHandles() {
  const show = sel && handlesArmed && !selDragging;
  if (!show && !handleEls) return;
  const h = ensureHandles();
  h.box.style.display = show ? 'block' : 'none';
  if (!show) return;
  for (const [which, pt] of [['start', sel.s], ['end', sel.e]]) {
    const el = h[which];
    const a = handleAnchor(pt, which);
    if (!a) {
      el.style.display = 'none';
      continue;
    }
    el.style.display = 'block';
    // start sits left of its caret and end right of it, so neither covers the selected text.
    el.style.left = `${which === 'start' ? a.x - HANDLE_BOX_PX + 8 : a.x - 8}px`;
    el.style.top = `${a.y}px`;
  }
}

function extendSel(x, y) {
  if (!sel) return;
  const pt = pointAt(sel, x, y);
  if (!pt) return;
  const { s, e } = extendFromWord(sel.word, pt);
  sel.s = s;
  sel.e = e;
  render();
}

// ---- Edge auto-scroll: one timer, shared by a held handle, the long-press finger and a mouse drag.
// `drag` is the last probe point (handle lift already applied); the timer re-applies it after each
// scroll so the selection follows even when the finger is still. Every gesture end calls stopDrag().
let drag = null; // { x, y }
const autoScroll = createAutoScroll({
  getPoint: () => (sel && drag ? drag : null),
  getBounds: () => sel.slot.el.getBoundingClientRect(),
  scrollBy: (dy) => {
    const el = sel.slot.el;
    const before = el.scrollTop;
    el.scrollTop += dy;
    if (el.scrollTop === before) return false;
    applyDrag();
    return true;
  },
});

function applyDrag() {
  if (!sel || !drag) return;
  if (heldHandle) {
    const pt = pointAt(sel, drag.x, drag.y);
    if (!pt) return;
    const r = dragHandle({ s: sel.s, e: sel.e }, heldHandle, pt);
    sel.s = r.s;
    sel.e = r.e;
    heldHandle = r.which;
    render();
  } else {
    extendSel(drag.x, drag.y);
  }
}

// Record the probe point, apply it (unless the caller just did the work), and keep the timer armed.
function dragTo(x, y, apply = true) {
  if (!sel) return;
  drag = { x, y };
  if (apply) applyDrag();
  autoScroll.start();
}

function stopDrag() {
  autoScroll.stop();
  drag = null;
}

function selectedText() {
  const parts = splitSelection(sel.s, sel.e, sel.histCount);
  const histText = parts.hist ? sliceLines(sel.lines, parts.hist.s, parts.hist.e) : '';
  const liveText = liveSpan(parts.live, sel.cols) ? sel.slot.term.getSelection() : '';
  const wrapped = sel.slot.term.buffer.active.getLine(sel.base)?.isWrapped === true;
  return joinSelectionText(histText, liveText, wrapped);
}

function clearSel() {
  stopDrag();
  if (!sel) return;
  const cur = sel;
  sel = null;
  selDragging = false;
  handlesArmed = false;
  heldHandle = null;
  placeHandles();
  cur.slot.term.clearSelection();
  if (histApi()) CSS.highlights.delete('aether-sel');
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
    if (beginSel(x, y)) {
      selDragging = true;
      handlesArmed = true; // shown once the finger lifts
      dragTo(x, y, false);
    }
  },
});
const lpMouse = createLongPress({
  slopPx: MOUSE_SLOP_PX,
  onFire: (x, y) => {
    if (mouse && beginSel(x, y)) {
      mouse.sel = true;
      dragTo(x, y, false);
    }
  },
});

// Alt-screen touch scroll: a vertical drag pans the slot natively, then the leftover is sent as
// wheel input so the remote app scrolls its own history. Sent directly, not via shouldSend
// (inputFilter drops mouse reports on purpose).
root.dataset.altScroll = 'aether-alt-scroll-v1';
const ALT_DECIDE_PX = 8;
const ALT_FLUSH_MS = 50;
let alt = null; // { slot, x, y, decided, on, carry, pending, timer }
const altKeep = { carry: 0 }; // sub-notch px carried into the next gesture

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
  stopDrag();
  tapTouch = null;
  if (ev.touches.length !== 1) return;
  const slot = slots.get(visible);
  if (!slot || slot.el.hidden) return;
  const t = ev.touches[0];
  lpTouch.start(t.clientX, t.clientY);
  if (sel) tapTouch = { x: t.clientX, y: t.clientY, at: Date.now() };
  alt = { slot, x: t.clientX, y: t.clientY, decided: false, on: false, carry: altKeep.carry, pending: 0, timer: 0 };
});

root.addEventListener('touchmove', (ev) => {
  if (ev.touches.length !== 1) {
    lpTouch.end();
    selDragging = false;
    stopDrag();
  } else {
    const p = ev.touches[0];
    lpTouch.move(p.clientX, p.clientY);
    if (tapTouch && Math.max(Math.abs(p.clientX - tapTouch.x), Math.abs(p.clientY - tapTouch.y)) >= TOUCH_SLOP_PX) tapTouch = null;
    if (selDragging) {
      ev.preventDefault();
      dragTo(p.clientX, p.clientY);
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
  stopDrag();
  if (tapTouch && Date.now() - tapTouch.at < TAP_MAX_MS) clearSel(); // a tap leaves selection mode
  tapTouch = null;
  altEnd(true);
  placeHandles();
});
root.addEventListener('touchcancel', () => {
  lpTouch.end();
  selDragging = false;
  stopDrag();
  tapTouch = null;
  altEnd();
  placeHandles();
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
  stopDrag();
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
    dragTo(ev.clientX, ev.clientY);
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
      alt = { slot, x: 0, y: 0, decided: true, on: true, carry: altKeep.carry, pending: 0, timer: 0 };
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
        appCursor: slot.term.modes.applicationCursorKeysMode === true,
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
