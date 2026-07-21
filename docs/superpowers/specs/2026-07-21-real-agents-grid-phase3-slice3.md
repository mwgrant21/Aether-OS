# Real Active Agents in the Orchestration Grid (Phase 3, slice 3) — Design

## Context

Phase 3 has shipped two slices so far: real Active Agent dispatch tracking in
Terminal's `ActiveAgentsCard`/Dashboard's `ActiveAgentsDigest` (first slice),
and in the Agents view's roster+detail pair (slice 2). Both left Grid,
Analytics, Files, Memory, and Chat reading the fully fictional `state.agents`
roster, deliberately untouched.

The user asked to continue with "grid/analytics" next. Reading both views'
actual source first showed they are not similar enough to brainstorm as one
slice: Grid (`OrchestrationGrid.tsx`/`gridMath.ts`) is a radial network diagram
whose entire layout depends on `ProjectStub.crew` (which project each agent is
assigned to) and `Agent.share` (a fraction of the simulated global burn rate)
— neither of which has a real equivalent. Analytics' `AgentBreakdownCard`
similarly depends on `Agent.share`/`Agent.hist` for its ranking and
sparklines. The user chose to do Grid first, as its own slice; Analytics is a
separate, later slice.

## Goal

`OrchestrationGrid.tsx` and `gridMath.ts` read `state.realAgents` instead of
`state.agents`. The project ring, crew-clustering, and assignment-link
machinery are removed entirely (not replaced) — no real "project" concept
exists yet to replace them with. What remains is a simplified hub-and-spoke:
the "AETHER CORE" hub plus one node per currently-open real dispatch, arranged
in a ring, with a feed link from the hub to each.

## Non-goals

- **No real "Projects" concept in this slice.** `state.projects`, the project
  ring, project-box clicks, and `GridView.tsx`'s `onOpenProjects` handler are
  all removed from this view, not migrated to real data — Projects has no
  real-data phase yet. The Projects view itself (`ProjectsView.tsx`) is
  untouched and still fully fictional.
- **No real per-dispatch token-share metric.** Feed-link stroke width uses
  elapsed time instead (see Architecture) — this is a repurposing of the
  visual channel, not an attempt to invent a fake "share" number for real
  dispatches.
- **No changes to Analytics, Files, Memory, or Chat.** All four keep reading
  the fictional `state.agents` roster, completely unchanged — a separate,
  later slice.
- **No changes to the hub's own rate readout** (`formatHubRate(rate)`, using
  `state.rate`) — that's the simulated reactor's global burn rate, a Phase 2
  concern (already given a real equivalent elsewhere, in Dashboard/footer),
  not part of "real Agents." Left exactly as-is.
- **No new click actions beyond the existing single click-to-select.** No
  hover tooltips, no drag, no zoom — matching the view's current interaction
  surface, just re-pointed at real data with a corrected dispatch (see
  Architecture).

## Architecture

### `gridMath.ts`: real-dispatch layout functions alongside the existing agent-angle math

New types and functions, additive at first (the existing fictional-agent
functions are removed only once genuinely dead — see Dead code below):

```ts
export interface RealAgentNode {
  agent: RealAgentDispatch;
  angle: number;
  x: number;
  y: number;
}

export interface RealFeedLink {
  toolUseId: string;
  x1: number; y1: number; x2: number; y2: number;
  strokeWidth: number;
}

export interface RealGridLayout {
  hub: { x: number; y: number };
  agentNodes: RealAgentNode[];
  feedLinks: RealFeedLink[];
  agentCount: number;
  linkCount: number;
}
```

- `computeRealAgentNodes(agents: RealAgentDispatch[]): RealAgentNode[]` —
  identical ring-placement logic to the existing `computeAgentNodes`, reusing
  the unchanged, agent-agnostic `agentAngle(index, total)` helper.
