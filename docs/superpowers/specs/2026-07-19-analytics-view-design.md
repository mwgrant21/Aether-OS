# Analytics View — Design

## Context

`Analytics` is registered in `viewRegistry.ts` with `component: null`, so it currently renders
the app's generic "not built yet" placeholder. No existing view or component routes into it —
unlike Memory/Projects, there is no pre-existing "VIEW ALL →" or button pointing at this tab yet.

`BottomMetricsRow.tsx` (`src/components/layout/BottomMetricsRow.tsx`) is mounted globally in
`App.tsx`, below the active view on every tab, and already renders several
analytics-shaped widgets — but some are not real:
- **Top Commands** is a hardcoded fixture array (`TOP_COMMANDS`), not derived from
  `state.cmdHist` (the last 30 typed terminal commands, already tracked).
- The **LIVE / DAILY / WEEKLY** range chips above the weekly bar chart are inert — only
  `WEEKLY` is styled "active" and clicking does nothing.
- **Session start** ("2:15 PM"), **Uptime** ("3h 42m"), and the weekly chart's
  "▼ 12% vs last wk" label are hardcoded strings, not derived from any state.

This design's scope includes fixing the Top Commands fixture (see Goal) but explicitly
leaves the inert range chips and the hardcoded session-info strings alone (see Non-goals) —
those are separate, unrelated fakes with no bearing on this view's data.

Data this view draws on, all already tracked and used elsewhere in smaller/narrower form:
- `Agent.share`/`Agent.hist` — per-agent live token share and a 15-sample burn history,
  currently only shown one-at-a-time in `AgentDetailCard.tsx`'s sparkline. No view compares
  agents to each other.
- `state.cmdHist` — last 30 typed terminal commands as raw strings (e.g. `"kill code builder"`),
  currently used only for the terminal's up/down history navigation, never counted/ranked.
- `SysMetric.hist` — an 8-sample rolling history per metric (CPU/MEM/NET/DISK), currently
  sparklined small in `SystemOverviewCard.tsx` (Terminal view) with no summary statistics.
- `state.logs` — the last 14 log entries, each with a `c` (color) field. Exactly three colors
  are used app-wide today (verified by grep across every log-producing site, `tick.ts` and
  `reducer.ts`'s `applyApprovalResolution`): `#3be0a0` (success), `#7fd8ef` (info/neutral),
  `#ff9d9d` (denied). No view aggregates log activity by type.

The Agents/Projects/Memory views establish a roster+detail master-detail pattern for
single-selectable-item views. Analytics has no single selectable item — it is a set of four
independent summary cards, closer in spirit to `DashboardView.tsx`'s grid-of-cards layout.

## Goal

Build a real Analytics view: a 2×2 grid of four cards, each surfacing a genuinely new
cross-cutting or deeper summary of data the app already tracks — agent burn-share ranking,
real command-frequency ranking, system-metric summary statistics, and log/alert frequency by
type — with no new state, actions, or persistence. As part of making Top Commands real, the
footer's hardcoded `TOP_COMMANDS` fixture and its inaccurate "THIS WEEK" label (the underlying
data has no per-week granularity — `cmdHist` is a 30-entry rolling window) are fixed to use the
same real derivation this view uses, so the two can never drift apart.

## Non-goals

- **The footer's inert LIVE/DAILY range chips.** Not wired to do anything today; wiring them up
  is unrelated to making Top Commands real and is out of scope here.
- **The footer's hardcoded Session Info strings** (`"2:15 PM"` start time, `"3h 42m"` uptime,
  the weekly chart's `"▼ 12% vs last wk"` label). None of this data exists anywhere in state to
  derive from truthfully; fixing it would require adding new session-tracking state, which is
  a separate concern from this view.
- **Any new state, reducer action, or persisted field.** This view is 100% derived from
  existing `AetherState` fields — no `selected`-style field, since there is no single
  selectable item across four independent cards.
