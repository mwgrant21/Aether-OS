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

// A recursive delete of a caller-supplied path is how the known-good evidence
// would get destroyed by the very script meant to protect it: point --scratch at
// the reference run (or any ancestor of it) and the wipe lands on the reference.
// So: never delete the supplied path. Treat it as a ROOT, refuse it if it
// overlaps the reference in either direction, and work inside a unique child
// that only this process created.
const referenceAbs = path.resolve(reference);
if (!fs.existsSync(referenceAbs)) { console.error(`reference run not found: ${referenceAbs}`); process.exit(2); }

const scratchRootArg = path.resolve(argOf('scratch', path.join(os.tmpdir(), 'aether-compat-auditor-verify')));
const contains = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
// Resolve against the nearest EXISTING ancestor before creating anything.
// Creating the directory first and checking afterwards still mutates the
// reference when --scratch names a not-yet-existing path inside it, and leaves
// the stray directory behind on rejection.
let probe = scratchRootArg;
while (!fs.existsSync(probe)) {
  const parent = path.dirname(probe);
  if (parent === probe) break;
  probe = parent;
}
const anchorReal = fs.existsSync(probe) ? fs.realpathSync(probe) : probe;
const intendedReal = path.resolve(anchorReal, path.relative(probe, scratchRootArg));
if (contains(intendedReal, referenceAbs) || contains(referenceAbs, intendedReal)
    || contains(anchorReal, referenceAbs) || contains(referenceAbs, anchorReal)) {
  console.error(`refusing unsafe --scratch: ${intendedReal} overlaps the reference run ${referenceAbs}`);
  process.exit(2);
}

fs.mkdirSync(scratchRootArg, { recursive: true });

// path.resolve is LEXICAL only. On Windows a junction (or a symlink anywhere)
// named as --scratch can point straight at the reference run: a textual
// comparison accepts it, mkdtemp then creates the working child INSIDE the
// supposedly read-only reference, and cpSync copies the reference into its own
// descendant. Canonicalize both sides with realpath -- after creating the root,
// so it can be resolved -- and compare those.
const scratchRootReal = fs.realpathSync(scratchRootArg);
const referenceReal = fs.realpathSync(referenceAbs);
if (contains(scratchRootReal, referenceReal) || contains(referenceReal, scratchRootReal)) {
  console.error(`refusing unsafe --scratch: ${scratchRootReal} overlaps the reference run ${referenceReal}`);
  process.exit(2);
}
const scratchRoot = fs.mkdtempSync(path.join(scratchRootReal, 'run-'));

function runAudit(dir, extra = []) {
  try {
    const stdout = execFileSync(process.execPath, [AUDIT, '--run', dir, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
  { name: 'markers-field-removed', property: 'evidence_complete',
    // Valid JSON, unusable content: dereferencing this later threw a stack trace
    // instead of the promised per-property report.
    mutate: dir => {
      const p = path.join(dir, 'expected-result.json');
      const e = JSON.parse(fs.readFileSync(p, 'utf8'));
      delete e.markers;
      fs.writeFileSync(p, JSON.stringify(e, null, 2));
    } },
  { name: 'expected-result-is-empty-object', property: 'evidence_complete',
    mutate: dir => fs.writeFileSync(path.join(dir, 'expected-result.json'), '{}') },
  { name: 'null-event-row', property: 'evidence_complete',
    // Valid JSON, unusable row: server_start is present so the shape check was
    // satisfied, and the null threw only once dereferenced.
    mutate: dir => {
      const p = path.join(dir, 'events.jsonl');
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').trimEnd() + '\nnull\n');
    } },
  { name: 'altered-payload', property: 'payload_integrity',
    mutate: dir => {
      const p = path.join(dir, 'expected-result.json');
      const e = JSON.parse(fs.readFileSync(p, 'utf8'));
      e.result.content[0].text = e.result.content[0].text.replace(/雪/, 'X'); // one character
      fs.writeFileSync(p, JSON.stringify(e, null, 2));
    } },
  { name: 'forged-marker', property: 'evidence_complete',
    // Caught at evidence time now, not at payload comparison: a marker that is
    // not present in the generated payload text means the evidence itself is
    // inconsistent. payload_integrity's own path stays covered by
    // altered-payload, which mutates the text the model actually received.
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
  { name: 'invalid-threshold-refused', expectExit: 2, args: ['--preapproval-max-ms', '250ms'],
    // Number('250ms') is NaN and every `ms > NaN` is false, so a typo would
    // empty the slow list and wave through manually-approved dispatches --
    // silently undoing the threshold. It must refuse instead.
    mutate: () => {} },
  { name: 'infinite-threshold-refused', expectExit: 2, args: ['--preapproval-max-ms', 'Infinity'],
    mutate: () => {} },
  { name: 'manually-approved-prompts', property: 'exact_preapproval',
    // The regression Codex identified: --allowedTools stops preapproving, the
    // operator clicks through three prompts, and every line still carries a
    // numeric permissionDecisionMs. Only the latency gives it away.
    mutate: dir => {
      const p = path.join(dir, 'client-debug.log');
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/permissionDecisionMs=\d+/g, 'permissionDecisionMs=4200'));
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
  const { exit, report } = runAudit(dir, c.args ?? []);
  let ok;
  let note;
  if (c.expectExit !== undefined) {
    ok = exit === c.expectExit;
    note = ok ? `refused with exit ${exit}` : `expected exit ${c.expectExit}, got ${exit}`;
  } else if (c.expectPass) {
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

fs.rmSync(scratchRoot, { recursive: true, force: true }); // only our own mkdtemp child
console.log(`\n${results.length - bad}/${results.length} auditor controls behaved correctly`);
process.exit(bad === 0 ? 0 : 1);
