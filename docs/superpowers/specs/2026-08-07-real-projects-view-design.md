# Real Projects View (Stage 16) — design

**Status:** approved for planning
**Date:** 2026-08-07

## What this is

Replaces the Projects view's fictional roster with real projects derived from
this machine's Claude Code transcripts, and makes each project's **cost** the
thing a click answers.

`state.projects` is the last major fictional data source in the app.
`initialState.ts` hardcodes four stubs — CLI Companion, Mobile Beta, Analytics
Pipeline, Docs Portal — with invented `pct` and `crew`, mutated by a
`NEW_PROJECT` action that pulls the next name from a pool. Every other Phase 3
surface was migrated or honestly resolved; Projects was not.

This stage is **Projects-view-only**. An app-wide project scope switch (every
view filtering to the selected project) is the intended follow-on and is
explicitly out of scope here — see §10.

## The data reality (read this before scoping anything)

The directory layout does **not** match the mental model of "my projects", and
building the roster from directories would produce a misleading view.

`~/.claude/projects/` on this machine holds 9 directories:

| directory | files | last active | note |
|---|---:|---|---|
| `C--Users-IT` | 181 | 2026-08-07 | the **home directory**, 150 MB |
| `C--Users-IT--claude` | 216 | 2026-07-24 | the `~/.claude` config dir, 50 MB |
| `C--Users-IT-Desktop-Aether-OS--claude-worktrees-statusline-feed` | 42 | 2026-07-28 | a **worktree** |
| `C--Users-IT-Desktop-NMMToolkit` | 5 | 2026-07-06 | |
| `C--Users-IT-Desktop-Aether-OS--claude-worktrees-aether-packages-core-task4` | 4 | 2026-08-04 | a **worktree**, since deleted from disk |
| `C--Users-IT-claude-token-tracker--claude-worktrees-packages-core-wiring` | 2 | 2026-08-04 | a **worktree** |
| `C--Users-IT-Desktop-Aether-OS` | 2 | 2026-07-29 | the real repo, 0.2 MB |
| `Queries` | 0 | never | empty |
| `uigen` | 0 | never | empty |

Read as a roster that is: two empty rows, three worktrees masquerading as
peers of their own parent, a 150 MB row for the home directory, Aether-OS as a
rounding error, and **no TokenMonitorV2 and no Miriels at all** — despite
substantial work on both.

**The directory records where a session *started*. `TranscriptEvent.cwd`
records where the work actually *happened*, and it changes mid-session.**
Sampling the five most recent transcripts inside `C--Users-IT`:

```
8043fe64 → C:\Users\IT | ...\agent-improvement | ...\Desktop\TokenMonitorV2 | ...\Desktop\Aether-OS
178739e4 → C:\Users\IT | ...\agent-improvement | ...\Desktop\TokenMonitorV2 | ...\TokenMonitorV2\src\renderer
ba285a2c → C:\Users\IT | ...\Desktop\TokenMonitorV2 | ...\agent-improvement\loops\daily-triage
8853aefd → C:\Users\IT | ...\Desktop\EFIPartitionRemediation
cf692ade → C:\Users\IT | ...\agent-improvement | ...\it-claude-marketplace
```

Every project named in the original request appears here. **Per-event `cwd` is
the signal; the transcript directory is not.** This also makes per-project cost
genuinely meaningful rather than approximate: a session that touched three
projects is split three ways instead of being attributed wholly to whichever
folder Claude happened to be launched from.

## Project identity

A pure resolver, `src/shared/projectIdentity.ts`:

```ts
resolveProject(cwd: string | null, probe: GitProbe): ProjectRef | null

interface ProjectRef { repoKey: string; repoName: string; worktree: string | null }
// True when <path>/.git exists as EITHER a directory (normal repo) or a file
// (a linked worktree's .git is a file containing a gitdir: pointer).
type GitProbe = (path: string) => boolean
```

Resolution order, and the order is load-bearing:

1. **Worktree by path shape.** If the path contains a `/.claude/worktrees/<name>/`
   or `/.worktrees/<name>/` segment, the parent repo is the prefix before that
   segment and the worktree is `<name>`. **Pure string work, no filesystem.**
2. **Nearest ancestor with `.git`.** Walk up from `cwd`; the first directory
   containing a `.git` entry is the repo root, with `worktree: null`. The walk
   terminates at the filesystem root (or drive root on Windows) and probes each
   ancestor at most once.
3. **Otherwise `null`** — the event is bucketed as `unscoped`.

