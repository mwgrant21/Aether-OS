// Golden-file parity harness: runs the Node collector and the Go collector
// against byte-identical fixture inputs and diffs the two resulting SQLite
// databases row-for-row.
//
// Usage (from collector-go/):
//   node scripts/parity/run-parity.mjs [--keep]
//
// Requirements:
//   * Node >= 22.5 (node:sqlite) -- used both to run the Node collector and to
//     read BOTH databases for the diff, so the comparison itself never depends
//     on the Go side being correct.
//   * The Node collector built: `npm run build` in collector/.
//   * `go` on PATH (builds the Go collector and the stub `claude` binary).
//
// Determinism strategy
// --------------------
//   1. Each collector gets its OWN copy of the fixture, generated from the same
//      generator with the same base timestamp. This matters because the spool
//      tailer DELETES spool files after consuming them -- a shared fixture would
//      leave the second collector nothing to ingest.
//   2. A stub `claude.exe` that prints a fixed JSON array is prepended to PATH,
//      so `claude agents --json` returns identical bytes to both collectors
//      instead of whatever the real fleet happens to look like this second.
//      Without it the fleet path is untestable AND both sides would write
//      drift_log rows whose `detail` contains runtime-specific spawn error text.
//   3. %USERPROFILE% is pointed at the fixture root. Node's os.homedir() and
//      Go's os.UserHomeDir() both read it on Windows, so both binaries run
//      their real, unmodified entrypoint path resolution -- no test-only flags.
//
// Excluded columns (see EXCLUDED below): autoincrement `id` columns, and
// columns whose value is Date.now()/time.Now() at ingest. Every other column of
// every table is compared. Row order is normalized away (rows are sorted by
// their retained-column tuple) because insertion order is only observable
// through the excluded `id` columns.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { buildFixture, FLEET_JSON } from './fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const collectorGoDir = resolve(here, '..', '..');
const repoRoot = resolve(collectorGoDir, '..');

// The Node collector's build output. Overridable because this repo is normally
// developed in a git worktree that has collector/src but no node_modules; in
// that case point this at the main checkout's collector/.
const nodeCollectorDir = process.env.AETHER_NODE_COLLECTOR_DIR
  ? resolve(process.env.AETHER_NODE_COLLECTOR_DIR)
  : join(repoRoot, 'collector');

const RUN_MS = Number(process.env.AETHER_PARITY_RUN_MS ?? 6000);
const KEEP = process.argv.includes('--keep');

// ---------------------------------------------------------------------------
// What gets excluded from the diff, and why. Anything not listed here IS
// compared. Keep this list minimal -- every entry is a place a real divergence
// could hide.
// ---------------------------------------------------------------------------
const EXCLUDED = {
  // id: INTEGER PRIMARY KEY AUTOINCREMENT.
  // occurred_at_ms: set to Date.now()/time.Now() at the tail tick that consumed
  //   the spool line (hookPayload.ts:47 occurredAtMs: receivedAtMs), NOT from
  //   the payload -- so it is wall-clock by construction.
  events: ['id', 'occurred_at_ms'],
  // id: autoincrement. detected_at_ms: the nowMs of the tick that detected it.
  drift_log: ['id', 'detected_at_ms'],
  // id only. occurred_at_ms here comes from the TRANSCRIPT's own timestamp
  // field (usageIngest.ts:13 event.timestamp.getTime()), so it is fixture data
  // and IS compared.
  usage_events: ['id'],
  // last_scanned_ms: the scan tick's nowMs. file_path and last_offset are
  // compared -- last_offset is the byte-offset arithmetic this port had to
  // reproduce exactly, including the trailing-partial-line case.
  transcript_files: ['last_scanned_ms'],
  // last_seen_ms: the poll tick's nowMs (fleetPoll.ts:94). started_at_ms comes
  // from the stub's JSON and IS compared.
  fleet_sessions: ['last_seen_ms'],
  // id only. started_at_ms/closed_at_ms come from transcript timestamps.
  tool_calls: ['id'],
  // Nothing excluded: every column is derived from transcript content.
  dispatches: [],
  // id: autoincrement. detected_at_ms: the scan tick's nowMs.
  anomalies: ['id', 'detected_at_ms'],
  daily_rollups: [],
  daily_anomaly_rollups: [],
  // schema_meta is handled specially below: the 'version' row is compared,
  // the two heartbeat rows are wall-clock and only their PRESENCE is checked.
  schema_meta: [],
};

