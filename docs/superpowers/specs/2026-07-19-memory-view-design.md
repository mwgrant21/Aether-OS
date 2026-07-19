# Memory View — Design

## Context

`Memory` is registered in `viewRegistry.ts` with `component: null`, so it currently renders
the app's generic "not built yet" placeholder. Two existing entry points already route to it:
`ReactorStatusCard`'s "MEMORY SWEEP" button (Dashboard — runs the `sweep` terminal command,
then dispatches `SET_ACTIVE_TAB('Memory')`) and `SystemsCard`'s stats row (Dashboard — reads
`state.memories.length` and the pinned count). Neither needs to change.

`MemoryStub` (`src/state/types.ts`) is minimal today: `{ pinned: boolean; strength: number }` —
no name, content, source, or timestamp. More importantly, nothing in the codebase ever
*creates* one: `initialState.ts` seeds `memories: []`, and the only existing mutation
(`sweep`, in `commands.ts`) only ever removes weak unpinned entries
(`strength <= 30`). This design both gives memories real content and gives them a way to come
into existence in the first place.

A second pre-existing gap found during exploration: `memories` (and, after this design, the
new `selectedMemory`) are missing from `persistence.ts`'s `savePersisted` whitelist entirely —
this exact bug class (a state field left out of the persistence whitelist) has recurred across
nearly every prior view in this repo (Dashboard's `projects`/`providers`/`routeDefault`,
Agents' `selected`, Projects' `selectedProject`) and must be fixed here too, not left implicit.

The Agents/Projects views establish the pattern this design follows: a fixed-width roster card
(list, click-to-select) beside a flexible detail card, both reading from the single
`useReducer` store (`useAetherStore`), with pure selection/derivation logic factored into a
co-located `*Math.ts` module and unit-tested there.

## Goal

Build a real Memory view: a named, readable roster of "engrams" (pinned first, then
strength-descending) with a detail pane for the selected one, a way to manually add a memory,
automatic memory creation from two fleet events that already fire live (agent kill, HIGH-risk
approval resolution), gradual strength decay over time for unpinned memories, and a pin
toggle — closing the loop on the existing `sweep` command and Dashboard stats that already
reference this data.

## Non-goals

- **Project-ship as a trigger.** Project status never transitions live anywhere in the app
  today (`SHIPPED` only ever appears as `initialState.ts` seed data) — adding a live
  ship-detection mechanism to `tick.ts`/project state is out of scope for a Memory view and
  would be scope creep into project lifecycle behavior. Only kill and HIGH-approval-resolution
  are wired as auto-triggers.
- **Editing or deleting an existing memory's content.** The only mutations are: create
  (manual or auto), pin/unpin, and sweep (prune). No rename/edit-content/manual-delete action.
- **Any new visual paradigm.** Reuses the established roster+detail layout from
  Agents/Projects — no timeline view, no graph/network visualization of memory relationships.
- **Changes to `ReactorStatusCard`'s or `SystemsCard`'s existing wiring** — both already point
  at the right data/tab.

## Architecture

New `src/components/memory/` module, mirroring `src/components/projects/` file-for-file.

### `memoryMath.ts` (pure, unit-tested)

- `pickSelectedMemory(memories: MemoryStub[], selected: string | null): MemoryStub | null` —
  mirrors `pickSelectedProject`: returns the match for `selected` (by `id`, compared as a
  string) if found, else `memories[0] ?? null`.
- `groupMemoriesForRoster(memories: MemoryStub[]): { pinned: MemoryStub[]; unpinned: MemoryStub[] }`
  — `pinned` in existing array order (i.e. pin order), `unpinned` sorted by `strength`
  descending. The roster renders `pinned` as a section above `unpinned`; the `pinned` section
  is simply omitted when empty (same "omit empty section" convention as
  `groupProjectsByStatus`).
- `STRENGTH_TIER_COLOR(strength: number): string` — three tiers (e.g. healthy / fading / at the
  `sweep` threshold), the same visual color-formula pattern as Projects' `STATUS_COLOR`, so the
  roster's strength bars and the detail pane's strength bar can't drift apart.

### `MemoryRosterCard.tsx`

