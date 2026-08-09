import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'node:module';
import { readUsageEventsSince, readFleetSessions, readDiagnostics } from './collectorStore.js';

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

// The dispatches table is built to match the schema version being simulated:
// a v4 database genuinely does not have the telemetry columns, and building it
// with them would make the pre-v5 test vacuous -- it would pass whether or not
// the reader actually branches on version.
//
// Column definitions mirror the v5 ALTER TABLE block in collector/src/schema.ts,
// including the NOT NULL DEFAULTs on retries and exit_state.
const DISPATCHES_V4 =
  'CREATE TABLE dispatches (tool_use_id TEXT PRIMARY KEY, tokens INTEGER NOT NULL, tool_uses INTEGER NOT NULL, duration_ms INTEGER NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER NOT NULL);';
const DISPATCHES_V5 =
  'CREATE TABLE dispatches (tool_use_id TEXT PRIMARY KEY, tokens INTEGER NOT NULL, tool_uses INTEGER NOT NULL, duration_ms INTEGER NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER NOT NULL, agent_id TEXT, task_kind TEXT, session_id TEXT, retries INTEGER NOT NULL DEFAULT 0, exit_state TEXT NOT NULL DEFAULT \'ok\', severity INTEGER, median_ms_at_eval INTEGER);';

// Column definition mirrors the v6 ALTER TABLE block in
// collector/src/schema.ts: a v5 database genuinely lacks source_file_rel, so
// building it in for the pre-v6 test would make that test vacuous.
const TOOL_CALLS_V5 =
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, file_path_rel TEXT, started_at_ms INTEGER NOT NULL, closed_at_ms INTEGER NOT NULL);';
const TOOL_CALLS_V6 =
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, file_path_rel TEXT, started_at_ms INTEGER NOT NULL, closed_at_ms INTEGER NOT NULL, source_file_rel TEXT);';

function tempDbForDiagnostics(schemaVersion = 4, transcriptLastScanMs: number | null = Date.now()): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collectorstore-diagnostics-'));
  const dbPath = join(dir, 'test.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ${schemaVersion >= 6 ? TOOL_CALLS_V6 : TOOL_CALLS_V5}
    ${schemaVersion >= 5 ? DISPATCHES_V5 : DISPATCHES_V4}
    CREATE TABLE anomalies (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, tool_use_id TEXT NOT NULL, detail TEXT NOT NULL, detected_at_ms INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)").run(String(schemaVersion));
  if (transcriptLastScanMs !== null) {
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('transcript_last_scan_ms', ?)").run(String(transcriptLastScanMs));
  }
  db.close();
  return dbPath;
}

describe('readDiagnostics', () => {
  it('returns null when schema version is below 4', () => {
    const dbPath = tempDbForDiagnostics(3);
    expect(readDiagnostics(dbPath, 0)).toBeNull();
  });

  it('returns tool calls, dispatches, and anomalies since the given timestamp', () => {
    const dbPath = tempDbForDiagnostics(4);
    const db = new DatabaseSync(dbPath);
    db.exec(`INSERT INTO tool_calls (tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms) VALUES ('tu_1', 'Read', 'a.ts', 1000, 2000)`);
    db.exec(`INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms) VALUES ('tu_task', 500, 1, 1000, 1000, 2000)`);
    db.exec(`INSERT INTO anomalies (kind, tool_use_id, detail, detected_at_ms) VALUES ('reReadLoop', 'tu_1', 'a.ts read 3 times', 1500)`);
    db.close();

    const snapshot = readDiagnostics(dbPath, 0);
    expect(snapshot?.toolCalls).toHaveLength(1);
    expect(snapshot?.dispatches).toHaveLength(1);
    expect(snapshot?.anomalies).toHaveLength(1);
  });

  // Collector-liveness gate, mirroring readFleetSessions' fleet_last_poll_ms
  // check: a dead collector must render as "collector isn't running" rather
  // than serving up-to-24h-old rows as if they were current activity.
  it('returns null when the transcript-scan heartbeat is missing', () => {
    const dbPath = tempDbForDiagnostics(4, null);
    expect(readDiagnostics(dbPath, 0)).toBeNull();
  });

  it('returns null when the transcript-scan heartbeat is stale', () => {
    const dbPath = tempDbForDiagnostics(4, Date.now() - 10 * 60 * 1000);
    expect(readDiagnostics(dbPath, 0)).toBeNull();
  });
});

