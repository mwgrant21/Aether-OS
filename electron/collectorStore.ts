import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import type { FleetSessionRow } from '../src/state/types';
// Type-only import, so nothing from the collector package is bundled into the
// main process -- these are erased at compile time. Reused rather than
// restated so there is exactly one declaration of what an exit state or a
// severity is, matching how personalitySpine.ts itself imports RevisionCause
// from memoryStore.ts instead of redeclaring it.
import type { ExitState, Severity } from '../collector/src/personalitySpine';

const require = createRequire(import.meta.url);

export interface CollectorUsageEvent {
  kind: 'assistant';
  timestamp: Date;
  usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number };
}

const MIN_SCHEMA_VERSION_FOR_USAGE_EVENTS = 2;
const MIN_SCHEMA_VERSION_FOR_FLEET_SESSIONS = 3;
const MIN_SCHEMA_VERSION_FOR_DIAGNOSTICS = 4;

// The schema-v5 migration (collector/src/schema.ts) ALTERs the dispatches
// table to add the telemetry columns. A database still at v4 has the rows but
// not the columns, so the SELECT below is chosen per-version: asking a v4
// database for agent_id is a hard SQLite error, and this reader's catch would
// turn that into a blanket null -- an operator on an old collector would lose
// the Ledger entirely rather than seeing a degraded one.
const MIN_SCHEMA_VERSION_FOR_DISPATCH_TELEMETRY = 5;

// Schema v6 (collector/src/schema.ts) ALTERs tool_calls to add
// source_file_rel. Same "column doesn't exist yet" hazard as
// MIN_SCHEMA_VERSION_FOR_DISPATCH_TELEMETRY above: a v5 database's tool_calls
// rows lack the column entirely, so it is selected by version rather than
// asked for and hoped.
const MIN_SCHEMA_VERSION_FOR_TOOL_CALL_SOURCE = 6;

/**
 * A persisted dispatch as the viewer sees it.
 *
 * The six base fields have always been read. The telemetry fields below them
 * were added to SQLite by the Stage 11 schema-v5 migration and then never read
 * into the viewer -- the gap named in
 * `docs/superpowers/specs/2026-08-03-voice-packs-stage12-design.md`
 * §"Gaps found in the existing codebase" item 1, which deliberately left it
 * unscheduled because Stage 12's live narration did not need it. Stage 15's
 * Ledger does: `exitState` and `retries` are what make the dispatch table a
 * cost-of-failure view rather than a cost-of-work one.
 *
 * Every telemetry field is nullable, and null means "not available" -- either
 * the database predates v5, or the column is genuinely null for this row.
 * Callers must not read null as a zero or an 'ok'.
 *
 * (That spec and the Stage 15 plan both enumerate six v5 columns and omit
 * `session_id`; the migration adds seven. All seven are read here.)
 */
export interface DispatchRow {
  toolUseId: string;
  tokens: number;
  toolUses: number;
  durationMs: number;
  startedAtMs: number;
  endedAtMs: number;
  agentId: string | null;
  taskKind: string | null;
  sessionId: string | null;
  retries: number | null;
  exitState: ExitState | null;
  severity: Severity | null;
  medianMsAtEval: number | null;
}

export interface DiagnosticsSnapshot {
  toolCalls: {
    toolUseId: string;
    toolName: string;
    filePathRel: string | null;
    startedAtMs: number;
    closedAtMs: number;
    // source_file_rel deliberately does NOT appear here -- it embeds Claude's
    // flattened-absolute-path project directory name, and paths must not
    // cross IPC (docs/privacy-and-data.md). It's read from SQLite (below) and
    // used main-side only, by dispatchEvidence.ts's own direct query -- never
    // mapped into this IPC-facing shape. See collectorStore.test.ts for the
    // SQLite-level coverage of the column itself.
  }[];
  dispatches: DispatchRow[];
  anomalies: { kind: string; toolUseId: string; detail: string; detectedAtMs: number }[];
}

