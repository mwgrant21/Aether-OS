import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'node:module';
import { readRetentionStatus, purgeCollectedData } from './retentionStore.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const FULL_SCHEMA = `
  CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, hook_event_name TEXT NOT NULL, session_id TEXT NOT NULL, project_rel_path TEXT, tool_name TEXT, had_tool_input INTEGER NOT NULL, had_tool_response INTEGER NOT NULL, notification_type TEXT, occurred_at_ms INTEGER NOT NULL);
  CREATE TABLE daily_rollups (day TEXT NOT NULL, hook_event_name TEXT NOT NULL, tool_name TEXT, event_count INTEGER NOT NULL, PRIMARY KEY (day, hook_event_name, tool_name));
  CREATE TABLE drift_log (id INTEGER PRIMARY KEY AUTOINCREMENT, detected_at_ms INTEGER NOT NULL, detail TEXT NOT NULL);
  CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at_ms INTEGER NOT NULL, model TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_creation_input_tokens INTEGER NOT NULL, cache_read_input_tokens INTEGER NOT NULL);
  CREATE TABLE transcript_files (file_path TEXT PRIMARY KEY, last_offset INTEGER NOT NULL, last_scanned_ms INTEGER NOT NULL);
  CREATE TABLE fleet_sessions (session_id TEXT PRIMARY KEY, pid INTEGER, project_name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, name TEXT NOT NULL, started_at_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL);
  CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, file_path_rel TEXT, started_at_ms INTEGER NOT NULL, closed_at_ms INTEGER NOT NULL);
  CREATE TABLE dispatches (tool_use_id TEXT PRIMARY KEY, tokens INTEGER NOT NULL, tool_uses INTEGER NOT NULL, duration_ms INTEGER NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER NOT NULL);
  CREATE TABLE anomalies (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, tool_use_id TEXT NOT NULL, detail TEXT NOT NULL, detected_at_ms INTEGER NOT NULL);
  CREATE TABLE daily_anomaly_rollups (day TEXT NOT NULL, kind TEXT NOT NULL, anomaly_count INTEGER NOT NULL, PRIMARY KEY (day, kind));