- `computeFeedStrokeWidthByElapsed(elapsedMs: number): number` — maps elapsed
  time to the same `[1.5, 8.5]` stroke-width range the existing
  `computeFeedStrokeWidth(share)` produces, using Phase 2's already-established
  10-minute burn-rate window (`BURN_WINDOW_MIN` in `realUsageMath.ts`) as the
  scale: linearly interpolates from the minimum at 0 elapsed to the maximum at
  10 minutes elapsed, holding at the maximum beyond that. A grounded existing
  constant, not an arbitrary new one.
- `computeRealFeedLinks(agentNodes: RealAgentNode[], now: number): RealFeedLink[]`
  — takes `now` as an explicit parameter (elapsed = `now - new
  Date(node.agent.startedAt).getTime()`), matching this project's established
  "pass time in, don't call `Date.now()` inside pure math" convention (already
  used by every `fmtElapsed`-consuming component).
- `computeRealGridLayout(agents: RealAgentDispatch[], now: number): RealGridLayout`
  — the real-data equivalent of `computeGridLayout`, with no `projectNodes`/
  `assignmentLinks` fields at all (not empty arrays — the fields don't exist
  on this type, since there's no project concept to represent).

`agentAngle`, `computeViewportTransform`, `toScreenPoint`, and `formatHubRate`
are unchanged and reused as-is — none of them are Agent-specific.

### `OrchestrationGrid.tsx`: rewritten props and rendering

- Props become `{ agents: RealAgentDispatch[]; rate: number; onSelectRealAgent: (toolUseId: string) => void }` — only `projects`/`onOpenProjects` are dropped. `rate` and the hub's `formatHubRate(rate)` label stay exactly as they are today (still `state.rate`, the simulated reactor rate) — per the Non-goals above, the hub's rate readout is out of scope for this slice and left untouched, not migrated or removed.
- Adds the same live-ticking `now` local state (`useState`/`useEffect`/
  `setInterval(1000)`/`clearInterval`) every other real-data component already
  uses, needed to keep feed-link thickness updating as dispatches age.
- Renders one `<g>` node per real dispatch: fixed accent-color circle/text
  (no per-node hue), 2-letter avatar from `subagentType.slice(0,2)`, label
  overlay showing `subagentType`/`description` instead of `agent.name`/
  `agent.task`.
- Clicking a node calls `onSelectRealAgent(node.agent.toolUseId)` (renamed
  from `onSelectAgent`) — see the click-through fix below.
- The entire project-ring JSX block (`<rect>` boxes, project label overlays)
  and the assignment-link `<line>` block are removed.
- Adds an explicit empty-state message (e.g. "no agents currently running,"
  matching every other real-data view's copy) shown when `layout.agentNodes.length === 0` — today this view has no empty state at all, just a bare hub with no spokes.
- The stat line changes from `"{agentCount} AGENTS · {linkCount} LINKS"` (where
  `linkCount` included both feed and assignment links) to the same format
  computed from `RealGridLayout`'s `linkCount` (now feed links only, since
  assignment links no longer exist).

### `GridView.tsx`: wiring + a real fix, not just a swap

```tsx
<OrchestrationGrid
  agents={state.realAgents}
  rate={state.rate}
  onSelectRealAgent={(toolUseId) => {
    dispatch({ type: 'SELECT_REAL_AGENT', toolUseId });
    dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Agents' });
  }}
/>
```

This is worth calling out explicitly: today, clicking an agent node dispatches
the fictional `SELECT_AGENT` and navigates to the Agents tab — which, since
slice 2 shipped, now reads only real dispatch data and ignores that dispatch
entirely. This click path has been silently broken (selecting a name the
Agents view no longer looks at) since slice 2 shipped, though nobody has
necessarily noticed. Making Grid's nodes real dispatches themselves means this
gets fixed as a side effect of the migration, not left broken or patched
around: clicking a node now dispatches `SELECT_REAL_AGENT` with that exact
dispatch's `toolUseId`, so it correctly lands on and displays that dispatch in
the real-data Agents view.

`onOpenProjects`/the `projects` prop are removed from this wiring entirely —
there are no project boxes left to click.

## Dead code

Confirmed via grep that `computeAgentNodes`, `computeProjectNodes`,
`computeFeedLinks`, `computeAssignmentLinks`, `computeFeedStrokeWidth`, the
internal `circularMeanAngle`/`clampBoxCenter` helpers, and the `AgentNode`/
`ProjectNode`/`AssignmentLink`/`GridLayout` types have no consumers anywhere
in `src/` outside `gridMath.ts` itself, `OrchestrationGrid.tsx`, and
`gridMath.test.ts` — once `OrchestrationGrid.tsx` stops using them, they
become genuinely dead. Following the exact sequencing discipline established
in slice 2: these are removed only as the last step, after `OrchestrationGrid.tsx`/`GridView.tsx` have already been rewritten and confirmed to compile clean without them — never removed first, which would break the build for components still depending on them mid-migration.

## Error handling / edge cases

- **Zero real dispatches**: `computeRealAgentNodes([])` returns `[]`,
  `computeRealFeedLinks([], now)` returns `[]`; the hub still renders alone,
  plus the new explicit empty-state message.
- **A dispatch completes while its node is mid-render/ticking**: handled
  identically to every other real-data view — the next `state.realAgents`
  snapshot simply no longer includes it, and React's keyed `.map()` (keyed on
  `toolUseId`, not array index) removes its node/link cleanly on the next
  render. No special-case cleanup needed.
