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
  return {
    push(item: QueuedExtraction): void {
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

export async function drainMemoryExtractQueue(
  store: MemoryStore,
  queue: MemoryExtractQueue,
  execFn?: ExtractExecFn,
): Promise<void> {
  for (const item of queue.drain()) {
    const existingMemories = store
      .getPrivateCandidates(item.agentId, EXISTING_MEMORIES_LIMIT)
      .map((m) => ({ id: m.id, kind: m.kind, content: m.content }));

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
        console.error(
          `[aether-collector] memory extraction issue for ${item.agentId} (${item.toolUseId}):`,
          result.parseError ?? result.rejected,
        );
      }
    } catch (err) {
      console.error(
        `[aether-collector] memory extraction failed for ${item.agentId} (${item.toolUseId}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
