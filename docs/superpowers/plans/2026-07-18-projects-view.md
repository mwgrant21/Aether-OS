# Projects View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `Projects` tab's `null` placeholder with a real Projects view — a status-grouped roster + detail screen for `state.projects`, matching the shape and conventions the Agents view already established.

**Architecture:** A master-detail layout, same shape as the Agents view: `ProjectRosterCard` (left, fixed width) lists every project grouped by status; `ProjectDetailCard` (right, flex) renders full detail for whichever project is selected. `ProjectsView.tsx` composes the two, using a new pure module (`projectsMath.ts`) for selection fallback, status grouping, the live-progress formula, and the status color map — the latter two extracted from `ProjectsDigest.tsx`, which currently duplicates them inline, so the digest and this new view can't drift apart. One new reducer action (`SELECT_PROJECT`) and one new state field (`selectedProject`, deliberately separate from the existing agent-only `selected` field) are added. No edit/delete/reassign actions are added — "add project" reuses the existing `NEW_PROJECT` action verbatim, and a crew member's name links to the Agents view via the same two-dispatch pattern `GridView.tsx` already uses for its agent-node clicks.

**Tech Stack:** Same as the existing project — React 18, Vite 5, TypeScript 5 (strict), Vitest. No new dependencies.

## Global Constraints

