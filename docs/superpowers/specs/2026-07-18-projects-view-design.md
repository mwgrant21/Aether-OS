# Projects View — Design

## Context

`Projects` is registered in `viewRegistry.ts` with `component: null`, so it currently
renders the app's generic "not built yet" placeholder. Two existing entry points already
route to it: `ProjectsDigest`'s "VIEW ALL →" (Dashboard) and `OrchestrationGrid`'s
project-box click (Grid), both via `dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Projects' })`.
Neither needs to change — they already point at the right place.

`ProjectStub` (`src/state/types.ts`) is minimal today: `{ name, status, pct, hue, crew: string[] }`.
A `NEW_PROJECT` reducer action already exists (prepends a project with a name pulled from a
pool, status `QUEUED`, `pct: 0`, empty crew). Nothing in the app currently edits or deletes a
project — this design does not add that capability.

The Agents view (`src/components/agents/`) establishes the pattern this design follows:
a fixed-width roster card (list, click-to-select) beside a flexible detail card, both reading
from a single `useReducer` store (`useAetherStore`), with pure selection/derivation logic
factored into a co-located `*Math.ts` module and unit-tested there.

## Goal

Build a real Projects view: a status-grouped roster of projects, a detail pane for the
selected one, a way to add a new project, and a link from a project's crew back into the
Agents view — all read-only beyond adding new projects, matching the fact that nothing else
in the app edits a project today.

## Non-goals

- Editing a project's status, crew, or any other field.
- Deleting or archiving a project.
- Any new visual paradigm (kanban board, drag-and-drop) — this reuses the established
  roster+detail layout from Agents.
- Changes to `ProjectsDigest` or `OrchestrationGrid`'s existing routing into this view.

## Architecture

New `src/components/projects/` module, mirroring `src/components/agents/` file-for-file:

### `projectsMath.ts` (pure, unit-tested)

- `pickSelectedProject(projects: ProjectStub[], selected: string | null): ProjectStub | null`
  — mirrors `pickSelectedAgent`: returns the match for `selected` if found, else
  `projects[0] ?? null`. The detail pane is only truly empty when there are zero projects.
- `groupProjectsByStatus(projects: ProjectStub[]): { status: ProjectStatus; projects: ProjectStub[] }[]`
  — returns groups in fixed order `BUILDING, REVIEW, QUEUED, SHIPPED`, omitting any status
  with zero projects.
- `computeLiveProjectPct(project: ProjectStub, used: number): number` — the animated-progress
  formula currently inlined in `ProjectsDigest.tsx`
  (`p.status === 'BUILDING' ? Math.min(99, Math.round(p.pct + (state.used - 24391) / 30000)) : p.pct`),
  extracted here. `ProjectsDigest` is updated to call this instead of inlining it, so the
  digest and the new detail pane cannot drift apart.
- `STATUS_COLOR: Record<ProjectStatus, string>` — moved here from its current local
  definition in `ProjectsDigest.tsx`; both the digest and the new roster/detail components
  import it from this one place.

### `ProjectRosterCard.tsx`

Left column, fixed width (300px, matching `AgentRosterCard`). Renders `groupProjectsByStatus`
as sectioned lists (status label header + rows), each row clickable
(`dispatch({ type: 'SELECT_PROJECT', name: project.name })`), highlighted when it matches
`selectedProject`. An "+ ADD" control in the header dispatches `{ type: 'NEW_PROJECT' }`,
visually matching Agent roster's "SPAWN +". Empty state: "no projects yet — add one to get
started" when `state.projects` is empty (same tone as Agent roster's empty state).

### `ProjectDetailCard.tsx`

Right column, flexes to fill remaining width (matching `AgentDetailCard`). For the resolved
project (via `pickSelectedProject`): name, status badge, live pct (via
`computeLiveProjectPct`) with a progress bar, and a crew section listing each crew member's
name as a clickable element. Clicking a crew name dispatches two actions in sequence —
`{ type: 'SELECT_AGENT', name }` then `{ type: 'SET_ACTIVE_TAB', tab: 'Agents' }` — identical
to `GridView.tsx`'s existing `onSelectAgent` wiring. Empty state ("no projects yet") shown
only when `state.projects` is empty, matching `AgentDetailCard`'s "NO AGENT SELECTED" empty
state shown only when `state.agents` is empty.

