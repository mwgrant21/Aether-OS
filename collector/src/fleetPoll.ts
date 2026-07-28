import { win32 } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export interface FleetSession {
  sessionId: string;
  pid: number | null;
  projectName: string;
  kind: string;
  status: string;
  name: string;
  startedAtMs: number;
}

const REQUIRED_STRING_FIELDS = ['sessionId', 'cwd', 'kind', 'name', 'status'] as const;

function missingFieldsOf(row: unknown): string[] {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return ['row is not an object'];
  const obj = row as Record<string, unknown>;
  const missing: string[] = [];
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof obj[field] !== 'string') missing.push(field);
  }
  if (typeof obj.startedAt !== 'number') missing.push('startedAt');
  return missing;
}

// win32.basename (not the platform-default basename import): claude agents
// --json's cwd is always a Windows-style path on this Windows-only personal
// app -- see this plan's Global Constraints for why the platform-default
// variant would make this file's own tests non-deterministic across dev
// machines running vitest on a different OS.
function toFleetSession(row: Record<string, unknown>): FleetSession {
  return {
    sessionId: row.sessionId as string,
    pid: typeof row.pid === 'number' ? row.pid : null,
    projectName: win32.basename(row.cwd as string),
    kind: row.kind as string,
    status: row.status as string,
    name: row.name as string,
    startedAtMs: row.startedAt as number,
  };
}

export function parseFleetJson(raw: string): { sessions: FleetSession[]; driftDetails: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const sessions: FleetSession[] = [];
  const driftDetails: string[] = [];

  for (const row of parsed) {
    const missing = missingFieldsOf(row);
    if (missing.length > 0) {
      driftDetails.push(`claude agents --json row missing/invalid field(s): ${missing.join(', ')}`);
      continue;
    }
    sessions.push(toFleetSession(row as Record<string, unknown>));
  }

  return { sessions, driftDetails };
}

export function filterOwnSession(sessions: FleetSession[], ownSessionId: string | null): FleetSession[] {
  if (ownSessionId === null) return sessions;
  return sessions.filter((s) => s.sessionId !== ownSessionId);
}

const STALE_MS = 30000; // twice the 15s poll interval, matching retention.ts's staleness convention

export function upsertFleetSessions(db: DatabaseSync, sessions: FleetSession[], nowMs: number): void {
  const upsert = db.prepare(
    `INSERT INTO fleet_sessions (session_id, pid, project_name, kind, status, name, started_at_ms, last_seen_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       pid = excluded.pid,
       project_name = excluded.project_name,
       kind = excluded.kind,
       status = excluded.status,
       name = excluded.name,
       started_at_ms = excluded.started_at_ms,
       last_seen_ms = excluded.last_seen_ms`
  );
  for (const s of sessions) {
    upsert.run(s.sessionId, s.pid, s.projectName, s.kind, s.status, s.name, s.startedAtMs, nowMs);
  }
  db.prepare('DELETE FROM fleet_sessions WHERE last_seen_ms < ?').run(nowMs - STALE_MS);
}
