import type { DatabaseSync } from 'node:sqlite';
import type { TranscriptEvent } from './transcriptParser.js';

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
