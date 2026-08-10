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
    expect(tables).toEqual([
      'anomalies',
      'daily_anomaly_rollups',
      'daily_rollups',
      'dispatches',
      'drift_log',
      'events',
      'fleet_sessions',
      'schema_meta',
      'tool_calls',
      'transcript_files',
      'usage_events',
    ]);
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

  it('migrate also creates usage_events and transcript_files, and bumps schema_meta to version 5', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual([
      'anomalies',
      'daily_anomaly_rollups',
      'daily_rollups',
      'dispatches',
      'drift_log',
      'events',
      'fleet_sessions',
      'schema_meta',
      'tool_calls',
      'transcript_files',
      'usage_events',
    ]);
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

  it('migrate also creates fleet_sessions, and bumps schema_meta to version 5', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual([
      'anomalies',
      'daily_anomaly_rollups',
      'daily_rollups',
      'dispatches',
      'drift_log',
      'events',
      'fleet_sessions',
      'schema_meta',
      'tool_calls',
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

  it('creates tool_calls, dispatches, anomalies, and daily_anomaly_rollups tables at v5', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    db.exec(`INSERT INTO tool_calls (tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms)
             VALUES ('tu_1', 'Read', 'src/foo.ts', 1000, 2000)`);
    db.exec(`INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms)
             VALUES ('tu_task_1', 5000, 3, 12000, 1000, 13000)`);
    db.exec(`INSERT INTO anomalies (kind, tool_use_id, detail, detected_at_ms)
             VALUES ('reReadLoop', 'tu_5', 'src/foo.ts read 3 times', 5000)`);
    db.exec(`INSERT INTO daily_anomaly_rollups (day, kind, anomaly_count) VALUES ('2026-07-28', 'reReadLoop', 1)`);

    const toolCall = db.prepare('SELECT * FROM tool_calls').get() as { tool_name: string };
    expect(toolCall.tool_name).toBe('Read');
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

  it('v5 migrate creates dispatches with all seven new telemetry columns', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    // Query the full column info for the dispatches table
    const columns: any[] = db
      .prepare("PRAGMA table_info(dispatches)")
      .all();

    const columnMap = new Map(columns.map((c: any) => [c.name, c]));

    // Verify all original columns exist
    expect(columnMap.has('tool_use_id')).toBe(true);
    expect(columnMap.has('tokens')).toBe(true);
    expect(columnMap.has('tool_uses')).toBe(true);
    expect(columnMap.has('duration_ms')).toBe(true);
    expect(columnMap.has('started_at_ms')).toBe(true);
    expect(columnMap.has('ended_at_ms')).toBe(true);

    // Verify the seven new columns
    expect(columnMap.has('agent_id')).toBe(true);
    expect(columnMap.get('agent_id').type).toBe('TEXT');
    expect(columnMap.get('agent_id').notnull).toBe(0); // nullable

    expect(columnMap.has('task_kind')).toBe(true);
    expect(columnMap.get('task_kind').type).toBe('TEXT');
    expect(columnMap.get('task_kind').notnull).toBe(0);

    expect(columnMap.has('session_id')).toBe(true);
    expect(columnMap.get('session_id').type).toBe('TEXT');
    expect(columnMap.get('session_id').notnull).toBe(0);

    expect(columnMap.has('retries')).toBe(true);
    expect(columnMap.get('retries').type).toBe('INTEGER');
    expect(columnMap.get('retries').notnull).toBe(1); // NOT NULL
    expect(columnMap.get('retries').dflt_value).toBe('0'); // DEFAULT 0

    expect(columnMap.has('exit_state')).toBe(true);
    expect(columnMap.get('exit_state').type).toBe('TEXT');
    expect(columnMap.get('exit_state').notnull).toBe(1); // NOT NULL
    expect(columnMap.get('exit_state').dflt_value).toBe("'ok'"); // DEFAULT 'ok'

    expect(columnMap.has('severity')).toBe(true);
    expect(columnMap.get('severity').type).toBe('INTEGER');
    expect(columnMap.get('severity').notnull).toBe(0); // nullable

    expect(columnMap.has('median_ms_at_eval')).toBe(true);
    expect(columnMap.get('median_ms_at_eval').type).toBe('INTEGER');
    expect(columnMap.get('median_ms_at_eval').notnull).toBe(0); // nullable

    db.close();
  });

  it('v5 migrate on an existing v4 DB preserves existing rows and applies defaults to new columns', () => {
    const db = openDatabase(tempDbPath());

    // Create a v4 schema manually
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dispatches (
        tool_use_id TEXT PRIMARY KEY,
        tokens INTEGER NOT NULL,
        tool_uses INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO schema_meta (key, value) VALUES ('version', '4')`
    ).run();

    // Insert some real v4 rows
    db.prepare(
      `INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('tu_old_1', 1000, 2, 5000, 100, 5100);
    db.prepare(
      `INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('tu_old_2', 2000, 3, 8000, 200, 8200);

    // Now migrate to v5
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    // Verify the rows still exist with original data
    const rows: any[] = db.prepare('SELECT * FROM dispatches ORDER BY tool_use_id').all();
    expect(rows.length).toBe(2);

    expect(rows[0].tool_use_id).toBe('tu_old_1');
    expect(rows[0].tokens).toBe(1000);
    expect(rows[0].tool_uses).toBe(2);
    expect(rows[0].duration_ms).toBe(5000);

    expect(rows[1].tool_use_id).toBe('tu_old_2');
    expect(rows[1].tokens).toBe(2000);

    // Verify defaults are applied
    expect(rows[0].agent_id).toBeNull();
    expect(rows[0].task_kind).toBeNull();
    expect(rows[0].session_id).toBeNull();
    expect(rows[0].retries).toBe(0); // DEFAULT 0
    expect(rows[0].exit_state).toBe('ok'); // DEFAULT 'ok'
    expect(rows[0].severity).toBeNull();
    expect(rows[0].median_ms_at_eval).toBeNull();

    expect(rows[1].retries).toBe(0);
    expect(rows[1].exit_state).toBe('ok');

    db.close();
  });

  it('v5 migrate is idempotent -- calling it twice does not attempt to re-add columns', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    // Calling migrate again should not throw and should not modify anything
    expect(() => migrate(db)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const columns: any[] = db.prepare("PRAGMA table_info(dispatches)").all();
    // Count should be exactly the original 6 + 7 new = 13 columns
    expect(columns.length).toBe(13);

    db.close();
  });

  it('v5 dispatches table can accept a full row with all new columns', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);

    db.prepare(
      `INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms, agent_id, task_kind, session_id, retries, exit_state, severity, median_ms_at_eval)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('tu_new_1', 5000, 4, 10000, 1000, 11000, 'ag-123', 'fetch', 'sess-1', 2, 'timeout', 2, 4500);

    const row: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu_new_1');
    expect(row.tokens).toBe(5000);
    expect(row.agent_id).toBe('ag-123');
    expect(row.task_kind).toBe('fetch');
    expect(row.session_id).toBe('sess-1');
    expect(row.retries).toBe(2);
    expect(row.exit_state).toBe('timeout');
    expect(row.severity).toBe(2);
    expect(row.median_ms_at_eval).toBe(4500);

    db.close();
  });
});

describe('schema version pin', () => {
  it('SCHEMA_VERSION is 8 -- bumping it must be deliberate', () => {
    // Every other version assertion in this file now compares against
    // SCHEMA_VERSION, so a bump does not break seven call sites. This one
    // test pins the literal, so the bump is still a conscious edit in exactly
    // one place rather than something that rides along unnoticed.
    // Bumping it means adding the matching migration block in schema.ts.
    expect(SCHEMA_VERSION).toBe(8);
  });
});

describe('healing an already-downgraded database', () => {
  it('migrates a database whose columns exist but whose recorded version was stamped back to 4', () => {
    // The state the old Go collector left behind (issue #31): physically at
    // v6/v7, recorded as 4. Both collectors then re-ran the v5 ALTERs against
    // existing columns and threw, so upgrading could not rescue an affected
    // machine -- #31's guard stopped NEW occurrences but healed nothing.
    const dir = mkdtempSync(join(tmpdir(), 'aether-heal-'));
    const db = openDatabase(join(dir, 'h.db'));
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    db.prepare("UPDATE schema_meta SET value = '4' WHERE key = 'version'").run();

    expect(() => migrate(db)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    // The columns must still be there exactly once.
    const cols = (db.prepare("SELECT name FROM pragma_table_info('dispatches')").all() as { name: string }[]).map((r) => r.name);
    expect(cols.filter((c) => c === 'agent_id')).toHaveLength(1);
    expect(cols).toContain('median_ms_at_eval');
    db.close();
  });
});
