# Reactor Redesign (Stage 8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the reactor's tangled six-plus-signal visual encoding with exactly three
nameable axes — Momentum (pulse speed, from real burn-rate trend), Pressure (hue, from real
rate-limit window usage), and Concurrency (glow/turbulence, from real dispatch count,
unchanged) — per `docs/superpowers/specs/2026-07-30-reactor-redesign-stage8-design.md`.

**Architecture:** Pure-function changes in `reactorMath.ts` plus the reducer/tick wiring that
feeds them. No IPC, no electron-layer, no WebGL shader changes. Cache clarity and per-model
hue shift are deleted outright, not replaced.

**Tech Stack:** TypeScript, Vitest, React (renderer state only — no new components).

## Global Constraints

- `state.cfg.alarm` and `state.cfg.autoThrottle` are **not removed** — they still drive
  `tick.ts`'s unrelated budget-simulation `effectiveRate` cap and `BudgetAlertsCard.tsx`'s UI.
  Only `state.alarmLevel`'s *source* changes, from `cfg.alarm` to `state.statusline`. (This
  corrects the design spec's "removed along with the old computation" line for `cfg.alarm` —
  that phrasing was too broad; the spec's actual intent, confirmed against the codebase, is
  that `cfg.alarm` stops feeding the reactor specifically.)
- Pressure thresholds: `warn` at 75% (`fiveHour`/`sevenDay` `usedPercentage`, whichever is
  higher), `crit` at 90%.
- Momentum window: last 3 `burnRatePerMin` samples; delta clamped to ±6000 tokens/min maps
  onto the existing `RATE_MIN`(20000)–`RATE_MAX`(168000) visual range, with `RATE_IDLE`(92000)
  as the zero-delta / insufficient-history center point.
- `glShader.ts`'s `drawCoreGL` keeps its `clarity: number` parameter (WebGL uniform,
  untouched — no display in this dev environment to verify a shader change against). Callers
  pass a constant `1` instead of `computeCacheClarity(state.cacheHitRatio)`.
- Run `npm test` (root) after every task; run it again at the very end alongside a TypeScript
  check.

---

### Task 1: `computeMomentum` replaces `computeRateFromUsage`

**Files:**
- Modify: `src/components/reactor/reactorMath.ts`
- Test: `src/components/reactor/reactorMath.test.ts`

**Interfaces:**
- Produces: `export interface RateSample { burnRatePerMin: number; atMs: number }` and
  `export function computeMomentum(history: RateSample[]): number` — used by Task 2's reducer
  wiring.
- `computeRateFromUsage` is deleted; no other task depends on it.

- [ ] **Step 1: Write the failing tests**

Replace the existing `describe('computeRateFromUsage', ...)` block in
`src/components/reactor/reactorMath.test.ts` (and its import of `computeRateFromUsage`) with:

```ts
describe('computeMomentum', () => {
  it('reads as the idle baseline with zero samples', () => {
    expect(computeMomentum([])).toBe(92000);
  });

  it('reads as the idle baseline with fewer than 3 samples (insufficient history)', () => {
    expect(computeMomentum([{ burnRatePerMin: 9000, atMs: 1 }, { burnRatePerMin: 100, atMs: 2 }])).toBe(92000);
  });

  it('reads as the idle baseline when burn rate is flat across the window', () => {
    const history = [
      { burnRatePerMin: 4000, atMs: 1 },
      { burnRatePerMin: 4000, atMs: 2 },
      { burnRatePerMin: 4000, atMs: 3 },
    ];
    expect(computeMomentum(history)).toBe(92000);
  });

  it('rises toward the visual ceiling as burn rate climbs across the window', () => {
    const history = [
      { burnRatePerMin: 1000, atMs: 1 },
      { burnRatePerMin: 4000, atMs: 2 },
      { burnRatePerMin: 7000, atMs: 3 },
    ];
    expect(computeMomentum(history)).toBe(168000);
  });

  it('falls toward the visual floor as burn rate drops across the window', () => {
    const history = [
      { burnRatePerMin: 7000, atMs: 1 },
      { burnRatePerMin: 4000, atMs: 2 },
      { burnRatePerMin: 1000, atMs: 3 },
    ];
    expect(computeMomentum(history)).toBe(20000);
  });

  it('clamps a rise steeper than the momentum range to the visual ceiling', () => {
    const history = [
      { burnRatePerMin: 0, atMs: 1 },
      { burnRatePerMin: 50000, atMs: 2 },
      { burnRatePerMin: 100000, atMs: 3 },
    ];
    expect(computeMomentum(history)).toBe(168000);
  });

  it('only considers the most recent 3 samples when more are present', () => {
    const history = [
      { burnRatePerMin: 9000, atMs: 0 }, // older sample outside the window, must be ignored
      { burnRatePerMin: 1000, atMs: 1 },
      { burnRatePerMin: 4000, atMs: 2 },
      { burnRatePerMin: 7000, atMs: 3 },
    ];
    expect(computeMomentum(history)).toBe(168000);
  });
});
```

