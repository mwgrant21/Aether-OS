import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import type { FleetSessionRow } from '../src/state/types';

const require = createRequire(import.meta.url);

export interface CollectorUsageEvent {
  kind: 'assistant';
  timestamp: Date;
  usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number };
}

const MIN_SCHEMA_VERSION_FOR_USAGE_EVENTS = 2;
const MIN_SCHEMA_VERSION_FOR_FLEET_SESSIONS = 3;

function openReadOnly(dbPath: string): DatabaseSync | null {
  if (!existsSync(dbPath)) return null;
  try {
    const sqlite = require('node:sqlite');
    return new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

function schemaVersionOf(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  } catch {
    return 0;
  }
}

export function readUsageEventsSince(dbPath: string, sinceMs: number): CollectorUsageEvent[] | null {
  const db = openReadOnly(dbPath);
  if (!db) return null;

  try {
    if (schemaVersionOf(db) < MIN_SCHEMA_VERSION_FOR_USAGE_EVENTS) return null;

    const rows = db
      .prepare(
        'SELECT occurred_at_ms, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens FROM usage_events WHERE occurred_at_ms >= ?'
      )
      .all(sinceMs) as {
      occurred_at_ms: number;
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    }[];

    return rows.map((r) => ({
      kind: 'assistant' as const,
      timestamp: new Date(r.occurred_at_ms),
      usage: {
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheCreationInputTokens: r.cache_creation_input_tokens,
        cacheReadInputTokens: r.cache_read_input_tokens,
      },
    }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function readFleetSessions(dbPath: string): FleetSessionRow[] | null {
  const db = openReadOnly(dbPath);
  if (!db) return null;

  try {
    if (schemaVersionOf(db) < MIN_SCHEMA_VERSION_FOR_FLEET_SESSIONS) return null;

    const rows = db
      .prepare('SELECT session_id, pid, project_name, kind, status, name, started_at_ms FROM fleet_sessions')
      .all() as {
      session_id: string;
      pid: number | null;
      project_name: string;
      kind: string;
      status: string;
      name: string;
      started_at_ms: number;
    }[];

    return rows.map((r) => ({
      sessionId: r.session_id,
      pid: r.pid,
      projectName: r.project_name,
      kind: r.kind,
      status: r.status,
      name: r.name,
      startedAtMs: r.started_at_ms,
    }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}
