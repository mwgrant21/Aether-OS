# Real Dispatch Token/Tool-Use History (Phase 3, slice 7) — Design

## Context

The completion event this app already tails (`electron/liveAgentTracker.ts` → `src/state/liveAgentsMath.ts`'s `applyLinesToOpenDispatches`) carries a `<usage>` block alongside the `<tool-use-id>` it already extracts:

```
<usage><subagent_tokens>96639</subagent_tokens><tool_uses>8</tool_uses><duration_ms>194546</duration_ms></usage>
```

Confirmed present in real transcript files (grepped `~/.claude/projects/**/*.jsonl` directly, not assumed), and it has been sitting unused since Phase 3's first slice — every slice since (Grid, Agents, Analytics, Memory, Chat) built on top of `RealAgentDispatch`'s existing fields (`subagentType`/`description`/`prompt`/`model`/`startedAt`) without ever touching this data. `PROGRESS.md`'s Analytics entry (slice 4) explicitly flagged this as deferred: the fictional "AGENT BURN BREAKDOWN" card was reframed around elapsed time specifically because real token data wasn't available yet.

**Why this slice is structurally different from Memory (slice 5) and Chat (slice 6):** both of those slices captured data by diffing `state.realAgents` before/after a `SET_REAL_AGENTS` action — a purely renderer-side comparison, because every field they needed was already attached to the dispatch *while it was open*. Token/tool-use/duration data does not exist until the exact moment of completion and is never attached to the `RealAgentDispatch` object at all — `applyLinesToOpenDispatches`'s completion branch (`liveAgentsMath.ts:40-44`) matches `<tool-use-id>`, deletes the dispatch from its internal open map, and discards everything else in the completion event's content, including `<usage>`. A renderer-side diff cannot recover data that was never captured. **This is the one slice in this migration that genuinely requires touching the electron-side parser**, not an optional precision-vs-scope trade-off like slice 5/6 faced.

All three `<usage>` fields turn out to matter (an initial assumption that `duration_ms` was redundant with client-computed elapsed time was wrong): `subagent_tokens`/`tool_uses` are new information regardless, and `duration_ms` is the *only* way to know a completed dispatch's total elapsed time — nothing tracks when a dispatch ended, so once it's gone from `state.realAgents`, client-side elapsed-time computation (`now - startedAt`) is no longer possible at all.

Raised to the user during brainstorming, three consumer surfaces were chosen (not exclusive): Analytics, Memory, and Chat. A further finding changed the Analytics angle specifically: the existing "LONGEST-RUNNING AGENTS" card (`AgentBreakdownCard.tsx`/`computeRealAgentBreakdown`) reads `state.realAgents` — **currently-running** dispatches only. Token/tool-use counts are only known *after* completion, so they cannot enrich that card's existing scope at all. The user chose a new, second card (recently-completed, ranked by tokens) over a third reframing of the same card.

## Goal

Capture real `tokens`/`toolUses`/`durationMs` at the moment a dispatch completes, store it keyed by `toolUseId`, and surface it in three places: a new Analytics card (recently-completed dispatches ranked by token burn), an enrichment line on Memory's auto-created completion entries, and a sentence in Chat's retrospective dispatch-channel system prompt.

## Non-goals

- **No change to `applyLinesToOpenDispatches`'s existing return type or the behavior of its 12 existing tests.** Capturing usage data is added via a new **optional third parameter** (an out-array the caller passes in to receive completions), not by restructuring the function's return shape — this keeps every existing call site and test byte-for-byte unaffected when the new parameter is omitted.
- **No change to Memory's or Chat's existing completion-detection mechanism** (`detectCompletedDispatches`, the renderer-side diff slices 5/6 already built). This slice's new data arrives via a **separate, independent channel** (a new IPC event, a new state field), looked up by consumers **at render/prompt-build time**, not injected into the existing creation-time object construction. This sidesteps any ordering dependency between the new event and the existing diff-based mechanism entirely — if usage data hasn't arrived yet when a Memory entry or Chat channel is created, the UI simply shows nothing extra until the next render, once it lands.
- **No UI display for Chat's dispatch channels** — enrichment there is prompt-only (the persona can mention real numbers if it comes up), not a separate visible stat line, keeping that consumer's scope tight.
- **No perfect retention guarantee.** `state.dispatchUsage` is capped at 100 entries (independent of `recentCompletedDispatches`'s 20-item cap, since permanent Chat channels need a better chance of keeping their stats than the transient picker pool does) — a very old dispatch channel's usage stats can still be evicted eventually. Accepted, not solved.
- **No retroactive backfill.** Only dispatches that complete *after* this feature ships get usage data; historical Memory entries/dispatch channels created before this slice simply show no usage line (Memory) or omit the usage sentence (Chat), which their existing render/prompt logic already handles gracefully via the same "look it up, show nothing if absent" pattern used for anything not yet arrived.
- **No change to the Analytics 2×2 grid's other three cards** (`TopCommandsCard`/`SystemMetricsCard`/`LogFrequencyCard`) — only the grid's layout dimensions change to fit a fifth card; their own content is untouched.

## Architecture

### `src/state/liveAgentsMath.ts`

New type:

```ts
export interface CompletedDispatchUsage extends RealAgentDispatch {
  tokens: number;
  toolUses: number;
  durationMs: number;
}
```

`applyLinesToOpenDispatches` gains one new **optional** parameter, `completedOut?: CompletedDispatchUsage[]` — when provided, the function pushes a `CompletedDispatchUsage` record into it every time it matches a genuine completion for a dispatch it recognizes (mirroring the exact same lookup its existing deletion logic already does), in addition to its existing, completely unchanged behavior. When omitted (every existing call site, including all 12 existing tests), the function behaves identically to today. Usage fields are parsed defensively from the same completion event's content string that already yields `<tool-use-id>`, defaulting to `0` if any individual field is missing (matching this codebase's established defensive-parsing convention elsewhere — e.g. `subagentType` defaulting to `'agent'`).

### `electron/liveAgentTracker.ts`

`tick()`'s return type changes from `Promise<RealAgentDispatch[]>` to `Promise<{ open: RealAgentDispatch[]; completed: CompletedDispatchUsage[] }>` — this function has no existing unit tests (electron-layer, no automated coverage per established precedent) and its only caller, `main.ts`'s `tickAndPushAgents`, is being updated in the same task, so this signature change is fully contained. Each of the function's three `applyLinesToOpenDispatches` call sites passes a fresh `completed: CompletedDispatchUsage[] = []` array as the new third argument and returns it alongside `open`.

### `electron/main.ts`

`tickAndPushAgents` destructures the new `{ open, completed }` shape: `agents:snapshot` keeps sending `open` exactly as before (zero change for any existing consumer), and a new `agents:completed` event sends `completed` — only when non-empty, avoiding IPC spam on the common case (most 1s ticks have no completions).

### `electron/preload.ts` / `src/aetherElectron.d.ts`

Additive: `window.aetherElectron.agents.onCompleted(callback)`, mirroring the existing `onSnapshot`'s exact shape (subscribe/unsubscribe pair over `ipcRenderer.on`/`removeListener`), typed against `CompletedDispatchUsage[]`.

### `src/state/useRealAgentsSync.ts`

A second, independent `useEffect` subscribes to `agents.onCompleted` and dispatches a new action, `RECORD_DISPATCH_USAGE`. The existing `onSnapshot`-driven effect is completely untouched.

### `src/state/reducer.ts`

New state field `dispatchUsage: Record<string, { tokens: number; toolUses: number; durationMs: number }>` (seeded `{}`). New action `{ type: 'RECORD_DISPATCH_USAGE'; completed: CompletedDispatchUsage[] }`: merges each completion's `{tokens, toolUses, durationMs}` into `dispatchUsage` keyed by `toolUseId`, then caps the map at 100 entries by evicting the oldest keys (JS object key insertion order is reliable here since `toolUseId` strings are never plain-integer-like — worth a one-line comment noting this assumption explicitly, since it's the kind of subtle correctness dependency a future editor could break without realizing).

