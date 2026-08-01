# Memory Layer 2 — Wiring `runExtractor` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a closed, substantive Agent dispatch into a real `claude -p` extraction call and, sometimes, a row in `memory.db` — the one missing piece Phase B (already shipped) left unwired.

**Architecture:** Two new small modules (`dispatchResultText.ts`: pure raw-JSONL text extractor; `memoryExtractQueue.ts`: an in-memory queue plus an async drain function) glue into two existing files (`transcriptScan.ts` gains an extraction-bar check and a queue-push pass; `index.ts` gains a `memoryStore` open and a drain `setInterval`, mirroring the existing `fleetPollTimer` pattern). No new runtime dependencies.

**Tech Stack:** TypeScript (`NodeNext`), `node:sqlite` (via existing `memoryStore.ts`), Vitest. Same conventions as every other file in `collector/src/`.

## Global Constraints

- Package root for all new/modified files and test runs: `collector/` (Node >=22.5, per `collector/package.json` `engines`).
- Every relative import ends in `.js` (NodeNext). `node:sqlite` imported as a type only, via `createRequire` inside `schema.ts#openDatabase` (unchanged by this plan — no file in this plan opens `node:sqlite` directly except through `createMemoryStore`, already built).
- Zero new npm dependencies.
- Source of truth for every decision below: `docs/superpowers/specs/2026-07-31-memory-layer2-wiring-design.md` (committed at `e5b84e3`), which itself defers to `docs/superpowers/specs/AETHER_MEMORY_LAYER_2.md` for the store/extractor contracts (already shipped, do not modify `collector/src/memoryStore.ts`, `memoryExtract.ts`, `memoryExtractPrompt.ts`, or `memoryExtractParser.ts` in this plan).
- **Privacy invariant, binding on every task:** the Agent dispatch's raw result text is read live and passed into `runExtractor`'s prompt; it is never written to any SQLite table, never logged in full (a truncated/length-only log line is fine), and never added to the shared `TranscriptEvent` type in `transcriptParser.ts` (that file is not modified by this plan at all).
- `scanTranscriptsOnce`'s new `extractQueue` parameter must be **optional**, defaulting to "extraction pass skipped" when omitted — every existing call site in `transcriptScan.test.ts` and `index.ts`'s prior behavior calls it positionally without a 5th argument, and none of those call sites are touched by this plan.
- The `dispatches` table's full current column set (for the SELECT this plan adds): `tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms, agent_id, task_kind, session_id, retries, exit_state, severity, median_ms_at_eval` (`collector/src/schema.ts:79-86` base + `:122-128` migration).
- Every task's final check runs `npx vitest run` and `npx tsc -b` from `collector/` before commit.

---

### Task 1: `dispatchResultText.ts` — extract raw result text from a JSONL line

**Files:**
- Create: `collector/src/dispatchResultText.ts`
- Test: `collector/src/dispatchResultText.test.ts`

**Interfaces:**
- Produces: `extractDispatchResultText(rawLine: string, toolUseId: string): string | null` — used by Task 3.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { extractDispatchResultText } from './dispatchResultText.js';

function rawLine(content: unknown, toolUseId = 'tu_1'): string {
  return JSON.stringify({
    type: 'user',
    sessionId: 's1',
    timestamp: '2026-07-08T09:00:00Z',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  });
}

