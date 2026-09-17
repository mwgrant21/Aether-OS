// Audits one compatibility probe run and reports EVERY property separately.
//
// READ-ONLY by default. The 2.1.270 auditor wrote its report into a shared
// outputs/ path, so merely inspecting old evidence would have overwritten it;
// this one writes nothing unless given an explicit --out.
//
//   node audit.mjs --run <dir> [--transcript <path>] [--out <file>] [--json]
//
// Exit code 0 only when every required property passes. A missing, empty,
// truncated or mismatched piece of evidence is a FAILURE, never a skip: the
// point of the harness is that it cannot accidentally report success.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argOf = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};

const runDir = argOf('run');
if (!runDir) { console.error('usage: node audit.mjs --run <dir> [--transcript <path>] [--out <file>]'); process.exit(2); }

const properties = [];
// Declared up here on purpose: emit() reads it, and emit() runs on the early
// evidence-missing exits too. A `const` declared further down would be in the
// temporal dead zone at that point and throw, killing the report instead of
// printing it -- which is precisely how a 'Failed' run would lose its reason.
let usage = null;
const record = (name, ok, detail) => { properties.push({ property: name, verdict: ok ? 'Passed' : 'Failed', detail }); return ok; };
const fail = (name, detail) => record(name, false, detail);

function readMaybe(file) {
  const p = path.join(runDir, file);
  if (!fs.existsSync(p)) return { ok: false, reason: `missing ${file}` };
  const raw = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  if (!raw.trim()) return { ok: false, reason: `empty ${file}` };
  return { ok: true, raw };
}

function parseJson(file) {
  const r = readMaybe(file);
  if (!r.ok) return r;
  try { return { ok: true, value: JSON.parse(r.raw) }; }
  catch (e) { return { ok: false, reason: `unparseable ${file}: ${e.message}` }; }
}

function parseJsonl(file) {
  const r = readMaybe(file);
  if (!r.ok) return r;
  const rows = [];
  for (const [i, line] of r.raw.trim().split(/\r?\n/).entries()) {
    try { rows.push(JSON.parse(line)); }
    catch (e) { return { ok: false, reason: `${file} line ${i + 1} unparseable (truncated run?): ${e.message}` }; }
  }
  return { ok: true, value: rows };
}

// ---------------------------------------------------------------- evidence
const session = parseJson('session.json');
const expected = parseJson('expected-result.json');
const events = parseJsonl('events.jsonl');
const debugRead = readMaybe('client-debug.log');

const missing = [session, expected, events, debugRead].filter(r => !r.ok).map(r => r.reason);
if (missing.length) {
  record('evidence_complete', false, missing.join('; '));
  emit();
  process.exit(1);
}
record('evidence_complete', true, 'session.json, expected-result.json, events.jsonl, client-debug.log all present and parseable');

const S = session.value, E = expected.value, EV = events.value;
const debug = debugRead.raw.split(/\r?\n/);

// The transcript is the only evidence the client itself writes. Derive it the
// same way Claude Code encodes a project directory, unless told otherwise.
const transcriptPath = argOf('transcript',
  S.transcript_hint ?? path.join(os.homedir(), '.claude', 'projects',
    String(S.cwd).replace(/\\/g, '/').replace(/[^A-Za-z0-9]/g, '-'), `${S.session_id}.jsonl`));

