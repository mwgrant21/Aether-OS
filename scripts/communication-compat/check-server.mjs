// Protocol smoke test for the synthetic bridge server. NO model session.
//
// Connects as an MCP client over stdio, lists tools, and drives the three
// tools. This proves the server handshakes, presents the three bridge tool
// names, and resolves exchanges the way production does; it proves NOTHING
// about how the Claude client presents or preapproves them, which is what the
// interactive probe is for.
//
// The server enforces a 3-call budget per process, so each session below gets
// its own server and its own run directory.
//
//   node check-server.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED = ['ask_codex', 'get_codex_exchange', 'cancel_codex_exchange'];
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
};
const bodyOf = (res) => JSON.parse(res.content[0].text);

async function withServer(label, fn) {
  const runDir = mkdtempSync(join(tmpdir(), 'aether-compat-smoke-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(HERE, 'fake-bridge-server.mjs')],
    // Short wait: this smoke test must not sit through the real 60s quiet get.
    env: { ...process.env, AETHER_COMPAT_RUN_DIR: runDir, AETHER_COMPAT_QUIET_WAIT_MS: '50' },
  });
  const client = new Client({ name: 'compat-smoke', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    await fn(client, runDir);
  } catch (e) {
    check(`${label}: protocol exchange`, false, e.message);
  } finally {
    try { await client.close(); } catch { /* transport already gone */ }
    rmSync(runDir, { recursive: true, force: true });
  }
}

// --- 1. handshake, tool roster, exchange_id lookup, payload, evidence -------
await withServer('session 1', async (client, runDir) => {
  check('handshake', true);

  const { tools } = await client.listTools();
  const names = tools.map(t => t.name).sort();
  check('tool names', JSON.stringify(names) === JSON.stringify([...EXPECTED].sort()), names.join(', '));
  check('no extra tools exposed', tools.length === 3, `${tools.length} tools`);

  const ask = await client.callTool({ name: 'ask_codex', arguments: { request_key: 'smoke', question: 'q' } });
  const body = bodyOf(ask);
  check('ask_codex accepted', body.state === 'accepted' && typeof body.exchange_id === 'string');

  const get = await client.callTool({ name: 'get_codex_exchange', arguments: { exchange_id: body.exchange_id } });
  const page = bodyOf(get);
  check('get by exchange_id returns a finished page', page.state === 'finished' && typeof page.page_text === 'string');
  check('payload within envelope',
    Buffer.byteLength(JSON.stringify(get), 'utf8') <= 32768,
    `${Buffer.byteLength(JSON.stringify(get), 'utf8')} bytes`);

  const wrong = await client.callTool({ name: 'get_codex_exchange', arguments: { exchange_id: 'not-the-id' } });
  check('unknown exchange_id rejected', wrong.isError === true && bodyOf(wrong).code === 'UNKNOWN_EXCHANGE');

  check('expected-result.json written', existsSync(join(runDir, 'expected-result.json')));
  const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  check('server logged its start and calls',
    events.some(e => e.event === 'server_start') && events.filter(e => e.event === 'call_start').length >= 3);
});

// --- 2. request_key is a valid lookup form, as the served schemas advertise --
await withServer('session 2', async (client) => {
  // bridge-tools.json (production's metadata, verbatim) declares request_key as
  // an alternative to exchange_id on both get and cancel, and production's own
  // server instructions tell the model to "consult once with a stable
  // request_key, then retrieve". A server that advertises that form and then
  // answers UNKNOWN_EXCHANGE fails a compatible client for doing what it was told.
  const ask = await client.callTool({ name: 'ask_codex', arguments: { request_key: 'smoke-key', question: 'q' } });
  check('ask_codex accepted (request_key session)', bodyOf(ask).state === 'accepted');

  const get = await client.callTool({ name: 'get_codex_exchange', arguments: { request_key: 'smoke-key' } });
  check('get by request_key returns the finished page',
    get.isError !== true && bodyOf(get).state === 'finished', get.isError ? bodyOf(get).code : '');

  const cancel = await client.callTool({ name: 'cancel_codex_exchange', arguments: { request_key: 'smoke-key' } });
  check('cancel by request_key is honoured',
    cancel.isError !== true && typeof bodyOf(cancel).cleanup_receipt === 'string', cancel.isError ? bodyOf(cancel).code : '');
});

// --- 3. exactly one lookup key, the way production's lookup() enforces it ----
await withServer('session 3', async (client) => {
  const ask = await client.callTool({ name: 'ask_codex', arguments: { request_key: 'smoke-key', question: 'q' } });
  const { exchange_id } = bodyOf(ask);

  const both = await client.callTool({ name: 'get_codex_exchange', arguments: { exchange_id, request_key: 'smoke-key' } });
  check('both lookup keys at once is INVALID_INPUT',
    both.isError === true && bodyOf(both).code === 'INVALID_INPUT', both.isError ? bodyOf(both).code : 'accepted');

  const wrongKey = await client.callTool({ name: 'get_codex_exchange', arguments: { request_key: 'not-the-key' } });
  check('unknown request_key rejected', wrongKey.isError === true && bodyOf(wrongKey).code === 'UNKNOWN_EXCHANGE');
});

console.log(failed === 0 ? '\nserver protocol OK (no model session was started)' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
