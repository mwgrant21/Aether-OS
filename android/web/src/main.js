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
import { chainDrag, toNotches, wheelBytes, shouldIntercept } from './altScroll.js';

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
  if (!slot || slot.el.hidden || Date.now() - altTouchAt < ALT_FOLLOW_QUIET_MS) return;
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
      if (isSlot(m.s) && isDim(m.cols) && isDim(m.rows)) setSize(slotFor(m.s), m.cols, m.rows);
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
      return;
    case 'zoom':
      if (m.px === 0 || (Number.isFinite(m.px) && m.px >= 8 && m.px <= MAX_FONT)) {
        zoomPx = m.px;
        for (const slot of slots.values()) applyZoom(slot);
        follow(slots.get(visible));
        for (const slot of slots.values()) scheduleHist(slot);
      }
      return;
    case 'compose': {
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
    default:
  }
};

// Alt-screen touch scroll: a vertical drag pans the slot natively, then the leftover is sent as
// wheel input so the remote app scrolls its own history. Sent directly, not via shouldSend
// (inputFilter drops mouse reports on purpose).
root.dataset.altScroll = 'aether-alt-scroll-v1';
const ALT_DECIDE_PX = 8;
const ALT_FLUSH_MS = 50;
let alt = null; // { slot, x, y, decided, on, carry, pending, timer }

function altFlush() {
  if (!alt) return;
  alt.timer = 0;
  const slot = alt.slot;
  if (alt.pending === 0 || !stdinOn || slot.el.hidden) return;
  const n = Math.max(-8, Math.min(8, alt.pending));
  const d = wheelBytes({
    notches: n,
    trackingMode: slot.term.modes.mouseTrackingMode,
    col: Math.floor(slot.term.cols / 2) + 1,
    row: Math.floor(slot.term.rows / 2) + 1,
  });
  if (d === null) return; // below the PgUp/PgDn threshold: keep accumulating
  alt.pending = 0;
  send({ t: 'input', s: slot.id, d });
}

function altEnd() {
  if (alt && alt.timer) clearTimeout(alt.timer);
  alt = null;
}

root.addEventListener('touchstart', (ev) => {
  altEnd();
  if (ev.touches.length !== 1) return;
  const slot = slots.get(visible);
  if (!slot || slot.el.hidden) return;
  const t = ev.touches[0];
  alt = { slot, x: t.clientX, y: t.clientY, decided: false, on: false, carry: 0, pending: 0, timer: 0 };
});

root.addEventListener('touchmove', (ev) => {
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

root.addEventListener('touchend', altEnd);
root.addEventListener('touchcancel', altEnd);

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