- **Any new backend/simulated data source.** No new metric categories are invented; every card
  reuses a field this app already tracks (see Context).
- **Editing, filtering, or configuring any of the four cards.** Read-only summaries, matching
  the fact that nothing in this app lets a user reconfigure what Dashboard's cards show either.

## Architecture

New `src/components/analytics/` module.

### `analyticsMath.ts` (pure, unit-tested)

- `computeAgentBreakdown(agents: Agent[]): { name: string; hue: string; pct: number; hist: number[] }[]`
  — one row per agent, `pct = Math.round(share * 100)`, sorted by `share` descending. Empty
  input → empty output (matches the zero-active-agents edge case already handled elsewhere in
  this app).
- `computeTopCommands(cmdHist: string[], limit = 5): { name: string; count: number }[]` —
  extracts the first whitespace-delimited word of each `cmdHist` entry (lowercased, so `"Kill
  Code Builder"`-style casing doesn't fragment counts), counts occurrences, sorts by count
  descending with alphabetical tie-break for determinism, returns the top `limit`. Empty input
  → empty output.
- `computeSysMetricStats(sys: SysMetric[]): { label: string; val: number; hist: number[]; min: number; max: number; avg: number }[]`
  — one row per metric, `min`/`max`/`avg` computed over that metric's existing `hist` array
  (unrounded; formatting/rounding is the component's job, matching how `val` is already handled
  elsewhere in this app).
- `computeLogFrequency(logs: LogEntry[]): { color: string; label: string; count: number }[]` —
  four fixed buckets in a fixed order: `{ color: '#3be0a0', label: 'Success' }`,
  `{ color: '#7fd8ef', label: 'Info' }`, `{ color: '#ff9d9d', label: 'Denied' }`,
  `{ color: '#5f8a97' (colors.textMuted), label: 'Other' }` — the last catching any log color
  outside the three verified in-use colors, so a future new log-producing site can't silently
  vanish from the count instead of surfacing as "Other". Always returns all four buckets (count
  0 where nothing matched), never an empty array, so the card never has to special-case a
  missing bucket.

### `AgentBreakdownCard.tsx`

Ranked list, one row per agent from `computeAgentBreakdown`: hue swatch, name, `pct`, and a
small sparkline from `hist` (reusing the existing `spark()` util from `src/utils/format.ts`,
same as `AgentDetailCard.tsx`'s sparkline). Empty state ("no active agents") when
`state.agents` is empty, matching every other empty-agents handling in this app.

### `TopCommandsCard.tsx`

Ranked list, one row per entry from `computeTopCommands(state.cmdHist)`: rank number, command
name, a proportional bar (width relative to the top entry's count, mirroring the footer's
existing bar-list visual language), and the count. Empty state ("no commands run yet") when
`state.cmdHist` is empty.

### `SystemMetricsCard.tsx`

One row per metric from `computeSysMetricStats(state.sys)`: label, current `val`, a sparkline
(reusing `spark()`), and a `min / avg / max` summary line — the one genuinely new piece of
information this card adds over `SystemOverviewCard.tsx`'s existing small tiles.

### `LogFrequencyCard.tsx`

Four rows, one per `computeLogFrequency(state.logs)` bucket (always all four, in fixed order):
color swatch, label, count. Bucket colors reuse the log entries' own `c` values directly (no
new color mapping beyond what `computeLogFrequency` already assigns).

### `AnalyticsView.tsx`

Thin composition root: renders the four cards in a 2×2 CSS grid (`display: 'grid',
gridTemplateColumns: '1fr 1fr'`), mirroring `DashboardView.tsx`'s grid-of-cards structure
(as opposed to Projects/Agents/Memory's two-column roster+detail flex row). Registered in
`viewRegistry.ts` as `Analytics`'s `component`, replacing `null`.

### `analyticsMath.test.ts`

Unit tests for all four pure functions (see Testing below).

## Modified: `BottomMetricsRow.tsx`

- Replace the hardcoded `TOP_COMMANDS` array and its rendering with
  `computeTopCommands(state.cmdHist)` (same `analyticsMath.ts` import `AnalyticsView` uses), so
  the footer and the new view can never show different rankings for the same data.
- Change the "THIS WEEK" label directly above the Top Commands list to "RECENT" — the only
  copy change in this file, reflecting that `cmdHist` is a 30-entry rolling window, not a
  week-scoped stat.
- Everything else in this file (weekly bar chart, context-window donut, session info, the inert
  range chips) is **unchanged** — this is a targeted fix of one specific fake, not a rewrite.

## State changes

None. No new `AetherState` field, no new reducer action, no persistence changes. This is the
first view in this project built entirely from existing state.

## Data flow

No new entry points needed (Non-goals: no other view links into Analytics yet, matching that
nothing linked into Projects or Memory before their own views existed either — those links were
either pre-existing routing this fills in, or simply absent, and adding a new "VIEW ALL →" link
elsewhere is out of scope here). Within the view: all four cards independently read from
`useAetherStore()`'s `state` and call their respective `analyticsMath.ts` function on render —
no cross-card data flow, no shared local state.

## Error handling / edge cases

- **Zero active agents:** `AgentBreakdownCard` shows its empty state; `computeAgentBreakdown([])`
  returns `[]`, no crash.
- **Empty `cmdHist`** (a fresh session before any terminal command is typed): `TopCommandsCard`
  shows its empty state; `computeTopCommands([])` returns `[]`. The footer's Top Commands
  section must handle this identically (same function, same empty case) — verified in Testing.
- **`sys`/`logs` are never empty in this app** (both are seeded and always populated by
  `tick.ts`), so `SystemMetricsCard`/`LogFrequencyCard` have no zero-data edge case to handle
  beyond what `computeSysMetricStats`/`computeLogFrequency` already return correctly for an
  empty array (defensive correctness, not a real reachable state).
- **A `cmdHist` entry that's just whitespace or the bare `clear`/`help` command with no args:**
  `computeTopCommands` still extracts a first word correctly (`"clear".split(/\s+/)[0] ===
  "clear"`); no special-casing needed.

## Testing

**Unit (`analyticsMath.test.ts`):**
- `computeAgentBreakdown`: sorts by share descending, `pct` rounds correctly, empty input →
  empty output.
- `computeTopCommands`: counts and ranks correctly against a known `cmdHist` fixture,
  case-insensitive counting (`"Kill X"` and `"kill Y"` both count toward `"kill"`), alphabetical
  tie-break when counts are equal, respects `limit`, empty input → empty output.
- `computeSysMetricStats`: `min`/`max`/`avg` computed correctly against a known `hist` fixture
  per metric, one row per input metric in the same order.
- `computeLogFrequency`: correct bucket counts against a fixture mixing all three known colors
  plus one unknown color (falls into "Other"), always returns exactly four buckets in fixed
  order even when some buckets are empty.

**Manual GUI QA (plan-exit, per this project's convention):**
1. Analytics tab renders the 2×2 grid with all four cards populated from the live seed state.
2. Agent Breakdown ranks the seed agents by share descending; sparklines render.
3. Top Commands is empty on a fresh session; after typing a few terminal commands, it populates
   and matches the footer's Top Commands list exactly (same ranking, same counts).
4. Footer's Top Commands label reads "RECENT" instead of "THIS WEEK"; the weekly bar chart,
   context donut, and session info are otherwise visually unchanged from before this plan.
5. System Metrics card shows min/avg/max alongside each metric's current value and sparkline.
6. Log Frequency card shows all four buckets (Success/Info/Denied/Other) with plausible counts
   against the seed session's log history.
7. Zero-agents edge case (temporarily clear `state.agents`) shows Agent Breakdown's empty state
   without crashing; other three cards are unaffected.
