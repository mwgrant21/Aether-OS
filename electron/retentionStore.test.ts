import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'node:module';
import { readRetentionStatus } from './retentionStore.js';

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
