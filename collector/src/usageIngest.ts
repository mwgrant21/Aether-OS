import type { DatabaseSync } from 'node:sqlite';
import type { TranscriptEvent } from './transcriptParser.js';
import type { ToolCallHistory } from './toolCallHistory.js';
import { parseDispatchOutcome, unrecognisedStatusTag } from './severity/parseDispatchOutcome.js';
import { computeSeverity, exitStateForStatus, TOOL_ERROR_FLOOR, type ExitState } from './severity/computeSeverity.js';
import { medianOf, BASELINE_WINDOW } from './severity/baselineMath.js';

/**
 * sourceFileRel is the project-relative transcript this turn was read from
 * (never absolute -- docs/privacy-and-data.md SS5). Persisting it is what makes
 * any future reconciliation of usage against a specific file possible; without
 * it, "has this file already been counted?" is unanswerable, which is exactly
 * what made the v7 backfill unsafe. See schema.ts's v8 block.
 */
export function ingestUsageEvent(db: DatabaseSync, event: TranscriptEvent, sourceFileRel: string): boolean {
  if (event.kind !== 'assistant' || event.usage === null || event.timestamp === null) return false;

  db.prepare(
    `INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, source_file_rel)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.timestamp.getTime(),
    event.model,
    event.usage.inputTokens,
    event.usage.outputTokens,
    event.usage.cacheCreationInputTokens,
    event.usage.cacheReadInputTokens,
    sourceFileRel
  );
  return true;
}

// Dispatch completion, ported from the already-shipped reference implementation
// in src/state/liveAgentsMath.ts (applyLinesToOpenDispatches):
//   - a dispatch OPENS on an assistant tool_use named 'Agent' (not 'Task')
//   - it CLOSES on a 'user'-kind event with origin.kind 'task-notification',
//     whose text carries <tool-use-id>/<subagent_tokens>/<tool_uses>/<duration_ms>
//     tags that Claude Code computes itself.
// The tool-use-id is an exact correlation id, so one completion event closes
// exactly one dispatch -- never a fan-out over everything currently open -- and
// the token/tool-use/duration values are real, not estimated, and are NULL when
// the notification carries no usage block (failed/killed). The status comes from
// <status> via parseDispatchOutcome. The notification text is read here and
// discarded; only the extracted numbers and the status are persisted.
export interface DispatchIngestOptions {
  diag?: (line: string) => void;
  reportedStatusTags?: Set<string>;
  // Tool-error count from the dispatch's own subagent transcript (counts only,
  // never text). Consulted for <status>completed</status> only; null = unknown.
  toolErrorsFor?: (toolUseId: string) => number | null;
}

const reportedStatusTagsForProcess = new Set<string>();

// Spec section 6: median of this agent type's own successful history, the
// same rules as the live baseline (completed rows, duration_ms > 0, last 20,
// minimum 5). An unknown status is stored as exit 'ok' too, so dispatch_status
// tells them apart; NULL status (history before the column, or Go-written
// rows) is admitted as before. duration_ms > 0 also skips NULL and the
// historic failures that were stored as ok with 0 ms. The row being ingested
// is excluded, so a re-ingest never compares a run against itself. Only rows
// that ended before beforeMs count, so a row is never scored against its own
// future. A row only sees earlier rows that were already ingested, so a
// completion scored before its predecessors are stored gets a partial
// baseline: rescorePendingDispatches corrects that from the database once the
// scan pass has stored them all (#106).
export function medianDurationMsFor(db: DatabaseSync, agentId: string | null, excludeToolUseId: string, beforeMs: number): number | null {
  if (agentId === null) return null;
  const rows = db
    .prepare(
      `SELECT duration_ms FROM dispatches
        WHERE agent_id = ? AND exit_state = 'ok' AND (dispatch_status = 'completed' OR dispatch_status IS NULL)
          AND duration_ms > 0 AND tool_use_id != ? AND ended_at_ms < ?
        ORDER BY ended_at_ms DESC LIMIT ?`,
    )
    .all(agentId, excludeToolUseId, beforeMs, BASELINE_WINDOW) as { duration_ms: number }[];
  return medianOf(rows.map((r) => r.duration_ms).reverse());
}

export function ingestDispatchEvent(
  db: DatabaseSync,
  history: ToolCallHistory,
  event: TranscriptEvent,
  options: DispatchIngestOptions = {},
): boolean {
  if (event.kind !== 'user' || event.originKind !== 'task-notification') return false;
  const content = event.humanText || '';
  const idMatch = content.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
  if (!idMatch) return false;
  const dispatchToolUseId = idMatch[1];
  const open = history.openByToolUseId[dispatchToolUseId];
  if (!open || open.toolName !== 'Agent') return false;
  if (event.timestamp === null) return false;

  const outcome = parseDispatchOutcome(content);
  if (outcome.status === 'unknown') {
    const tag = unrecognisedStatusTag(content);
    const seen = options.reportedStatusTags ?? reportedStatusTagsForProcess;
    if (tag !== null && !seen.has(tag)) {
      seen.add(tag);
      (options.diag ?? ((l: string) => console.error(l)))(
        `[aether-collector] [diag] dispatch status not recognised tag=${tag}; stored as ok`,
      );
    }
  }
  const endedAtMs = event.timestamp.getTime();
  const result = computeSeverity({
    exit: exitStateForStatus(outcome.status),
    // Only completed runs are scored for slowness: unknown stays at 1.
    elapsedMs: outcome.status === 'completed' ? (outcome.usage?.durationMs ?? 0) : 0,
    medianMsAtEval: medianDurationMsFor(db, open.subagentType, dispatchToolUseId, endedAtMs),
    toolErrors: outcome.status === 'completed' ? (options.toolErrorsFor?.(dispatchToolUseId) ?? null) : null,
  });

  db.prepare(
    `INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms,
       agent_id, task_kind, session_id, retries, exit_state, severity, median_ms_at_eval, dispatch_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tool_use_id) DO UPDATE SET tokens = excluded.tokens, tool_uses = excluded.tool_uses,
       duration_ms = excluded.duration_ms, ended_at_ms = excluded.ended_at_ms,
       agent_id = excluded.agent_id, task_kind = excluded.task_kind, session_id = excluded.session_id,
       retries = excluded.retries, exit_state = excluded.exit_state, severity = excluded.severity,
       median_ms_at_eval = excluded.median_ms_at_eval, dispatch_status = excluded.dispatch_status`
  ).run(
    dispatchToolUseId, outcome.usage?.tokens ?? null, outcome.usage?.toolUses ?? null, outcome.usage?.durationMs ?? null,
    open.startedAt, endedAtMs,
    open.subagentType, open.subagentType, open.sessionId, 0, result.exitState, result.severity, result.medianMs,
    outcome.status,
  );
  noteDispatchRescore(db, endedAtMs);
  return true;
}

// #106: a dispatch is scored against the rows stored when it is ingested, so
// one ingested before an earlier-ended run (a first scan reads files in
// readdirSync order; old transcripts can also appear later) is scored on a
// partial baseline. Every ingest lowers this durable watermark in the same
// transaction as its row, and rescorePendingDispatches rescores every row
// ended at or after it, then clears it. A crash before the rescore leaves the
// watermark for the next scan, so the fix never depends on in-memory state.
const RESCORE_KEY = 'dispatch_rescore_from_ms';

function noteDispatchRescore(db: DatabaseSync, endedAtMs: number): void {
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(MIN(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`,
  ).run(RESCORE_KEY, String(endedAtMs));
}

