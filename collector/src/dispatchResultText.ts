/**
 * Aether OS — Layer 2 wiring: live (never-persisted) read of an Agent
 * dispatch's raw result text.
 *
 * Design: docs/superpowers/specs/2026-07-31-memory-layer2-wiring-design.md
 * SS2.1. The shared TranscriptEvent type (transcriptParser.ts) deliberately
 * reduces a tool_result to { toolUseId, resultLength } -- the content is
 * read once to compute .length and discarded, per docs/privacy-and-data.md.
 * This function is the one narrow exception: it re-parses the SAME raw
 * JSONL line already in memory for this scan tick, reads the content ONE
 * caller needs (feeding runExtractor's prompt, never a database write), and
 * is never wired into transcriptParser.ts or its TranscriptEvent output.
 *
 * Never throws -- same tolerant-parsing convention as every other parser in
 * this package (parseExtractorOutput, parseTranscriptLine).
 */

export function extractDispatchResultText(rawLine: string, toolUseId: string): string | null {
  let json: any;
  try {
    json = JSON.parse(rawLine);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;

  const content = json.message?.content;
  if (!Array.isArray(content)) return null;

  const match = content.find(
    (item: any) => item && item.type === 'tool_result' && item.tool_use_id === toolUseId,
  );
  if (!match) return null;

  const raw = match.content;
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (Array.isArray(raw)) {
    text = raw
      .filter((block: any) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block: any) => block.text)
      .join('\n');
  } else {
    return null;
  }

  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}