### `ProjectsView.tsx`

Thin composition root: renders `ProjectRosterCard` and `ProjectDetailCard` side by side in a
flex row, same structure as `AgentsView.tsx`. Registered in `viewRegistry.ts` as `Projects`'s
`component`, replacing `null`.

### `projectsMath.test.ts`

Unit tests for the three pure functions in `projectsMath.ts` (see Testing below).

## State changes

- `AetherState` gains `selectedProject: string | null`. This is a **new, separate field**
  from the existing `selected` field (which is Agent-only) — sharing one field between agent
  selection and project selection would make selecting a project in one view silently clear
  or collide with an agent selection made in another. `initialState.ts` sets it to `null`.
- New reducer action: `{ type: 'SELECT_PROJECT'; name: string }`. Reducer case:
  `{ ...state, selectedProject: action.name }`.
- No other new actions. "Add project" reuses the existing `NEW_PROJECT` action verbatim.
  No edit/delete/reassign actions are added (see Non-goals).

## Data flow

Existing entry points (`ProjectsDigest`'s "VIEW ALL →", `OrchestrationGrid`'s project-box
click) are unchanged — they already dispatch `SET_ACTIVE_TAB('Projects')`.

Within the new view: click a roster row → `SELECT_PROJECT` → `pickSelectedProject` resolves
which project the detail pane shows. Click a crew name in the detail pane → `SELECT_AGENT` +
`SET_ACTIVE_TAB('Agents')` → lands on the Agents view with that agent already selected.

## Persistence

Add `selectedProject: state.selectedProject` to the `savePersisted` whitelist in
`src/state/persistence.ts`. This exact bug class (a new selection-style field left out of the
persistence whitelist) has been hit and fixed in two prior plans in this repo (Agents view,
Nav+Dashboard view) — the implementation plan must call this out as an explicit step, not
leave it implicit, so it isn't a third recurrence.

## Error handling / edge cases

- **Zero projects:** roster shows its empty state, detail pane shows its empty state. No
  crash, no `undefined` access — `pickSelectedProject` returns `null` and both components
  branch on that, matching the Agents view's existing handling of the zero-agents case.
- **`selectedProject` pointing at a name that no longer exists:** cannot currently happen
  (nothing deletes or renames a project), but `pickSelectedProject`'s fallback to
  `projects[0] ?? null` makes this a non-issue if it ever does — same defensive shape as
  `pickSelectedAgent`.

## Testing

**Unit (`projectsMath.test.ts`):**
- `groupProjectsByStatus`: correct grouping, fixed status order, empty-status groups omitted,
  empty input → empty output.
- `pickSelectedProject`: returns the matching project when `selected` is set and found; falls
  back to `projects[0]` when `selected` is `null` or not found; returns `null` for an empty
  list.
- `computeLiveProjectPct`: matches the exact formula currently inlined in `ProjectsDigest.tsx`
  for a `BUILDING` project (regression test against the extraction), and returns the stored
  `pct` unchanged for non-`BUILDING` statuses.

**Manual GUI QA (plan-exit, per this project's convention):**
1. Roster renders all seed projects grouped correctly by status.
2. Clicking a roster row selects it; detail pane updates.
3. Crew name click in detail pane lands on that agent, selected, in the Agents view.
4. "+ ADD" creates a new project (via `NEW_PROJECT`); it appears under the QUEUED group.
5. Zero-projects edge case (manually clear `state.projects` or check via a fresh/edge-case
   session) shows both empty states without error.
6. Reload the app — `selectedProject` persists and the same project is still selected.
7. `ProjectsDigest` still renders correctly after the `computeLiveProjectPct`/`STATUS_COLOR`
   extraction (regression check on the refactor).
