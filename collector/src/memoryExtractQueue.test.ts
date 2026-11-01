import { describe, it, expect, vi } from 'vitest';
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

  it('ignores a repeated toolUseId, including after it was drained', () => {
    const queue = createMemoryExtractQueue();
    queue.push(baseItem);
    queue.push({ ...baseItem });
    expect(queue.size()).toBe(1);
    queue.drain();
    queue.push({ ...baseItem });
    expect(queue.size()).toBe(0);
    queue.push({ ...baseItem, toolUseId: 'tu_2' });
    expect(queue.size()).toBe(1);
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

  it('reports an exec timeout through onIssue with ids and the sanitized reason', async () => {
    const { store, cleanup } = tempStore();
    try {
      const queue = createMemoryExtractQueue();
      queue.push(baseItem);
      const onIssue = vi.fn();
      await drainMemoryExtractQueue(
        store,
        queue,
        async () => {
          throw Object.assign(new Error('timed out'), { killed: true });
        },
        onIssue,
      );
      expect(onIssue).toHaveBeenCalledTimes(1);
      const detail = onIssue.mock.calls[0][0] as string;
      expect(detail).toContain('memory extraction ');
      expect(detail).toContain('CINDER');
      expect(detail).toContain('tu_1');
      expect(detail).toContain('exec_failed: timeout');
    } finally {
      cleanup();
    }
  });

  it('never puts run content from an exec error message into onIssue', async () => {
    const { store, cleanup } = tempStore();
    try {
      const queue = createMemoryExtractQueue();
      queue.push({ ...baseItem, runSummary: 'CANARY-RUN-SUMMARY' });
      const onIssue = vi.fn();
      await drainMemoryExtractQueue(
        store,
        queue,
        async () => {
          throw Object.assign(new Error('Command failed: claude -p CANARY-RUN-SUMMARY'), { code: 1 });
        },
        onIssue,
      );
      expect(onIssue).toHaveBeenCalledTimes(1);
      expect(onIssue.mock.calls[0][0]).not.toContain('CANARY');
    } finally {
      cleanup();
    }
  });

  it('a failed item is reported, not re-queued, and does not stop the next item', async () => {
    const { store, cleanup } = tempStore();
    try {
      const queue = createMemoryExtractQueue();
      queue.push({ ...baseItem, toolUseId: 'tu_1' });
      queue.push({ ...baseItem, toolUseId: 'tu_2' });
      const onIssue = vi.fn();
      const execFn = vi.fn(async () => {
        if (execFn.mock.calls.length === 1) throw Object.assign(new Error('x'), { killed: true });
        return { stdout: '[]' };
      });
      await drainMemoryExtractQueue(store, queue, execFn, onIssue);
      expect(execFn).toHaveBeenCalledTimes(2);
      expect(queue.size()).toBe(0);
      expect(onIssue).toHaveBeenCalledTimes(1);
      expect(onIssue.mock.calls[0][0]).toContain('tu_1');
    } finally {
      cleanup();
    }
  });
});