// Rescores from stored columns only, so it needs no transcript or subagent
// read. That is exact because the tool-error count is the one input not
// stored, and it only matters as a floor of 3 on a completed run, which
// slowness alone (capped at 2) can never reach: a stored completed severity
// of 3 or more therefore means the floor applied. Rows with a NULL
// dispatch_status (before the column, Go-written, or swept fatal) were not
// scored by this path and are left alone. The median reads only
// duration_ms and ended_at_ms, so the rescore order does not matter.
export function rescorePendingDispatches(db: DatabaseSync): number {
  const marker = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(RESCORE_KEY) as { value: string } | undefined;
  if (!marker) return 0;
  const rows = db
    .prepare(
      `SELECT tool_use_id, agent_id, ended_at_ms, duration_ms, exit_state, severity, dispatch_status FROM dispatches
        WHERE dispatch_status IS NOT NULL AND ended_at_ms >= ?`,
    )
    .all(Number(marker.value)) as {
      tool_use_id: string; agent_id: string | null; ended_at_ms: number; duration_ms: number | null;
      exit_state: ExitState; severity: number; dispatch_status: string;
    }[];
  const update = db.prepare('UPDATE dispatches SET severity = ?, median_ms_at_eval = ? WHERE tool_use_id = ?');
  for (const row of rows) {
    const completed = row.dispatch_status === 'completed';
    const result = computeSeverity({
      exit: row.exit_state,
      elapsedMs: completed ? (row.duration_ms ?? 0) : 0,
      medianMsAtEval: medianDurationMsFor(db, row.agent_id, row.tool_use_id, row.ended_at_ms),
      toolErrors: completed && row.severity >= 3 ? TOOL_ERROR_FLOOR : null,
    });
    update.run(result.severity, result.medianMs, row.tool_use_id);
  }
  db.prepare('DELETE FROM schema_meta WHERE key = ?').run(RESCORE_KEY);
  return rows.length;
}
