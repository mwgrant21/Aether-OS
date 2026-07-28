import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);

export const SCHEMA_VERSION = 3;

export function openDatabase(dbPath: string): DatabaseSync {
  // Runtime-value require (not a static import) to avoid Vite transformation
  // issues with node:sqlite; the type import above is compile-time only.
  const sqlite = require('node:sqlite');
  mkdirSync(dirname(dbPath), { recursive: true });
  return new sqlite.DatabaseSync(dbPath);
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
  `);
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
