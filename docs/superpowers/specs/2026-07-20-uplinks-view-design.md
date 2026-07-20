# Uplinks View — Design

## Context

`Uplinks` is registered in `viewRegistry.ts` with `component: null`, so it currently renders
the app's generic "not built yet" placeholder. Unlike Analytics/Settings (which had no prior
entry point), `SystemsCard.tsx`'s "UPLINKS →" link already dispatches
`{ type: 'SET_ACTIVE_TAB', tab: 'Uplinks' }` — a real, pre-existing route waiting for this view
to exist.

`Provider` (`src/state/types.ts`) is minimal: `{ name: string; connected: boolean }`. Seeded in
`initialState.ts` with three fictional providers: `Aether Core` (connected), `OpenAI/Codex`
(disconnected), `Local Ollama` (disconnected). `routeDefault` is a bare `string` field, seeded
as `'Auto'`.

A grep across every `.ts`/`.tsx` file for `providers`/`routeDefault` found exactly one
consumer: `SystemsCard.tsx`, which displays `"Uplinks online {connected}/{total}"` and
`"Default runtime: {routeDefault.toUpperCase()}"` — both read-only. No reducer action, no
terminal command, nothing anywhere mutates either field; they are set once at
`initialState.ts` and frozen for the life of the session. `connected` is confirmed purely
cosmetic today — no other app logic (tick.ts, commands.ts, chat, or any other view) branches
on a provider's connection state.

`providers` and `routeDefault` are already both in `persistence.ts`'s `savePersisted`
whitelist — no persistence fix needed for this plan, continuing the pattern since Settings.

## Goal

Build a real Uplinks view: a connect/disconnect toggle per provider, and a default-runtime
selector (`Auto` or any of the three provider names) — the first-ever UI for both fields.

## Non-goals

- **Adding, removing, or renaming providers.** The three providers are a fixed fictional set,
  matching how this app's other fixed-size collections (e.g. `Cfg`'s ten fields) aren't made
  user-extensible either. No "add uplink" affordance.
- **Any real network/API connection.** `connected` toggles state truthfully; it does not
  attempt to reach any actual service (there is none — `Aether Core`/`OpenAI/Codex`/
  `Local Ollama` are flavor names in a fictional dashboard). Matches how Settings' `sound`
  toggle is cosmetic-only for the same reason (no real subsystem exists to wire up).
  Chat's real `/api/chat` proxy (Anthropic-backed) is a separate, already-shipped mechanism
  and is not gated by this view's toggles.
- **Restricting the default-runtime selector to connected providers only.** All four options
  (`Auto` + 3 provider names) are always selectable regardless of connection state.
- **Auto-resetting `routeDefault` when its target provider is disconnected.** No cross-field
  validation is added — if a user disconnects the provider currently set as the default
  runtime, `routeDefault` keeps its value. This matches the app's general convention of not
  adding defensive consistency logic between fields that have no real behavioral coupling.
- **A dedicated `*Math.ts` pure-logic module.** First view in this project with no
  non-trivial derivation to extract — the one "is this the active pill" check is a one-line
  equality comparison, not worth a module for consistency's own sake.

## Architecture

Single new file: `src/components/uplinks/UplinksView.tsx`. No roster+detail split (no
selectable item with rich per-item content, unlike Agents/Projects/Memory) and no grid-of-cards
(unlike Analytics/Settings — this view is thin enough to be one card).

### `UplinksView.tsx`

One card with two sections:

- **PROVIDERS** — one row per `state.providers` entry: a status dot (green when `connected`,
  dim otherwise — same status-dot idiom `ReactorStatusCard.tsx`'s alarm indicator already
  uses), the provider `name`, an `ONLINE`/`OFFLINE` badge, and a connect/disconnect toggle
  button dispatching `{ type: 'TOGGLE_PROVIDER_CONNECTION', name: p.name }`.
