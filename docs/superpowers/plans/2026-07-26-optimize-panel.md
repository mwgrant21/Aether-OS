# Optimize Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port TokenMonitor's Optimize panel in full — 3 waste-detection rules
priced by counterfactual cost, a letter-grade summary, a one-click Apply-fix
that writes guidance into `CLAUDE.md` (global or project), and recurrence
tracking that re-flags a finding if it keeps happening after being applied.

**Architecture:** Pure logic ports into `src/shared/` (`modelPricing.ts`,
`optimizeRules.ts`, `optimizeGrade.ts`, `optimizeActions.ts`), a small persisted
state helper in `electron/` (`optimizeState.ts`), IPC wiring that rides the
*already-existing* 60-second `scanAndPushUsage()` cycle in `main.ts` for
detection, plus two new `ipcMain.handle` calls for the explicit, user-triggered
Apply-fix action. State/reducer/hook wiring and a new `Optimize` nav tab follow
this app's established patterns exactly (`SET_ACTIVE_WORK`-style reducer cases,
`useRealAgentsSync`-style sync hooks, `attachments`-style invoke IPC).

**Tech Stack:** TypeScript (strict), React 18, Electron main-process IPC + fs, Vitest.

## Global Constraints

- No CSS modules or styled-components — inline styles only, per this codebase's
  established convention.
- `npm test`, `npm run build`, and `npm run electron:build` clean before every
  commit that touches `electron/`.
- Full spec: `docs/superpowers/specs/2026-07-26-optimize-panel-design.md`.
- Apply-fix is a one-click USER action (button + explicit confirm), never
  triggered automatically by the background scan. This is a hard requirement,
  not a style preference — see the spec's rationale.
- The main process is the ONLY place a file path is decided. The renderer sends
  a `findingId` plus a choice of `'global' | 'project'`; it never sends or
  receives a raw writable path string it could tamper with. Mirror
  `electron/attachmentsStore.ts`'s `assertSafeName`-style containment
  discipline for the two allowed target paths.
- Do not touch `src/components/grid/` or `src/components/reactor/` — unrelated
  to this feature.

---

### Task 1: `modelPricing.ts` (pure, ported)

**Files:**
- Create: `src/shared/modelPricing.ts` + `modelPricing.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const PRICING_PER_MILLION_TOKENS: {
    opus: { input: number; output: number };
    sonnet: { input: number; output: number };
    haiku: { input: number; output: number };
  };
  export function pricingTierForModel(modelName: string | null): 'opus' | 'sonnet' | 'haiku';
  export function costForEvent(event: { model: string | null; usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number } | null }): number;
  ```

**Steps:**
- [ ] Port from `C:\Users\Matt\projects\TokenMonitor\src\shared\modelPricing.js` verbatim, translated to TypeScript with the types above:
  ```ts
  export const PRICING_PER_MILLION_TOKENS = {
    opus: { input: 15, output: 75 },
    sonnet: { input: 3, output: 15 },
    haiku: { input: 0.8, output: 4 },
  } as const;

  const CACHE_READ_DISCOUNT = 0.1;

  export function pricingTierForModel(modelName: string | null): 'opus' | 'sonnet' | 'haiku' {
    const lower = (modelName || '').toLowerCase();
    if (lower.includes('opus')) return 'opus';
    if (lower.includes('haiku')) return 'haiku';
    return 'sonnet';
  }

  export function costForEvent(event: {
    model: string | null;
    usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number } | null;
  }): number {
    if (!event || !event.usage) return 0;
    const tier = pricingTierForModel(event.model);
    const rates = PRICING_PER_MILLION_TOKENS[tier];
    const inputCost = ((event.usage.inputTokens + event.usage.cacheCreationInputTokens) / 1_000_000) * rates.input;
    const cacheReadCost = (event.usage.cacheReadInputTokens / 1_000_000) * rates.input * CACHE_READ_DISCOUNT;
    const outputCost = (event.usage.outputTokens / 1_000_000) * rates.output;
    return inputCost + cacheReadCost + outputCost;
  }
  ```
