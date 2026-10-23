// Static phone pages for remote access, served from main as plain strings.
// No fs, no require: the bytes ship inside the bundle. The viewer is read-only
// by construction (no input element, no socket send) and renders message text
// with textContent only. See the mobile remote-access spec, T7.
import type { RemoteAssets } from './types';

const HEAD =
  '<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  '<meta name="referrer" content="no-referrer">\n' +
  '<meta name="robots" content="noindex">\n' +
  '<link rel="stylesheet" href="/assets/app.css">\n';

export const PAIR_HTML =
  '<!doctype html>\n<html lang="en">\n<head>\n' +
  HEAD +
  '<title>Pair with Aether</title>\n</head>\n<body class="pair">\n' +
  '<main>\n<h1>Pair with Aether</h1>\n' +
  '<p>Enter the code shown in Aether on your computer.</p>\n' +
  '<label for="code">Pairing code</label>\n' +
  '<input id="code" type="text" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="9" placeholder="XXXX-XXXX">\n' +
  '<button id="go" type="button">Pair</button>\n' +
  '<p id="msg" role="status" aria-live="polite"></p>\n</main>\n' +
  '<script src="/assets/pair.js"></script>\n</body>\n</html>\n';

export const VIEWER_HTML =
  '<!doctype html>\n<html lang="en">\n<head>\n' +
  HEAD +
  '<title>Aether</title>\n</head>\n<body class="viewer">\n' +
  '<header><h1 id="title">Claude session</h1><span id="state" role="status" aria-live="polite"></span></header>\n' +
  '<div id="banner" hidden></div>\n' +
  '<main id="list" aria-live="polite"></main>\n' +
  '<button id="pill" type="button" hidden>New messages</button>\n' +
  '<script src="/assets/viewer.js"></script>\n</body>\n</html>\n';

export const PAIR_JS = String.raw`(function () {
  'use strict';
  var input = document.getElementById('code');
  var button = document.getElementById('go');
  var msg = document.getElementById('msg');
  var hash = location.hash || '';
  var m = /^#c=([A-Za-z0-9-]{1,16})$/.exec(hash);
  var fromHash = m ? m[1] : '';
  // Remove the fragment before any network call so the code never lingers in history.
  history.replaceState(null, '', location.pathname);
  if (fromHash) input.value = fromHash;
  var busy = false;
  function say(text) { msg.textContent = text; }
  function submit() {
    if (busy) return;
    var code = input.value.trim().toUpperCase();
    if (!code) { say('Enter the code.'); return; }
    busy = true;
    say('Checking...');
    fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code }),
      credentials: 'same-origin'
    }).then(function (res) {
      busy = false;
      if (res.status === 204) { location.replace('/'); return; }
      if (res.status === 429) { say('Too many attempts. Create a new code on the desktop.'); return; }
      say('Code not accepted or expired.');
    }, function () {
      busy = false;
      say('Could not reach Aether.');
    });
  }
  button.addEventListener('click', submit);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  if (fromHash) submit();
})();
`;

export const VIEWER_JS = String.raw`(function () {
  'use strict';
  var MAX_BUBBLES = 200;
  var NEAR_BOTTOM_PX = 80;
  var list = document.getElementById('list');
  var titleEl = document.getElementById('title');
  var stateEl = document.getElementById('state');
  var banner = document.getElementById('banner');
  var pill = document.getElementById('pill');
  var items = [];
  var ids = new Set();
  var delay = 1000;
  var everOpened = false;
  var failsAfterOpen = 0;
  var stopped = false;
  var timer = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function nearBottom() {
    return list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX;
  }
  function scrollDown() { list.scrollTop = list.scrollHeight; }
  function timeText(ms) {
    try { return new Date(ms).toLocaleTimeString(); } catch (e) { return ''; }
  }
  function forget(item) {
    ids.delete(item.id);
    if (item.node.parentNode) item.node.parentNode.removeChild(item.node);
  }
  function clearAll() {
    for (var i = 0; i < items.length; i++) forget(items[i]);
    items = [];
    ids.clear();
  }
  function trim() {
    while (items.length > MAX_BUBBLES) forget(items.shift());
  }

  function buildMsg(ev) {
    var b = el('div', 'bubble ' + (ev.role === 'you' ? 'you' : 'claude'));
    b.appendChild(el('div', 'text', ev.text));
    if (ev.truncated) b.appendChild(el('div', 'trunc', '(truncated)'));
    var tools = Array.isArray(ev.tools) ? ev.tools : [];
    if (tools.length) {
      var row = el('div', 'tools');
      for (var i = 0; i < tools.length; i++) row.appendChild(el('span', 'chip', tools[i]));
      b.appendChild(row);
    }
    b.appendChild(el('div', 'time', timeText(ev.atMs)));
    return b;
  }
  function buildTraffic(ev) {
    var c = el('div', 'card');
    var head = el('div', 'route');
    head.appendChild(el('span', 'who', String(ev.from) + ' -> ' + String(ev.to)));
    if (ev.status) head.appendChild(el('span', 'badge', ev.status));
    c.appendChild(head);
    if (ev.subject) c.appendChild(el('div', 'subject', ev.subject));
    var body = el('div', 'text clamp', ev.text);
    body.addEventListener('click', function () { body.classList.toggle('expanded'); });
    c.appendChild(body);
    if (ev.truncated) c.appendChild(el('div', 'trunc', '(truncated)'));
    c.appendChild(el('div', 'time', timeText(ev.atMs)));
    return c;
  }
  function render(ev) {
    if (!ev || typeof ev.id !== 'string' || ids.has(ev.id)) return null;
    var node = ev.k === 'msg' ? buildMsg(ev) : ev.k === 'traffic' ? buildTraffic(ev) : null;
    if (!node) return null;
    ids.add(ev.id);
    items.push({ id: ev.id, node: node });
    list.appendChild(node);
    return node;
  }
  function append(events) {
    var stick = nearBottom();
    var added = false;
    for (var i = 0; i < events.length; i++) if (render(events[i])) added = true;
    trim();
    if (!added) return;
    if (stick) { scrollDown(); pill.hidden = true; } else { pill.hidden = false; }
  }

  function onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'session') {
      titleEl.textContent = m.title || 'Claude session';
      if (m.attached === false) { banner.textContent = 'No Claude session is pinned in Aether.'; banner.hidden = false; }
      else { banner.hidden = true; }
    } else if (m.t === 'history') {
      clearAll();
      append(Array.isArray(m.events) ? m.events : []);
      scrollDown();
      pill.hidden = true;
    } else if (m.t === 'event') {
      append([m.event]);
    } else if (m.t === 'bye') {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      var why = { revoked: 'This phone was unpaired.', disabled: 'Remote access was turned off.', 'slow-consumer': 'Connection too slow.', policy: 'Connection refused.' };
      stateEl.textContent = why[m.reason] || 'Disconnected.';
    }
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws;
    var opened = false;
    stateEl.textContent = 'Connecting...';
    try { ws = new WebSocket(proto + location.host + '/ws'); } catch (e) { retry(false); return; }
    ws.onopen = function () {
      opened = true; everOpened = true; failsAfterOpen = 0; delay = 1000;
      stateEl.textContent = 'Live';
    };
    ws.onmessage = function (e) {
      var m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      onMessage(m);
    };
    ws.onclose = function () { if (!stopped) retry(opened); };
    ws.onerror = function () {};
  }
  function retry(wasOpen) {
    if (stopped) return;
    if (!wasOpen && everOpened) {
      failsAfterOpen += 1;
      if (failsAfterOpen >= 2) {
        stopped = true;
        stateEl.textContent = 'Paired session ended. Pair again.';
        return;
      }
    }
    stateEl.textContent = 'Reconnecting...';
    timer = setTimeout(function () { timer = null; connect(); }, delay);
    delay = Math.min(delay * 2, 15000);
  }

  pill.addEventListener('click', function () { scrollDown(); pill.hidden = true; });
  list.addEventListener('scroll', function () { if (nearBottom()) pill.hidden = true; });
  connect();
})();
`;

