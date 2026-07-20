# Real Dashboard Usage Data (Phase 2) — Design

## Context

Phases 0-1 (shipped) gave aether-os a real Electron shell and a real,
persistent `claude` CLI terminal session. Every other piece of the app —
including the entire "reactor" simulation — is still driven by
`state/tick.ts`'s `computeTick()`, which runs every second and random-walks
`used`/`rate`/`ctxUsed`/`weekRaw`, every agent's `pct`/`hist`, `sys`
(CPU/MEM/NET/DISK), logs, notifs, and approvals — all in one function, all
entangled with each other (`rate` alone feeds the alarm level, every agent's
sparkline, and the reactor's pulse-animation speed).

The sibling project TokenMonitor already solves "real Claude Code usage
data" via a fully portable, dependency-free pipeline: `transcriptParser.js`
(pure, parses one JSONL line into a normalized event), `historyScanner.js`
(fs-only, walks `~/.claude/projects/**/*.jsonl`, returns the full event
array), and `historyAggregator.js` (pure, derives burn-trend series,
spend-by-project, session history, model split, week-over-week deltas — none
of it Electron-specific).

None of TokenMonitor's own dashboard concepts map cleanly onto aether-os's
*existing* Analytics cards (Agent Breakdown, Top Commands, System Metrics,
Log Frequency are all about the fictional agent/log/command simulation, not
Claude Code activity). They map directly onto aether-os's *Dashboard* token
widgets instead — `ReactorStatusCard`'s KPI tiles (SESSION TOKENS, BUDGET
LEFT, DEPLETION ETA, CONTEXT) and the global footer's (`BottomMetricsRow.tsx`,
mounted on every view) TOKEN USAGE card (weekly bar chart, THIS WEEK total,
week-over-week trend) and part of its SESSION INFO card ("Tokens used" row).

## Goal

Replace the token/burn-specific numbers in the widgets above with real data
computed by periodically scanning `~/.claude/projects/**/*.jsonl`, while
leaving `tick.ts` and everything it drives (agents, `sys`, logs, notifs,
approvals, alarm level, reactor pulse animation) exactly as fictional as
they are today.

## Non-goals

- **`tick.ts` is not touched.** `state.used`/`state.rate`/`state.weekRaw`
  keep existing exactly as they do today and keep driving the fictional
  reactor/agent/alarm/pulse system unchanged — real data is added as an
  entirely separate, new state slice, not a replacement of these fields.
  This is the direct, lower-risk consequence of scoping this phase to "just
  the token widgets, not agents": touching `tick.ts` in place would risk
  destabilizing the alarm/pulse/agent-sparkline behavior that's explicitly
  out of scope until a later phase resolves what "Agents" should mean.
- **CONTEXT (the context-window-fill KPI and the footer's CONTEXT WINDOW
  card) stays fictional.** A single session's live context-window
  percentage isn't reliably derivable from batch-scanning historical
  transcript files — TokenMonitor itself needed a separate live-scraping
  mechanism (`usageScraper`) for this, which is out of scope here.
- **No dollar spend.** Real numbers this phase are token counts only — no
  `modelPricing.js` port, no `$` figures anywhere. The current KPI tile's
  fake "$0.000018/token spend" subtitle is removed, not replaced with a
  real-but-fragile dollar estimate.
- **No live-tailing of the active session.** Real numbers refresh via a
  periodic re-scan (every 60s) of all transcript files, not a
  `liveSessionMonitor`-style tail of the currently-open session.
- **No new "Recent Sessions" view or any other new UI surface.** Only the
  specific widgets named in Goal change.
- **Analytics' four existing cards are untouched** — they remain entirely
  about the fictional simulation, as today.
- **One known, accepted inconsistency this phase deliberately leaves
  unresolved:** the alarm system (BURN ALARM / ELEVATED / NOMINAL, plus its
  notification toasts) stays driven by the fictional `state.rate`, now
  fully decoupled from the real burn numbers displayed right next to it —
  you could see a real "BUDGET LEFT: 12%" beside a fictional "NOMINAL"
  status with no relationship between them. Reconciling the alarm/pulse
  system's real-vs-fictional status is left to whatever later phase
  actually tackles the reactor simulation holistically.

## Architecture

### New state: `AetherState.realUsage`

```ts
export interface RealUsageSnapshot {
  weeklyTokens: number[];        // 7 values, oldest -> newest (Mon..Sun), matches BottomMetricsRow's existing DAY_LABELS order
  usedThisMonth: number;
  burnRatePerMin: number;        // tokens/min over a recent window (last 10 minutes)
  weekOverWeekPct: number | null; // null when there's no meaningful prior-week data to compare against
  lastScanAt: string | null;      // ISO timestamp of the last successful scan, null before the first one completes
}
```