const WALL_CLOCK_META_KEYS = new Set(['fleet_last_poll_ms', 'transcript_last_scan_ms']);

const TABLES = Object.keys(EXCLUDED);

// ---------------------------------------------------------------------------

function log(...args) {
  console.log(...args);
}

function buildStubClaude(binDir) {
  mkdirSync(binDir, { recursive: true });
  const srcDir = mkdtempSync(join(tmpdir(), 'aether-stub-claude-'));
  writeFileSync(
    join(srcDir, 'go.mod'),
    'module aetherstubclaude\n\ngo 1.26\n',
    'utf8'
  );
  writeFileSync(
    join(srcDir, 'main.go'),
    'package main\n\nimport "fmt"\n\nconst payload = `' + FLEET_JSON + '`\n\nfunc main() { fmt.Print(payload) }\n',
    'utf8'
  );
  const out = join(binDir, 'claude.exe');
  execFileSync('go', ['build', '-o', out, '.'], { cwd: srcDir, stdio: 'inherit' });
  rmSync(srcDir, { recursive: true, force: true });
  return out;
}

function runFor(label, cmd, args, env, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill();
    }, RUN_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectRun(new Error(`${label} failed to spawn: ${err.message}`));
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (!killed && code !== 0 && code !== null) {
        rejectRun(new Error(`${label} exited early with code ${code}\n${out}`));
        return;
      }
      log(`  ${label}: ran ${RUN_MS}ms, exit=${code} signal=${signal}`);
      if (out.trim()) log(out.trim().split('\n').map((l) => `    | ${l}`).join('\n'));
      resolveRun();
    });
  });
}

function dumpDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  const dump = { tables: {}, schema: {} };
  try {
    for (const table of TABLES) {
      // Schema shape, for the reader-side compatibility check.
      dump.schema[table] = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }));

      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      const excluded = new Set(EXCLUDED[table]);
      const normalized = rows.map((row) => {
        const kept = {};
        for (const [k, v] of Object.entries(row)) {
          if (excluded.has(k)) continue;
          kept[k] = typeof v === 'bigint' ? Number(v) : v;
        }
        return kept;
      });
      if (table === 'schema_meta') {
        for (const r of normalized) {
          if (WALL_CLOCK_META_KEYS.has(r.key)) r.value = '<wall-clock>';
        }
      }
      normalized.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
      dump.tables[table] = normalized;
    }
    dump.indexes = db
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all();
  } finally {
    db.close();
  }
  return dump;
}

function diffDumps(a, b) {
  const problems = [];

  for (const table of TABLES) {
    const sa = JSON.stringify(a.schema[table]);
    const sb = JSON.stringify(b.schema[table]);
    if (sa !== sb) {
      problems.push(`SCHEMA MISMATCH ${table}\n  node: ${sa}\n  go:   ${sb}`);
    }
  }
  if (JSON.stringify(a.indexes) !== JSON.stringify(b.indexes)) {
    problems.push(`INDEX MISMATCH\n  node: ${JSON.stringify(a.indexes)}\n  go:   ${JSON.stringify(b.indexes)}`);
  }

  for (const table of TABLES) {
    const ra = a.tables[table];
    const rb = b.tables[table];
    if (ra.length !== rb.length) {
      problems.push(`ROW COUNT ${table}: node=${ra.length} go=${rb.length}`);
    }
    const max = Math.max(ra.length, rb.length);
    for (let i = 0; i < max; i++) {
      const la = ra[i] === undefined ? '<missing>' : JSON.stringify(ra[i]);
      const lb = rb[i] === undefined ? '<missing>' : JSON.stringify(rb[i]);
      if (la !== lb) problems.push(`ROW DIFF ${table}[${i}]\n  node: ${la}\n  go:   ${lb}`);
    }
  }
  return problems;
}