Left column, fixed width (300px, matching `ProjectRosterCard`/`AgentRosterCard`). Renders
`groupMemoriesForRoster`'s two sections (PINNED header + rows, then the rest), each row
showing `name`, a `source` badge, and a strength bar colored via `STRENGTH_TIER_COLOR`. Rows
are clickable (`dispatch({ type: 'SELECT_MEMORY', id: m.id })`), highlighted when they match
`selectedMemory`. No "+ add" header control — unlike `NEW_PROJECT`/`spawn` (which need no user
text and so can be one-click buttons), `remember` exists specifically to capture arbitrary
free text, which nothing in this app currently collects outside the terminal (no
`window.prompt` or modal-input pattern exists anywhere in the codebase today, and introducing
one here would be exactly the "new visual paradigm" this design's Non-goals rule out). Manual
memory creation is terminal-only: `remember <text>`, discoverable via `help`, matching how
`theme`/`renderer` are also terminal-only, free-text-argument commands with no roster/dashboard
button equivalent. Empty state: "no memories logged yet" when `state.memories` is empty.

### `MemoryDetailCard.tsx`

Right column, flexes to fill remaining width (matching `ProjectDetailCard`). For the resolved
memory (via `pickSelectedMemory`): `name` as heading, `source` badge, `ts`, full `content`
text, a strength bar (via `STRENGTH_TIER_COLOR`), and a pin/unpin toggle button dispatching
`{ type: 'TOGGLE_MEMORY_PIN'; id }`. Empty state ("no memory selected") shown only when
`state.memories` is empty, matching the other detail cards' convention.

### `MemoryView.tsx`

Thin composition root: renders `MemoryRosterCard` and `MemoryDetailCard` side by side in a flex
row, same structure as `ProjectsView.tsx`/`AgentsView.tsx`. Registered in `viewRegistry.ts` as
`Memory`'s `component`, replacing `null`.

### `memoryMath.test.ts`

Unit tests for the pure functions in `memoryMath.ts` (see Testing below).

## State changes

- `MemoryStub` (`src/state/types.ts`) gains four fields: `id: number`, `name: string`,
  `content: string`, `source: string`, `ts: string`. `pinned`/`strength` are unchanged.
- `AetherState` gains `selectedMemory: string | null` (a new, separate field from
  `selected`/`selectedProject` — same reasoning as those two: sharing a selection field across
  views would let selecting in one view silently clobber another) and `memSeq: number`
  (monotonic id counter, exactly mirroring `apprSeq`). `initialState.ts` sets
  `selectedMemory: null` and `memSeq` to one past the highest seeded memory id.
- New reducer actions:
  - `{ type: 'SELECT_MEMORY'; id: number }` → `{ ...state, selectedMemory: String(action.id) }`.
  - `{ type: 'TOGGLE_MEMORY_PIN'; id: number }` → toggles `pinned` on the matching memory.
- New terminal command `remember <text>` in `commands.ts` (alongside `spawn`/`sweep`, and added
  to the `help` listing): creates
  `{ id: state.memSeq, name: <text, truncated to ~40 chars>, content: <text>, source: 'operator', ts: nowShort(), pinned: false, strength: 100 }`,
  patches `memories: [...state.memories, memory]` and `memSeq: state.memSeq + 1`.
- **Kill auto-trigger**: `commands.ts`'s `case 'kill'` (the single call site for both the typed
  terminal command and the Agents view's TERMINATE button, since both route through
  `RUN_COMMAND`) additionally appends a memory
  (`name: "{agent} decommissioned"`, `source: agent name`, `strength: 100`) and bumps `memSeq`.
- **HIGH-approval auto-trigger**: this has two independent call sites today and both need the
  same one-line addition —
  - `applyApprovalResolution` in `reducer.ts` (used by `RESOLVE_APPROVAL` and chat's
    `autoResolve` path): when `ok && req.risk === 'HIGH'`, append a memory
    (`name: "{approve|deny}d: {req.action}"`, `source: req.agent`, `strength: 100`).
  - `commands.ts`'s own separate `approve`/`deny` case (typed `approve <n>`/`deny <n>` in the
    terminal — this does not call `applyApprovalResolution`, it has its own patch): identical
    condition and memory shape.
