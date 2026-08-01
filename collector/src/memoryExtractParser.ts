/**
 * Aether OS — Layer 2 tolerant extractor-output parser.
 *
 * Design: AETHER_MEMORY_LAYER_2.md §4.1, ported in spirit from Miriel's
 * `parseExtractorOutput` (memory-engine.js). Models asked for "JSON only"
 * still sometimes wrap it in prose or a markdown code fence; this never
 * throws and always hands the caller a usable (possibly empty) array plus a
 * diagnostic string when the output was not a clean array of operations.
 *
 * Deliberately conservative: on ANY doubt, return zero ops rather than guess
 * at a partial parse. §4.3's capture-prompt discipline is "sparse and right
 * beats dense and confabulated" -- this module extends that discipline to
 * parsing. `applyOps` (memoryStore.ts) never sees ops this function was not
 * sure about.
 */

export interface ParsedExtractorOutput {
  ops: unknown[];
  parseError: string | null;
}

function tryParseArray(text: string): unknown[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

export function parseExtractorOutput(raw: string): ParsedExtractorOutput {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ops: [], parseError: 'empty_output' };
  }

  // Fast path: the whole trimmed string is already a JSON array.
  const direct = tryParseArray(trimmed);
  if (direct) return { ops: direct, parseError: null };

  // The whole trimmed string is valid JSON, just not an array (e.g. a bare
  // object). Distinguish this from "not JSON at all" for a more useful
  // parseError.
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      return { ops: [], parseError: 'not_an_array' };
    }
  } catch {
    /* fall through to bracket extraction below */
  }

  // Slow path: find the first '[' and the LAST ']' in the whole string and
  // try that substring. Handles markdown code fences and leading/trailing
  // prose. Using the LAST ']' (not the first one after the first '[')
  // tolerates a nested array/object inside an op (e.g. a future op shape)
  // without truncating early.
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    return { ops: [], parseError: 'no_json_array_found' };
  }
  const candidate = trimmed.slice(start, end + 1);
  const extracted = tryParseArray(candidate);
  if (extracted) return { ops: extracted, parseError: null };

  return { ops: [], parseError: 'no_json_array_found' };
}
