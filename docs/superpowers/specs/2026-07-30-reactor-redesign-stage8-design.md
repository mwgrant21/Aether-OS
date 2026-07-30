# Reactor Redesign (Stage 8) — Design

## Context

Roadmap Stage 8 (`docs/roadmap.md` row 8): "Derivative-not-level encoding, three nameable
axes, real rate-limit denominator. Needs Stage 1." That one line is the entire prior spec —
this doc fleshes it out.

Phase 5 (`docs/superpowers/specs/2026-07-24-reactor-live-load-phase5-design.md`, shipped)
already wired real signals into the reactor, but the result is a tangle, not three clean
axes:

- **Pulse speed** (`state.rate`) is a *level* — `computeRateFromUsage` maps the current
  `burnRatePerMin` snapshot onto a visual range. It answers "how much work right now," not
  "is work ramping up or down."
- **Hue** is stacked from four independent sources in one `hue-rotate` value: theme,
  `alarmLevel` (warn/crit), `overload` (dispatch count ≥ 3), and per-model tint
  (`computeModelHueShift`). No single channel is independently readable.
- **`alarmLevel`** (`tick.ts`) is computed from `state.rate` vs. `cfg.alarm`, an arbitrary
  user-set K/min threshold — not the real Anthropic rate-limit windows. Stage 1 (statusline
  feed, shipped, merged to master) now surfaces those windows as
  `state.statusline.fiveHour.usedPercentage` / `.sevenDay.usedPercentage` — the actual
  "how close to getting throttled" signal — and nothing consumes them yet.
- **Cache clarity** (`computeCacheClarity`) and **glow/turbulence from concurrency**
  (`computeConcurrencyTurbulence`, `computeDispatchIntensity`) are two more independent
  signals layered on top.

Six-plus signals compressed into hue + pulse + glow is not three nameable axes.

## Design

### The three axes

Reactor visual state collapses to exactly three, each a pure function of one real signal.
Cache clarity and per-model hue shift are **removed entirely** — no fallback, no
minor-modifier retention.

| Axis | Visual channel | Signal | Replaces |
|---|---|---|---|
| **Momentum** | Pulse speed/duration | Rolling delta of real `burnRatePerMin` over the last 3 ticks | `computeRateFromUsage` (level-based) |
| **Pressure** | Hue | `max(fiveHour.usedPercentage, sevenDay.usedPercentage)` from `state.statusline` | `alarmLevel` (rate vs. `cfg.alarm`) |
| **Concurrency** | Glow/turbulence intensity | `realAgents.length` | Unchanged — already one clean real-data axis (`computeConcurrencyTurbulence`, `computeDispatchIntensity`) |

### Momentum

New `computeMomentum(history: {burnRatePerMin: number; atMs: number}[]): number`, in
`reactorMath.ts`, replacing `computeRateFromUsage`.

- The reducer keeps a ring buffer of the last 3 `burnRatePerMin` samples (with timestamps),
  updated wherever `realUsage` currently updates `state.rate`.
- `computeMomentum` returns the normalized delta between the newest and oldest sample in the
  buffer, mapped into the existing `RATE_MIN`–`RATE_MAX` pulse-duration range: rising burn →
  faster pulse, falling → slower, flat/insufficient-history (<3 samples, e.g. at startup) →
  today's idle baseline (`RATE_IDLE`).
- `computePulseDuration` keeps its existing signature and behavior — it already just consumes
  a `rate` number; only what feeds `rate` changes.

### Pressure

`tick.ts`'s `level` computation changes from `rateK >= alarm` to reading
`state.statusline`:

```
pressure = statusline
  ? Math.max(statusline.fiveHour?.usedPercentage ?? 0, statusline.sevenDay?.usedPercentage ?? 0)
  : 0
level: AlarmLevel = pressure >= 90 ? 'crit' : pressure >= 75 ? 'warn' : 'ok'
```

- `statusline === null` (feed not installed, or no data yet) → `'ok'`. Same principle as the
  Momentum idle floor: missing data must never read as a false alarm.
- `cfg.alarm` (user-configured K/min threshold) and its UI (if any Settings surface exposes
  it solely for this purpose) are removed along with the old computation — it no longer
  drives anything real.
- `computeThemeHueDeg`/`computeThemeFilter` keep their existing `alarmLevel`/`overload`
  hue-shift logic unchanged; only what feeds `alarmLevel` changes.

### Concurrency

No change. `computeConcurrencyTurbulence` and `computeDispatchIntensity` already derive
purely from `state.realAgents.length` and stay as-is.

### Removed

- `computeCacheClarity` and its call sites (`useReactorCanvas.ts`/`ReactorCore.tsx` shader
  wiring for cache clarity).
- `computeModelHueShift`, `dominantModel`, and the `modelHueShift` parameter threaded through
  `computeThemeFilter`.
- `cfg.alarm` and any UI control that exists only to set it.

### Scope boundaries

- `state.agents` (the fictional roster) and anything else already out of scope per Phase 5 —
  untouched.
- No IPC/electron-layer changes — this is reducer + renderer math, same category as Phase 5.
- Warn/crit thresholds (75%/90%) are a starting point, adjustable later without
  architectural change, same posture Phase 5 took with its 2/3 dispatch-count thresholds.

## Testing

Extends existing suites:

- `reactorMath.test.ts` — new cases for `computeMomentum` (rising / falling / flat /
  insufficient-history); delete `computeRateFromUsage`, `computeCacheClarity`,
  `computeModelHueShift`, `dominantModel` test cases along with the functions.
- `tick.test.ts` — cases for the statusline-null fallback and the new percentage-based
  warn/crit thresholds; delete the old `cfg.alarm`-based cases.

## Out of scope

- Any change to `state.agents`, the fictional simulation, or any other view.
- Changing the Concurrency axis's thresholds or mechanism.
- A fourth axis, or continuous/proportional scaling beyond what's specified above.