### Memory enrichment

`MemoryStub` gains an optional `toolUseId?: string`. Slice 5's existing completion-triggered memory-creation block (`reducer.ts`'s `SET_REAL_AGENTS` case) adds `toolUseId: dispatch.toolUseId` to the memory object it already builds — a one-line addition to an existing object literal, not a new code path. `MemoryDetailCard.tsx` (and optionally `MemoryRosterCard.tsx`, an implementation-time call for how much detail the compact roster row should carry vs. the full detail card) looks up `state.dispatchUsage[memory.toolUseId ?? '']` and, when present, renders an additional line such as `"Used 12.3K tokens · 8 tool calls · 4m 12s"` below the existing content — nothing rendered when absent (the common case for the app's other three memory sources, which never get a `toolUseId` at all, and for any dispatch-sourced memory whose usage data hasn't arrived yet or aged out of the cap).

### Chat enrichment

`DispatchChannelStub` already carries `toolUseId` (slice 6) — no new field needed. `systemPrompt.ts`'s `buildDispatchPrompt` looks up `state.dispatchUsage[channel.toolUseId]` and, when present, appends one sentence to the retrospective prompt giving the persona real numbers (e.g. "You used approximately 12,300 tokens across 8 tool calls, taking about 4 minutes."). When absent, the prompt is built exactly as slice 6 shipped it — no structural change to the function's existing shape, purely an additional conditional sentence.

### Analytics enrichment