Seeded in `initialState.ts` as all-zero/null (`weeklyTokens: [0,0,0,0,0,0,0]`,
`usedThisMonth: 0`, `burnRatePerMin: 0`, `weekOverWeekPct: null`,
`lastScanAt: null`) — this is also exactly what a plain-browser session
(`npm run dev`, no Electron) permanently shows, since there's no real data
source to populate it there. No special "requires Electron" fallback
messaging is added for these widgets (unlike `PtyTerminal`'s dedicated
fallback) — a Dashboard full of honest zeros for real-data widgets, sitting
alongside the still-fully-functional fictional ones, doesn't need one.

New reducer action `SET_REAL_USAGE: { snapshot: RealUsageSnapshot }`,
replacing `state.realUsage` wholesale on each scan.

### Pure aggregation logic: `src/components/dashboard/realUsageMath.ts` (new)

Deliberately placed under `src/` (not `electron/`) so it's covered by this
project's existing Vitest/`tsc -b` setup, matching every other `xMath.ts`
module's convention — mirrors TokenMonitor's own split between pure,
testable `src/shared/historyAggregator.js` and fs-touching
`src/main/historyScanner.js`. Consumes the same normalized event shape
`transcriptParser` produces (ported below):

```ts
export interface UsageEvent {
  kind: 'assistant' | 'user' | 'other';
  timestamp: Date | null;
  usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number } | null;
}

export function computeWeeklyTokens(events: UsageEvent[], now: Date): number[] { /* 7 daily buckets, oldest -> newest */ }
export function computeUsedThisMonth(events: UsageEvent[], now: Date): number { /* sum since local month start */ }
export function computeBurnRatePerMin(events: UsageEvent[], now: Date): number { /* tokens in the last 10 min / 10 */ }
export function computeWeekOverWeekPct(events: UsageEvent[], now: Date): number | null { /* this-week total vs last-week total */ }
```

Adapted from, not a verbatim port of, `historyAggregator.js`'s
`burnSeries`/`weekOverWeek`/`forecastMonth` — aether-os's BUDGET LEFT/
DEPLETION ETA model (a monthly cap depleting against cumulative usage) is
close to but not identical to TokenMonitor's own framing, so these functions
are purpose-built for aether-os's existing KPI formulas in
`dashboardMath.ts`, not copies.

### Electron main process

- `electron/transcriptParser.ts` (new) — TypeScript port of TokenMonitor's
  `src/shared/transcriptParser.js`, typed to produce `UsageEvent` (plus the
  full normalized shape TokenMonitor's version returns, in case a later
  phase wants the rest of it — `sessionId`, `cwd`, `model`, `toolUses`, etc.
  are kept even though this phase only consumes `kind`/`timestamp`/`usage`).
- `electron/historyScanner.ts` (new) — TypeScript port of TokenMonitor's
  `src/main/historyScanner.js`, resolving `path.join(os.homedir(), '.claude',
  'projects')` (the exact path TokenMonitor itself uses, confirmed by
  reading its `main.js`), returning the full parsed event array.
- `electron/main.ts` (modified) — on `app.whenReady()`, runs an initial scan
  and starts a `setInterval` (60s) that re-scans, calls the four
  `realUsageMath` functions (imported from `src/components/dashboard/`,
  the same repo, resolvable by electron-vite's main bundler the same way it
  already resolves `./ptyManager` — **this needs empirical verification
  during implementation**, matching this project's established "verify,
  don't assume" discipline from Phase 0's build-output-path and Phase 1's
  preload-format discoveries), builds a `RealUsageSnapshot`, and pushes it
  to the renderer via `mainWindow.webContents.send('usage:snapshot', ...)`.
- `electron/preload.ts` (modified) — adds a read-only `usage.onSnapshot`
  listener (no `write`/`invoke` needed, unlike `pty` — this is one-way data
  flow from main to renderer).
- `src/aetherElectron.d.ts` (modified) — types the new `usage` surface.

### Renderer wiring

A new small hook, `useRealUsageSync()`, mirroring this project's existing
`usePulseDurationVar()` pattern (a small effect-only hook called once at the
App root) — subscribes to `window.aetherElectron?.usage?.onSnapshot`,
dispatching `SET_REAL_USAGE` on each push. Called once in `App.tsx`,
alongside the existing `PulseDurationSync`.