- Project root: `C:\Users\Matt\projects\aether-os` (already scaffolded; this plan extends it).
- Full design spec: `docs/superpowers/specs/2026-07-18-projects-view-design.md` (commit `2e5a2c6`) — this plan implements it task-by-task; consult it for the "why" behind any decision below.
- **Scope for this plan:** `src/components/projects/` (new: `ProjectsView.tsx`, `ProjectRosterCard.tsx`, `ProjectDetailCard.tsx`, `projectsMath.ts` + test), `src/components/dashboard/ProjectsDigest.tsx` (modified — extraction only, no behavior change), `src/state/types.ts` / `initialState.ts` / `reducer.ts` / `persistence.ts` (modified — one new field, one new action, one new persistence-whitelist entry), `src/viewRegistry.ts` (modified — flip `Projects`'s component from `null`). `OrchestrationGrid.tsx`'s project-box click and `ProjectsDigest`'s "VIEW ALL →" are **unchanged** — both already dispatch `SET_ACTIVE_TAB('Projects')` and now simply land somewhere real.
- **Read-only + spawn-only is IN SCOPE, full CRUD is NOT.** The only mutating action this view offers is adding a project, which reuses `NEW_PROJECT` exactly as-is (same name pool, same `QUEUED`/`pct: 0`/`crew: []` shape). No status-change, crew-reassign, or delete/archive action exists in the app today for projects, and this plan does not add one.
- **`selectedProject` is a new, separate `AetherState` field — not a reuse of `selected`.** `selected` is Agent-only (read by `pickSelectedAgent` in the Agents view). Sharing one field between agent selection and project selection would make selecting a project in one view silently collide with an agent selection made in another.
- **Crew-name click is IN SCOPE**, reusing the exact `SELECT_AGENT` + `SET_ACTIVE_TAB('Agents')` two-dispatch pattern `GridView.tsx` already uses for `onSelectAgent`. No new reducer logic — this is wiring, not a new action.
- **Extracting `STATUS_COLOR` and the live-pct formula out of `ProjectsDigest.tsx` into `projectsMath.ts` is IN SCOPE**, done in Task 2 as a small, directly-related refactor (the new Detail pane needs the identical formula and color map; leaving them duplicated would let the two drift). `ProjectsDigest.tsx`'s rendering, 6-item slice, and "VIEW ALL →" link are otherwise **unchanged** — this is an extraction, not a redesign, and Task 2 includes an explicit regression check that the digest still renders identically.
- **The `selectedProject` persistence-whitelist entry is added proactively in Task 1**, not discovered and patched during final QA. Two prior plans in this repo (Agents view, Nav+Dashboard view) hit exactly this bug class — a new selection-style field left out of `savePersisted`'s whitelist — and this plan calls it out explicitly up front instead of risking a third recurrence.
- Match established visual/style conventions exactly: inline `CSSProperties` consts, `colors`/`fonts` tokens from `src/styles/tokens.ts`, `useAetherStore()`. Small per-file style-helper duplication (e.g. a local `statusBadgeStyle` function) matches this codebase's existing convention (see `ProjectsDigest.tsx`, `AgentRosterCard.tsx`) — there is no shared style-helpers module to import from instead.
- New pure-logic module (`projectsMath.ts`) and the reducer/persistence additions get Vitest coverage. Presentational components (`ProjectRosterCard`, `ProjectDetailCard`, `ProjectsView`) have no new testable logic of their own and are verified via the dev server, matching the precedent set by `AgentRosterCard`/`AgentDetailCard`/`AgentsView`.
- Run `npm test`, `npx tsc -b`, and `npm run build` clean before every commit. Baseline going into this plan: **196 passing tests across 21 files** (confirmed via `npm test` immediately before this plan was written).

---

## File Structure

```
aether-os/
  src/
    components/
      projects/
        ProjectsView.tsx          NEW — 2-column composition, mounted by the view registry
        ProjectRosterCard.tsx     NEW — left rail: status-grouped project list (selectable) + "+ ADD"
        ProjectDetailCard.tsx     NEW — right panel: selected project's full detail, crew links to Agents
        projectsMath.ts           NEW — pure derivation, tested
        projectsMath.test.ts      NEW
      dashboard/
        ProjectsDigest.tsx        MODIFIED — consumes STATUS_COLOR/computeLiveProjectPct from projectsMath.ts instead of local duplicates; no behavior change
    state/
      types.ts                    MODIFIED — AetherState.selectedProject
      initialState.ts             MODIFIED — selectedProject: null
      reducer.ts                  MODIFIED — SELECT_PROJECT action
      reducer.test.ts             MODIFIED — test for SELECT_PROJECT
      persistence.ts              MODIFIED — selectedProject added to savePersisted whitelist
      persistence.test.ts         MODIFIED — round-trip test for selectedProject
    viewRegistry.ts                MODIFIED — flip Projects' component from null to ProjectsView
    viewRegistry.test.ts           MODIFIED — test that Projects now resolves
```

---

### Task 1: State — `selectedProject` field, `SELECT_PROJECT` action, persistence

Adds the one new field and one new action this view needs, plus the persistence-whitelist entry, done together up front per the Global Constraints note above.

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/reducer.ts`
- Modify: `src/state/reducer.test.ts`
- Modify: `src/state/persistence.ts`
- Modify: `src/state/persistence.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AetherState.selectedProject: string | null`; `{ type: 'SELECT_PROJECT'; name: string }` added to the `Action` union — consumed by Task 5's `ProjectsView`.

- [ ] **Step 1: Write the failing tests**

Append to `src/state/reducer.test.ts` (inside the existing `describe('reducer', ...)` block, right after the `'SELECT_AGENT sets selected'` test):

```ts
it('SELECT_PROJECT sets selectedProject', () => {
  const next = reducer(initialState, { type: 'SELECT_PROJECT', name: 'Mobile Beta' });
  expect(next.selectedProject).toBe('Mobile Beta');
});
```

Append to `src/state/persistence.test.ts` (inside the existing `describe('persistence', ...)` block, right after the `'persists the selected agent across reloads'` test):

```ts
it('persists the selected project across reloads', () => {
  savePersisted({ ...initialState, selectedProject: 'Mobile Beta' });
  const loaded = loadPersisted();
  expect(loaded?.selectedProject).toBe('Mobile Beta');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- reducer persistence`
Expected: FAIL — `selectedProject` doesn't exist on `AetherState` yet (`SELECT_PROJECT` isn't a valid `Action`; `initialState.selectedProject` is `undefined`, not `'Mobile Beta'`).

- [ ] **Step 3: Add the field to `AetherState` in `src/state/types.ts`**

Change:

```ts
  selected: string | null;
```

to:

```ts
  selected: string | null;
  selectedProject: string | null;
```

- [ ] **Step 4: Add the default in `src/state/initialState.ts`**

Change:

```ts
  selected: null,
```

to:

```ts
  selected: null,
  selectedProject: null,
```

- [ ] **Step 5: Add the action to the `Action` union in `src/state/reducer.ts`**

Change the union's last member:

```ts
  | { type: 'REACTIVATE_AGENT'; name: string };
```

to:

```ts
  | { type: 'REACTIVATE_AGENT'; name: string }
  | { type: 'SELECT_PROJECT'; name: string };
```

- [ ] **Step 6: Add the `switch` case**

In `src/state/reducer.ts`, right after the existing `case 'SELECT_AGENT':` case:

```ts
    case 'SELECT_AGENT':
      return { ...state, selected: action.name };

    case 'SELECT_PROJECT':
      return { ...state, selectedProject: action.name };
```

- [ ] **Step 7: Add `selectedProject` to the persistence whitelist in `src/state/persistence.ts`**

Change:

```ts
      selected: state.selected,
      chatActionResults: state.chatActionResults,
```

to:

```ts
      selected: state.selected,
      selectedProject: state.selectedProject,
      chatActionResults: state.chatActionResults,
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -- reducer persistence`
Expected: PASS.

- [ ] **Step 9: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (198 total: 196 + 2 new), 0 type errors.

- [ ] **Step 10: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/state/reducer.ts src/state/reducer.test.ts src/state/persistence.ts src/state/persistence.test.ts
git commit -m "feat: add selectedProject state field, SELECT_PROJECT action, and persistence"
```

---

### Task 2: Projects derivation math (`projectsMath.ts`) + extract shared logic from `ProjectsDigest.tsx`

The pure logic this view needs: which project counts as "selected" (falling back sensibly, same shape as `pickSelectedAgent`), grouping projects by status in a fixed display order, and the live-progress formula + status color map — both extracted from `ProjectsDigest.tsx`, which currently defines them inline/locally, so the digest and the new Detail pane share one implementation instead of two that can drift.

**Files:**
- Create: `src/components/projects/projectsMath.ts`
- Test: `src/components/projects/projectsMath.test.ts`
- Modify: `src/components/dashboard/ProjectsDigest.tsx`

**Interfaces:**
- Consumes: `ProjectStatus`, `ProjectStub` from `../../state/types`.
- Produces: `pickSelectedProject(projects: ProjectStub[], selected: string | null): ProjectStub | null`, `groupProjectsByStatus(projects: ProjectStub[]): { status: ProjectStatus; projects: ProjectStub[] }[]`, `computeLiveProjectPct(project: ProjectStub, used: number): number`, `STATUS_COLOR: Record<ProjectStatus, string>` — consumed by Task 3's `ProjectRosterCard`, Task 4's `ProjectDetailCard`, Task 5's `ProjectsView`, and (as of this task) `ProjectsDigest.tsx`.

- [ ] **Step 1: Write the failing tests**

`src/components/projects/projectsMath.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeLiveProjectPct, groupProjectsByStatus, pickSelectedProject } from './projectsMath';
import { initialState } from '../../state/initialState';

describe('pickSelectedProject', () => {
  it('returns the project matching selected when present', () => {
    const project = pickSelectedProject(initialState.projects, 'Mobile Beta');
    expect(project?.name).toBe('Mobile Beta');
  });

  it('falls back to the first project when selected is null', () => {
    const project = pickSelectedProject(initialState.projects, null);
    expect(project?.name).toBe(initialState.projects[0].name);
  });

  it('falls back to the first project when selected does not match any project', () => {
    const project = pickSelectedProject(initialState.projects, 'Nonexistent Project');
    expect(project?.name).toBe(initialState.projects[0].name);
  });

  it('returns null when there are no projects at all', () => {
    expect(pickSelectedProject([], 'Anything')).toBeNull();
  });
});

describe('groupProjectsByStatus', () => {
  it('groups the seed projects into all four statuses, in BUILDING/REVIEW/QUEUED/SHIPPED order', () => {
    const groups = groupProjectsByStatus(initialState.projects);
    expect(groups.map((g) => g.status)).toEqual(['BUILDING', 'REVIEW', 'QUEUED', 'SHIPPED']);
    expect(groups.find((g) => g.status === 'BUILDING')?.projects.map((p) => p.name)).toEqual(['CLI Companion']);
    expect(groups.find((g) => g.status === 'REVIEW')?.projects.map((p) => p.name)).toEqual(['Mobile Beta']);
  });

  it('omits statuses with zero projects, preserving order for the ones that remain', () => {
    const subset = initialState.projects.filter((p) => p.status === 'BUILDING' || p.status === 'SHIPPED');
    const groups = groupProjectsByStatus(subset);
    expect(groups.map((g) => g.status)).toEqual(['BUILDING', 'SHIPPED']);
  });

  it('returns an empty array for an empty input', () => {
    expect(groupProjectsByStatus([])).toEqual([]);
  });
});

describe('computeLiveProjectPct', () => {
  it('returns the unchanged pct for a BUILDING project when used is at the seed baseline', () => {
    const cliCompanion = initialState.projects.find((p) => p.name === 'CLI Companion')!;
    expect(computeLiveProjectPct(cliCompanion, 24391)).toBe(62);
  });

  it('animates a BUILDING project pct upward as used climbs, capped at 99', () => {
    const cliCompanion = initialState.projects.find((p) => p.name === 'CLI Companion')!;
    expect(computeLiveProjectPct(cliCompanion, 24391 + 30000)).toBe(63);
    expect(computeLiveProjectPct(cliCompanion, 24391 + 40 * 30000)).toBe(99);
  });

  it('returns the stored pct unchanged for non-BUILDING statuses regardless of used', () => {
    const mobileBeta = initialState.projects.find((p) => p.name === 'Mobile Beta')!;
    expect(computeLiveProjectPct(mobileBeta, 24391 + 40 * 30000)).toBe(mobileBeta.pct);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- projectsMath`
Expected: FAIL — `projectsMath.ts` doesn't exist yet.

- [ ] **Step 3: Implement `src/components/projects/projectsMath.ts`**

```ts
import type { ProjectStatus, ProjectStub } from '../../state/types';

export const STATUS_COLOR: Record<ProjectStatus, string> = {
  BUILDING: '#7ef0ff',
  REVIEW: '#f5c66b',
  QUEUED: '#5f8a97',
  SHIPPED: '#3be0a0',
};

const STATUS_ORDER: ProjectStatus[] = ['BUILDING', 'REVIEW', 'QUEUED', 'SHIPPED'];

export function pickSelectedProject(projects: ProjectStub[], selected: string | null): ProjectStub | null {
  if (selected) {
    const match = projects.find((p) => p.name === selected);
    if (match) return match;
  }
  return projects[0] ?? null;
}

export function groupProjectsByStatus(projects: ProjectStub[]): { status: ProjectStatus; projects: ProjectStub[] }[] {
  return STATUS_ORDER.map((status) => ({ status, projects: projects.filter((p) => p.status === status) })).filter(
    (group) => group.projects.length > 0,
  );
}

export function computeLiveProjectPct(project: ProjectStub, used: number): number {
  return project.status === 'BUILDING' ? Math.min(99, Math.round(project.pct + (used - 24391) / 30000)) : project.pct;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- projectsMath`
Expected: PASS, 10 tests.

- [ ] **Step 5: Update `src/components/dashboard/ProjectsDigest.tsx` to consume the extracted logic**

Change:

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { ProjectStatus } from '../../state/types';

const STATUS_COLOR: Record<ProjectStatus, string> = {
  BUILDING: '#7ef0ff',
  REVIEW: '#f5c66b',
  QUEUED: '#5f8a97',
  SHIPPED: '#3be0a0',
};

export function ProjectsDigest() {
  const { state, dispatch } = useAetherStore();
  const projects = state.projects.slice(0, 6).map((p) => ({
    ...p,
    pct: p.status === 'BUILDING' ? Math.min(99, Math.round(p.pct + (state.used - 24391) / 30000)) : p.pct,
  }));
```

to:

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { STATUS_COLOR, computeLiveProjectPct } from '../projects/projectsMath';

export function ProjectsDigest() {
  const { state, dispatch } = useAetherStore();
  const projects = state.projects.slice(0, 6).map((p) => ({
    ...p,
    pct: computeLiveProjectPct(p, state.used),
  }));
```

The rest of `ProjectsDigest.tsx` (JSX, `cardStyle`/`titleStyle`/`viewAllStyle`/`nameStyle`/`statusBadgeStyle`) is unchanged.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b`
Expected: exits 0. (Confirms the removed `ProjectStatus` import isn't left dangling and the extraction compiles clean.)

- [ ] **Step 7: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (208 total: 198 + 10 new), 0 type errors.

- [ ] **Step 8: Verify the digest regression via dev server**

Run: `npm run dev`. On the Dashboard, confirm the Projects digest card still renders exactly as before — same 4 seed projects, same status badges/colors, same pct values, "VIEW ALL →" still present (still routes to the — still placeholder, until Task 5 — Projects tab).

- [ ] **Step 9: Commit**

```bash
git add src/components/projects/projectsMath.ts src/components/projects/projectsMath.test.ts src/components/dashboard/ProjectsDigest.tsx
git commit -m "feat: add Projects view derivation math; extract STATUS_COLOR/live-pct formula out of ProjectsDigest"
```

---

### Task 3: Project Roster card (status-grouped list + "+ ADD")

Left rail of the Projects view. Projects grouped by status (`groupProjectsByStatus`), each a selectable row (status badge/name/live pct, same visual language `ProjectsDigest` already established), plus a "+ ADD" button reusing the existing `NEW_PROJECT` action.

**Files:**
- Create: `src/components/projects/ProjectRosterCard.tsx`

**Interfaces:**
- Consumes: `useAetherStore()`; `STATUS_COLOR`, `computeLiveProjectPct`, `groupProjectsByStatus` from `./projectsMath`; `colors`, `fonts` from `../../styles/tokens`.
- Produces: `ProjectRosterCard({ selectedName }: { selectedName: string | null })` — mounted by Task 5's `ProjectsView`.

No new unit-testable logic — verify via dev server.

- [ ] **Step 1: Implement `src/components/projects/ProjectRosterCard.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { STATUS_COLOR, computeLiveProjectPct, groupProjectsByStatus } from './projectsMath';

export function ProjectRosterCard({ selectedName }: { selectedName: string | null }) {
  const { state, dispatch } = useAetherStore();
  const groups = groupProjectsByStatus(state.projects);

  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>PROJECTS</div>
        <span onClick={() => dispatch({ type: 'NEW_PROJECT' })} style={addButtonStyle}>
          + ADD
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {groups.map((group) => (
          <div key={group.status}>
            <div style={groupHeaderStyle}>
              {group.status} ({group.projects.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {group.projects.map((p) => {
                const on = p.name === selectedName;
                const pct = computeLiveProjectPct(p, state.used);
                return (
                  <div key={p.name} onClick={() => dispatch({ type: 'SELECT_PROJECT', name: p.name })} style={rowStyle(on)}>
                    <span style={statusBadgeStyle(STATUS_COLOR[p.status])}>{p.status}</span>
                    <span style={nameStyle}>{p.name}</span>
                    <span style={{ flex: 'none', font: `700 11px/1 ${fonts.mono}`, color: p.hue }}>{pct}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {!state.projects.length && <div style={emptyStyle}>no projects yet — add one to get started</div>}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  width: 300,
  flex: 'none',
  padding: 15,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const addButtonStyle: CSSProperties = {
  cursor: 'pointer',
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: 1,
  color: colors.accentCyanSoft,
  padding: '4px 9px',
  borderRadius: 6,
  border: '1px solid rgba(95,220,255,.35)',
};
const groupHeaderStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textDim };
function rowStyle(on: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 9px',
    borderRadius: 9,
    cursor: 'pointer',
    background: on ? 'rgba(23,184,216,.14)' : undefined,
    border: on ? '1px solid rgba(95,220,255,.4)' : '1px solid transparent',
  };
}
const nameStyle: CSSProperties = {
  flex: 1,
  font: `600 13px/1 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
function statusBadgeStyle(c: string): CSSProperties {
  return { flex: 'none', font: `600 8px/1 ${fonts.ui}`, letterSpacing: 1, color: c, border: `1px solid ${c}55`, padding: '4px 7px', borderRadius: 4, width: 56, textAlign: 'center' };
}
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/projects/ProjectRosterCard.tsx
git commit -m "feat: build the Projects view roster card (status-grouped list + add project)"
```

---

### Task 4: Project Detail card

Right panel of the Projects view. Shows the selected project's name/status badge, live progress bar/pct, and a crew list where each name is clickable (jumps to that agent in the Agents view). Renders an honest empty state when there are no projects at all.

**Files:**
- Create: `src/components/projects/ProjectDetailCard.tsx`

**Interfaces:**
- Consumes: `useAetherStore()`; `STATUS_COLOR`, `computeLiveProjectPct` from `./projectsMath`; `colors`, `fonts` from `../../styles/tokens`; `ProjectStub` type from `../../state/types`.
- Produces: `ProjectDetailCard({ project }: { project: ProjectStub | null })` — mounted by Task 5's `ProjectsView`.

No new unit-testable logic (the math it uses is already tested in Task 2) — verify via dev server.

- [ ] **Step 1: Implement `src/components/projects/ProjectDetailCard.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { ProjectStub } from '../../state/types';
import { STATUS_COLOR, computeLiveProjectPct } from './projectsMath';

export function ProjectDetailCard({ project }: { project: ProjectStub | null }) {
  const { state, dispatch } = useAetherStore();

  if (!project) {
    return (
      <div style={cardStyle}>
        <div style={emptyWrapStyle}>
          <div style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textSecondary }}>NO PROJECTS YET</div>
          <div style={{ marginTop: 8, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textMuted }}>
            Add a project from the roster to see it here.
          </div>
        </div>
      </div>
    );
  }

  const pct = computeLiveProjectPct(project, state.used);

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={swatchStyle(project.hue)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: `700 18px/1 ${fonts.ui}`, color: colors.textPrimary }}>{project.name}</div>
        </div>
        <span style={statusBadgeStyle(STATUS_COLOR[project.status])}>{project.status}</span>
      </div>

      <div style={trackStyle}>
        <div style={{ height: '100%', width: `${pct}%`, background: project.hue, boxShadow: `0 0 10px ${project.hue}` }} />
      </div>
      <div style={{ marginTop: 6 }}>
        <span style={{ font: `700 13px/1 ${fonts.mono}`, color: project.hue }}>{pct}% complete</span>
      </div>

      <div style={{ marginTop: 20 }}>
        <div style={sectionLabelStyle}>CREW</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {project.crew.map((name) => (
            <span
              key={name}
              onClick={() => {
                dispatch({ type: 'SELECT_AGENT', name });
                dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Agents' });
              }}
              style={crewRowStyle}
            >
              {name}
            </span>
          ))}
          {!project.crew.length && <div style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>no crew assigned</div>}
        </div>
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  padding: 18,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
};
const emptyWrapStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
};
function swatchStyle(hue: string): CSSProperties {
  return {
    width: 46,
    height: 46,
    flex: 'none',
    borderRadius: 10,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 5px,#123f4e 5px 10px)',
    border: `1px solid ${hue}`,
  };
}
function statusBadgeStyle(c: string): CSSProperties {
  return { flex: 'none', font: `600 8px/1 ${fonts.ui}`, letterSpacing: 1, color: c, border: `1px solid ${c}55`, padding: '4px 7px', borderRadius: 4, width: 56, textAlign: 'center' };
}
const trackStyle: CSSProperties = { height: 6, borderRadius: 3, background: 'rgba(20,50,64,.7)', overflow: 'hidden', marginTop: 18 };
const sectionLabelStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
const crewRowStyle: CSSProperties = {
  cursor: 'pointer',
  font: `600 13px/1 ${fonts.ui}`,
  color: colors.accentCyanSoft,
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid rgba(95,220,255,.2)',
  background: 'rgba(6,20,28,.5)',
  width: 'fit-content',
};
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/projects/ProjectDetailCard.tsx
git commit -m "feat: build the Projects view detail card (progress, crew list linking to Agents)"
```

---

### Task 5: Projects view composition + registry wiring

Composes the roster and detail cards using `pickSelectedProject` to decide which project's detail to show, then flips the `Projects` view-registry entry from `null` to the real component.

**Files:**
- Create: `src/components/projects/ProjectsView.tsx`
- Modify: `src/viewRegistry.ts`
- Modify: `src/viewRegistry.test.ts`

**Interfaces:**
- Consumes: `useAetherStore()`; `pickSelectedProject` from `./projectsMath`; `ProjectRosterCard`, `ProjectDetailCard`.
- Produces: `ProjectsView()` — registered in `viewRegistry.ts`, completing the Projects slice.

- [ ] **Step 1: Implement `src/components/projects/ProjectsView.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { pickSelectedProject } from './projectsMath';
import { ProjectRosterCard } from './ProjectRosterCard';
import { ProjectDetailCard } from './ProjectDetailCard';

export function ProjectsView() {
  const { state } = useAetherStore();
  const selectedProject = pickSelectedProject(state.projects, state.selectedProject);

  return (
    <div style={rootStyle}>
      <ProjectRosterCard selectedName={selectedProject?.name ?? null} />
      <ProjectDetailCard project={selectedProject} />
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
```

- [ ] **Step 2: Wire Projects into the registry**

In `src/viewRegistry.ts`, add the import and flip the entry:

```ts
import { ProjectsView } from './components/projects/ProjectsView';
// ...
{ id: 'Projects', inTopBar: true, inSidebar: true, component: ProjectsView },
```

- [ ] **Step 3: Update `src/viewRegistry.test.ts`**

Add a new test confirming Projects now resolves (after the existing `'getViewComponent resolves Grid now that it is built'` test):

```ts
it('getViewComponent resolves Projects now that it is built', () => {
  expect(getViewComponent('Projects')).not.toBeNull();
});
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (209 total: 208 from Tasks 1–2 + 1 new here), 0 type errors, build succeeds.

- [ ] **Step 5: Verify via dev server**

Run: `npm run dev`. Click the Projects tab (top bar or sidebar): the roster + detail two-column layout renders, the first project (by seed array order) is selected by default, clicking other roster rows swaps the detail panel, projects are grouped under their correct status headers.

- [ ] **Step 6: Commit**

```bash
git add src/components/projects/ProjectsView.tsx src/viewRegistry.ts src/viewRegistry.test.ts
git commit -m "feat: compose the Projects view and wire it into the view registry"
```

---

### Task 6: Final integration QA

**Files:** none (verification-only task).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (209/209), 0 type errors, build succeeds.

- [ ] **Step 2: Manual QA checklist**

Run: `npm run dev`, open the browser.

- [ ] Clicking the top bar's or sidebar's "Projects" entry shows the two-column roster + detail layout; the first project is selected by default with no prior interaction.
- [ ] Roster shows all four seed projects grouped correctly: CLI Companion under BUILDING, Mobile Beta under REVIEW, Analytics Pipeline under QUEUED, Docs Portal under SHIPPED — in that section order.
- [ ] Clicking a different roster row swaps the detail panel to that project (name, status badge, pct, crew all update); the previously-selected row loses its highlight and the new one gains it.
- [ ] In the detail panel, clicking a crew member's name navigates to the Agents view with that agent selected in the Agent Detail panel.
- [ ] Click "+ ADD" in the roster header — a new project appears under the QUEUED group with 0%, and becomes visible without needing to scroll or refresh.
- [ ] Zero-projects edge case: temporarily set `projects: []` in `src/state/initialState.ts` (local, uncommitted edit), reload the dev server, and confirm both the roster's "no projects yet — add one to get started" and the detail panel's "NO PROJECTS YET" render without error. Revert the edit (`git checkout -- src/state/initialState.ts`) before continuing.
- [ ] Dashboard's Projects digest still renders identically to before this plan (same 4 seed projects, same badges/colors/pct animation) — confirms the Task 2 extraction introduced no behavior change.
- [ ] Grid view's project-box click and Dashboard's "VIEW ALL →" both still land on this real Projects view (previously the placeholder).
- [ ] Reload the page — confirm the previously-selected project is still shown in the Projects view detail panel (i.e. `state.selectedProject` survived the reload).
- [ ] Confirm no regressions elsewhere: Terminal, Dashboard, Agents, Grid, Chat, and all remaining placeholder tabs still route and highlight correctly.

- [ ] **Step 3: Address any regression found in Step 2**

If Step 2 surfaces a real regression (not a pre-existing, already-documented quirk), fix it and commit separately with a `fix:` message before considering this plan done. If nothing was found, skip this step.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-18-projects-view.md`. Executed via the same per-task pipeline as prior plans in this repo: a fresh implementer subagent per task, a fresh reviewer subagent (spec compliance + code quality) before commit, then one whole-branch review after all tasks land.

### Critical Files for Implementation
- C:\Users\Matt\projects\aether-os\src\state\reducer.ts
- C:\Users\Matt\projects\aether-os\src\state\types.ts
- C:\Users\Matt\projects\aether-os\src\components\projects\projectsMath.ts
- C:\Users\Matt\projects\aether-os\src\components\projects\ProjectsView.tsx
- C:\Users\Matt\projects\aether-os\src\components\dashboard\ProjectsDigest.tsx
- C:\Users\Matt\projects\aether-os\src\viewRegistry.ts
