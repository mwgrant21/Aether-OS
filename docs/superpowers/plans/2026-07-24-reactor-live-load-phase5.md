# Reactor Live Load (Phase 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive the reactor's visuals (pulse speed, overdrive, and a new overload color/glow tier) from real token burn rate and real dispatch concurrency instead of `tick.ts`'s synthetic random walk and the fictional agent roster.

**Architecture:** `state.rate` becomes a pure derivation of `state.realUsage.burnRatePerMin` (computed in the `SET_REAL_USAGE` reducer case, with an idle-floor fallback), replacing `tick.ts`'s random-walk mutation of `rate`. `overdrive`/new `overload` booleans in `useReactorCanvas.ts` switch from `state.agents.length` (fictional) to `state.realAgents.length` (real, live-tailed) at thresholds of 2 and 3. `overload` adds a hue shift (new tier in `computeThemeHueDeg`/`computeThemeFilter`, alongside the existing `alarmLevel` tiers) and a `glowFactor` multiplier.

**Tech Stack:** TypeScript, React, Vitest. No Electron/IPC changes — pure renderer-side derivation from state Phase 2/3 already populate.

## Global Constraints

- `state.agents` (fictional roster) and every other reader of it (Terminal digest, approval simulation, etc.) stays completely untouched — this phase changes only what feeds the reactor.
- No electron-layer / IPC changes.
- Idle floor (`burnRatePerMin === 0` → `state.rate` falls back to `92000`, the existing `initialState` default) so an idle app's pulse looks exactly as it does today.
- `overdrive` threshold: `realAgents.length >= 2`. `overload` threshold: `realAgents.length >= 3`. Flat thresholds, not proportional scaling.
- `alarmLevel`'s existing `warn`/`crit` hue behavior is unchanged; `overload` is additive on top, not a replacement.

---

### Task 1: `computeRateFromUsage` — pure rate derivation + `tick.ts` decoupling

**Files:**
- Modify: `src/components/reactor/reactorMath.ts`
- Modify: `src/components/reactor/reactorMath.test.ts`
- Modify: `src/state/tick.ts`
- Modify: `src/state/tick.test.ts`

**Interfaces:**
- Produces: `computeRateFromUsage(burnRatePerMin: number): number` — exported from `reactorMath.ts`. Returns `burnRatePerMin` clamped to `[20000, 168000]` when `burnRatePerMin > 0`; returns `92000` (idle floor) when `burnRatePerMin <= 0`.
- Consumes (Task 2): reducer's `SET_REAL_USAGE` case will call `computeRateFromUsage(action.snapshot.burnRatePerMin)` to set `state.rate`.

- [ ] **Step 1: Write the failing test for `computeRateFromUsage`**

Add to `src/components/reactor/reactorMath.test.ts` (new `describe` block, after the existing `computeSurge` block):

```typescript
describe('computeRateFromUsage', () => {
  it('falls back to the idle baseline when burn rate is zero', () => {
    expect(computeRateFromUsage(0)).toBe(92000);
  });

  it('falls back to the idle baseline for a negative burn rate', () => {
    expect(computeRateFromUsage(-500)).toBe(92000);
  });

  it('passes through a burn rate already inside the visual range', () => {
    expect(computeRateFromUsage(92000)).toBe(92000);
    expect(computeRateFromUsage(50000)).toBe(50000);
  });

  it('clamps a burn rate below the visual floor', () => {
    expect(computeRateFromUsage(5000)).toBe(20000);
  });

  it('clamps a burn rate above the visual ceiling', () => {
    expect(computeRateFromUsage(400000)).toBe(168000);
  });
});
```

Also update the existing `import` line at the top of the file to include `computeRateFromUsage`:

```typescript
import { advancePhase, computePulseDuration, computeRateFromUsage, computeSurge, computeThemeFilter, computeThemeHueDeg } from './reactorMath';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/reactor/reactorMath.test.ts`
Expected: FAIL with "computeRateFromUsage is not a function" (or a TypeScript import error).

- [ ] **Step 3: Implement `computeRateFromUsage`**

In `src/components/reactor/reactorMath.ts`, add near the top (after the `HUE_MAP` constant):

```typescript
const RATE_MIN = 20000;
const RATE_MAX = 168000;
const RATE_IDLE = 92000;

export function computeRateFromUsage(burnRatePerMin: number): number {
  if (burnRatePerMin <= 0) return RATE_IDLE;
  return Math.max(RATE_MIN, Math.min(RATE_MAX, burnRatePerMin));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/reactor/reactorMath.test.ts`