- **DEFAULT RUNTIME** — a row of four pill buttons: `Auto` plus each provider's `name`, each
  dispatching `{ type: 'SET_ROUTE_DEFAULT', value: option }`. Active pill determined by
  `state.routeDefault === option` (case-sensitive exact match — `routeDefault`'s seed value
  `'Auto'` and the pill labeled `Auto` must match exactly; provider-name pills use the
  provider's own `name` string verbatim, e.g. `'OpenAI/Codex'`).

No new unit-testable logic — verified via typecheck + dev server, matching every prior
presentational-only component in this project.

## State changes

- New reducer action: `{ type: 'TOGGLE_PROVIDER_CONNECTION'; name: string }`. Reducer case:
  finds the provider by `name` in `state.providers` and flips its `connected` boolean,
  leaving all other providers untouched (same `.map()` idiom `TOGGLE_MEMORY_PIN`/
  `TOGGLE_AGENT_PAUSE` already use). A `name` that matches no provider is a no-op (returns
  `state.providers` unchanged via the map producing an identical array by value — matches
  this app's existing no-op convention for unknown-name actions, e.g.
  `TOGGLE_AGENT_PAUSE on an unknown name is a no-op`).
- New reducer action: `{ type: 'SET_ROUTE_DEFAULT'; value: string }`. Reducer case:
  `return { ...state, routeDefault: action.value };` — no validation that `value` is one of
  the four known options, matching how `UPDATE_CFG`'s numeric fields are also range-validated
  only by the UI control (`<input type="range">`), not the reducer.
- No new `AetherState` fields — no selection state, matching Analytics/Settings (no single
  selectable item in this view either).

## Data flow

`SystemsCard.tsx`'s existing "UPLINKS →" link needs no change — it already dispatches
`SET_ACTIVE_TAB('Uplinks')` and will now land on a real view instead of the placeholder.
Within the view: clicking a provider's toggle dispatches `TOGGLE_PROVIDER_CONNECTION`;
`SystemsCard`'s "Uplinks online X/Y" stat updates immediately (same `state.providers`).
Clicking a default-runtime pill dispatches `SET_ROUTE_DEFAULT`; `SystemsCard`'s "Default
runtime" line updates immediately (same `state.routeDefault`).

## Error handling / edge cases

- **`providers` is never empty** — three seed entries always present, no persistence path
  clears the array, so no empty-state UI is needed (matches `sys`/`logs`' "never empty in
  practice" handling in the Analytics spec).
- **`TOGGLE_PROVIDER_CONNECTION` with an unrecognized `name`**: no-op, per State changes above
  — defensive correctness, not a reachable case from this view's own UI (every button's `name`
  comes directly from an existing `state.providers` entry).
- **`SET_ROUTE_DEFAULT` with an unrecognized `value`**: cannot happen from this view's own UI
  (every pill's `value` is either the literal `'Auto'` or an existing provider's `name`), and
  the reducer does not validate it — an unrecognized value would simply render as "no pill
  highlighted," an honest (if unreachable) outcome rather than a crash.

## Testing

**Unit (`reducer.test.ts`):**
- `TOGGLE_PROVIDER_CONNECTION` flips the named provider's `connected` only, leaving the other
  two provider entries' `connected` values unchanged.
- `TOGGLE_PROVIDER_CONNECTION` on an unrecognized name is a no-op (matches the existing
  `TOGGLE_AGENT_PAUSE`/`REACTIVATE_AGENT` no-op test convention).
- `SET_ROUTE_DEFAULT` sets `routeDefault` to the given value, leaving `providers` unchanged.

**Manual GUI QA (plan-exit, per this project's convention):**
1. Uplinks tab renders both sections with the three seed providers and four runtime pills.
2. Toggling a provider's connect/disconnect button flips its ONLINE/OFFLINE badge immediately.
3. Switch to Dashboard — `SystemsCard`'s "Uplinks online X/Y" count reflects the toggle from
   step 2 without a reload.
4. Clicking a default-runtime pill highlights it and un-highlights the previous selection.
5. Switch to Dashboard — `SystemsCard`'s "Default runtime" line reflects the new selection.
6. Disconnect the provider currently selected as the default runtime — confirm `routeDefault`
   keeps pointing at it (no auto-reset), per this design's explicit non-goal.
7. Reload the page — both the providers' connection states and `routeDefault` persist
   (regression check — `providers`/`routeDefault` were already whitelisted before this plan).
8. Confirm no regressions elsewhere: Terminal, Dashboard, Agents, Grid, Chat, Projects, Memory,
   Analytics, Settings, and the remaining placeholder tab (Files) still route and highlight
   correctly.
