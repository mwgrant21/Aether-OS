# Optimize Panel — Design Spec

## Goal

Port TokenMonitor's Optimize panel **in full**: rule-based detection of Claude Code
usage waste (wrong-model-for-the-turn, re-read files that should be pinned,
uncapped command output), priced by counterfactual cost, rolled into a
letter-grade summary, with a one-click **Apply fix** that writes real guidance
into `CLAUDE.md` (global or project-scoped), and **recurrence tracking** that
re-flags a finding if it keeps happening after the fix was applied. This
supersedes an earlier draft of this spec that deferred apply-fix/recurrence —
superseded per an explicit decision to match TokenMonitor's complete closed loop
now, not as a later fast-follow.

**Note on scope boundary**: `docs/diagnostic-thesis-plan.md` treats this port as
"Phase B4" input to a not-yet-designed anomaly-window cost-attribution record.
This plan does NOT attempt that integration — it stays self-contained, keying
rules off raw `TranscriptEvent` data exactly as TokenMonitor's do. Consuming
anomaly windows instead of/alongside raw events is a separate, later decision.

## Why this ports cleanly

Aether OS already has almost everything TokenMonitor's Optimize needs, built for
other features:

- `electron/transcriptParser.ts`'s `TranscriptEvent` (kind/model/usage/toolUses/
  toolResults) is structurally the same shape TokenMonitor's rules consume.
- `electron/historyScanner.ts#scanAllProjects(projectsRoot)` already walks every
  project under `~/.claude/projects` and parses every `.jsonl` line — this is
  exactly TokenMonitor's historical-rescan behavior, already built.
- `main.ts#scanAndPushUsage()` already calls `scanAllProjects` on a 60-second
  timer and pushes the result to the Dashboard. Optimize's rule evaluation
  **reuses this same scan and the same `events` array** — no second scan loop.
- `src/shared/` is already the established home for pure, dual-context
  (main + renderer) logic (`anomalyDetectors.ts`, `alertSounds.ts`) — the exact
  role TokenMonitor's `optimizeRules.js`/`optimizeGrade.js`/`modelPricing.js` play.

