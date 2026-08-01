# Memory Layer 2 — Wiring `runExtractor` Into the Collector

**Design document**
Status: approved, ready for implementation plan
Companion to: `AETHER_MEMORY_LAYER_2.md` (Phase B, already shipped at `2f786bc`)

---

## 0. What this is

Phase B (`docs/superpowers/specs/AETHER_MEMORY_LAYER_2.md`) built `runExtractor` —
the full call → parse → apply pipeline — and proved it correct against injected
fake exec functions. Nothing calls it. This document is the wiring: the one
missing piece that turns a closed Agent dispatch into an actual `claude -p`
call and, sometimes, a row in `memory.db`.

**Non-goal:** shared-scope (`STEWARD`) writes. Layer 1 §10 makes `STEWARD` a
viewer-side persona with no process of its own (Layer 2 spec, decision #1,
already closed) — this document wires **private-scope extraction only**, one
subagent learning about its own history with the user. Shared-scope proposal
is separate future work with no design here.

---

## 1. The blocking problem this document solves

`runExtractor`'s `runSummary: string` input has no source. The collector's
shared `TranscriptEvent` type (`transcriptParser.ts`) deliberately reduces a
tool result to `{ toolUseId, resultLength }` — the actual content is read once
to compute `.length` and discarded, per `docs/privacy-and-data.md`'s house
rule that tool-result payloads must never be persisted. That type is used
everywhere in the collector and is privacy-audited as such; widening it to
carry content would relax a guarantee well beyond this one use.

**Resolution: read the Agent tool's result content live, from the raw JSONL
line already in hand, at the one call site that needs it — never persist it,
never add it to the shared parser's output type.**

---

## 2. Where this hooks in

`transcriptScan.ts`'s `scanTranscriptsOnce` builds `parsedEvents` like this
today:

```ts
const parsedEvents = lines
  .map((l) => parseTranscriptLine(l))
  .filter((e): e is NonNullable<typeof e> => e !== null);
```

**This drops the positional correspondence between `lines[i]` and
`parsedEvents[i]`** — a line that fails to parse is filtered out, so index `i`
in one array does not mean index `i` in the other from that point on. Reading
the raw line for a given event (§2.1) needs that correspondence, so this
document changes the construction to filter as pairs instead of filtering
after mapping:

```ts
const parsedPairs = lines
  .map((l) => ({ rawLine: l, event: parseTranscriptLine(l) }))
  .filter((p): p is { rawLine: string; event: TranscriptEvent } => p.event !== null);
const parsedEvents = parsedPairs.map((p) => p.event);
```

`parsedEvents` keeps its existing name and shape (every other call site in
this function — `ingestUsageEvent`, `ingestToolCallsAndAnomalies`,
`ingestDispatchEvent`, `sweepStaleDispatches` — is unaffected and unchanged),
derived from `parsedPairs` rather than being the primary array. Only the new
pass (below) iterates `parsedPairs` instead of `parsedEvents`, to reach each
event's raw line.

The existing dispatch-completion loop:

```ts
for (const event of parsedEvents) {
  ingestDispatchEvent(db, anomalyResult.history, event);
}
```

gains a second pass over `parsedPairs`, after it, that:

1. Confirms the just-closed dispatch is `exit_state: 'ok'` (never `'fatal'` —
   a stale/timed-out dispatch produced no real final report to extract from).
2. Confirms it clears the extraction bar (§4).
3. Extracts the raw result text for that `tool-use-id` from `pair.rawLine`
   (§2.1), not from the already-reduced `TranscriptEvent`.
4. Pushes a queue entry — never calls `runExtractor` inline (§3).

`ingestDispatchEvent` already returns `boolean` (closed or not); this
document does not change its signature. The new pass reads the `dispatches`
row `ingestDispatchEvent` just wrote (a `SELECT ... WHERE tool_use_id = ?`) to
get `agent_id`, `task_kind`, `duration_ms`, `tool_uses`, `session_id`,
`exit_state`, and `tool_use_id`, rather than re-deriving those values from
`ToolCallHistory` a second time.

### 2.1 Reading the raw result text

New function, `collector/src/dispatchResultText.ts`:

```ts
export function extractDispatchResultText(rawLine: string, toolUseId: string): string | null
```

Parses `rawLine` as JSON itself (independent of `parseTranscriptLine`, which
already ran and discarded what we need), finds the `user`-kind message's
`content` array, finds the `tool_result` item whose `tool_use_id` matches,
and returns its `content` coerced to a string (the Agent tool's result
content is either a plain string or a content-block array with `type:
'text'` items — join text items if it's the latter, matching the
`transcriptParser.ts` text-extraction convention already used for `humanText`).
Returns `null` on any parse failure, missing match, or empty content — never
throws, matching every other tolerant-parsing convention in this package.

This function touches **only** the raw line already read into memory for
this scan tick (`readNewLinesSync` already has it); it opens no new file
handle and adds no new I/O.

---

## 3. Async, off the ingest loop

`scanTranscriptsOnce` stays fully synchronous — no `await` enters it. The new
pass pushes onto an in-memory queue instead of calling `runExtractor`
directly:

`collector/src/memoryExtractQueue.ts`:

```ts
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
    push(item: QueuedExtraction): void { items.push(item); },
    drain(): QueuedExtraction[] { return items.splice(0, items.length); },
    size(): number { return items.length; },
  };
}
export type MemoryExtractQueue = ReturnType<typeof createMemoryExtractQueue>;
```

A queue, not a channel or an event emitter, because `startCollector` already
has exactly this shape of decoupling for `pollAndUpsertFleet` (a `setInterval`
calling an async function, logging and swallowing errors) — the queue is the
minimal structure that lets `scanTranscriptsOnce` (sync, ticks every 15s) and
the new drain timer (async, ticks independently) not share a call stack.