- [ ] Port `C:\Users\Matt\projects\TokenMonitor\test\modelPricing.test.js`'s test cases into `modelPricing.test.ts` using vitest's `describe`/`it`/`expect` (this codebase's convention — see any existing `src/shared/*.test.ts` file), not node:test/assert. Cover: tier detection for opus/haiku/sonnet/unknown model strings (case-insensitive substring match), `costForEvent` with a null/missing `usage` returning 0, and at least one concrete cost calculation with hand-computed expected value.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean.
- [ ] Commit: `feat: port modelPricing (per-model USD rates + per-event cost)`

---

### Task 2: `TranscriptEvent` gains `resultLength`

**Files:**
- Modify: `electron/transcriptParser.ts`
- Modify: `electron/transcriptParser.test.ts` if it exists — check first; if no test file exists for this module yet, check `liveAgentsMath.test.ts`/`toolCallHistory.test.ts` for how they construct `TranscriptEvent`/run raw JSONL through `parseTranscriptLine` in tests, and add coverage there or create the parser's own test file, whichever this codebase's existing convention favors (check for a `parseTranscriptLine` test suite first via grep before deciding).

**Interfaces:**
- Modifies: `TranscriptToolResult` gains one field:
  ```ts
  export interface TranscriptToolResult {
    toolUseId: string;
    resultLength: number;
  }
  ```
- Consumers of the OLD shape (`liveAgentsMath.ts`, `toolCallHistory.ts`) are unaffected — they read `toolUseId` only and don't destructure exhaustively, so an additive field is safe. Confirm this by reading both files' current `toolResults`-consuming code before making the change, per this codebase's established practice of verifying backward compatibility before extending a shared type (the same practice used when `originKind` was added).

**Steps:**
- [ ] Read `electron/transcriptParser.ts` in full (it's short, ~120 lines).
- [ ] In `parseTranscriptLine`'s `json.type === 'user'` branch, where `toolResults` is currently built as:
  ```ts
  const toolResults = content
    .filter((item: any) => item.type === 'tool_result')
    .map((item: any) => ({ toolUseId: item.tool_use_id }));
  ```
  change the `.map` to also compute a result length from the item's content:
  ```ts
  const toolResults = content
    .filter((item: any) => item.type === 'tool_result')
    .map((item: any) => ({
      toolUseId: item.tool_use_id,
      resultLength: JSON.stringify(item.content ?? '').length,
    }));
  ```
  (`JSON.stringify` on a string content value still produces a reasonable length proxy for either a string or a structured content array — this matches the "rough estimate" spirit already documented in TokenMonitor's own `uncapped-bash-output` rule, which itself divides by ~4 chars/token as an approximation, not an exact count.)
- [ ] Add/extend a test asserting a `tool_result` line with a large `content` string produces a `TranscriptEvent` whose `toolResults[0].resultLength` matches the expected computed length, and a small one produces a small length.
- [ ] Verify: `npx tsc -b` clean (this will surface any place still doing an EXHAUSTIVE object-literal match against `TranscriptToolResult` that would need the new field — if so, add `resultLength: 0` there rather than changing the meaning of a field this task doesn't own), `npx vitest run` clean (including `liveAgentsMath.test.ts`/`toolCallHistory.test.ts` — confirm no fixture there breaks).
- [ ] Commit: `feat: extend TranscriptToolResult with resultLength for the Optimize uncapped-output rule`

---

### Task 3: `optimizeRules.ts` — the 3 detection rules (pure, ported, no recurrence yet)

**Files:**
- Create: `src/shared/optimizeRules.ts` + `optimizeRules.test.ts`

**Interfaces:**
- Consumes: `TranscriptEvent` (from `../../electron/transcriptParser`, adjust relative path), `costForEvent`/`pricingTierForModel`/`PRICING_PER_MILLION_TOKENS` (Task 1).
- Produces:
  ```ts
  export interface OptimizeFinding {
    id: 'opus-on-trivial-turns' | 'unpinned-config-re-reads' | 'uncapped-bash-output';
    title: string;
    detail: string;
    estSavingsPerWeek: number;
    fixText: string;
  }
  export function evaluateOptimizeRules(events: TranscriptEvent[], windowMs: number): OptimizeFinding[];
  ```
  (`evaluateOptimizeRulesWithRecurrence` is Task 6, once applied-state exists — do not implement it here.)

**Steps:**
- [ ] Port the three rule functions from `C:\Users\Matt\projects\TokenMonitor\src\shared\optimizeRules.js` (read that file in full — it's ~130 lines, already shown in this session's brainstorm), translated to TypeScript against THIS codebase's real `TranscriptEvent` field names (`toolUses`/`toolResults`/`usage`/`model`/`kind` — these are already identical names to TokenMonitor's own event shape, so the translation is close to line-for-line):
  - `findOpusOnTrivialTurns(events, windowMs)`: filters `e.kind === 'assistant' && e.usage && pricingTierForModel(e.model) === 'opus' && e.usage.outputTokens < 100`. Constant `TRIVIAL_OUTPUT_TOKEN_THRESHOLD = 100`.
  - `findUnpinnedConfigRereads(events, windowMs)`: groups `Read` tool_use calls by `input.file_path` (note: `toolUse.input` is `unknown` in this codebase's `TranscriptToolUse` type, not TokenMonitor's loosely-typed object — add a type guard: `const filePath = typeof toolUse.input === 'object' && toolUse.input !== null && 'file_path' in toolUse.input ? (toolUse.input as { file_path?: unknown }).file_path : undefined; if (typeof filePath !== 'string') continue;`). Constant `REPEATED_READ_THRESHOLD = 3`, `MAX_LISTED_FILES = 3`. Use Node's `path` module's `win32.basename` for display (matches TokenMonitor's own cross-platform-safe choice, since transcripts can contain Windows paths regardless of the host OS running tests).
  - `findUncappedBashOutput(events, windowMs)`: matches `Bash` tool_use calls (again with the same `input` type-guard pattern for `command: string`) against their `tool_result`'s NEW `resultLength` field (Task 2) exceeding `BASH_OUTPUT_SIZE_THRESHOLD = 5000` with no pagination hint (`/head|tail|select-object|measure-object|-first|-last/i`).
  - `extrapolateToWeekly(value, windowMs)`: `windowMs ? value * ((7*24*60*60*1000) / windowMs) : 0`.
  - `evaluateOptimizeRules(events, windowMs)`: runs all three, filters out `null` results.
- [ ] Port `C:\Users\Matt\projects\TokenMonitor\test\optimizeRules.test.js`'s fixtures and test cases (shown in full in this session — 8 tests covering: opus-trivial detection, re-read detection with the exact filename in `detail`, aggregation across multiple offending files into ONE finding, the `MAX_LISTED_FILES`/"+N more" cap with basename-only display, uncapped-bash detection, and a clean-session-produces-no-findings case) into `optimizeRules.test.ts` using vitest syntax, constructing `TranscriptEvent` object literals directly (matching this codebase's now-established fixture convention from `anomalyDetectors.test.ts`/`liveAgentsMath.test.ts`) rather than raw JSON strings. Do NOT port the recurrence-related tests yet (`evaluateOptimizeRulesWithRecurrence`) — those belong to Task 6.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean.
- [ ] Commit: `feat: port the 3 Optimize waste-detection rules`

---

### Task 4: `optimizeGrade.ts` (pure, ported)

**Files:**
- Create: `src/shared/optimizeGrade.ts` + `optimizeGrade.test.ts`

**Interfaces:**
- Consumes: `OptimizeFinding` (Task 3).
- Produces:
  ```ts
  export interface GradeRow {
    key: string;
    label: string;
    status: 'good' | 'warn' | 'bad';
    note: string;
    scored: boolean;
  }
  export function gradeBreakdown(input: { findings: OptimizeFinding[]; cacheHitRate: number }): GradeRow[];
  export function summarizeOptimize(findings: OptimizeFinding[]): { totalPerWeek: number; grade: 'A' | 'B' | 'C' | 'D' };
  export function appliedSummary(findings: (OptimizeFinding & { applied?: boolean })[]): { count: number; totalPerWeek: number };
  ```

**Steps:**
- [ ] Port `C:\Users\Matt\projects\TokenMonitor\src\shared\optimizeGrade.js` verbatim (shown in full in this session) into TypeScript with the types above: `BAD_THRESHOLD_PER_WEEK = 25`, the 3-row `FACTORS` table (model-routing/file-pinning/output-caps, each mapping to one finding id with a `goodNote`/`fixNote`), `gradeBreakdown` producing those 3 scored rows plus a 4th unscored `context-hygiene` row driven by `cacheHitRate` (good ≥0.7, warn ≥0.4, else bad; `'Cache hit rate unknown.'` when not a finite number), and `appliedSummary` summing `estSavingsPerWeek` over findings with `applied === true`.
- [ ] `summarizeOptimize`: `totalPerWeek` = sum of `estSavingsPerWeek` across findings (treating non-finite as 0); grade `A` below 10, `B` below 25, `C` below 50, else `D` (boundaries are inclusive-upper on the LOWER grade — i.e. exactly 10 is B, exactly 25 is C, exactly 50 is D, matching TokenMonitor's `<` comparisons exactly).
- [ ] Port `C:\Users\Matt\projects\TokenMonitor\test\optimizeGrade.test.js` and the `summarizeOptimize`-specific cases already shown from `optimizeRules.test.js` (the grade-boundary tests at 9.99/10/24.99/25/49.99/50/120) into `optimizeGrade.test.ts` using vitest syntax — the boundary tests are exact-value tests, port them verbatim.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean.
- [ ] Commit: `feat: port optimizeGrade (setup grade + factor breakdown)`

---

### Task 5: `optimizeActions.ts` (pure, ported) — guidance text + CLAUDE.md upsert logic

**Files:**
- Create: `src/shared/optimizeActions.ts` + `optimizeActions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MANAGED_BEGIN: string; // '<!-- token-tracker:begin -->'
  export const MANAGED_END: string;   // '<!-- token-tracker:end -->'
  export const HEADING: string;       // '## Token Tracker suggestions'
  export function guidanceFor(findingId: string): string | null;
  export function upsertGuidance(content: string, findingId: string): { content: string; added: boolean };
  export function isGuidanceApplied(content: string, findingId: string): boolean;
  ```

**Steps:**
- [ ] Port `C:\Users\Matt\projects\TokenMonitor\src\shared\optimizeActions.js` verbatim (shown in full in this session) into TypeScript. Keep the exact same 3 guidance strings (`GUIDANCE_BY_ID`), the exact same managed-block marker constants, and the exact same `upsertGuidance` behavior: no managed block present → append a fresh one (preserving original content byte-for-byte as a prefix, with correct separator logic for empty/no-trailing-newline/has-trailing-newline content); block present but bullet absent → insert immediately before `MANAGED_END`; bullet already present → no-op (`added: false`).
- [ ] Port `C:\Users\Matt\projects\TokenMonitor\test\optimizeActions.test.js` into `optimizeActions.test.ts` using vitest syntax — cover all the byte-preservation edge cases (empty content, content with/without trailing newline, block present with bullet already there, block present without the bullet, unknown finding id).
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean.
- [ ] Commit: `feat: port optimizeActions (CLAUDE.md guidance upsert logic)`

---

### Task 6: `electron/optimizeState.ts` (persistence) + recurrence in `optimizeRules.ts`

**Files:**
- Create: `electron/optimizeState.ts` + `optimizeState.test.ts`
- Modify: `src/shared/optimizeRules.ts` (add `evaluateOptimizeRulesWithRecurrence`, from Task 3)

**Interfaces:**
- Produces (`electron/optimizeState.ts`):
  ```ts
  export function sanitizeState(raw: unknown): Record<string, number>;
  export async function loadOptimizeState(statePath: string): Promise<Record<string, number>>;
  export async function recordAppliedAt(statePath: string, findingId: string, whenMs: number): Promise<Record<string, number>>;
  ```
- Modifies (`src/shared/optimizeRules.ts`):
  ```ts
  export function evaluateOptimizeRulesWithRecurrence(
    events: TranscriptEvent[],
    windowMs: number,
    appliedState: Record<string, number>,
  ): (OptimizeFinding & { recurring?: true; appliedAtMs?: number })[];
  ```

**Steps:**
- [ ] Port `C:\Users\Matt\projects\TokenMonitor\src\shared\optimizeState.js` (shown in full in this session) into `electron/optimizeState.ts` — this is electron-side (uses `fs/promises`), not `src/shared/`, matching how `attachmentsStore.ts` also does its own fs work in `electron/`, not `src/shared/`. `sanitizeState` filters an arbitrary parsed-JSON object down to only its finite-number values. `loadOptimizeState` reads+parses, returning `{}` on any error (missing file, malformed JSON). `recordAppliedAt` loads current state, sets `current[findingId] = whenMs`, writes back with `fsp.mkdir(dirname, {recursive:true})` first, `JSON.stringify(state, null, 2)`.
- [ ] Port `C:\Users\Matt\projects\TokenMonitor\test\optimizeState.test.js`'s test cases into `optimizeState.test.ts`, using a temp-directory fixture pattern (check `electron/windowBounds.test.ts` — it already persists to a real file in tests — for this codebase's established temp-file test convention rather than inventing a new one).
- [ ] In `src/shared/optimizeRules.ts`, add (per the exact logic in TokenMonitor's `evaluateOptimizeRulesWithRecurrence`, shown in full in this session): compute `eventTimestampMs(e)` from `e.timestamp` (already a `Date | null` in this codebase's `TranscriptEvent`, simpler than TokenMonitor's string-or-Date handling — just `e.timestamp ? e.timestamp.getTime() : NaN`), run `evaluateOptimizeRules` once, then for each finding with a recorded `appliedAtMs` in `appliedState`, re-run that SAME finding's rule against only the events with `eventTimestampMs(e) > appliedAtMs`: no match → drop the finding (fix held); still matches → keep it tagged `{ ...recurred, appliedAtMs, recurring: true }` (fresh numbers from post-fix evidence only, per the spec). You'll need each rule function itself addressable by id — port TokenMonitor's `RULES_BY_ID` map (not previously exported from Task 3) as a module-level (non-exported, or exported if genuinely useful — your call) lookup used only inside this function.
- [ ] Port the recurrence-specific tests from `C:\Users\Matt\projects\TokenMonitor\test\optimizeRules.test.js` (the 4 tests already shown in full in this session's brainstorm: no-applied-state passthrough, fix-held-drops-finding, recurs-after-appliedAt-kept-with-fresh-numbers, unrelated-applied-state-doesn't-affect-other-findings) into `optimizeRules.test.ts`.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean.
- [ ] Commit: `feat: add optimize applied-state persistence and recurrence tracking`

---

### Task 7: Electron main — wire detection into the existing scan cycle, add Apply-fix IPC handlers

**Files:**
- Modify: `electron/main.ts`

**Interfaces:**
- Consumes: `evaluateOptimizeRulesWithRecurrence`, `summarizeOptimize`, `gradeBreakdown` (Tasks 3/4/6), `loadOptimizeState`/`recordAppliedAt` (Task 6), `guidanceFor`/`upsertGuidance` (Task 5).
- Produces: `sendToWindow('optimize:findings', findings)`, `sendToWindow('optimize:summary', summary)`, `sendToWindow('optimize:breakdown', rows)` pushed from the existing scan cycle; `ipcMain.handle('optimize:targets', ...)` and `ipcMain.handle('optimize:apply', ...)`.

**Steps:**
- [ ] Read `electron/main.ts`'s `scanAndPushUsage()` in full (shown in this session — it already calls `scanAllProjects(projectsRoot)` and pushes `usage:snapshot`). Add, after computing `events` in that same function:
  ```ts
  const optimizeStatePath = join(os.homedir(), '.aether-os', 'optimize-state.json');
  const appliedState = await loadOptimizeState(optimizeStatePath);
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const findings = evaluateOptimizeRulesWithRecurrence(events, WEEK_MS, appliedState);
  const summary = summarizeOptimize(findings);
  let totalCacheRead = 0;
  let totalInput = 0;
  for (const e of events) {
    if (!e.usage) continue;
    totalCacheRead += e.usage.cacheReadInputTokens;
    totalInput += e.usage.inputTokens + e.usage.cacheCreationInputTokens + e.usage.cacheReadInputTokens;
  }
  const cacheHitRate = totalInput > 0 ? totalCacheRead / totalInput : 0;
  const breakdown = gradeBreakdown({ findings, cacheHitRate });
  sendToWindow('optimize:findings', findings);
  sendToWindow('optimize:summary', summary);
  sendToWindow('optimize:breakdown', breakdown);
  ```
  Compute `cacheHitRate` as its own small inline reduce over `events` (mirroring how `liveAgentTracker.ts` already accumulates `cumulativeCacheRead`/`cumulativeInput` for its OWN session-level ratio — same formula shape, applied to the historical `events` array instead of the live session).
- [ ] Add the target-path helpers and two new `ipcMain.handle` calls, near the existing `attachments:*` handlers for locality:
  ```ts
  function optimizeGlobalTargetPath(): string {
    return join(os.homedir(), '.claude', 'CLAUDE.md');
  }
  function optimizeProjectTargetPath(events: TranscriptEvent[]): string | null {
    const withCwd = events.filter((e) => e.cwd && e.timestamp).sort((a, b) => b.timestamp!.getTime() - a.timestamp!.getTime());
    return withCwd.length > 0 ? join(withCwd[0].cwd!, 'CLAUDE.md') : null;
  }
  ```
  (`optimizeProjectTargetPath` implements this plan's documented deviation from TokenMonitor's live `getLatestCwd()` — deriving "current project" from the most recently timestamped event's `cwd` in the last scan, since this app has no live per-project cwd tracking. Cache the last scan's `events` in a module-level variable set by `scanAndPushUsage()` so this function and the IPC handlers below don't need to re-scan.)
  ```ts
  ipcMain.handle('optimize:targets', async () => {
    const globalPath = optimizeGlobalTargetPath();
    const projectPath = optimizeProjectTargetPath(lastScannedEvents);
    async function pathExists(p: string): Promise<boolean> {
      try { await fsp.stat(p); return true; } catch { return false; }
    }
    return {
      global: { path: globalPath, exists: await pathExists(globalPath) },
      project: projectPath ? { path: projectPath, exists: await pathExists(projectPath) } : null,
    };
  });

  ipcMain.handle('optimize:apply', async (_event, { findingId, targetPath }: { findingId: string; targetPath: string }) => {
    const globalPath = optimizeGlobalTargetPath();
    const projectPath = optimizeProjectTargetPath(lastScannedEvents);
    const allowed = targetPath === globalPath || (projectPath !== null && targetPath === projectPath);
    if (!allowed) return { ok: false, error: 'invalid target' };
    if (guidanceFor(findingId) === null) return { ok: false, error: 'unknown finding' };

    try {
      let existing = '';
      let fileExisted = true;
      try {
        existing = await fsp.readFile(targetPath, 'utf8');
      } catch (err: any) {
        if (err.code === 'ENOENT') { existing = ''; fileExisted = false; } else { throw err; }
      }
      const { content, added } = upsertGuidance(existing, findingId);
      await recordAppliedAt(optimizeStatePath, findingId, Date.now());
      if (!added) return { ok: true, added: false, alreadyPresent: true, targetPath };

      let backupPath: string | null = null;
      if (fileExisted) {
        backupPath = `${targetPath}.ttbak-${Date.now()}`;
        await fsp.writeFile(backupPath, existing, 'utf8');
      }
      await fsp.mkdir(dirname(targetPath), { recursive: true });
      await fsp.writeFile(targetPath, content, 'utf8');
      return { ok: true, added: true, targetPath, backupPath };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
  ```
  Add a module-level `let lastScannedEvents: TranscriptEvent[] = [];` set at the top of `scanAndPushUsage()` right after `scanAllProjects` resolves, so both handlers above can read it without re-scanning. Import `fsp` (already imported as `promises as fsp` or similar — check the file's existing fs import style first), `dirname` from `path`, and the new functions from `../src/shared/optimizeActions`, `./optimizeState`, `../src/shared/optimizeRules`, `../src/shared/optimizeGrade`.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean, `npm run electron:build` clean.
- [ ] Commit: `feat: wire Optimize detection into the existing scan cycle, add Apply-fix IPC handlers`

---

### Task 8: preload + state (types/initialState/reducer) + sync hook

**Files:**
- Modify: `electron/preload.ts`
- Modify: `src/aetherElectron.d.ts`
- Modify: `src/state/types.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/reducer.ts` (+ `reducer.test.ts`)
- Create: `src/state/useOptimizeSync.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `OptimizeFinding` (Task 3), `GradeRow` (Task 4), the IPC channels/handlers from Task 7.
- Produces: `state.optimizeFindings: OptimizeFinding[]`, `state.optimizeSummary: { totalPerWeek: number; grade: 'A'|'B'|'C'|'D' }`, `state.optimizeBreakdown: GradeRow[]`, three new reducer actions (`SET_OPTIMIZE_FINDINGS`/`SET_OPTIMIZE_SUMMARY`/`SET_OPTIMIZE_BREAKDOWN`), `window.aetherElectron.optimize.{onFindings,onSummary,onBreakdown,targets,apply}`.

**Steps:**
- [ ] `electron/preload.ts`: add, matching `onActiveWork`'s push-listener pattern for the three `on*` methods and `attachments.list`'s invoke pattern for `targets`/`apply`:
  ```ts
  optimize: {
    onFindings: (callback: (findings: OptimizeFinding[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, findings: OptimizeFinding[]) => callback(findings);
      ipcRenderer.on('optimize:findings', listener);
      return () => ipcRenderer.removeListener('optimize:findings', listener);
    },
    onSummary: (callback: (summary: OptimizeSummary) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, summary: OptimizeSummary) => callback(summary);
      ipcRenderer.on('optimize:summary', listener);
      return () => ipcRenderer.removeListener('optimize:summary', listener);
    },
    onBreakdown: (callback: (rows: GradeRow[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, rows: GradeRow[]) => callback(rows);
      ipcRenderer.on('optimize:breakdown', listener);
      return () => ipcRenderer.removeListener('optimize:breakdown', listener);
    },
    targets: (): Promise<{ global: { path: string; exists: boolean }; project: { path: string; exists: boolean } | null }> =>
      ipcRenderer.invoke('optimize:targets'),
    apply: (args: { findingId: string; targetPath: string }): Promise<{ ok: boolean; added?: boolean; alreadyPresent?: boolean; targetPath?: string; backupPath?: string | null; error?: string }> =>
      ipcRenderer.invoke('optimize:apply', args),
  },
  ```
  Import `OptimizeFinding`/`GradeRow` as types from `../src/shared/optimizeRules`/`../src/shared/optimizeGrade`; define `OptimizeSummary` inline or import from `optimizeGrade.ts` if you exported it there in Task 4 (check).
- [ ] `src/aetherElectron.d.ts`: read the file first, add matching declarations under a new `optimize` namespace, following whatever declaration style `agents`/`attachments` already use.
- [ ] `src/state/types.ts`: add `optimizeFindings: OptimizeFinding[]; optimizeSummary: OptimizeSummary; optimizeBreakdown: GradeRow[];` to `AetherState`, importing the types from `../shared/optimizeRules`/`../shared/optimizeGrade`.
- [ ] `src/state/initialState.ts`: add `optimizeFindings: [], optimizeSummary: { totalPerWeek: 0, grade: 'A' as const }, optimizeBreakdown: [],`.
- [ ] `src/state/reducer.ts`: add 3 actions to the `Action` union (`SET_OPTIMIZE_FINDINGS`/`SET_OPTIMIZE_SUMMARY`/`SET_OPTIMIZE_BREAKDOWN`, each carrying its respective payload), 3 case handlers mirroring `SET_ACTIVE_WORK`'s exact wholesale-replace shape (read it first).
- [ ] `reducer.test.ts`: add 3 tests for the new actions, matching this file's existing per-action test style (check for a `SET_ACTIVE_WORK`/`SET_ANOMALIES` test to mirror; if none exists for one of those, match the general style used elsewhere in the file, per the precedent already set in this project's Instrument+Alarm Task 3).
- [ ] Create `src/state/useOptimizeSync.ts`: three `useEffect` blocks matching `useRealAgentsSync.ts`'s existing three (`onSnapshot`/`onCompleted`/`onActiveWork`) exactly — `agents.onFindings((findings) => dispatch({ type: 'SET_OPTIMIZE_FINDINGS', findings }))` (using `optimize` not `agents` as the namespace), and the same for summary/breakdown.
- [ ] `src/App.tsx`: read the file in full (already read once this session — it uses bare wrapper components like `RealAgentsSync`/`AlertSounds` mounted inside `AppShell`, inside `AetherStoreProvider`, since `App`'s own top-level body runs outside the provider). Add an `OptimizeSync` wrapper component following that exact same pattern and mount it alongside the existing ones.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean, `npm run electron:build` clean.
- [ ] Commit: `feat: plumb Optimize findings/summary/breakdown and apply-fix bridge from main process to renderer state`

---

### Task 9: `OptimizeView` UI + nav tab

**Files:**
- Create: `src/components/optimize/OptimizeView.tsx`
- Modify: `src/viewRegistry.ts`

**Interfaces:**
- Consumes: `state.optimizeFindings`/`optimizeSummary`/`optimizeBreakdown` (Task 8), `window.aetherElectron.optimize.targets`/`.apply` (Task 8), `useColors`, `Button` (both already exist).

**Steps:**
- [ ] Read `src/components/analytics/AnalyticsView.tsx` and one of its cards (e.g. `TokenBurnCard.tsx`, already `useColors()`-migrated) in full first, to match this app's established card layout/typography/spacing conventions exactly — do not invent a new visual language for this view.
- [ ] Build `OptimizeView.tsx` as a single-view component (not a card embedded elsewhere, per the approved UI-placement decision) with:
  - A header row: `⚡ OPTIMIZE` title, a summary line (`est. save ~$X/wk` normally, or `N applied · saving ~$X/wk` when `appliedSummary(...)`'s count is nonzero — call `appliedSummary` from `optimizeGrade.ts` over `state.optimizeFindings`, treating any finding you've successfully applied THIS session as `applied: true` locally in component state, since the main process doesn't track "applied" as a per-finding flag on the finding object itself, only as a timestamp in `optimizeState.json` used for recurrence), and a `Button` showing `Setup {grade} ▾` that toggles a breakdown panel.
  - The breakdown panel (toggle-shown): one row per `state.optimizeBreakdown` entry, each showing `label`, `note`, and a glyph/color keyed by `status` ('good'/'warn'/'bad') using this app's existing `colors.success`/`colors.warn`/`colors.danger` tokens — do not invent new status colors.
  - If `state.optimizeFindings` is empty: a single "Looking healthy — no findings." message, matching this app's established empty-state styling (check `emptyStyle` in a sibling file like `FilesView.tsx`).
  - Otherwise: one card per finding — `title`, `detail`, either `~$X/wk` + an "Apply fix" `Button`, or (if `finding.recurring`) a distinct warning line ("Still happening despite guidance") + a "Reapply fix" `Button` — using the `panelInset`/`chipBorder` "quiet chip" convention already established in this codebase for card-like containers.
  - Clicking Apply/Reapply opens a small target-picker overlay — model this on `TopBar.tsx`'s `apprPanelStyle` absolute-positioned dropdown-panel pattern (NOT a full-screen modal+backdrop, which has no precedent in this codebase) anchored below the clicked button: on open, call `window.aetherElectron.optimize.targets()`, show two radio-style `Button` options (global path always available; project path only if non-null, otherwise show "no active project detected" and disable that option), a confirm `Button` that calls `window.aetherElectron.optimize.apply({ findingId, targetPath })`, and a status line reporting the result (`"Applied to CLAUDE.md (backed up)"` / `"Already applied"` / an error message). Close the overlay ~900ms after a successful apply, matching TokenMonitor's own UX timing (a reasonable, already-tuned value, not arbitrary).
- [ ] Add `import { OptimizeView } from './components/optimize/OptimizeView';` and one line to `src/viewRegistry.ts`'s `VIEWS` array: `{ id: 'Optimize', inTopBar: true, inSidebar: true, component: OptimizeView }`.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean, `npm run electron:build` clean. This task has no new unit-testable logic of its own (all the interesting logic was tested in Tasks 1-6) — visual correctness (card layout, breakdown panel, target-picker overlay) is deferred to manual/live-window check, per this project's established pattern; note this explicitly in your report.
- [ ] Commit: `feat: add Optimize nav view (findings, setup grade, apply-fix target picker)`

---

After all nine tasks: whole-branch review, then a `PROGRESS.md` entry in the established format, explicitly noting: (a) this is a full port of TokenMonitor's Optimize panel including apply-fix and recurrence, not the findings-only v1 an earlier spec draft proposed; (b) the one real architectural difference from TokenMonitor — "project" target path is derived from the most-recently-timestamped event's `cwd` in the last historical scan, not a live `getLatestCwd()`, since this app's terminal has no equivalent live per-project-cwd concept; (c) the pricing table in `modelPricing.ts` is an approximation carried over from TokenMonitor, not verified against current published rates (same caveat TokenMonitor's own source carries); (d) anomaly-window integration (`docs/diagnostic-thesis-plan.md`'s Phase B4) is explicitly out of scope for this plan; (e) UI visual correctness (card layout, breakdown panel, target-picker overlay) was verified via manual/live-window check, per this project's established pattern.
