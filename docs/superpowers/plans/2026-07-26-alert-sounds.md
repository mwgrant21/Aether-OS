# Alert Sounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing (currently decorative) `state.cfg.sound` toggle actually play sound — a synthesized yellow-alert chirp and looping red-alert klaxon driven by the existing budget `state.alarmLevel`, and a distinct soft chime driven by Instrument+Alarm's `state.anomalies`.

**Architecture:** A pure decision function (`decideAlertActions`) maps a previous/next `{alarmLevel, anomalyCount}` pair to a list of actions (`playYellow` / `startRed` / `stopRed` / `playAnomalyChime`). A thin Web Audio playback module executes those actions as synthesized oscillator tones — no external audio asset, avoiding any copyright exposure from real Star-Trek-style klaxon recordings. A new `useAlertSounds()` hook, mounted bare in `App.tsx` next to the existing `useRealAgentsSync()`/`useRealUsageSync()`, watches `state.alarmLevel`/`state.anomalies.length`/`state.cfg.sound` and calls `decideAlertActions` on every change.

**Tech Stack:** TypeScript (strict), React 18, Web Audio API, Vitest.

## Global Constraints

- No CSS modules or styled-components — inline styles only, per the codebase's established convention.
- `npm test` and `npm run build` clean before every commit.
- Full spec: `docs/superpowers/specs/2026-07-26-alert-sounds-design.md`.
- No external audio asset of any kind — all sounds are synthesized via Web Audio oscillators at runtime.
- The audio-producing functions themselves are not meaningfully unit-testable (jsdom has no real `AudioContext`) — only `decideAlertActions`'s pure decision logic is unit tested; audio correctness is verified manually via the TEST SOUND button, per this project's established pattern for anything audio/visual (Reactor Semantics, Instrument+Alarm).

---

### Task 1: `decideAlertActions` pure decision logic

**Files:**
- Create: `src/shared/alertSounds.ts` (only the type + `decideAlertActions` function in this task — the Web Audio playback functions are added in Task 2)
- Create: `src/shared/alertSounds.test.ts`

**Interfaces:**
- Consumes: `AlarmLevel` type from `../state/types` (already exists: `'ok' | 'warn' | 'crit'`).
- Produces:
  ```ts
  export type AlertAction =
    | { kind: 'playYellow' }
    | { kind: 'startRed' }
    | { kind: 'stopRed' }
    | { kind: 'playAnomalyChime' };

  export interface AlertSnapshot {
    alarmLevel: AlarmLevel;
    anomalyCount: number;
  }

  export function decideAlertActions(prev: AlertSnapshot, next: AlertSnapshot): AlertAction[];
  ```

- [ ] **Step 1: Write the failing test**

