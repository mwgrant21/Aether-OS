# Instrument + Alarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the reactor from decoration into an instrument (model-tier hue, cache-hit clarity, concurrency turbulence, all real signals) and give it an alarm system that detects and surfaces real problems (re-read loops, write-delete-rewrite cycles, high burn with zero edits, stalled permission prompts) from live transcript activity.

**Architecture:** A new bounded tool-call history ring buffer in `electron/liveAgentTracker.ts` (built by finally wiring in the already-existing-but-unused `parseTranscriptLine` from `transcriptParser.ts`) feeds four pure anomaly detectors, pushed to the renderer over a new IPC channel. Reactor Semantics extends the existing `reactorMath.ts` pure-function pattern with three new signal-to-visual mappings, wired through the existing `useReactorCanvas`/`computeThemeFilter`/`drawCoreGL` pipeline.

**Tech Stack:** TypeScript (strict), React 18, Electron main-process IPC, Vitest.

## Global Constraints

- No CSS modules or styled-components — inline styles only, per the codebase's established convention.
- `npm test` and `npm run build` clean before every commit.
- Full spec: `docs/superpowers/specs/2026-07-26-instrument-alarm-design.md`.
- The ring buffer is in-memory only, reset on pty respawn (matching `notifyPtySpawned`'s existing reset of `currentOpen`/`currentWork`) — no new persistence dependency.
- Anomaly detection must NOT be conflated with the existing `alarmLevel` (budget-driven) field — keep them independently readable signals; anomalies gate on `state.anomalies.length > 0`, not on `alarmLevel`.
- **Correction to the design spec, adopted here**: the spec assumed dispatch-level cache-token fields could be added to `DispatchUsage`/`CompletedDispatchUsage`. This is wrong — `applyLinesToOpenDispatches` derives `tokens`/`toolUses`/`durationMs` from a synthesized `task-notification` message's embedded tags (`<subagent_tokens>`, `<tool_uses>`, `<duration_ms>`), which do NOT carry a cache-token breakdown, and the subagent's own detailed usage lives in a separate child transcript file this tracker never tails (it only tails the pinned parent pty session file). Cache-hit ratio is therefore tracked as a **session-level running total** in `liveAgentTracker.ts` (summed across every parsed `TranscriptEvent.usage` in the tracked file, not per-dispatch) — see Task 2. `DispatchUsage`/`CompletedDispatchUsage` are NOT modified by this plan.
- **Correction to the design spec, adopted here**: `computeCacheClarity`/`computeConcurrencyTurbulence` only wire into `ReactorCore.tsx` (the WebGL-rendered default renderer, via `glShader.ts`'s `drawCoreGL`) — NOT `StormCore.tsx`, which uses a separate canvas-2D system (`aetherStorm.ts`) with its own unrelated `mode`-based intensity proxy. Extending StormCore is out of scope for this plan. `computeModelHueShift` (via `computeThemeFilter`) DOES apply to both renderers, since both already call `computeThemeFilter`.

---

### Task 1: Anomaly detectors (pure logic, no wiring yet)

**Files:**
- Create: `src/shared/anomalyDetectors.ts` + `anomalyDetectors.test.ts`
- Create: `electron/toolCallHistory.ts` + `toolCallHistory.test.ts`

**Interfaces:**
- Produces (`toolCallHistory.ts`):
  ```ts
  export interface ClosedToolCall {
    toolUseId: string;
    toolName: string;
    filePath: string | null;
    startedAt: number;
    closedAt: number;
  }
  export interface ToolCallHistory {
    events: ClosedToolCall[];
  }
  export const HISTORY_MAX_EVENTS = 500;
  export function createEmptyHistory(): ToolCallHistory;
  export function updateHistory(history: ToolCallHistory, events: TranscriptEvent[], nowMs: number): ToolCallHistory;
  ```
- Produces (`anomalyDetectors.ts`):
  ```ts
  export interface Anomaly {
    kind: 'reReadLoop' | 'writeDeleteRewrite' | 'zeroEditBurn' | 'stalledPermission';
    toolUseId: string;
    detail: string;
  }
  export function detectReReadLoop(events: ClosedToolCall[]): Anomaly[];
  export function detectWriteDeleteRewrite(events: ClosedToolCall[], nowMs: number): Anomaly[];
  export function detectZeroEditBurn(events: ClosedToolCall[], tokensUsed: number): Anomaly[];
  export function detectStalledPermission(openWork: RealActiveWork[], events: ClosedToolCall[], nowMs: number): Anomaly[];
  export function detectAnomalies(history: ToolCallHistory, work: RealActiveWork[], tokensUsed: number, nowMs: number): Anomaly[];
  ```

**Steps:**
- [ ] `electron/toolCallHistory.ts`: implement `updateHistory` — for each `TranscriptEvent` with a non-empty `toolUses`, open an in-flight entry keyed by `toolUses[].id` (extract `filePath` from `input.file_path` when the input object has that property, else `null`; `toolName` from `toolUses[].name`; `startedAt` from `event.timestamp?.getTime() ?? nowMs`). For each `TranscriptEvent` with non-empty `toolResults`, close the matching in-flight entry by `toolResults[].toolUseId`, set `closedAt = event.timestamp?.getTime() ?? nowMs`, and append to `history.events`. After processing all events, if `history.events.length > HISTORY_MAX_EVENTS`, slice to keep only the newest `HISTORY_MAX_EVENTS` (drop from the front — oldest first). In-flight (not-yet-closed) entries persist across calls in a way `updateHistory` must support: since the function is pure and takes no closure state, track in-flight entries as a SEPARATE field on `ToolCallHistory`:
  ```ts
  export interface ToolCallHistory {
    events: ClosedToolCall[];
    openByToolUseId: Record<string, { toolName: string; filePath: string | null; startedAt: number }>;
  }
  export function createEmptyHistory(): ToolCallHistory {
    return { events: [], openByToolUseId: {} };
  }
  ```
  (This corrects the interface shown above — use this two-field version.)
- [ ] `toolCallHistory.test.ts`: cover (a) a tool_use with no matching result yet stays in `openByToolUseId`, doesn't appear in `events`; (b) a matching result closes it and moves it into `events`; (c) `filePath` extraction from `input.file_path` when present, `null` when absent; (d) buffer eviction — feed 510 closed events across multiple `updateHistory` calls, assert `events.length === HISTORY_MAX_EVENTS` and the oldest 10 are gone; (e) multiple concurrent open calls tracked independently by `toolUseId`. Construct `TranscriptEvent` fixtures directly (import the type from `../electron/transcriptParser` — adjust relative path) rather than raw JSON strings.
- [ ] `src/shared/anomalyDetectors.ts`: implement the four detectors plus `detectAnomalies`.
  - `detectReReadLoop`: group `events` by `filePath` (skip `null`) where `toolName === 'Read'`; for any group with `length >= 3`, emit one `Anomaly` with `kind: 'reReadLoop'`, `toolUseId` = the group's most recent event's `toolUseId`, `detail: \`${filePath} read ${count} times\`` (use the actual file path and count).
  - `detectWriteDeleteRewrite`: group `events` by `filePath` where `toolName === 'Write' || toolName === 'Edit'`, within a 5-minute (300,000ms) trailing window from `nowMs`; for any group with `length >= 3` within that window, emit `kind: 'writeDeleteRewrite'`, `detail: \`${filePath} written ${count} times in 5min\`.
  - `detectZeroEditBurn`: if `tokensUsed >= 20000` AND `events` contains zero entries with `toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit'`, emit one `kind: 'zeroEditBurn'` anomaly with `toolUseId: ''` (no single triggering call — caller/UI treats empty `toolUseId` as "session-level, not node-specific") and `detail: \`${tokensUsed} tokens used with zero file edits\`.
  - `detectStalledPermission`: for each entry in `openWork` (the existing `RealActiveWork[]` open-lane list — import its type from `../state/liveAgentsMath`, adjust relative path), compute `ageMs = nowMs - new Date(entry.startedAt).getTime()`; if `ageMs > 60000` AND no `events` entry exists with `toolUseId === entry.toolUseId` (i.e., it never closed), emit `kind: 'stalledPermission'`, `toolUseId: entry.toolUseId`, `detail: \`${entry.label} open for ${Math.round(ageMs/1000)}s\`.
  - `detectAnomalies`: calls all four and concatenates their results.
- [ ] `anomalyDetectors.test.ts`: for each detector, one true-positive fixture and one true-negative fixture (e.g. 2 reads of the same file does NOT trigger `detectReReadLoop`, 3 does; a Write present does NOT trigger `detectZeroEditBurn` even above the token floor). Use concrete `ClosedToolCall`/`RealActiveWork` object literals, not helper builders that hide the actual field values.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` (all passing plus new tests), `npm run build` clean.
- [ ] Commit: `feat: add tool-call history buffer and anomaly detectors`

### Task 2: Wire history buffer + detectors into liveAgentTracker, switch to parseTranscriptLine

**Files:**
- Modify: `electron/liveAgentTracker.ts`
- Modify: `src/state/liveAgentsMath.ts` (+ `liveAgentsMath.test.ts`)

**Interfaces:**
- Consumes: `parseTranscriptLine`, `TranscriptEvent` from `./transcriptParser` (already exist, unmodified). `updateHistory`, `createEmptyHistory`, `ToolCallHistory` from Task 1's `./toolCallHistory`. `detectAnomalies` from `../src/shared/anomalyDetectors`.
- Produces: `LiveAgentTick` gains two new fields: `anomalies: Anomaly[]` and `cacheHitRatio: number` (session-level running total, see below).

**Steps:**
- [ ] In `src/state/liveAgentsMath.ts`, change `applyLinesToOpenDispatches` and `applyLinesToOpenWork`'s second parameter from `rawLines: string[]` to `events: TranscriptEvent[]` (import the type from `../../electron/transcriptParser`). Update both functions' bodies to read from the typed `TranscriptEvent` fields instead of `JSON.parse`-ing raw lines themselves:
  - `applyLinesToOpenDispatches`: the `Agent` tool_use detection reads `event.toolUses` (filter `name === 'Agent'`) instead of digging into `json.message.content`. The completion-detection logic (matching a `task-notification` user message) is trickier: `TranscriptEvent.kind` is `'user'`, but `parseTranscriptLine` does NOT currently expose the raw `origin.kind === 'task-notification'` check or the embedded `<tool-use-id>`/`<subagent_tokens>`/`<tool_uses>`/`<duration_ms>` tag content — read `electron/transcriptParser.ts`'s `parseTranscriptLine` implementation in full first to see exactly what `humanText`/`isHumanPrompt` expose for user-kind lines, and confirm whether the raw text content (containing those embedded tags) is available via `event.humanText` or a similar field. If the current `TranscriptEvent` shape does NOT expose enough to keep this completion-detection working (e.g. it strips or doesn't parse `origin.kind`), you have two choices, in this priority order: (a) extend `TranscriptEvent`/`parseTranscriptLine` in `transcriptParser.ts` with the minimal additional field needed (e.g. `originKind: string | null`) — preferred, keeps everything on one parser; (b) if that's structurally awkward, keep `applyLinesToOpenDispatches` reading the ORIGINAL raw line string for this one branch only (pass both `events: TranscriptEvent[]` and the original `rawLines: string[]` in parallel, zipped by index) — only as a fallback, and note in your commit message why (a) wasn't taken.
  - `applyLinesToOpenWork`: same pattern — reads `event.toolUses`/`event.toolResults` (open on tool_use, close on matching toolResult) instead of re-parsing JSON. This one has no completion-tag dependency, so it should convert cleanly.
- [ ] Update `liveAgentsMath.test.ts`: every existing test constructs raw JSON-string fixtures today — convert each to construct `TranscriptEvent` object literals instead (or keep raw strings and run them through `parseTranscriptLine` first inside the test, whichever produces less churn — your call, but the test's assertions on behavior must not change, only how the input is constructed). Existing test names/expectations stay the same; this is a fixture-format migration, not new test design.
- [ ] In `electron/liveAgentTracker.ts`:
  - Add a `let history: ToolCallHistory = createEmptyHistory();` and `let cumulativeCacheRead = 0; let cumulativeInput = 0;` to the closure, alongside the existing `currentOpen`/`currentWork` state.
  - Reset all three (`history`, `cumulativeCacheRead`, `cumulativeInput`) inside `notifyPtySpawned`, matching the existing reset of `currentOpen`/`currentWork`.
  - In `tick()`, after reading `lines` via `readNewLines`, map each raw line through `parseTranscriptLine(rawLine)`, filter out `null` results, producing `events: TranscriptEvent[]`. Pass `events` (not `lines`) to `applyLinesToOpenDispatches`/`applyLinesToOpenWork` (per Task 2's signature change above — if you took fallback option (b) for the task-notification branch, also pass the original `lines` alongside).
  - Update `history = updateHistory(history, events, Date.now())`.
  - For each `event` with `event.usage !== null`, add `event.usage.cacheReadInputTokens` to `cumulativeCacheRead` and `event.usage.inputTokens` to `cumulativeInput`.
  - Compute `cacheHitRatio = cumulativeInput + cumulativeCacheRead > 0 ? cumulativeCacheRead / (cumulativeInput + cumulativeCacheRead) : 0`.
  - Compute a rough current-session `tokensUsed` for `detectZeroEditBurn` — sum `event.usage.inputTokens + event.usage.outputTokens` across the SAME `events` array processed this tick is NOT the right scope (that's only new lines, not the running total); instead use `currentOpen`'s dispatch tokens if non-empty, or fall back to `cumulativeInput` as a proxy for "how much has been burned in this tracked session" — read the existing code's `LiveAgentTick`/`tickAndPushAgents` call site in `electron/main.ts` first to see if a better existing running-total already exists (e.g. from the usage-scan pipeline) before inventing a new one; if one exists, reuse it via a parameter passed into `tick()` rather than duplicating burn tracking.
  - Call `const anomalies = detectAnomalies(history, currentWork, tokensUsedForBurn, Date.now());`.
  - Add `anomalies` and `cacheHitRatio` to the object returned by `tick()` (extend `LiveAgentTick`'s interface with these two fields).
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean (including migrated `liveAgentsMath.test.ts`), `npm run build` AND `npm run electron:build` clean (this task touches `electron/`).
- [ ] Commit: `feat: switch liveAgentTracker to parseTranscriptLine, wire in history and anomaly detection`

### Task 3: IPC + state plumbing for anomalies

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/aetherElectron.d.ts`
- Modify: `src/state/types.ts`
- Modify: `src/state/reducer.ts` (+ `reducer.test.ts`)
- Modify: `src/state/initialState.ts`
- Modify: `src/state/useRealAgentsSync.ts`

**Interfaces:**
- Consumes: `Anomaly` type from `src/shared/anomalyDetectors.ts` (Task 1), `tick()`'s new `anomalies`/`cacheHitRatio` fields (Task 2).
- Produces: `state.anomalies: Anomaly[]`, `state.cacheHitRatio: number` (both on `AetherState`), `SET_ANOMALIES` and `SET_CACHE_HIT_RATIO` reducer actions, `window.aetherElectron.agents.onAnomalies` bridge method.

**Steps:**
- [ ] `electron/main.ts`: read `tickAndPushAgents` in full first. After the existing `sendToWindow('agents:activeWork', work)` line, add `sendToWindow('agents:anomalies', anomalies);` and `sendToWindow('agents:cacheHitRatio', cacheHitRatio);` using the two new fields from `liveAgentTracker.tick()`'s return value (destructure them alongside the existing `open`/`completed`/`work`).
- [ ] `electron/preload.ts`: add to the `agents` object, matching `onActiveWork`'s exact pattern:
  ```ts
  onAnomalies: (callback: (anomalies: Anomaly[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, anomalies: Anomaly[]) => callback(anomalies);
    ipcRenderer.on('agents:anomalies', listener);
    return () => ipcRenderer.removeListener('agents:anomalies', listener);
  },
  onCacheHitRatio: (callback: (ratio: number) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, ratio: number) => callback(ratio);
    ipcRenderer.on('agents:cacheHitRatio', listener);
    return () => ipcRenderer.removeListener('agents:cacheHitRatio', listener);
  },
  ```
  Import `Anomaly` as a type from `../src/shared/anomalyDetectors` at the top of the file, alongside the existing type imports.
- [ ] `src/aetherElectron.d.ts`: read the file first, add matching type declarations for `onAnomalies`/`onCacheHitRatio` under the `agents` namespace, following whatever declaration style the existing `onActiveWork` entry uses.
- [ ] `src/state/types.ts`: add `anomalies: Anomaly[];` and `cacheHitRatio: number;` to `AetherState` (import `Anomaly` from `../shared/anomalyDetectors`).
- [ ] `src/state/initialState.ts`: add `anomalies: [],` and `cacheHitRatio: 0,` to the initial state object.
- [ ] `src/state/reducer.ts`: add two action types to the `Action` union: `{ type: 'SET_ANOMALIES'; anomalies: Anomaly[] }` and `{ type: 'SET_CACHE_HIT_RATIO'; ratio: number }`. Add two `case` handlers mirroring the existing `SET_ACTIVE_WORK` handler exactly (read it first) — each just returns `{ ...state, anomalies: action.anomalies }` / `{ ...state, cacheHitRatio: action.ratio }`, no merge logic.
- [ ] `reducer.test.ts`: add two small tests asserting `SET_ANOMALIES`/`SET_CACHE_HIT_RATIO` replace the field wholesale, matching the style of the existing `SET_ACTIVE_WORK` test.
- [ ] `src/state/useRealAgentsSync.ts`: add two more `useEffect` blocks, exactly matching the existing three (`onSnapshot`/`onCompleted`/`onActiveWork`) — `agents.onAnomalies((anomalies) => dispatch({ type: 'SET_ANOMALIES', anomalies }))` and `agents.onCacheHitRatio((ratio) => dispatch({ type: 'SET_CACHE_HIT_RATIO', ratio }))`.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` AND `npm run electron:build` clean.
- [ ] Commit: `feat: plumb anomalies and cache-hit ratio from main process to renderer state`

### Task 4: Reactor Semantics — reactorMath additions

**Files:**
- Modify: `src/components/reactor/reactorMath.ts` (+ `reactorMath.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  export function computeCacheClarity(cacheHitRatio: number): number; // -> [0.6, 1]
  export function computeConcurrencyTurbulence(realAgentCount: number): number; // -> [0, 1]
  export function dominantModel(realAgents: { model: string | null }[]): string | null;
  export function computeModelHueShift(model: string | null): number;
  ```
- Modifies: `computeThemeFilter`'s signature gains a 5th optional parameter: `computeThemeFilter(theme: ThemeName, alarmLevel: AlarmLevel, glowFx: boolean, overload: boolean = false, modelHueShift: number = 0): string` — the shift is added to `hueDeg` inside the function (after the existing `overload` shift), before formatting the `hue-rotate(...)` string. This keeps every existing call site (which omits the 5th arg) working unchanged, and applies to BOTH `ReactorCore` and `StormCore` automatically since both already call `computeThemeFilter`.

**Steps:**
- [ ] Add `computeCacheClarity`:
  ```ts
  const CACHE_CLARITY_MIN = 0.6;
  export function computeCacheClarity(cacheHitRatio: number): number {
    const t = Math.max(0, Math.min(1, cacheHitRatio));
    return CACHE_CLARITY_MIN + t * (1 - CACHE_CLARITY_MIN);
  }
  ```
- [ ] Add `computeConcurrencyTurbulence`:
  ```ts
  const TURBULENCE_SATURATION_COUNT = 4; // realAgentCount at/above this reads as maximum turbulence
  export function computeConcurrencyTurbulence(realAgentCount: number): number {
    return Math.max(0, Math.min(1, realAgentCount / TURBULENCE_SATURATION_COUNT));
  }
  ```
- [ ] Add `dominantModel` and `computeModelHueShift`:
  ```ts
  export function dominantModel(realAgents: { model: string | null }[]): string | null {
    const counts = new Map<string, number>();
    for (const a of realAgents) {
      if (!a.model) continue;
      counts.set(a.model, (counts.get(a.model) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [model, count] of counts) {
      if (count > bestCount) { best = model; bestCount = count; }
    }
    return best;
  }

  // Model name substrings, checked in this order (first match wins) -- real
  // model identifiers look like "claude-haiku-4-5-..."/"claude-sonnet-5"/etc.
  const MODEL_HUE_SHIFTS: [substring: string, shiftDeg: number][] = [
    ['haiku', -60],   // cool blue
    ['opus', 90],     // violet
    ['fable', 200],   // gold
    // sonnet and anything unrecognized: no shift (0), sonnet is the visual default
  ];

  export function computeModelHueShift(model: string | null): number {
    if (!model) return 0;
    const lower = model.toLowerCase();
    for (const [substring, shift] of MODEL_HUE_SHIFTS) {
      if (lower.includes(substring)) return shift;
    }
    return 0;
  }
  ```
- [ ] Modify `computeThemeFilter`'s signature and body per the Interfaces section above — add the parameter, add `hueDeg += modelHueShift;` after the existing `if (overload) hueDeg += OVERLOAD_HUE_SHIFT;` line.
- [ ] `reactorMath.test.ts`: add tests for all four new functions (boundary values: `computeCacheClarity(0)` → `0.6`, `computeCacheClarity(1)` → `1`; `computeConcurrencyTurbulence(0)` → `0`, `computeConcurrencyTurbulence(4)` and above → `1`; `dominantModel([])` → `null`, a 3-vs-1 split picks the majority; `computeModelHueShift('claude-haiku-4-5-x')` → `-60`, `computeModelHueShift('claude-sonnet-5')` → `0`, `computeModelHueShift(null)` → `0`). Add a test confirming `computeThemeFilter('cyan', 'ok', true)` (4-arg call, matching every existing test) is UNCHANGED in output, and a new test confirming the 5th-arg case shifts the hue.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean.
- [ ] Commit: `feat: add reactor semantics pure functions (model hue, cache clarity, concurrency turbulence)`

### Task 5: Reactor Semantics — wire into ReactorCore/glShader/useReactorCanvas

**Files:**
- Modify: `src/components/reactor/glShader.ts`
- Modify: `src/components/reactor/useReactorCanvas.ts`
- Modify: `src/components/reactor/ReactorCore.tsx`

**Interfaces:**
- Consumes: `computeCacheClarity`, `computeConcurrencyTurbulence`, `dominantModel`, `computeModelHueShift` from Task 4's `reactorMath.ts`. `state.cacheHitRatio` from Task 3.

**Steps:**
- [ ] `glShader.ts`: read the file in full first (it's short). Add `clarity: number` and `turbulence: number` to `DrawCoreGLParams`. Add two new uniform locations alongside the existing ones in `initGL`'s uniform-lookup loop (`u_clarity`, and reuse the EXISTING `u_storm` uniform for turbulence — do NOT add a second turbulence uniform, since `u_storm` already drives the fragment shader's `pow(m, 2.3-u_storm)` turbulence-shaping and is currently only set from `burnRate` in `drawCoreGL`). In `drawCoreGL`, change the existing line `gl.uniform1f(u.u_storm, 0.25 + burnT * 0.65);` to also factor in `params.turbulence` — e.g. `gl.uniform1f(u.u_storm, Math.min(1, 0.25 + burnT * 0.65 + params.turbulence * 0.3));` (additive contribution, capped at 1, so turbulence adds ON TOP of the existing burn-rate-driven storminess rather than replacing it). Add `gl.uniform1f(u.u_clarity, params.clarity);` as a new line. In the fragment shader source string (`FRAGMENT_SHADER` constant), add `u_clarity` to the uniform declarations list and multiply the final alpha/color output by it — read the existing shader's final `gl_FragColor` assignment line and multiply its alpha component (not the color channels, so low clarity fades the core rather than recoloring it) by `u_clarity`.
- [ ] `useReactorCanvas.ts`: read the file in full. In the same effect/callback where `computeThemeFilter`/`computeDispatchIntensity` are currently called (around line 62-64), add:
  ```ts
  const clarity = computeCacheClarity(s.cacheHitRatio);
  const turbulence = computeConcurrencyTurbulence(s.realAgents.length);
  const modelHueShift = computeModelHueShift(dominantModel(s.realAgents));
  const themeFilter = computeThemeFilter(s.cfg.theme, s.alarmLevel, s.cfg.glowFx, overload, modelHueShift);
  ```
  (replacing the existing `computeThemeFilter` call with the 5-arg version). Import the four new functions from `./reactorMath`. Add `clarity`/`turbulence` to the `ReactorFrame` interface and to the object passed via `drawRef.current({ ... })`.
- [ ] `ReactorCore.tsx`: in the `drawCoreGL(glProgramRef.current, { ... })` call, add `clarity: frame.clarity, turbulence: frame.turbulence,` to the params object.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean. This task has no new unit-testable logic of its own (pure functions were tested in Task 4; this is wiring) — a manual/live-window check is the real verification, note in the report that this is deferred to the user per the project's established pattern.
- [ ] Commit: `feat: wire cache clarity and concurrency turbulence into ReactorCore's WebGL shader`

### Task 6: Grid warning rings + reactor anomaly flicker + legend toggle

**Files:**
- Modify: `src/components/grid/OrchestrationGrid.tsx`
- Modify: `src/components/reactor/StormCore.tsx` and/or `ReactorCore.tsx` (whichever is the active default — read `src/state/initialState.ts`'s `cfg.renderer` default first to confirm; wire the flicker into BOTH, since the user can switch renderers at runtime)
- Modify: `src/components/settings/AppearanceCard.tsx`

**Interfaces:**
- Consumes: `state.anomalies` (Task 3).

**Steps:**
- [ ] `OrchestrationGrid.tsx`: read the file in full. In the node-rendering loop (around the `<g key={node.agent.toolUseId} ...>` block), check whether `state.anomalies.some(a => a.toolUseId === node.agent.toolUseId)` (you'll need to accept `anomalies: Anomaly[]` as a new prop, threaded from `GridView.tsx` — read that file too, to see how `agents`/`onSelectRealAgent` are currently passed down, and add `anomalies` the same way). If true, render an additional ring/stroke around that node — an SVG `<circle>` (or equivalent, matching whatever shape the existing node visual uses) with a warning color (use `colors.warn` — read whether this file already uses `useColors()` post-UI-Polish-Pass or a static import, and match whichever convention it currently uses) and a distinct stroke pattern (dashed or pulsing — read `global.css` for any existing pulse/dash animation class to reuse rather than inventing a new one).
- [ ] `GridView.tsx`: thread `state.anomalies` down to `OrchestrationGrid` as the new prop.
- [ ] Reactor flicker: in whichever of `StormCore.tsx`/`ReactorCore.tsx` is simplest to add a conditional visual state to (read both first), add a check on `state.anomalies.length > 0` — independent of `alarmLevel`, per the Global Constraints — that triggers a brief amber flicker. Reuse an EXISTING animation/keyframe from `global.css` if one fits (check for anything alarm/flash/pulse-named) rather than adding a new CSS keyframe; if nothing fits, add one new minimal keyframe (a 2-3 property opacity/filter pulse, not a new complex animation) and document why in the commit message.
- [ ] `AppearanceCard.tsx`: read the file in full (it now has THEME/RENDERER/MODE rows from prior work). Add a new toggle row for a "legend" setting — add `showReactorLegend: boolean` to `Cfg` in `src/state/types.ts` and `initialState.ts` (default `false`), following the exact same `RUN_COMMAND`-dispatch toggle pattern OR — if a boolean toggle doesn't fit the existing `RUN_COMMAND`-based terminal-command convention as naturally as the enum-valued THEME/RENDERER/MODE rows do — dispatch a direct reducer action instead (e.g. `{ type: 'TOGGLE_REACTOR_LEGEND' }`), whichever fits this file's existing patterns better; make the choice explicit in your report, don't silently pick one without checking both conventions already present in this file. When enabled, render a small fixed-position overlay (near wherever the reactor mounts — check `Sidebar.tsx`'s reactor placement from earlier work) with four short lines: "HUE = MODEL", "PULSE = TOKENS/SEC", "TURBULENCE = CONCURRENT AGENTS", "CLARITY = CACHE HIT RATE" (or similar concise wording — exact copy is your call, keep each line under 30 characters to fit the sci-fi console aesthetic).
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean. Visual correctness (ring appearance, flicker timing, legend readability) is not unit-testable — defer to manual/live-window check per this project's established pattern.
- [ ] Commit: `feat: surface anomalies as Grid warning rings and reactor flicker, add legend toggle`

---

After all six tasks: whole-branch review, then a PROGRESS.md entry in the established format, explicitly noting: (a) the two spec corrections adopted in this plan (session-level cache-hit ratio instead of per-dispatch; StormCore excluded from the WebGL-specific turbulence/clarity wiring), (b) that `detectStalledPermission` is a heuristic approximation (can false-positive on genuinely-long-running tools), and (c) that anomaly detection and Reactor Semantics visuals are not meaningfully unit-testable past the pure-function layer and were verified via manual/live-window check where noted per-task.