`dashboardMath.ts`'s `computeDashKpis()` is modified to read
`state.realUsage` for SESSION TOKENS/BUDGET LEFT/DEPLETION ETA (same
existing formulas — `capTokens - used`, `remaining / (rate/60)` — now fed
real inputs instead of `state.used`/`state.rate`); the CONTEXT KPI is
untouched, still reading `state.ctxUsed`.

`BottomMetricsRow.tsx` is modified: the weekly bar chart and "THIS WEEK"
total read `state.realUsage.weeklyTokens` (replacing the current magic-number
formula `327841 + (state.used - 24391)`) and a real week-over-week trend
replaces the hardcoded "▼ 12% vs last wk" text; SESSION INFO's "Tokens used"
row reads `state.realUsage.usedThisMonth` instead of `state.used` (the same
conceptual field shown twice today — leaving one real and one fictional
after this change would be an immediately obvious inconsistency). The
CONTEXT WINDOW card, TOP COMMANDS card, and every other SESSION INFO row are
untouched.

## Data flow

App mounts → `useRealUsageSync()` registers a listener → main process's
initial scan (on `whenReady`) completes → `usage:snapshot` pushes the first
real numbers → `SET_REAL_USAGE` updates `state.realUsage` → `ReactorStatusCard`'s
KPI tiles and `BottomMetricsRow`'s TOKEN USAGE card re-render with real
values. Every 60s thereafter, the same push repeats with freshly re-scanned
data. In plain-browser mode (`npm run dev`), `window.aetherElectron` is
`undefined`, the hook's subscribe call is a no-op, and `state.realUsage`
never leaves its seeded all-zero state.

## Error handling / edge cases

- **`~/.claude/projects` doesn't exist** (fresh machine, never used Claude
  Code): `historyScanner.ts`'s port of `scanAllProjects` already handles
  this (TokenMonitor's version catches `ENOENT` and returns an empty event
  array) — the aggregation functions all produce zero/null-safe output on
  an empty event array, so the widgets show honest zeros, not a crash.
- **`burnRatePerMin` is 0** (no recent activity): `DEPLETION ETA`'s existing
  `fmtEta()` helper already returns `'n/a'` for non-finite/≤0 input
  (`remaining / (0/60)` = `Infinity`, caught by `fmtEta`'s own
  `!isFinite(sec)` check) — no new handling needed, confirmed by reading
  the existing function before writing this spec.
- **First scan hasn't completed yet** (very first seconds after launch):
  `lastScanAt: null` and all-zero seed values render the same as "no real
  activity" — indistinguishable from the empty-history case above, which is
  an acceptable simplification (no separate "scanning..." loading state).

## Testing

**Unit tests** (`realUsageMath.test.ts`, new): each of the four exported
functions gets real-seed-data-shaped test fixtures (matching
`UsageEvent`'s shape) covering: normal multi-day/multi-session data, an
empty event array (all outputs zero/null, no crash), a single event exactly
at a bucket boundary, and (for `computeWeekOverWeekPct`) both "prior week
had no data" (→ `null`) and a normal comparison case.

**No new tests for `transcriptParser.ts`/`historyScanner.ts`** — these are
near-verbatim ports of already-tested TokenMonitor code, and
`historyScanner.ts` is fs-touching main-process code outside this project's
existing Vitest/`tsc -b` gate (matching Phase 0/1's precedent that
`electron/*.ts` gets editor-only type-checking, not automated test
coverage).

**Manual verification (plan-exit):**
1. `npm run electron:dev` — confirm the app launches without error and,
   within the first scan cycle, `ReactorStatusCard`'s SESSION TOKENS/BUDGET
   LEFT/DEPLETION ETA and the footer's TOKEN USAGE weekly bars show
   plausible real numbers (compare against what's actually in
   `~/.claude/projects` for a sanity check, not exact-value verification).
2. Confirm CONTEXT (both the KPI tile and the footer's CONTEXT WINDOW card)
   is unchanged — still animating via the existing fictional simulation.
3. Confirm the footer's SESSION INFO "Tokens used" row now matches
   `ReactorStatusCard`'s SESSION TOKENS tile (both reading the same real
   value), rather than the two being different numbers as they are today.
4. Wait through one 60s interval and confirm the numbers refresh (or stay
   the same, if no new activity occurred) without a page reload.
5. Confirm every other view (Agents, Grid, Analytics, etc.) still renders
   normally — nothing here should visibly change agent pct/hist, `sys`
   metrics, logs, or the alarm level.
6. Confirm `npm run dev` (plain browser) shows the same all-zero
   `realUsage` state without crashing.