Create `src/shared/alertSounds.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decideAlertActions } from './alertSounds';

function snap(alarmLevel: 'ok' | 'warn' | 'crit', anomalyCount = 0) {
  return { alarmLevel, anomalyCount };
}

describe('decideAlertActions', () => {
  it('plays yellow chirp on ok -> warn', () => {
    expect(decideAlertActions(snap('ok'), snap('warn'))).toEqual([{ kind: 'playYellow' }]);
  });

  it('starts red loop on warn -> crit, with no yellow re-fire', () => {
    expect(decideAlertActions(snap('warn'), snap('crit'))).toEqual([{ kind: 'startRed' }]);
  });

  it('starts red loop on ok -> crit (skips warn in one tick)', () => {
    expect(decideAlertActions(snap('ok'), snap('crit'))).toEqual([{ kind: 'startRed' }]);
  });

  it('stops red loop on crit -> warn', () => {
    expect(decideAlertActions(snap('crit'), snap('warn'))).toEqual([{ kind: 'stopRed' }]);
  });

  it('stops red loop on crit -> ok', () => {
    expect(decideAlertActions(snap('crit'), snap('ok'))).toEqual([{ kind: 'stopRed' }]);
  });

  it('plays nothing on warn -> ok (de-escalation to ok is silent)', () => {
    expect(decideAlertActions(snap('warn'), snap('ok'))).toEqual([]);
  });

  it('plays nothing when the alarm level does not change', () => {
    expect(decideAlertActions(snap('ok'), snap('ok'))).toEqual([]);
    expect(decideAlertActions(snap('warn'), snap('warn'))).toEqual([]);
    expect(decideAlertActions(snap('crit'), snap('crit'))).toEqual([]);
  });

  it('plays the anomaly chime on a 0 -> N>0 transition', () => {
    expect(decideAlertActions(snap('ok', 0), snap('ok', 1))).toEqual([{ kind: 'playAnomalyChime' }]);
    expect(decideAlertActions(snap('ok', 0), snap('ok', 3))).toEqual([{ kind: 'playAnomalyChime' }]);
  });

  it('does not re-fire the chime on N>0 -> M>0', () => {
    expect(decideAlertActions(snap('ok', 1), snap('ok', 3))).toEqual([]);
  });

  it('does not fire the chime on N>0 -> 0', () => {
    expect(decideAlertActions(snap('ok', 2), snap('ok', 0))).toEqual([]);
  });

  it('combines an alarm-level action with the anomaly chime in the same tick', () => {
    expect(decideAlertActions(snap('ok', 0), snap('crit', 1))).toEqual([
      { kind: 'startRed' },
      { kind: 'playAnomalyChime' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/alertSounds.test.ts`
Expected: FAIL — `src/shared/alertSounds.ts` does not exist yet (or `decideAlertActions` is not exported).

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/alertSounds.ts`:

```ts
import type { AlarmLevel } from '../state/types';

export type AlertAction =
  | { kind: 'playYellow' }
  | { kind: 'startRed' }
  | { kind: 'stopRed' }
  | { kind: 'playAnomalyChime' };

export interface AlertSnapshot {
  alarmLevel: AlarmLevel;
  anomalyCount: number;
}