// Closes the gap named in
// docs/superpowers/specs/2026-08-03-voice-packs-stage12-design.md
// §"Gaps found in the existing codebase" item 1: the schema-v5 telemetry
// columns existed in SQLite but were never read into the viewer.
describe('readDiagnostics dispatch telemetry (schema v5)', () => {
  it('reads all seven v5 telemetry columns from a v5 database', () => {
    const dbPath = tempDbForDiagnostics(5);
    const db = new DatabaseSync(dbPath);
    db.exec(
      `INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms, agent_id, task_kind, session_id, retries, exit_state, severity, median_ms_at_eval)
       VALUES ('tu_task', 500, 3, 1200, 1000, 2200, 'agent-7', 'research', 'sess-42', 0, 'ok', 2, 900)`,
    );
    db.close();

    const snapshot = readDiagnostics(dbPath, 0);
    expect(snapshot?.dispatches).toHaveLength(1);
    expect(snapshot!.dispatches[0]).toEqual({
      toolUseId: 'tu_task',
      tokens: 500,
      toolUses: 3,
      durationMs: 1200,
      startedAtMs: 1000,
      endedAtMs: 2200,
      agentId: 'agent-7',
      taskKind: 'research',
      sessionId: 'sess-42',
      retries: 0,
      exitState: 'ok',
      severity: 2,
      medianMsAtEval: 900,
    });
  });

  // The degraded path. A v4 database physically lacks these columns, so the
  // reader must choose a narrower SELECT -- asking for agent_id here is a hard
  // SQLite error, and this reader's catch would convert that into a blanket
  // null, costing the operator the whole Ledger instead of seven fields.
  it('returns null telemetry, not a throw or a dropped snapshot, on a pre-v5 database', () => {
    const dbPath = tempDbForDiagnostics(4);
    const db = new DatabaseSync(dbPath);
    db.exec(
      `INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms)
       VALUES ('tu_old', 100, 1, 500, 1000, 1500)`,
    );
    db.close();

    expect(() => readDiagnostics(dbPath, 0)).not.toThrow();
    const snapshot = readDiagnostics(dbPath, 0);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.dispatches).toHaveLength(1);
    const row = snapshot!.dispatches[0];
    // Base fields still read normally...
    expect(row.tokens).toBe(100);
    expect(row.durationMs).toBe(500);
    // ...and every telemetry field degrades to null rather than to 0 or 'ok',
    // which a caller could not distinguish from a real zero-retry success.
    expect(row.agentId).toBeNull();
    expect(row.taskKind).toBeNull();
    expect(row.sessionId).toBeNull();
    expect(row.retries).toBeNull();
    expect(row.exitState).toBeNull();
    expect(row.severity).toBeNull();
    expect(row.medianMsAtEval).toBeNull();
  });

  // The cost-of-failure case the Ledger's dispatch table exists to surface:
  // tokens were spent, the work failed unrecoverably, and it was retried.
  it('reads a fatal exit with retries > 0', () => {
    const dbPath = tempDbForDiagnostics(5);
    const db = new DatabaseSync(dbPath);
    db.exec(
      `INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms, agent_id, task_kind, session_id, retries, exit_state, severity, median_ms_at_eval)
       VALUES ('tu_fatal', 9000, 12, 60000, 1000, 61000, 'agent-3', 'build', 'sess-42', 2, 'fatal', 4, 1500)`,
    );
    db.close();

    const row = readDiagnostics(dbPath, 0)!.dispatches[0];
    expect(row.exitState).toBe('fatal');
    expect(row.retries).toBe(2);
    expect(row.severity).toBe(4);
    expect(row.tokens).toBe(9000);
  });

  // exit_state is a TEXT column with a DEFAULT, not a constrained enum, so an
  // out-of-union value can physically be stored. It must not reach the Ledger's
  // fatal-exit styling as an unrecognized string.
  it('narrows an unrecognized exit_state to null instead of passing it through', () => {
    const dbPath = tempDbForDiagnostics(5);
    const db = new DatabaseSync(dbPath);
    db.exec(
      `INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms, retries, exit_state, severity)
       VALUES ('tu_weird', 10, 1, 100, 1000, 1100, 0, 'exploded', 99)`,
    );
    db.close();

    const row = readDiagnostics(dbPath, 0)!.dispatches[0];
    expect(row.exitState).toBeNull();
    // 99 is outside the 0-4 Severity union and is rejected the same way.
    expect(row.severity).toBeNull();
    // The row itself still comes through -- one bad column does not drop it.
    expect(row.toolUseId).toBe('tu_weird');
    expect(row.retries).toBe(0);
  });

  it('maps genuinely-null v5 columns through as null', () => {
    const dbPath = tempDbForDiagnostics(5);
    const db = new DatabaseSync(dbPath);
    // agent_id, task_kind, session_id, severity and median_ms_at_eval are
    // nullable in the migration; retries and exit_state carry NOT NULL DEFAULTs.
    db.exec(
      `INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms)
       VALUES ('tu_sparse', 42, 1, 200, 1000, 1200)`,
    );
    db.close();

    const row = readDiagnostics(dbPath, 0)!.dispatches[0];
    expect(row.agentId).toBeNull();
    expect(row.taskKind).toBeNull();
    expect(row.sessionId).toBeNull();
    expect(row.severity).toBeNull();
    expect(row.medianMsAtEval).toBeNull();
    // The defaults applied, so these are real values rather than absences.
    expect(row.retries).toBe(0);
    expect(row.exitState).toBe('ok');
  });
});

