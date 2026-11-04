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

// ---------------------------------------------------------------------------
// Subagent hand-back reports. When a task-notification's <result> is the
// harness stub ("delivered to you as a message from ..."), the real report
// arrived earlier as a hand-back record. This store holds that text between
// the hand-back and the notification, possibly across scan ticks. It is
// transient, in-memory only, and under the same never-persist, never-log rule
// as humanText. Callers own the instance; there is no module-level singleton.
// ---------------------------------------------------------------------------

export const HANDBACK_REPORT_MAX_CHARS = 8_000;
export const HANDBACK_STORE_MAX_ENTRIES = 32;
export const HANDBACK_STORE_MAX_TOTAL_CHARS = 64_000;

const TASK_ID_RE = /<task-id>(.*?)<\/task-id>/;
const HANDBACK_STUB_RE = /delivered to you as a message from/i;
// Observed stubs are 147-151 chars; the guard keeps a real report that quotes
// the phrase from being misclassified.
const HANDBACK_STUB_MAX_LEN = 400;

export function extractDispatchTaskId(humanText: string | null): string | null {
  if (!humanText) return null;
  const match = humanText.match(TASK_ID_RE);
  if (!match) return null;
  const trimmed = match[1].trim();
  return trimmed ? trimmed : null;
}

export function isHandbackStub(text: string): boolean {
  return text.length <= HANDBACK_STUB_MAX_LEN && HANDBACK_STUB_RE.test(text);
}

export function createHandbackReportStore() {
  // Map insertion order is age order: first key is the oldest.
  const reports = new Map<string, string>();
  let total = 0;

  function remove(agentId: string): void {
    const existing = reports.get(agentId);
    if (existing === undefined) return;
    total -= existing.length;
    reports.delete(agentId);
  }

  return {
    put(agentId: string, reportText: string): void {
      const text = reportText.slice(0, HANDBACK_REPORT_MAX_CHARS);
      remove(agentId);
      reports.set(agentId, text);
      total += text.length;
      while (
        reports.size > 1 &&
        (reports.size > HANDBACK_STORE_MAX_ENTRIES || total > HANDBACK_STORE_MAX_TOTAL_CHARS)
      ) {
        const oldest = reports.keys().next().value as string;
        remove(oldest);
      }
    },
    get(agentId: string): string | null {
      return reports.get(agentId) ?? null;
    },
    delete(agentId: string): void {
      remove(agentId);
    },
    clear(): void {
      reports.clear();
      total = 0;
    },
    size(): number {
      return reports.size;
    },
    totalChars(): number {
      return total;
    },
  };
}

export type HandbackReportStore = ReturnType<typeof createHandbackReportStore>;
