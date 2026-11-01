// Fake `claude -p --input-format stream-json` for voice tests. Plain Node ESM, no deps.
// Flags are ignored. Emits nothing until the first user message (like the real CLI).
// Directives inside the user text pick the behaviour:
//   [[slow]] 5 chunks 40 ms apart (interruptible)   [[delim]] spoken line, ---, detail
//   [[secret]] key split across two chunks + password=...   [[tool]] a Bash tool_use start
//   [[perm]] can_use_tool request, waits for the answer     [[crash]] exit 1 mid-reply
//   [[hang]] slow reply that ignores interrupt              [[utf8]] a multi-byte char split across writes
// Env: FAKE_CLAUDE_EXIT_AFTER_MS exits unprompted; FAKE_CLAUDE_GRANDCHILD=1 spawns a
// grandchild and survives stdin EOF (so only a tree kill ends it).
// stderr gets one `pid=<n>` line (and `gc=<n>` for the grandchild) for the tests.
import { spawn } from 'node:child_process';

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const delta = (text) => out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const result = () => out({ type: 'result', subtype: 'success', is_error: false });

process.stderr.write('pid=' + process.pid + '\n');
if (process.env.FAKE_CLAUDE_EXIT_AFTER_MS) {
  setTimeout(() => process.exit(0), Number(process.env.FAKE_CLAUDE_EXIT_AFTER_MS));
}
if (process.env.FAKE_CLAUDE_GRANDCHILD === '1') {
  const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true, detached: true });
  process.stderr.write('gc=' + gc.pid + '\n');
  setInterval(() => {}, 1000);
}

let started = false;
let timers = [];
let ignoreInterrupt = false;
let pendingPerm = null;

function later(ms, fn) {
  const t = setTimeout(fn, ms);
  timers.push(t);
}
function stopReply() {
  for (const t of timers) clearTimeout(t);
  timers = [];
}
function chunksOf(text, n) {
  const size = Math.max(1, Math.ceil(text.length / n));
  const parts = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}
function streamChunks(parts, gapMs, done) {
  parts.forEach((p, i) => later(i * gapMs, () => delta(p)));
  later(parts.length * gapMs, done);
}

function reply(text) {
  if (text.includes('[[crash]]')) {
    delta('partial ');
    setTimeout(() => process.exit(1), 10);
    return;
  }
  if (text.includes('[[perm]]')) {
    const id = 'perm-' + Date.now();
    pendingPerm = id;
    out({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo hi' } } });
    return;
  }
  if (text.includes('[[tool]]')) {
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } } });
    streamChunks(['done'], 5, result);
    return;
  }
  if (text.includes('[[utf8]]')) {
    const line = Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'café ☃ ok' } } }) + '\n', 'utf8');
    const cut = line.indexOf(0xc3) + 1; // splits the two bytes of e-acute
    process.stdout.write(line.subarray(0, cut));
    later(30, () => process.stdout.write(line.subarray(cut)));
    later(60, result);
    return;
  }
  if (text.includes('[[hang]]')) {
    ignoreInterrupt = true;
    streamChunks(chunksOf('hanging reply that keeps going '.repeat(10), 50), 40, result);
    return;
  }
  if (text.includes('[[slow]]')) {
    streamChunks(chunksOf('Sure thing. slow reply with several chunks', 5), 40, result);
    return;
  }
  if (text.includes('[[delim]]')) {
    streamChunks(['Sure thing.\n---\nDetail here.'], 5, result);
    return;
  }
  if (text.includes('[[secret]]')) {
    const key = 'sk-ant-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5';
    streamChunks(['Here: ' + key.slice(0, 20), key.slice(20) + ' and password=hunter2hunter2 end.'], 5, result);
    return;
  }
  streamChunks(chunksOf('ok: ' + text, 3), 5, result);
}

function handle(msg) {
  if (msg.type === 'user') {
    if (!started) {
      started = true;
      out({ type: 'system', subtype: 'init' });
    }
    const c = msg.message?.content;
    reply(typeof c === 'string' ? c : JSON.stringify(c));
  } else if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
    if (ignoreInterrupt) return;
    stopReply();
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
    result();
  } else if (msg.type === 'control_response' && pendingPerm && msg.response?.request_id === pendingPerm) {
    pendingPerm = null;
    delta('perm: ' + msg.response?.response?.behavior);
    result();
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)); } catch { /* ignore junk */ }
  }
});
process.stdin.on('end', () => {
  if (process.env.FAKE_CLAUDE_GRANDCHILD === '1') return; // stay alive: only a tree kill ends us
  process.exit(0);
});
