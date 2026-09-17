// Protocol smoke test for the synthetic bridge server. NO model session.
//
// Connects as an MCP client over stdio, lists tools, and calls ask_codex.
// This proves the server handshakes and presents the three bridge tool names;
// it proves NOTHING about how the Claude client presents or preapproves them,
// which is what the interactive probe is for.
//
//   node check-server.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const runDir = mkdtempSync(join(tmpdir(), 'aether-compat-smoke-'));
const EXPECTED = ['ask_codex', 'get_codex_exchange', 'cancel_codex_exchange'];
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(HERE, 'fake-bridge-server.mjs')],
  // Short wait: this smoke test must not sit through the real 60s quiet get.
  env: { ...process.env, AETHER_COMPAT_RUN_DIR: runDir, AETHER_COMPAT_QUIET_WAIT_MS: '50' },
});
const client = new Client({ name: 'compat-smoke', version: '1.0.0' }, { capabilities: {} });

try {
  await client.connect(transport);
  check('handshake', true);

  const { tools } = await client.listTools();
  const names = tools.map(t => t.name).sort();
  check('tool names', JSON.stringify(names) === JSON.stringify([...EXPECTED].sort()), names.join(', '));
  check('no extra tools exposed', tools.length === 3, `${tools.length} tools`);

  const ask = await client.callTool({ name: 'ask_codex', arguments: { request_key: 'smoke', question: 'q' } });
  const body = JSON.parse(ask.content[0].text);
  check('ask_codex accepted', body.state === 'accepted' && typeof body.exchange_id === 'string');

  const get = await client.callTool({ name: 'get_codex_exchange', arguments: { exchange_id: body.exchange_id } });
  const page = JSON.parse(get.content[0].text);
  check('get returns a finished page', page.state === 'finished' && typeof page.page_text === 'string');
  check('payload within envelope',
    Buffer.byteLength(JSON.stringify(get), 'utf8') <= 32768,
    `${Buffer.byteLength(JSON.stringify(get), 'utf8')} bytes`);

  const wrong = await client.callTool({ name: 'get_codex_exchange', arguments: { exchange_id: 'not-the-id' } });
  check('unknown exchange rejected', wrong.isError === true);

  check('expected-result.json written', existsSync(join(runDir, 'expected-result.json')));
  const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  check('server logged its start and calls',
    events.some(e => e.event === 'server_start') && events.filter(e => e.event === 'call_start').length >= 3);
} catch (e) {
  check('protocol exchange', false, e.message);
} finally {
  try { await client.close(); } catch { /* transport already gone */ }
  rmSync(runDir, { recursive: true, force: true });
}

console.log(failed === 0 ? '\nserver protocol OK (no model session was started)' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
