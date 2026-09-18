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

// --- 7. a filesystem failure becomes a reason, never a throw ----------------
{
  // configPath exists and is not a symlink, but is a DIRECTORY: readFileSync
  // throws EISDIR. Before the fix this propagated out of trustWorkspace and
  // aborted prepare-run after the run directory was already built, skipping the
  // documented "warn and let the operator use the trust screen" fallback.
  const dir = join(root, 'isdir');
  require('node:fs').mkdirSync(join(dir, '.claude.json'), { recursive: true });
  let threw = false;
  let r;
  try { r = trustWorkspace(WS, join(dir, '.claude.json')); } catch { threw = true; }
  check('filesystem error returns a reason instead of throwing', !threw && r?.trusted === false, threw ? 'threw' : r?.reason ?? '');
  check('no stray temp file left behind',
    readdirSync(dir).filter(f => f.includes('compat-tmp')).length === 0);
}

// --- 8. a concurrent write is not clobbered ---------------------------------
{
  // Simulates another Claude process rewriting the config after our read but
  // before we publish. Without the guard, our stale serialization wins and the
  // function still reports success.
  const p = makeConfig('concurrent', { numStartups: 1, projects: {} });
  let fired = 0;
  const r = trustWorkspace(WS, p, {
    beforePublish: (cfg) => {
      if (fired++) return;                      // only the first attempt races
      const other = JSON.parse(readFileSync(cfg, 'utf8'));
      other.numStartups = 99;                   // the concurrent update
      other.projects['C:/other/added-by-someone-else'] = { hasTrustDialogAccepted: true };
      writeFileSync(cfg, JSON.stringify(other, null, 2) + '\n');
    },
  });
  const after = JSON.parse(readFileSync(p, 'utf8'));
  check('concurrent write survives', after.numStartups === 99, `numStartups=${after.numStartups}`);
  check('the other project entry survives',
    !!after.projects['C:/other/added-by-someone-else']);
  // The retry rebuilds on the newer contents, so the trust flag should also land.
  check('our change still applied after retry', r.trusted === true && after.projects[WS]?.hasTrustDialogAccepted === true,
    r.trusted ? '' : r.reason ?? '');
  check('no stray temp file after the race',
    readdirSync(dirname(p)).filter(f => f.includes('compat-tmp')).length === 0);
}

// --- 9. a write landing AFTER the rename is not restored over ---------------
{
  // beforePublish cannot reach this window: it fires before the pre-rename
  // check. This races the interval between publishing and reading back, where
  // the old code would copy the backup over the newer config.
  const p = makeConfig('post-rename', { numStartups: 1, projects: {} });
  const r = trustWorkspace(WS, p, {
    afterPublish: (cfg) => {
      const o = JSON.parse(readFileSync(cfg, 'utf8'));
      o.numStartups = 555;
      o.projects['C:/other/written-after-rename'] = { hasTrustDialogAccepted: true };
      writeFileSync(cfg, JSON.stringify(o, null, 2) + '\n');
    },
  });
  const after = JSON.parse(readFileSync(p, 'utf8'));
  check('post-rename write is not restored over', after.numStartups === 555,
    'numStartups=' + after.numStartups);
  check('project entry written after rename survives',
    !!after.projects['C:/other/written-after-rename']);
  check('reports failure rather than false success', r.trusted === false,
    (r.reason || '').slice(0, 70));
  check('reason names the concurrent change',
    /changed by another process after publishing/.test(r.reason || ''), r.reason || '');
}

rmSync(root, { recursive: true, force: true });
console.log(failed === 0 ? '\nall trust-workspace checks passed (real ~/.claude.json never touched)' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
