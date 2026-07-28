import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'node:module';
import { readUsageEventsSince, readFleetSessions } from './collectorStore.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

function tempDbWithUsageEvents(rows: { occurred_at_ms: number; model: string | null; input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }[], schemaVersion = 2): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collectorstore-'));
  const dbPath = join(dir, 'test.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at_ms INTEGER NOT NULL, model TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_creation_input_tokens INTEGER NOT NULL, cache_read_input_tokens INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)").run(String(schemaVersion));
  const insert = db.prepare(
    'INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const r of rows) {
    insert.run(r.occurred_at_ms, r.model, r.input_tokens, r.output_tokens, r.cache_creation_input_tokens, r.cache_read_input_tokens);
  }
  db.close();
  return dbPath;
}

describe('readUsageEventsSince', () => {
  it('returns mapped events at or after sinceMs, sorted or not (callers do not depend on order)', () => {
    const dbPath = tempDbWithUsageEvents([
      { occurred_at_ms: 1000, model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 },
      { occurred_at_ms: 2000, model: null, input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ]);
    const events = readUsageEventsSince(dbPath, 0);
    expect(events).not.toBeNull();
    expect(events!.length).toBe(2);
    expect(events![0]).toEqual({
      kind: 'assistant',
      timestamp: new Date(1000),
      usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 10 },
    });
  });

  it('excludes events strictly before sinceMs', () => {
    const dbPath = tempDbWithUsageEvents([
      { occurred_at_ms: 1000, model: null, input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      { occurred_at_ms: 5000, model: null, input_tokens: 2, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ]);
    const events = readUsageEventsSince(dbPath, 3000);
    expect(events!.length).toBe(1);
    expect(events![0].timestamp).toEqual(new Date(5000));
  });

  it('returns null when the database file does not exist', () => {
    const missingPath = join(tmpdir(), 'aether-collectorstore-missing-' + Date.now(), 'test.db');
    expect(readUsageEventsSince(missingPath, 0)).toBeNull();
  });

  it('returns null when schema_meta version is below 2', () => {
    const dbPath = tempDbWithUsageEvents([], 1);
    expect(readUsageEventsSince(dbPath, 0)).toBeNull();
  });

  it('never throws even against a malformed/corrupt database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-collectorstore-corrupt-'));
    const dbPath = join(dir, 'test.db');
    require('fs').writeFileSync(dbPath, 'not a real sqlite file');
    expect(() => readUsageEventsSince(dbPath, 0)).not.toThrow();
    expect(readUsageEventsSince(dbPath, 0)).toBeNull();
  });
});

// heartbeatMs defaults to "now" (fresh) so every pre-existing test that
// doesn't care about the heartbeat still gets a live-collector reading.
// Pass null to omit the heartbeat row entirely (simulating a collector that
// predates this fix, or has never completed a fleet-poll cycle).
function tempDbWithFleetSessions(
  rows: { session_id: string; pid: number | null; project_name: string; kind: string; status: string; name: string; started_at_ms: number; last_seen_ms: number }[],
  schemaVersion = 3,
  heartbeatMs: number | null = Date.now()
): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collectorstore-fleet-'));
  const dbPath = join(dir, 'test.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE fleet_sessions (session_id TEXT PRIMARY KEY, pid INTEGER, project_name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, name TEXT NOT NULL, started_at_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)").run(String(schemaVersion));
  if (heartbeatMs !== null) {
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('fleet_last_poll_ms', ?)").run(String(heartbeatMs));
  }
  const insert = db.prepare(
    'INSERT INTO fleet_sessions (session_id, pid, project_name, kind, status, name, started_at_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const r of rows) {
    insert.run(r.session_id, r.pid, r.project_name, r.kind, r.status, r.name, r.started_at_ms, r.last_seen_ms);
  }
  db.close();
  return dbPath;
}

