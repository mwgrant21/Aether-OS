import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema.js';
import { compact, RETENTION_WINDOW_MS } from './retention.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-retention-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return db;
}

function insertEvent(db: any, occurredAtMs: number, toolName: string) {
  db.prepare(
    `INSERT INTO events (hook_event_name, session_id, project_rel_path, tool_name, had_tool_input, had_tool_response, notification_type, occurred_at_ms)
     VALUES ('PreToolUse', 's1', NULL, ?, 1, 0, NULL, ?)`
  ).run(toolName, occurredAtMs);
}

function insertEventNoTool(db: any, hookEventName: string, occurredAtMs: number) {
  db.prepare(
    `INSERT INTO events (hook_event_name, session_id, project_rel_path, tool_name, had_tool_input, had_tool_response, notification_type, occurred_at_ms)
     VALUES (?, 's1', NULL, NULL, 0, 0, NULL, ?)`
  ).run(hookEventName, occurredAtMs);
}

describe('compact', () => {
  it('rolls up and deletes rows older than the retention window, leaving recent rows untouched', () => {
    const db = freshDb();
    const now = Date.parse('2026-08-01T00:00:00Z');
    const oldDay = Date.parse('2026-06-01T10:00:00Z'); // well past 30 days
    const recentDay = now - 60_000; // 1 minute ago

    insertEvent(db, oldDay, 'Bash');
    insertEvent(db, oldDay, 'Bash');
    insertEvent(db, oldDay, 'Read');
    insertEvent(db, recentDay, 'Bash');

    const result = compact(db, now);
    expect(result.rolledUpDays).toBe(1);
    expect(result.deletedRows).toBe(3);

    const remaining = db.prepare('SELECT COUNT(*) as c FROM events').get() as any;
    expect(remaining.c).toBe(1); // only the recent row survives

    const rollups = db.prepare('SELECT * FROM daily_rollups ORDER BY tool_name').all() as any[];
    expect(rollups).toEqual([
      { day: '2026-06-01', hook_event_name: 'PreToolUse', tool_name: 'Bash', event_count: 2 },
      { day: '2026-06-01', hook_event_name: 'PreToolUse', tool_name: 'Read', event_count: 1 },
    ]);
    db.close();
  });

  it('is idempotent -- calling compact twice does not duplicate or change rollup counts', () => {
    const db = freshDb();
    const now = Date.parse('2026-08-01T00:00:00Z');
    const oldDay = Date.parse('2026-06-01T10:00:00Z');
    insertEvent(db, oldDay, 'Bash');

    compact(db, now);
    const second = compact(db, now);
    expect(second.rolledUpDays).toBe(0); // nothing left to roll up
    expect(second.deletedRows).toBe(0);

    const rollups = db.prepare('SELECT event_count FROM daily_rollups').all() as any[];
    expect(rollups).toEqual([{ event_count: 1 }]);
    db.close();
  });

  it('leaves a day with no events past the window untouched (no rollup row, nothing to delete)', () => {
    const db = freshDb();
    const now = Date.parse('2026-08-01T00:00:00Z');
    const result = compact(db, now);
    expect(result).toEqual({ rolledUpDays: 0, deletedRows: 0 });
    db.close();
  });

  it('RETENTION_WINDOW_MS is exactly 30 days', () => {
    expect(RETENTION_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('dedupes daily_rollups for events with a NULL tool_name (Stop/Notification) across repeated compaction', () => {
    // Regression test: SQLite treats NULL as distinct from every other NULL in a
    // PRIMARY KEY, so ON CONFLICT(day, hook_event_name, tool_name) never fired
    // when tool_name was left as raw null, producing duplicate rollup rows on a
    // second compact() call. tool_name must be normalized to '' before it is
    // ever written to daily_rollups.
    const db = freshDb();
    const now = Date.parse('2026-08-01T00:00:00Z');
    const oldDay1 = Date.parse('2026-06-01T10:00:00Z');
    const oldDay2 = Date.parse('2026-06-01T11:00:00Z');

    insertEventNoTool(db, 'Stop', oldDay1);
    const first = compact(db, now);
    expect(first.rolledUpDays).toBe(1);
    expect(first.deletedRows).toBe(1);

    // A second, later compaction with more stale events on the SAME day/event
    // must merge into the existing rollup row, not create a duplicate.
    insertEventNoTool(db, 'Stop', oldDay2);
    const second = compact(db, now);
    expect(second.rolledUpDays).toBe(1);
    expect(second.deletedRows).toBe(1);

    const rollups = db
      .prepare("SELECT * FROM daily_rollups WHERE day = '2026-06-01' AND hook_event_name = 'Stop'")
      .all() as any[];
    expect(rollups).toEqual([{ day: '2026-06-01', hook_event_name: 'Stop', tool_name: '', event_count: 2 }]);
    db.close();
  });

  it('deletes drift_log rows older than the retention window, leaving recent ones untouched', () => {
    // Regression test: fleet-poll failures (Task 5's pollFleet) can write a
    // drift_log row every 15s indefinitely on a sustained failure, unlike
    // the pre-existing rare hook-payload-drift writes this table was
    // originally sized for. drift_log needs the same 30-day retention
    // events already has, or it grows unbounded.
    const db = freshDb();
    const now = Date.parse('2026-08-01T00:00:00Z');
    const oldDay = Date.parse('2026-06-01T10:00:00Z'); // well past 30 days
    const recent = now - 60_000; // 1 minute ago

    db.prepare('INSERT INTO drift_log (detected_at_ms, detail) VALUES (?, ?)').run(oldDay, 'old drift');
    db.prepare('INSERT INTO drift_log (detected_at_ms, detail) VALUES (?, ?)').run(recent, 'recent drift');

    compact(db, now);

    const rows = db.prepare('SELECT detail FROM drift_log ORDER BY detected_at_ms').all() as any[];
    expect(rows).toEqual([{ detail: 'recent drift' }]);
    db.close();
  });

  it('deletes stale drift_log rows even when there are zero stale events rows this cycle', () => {
    // Regression test for the early-return trap: compact() used to return
    // immediately when `events` had no stale rows, which would have
    // skipped the drift_log deletion entirely on a cycle where only
    // drift_log (not events) had aged-out rows.
    const db = freshDb();
    const now = Date.parse('2026-08-01T00:00:00Z');
    const oldDay = Date.parse('2026-06-01T10:00:00Z');

    db.prepare('INSERT INTO drift_log (detected_at_ms, detail) VALUES (?, ?)').run(oldDay, 'old drift');

    const result = compact(db, now);
    expect(result).toEqual({ rolledUpDays: 0, deletedRows: 0 });

    const count: any = db.prepare('SELECT COUNT(*) as c FROM drift_log').get();
    expect(count.c).toBe(0);
    db.close();
  });

  it('rolls up anomalies into daily_anomaly_rollups and deletes stale tool_calls/dispatches unconditionally', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const oldMs = Date.now() - RETENTION_WINDOW_MS - 1000;

    db.exec(`INSERT INTO anomalies (kind, tool_use_id, detail, detected_at_ms) VALUES ('reReadLoop', 'tu_1', 'x', ${oldMs})`);
    db.exec(`INSERT INTO tool_calls (tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms) VALUES ('tu_2', 'Read', 'a.ts', ${oldMs}, ${oldMs})`);
    db.exec(`INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms) VALUES ('tu_3', 100, 1, 500, ${oldMs}, ${oldMs})`);

    compact(db, Date.now());

    expect((db.prepare('SELECT COUNT(*) as c FROM anomalies').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) as c FROM tool_calls').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) as c FROM dispatches').get() as { c: number }).c).toBe(0);
    const rollup = db.prepare("SELECT anomaly_count FROM daily_anomaly_rollups WHERE kind = 'reReadLoop'").get() as { anomaly_count: number };
    expect(rollup.anomaly_count).toBe(1);

    db.close();
  });
});
