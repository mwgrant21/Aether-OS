# App-wide project scope switch — design

**Status:** approved for planning
**Date:** 2026-08-10
**Companion:** `docs/superpowers/specs/2026-08-07-real-projects-view-design.md` (Stage 16) — this is
that stage's own "Option A" follow-on, named and deliberately deferred there (see its §"Out of
scope").

## What this is

Selecting a project row in the Projects view scopes the **Ledger** and **Optimize** views to that
project's data instead of the whole machine's. A TopBar indicator shows the active scope from any
tab and clears it back to "all projects."

Stage 16 built the roster and per-project cost math but explicitly did not wire it to any other
view: *"Option A, the app-wide scope switch — making Ledger/Optimize/Analytics/Comms filter to the
selected project. Intended follow-on; deliberately not built before we know which per-project
numbers get looked at."* This is that follow-on, narrowed by what the data actually supports — see
below.

## Scope, narrowed from the roadmap's own wording

The roadmap and Stage 16 both named four views: Ledger, Optimize, Analytics, Comms. Only two of
those are buildable without a materially larger change:

- **Ledger** and **Optimize** are both derived from the same cross-project scan `main.ts` already
  runs every tick (`scanAllProjects` → `TranscriptEvent[]`) — the identical event stream Stage 16
  groups by project for the roster. Both are natural fits.
- **Analytics**' dispatch-based cards (`TokenBurnCard`, `AgentBreakdownCard`) read `realAgents` /
  `recentCompletedDispatches`, which track **only Aether's own live terminal pty session** — not
  any arbitrary project's transcripts. Its other cards (`TopCommandsCard` from `cmdHist`,
  `SystemMetricsCard` from `sys`) have no project attribution at all: terminal input history and
  OS-level readings aren't tied to a `cwd`.
- **Comms** is built around Aether's own session transcript and per-dispatch retrospective channels
  (`SESSION_TRANSCRIPT_SENTINEL`) — also inherently single-session, not cross-project.

**This stage covers Ledger and Optimize only.** Analytics and Comms are unaffected by the scope
switch — no UI change, no filtering, nothing silently ignored, because there is no project field in
their underlying data to filter on. Making them project-aware would mean giving Aether's live
dispatch tracking and its own session transcript a project dimension they don't have today — a
materially bigger change than a filter switch, and out of scope here.

A related idea raised alongside this one — showing/selecting which project the independent Codex
terminal (Stage 18) is working in — is a different mechanism entirely (the pty's live working
directory, not the transcript scan) and is deferred to its own future design, not folded in here.

## Data flow

`buildProjectsSnapshot` (electron, called once per scan tick, alongside the global Optimize/Ledger
computation `main.ts` already does) groups every scan's events by resolved project and computes a
`LedgerSnapshot` per node via the existing `buildLedgerSnapshot`. This adds one more field,
computed from the exact same per-group event array:

```ts
interface ProjectNode {
  key: string;
  name: string;
  worktree: string | null;
  ledger: LedgerSnapshot;
  // NEW — computed the same way, from the same per-group events, as the
  // existing global Optimize view's three calls in main.ts.
  optimize: {
    findings: (OptimizeFinding & { recurring?: true; appliedAtMs?: number })[];
    summary: OptimizeSummary;
    breakdown: GradeRow[];
  };
}
```

Computed per group as:

```ts
const findings = evaluateOptimizeRulesWithRecurrence(groupEvents, WEEK_MS, appliedState);
const summary = summarizeOptimize(findings);
const cacheHitRate = computeCacheHitRate(groupEvents);
const breakdown = gradeBreakdown({ findings, cacheHitRate });
```

— identical to the three calls `main.ts` already makes for the *global* Optimize view (`optimize:findings`/
`optimize:summary`/`optimize:breakdown`), re-run per project group instead of once over every event.

`appliedState` (which findings the operator has already actioned, loaded via `loadOptimizeState`)
stays global/shared across projects, not per-project. Applying guidance is a user action against a
CLAUDE.md file (global or the most-recently-active project's, via the existing unrelated
`optimize:apply` target picker — see Terminology below); whether a finding shows as already-applied
is orthogonal to which project's view you happen to be looking at.

**No new IPC channel.** `projects:snapshot` already carries every `ProjectNode`; it now carries a
larger payload per node. No change to when or how often it's pushed.

## State & UI

- **No new state field.** `state.selectedProject` — already exists, already persisted, already
  falls back to no-selection when its key is absent from the current snapshot (Stage 16) — *is* the
  scope. One selection, one meaning, everywhere it's read.
