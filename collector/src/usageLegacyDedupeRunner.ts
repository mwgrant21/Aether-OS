import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { closeSync, existsSync, lstatSync, openSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDryRunHandle, DbChangedError, AssertionError } from './usageBackfill.js';
import { defaultFreeBytes, defaultVerifyBackup, utcStamp } from './usageBackfillRunner.js';
import { dedupeLegacyUsage, PlanOutOfBoundsError, PrerequisiteError } from './usageLegacyDedupe.js';

// Runtime require, not a static import: same Vite workaround as schema.ts openDatabase.
const require = createRequire(import.meta.url);

const HEARTBEAT_FRESH_MS = 60_000;

export const LEGACY_DEDUPE_USAGE_TEXT = `Usage: dedupe-legacy-usage [--apply --expect-delete <n> --expect-token-mass <n>] [--allow-running] [--db <path>] [--help]

Deletes the surplus of legacy usage_events rows (message_key NULL, written before
0.7.6) that the exact repair, backfill-usage, could not recover because their
transcripts are gone. Run backfill-usage first: apply is refused until its marker exists.

The rule is APPROXIMATE and reads no transcript. Rows of one transcript file with
the same model and the same four token counts, each within 60 seconds of the
previous one, are treated as one streamed message: the earliest is kept, the rest
are deleted. Individual deletes are not verified. Survivors keep message_key NULL
and may carry partial output; duplicates across files are not caught; totals will
not be exact. Compare the dry-run cluster shape with what you expect before applying.

Default is a dry-run: reads only, prints a one-line JSON report, writes nothing.

--apply          Write the deletes. Requires --expect-delete and
                 --expect-token-mass, which must equal the dry-run's rowsToDelete
                 and deleteTokenMass (otherwise exit 6 before anything is backed
                 up). The collector must be stopped for more than 60 seconds:
                 the run is refused if schema_meta.transcript_last_scan_ms is
                 younger than that, missing or not a number. Before writing, a
                 backup is taken next to the database as
                 collector.db.pre-legacy-dedupe-<UTC yyyymmddHHMMSS>.bak and
                 verified (quick_check, row count, token sum).
--allow-running  Skip the collector-alive check. Test-only; never use it on a
                 live database.
--db <path>      Database path (tests only; default ~/.aether-os/collector.db).
--help           Print this text.

Exit codes: 0 ok, 1 error / rolled back / assertion mismatch, 2 message_key
column or backfill marker missing, 3 collector alive or heartbeat unreadable,
4 backup or free-space failure, 5 database changed during the run (nothing
written; a verified .bak is left behind, so a same-second rerun exits 4 until
you remove or keep it), 6 plan out of bounds (expected counts differ, a cluster
over 30 rows or 300 seconds, or more than 60% of rows would go).

Rollback: restoring the .bak is clean ONLY before the collector restarts, and
only after moving aside <db>-wal and <db>-shm. After a restart the gap re-ingest
duplicates tool_calls and hook spool files already consumed are lost. The
database file does not shrink (no VACUUM). Decide go/no-go on the dry-run
numbers before apply.
`;

export interface LegacyDedupeRunnerEnv {
  out?: (line: string) => void;
  err?: (line: string) => void;
  now?: () => number;
  defaultDbPath?: string;
  /** Free bytes on the volume holding dir. */
  freeBytes?: (dir: string) => number;
  /** Returns true iff the backup at path is sound and matches the snapshot. */
  verifyBackup?: (backupPath: string, snap: import('./usageBackfill.js').BackfillSnapshot) => boolean;
  /** Passed through to dedupeLegacyUsage (tests only). */
  testHooks?: { beforeLock?: () => void; afterWrites?: (db: DatabaseSync) => void };
}

class BackupError extends Error {}

interface Args {
  apply: boolean;
  allowRunning: boolean;
  help: boolean;
  db?: string;
  expectDelete?: number;
  expectTokenMass?: number;
}

function parseArgs(argv: string[]): Args | null {
  const a: Args = { apply: false, allowRunning: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--apply') a.apply = true;
    else if (t === '--allow-running') a.allowRunning = true;
    else if (t === '--help') a.help = true;
    else if (t === '--db' || t === '--expect-delete' || t === '--expect-token-mass') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return null;
      if (t === '--db') a.db = v;
      else {
        if (!/^\d{1,15}$/.test(v)) return null;
        if (t === '--expect-delete') a.expectDelete = Number(v);
        else a.expectTokenMass = Number(v);
      }
    } else return null;
  }
  return a;
}

// lstat, not existsSync: a dangling symlink at the backup path must count as taken.
function pathTaken(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new BackupError();
  }
}

/**
 * Guarded entry point for `dedupe-legacy-usage`. Returns the exit code; never throws.
 * Every error path prints a fixed string and the code, never err.message or a path.
 */