// Schema v6 (collector/src/schema.ts) adds tool_calls.source_file_rel, the
// dispatch-to-file correlation column from the reconciliation note.
describe('readDiagnostics tool call source (schema v6)', () => {
  // I4: source_file_rel embeds Claude's flattened-absolute-path project
  // directory name and must not cross IPC (docs/privacy-and-data.md). It must
  // stay queryable in SQLite directly (dispatchEvidence.ts's own query does
  // exactly that) while never appearing on the object readDiagnostics returns
  // for the diagnostics:snapshot IPC channel.
  it('does not expose source_file_rel on the IPC-facing toolCalls shape, though it remains queryable in SQLite', () => {
    const dbPath = tempDbForDiagnostics(6);
    const db = new DatabaseSync(dbPath);
    db.exec(
      `INSERT INTO tool_calls (tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms, source_file_rel)
       VALUES ('tu_1', 'Edit', 'src/foo.ts', 1000, 2000, 'proj/sess-1/subagents/agent-x.jsonl')`,
    );

    const directRow = db
      .prepare('SELECT source_file_rel FROM tool_calls WHERE tool_use_id = ?')
      .get('tu_1') as { source_file_rel: string };
    expect(directRow.source_file_rel).toBe('proj/sess-1/subagents/agent-x.jsonl');
    db.close();

    const row = readDiagnostics(dbPath, 0)!.toolCalls[0] as Record<string, unknown>;
    expect(row).not.toHaveProperty('sourceFileRel');
    expect(row.toolUseId).toBe('tu_1');
  });

  // The degraded path. A v5 database physically lacks source_file_rel, so
  // the reader must choose a narrower SELECT rather than error and drop the
  // whole snapshot.
  it('does not throw on a pre-v6 database lacking the column at all', () => {
    const dbPath = tempDbForDiagnostics(5);
    const db = new DatabaseSync(dbPath);
    db.exec(
      `INSERT INTO tool_calls (tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms)
       VALUES ('tu_1', 'Edit', 'src/foo.ts', 1000, 2000)`,
    );
    db.close();

    expect(() => readDiagnostics(dbPath, 0)).not.toThrow();
    const snapshot = readDiagnostics(dbPath, 0);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.toolCalls).toHaveLength(1);
    // Base fields still read normally.
    expect(snapshot!.toolCalls[0].toolUseId).toBe('tu_1');
  });
});