- **`LedgerView`**: when `selectedProject` resolves to a node in `state.projectsSnapshot` (checked
  against both `roots` and each root's `children`), render that node's `.ledger` instead of the
  global `state.ledger` for `SessionCostCard`/`RollupCard`/`CacheImpactCard`. Falls back to the
  global view when `selectedProject` is `null` or its key isn't found in the current snapshot
  (deleted project since selection — the same edge case Stage 16 already handles for its own detail
  panel).
  **`DispatchCostTable` and the reconciliation strip are suppressed while scoped**, not
  re-filtered. Both are built from `state.recentCompletedDispatches` / `state.dispatchUsage` /
  `state.diagnostics` — Aether's-own-live-terminal-session dispatch tracking, with no
  `cwd`/project field anywhere in that data (same limitation as Analytics, found while writing the
  implementation plan and confirmed against `liveAgentsMath.ts`'s `RealAgentDispatch`/
  `CompletedDispatchUsage` shapes). Left unscoped, the reconciliation strip would compare a
  correctly-scoped `ledger.rollups.today` against Aether's-own-session `todaysEstimates` — an
  actively misleading residual, not just an irrelevant one. A short note explains the suppression
  in place of the table. The global (no-scope) view is unchanged — both render as they do today.
- **`OptimizeView`**: same lookup, rendering the resolved node's `.optimize.findings` /
  `.optimize.summary` / `.optimize.breakdown` instead of `state.optimizeFindings` /
  `state.optimizeSummary` / `state.optimizeBreakdown`. Same fallback rule.
- **`unscoped`** (work outside any git repository) is not selectable today — `ProjectRosterCard`
  renders it with no `onClick`/`onSelect` handler — and this feature does not add one. Scope can
  only ever resolve to a root or a child (worktree/checkout) key, matching what's already clickable.
- **TopBar**: a small pill rendered whenever `selectedProject` resolves to a snapshot node —
  `Scoped: <name> ×` — clickable to clear (dispatches the same deselect action Projects' own
  deselect uses). The display name comes from the resolved node's `.name`, already in
  `state.projectsSnapshot`; no new data plumbing.
- **Entry point stays Projects-view-only.** Clicking a project row there is the only way to set
  scope; Ledger and Optimize don't grow their own pickers. (Considered and deferred — see Stage
  16's own "why not build the picker everywhere yet" reasoning; same logic applies here: don't
  build a second selection surface before the first one shows its numbers get looked at.)

## Terminology note — read before touching `optimize:apply`

`electron/main.ts`'s existing `optimize:apply` IPC handler takes a `target: 'global' | 'project'`
that is **unrelated to this feature**. It decides *where a CLAUDE.md guidance edit gets written*:
`'global'` is `~/.claude/CLAUDE.md`; `'project'` is inferred as whichever `cwd` belongs to the
single most-recently-timestamped event in the whole scan (`optimizeProjectTargetPath`), independent
of any project selection anywhere in the UI. This feature does not read, write, or otherwise touch
that mechanism. The two concepts share the word "project" and nothing else — flagged here so a
future reader doesn't conflate "scoped to project X's view" with "write CLAUDE.md guidance to
project X."

## Testing

Per project convention: pure logic exhaustively, rendering by component test, visual judgement
manual.

- **`buildProjectsSnapshot` / `projectsMath.ts`**: extends the existing sum-invariant test suite
  with the new `optimize` field — a project group with a real rule violation shows the matching
  finding on its node; a group with none has an empty `findings` array and a summary reflecting
  zero findings, not an absent field.
- **View-level scope resolution** (wherever the root/child lookup lives — likely a small pure
  selector shared by `LedgerView` and `OptimizeView`): unit tests for all three cases —
  `selectedProject` null (global), resolves to a root, resolves to a child, and the stale-key
  fallback (selected key no longer present in the current snapshot).
- **Component tests**: `LedgerView`/`OptimizeView` render the scoped node's numbers when a valid
  scope is active, and the global numbers otherwise. `LedgerView` additionally: `DispatchCostTable`
  and the reconciliation strip are absent while scoped and present when unscoped. TopBar pill
  renders/hides correctly and its clear action dispatches the deselect.
- **Visual judgement manual**, per this project's established practice — the TopBar pill's live
  rendering has not been seen in a running window.

## Known limitations, named plainly

1. **Per-tick cost grows**: Optimize findings are now computed once per project node, every scan
   tick, in addition to the existing global computation — the same order of magnitude of added work
   Stage 16 already introduced for the Ledger without a stated performance concern. Not mitigated
   further here; revisit if the roster grows large enough to matter.
2. **`appliedState` is global, not per-project.** A finding applied via one project's CLAUDE.md
   still shows as "already applied" when viewing a different project's scoped Optimize findings, if
   that project's own events happen to trip the same rule ID. This mirrors how `appliedState` already
   behaves for the global view — not a new inconsistency, just one that now surfaces per-project too.
3. **Deleted-project scope silently falls back to global**, not an explicit "this project no longer
   exists" message — same convention Stage 16 already established for its own detail panel.
4. **`LedgerView`'s dispatch-level detail (`DispatchCostTable`, the reconciliation strip) is
   unavailable while scoped**, for the same reason Analytics is entirely out of scope: it comes
   from Aether's-own-live-session dispatch tracking, which carries no project attribution. Only the
   snapshot-derived cards (`SessionCostCard`/`RollupCard`/`CacheImpactCard`) are genuinely scoped.

## Out of scope

- Analytics, Comms — no project attribution in their underlying data; see "Scope, narrowed" above.
- Codex-terminal project show/select — different mechanism (pty live cwd, not the transcript scan);
  deferred to its own future design.
- Pickers in Ledger/Optimize themselves — Projects view stays the only entry point.
- Any change to `optimize:apply`'s existing `'global' | 'project'` target picker.
- Making `unscoped` selectable.

## Next step

Hand off to `writing-plans`, saved to a plan doc under `docs/superpowers/plans/`.
