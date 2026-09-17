// Negative control for audit.mjs.
//
// An auditor that only ever says "Passed" is worse than no auditor, because it
// launders a missing check into a verdict. This copies a known-good run into a
// scratch directory, damages it in one specific way at a time, and asserts the
// auditor FAILS each time -- and fails on the right property.
//
//   node verify-auditor.mjs --reference <dir> [--scratch <dir>]
//
// The reference run is only ever READ. Every mutation happens on a copy.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.join(HERE, 'audit.mjs');

const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const reference = argOf('reference');
if (!reference) { console.error('usage: node verify-auditor.mjs --reference <known-good run dir>'); process.exit(2); }

const scratchRoot = argOf('scratch', path.join(os.tmpdir(), 'aether-compat-auditor-verify'));
fs.rmSync(scratchRoot, { recursive: true, force: true });
fs.mkdirSync(scratchRoot, { recursive: true });

function runAudit(dir) {
  try {
    const stdout = execFileSync(process.execPath, [AUDIT, '--run', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { exit: 0, report: JSON.parse(stdout) };
  } catch (e) {
    let report = null;
    try { report = JSON.parse(e.stdout ?? ''); } catch { /* evidence so broken there is no report */ }
    return { exit: e.status ?? 1, report, stderr: (e.stderr ?? '').trim() };
  }
}

function freshCopy(name) {
  const dest = path.join(scratchRoot, name);
  fs.cpSync(reference, dest, { recursive: true });
  return dest;
}

const cases = [
  { name: 'baseline-unmodified', expectPass: true, mutate: () => {} },
  { name: 'missing-events', property: 'evidence_complete',
    mutate: dir => fs.rmSync(path.join(dir, 'events.jsonl')) },
  { name: 'empty-expected-result', property: 'evidence_complete',
    mutate: dir => fs.writeFileSync(path.join(dir, 'expected-result.json'), '') },
  { name: 'truncated-events', property: 'evidence_complete',
    mutate: dir => {
      const p = path.join(dir, 'events.jsonl');
      const raw = fs.readFileSync(p, 'utf8');
      fs.writeFileSync(p, raw.slice(0, Math.floor(raw.length * 0.6))); // cut mid-line
    } },
  { name: 'altered-payload', property: 'payload_integrity',
    mutate: dir => {
      const p = path.join(dir, 'expected-result.json');
      const e = JSON.parse(fs.readFileSync(p, 'utf8'));
      e.result.content[0].text = e.result.content[0].text.replace(/雪/, 'X'); // one character
      fs.writeFileSync(p, JSON.stringify(e, null, 2));
    } },
  { name: 'forged-marker', property: 'payload_integrity',
    mutate: dir => {
      const p = path.join(dir, 'expected-result.json');
      const e = JSON.parse(fs.readFileSync(p, 'utf8'));
      e.markers[0] = '00000000-0000-4000-8000-000000000000'; // never reported by the model
      fs.writeFileSync(p, JSON.stringify(e, null, 2));
    } },
  { name: 'aborted-wait', property: 'quiet_inline_get',
    mutate: dir => {
      const p = path.join(dir, 'events.jsonl');
      const rows = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
      for (const r of rows) if (r.event === 'call_end' && r.name === 'get_codex_exchange') r.aborted = true;
      fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    } },
  { name: 'short-wait', property: 'quiet_inline_get',
    mutate: dir => {
      const p = path.join(dir, 'events.jsonl');
      const rows = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
      for (const r of rows) if (r.event === 'call_end' && r.name === 'get_codex_exchange') r.elapsed_ms = 1234;
      fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    } },
  { name: 'leaked-api-key', property: 'provider_isolation',
    mutate: dir => {
      const p = path.join(dir, 'events.jsonl');
      const rows = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
      for (const r of rows) if (r.event === 'server_start') r.api_key_present = true;
      fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    } },
  { name: 'missing-permission-evidence', property: 'exact_preapproval',
    mutate: dir => {
      const p = path.join(dir, 'client-debug.log');
      const kept = fs.readFileSync(p, 'utf8').split(/\r?\n/)
        .filter(l => !/tool_dispatch_start .*tool=mcp__aether-bridge/.test(l));
      fs.writeFileSync(p, kept.join('\n'));
    } },
];

let bad = 0;
const results = [];
for (const c of cases) {
  const dir = freshCopy(c.name);
  c.mutate(dir);
  const { exit, report } = runAudit(dir);
  let ok;
  let note;
  if (c.expectPass) {
    ok = exit === 0 && report?.verdict === 'Passed';
    note = ok ? 'passes unmodified' : `expected Passed, got ${report?.verdict ?? 'no report'}`;
  } else {
    const failed = report?.failed_properties ?? [];
    ok = exit !== 0 && failed.includes(c.property);
    note = ok ? `failed on ${c.property}` : `expected failure on ${c.property}, got exit=${exit} failed=${JSON.stringify(failed)}`;
  }
  if (!ok) bad += 1;
  results.push({ case: c.name, ok, note });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(30)} ${note}`);
}

fs.rmSync(scratchRoot, { recursive: true, force: true });
console.log(`\n${results.length - bad}/${results.length} auditor controls behaved correctly`);
process.exit(bad === 0 ? 0 : 1);
