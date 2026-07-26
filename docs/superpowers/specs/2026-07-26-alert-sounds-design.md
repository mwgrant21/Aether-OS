# Alert Sounds — Design Spec

## Goal

`state.cfg.sound` is a real toggle in `BudgetAlertsCard.tsx` — it persists, it renders ON/OFF, `SystemsCard.tsx` reports its state — but nothing has ever been wired to it. No sound plays regardless of its value. This spec makes it real: a synthesized Star-Trek-style alert klaxon (yellow chirp / red loop) for the existing budget `alarmLevel`, and a distinct soft chime for Instrument+Alarm anomalies.

## Constraint: no external audio asset

The user's first instinct was to grab a real Star Trek red-alert klaxon recording. That audio is copyrighted (CBS/Paramount) and can't be bundled into the app. Sourcing a genuine CC0 replacement (e.g. from freesound.org) also isn't practical in this workflow — Freesound requires an authenticated OAuth download, not a plain fetchable URL.

Instead, all three sounds are **synthesized at runtime with the Web Audio API** — plain oscillator nodes, no asset file at all. This has zero licensing exposure, and the "alternating two-tone klaxon" character the user wants is exactly what an oscillator frequency-modulation is good at producing.

## Trigger mapping (confirmed with user)

| Source | Transition | Sound | Behavior |
|---|---|---|---|
| `state.alarmLevel` | `ok`/`crit` → `warn` | yellow alert | single ~1s chirp, plays once per transition |
| `state.alarmLevel` | any → `crit` | red alert | loops continuously until `alarmLevel` leaves `crit` |
| `state.anomalies.length` | `0` → `>0` | anomaly chime | short soft ping, plays once per transition |

All three are gated by `state.cfg.sound` — off means nothing plays, full stop.

## Architecture

No new reducer actions or state fields. `state.alarmLevel` (already computed in `src/state/tick.ts`) and `state.anomalies` (already populated via IPC from Instrument+Alarm) are both already live in `AetherState` — this feature only needs to *react* to their transitions, following the same pattern as the existing `useRealAgentsSync()`/`useRealUsageSync()` hooks mounted bare in `App.tsx`.

### `src/shared/alertSounds.ts` — pure decision logic + Web Audio playback

Two halves, deliberately separated so the interesting part is unit-testable:

```ts
export type AlertAction =
  | { kind: 'playYellow' }
  | { kind: 'startRed' }
  | { kind: 'stopRed' }
  | { kind: 'playAnomalyChime' };

// Pure — no AudioContext, no side effects. Takes the previous and current
// tick's relevant state slices and returns what should happen this tick.
export function decideAlertActions(
  prev: { alarmLevel: AlarmLevel; anomalyCount: number },
  next: { alarmLevel: AlarmLevel; anomalyCount: number },
): AlertAction[]
```

Truth table `decideAlertActions` must satisfy (this is the spec for its test suite):
- `ok`→`warn`: `[playYellow]`
- `warn`→`crit`: `[startRed]` (no yellow re-fire)
- `crit`→`warn`: `[stopRed]`
- `crit`→`ok`: `[stopRed]`
- `warn`→`ok`: `[]` (no sound on de-escalation to ok, matching the existing notification logic in `tick.ts` which also only reacts to `level !== 'ok'`)
- `ok`→`crit` (skips warn in one tick — possible if burn rate spikes fast): `[startRed]`, no yellow
- same level→same level: `[]`
- `anomalyCount` `0`→`N>0`: includes `playAnomalyChime` (independent of alarm transitions, can combine with any of the above in the same result array)
- `anomalyCount` `N>0`→`0` or `N>0`→`M>0`: no chime (only the 0→>0 edge fires)

The audio-producing half is NOT unit-testable in the usual sense (jsdom has no real `AudioContext`) — mirrors this project's established pattern (Reactor Semantics, Instrument+Alarm) of deferring audio/visual correctness to a manual/live-window check. Implementation sketch:

```ts
let sharedCtx: AudioContext | null = null;
function getContext(): AudioContext {
  if (!sharedCtx) sharedCtx = new AudioContext();
  if (sharedCtx.state === 'suspended') sharedCtx.resume();
  return sharedCtx;
}

export function playYellowAlert(): void { /* two alternating tones (~800Hz/1000Hz), ~150ms each, ~4 repeats, gain envelope to avoid clicks */ }
export function playAnomalyChime(): void { /* single short soft sine ping, ~200ms, lower gain than the klaxon */ }
export function startRedAlert(): () => void {
  /* schedules a looping two-tone oscillator pattern (lower/more urgent than yellow, continuous
     alternation) using setInterval or recursive setTimeout scheduling further oscillator nodes;
     returns a stop function that clears the schedule and disconnects any live nodes */
}
```

### `src/state/useAlertSounds.ts` — the reactive hook

```ts
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
        else if (action.kind === 'stopRed') { stopRedRef.current?.(); stopRedRef.current = null; }
      }
    }
    prevRef.current = next;
  }, [state.alarmLevel, state.anomalies.length, state.cfg.sound]);

  // If sound gets toggled OFF mid-red-alert, stop the loop immediately rather than
  // waiting for the next alarmLevel transition.
  useEffect(() => {
    if (!state.cfg.sound) { stopRedRef.current?.(); stopRedRef.current = null; }
  }, [state.cfg.sound]);
}
```

Mounted bare in `App.tsx` next to `useRealAgentsSync()`/`useRealUsageSync()`.

## Settings: a way to verify without a real alarm

Since neither of us can trigger a real budget-crit or anomaly live in this session, `BudgetAlertsCard.tsx` gets one small addition next to the existing sound ON/OFF toggle: a **"TEST SOUND"** button that calls `playYellowAlert()` directly. This is the only way to confirm the synthesized tone actually sounds right without waiting for a live alarm — the user should press it during the manual verification pass.

## Files

- Create: `src/shared/alertSounds.ts` + `alertSounds.test.ts` (tests `decideAlertActions` only)
- Create: `src/state/useAlertSounds.ts`
- Modify: `src/App.tsx` — mount `useAlertSounds()`
- Modify: `src/components/settings/BudgetAlertsCard.tsx` — add TEST SOUND button

## Out of scope

- Per-sound volume/mute controls beyond the existing single ON/OFF toggle.
- Any sound for `warn`→`ok` or general notification events (toasts, approvals) — this spec is scoped to the budget alarm klaxon and the Instrument+Alarm chime only, per the user's stated trigger mapping.
- Persisting "last played" or de-duplicating across app restarts — `prevRef` starts fresh each session at whatever `state.alarmLevel`/`anomalies` are on load, so no spurious sound fires just from a fresh mount (the effect's first run has `prev === next` by construction, since `prevRef` is initialized from the same state the effect first reads).

## Verification

- `decideAlertActions`'s full truth table above, unit tested.
- `npx tsc -b`, `npx vitest run`, `npm run build`, `npm run electron:build` clean.
- Manual/live-window check (established pattern for this project): toggle sound ON, press TEST SOUND, confirm the yellow chirp is audible and not jarring; if feasible, force a budget-crit or anomaly condition to hear the red loop and chime for real.
