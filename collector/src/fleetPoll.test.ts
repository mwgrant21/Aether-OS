import { describe, it, expect } from 'vitest';
import { parseFleetJson, filterOwnSession, type FleetSession } from './fleetPoll.js';

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