// SQLite is untyped at the boundary: exit_state is a TEXT column with a
// DEFAULT, not a constrained enum, so a value that is not an ExitState can
// physically be in there. Casting blind would let a garbage string reach the
// Ledger's fatal-exit styling and silently miss. Narrow instead, and treat
// anything unrecognized as "not available" rather than inventing a state.
const EXIT_STATES: ReadonlySet<string> = new Set<ExitState>([
  'ok',
  'partial',
  'error',
  'fatal',
  'timeout',
  'blocked',
]);

function asExitState(value: unknown): ExitState | null {
  return typeof value === 'string' && EXIT_STATES.has(value) ? (value as ExitState) : null;
}

function asSeverity(value: unknown): Severity | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4
    ? (value as Severity)
    : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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
    const version = schemaVersionOf(db);
    if (version < MIN_SCHEMA_VERSION_FOR_DIAGNOSTICS) return null;

    // Collector-liveness gate, mirroring readFleetSessions': without it a
    // crashed collector kept serving up-to-24h-old rows, which
    // DispatchTimeline rendered as current activity ("looks alive, isn't").
    const lastScanMs = heartbeatMs(db, 'transcript_last_scan_ms');
    if (lastScanMs === null || Date.now() - lastScanMs > DIAGNOSTICS_HEARTBEAT_STALE_MS) return null;

    // Pre-v6 databases lack source_file_rel entirely, so the column list is
    // selected by schema version rather than asked for and hoped -- same
    // pattern as hasDispatchTelemetry below.
    const hasToolCallSource = version >= MIN_SCHEMA_VERSION_FOR_TOOL_CALL_SOURCE;
    const toolCallColumns = hasToolCallSource
      ? 'tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms, source_file_rel'
      : 'tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms';

    const toolCallRows = db
      .prepare(`SELECT ${toolCallColumns} FROM tool_calls WHERE closed_at_ms >= ?`)
      .all(sinceMs) as { tool_use_id: string; tool_name: string; file_path_rel: string | null; started_at_ms: number; closed_at_ms: number; source_file_rel?: string | null }[];

    // Pre-v5 databases lack the telemetry columns entirely, so the column list
    // is selected by schema version rather than asking for them and hoping.
    const hasDispatchTelemetry = version >= MIN_SCHEMA_VERSION_FOR_DISPATCH_TELEMETRY;
    const dispatchColumns = hasDispatchTelemetry
      ? 'tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms, agent_id, task_kind, session_id, retries, exit_state, severity, median_ms_at_eval'
      : 'tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms';

    const dispatchRows = db
      .prepare(`SELECT ${dispatchColumns} FROM dispatches WHERE ended_at_ms >= ?`)
      .all(sinceMs) as Record<string, unknown>[];

    const anomalyRows = db
      .prepare('SELECT kind, tool_use_id, detail, detected_at_ms FROM anomalies WHERE detected_at_ms >= ?')
      .all(sinceMs) as { kind: string; tool_use_id: string; detail: string; detected_at_ms: number }[];

    return {
      toolCalls: toolCallRows.map((r) => ({
        toolUseId: r.tool_use_id,
        toolName: r.tool_name,
        filePathRel: r.file_path_rel,
        startedAtMs: r.started_at_ms,
        closedAtMs: r.closed_at_ms,
      })),
      dispatches: dispatchRows.map(
        (r): DispatchRow => ({
          toolUseId: r.tool_use_id as string,
          tokens: r.tokens as number,
          toolUses: r.tool_uses as number,
          durationMs: r.duration_ms as number,
          startedAtMs: r.started_at_ms as number,
          endedAtMs: r.ended_at_ms as number,
          // On a pre-v5 database these keys are absent from the row object, so
          // the narrowing helpers see undefined and yield null -- the same
          // "not available" answer a v5 row with a null column gives.
          agentId: asNullableString(r.agent_id),
          taskKind: asNullableString(r.task_kind),
          sessionId: asNullableString(r.session_id),
          retries: asNullableNumber(r.retries),
          exitState: asExitState(r.exit_state),
          severity: asSeverity(r.severity),
          medianMsAtEval: asNullableNumber(r.median_ms_at_eval),
        }),
      ),
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
