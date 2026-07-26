# Instrument + Alarm — Design Spec

**Date:** 2026-07-26
**Status:** Approved, pending implementation plan

## Context

Following the UI Polish Pass, this is the user's stated top-priority item from the earlier Fable-model brainstorm on making Aether OS "truly shine": turning the reactor visualization from decoration into an instrument (real signals mapped to distinct visual channels), and giving it an alarm system that surfaces real problems detected from live transcript activity (re-read loops, write-delete-rewrite cycles, token burn with no file edits, stalled permission prompts).

Research before this design confirmed the codebase's actual state:
- `electron/transcriptParser.ts` already parses each transcript JSONL line into a rich `TranscriptEvent` (model, full token usage including cache creation/read, per-tool-call `toolUses[]` with raw `input`, `toolResults[]` keyed by `toolUseId`) — but it is currently **unused**. `electron/liveAgentTracker.ts` and `src/state/liveAgentsMath.ts` each independently re-parse the raw JSON themselves.
- `applyLinesToOpenWork` (in `liveAgentsMath.ts`) tracks every in-flight tool call as an open "lane," but **deletes each lane on completion** — nothing retains closed tool-call history. This is the one real gap: neither Reactor Semantics nor Anomaly Klaxon can be built without something that remembers what already happened.
- `RealAgentDispatch.model` already exists (nullable string) — the model-tier hue signal is close to free once dispatch tracking is the data source.
- Cache-hit ratio exists nowhere — cache token fields only live in the currently-unused `TranscriptEvent.usage`.
- `src/components/reactor/reactorMath.ts` already establishes the exact pattern to extend: small pure `compute*` functions with documented constants, each consumed by a component prop. Two real signals are already wired (burn rate → pulse, agent count → overdrive/overload).

## Scope

Two features, one implementation plan, sharing one piece of new infrastructure (the ring buffer):

1. **Reactor Semantics Pass** — map hue (dominant model tier), pulse rate (tokens/sec — already done via `computeRateFromUsage`, not re-scoped here), plasma turbulence (agent concurrency), and core clarity/opacity (cache-hit ratio) to distinct visual channels on the StormCore reactor, plus a legend toggle so the mapping is legible, not just vibes.
2. **Anomaly Klaxon** — detect four specific pathologies live from the new tool-call history: re-read loops, write-delete-rewrite cycles, high token burn with zero file edits, and stalled permission prompts. Surface each as a warning ring on the corresponding Grid node and an amber flicker on the reactor.

## Out of scope

