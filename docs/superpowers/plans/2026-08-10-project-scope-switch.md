# App-wide Project Scope Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Selecting a project row in the Projects view scopes the Ledger and Optimize views to that project's data, with a TopBar indicator to see and clear the active scope from any tab.

**Architecture:** Extend Stage 16's existing per-project event grouping (`buildProjectsSnapshot`) to also compute Optimize findings per project node, reusing the exact same per-group events already used for the per-project Ledger. No new IPC channel — `projects:snapshot` already carries every node; it now carries more per node. `state.selectedProject` (already exists, already persisted) is the single scope concept everywhere it's read.

**Tech Stack:** TypeScript, React, Electron (main process), Vitest + React Testing Library.

## Global Constraints

- No new IPC channel. `projects:snapshot` is the only channel that changes shape.
- No new `AetherState` field. `state.selectedProject` is the scope, full stop.
- `unscoped` stays unselectable — do not add a click handler to it anywhere.
- Ledger/Optimize entry point for setting scope stays Projects-view-only. Do not add pickers to `LedgerView`/`OptimizeView`.
- `LedgerView`'s `DispatchCostTable` and reconciliation strip are suppressed (not filtered) while a scope is active — they're built from Aether's-own-live-session dispatch tracking, which has no project attribution.
- `optimize:apply`'s existing `'global' | 'project'` target picker is untouched by this plan — it is a different, pre-existing concept (where a CLAUDE.md edit is written) that happens to share the word "project." Do not conflate it with scope in code or copy.
- Spec: `docs/superpowers/specs/2026-08-10-project-scope-switch-design.md`.

---

### Task 1: Compute per-project Optimize findings in `buildProjectsSnapshot`

**Files:**
- Modify: `src/shared/projectsSnapshot.ts`
- Test: `src/shared/projectsSnapshot.test.ts`

**Interfaces:**
- Consumes: `evaluateOptimizeRulesWithRecurrence(events: TranscriptEvent[], windowMs: number, appliedState: Record<string, number>): (OptimizeFinding & { recurring?: true; appliedAtMs?: number })[]` and `summarizeOptimize(findings: OptimizeFinding[]): OptimizeSummary` from `./optimizeRules`; `computeCacheHitRate(events: TranscriptEvent[]): number` from `./cacheHitRate`; `gradeBreakdown(input?: { findings?: OptimizeFinding[]; cacheHitRate?: number }): GradeRow[]` from `./optimizeGrade`.
- Produces: `ProjectNode.optimize: { findings: (OptimizeFinding & { recurring?: true; appliedAtMs?: number })[]; summary: OptimizeSummary; breakdown: GradeRow[] }` — Task 4/5 read this field.

- [ ] **Step 1: Write the failing test**

Add to `src/shared/projectsSnapshot.test.ts` (near the other `buildProjectsSnapshot` tests):

```ts
// ... inside describe('buildProjectsSnapshot', ...) — no new import needed,
// TranscriptEvent is already imported at the top of this file:

it('computes optimize findings per project from that project\'s own events, not the global set', () => {
  // 200 assistant turns on opus with tiny (<300 tok) output each trips the
  // opus-on-trivial-turns rule (see optimizeRules.ts's threshold). Only
  // AETHER's events get this shape; TOKEN's stay small and healthy.
  const trivialOpusEvents: TranscriptEvent[] = Array.from({ length: 200 }, () => ({
    kind: 'assistant' as const,
    sessionId: 's',
    timestamp: new Date(NOW),
    cwd: AETHER,
    model: 'claude-opus-4-8',
    usage: { inputTokens: 0, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    toolUses: [],
    toolResults: [],
    isHumanPrompt: false,
    humanText: null,
    originKind: null,
  }));
  const s = buildProjectsSnapshot(
    [...trivialOpusEvents, ev(TOKEN, M)],
    probe,
    keyOf,
    'UTC',
    NOW,
    { windowMs: 7 * 24 * 60 * 60 * 1000, appliedState: {} },
  );
  const aether = s.roots.find((r) => r.name === 'aether-os')!;
  const token = s.roots.find((r) => r.name === 'tokenmonitorv2')!;
  const aetherFindingIds = aether.optimize.findings.map((f) => f.id);
  expect(aetherFindingIds).toContain('opus-on-trivial-turns');
  expect(token.optimize.findings.map((f) => f.id)).not.toContain('opus-on-trivial-turns');
});

it('a project with no rule violations has an empty findings array, not an absent field', () => {
  const s = buildProjectsSnapshot([ev(AETHER, M)], probe, keyOf, 'UTC', NOW);
  expect(s.roots[0].optimize.findings).toEqual([]);
  expect(s.roots[0].optimize.summary.grade).toBe('A');
});

it('defaults windowMs/appliedState when optimizeOptions is omitted, matching main.ts\'s WEEK_MS', () => {
  // No optimizeOptions passed -- existing callers (and the 9 tests above this
  // one) must keep working unchanged.
  const s = buildProjectsSnapshot([ev(AETHER, M)], probe, keyOf, 'UTC', NOW);
  expect(s.roots[0].optimize).toBeDefined();
  expect(Array.isArray(s.roots[0].optimize.findings)).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm test -- src/shared/projectsSnapshot.test.ts`
