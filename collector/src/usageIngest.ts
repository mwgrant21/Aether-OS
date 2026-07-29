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

export function ingestDispatchEvent(
  db: DatabaseSync,
  history: ToolCallHistory,
  event: TranscriptEvent,
  dispatchToolUseId: string,
  toolUseCount: number,
): boolean {
  if (event.kind !== 'assistant' || event.usage === null || event.timestamp === null) return false;
  const open = history.openByToolUseId[dispatchToolUseId];
  if (!open || open.toolName !== 'Task') return false;

  const endedAtMs = event.timestamp.getTime();
  const tokens = event.usage.inputTokens + event.usage.outputTokens;

  db.prepare(
    `INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tool_use_id) DO UPDATE SET tokens = excluded.tokens, tool_uses = excluded.tool_uses,
       duration_ms = excluded.duration_ms, ended_at_ms = excluded.ended_at_ms`
  ).run(dispatchToolUseId, tokens, toolUseCount, endedAtMs - open.startedAt, open.startedAt, endedAtMs);
  return true;
}