async function main() {
  const nodeEntry = join(nodeCollectorDir, 'dist', 'index.js');
  if (!existsSync(nodeEntry)) {
    throw new Error(`Node collector not built: ${nodeEntry} missing. Run 'npm run build' in ${nodeCollectorDir}, or set AETHER_NODE_COLLECTOR_DIR.`);
  }

  const workRoot = mkdtempSync(join(tmpdir(), 'aether-parity-'));
  log(`work dir: ${workRoot}`);

  const goBin = join(workRoot, 'bin', 'aether-collector-go.exe');
  mkdirSync(dirname(goBin), { recursive: true });
  log('building Go collector...');
  execFileSync('go', ['build', '-o', goBin, './cmd/aether-collector'], { cwd: collectorGoDir, stdio: 'inherit' });

  log('building stub `claude` binary...');
  const stubBin = join(workRoot, 'stubbin');
  buildStubClaude(stubBin);

  // ONE base timestamp, TWO identical fixture copies.
  const baseMs = Date.now();
  const rootA = join(workRoot, 'home-node');
  const rootB = join(workRoot, 'home-go');
  const fixA = buildFixture(rootA, baseMs);
  const fixB = buildFixture(rootB, baseMs);

  // Windows env vars are case-insensitive but a spawned child's env object is
  // not, so PATH must be written back under whatever casing the parent already
  // uses rather than adding a second key the child would see as distinct.
  const envFor = (root) => {
    const env = { ...process.env };
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = `${stubBin};${env[pathKey] ?? ''}`;
    for (const k of Object.keys(env)) {
      // HOMEDRIVE/HOMEPATH would otherwise win over USERPROFILE in some
      // home-directory resolvers; drop them so USERPROFILE is unambiguous.
      if (k.toLowerCase() === 'homedrive' || k.toLowerCase() === 'homepath') delete env[k];
      if (k.toLowerCase() === 'userprofile' || k.toLowerCase() === 'home') delete env[k];
    }
    env.USERPROFILE = root;
    env.HOME = root;
    return env;
  };

  log('running Node collector...');
  await runFor('node', process.execPath, [nodeEntry], envFor(rootA), nodeCollectorDir);

  log('running Go collector...');
  await runFor('go', goBin, [], envFor(rootB), collectorGoDir);

  if (!existsSync(fixA.dbPath)) throw new Error(`Node collector produced no database at ${fixA.dbPath}`);
  if (!existsSync(fixB.dbPath)) throw new Error(`Go collector produced no database at ${fixB.dbPath}`);

  const dumpA = dumpDb(fixA.dbPath);
  const dumpB = dumpDb(fixB.dbPath);

  log('\n--- row counts (node / go) ---');
  for (const t of TABLES) log(`  ${t.padEnd(24)} ${String(dumpA.tables[t].length).padStart(4)} / ${String(dumpB.tables[t].length).padStart(4)}`);

  const problems = diffDumps(dumpA, dumpB);

  if (process.env.AETHER_PARITY_DUMP) {
    writeFileSync(join(workRoot, 'dump-node.json'), JSON.stringify(dumpA, null, 2), 'utf8');
    writeFileSync(join(workRoot, 'dump-go.json'), JSON.stringify(dumpB, null, 2), 'utf8');
    log(`\ndumps written to ${workRoot}`);
  }

  if (problems.length > 0) {
    log(`\n=== ${problems.length} DIVERGENCE(S) ===`);
    for (const p of problems) log(p);
    if (!KEEP) log(`(work dir kept for inspection: ${workRoot})`);
    process.exitCode = 1;
    return;
  }

  log('\nPARITY OK: every table row-for-row identical outside the documented exclusions.');
  if (!KEEP) rmSync(workRoot, { recursive: true, force: true });
  else log(`work dir kept: ${workRoot}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