export function runLegacyUsageDedupe(argv: string[], env: LegacyDedupeRunnerEnv = {}): number {
  const out = env.out ?? ((l: string) => process.stdout.write(l + '\n'));
  const errOut = env.err ?? ((l: string) => process.stderr.write(l + '\n'));
  const now = env.now ?? Date.now;
  const fail = (msg: string, code: number): number => {
    errOut(`dedupe-legacy-usage: ${msg} (exit ${code})`);
    return code;
  };

  const args = parseArgs(argv);
  if (args === null) {
    errOut(LEGACY_DEDUPE_USAGE_TEXT);
    return 1;
  }
  if (args.help) {
    out(LEGACY_DEDUPE_USAGE_TEXT);
    return 0;
  }

  const dbPath = args.db ?? env.defaultDbPath ?? join(homedir(), '.aether-os', 'collector.db');
  if (!existsSync(dbPath)) return fail('database not found', 1);

  let db: DatabaseSync | undefined;
  let backupPath: string | undefined;
  let createdBackup = false;
  try {
    try {
      if (args.apply) {
        db = new (require('node:sqlite').DatabaseSync)(dbPath) as DatabaseSync;
        db.exec('PRAGMA busy_timeout = 5000');
      } else {
        db = openDryRunHandle(dbPath);
      }
    } catch {
      return fail('cannot open database', 1);
    }

    if (args.apply && !args.allowRunning) {
      let hb: { value: string } | undefined;
      try {
        hb = db.prepare("SELECT value FROM schema_meta WHERE key = 'transcript_last_scan_ms'").get() as
          | { value: string }
          | undefined;
      } catch {
        return fail('cannot read heartbeat', 1);
      }
      // Strict digits only: Number('') is 0, which would read as "stopped long ago".
      const last = hb && /^\d{1,16}$/.test(String(hb.value)) ? Number(hb.value) : NaN;
      // Fail closed: a missing or non-numeric heartbeat is not proof the collector is stopped.
      // A heartbeat in the future (clock skew) is also treated as fresh.
      if (!Number.isFinite(last)) {
        return fail('collector heartbeat missing or unreadable; cannot prove the collector is stopped', 3);
      }
      if (now() - last < HEARTBEAT_FRESH_MS) {
        return fail('collector appears to be running; stop it and wait over 60 seconds', 3);
      }
    }

    const report = dedupeLegacyUsage(db, {
      apply: args.apply,
      expectDelete: args.expectDelete,
      expectTokenMass: args.expectTokenMass,
      testHooks: env.testHooks,
      onSnapshot: args.apply
        ? (snap) => {
            const dir = dirname(dbPath);
            backupPath = join(dir, `collector.db.pre-legacy-dedupe-${utcStamp(now())}.bak`);
            let taken: boolean;
            try {
              taken = pathTaken(backupPath);
            } catch {
              backupPath = undefined;
              throw new BackupError();
            }
            if (taken) {
              backupPath = undefined; // not ours: never delete it
              throw new BackupError();
            }
            let needed: number;
            let free: number;
            try {
              needed = Math.ceil(statSync(dbPath).size * 1.1) + 1024 * 1024;
              free = (env.freeBytes ?? defaultFreeBytes)(dir);
            } catch {
              throw new BackupError();
            }
            if (!(free >= needed)) throw new BackupError();
            // Claim the destination atomically: the exclusive create ('wx') is the ownership
            // claim, and on POSIX it fails (EEXIST) on any existing path, so cleanup only ever
            // removes a file this run created. It is not what covers a pre-existing symlink:
            // on Windows 'wx' can follow a dangling symlink created after the lstat precheck
            // (pathTaken above), and that precheck is what rejects links that already exist.
            try {
              closeSync(openSync(backupPath, 'wx'));
            } catch {
              backupPath = undefined; // not ours: never delete it
              throw new BackupError();
            }
            createdBackup = true;
            try {
              const target = backupPath.replace(/'/g, "''");
              db!.exec(`VACUUM INTO '${target}'`);
              if (!(env.verifyBackup ?? defaultVerifyBackup)(backupPath, snap)) throw new BackupError();
            } catch {
              throw new BackupError();
            }
          }
        : undefined,
    });
    out(JSON.stringify(report));
    return 0;
  } catch (e) {
    if (e instanceof BackupError) {
      db?.close();
      db = undefined;
      if (createdBackup && backupPath) {
        try {
          unlinkSync(backupPath);
        } catch {
          // best effort; the file is only ever one this run created
        }
      }
      return fail('backup or free-space check failed, nothing written', 4);
    }
    if (e instanceof PlanOutOfBoundsError) return fail(`plan out of bounds (${e.reason}), nothing written`, 6);
    if (e instanceof PrerequisiteError) return fail('backfill-usage marker missing; run backfill-usage first', 2);
    if (e instanceof DbChangedError) return fail('database changed during the run, nothing written, re-run', 5);
    if (e instanceof AssertionError) return fail(`post-write assertion ${e.assertion} failed, rolled back`, 1);
    if (e instanceof Error && e.message === 'usage_events.message_key missing') {
      return fail('usage_events.message_key column missing; run the collector once to migrate', 2);
    }
    return fail('unexpected error, nothing written or rolled back', 1);
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}
