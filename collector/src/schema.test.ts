import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate, getSchemaVersion, SCHEMA_VERSION } from './schema.js';

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-schema-'));
  return join(dir, 'test.db');
}

describe('schema', () => {
  it('creates all expected tables and the version row on first migrate', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual(['daily_rollups', 'drift_log', 'events', 'schema_meta']);
    db.close();
  });

  it('migrate is idempotent -- calling it twice does not throw or duplicate the version row', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    migrate(db);
    const rows = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").all();
    expect(rows.length).toBe(1);
    db.close();
  });

  it('events table accepts a full row insert with the documented columns', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    db.prepare(
      `INSERT INTO events (hook_event_name, session_id, project_rel_path, tool_name, had_tool_input, had_tool_response, notification_type, occurred_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('PreToolUse', 'sess-1', 'src/index.ts', 'Bash', 1, 0, null, 1000);
    const row: any = db.prepare('SELECT * FROM events').get();
    expect(row.hook_event_name).toBe('PreToolUse');
    expect(row.had_tool_input).toBe(1);
    db.close();
  });
});