Expected: PASS, all `computeRateFromUsage` cases green.

- [ ] **Step 5: Decouple `tick.ts` from `state.rate`**

`tick.ts` currently random-walks `rate` toward a target and returns it as part of the tick partial, which overwrites `state.rate` every tick. `state.rate` is about to become owned by the `SET_REAL_USAGE` reducer case (Task 2) — `computeTick` must stop mutating and returning it, while still using the *current* `state.rate` (plus the existing `autoThrottle` cap) for its own `used`/`alarmLevel`/notification math, which stays unchanged in behavior.

Replace `src/state/tick.ts` lines 13–20 (from `export function computeTick` through the `used` line):

```typescript
export function computeTick(state: AetherState): Partial<AetherState> {
  const mode = state.cfg.opMode;
  let effectiveRate = state.rate;
  if (state.cfg.autoThrottle) effectiveRate = Math.min(effectiveRate, state.cfg.alarm * 1000 * 0.8);

  const used = state.used + (effectiveRate / 60) * 0.9 * 0.05;
```

Then update every remaining reference to the old local `rate` variable in the rest of the function body to `effectiveRate`:

- Line 21 area (`ctxUsed`) is unaffected (doesn't reference `rate`).
- Line 29 (`agents` map, `hist` field): change `rate * a.share * (0.85 + Math.random() * 0.3)` to `effectiveRate * a.share * (0.85 + Math.random() * 0.3)`.
- Line 40 (`rateK`): change `const rateK = rate / 1000;` to `const rateK = effectiveRate / 1000;`.

Finally, update the function's `return` statement (was line 73) to drop `rate` from the returned object:

```typescript
  return { used, ctxUsed, weekRaw, agents, sys, alarmLevel: level, notifs, unread, approvals, apprSeq, memories };
```

The unused `target` variable and its computation (old lines 15–18) are removed entirely as part of this replacement — confirm no other line in the file still references `target` or the old local `rate` after this edit (only `effectiveRate` should remain).

- [ ] **Step 6: Update `tick.test.ts` for the new contract**

`computeTick` no longer returns `rate` at all, so the three existing tests asserting on `result.rate` need rewriting to assert on `result.used` (which still reflects the rate-driven budget math) instead. Replace the first three `it` blocks in `src/state/tick.test.ts` (lines 10–32, from `'clamps rate to...'` through the `'is fully deterministic...'` block):

```typescript
  it('does not return a rate field — rate is owned by SET_REAL_USAGE, not TICK', () => {
    const result = computeTick({ ...initialState, rate: 92000, cfg: { ...initialState.cfg, autoThrottle: false } });
    expect(result.rate).toBeUndefined();
  });

  it('auto-throttle caps the effective rate used for budget math at 80% of the alarm threshold', () => {
    const uncapped = computeTick({
      ...initialState,
      rate: 168000,
      cfg: { ...initialState.cfg, autoThrottle: false, alarm: 120 },
    });
    const capped = computeTick({
      ...initialState,
      rate: 168000,
      cfg: { ...initialState.cfg, autoThrottle: true, alarm: 120 },
    });
    expect(capped.used!).toBeLessThan(uncapped.used!);
  });

  it('is fully deterministic with Math.random pinned to 0.5', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const state = { ...initialState, rate: 84000, agents: [], cfg: { ...initialState.cfg, opMode: 'EDITS' as const, autoThrottle: true, alarm: 120 } };
    const result = computeTick(state);
    expect(result.used).toBeCloseTo(state.used + (84000 / 60) * 0.9 * 0.05, 5);
    expect(result.alarmLevel).toBe('ok');
    expect(result.approvals).toEqual(state.approvals);
  });
```

The remaining tests in the file (`'flips alarmLevel to crit...'` through the end) are unaffected — they don't assert on `result.rate` and continue to pass unchanged, since `alarmLevel`'s computation still runs off `effectiveRate` derived from the `rate` each test already seeds into its input state.

- [ ] **Step 7: Run both test files to verify everything passes**

Run: `npx vitest run src/components/reactor/reactorMath.test.ts src/state/tick.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 8: Typecheck**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/components/reactor/reactorMath.ts src/components/reactor/reactorMath.test.ts src/state/tick.ts src/state/tick.test.ts
git commit -m "feat: add computeRateFromUsage, decouple tick.ts from state.rate"
```

---

### Task 2: Wire `state.rate` to `SET_REAL_USAGE`

**Files:**
- Modify: `src/state/reducer.ts`
- Modify: `src/state/reducer.test.ts`

**Interfaces:**
- Consumes: `computeRateFromUsage` from `src/components/reactor/reactorMath.ts` (Task 1).
- Produces: `SET_REAL_USAGE` now also sets `state.rate`, in addition to `state.realUsage`, for every downstream consumer (`useReactorCanvas.ts`, `computeTick`, `dashboardMath.ts`, etc. — none of which need changes here, since they already read `state.rate` by name).

- [ ] **Step 1: Write the failing tests**

Add to `src/state/reducer.test.ts` (new `describe` block; place it near the other top-level action `describe` blocks, e.g. after the `SET_REAL_AGENTS` blocks):

```typescript
describe('SET_REAL_USAGE', () => {
  it('derives state.rate from the snapshot burn rate', () => {
    const snapshot = { ...initialState.realUsage, burnRatePerMin: 50000 };
    const next = reducer(initialState, { type: 'SET_REAL_USAGE', snapshot });
    expect(next.rate).toBe(50000);
    expect(next.realUsage).toBe(snapshot);
  });

  it('falls back to the idle baseline rate when the snapshot burn rate is zero', () => {
    const snapshot = { ...initialState.realUsage, burnRatePerMin: 0 };
    const withElevatedRate = { ...initialState, rate: 150000 };
    const next = reducer(withElevatedRate, { type: 'SET_REAL_USAGE', snapshot });
    expect(next.rate).toBe(92000);
  });

  it('clamps an extreme snapshot burn rate into the visual range', () => {
    const snapshot = { ...initialState.realUsage, burnRatePerMin: 900000 };
    const next = reducer(initialState, { type: 'SET_REAL_USAGE', snapshot });
    expect(next.rate).toBe(168000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/state/reducer.test.ts -t "SET_REAL_USAGE"`
Expected: FAIL — `next.rate` still reflects `initialState.rate`/whatever was seeded, not the derived value (the reducer case doesn't yet touch `rate`).

- [ ] **Step 3: Implement**

In `src/state/reducer.ts`, add the import (alongside the existing `liveAgentsMath` import line):

```typescript
import { computeRateFromUsage } from '../components/reactor/reactorMath';
```

Replace the `SET_REAL_USAGE` case (currently `return { ...state, realUsage: action.snapshot };`):

```typescript
    case 'SET_REAL_USAGE':
      return { ...state, realUsage: action.snapshot, rate: computeRateFromUsage(action.snapshot.burnRatePerMin) };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/state/reducer.test.ts -t "SET_REAL_USAGE"`
Expected: PASS.

- [ ] **Step 5: Run the full reducer suite to confirm no regression**

Run: `npx vitest run src/state/reducer.test.ts`
Expected: PASS, all tests green (existing `SET_REAL_AGENTS`/`RECORD_DISPATCH_USAGE`/approval-resolution tests unaffected — none of them dispatch `SET_REAL_USAGE`).

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/state/reducer.ts src/state/reducer.test.ts
git commit -m "feat: derive state.rate from real usage on SET_REAL_USAGE"
```

---

### Task 3: `overload` tier in `reactorMath.ts` (hue + filter)

**Files:**
- Modify: `src/components/reactor/reactorMath.ts`
- Modify: `src/components/reactor/reactorMath.test.ts`

**Interfaces:**
- Produces: `computeThemeHueDeg(theme: ThemeName, alarmLevel: AlarmLevel, overload?: boolean): number` and `computeThemeFilter(theme: ThemeName, alarmLevel: AlarmLevel, glowFx: boolean, overload?: boolean): string` — both gain an optional trailing `overload` parameter (default `false`), so every existing 2-arg/3-arg call site in the codebase keeps compiling and behaving identically.
- Consumes (Task 4): `useReactorCanvas.ts` will pass its computed `overload` boolean as the new trailing argument to `computeThemeFilter`.

- [ ] **Step 1: Write the failing tests**

Add to `src/components/reactor/reactorMath.test.ts`, inside the existing `describe('computeThemeHueDeg', ...)` block (after the `'alarm level overrides the chosen theme'` test):

```typescript
  it('overload adds a hue shift on top of the base theme', () => {
    const base = computeThemeHueDeg('cyan', 'ok', false);
    const overloaded = computeThemeHueDeg('cyan', 'ok', true);
    expect(overloaded).not.toBe(base);
  });

  it('overload layers on top of an active alarm level rather than being overridden by it', () => {
    const warnOnly = computeThemeHueDeg('cyan', 'warn', false);
    const warnAndOverload = computeThemeHueDeg('cyan', 'warn', true);
    expect(warnAndOverload).not.toBe(warnOnly);
  });

  it('defaults to no overload shift when the parameter is omitted', () => {
    expect(computeThemeHueDeg('cyan', 'ok')).toBe(computeThemeHueDeg('cyan', 'ok', false));
  });
```

And inside the existing `describe('computeThemeFilter', ...)` block:

```typescript
  it('overload changes the filter string even when alarmLevel and glowFx are unchanged', () => {
    const base = computeThemeFilter('cyan', 'ok', true, false);
    const overloaded = computeThemeFilter('cyan', 'ok', true, true);
    expect(overloaded).not.toBe(base);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/reactor/reactorMath.test.ts`
Expected: FAIL — `computeThemeHueDeg`/`computeThemeFilter` don't yet accept a fourth/third `overload` argument, so overloaded output equals base output.

- [ ] **Step 3: Implement**

In `src/components/reactor/reactorMath.ts`, replace `computeThemeHueDeg` and `computeThemeFilter`:

```typescript
const OVERLOAD_HUE_SHIFT = 40;

export function computeThemeHueDeg(theme: ThemeName, alarmLevel: AlarmLevel, overload: boolean = false): number {
  let hueDeg = HUE_MAP[theme] ?? 0;
  if (alarmLevel === 'warn') hueDeg = -150;
  else if (alarmLevel === 'crit') hueDeg = 165;
  if (overload) hueDeg += OVERLOAD_HUE_SHIFT;
  return hueDeg;
}

export function computeThemeFilter(theme: ThemeName, alarmLevel: AlarmLevel, glowFx: boolean, overload: boolean = false): string {
  const hueDeg = computeThemeHueDeg(theme, alarmLevel, overload);
  const overloadBrightness = overload ? ' brightness(1.15)' : '';
  return `hue-rotate(${hueDeg}deg)` + (glowFx === false ? ' saturate(.75) brightness(.92)' : '') + overloadBrightness;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/reactor/reactorMath.test.ts`
Expected: PASS, all tests green including the pre-existing ones (unaffected by the new optional parameter).

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/reactor/reactorMath.ts src/components/reactor/reactorMath.test.ts
git commit -m "feat: add overload hue/brightness tier to reactorMath"
```

---

### Task 4: Wire `overdrive`/`overload` to real dispatch count in `useReactorCanvas.ts`

**Files:**
- Modify: `src/components/reactor/useReactorCanvas.ts`
- Create: `src/components/reactor/useReactorCanvas.test.ts`

**Interfaces:**
- Consumes: `computeThemeFilter` (now 4-arg, Task 3) from `reactorMath.ts`.
- Produces: no new exports — `ReactorFrame.overdrive` (existing field) now reflects `state.realAgents.length >= 2` instead of the fictional roster; a new local `overload` boolean (`state.realAgents.length >= 3`) is applied to the canvas `filter` and a `glowFactor` multiplier, both computed inline in the `runFrame` closure and not exposed as new `ReactorFrame` fields (nothing downstream in `ReactorCore.tsx` needs `overload` directly — the visual effects it drives are fully applied before `draw()` is called).

This file's core logic (`runFrame`) isn't unit-testable in isolation today (no existing test file) since it's a `requestAnimationFrame`-driven closure over refs and canvas elements — this task adds a small new test file covering only the two new pure threshold computations, extracted as a testable helper, rather than attempting to test the whole rAF loop.

- [ ] **Step 1: Extract and test the threshold logic as a pure function**

Add a new small pure function to `src/components/reactor/reactorMath.ts` (same file as Task 1/3's additions, since it's reactor-visual math):

```typescript
export interface DispatchIntensity {
  overdrive: boolean;
  overload: boolean;
  glowMultiplier: number;
}

export function computeDispatchIntensity(realAgentCount: number): DispatchIntensity {
  const overdrive = realAgentCount >= 2;
  const overload = realAgentCount >= 3;
  return { overdrive, overload, glowMultiplier: overload ? 1.25 : 1 };
}
```

Write the test first in `src/components/reactor/reactorMath.test.ts` (new `describe` block):

```typescript
describe('computeDispatchIntensity', () => {
  it('is neither overdrive nor overload with 0 or 1 concurrent dispatches', () => {
    expect(computeDispatchIntensity(0)).toEqual({ overdrive: false, overload: false, glowMultiplier: 1 });
    expect(computeDispatchIntensity(1)).toEqual({ overdrive: false, overload: false, glowMultiplier: 1 });
  });

  it('is overdrive but not overload at exactly 2 concurrent dispatches', () => {
    expect(computeDispatchIntensity(2)).toEqual({ overdrive: true, overload: false, glowMultiplier: 1 });
  });

  it('is both overdrive and overload at 3 or more concurrent dispatches', () => {
    expect(computeDispatchIntensity(3)).toEqual({ overdrive: true, overload: true, glowMultiplier: 1.25 });
    expect(computeDispatchIntensity(9)).toEqual({ overdrive: true, overload: true, glowMultiplier: 1.25 });
  });
});
```

Update the `import` line in `reactorMath.test.ts` to include `computeDispatchIntensity`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/reactor/reactorMath.test.ts`
Expected: FAIL with "computeDispatchIntensity is not a function".

- [ ] **Step 3: Confirm it passes once the function above is added**

Run: `npx vitest run src/components/reactor/reactorMath.test.ts`
Expected: PASS.

- [ ] **Step 4: Wire it into `useReactorCanvas.ts`**

In `src/components/reactor/useReactorCanvas.ts`, update the import line (currently `import { advancePhase, computePulseDuration, computeSurge, computeThemeFilter } from './reactorMath';`):

```typescript
import { advancePhase, computeDispatchIntensity, computePulseDuration, computeSurge, computeThemeFilter } from './reactorMath';
```

Replace this line (currently `const overdrive = s.agents.length >= 7;`):

```typescript
        const { overdrive, overload, glowMultiplier } = computeDispatchIntensity(s.realAgents.length);
```

Replace the `glowFactor` line (currently `const glowFactor = (s.cfg.glow == null ? 70 : s.cfg.glow) / 70;`):

```typescript
        const glowFactor = ((s.cfg.glow == null ? 70 : s.cfg.glow) / 70) * glowMultiplier;
```

Replace the `themeFilter` line (currently `const themeFilter = computeThemeFilter(s.cfg.theme, s.alarmLevel, s.cfg.glowFx);`):

```typescript
        const themeFilter = computeThemeFilter(s.cfg.theme, s.alarmLevel, s.cfg.glowFx, overload);
```

- [ ] **Step 5: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS, all tests green (369+ tests, plus the new ones added in this plan).

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 7: Manual verification (documented, not automated — same precedent as every prior Electron-window check in this project)**

This step cannot be performed by the controller (Claude-in-Chrome targets Chrome tabs, not the native `electron:dev` window) — defer to the user, matching the established precedent from Phase 4 and "Files → Attachments." Document in the commit/PROGRESS.md entry that manual verification of the following was deferred:
- Idle state (no real dispatches running): pulse looks the same as before this phase (steady, baseline rate).
- One real dispatch running: pulse speeds up somewhat (rate-driven), but no overdrive/overload visual kick.
- Two concurrent real dispatches: overdrive kicks in (faster surge/pulse), no color shift yet.
- Three or more concurrent real dispatches: overload kicks in — visible hue shift and brighter glow on top of overdrive.
- `renderer: 'volumetric'`, `'classic'` (nebula), and `'warp'` modes all visibly respond to the above (Settings → renderer toggle).

- [ ] **Step 8: Commit**

```bash
git add src/components/reactor/reactorMath.ts src/components/reactor/reactorMath.test.ts src/components/reactor/useReactorCanvas.ts
git commit -m "feat: drive reactor overdrive/overload from real dispatch concurrency"
```

---

### Task 5: Final verification and `PROGRESS.md` ledger entry

**Files:**
- Modify: `PROGRESS.md`

**Interfaces:**
- None — documentation-only task, matching this project's established SDD pattern of a final ledger entry per phase (see Phase 4's entry for the dense-paragraph style to match).

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, full green suite, no regressions.

- [ ] **Step 2: Run the full build**

Run: `npm run build`
Expected: clean build, no errors.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 4: Append the Phase 5 entry to `PROGRESS.md`**

Add a new bullet at the top of the "Shipped plans (newest first)" list (above the Phase 4 entry), in the project's established dense-paragraph style, covering: what was replaced (`tick.ts`'s random walk → `computeRateFromUsage` off `state.realUsage.burnRatePerMin`, sourced in the `SET_REAL_USAGE` reducer case), the idle-floor behavior, the `overdrive`/`overload` thresholds and what `overload` visually adds (hue shift + glow bump, layered on `alarmLevel`'s existing tiers, not replacing them), that `state.agents`/the fictional simulation are untouched, and that manual `electron:dev` verification of the visual thresholds was deferred to the user per established precedent. Also update the "Right now" section's opening framing to note Phase 5 is shipped.

- [ ] **Step 5: Commit**

```bash
git add PROGRESS.md
git commit -m "docs: close out Phase 5 (Reactor Live Load) in PROGRESS.md ledger"
```
