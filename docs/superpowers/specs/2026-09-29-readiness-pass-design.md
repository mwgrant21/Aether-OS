# Design: READINESS teaches and fills the column, plus four standby fixes (2026-09-29)

Source: the "Next pass: already chosen" list in
`docs/superpowers/plans/2026-09-29-idle-composition-handoff.md` (PR #93), from the
critique of #92. Written against `master` at `e9e2aca`. Baseline on work-it:
198 files passed / 1 skipped, 2177 tests passed / 14 skipped.

Decisions from that handoff still hold and are not reopened here: StormCore is
protected, dark-only, one OPEN TERMINAL on the Dashboard under READINESS, unmet
READINESS rows are never amber, glow only while a session is live.

## 1. READINESS teaches and fills the column [P1]

### Voiceover

> I open Aether cold. On the right, READINESS runs the full height of the
> reactor. Each thing that is not ready tells me, in one line, how to fix it.
> Each thing that is ready tells me when it was last true. OPEN TERMINAL sits
> at the bottom, level with the reactor's base.

### The honesty finding that shapes this item

`Collector: running.` is set today by `state.diagnostics !== null`
(`readinessMath.ts`). That only proves `~/.aether-os/collector.db` exists, is
schema >= 4, and was readable for the last 24h (`electron/main.ts`
`readDiagnostics(collectorDbPath, Date.now() - 24h)`). The app never starts the
collector (`roadmap.md`: "start the collector on demand" was never built), so a
collector that died yesterday still reads "running". This pass replaces the
claim with what the app can observe: the newest recorded event.

### Copy

Times are absolute, `HH:MM` in local time; when the timestamp is not from the
current local day, prefix the short date: `Sep 28 14:02`. No relative times
("3m ago"): they need a ticking re-render and go stale on screen.

| Row | Met sentence | Unmet sentence | Unmet hint |
|---|---|---|---|
| desktop | `Desktop app: running.` (no time: a static fact) | `Desktop app: not running.` | `Start it with npm run electron:dev.` |
| terminal | `Terminal: open since {t}.` | `Terminal: no session yet.` | desktop present: `Use OPEN TERMINAL below.` / browser: `Needs the desktop app.` |
| statusline | `Statusline: live, {t}.` (t = `capturedAtMs`) | no snapshot: `Statusline: no reading yet.` / stale: `Statusline: last reading {t}.` | no snapshot: `Install it in Settings, then run a Claude Code turn.` / stale: `Refreshes on each Claude Code turn.` |
| collector | `Collector: last event {t}.` | has events, stale: `Collector: no events since {t}.` / none: `Collector: no events in the last 24h.` | `Build and start it in collector/: npm run build, then npm start.` |

Met rows have no hint. The Desktop row no longer appends `DESKTOP_APP_REASON`
(see item 3).

### Data

- **Store:** add `terminalOpenedAtMs: number | null` to `AetherState`, initial
  `null`. Set to `Date.now()` when the pty reports alive (the same place
  `terminalAlive` becomes `true`), cleared to `null` wherever `terminalAlive`
  becomes `false`. If `terminalAlive` is true but `terminalOpenedAtMs` is null
  (should not happen; defensive), the met sentence is `Terminal: open.`
- **Freshness:** in `readinessMath.ts`, add
  `COLLECTOR_STALE_AFTER_MS = 10 * 60 * 1000`,
  `newestCollectorEventMs(diagnostics): number | null` (max over
  `toolCalls[].closedAtMs`, `dispatches[].endedAtMs`,
  `anomalies[].detectedAtMs`; null when all are empty or `diagnostics` is null),
  and `isCollectorFresh(newest, nowMs)` using the same `<=` comparison as
  `isStatuslineFresh`.
- **Row shape:** `ReadinessRow` gains `hint: string | null`. `computeReadiness`
  stays pure; its `state` pick grows by `terminalOpenedAtMs`. Time formatting is
  a pure helper taking `nowMs` so tests are deterministic (local-day comparison
  against `nowMs`, not `new Date()`).
- **Glow** is unchanged: terminal and statusline may glow while live; desktop
  and collector never glow.

### Layout

- `ReadinessCard`: `flex: none` becomes `flex: 1`, so the card spans the
  reactor card's height in the right column.
- The list stays at the top at its current rhythm; `OpenTerminalButton`'s wrapper
  gets `marginTop: 'auto'` so it pins to the card's bottom edge. The stretch goes
  in the gap between the last row and the button, not between rows.
- `StandbyStrip` stays content-height (`flex: none`) below READINESS.
- Hint line: under its row's sentence, indented to the sentence's left edge
  (clear of the dot), `400 11px/1.5` UI font, `textMuted`. 11px is the floor.
  Command text (`npm run electron:dev`, `npm run build`, `npm start`) in the mono font token.

### Honesty rules (each becomes a test)

1. No hint names a control that is not on screen: `Use OPEN TERMINAL below.`
   only when `desktop` is true.
2. The collector copy never contains "running".
3. Unmet dots are hollow and `textMuted`; nothing in READINESS uses amber.
4. A met row never has a hint; an unmet row always does.
5. Collector freshness boundary: fresh at exactly `COLLECTOR_STALE_AFTER_MS`,
   stale 1ms later (mirrors the statusline boundary test).

## 2. Alerts strip item and dropdown [P1]

Today `StandbyStrip.tsx` opens the notifications dropdown about 600px away;
focus does not follow and `TopBar.tsx` has no key or focus handling for it.

- On open (from the strip or the TopBar bell), move focus into the panel (its
  first focusable element, else the panel itself with `tabIndex={-1}`).
- On close, return focus to whichever trigger opened it.
- Close on Escape and on a pointer-down outside the panel and its trigger.
- The strip's Alerts item gets `aria-expanded` bound to the dropdown's open
  state, and clicking it while open closes it (closes handoff ruling 10's
  second gap).
- The approvals/notifications mutual exclusion from #91 is preserved.

## 3. The desktop-app reason is printed once [P2]

`readinessMath.ts` stops appending `DESKTOP_APP_REASON` to the Desktop row
(already reflected in item 1's copy). `OpenTerminalButton` keeps printing it
under the disabled button, where `aria-describedby` points at it.

## 4. Standby contradictions [P2]

- SESSION INFO (`BottomMetricsRow.tsx`): at STANDBY (`!isSessionLive`), the
  session-start and uptime values render `—` and uptime does not tick.
- STANDBY STRIP counts: `0` in `textMuted`; `soft signal` cyan only for a count
  above 0. The memory count follows the same rule.

## 5. One OPEN TERMINAL everywhere [P2]

`OpenTerminalButton` gains `variant?: 'primary' | 'secondary'` (default
`primary`, current look). `secondary` uses the existing secondary button
treatment from DESIGN.md. Every OPEN TERMINAL in the app, including the Agents
view roster empty state, renders through it, so the desktop-app check
(aria-disabled plus reason) is shared. A test asserts no other component
renders the literal `OPEN TERMINAL`.

## Out of scope

The other open critique items (region semantics on REACTOR STATUS and digest
cards, the 17px KPI, the radius and padding drift, the literal rgba, Projects
copy, the orphan sidebar label, DispatchTimeline's panel) and the older
carry-overs in the handoff. Starting the collector from the app stays unbuilt.

## Verification

- `npm test` green with the new tests; `npm run build` (runs `tsc -b`, so it is
  the renderer typecheck) and `npm run typecheck:electron` green, since
  `terminalOpenedAtMs` is set from the pty sync path.
- `/impeccable critique` re-run on `DashboardView.tsx`, compared against the
  22/40 snapshot from #92.
- A live check in `npm run electron:dev` at STANDBY and with a terminal open:
  the READINESS card height matches the reactor card, the button sits level with
  its base, and Alerts focus, Escape and outside-click behave as above.

## Amendment (2026-09-29, final review)

The honesty finding behind the Collector row's original copy ("the app never
starts or watches the collector process, so it cannot claim running") was
wrong. `electron/collectorStore.ts:210-211`'s `readDiagnostics` already gates
on the collector's own `transcript_last_scan_ms` heartbeat and returns `null`
once it goes stale (`DIAGNOSTICS_HEARTBEAT_STALE_MS`), so `state.diagnostics
!== null` already proves a live, scanning collector -- introduced at commit
c2d8b6c. The 10-minute event-freshness window this spec's Collector row used
in its place was a second, redundant and looser liveness check layered on top
of a heartbeat gate that already exists.

The operator chose heartbeat-based copy for the Collector row. The three
sentences:

- Met, with an event: `Collector: running, last event {t}.`
- Met, no events yet: `Collector: running, no events in the last 24h.`
- Unmet (diagnostics null): `Collector: not running.`

The 10-minute `COLLECTOR_STALE_AFTER_MS` window and the "collector copy never
says running" rule are withdrawn.
