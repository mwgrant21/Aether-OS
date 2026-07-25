# Reactor Live Load (Phase 5) — Design

## Context

Phase 4 (Real Live Output) replaced `state.logs`'s fictional producer with real dispatch-lifecycle events, but the reactor visual subsystem (`ReactorCore.tsx`, `useReactorCanvas.ts`, `reactorMath.ts`) was explicitly out of scope and still runs entirely on synthetic data:

- `state.rate` (drives pulse speed / surge intensity) comes from `tick.ts`'s `Math.random()`-driven walk toward a target, clamped 20k–168k, with no relationship to real token usage.
- `overdrive` (the intensity-kick boolean) is `state.agents.length >= 7` — the fictional agent roster, not real dispatch activity.

Two real signals already exist in state, wired up in Phase 2 and Phase 3, but never connected to the reactor:

- `state.realUsage.burnRatePerMin` — real measured token consumption, refreshed every 60s via a batch scan of `~/.claude/projects/**/*.jsonl` (Phase 2).
- `state.realAgents` — real currently-open Claude Code dispatches, live-tailed in near-real-time (Phase 3, slice 1).

Phase 5 wires both into the reactor, replacing the synthetic drivers.

## Design

### Rate (ambient pulse speed)

`state.rate` becomes a pure derivation of `state.realUsage.burnRatePerMin` instead of a random walk:

- When `burnRatePerMin > 0`, `state.rate` tracks it directly (mapped/clamped into the existing 20k–168k visual range the pulse-duration math already expects).
- When `burnRatePerMin === 0` (idle — no recent real usage), `state.rate` falls back to the current idle baseline (`92000`, today's `initialState` default), so an idle app looks exactly as it does today: a steady, alive pulse, not a dead one.

This computation replaces `tick.ts`'s random-walk block entirely. It lives in the reducer (recomputed whenever `realUsage` updates), since `rate` is already reducer-owned state — keeping the fallback/mapping logic in one place rather than duplicating it in the render hook.

### Overdrive and overload (intensity tiers)

Two thresholds on `state.realAgents.length`, replacing the fictional `state.agents.length >= 7` check in `useReactorCanvas.ts`:

- **`overdrive`** (existing flag): `realAgents.length >= 2`. A single real dispatch may nudge the pulse but never crosses into overdrive on its own. Same visual effect as today (faster pulse/surge), just re-sourced from real data.
- **`overload`** (new tier): `realAgents.length >= 3`. Layers on top of `overdrive` — a hue shift plus a `glowFactor` bump, using the same mechanism `computeThemeHueDeg`/`computeThemeFilter` already use for `alarmLevel`'s `warn`/`crit` tiers (a new tier alongside them, not a replacement — `alarmLevel` is about token budget, `overload` is about dispatch concurrency, and both can be true independently).

Net visual read: idle (steady baseline pulse) → active (faster pulse, 2+ dispatches) → overload (faster pulse + color shift + glow bump, 3+ dispatches).

Thresholds (2/3) are a starting point, adjustable later without architectural change.

### Scope boundaries

- `state.agents` (the fictional roster) and everything that still reads it (Terminal's digest, Files' historical fictional references, etc.) — completely untouched. This phase only changes what feeds the reactor.
- No electron-layer / IPC changes — pure renderer-side derivation from state that Phase 2/3 already populate, same category as Phase 3 slice 5/6 and Phase 4.
- `alarmLevel`'s existing hue/filter behavior is unchanged; `overload` is additive.

### Testing

Extends existing suites, no new test files:

- `reactorMath.test.ts` — new cases for the `overload` hue tier alongside existing `warn`/`crit` cases.
- `tick.test.ts` / reducer tests — cases for the idle floor (`burnRatePerMin === 0` → baseline), the real-usage-driven rate mapping, and the 2/3 `realAgents.length` thresholds for `overdrive`/`overload`.

## Out of scope

- Continuous/proportional scaling of `overload` with dispatch count (flat threshold only, for now).
- Any change to `state.agents`, the fictional simulation, or any other view.
