import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseFleetJson, filterOwnSession, upsertFleetSessions, type FleetSession } from './fleetPoll.js';
import { openDatabase, migrate } from './schema.js';

// Captured directly from `claude agents --json` on this machine — see
// docs/superpowers/specs/2026-07-28-fleet-session-picker-design.md.
const REAL_ROW = {
  pid: 6824,
  cwd: 'C:\\Users\\IT',
  kind: 'interactive',
  startedAt: 1785255815376,
  sessionId: '37d95054-b8c3-44c2-8422-06d7fd9d52d7',
  name: 'it-68',
  status: 'busy',
};

describe('parseFleetJson', () => {
  it('parses a real captured row, deriving projectName from cwd via win32 basename', () => {
    const result = parseFleetJson(JSON.stringify([REAL_ROW]));
    expect(result).not.toBeNull();
    expect(result!.driftDetails).toEqual([]);
    expect(result!.sessions).toEqual([
      {
        sessionId: '37d95054-b8c3-44c2-8422-06d7fd9d52d7',
        pid: 6824,
        projectName: 'IT',
        kind: 'interactive',
        status: 'busy',
        name: 'it-68',
        startedAtMs: 1785255815376,
      },
    ]);
  });

  it('parses an empty array as zero sessions, zero drift', () => {
    const result = parseFleetJson('[]');
    expect(result).toEqual({ sessions: [], driftDetails: [] });
  });

  it('treats a missing pid as null rather than dropping the row', () => {
    const { pid, ...withoutPid } = REAL_ROW;
    const result = parseFleetJson(JSON.stringify([withoutPid]));
    expect(result!.sessions[0].pid).toBeNull();
    expect(result!.driftDetails).toEqual([]);
  });

  it('drops a row missing a required field and records a drift detail, keeping other valid rows', () => {
    const { sessionId, ...missingSessionId } = REAL_ROW;
    const secondRow = { ...REAL_ROW, sessionId: 'other-session' };
    const result = parseFleetJson(JSON.stringify([missingSessionId, secondRow]));
    expect(result!.sessions).toEqual([
      {
        sessionId: 'other-session',
        pid: 6824,
        projectName: 'IT',
        kind: 'interactive',
        status: 'busy',
        name: 'it-68',
        startedAtMs: 1785255815376,
      },
    ]);
    expect(result!.driftDetails).toHaveLength(1);
    expect(result!.driftDetails[0]).toContain('sessionId');
  });

  it('returns null for malformed JSON', () => {
    expect(parseFleetJson('not json{{')).toBeNull();
  });

  it('returns null when the top-level value is not an array', () => {
    expect(parseFleetJson(JSON.stringify({ not: 'an array' }))).toBeNull();
  });
});

describe('filterOwnSession', () => {
  const sessions: FleetSession[] = [
    { sessionId: 'own', pid: 1, projectName: 'IT', kind: 'interactive', status: 'busy', name: 'it-1', startedAtMs: 1000 },
    { sessionId: 'other', pid: 2, projectName: 'proj', kind: 'interactive', status: 'idle', name: 'it-2', startedAtMs: 2000 },
  ];

  it('excludes the session whose sessionId matches ownSessionId', () => {
    expect(filterOwnSession(sessions, 'own')).toEqual([sessions[1]]);
  });

  it('returns every session unchanged when ownSessionId is null', () => {
    expect(filterOwnSession(sessions, null)).toEqual(sessions);
  });

  it('returns every session unchanged when ownSessionId matches nothing', () => {
    expect(filterOwnSession(sessions, 'no-such-session')).toEqual(sessions);
  });
});

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-fleetupsert-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return db;
}

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    sessionId: 's1',
    pid: 100,
    projectName: 'proj',
    kind: 'interactive',
    status: 'busy',
    name: 'it-1',
    startedAtMs: 1000,
    ...overrides,
  };
}

describe('upsertFleetSessions', () => {
  it('inserts a new session with last_seen_ms stamped to nowMs', () => {
    const db = freshDb();
    upsertFleetSessions(db, [session()], 5000);
    const row: any = db.prepare('SELECT * FROM fleet_sessions').get();
    expect(row.session_id).toBe('s1');
    expect(row.last_seen_ms).toBe(5000);
    db.close();
  });

  it('updates an existing session in place by session_id, not duplicating it', () => {
    const db = freshDb();
    upsertFleetSessions(db, [session({ status: 'busy' })], 1000);
    upsertFleetSessions(db, [session({ status: 'idle' })], 2000);
    const rows: any[] = db.prepare('SELECT * FROM fleet_sessions').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('idle');
    expect(rows[0].last_seen_ms).toBe(2000);
    db.close();
  });

  it('prunes a row whose last_seen_ms is older than 30 seconds before this call\'s nowMs', () => {
    const db = freshDb();
    upsertFleetSessions(db, [session({ sessionId: 'stale' })], 1000);
    upsertFleetSessions(db, [session({ sessionId: 'fresh' })], 40000);
    const rows: any[] = db.prepare('SELECT session_id FROM fleet_sessions').all();
    expect(rows.map((r) => r.session_id)).toEqual(['fresh']);
    db.close();
  });

  it('the prune runs even when called with an empty sessions array', () => {
    const db = freshDb();
    upsertFleetSessions(db, [session({ sessionId: 'stale' })], 1000);
    upsertFleetSessions(db, [], 40000);
    const count: any = db.prepare('SELECT COUNT(*) as c FROM fleet_sessions').get();
    expect(count.c).toBe(0);
    db.close();
  });
});