New pure function in `analyticsMath.ts`, e.g. `computeCompletedDispatchBurn(pool: RealAgentDispatch[], usage: Record<string, {tokens: number; toolUses: number; durationMs: number}>): Row[]` — cross-references `state.recentCompletedDispatches` (already exists from slice 6) against `state.dispatchUsage` by `toolUseId`, filters to entries that actually have usage data (a completed dispatch in the pool whose usage hasn't arrived yet, or predates this feature, is simply omitted rather than shown with zeros), sorts by `tokens` descending, caps to a small display count matching this app's other Analytics rows (e.g. top 5). New component, e.g. `TokenBurnCard.tsx`, styled to match `AgentBreakdownCard.tsx`'s existing row/avatar/name/desc conventions exactly, added to `AnalyticsView.tsx`'s grid alongside the existing four. **The grid's CSS (`gridStyle`'s `gridTemplateColumns`/`gridTemplateRows`, currently a plain 2×2) needs to change to fit a fifth card — the exact new layout is an implementation-time call, not decided here.**

## Data flow

Every ~1s tick: `liveAgentTracker.tick()` now returns both the open list and any dispatches that completed on this tick, each carrying real usage stats parsed at the exact moment their completion event was seen. `main.ts` pushes `agents:snapshot` (unchanged) and, when non-empty, `agents:completed` (new). The renderer's existing `SET_REAL_AGENTS`-driven pipeline (Memory/Chat creation, slices 5/6) runs completely independently and unchanged; the new `RECORD_DISPATCH_USAGE` pipeline populates `state.dispatchUsage` on its own schedule. The two mechanisms only ever meet at **render time**, in each consumer's own lookup — never at creation time, so there is no dependency on which event arrives first.

## Error handling / edge cases

- **A `<usage>` field missing or malformed in a completion event**: defaults to `0` for that field individually, matching this codebase's established defensive-parsing style — never throws, never drops the whole completion record over one bad field.
- **Usage data arriving after a Memory entry or Chat channel already exists**: handled by design (render-time lookup) — the UI/prompt simply updates on the next render once `state.dispatchUsage` has the entry, no special-casing needed.
- **Usage data never arriving at all** (app wasn't watching at the exact completion moment, or the entry aged out of the 100-cap): both Memory's detail card and Chat's prompt builder already degrade gracefully to "show nothing extra" — the same `if (!found) return/skip` pattern used throughout this app's other optional-lookup code (e.g. `buildDispatchPrompt`'s own existing no-stub-found fallback from slice 6).
- **`RECORD_DISPATCH_USAGE` firing for a `toolUseId` this app never tracked as open** (a theoretical replay/session-switch edge case): the reducer just adds the entry to `dispatchUsage` unconditionally — harmless, since nothing looks up an untracked `toolUseId` from any UI path anyway.
- **The 100-entry cap's eviction order**: relies on `Object.keys()` preserving insertion order for non-integer-like string keys (a real JS/ECMAScript guarantee, not an assumption) — called out explicitly in the implementation with a comment, since it's a subtle correctness dependency.

## Testing

**Unit (`liveAgentsMath.test.ts`):**
- `applyLinesToOpenDispatches` without the third argument behaves identically to today across all 12 existing tests (regression — no test changes needed, confirming the optional-parameter approach is genuinely non-breaking).
- With the third argument provided: a dispatch that opens and later completes (across two separate calls, mirroring real tick-to-tick usage) produces one entry in the out-array with the correct `tokens`/`toolUses`/`durationMs` parsed from its completion event.
- A dispatch that opens *and* completes within the same batch of lines (the replay-on-session-switch case already covered for the existing open/close logic) still correctly produces a `completedOut` entry.
- Malformed/missing individual `<usage>` sub-fields default to `0` without throwing.
- A completion event for a `tool-use-id` not present in the open map produces no `completedOut` entry (matches the existing no-op-for-unknown-id behavior).

**Unit (`reducer.test.ts`):**
- `RECORD_DISPATCH_USAGE` merges one or more completions into `dispatchUsage`, keyed by `toolUseId`.
- The 100-entry cap evicts the oldest entries first when exceeded.
- The slice-5 Memory-creation block now includes `toolUseId` on the created `MemoryStub` — existing slice-5 tests updated/extended to assert this new field, not just added fresh.

**Unit (`systemPrompt.test.ts`):**
- `buildDispatchPrompt` includes the usage sentence when `state.dispatchUsage` has a matching entry, and omits it (prompt otherwise identical to slice 6's shipped behavior) when absent.

**Unit (`analyticsMath.test.ts`):**
- `computeCompletedDispatchBurn` sorts by `tokens` descending, filters out pool entries with no matching usage data, and respects the display cap.

**Manual GUI QA (plan-exit, per this project's convention):** since a real dispatch completing on demand isn't reliably reproducible (same accepted gap as every real-data-dependent slice so far), this pass is scoped to confirming the Memory detail card and Analytics' new card both render correctly with a manually-seeded `state.dispatchUsage` entry (or an organic completion if one happens to occur during the QA window), and that zero regression exists in Memory's other three sources, Chat's other channel kinds, and Analytics' other three cards.
