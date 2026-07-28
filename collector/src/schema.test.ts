import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate, getSchemaVersion, SCHEMA_VERSION, stampFleetHeartbeat } from './schema.js';

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
    expect(tables).toEqual(['daily_rollups', 'drift_log', 'events', 'fleet_sessions', 'schema_meta', 'transcript_files', 'usage_events']);
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

  it('migrate also creates usage_events and transcript_files, and bumps schema_meta to version 3', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    expect(getSchemaVersion(db)).toBe(3);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual(['daily_rollups', 'drift_log', 'events', 'fleet_sessions', 'schema_meta', 'transcript_files', 'usage_events']);
    db.close();
  });

  it('usage_events accepts a full row insert', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    db.prepare(
      `INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(1000, 'claude-sonnet-4-6', 100, 50, 0, 200);
    const row: any = db.prepare('SELECT * FROM usage_events').get();
    expect(row.model).toBe('claude-sonnet-4-6');
    expect(row.input_tokens).toBe(100);
    db.close();
  });

  it('transcript_files tracks a per-file offset, upsertable by file_path', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    db.prepare(
      `INSERT INTO transcript_files (file_path, last_offset, last_scanned_ms) VALUES (?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET last_offset = excluded.last_offset, last_scanned_ms = excluded.last_scanned_ms`
    ).run('/proj/session.jsonl', 500, 1000);
    db.prepare(
      `INSERT INTO transcript_files (file_path, last_offset, last_scanned_ms) VALUES (?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET last_offset = excluded.last_offset, last_scanned_ms = excluded.last_scanned_ms`
    ).run('/proj/session.jsonl', 900, 2000);
    const row: any = db.prepare('SELECT * FROM transcript_files').get();
    expect(row.last_offset).toBe(900);
    const count: any = db.prepare('SELECT COUNT(*) as c FROM transcript_files').get();
    expect(count.c).toBe(1);
    db.close();
  });

  it('migrate also creates fleet_sessions, and bumps schema_meta to version 3', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    expect(getSchemaVersion(db)).toBe(3);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual([
      'daily_rollups',
      'drift_log',
      'events',
      'fleet_sessions',
      'schema_meta',
      'transcript_files',
      'usage_events',
    ]);
    db.close();
  });

  it('fleet_sessions accepts a full row insert, with pid nullable', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    db.prepare(
      `INSERT INTO fleet_sessions (session_id, pid, project_name, kind, status, name, started_at_ms, last_seen_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('sess-1', 6824, 'IT', 'interactive', 'busy', 'it-68', 1000, 2000);
    const row: any = db.prepare('SELECT * FROM fleet_sessions').get();
    expect(row.session_id).toBe('sess-1');
    expect(row.pid).toBe(6824);

    db.prepare(
      `INSERT INTO fleet_sessions (session_id, pid, project_name, kind, status, name, started_at_ms, last_seen_ms)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`
    ).run('sess-2', 'proj', 'background', 'idle', 'bg-1', 3000, 4000);
    const row2: any = db.prepare('SELECT pid FROM fleet_sessions WHERE session_id = ?').get('sess-2');
    expect(row2.pid).toBeNull();
    db.close();
  });

  it('fleet_sessions is upsertable by session_id', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    const upsert = db.prepare(
      `INSERT INTO fleet_sessions (session_id, pid, project_name, kind, status, name, started_at_ms, last_seen_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET status = excluded.status, last_seen_ms = excluded.last_seen_ms`
    );
    upsert.run('sess-1', 1, 'IT', 'interactive', 'busy', 'it-68', 1000, 2000);
    upsert.run('sess-1', 1, 'IT', 'interactive', 'idle', 'it-68', 1000, 5000);
    const row: any = db.prepare('SELECT * FROM fleet_sessions').get();
    expect(row.status).toBe('idle');
    expect(row.last_seen_ms).toBe(5000);
    const count: any = db.prepare('SELECT COUNT(*) as c FROM fleet_sessions').get();
    expect(count.c).toBe(1);
    db.close();
  });

  it('stampFleetHeartbeat writes fleet_last_poll_ms to schema_meta and upserts on repeated calls', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    stampFleetHeartbeat(db, 1000);
    let row: any = db.prepare("SELECT value FROM schema_meta WHERE key = 'fleet_last_poll_ms'").get();
    expect(row.value).toBe('1000');

    stampFleetHeartbeat(db, 2000);
    row = db.prepare("SELECT value FROM schema_meta WHERE key = 'fleet_last_poll_ms'").get();
    expect(row.value).toBe('2000');

    const count: any = db
      .prepare("SELECT COUNT(*) as c FROM schema_meta WHERE key = 'fleet_last_poll_ms'")
      .get();
    expect(count.c).toBe(1);
    db.close();
  });
});
