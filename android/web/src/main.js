// Aether Mobile terminal page: display + keyboard only (design spec 2.8, 4.4).
// Every byte of I/O goes through the Kotlin-side bridge (addWebMessageListener); the
// page has no network (CSP connect-src 'none'). No clipboard addon (OSC 52 off), no
// link handling, no title handling.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const SESSION = 'claude'; // V0: one fake session; tabs arrive in V2
const bridge = window.aetherBridge;
const send = (m) => bridge.postMessage(JSON.stringify(m));
const utf8Len = (s) => new TextEncoder().encode(s).length;

const term = new Terminal({
  scrollback: 2000,
  cursorBlink: true,
  fontFamily: 'ui-monospace, "Cascadia Mono", Menlo, monospace',
  fontSize: 14,
  theme: { background: '#0A0E14', foreground: '#D5DEE8', cursor: '#4FD1C5' },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('term'));

term.onData((d) => send({ t: 'input', s: SESSION, d }));
term.onResize(({ cols, rows }) => send({ t: 'resize', s: SESSION, cols, rows }));

bridge.onmessage = (ev) => {
  let m;
  try {
    m = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (m && m.t === 'out' && m.s === SESSION && typeof m.d === 'string') {
    // Credit back to Kotlin once xterm has consumed the chunk (flow control, used from V2).
    term.write(m.d, () => send({ t: 'consumed', s: SESSION, bytes: utf8Len(m.d) }));
  }
};

new ResizeObserver(() => fit.fit()).observe(document.getElementById('term'));
fit.fit();
term.focus();
send({ t: 'ready' });
