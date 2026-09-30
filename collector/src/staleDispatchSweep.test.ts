import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema.js';
import { sweepStaleDispatches } from './staleDispatchSweep.js';
import { createEmptyHistory, type ToolCallHistory } from './toolCallHistory.js';
import { computeSeverity } from './severity/computeSeverity.js';
import { FUTURE_MTIME_TOLERANCE_MS } from './severity/isStalled.js';

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

  it('sweeping the same stale entry twice is an idempotent no-op: the fatal row stays as first written', () => {
    const db = freshDb();
    const nowMs = THIRTY_MIN + 1000;
    const history = historyWithOpen('tu6', { startedAt: 0, sessionId: 'ghost-session' });

    const first = sweepStaleDispatches(db, history, nowMs);
    expect(first.staleFound).toBe(1);

    const nowMs2 = nowMs + 5000;
    const second = sweepStaleDispatches(db, history, nowMs2);
    expect(second.staleFound).toBe(0); // already-fatal row is skipped, not re-swept

    const count: any = db.prepare('SELECT COUNT(*) as c FROM dispatches WHERE tool_use_id = ?').get('tu6');
    expect(count.c).toBe(1);
    const row: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu6');
    // ended_at_ms/duration_ms stay pinned to the FIRST sweep's nowMs -- a fatal
    // row is final once written, not overwritten on every subsequent tick.
    expect(row.ended_at_ms).toBe(nowMs);
    expect(row.duration_ms).toBe(nowMs - 0);
    db.close();
  });

  it('writes severity from the real computeSeverity(fatal) and duration/ended_at reflecting nowMs', () => {
    const db = freshDb();
    const startedAt = 1000;
    const nowMs = startedAt + THIRTY_MIN + 1000;
    const history = historyWithOpen('tu7', { startedAt, sessionId: 'ghost-session' });

    sweepStaleDispatches(db, history, nowMs);

    const row: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu7');
    const expectedSeverity = computeSeverity({ exit: 'fatal', elapsedMs: nowMs - startedAt, medianMsAtEval: null }).severity;
    expect(expectedSeverity).toBe(4);
    expect(row.severity).toBe(4);
    expect(row.duration_ms).toBe(nowMs - startedAt);
    expect(row.ended_at_ms).toBe(nowMs);
    expect(row.tokens).toBeNull();
    expect(row.tool_uses).toBeNull();
    db.close();
  });

  it('stall boundary: exactly STALL_MS of inactivity is not stalled, one ms more is', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO fleet_sessions (session_id, pid, project_name, kind, status, name, started_at_ms, last_seen_ms)
       VALUES ('s1', NULL, 'proj', 'agent', 'running', 'agent', 0, ?)`
    ).run(THIRTY_MIN);
    expect(sweepStaleDispatches(db, historyWithOpen('tu_b', { startedAt: 0 }), THIRTY_MIN).staleFound).toBe(0);
    db.prepare("UPDATE fleet_sessions SET last_seen_ms = ? WHERE session_id = 's1'").run(THIRTY_MIN + 1);
    expect(sweepStaleDispatches(db, historyWithOpen('tu_b', { startedAt: 0 }), THIRTY_MIN + 1).staleFound).toBe(1);
    db.close();
  });
});

describe('sweepStaleDispatches -- subagent progress (F15)', () => {
  function setup() {
    const db = freshDb();
    const nowMs = THIRTY_MIN * 2;
    db.prepare(
      `INSERT INTO fleet_sessions (session_id, pid, project_name, kind, status, name, started_at_ms, last_seen_ms)
       VALUES ('s1', NULL, 'proj', 'agent', 'running', 'agent', 0, ?)`
    ).run(nowMs - 1000);
    return { db, nowMs };
  }

  it('recent subagent-file progress keeps a long dispatch from stalling', () => {
    const { db, nowMs } = setup();
    const h = historyWithOpen('tu_p', { startedAt: 0 });
    expect(sweepStaleDispatches(db, h, nowMs, () => nowMs - 60_000).staleFound).toBe(0);
    expect(sweepStaleDispatches(db, h, nowMs).staleFound).toBe(1);
    db.close();
  });

  it('a probe with no data for the dispatch falls back to dispatch start', () => {
    const { db, nowMs } = setup();
    const h = historyWithOpen('tu_q', { startedAt: 0 });
    expect(sweepStaleDispatches(db, h, nowMs, () => null).staleFound).toBe(1);
    db.close();
  });

  it('a far-future mtime (+5h, clock skew) is ignored and does not hold off a real stall', () => {
    const { db, nowMs } = setup();
    const h = historyWithOpen('tu_f', { startedAt: 0 });
    expect(sweepStaleDispatches(db, h, nowMs, () => nowMs + 5 * 60 * 60 * 1000).staleFound).toBe(1);
    db.close();
  });

  it('a live dispatch (40 min old) whose mtime is slightly ahead of nowMs is not stale', () => {
    for (const ahead of [1, 1000, 4 * 60 * 1000]) {
      const { db, nowMs } = setup();
      const h = historyWithOpen('tu_live', { startedAt: nowMs - 40 * 60 * 1000 });
      expect(sweepStaleDispatches(db, h, nowMs, () => nowMs + ahead).staleFound).toBe(0);
      db.close();
    }
  });

  it('future-mtime tolerance boundary: exactly +tolerance counts as progress, +1 ms is ignored', () => {
    const at = setup();
    const hAt = historyWithOpen('tu_edge_at', { startedAt: at.nowMs - 40 * 60 * 1000 });
    expect(sweepStaleDispatches(at.db, hAt, at.nowMs, () => at.nowMs + FUTURE_MTIME_TOLERANCE_MS).staleFound).toBe(0);
    at.db.close();
    const over = setup();
    const hOver = historyWithOpen('tu_edge_over', { startedAt: over.nowMs - 40 * 60 * 1000 });
    expect(sweepStaleDispatches(over.db, hOver, over.nowMs, () => over.nowMs + FUTURE_MTIME_TOLERANCE_MS + 1).staleFound).toBe(1);
    over.db.close();
  });

  it('an mtime 31 min in the past on a 40 min old dispatch stalls', () => {
    const { db, nowMs } = setup();
    const h = historyWithOpen('tu_idle', { startedAt: nowMs - 40 * 60 * 1000 });
    expect(sweepStaleDispatches(db, h, nowMs, () => nowMs - 31 * 60 * 1000).staleFound).toBe(1);
    db.close();
  });

  it('does not call lastProgressFor for an entry no older than STALL_MS; calls it once past it', () => {
    const { db, nowMs } = setup();
    const calls: string[] = [];
    const spy = (id: string) => { calls.push(id); return null; };
    sweepStaleDispatches(db, historyWithOpen('tu_young', { startedAt: nowMs - THIRTY_MIN }), nowMs, spy);
    expect(calls).toEqual([]);
    sweepStaleDispatches(db, historyWithOpen('tu_old', { startedAt: nowMs - THIRTY_MIN - 1 }), nowMs, spy);
    expect(calls).toEqual(['tu_old']);
    db.close();
  });

  it('old subagent progress (past the stall window) still stalls', () => {
    const { db, nowMs } = setup();
    const h = historyWithOpen('tu_r', { startedAt: 0 });
    expect(sweepStaleDispatches(db, h, nowMs, () => nowMs - THIRTY_MIN - 1).staleFound).toBe(1);
    db.close();
  });
});
