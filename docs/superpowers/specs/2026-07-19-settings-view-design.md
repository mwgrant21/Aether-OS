# Settings View — Design

## Context

`Settings` is registered in `viewRegistry.ts` with `component: null`, so it currently renders
the app's generic "not built yet" placeholder. No existing view routes into it.

`Cfg` (`src/state/types.ts`) has ten fields: `opMode`, `renderer`, `pulseMode`, `theme`, `glow`,
`glowFx`, `capM`, `alarm`, `autoThrottle`, `sound`. A full grep across the codebase for every
read and write site of each field found:

- **`opMode`** — has a UI path: `TopBar.tsx`'s PLAN/EDITS/AUTO 3-way toggle, dispatching the
  existing `SET_OP_MODE` reducer action.
- **`theme`** — has a command path: the terminal's `theme <name>` command
  (`commands.ts`'s `case 'theme'`), also reachable via Chat's action-JSON pipeline.
- **`renderer`** — has a command path: the terminal's `renderer <mode>` command
  (`commands.ts`'s `case 'renderer'`).
- **`pulseMode`, `glow`, `glowFx`, `capM`, `alarm`, `autoThrottle`, `sound`** — **have no UI or
  command path anywhere in the app.** They are set once in `initialState.ts` and can never be
  changed by a user — verified by grep across every `.ts`/`.tsx` file for `cfg.<field>` reads and
  every `cfg:` write site in `reducer.ts`/`commands.ts`. These six fields are read by:
  `pulseMode` (reactor pulse animation speed basis, `useReactorCanvas.ts`/`dashboardMath.ts`),
  `glow` (reactor core glow intensity multiplier, `useReactorCanvas.ts`, baseline 70), `glowFx`
  (whether theme-colored glow filters apply, `useReactorCanvas.ts`), `capM` (monthly token
  budget cap in millions — drives Dashboard's "BUDGET LEFT"/depletion ETA, the terminal's
  `budget` command, Chat's offline fallback and system-prompt budget snapshot), `alarm` (burn
  rate alarm threshold in K tok/min, `tick.ts`'s alarm-level transitions and auto-throttle cap),
  `autoThrottle` (whether burn rate is capped at 80% of the alarm threshold, `tick.ts`),
  `sound` (displayed as ON/OFF in `SystemsCard.tsx`, but no audio system exists anywhere in this
  app — the field is already purely cosmetic today).

`Cfg` (as a whole object) is **already** in `persistence.ts`'s `savePersisted` whitelist
(`cfg: state.cfg`, present since the app's original scaffold) — unlike every other view built so
far, this plan does not need to fix a persistence gap.

The Dashboard/Analytics views establish a flat grid-of-cards layout for views with no single
selectable item (as opposed to Agents/Projects/Memory's roster+detail). Settings has no
selectable item either — it's a form, not a list — so it follows that same grid convention.

## Goal

Build a real Settings view: the first-ever UI for the six orphaned `Cfg` fields
(`pulseMode`, `glow`, `glowFx`, `capM`, `alarm`, `autoThrottle`, `sound`), plus a single
authoritative screen showing all ten `Cfg` fields together (including the three that already
have another path — `opMode`, `theme`, `renderer` — reusing those existing paths rather than
duplicating logic for them).

## Non-goals

- **Real audio for `sound`.** The toggle changes `cfg.sound` truthfully (and `SystemsCard`'s
  existing ON/OFF display already reflects it) — it does not make anything in the app audible,
  since no audio system exists anywhere in this codebase today. Building one is out of scope.
- **Removing or changing `TopBar.tsx`'s opMode toggle, or the terminal's `theme`/`renderer`
  commands.** Settings is an additional place to control these, not a replacement — matches how
  `remember` (Memory view) didn't replace any existing command, and how every terminal command
  continues to work exactly as before after each new view ships.
- **Any new persistence work.** `cfg` is already fully persisted as a whole object; `UPDATE_CFG`
  produces a new `cfg` object via the existing reducer pattern, so the existing
  `cfg: state.cfg` whitelist entry covers every field this plan touches with no change needed.
- **A "reset to defaults" action.** Not requested; would need to reference `initialState.cfg`
  from a reducer action, adding a second config-mutation concern beyond what's asked for here.
- **Server-side or cross-device validation of numeric ranges.** Native HTML `<input type="range">`
  `min`/`max` attributes enforce the chosen bounds client-side; no reducer-side clamping is
  added, matching this app's existing pattern of trusting UI-level input constraints (e.g. the
  terminal's `theme`/`renderer` commands validate against a fixed name list, not a range).

## Architecture

New `src/components/settings/` module.

### `settingsMath.ts` (pure, unit-tested)

- `RENDERER_KEY_TO_WORD: Record<RendererMode, string>` — `{ classic: 'nebula', volumetric:
  'volumetric', warp: 'warp' }`, the reverse of the mapping already inlined in `commands.ts`'s
  `case 'renderer'` (`rd === 'nebula' ? 'classic' : rd`). This lets `AppearanceCard` show which
  of the terminal's `renderer <word>` options is active given `cfg.renderer`'s internal key,
  without duplicating the forward-direction parsing logic that already lives in `commands.ts`.
- `rendererKeyToWord(renderer: RendererMode): string` — a thin function wrapper around the map
  (`RENDERER_KEY_TO_WORD[renderer]`), so components import a function rather than reaching into
  a raw object, matching this codebase's existing `*Math.ts` export style (functions, not bare
  data structures, e.g. `STATUS_COLOR` is the one existing exception and is itself a plain
  `Record`, so a bare `RENDERER_KEY_TO_WORD` export would also be acceptable — this plan exports
  both the map and the wrapper function for clarity at call sites).

### `OperatingModeCard.tsx`

Reuses the exact `TopBar.tsx` OP_MODES data (`PLAN`/`EDITS`/`AUTO` labels, tooltips, active-state
styling) in a card-sized 3-way toggle, dispatching the existing
`{ type: 'SET_OP_MODE'; mode: OpMode }` action — no new state, no new action.

### `AppearanceCard.tsx`

- **Theme:** six color swatches (`cyan`/`blue`/`teal`/`violet`/`amber`/`red`, from
  `commands.ts`'s existing `THEME_NAMES`), each dispatching
  `{ type: 'RUN_COMMAND', raw: 'theme ${name}' }` — the same "dispatch a command string from a
  UI element" pattern `ReactorStatusCard.tsx`'s "MEMORY SWEEP" button and `AgentDetailCard.tsx`'s
  "TERMINATE" button already use. Active swatch determined by `cfg.theme === name`.
- **Renderer:** a 3-way toggle over `commands.ts`'s existing `RENDERER_WORDS`
  (`nebula`/`volumetric`/`warp`), each dispatching
  `{ type: 'RUN_COMMAND', raw: 'renderer ${word}' }`. Active option determined by
  `rendererKeyToWord(cfg.renderer) === word`.
- **Reactor pulse:** a 2-way toggle (`live` / `ambient`), dispatching
  `{ type: 'UPDATE_CFG', patch: { pulseMode: 'live' | 'ambient' } }`.
- **Core glow intensity:** a range slider, `min={0} max={140} step={10}`, value `cfg.glow`,
  `onChange` dispatching `{ type: 'UPDATE_CFG', patch: { glow: Number(e.target.value) } }`.
- **Glow effects:** an on/off toggle, dispatching
  `{ type: 'UPDATE_CFG', patch: { glowFx: !cfg.glowFx } }`.

### `BudgetAlertsCard.tsx`

- **Monthly cap:** a range slider, `min={0.5} max={10} step={0.5}`, value `cfg.capM`, displayed
  as `${cfg.capM.toFixed(1)}M tokens` (matching the exact formatting `dashboardMath.ts`/
  `commands.ts`'s `budget` command already use), dispatching
  `{ type: 'UPDATE_CFG', patch: { capM: Number(e.target.value) } }`.
- **Alarm threshold:** a range slider, `min={50} max={200} step={10}`, value `cfg.alarm`,
  displayed as `${cfg.alarm}K tok/min`, dispatching
  `{ type: 'UPDATE_CFG', patch: { alarm: Number(e.target.value) } }`.
- **Auto-throttle:** an on/off toggle, dispatching
  `{ type: 'UPDATE_CFG', patch: { autoThrottle: !cfg.autoThrottle } }`.
- **Sound:** an on/off toggle, dispatching
  `{ type: 'UPDATE_CFG', patch: { sound: !cfg.sound } }` (see Non-goals — cosmetic).

### `SettingsView.tsx`

Composes the three cards in a two-column layout: `OperatingModeCard` and `BudgetAlertsCard`
stacked in the left column (both compact — a 3-way toggle and four short controls), the taller
`AppearanceCard` (five controls) filling the right column. Registered in `viewRegistry.ts` as
`Settings`'s `component`, replacing `null`.

### `settingsMath.test.ts`

Unit tests for `rendererKeyToWord` (see Testing below).

## State changes

- New reducer action: `{ type: 'UPDATE_CFG'; patch: Partial<Cfg> }`. Reducer case:
  `return { ...state, cfg: { ...state.cfg, ...action.patch } };`. This one action covers all
  seven fields controlled by a toggle/slider in this plan (`pulseMode`, `glow`, `glowFx`,
  `capM`, `alarm`, `autoThrottle`, `sound`) — chosen over seven dedicated actions
  (`SET_PULSE_MODE`, `SET_GLOW`, etc.) because a settings-form screen editing many fields of the
  same object is exactly the case a generic patch action fits; the existing one-action-per-concern
  precedent (`SELECT_AGENT`, `SET_OP_MODE`) was set for single-purpose mutations, not multi-field
  forms.
- `opMode` continues through the existing `SET_OP_MODE` action; `theme`/`renderer` continue
  through the existing `RUN_COMMAND` → `commands.ts` path. No changes to either.
- No new `AetherState` fields (no selection state — this view has nothing to select).

## Data flow

No existing entry points route into Settings yet (first view here without a prior "VIEW ALL →"
or button already pointing at it — matches how Analytics also had none). Within the view: each
card's controls read directly from `state.cfg` and dispatch either `UPDATE_CFG`, `SET_OP_MODE`,
or `RUN_COMMAND` — no cross-card data flow, no shared local state, no card ever reads another
card's rendered value.

## Error handling / edge cases

- **`cfg` is never partially missing** — it's a required, fully-typed field on `AetherState`,
  always fully populated from either `initialState.ts` or a full round-trip through
  `savePersisted`/`loadPersisted` (no partial-`Cfg` persistence path exists). No empty-state
  handling is needed anywhere in this view.
- **Slider values are always in-range by construction** — native `<input type="range">` cannot
  produce a value outside its own `min`/`max`, so `UPDATE_CFG`'s reducer case needs no clamping.
- **Theme/renderer button clicks that would set an already-active value** (e.g. clicking the
  already-selected theme swatch) — `commands.ts`'s existing `theme`/`renderer` commands already
  handle this as a harmless no-visible-change re-application; this plan adds no special-casing.

## Testing

**Unit (`settingsMath.test.ts`):**
- `rendererKeyToWord('classic')` returns `'nebula'`.
- `rendererKeyToWord('volumetric')` returns `'volumetric'` (identity case).
- `rendererKeyToWord('warp')` returns `'warp'` (identity case).

**Manual GUI QA (plan-exit, per this project's convention):**
1. Settings tab renders the two-column layout with all three cards populated from live state.
2. Operating Mode toggle changes `state.cfg.opMode`; confirm `TopBar.tsx`'s own toggle reflects
   the same change immediately (shared state, not a separate mechanism).
3. Clicking a theme swatch in Appearance changes the reactor core's visible theme color; confirm
   it matches what typing `theme <name>` in the terminal does.
4. Clicking a renderer option changes the reactor core's renderer; confirm it matches what
   typing `renderer <word>` in the terminal does, and that the active option highlight correctly
   reflects `cfg.renderer` via `rendererKeyToWord`.
5. Toggling reactor pulse (live/ambient) and moving the glow intensity slider visibly changes the
   reactor core's animation on the Terminal/Dashboard views.
6. Moving the monthly cap slider changes Dashboard's "BUDGET LEFT" percentage and the terminal's
   `budget` command output correspondingly.
7. Moving the alarm threshold slider and toggling auto-throttle changes when/whether the burn
   alarm fires (observable via `alarmLevel` changes over a few ticks).
8. Toggling sound changes `SystemsCard`'s "Sound: ON/OFF" display (already-existing read site).
9. Reload the page — every changed value in this view persists (regression check that no new
   gap was introduced, given `cfg` was already fully whitelisted before this plan).
