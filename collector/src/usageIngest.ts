import type { DatabaseSync } from 'node:sqlite';
import type { TranscriptEvent } from './transcriptParser.js';
import type { ToolCallHistory } from './toolCallHistory.js';

export function ingestUsageEvent(db: DatabaseSync, event: TranscriptEvent): boolean {
  if (event.kind !== 'assistant' || event.usage === null || event.timestamp === null) return false;

  db.prepare(
    `INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    event.timestamp.getTime(),
    event.model,
    event.usage.inputTokens,
    event.usage.outputTokens,
    event.usage.cacheCreationInputTokens,
    event.usage.cacheReadInputTokens
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

  db.prepare(
    `INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tool_use_id) DO UPDATE SET tokens = excluded.tokens, tool_uses = excluded.tool_uses,
       duration_ms = excluded.duration_ms, ended_at_ms = excluded.ended_at_ms`
  ).run(dispatchToolUseId, tokens, toolUses, durationMs, open.startedAt, endedAtMs);
  return true;
}
