import type { DatabaseSync } from 'node:sqlite';
import type { TranscriptEvent } from './transcriptParser.js';
import type { ToolCallHistory } from './toolCallHistory.js';
import { computeSeverity } from './personalitySpine.js';

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
// the token/tool-use/duration values are real, not estimated. The notification
// text is read here and discarded; only the extracted numbers are persisted.
export function ingestDispatchEvent(
  db: DatabaseSync,
  history: ToolCallHistory,
  event: TranscriptEvent,
): boolean {
  if (event.kind !== 'user' || event.originKind !== 'task-notification') return false;
  const content = event.humanText || '';
  const idMatch = content.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
  if (!idMatch) return false;
  const dispatchToolUseId = idMatch[1];
  const open = history.openByToolUseId[dispatchToolUseId];
  if (!open || open.toolName !== 'Agent') return false;
  if (event.timestamp === null) return false;

  const tokensMatch = content.match(/<subagent_tokens>(\d+)<\/subagent_tokens>/);
  const toolUsesMatch = content.match(/<tool_uses>(\d+)<\/tool_uses>/);
  const durationMatch = content.match(/<duration_ms>(\d+)<\/duration_ms>/);
  const tokens = tokensMatch ? Number(tokensMatch[1]) : 0;
  const toolUses = toolUsesMatch ? Number(toolUsesMatch[1]) : 0;
  const durationMs = durationMatch ? Number(durationMatch[1]) : 0;
  const endedAtMs = event.timestamp.getTime();

  const severity = computeSeverity({
    exit: 'ok',
    retries: 0,
    elapsedMs: durationMs,
    medianMsAtEval: null,
  });

  db.prepare(
    `INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms,
       agent_id, task_kind, session_id, retries, exit_state, severity, median_ms_at_eval)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tool_use_id) DO UPDATE SET tokens = excluded.tokens, tool_uses = excluded.tool_uses,
       duration_ms = excluded.duration_ms, ended_at_ms = excluded.ended_at_ms,
       agent_id = excluded.agent_id, task_kind = excluded.task_kind, session_id = excluded.session_id,
       retries = excluded.retries, exit_state = excluded.exit_state, severity = excluded.severity,
       median_ms_at_eval = excluded.median_ms_at_eval`
  ).run(
    dispatchToolUseId, tokens, toolUses, durationMs, open.startedAt, endedAtMs,
    open.subagentType, open.subagentType, open.sessionId, 0, 'ok', severity, null
  );
  return true;
}
