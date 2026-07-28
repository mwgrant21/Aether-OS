import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema';
import { compact, RETENTION_WINDOW_MS } from './retention';

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
});
