// Golden-file parity harness: runs the Node collector and the Go collector
// against byte-identical fixture inputs and diffs the two resulting SQLite
// databases row-for-row, then runs both CLIs' hook-install and autostart
// operations against byte-identical settings.json fixtures and diffs those.
//
// Usage (from collector-go/):
//   node scripts/parity/run-parity.mjs [--keep]
//
// Requirements:
//   * Node >= 22.5 (node:sqlite) -- used both to run the Node collector and to
//     read BOTH databases for the diff, so the comparison itself never depends
//     on the Go side being correct.
//   * The Node collector built: `npm run build` in collector/.
//   * `go` on PATH (builds the Go collector, the Go CLI, and two stub binaries).
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
//      The stub counts its own invocations PER FIXTURE ROOT and returns
//      FLEET_JSON to the first poll, FLEET_JSON_LATER to every poll after --
//      see fixture.mjs for what each payload buys.
//   3. %USERPROFILE% is pointed at the fixture root. Node's os.homedir() and
//      Go's os.UserHomeDir() both read it on Windows, so both binaries run
//      their real, unmodified entrypoint path resolution -- no test-only flags.
//   4. A stub `schtasks.exe` that only records its own argv is used for the
//      autostart comparison, on a PATH that contains NOTHING ELSE, so neither
//      CLI can reach the real Windows Task Scheduler. See runAutostartParity.
//
// Multi-tick coverage
// -------------------
// Both collectors run their transcript scan and fleet poll on a 15s interval
// (collector/src/index.ts:86,88; collector-go/cmd/aether-collector/main.go).
// RUN_MS defaults to 50s so FOUR ticks of each land (t=0 immediate, then 15s,
// 30s, 45s) with a 5s margin before the kill, and appendMidRun() fires at
// APPEND_AT_MS (8s, comfortably between tick 1 and tick 2). That is what gives
// differential coverage to:
//   * anomaly dedup across ticks (unique index + INSERT OR IGNORE)
//   * incremental offset-resume rescan (transcript_files.last_offset)
//   * fleet_sessions' ON CONFLICT update and its 30s stale prune
// The COVERAGE ASSERTIONS section below fails the run if any of those did not
// actually happen, so shrinking RUN_MS can never silently return this harness
// to single-tick coverage while still reporting PARITY OK.
//
// Excluded columns (see EXCLUDED below): autoincrement `id` columns, and
// columns whose value is Date.now()/time.Now() at ingest. Every other column of
// every table is compared. Row order is normalized away (rows are sorted by
// their retained-column tuple) because insertion order is only observable
// through the excluded `id` columns.

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  buildFixture,
  appendMidRun,
  settingsFixture,
  betaTrailingPartialBytes,
  alphaTranscriptPath,
  betaTranscriptPath,
  ALPHA_REL_PATH,
  BETA_REL_PATH,
  FLEET_JSON,
  FLEET_JSON_LATER,
  STUB_CALL_COUNT_FILE,
  STUB_SCHTASKS_LOG_FILE,
} from './fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const collectorGoDir = resolve(here, '..', '..');
const repoRoot = resolve(collectorGoDir, '..');

// The Node collector's build output. Overridable because this repo is normally
// developed in a git worktree that has collector/src but no node_modules; in
// that case point this at the main checkout's collector/.
const nodeCollectorDir = process.env.AETHER_NODE_COLLECTOR_DIR
  ? resolve(process.env.AETHER_NODE_COLLECTOR_DIR)
  : join(repoRoot, 'collector');