- **Elapsed time exceeding the 10-minute scale**: `computeFeedStrokeWidthByElapsed` clamps to the maximum stroke width beyond 10 minutes, exactly mirroring how `computeFeedStrokeWidth`'s existing `Math.max(0, Math.min(1, share))` clamp already handles out-of-range input defensively.

## Testing

**Unit tests** (`gridMath.test.ts`, extended): `computeRealAgentNodes` gets
the same ring-placement assertions the existing `computeAgentNodes` tests
already cover (angle/position math is identical, just a different input
type) using `RealAgentDispatch` fixtures. `computeFeedStrokeWidthByElapsed`
gets tests at 0ms (minimum), 10 minutes exactly (maximum), beyond 10 minutes
(still maximum, clamped), and a mid-point (linear interpolation). `computeRealGridLayout` gets a test confirming the returned shape has no `projectNodes`/`assignmentLinks` fields and that `linkCount` matches `feedLinks.length` exactly (no assignment-link inflation, unlike the old `computeGridLayout`). The existing `computeAgentNodes`/`computeProjectNodes`/`computeFeedLinks`/`computeAssignmentLinks`/`computeFeedStrokeWidth` tests are removed in the same task that removes the functions themselves, once genuinely dead.

**No new tests for `OrchestrationGrid.tsx`/`GridView.tsx`** — matching this
project's established convention of manual GUI verification for
presentational components.

**Manual verification (plan-exit):**
1. With `state.realAgents` empty (default/plain-browser): confirm the hub
   renders alone with the new empty-state message, no project ring, no
   assignment links.
2. With a real dispatch active: confirm a node appears in the ring showing
   the correct subagent-type avatar/label, a feed link from the hub whose
   thickness increases as the dispatch's elapsed time grows (spot-check
   against `computeFeedStrokeWidthByElapsed`'s expected values at a few
   elapsed durations, not just eyeballing).
3. Click a node and confirm it navigates to the Agents tab AND that tab
   correctly shows that exact dispatch selected in its detail card — the
   real fix described above, not just "navigation happens."
4. Confirm Analytics, Files, Memory, and Chat show zero regression — all
   four still reference the fictional `state.agents` roster exactly as
   before.
5. Confirm the Projects view and Dashboard's Projects digest are unaffected
   — both still read the fully fictional `state.projects`, with no dependency
   on anything Grid does.
