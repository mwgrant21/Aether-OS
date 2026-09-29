# Dashboard idle composition ("Cold cockpit") — design spec

Date: 2026-09-29. Status: approved narration; spec derived from it.
Source: dashboard critique `.impeccable/critique/2026-09-29T03-51-17Z__src-components-dashboard-dashboardview-tsx.md`
(21/40, P1 "idle layout is mostly dead glass", P1 "standby signals contradict each other", plus the P2/P3 items).
Binding: `DESIGN.md` (Living Core Rule, Light Is Energy / Glow-Is-State, Amber Means You, Numbers Are Mono,
11px floor, tokens not literals, Button primitive) and `CLAUDE.md` (cost-figure rules, privacy).

The feature is done when the acceptance narrative at the bottom could be filmed as narrated.

## Decisions (settled; don't relitigate)

- At STANDBY, the four digests (ACTIVE AGENTS, PROJECTS, RECENT ALERTS, SYSTEMS) are replaced by a
  READINESS panel and a STANDBY STRIP. A digest returns as its own panel **only when it has data**, so a
  live console with no alerts shows no empty alerts box.
- Readiness uses a green dot for a met item and a hollow muted dot for an unmet one. **No amber**: none of
  these is a request for the operator (amber stays for approvals and anomalies).
- MEMORY SWEEP leaves the dashboard. Memory appears as a count in the strip; the sweep lives on the Memory view.
- The reactor card's CONTEXT tile becomes **TODAY** (today's cost at API rate), because the bottom row
  already shows context. Amended from the narration's "SESSION COST": no session-scoped cost exists in the
  store, and `state.ledger.total` is all-history, which the repo forbids labelling "session".
- The reactor and StormCore visuals are untouched (Living Core Rule). Only its panel's size changes.

## Component requirements

1. **Dashboard layout (`DashboardView.tsx`).** At STANDBY with no digest data: the reactor card spans the
   full left half of the main area; the right half holds READINESS on top and the STANDBY STRIP below.
   With data: the reactor card keeps the left half; READINESS stays; each digest with data is a panel in
   the right half, stacked below READINESS; digests without data are items in the strip. The bottom
   metrics row and footer are unchanged in position.
2. **Reactor card (`ReactorStatusCard.tsx`).**
   - Status text: STANDBY in Text Muted with a flat dot (no glow) when idle; NOMINAL in success with the
     dot glowing when live; alarm states unchanged.
   - Rate line: exactly `— tok/min · standby` when idle. When live, the existing rate readout and pulse
     mode. The words "live-rate pulse" never appear with "standby".
   - KPI tiles, in order: MONTH TOKENS, DEPLETION ETA, TODAY, BUDGET LEFT. All show `—` (NO_DATA) with no source.
   - **TODAY tile:** value = `state.ledger.rollups.today` formatted as USD (Space Mono); `null` or no ledger → `—`.
     Caption: `API rate, not paid`. It is an exact figure: no `~`, and it never reads `$0.00` for "no data".
   - MEMORY SWEEP is removed. OPEN TERMINAL is the card's only action.
3. **READINESS panel (new, `dashboard/ReadinessCard.tsx`).** `h2` READINESS; four rows, each a dot + one
   plain sentence; one OPEN TERMINAL button below the list.

   | Row | Met when | Met copy | Unmet copy |
   |---|---|---|---|
   | Desktop app | `window.aetherElectron` exists | Desktop app: running. | Desktop app: not running. The Terminal and live tracking need the desktop app. |
   | Terminal | `state.terminalAlive` | Terminal: session running. | Terminal: no session yet. |
   | Statusline | `state.statusline` fresh (same threshold as `isSessionLive`) | Statusline: live. | Statusline: no reading yet. / Statusline: last reading is stale. |
   | Collector | `state.diagnostics !== null` | Collector: running. | Collector: not running. |

   Dots: met = `colors.success` filled, glow only per Light Is Energy (the dot for a live signal may glow;
   Desktop app and Collector are static, so no glow); unmet = hollow ring in Text Muted. Rows are a list
   (`ul`/`li`) so a screen reader hears "list, 4 items".
4. **STANDBY STRIP (new, `dashboard/StandbyStrip.tsx`).** One thin panel; a single row of items for each
   digest **without** data, separated by `·`: `Agents 0`, `Projects 0`, `Alerts 0`, `Memory N engrams`
   (N = `state.memories.length`). Label in Rajdhani, count in Space Mono. Each item is a link-style
   `Button` to its view (Agents, Projects, the alerts dropdown, Memory). Hidden when every digest has data.
5. **Digest panels.** ACTIVE AGENTS, PROJECTS, RECENT ALERTS as today, rendered only when they have data.
   SYSTEMS is retired from the dashboard: Terminal and Collector state move into READINESS, the memory
   count moves to the strip, and the CTRL+K hint moves to the top bar (see 8).
