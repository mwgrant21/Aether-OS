# Nav Registry + Dashboard View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the app's three hand-maintained, drift-prone nav lists (`TopBar`'s tabs, `Sidebar`'s nav items, `Sidebar`'s clickable set) with a single view registry, then build the Dashboard view — the app's home screen — on top of it, wired for real.

**Architecture:** A new `src/viewRegistry.ts` (outside both `state/` and `components/`, since it imports view components and is imported by both `App.tsx` and the layout components — putting it in `state/` would violate that module's "never imports from components" rule) exports a single `VIEWS` array describing every tab: its id, whether it shows in the top bar's tabs, whether it shows in the sidebar's nav, and which component (if any) renders it. `TopBar`/`Sidebar` derive their lists by filtering this array instead of hand-maintaining separate constants; `App.tsx`'s `ActiveView` looks up the component instead of an `if` chain. Dashboard itself follows the same pattern as the Terminal slice: pure derivation functions (`dashboardMath.ts`, tested) feed presentational components that read `useAetherStore()` directly, ported from the design source's `isDashboard` template block and its `renderVals()` computations.

**Tech Stack:** Same as the existing project — React 18, Vite 5, TypeScript 5 (strict), Vitest. No new dependencies.

## Global Constraints

- Project root: `C:\Users\Matt\projects\aether-os` (already scaffolded; this plan extends it, not a fresh `git init`).
- Source of truth for exact values is `C:\Users\Matt\Documents\design_handoff_aether_os\Aether Agent OS.dc.html` and its `README.md`, same as the prior plan. Colors/spacing/fonts must match the design source verbatim, copied from the extraction in this plan's tasks.
- All 11 nav entries (`Dashboard`, `Terminal`, `Chat`, `Agents`, `Grid`, `Projects`, `Memory`, `Analytics`, `Files`, `Uplinks`, `Settings`) remain clickable — the current app has no non-clickable nav entry, so the registry doesn't need a separate `clickable` flag distinct from "is in the registry."
- **Scope for this plan:** the nav/view registry, plus the Dashboard view's 5 cells (reactor status hero + quick actions, Active Agents digest, Projects digest, Recent Alerts, Systems). Chat/Agents(-full)/Grid/Projects(-full)/Memory/Analytics/Uplinks/Files/Settings remain `ComingSoonPanel` placeholders exactly as before — this plan does not build any of those views' own screens, only Dashboard's *summaries* of some of their data.
- **Three documented, deliberate scope cuts** (do not "fix" these — they're intentional, matching the prior plan's precedent of honest, minimal placeholders over premature scope):
  1. The "◇ COMPOSE MISSION" quick-action button is rendered for visual fidelity but is **inert** (no `onClick`) — the Mission Composer is a modal overlay with its own goal-input/crew-planning logic that belongs to a future plan, not a tab `ComingSoonPanel` can stand in for.
  2. The design source's `runSweep` quick action has a decay-fallback branch (if no weak engrams exist, decay every unpinned engram's strength by 6 instead) and writes to a `memFeed` log that nothing in this plan's scope displays. This plan's "MEMORY SWEEP" button instead reuses the **already-built, already-tested** terminal `sweep` command's exact logic (`dispatch({type:'RUN_COMMAND', raw:'sweep'})`) plus a `SET_ACTIVE_TAB` to `'Memory'` — simpler, faithful in spirit (compacts weak engrams, navigates to Memory), and adds zero new untested logic.
  3. The Systems card's `Uplinks online`/`Default runtime`/`Sound` rows require three new state slices (`providers`, `routeDefault`, `cfg.sound`) that exist ONLY so this card can render truthfully — none of Uplinks/Settings' own screens are built. These are added as minimal typed state with reasonable (not verbatim-extracted — the source's real seed values weren't captured) seed data, same "trimmed but real" philosophy as the Terminal plan's seed agents.
- Every new pure-logic module gets a Vitest suite; presentational grid/JSX work is verified via the dev server (browser automation if available in the executing session, otherwise build+typecheck plus careful reading, same fallback pattern used throughout the prior plan).
- Run `npm test`, `npx tsc -b`, and `npm run build` clean before every commit.

---

## File Structure

```
aether-os/
  src/
    viewRegistry.ts                    NEW — single source of truth for nav/tabs/routing
    App.tsx                            MODIFIED — ActiveView looks up the registry
    components/
      layout/
        TopBar.tsx                     MODIFIED — tabs derived from viewRegistry
        Sidebar.tsx                    MODIFIED — nav derived from viewRegistry
      dashboard/
        DashboardView.tsx              NEW — grid composition, mounts the 5 cells
        ReactorStatusCard.tsx          NEW — hero cell: mini CSS core, KPIs, quick actions
        ActiveAgentsDigest.tsx         NEW
        ProjectsDigest.tsx             NEW
        RecentAlertsCard.tsx           NEW
        SystemsCard.tsx                NEW
        dashboardMath.ts               NEW — pure KPI/status derivation, tested
        dashboardMath.test.ts          NEW
    state/
      types.ts                        MODIFIED — ProjectStatus, ProjectStub.hue, Provider, Cfg.sound, AetherState.providers/routeDefault
      initialState.ts                 MODIFIED — seed projects/providers/routeDefault/cfg.sound
      reducer.ts                      MODIFIED — NEW_PROJECT action
      reducer.test.ts                 MODIFIED — NEW_PROJECT test
```

---

### Task 1: Nav / view registry refactor

