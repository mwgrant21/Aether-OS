import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';

const require = createRequire(import.meta.url);

export interface RetentionRowCounts {
  events: number;
  dailyRollups: number;
  usageEvents: number;
  toolCalls: number;
  dispatches: number;
  anomalies: number;
  dailyAnomalyRollups: number;
  driftLog: number;
  fleetSessions: number;
}

export interface RetentionStatus {
  exists: boolean;
  // False only when exists:true and the file could not be read (corruption,
  // permissions, mid-write lock, etc). A missing file is exists:false,
  // readable:true -- "readable" only speaks to files that are actually there.
  // Callers must not render exists:false and (exists:true, readable:false)
  // the same way: one means "no data yet," the other means "there is data
  // here but we can't currently show it to you," and conflating them
  // overclaims the retention card's visibility guarantee.
  readable: boolean;
  fileSizeBytes: number;
  oldestRetainedAtMs: number | null;
  rowCounts: RetentionRowCounts;
}

export interface PurgeResult {
  ok: boolean;
  error?: string;
}

// Distinguishes "no file at this path" from "file is there but couldn't be
// opened" -- the caller needs both, not just a collapsed null.
function openReadOnly(dbPath: string): DatabaseSync | 'missing' | 'unreadable' {
  if (!existsSync(dbPath)) return 'missing';
  try {
    const sqlite = require('node:sqlite');
    return new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return 'unreadable';
  }
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
  return row.c;
}

// Returns null (not 0) so an empty table never masquerades as "oldest row at
// epoch 0" in the Math.min() below.
function minOf(db: DatabaseSync, table: string, column: string): number | null {
  const row = db.prepare(`SELECT MIN(${column}) as m FROM ${table}`).get() as { m: number | null };
  return row.m;
}

// Rollup tables are keyed by a UTC day string ('YYYY-MM-DD', written by
// collector-go's dayKeyUtc), not a row timestamp. MIN() over TEXT is a
// lexicographic compare, which for zero-padded ISO dates is also chronological.
// Midnight UTC is the earliest instant that day can represent, so it is the
// correct lower bound for "oldest retained".
function minDayMsOf(db: DatabaseSync, table: string): number | null {
  const row = db.prepare(`SELECT MIN(day) as m FROM ${table}`).get() as { m: string | null };
  if (row.m === null) return null;
  const ms = Date.parse(`${row.m}T00:00:00Z`);
  // A malformed day string would yield NaN and silently poison Math.min, which
  // is exactly the kind of quiet wrongness this readout must not have.
  return Number.isFinite(ms) ? ms : null;
}

const EMPTY_STATUS: RetentionStatus = {
  exists: false,
  readable: true,
  fileSizeBytes: 0,
  oldestRetainedAtMs: null,
  rowCounts: {
    events: 0,
    dailyRollups: 0,
    usageEvents: 0,
    toolCalls: 0,
    dispatches: 0,
    anomalies: 0,
    dailyAnomalyRollups: 0,
    driftLog: 0,
    fleetSessions: 0,
  },
};

// Same zeroed shape as EMPTY_STATUS, but exists:true -- the file is there,
// it just couldn't be read. See RetentionStatus.readable for why this must
// stay distinguishable from EMPTY_STATUS at the call site.
const UNREADABLE_STATUS: RetentionStatus = { ...EMPTY_STATUS, exists: true, readable: false };

