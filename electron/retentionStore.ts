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
  fileSizeBytes: number;
  oldestRetainedAtMs: number | null;
  rowCounts: RetentionRowCounts;
}

function openReadOnly(dbPath: string): DatabaseSync | null {
  if (!existsSync(dbPath)) return null;
  try {
    const sqlite = require('node:sqlite');
    return new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
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

const EMPTY_STATUS: RetentionStatus = {
  exists: false,
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

export function readRetentionStatus(dbPath: string): RetentionStatus {
  const db = openReadOnly(dbPath);
  if (!db) return EMPTY_STATUS;

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

    // Oldest live row across every RAW table -- rollup tables (daily_rollups,
    // daily_anomaly_rollups) are keyed by day string, not a row timestamp,
    // and are already represented by these tables' own oldest row before
    // compaction ages it out.
    const candidates = [
      minOf(db, 'events', 'occurred_at_ms'),
      minOf(db, 'usage_events', 'occurred_at_ms'),
      minOf(db, 'dispatches', 'started_at_ms'),
      minOf(db, 'tool_calls', 'started_at_ms'),
      minOf(db, 'anomalies', 'detected_at_ms'),
    ].filter((v): v is number => v !== null);

    const oldestRetainedAtMs = candidates.length > 0 ? Math.min(...candidates) : null;

    return { exists: true, fileSizeBytes, oldestRetainedAtMs, rowCounts };
  } catch {
    return EMPTY_STATUS;
  } finally {
    db.close();
  }
}
