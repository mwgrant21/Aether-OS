/**
 * Aether OS — Layer 2 wiring: extract the subagent's final report out of a
 * closed dispatch's task-notification text.
 *
 * Design: docs/superpowers/specs/2026-07-31-memory-layer2-wiring-design.md
 * SS2.1 (revised). A real captured task-notification event's
 * message.content is a plain string containing <result>...</result> inline
 * with the tags usageIngest.ts#ingestDispatchEvent already parses
 * (<tool-use-id>, <subagent_tokens>, etc.) out of that exact string, surfaced
 * on TranscriptEvent as `humanText`. This function extracts one more tag
 * from the same already-in-memory string -- no JSON re-parsing, no raw
 * line, no new file I/O, and no widening of TranscriptEvent.
 *
 * `humanText` is already documented in transcriptParser.ts as "transient
 * and MUST NEVER be persisted" -- this function's caller (Task 3) must
 * honor that for whatever this returns, exactly as it already must for
 * humanText itself.
 *
 * Never throws -- same tolerant-parsing convention as every other parser in
 * this package (parseExtractorOutput, parseTranscriptLine).
 */

const RESULT_TAG_RE = /<result>([\s\S]*?)<\/result>/;

export function extractDispatchResultText(humanText: string | null): string | null {
  if (!humanText) return null;
  const match = humanText.match(RESULT_TAG_RE);
  if (!match) return null;
  const trimmed = match[1].trim();
  return trimmed ? trimmed : null;
}