Also delete these now-obsolete `describe` blocks and their imports (Task 4 removes the rest;
this task only removes what `computeRateFromUsage`'s removal makes dead):
none yet — leave `computeCacheClarity`/`computeModelHueShift`/`dominantModel` tests in place
for Task 4.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- reactorMath` (from `C:/Users/Matt/projects/aether-os`)
Expected: FAIL — `computeMomentum` is not exported / not defined.

- [ ] **Step 3: Implement `computeMomentum`, remove `computeRateFromUsage`**

In `src/components/reactor/reactorMath.ts`, replace the `computeRateFromUsage` block (lines
9–22 in the current file, including its comment) with:

```ts
export interface RateSample {
  burnRatePerMin: number;
  atMs: number;
}

const MOMENTUM_WINDOW = 3;
// tokens/min delta across the window that reads as the max visual rise/fall; a starting
// point, adjustable later without architectural change (same posture as REAL_BURN_CEILING
// before it).
const MOMENTUM_RANGE = 6000;

export function computeMomentum(history: RateSample[]): number {
  if (history.length < MOMENTUM_WINDOW) return RATE_IDLE;
  const window = history.slice(-MOMENTUM_WINDOW);
  const delta = window[window.length - 1].burnRatePerMin - window[0].burnRatePerMin;
  const clamped = Math.max(-MOMENTUM_RANGE, Math.min(MOMENTUM_RANGE, delta));
  if (clamped >= 0) return Math.round(RATE_IDLE + (clamped / MOMENTUM_RANGE) * (RATE_MAX - RATE_IDLE));
  return Math.round(RATE_IDLE + (clamped / MOMENTUM_RANGE) * (RATE_IDLE - RATE_MIN));
}
```

Keep `RATE_MIN`, `RATE_MAX`, `RATE_IDLE` constants as they are (still used by
`computePulseDuration` and now by `computeMomentum`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- reactorMath`
Expected: PASS for all `computeMomentum` cases. Other blocks in the file still reference
`computeRateFromUsage` in their imports at this point only if you haven't removed the import —
remove `computeRateFromUsage` from the `import { ... } from './reactorMath'` line and add
`computeMomentum` in its place.

- [ ] **Step 5: Commit**

```bash
git add src/components/reactor/reactorMath.ts src/components/reactor/reactorMath.test.ts
git commit -m "feat: add computeMomentum, replacing level-based computeRateFromUsage"
```

---

### Task 2: Wire Momentum into the reducer's `SET_REAL_USAGE` handler

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/persistence.ts`
- Modify: `src/state/reducer.ts`
- Test: `src/state/reducer.test.ts`

**Interfaces:**
- Consumes: `computeMomentum(history: RateSample[]): number`, `RateSample` from Task 1.
- Produces: `AetherState.rateHistory: RateSample[]` — no other task reads this directly, but
  it must exist on `AetherState` and `initialState` for the app to type-check and for
  `persistence.test.ts`'s coverage check to pass.

- [ ] **Step 1: Write the failing tests**

In `src/state/reducer.test.ts`, replace the existing `describe('SET_REAL_USAGE', ...)` block
(the one asserting `next.rate` via `computeRateFromUsage`) with:

```ts
describe('SET_REAL_USAGE', () => {
  it('stays at the idle baseline on the first snapshot (insufficient history)', () => {
    const snapshot = { ...initialState.realUsage, burnRatePerMin: 6150 };
    const next = reducer(initialState, { type: 'SET_REAL_USAGE', snapshot });
    expect(next.rate).toBe(92000);
    expect(next.rateHistory).toHaveLength(1);
    expect(next.realUsage).toBe(snapshot);
  });

  it('stays at the idle baseline with only two accumulated snapshots', () => {
    const first = reducer(initialState, { type: 'SET_REAL_USAGE', snapshot: { ...initialState.realUsage, burnRatePerMin: 1000 } });
    const second = reducer(first, { type: 'SET_REAL_USAGE', snapshot: { ...initialState.realUsage, burnRatePerMin: 5000 } });
    expect(second.rate).toBe(92000);
    expect(second.rateHistory).toHaveLength(2);
  });

  it('rises toward the visual ceiling once three rising snapshots accumulate', () => {
    let s = initialState;
    for (const burnRatePerMin of [1000, 4000, 7000]) {
      s = reducer(s, { type: 'SET_REAL_USAGE', snapshot: { ...initialState.realUsage, burnRatePerMin } }) as typeof initialState;
    }
    expect(s.rate).toBe(168000);
  });

  it('keeps only the most recent 3 samples in rateHistory', () => {
    let s = initialState;
    for (const burnRatePerMin of [1000, 2000, 3000, 4000]) {
      s = reducer(s, { type: 'SET_REAL_USAGE', snapshot: { ...initialState.realUsage, burnRatePerMin } }) as typeof initialState;
    }
    expect(s.rateHistory).toHaveLength(3);
    expect(s.rateHistory.map((r) => r.burnRatePerMin)).toEqual([2000, 3000, 4000]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- reducer.test`
Expected: FAIL — `computeRateFromUsage` import no longer resolves once Task 1 removed it (if
not already updated), or `rateHistory` is `undefined`.

- [ ] **Step 3: Add `rateHistory` to state, wire the reducer**

In `src/state/types.ts`, add a new import alongside the existing `import type` block near the
top of the file (it already has one for `StatuslineSnapshot` — add this line next to it):

```ts
import type { RateSample } from '../components/reactor/reactorMath';
```

Then add to `AetherState` (near `realUsage`, e.g. directly below it):

```ts
  rateHistory: RateSample[];
```

In `src/state/initialState.ts`, add:

```ts
  rateHistory: [],
```

(placed near `realUsage`'s initializer, wherever that is defined further down the file).

In `src/state/persistence.ts`, add to `PERSISTENCE_EXCLUSIONS`:

```ts
  rateHistory: 'a live rolling window of real burn-rate samples feeding computeMomentum; a persisted value would seed a new session\'s Momentum reading with a previous session\'s trend',
```

In `src/state/reducer.ts`:
- Change the import on line 9 from `computeRateFromUsage` to `computeMomentum`.
- Replace the `SET_REAL_USAGE` case (lines 185–191) with:

```ts
    case 'SET_REAL_USAGE': {
      const rateHistory = state.rateHistory.concat({ burnRatePerMin: action.snapshot.burnRatePerMin, atMs: Date.now() }).slice(-3);
      return {
        ...state,
        realUsage: action.snapshot,
        ctxUsed: action.snapshot.ctxUsed,
        rateHistory,
        rate: computeMomentum(rateHistory),
      };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- reducer.test`
Expected: PASS. Then run `npm test -- persistence.test` — the coverage test will fail if
`rateHistory` was added to `types.ts`/`initialState.ts` but not to `PERSISTENCE_EXCLUSIONS`;
confirm it passes.

- [ ] **Step 5: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/state/persistence.ts src/state/reducer.ts src/state/reducer.test.ts
git commit -m "feat: wire computeMomentum into SET_REAL_USAGE via a 3-sample rateHistory"
```

---

### Task 3: Pressure — `alarmLevel` sourced from real rate-limit usage, not `cfg.alarm`

**Files:**
- Modify: `src/state/tick.ts`
- Test: `src/state/tick.test.ts`

**Interfaces:**
- Consumes: `state.statusline: StatuslineSnapshot | null` (already on `AetherState`, shipped
  in Stage 1 — no change needed to its type).
- No other task depends on this task's internals; `alarmLevel: AlarmLevel` stays the same
  type consumed by `reactorMath.ts`'s `computeThemeHueDeg`/`computeThemeFilter`/
  `computePulseDuration` (Task 4/5 touch those signatures for other reasons, not this one).

- [ ] **Step 1: Write the failing tests**

In `src/state/tick.test.ts`, replace the test named `'flips alarmLevel to crit and fires a
notification when the burn rate crosses the alarm threshold'` (lines 38–45) with:

```ts
  function statuslineWith(fiveHourPct: number | null, sevenDayPct: number | null) {
    return {
      capturedAtMs: 0,
      sessionId: null,
      modelId: null,
      modelDisplayName: null,
      fiveHour: fiveHourPct === null ? null : { usedPercentage: fiveHourPct, resetsAtMs: 0 },
      sevenDay: sevenDayPct === null ? null : { usedPercentage: sevenDayPct, resetsAtMs: 0 },
      contextUsedPercentage: null,
      contextWindowSize: null,
      contextUsage: null,
      totalCostUsd: null,
      currentDir: null,
      projectDir: null,
    };
  }

  it('alarmLevel stays ok when statusline is null (no rate-limit data yet)', () => {
    const state = { ...initialState, agents: [], statusline: null };
    const result = computeTick(state);
    expect(result.alarmLevel).toBe('ok');
  });

  it('alarmLevel flips to warn at 75% rate-limit usage', () => {
    const state = { ...initialState, agents: [], statusline: statuslineWith(80, 10) };
    const result = computeTick(state);
    expect(result.alarmLevel).toBe('warn');
  });

  it('flips alarmLevel to crit and fires a notification when rate-limit usage crosses 90%', () => {
    const state = { ...initialState, agents: [], statusline: statuslineWith(95, 10) };
    const result = computeTick(state);
    expect(result.alarmLevel).toBe('crit');
    expect(result.notifs).toHaveLength(1);
    expect(result.notifs![0].m).toContain('RATE LIMIT ALARM');
    expect(result.unread).toBe(1);
  });

  it('uses the higher of fiveHour/sevenDay usedPercentage', () => {
    const state = { ...initialState, agents: [], statusline: statuslineWith(20, 95) };
    const result = computeTick(state);
    expect(result.alarmLevel).toBe('crit');
  });
```

Leave the other existing tests (`does not return a rate field`, `auto-throttle caps...`, `is
fully deterministic...`) untouched — they exercise `cfg.alarm`'s unrelated `autoThrottle`
role, which this task does not change.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tick.test`
Expected: FAIL — `alarmLevel` still derives from `cfg.alarm`/`rate`, not `statusline`, so the
new expectations don't match.

- [ ] **Step 3: Implement the Pressure computation**

In `src/state/tick.ts`, replace lines 36–38:

```ts
  const alarm = state.cfg.alarm;
  const rateK = effectiveRate / 1000;
  const level: AlarmLevel = rateK >= alarm ? 'crit' : rateK >= alarm * 0.85 ? 'warn' : 'ok';
```

with:

```ts
  const pressure = state.statusline
    ? Math.max(state.statusline.fiveHour?.usedPercentage ?? 0, state.statusline.sevenDay?.usedPercentage ?? 0)
    : 0;
  const level: AlarmLevel = pressure >= 90 ? 'crit' : pressure >= 75 ? 'warn' : 'ok';
```

Then update the notification text at lines 44–48 (inside the `if (level !== state.alarmLevel
&& level !== 'ok')` block) from:

```ts
        m: level === 'crit' ? `BURN ALARM — rate exceeds ${alarm}K/min` : 'Burn elevated — approaching alarm threshold',
```

to:

```ts
        m: level === 'crit' ? `RATE LIMIT ALARM — usage at ${Math.round(pressure)}%` : 'Rate limit elevated — approaching threshold',
```

`effectiveRate` and `state.cfg.alarm` (used two lines above, in the `autoThrottle` cap) are
otherwise untouched — do not remove them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tick.test`
Expected: PASS for all tick tests.

- [ ] **Step 5: Commit**

```bash
git add src/state/tick.ts src/state/tick.test.ts
git commit -m "feat: derive alarmLevel (Pressure) from real rate-limit usage, not cfg.alarm"
```

---

### Task 4: Remove cache clarity and per-model hue shift from `reactorMath.ts`

**Files:**
- Modify: `src/components/reactor/reactorMath.ts`
- Test: `src/components/reactor/reactorMath.test.ts`

**Interfaces:**
- Removes: `computeCacheClarity`, `computeModelHueShift`, `dominantModel`.
- Changes: `computeThemeHueDeg(theme, alarmLevel, overload)` and
  `computeThemeFilter(theme, alarmLevel, glowFx, overload)` drop their `modelHueShift`
  parameter entirely (was previously an optional 5th/4th param with a `= 0` default).
- Produces (unchanged signature, for Task 5): `computeThemeFilter(theme: ThemeName, alarmLevel: AlarmLevel, glowFx: boolean, overload?: boolean): string`.

- [ ] **Step 1: Update the failing tests**

In `src/components/reactor/reactorMath.test.ts`:
- Delete the `describe('computeCacheClarity', ...)`, `describe('dominantModel', ...)`, and
  `describe('computeModelHueShift', ...)` blocks entirely.
- Remove `computeCacheClarity`, `computeModelHueShift`, `dominantModel` from the top `import`
  block.
- `describe('computeThemeHueDeg', ...)` needs no changes — none of its assertions pass a
  `modelHueShift` argument (that parameter only ever existed on `computeThemeFilter`).
- In `describe('computeThemeFilter', ...)`, delete these two `it` blocks entirely (both
  exercise the now-removed 5th `modelHueShift` argument):

```ts
  it('the 4-arg call form is unchanged (modelHueShift defaults to 0)', () => {
    expect(computeThemeFilter('cyan', 'ok', true)).toBe('hue-rotate(0deg)');
    expect(computeThemeFilter('violet', 'warn', false, true)).toBe(
      computeThemeFilter('violet', 'warn', false, true, 0)
    );
  });

  it('a 5th-arg modelHueShift shifts the hue on top of the existing shifts', () => {
    expect(computeThemeFilter('cyan', 'ok', true, false, -60)).toBe('hue-rotate(-60deg)');
    expect(computeThemeFilter('cyan', 'ok', true, true, 90)).toBe('hue-rotate(130deg) brightness(1.15)');
  });
```

  Leave `describe('computeThemeFilter', ...)`'s other two `it` blocks (`'builds a hue-rotate
  string...'` and `'overload changes the filter string...'`) untouched — neither uses
  `modelHueShift`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- reactorMath`
Expected: FAIL — the file still imports/exports the functions being removed, or a remaining
test still calls the old signature.

- [ ] **Step 3: Implement the removal**

In `src/components/reactor/reactorMath.ts`:
- Delete the `computeCacheClarity` function and its `CACHE_CLARITY_MIN` constant.
- Delete the `dominantModel` function.
- Delete the `computeModelHueShift` function and its `MODEL_HUE_SHIFTS` array.
- Change:

```ts
export function computeThemeHueDeg(theme: ThemeName, alarmLevel: AlarmLevel, overload: boolean = false): number {
  let hueDeg = HUE_MAP[theme] ?? 0;
  if (alarmLevel === 'warn') hueDeg = -150;
  else if (alarmLevel === 'crit') hueDeg = 165;
  if (overload) hueDeg += OVERLOAD_HUE_SHIFT;
  return hueDeg;
}

export function computeThemeFilter(theme: ThemeName, alarmLevel: AlarmLevel, glowFx: boolean, overload: boolean = false, modelHueShift: number = 0): string {
  let hueDeg = computeThemeHueDeg(theme, alarmLevel, overload);
  hueDeg += modelHueShift;
  const overloadBrightness = overload ? ' brightness(1.15)' : '';
  return `hue-rotate(${hueDeg}deg)` + (glowFx === false ? ' saturate(.75) brightness(.92)' : '') + overloadBrightness;
}
```

to:

```ts
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- reactorMath`
Expected: PASS. Note this task alone will leave `useReactorCanvas.ts` and `Reactor.tsx`
type-broken (they still import/call the removed functions) — that's expected here and fixed
in Task 5. Confirm with `npm test -- reactorMath` specifically, not the full suite, at this
step.

- [ ] **Step 5: Commit**

```bash
git add src/components/reactor/reactorMath.ts src/components/reactor/reactorMath.test.ts
git commit -m "feat: remove cache-clarity and per-model hue shift from reactorMath"
```

---

### Task 5: Update reactor call sites (`useReactorCanvas.ts`, `ReactorCore.tsx`, `Reactor.tsx`)

**Files:**
- Modify: `src/components/reactor/useReactorCanvas.ts`
- Modify: `src/components/reactor/ReactorCore.tsx`
- Modify: `src/components/reactor/Reactor.tsx`

**Interfaces:**
- Consumes: `computeThemeFilter(theme, alarmLevel, glowFx, overload?)` (Task 4's new
  signature); `drawCoreGL`'s existing `{ clarity: number; ... }` param shape (unchanged, in
  `glShader.ts` — not modified by this task).

- [ ] **Step 1: Update `useReactorCanvas.ts`**

Remove `computeCacheClarity`, `computeModelHueShift`, `dominantModel` from the import block
(lines 3–13). Replace:

```ts
        const clarity = computeCacheClarity(s.cacheHitRatio);
        const turbulence = computeConcurrencyTurbulence(s.realAgents.length);
        const modelHueShift = computeModelHueShift(dominantModel(s.realAgents));
        const themeFilter = computeThemeFilter(s.cfg.theme, s.alarmLevel, s.cfg.glowFx, overload, modelHueShift);
```

with:

```ts
        const clarity = 1; // cache-clarity axis removed (Stage 8) — full clarity always
        const turbulence = computeConcurrencyTurbulence(s.realAgents.length);
        const themeFilter = computeThemeFilter(s.cfg.theme, s.alarmLevel, s.cfg.glowFx, overload);
```

`ReactorFrame`'s interface (lines 15–28) keeps its `clarity: number` field unchanged — only
what computes the value changes.

- [ ] **Step 2: Update `Reactor.tsx`**

Replace:

```ts
import { computeThemeFilter, computeDispatchIntensity, computeModelHueShift, dominantModel } from './reactorMath';
```

with:

```ts
import { computeThemeFilter, computeDispatchIntensity } from './reactorMath';
```

Replace:

```ts
    const { overload } = computeDispatchIntensity(state.realAgents.length);
    const modelHueShift = computeModelHueShift(dominantModel(state.realAgents));
    const filter = computeThemeFilter(state.cfg.theme, state.alarmLevel, state.cfg.glowFx, overload, modelHueShift);
```

with:

```ts
    const { overload } = computeDispatchIntensity(state.realAgents.length);
    const filter = computeThemeFilter(state.cfg.theme, state.alarmLevel, state.cfg.glowFx, overload);
```

- [ ] **Step 3: Confirm `ReactorCore.tsx` needs no change**

`ReactorCore.tsx` passes `clarity: frame.clarity` straight through to `drawCoreGL` (line 37) —
it already reads whatever `useReactorCanvas.ts` puts on the frame, so no edit is needed there.
Open the file and confirm this by inspection; do not edit it.

- [ ] **Step 4: Type-check and run the full test suite**

Run: `npx tsc --noEmit` (from `C:/Users/Matt/projects/aether-os`)
Expected: no errors referencing `computeCacheClarity`, `computeModelHueShift`, `dominantModel`,
or a `modelHueShift`/5-argument call to `computeThemeFilter`.

Run: `npm test`
Expected: all test files pass (708 tests before this plan; expect a small net change from
this plan's added/removed test cases — no failures).

- [ ] **Step 5: Commit**

```bash
git add src/components/reactor/useReactorCanvas.ts src/components/reactor/Reactor.tsx
git commit -m "feat: update reactor call sites for the removed cache-clarity/model-hue axes"
```

---

### Task 6: Verify, document, close out Stage 8

**Files:**
- Modify: `PROGRESS.md`
- Modify: `docs/roadmap.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Full verification**

From `C:/Users/Matt/projects/aether-os`:

```bash
npm test
npx tsc --noEmit
cd collector && npm test && cd ..
```

Expected: all green. If anything fails, stop and fix before documenting — do not write a
"shipped" note against a red suite.

- [ ] **Step 2: Update `docs/roadmap.md`**

Change row 8 (currently `| **8** | **Reactor redesign** | Derivative-not-level encoding,
three nameable axes, real rate-limit denominator. Needs Stage 1. | ~5 tasks |`) to prepend
`**Status: shipped.**` to the description cell, matching the convention already used on rows
3, 4, and 5, e.g.:

```
| **8** | **Reactor redesign** | **Status: shipped** — see `docs/superpowers/plans/2026-07-30-reactor-redesign-stage8.md`. Derivative-not-level encoding, three nameable axes, real rate-limit denominator. | ~5 tasks |
```

- [ ] **Step 3: Add a `PROGRESS.md` "Shipped plans" entry**

Add a new bullet at the top of the `## Shipped plans (newest first)` list (immediately after
that heading, before the existing "Closing the Loop (Stage 6)" entry), following the exact
style of the entries already there (bold linked title, plan-doc link, prose summary,
sub-bullets for any real corrections found during the task-by-task work, sub-bullets for what
was explicitly deferred):

```
- **[Reactor Redesign (Stage 8)](docs/superpowers/plans/2026-07-30-reactor-redesign-stage8.md)** — all 6 tasks passed. Collapses the reactor's six-plus tangled visual signals into exactly three nameable axes: Momentum (pulse speed, from the real burn-rate trend across the last 3 samples, replacing a burn-rate *level* snapshot), Pressure (hue, from the real `fiveHour`/`sevenDay` rate-limit window usage Stage 1's statusline feed surfaces, replacing an arbitrary user-set K/min threshold), and Concurrency (glow/turbulence, from real dispatch count — already correct since Phase 5, unchanged). Cache-hit clarity and per-model hue shift are removed outright, not folded in or kept as minor modifiers.
```

Leave a placeholder line directly below it only if the actual task execution surfaced a real
correction worth recording (matching entries (a)/(b)/(c) in the Stage 6 write-up above it) —
if nothing notable came up during implementation, omit the sub-bullets entirely rather than
inventing one.

- [ ] **Step 4: Commit**

```bash
git add PROGRESS.md docs/roadmap.md
git commit -m "docs: Stage 8 (Reactor redesign) shipped -- roadmap/PROGRESS closeout"
```
