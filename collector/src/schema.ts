import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);

export const SCHEMA_VERSION = 7;

export function openDatabase(dbPath: string): DatabaseSync {
  // Runtime-value require (not a static import) to avoid Vite transformation
  // issues with node:sqlite; the type import above is compile-time only.
  const sqlite = require('node:sqlite');
  mkdirSync(dirname(dbPath), { recursive: true });
  return new sqlite.DatabaseSync(dbPath);
}

/**
 * Columns physically present on a table, regardless of what schema_meta
 * claims. Migrations are driven off THIS, not off the recorded version.
 *
 * A database can be physically ahead of its recorded version -- the Go
 * collector used to stamp the version back to 4 on a v6/v7 database (issue
 * #31), which made the version-gated ALTERs below re-run against columns that
 * already existed and throw `duplicate column name`. That threw at
 * index.ts:49, unguarded, so an affected machine could not be rescued by
 * upgrading either collector. Checking the column set heals that state
 * instead of merely refusing to create more of it.
 */
function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, ddl: string): void {
  if (tableColumns(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hook_event_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_rel_path TEXT,
      tool_name TEXT,
      had_tool_input INTEGER NOT NULL,
      had_tool_response INTEGER NOT NULL,
      notification_type TEXT,
      occurred_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_rollups (
      day TEXT NOT NULL,
      hook_event_name TEXT NOT NULL,
      tool_name TEXT,
      event_count INTEGER NOT NULL,
      PRIMARY KEY (day, hook_event_name, tool_name)
    );
    CREATE TABLE IF NOT EXISTS drift_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      detected_at_ms INTEGER NOT NULL,
      detail TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at_ms INTEGER NOT NULL,
      model TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_creation_input_tokens INTEGER NOT NULL,
      cache_read_input_tokens INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transcript_files (
      file_path TEXT PRIMARY KEY,
      last_offset INTEGER NOT NULL,
      last_scanned_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fleet_sessions (
      session_id TEXT PRIMARY KEY,
      pid INTEGER,
      project_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      name TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      last_seen_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_use_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      file_path_rel TEXT,
      started_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dispatches (
      tool_use_id TEXT PRIMARY KEY,
      tokens INTEGER NOT NULL,
      tool_uses INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      started_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS anomalies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      tool_use_id TEXT NOT NULL,
      detail TEXT NOT NULL,
      detected_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_anomaly_rollups (
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      anomaly_count INTEGER NOT NULL,
      PRIMARY KEY (day, kind)
    );
  `);
  // Anomaly dedup: the detectors re-scan a rolling 5-minute window on every
  // ~15s scan tick, so one real anomaly is re-detected on ~20 consecutive
  // ticks. This unique index (together with the INSERT OR IGNORE in
  // anomalyIngest.ts) collapses those repeats to a single row. Duplicates
  // written by an earlier build of this branch are collapsed first so the
  // index can be created on an existing dev database. Deliberately NO
  // SCHEMA_VERSION bump: an index adds no column or table, and readers gated
  // on version >= 4 see the identical row shape.
  db.exec(`
    DELETE FROM anomalies WHERE id NOT IN (
      SELECT MIN(id) FROM anomalies GROUP BY kind, tool_use_id
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_anomalies_kind_tool_use_id
      ON anomalies (kind, tool_use_id);
  `);

  // v5 migration: add telemetry columns to dispatches table
  // Only run this migration when upgrading from schema version < 5
  const currentVersion = getSchemaVersion(db);
  // Column-driven, not version-gated -- see tableColumns above. Safe to run
  // on a database that is physically ahead of its recorded version.
  if (currentVersion < 5) {
    addColumnIfMissing(db, 'dispatches', 'agent_id', 'agent_id TEXT');
    addColumnIfMissing(db, 'dispatches', 'task_kind', 'task_kind TEXT');
    addColumnIfMissing(db, 'dispatches', 'session_id', 'session_id TEXT');
    addColumnIfMissing(db, 'dispatches', 'retries', 'retries INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'dispatches', 'exit_state', "exit_state TEXT NOT NULL DEFAULT 'ok'");
    addColumnIfMissing(db, 'dispatches', 'severity', 'severity INTEGER');
    addColumnIfMissing(db, 'dispatches', 'median_ms_at_eval', 'median_ms_at_eval INTEGER');
  }

  // v6 migration: add the source-file correlation column. Populated going
  // forward only -- rows ingested under schema < 6 keep source_file_rel NULL,
  // which readers must treat as "predates exact correlation", not "not part
  // of a dispatch". See the Task 0 reconciliation note under
  // docs/superpowers/specs/ (2026-08-07, cross-engine verification).
  if (currentVersion < 6) {
    addColumnIfMissing(db, 'tool_calls', 'source_file_rel', 'source_file_rel TEXT');
  }

  // v7 migration: flag a one-time backfill of nested subagent usage.
  //
  // Databases written before the nested loop ingested usage already hold each
  // subagent file's offset at EOF, so the fix alone replays nothing and their
  // historical spend stays missing forever. The backfill itself runs at scan
  // time (this function has no projects root to read files from) and inserts
  // usage_events ONLY.
  //
  // It deliberately does NOT rewind offsets. usage_events and tool_calls are
  // both plain INSERTs with no unique constraint -- only anomalies uses
  // INSERT OR IGNORE -- so double counting is prevented by offset tracking,
  // not by idempotency. Rewinding to replay a nested file would correct the
  // usage undercount by duplicating every tool_calls row already ingested
  // from it.
  //
  // Flagged only when nested rows actually exist: a fresh database has none,
  // so it is never marked, and a database created by a post-fix collector
  // therefore cannot be double counted by a later backfill.
  if (currentVersion < 7) {
    const nested = db
      .prepare(`SELECT COUNT(*) AS n FROM transcript_files WHERE file_path LIKE '%subagents%'`)
      .get() as { n: number };
    if (nested.n > 0) {
      db.prepare(
        `INSERT INTO schema_meta (key, value) VALUES ('subagent_usage_backfill_pending', '1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run();
    }
  }

  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(SCHEMA_VERSION));
}

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

/**
 * Stamps a heartbeat: "the collector's fleet-poll cycle is alive and
 * cycling," independent of whether the poll itself succeeded. Callers must
 * invoke this after EVERY fleet-poll cycle (success or failure) -- the
 * reader side (electron/collectorStore.ts's readFleetSessions) treats a
 * missing or stale heartbeat as "collector isn't running," which is what
 * lets stale fleet_sessions rows correctly stop rendering as live sessions
 * when the collector process itself has died or been stopped.
 */
export function stampFleetHeartbeat(db: DatabaseSync, nowMs: number): void {
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('fleet_last_poll_ms', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(nowMs));
}

/**
 * The transcript-scan cycle's equivalent of stampFleetHeartbeat: "the
 * collector's transcript scanning is alive and cycling," stamped on EVERY
 * scan tick regardless of whether the scan found or ingested anything.
 * electron/collectorStore.ts's readDiagnostics treats a missing or stale
 * value as "collector isn't running," so a dead collector stops serving
 * up-to-24h-old tool_calls/dispatches/anomalies rows as if they were current
 * activity -- the same "looks alive, isn't" failure mode the fleet heartbeat
 * closes.
 */
export function stampTranscriptScanHeartbeat(db: DatabaseSync, nowMs: number): void {
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('transcript_last_scan_ms', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(nowMs));
}