Expected: FAIL — `s.roots[0].optimize` is `undefined` (property doesn't exist yet), and the `OptimizeFinding` import path resolves fine but the field itself is missing.

- [ ] **Step 3: Add the `optimize` field to `ProjectNode` and compute it in `buildProjectsSnapshot`**

In `src/shared/projectsSnapshot.ts`, add imports and extend the interface:

```ts
// src/shared/projectsSnapshot.ts
import type { TranscriptEvent } from '../../electron/transcriptParser';
import { buildLedgerSnapshot, type LedgerSnapshot } from './ledgerMath';
import { resolveProject, type GitProbe } from './projectIdentity';
import { evaluateOptimizeRulesWithRecurrence, summarizeOptimize, type OptimizeFinding, type OptimizeSummary } from './optimizeRules';
import { computeCacheHitRate } from './cacheHitRate';
import { gradeBreakdown, type GradeRow } from './optimizeGrade';

const DEFAULT_OPTIMIZE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // mirrors main.ts's WEEK_MS

export interface ProjectOptimizeSnapshot {
  findings: (OptimizeFinding & { recurring?: true; appliedAtMs?: number })[];
  summary: OptimizeSummary;
  breakdown: GradeRow[];
}

export interface ProjectNode {
  /** Opaque and stable. Never a path -- see docs/privacy-and-data.md. */
  key: string;
  /** Basename only. */
  name: string;
  worktree: string | null;
  ledger: LedgerSnapshot;
  optimize: ProjectOptimizeSnapshot;
}
```

(`ProjectRoot`/`ProjectsSnapshot` interfaces below it are unchanged — `ProjectRoot extends ProjectNode` already inherits the new field.)

Add a small helper above `buildProjectsSnapshot` and compute `optimize` for both the child-loop and the root:

```ts
function buildOptimizeSnapshot(
  events: TranscriptEvent[],
  windowMs: number,
  appliedState: Record<string, number>,
): ProjectOptimizeSnapshot {
  const findings = evaluateOptimizeRulesWithRecurrence(events, windowMs, appliedState);
  const summary = summarizeOptimize(findings);
  const cacheHitRate = computeCacheHitRate(events);
  const breakdown = gradeBreakdown({ findings, cacheHitRate });
  return { findings, summary, breakdown };
}
```

Change the function signature to accept an optional 6th param, and use it in both places a `ProjectNode` is built:

```ts
export function buildProjectsSnapshot(
  events: TranscriptEvent[],
  probe: GitProbe,
  keyOf: (repoPath: string) => string,
  timeZone: string,
  nowMs: number,
  optimizeOptions?: { windowMs: number; appliedState: Record<string, number> },
): ProjectsSnapshot {
  const windowMs = optimizeOptions?.windowMs ?? DEFAULT_OPTIMIZE_WINDOW_MS;
  const appliedState = optimizeOptions?.appliedState ?? {};
  // ... unchanged grouping loop above ...
```

In the children loop, replace:

```ts
      children.push({
        key: keyOf(`${repoPath}#${slot}`),
        name,
        worktree: slot === '' ? null : slot,
        ledger: buildLedgerSnapshot(slotEvents, timeZone, nowMs),
      });
