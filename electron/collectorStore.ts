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
const MIN_SCHEMA_VERSION_FOR_DIAGNOSTICS = 4;

export interface DiagnosticsSnapshot {
  toolCalls: { toolUseId: string; toolName: string; filePathRel: string | null; startedAtMs: number; closedAtMs: number }[];
  dispatches: { toolUseId: string; tokens: number; toolUses: number; durationMs: number; startedAtMs: number; endedAtMs: number }[];
  anomalies: { kind: string; toolUseId: string; detail: string; detectedAtMs: number }[];
}

// 3x the collector's 15s fleet-poll interval -- enough margin that one slow
// poll cycle doesn't false-trigger, while still catching a genuinely dead
// collector within roughly one extra cycle.
const FLEET_HEARTBEAT_STALE_MS = 45000;

// Same rationale as FLEET_HEARTBEAT_STALE_MS, against the collector's 15s
// transcript-scan interval.
const DIAGNOSTICS_HEARTBEAT_STALE_MS = 45000;

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

function heartbeatMs(db: DatabaseSync, key: 'fleet_last_poll_ms' | 'transcript_last_scan_ms'): number | null {
  try {
    const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : null;
  } catch {
    return null;
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

export function readDiagnostics(dbPath: string, sinceMs: number): DiagnosticsSnapshot | null {
  const db = openReadOnly(dbPath);
  if (!db) return null;

  try {
    if (schemaVersionOf(db) < MIN_SCHEMA_VERSION_FOR_DIAGNOSTICS) return null;

    // Collector-liveness gate, mirroring readFleetSessions': without it a
    // crashed collector kept serving up-to-24h-old rows, which
    // DispatchTimeline rendered as current activity ("looks alive, isn't").
    const lastScanMs = heartbeatMs(db, 'transcript_last_scan_ms');
    if (lastScanMs === null || Date.now() - lastScanMs > DIAGNOSTICS_HEARTBEAT_STALE_MS) return null;

    const toolCallRows = db
      .prepare('SELECT tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms FROM tool_calls WHERE closed_at_ms >= ?')
      .all(sinceMs) as { tool_use_id: string; tool_name: string; file_path_rel: string | null; started_at_ms: number; closed_at_ms: number }[];

    const dispatchRows = db
      .prepare('SELECT tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms FROM dispatches WHERE ended_at_ms >= ?')
      .all(sinceMs) as { tool_use_id: string; tokens: number; tool_uses: number; duration_ms: number; started_at_ms: number; ended_at_ms: number }[];

    const anomalyRows = db
      .prepare('SELECT kind, tool_use_id, detail, detected_at_ms FROM anomalies WHERE detected_at_ms >= ?')
      .all(sinceMs) as { kind: string; tool_use_id: string; detail: string; detected_at_ms: number }[];

    return {
      toolCalls: toolCallRows.map((r) => ({ toolUseId: r.tool_use_id, toolName: r.tool_name, filePathRel: r.file_path_rel, startedAtMs: r.started_at_ms, closedAtMs: r.closed_at_ms })),
      dispatches: dispatchRows.map((r) => ({ toolUseId: r.tool_use_id, tokens: r.tokens, toolUses: r.tool_uses, durationMs: r.duration_ms, startedAtMs: r.started_at_ms, endedAtMs: r.ended_at_ms })),
      anomalies: anomalyRows.map((r) => ({ kind: r.kind, toolUseId: r.tool_use_id, detail: r.detail, detectedAtMs: r.detected_at_ms })),
    };
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

    // Collector-liveness gate: a missing or stale heartbeat means the
    // collector process itself has stopped polling (crashed, was stopped,
    // machine slept, or never started) -- treat that identically to
    // "collector isn't installed" rather than serving whatever stale rows
    // happen to still be sitting in fleet_sessions. See PROGRESS.md's Fleet
    // Session Browser entry for the "looks alive, isn't" failure mode this
    // closes.
    const lastPollMs = heartbeatMs(db, 'fleet_last_poll_ms');
    if (lastPollMs === null || Date.now() - lastPollMs > FLEET_HEARTBEAT_STALE_MS) return null;

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
