/**
 * Aether OS — Layer 2 wiring: the async extraction queue.
 *
 * Design: docs/superpowers/specs/2026-07-31-memory-layer2-wiring-design.md
 * SS3. scanTranscriptsOnce (transcriptScan.ts) stays fully synchronous; it
 * pushes onto this queue instead of calling runExtractor directly. A
 * separate setInterval (index.ts) drains it -- same decoupling shape
 * fleetPoll.ts's pollAndUpsertFleet already uses for its own setInterval.
 *
 * Sequential draining (not Promise.all): each item spawns a real `claude -p`
 * subprocess via runExtractor's default exec. Bounding concurrent subprocess
 * count to 1 matches this being a personal single-user cockpit with no
 * throughput requirement here.
 */

import { runExtractor, type ExtractExecFn } from './memoryExtract.js';
import type { MemoryStore } from './memoryStore.js';

export interface QueuedExtraction {
  agentId: string;
  taskKind: string;
  sessionId: string | null;
  toolUseId: string;
  runSummary: string;
  queuedAtMs: number;
}

export function createMemoryExtractQueue() {
  const items: QueuedExtraction[] = [];
  // toolUseIds queued or drained earlier in this process, so a duplicate
  // task-notification for the same dispatch cannot extract twice. Bounded,
  // oldest-first eviction; drain() does not clear it.
  const seen = new Set<string>();
  const SEEN_CAP = 500;
  return {
    push(item: QueuedExtraction): void {
      if (seen.has(item.toolUseId)) return;
      seen.add(item.toolUseId);
      if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value as string);
      items.push(item);
    },
    drain(): QueuedExtraction[] {
      return items.splice(0, items.length);
    },
    size(): number {
      return items.length;
    },
  };
}

export type MemoryExtractQueue = ReturnType<typeof createMemoryExtractQueue>;

// existingMemories cap: well under getPrivateCandidates's own 200-row
// default, to keep the extraction prompt small (Layer 2 spec SS4.4's
// practical-ceiling note).
const EXISTING_MEMORIES_LIMIT = 20;

// Detail strings are built only from fixed text, ids, a sanitized parseError, a
// count, or err.name: never err.message/cmd/stderr (they carry the prompt).
function report(onIssue: ((detail: string) => void) | undefined, detail: string): void {
  if (!onIssue) return;
  try {
    onIssue(detail);
  } catch {
    // a closed db after stop() must not escape the drain
  }
}

// One fixed-format line per successful attempt, so an attempt that returns zero ops is still visible.
// A failed attempt is already reported by its issue line (exec_failed / parse error / err.name).
// Only fixed text, ids, integer counts and elapsed ms: never prompt, model output or err.message.
function reportOutcome(
  onIssue: ((detail: string) => void) | undefined,
  outcome: 'ok' | 'empty',
  item: QueuedExtraction,
  counts: { added: number; updated: number; superseded: number; revised: number; touched: number; rejected: number },
  ms: number,
): void {
  report(
    onIssue,
    `memory extraction ${outcome} for ${item.agentId} (${item.toolUseId}): ` +
      `added=${counts.added} updated=${counts.updated} superseded=${counts.superseded} ` +
      `revised=${counts.revised} touched=${counts.touched} rejected=${counts.rejected} ms=${ms}`,
  );
}

export async function drainMemoryExtractQueue(
  store: MemoryStore,
  queue: MemoryExtractQueue,
  execFn?: ExtractExecFn,
  onIssue?: (detail: string) => void,
): Promise<void> {
  for (const item of queue.drain()) {
    const existingMemories = store
      .getPrivateCandidates(item.agentId, EXISTING_MEMORIES_LIMIT)
      .map((m) => ({ id: m.id, kind: m.kind, content: m.content }));

    const startedAt = Date.now();
    try {
      const result = await runExtractor(
        {
          store,
          writer: item.agentId,
          sourceKind: 'run',
          sourceRunId: item.toolUseId,
          runSummary: item.runSummary,
          existingMemories,
        },
        execFn,
      );
      if (result.parseError || result.rejected.length) {
        // With a sink (logDrift) the console line comes from the sink; print here only without one.
        if (!onIssue) {
          console.error(
            `[aether-collector] memory extraction issue for ${item.agentId} (${item.toolUseId}):`,
            result.parseError ?? `rejected=${result.rejected.length}`,
          );
        }
        report(
          onIssue,
          `memory extraction issue for ${item.agentId} (${item.toolUseId}): ` +
            (result.parseError ?? `rejected=${result.rejected.length}`),
        );
      }
      if (result.parseError) continue;
      const counts = {
        added: result.added,
        updated: result.updated,
        superseded: result.superseded,
        revised: result.revised,
        touched: result.touched,
        rejected: result.rejected.length,
      };
      const changes = counts.added + counts.updated + counts.superseded + counts.revised + counts.touched;
      reportOutcome(onIssue, changes > 0 ? 'ok' : 'empty', item, counts, Date.now() - startedAt);
    } catch (err) {
      if (!onIssue) {
        console.error(
          `[aether-collector] memory extraction failed for ${item.agentId} (${item.toolUseId}):`,
          err instanceof Error ? err.name : 'non-error',
        );
      }
      report(
        onIssue,
        `memory extraction failed for ${item.agentId} (${item.toolUseId}): ${err instanceof Error ? err.name : 'non-error'}`,
      );
    }
  }
}