```

with:

```ts
      children.push({
        key: keyOf(`${repoPath}#${slot}`),
        name,
        worktree: slot === '' ? null : slot,
        ledger: buildLedgerSnapshot(slotEvents, timeZone, nowMs),
        optimize: buildOptimizeSnapshot(slotEvents, windowMs, appliedState),
      });
```

And in the root push, replace:

```ts
    roots.push({
      key: keyOf(repoPath),
      name,
      worktree: null,
      ledger: buildLedgerSnapshot(allEvents, timeZone, nowMs),
      children,
    });
```

with:

```ts
    roots.push({
      key: keyOf(repoPath),
      name,
      worktree: null,
      ledger: buildLedgerSnapshot(allEvents, timeZone, nowMs),
      optimize: buildOptimizeSnapshot(allEvents, windowMs, appliedState),
      children,
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/shared/projectsSnapshot.test.ts`
Expected: PASS, all tests including the pre-existing 9.

- [ ] **Step 5: Type-check**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/projectsSnapshot.ts src/shared/projectsSnapshot.test.ts
git commit -m "feat(projects): compute per-project Optimize findings in buildProjectsSnapshot"
```

---

### Task 2: Wire `main.ts` to pass the real window/appliedState into `buildProjectsSnapshot`

**Files:**
- Modify: `electron/main.ts:394-401`

**Interfaces:**
- Consumes: Task 1's `buildProjectsSnapshot`'s new optional 6th parameter `{ windowMs: number; appliedState: Record<string, number> }`. `WEEK_MS` (existing local const, `electron/main.ts:225`) and `appliedState` (existing local, loaded at `electron/main.ts:373` via `loadOptimizeState`) are already in scope at the call site — no new state to introduce.
- Produces: nothing new for later tasks — this is the only place `buildProjectsSnapshot` is called in the app.

- [ ] **Step 1: Update the call site**

In `electron/main.ts`, the existing call (currently lines 394-400):

```ts
  cachedProjectsSnapshot = buildProjectsSnapshot(
    optimizeEvents,
    gitProbe,
    projectKey,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    Date.now(),
  );
```

becomes:

```ts
  cachedProjectsSnapshot = buildProjectsSnapshot(
    optimizeEvents,
    gitProbe,
    projectKey,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    Date.now(),
    { windowMs: WEEK_MS, appliedState },
  );
```

This runs after `appliedState` is loaded (line 373) and reuses the same `WEEK_MS`/`appliedState` the global Optimize computation two lines above already uses — same window, same applied-guidance record, just re-run per project group.

- [ ] **Step 2: Type-check**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS, no regressions (this file has no dedicated unit test; verified via type-check plus the app's existing electron-side integration coverage).

- [ ] **Step 4: Commit**

```bash
git add electron/main.ts
git commit -m "feat(projects): pass the real optimize window/appliedState into buildProjectsSnapshot"
```

---

### Task 3: Allow `SELECT_PROJECT` to clear the selection

**Files:**
- Modify: `src/state/reducer.ts:29` (action type), `src/state/reducer.ts:156-157` (case)
- Test: `src/state/reducer.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `dispatch({ type: 'SELECT_PROJECT', key: null })` clears `state.selectedProject` — Task 6's TopBar clear button relies on this.

- [ ] **Step 1: Write the failing test**

Add to `src/state/reducer.test.ts`, near the existing `'SELECT_PROJECT sets selectedProject'` test:

```ts
it('SELECT_PROJECT with a null key clears selectedProject', () => {
  const withSelection = reducer(initialState, { type: 'SELECT_PROJECT', key: 'mobile-beta' });
  const cleared = reducer(withSelection, { type: 'SELECT_PROJECT', key: null });
  expect(cleared.selectedProject).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/state/reducer.test.ts -t "clears selectedProject"`
Expected: FAIL — TypeScript error, `key: null` is not assignable to `SELECT_PROJECT`'s current `key: string`.

- [ ] **Step 3: Widen the action type**

In `src/state/reducer.ts`, change:

```ts
  | { type: 'SELECT_PROJECT'; key: string }
```

to:

```ts
  | { type: 'SELECT_PROJECT'; key: string | null }
```

The reducer case itself (`return { ...state, selectedProject: action.key };`) needs no change — it already assigns whatever `action.key` is, and `AetherState.selectedProject` is already typed `string | null`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/state/reducer.test.ts`
Expected: PASS, including the pre-existing `'SELECT_PROJECT sets selectedProject'` test.

- [ ] **Step 5: Type-check**

Run: `npx tsc -b`
Expected: no errors. (Confirms no other call site assumed `key` is always a non-null string in a way that would now break — `ProjectRosterCard`'s `onSelect: (key: string) => void` prop stays non-nullable and unaffected, since it only ever forwards real keys.)

- [ ] **Step 6: Commit**

```bash
git add src/state/reducer.ts src/state/reducer.test.ts
git commit -m "feat(state): allow SELECT_PROJECT to clear selectedProject with a null key"
```

---

### Task 4: Scope `LedgerView` to the selected project

**Files:**
- Modify: `src/components/ledger/LedgerView.tsx`
- Test: `src/components/ledger/LedgerView.test.tsx`

**Interfaces:**
- Consumes: `findProjectByKey(snapshot: ProjectsSnapshot | null, key: string | null, opts?: { fallbackToFirst?: boolean }): ProjectNode | null` from `../projects/projectsMath` (no `fallbackToFirst` here — `null` must mean "no scope," not "show something anyway"). `ProjectNode.ledger`/`.optimize` from Task 1.
- Produces: `resolveLedgerViewData(state): { ledger: LedgerSnapshot | null; showDispatchDetail: boolean }` — a pure, exported function, tested directly (this file's existing convention: `buildDispatchRows`/`selectTodaysRows` are also exported pure functions tested without mounting the component, since `AetherStoreProvider` has no test-time state override).

- [ ] **Step 1: Write the failing test**

Add to `src/components/ledger/LedgerView.test.tsx`:

```ts
import { resolveLedgerViewData } from './LedgerView';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';

describe('resolveLedgerViewData', () => {
  const globalLedger = { total: { usd: 10, breakdown: { input: 10, output: 0, cacheCreation: 0, cacheRead: 0 } } } as any;
  const scopedLedger = { total: { usd: 3, breakdown: { input: 3, output: 0, cacheCreation: 0, cacheRead: 0 } } } as any;
  const snapshot: ProjectsSnapshot = {
    roots: [
      {
        key: 'aether', name: 'aether-os', worktree: null,
        ledger: scopedLedger,
        optimize: { findings: [], summary: { totalPerWeek: 0, grade: 'A' as const }, breakdown: [] },
        children: [],
      },
    ],
    unscoped: null,
    computedAtMs: 0,
  };

  it('returns the global ledger and shows dispatch detail when nothing is selected', () => {
    const result = resolveLedgerViewData({ selectedProject: null, projectsSnapshot: snapshot, ledger: globalLedger });
    expect(result.ledger).toBe(globalLedger);
    expect(result.showDispatchDetail).toBe(true);
  });

  it('returns the scoped project\'s ledger and hides dispatch detail when a valid project is selected', () => {
    const result = resolveLedgerViewData({ selectedProject: 'aether', projectsSnapshot: snapshot, ledger: globalLedger });
    expect(result.ledger).toBe(scopedLedger);
    expect(result.showDispatchDetail).toBe(false);
  });

  it('falls back to the global ledger when the selected key is no longer in the snapshot', () => {
    const result = resolveLedgerViewData({ selectedProject: 'deleted-project', projectsSnapshot: snapshot, ledger: globalLedger });
    expect(result.ledger).toBe(globalLedger);
    expect(result.showDispatchDetail).toBe(true);
  });

  it('falls back to the global ledger when there is no snapshot yet', () => {
    const result = resolveLedgerViewData({ selectedProject: 'aether', projectsSnapshot: null, ledger: globalLedger });
    expect(result.ledger).toBe(globalLedger);
    expect(result.showDispatchDetail).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/ledger/LedgerView.test.tsx -t "resolveLedgerViewData"`
Expected: FAIL — `resolveLedgerViewData` is not exported from `./LedgerView` yet.

- [ ] **Step 3: Implement `resolveLedgerViewData` and wire it into the component**

In `src/components/ledger/LedgerView.tsx`, add the import and the new function (near `buildDispatchRows`):

```ts
import { findProjectByKey } from '../projects/projectsMath';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';

/**
 * Resolves which ledger to render and whether the dispatch-level detail
 * (DispatchCostTable, the reconciliation strip) is safe to show.
 *
 * Dispatch detail is Aether's-own-live-session tracking (recentCompletedDispatches
 * / dispatchUsage / diagnostics) -- it carries no project attribution, so
 * showing it next to a SCOPED ledger.rollups.today would compare a
 * project-scoped exact total against unscoped dispatch estimates, producing
 * a misleading residual. It is suppressed whenever a scope is active, not
 * re-filtered -- there is nothing in that data to filter on.
 */
export function resolveLedgerViewData(state: {
  selectedProject: string | null;
  projectsSnapshot: ProjectsSnapshot | null;
  ledger: LedgerSnapshot | null;
}): { ledger: LedgerSnapshot | null; showDispatchDetail: boolean } {
  const scoped = findProjectByKey(state.projectsSnapshot, state.selectedProject);
  if (scoped) return { ledger: scoped.ledger, showDispatchDetail: false };
  return { ledger: state.ledger, showDispatchDetail: true };
}
```

`LedgerSnapshot` is already imported at the top of this file (from `../../shared/ledgerMath`) — no new type import needed for it.

Now wire it into the component. Replace:

```ts
  const { state } = useAetherStore();
  const ledger = state.ledger;

  const rows = buildDispatchRows(state);
```

with:

```ts
  const { state } = useAetherStore();
  const { ledger, showDispatchDetail } = resolveLedgerViewData(state);

  const rows = buildDispatchRows(state);
```

Then wrap the `DispatchCostTable` and reconciliation-strip JSX in the `showDispatchDetail` check. Replace:

```tsx
          <DispatchCostTable rows={rows} />

          {reconciliation !== null && (
```

with:

```tsx
          {showDispatchDetail && <DispatchCostTable rows={rows} />}

          {showDispatchDetail && reconciliation !== null && (
```

Finally, add a short note explaining the suppression when scoped but the table would otherwise have shown. Add this right after the closing `)}` of the reconciliation block (still inside the `{!ledger ? ... : (<> ... </>)}` branch, after the `PricingBasisFooter`):

```tsx
          {!showDispatchDetail && (
            <div style={residualCaveatStyle(colors)}>
              Dispatch-level detail is only available for the unscoped view — Aether's live
              dispatch tracking follows this session, not any specific project.
            </div>
          )}

          <PricingBasisFooter />
```

(replacing the existing bare `<PricingBasisFooter />` line at the end of that branch).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/components/ledger/LedgerView.test.tsx`
Expected: PASS, including all pre-existing tests in this file.

- [ ] **Step 5: Type-check**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/ledger/LedgerView.tsx src/components/ledger/LedgerView.test.tsx
git commit -m "feat(ledger): scope LedgerView to the selected project, suppress dispatch detail while scoped"
```

---

### Task 5: Scope `OptimizeView` to the selected project

**Files:**
- Modify: `src/components/optimize/OptimizeView.tsx`
- Test: `src/components/optimize/OptimizeView.test.ts` (new)

**Interfaces:**
- Consumes: `findProjectByKey` (same as Task 4). `ProjectNode.optimize` from Task 1.
- Produces: `resolveOptimizeViewData(state): { findings: (OptimizeFinding & { recurring?: true; appliedAtMs?: number })[]; summary: OptimizeSummary; breakdown: GradeRow[] }` — exported pure function, same testing rationale as Task 4 (no test-time store override exists).

- [ ] **Step 1: Write the failing test**

Create `src/components/optimize/OptimizeView.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveOptimizeViewData } from './OptimizeView';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';
import type { OptimizeFinding } from '../../shared/optimizeRules';

describe('resolveOptimizeViewData', () => {
  const globalFinding: OptimizeFinding = {
    id: 'opus-on-trivial-turns',
    title: 'global finding',
    detail: '',
    estSavingsPerWeek: 5,
    fixText: '',
  };
  const scopedFinding: OptimizeFinding = {
    id: 'cost-of-thrash',
    title: 'scoped finding',
    detail: '',
    estSavingsPerWeek: 2,
    fixText: '',
  };
  const globalState = {
    optimizeFindings: [globalFinding],
    optimizeSummary: { totalPerWeek: 5, grade: 'B' as const },
    optimizeBreakdown: [],
  };
  const snapshot: ProjectsSnapshot = {
    roots: [
      {
        key: 'aether', name: 'aether-os', worktree: null,
        ledger: {} as any,
        optimize: { findings: [scopedFinding], summary: { totalPerWeek: 2, grade: 'A' as const }, breakdown: [] },
        children: [],
      },
    ],
    unscoped: null,
    computedAtMs: 0,
  };

  it('returns the global findings when nothing is selected', () => {
    const result = resolveOptimizeViewData({ selectedProject: null, projectsSnapshot: snapshot, ...globalState });
    expect(result.findings).toBe(globalState.optimizeFindings);
  });

  it('returns the scoped project\'s findings when a valid project is selected', () => {
    const result = resolveOptimizeViewData({ selectedProject: 'aether', projectsSnapshot: snapshot, ...globalState });
    expect(result.findings).toEqual([scopedFinding]);
    expect(result.summary.grade).toBe('A');
  });

  it('falls back to global findings when the selected key is no longer in the snapshot', () => {
    const result = resolveOptimizeViewData({ selectedProject: 'deleted', projectsSnapshot: snapshot, ...globalState });
    expect(result.findings).toBe(globalState.optimizeFindings);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/optimize/OptimizeView.test.ts`
Expected: FAIL — `OptimizeView.test.ts` imports `resolveOptimizeViewData`, which doesn't exist yet, and the file itself doesn't exist yet either.

- [ ] **Step 3: Implement `resolveOptimizeViewData` and wire it into the component**

In `src/components/optimize/OptimizeView.tsx`, add imports and the function above `export function OptimizeView()`:

```ts
import { findProjectByKey } from '../projects/projectsMath';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';
import type { OptimizeSummary } from '../../shared/optimizeRules';
import type { GradeRow } from '../../shared/optimizeGrade';

export function resolveOptimizeViewData(state: {
  selectedProject: string | null;
  projectsSnapshot: ProjectsSnapshot | null;
  optimizeFindings: OptimizeFinding[];
  optimizeSummary: OptimizeSummary;
  optimizeBreakdown: GradeRow[];
}): {
  findings: (OptimizeFinding & { recurring?: true; appliedAtMs?: number })[];
  summary: OptimizeSummary;
  breakdown: GradeRow[];
} {
  const scoped = findProjectByKey(state.projectsSnapshot, state.selectedProject);
  if (scoped) return { findings: scoped.optimize.findings, summary: scoped.optimize.summary, breakdown: scoped.optimize.breakdown };
  return { findings: state.optimizeFindings, summary: state.optimizeSummary, breakdown: state.optimizeBreakdown };
}
```

Then, inside `OptimizeView()`, replace:

```ts
  const findings = state.optimizeFindings;
  const summary = state.optimizeSummary;
```

with:

```ts
  const { findings, summary, breakdown } = resolveOptimizeViewData(state);
```

And replace the one remaining direct read of `state.optimizeBreakdown` (inside the `breakdownOpen &&` block):

```tsx
          {state.optimizeBreakdown.map((row) => (
```

with:

```tsx
          {breakdown.map((row) => (
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/components/optimize/OptimizeView.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/optimize/OptimizeView.tsx src/components/optimize/OptimizeView.test.ts
git commit -m "feat(optimize): scope OptimizeView to the selected project"
```

---

### Task 6: TopBar scope indicator with clear action

**Files:**
- Modify: `src/components/layout/TopBar.tsx`
- Test: `src/components/layout/TopBar.test.ts` (new)

**Interfaces:**
- Consumes: `findProjectByKey` (same as Tasks 4/5). `dispatch({ type: 'SELECT_PROJECT', key: null })` from Task 3.
- Produces: `resolveScopePillLabel(state): string | null` — exported pure function (same convention as Tasks 4/5), returns the display name when a scope is active, `null` when not. Nothing later depends on this.

- [ ] **Step 1: Write the failing test**

Create `src/components/layout/TopBar.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveScopePillLabel } from './TopBar';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';

describe('resolveScopePillLabel', () => {
  const snapshot: ProjectsSnapshot = {
    roots: [
      {
        key: 'aether', name: 'aether-os', worktree: null,
        ledger: {} as any,
        optimize: { findings: [], summary: { totalPerWeek: 0, grade: 'A' as const }, breakdown: [] },
        children: [
          {
            key: 'aether#wt', name: 'aether-os', worktree: 'statusline-feed',
            ledger: {} as any,
            optimize: { findings: [], summary: { totalPerWeek: 0, grade: 'A' as const }, breakdown: [] },
          },
        ],
      },
    ],
    unscoped: null,
    computedAtMs: 0,
  };

  it('returns null when nothing is selected', () => {
    expect(resolveScopePillLabel({ selectedProject: null, projectsSnapshot: snapshot })).toBeNull();
  });

  it('returns the project name when a root is selected', () => {
    expect(resolveScopePillLabel({ selectedProject: 'aether', projectsSnapshot: snapshot })).toBe('aether-os');
  });

  it('returns the project name when a child (worktree) is selected', () => {
    expect(resolveScopePillLabel({ selectedProject: 'aether#wt', projectsSnapshot: snapshot })).toBe('aether-os');
  });

  it('returns null when the selected key is no longer in the snapshot', () => {
    expect(resolveScopePillLabel({ selectedProject: 'deleted', projectsSnapshot: snapshot })).toBeNull();
  });

  it('returns null when there is no snapshot yet', () => {
    expect(resolveScopePillLabel({ selectedProject: 'aether', projectsSnapshot: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/layout/TopBar.test.ts`
Expected: FAIL — `TopBar.test.ts` and `resolveScopePillLabel` don't exist yet.

- [ ] **Step 3: Implement `resolveScopePillLabel` and the pill UI**

In `src/components/layout/TopBar.tsx`, add imports near the top:

```ts
import { findProjectByKey } from '../projects/projectsMath';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';
```

Add the pure function above `export function TopBar()`:

```ts
export function resolveScopePillLabel(state: {
  selectedProject: string | null;
  projectsSnapshot: ProjectsSnapshot | null;
}): string | null {
  const scoped = findProjectByKey(state.projectsSnapshot, state.selectedProject);
  return scoped?.name ?? null;
}
```

Inside `TopBar()`, add the resolved label near the other derived values at the top:

```ts
  const scopeLabel = resolveScopePillLabel(state);
```

Insert the pill in the JSX right after the flex spacer and before the op-mode group. Replace:

```tsx
      <div style={{ flex: 1 }} />

      <div style={opModeGroupStyle}>
```

with:

```tsx
      <div style={{ flex: 1 }} />

      {scopeLabel && (
        <Button
          title="Clear project scope"
          onClick={() => dispatch({ type: 'SELECT_PROJECT', key: null })}
          style={scopePillStyle(colors)}
        >
          Scoped: {scopeLabel} ×
        </Button>
      )}

      <div style={opModeGroupStyle}>
```

Add the style function alongside the other style functions near the bottom of the file (matching the existing `apprBadgeStyle`/`riskBadgeStyle` pattern):

```ts
function scopePillStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 'none',
    marginRight: 10,
    padding: '6px 12px',
    borderRadius: 8,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelInset,
    font: `600 11px/1 ${fonts.ui}`,
    color: colors.accentCyanSoft,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/components/layout/TopBar.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/TopBar.tsx src/components/layout/TopBar.test.ts
git commit -m "feat(topbar): show and clear the active project scope from any tab"
```

---

### Task 7: Full-suite verification

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS, all suites — including every test added in Tasks 1–6 and all pre-existing tests (no regressions in `projectsSnapshot.test.ts`'s original 9 cases, `LedgerView.test.tsx`'s existing `RollupCard`/`SessionCostCard` tests, `reducer.test.ts`'s existing `SELECT_PROJECT` test).

- [ ] **Step 2: Type-check the whole project**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `npm run electron:build`
Expected: SUCCESS, all three process types (main, preload, renderer).

- [ ] **Step 4: Note deferred verification plainly**

Per this project's established convention (this dev environment is headless, no way to launch and interact with the Electron GUI directly): the TopBar pill's live rendering, and the visual transition between scoped/unscoped `LedgerView`/`OptimizeView`, have not been seen in a running window. State this plainly in the final report rather than implying it was checked.

- [ ] **Step 5: Commit (if any cleanup was needed)**

Only if Steps 1–3 required fixes beyond the six feature commits above:

```bash
git add -A
git commit -m "fix: address full-suite verification findings"
```

If nothing needed fixing, skip this step — there is nothing to commit.