Rule 1 must precede rule 2, and must not consult the filesystem, because
**history references worktrees that no longer exist.** `.claude/worktrees/aether-packages-core-task4`
was removed from this machine on 2026-08-07; a filesystem-only resolver would
silently drop every event from it and Aether-OS's historical cost would quietly
shrink. Deriving worktree identity from the path string keeps deleted
checkouts attributable.

Rule 2's *nearest* qualifier matters for a trap that exists on this machine:
`C:\Users\IT\Desktop\.git` is a stray repository. Because every real project
root (`Aether-OS`, `TokenMonitorV2`, `agent-improvement`,
`it-claude-marketplace`, `EFIPartitionRemediation`) carries its own `.git`,
the innermost match wins and `Desktop/.git` only ever captures loose folders
that are not repositories themselves.

`probe` is injected so the resolver is exhaustively testable without touching
disk. Main supplies a real filesystem probe, memoised per path for the
lifetime of a scan.

**Normalisation, before anything else:** lowercase the drive letter, convert
`\` to `/`, and strip a trailing separator. Without this, `C:\Users\IT\Desktop\Aether-OS`
and `c:/users/it/desktop/aether-os` hash to two different projects.

## Worktree nesting

A worktree is its own node **and** its cost folds into its parent repo
(figures below are illustrative, not measured):

```
▾ Aether-OS                       $184.20      ← includes children
    └ main                        $ 31.05
    └ wt: statusline-feed         $118.60
    └ wt: packages-core-task4     $ 34.55
▸ TokenMonitorV2                  $ 96.40
  unscoped (~)                    $ 44.90
```

**The repo's own checkout is a child node too**, shown as `main` — it is the
node with `worktree: null`. That makes the child list exhaustive and gives a
clean invariant: **a root's children sum exactly to the root's total.** The
alternative — children being worktrees only, with the repo's own work implicit
in the parent — leaves a visible gap between the parent figure and its rows
that a reader has to work out, which is the sort of unexplained arithmetic this
project's cost views specifically avoid.

Children are only rendered when there is **more than one**; a repo that has
never had a worktree shows a single flat row rather than a disclosure control
wrapping one child identical to its parent.

**A root's `ledger` includes its children's cost.** This is the one arithmetic
trap in the feature: summing every node (roots *and* children) double-counts.
Only root totals plus `unscoped` may be summed — see §8.

## Data flow

`main.ts` already produces a `TranscriptEvent[]` each scan tick (`scanAllProjects`,
reused for Optimize and the Ledger). Group those events by resolved project and
call the **existing** `buildLedgerSnapshot` once per group — no new cost math.

New `projects:snapshot` IPC channel, mirroring `fleet` / `diagnostics` /
`ledger`, with a `projects:snapshot:current` pull channel for the same
startup-race reason documented for `ledger` and `statusline`.

```ts
interface ProjectNode {
  key: string;                  // opaque, stable — see Privacy below
  name: string;                 // basename, display only
  worktree: string | null;
  ledger: LedgerSnapshot;
}

interface ProjectRoot extends ProjectNode {
  // Every checkout of this repo, INCLUDING its own (that one has
  // `worktree: null` and displays as "main"). The root's `ledger` above is the
  // sum of these, so children sum exactly to the parent.
  // Rendered only when length > 1.
  children: ProjectNode[];
}