- Anomaly *auto-remediation* (killing a dispatch, sending a course-correction) — this pass is detection/surfacing only, matching the original brainstorm's framing of this as the "instrument + alarm" step before the later "Command Deck"/supervision track.
- A persistent activity log (SQLite/JSONL-on-disk) — the ring buffer is in-memory only, reset on pty respawn (matching `liveAgentTracker`'s existing `notifyPtySpawned` reset behavior). Session-crossing history is a future "Replay Theater" concern, not this one.
- Any change to `dispatchUsage`'s existing shape/consumers (Memory, Chat, Analytics) — this pass only adds new data, it doesn't touch how existing consumers read `dispatchUsage`.
- Sound/audio for the "klaxon" — visual-only alarm in this pass; the earlier brainstorm's "Voice of the Ship" TTS idea is separate, deferred work.

## Architecture

### Switching to `parseTranscriptLine`

`electron/liveAgentTracker.ts`'s `tick()` currently passes raw `rawLines: string[]` into `applyLinesToOpenDispatches`/`applyLinesToOpenWork`, both of which do their own `JSON.parse` + manual field digging. This pass changes `tick()` to first map each raw line through `parseTranscriptLine(rawLine): TranscriptEvent | null`, filter out `null`s, and pass the resulting `TranscriptEvent[]` to all three consumers (the two existing functions, updated to accept `TranscriptEvent[]` instead of `string[]`, plus the new ring-buffer updater below). This is a mechanical refactor of the two existing functions' input type — their logic doesn't change, they just read from `TranscriptEvent` fields instead of re-deriving them from raw JSON.

### Ring buffer

New file `electron/toolCallHistory.ts`:

```ts
import type { TranscriptEvent } from './transcriptParser';

export interface ClosedToolCall {
  toolUseId: string;
  toolName: string;
  filePath: string | null; // extracted from input.file_path when present (Read/Edit/Write)
  startedAt: number; // epoch ms
  closedAt: number; // epoch ms
  hadResult: boolean; // false if this entry was force-closed by the buffer's own eviction, not a real toolResult
}

export interface ToolCallHistory {
  events: ClosedToolCall[]; // bounded, oldest evicted first
}

export const HISTORY_MAX_EVENTS = 500;

export function updateHistory(
  history: ToolCallHistory,
  events: TranscriptEvent[],
  nowMs: number,
): ToolCallHistory;
```

`updateHistory` is pure (aside from reading `nowMs` as an explicit parameter, not `Date.now()`, so it stays testable): it tracks in-flight `tool_use` calls (from `toolUses[]`) keyed by `id`, closes them when a matching `toolResults[].toolUseId` arrives, and appends the closed entry to `events`, evicting the oldest entries past `HISTORY_MAX_EVENTS`. `filePath` is extracted the same way `labelForToolUse` already does today (`input.file_path` when present, else `null`).

`electron/liveAgentTracker.ts` holds one `ToolCallHistory` in its closure (reset in `notifyPtySpawned`, same lifecycle as `currentOpen`/`currentWork` today), updates it each `tick()`, and includes it in `LiveAgentTick`'s return shape as a new `history: ToolCallHistory` field.

### Anomaly detectors

New file `src/shared/anomalyDetectors.ts` (pure logic, colocated tests — matches this repo's established `shared/`-with-tests convention, not `electron/`, since detectors don't need Node APIs and this keeps them reachable from both main-process ticking and any future renderer-side use):

```ts
export interface Anomaly {
  kind: 'reReadLoop' | 'writeDeleteRewrite' | 'zeroEditBurn' | 'stalledPermission';
  toolUseId: string; // the triggering/most-recent event's id, for Grid node correlation
  detail: string; // human-readable, e.g. "src/foo.ts read 4 times in 90s"
}

export function detectReReadLoop(events: ClosedToolCall[]): Anomaly[];
export function detectWriteDeleteRewrite(events: ClosedToolCall[]): Anomaly[];
export function detectZeroEditBurn(events: ClosedToolCall[], tokensUsed: number): Anomaly[];
export function detectStalledPermission(openToolUseIds: string[], events: ClosedToolCall[], nowMs: number): Anomaly[];

export function detectAnomalies(history: ToolCallHistory, work: RealActiveWork[], nowMs: number): Anomaly[];
```

Thresholds (exact values to be tuned during implementation against real transcript samples, but the plan must pick concrete starting numbers, not leave them as placeholders):
- `detectReReadLoop`: same `filePath` appears in ≥3 `Read` events within the current buffer window.
- `detectWriteDeleteRewrite`: a `Write`/`Edit` on the same `filePath` occurs 3+ times within a short window (e.g. 5 minutes) — this is the CLAUDE.md-documented "write-delete-rewrite cycle" anti-pattern.
- `detectZeroEditBurn`: `tokensUsed` (from the current dispatch's running total, passed in by the caller — not computed here) exceeds a floor (e.g. 20,000) with zero `Write`/`Edit`/`NotebookEdit` events in the buffer for that dispatch's toolUseIds.
- `detectStalledPermission`: an entry in `work` (the existing open-lane tracker) has been open longer than a threshold (e.g. 60s) with no corresponding `hadResult: true` entry appearing in `events` — a heuristic proxy for "waiting on a permission prompt," since the transcript format doesn't distinguish permission-wait from genuinely-long-running tools, and the design accepts this as an approximation, not a guarantee.

`detectAnomalies` is the single entry point `liveAgentTracker.ts` calls each tick, composing the four detectors.

### IPC + state plumbing

- `electron/main.ts`: `tickAndPushAgents` (existing) gains a call to `detectAnomalies` after `liveAgentTracker.tick()`, and sends the result over a new `sendToWindow('agents:anomalies', anomalies)` call (reusing the existing `sendToWindow` guard from the Phase 6 crash fix — no new destroyed-webContents risk).
- `electron/preload.ts`: expose `onAnomalies` under the existing `agents` bridge namespace, matching the pattern of `onActiveWork`.
- `src/state/types.ts`: add `anomalies: Anomaly[]` to `AetherState`.
- `src/state/reducer.ts`: add a `SET_ANOMALIES` action (mirrors the existing `SET_ACTIVE_WORK` handler exactly — replace the array wholesale each tick, no merge logic needed since the main process already computes the full current set).
- `src/state/store.tsx` (or wherever `useRealAgentsSync`/equivalent hooks subscribe to the other `agents:*` channels): add a fourth `useEffect` subscribing to `onAnomalies`, mirroring the existing three.

### Reactor Semantics

New pure functions in `src/components/reactor/reactorMath.ts`, following the file's existing conventions exactly (small function, documented constants, no side effects):

```ts
// Hue shift per model tier, layered on top of the existing theme hue —
// haiku reads cool/blue, sonnet is the existing default (no shift), opus
// reads violet, fable reads gold. Unrecognized/null model -> no shift.
export function computeModelHueShift(dominantModel: string | null): number;

// cacheHitRatio in [0,1] (cacheReadInputTokens / (cacheReadInputTokens + inputTokens),
// 0 when no data yet) -> core opacity/clarity multiplier in [0.6, 1] (never fully
// transparent even at zero cache hits, so the core stays visible).
export function computeCacheClarity(cacheHitRatio: number): number;

// realAgentCount (already used by computeDispatchIntensity for the
// discrete overdrive/overload booleans) -> a continuous turbulence value in
// [0,1] for the plasma shader's existing u_storm-style uniform, so
// concurrency reads as a gradient, not just three fixed steps.
export function computeConcurrencyTurbulence(realAgentCount: number): number;
```

`computeModelHueShift`'s output is added to the existing `computeThemeHueDeg`'s result at the call site in `Reactor.tsx` (not merged into `computeThemeHueDeg` itself, to keep that function's existing signature/tests untouched). `computeCacheClarity` and `computeConcurrencyTurbulence` thread through as new props on `StormCore` (and `glShader.ts`'s `DrawCoreGLParams`, adding `cacheClarity`/`turbulence` fields alongside the existing `surge`/`phase`/`overdrive`/`glowFactor`/`burnRate`/`soft`), consumed by new uniforms in the WebGL shader (`u_clarity`, extending the existing `u_storm` usage for turbulence rather than adding a second uniform, since `u_storm` already drives `pow(m, 2.3-u_storm)` turbulence-shaping in the fragment shader).

Where does `dominantModel` and `cacheHitRatio` come from at the call site? `state.realAgents` already carries `model` per dispatch; `dominantModel` is the most-frequent non-null `model` among currently-open dispatches (a small pure helper, not listed above since it's a one-line `reduce`, defined alongside the other functions). `cacheHitRatio` requires `DispatchUsage` (in `dispatchUsage`) to gain two new fields — this is the one place this pass DOES touch the existing dispatch-completion pipeline, additively: `cacheReadInputTokens`/`cacheCreationInputTokens` (or just a precomputed `cacheHitRatio` field) added to `DispatchUsage`, populated at completion time in `applyLinesToOpenDispatches` from the (now-available, post-refactor) `TranscriptEvent.usage`. This is an additive field on an existing type — per the Global Constraints below, existing consumers of `DispatchUsage` must not need any change since they simply ignore fields they don't read.

### Legend toggle

A small settings toggle (in `AppearanceCard.tsx`, alongside the existing renderer/theme/mode rows from the UI Polish Pass) that shows/hides a compact legend overlay near the reactor — four short lines mapping each visual channel to its real-world meaning. Persisted the same way every other `Cfg` field persists (no new persistence mechanism).

### Grid warning rings + reactor flicker

- Grid: nodes corresponding to `Anomaly.toolUseId` (or, for `zeroEditBurn`, the dispatch's toolUseId) get a warning ring — an additive visual treatment on the existing node rendering, not a new node type.
- Reactor: when `state.anomalies.length > 0`, the reactor's existing `alarmLevel`-driven amber path (already exists for `'warn'` — see `computeThemeHueDeg`) gets triggered, OR a new lightweight flicker animation is added if reusing `alarmLevel` would incorrectly conflate transcript-pattern anomalies with the existing budget-alarm system (the design intent is these are DIFFERENT kinds of alarms; do not silently merge them into one `alarmLevel` value — the exact mechanism, a new `state.anomalies.length > 0` check independent of `alarmLevel`, vs threading anomalies into `alarmLevel` as a third input, is an implementation decision for the plan to make explicit, not left ambiguous here: **use a new, independent check**, since conflating a token-budget alarm with a code-quality-pattern alarm would make either signal harder to read at a glance).

## Error handling / edge cases

- `updateHistory`/detectors run every tick (1s) on a bounded buffer (max 500 events) — cheap enough to not need throttling, but if a real-world buffer walk proves costly, evaluate before shipping (measure, don't assume).
- A `TranscriptEvent` with `usage: null` (many lines have no usage block) is simply skipped for cache-ratio purposes — `dominantModel`/`cacheHitRatio` degrade gracefully (no data → `computeCacheClarity(0)` → minimum-but-visible clarity, not a crash).
- Ring buffer reset on `notifyPtySpawned` means anomalies detected in a prior pty session never leak into a new one — matches the existing `currentOpen`/`currentWork` reset behavior exactly.
- `detectStalledPermission`'s heuristic can false-positive on any genuinely-long-running tool call (e.g., a slow `Bash` command) — this is a known, accepted limitation stated explicitly in the detector's doc comment, not silently swept under.

## Testing

- `updateHistory`: colocated test with concrete `TranscriptEvent[]` fixtures — covers open→close transition, buffer eviction past `HISTORY_MAX_EVENTS`, and multiple concurrent open calls.
- Each detector (`detectReReadLoop`, `detectWriteDeleteRewrite`, `detectZeroEditBurn`, `detectStalledPermission`) gets its own colocated test with fixture event arrays proving both a true-positive and a true-negative case (e.g. 2 reads of the same file does NOT trigger `detectReReadLoop`, 3 does).
- `computeModelHueShift`, `computeCacheClarity`, `computeConcurrencyTurbulence`: colocated tests matching `reactorMath.test.ts`'s existing style (boundary values, documented constants asserted against).
- The `liveAgentTracker.ts` refactor to `parseTranscriptLine` is covered by the EXISTING `applyLinesToOpenDispatches`/`applyLinesToOpenWork` tests, updated to construct `TranscriptEvent` fixtures instead of raw JSON strings — this should be a mechanical test-fixture update, not new test-design work, since the functions' behavior doesn't change, only their input type.
- Grid warning-ring rendering and reactor flicker are NOT meaningfully unit-testable (visual), consistent with this project's established pattern — verified via manual/live-window check.

## Global Constraints (for the implementation plan)

- `DispatchUsage`'s new cache-related field(s) are additive — no existing consumer (Memory, Chat, Analytics) may require changes as a result.
- Anomaly detection must not be conflated with the existing `alarmLevel` (budget-driven) — keep them as independently-readable signals.
- The ring buffer is in-memory only, reset on pty respawn — no new persistence dependency in this pass.
- `npm test` and `npm run build` clean before every commit, matching every prior plan in this repo.