- **Decay**: `computeTick` (`tick.ts`) maps `state.memories`, reducing each *unpinned* memory's
  `strength` by a small fixed amount per tick (e.g. `Math.max(0, m.strength - 0.4)`), pinned
  memories passed through unchanged. Returned as part of the existing `Partial<AetherState>`
  tick patch.
- **Sweep**: unchanged — already implemented in `commands.ts`, prunes unpinned memories with
  `strength <= 30`.

## Data flow

Existing entry points (`ReactorStatusCard`'s "MEMORY SWEEP", `SystemsCard`'s stats) are
unchanged. Within the new view: click a roster row → `SELECT_MEMORY` → `pickSelectedMemory`
resolves which memory the detail pane shows. Type `remember <text>` in the Terminal → new
memory appended, becomes visible in the roster (sorted by strength, so a fresh
`strength: 100` memory sorts near the top of the unpinned section). Pin toggle in the detail
pane → `TOGGLE_MEMORY_PIN` → memory moves to the PINNED section on next render and stops
decaying.

## Persistence

Add `memories: state.memories` and `selectedMemory: state.selectedMemory` to the
`savePersisted` whitelist in `src/state/persistence.ts`. As noted in Context, `memories` is
missing from this whitelist *today*, independent of this design — call this out as an explicit
implementation-plan step (bug fix), not bundled invisibly into the new-field addition.

## Error handling / edge cases

- **Zero memories:** roster and detail pane both show their empty states. No crash, no
  `undefined` access — `pickSelectedMemory` returns `null` and both components branch on that,
  matching every other view's zero-item handling.
- **`selectedMemory` pointing at an id that no longer exists** (the memory was swept away while
  selected): `pickSelectedMemory`'s fallback to `memories[0] ?? null` makes this a non-issue —
  same defensive shape as `pickSelectedProject`/`pickSelectedAgent`.
- **Sweep removing the selected memory:** falls out naturally from the fallback above; no
  special-case code needed.
- **`remember` with empty/whitespace-only text:** the command should no-op with an error line
  (`✗ usage: remember <text>`), matching `kill`/`theme`/`renderer`'s existing usage-error
  pattern, rather than creating a blank memory.
- **Decay driving a pinned-then-unpinned memory below the sweep threshold immediately:**
  expected and correct — unpinning a weak memory means it's eligible for the next sweep, same
  as any naturally-decayed memory.

## Testing

**Unit (`memoryMath.test.ts`):**
- `groupMemoriesForRoster`: pinned section in pin order, unpinned section sorted by strength
  descending, empty pinned section omitted (returned as `[]`, roster hides it), empty input →
  both empty.
- `pickSelectedMemory`: returns the matching memory when `selected` is set and found; falls
  back to `memories[0]` when `selected` is `null` or not found; returns `null` for an empty
  list.
- `STRENGTH_TIER_COLOR`: correct tier boundary behavior, including right at the `sweep`
  threshold (30).

**Manual GUI QA (plan-exit, per this project's convention):**
1. Roster renders seed memories, pinned section above unpinned, unpinned sorted by strength.
2. Clicking a roster row selects it; detail pane updates with full content/source/timestamp.
3. Terminal `remember <text>` creates a new memory; it appears in the roster.
4. Pin toggle moves a memory into the PINNED section and its strength bar stops decreasing
   across subsequent ticks.
5. Kill an agent (via Terminal `kill <name>` or Agents view TERMINATE) — a new memory appears
   referencing that agent.
6. Resolve a HIGH-risk approval (via the bell, an Agents card, or terminal `approve`/`deny`) —
   a new memory appears referencing that approval, for all three resolution paths.
7. Let a few ticks pass — an unpinned memory's strength visibly decreases; a pinned one does
   not.
8. Run `sweep` (Terminal command or Dashboard's "MEMORY SWEEP" button) — memories at/below
   strength 30 and not pinned are removed; pinned ones survive regardless of strength.
9. Zero-memories edge case shows both empty states without error.
10. Reload the app — memories, their current strengths, and `selectedMemory` all persist
    (regression check on the persistence-whitelist fix).
