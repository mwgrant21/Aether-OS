import type { DatabaseSync } from 'node:sqlite';
import type { TranscriptEvent } from './transcriptParser.js';
import type { ToolCallHistory } from './toolCallHistory.js';
import { parseDispatchOutcome, unrecognisedStatusTag } from './severity/parseDispatchOutcome.js';
import { computeSeverity, exitStateForStatus } from './severity/computeSeverity.js';
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
// future. That does NOT make a first backfill order-independent: a row only
// sees earlier rows that were already ingested, and transcript files are
// scanned in directory order, not by time.
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
  return true;
}
