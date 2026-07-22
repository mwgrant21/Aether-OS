# Real Active Agents in Analytics (Phase 3, slice 4) — Design

## Context

Phase 3 has shipped three slices: real Active Agent dispatch tracking in
Terminal/Dashboard's cards (first slice), the Agents view's roster+detail
pair (slice 2), and the Orchestration Grid (slice 3). Analytics was
deliberately scoped out of slice 3 — its `AgentBreakdownCard` depends on
`Agent.share`/`Agent.hist`, fields with no real equivalent, the same problem
Grid had with its project-ring/crew-assignment logic.

Reading Analytics' actual source first (already done during this slice's
brainstorming, confirmed unaffected by slice 3's own diff) showed the scope
is narrower than "Analytics": of its four cards
(`AgentBreakdownCard`/`TopCommandsCard`/`SystemMetricsCard`/`LogFrequencyCard`,
backed by `analyticsMath.ts`), only `AgentBreakdownCard` reads agent data at
all. The other three read command history, system metrics, and logs — none
of them reference `state.agents` and are untouched by this slice.

`AgentBreakdownCard`'s entire premise — "AGENT BURN BREAKDOWN," ranked by
`Agent.share` (percent of a simulated token-burn rate) with an `Agent.hist`
token-draw sparkline — has no honest real substitute the way Grid's ring
position did. Real per-dispatch token consumption is still a deliberately
deferred non-goal from the first slice (the completion event's
`<usage><subagent_tokens>` XML exists but nothing captures or stores it
anywhere yet). The user chose to redesign the card around elapsed time
instead — the same substitution Grid made for its feed-link stroke width —
rather than leave it fictional pending a future token-history slice.

## Goal

`AgentBreakdownCard.tsx` reads `state.realAgents` instead of `state.agents`,
reframed as a duration-sorted list ("LONGEST-RUNNING AGENTS") rather than a
burn-share breakdown.

## Non-goals

- **No changes to `TopCommandsCard`, `SystemMetricsCard`, `LogFrequencyCard`,
  or their `analyticsMath.ts` functions** (`computeTopCommands`,
  `computeSysMetricStats`, `computeLogFrequency`) — none read agent data,
  all stay exactly as they are.
- **No real per-dispatch token/duration history or sparkline.** Still
  deliberately deferred, same as every prior slice. This card's row
  no longer has anything resembling a sparkline at all — not a real one, not
  a placeholder.
- **No changes to Files, Memory, or Chat.** All three keep reading the
  fictional `state.agents` roster, untouched — separate, later slices.
- **No new sorting/filtering controls.** The card is duration-sorted,
  descending, unconditionally — no user-facing toggle to sort a different
  way, matching the existing card's own lack of controls.

## Architecture

### `analyticsMath.ts`: new real-data breakdown function

```ts
export interface RealAgentBreakdownRow {
  toolUseId: string;
  subagentType: string;
  description: string;
  elapsedMs: number;
}

export function computeRealAgentBreakdown(agents: RealAgentDispatch[], now: number): RealAgentBreakdownRow[] {
  return agents
    .map((a) => ({
      toolUseId: a.toolUseId,
      subagentType: a.subagentType,
      description: a.description,
      elapsedMs: now - new Date(a.startedAt).getTime(),
    }))
    .sort((a, b) => b.elapsedMs - a.elapsedMs);
}
```

`now` is an explicit parameter, matching the established pattern (used by
Grid's `computeRealFeedLinks`/`computeRealGridLayout`) of pure math never
calling `Date.now()` internally — the owning component's local ticking `now`
state is threaded in, keeping the function testable with fixed timestamps.

### `AgentBreakdownCard.tsx`: rewritten

- Title changes from `"AGENT BURN BREAKDOWN"` to `"LONGEST-RUNNING AGENTS"`
  — distinct from "ACTIVE AGENTS" (used by Terminal's card and the
  Agents-view roster), since this card's specific value is the duration
  ordering, not just "what's currently running."
- Adds the same live-ticking `now` local state (`useState`/`useEffect`/
  `setInterval(1000)`/`clearInterval`) every other real-data component in
  this app already uses.
- Each row: fixed accent-color avatar with a 2-letter code from
  `subagentType` (replacing the per-agent hue swatch), `subagentType` as the
  primary label (replacing `name`), `description` as secondary text in the
  space the sparkline previously occupied, and a live `fmtElapsed(row.elapsedMs)`
  readout right-aligned where the `{pct}%` figure used to be.
- Empty-state copy changes from `"no active agents"` to `"no agents currently
  running"`, matching the established wording used everywhere else in this
  migration.

### Dead code

Confirmed via grep that `computeAgentBreakdown` and `AgentBreakdownRow` have
no consumers anywhere in `src/` outside `AgentBreakdownCard.tsx`,
`analyticsMath.ts` itself, and `analyticsMath.test.ts` — once the card stops
using them, they become genuinely dead. Following the same sequencing
discipline established in slices 2 and 3: removed only as the last step,
after the card has already been rewritten and the build confirmed clean
without them — never removed first.

## Error handling / edge cases

- **Zero real dispatches**: `computeRealAgentBreakdown([], now)` returns
  `[]`; the card renders its empty state.
- **Two dispatches with identical `startedAt`** (both fired in the same
  millisecond, plausible for a batch dispatch): `.sort()`'s stability is not
  relied upon for correctness here — either relative order is an acceptable
  tie-break, since both would show visually identical elapsed times anyway.
- **A dispatch completes between renders**: handled identically to every
  other real-data view — the next `state.realAgents` snapshot simply omits
  it, and React's keyed `.map()` (keyed on `toolUseId`) removes its row
  cleanly.

## Testing

**Unit tests** (`analyticsMath.test.ts`, extended): `computeRealAgentBreakdown`
gets tests for descending elapsed-time ordering (at least 3 dispatches with
distinct `startedAt` values, asserting row order), the empty-array case, and
a check that `elapsedMs` is computed correctly against a fixed `now` (not
relying on real wall-clock time in the test). The existing
`computeAgentBreakdown` describe block is removed in the same task that
removes the function itself.

**No new tests for `AgentBreakdownCard.tsx`** — matching this project's
established convention of manual GUI verification for presentational
components.

**Manual verification (plan-exit):**
1. With `state.realAgents` empty: confirm the card shows `"no agents
   currently running"`.
2. With multiple real dispatches active at different start times: confirm
   they're ordered longest-running first, each showing its subagent type,
   description, and a live-ticking elapsed-time readout.
3. Confirm `TopCommandsCard`/`SystemMetricsCard`/`LogFrequencyCard` show zero
   regression — all three still render exactly as before.
4. Confirm Files, Memory, and Chat show zero regression — all three still
   reference the fictional `state.agents` roster exactly as before.
