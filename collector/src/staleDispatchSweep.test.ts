import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema.js';
import { sweepStaleDispatches } from './staleDispatchSweep.js';
import { createEmptyHistory, type ToolCallHistory } from './toolCallHistory.js';
import { computeSeverity } from './personalitySpine.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-stale-sweep-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return db;
}

function historyWithOpen(
  toolUseId: string,
  overrides: Partial<{ toolName: string; startedAt: number; subagentType: string | null; sessionId: string | null }> = {}
): ToolCallHistory {
  const history = createEmptyHistory();
  history.openByToolUseId[toolUseId] = {
    toolName: overrides.toolName ?? 'Agent',
    filePath: null,
    startedAt: overrides.startedAt ?? 0,
    subagentType: overrides.subagentType ?? 'general-purpose',
    sessionId: overrides.sessionId ?? 's1',
  };
  return history;
}

const FIFTEEN_S = 15000;
const THIRTY_MIN = 30 * 60 * 1000;

describe('sweepStaleDispatches', () => {
  it('writes fatal when session has no fleet_sessions row at all and entry is past the grace period', () => {
    const db = freshDb();
    const nowMs = FIFTEEN_S + 1000; // past the 15s grace period
    const history = historyWithOpen('tu1', { startedAt: 0, sessionId: 'ghost-session' });

    const result = sweepStaleDispatches(db, history, nowMs);

    expect(result.staleFound).toBe(1);
    const row: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu1');
    expect(row.exit_state).toBe('fatal');
    db.close();
  });

  it('does NOT write when the session has no row but the entry is younger than the grace period', () => {
    const db = freshDb();
    const nowMs = 2000; // well under the 15s grace period
    const history = historyWithOpen('tu2', { startedAt: 0, sessionId: 'ghost-session' });

    const result = sweepStaleDispatches(db, history, nowMs);

    expect(result.staleFound).toBe(0);
    const row = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu2');
    expect(row).toBeUndefined();
    db.close();
  });

  it('writes fatal when session is fresh but the entry has been open past the 30-minute timeout', () => {
    const db = freshDb();
    const startedAt = 0;
    const nowMs = THIRTY_MIN + 1000;
    db.prepare(
      `INSERT INTO fleet_sessions (session_id, pid, project_name, kind, status, name, started_at_ms, last_seen_ms)
       VALUES ('s1', NULL, 'proj', 'agent', 'running', 'agent', 0, ?)`
    ).run(nowMs - 1000); // last_seen_ms is fresh: 1s ago
    const history = historyWithOpen('tu3', { startedAt, sessionId: 's1' });

    const result = sweepStaleDispatches(db, history, nowMs);

    expect(result.staleFound).toBe(1);
    const row: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu3');
    expect(row.exit_state).toBe('fatal');
    db.close();
  });

  it('does NOT write when session is fresh and entry is under the 30-minute timeout', () => {
    const db = freshDb();
    const nowMs = FIFTEEN_S + 1000;
    db.prepare(
      `INSERT INTO fleet_sessions (session_id, pid, project_name, kind, status, name, started_at_ms, last_seen_ms)
       VALUES ('s1', NULL, 'proj', 'agent', 'running', 'agent', 0, ?)`
    ).run(nowMs - 1000); // fresh
    const history = historyWithOpen('tu4', { startedAt: 0, sessionId: 's1' });

    const result = sweepStaleDispatches(db, history, nowMs);

    expect(result.staleFound).toBe(0);
    const row = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu4');
    expect(row).toBeUndefined();
    db.close();
  });

  it('never sweeps a non-Agent open entry regardless of age', () => {
    const db = freshDb();
    const nowMs = THIRTY_MIN + 100000; // very old, no fleet session either
    const history = historyWithOpen('tu5', { toolName: 'Read', startedAt: 0, sessionId: 'ghost' });

    const result = sweepStaleDispatches(db, history, nowMs);

    expect(result.staleFound).toBe(0);
    const row = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu5');
    expect(row).toBeUndefined();
    db.close();
  });

  it('sweeping the same stale entry twice does not duplicate rows or throw', () => {
    const db = freshDb();
    const nowMs = THIRTY_MIN + 1000;
    const history = historyWithOpen('tu6', { startedAt: 0, sessionId: 'ghost-session' });

    expect(() => sweepStaleDispatches(db, history, nowMs)).not.toThrow();
    const nowMs2 = nowMs + 5000;
    expect(() => sweepStaleDispatches(db, history, nowMs2)).not.toThrow();

    const count: any = db.prepare('SELECT COUNT(*) as c FROM dispatches WHERE tool_use_id = ?').get('tu6');
    expect(count.c).toBe(1);
    const row: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu6');
    expect(row.ended_at_ms).toBe(nowMs2); // second sweep's nowMs won via upsert
    db.close();
  });

  it('writes severity from the real computeSeverity(fatal) and duration/ended_at reflecting nowMs', () => {
    const db = freshDb();
    const startedAt = 1000;
    const nowMs = startedAt + THIRTY_MIN + 1000;
    const history = historyWithOpen('tu7', { startedAt, sessionId: 'ghost-session' });

    sweepStaleDispatches(db, history, nowMs);

    const row: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu7');
    const expectedSeverity = computeSeverity({ exit: 'fatal', retries: 0, elapsedMs: nowMs - startedAt, medianMsAtEval: null });
    expect(expectedSeverity).toBe(4);
    expect(row.severity).toBe(4);
    expect(row.duration_ms).toBe(nowMs - startedAt);
    expect(row.ended_at_ms).toBe(nowMs);
    expect(row.tokens).toBe(0);
    expect(row.tool_uses).toBe(0);
    db.close();
  });
});