`startCollector` gains one more `setInterval`, mirroring `fleetPollTimer`:

```ts
const memoryStore = createMemoryStore(options.memoryDbPath);
const extractQueue = createMemoryExtractQueue();
// ... extractQueue threaded into scanTranscriptsOnce's options ...
const memoryExtractTimer = setInterval(() => {
  drainMemoryExtractQueue(memoryStore, extractQueue).catch((err) =>
    console.error('[aether-collector] memory extraction failed:', err)
  );
}, options.memoryExtractIntervalMs);
```

`drainMemoryExtractQueue` (`collector/src/memoryExtractQueue.ts`, same file):

```ts
export async function drainMemoryExtractQueue(
  store: MemoryStore,
  queue: MemoryExtractQueue,
  execFn?: ExtractExecFn,
): Promise<void> {
  for (const item of queue.drain()) {
    const existingMemories = store.getPrivateCandidates(item.agentId, 20)
      .map((m) => ({ id: m.id, kind: m.kind, content: m.content }));
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
        `[aether-collector] memory extraction issue for ${item.agentId}:`,
        result.parseError ?? result.rejected,
      );
    }
  }
}
```

Sequential `for...of` with `await` inside, not `Promise.all` — extraction
calls spawn real `claude -p` processes; running them one at a time bounds
concurrent subprocess count to 1, which matches this being a personal
single-user cockpit with no throughput requirement here. If the queue grows
faster than it drains, that is visible as `queue.size()` staying nonzero
(not measured/alerted in this document — out of scope, §6).

`existingMemories` capped at 20, well under the store's own default 200-row
internal cap (`getPrivateCandidates`'s own default), to keep the prompt small
per §4.4 of the Layer 2 spec's practical-ceiling note.

---

## 4. The extraction bar

Only dispatches clearing a minimum bar are queued:

```ts
const CLEARS_EXTRACTION_BAR = (durationMs: number, toolUses: number): boolean =>
  durationMs >= 60_000 || toolUses >= 5;
```

Trivial one-shot dispatches (a quick lookup, a single tool call) are unlikely
to produce a judgment worth remembering per the Layer 2 spec's own filter
(§1: *"if this entry were wrong, how would I find out?"* — a judgment needs
enough substance to be checkable at all), and this keeps `claude -p` spawn
frequency proportional to substantive work rather than every dispatch close.
The two thresholds are `OR`, not `AND`: a short-but-tool-heavy dispatch and a
long-but-tool-light one are both plausible sources of a real judgment.

These constants are not tuned against real traffic — same caveat as the
Layer 2 spec's own Phase E ("parked, needs real traffic") for its scoring
weights. Revisit once this has run for a while.

---

## 5. `memory.db` lifecycle

Opened once in `startCollector`, alongside `collector.db`'s own open,
default path `join(homedir(), '.aether-os', 'memory.db')` per the Layer 2
spec §3.1b (a separate file from `collector.db`, never subject to
`collector.db`'s retention/purge sweep). Held for the process lifetime,
closed in `startCollector`'s returned stop function alongside `db.close()`.

```ts
export function startCollector(options: {
  // ... existing fields ...
  memoryDbPath: string;
  memoryExtractIntervalMs: number;
}): () => void {
  // ... existing opens ...
  const memoryStore = createMemoryStore(options.memoryDbPath);
  // ...
  return () => {
    // ... existing stops ...
    memoryStore.close();
  };
}
```

The real-process wiring block at the bottom of `index.ts` gains
`memoryDbPath: join(aetherDir, 'memory.db')` and
`memoryExtractIntervalMs: 15000` (matching `transcriptScanIntervalMs`, no
strong reason to diverge — the queue is typically near-empty between ticks).

---

## 6. What this document deliberately does not cover

- **Shared-scope (`STEWARD`) writes.** No design here; separate future work.
- **Retry on failed extraction.** A failed item is logged and dropped, matching
  the collector's existing fire-and-forget-with-logging convention (fleet
  poll, retention). If this proves too lossy in practice, a retry queue is a
  follow-up, not part of this wiring.
- **Backpressure / queue-depth alerting.** `queue.size()` exists as a hook for
  future observability; nothing reads it yet.
- **Tuning the extraction bar's thresholds against real traffic.** Stated as
  a starting point, not a measured one (§4).
- **The Memory view (Phase D).** Nothing here renders extracted memories
  anywhere; they land in `memory.db` and stay there until Phase D exists.

---

## 7. Build order

1. `dispatchResultText.ts` — `extractDispatchResultText`, pure function, unit
   tested against raw JSONL fixtures (string-content and array-content
   shapes, missing match, malformed JSON).
2. `memoryExtractQueue.ts` — `createMemoryExtractQueue`, `drainMemoryExtractQueue`,
   tested with an injected `execFn` (same convention as `runExtractor` itself)
   and a real `createMemoryStore`-backed store, not mocked.
3. `transcriptScan.ts` — thread the queue through `scanTranscriptsOnce`'s
   options, add the extraction-bar check and the new pass over
   `parsedEvents`/raw `lines` pairing.
4. `index.ts` — open `memoryStore`, wire the drain timer, extend
   `startCollector`'s options and the real-process wiring block.
5. End-to-end integration test: a synthetic transcript fixture with a
   qualifying Agent dispatch closure, drive `scanTranscriptsOnce` then
   `drainMemoryExtractQueue` with an injected `execFn` returning a valid ADD
   op, assert the row lands in a real `memory.db`-backed store via
   `getPrivateCandidates`.
