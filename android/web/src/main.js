// Aether Mobile terminal page: display only in V2 (design spec 2.8, 4.4, D7).
// Every byte of I/O goes through the Kotlin-side bridge (addWebMessageListener); the
// page has no network (CSP connect-src 'none'). No clipboard addon (OSC 52 off), no
// link handling, no title handling. One xterm per slot, created on first use.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { installReplySuppression, applySnap, applySize } from './replySuppression.js';
import { shouldSend, applyStdin } from './inputFilter.js';
import { composeInputs } from './compose.js';

const DEFAULT_SLOT = 'claude'; // the V0 demo source sends `out` for this slot with no snap/size
const FONT_FAMILY = 'ui-monospace, "Cascadia Mono", Menlo, monospace';
const MIN_FONT = 6;
const MAX_FONT = 24;
const bridge = window.aetherBridge;
const send = (m) => bridge.postMessage(JSON.stringify(m));
const utf8Len = (s) => new TextEncoder().encode(s).length;
const root = document.getElementById('term');

const slots = new Map();
let visible = DEFAULT_SLOT;
let zoomPx = 14; // 0 = fit width
let stdinOn = false; // fail closed: Kotlin turns typing on with {t:'stdin', on:true}

function slotFor(id) {
  let slot = slots.get(id);
  if (slot) return slot;
  const el = document.createElement('div');
  el.className = 'slot';
  el.hidden = id !== visible;
  root.appendChild(el);
  const term = new Terminal({
    scrollback: 2000,
    cursorBlink: false,
    disableStdin: !stdinOn, // fail closed; the `stdin` bridge message flips it
    allowProposedApi: false,
    fontFamily: FONT_FAMILY,
    fontSize: zoomPx || 14,
    theme: { background: '#0A0E14', foreground: '#D5DEE8', cursor: '#4FD1C5' },
  });
  installReplySuppression(term);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  slot = { id, el, term, fit, sized: false };
  // Input only while stdin is on, and never mouse/focus reports (inputFilter). Resize is
  // reported only while the page is fitting itself (V0 demo); titan owns the size otherwise.
  term.onData((d) => {
    if (shouldSend(d)) send({ t: 'input', s: id, d });
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
}

// sized is set synchronously so the onResize wired above stays silent; the resize itself
// is applied in order behind pending output (see applySize / applySnap).
function setSize(slot, cols, rows) {
  slot.sized = true;
  applySize(slot.term, cols, rows, () => applyZoom(slot));
}

function show(id) {
  visible = id;
  for (const [sid, slot] of slots) slot.el.hidden = sid !== id;
  const slot = slotFor(id);
  slot.el.hidden = false;
  applyZoom(slot);
  if (!slot.sized) slot.fit.fit();
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
      applySnap(slot.term, m.cols, m.rows, m.d, () => applyZoom(slot));
      return;
    }
    case 'out': {
      if (!isSlot(m.s) || typeof m.d !== 'string') return;
      const { d, s } = m;
      // Credit back to Kotlin once xterm has consumed the chunk (flow control).
      slotFor(s).term.write(d, () => send({ t: 'consumed', s, bytes: utf8Len(d) }));
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
      }
      return;
    case 'compose': {
      if (!isSlot(m.s) || typeof m.d !== 'string' || typeof m.enter !== 'boolean' || !stdinOn) return;
      const slot = slots.get(m.s);
      if (!slot) return;
      for (const msg of composeInputs(m.s, m.d, m.enter, slot.term.modes.bracketedPasteMode)) {
        if (shouldSend(msg.d)) send(msg);
      }
      return;
    }
    default:
  }
};

// V0 fit behaviour, only for slots that never received a size or snap.
new ResizeObserver(() => {
  for (const slot of slots.values()) {
    if (!slot.sized && !slot.el.hidden) slot.fit.fit();
    else if (zoomPx === 0) applyZoom(slot);
  }
}).observe(root);

show(DEFAULT_SLOT);
send({ t: 'ready' });
