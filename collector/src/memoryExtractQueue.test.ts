import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from './memoryStore.js';
import { createMemoryExtractQueue, drainMemoryExtractQueue, type QueuedExtraction } from './memoryExtractQueue.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-extractqueue-'));
  const store = createMemoryStore(join(dir, 'memory.db'), { now: () => 1_700_000_000 });
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const baseItem: QueuedExtraction = {
  agentId: 'CINDER',
  taskKind: 'review',
  sessionId: 's1',
  toolUseId: 'tu_1',
  runSummary: 'Implemented a retry helper; user asked to always double-check migrations first.',
  queuedAtMs: 1_700_000_000,
};

describe('createMemoryExtractQueue', () => {
  it('push then drain returns items in FIFO order and empties the queue', () => {
    const queue = createMemoryExtractQueue();
    queue.push(baseItem);
    queue.push({ ...baseItem, toolUseId: 'tu_2' });
    expect(queue.size()).toBe(2);
    const drained = queue.drain();
    expect(drained.map((i) => i.toolUseId)).toEqual(['tu_1', 'tu_2']);
    expect(queue.size()).toBe(0);
    expect(queue.drain()).toEqual([]);
  });
});

describe('drainMemoryExtractQueue', () => {
  it('drains each item through runExtractor and applies the result to the real store', async () => {
    const { store, cleanup } = tempStore();
    try {
      const queue = createMemoryExtractQueue();
      queue.push(baseItem);
      await drainMemoryExtractQueue(store, queue, async () => ({
        stdout: '[{"op":"ADD","kind":"habit","content":"Matt always asks CINDER to double-check migrations."}]',
      }));
      expect(store.getPrivateCandidates('CINDER')).toHaveLength(1);
      expect(queue.size()).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('processes multiple queued items sequentially, one at a time', async () => {
    const { store, cleanup } = tempStore();
    try {
      const queue = createMemoryExtractQueue();
      queue.push({ ...baseItem, toolUseId: 'tu_1', agentId: 'CINDER' });
      queue.push({ ...baseItem, toolUseId: 'tu_2', agentId: 'FORGE' });
      let concurrentCalls = 0;
      let maxConcurrent = 0;
      await drainMemoryExtractQueue(store, queue, async () => {
        concurrentCalls += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
        await new Promise((r) => setTimeout(r, 5));
        concurrentCalls -= 1;
        return { stdout: '[]' };
      });
      expect(maxConcurrent).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('caps existingMemories passed to the extractor at 20, well under the store default of 200', async () => {
    const { store, cleanup } = tempStore();
    try {
      for (let i = 0; i < 25; i++) {
        store.applyOps(
          [{ op: 'ADD', kind: 'habit', content: `Habit number ${i}.` }],
          { writer: 'CINDER', sourceKind: 'run' },
        );
      }
      const queue = createMemoryExtractQueue();
      queue.push({ ...baseItem, agentId: 'CINDER' });
      let receivedPromptLength = 0;
      await drainMemoryExtractQueue(store, queue, async (prompt: string) => {
        receivedPromptLength = (prompt.match(/id=\d+ kind=/g) ?? []).length;
        return { stdout: '[]' };
      });
      expect(receivedPromptLength).toBe(20);
    } finally {
      cleanup();
    }
  });

  it('does not throw when an item fails (exec error) and continues to the next item', async () => {
    const { store, cleanup } = tempStore();
    try {
      const queue = createMemoryExtractQueue();
      queue.push({ ...baseItem, toolUseId: 'tu_1' });
      queue.push({ ...baseItem, toolUseId: 'tu_2' });
      let callCount = 0;
      await expect(
        drainMemoryExtractQueue(store, queue, async () => {
          callCount += 1;
          if (callCount === 1) throw new Error('spawn ENOENT');
          return { stdout: '[]' };
        }),
      ).resolves.not.toThrow();
      expect(callCount).toBe(2);
    } finally {
      cleanup();
    }
  });
});
