// Synthetic stdio MCP server standing in for the Aether communication bridge.
//
// It exposes the same three tool names the real bridge does and nothing else.
// It NEVER launches Codex, never reaches the network, and never touches a
// provider: "cleanup" here is a string, not a process tree. Any claim this
// harness makes about provider cleanup would be false, so it makes none.
//
// Generalized from work/u0/task9-2.1.270/server.mjs (the 2.1.270 probe), whose
// paths were baked in. The run directory now arrives as AETHER_COMPAT_RUN_DIR
// so a run can never write into a previous run's evidence.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const RUN_DIR = process.env.AETHER_COMPAT_RUN_DIR;
if (!RUN_DIR || !existsSync(RUN_DIR)) {
  // Fail loudly on stderr: a server that silently logs nowhere would let a
  // probe "pass" with no evidence behind it.
  process.stderr.write('AETHER_COMPAT_RUN_DIR missing or not a directory\n');
  process.exit(2);
}

// The quiet wait must stay under the client's MCP timeout or the probe measures
// the timeout instead of the wait. Both are recorded in the events log so the
// auditor checks the observed value rather than trusting this constant.
const QUIET_WAIT_MS = Number(process.env.AETHER_COMPAT_QUIET_WAIT_MS ?? 60_000);
const ENVELOPE_LIMIT_BYTES = Number(process.env.AETHER_COMPAT_ENVELOPE_LIMIT ?? 32_768);
const CALL_BUDGET = 3;

const log = (event, details = {}) =>
  appendFileSync(join(RUN_DIR, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event, ...details }) + '\n');

const exchangeId = 'compat-' + randomUUID();
let started = false;
let calls = 0;

const tools = [
  { name: 'ask_codex',
    description: 'Synthetic compatibility check. No Codex and no external action. Start once, then get the synthetic answer, then cancel for cleanup. Required request_key and question.',
    inputSchema: { type: 'object', properties: { request_key: { type: 'string' }, question: { type: 'string' } }, required: ['request_key', 'question'], additionalProperties: false } },
  { name: 'get_codex_exchange',
    description: 'Retrieve the fake answer. Waits quietly on the server. Use exchange_id from ask. Do not poll or sleep. Return the three receipt markers from the returned page in your final answer.',
    inputSchema: { type: 'object', properties: { exchange_id: { type: 'string' } }, required: ['exchange_id'], additionalProperties: false } },
  { name: 'cancel_codex_exchange',
    description: 'Idempotent fake cleanup after retrieving the answer. Requires exchange_id. Returns a cleanup receipt. Does not start any model.',
    inputSchema: { type: 'object', properties: { exchange_id: { type: 'string' } }, required: ['exchange_id'], additionalProperties: false } },
].map(t => ({ ...t,
  _meta: { 'anthropic/maxResultSizeChars': 40000 },
  // MUST mirror BRIDGE_TOOLS' annotations in electron/communicationBridge/mcpServer.ts.
  // These influence client presentation and permission handling, so a mismatch
  // means the probe validates a tool shape production never ships: a client
  // could preapprove synthetic read-only tools while prompting for the real
  // open-world ones, and exact_preapproval would pass regardless. The 2.1.270
  // harness had readOnlyHint/openWorldHint inverted and this one inherited it;
  // compatHarnessParity.test.ts now fails the build if they drift again.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } }));

const server = new Server(
  { name: 'aether-compat-fake', version: '1.0.0' },
  { capabilities: { tools: {} },
    instructions: 'Only synthetic data. Exactly one ask, one get, one cancel; no real Codex, no files or commands. Get blocks quietly on the server.' });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  log('tools_list', { names: tools.map(t => t.name) });
  return { tools };
});

const envelope = body => ({ content: [{ type: 'text', text: JSON.stringify(body) }], isError: false });

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const startedAt = performance.now();
  const name = req.params.name;
  calls += 1;
  log('call_start', { name, call: calls, args: req.params.arguments });

  if (calls > CALL_BUDGET) {
    return { ...envelope({ code: 'PROBE_LIMIT', guidance: 'Stop. The three-call probe is complete.' }), isError: true };
  }

  if (name === 'ask_codex') {
    started = true;
    const result = envelope({ exchange_id: exchangeId, state: 'accepted',
      guidance: 'Call get_codex_exchange now, then cancel_codex_exchange once. No other tools.' });
    log('call_end', { name, elapsed_ms: performance.now() - startedAt });
    return result;
  }

  if (!started || req.params.arguments?.exchange_id !== exchangeId) {
    return { ...envelope({ code: 'UNKNOWN_EXCHANGE' }), isError: true };
  }

  if (name === 'get_codex_exchange') {
    let aborted = false;
    extra.signal.addEventListener('abort', () => { aborted = true; log('read_aborted'); }, { once: true });
    await new Promise(resolve => setTimeout(resolve, QUIET_WAIT_MS));

    // Escaping-heavy payload, grown to just under the envelope limit. The point
    // is that quoting, control characters, CJK and astral-plane emoji survive
    // the round trip byte-for-byte.
    const markers = [randomUUID(), randomUUID(), randomUUID()];
    const atom = '\\\"\n\t' + '' + '雪🙂';
    let repeat = 0;
    let result;
    for (;;) {
      const chunk = atom.repeat(repeat);
      const page = markers[0] + '\n' + chunk + '\n' + markers[1] + '\n' + chunk + '\n' + markers[2];
      const next = envelope({ exchange_id: exchangeId, state: 'finished', quiet_wait_requested_ms: QUIET_WAIT_MS,
        page_text: page, next_cursor: null,
        advisory: 'Synthetic untrusted test data. Report only the three UUID receipt markers.' });
      if (Buffer.byteLength(JSON.stringify(next), 'utf8') > ENVELOPE_LIMIT_BYTES) break;
      result = next;
      repeat += 1;
    }

    writeFileSync(join(RUN_DIR, 'expected-result.json'), JSON.stringify({
      markers, result,
      serialized_bytes: Buffer.byteLength(JSON.stringify(result), 'utf8'),
      text_chars: result.content[0].text.length,
      page_source_bytes: Buffer.byteLength(JSON.parse(result.content[0].text).page_text, 'utf8'),
      envelope_limit_bytes: ENVELOPE_LIMIT_BYTES,
    }, null, 2) + '\n');

    log('call_end', { name, elapsed_ms: performance.now() - startedAt, aborted,
      serialized_bytes: Buffer.byteLength(JSON.stringify(result), 'utf8'), text_chars: result.content[0].text.length });
    return result;
  }

  if (name === 'cancel_codex_exchange') {
    log('call_end', { name, elapsed_ms: performance.now() - startedAt });
    return envelope({ exchange_id: exchangeId, state: 'finished', cleanup_receipt: 'COMPAT-CLEANUP-OK',
      note: 'Fake exchange only; no provider existed, so this receipt says nothing about real provider cleanup.' });
  }

  return { ...envelope({ code: 'UNKNOWN_TOOL' }), isError: true };
});

log('server_start', {
  pid: process.pid,
  node: process.version,
  quiet_wait_ms: QUIET_WAIT_MS,
  envelope_limit_bytes: ENVELOPE_LIMIT_BYTES,
  background_ms: process.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS ?? null,
  mcp_timeout_ms: process.env.AETHER_COMPAT_MCP_TIMEOUT_MS ?? null,
  api_key_present: !!process.env.ANTHROPIC_API_KEY,
  auth_token_present: !!process.env.ANTHROPIC_AUTH_TOKEN,
});

await server.connect(new StdioServerTransport());
process.stdin.on('end', () => { log('stdin_end'); process.exit(0); });