let rows;
if (!fs.existsSync(transcriptPath)) {
  fail('transcript_present', `no transcript at ${transcriptPath}`);
  emit(); process.exit(1);
}
try {
  rows = fs.readFileSync(transcriptPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
} catch (e) {
  fail('transcript_present', `transcript unparseable (truncated?): ${e.message}`);
  emit(); process.exit(1);
}
record('transcript_present', true, `${rows.length} rows at ${transcriptPath}`);

const blocks = rows.flatMap((row, index) => Array.isArray(row.message?.content)
  ? row.message.content.map(b => ({ ...b, row: index, messageId: row.message.id })) : []);
const calls = blocks.filter(b => b.type === 'tool_use');
const results = blocks.filter(b => b.type === 'tool_result');
const NAMES = ['ask_codex', 'get_codex_exchange', 'cancel_codex_exchange'].map(n => 'mcp__aether-bridge__' + n);

// ------------------------------------------------- P1 direct presentation
// The 2.1.270 auditor asserted the literal string "0/386 deferred tools
// included". That count is a property of that day's tool roster, not an
// invariant -- it would fail on any machine with a different plugin set while
// telling us nothing about the bridge. What actually matters is that the model
// reached the three bridge tools DIRECTLY: called them, in order, with no
// tool-search indirection and nothing else called.
{
  const called = calls.map(c => c.name);
  const order = JSON.stringify(called) === JSON.stringify(NAMES);
  const searchCalls = called.filter(n => /toolsearch|tool_search/i.test(n));
  const foreign = called.filter(n => !NAMES.includes(n));
  const loadingLines = debug.filter(l => /Dynamic tool loading:/.test(l));
  record('direct_tool_presentation', order && searchCalls.length === 0 && foreign.length === 0, {
    called_in_order: order,
    tool_search_calls: searchCalls.length,
    non_bridge_calls: foreign,
    // Reported as evidence, never asserted against a fixed number.
    dynamic_tool_loading: loadingLines.map(l => l.trim().slice(-120)),
  });
}

// --------------------------------------------------- P2 exact preapproval
{
  const dispatch = debug.filter(l => /tool_dispatch_start .*tool=mcp__aether-bridge/.test(l));
  const timed = dispatch.filter(l => /permissionDecisionMs=\d+/.test(l));
  const modes = [...new Set(rows.map(r => r.permissionMode).filter(Boolean))];
  record('exact_preapproval', dispatch.length === 3 && timed.length === 3, {
    bridge_dispatches: dispatch.length,
    with_permission_decision: timed.length,
    requested_permission_mode: S.requested_permission_mode ?? S.permission_mode ?? null,
    effective_permission_modes_in_transcript: modes,
    // Fast decisions are consistent with preapproval but do not by themselves
    // prove unrelated tools stayed unapproved. Stated, not inferred away.
    caveat: 'Timing evidence only; this run does not test negative permission boundaries.',
  });
}

// ---------------------------------------------------- P3 quiet inline get
{
  const starts = EV.filter(e => e.event === 'call_start').map(e => e.name);
  const serverStart = EV.find(e => e.event === 'server_start') ?? {};
  const expectedWait = Number(serverStart.quiet_wait_ms ?? 60_000);
  const mcpTimeout = Number(serverStart.mcp_timeout_ms ?? S.mcp_timeout_ms ?? 90_000);
  const wait = EV.find(e => e.event === 'call_end' && e.name === 'get_codex_exchange');
  const get = calls[1];
  const getResult = get ? results.find(b => b.tool_use_id === get.id) : undefined;
  const intervening = get && getResult
    ? rows.slice(get.row + 1, getResult.row).filter(r => r.type === 'assistant' && r.message?.id !== get.messageId).length
    : -1;
  const orderOk = JSON.stringify(starts) === JSON.stringify(['ask_codex', 'get_codex_exchange', 'cancel_codex_exchange']);
  const waitOk = !!wait && !wait.aborted && wait.elapsed_ms >= expectedWait && wait.elapsed_ms < mcpTimeout;
  record('quiet_inline_get', orderOk && waitOk && intervening === 0, {
    server_call_order: starts,
    // Measured on the server, never read from the payload's nominal field.
    measured_wait_ms: wait?.elapsed_ms ?? null,
    required_at_least_ms: expectedWait,
    must_stay_under_mcp_timeout_ms: mcpTimeout,
    aborted: wait?.aborted ?? null,
    intervening_model_responses: intervening,
    background_ms: serverStart.background_ms ?? null,
  });
}

// ------------------------------------------------- P4 payload integrity
{
  const get = calls[1];
  const getResult = get ? results.find(b => b.tool_use_id === get.id) : undefined;
  const received = getResult
    ? (typeof getResult.content === 'string' ? getResult.content : (getResult.content ?? []).map(c => c.text ?? '').join(''))
    : null;
  const exactMatch = received !== null && received === E.result.content[0].text;
  const limit = Number(E.envelope_limit_bytes ?? 32_768);
  const withinEnvelope = E.serialized_bytes <= limit;
  const finalText = blocks.filter(b => b.type === 'text' && rows[b.row].type === 'assistant').at(-1)?.text ?? '';
  const markersReported = E.markers.filter(m => finalText.includes(m));
  const cleanup = /(?:U0|COMPAT)-CLEANUP-OK/.test(finalText);
  record('payload_integrity',
    exactMatch && withinEnvelope && !getResult?.is_error && markersReported.length === E.markers.length && cleanup, {
      exact_text_match: exactMatch,
      result_is_error: getResult?.is_error ?? null,
      serialized_bytes: E.serialized_bytes,
      envelope_limit_bytes: limit,
      text_chars: E.text_chars,
      markers_reported: `${markersReported.length}/${E.markers.length}`,
      cleanup_receipt_in_final_answer: cleanup,
    });
}

// ------------------------------------------------------------ environment
{
  const s = EV.find(e => e.event === 'server_start') ?? {};
  record('provider_isolation', s.api_key_present === false && s.auth_token_present === false, {
    api_key_present: s.api_key_present ?? null,
    auth_token_present: s.auth_token_present ?? null,
    note: 'The synthetic server never launches Codex, so this run proves nothing about real provider cleanup.',
  });
}

// ------------------------------------------------------------------ usage
usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
const seen = new Set();
for (const row of rows) {
  const m = row.message;
  if (!m?.usage || seen.has(m.id)) continue;
  seen.add(m.id);
  for (const k of Object.keys(usage)) usage[k] += m.usage[k] ?? 0;
}

function emit() {
  const failed = properties.filter(p => p.verdict === 'Failed');
  const report = {
    verdict: failed.length === 0 ? 'Passed' : 'Failed',
    failed_properties: failed.map(p => p.property),
    run_dir: runDir,
    // Read through the parse result, not the `S` alias: emit() also runs on the
    // early evidence-missing exits, where `S` is still in its temporal dead zone.
    session_id: (session.ok ? session.value?.session_id : null) ?? null,
    client_version: (session.ok ? session.value?.version : null) ?? null,
    properties,
    usage: usage ?? undefined,
  };
  const out = argOf('out');
  if (out) {
    if (fs.existsSync(out)) { console.error(`refusing to overwrite existing report: ${out}`); process.exit(2); }
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}

const report = emit();
process.exit(report.verdict === 'Passed' ? 0 : 1);