6. **Footer (`Footer.tsx`).** The status dot glows only when live or alarmed (same gate as the reactor card's dot).
7. **Terminal view header.** "session active" is derived from `isSessionLive`; idle reads "standby".
8. **CTRL+K hint.** A small keycap chip `CTRL K` in the top bar beside the operator badge, Space Mono,
   quiet-chip style, opening the command palette on click.
9. **Copy and colour drift.** One sentence per concept across views (no-agents copy identical on
   Dashboard, Agents and Terminal); `#8ab6ff` removed (memory count uses `accentCyanSoft`); alert rows use
   success/warn/danger tokens, not arbitrary colours.

## Interaction requirements

- **OPEN TERMINAL** (READINESS and reactor card): switches to the Terminal view (`SET_ACTIVE_TAB` → Terminal).
  In browser mode it is disabled (`aria-disabled`, not removed) and the Desktop-app row's reason is shown
  directly beneath it.
- **Readiness updates** live: within one store tick of `terminalAlive`/`statusline`/`diagnostics` changing,
  the row's dot and sentence change. No announcement beyond the existing Footer live region.
- **Power-up:** when `isSessionLive` flips true, the reactor powers up over `motion.duration.slow` (existing
  storm filter), the status reads NOMINAL, and the footer reads ALL GOOD.
- **Digest arrival:** when a digest gains data, its strip item is removed and its panel enters the right
  column (height and opacity over `motion.duration.slow`, `motion.easing.decelerate`, transform/opacity
  only; under reduced motion it appears without animation). When it loses data, the reverse.
- **Strip items** navigate to their view on click and Enter/Space; each has a visible focus ring.

## State requirements

- **Cold STANDBY** (the narration's opening): reactor dim, STANDBY muted, flat dots, all tiles `—`,
  READINESS with Desktop app and Collector met and Terminal and Statusline unmet, strip showing all
  four items.
- **Live, no agents:** READINESS all green (in the desktop app); reactor NOMINAL; strip still shows
  Agents/Projects/Alerts as applicable.
- **Live with an agent:** ACTIVE AGENTS panel present; "Agents" item gone from the strip.
- **Browser mode (the imperfect moment):** Desktop app unmet with its reason; OPEN TERMINAL disabled
  with the same reason beneath it; nothing reads as an error.
- **Stale statusline:** Statusline row unmet with "last reading is stale".
- **Alarm (warn/crit) at any point:** existing alarm treatment wins over STANDBY/NOMINAL.

## Off-camera requirements

- No new IPC and no new persisted state: every readiness signal is already in the store
  (`terminalAlive`, `statusline`, `diagnostics`, `memories`, `ledger`) or on `window.aetherElectron`.
- TODAY follows the cost-figure rules: `ExactCost` semantics, `null` ≠ `0`, API-rate basis stated.
- Accessibility: READINESS and the strip are landmarks-in-panels with `h2`s; one `h1` per view stays;
  the Footer remains the single status announcement; every new button uses the `Button` primitive.
- Tests (in the existing test files where they exist, otherwise new sibling files, one per behaviour):
  layout switch by digest data; each readiness row's met/unmet copy; OPEN TERMINAL disabled in browser
  mode; strip items present/absent and navigating; TODAY value/`—`/caption; rate line idle copy; footer
  glow gate; terminal header wording.
- `DESIGN.md` updates: the dashboard layout paragraph, a READINESS / STANDBY STRIP component entry, and
  Known Gaps (remove the idle-emptiness gap).

## Acceptance narrative (approved voiceover, verbatim)

> I launch Aether OS. The dashboard opens at STANDBY: the reactor sits dim and cold, taking up the whole
> left half of the main area, with its status reading STANDBY in muted grey and no glow on the dot. Below it,
> one line reads "— tok/min · standby". The tiles under that read MONTH TOKENS, DEPLETION ETA, SESSION COST
> and BUDGET LEFT, all showing "—".
>
> To the right of the reactor, where four empty panels used to be, is a READINESS panel with four rows,
> each with a small dot and a plain sentence. "Desktop app: running." "Terminal: no session yet."
> "Statusline: no reading yet." "Collector: running." The first and last dots are soft green; the middle
> two are hollow. Under the list is one button, OPEN TERMINAL.
>
> Beneath READINESS, one thin STANDBY STRIP reads "Agents 0 · Projects 0 · Alerts 0 · Memory 12 engrams".
> Each count is a link to its view. The bottom metrics row is unchanged, and the footer says STANDBY with
> no glow.
>
> I press OPEN TERMINAL. The Terminal view opens and I start Claude. Back on the dashboard, within a few
> seconds, the Terminal and Statusline rows turn solid green, and the reactor powers up over about a
> second, brightening and discharging. The status flips to NOMINAL in green, and the footer says ALL GOOD.
>
> Claude dispatches a subagent. The "Agents 0" item leaves the strip, and an ACTIVE AGENTS panel slides in
> beside READINESS showing the agent's row. Projects and Alerts stay in the strip, because they still have
> nothing to show.
>
> Earlier, on the laptop where I'd opened the browser build, READINESS read "Desktop app: not running. The
> Terminal and live tracking need the desktop app." OPEN TERMINAL was disabled, with that same reason under
> it, so it was clear nothing was broken.

Amendment (approved 2026-09-29): the tile narrated as "SESSION COST" is built as **TODAY** (`API rate, not
paid`), because no session-scoped cost exists in the store.