Replaces `TopBar.tsx`'s `TAB_LABELS`, `Sidebar.tsx`'s `NAV_ITEMS`/`CLICKABLE`, and `App.tsx`'s `if (state.activeTab === 'Terminal')` chain with one shared array. Every current label/ordering is preserved exactly — this is a pure refactor, not a behavior change (confirmed: the current `CLICKABLE` set is the exact union of `TAB_LABELS` and `NAV_ITEMS`, so no entry needs a separate "not clickable" state).

**Files:**
- Create: `src/viewRegistry.ts`
- Create: `src/viewRegistry.test.ts`
- Modify: `src/components/layout/TopBar.tsx`
- Modify: `src/components/layout/Sidebar.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Produces: `VIEWS: ViewDef[]`, `getViewComponent(id: string): ComponentType | null` — consumed by `App.tsx` (this task) and by Task 6 (adding Dashboard's entry).

- [ ] **Step 1: Write the failing test**

`src/viewRegistry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { VIEWS, getViewComponent } from './viewRegistry';

describe('viewRegistry', () => {
  it('has no duplicate ids', () => {
    const ids = VIEWS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('matches the current app\'s top-bar tabs and sidebar nav exactly', () => {
    const topBarIds = VIEWS.filter((v) => v.inTopBar).map((v) => v.id);
    const sidebarIds = VIEWS.filter((v) => v.inSidebar).map((v) => v.id);
    expect(topBarIds).toEqual(['Terminal', 'Chat', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Files']);
    expect(sidebarIds).toEqual(['Dashboard', 'Terminal', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Uplinks', 'Settings']);
  });

  it('getViewComponent returns null for ids with no built component', () => {
    expect(getViewComponent('Chat')).toBeNull();
    expect(getViewComponent('NotARealTab')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- viewRegistry`
Expected: FAIL — `viewRegistry.ts` doesn't exist yet.

- [ ] **Step 3: Implement src/viewRegistry.ts**

`Dashboard` and `Terminal` get real components (Dashboard is wired here as `null` for now — Task 6 flips it to the real `DashboardView` once built, so this task's own tests pass against the pre-Dashboard state; **Terminal's entry is populated immediately** since `TerminalView` already exists):

```ts
import type { ComponentType } from 'react';
import { TerminalView } from './components/terminal/TerminalView';

export interface ViewDef {
  id: string;
  inTopBar: boolean;
  inSidebar: boolean;
  component: ComponentType | null;
}

export const VIEWS: ViewDef[] = [
  { id: 'Dashboard', inTopBar: false, inSidebar: true, component: null },
  { id: 'Terminal', inTopBar: true, inSidebar: true, component: TerminalView },
  { id: 'Chat', inTopBar: true, inSidebar: false, component: null },
  { id: 'Agents', inTopBar: true, inSidebar: true, component: null },
  { id: 'Grid', inTopBar: true, inSidebar: true, component: null },
  { id: 'Projects', inTopBar: true, inSidebar: true, component: null },
  { id: 'Memory', inTopBar: true, inSidebar: true, component: null },
  { id: 'Analytics', inTopBar: true, inSidebar: true, component: null },
  { id: 'Files', inTopBar: true, inSidebar: false, component: null },
  { id: 'Uplinks', inTopBar: false, inSidebar: true, component: null },
  { id: 'Settings', inTopBar: false, inSidebar: true, component: null },
];

export function getViewComponent(id: string): ComponentType | null {
  return VIEWS.find((v) => v.id === id)?.component ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- viewRegistry`
Expected: PASS, 3 tests.

- [ ] **Step 5: Update src/components/layout/TopBar.tsx**

Replace the `TAB_LABELS` constant and its usage:

```tsx
// remove: const TAB_LABELS = ['Terminal', 'Chat', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Files'];
// add:
import { VIEWS } from '../../viewRegistry';
const TOP_BAR_IDS = VIEWS.filter((v) => v.inTopBar).map((v) => v.id);
```

And change `{TAB_LABELS.map((label) => {` to `{TOP_BAR_IDS.map((label) => {` (the rest of the `.map` body — `tabStyle(on)`, `dispatch({ type: 'SET_ACTIVE_TAB', tab: label })` — is unchanged).

- [ ] **Step 6: Update src/components/layout/Sidebar.tsx**

Replace `NAV_ITEMS` and `CLICKABLE`:

```tsx
// remove: const NAV_ITEMS = ['Dashboard', 'Terminal', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Uplinks', 'Settings'];
// remove: const CLICKABLE = new Set([...]);
// add:
import { VIEWS } from '../../viewRegistry';
const SIDEBAR_IDS = VIEWS.filter((v) => v.inSidebar).map((v) => v.id);
```

Change `{NAV_ITEMS.map((label) => {` to `{SIDEBAR_IDS.map((label) => {`. Since every registry entry is clickable (per Global Constraints), simplify the body: remove the `const clickable = CLICKABLE.has(label);` line and the ternary in `onClick`/`navItemStyle` — every item is now unconditionally clickable:

```tsx
return (
  <div key={label} onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: label })} style={navItemStyle(on)}>
    ...
```

Update `navItemStyle`'s signature to drop the now-unused `clickable` parameter (it always produced `cursor: 'pointer'` anyway since every current entry was clickable):

```ts
function navItemStyle(on: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    padding: '9px 10px',
    borderRadius: 9,
    cursor: 'pointer',
    background: on ? 'linear-gradient(90deg, rgba(23,184,216,.18), rgba(23,184,216,.02))' : undefined,
    border: on ? '1px solid rgba(95,220,255,.4)' : '1px solid transparent',
    color: on ? colors.textPrimary : '#7f9fac',
    boxShadow: on ? 'inset 0 0 14px rgba(95,240,255,.12)' : undefined,
  };
}
```

(Everything else in `Sidebar.tsx` — `navDotWrapStyle`, `navDotStyle`, `RECENT_AGENTS`, the reactor-tip card — is unchanged.)

- [ ] **Step 7: Update src/App.tsx**

```tsx
import { AetherStoreProvider, useAetherStore } from './state/store';
import { AppShell } from './components/layout/AppShell';
import { ComingSoonPanel } from './components/layout/ComingSoonPanel';
import { BottomMetricsRow } from './components/layout/BottomMetricsRow';
import { getViewComponent } from './viewRegistry';

function ActiveView() {
  const { state } = useAetherStore();
  const Component = getViewComponent(state.activeTab);
  if (Component) return <Component />;
  return <ComingSoonPanel tabName={state.activeTab} />;
}

export default function App() {
  return (
    <AetherStoreProvider>
      <AppShell>
        <ActiveView />
        <BottomMetricsRow />
      </AppShell>
    </AetherStoreProvider>
  );
}
```

- [ ] **Step 8: Run the full suite and verify no regressions**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (44 prior tests + 3 new = 47), 0 type errors, build succeeds.

- [ ] **Step 9: Verify via dev server**

Run: `npm run dev`. Confirm the Terminal tab still works exactly as before (top bar tab highlighting, sidebar nav highlighting, clicking any other nav/tab entry still shows `ComingSoonPanel` with the correct label) — this task must be behaviorally invisible except for the code structure.

- [ ] **Step 10: Commit**

```bash
git add src/viewRegistry.ts src/viewRegistry.test.ts src/components/layout/TopBar.tsx src/components/layout/Sidebar.tsx src/App.tsx
git commit -m "refactor: replace three hand-maintained nav lists with a single view registry"
```

---

### Task 2: Extend AetherState for Dashboard's data needs

Ported from the design source's `renderVals()` computations for `dashProjects`/`dashSystems` (research summary: Project items need a `hue` field the current `ProjectStub` lacks and a real 4-value `status` union instead of a bare `string`; the Systems card needs `providers`/`routeDefault`/`cfg.sound`, none of which exist yet since Uplinks/Settings are out of scope). Also adds the `NEW_PROJECT` reducer action for the Dashboard's "NEW PROJECT" quick action — there's no equivalent terminal command to reuse (unlike "SPAWN AGENT", which reuses the existing `spawn` command).

Per Global Constraint #3: `providers`/`routeDefault`/`cfg.sound`'s seed values are original-flavored, not verbatim-extracted (the source's real values weren't captured during research) — same disclosure as the Terminal plan's seed agents.

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/reducer.ts`
- Modify: `src/state/reducer.test.ts`

**Interfaces:**
- Produces: `ProjectStatus` type, `ProjectStub.hue: string`, `Provider` interface, `Cfg.sound: boolean`, `AetherState.providers: Provider[]`, `AetherState.routeDefault: string`, `{ type: 'NEW_PROJECT' }` action — consumed by Task 5 (`ProjectsDigest`) and Task 6 (`SystemsCard`).

- [ ] **Step 1: Update src/state/types.ts**

Change the existing `ProjectStub` interface and add a status union type (append near it):

```ts
export type ProjectStatus = 'BUILDING' | 'REVIEW' | 'QUEUED' | 'SHIPPED';

export interface ProjectStub {
  name: string;
  status: ProjectStatus;
  pct: number;
  hue: string;
}

export interface Provider {
  name: string;
  connected: boolean;
}
```

Add `sound: boolean;` to the `Cfg` interface (alongside the existing `glow`/`glowFx`/etc fields). Add two fields to `AetherState`:

```ts
providers: Provider[];
routeDefault: string;
```

- [ ] **Step 2: Update src/state/initialState.ts**

Change `projects: []` to a seeded array, add `cfg.sound: false`, and add `providers`/`routeDefault`:

```ts
projects: [
  { name: 'CLI Companion', status: 'BUILDING', pct: 62, hue: '#7ef0ff' },
  { name: 'Mobile Beta', status: 'REVIEW', pct: 88, hue: '#8ab6ff' },
  { name: 'Analytics Pipeline', status: 'QUEUED', pct: 0, hue: '#5fffe0' },
  { name: 'Docs Portal', status: 'SHIPPED', pct: 100, hue: '#7fd8ef' },
],
providers: [
  { name: 'Aether Core', connected: true },
  { name: 'OpenAI/Codex', connected: false },
  { name: 'Local Ollama', connected: false },
],
routeDefault: 'Auto',
```

In the `cfg` object literal, add `sound: false,` alongside the existing fields (e.g. after `autoThrottle: true,`).

- [ ] **Step 3: Write the failing test for NEW_PROJECT**

Append to `src/state/reducer.test.ts` (inside the existing `describe('reducer', ...)` block):

```ts
it('NEW_PROJECT adds an unused project from the pool, cycling hues', () => {
  const next = reducer(initialState, { type: 'NEW_PROJECT' });
  expect(next.projects).toHaveLength(initialState.projects.length + 1);
  const added = next.projects[0];
  expect(added.status).toBe('QUEUED');
  expect(added.pct).toBe(0);
  expect(['CLI Companion', 'Mobile Beta', 'Analytics Pipeline']).not.toContain(undefined);
});

it('NEW_PROJECT falls back to a numbered name once the pool is exhausted', () => {
  const withAllTaken = {
    ...initialState,
    projects: [
      { name: 'CLI Companion', status: 'BUILDING' as const, pct: 10, hue: '#fff' },
      { name: 'Mobile Beta', status: 'BUILDING' as const, pct: 10, hue: '#fff' },
      { name: 'Analytics Pipeline', status: 'BUILDING' as const, pct: 10, hue: '#fff' },
    ],
  };
  const next = reducer(withAllTaken, { type: 'NEW_PROJECT' });
  expect(next.projects[0].name).toBe('Project 4');
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test -- reducer`
Expected: FAIL — `NEW_PROJECT` isn't a valid `Action` yet.

- [ ] **Step 5: Add the NEW_PROJECT action to src/state/reducer.ts**

Add to the `Action` union:

```ts
| { type: 'NEW_PROJECT' }
```

Add a case to the `switch`:

```ts
case 'NEW_PROJECT': {
  const pool = ['CLI Companion', 'Mobile Beta', 'Analytics Pipeline'];
  const taken = new Set(state.projects.map((p) => p.name));
  const name = pool.find((n) => !taken.has(n)) ?? `Project ${state.projects.length + 1}`;
  const hues = ['#7ef0ff', '#8ab6ff', '#5fffe0', '#7fd8ef', '#9bd0ff'];
  return {
    ...state,
    projects: [{ name, status: 'QUEUED', pct: 0, hue: hues[state.projects.length % hues.length] }, ...state.projects],
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- reducer`
Expected: PASS, 9 tests (7 existing + 2 new).

- [ ] **Step 7: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (50 total), 0 type errors. (The `commands.test.ts`/`commands.ts` `projects`/`sweep` commands only read `p.name`/`p.status`/`p.pct`, so adding `hue` to `ProjectStub` and seeding real data doesn't break them — confirm this in the run.)

- [ ] **Step 8: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/state/reducer.ts src/state/reducer.test.ts
git commit -m "feat: extend AetherState for Dashboard — project hue/status, providers, routeDefault, NEW_PROJECT action"
```

---

### Task 3: Dashboard derivation math (dashboardMath.ts)

Ported from the design source's `renderVals()`: `dashStatus` (a differently-worded three-way alarm label — `'BURN ALARM'`/`'ELEVATED'`/`'NOMINAL'`, distinct from the Footer's `'BURN ALARM'`/`'BURN ELEVATED'`/`'ALL GOOD'` — sharing only the *color* logic, not the text), `dashPulseMode` (a one-line summary of `cfg.pulseMode`/`cfg.theme`), and the 4 KPI tiles (session tokens/spend, budget-left %, depletion ETA, context %).

**Files:**
- Create: `src/components/dashboard/dashboardMath.ts`
- Test: `src/components/dashboard/dashboardMath.test.ts`

**Interfaces:**
- Consumes: `AetherState`, `AlarmLevel` from `../../state/types`; `fmt`, `short`, `fmtEta` from `../../utils/format`.
- Produces: `computeDashStatus(alarmLevel): string`, `computeDashPulseMode(cfg): string`, `computeDashKpis(state): { k: string; v: string; s: string }[]` — consumed by Task 4's `ReactorStatusCard`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { computeDashKpis, computeDashPulseMode, computeDashStatus } from './dashboardMath';
import { initialState } from '../../state/initialState';

describe('computeDashStatus', () => {
  it('maps each alarm level to its Dashboard-specific label', () => {
    expect(computeDashStatus('ok')).toBe('NOMINAL');
    expect(computeDashStatus('warn')).toBe('ELEVATED');
    expect(computeDashStatus('crit')).toBe('BURN ALARM');
  });
});

describe('computeDashPulseMode', () => {
  it('describes live-rate pulse with the active theme', () => {
    expect(computeDashPulseMode({ ...initialState.cfg, pulseMode: 'live', theme: 'cyan' })).toBe('live-rate pulse · cyan core');
  });
  it('describes ambient pulse', () => {
    expect(computeDashPulseMode({ ...initialState.cfg, pulseMode: 'ambient', theme: 'violet' })).toBe('ambient pulse · violet core');
  });
});

describe('computeDashKpis', () => {
  it('derives all four KPI tiles from state', () => {
    const kpis = computeDashKpis({ ...initialState, used: 24391, rate: 92000, ctxUsed: 78432, cfg: { ...initialState.cfg, capM: 2.0 } });
    expect(kpis).toHaveLength(4);
    expect(kpis[0]).toEqual({ k: 'SESSION TOKENS', v: '24.39K', s: '$0.44 spend' });
    expect(kpis[1].k).toBe('BUDGET LEFT');
    expect(kpis[1].v).toBe('98.8%');
    expect(kpis[1].s).toBe('of 2.0M cap');
    expect(kpis[2].k).toBe('DEPLETION ETA');
    expect(kpis[3]).toEqual({ k: 'CONTEXT', v: '63%', s: '78.4K / 125K' });
  });

  it('clamps budget-left at 0% instead of going negative', () => {
    const kpis = computeDashKpis({ ...initialState, used: 5_000_000, cfg: { ...initialState.cfg, capM: 2.0 } });
    expect(kpis[1].v).toBe('0.0%');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- dashboardMath`
Expected: FAIL — `dashboardMath.ts` doesn't exist yet.

- [ ] **Step 3: Implement src/components/dashboard/dashboardMath.ts**

```ts
import type { AetherState, AlarmLevel, Cfg } from '../../state/types';
import { fmt, fmtEta, short } from '../../utils/format';

export function computeDashStatus(alarmLevel: AlarmLevel): string {
  if (alarmLevel === 'crit') return 'BURN ALARM';
  if (alarmLevel === 'warn') return 'ELEVATED';
  return 'NOMINAL';
}

export function computeDashPulseMode(cfg: Cfg): string {
  const mode = cfg.pulseMode === 'ambient' ? 'ambient pulse' : 'live-rate pulse';
  return `${mode} · ${cfg.theme} core`;
}

export interface DashKpi {
  k: string;
  v: string;
  s: string;
}

export function computeDashKpis(state: AetherState): DashKpi[] {
  const capTokens = state.cfg.capM * 1e6;
  const budgetLeftPct = Math.max(0, 100 - (state.used / capTokens) * 100);
  const remaining = Math.max(0, capTokens - state.used);
  const ctxPct = Math.round(state.ctxUsed / 1250);

  return [
    { k: 'SESSION TOKENS', v: short(state.used), s: `$${(state.used * 0.000018).toFixed(2)} spend` },
    { k: 'BUDGET LEFT', v: `${budgetLeftPct.toFixed(1)}%`, s: `of ${state.cfg.capM.toFixed(1)}M cap` },
    { k: 'DEPLETION ETA', v: fmtEta(remaining / (state.rate / 60)), s: 'at current draw' },
    { k: 'CONTEXT', v: `${ctxPct}%`, s: `${short(state.ctxUsed)} / 125K` },
  ];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- dashboardMath`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/dashboardMath.ts src/components/dashboard/dashboardMath.test.ts
git commit -m "feat: port Dashboard KPI/status derivation math"
```

---

### Task 4: Reactor status hero card (mini CSS core, KPIs, quick actions)

Ported from the design source's Dashboard hero cell (col 1, spans both grid rows): a lightweight CSS-only mini reactor (two counter-rotating dashed rings + two breath-pulsing radial-gradient discs — NOT the canvas `ReactorCore` used in Terminal), a status pill, a burn-rate readout, the 4 KPI tiles from Task 3, and the 5-button quick-actions grid. Three of the five buttons reuse existing dispatches exactly (`SPAWN AGENT` → `RUN_COMMAND raw:'spawn'`, `OPEN TERMINAL` → `SET_ACTIVE_TAB 'Terminal'`, `MEMORY SWEEP` → `RUN_COMMAND raw:'sweep'` + `SET_ACTIVE_TAB 'Memory'` per Global Constraint #2); `NEW PROJECT` dispatches Task 2's new `NEW_PROJECT` action; `COMPOSE MISSION` is intentionally inert per Global Constraint #1.

**Files:**
- Create: `src/components/dashboard/ReactorStatusCard.tsx`

**Interfaces:**
- Consumes: `useAetherStore()`; `computeDashStatus`, `computeDashPulseMode`, `computeDashKpis` from `./dashboardMath`; `colors`, `fonts` from `../../styles/tokens`; `fmt` from `../../utils/format`.
- Produces: `ReactorStatusCard()` — mounted by Task 6's `DashboardView` as the grid's `grid-row: span 2` first cell.

No new unit-testable logic (the math is already tested in Task 3) — verify via dev server.

- [ ] **Step 1: Implement src/components/dashboard/ReactorStatusCard.tsx**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { fmt } from '../../utils/format';
import { computeDashKpis, computeDashPulseMode, computeDashStatus } from './dashboardMath';

export function ReactorStatusCard() {
  const { state, dispatch } = useAetherStore();
  const statusC = state.alarmLevel === 'crit' ? colors.danger : state.alarmLevel === 'warn' ? colors.warn : colors.success;
  const kpis = computeDashKpis(state);

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>REACTOR STATUS</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 11px/1 ${fonts.mono}`, color: statusC }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusC, boxShadow: `0 0 8px ${statusC}` }} />
          {computeDashStatus(state.alarmLevel)}
        </div>
      </div>

      <div style={{ flex: 'none', display: 'grid', placeItems: 'center', padding: '18px 0 6px' }}>
        <div style={{ position: 'relative', width: 120, height: 120, display: 'grid', placeItems: 'center' }}>
          <div style={ringOuterStyle} />
          <div style={ringInnerStyle} />
          <div style={glowDiscStyle} />
          <div style={coreDiscStyle} />
        </div>
      </div>
      <div style={{ textAlign: 'center', font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>
        {fmt(state.rate)} tok/min · {computeDashPulseMode(state.cfg)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginTop: 16 }}>
        {kpis.map((dk) => (
          <div key={dk.k} style={kpiTileStyle}>
            <div style={{ font: `600 9px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted }}>{dk.k}</div>
            <div style={{ font: `700 17px/1 ${fonts.mono}`, color: colors.textPrimary, marginTop: 7 }}>{dk.v}</div>
            <div style={{ font: `400 9px/1 ${fonts.mono}`, color: colors.textDim, marginTop: 5 }}>{dk.s}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 'auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, paddingTop: 14 }}>
        <span onClick={() => dispatch({ type: 'RUN_COMMAND', raw: 'spawn' })} style={primaryActionStyle}>
          ⊕ SPAWN AGENT
        </span>
        <span onClick={() => dispatch({ type: 'NEW_PROJECT' })} style={secondaryActionStyle}>
          ⊕ NEW PROJECT
        </span>
        <span
          onClick={() => {
            dispatch({ type: 'RUN_COMMAND', raw: 'sweep' });
            dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Memory' });
          }}
          style={secondaryActionStyle}
        >
          MEMORY SWEEP
        </span>
        <span onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Terminal' })} style={secondaryActionStyle}>
          OPEN TERMINAL
        </span>
        {/* Mission Composer modal is out of scope for this plan — button renders for visual
            fidelity but is intentionally not wired (see Global Constraints #1). */}
        <span style={{ ...composeActionStyle, cursor: 'default' }}>◇ COMPOSE MISSION</span>
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  gridRow: 'span 2',
  padding: 16,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const ringOuterStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  borderRadius: '50%',
  border: '2px dashed rgba(95,240,255,.3)',
  animation: 'spin 16s linear infinite',
};
const ringInnerStyle: CSSProperties = {
  position: 'absolute',
  inset: 16,
  borderRadius: '50%',
  border: '1px dashed rgba(120,235,255,.45)',
  animation: 'spinRev 10s linear infinite',
};
const glowDiscStyle: CSSProperties = {
  position: 'absolute',
  width: 76,
  height: 76,
  borderRadius: '50%',
  background: 'radial-gradient(circle, rgba(95,240,255,.28), transparent 66%)',
  animation: 'breath var(--pulse-dur, 2.4s) ease-in-out infinite',
};
const coreDiscStyle: CSSProperties = {
  position: 'relative',
  width: 54,
  height: 54,
  borderRadius: '50%',
  background: 'radial-gradient(circle at 44% 38%, #fff, #7ef0ff 30%, #17b8d8 64%, #0a5f74 100%)',
  boxShadow: '0 0 22px rgba(95,240,255,.9), 0 0 52px rgba(80,220,255,.45)',
  animation: 'breath var(--pulse-dur, 2.4s) ease-in-out infinite',
};
const kpiTileStyle: CSSProperties = { padding: '11px 12px', borderRadius: 9, border: '1px solid rgba(80,190,220,.18)', background: 'rgba(6,20,28,.5)' };
const primaryActionStyle: CSSProperties = {
  textAlign: 'center',
  cursor: 'pointer',
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: 1.5,
  color: '#04202b',
  background: 'linear-gradient(180deg,#7ef0ff,#17b8d8)',
  padding: '10px 0',
  borderRadius: 8,
  boxShadow: '0 0 14px rgba(95,240,255,.4)',
};
const secondaryActionStyle: CSSProperties = {
  textAlign: 'center',
  cursor: 'pointer',
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: 1.5,
  color: '#bff4ff',
  border: '1px solid rgba(95,220,255,.45)',
  padding: '10px 0',
  borderRadius: 8,
  background: 'rgba(23,184,216,.1)',
};
const composeActionStyle: CSSProperties = {
  gridColumn: 'span 2',
  textAlign: 'center',
  font: `600 12px/1 ${fonts.ui}`,
  letterSpacing: 2,
  color: colors.textPrimary,
  border: '1px solid rgba(95,220,255,.55)',
  padding: '11px 0',
  borderRadius: 8,
  background: 'rgba(23,184,216,.18)',
  boxShadow: 'inset 0 0 18px rgba(95,240,255,.12)',
};
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/dashboard/ReactorStatusCard.tsx
git commit -m "feat: build the Dashboard reactor status hero card (mini core, KPIs, quick actions)"
```

---

### Task 5: Active Agents & Projects digest cards

Ported from the design source's two mid-grid cells. Both are lighter-weight than their Terminal-view counterparts: Active Agents shows every agent (no truncation) as avatar + name + thin progress bar, no task text or file list; Projects shows the first 6 (`state.projects.slice(0, 6)`) as a status badge + name + percent, with `BUILDING`-status items getting a small live creep tied to session usage (`Math.min(99, Math.round(p.pct + (state.used - 24391) / 30000))`) matching the source exactly, other statuses showing their stored `pct` unchanged.

**Files:**
- Create: `src/components/dashboard/ActiveAgentsDigest.tsx`
- Create: `src/components/dashboard/ProjectsDigest.tsx`

**Interfaces:**
- Consumes: `useAetherStore()`; `colors`, `fonts` from `../../styles/tokens`.
- Produces: `ActiveAgentsDigest()`, `ProjectsDigest()` — mounted by Task 6's `DashboardView`.

No new unit-testable logic — verify via dev server.

- [ ] **Step 1: Implement src/components/dashboard/ActiveAgentsDigest.tsx**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function ActiveAgentsDigest() {
  const { state, dispatch } = useAetherStore();
  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>ACTIVE AGENTS</div>
        <span onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Agents' })} style={viewAllStyle}>
          VIEW ALL →
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 11, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {state.agents.map((a) => (
          <div key={a.name} onClick={() => dispatch({ type: 'SELECT_AGENT', name: a.name })} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <span style={avatarStyle(a.hue)}>{a.i}</span>
            <span style={nameStyle}>{a.name}</span>
            <span style={trackStyle}>
              <span style={{ display: 'block', height: '100%', width: `${Math.round(a.pct)}%`, background: a.hue, boxShadow: `0 0 8px ${a.hue}` }} />
            </span>
            <span style={{ flex: 'none', font: `700 11px/1 ${fonts.mono}`, color: a.hue, width: 32, textAlign: 'right' }}>{Math.round(a.pct)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const viewAllStyle: CSSProperties = { cursor: 'pointer', font: `600 10px/1 ${fonts.ui}`, letterSpacing: 1.5, color: colors.accentCyanSoft };
function avatarStyle(hue: string): CSSProperties {
  return {
    width: 26,
    height: 26,
    flex: 'none',
    borderRadius: 7,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 4px,#123f4e 4px 8px)',
    border: `1px solid ${hue}`,
    display: 'grid',
    placeItems: 'center',
    font: `700 10px/1 ${fonts.mono}`,
    color: hue,
  };
}
const nameStyle: CSSProperties = { flex: 1, font: `600 13px/1 ${fonts.ui}`, color: colors.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const trackStyle: CSSProperties = { flex: 'none', width: 70, height: 4, borderRadius: 2, background: 'rgba(20,50,64,.7)', overflow: 'hidden' };
```

- [ ] **Step 2: Implement src/components/dashboard/ProjectsDigest.tsx**

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

  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>PROJECTS</div>
        <span onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Projects' })} style={viewAllStyle}>
          VIEW ALL →
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 11, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {projects.map((p) => (
          <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <span style={statusBadgeStyle(STATUS_COLOR[p.status])}>{p.status}</span>
            <span style={nameStyle}>{p.name}</span>
            <span style={{ flex: 'none', font: `700 11px/1 ${fonts.mono}`, color: p.hue }}>{p.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const viewAllStyle: CSSProperties = { cursor: 'pointer', font: `600 10px/1 ${fonts.ui}`, letterSpacing: 1.5, color: colors.accentCyanSoft };
const nameStyle: CSSProperties = { flex: 1, font: `600 13px/1 ${fonts.ui}`, color: colors.textPrimary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
function statusBadgeStyle(c: string): CSSProperties {
  return { flex: 'none', font: `600 8px/1 ${fonts.ui}`, letterSpacing: 1, color: c, border: `1px solid ${c}55`, padding: '4px 7px', borderRadius: 4, width: 56, textAlign: 'center' };
}
```

Note: `ProjectsDigest`'s row doesn't dispatch anything on click yet (the source's `dp.sel` sets `projSelected` and switches to a Projects view this plan doesn't build) — the `cursor: 'pointer'` is kept for visual fidelity but the click is a no-op, consistent with `COMPOSE MISSION`'s scope cut. This is a minor, self-contained gap — not called out as a separate Global Constraint since it's the same "the destination view doesn't exist yet" reasoning already covered.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/ActiveAgentsDigest.tsx src/components/dashboard/ProjectsDigest.tsx
git commit -m "feat: build the Dashboard Active Agents and Projects digest cards"
```

---

### Task 6: Recent Alerts + Systems cards, grid composition, registry wiring

Ported from the design source's remaining two Dashboard cells and the 3-col×2-row grid that assembles all 5. Recent Alerts is a direct `state.notifs.slice(0, 8)` read — no new logic. Systems is a flat key/value list requiring the three state slices added in Task 2 (`providers`, `routeDefault`, `cfg.sound`) plus fields already in scope (`memories`, `approvals`, `idleList`).

**Files:**
- Create: `src/components/dashboard/RecentAlertsCard.tsx`
- Create: `src/components/dashboard/SystemsCard.tsx`
- Create: `src/components/dashboard/DashboardView.tsx`
- Modify: `src/viewRegistry.ts` (flip Dashboard's `component` from `null` to `DashboardView`)
- Modify: `src/viewRegistry.test.ts` (the "returns null for ids with no built component" test must switch its Dashboard assertion — see Step 5)

**Interfaces:**
- Consumes: `useAetherStore()`; `colors`, `fonts` from `../../styles/tokens`.
- Produces: `RecentAlertsCard()`, `SystemsCard()`, `DashboardView()` — the last is registered in `viewRegistry.ts`, completing the Dashboard slice.

- [ ] **Step 1: Implement src/components/dashboard/RecentAlertsCard.tsx**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function RecentAlertsCard() {
  const { state } = useAetherStore();
  const alerts = state.notifs.slice(0, 8);
  return (
    <div style={cardStyle}>
      <div style={titleStyle}>RECENT ALERTS</div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 11, display: 'flex', flexDirection: 'column', gap: 9 }}>
        {alerts.map((nf, idx) => (
          <div key={idx} style={{ display: 'flex', gap: 9, font: `400 10.5px/1.5 ${fonts.mono}` }}>
            <span style={{ color: colors.textDim, flex: 'none' }}>{nf.t}</span>
            <span style={{ color: nf.c }}>{nf.m}</span>
          </div>
        ))}
        {!alerts.length && <div style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>no alerts — reactor calm</div>}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
const titleStyle: CSSProperties = { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
```

- [ ] **Step 2: Implement src/components/dashboard/SystemsCard.tsx**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function SystemsCard() {
  const { state, dispatch } = useAetherStore();
  const rows = [
    { k: 'Uplinks online', v: `${state.providers.filter((pv) => pv.connected).length} / ${state.providers.length}`, c: colors.success },
    { k: 'Memory engrams', v: String(state.memories.length), c: '#8ab6ff' },
    { k: 'Pinned', v: String(state.memories.filter((m) => m.pinned).length), c: colors.warn },
    { k: 'Pending approvals', v: String(state.approvals.length), c: state.approvals.length ? colors.warn : colors.success },
    { k: 'Idle agents', v: String(state.idleList.length), c: colors.textSecondary },
    { k: 'Default runtime', v: state.routeDefault.toUpperCase(), c: colors.accentCyan },
    { k: 'Sound', v: state.cfg.sound ? 'ON' : 'OFF', c: state.cfg.sound ? colors.success : colors.textMuted },
  ];

  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>SYSTEMS</div>
        <span onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Uplinks' })} style={viewAllStyle}>
          UPLINKS →
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', marginTop: 11, display: 'flex', flexDirection: 'column', gap: 9 }}>
        {rows.map((r) => (
          <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', font: `400 11px/1 ${fonts.mono}` }}>
            <span style={{ color: colors.textSecondary }}>{r.k}</span>
            <span style={{ color: r.c }}>{r.v}</span>
          </div>
        ))}
      </div>
      <div style={{ flex: 'none', font: `400 9px/1.5 ${fonts.mono}`, color: colors.textDim, paddingTop: 10, borderTop: `1px solid ${colors.chromeBorder}` }}>
        CTRL+K jumps anywhere · state persists across reloads
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const viewAllStyle: CSSProperties = { cursor: 'pointer', font: `600 10px/1 ${fonts.ui}`, letterSpacing: 1.5, color: colors.accentCyanSoft };
```

Note: `src/styles/tokens.ts`'s palette has `accentCyan`/`accentCyanDeep`/`accentCyanSoft` but no blue token, so the "Memory engrams" row's `'#8ab6ff'` (the same blue used for agent hues elsewhere) is a literal, matching the source's own literal color rather than referencing a token that doesn't exist. If a future plan adds a blue token to `tokens.ts`, this can be swapped to reference it.

- [ ] **Step 3: Implement src/components/dashboard/DashboardView.tsx**

```tsx
import type { CSSProperties } from 'react';
import { ReactorStatusCard } from './ReactorStatusCard';
import { ActiveAgentsDigest } from './ActiveAgentsDigest';
import { ProjectsDigest } from './ProjectsDigest';
import { RecentAlertsCard } from './RecentAlertsCard';
import { SystemsCard } from './SystemsCard';

export function DashboardView() {
  return (
    <div style={gridStyle}>
      <ReactorStatusCard />
      <ActiveAgentsDigest />
      <ProjectsDigest />
      <RecentAlertsCard />
      <SystemsCard />
    </div>
  );
}

const gridStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'grid',
  gridTemplateColumns: '1.05fr 1fr 1fr',
  gridTemplateRows: '1fr 1fr',
  gap: 14,
};
```

(`ReactorStatusCard` sets its own `gridRow: 'span 2'` — see Task 4 — so it occupies column 1 across both rows; the other four cells auto-place into the remaining 2×2 positions in the order they're written here, matching the source's document order exactly.)

- [ ] **Step 4: Wire Dashboard into the registry**

In `src/viewRegistry.ts`, add the import and flip the entry:

```ts
import { DashboardView } from './components/dashboard/DashboardView';
// ...
{ id: 'Dashboard', inTopBar: false, inSidebar: true, component: DashboardView },
```

- [ ] **Step 5: Update src/viewRegistry.test.ts**

The `getViewComponent` test from Task 1 no longer needs adjustment (it only asserted `'Chat'` and `'NotARealTab'` return `null` — Dashboard was never asserted there). Add one new test confirming Dashboard now resolves:

```ts
it('getViewComponent resolves Dashboard now that it is built', () => {
  expect(getViewComponent('Dashboard')).not.toBeNull();
});
```

- [ ] **Step 6: Run the full suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (51 total), 0 type errors, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/components/dashboard/RecentAlertsCard.tsx src/components/dashboard/SystemsCard.tsx src/components/dashboard/DashboardView.tsx src/viewRegistry.ts src/viewRegistry.test.ts
git commit -m "feat: build Dashboard's Recent Alerts and Systems cards, compose the grid, wire into the view registry"
```

---

### Task 7: Final integration QA

**Files:** none (verification-only task).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS, 0 type errors, build succeeds.

- [ ] **Step 2: Manual QA checklist**

Run: `npm run dev`, open the browser.

- [ ] Clicking the Sidebar's "Dashboard" entry (or reloading with `activeTab: 'Dashboard'` persisted) shows the full 5-cell grid: hero card spanning both rows on the left, Active Agents / Projects / Recent Alerts / Systems filling the remaining 2×2 grid.
- [ ] The mini CSS reactor core in the hero card visibly breathes/pulses in sync with the same `--pulse-dur` the Terminal view's canvas reactor uses (spawn a few agents to raise the burn rate, confirm the pulse visibly speeds up on Dashboard the same way it does on Terminal).
- [ ] All 4 KPI tiles show real, correctly-formatted numbers (spend as `$X.XX`, budget-left as a percent, ETA as `Xh Ym`/`Xm`, context as `X%`).
- [ ] Click "SPAWN AGENT" — a 6th agent appears in both the Dashboard's Active Agents digest and (navigate to Terminal to confirm) the Terminal right rail.
- [ ] Click "NEW PROJECT" three times — three new projects appear (CLI Companion, Mobile Beta, Analytics Pipeline in order), a 4th click produces "Project 5" (since the pool of 3 is exhausted and 4 projects were already seeded).
- [ ] Click "MEMORY SWEEP" — the view switches to the Memory tab (showing `ComingSoonPanel`, since Memory itself isn't built); navigate back to Dashboard and confirm no error occurred.
- [ ] Click "OPEN TERMINAL" — switches to the Terminal tab.
- [ ] "COMPOSE MISSION" is visibly present but clicking it does nothing (no console error, no state change) — confirms the deliberate scope cut didn't silently break anything.
- [ ] Recent Alerts shows live notifications as they fire from the simulation tick (or "no alerts — reactor calm" if none yet).
- [ ] Systems card shows all 7 rows with real values (`Uplinks online` as `1 / 3`, `Sound` as `OFF`, etc.).
- [ ] Confirm the nav-registry refactor (Task 1) didn't regress anything: every sidebar/top-bar entry still highlights correctly and routes to either its real view (Dashboard, Terminal) or `ComingSoonPanel` with the correct label.
- [ ] Reload the page — Dashboard's data (agents, projects, alerts) persists correctly via the existing localStorage mechanism (no changes were needed there since `AetherState`'s persisted-fields whitelist already includes `agents`/`notifs`, and `projects` needs to be added to that whitelist if it wasn't already — check `src/state/persistence.ts`'s `PERSISTED_KEYS`/whitelist and confirm; add `projects` to it now if missing, as a small unplanned fix within this task's own verification scope).

- [ ] **Step 3: Commit any fix from Step 2's persistence check, if needed**

If `projects` (or `providers`/`routeDefault`) needed to be added to `src/state/persistence.ts`'s whitelist during Step 2, commit that as its own small fix:

```bash
git add src/state/persistence.ts
git commit -m "fix: persist Dashboard's project/provider state across reloads"
```

If no fix was needed, skip this step.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-17-nav-registry-dashboard.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, with review between tasks and fast iteration.

**2. Inline Execution** — execute tasks in this session using `executing-plans`, batch execution with checkpoints for review.

**Which approach?**