describe('readFleetSessions', () => {
  it('returns mapped fleet session rows', () => {
    const dbPath = tempDbWithFleetSessions([
      { session_id: 's1', pid: 100, project_name: 'proj', kind: 'interactive', status: 'busy', name: 'it-1', started_at_ms: 1000, last_seen_ms: 2000 },
    ]);
    const rows = readFleetSessions(dbPath);
    expect(rows).toEqual([
      { sessionId: 's1', pid: 100, projectName: 'proj', kind: 'interactive', status: 'busy', name: 'it-1', startedAtMs: 1000 },
    ]);
  });

  it('returns an empty array (not null) when the table exists but has zero rows', () => {
    const dbPath = tempDbWithFleetSessions([]);
    expect(readFleetSessions(dbPath)).toEqual([]);
  });

  it('maps a null pid through as null', () => {
    const dbPath = tempDbWithFleetSessions([
      { session_id: 's1', pid: null, project_name: 'proj', kind: 'background', status: 'idle', name: 'it-1', started_at_ms: 1000, last_seen_ms: 2000 },
    ]);
    expect(readFleetSessions(dbPath)![0].pid).toBeNull();
  });

  it('returns null when the database file does not exist', () => {
    const missingPath = join(tmpdir(), 'aether-collectorstore-fleet-missing-' + Date.now(), 'test.db');
    expect(readFleetSessions(missingPath)).toBeNull();
  });

  it('returns null when schema_meta version is below 3', () => {
    const dbPath = tempDbWithFleetSessions([], 2);
    expect(readFleetSessions(dbPath)).toBeNull();
  });

  it('never throws even against a malformed/corrupt database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-collectorstore-fleet-corrupt-'));
    const dbPath = join(dir, 'test.db');
    require('fs').writeFileSync(dbPath, 'not a real sqlite file');
    expect(() => readFleetSessions(dbPath)).not.toThrow();
    expect(readFleetSessions(dbPath)).toBeNull();
  });

  // Regression coverage for the whole-branch-review finding: stale
  // fleet_sessions rows must stop rendering as live sessions once the
  // collector process itself has stopped polling, even though the rows
  // themselves are still sitting in the table.
  it('returns null when the fleet heartbeat is missing (collector predates this fix, or has never completed a fleet-poll cycle)', () => {
    const dbPath = tempDbWithFleetSessions(
      [{ session_id: 's1', pid: 100, project_name: 'proj', kind: 'interactive', status: 'busy', name: 'it-1', started_at_ms: 1000, last_seen_ms: 2000 }],
      3,
      null
    );
    expect(readFleetSessions(dbPath)).toBeNull();
  });

  it('returns null when the fleet heartbeat is older than the staleness threshold (collector stopped or stalled)', () => {
    const dbPath = tempDbWithFleetSessions(
      [{ session_id: 's1', pid: 100, project_name: 'proj', kind: 'interactive', status: 'busy', name: 'it-1', started_at_ms: 1000, last_seen_ms: 2000 }],
      3,
      Date.now() - 50_000 // well past the 45s threshold (3x the 15s poll interval)
    );
    expect(readFleetSessions(dbPath)).toBeNull();
  });

  it('returns real data when the fleet heartbeat is fresh (well within the staleness threshold)', () => {
    const dbPath = tempDbWithFleetSessions(
      [{ session_id: 's1', pid: 100, project_name: 'proj', kind: 'interactive', status: 'busy', name: 'it-1', started_at_ms: 1000, last_seen_ms: 2000 }],
      3,
      Date.now() - 5_000
    );
    expect(readFleetSessions(dbPath)).toEqual([
      { sessionId: 's1', pid: 100, projectName: 'proj', kind: 'interactive', status: 'busy', name: 'it-1', startedAtMs: 1000 },
    ]);
  });

  // Deferred test flagged by the task reviewer as missing: this path is
  // believed correct (the try/catch around the query should catch "no such
  // table") but was never actually exercised.
  it('returns null (via the catch path) when schema version is >= 3 but the fleet_sessions table is somehow still missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-collectorstore-fleet-notable-'));
    const dbPath = join(dir, 'test.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)").run('3');
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('fleet_last_poll_ms', ?)").run(String(Date.now()));
    db.close();

    expect(() => readFleetSessions(dbPath)).not.toThrow();
    expect(readFleetSessions(dbPath)).toBeNull();
  });
});
