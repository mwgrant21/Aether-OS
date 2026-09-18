// Tests trust-workspace.mjs against FIXTURE configs only. It never reads or
// writes the operator's real ~/.claude.json -- every case passes an explicit
// configPath into a temp directory.
//
// Named verify-* rather than *.test.mjs on purpose: vitest globs *.test.* and
// would collect this standalone script, find zero vitest cases in it, and fail
// the suite. Same convention as verify-auditor.mjs.
// Run: node scripts/communication-compat/verify-trust-workspace.mjs
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { trustWorkspace } from './trust-workspace.mjs';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
};

const root = mkdtempSync(join(tmpdir(), 'trust-workspace-test-'));
const WS = 'C:/scratch/workspace-under-test';

function fixture(name, config) {
  const dir = join(root, name);
  const p = join(dir, '.claude.json');
  writeFileSync(join(dir, '.keep'), '', { flag: 'w' });
  return p;
}
function makeConfig(name, obj) {
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  const fs = require('node:fs');
  fs.mkdirSync(dir, { recursive: true });
  const p = join(dir, '.claude.json');
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  return p;
}
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);

// --- 1. adds the flag, leaves everything else alone --------------------------
{
  const p = makeConfig('happy', {
    numStartups: 7,
    projects: { 'C:/other/project': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] } },
    tipsHistory: { a: 1 },
  });
  const before = JSON.parse(readFileSync(p, 'utf8'));
  const r = trustWorkspace(WS, p);
  const after = JSON.parse(readFileSync(p, 'utf8'));
  check('adds the trust flag', r.trusted && after.projects[WS].hasTrustDialogAccepted === true);
  check('reports a backup path', typeof r.backup === 'string' && existsSync(r.backup));
  check('backup matches the original', JSON.stringify(JSON.parse(readFileSync(r.backup, 'utf8'))) === JSON.stringify(before));
  check('other project untouched',
    JSON.stringify(after.projects['C:/other/project']) === JSON.stringify(before.projects['C:/other/project']));
  check('top-level keys untouched',
    after.numStartups === 7 && JSON.stringify(after.tipsHistory) === JSON.stringify(before.tipsHistory));
  check('exactly one project added', Object.keys(after.projects).length === Object.keys(before.projects).length + 1);
}

// --- 2. idempotent: already trusted is a no-op, no backup churn --------------
{
  const p = makeConfig('already', { projects: { [WS]: { hasTrustDialogAccepted: true } } });
  const before = readFileSync(p, 'utf8');
  const r = trustWorkspace(WS, p);
  check('already-trusted is a no-op', r.trusted === true && r.alreadyTrusted === true);
  check('file untouched when already trusted', readFileSync(p, 'utf8') === before);
  check('no stray backup created', readdirSync(dirname(p)).filter(f => f.includes('compat-backup')).length === 0);
}

// --- 3. preserves an existing entry's other fields ---------------------------
{
  const p = makeConfig('existing', {
    projects: { [WS]: { hasTrustDialogAccepted: false, allowedTools: ['Read'], lastCost: 1.5 } },
  });
  const r = trustWorkspace(WS, p);
  const after = JSON.parse(readFileSync(p, 'utf8'));
  check('flips false -> true', r.trusted && after.projects[WS].hasTrustDialogAccepted === true);
  check('keeps the entry\'s other fields',
    JSON.stringify(after.projects[WS].allowedTools) === JSON.stringify(['Read']) && after.projects[WS].lastCost === 1.5);
}

// --- 4. refuses a symlinked config ------------------------------------------
{
  const dir = join(root, 'linked');
  require('node:fs').mkdirSync(dir, { recursive: true });
  const real = join(dir, 'real.json');
  writeFileSync(real, JSON.stringify({ projects: {} }, null, 2));
  const link = join(dir, '.claude.json');
  let made = true;
  try { symlinkSync(real, link, 'file'); } catch { made = false; }
  if (made) {
    const r = trustWorkspace(WS, link);
    check('refuses a symlinked config', r.trusted === false && /symlink/i.test(r.reason));
    check('symlink target untouched', !JSON.parse(readFileSync(real, 'utf8')).projects[WS]);
  } else {
    check('refuses a symlinked config', false, 'SKIPPED - could not create a symlink (needs privilege)');
  }
}

// --- 5. refuses unparseable config, leaves it byte-identical -----------------
{
  const dir = join(root, 'broken');
  require('node:fs').mkdirSync(dir, { recursive: true });
  const p = join(dir, '.claude.json');
  writeFileSync(p, '{ this is not json');
  const r = trustWorkspace(WS, p);
  check('refuses unparseable config', r.trusted === false && /parseable/i.test(r.reason));
  check('unparseable config left as-is', readFileSync(p, 'utf8') === '{ this is not json');
}

// --- 6. missing config is reported, not created ------------------------------
{
  const p = join(root, 'absent', '.claude.json');
  const r = trustWorkspace(WS, p);
  check('missing config reported', r.trusted === false && /no config/i.test(r.reason));
  check('missing config not created', !existsSync(p));
}

rmSync(root, { recursive: true, force: true });
console.log(failed === 0 ? '\nall trust-workspace checks passed (real ~/.claude.json never touched)' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