// Both collectors' transcript-scan and fleet-poll interval, and fleetPoll's
// stale threshold. Not configuration -- these mirror the values both sources
// hardcode, and RUN_MS is derived from them.
const TICK_INTERVAL_MS = 15000;
const FLEET_STALE_MS = 30000;
// The tick that robustly satisfies fleetPoll's `last_seen_ms < nowMs -
// STALE_MS` prune for a session last seen at the t=0 poll: the first tick
// strictly past FLEET_STALE_MS. floor(30000/15000)+1 = the 3rd interval tick,
// i.e. t=45s. (The t=30s tick only clears the threshold by however many
// milliseconds of startup+ticker drift separate it from the immediate poll --
// true in practice, but not something to build a coverage claim on.)
const MIN_RUN_MS = (Math.floor(FLEET_STALE_MS / TICK_INTERVAL_MS) + 1) * TICK_INTERVAL_MS + 2000;
// Four ticks (0/15/30/45s) plus a 5s margin before the kill.
const DEFAULT_RUN_MS = 50000;
const RUN_MS = Number(process.env.AETHER_PARITY_RUN_MS ?? DEFAULT_RUN_MS);
// Between tick 1 (t=0) and tick 2 (t=15s), far from both.
const APPEND_AT_MS = Number(process.env.AETHER_PARITY_APPEND_MS ?? 8000);
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
  // reproduce exactly, including the trailing-partial-line case and the
  // resume-from-mid-partial case appendMidRun creates.
  transcript_files: ['last_scanned_ms'],
  // last_seen_ms: the poll tick's nowMs (fleetPoll.ts:94). started_at_ms comes
  // from the stub's JSON and IS compared. WHICH ROWS SURVIVE is compared too,
  // and that is the 30s stale prune's observable output.
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

// Builds a single-file Go program into binDir/<exeName>. Used for both stubs;
// `go` is already a hard requirement of this harness, so this needs no extra
// toolchain.
function buildGoStub(binDir, exeName, mainGoSource) {
  mkdirSync(binDir, { recursive: true });
  const srcDir = mkdtempSync(join(tmpdir(), 'aether-stub-'));
  writeFileSync(join(srcDir, 'go.mod'), `module aetherstub\n\ngo 1.26\n`, 'utf8');
  writeFileSync(join(srcDir, 'main.go'), mainGoSource, 'utf8');
  const out = join(binDir, exeName);
  execFileSync('go', ['build', '-o', out, '.'], { cwd: srcDir, stdio: 'inherit' });
  rmSync(srcDir, { recursive: true, force: true });
  return out;
}

// `claude agents --json` stub. Counts its invocations in a per-fixture-root
// file so "first poll" means first poll OF THIS COLLECTOR, not of the harness
// (the two collectors run sequentially against the same stub binary).
const STUB_CLAUDE_SRC = `package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const first = ` + '`' + FLEET_JSON + '`' + `
const later = ` + '`' + FLEET_JSON_LATER + '`' + `

func main() {
	home := os.Getenv("USERPROFILE")
	if home == "" {
		home = os.Getenv("HOME")
	}
	statePath := filepath.Join(home, ${JSON.stringify(STUB_CALL_COUNT_FILE)})
	n := 0
	if b, err := os.ReadFile(statePath); err == nil {
		n, _ = strconv.Atoi(strings.TrimSpace(string(b)))
	}
	n++
	_ = os.WriteFile(statePath, []byte(strconv.Itoa(n)), 0644)
	if n == 1 {
		fmt.Print(first)
	} else {
		fmt.Print(later)
	}
}
`;

// schtasks.exe stub: records argv and does nothing else. Deliberately has no
// side effect at all -- the point of the autostart comparison is WHAT each CLI
// asks schtasks to do, and neither CLI may be allowed near the real scheduler.
const STUB_SCHTASKS_SRC = `package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

func main() {
	home := os.Getenv("USERPROFILE")
	if home == "" {
		home = os.Getenv("HOME")
	}
	logPath := filepath.Join(home, ${JSON.stringify(STUB_SCHTASKS_LOG_FILE)})
	b, err := json.Marshal(os.Args[1:])
	if err != nil {
		os.Exit(2)
	}
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		os.Exit(2)
	}
	defer f.Close()
	if _, err := f.Write(append(b, '\\n')); err != nil {
		os.Exit(2)
	}
}
`;