describe('extractDispatchResultText', () => {
  it('extracts a plain string tool_result content', () => {
    const result = extractDispatchResultText(rawLine('Implemented the feature, all tests passing.'), 'tu_1');
    expect(result).toBe('Implemented the feature, all tests passing.');
  });

  it('extracts and joins text blocks from an array-shaped tool_result content', () => {
    const line = rawLine([
      { type: 'text', text: 'First finding.' },
      { type: 'text', text: 'Second finding.' },
    ]);
    const result = extractDispatchResultText(line, 'tu_1');
    expect(result).toBe('First finding.\nSecond finding.');
  });

  it('ignores non-text blocks when joining an array-shaped content', () => {
    const line = rawLine([
      { type: 'text', text: 'Kept.' },
      { type: 'image', source: { data: 'irrelevant' } },
    ]);
    const result = extractDispatchResultText(line, 'tu_1');
    expect(result).toBe('Kept.');
  });

  it('returns null when no tool_result matches the given toolUseId', () => {
    const result = extractDispatchResultText(rawLine('some content', 'tu_other'), 'tu_1');
    expect(result).toBeNull();
  });

  it('returns null when the message has no tool_result at all', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    const result = extractDispatchResultText(line, 'tu_1');
    expect(result).toBeNull();
  });

  it('returns null for empty or whitespace-only content', () => {
    expect(extractDispatchResultText(rawLine(''), 'tu_1')).toBeNull();
    expect(extractDispatchResultText(rawLine('   '), 'tu_1')).toBeNull();
  });

  it('never throws on malformed JSON', () => {
    expect(() => extractDispatchResultText('not json at all {{', 'tu_1')).not.toThrow();
    expect(extractDispatchResultText('not json at all {{', 'tu_1')).toBeNull();
  });

  it('never throws on a well-formed but unexpected shape', () => {
    const line = JSON.stringify({ type: 'user', message: { content: 'not an array' } });
    expect(() => extractDispatchResultText(line, 'tu_1')).not.toThrow();
    expect(extractDispatchResultText(line, 'tu_1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `collector/`): `npx vitest run src/dispatchResultText.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dispatchResultText.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
cd collector
git add src/dispatchResultText.ts src/dispatchResultText.test.ts
git commit -m "feat(memory-layer-2): add live (never-persisted) dispatch result text reader"
```

---

### Task 2: `memoryExtractQueue.ts` — the async extraction queue

**Files:**
- Create: `collector/src/memoryExtractQueue.ts`
- Test: `collector/src/memoryExtractQueue.test.ts`

**Interfaces:**
- Consumes: `runExtractor`, `ExtractExecFn` from `./memoryExtract.js` (already shipped); `MemoryStore` from `./memoryStore.js` (already shipped).
- Produces: `QueuedExtraction` (type), `createMemoryExtractQueue()`, `MemoryExtractQueue` (type), `drainMemoryExtractQueue(store, queue, execFn?)` — used by Task 3 (`push`) and Task 4 (`drainMemoryExtractQueue`, wired into a timer).

- [ ] **Step 1: Write the failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/memoryExtractQueue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/memoryExtractQueue.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd collector
git add src/memoryExtractQueue.ts src/memoryExtractQueue.test.ts
git commit -m "feat(memory-layer-2): add async extraction queue draining runExtractor sequentially"
```

---

### Task 3: Wire the extraction pass into `transcriptScan.ts`

**Files:**
- Modify: `collector/src/transcriptScan.ts`
- Test: `collector/src/transcriptScan.test.ts` (add cases; existing cases must keep passing unmodified)

**Interfaces:**
- Consumes: `extractDispatchResultText` (Task 1); `MemoryExtractQueue`, `QueuedExtraction` (Task 2, type only — no `runExtractor` call happens in this file).
- Produces: `scanTranscriptsOnce`'s new optional 5th parameter — used by Task 4.

- [ ] **Step 1: Write the failing tests**

Add these `describe` blocks to the existing `collector/src/transcriptScan.test.ts` (do not modify any existing test in that file — every current call to `scanTranscriptsOnce` passes exactly 4 arguments and must keep working unchanged, since the new parameter is optional):

```typescript
import { createMemoryExtractQueue } from './memoryExtractQueue.js';

// A closed, substantive Agent dispatch: an assistant tool_use named 'Agent'
// followed by its task-notification completion, with a tool_result on the
// SAME toolUseId carrying the subagent's final report text. Mirrors the real
// shape verified in usageIngest.test.ts's openDispatch/completionEvent
// helpers, plus the tool_result line this plan's Task 1 reads from.
function agentToolUseLine(toolUseId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    timestamp,
    message: {
      model: 'claude-sonnet-4-6',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { subagent_type: 'CINDER' } }],
    },
  });
}

function taskNotificationLine(
  toolUseId: string,
  timestamp: string,
  parts: { tokens?: number; toolUses?: number; durationMs?: number } = {},
): string {
  const { tokens = 100, toolUses = 6, durationMs = 65_000 } = parts;
  return JSON.stringify({
    type: 'user',
    sessionId: 's1',
    timestamp,
    origin: { kind: 'task-notification' },
    message: {
      content: [
        {
          type: 'text',
          text:
            `<tool-use-id>${toolUseId}</tool-use-id>` +
            `<subagent_tokens>${tokens}</subagent_tokens>` +
            `<tool_uses>${toolUses}</tool_uses>` +
            `<duration_ms>${durationMs}</duration_ms>`,
        },
        { type: 'tool_result', tool_use_id: toolUseId, content: 'Implemented the feature, all tests passing.' },
      ],
    },
  });
}

describe('scanTranscriptsOnce -- memory extraction queueing', () => {
  it('queues a closed, substantive Agent dispatch for extraction when a queue is provided', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-mem-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    const lines = [
      agentToolUseLine('tu_1', '2026-07-08T09:00:00Z'),
      taskNotificationLine('tu_1', '2026-07-08T09:01:05Z', { durationMs: 65_000, toolUses: 6 }),
    ].join('\n');
    writeFileSync(join(projDir, 'session.jsonl'), `${lines}\n`, 'utf8');

    const db = freshDb();
    const queue = createMemoryExtractQueue();
    scanTranscriptsOnce(db, projectsRoot, 2000, new Map(), queue);

    expect(queue.size()).toBe(1);
    const drained = queue.drain();
    expect(drained[0]).toMatchObject({
      agentId: 'CINDER',
      toolUseId: 'tu_1',
      runSummary: 'Implemented the feature, all tests passing.',
    });
    db.close();
  });

  it('does not queue a dispatch that falls below the extraction bar (short duration, few tool uses)', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-mem-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    const lines = [
      agentToolUseLine('tu_1', '2026-07-08T09:00:00Z'),
      taskNotificationLine('tu_1', '2026-07-08T09:00:05Z', { durationMs: 3_000, toolUses: 1 }),
    ].join('\n');
    writeFileSync(join(projDir, 'session.jsonl'), `${lines}\n`, 'utf8');

    const db = freshDb();
    const queue = createMemoryExtractQueue();
    scanTranscriptsOnce(db, projectsRoot, 2000, new Map(), queue);

    expect(queue.size()).toBe(0);
    db.close();
  });

  it('does not queue anything, and does not throw, when no queue is provided (existing callers unaffected)', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-mem-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    const lines = [
      agentToolUseLine('tu_1', '2026-07-08T09:00:00Z'),
      taskNotificationLine('tu_1', '2026-07-08T09:01:05Z', { durationMs: 65_000, toolUses: 6 }),
    ].join('\n');
    writeFileSync(join(projDir, 'session.jsonl'), `${lines}\n`, 'utf8');

    const db = freshDb();
    expect(() => scanTranscriptsOnce(db, projectsRoot, 2000, new Map())).not.toThrow();
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/transcriptScan.test.ts`
Expected: FAIL — `scanTranscriptsOnce` does not accept/use a 5th argument, `queue.size()` stays 0 in the first two new cases (behavior not implemented yet); TypeScript may also flag the extra argument since the parameter doesn't exist yet.

- [ ] **Step 3: Modify `transcriptScan.ts`**

Add the import at the top (alongside the existing imports):

```typescript
import { extractDispatchResultText } from './dispatchResultText.js';
import type { MemoryExtractQueue } from './memoryExtractQueue.js';
```

Add this constant near the top of the file, after the existing helper functions and before `scanTranscriptsOnce`:

```typescript
// docs/superpowers/specs/2026-07-31-memory-layer2-wiring-design.md SS4.
// Trivial one-shot dispatches are unlikely to produce a judgment worth
// remembering; this keeps claude -p spawn frequency proportional to
// substantive work. Not tuned against real traffic -- revisit once this has
// run for a while, same caveat as the Layer 2 spec's own Phase E.
function clearsExtractionBar(durationMs: number, toolUses: number): boolean {
  return durationMs >= 60_000 || toolUses >= 5;
}
```

Change the `parsedEvents` construction (currently a single `.map().filter()` chain) to preserve raw-line/event pairing, and derive `parsedEvents` from the pairs:

```typescript
const parsedPairs = lines
  .map((l) => ({ rawLine: l, event: parseTranscriptLine(l) }))
  .filter((p): p is { rawLine: string; event: NonNullable<ReturnType<typeof parseTranscriptLine>> } => p.event !== null);
const parsedEvents = parsedPairs.map((p) => p.event);
```

(This replaces the existing `const parsedEvents = lines.map((l) => parseTranscriptLine(l)).filter(...)` block. Every existing use of `parsedEvents` below it — `ingestUsageEvent`, `ingestToolCallsAndAnomalies`, the `ingestDispatchEvent` loop, `sweepStaleDispatches` — is unchanged; they still iterate `parsedEvents`, which has the same contents and order as before.)

Add the new pass **after** the existing `ingestDispatchEvent` loop and **before** `sweepStaleDispatches` (extraction should see a dispatch that just closed this tick, and should not fire for a dispatch the sweep is about to mark fatal instead — `sweepStaleDispatches` only fires on dispatches `ingestDispatchEvent` did NOT just close, per its own existing guard, so ordering relative to it does not change which dispatches qualify, but placing extraction after real closures and before the fatal sweep keeps the read-then-queue logic adjacent to the closure it depends on):

```typescript
// Memory Layer 2 wiring (docs/superpowers/specs/2026-07-31-memory-layer2-wiring-design.md
// SS2). extractQueue is optional so every existing caller (including this
// file's own tests) is unaffected when omitted -- extraction is simply
// skipped. Reads pair.rawLine (the raw JSONL line still in memory for this
// scan tick), never re-opens the file and never persists the text anywhere.
if (extractQueue) {
  for (const pair of parsedPairs) {
    if (pair.event.originKind !== 'task-notification') continue;
    const idMatch = (pair.event.humanText || '').match(/<tool-use-id>(.*?)<\/tool-use-id>/);
    if (!idMatch) continue;
    const toolUseId = idMatch[1];

    const row = db
      .prepare(
        'SELECT agent_id, task_kind, session_id, duration_ms, tool_uses, exit_state FROM dispatches WHERE tool_use_id = ?',
      )
      .get(toolUseId) as
      | { agent_id: string | null; task_kind: string | null; session_id: string | null; duration_ms: number; tool_uses: number; exit_state: string }
      | undefined;
    if (!row || !row.agent_id) continue;
    if (row.exit_state !== 'ok') continue;
    if (!clearsExtractionBar(row.duration_ms, row.tool_uses)) continue;

    const runSummary = extractDispatchResultText(pair.rawLine, toolUseId);
    if (!runSummary) continue;

    extractQueue.push({
      agentId: row.agent_id,
      taskKind: row.task_kind ?? row.agent_id,
      sessionId: row.session_id,
      toolUseId,
      runSummary,
      queuedAtMs: nowMs,
    });
  }
}
```

Update `scanTranscriptsOnce`'s signature to accept the new optional parameter:

```typescript
export function scanTranscriptsOnce(
  db: DatabaseSync,
  projectsRoot: string,
  nowMs: number,
  historyByFile: Map<string, ToolCallHistory>,
  extractQueue?: MemoryExtractQueue
): { filesScanned: number; eventsIngested: number; toolCallsIngested: number; anomaliesIngested: number } {
```

(Only the signature line changes; the return type and every other line of the function body outside what's described above is untouched.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/transcriptScan.test.ts`
Expected: PASS (all existing cases plus 3 new ones).

- [ ] **Step 5: Commit**

```bash
cd collector
git add src/transcriptScan.ts src/transcriptScan.test.ts
git commit -m "feat(memory-layer-2): queue substantive closed dispatches for memory extraction"
```

---

### Task 4: Wire the drain timer and `memoryStore` into `index.ts`

**Files:**
- Modify: `collector/src/index.ts`
- Test: `collector/src/index.test.ts` (add cases; existing cases must keep passing unmodified)

**Interfaces:**
- Consumes: `createMemoryExtractQueue`, `drainMemoryExtractQueue` (Task 2); `createMemoryStore` from `./memoryStore.js` (already shipped).
- Produces: `startCollector`'s two new required options (`memoryDbPath`, `memoryExtractIntervalMs`) — nothing later in this plan consumes them; this is the plan's final wiring point.

- [ ] **Step 1: Write the failing tests**

First, read `collector/src/index.test.ts` to see the exact existing test structure for `startCollector` (it constructs temp directories and calls `startCollector` with a full options object, then calls the returned stop function). Add a new test following that same structure:

```typescript
it('opens a memory store at the configured path and closes it on stop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-index-mem-'));
  const stop = startCollector({
    dbPath: join(dir, 'collector.db'),
    spoolDir: join(dir, 'spool'),
    tailIntervalMs: 1_000_000, // effectively never fires during this test
    compactIntervalMs: 1_000_000,
    projectsRoot: join(dir, 'projects'),
    transcriptScanIntervalMs: 1_000_000,
    ownSessionFilePath: join(dir, 'own-session.json'),
    fleetPollIntervalMs: 1_000_000,
    memoryDbPath: join(dir, 'memory.db'),
    memoryExtractIntervalMs: 1_000_000,
  });

  expect(existsSync(join(dir, 'memory.db'))).toBe(true);
  expect(() => stop()).not.toThrow();
  // A second start against the same path must succeed (proves stop() actually
  // closed the file handle rather than leaking it).
  const stop2 = startCollector({
    dbPath: join(dir, 'collector.db'),
    spoolDir: join(dir, 'spool'),
    tailIntervalMs: 1_000_000,
    compactIntervalMs: 1_000_000,
    projectsRoot: join(dir, 'projects'),
    transcriptScanIntervalMs: 1_000_000,
    ownSessionFilePath: join(dir, 'own-session.json'),
    fleetPollIntervalMs: 1_000_000,
    memoryDbPath: join(dir, 'memory.db'),
    memoryExtractIntervalMs: 1_000_000,
  });
  expect(() => stop2()).not.toThrow();
});
```

Add the necessary import at the top of the test file if not already present: `import { existsSync } from 'node:fs';` (check the existing imports first — `mkdtempSync`/`join`/`tmpdir` are almost certainly already imported for other tests in this file; reuse them, do not duplicate).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/index.test.ts`
Expected: FAIL — `startCollector`'s options type does not have `memoryDbPath`/`memoryExtractIntervalMs` yet (TypeScript error) and `memory.db` is never created.

- [ ] **Step 3: Modify `index.ts`**

Add imports:

```typescript
import { createMemoryStore } from './memoryStore.js';
import { createMemoryExtractQueue, drainMemoryExtractQueue } from './memoryExtractQueue.js';
```

Extend `startCollector`'s options parameter type:

```typescript
export function startCollector(options: {
  dbPath: string;
  spoolDir: string;
  tailIntervalMs: number;
  compactIntervalMs: number;
  projectsRoot: string;
  transcriptScanIntervalMs: number;
  ownSessionFilePath: string;
  fleetPollIntervalMs: number;
  memoryDbPath: string;
  memoryExtractIntervalMs: number;
}): () => void {
```

Inside the function body, after `const db = openDatabase(options.dbPath); migrate(db);`, add:

```typescript
const memoryStore = createMemoryStore(options.memoryDbPath);
const extractQueue = createMemoryExtractQueue();
```

Change the `scanTranscriptsOnce` call sites (both the immediate call and the one inside `transcriptScanTimer`'s `setInterval` callback) to pass `extractQueue` as the 5th argument:

```typescript
scanTranscriptsOnce(db, options.projectsRoot, Date.now(), toolCallHistoryByFile, extractQueue);
```

and inside the timer:

```typescript
const transcriptScanTimer = setInterval(
  () => scanTranscriptsOnce(db, options.projectsRoot, Date.now(), toolCallHistoryByFile, extractQueue),
  options.transcriptScanIntervalMs
);
```

Add the drain timer, following the exact pattern the existing `fleetPollTimer` block already uses (fire once immediately, catching and logging, then on an interval):

```typescript
drainMemoryExtractQueue(memoryStore, extractQueue).catch((err) =>
  console.error('[aether-collector] memory extraction failed:', err)
);
const memoryExtractTimer = setInterval(() => {
  drainMemoryExtractQueue(memoryStore, extractQueue).catch((err) =>
    console.error('[aether-collector] memory extraction failed:', err)
  );
}, options.memoryExtractIntervalMs);
```

Update the returned stop function to clear the new timer and close the new store:

```typescript
return () => {
  stopTailer();
  clearInterval(compactTimer);
  clearInterval(transcriptScanTimer);
  clearInterval(fleetPollTimer);
  clearInterval(memoryExtractTimer);
  memoryStore.close();
  db.close();
};
```

Finally, update the real-process wiring block at the bottom of the file (inside `if (isMainModule) { ... }`) to supply the two new options:

```typescript
const stop = startCollector({
  dbPath: join(aetherDir, 'collector.db'),
  spoolDir: join(aetherDir, 'spool'),
  tailIntervalMs: 2000,
  compactIntervalMs: 60 * 60 * 1000, // hourly
  projectsRoot: join(homedir(), '.claude', 'projects'),
  transcriptScanIntervalMs: 15000,
  ownSessionFilePath: join(aetherDir, 'own-session.json'),
  fleetPollIntervalMs: 15000,
  memoryDbPath: join(aetherDir, 'memory.db'),
  memoryExtractIntervalMs: 15000,
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/index.test.ts`
Expected: PASS (all existing cases plus the new one).

- [ ] **Step 5: Commit**

```bash
cd collector
git add src/index.ts src/index.test.ts
git commit -m "feat(memory-layer-2): open memory store and drain extraction queue in startCollector"
```

---

### Task 5: End-to-end integration test and full-suite verification

**Files:**
- Create: `collector/src/memoryLayer2Wiring.integration.test.ts`

**Interfaces:**
- Consumes: `scanTranscriptsOnce` (unmodified export, Task 3's new behavior), `createMemoryExtractQueue`/`drainMemoryExtractQueue` (Task 2), `createMemoryStore`/`getPrivateCandidates` (already shipped, unmodified).
- Produces: nothing new — this is the plan's final verification task.

- [ ] **Step 1: Write the integration test**

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate } from './schema.js';
import { scanTranscriptsOnce } from './transcriptScan.js';
import { createMemoryStore } from './memoryStore.js';
import { createMemoryExtractQueue, drainMemoryExtractQueue } from './memoryExtractQueue.js';

// Mirrors the fixture helpers introduced in Task 3's transcriptScan.test.ts
// additions, kept local to this file since an integration test should not
// depend on another test file's unexported helpers.
function agentToolUseLine(toolUseId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    timestamp,
    message: {
      model: 'claude-sonnet-4-6',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { subagent_type: 'CINDER' } }],
    },
  });
}

function taskNotificationLine(toolUseId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId: 's1',
    timestamp,
    origin: { kind: 'task-notification' },
    message: {
      content: [
        {
          type: 'text',
          text:
            `<tool-use-id>${toolUseId}</tool-use-id>` +
            `<subagent_tokens>500</subagent_tokens>` +
            `<tool_uses>8</tool_uses>` +
            `<duration_ms>90000</duration_ms>`,
        },
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'User overruled a suggestion to add a retry loop, accepting unbounded retry instead.',
        },
      ],
    },
  });
}

describe('Memory Layer 2 wiring -- end to end', () => {
  it('scans a transcript with a substantive closed dispatch, queues it, drains it through a fake model, and lands a row in memory.db', async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-e2e-mem-projects-'));
    const dbDir = mkdtempSync(join(tmpdir(), 'aether-e2e-mem-db-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    const lines = [
      agentToolUseLine('tu_1', '2026-07-08T09:00:00Z'),
      taskNotificationLine('tu_1', '2026-07-08T09:01:30Z'),
    ].join('\n');
    writeFileSync(join(projDir, 'session.jsonl'), `${lines}\n`, 'utf8');

    const db = openDatabase(join(dbDir, 'collector.db'));
    migrate(db);
    const memoryStore = createMemoryStore(join(dbDir, 'memory.db'));
    const extractQueue = createMemoryExtractQueue();

    try {
      scanTranscriptsOnce(db, projectsRoot, Date.now(), new Map(), extractQueue);
      expect(extractQueue.size()).toBe(1);

      await drainMemoryExtractQueue(memoryStore, extractQueue, async () => ({
        stdout:
          '[{"op":"ADD","kind":"overrule","content":"Matt overruled adding a retry loop, accepting unbounded retry instead."}]',
      }));

      const rows = memoryStore.getPrivateCandidates('CINDER');
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toContain('unbounded retry');
      expect(rows[0].kind).toBe('overrule');
    } finally {
      memoryStore.close();
      db.close();
      rmSync(projectsRoot, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the new test**

Run (from `collector/`): `npx vitest run src/memoryLayer2Wiring.integration.test.ts`
Expected: PASS (1 test).

- [ ] **Step 3: Run the full collector test suite**

Run: `npx vitest run`
Expected: PASS — every existing suite plus all new tests from Tasks 1-5 (this plan adds 8 + 5 + 3 + 1 + 1 = 18 new tests).

- [ ] **Step 4: Run the TypeScript build**

Run: `npx tsc -b`
Expected: exits 0, no errors.

- [ ] **Step 5: Commit**

```bash
cd collector
git add src/memoryLayer2Wiring.integration.test.ts
git commit -m "test(memory-layer-2): end-to-end integration test for the wiring"
```

---

## What this plan deliberately does not cover

(Mirrors `docs/superpowers/specs/2026-07-31-memory-layer2-wiring-design.md` §6.)

- **Shared-scope (`STEWARD`) writes.** No design exists for this; separate future work.
- **Retry on failed extraction.** A failed item is logged and dropped.
- **Backpressure / queue-depth alerting.** `queue.size()` exists as a hook; nothing reads it yet.
- **Tuning the extraction bar's thresholds (`60_000`ms / `5` tool uses) against real traffic.** Starting values, not measured ones.
- **The Memory view (Phase D).** Nothing in this plan renders extracted memories anywhere.
- **Running this against the real `claude` CLI.** Every test in this plan uses an injected `execFn`; the first real invocation happens only when this code runs in the actual collector process on a real machine, same caveat Phase B's own closeout already carries forward.