export const APP_CSS = `*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font:16px/1.4 system-ui,sans-serif;background:#0f1115;color:#e6e6e6;-webkit-text-size-adjust:100%}
h1{font-size:1.1rem;margin:0}
body.pair main{max-width:28rem;margin:0 auto;padding:1.5rem 1rem}
body.pair label{display:block;margin:1rem 0 .25rem}
body.pair input{width:100%;font:inherit;font-size:1.25rem;letter-spacing:.1em;padding:.6rem;border-radius:8px;border:1px solid #444;background:#181b22;color:inherit}
body.pair button{margin-top:1rem;width:100%;font:inherit;padding:.75rem;border-radius:8px;border:0;background:#4a7dff;color:#fff}
body.viewer{display:flex;flex-direction:column}
body.viewer header{display:flex;justify-content:space-between;gap:.5rem;align-items:baseline;padding:.6rem .8rem;background:#181b22;border-bottom:1px solid #2a2f3a}
#state{font-size:.8rem;opacity:.7}
#banner{padding:.5rem .8rem;background:#3a2f12;color:#f1d58a}
#list{flex:1;overflow-y:auto;padding:.6rem;display:flex;flex-direction:column;gap:.5rem;overflow-wrap:anywhere}
.bubble{max-width:88%;padding:.5rem .7rem;border-radius:12px;background:#222733}
.bubble.you{align-self:flex-end;background:#2b4a8a}
.bubble.claude{align-self:flex-start}
.text{white-space:pre-wrap}
.time{font-size:.7rem;opacity:.55;margin-top:.2rem}
.trunc{font-size:.75rem;opacity:.65}
.tools{display:flex;flex-wrap:wrap;gap:.25rem;margin-top:.3rem}
.chip{font-size:.7rem;padding:.1rem .45rem;border-radius:999px;background:#0f1115;opacity:.85}
.card{padding:.5rem .7rem;border-radius:8px;background:#1a1f2b;border-left:3px solid #6b7bff}
.route{display:flex;gap:.5rem;align-items:center;font-size:.8rem;opacity:.9}
.subject{font-weight:600;margin-top:.2rem}
.badge{font-size:.7rem;padding:.05rem .4rem;border-radius:4px;background:#444}
.clamp{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:12;overflow:hidden;cursor:pointer}
.clamp.expanded{display:block;-webkit-line-clamp:unset}
#pill{position:fixed;left:50%;bottom:1rem;transform:translateX(-50%);padding:.5rem 1rem;border-radius:999px;border:0;background:#4a7dff;color:#fff;font:inherit}
[hidden]{display:none!important}
`;

export function contentSecurityPolicy(hostPort: string): string {
  return (
    "default-src 'none'; script-src 'self'; style-src 'self'; " +
    `connect-src 'self' ws://${hostPort}; img-src 'self' data:; ` +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
}

export const REMOTE_ASSETS: RemoteAssets = {
  pairHtml: PAIR_HTML,
  pairJs: PAIR_JS,
  viewerHtml: VIEWER_HTML,
  viewerJs: VIEWER_JS,
  appCss: APP_CSS,
};
