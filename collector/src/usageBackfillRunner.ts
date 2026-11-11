import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { existsSync, statSync, statfsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  backfillUsageKeys,
  openDryRunHandle,
  DbChangedError,
  AssertionError,
  type BackfillSnapshot,
} from './usageBackfill.js';

// Runtime require, not a static import: same Vite workaround as schema.ts openDatabase.
const require = createRequire(import.meta.url);

const HEARTBEAT_FRESH_MS = 60_000;

export const USAGE_TEXT = `Usage: backfill-usage [--apply] [--allow-running] [--db <path>] [--projects-root <dir>] [--help]

Repairs legacy usage_events rows that have no message_key by matching them to
their transcript lines, keying one row per message and deleting the duplicates.

Default is a dry-run: reads only, prints a one-line JSON report, writes nothing.

--apply          Write the repair. The collector must be stopped: the run is
                 refused if schema_meta.transcript_last_scan_ms is younger than
                 60 seconds. Before writing, a backup is taken next to the
                 database as collector.db.pre-usage-backfill-<UTC yyyymmddHHMMSS>.bak
                 and verified (quick_check, row count, token sum).
--allow-running  Skip the collector-alive check. Test-only; never use it on a
                 live database.
--db <path>      Database path (tests only; default ~/.aether-os/collector.db).
--projects-root  Transcript root (tests only; default ~/.claude/projects).
--help           Print this text.

Exit codes: 0 ok, 1 error / rolled back / assertion mismatch, 2 message_key
column missing, 3 collector alive, 4 backup or free-space failure,
5 database changed during the run (nothing written, re-run).

Rollback: restoring the .bak is clean ONLY before the collector restarts.
After a restart the gap re-ingest duplicates tool_calls and hook spool files
already consumed are lost. Decide go/no-go on the dry-run numbers before apply.
`;

export interface RunnerEnv {
  out?: (line: string) => void;
  err?: (line: string) => void;
  now?: () => number;
  defaultDbPath?: string;
  defaultProjectsRoot?: string;
  /** Free bytes on the volume holding dir. */
  freeBytes?: (dir: string) => number;
  /** Returns true iff the backup at path is sound and matches the snapshot. */
  verifyBackup?: (backupPath: string, snap: BackfillSnapshot) => boolean;
  /** Passed through to backfillUsageKeys (tests only). */
  testHooks?: { beforeLock?: () => void; afterWrites?: (db: DatabaseSync) => void };
}

class BackupError extends Error {}

interface Args {
  apply: boolean;
  allowRunning: boolean;
  help: boolean;
  db?: string;
  root?: string;
}

function parseArgs(argv: string[]): Args | null {
  const a: Args = { apply: false, allowRunning: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--apply') a.apply = true;
    else if (t === '--allow-running') a.allowRunning = true;
    else if (t === '--help') a.help = true;
    else if (t === '--db' || t === '--projects-root') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return null;
      if (t === '--db') a.db = v;
      else a.root = v;
    } else return null;
  }
  return a;
}

const utcStamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14);

function defaultFreeBytes(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

const TOKEN_SUM =
  'COALESCE(SUM(input_tokens),0) + COALESCE(SUM(output_tokens),0) + COALESCE(SUM(cache_creation_input_tokens),0) + COALESCE(SUM(cache_read_input_tokens),0)';

function defaultVerifyBackup(backupPath: string, snap: BackfillSnapshot): boolean {
  const db: DatabaseSync = new (require('node:sqlite').DatabaseSync)(backupPath, { readOnly: true });
  try {
    const qc = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    if (qc.length !== 1 || Object.values(qc[0])[0] !== 'ok') return false;
    const r = db.prepare(`SELECT COUNT(*) AS c, ${TOKEN_SUM} AS t FROM usage_events`).get() as { c: number; t: number };
    return Number(r.c) === snap.count && Number(r.t) === snap.tokensTotal;
  } finally {
    db.close();
  }
}

/**
 * Guarded entry point for `backfill-usage`. Returns the exit code; never throws.
 * Every error path prints a fixed string and the code, never err.message or a path.
 */
export function runUsageBackfill(argv: string[], env: RunnerEnv = {}): number {
  const out = env.out ?? ((l: string) => process.stdout.write(l + '\n'));
  const errOut = env.err ?? ((l: string) => process.stderr.write(l + '\n'));
  const now = env.now ?? Date.now;
  const fail = (msg: string, code: number): number => {
    errOut(`backfill-usage: ${msg} (exit ${code})`);
    return code;
  };

  const args = parseArgs(argv);
  if (args === null) {
    errOut(USAGE_TEXT);
    return 1;
  }
  if (args.help) {
    out(USAGE_TEXT);
    return 0;
  }

  const dbPath = args.db ?? env.defaultDbPath ?? join(homedir(), '.aether-os', 'collector.db');
  const root = args.root ?? env.defaultProjectsRoot ?? join(homedir(), '.claude', 'projects');
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
      const last = hb ? Number(hb.value) : NaN;
      // Younger than 60 s means a collector is alive. A heartbeat in the future
      // (clock skew) is also treated as fresh: refusing is the safe side.
      if (Number.isFinite(last) && now() - last < HEARTBEAT_FRESH_MS) {
        return fail('collector appears to be running; stop it and wait over 60 seconds', 3);
      }
    }

    const report = backfillUsageKeys(db, root, {
      apply: args.apply,
      testHooks: env.testHooks,
      onSnapshot: args.apply
        ? (snap) => {
            const dir = dirname(dbPath);
            backupPath = join(dir, `collector.db.pre-usage-backfill-${utcStamp(now())}.bak`);
            if (existsSync(backupPath)) {
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
            try {
              const target = backupPath.replace(/'/g, "''");
              createdBackup = true;
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