One real gap: `TranscriptToolResult` doesn't currently capture the tool result's
raw content length, which the `uncapped-bash-output` rule needs. Fixing this is
a small, precedented extension (`originKind` was added to `TranscriptEvent` the
same way, for a different rule, in Instrument+Alarm's Task 2).

## Rules ported (3, matching TokenMonitor exactly)

1. **`opus-on-trivial-turns`** — an Opus-tier turn with output under 100 tokens.
   Estimated cost = actual Opus cost minus what the same turn would have cost on
   Sonnet.
2. **`unpinned-config-re-reads`** — the same file `Read` 3+ times in the scanned
   window. This is the *cost-estimation* sibling of the already-shipped
   `detectReReadLoop` anomaly (Instrument+Alarm) — that one flags a live re-read
   loop for the reactor/Grid warning ring; this one costs it out over history.
   They can coexist without duplication: one is a live-session anomaly signal,
   the other a historical waste-with-a-dollar-figure signal.
3. **`uncapped-bash-output`** — a `Bash` tool call whose result exceeds a size
   threshold with no pagination hint (`head`/`tail`/`Select-Object -First`/etc.)
   in the command string.

Each finding: `{ id, title, detail, estSavingsPerWeek, fixText }`.

## Architecture

### `src/shared/modelPricing.ts` (new, direct port)

```ts
export const PRICING_PER_MILLION_TOKENS = {
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 0.8, output: 4 },
} as const;
export function pricingTierForModel(modelName: string | null): 'opus' | 'sonnet' | 'haiku';
export function costForEvent(event: { model: string | null; usage: TranscriptUsage | null }): number;
```
Same substring-matching convention `reactorMath.ts`'s `computeModelHueShift` already
uses (haiku/opus/else-sonnet) — consistent with an established pattern in this
codebase, not a new one.

### `electron/transcriptParser.ts` (modify)

Add `resultLength: number` to `TranscriptToolResult`, computed as the
JSON-stringified length of the tool_result's `content` field at parse time.
This is additive — existing consumers (`liveAgentsMath.ts`, `toolCallHistory.ts`)
ignore the new field; only the new Optimize rule reads it.

### `src/shared/optimizeRules.ts` (new, ported)

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
Operates on `TranscriptEvent[]` (this app's real type) instead of TokenMonitor's
own event shape — the three rule bodies port almost line-for-line, adjusted for
field names (`toolUses`/`toolResults` are already the same names).

### `src/shared/optimizeGrade.ts` (new, ported)

```ts
export interface GradeRow { key: string; label: string; status: 'good' | 'warn' | 'bad'; note: string; scored: boolean; }
export function gradeBreakdown(input: { findings: OptimizeFinding[]; cacheHitRate: number }): GradeRow[];
export function summarizeOptimize(findings: OptimizeFinding[]): { totalPerWeek: number; grade: 'A' | 'B' | 'C' | 'D' };
```
`cacheHitRate` here is computed from the SAME historically-scanned `events`
array the rules run on (aggregate `cacheReadInputTokens` / total input across
all scanned events) — a distinct figure from Instrument+Alarm's
`state.cacheHitRatio` (which is a live, single-session running total). Same
name-adjacent concept, different scope; do not conflate the two or reuse one
for the other.

### `electron/main.ts` (modify)

Inside the existing `scanAndPushUsage()`, after computing `events`, add:
```ts
const windowMs = 7 * 24 * 60 * 60 * 1000; // matches realUsageMath.ts's WEEK_MS
const findings = evaluateOptimizeRules(events, windowMs);
sendToWindow('optimize:findings', findings);
```
No new scan, no new interval — rides the existing 60s cycle.

### `electron/preload.ts` / `src/aetherElectron.d.ts` (modify)

`onOptimizeFindings(callback): () => void`, matching `onActiveWork`'s exact
listener/cleanup pattern.

### State (modify `types.ts`/`initialState.ts`/`reducer.ts`/a sync hook)

`state.optimizeFindings: OptimizeFinding[]` (default `[]`), `SET_OPTIMIZE_FINDINGS`
reducer action (wholesale replace, matching `SET_ACTIVE_WORK`/`SET_ANOMALIES`),
wired via a `useOptimizeSync` hook mounted the same way as
`useRealAgentsSync`/`useAlertSounds` — or folded into the existing
`useRealUsageSync.ts` hook, since both react to the same `usage:snapshot`-style
scan cycle (implementer's call, based on which reads cleaner).

### UI: new `Optimize` nav tab

`src/components/optimize/OptimizeView.tsx` (new) — a findings list (one card per
finding: title, detail, `~$X/wk`, fix text, using this app's established
`panelInset`/`chipBorder` "quiet chip" convention) plus a Setup-grade letter and
the 4-row factor breakdown from `gradeBreakdown`. One line added to
`src/viewRegistry.ts`'s `VIEWS` array: `{ id: 'Optimize', inTopBar: true, inSidebar: true, component: OptimizeView }`.
No Apply/fix buttons in v1.

## Apply-fix + recurrence (now in scope)

Ported from `optimizeActions.js` (pure guidance/upsert logic), `optimizeState.js`
(applied-timestamp persistence), and `optimizeActionHandlers.js` (the two IPC
handlers) — see the Implementation Plan for the concrete task breakdown. Key
behaviors carried over unchanged:

- **Apply is one-click, not automatic** — a real user action (button + confirm),
  never triggered by the background scan. This is the actual reason TokenMonitor
  didn't make this fully automatic, and the same reasoning holds here: writing
  to a project's `CLAUDE.md` should stay a conscious choice.
- **Server-side path allowlist** — the main process only ever writes to the
  global (`~/.claude/CLAUDE.md`) or a derived project path, both computed in the
  main process; the renderer sends a `findingId` and picks between two
  main-computed paths, never an arbitrary path string.
- **Backup before write** — an existing target file is copied to
  `<path>.ttbak-<timestamp>` before the new content is written.
- **Recurrence** — re-applying always resets the check ("Apply" means "watch
  from now"); a finding whose fix held (no matching evidence since applied) is
  dropped entirely; one that still matches is kept and tagged `recurring: true`
  with fresh (post-fix-only) numbers, never stale pre-fix evidence.

**One real difference from TokenMonitor worth flagging**: TokenMonitor derives
the "project" target from a live `getLatestCwd()` getter tied to its terminal's
actual working directory. Aether OS's embedded terminal always spawns at
`homeDir` (see `liveAgentTracker.ts`'s existing comment on this) — there's no
single "current project" concept to key off the same way. This plan instead
derives the project target from whichever project directory contributed the
most recently-timestamped event in the historical scan already underway — a
reasonable proxy, not a perfect match, and worth revisiting if it proves
confusing in practice.

## Out of scope (still deferred)

- **Per-project attribution/drill-down** — TokenMonitor's rules aggregate
  globally across all scanned projects; this port matches that. A "which
  project is this costing you in" breakdown view is a reasonable v2.
- **Anomaly-window integration** (`docs/diagnostic-thesis-plan.md`'s Phase B4) —
  explicitly out of scope per the note above.

## Testing

- `modelPricing.ts`, `optimizeRules.ts`, `optimizeGrade.ts` are pure — port
  TokenMonitor's existing test suites as the starting fixture set, adapted to
  `TranscriptEvent`'s field names/shape.
- IPC wiring and the UI view: same not-meaningfully-unit-testable-past-the-pure-
  logic-layer pattern as every other feature shipped this session — verified
  manually/live-window, not with jsdom.