export function readRetentionStatus(dbPath: string): RetentionStatus {
  const db = openReadOnly(dbPath);
  if (db === 'missing') return EMPTY_STATUS;
  if (db === 'unreadable') return UNREADABLE_STATUS;

  try {
    const fileSizeBytes = statSync(dbPath).size;
    const rowCounts: RetentionRowCounts = {
      events: countRows(db, 'events'),
      dailyRollups: countRows(db, 'daily_rollups'),
      usageEvents: countRows(db, 'usage_events'),
      toolCalls: countRows(db, 'tool_calls'),
      dispatches: countRows(db, 'dispatches'),
      anomalies: countRows(db, 'anomalies'),
      dailyAnomalyRollups: countRows(db, 'daily_anomaly_rollups'),
      driftLog: countRows(db, 'drift_log'),
      fleetSessions: countRows(db, 'fleet_sessions'),
    };

    // Oldest live row across EVERY retained table, raw and aggregate alike.
    //
    // Raw tables alone are not enough, and the earlier "rollups are already
    // represented by these tables' own oldest row before compaction ages it
    // out" reasoning carried its own refutation in that final clause. Once
    // collector-go's retention.Compact runs, the raw rows ARE aged out while
    // daily_rollups / daily_anomaly_rollups survive by design --
    // docs/privacy-and-data.md: "Aggregates survive, event rows age out." A
    // raw-only reading therefore jumps forward, or reports null, while older
    // aggregates sit on disk and are counted in rowCounts. Understating the
    // age of retained data in the privacy readout is the one thing this
    // number must never do; it is the same honesty constraint the Ledger
    // applies when it renders a missing period as a gap rather than $0.00.
    //
    // drift_log and fleet_sessions are included for a second reason: both are
    // timestamped and both are already counted in rowCounts, so omitting them
    // made this function internally inconsistent. fleet_sessions matters most
    // -- retention.Compact has no `DELETE FROM fleet_sessions` at all, so its
    // rows are never aged out and can be the genuinely oldest data in the store.
    const candidates = [
      minOf(db, 'events', 'occurred_at_ms'),
      minOf(db, 'usage_events', 'occurred_at_ms'),
      minOf(db, 'dispatches', 'started_at_ms'),
      minOf(db, 'tool_calls', 'started_at_ms'),
      minOf(db, 'anomalies', 'detected_at_ms'),
      minOf(db, 'drift_log', 'detected_at_ms'),
      minOf(db, 'fleet_sessions', 'started_at_ms'),
      minDayMsOf(db, 'daily_rollups'),
      minDayMsOf(db, 'daily_anomaly_rollups'),
    ].filter((v): v is number => v !== null);

    const oldestRetainedAtMs = candidates.length > 0 ? Math.min(...candidates) : null;

    return { exists: true, readable: true, fileSizeBytes, oldestRetainedAtMs, rowCounts };
  } catch {
    // File opened but reading it (statSync, a table missing/corrupt mid-schema,
    // etc) blew up -- same "exists but unreadable" case as a failed open above.
    return UNREADABLE_STATUS;
  } finally {
    db.close();
  }
}

// Order doesn't matter -- no foreign keys are declared in schema.ts, so
// there's no delete-order constraint between these tables.
const PURGE_TABLES = [
  'events',
  'daily_rollups',
  'drift_log',
  'usage_events',
  'fleet_sessions',
  'tool_calls',
  'dispatches',
  'anomalies',
  'daily_anomaly_rollups',
] as const;

export function purgeCollectedData(dbPath: string): PurgeResult {
  if (!existsSync(dbPath)) return { ok: true };

  let db: DatabaseSync | null = null;
  try {
    const sqlite = require('node:sqlite');
    // A second, separate writable connection -- collectorStore.ts/main.ts's
    // read-only handles are untouched. busy_timeout is set explicitly here
    // because schema.ts's openDatabase() (the Node collector's own
    // connection) never sets one on collector.db, unlike memory.db and the
    // Go backend -- without this, a purge landing mid-collector-write would
    // fail immediately instead of retrying.
    db = new sqlite.DatabaseSync(dbPath) as DatabaseSync;
    db.exec('PRAGMA busy_timeout = 5000');

    // Transaction: BEGIN/DELETE/COMMIT. If any step fails, roll back and report error.
    // Once COMMIT succeeds, the data deletion is permanent.
    try {
      db.exec('BEGIN');
      for (const table of PURGE_TABLES) {
        db.exec(`DELETE FROM ${table}`);
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // No transaction was open (e.g. BEGIN itself failed) -- nothing to roll back.
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // VACUUM is disk-reclamation housekeeping after deletion succeeded. If it fails
    // (e.g., transient SQLITE_BUSY), the purge already succeeded and the data is
    // already gone -- swallow the error and return ok:true. Do not conflate VACUUM
    // housekeeping failure with purge failure.
    try {
      db.exec('VACUUM');
    } catch {
      // VACUUM failure after successful COMMIT is not purge failure.
    }

    return { ok: true };
  } catch (err) {
    // Catch connection-open, PRAGMA setup, or any other pre-COMMIT failures.
    // This does NOT catch transaction errors (inner try/catch returns) or VACUUM
    // errors (own try/catch swallows), only pre-COMMIT setup failures.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    db?.close();
  }
}