interface ProjectsSnapshot {
  roots: ProjectRoot[];         // sorted by ledger.total.usd descending
  unscoped: LedgerSnapshot | null;   // null when no unattributable events
  computedAtMs: number;
}
```

### Privacy — this changes the shape

`docs/privacy-and-data.md` is binding: *"Paths are the remaining sensitive
surface — store project-relative, display basenames only."* `ProjectsSnapshot`
crosses IPC and lands in the renderer store, so:

- **`key` is a truncated hash of the normalised path, never the path itself** —
  specified concretely so two implementations cannot disagree: the first 12 hex
  characters of `sha256(normalisedPath)`. A worktree's key hashes its own
  normalised path, so it is distinct from its parent's.
- **`name` is the basename**, and `worktree` is the worktree's own name.
- **No absolute path crosses IPC.** The resolver runs in main; only derived
  identity leaves it.

## Components

| file | change |
|---|---|
| `src/shared/projectIdentity.ts` | **new** — resolver above, pure, injected probe |
| `src/components/projects/projectsMath.ts` | **rewritten** — grouping, nesting, cost-desc sort, unscoped bucket |
| `src/components/projects/ProjectRosterCard.tsx` | **rewritten** — two-level rows, expand/collapse |
| `src/components/projects/ProjectDetailCard.tsx` | **rewritten** — composes the Stage 15 cards for one project |
| `src/components/projects/ProjectsView.tsx` | wiring only |
| `src/state/useProjectsSync.ts` | **new** — mirrors `useLedgerSync`, including the mount-time pull |

The detail panel is mostly composition. The Stage 15 cards are prop-driven and
pure: `SessionCostCard` takes `{ total, tiers }`, `RollupCard` takes
`{ rollups }`, `CacheImpactCard` takes `{ cache, hitRatio }`. A project's
`LedgerSnapshot` satisfies all three, so the per-project detail is assembly
rather than new UI.

### Deletions

- `ProjectStub` and the four hardcoded stubs
- the `NEW_PROJECT` action, its reducer case, the name pool and hue cycling
- `pct`, `crew`, `status` — no real equivalent exists and none is invented

`state.projects` becomes derived live data and moves into
`PERSISTENCE_EXCLUSIONS`, for the same reason `ledger` did: a rehydrated value
would render a previous machine-state's costs as current.

`selectedProject` is re-keyed on `repoKey`. It **stays persisted** — a hash of a
path is stable across sessions, unlike `selectedRealAgent`'s `toolUseId` — but
the view must fall back to no-selection when the key is absent from the current
snapshot, so a deleted project cannot strand the panel.

## Testing

Per project convention: pure logic exhaustively, rendering by component test,
visual judgement manual.

**`projectIdentity.ts`** — the probe is injected, so every hard case is
testable without disk:

- `/.claude/worktrees/<name>/` and `/.worktrees/<name>/` paths
- a worktree path whose directory **no longer exists** (probe returns false throughout)
- the `Desktop/.git` trap: a real repo nested under a stray parent repo resolves to the inner one
- a subdirectory rolling up (`TokenMonitorV2/src/renderer` → `TokenMonitorV2`)
- bare `C:\Users\IT` → `null` (unscoped)
- `null` cwd → `null`
- case and separator normalisation: `C:\...\Aether-OS` and `c:/.../aether-os` resolve to one key
- nested repositories: innermost wins

**`projectsMath.ts`** — grouping, nesting, cost-descending sort at both levels,
the unscoped bucket, and a project with events but zero cost rendering as `0`
rather than being dropped.

**Two sum invariants, as tests rather than hopes:**

1. Every root's `ledger.total.usd` plus `unscoped` equals the all-transcripts
   Ledger total for the same events. Anything the resolver drops shows up here.
   The test must sum **roots only** — including children double-counts, because
   a root's total already contains them.
2. Each root's children sum exactly to that root's total. This is what makes
   the expanded rows add up on screen.

**Component tests** — nested rendering, expand/collapse, cost-desc order, and
that the `unscoped` row renders when present.

## Known limitations, named plainly

1. **A deleted repository's history becomes `unscoped`.** Rule 1 rescues deleted
   *worktrees* because their identity is recoverable from the path string; a
   deleted repo has no such marker, so its events fall through to rule 3. A
   persisted resolution cache would fix this and is deliberately not in scope.
2. **`unscoped` will not be small.** Every sampled session includes bare
   `C:\Users\IT` as a cwd, and work done from the home directory genuinely has
   no project context. This is honest rather than a defect, but the row should
   not read as an error state.
3. **A project with no Claude Code activity never appears.** The roster is
   derived from transcripts, not from disk. `Queries` and `uigen` — the two
   empty directories — correctly never render.
4. **Attribution follows `cwd`, not intent.** Editing a TokenMonitorV2 file
   while `cwd` is the home directory attributes that cost to `unscoped`. Using
   the file paths a session touched would be closer to intent, but it is
   inference with its own failure modes and is out of scope.
5. **Cost is exact to the pricing table, and the table's caveats carry over**
   unchanged from Stage 15 — including the `DISPATCH_OUTPUT_SHARE` blend
   assumption and the fact that spend which never passed through a transcript
   is invisible.

## Out of scope

- **Option A, the app-wide scope switch** — making Ledger/Optimize/Analytics/Comms
  filter to the selected project. Intended follow-on; deliberately not built
  before we know which per-project numbers get looked at.
- Activity data in the detail panel (sessions, dispatches, anomalies, live status).
- Creating, editing, renaming, or configuring projects.
- Any path-configuration UI.

## Next step

Hand off to `writing-plans`, saved to
`docs/superpowers/plans/2026-08-07-real-projects-view-stage16.md`.