`;

export function seedCollectorDb(dir: string, name = 'collector.db'): { dbPath: string; db: InstanceType<typeof DatabaseSync> } {
  const dbPath = join(dir, name);
  const db = new DatabaseSync(dbPath);
  db.exec(FULL_SCHEMA);
  return { dbPath, db };
}

describe('readRetentionStatus', () => {
  it('returns exists:false and zeroed counts when the db file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-'));
    const status = readRetentionStatus(join(dir, 'missing.db'));
    expect(status.exists).toBe(false);
    expect(status.fileSizeBytes).toBe(0);
    expect(status.oldestRetainedAtMs).toBeNull();
    expect(status.rowCounts.events).toBe(0);
  });

  it('reports row counts across every data table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-'));
    const { dbPath, db } = seedCollectorDb(dir);
    db.prepare(
      'INSERT INTO events (hook_event_name, session_id, had_tool_input, had_tool_response, occurred_at_ms) VALUES (?, ?, ?, ?, ?)'
    ).run('PreToolUse', 's1', 1, 0, 5000);
    db.prepare(
      'INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(3000, 'claude-sonnet-4-6', 10, 5, 0, 0);
    db.prepare('INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms) VALUES (?, ?, ?, ?, ?, ?)').run(
      't1', 100, 1, 500, 4000, 4500
    );
    db.close();

    const status = readRetentionStatus(dbPath);
    expect(status.exists).toBe(true);
    expect(status.rowCounts.events).toBe(1);
    expect(status.rowCounts.usageEvents).toBe(1);
    expect(status.rowCounts.dispatches).toBe(1);
    expect(status.rowCounts.anomalies).toBe(0);
    expect(status.fileSizeBytes).toBeGreaterThan(0);
  });

  it('computes oldestRetainedAtMs as the earliest row across events/usage_events/dispatches/tool_calls/anomalies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-'));
    const { dbPath, db } = seedCollectorDb(dir);
    db.prepare(
      'INSERT INTO events (hook_event_name, session_id, had_tool_input, had_tool_response, occurred_at_ms) VALUES (?, ?, ?, ?, ?)'
    ).run('PreToolUse', 's1', 1, 0, 9000);
    db.prepare(
      'INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(2000, null, 1, 1, 0, 0); // earliest
    db.prepare('INSERT INTO anomalies (kind, tool_use_id, detail, detected_at_ms) VALUES (?, ?, ?, ?)').run('slow', 't1', '{}', 7000);
    db.close();

    const status = readRetentionStatus(dbPath);
    expect(status.oldestRetainedAtMs).toBe(2000);
  });

  it('returns oldestRetainedAtMs:null when every raw table is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-'));
    const { dbPath, db } = seedCollectorDb(dir);
    db.close();

    const status = readRetentionStatus(dbPath);
    expect(status.exists).toBe(true);
    expect(status.oldestRetainedAtMs).toBeNull();
  });

  it('never throws against a malformed/corrupt database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-corrupt-'));
    const dbPath = join(dir, 'test.db');
    require('fs').writeFileSync(dbPath, 'not a real sqlite file');
    expect(() => readRetentionStatus(dbPath)).not.toThrow();
  });
});

describe('purgeCollectedData', () => {
  it('deletes every row in every data table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-purge-'));
    const { dbPath, db } = seedCollectorDb(dir);
    db.prepare(
      'INSERT INTO events (hook_event_name, session_id, had_tool_input, had_tool_response, occurred_at_ms) VALUES (?, ?, ?, ?, ?)'
    ).run('PreToolUse', 's1', 1, 0, 1000);
    db.prepare('INSERT INTO daily_rollups (day, hook_event_name, tool_name, event_count) VALUES (?, ?, ?, ?)').run(
      '2026-08-11', 'PreToolUse', '', 5
    );
    db.prepare('INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms) VALUES (?, ?, ?, ?, ?, ?)').run(
      't1', 100, 1, 500, 1000, 1500
    );
    db.prepare('INSERT INTO anomalies (kind, tool_use_id, detail, detected_at_ms) VALUES (?, ?, ?, ?)').run('slow', 't1', '{}', 1200);

    // Precondition: confirm the seed actually landed before asserting the purge cleared it.
    const before = readRetentionStatus(dbPath);
    expect(before.rowCounts.events).toBe(1);
    expect(before.rowCounts.dailyRollups).toBe(1);
    expect(before.rowCounts.dispatches).toBe(1);
    expect(before.rowCounts.anomalies).toBe(1);
    db.close();

    const result = purgeCollectedData(dbPath);
    expect(result.ok).toBe(true);

    const after = readRetentionStatus(dbPath);
    expect(after.rowCounts.events).toBe(0);
    expect(after.rowCounts.dailyRollups).toBe(0);
    expect(after.rowCounts.dispatches).toBe(0);
    expect(after.rowCounts.anomalies).toBe(0);
  });

  // The load-bearing regression test named in the design spec: wiping
  // transcript_files alongside the data tables would reset every scan
  // cursor to "unread," and the collector's very next scan tick would
  // replay full transcript history and silently re-populate everything
  // this test just confirmed was deleted.
  it('preserves transcript_files rows exactly, unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-purge-'));
    const { dbPath, db } = seedCollectorDb(dir);
    db.prepare('INSERT INTO transcript_files (file_path, last_offset, last_scanned_ms) VALUES (?, ?, ?)').run(
      '/home/user/.claude/projects/foo/session1.jsonl', 48213, 9999
    );
    db.close();

    purgeCollectedData(dbPath);

    const db2 = new DatabaseSync(dbPath, { readOnly: true });
    const row = db2.prepare('SELECT last_offset, last_scanned_ms FROM transcript_files WHERE file_path = ?').get(
      '/home/user/.claude/projects/foo/session1.jsonl'
    ) as { last_offset: number; last_scanned_ms: number };
    db2.close();
    expect(row.last_offset).toBe(48213);
    expect(row.last_scanned_ms).toBe(9999);
  });

  it('preserves schema_meta rows exactly, unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-purge-'));
    const { dbPath, db } = seedCollectorDb(dir);
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', '6')").run();
    db.close();

    purgeCollectedData(dbPath);

    const db2 = new DatabaseSync(dbPath, { readOnly: true });
    const row = db2.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string };
    db2.close();
    expect(row.value).toBe('6');
  });

  it('never opens or modifies a separate memory.db file in the same directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-purge-'));
    const { dbPath } = seedCollectorDb(dir, 'collector.db');
    const memDbPath = join(dir, 'memory.db');
    const memDb = new DatabaseSync(memDbPath);
    memDb.exec('CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT NOT NULL)');
    memDb.prepare('INSERT INTO memories (content) VALUES (?)').run('a real memory decision');
    memDb.close();

    purgeCollectedData(dbPath);

    const memDb2 = new DatabaseSync(memDbPath, { readOnly: true });
    const row = memDb2.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number };
    memDb2.close();
    expect(row.c).toBe(1);
  });

  it('reduces the on-disk file size after deleting rows (VACUUM actually ran)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-purge-'));
    const { dbPath, db } = seedCollectorDb(dir);
    const insert = db.prepare(
      'INSERT INTO events (hook_event_name, session_id, had_tool_input, had_tool_response, occurred_at_ms) VALUES (?, ?, ?, ?, ?)'
    );
    for (let i = 0; i < 500; i++) insert.run('PreToolUse', `s${i}`, 1, 0, i);
    db.close();

    const before = readRetentionStatus(dbPath).fileSizeBytes;
    purgeCollectedData(dbPath);
    const after = readRetentionStatus(dbPath).fileSizeBytes;
    expect(after).toBeLessThan(before);
  });

  it('is a no-op that returns ok:true when the db file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-purge-'));
    const result = purgeCollectedData(join(dir, 'missing.db'));
    expect(result.ok).toBe(true);
  });

  // Regression test: VACUUM failure after COMMIT succeeds must not be reported as purge failure,
  // since the data deletion is already permanent at that point.
  it('returns ok:true and preserves data deletion even if VACUUM fails after COMMIT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-purge-'));
    const { dbPath, db } = seedCollectorDb(dir);
    db.prepare(
      'INSERT INTO events (hook_event_name, session_id, had_tool_input, had_tool_response, occurred_at_ms) VALUES (?, ?, ?, ?, ?)'
    ).run('PreToolUse', 's1', 1, 0, 1000);
    db.close();

    // Wrap DatabaseSync to simulate VACUUM failure after COMMIT succeeds
    const OriginalDatabaseSync = DatabaseSync;
    let commitSucceeded = false;
    class MockDatabaseSync extends OriginalDatabaseSync {
      exec(sql: string) {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed === 'COMMIT') {
          commitSucceeded = true;
          // Let COMMIT succeed
          super.exec(sql);
        } else if (trimmed === 'VACUUM' && commitSucceeded) {
          // Simulate transient SQLITE_BUSY after COMMIT
          throw new Error('database is locked');
        } else {
          // All other commands pass through
          super.exec(sql);
        }
      }
    }

    // Temporarily replace the require cache
    const sqlite = require('node:sqlite');
    const OriginalConstructor = sqlite.DatabaseSync;
    sqlite.DatabaseSync = MockDatabaseSync;

    try {
      const result = purgeCollectedData(dbPath);
      // Even though VACUUM threw, purge should succeed because COMMIT already succeeded
      expect(result.ok).toBe(true);
      expect(commitSucceeded).toBe(true);

      // Verify data is actually gone
      const after = readRetentionStatus(dbPath);
      expect(after.rowCounts.events).toBe(0);
    } finally {
      sqlite.DatabaseSync = OriginalConstructor;
    }
  });
});