function runFor(label, cmd, args, env, cwd, onMidRun) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    let killed = false;
    let midRunError = null;
    const midRunTimer = setTimeout(() => {
      try {
        onMidRun();
      } catch (err) {
        midRunError = err;
      }
    }, APPEND_AT_MS);
    const timer = setTimeout(() => {
      killed = true;
      child.kill();
    }, RUN_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      clearTimeout(midRunTimer);
      rejectRun(new Error(`${label} failed to spawn: ${err.message}`));
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(midRunTimer);
      if (midRunError) {
        rejectRun(new Error(`${label}: mid-run fixture append failed: ${midRunError.message}`));
        return;
      }
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

// ---------------------------------------------------------------------------
// COVERAGE ASSERTIONS
//
// diffDumps only proves the two collectors AGREE. These prove the run actually
// exercised the multi-tick behaviors this harness claims to cover, on each
// collector independently -- so a future RUN_MS/APPEND_AT_MS change that
// quietly drops back to one tick fails loudly instead of still printing
// PARITY OK against a narrower fixture.
// ---------------------------------------------------------------------------
function coverageProblems(label, dump, root, baseMs) {
  const problems = [];
  const fail = (msg) => problems.push(`COVERAGE (${label}): ${msg}`);

  const fleet = dump.tables.fleet_sessions;
  const bbb = fleet.find((r) => r.session_id === 'fleet-session-bbb');
  if (!bbb) {
    fail('fleet_sessions has no fleet-session-bbb row at all');
  } else if (bbb.status !== 'active') {
    // FLEET_JSON says idle, FLEET_JSON_LATER says active -- 'active' can only
    // come from a SECOND poll going through ON CONFLICT DO UPDATE.
    fail(`fleet-session-bbb.status is ${JSON.stringify(bbb.status)}, expected "active" from a second poll's upsert`);
  }
  if (fleet.some((r) => r.session_id === 'fleet-session-eee')) {
    fail(`fleet-session-eee survived; the ${FLEET_STALE_MS}ms stale prune never ran (needs >${FLEET_STALE_MS}ms of polls after its only sighting)`);
  }
  if (!fleet.some((r) => r.session_id === 'fleet-session-ccc')) {
    fail('fleet-session-ccc was pruned; it appears in every poll and must never go stale');
  }

  const anomalies = dump.tables.anomalies;
  const seen = new Set();
  for (const a of anomalies) {
    const key = `${a.kind}\0${a.tool_use_id}`;
    if (seen.has(key)) fail(`duplicate anomalies row for (${a.kind}, ${a.tool_use_id}) -- INSERT OR IGNORE + unique index failed to dedup repeat detections`);
    seen.add(key);
  }
  const reReads = anomalies.filter((a) => a.kind === 'reReadLoop').map((a) => a.detail);
  if (!reReads.some((d) => d.endsWith('read 3 times'))) {
    fail(`no "read 3 times" reReadLoop anomaly (first-tick detection missing); saw ${JSON.stringify(reReads)}`);
  }
  if (!reReads.some((d) => d.endsWith('read 4 times'))) {
    fail(`no "read 4 times" reReadLoop anomaly; the post-append rescan never happened, so dedup was never re-exercised. saw ${JSON.stringify(reReads)}`);
  }

  // Incremental offset-resume: alpha ends with a newline so its final offset is
  // the whole file; beta ends with an incomplete line that must be excluded.
  const offsets = new Map(dump.tables.transcript_files.map((r) => [r.file_path, r.last_offset]));
  const alphaSize = statSync(alphaTranscriptPath(root)).size;
  const betaSize = statSync(betaTranscriptPath(root)).size;
  const betaExpected = betaSize - betaTrailingPartialBytes(baseMs);
  if (offsets.get(ALPHA_REL_PATH) !== alphaSize) {
    fail(`transcript_files[${ALPHA_REL_PATH}].last_offset = ${offsets.get(ALPHA_REL_PATH)}, expected ${alphaSize} (whole file after the mid-run append)`);
  }
  if (offsets.get(BETA_REL_PATH) !== betaExpected) {
    fail(`transcript_files[${BETA_REL_PATH}].last_offset = ${offsets.get(BETA_REL_PATH)}, expected ${betaExpected} (file size ${betaSize} minus the trailing partial line)`);
  }

  // The spool file that only appeared after startup.
  if (!dump.tables.events.some((e) => e.session_id === 'gamma')) {
    fail('no events from the gamma spool file, which is written mid-run -- the spool tailer never picked up a file created after startup');
  }

  return problems;
}

// ---------------------------------------------------------------------------
// hookinstall / autostart CLI parity
// ---------------------------------------------------------------------------

function runOnce(label, cmd, args, env, cwd) {
  const r = spawnSync(cmd, args, { env, cwd, encoding: 'utf8' });
  if (r.error) throw new Error(`${label} failed to spawn: ${r.error.message}`);
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// Deterministic ordering of object keys, arrays left alone. This is the ONE
// documented divergence between the two hook installers: Go's encoding/json
// always sorts map keys, Node's JSON.stringify preserves insertion order (see
// internal/hookinstall/installer.go's package doc). Array order IS semantic
// (hook groups run in order) and is therefore NOT normalized.
function canonicalJson(v) {
  if (Array.isArray(v)) return v.map(canonicalJson);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalJson(v[k]);
    return out;
  }
  return v;
}

function readCanonical(path) {
  return JSON.stringify(canonicalJson(JSON.parse(readFileSync(path, 'utf8'))), null, 2);
}

// Normalizes the fixture root and the backup filename's embedded Date.now()
// out of CLI stdout. Those are the only two legitimately-varying parts; the
// scriptPath both CLIs print is the SAME absolute path (the Go CLI is given
// the Node CLI's resolved path via -script-path) and is compared verbatim.
function normalizeCliOut(out, root) {
  return out
    .replace(/\r\n/g, '\n')
    .split(root)
    .join('<HOME>')
    .replace(/\.aetherbak-\d+/g, '.aetherbak-<ts>')
    .trim();
}

function backupContents(claudeDir) {
  return readdirSync(claudeDir)
    .filter((f) => f.startsWith('settings.json.aetherbak-'))
    .sort()
    .map((f) => readCanonical(join(claudeDir, f)));
}

function strayTempFiles(claudeDir) {
  return readdirSync(claudeDir).filter((f) => f.includes('.aethertmp-')).sort();
}

function runHookInstallParity(sides) {
  const problems = [];
  const push = (msg) => problems.push(`HOOKINSTALL: ${msg}`);

  const compare = (what, a, b) => {
    if (a !== b) push(`${what}\n  node: ${a}\n  go:   ${b}`);
  };

  const step = (name, args) => {
    const results = sides.map((s) => {
      const r = runOnce(`${s.label} cli ${name}`, s.cmd, [...s.args, ...args], s.env, s.cwd);
      return { ...r, out: normalizeCliOut(r.out, s.root) };
    });
    compare(`\`${name}\` exit status`, String(results[0].status), String(results[1].status));
    compare(`\`${name}\` stdout`, results[0].out, results[1].out);
    return results;
  };

  const compareState = (name) => {
    compare(`settings.json after ${name}`, readCanonical(sides[0].settingsPath), readCanonical(sides[1].settingsPath));
    compare(
      `backup files after ${name}`,
      JSON.stringify(backupContents(sides[0].claudeDir), null, 2),
      JSON.stringify(backupContents(sides[1].claudeDir), null, 2)
    );
    compare(
      `leftover .aethertmp- files after ${name}`,
      JSON.stringify(strayTempFiles(sides[0].claudeDir)),
      JSON.stringify(strayTempFiles(sides[1].claudeDir))
    );
    for (const s of sides) {
      if (strayTempFiles(s.claudeDir).length > 0) {
        push(`${s.label} left a .aethertmp- file behind after ${name}: ${strayTempFiles(s.claudeDir).join(', ')}`);
      }
    }
  };

  // Like the COVERAGE ASSERTIONS above: comparing node against go proves they
  // AGREE, which two no-ops would also satisfy. These pin what each side must
  // independently have done, so a hook installer that silently stopped
  // installing anything cannot pass this step.
  const expectStatus = (name, results, expected) => {
    for (const [i, s] of sides.entries()) {
      for (const line of expected) {
        if (!results[i].out.split('\n').some((l) => l.trim() === line)) {
          push(`${s.label}: \`${name}\` did not report "${line}"; got\n${results[i].out}`);
        }
      }
    }
  };
  const NOT_INSTALLED = ['PreToolUse: not installed', 'PostToolUse: not installed', 'Notification: not installed', 'Stop: not installed'];

  expectStatus('status (pre-install)', step('status (pre-install)', ['status']), NOT_INSTALLED);
  step('install-hooks', ['install-hooks']);
  compareState('install-hooks');
  // Stop stays "not installed": the fixture's Stop value is not an array, and
  // both installers deliberately skip an unrecognized shape rather than
  // overwrite it.
  expectStatus('status (post-install)', step('status (post-install)', ['status']), [
    'PreToolUse: installed',
    'PostToolUse: installed',
    'Notification: installed',
    'Stop: not installed',
  ]);
  // Idempotence: a second install must not append a duplicate group. Counted
  // per side rather than only compared across sides, for the same
  // non-vacuity reason as expectStatus.
  step('install-hooks (repeat)', ['install-hooks']);
  compareState('install-hooks (repeat)');
  for (const s of sides) {
    const occurrences = readFileSync(s.settingsPath, 'utf8').split('aether-hook-emit.mjs').length - 1;
    if (occurrences !== 3) {
      push(`${s.label}: settings.json contains the hook marker ${occurrences} time(s) after a repeated install, expected 3 (PreToolUse, PostToolUse, Notification -- Stop is skipped)`);
    }
  }
  step('uninstall-hooks', ['uninstall-hooks']);
  compareState('uninstall-hooks');
  step('uninstall-hooks (repeat)', ['uninstall-hooks']);
  compareState('uninstall-hooks (repeat)');
  expectStatus('status (post-uninstall)', step('status (post-uninstall)', ['status']), NOT_INSTALLED);

  // Round-trip: install-then-uninstall must restore the original file's
  // content exactly (modulo key order), including the unrelated PreToolUse
  // group, the untouched SessionStart group, and the non-array Stop value both
  // installers deliberately skip.
  const original = JSON.stringify(canonicalJson(settingsFixture()), null, 2);
  for (const s of sides) {
    const after = readCanonical(s.settingsPath);
    if (after !== original) {
      push(`${s.label}: install+uninstall did not round-trip settings.json back to its original content\n  original: ${original}\n  after:    ${after}`);
    }
  }

  return problems;
}

// The /TR value is the ONE disclosed, intentional divergence between the two
// CLIs' schtasks argv: Node needs `"<node.exe>" "<index.js>"` because it needs
// an interpreter, a self-contained Go binary passes `"<exe>"` alone (see
// cmd/aether-collector-cli/main.go's doc comment). Every other flag, its
// order, and the task name are compared verbatim.
function normalizeSchtasksArgv(argv) {
  const out = [...argv];
  const i = out.indexOf('/TR');
  if (i !== -1 && i + 1 < out.length) out[i + 1] = '<TR: disclosed node-vs-go divergence>';
  return out;
}

function runAutostartParity(sides) {
  const problems = [];
  const push = (msg) => problems.push(`AUTOSTART: ${msg}`);

  const readArgvLog = (path) =>
    (existsSync(path) ? readFileSync(path, 'utf8') : '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
      .filter((argv) => argv[0] !== '--aether-stub-probe');

  for (const args of [['install-autostart'], ['uninstall-autostart']]) {
    const results = sides.map((s) => {
      const r = runOnce(`${s.label} cli ${args[0]}`, s.cmd, [...s.args, ...args], s.autostartEnv, s.cwd);
      return { ...r, out: normalizeCliOut(r.out, s.root) };
    });
    if (results[0].status !== results[1].status) {
      push(`\`${args[0]}\` exit status: node=${results[0].status} go=${results[1].status}`);
    }
    if (results[0].out !== results[1].out) {
      push(`\`${args[0]}\` stdout\n  node: ${results[0].out}\n  go:   ${results[1].out}`);
    }
    for (const r of results) {
      if (r.status !== 0) push(`\`${args[0]}\` exited ${r.status}: ${r.out}`);
    }
  }

  const argvA = readArgvLog(sides[0].schtasksLogPath).map(normalizeSchtasksArgv);
  const argvB = readArgvLog(sides[1].schtasksLogPath).map(normalizeSchtasksArgv);
  if (argvA.length !== 2) push(`node CLI made ${argvA.length} schtasks call(s), expected 2 (install + uninstall)`);
  if (argvB.length !== 2) push(`go CLI made ${argvB.length} schtasks call(s), expected 2 (install + uninstall)`);
  const sa = JSON.stringify(argvA, null, 2);
  const sb = JSON.stringify(argvB, null, 2);
  if (sa !== sb) push(`schtasks argv mismatch\n  node: ${sa}\n  go:   ${sb}`);

  return problems;
}

async function main() {
  const nodeEntry = join(nodeCollectorDir, 'dist', 'index.js');
  if (!existsSync(nodeEntry)) {
    throw new Error(`Node collector not built: ${nodeEntry} missing. Run 'npm run build' in ${nodeCollectorDir}, or set AETHER_NODE_COLLECTOR_DIR.`);
  }
  const nodeCliEntry = join(nodeCollectorDir, 'dist', 'cli.js');
  if (!existsSync(nodeCliEntry)) {
    throw new Error(`Node collector CLI not built: ${nodeCliEntry} missing. Run 'npm run build' in ${nodeCollectorDir}.`);
  }
  // cli.ts resolves this itself from its own compiled location and has no
  // override flag, so the Node CLI's value is authoritative and the Go CLI is
  // told to use the same one via -script-path.
  const scriptPath = resolve(nodeCliEntry, '..', '..', '..', 'scripts', 'aether-hook-emit.mjs');
  if (!existsSync(scriptPath)) {
    throw new Error(`aether-hook-emit.mjs not found at ${scriptPath}; both CLIs refuse to run without it.`);
  }

  if (RUN_MS < MIN_RUN_MS) {
    log(`WARNING: AETHER_PARITY_RUN_MS=${RUN_MS} is below the ${MIN_RUN_MS}ms needed for full multi-tick coverage; the COVERAGE ASSERTIONS below will fail.`);
  }
  if (APPEND_AT_MS >= TICK_INTERVAL_MS) {
    log(`WARNING: AETHER_PARITY_APPEND_MS=${APPEND_AT_MS} is not strictly inside the first ${TICK_INTERVAL_MS}ms tick window; the mid-run append may race a scan tick.`);
  }

  const workRoot = mkdtempSync(join(tmpdir(), 'aether-parity-'));
  log(`work dir: ${workRoot}`);

  const binDir = join(workRoot, 'bin');
  const goBin = join(binDir, 'aether-collector-go.exe');
  const goCliBin = join(binDir, 'aether-collector-cli.exe');
  mkdirSync(binDir, { recursive: true });
  log('building Go collector...');
  execFileSync('go', ['build', '-o', goBin, './cmd/aether-collector'], { cwd: collectorGoDir, stdio: 'inherit' });
  log('building Go collector CLI...');
  execFileSync('go', ['build', '-o', goCliBin, './cmd/aether-collector-cli'], { cwd: collectorGoDir, stdio: 'inherit' });

  log('building stub `claude` and `schtasks` binaries...');
  const stubBin = join(workRoot, 'stubbin');
  buildGoStub(stubBin, 'claude.exe', STUB_CLAUDE_SRC);
  buildGoStub(stubBin, 'schtasks.exe', STUB_SCHTASKS_SRC);

  // ONE base timestamp, TWO identical fixture copies.
  const baseMs = Date.now();
  const rootA = join(workRoot, 'home-node');
  const rootB = join(workRoot, 'home-go');
  const fixA = buildFixture(rootA, baseMs);
  const fixB = buildFixture(rootB, baseMs);

  // Windows env vars are case-insensitive but a spawned child's env object is
  // not, so PATH must be written back under whatever casing the parent already
  // uses rather than adding a second key the child would see as distinct.
  const envFor = (root, pathValue) => {
    const env = { ...process.env };
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = pathValue ?? `${stubBin};${env[pathKey] ?? ''}`;
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
  // For the autostart comparison PATH contains the stub directory and NOTHING
  // else, so neither CLI can fall through to the real schtasks.exe in
  // System32 and register (or delete) a scheduled task on the machine running
  // this harness. Verified below by an actual probe, not just by assumption.
  const autostartEnvFor = (root) => envFor(root, stubBin);

  // The two collectors run CONCURRENTLY, not one after the other. They share
  // nothing: separate fixture roots, separate databases, separate stub
  // invocation counters. Two reasons this matters now that RUN_MS is 50s
  // rather than 6s:
  //   * total wall time stays ~RUN_MS instead of 2x RUN_MS.
  //   * reader-check.mjs (the sibling script that runs the real
  //     electron/collectorStore.ts against both databases) has a 45s
  //     liveness-heartbeat gate. Run sequentially, the FIRST collector's last
  //     heartbeat would already be >45s stale by the time the harness exits,
  //     and the reader would correctly return null for that database only --
  //     making reader-check report a spurious divergence.
  // Nothing compared here is timing-derived (every wall-clock column is in
  // EXCLUDED, and both the drift_log contents and the final fleet_sessions
  // contents are deliberately independent of exactly how many ticks fit in
  // RUN_MS), so CPU contention between the two cannot skew the diff.
  log(`running both collectors concurrently for ${RUN_MS}ms (mid-run fixture append at ${APPEND_AT_MS}ms)...`);
  await Promise.all([
    runFor('node', process.execPath, [nodeEntry], envFor(rootA), nodeCollectorDir, () => appendMidRun(rootA, baseMs)),
    runFor('go', goBin, [], envFor(rootB), collectorGoDir, () => appendMidRun(rootB, baseMs)),
  ]);

  if (!existsSync(fixA.dbPath)) throw new Error(`Node collector produced no database at ${fixA.dbPath}`);
  if (!existsSync(fixB.dbPath)) throw new Error(`Go collector produced no database at ${fixB.dbPath}`);

  const dumpA = dumpDb(fixA.dbPath);
  const dumpB = dumpDb(fixB.dbPath);

  log('\n--- row counts (node / go) ---');
  for (const t of TABLES) log(`  ${t.padEnd(24)} ${String(dumpA.tables[t].length).padStart(4)} / ${String(dumpB.tables[t].length).padStart(4)}`);

  const problems = diffDumps(dumpA, dumpB);
  problems.push(...coverageProblems('node', dumpA, rootA, baseMs));
  problems.push(...coverageProblems('go', dumpB, rootB, baseMs));

  // ---- CLI parity: hook install/uninstall + autostart ---------------------
  const sides = [
    {
      label: 'node',
      cmd: process.execPath,
      args: [nodeCliEntry],
      env: envFor(rootA),
      autostartEnv: autostartEnvFor(rootA),
      cwd: nodeCollectorDir,
      root: rootA,
      claudeDir: fixA.claudeDir,
      settingsPath: fixA.settingsPath,
      schtasksLogPath: fixA.stubSchtasksLogPath,
    },
    {
      label: 'go',
      cmd: goCliBin,
      args: ['-script-path', scriptPath],
      env: envFor(rootB),
      autostartEnv: autostartEnvFor(rootB),
      cwd: collectorGoDir,
      root: rootB,
      claudeDir: fixB.claudeDir,
      settingsPath: fixB.settingsPath,
      schtasksLogPath: fixB.stubSchtasksLogPath,
    },
  ];

  log('\nrunning hook install/uninstall CLI parity...');
  problems.push(...runHookInstallParity(sides));

  // Safety gate: prove the stub schtasks.exe is what a child process actually
  // resolves under this PATH before letting either CLI run an autostart
  // command. Node/libuv does its own PATH search rather than using
  // CreateProcess's System32-first order, and Go's exec.LookPath is PATH-only,
  // but "believed to be" is not good enough when the failure mode is silently
  // creating or deleting a real AetherCollector scheduled task on a developer's
  // machine.
  log('running autostart CLI parity (against a stub schtasks.exe)...');
  const probeRoot = join(workRoot, 'probe-home');
  mkdirSync(probeRoot, { recursive: true });
  spawnSync('schtasks.exe', ['--aether-stub-probe'], { env: envFor(probeRoot, stubBin), cwd: workRoot });
  const probeLog = join(probeRoot, STUB_SCHTASKS_LOG_FILE);
  if (!existsSync(probeLog) || !readFileSync(probeLog, 'utf8').includes('--aether-stub-probe')) {
    throw new Error(
      'refusing to run the autostart parity step: spawning `schtasks.exe` under the stub-only PATH did not reach the stub, ' +
        'so running it for real would touch the machine\'s actual Task Scheduler.'
    );
  }
  problems.push(...runAutostartParity(sides));

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

  log('\nPARITY OK: every table row-for-row identical outside the documented exclusions,');
  log('multi-tick coverage assertions satisfied on both collectors, and both CLIs');
  log('produced identical settings.json / schtasks argv outcomes.');
  if (!KEEP) rmSync(workRoot, { recursive: true, force: true });
  else log(`work dir kept: ${workRoot}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