export function decideAlertActions(prev: AlertSnapshot, next: AlertSnapshot): AlertAction[] {
  const actions: AlertAction[] = [];

  if (next.alarmLevel !== prev.alarmLevel) {
    if (next.alarmLevel === 'crit') {
      actions.push({ kind: 'startRed' });
    } else if (next.alarmLevel === 'warn' && prev.alarmLevel === 'crit') {
      actions.push({ kind: 'stopRed' });
    } else if (next.alarmLevel === 'warn') {
      actions.push({ kind: 'playYellow' });
    } else if (next.alarmLevel === 'ok' && prev.alarmLevel === 'crit') {
      actions.push({ kind: 'stopRed' });
    }
    // warn -> ok is intentionally silent (matches tick.ts's existing
    // notification logic, which also only reacts to level !== 'ok').
  }

  if (prev.anomalyCount === 0 && next.anomalyCount > 0) {
    actions.push({ kind: 'playAnomalyChime' });
  }

  return actions;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/alertSounds.test.ts`
Expected: PASS, all 12 test cases green.

- [ ] **Step 5: Verify no regressions and commit**

Run: `npx tsc -b && npx vitest run`
Expected: clean, all pre-existing tests still passing.

```bash
git add src/shared/alertSounds.ts src/shared/alertSounds.test.ts
git commit -m "feat: add decideAlertActions pure alarm-transition decision logic"
```

---

### Task 2: Web Audio synthesized playback functions

**Files:**
- Modify: `src/shared/alertSounds.ts` (add the playback functions below the existing `decideAlertActions`)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  export function playYellowAlert(): void;
  export function playAnomalyChime(): void;
  export function startRedAlert(): () => void; // returns a stop function
  ```

**Steps:**
- [ ] **Step 1: Add a lazily-created shared `AudioContext` getter**

Append to `src/shared/alertSounds.ts`:

```ts
let sharedCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedCtx) {
    sharedCtx = new AudioContext();
  }
  if (sharedCtx.state === 'suspended') {
    void sharedCtx.resume();
  }
  return sharedCtx;
}
```

- [ ] **Step 2: Add a single-tone helper used by all three sounds**

```ts
function playTone(ctx: AudioContext, frequencyHz: number, startTime: number, durationSec: number, peakGain: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(frequencyHz, startTime);

  // Short linear attack/release so the tone doesn't click at start/end.
  const attack = Math.min(0.02, durationSec / 4);
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(peakGain, startTime + attack);
  gain.gain.linearRampToValueAtTime(0, startTime + durationSec);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + durationSec);
}
```

- [ ] **Step 3: Add `playYellowAlert` — a single alternating two-tone chirp**

```ts
export function playYellowAlert(): void {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const toneDur = 0.15;
  const gap = 0.02;
  const frequencies = [880, 1046.5, 880, 1046.5]; // A5, C6, A5, C6 — bright, brief, unmistakably an alert
  frequencies.forEach((freq, i) => {
    playTone(ctx, freq, now + i * (toneDur + gap), toneDur, 0.18);
  });
}
```

- [ ] **Step 4: Add `playAnomalyChime` — one short soft ping**

```ts
export function playAnomalyChime(): void {
  const ctx = getAudioContext();
  playTone(ctx, 1318.5, ctx.currentTime, 0.25, 0.09); // E6, quieter and longer-tailed than the klaxon tones — reads as a notification, not an alarm
}
```

- [ ] **Step 5: Add `startRedAlert` — continuous looping two-tone klaxon**

```ts
export function startRedAlert(): () => void {
  const ctx = getAudioContext();
  const toneDur = 0.22;
  const lowFreq = 587.33; // D5
  const highFreq = 739.99; // F#5 — lower and more urgent than the yellow chirp's A5/C6 pair
  let stopped = false;
  let nextToneIsHigh = false;

  function scheduleNext() {
    if (stopped) return;
    const now = ctx.currentTime;
    playTone(ctx, nextToneIsHigh ? highFreq : lowFreq, now, toneDur, 0.22);
    nextToneIsHigh = !nextToneIsHigh;
    setTimeout(scheduleNext, toneDur * 1000);
  }

  scheduleNext();

  return () => {
    stopped = true;
  };
}
```

- [ ] **Step 6: Verify and commit**

Run: `npx tsc -b && npx vitest run`
Expected: clean. (No new tests in this step — per Global Constraints, oscillator playback isn't meaningfully unit-testable in jsdom. `decideAlertActions`'s tests from Task 1 are unaffected since these are new, additive exports.)

```bash
git add src/shared/alertSounds.ts
git commit -m "feat: add synthesized Web Audio playback for yellow/red alerts and anomaly chime"
```

---

### Task 3: `useAlertSounds` hook + mount in `App.tsx`

**Files:**
- Create: `src/state/useAlertSounds.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `decideAlertActions`, `playYellowAlert`, `playAnomalyChime`, `startRedAlert` from `../shared/alertSounds` (Tasks 1-2). `useAetherStore` from `./store` (already exists — read `src/state/useRealAgentsSync.ts` in full first for the exact hook-authoring convention this codebase uses: bare `useEffect` calls reading `state`/`dispatch` from `useAetherStore()`, no extra abstraction).
- Produces: `useAlertSounds(): void` — a hook with no return value, side-effect only, called bare like `useRealAgentsSync()`.

**Steps:**
- [ ] **Step 1: Write `useAlertSounds.ts`**

Create `src/state/useAlertSounds.ts`:

```ts
import { useEffect, useRef } from 'react';
import { useAetherStore } from './store';
import { decideAlertActions, playAnomalyChime, playYellowAlert, startRedAlert } from '../shared/alertSounds';

export function useAlertSounds(): void {
  const { state } = useAetherStore();
  const prevRef = useRef({ alarmLevel: state.alarmLevel, anomalyCount: state.anomalies.length });
  const stopRedRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const next = { alarmLevel: state.alarmLevel, anomalyCount: state.anomalies.length };

    if (state.cfg.sound) {
      for (const action of decideAlertActions(prevRef.current, next)) {
        if (action.kind === 'playYellow') playYellowAlert();
        else if (action.kind === 'playAnomalyChime') playAnomalyChime();
        else if (action.kind === 'startRed') stopRedRef.current = startRedAlert();
        else if (action.kind === 'stopRed') {
          stopRedRef.current?.();
          stopRedRef.current = null;
        }
      }
    }

    prevRef.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.alarmLevel, state.anomalies.length, state.cfg.sound]);

  // If sound is toggled OFF mid-red-alert, stop the loop immediately rather
  // than waiting for the next alarmLevel transition to fire `stopRed`.
  useEffect(() => {
    if (!state.cfg.sound) {
      stopRedRef.current?.();
      stopRedRef.current = null;
    }
  }, [state.cfg.sound]);
}
```

Check whether this codebase's ESLint config actually has the `react-hooks/exhaustive-deps` rule enabled before including that disable comment — read `.eslintrc*`/`eslint.config.*` at the repo root first. If the rule isn't configured, drop the comment (it would be dead code).

- [ ] **Step 2: Mount the hook in `App.tsx`**

Read `src/App.tsx` in full first (it's short). Add the import alongside the existing `useRealAgentsSync` import, and call `useAlertSounds()` in the same place `useRealAgentsSync()` is called (inside the `App` component body, before the returned JSX):

```ts
import { useAlertSounds } from './state/useAlertSounds';
```

```ts
useAlertSounds();
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc -b && npx vitest run && npm run build && npm run electron:build`
Expected: all clean. No new tests in this task — the hook is pure wiring over Task 1's already-tested decision function and Task 2's non-testable audio functions; there is no new branching logic here to unit test.

```bash
git add src/state/useAlertSounds.ts src/App.tsx
git commit -m "feat: wire useAlertSounds hook into App, reacting to alarmLevel/anomalies/sound toggle"
```

---

### Task 4: TEST SOUND button in Settings

**Files:**
- Modify: `src/components/settings/BudgetAlertsCard.tsx`

**Interfaces:**
- Consumes: `playYellowAlert` from `../../shared/alertSounds` (Task 2).

**Steps:**
- [ ] **Step 1: Read the file in full**

Read `src/components/settings/BudgetAlertsCard.tsx` in full (it's short — you've already seen the SOUND toggle row above at the `dispatch({ type: 'UPDATE_CFG', patch: { sound: !cfg.sound } })` line). Find the `toggleStyle` function used by the other toggles in this file, and find how a plain (non-toggle) action button is styled elsewhere in this codebase if one exists nearby — otherwise reuse `toggleStyle(colors, false)` for a neutral, always-"off-look" button, since TEST SOUND is a momentary action button, not a toggle.

- [ ] **Step 2: Add the button next to the SOUND row**

Add a `Button` immediately after the existing SOUND toggle row (same `<div style={{ marginTop: 12, ... }}>` block, or a new adjacent row — match this file's existing spacing convention), calling `playYellowAlert()` directly:

```tsx
<Button onClick={() => playYellowAlert()} style={toggleStyle(colors, false)} title="Play the yellow-alert chirp to preview it">
  TEST SOUND
</Button>
```

Import `playYellowAlert` at the top of the file:

```ts
import { playYellowAlert } from '../../shared/alertSounds';
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc -b && npx vitest run && npm run build && npm run electron:build`
Expected: all clean.

```bash
git add src/components/settings/BudgetAlertsCard.tsx
git commit -m "feat: add TEST SOUND button to Settings for manually previewing the yellow alert chirp"
```

---

After all four tasks: whole-branch review, then a `PROGRESS.md` entry in the established format, explicitly noting: (a) no external audio asset is used anywhere — all three sounds are synthesized via Web Audio oscillators, avoiding the copyright exposure of a real Star-Trek-style klaxon recording; (b) `decideAlertActions` is unit tested exhaustively, but the oscillator playback functions and the `useAlertSounds` hook itself are not meaningfully unit-testable (no real `AudioContext` in jsdom) and were verified via the TEST SOUND button / a manual live-window check, per this project's established pattern for audio/visual work.
