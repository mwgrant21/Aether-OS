# Spec: Aether OS polish pass 1: storm reactor centred, dead button removed, honest readouts, idle STANDBY

Written 2026-09-28 against commit **d36a3e3** (branch `design/document-system`). Stop if d36a3e3 is not an ancestor of your HEAD.
Source of these findings: `.impeccable/critique/2026-09-28T20-35-01Z__src-components-dashboard-dashboardview-tsx.md` (committed alongside this spec on branch `design/document-system`).
Design authority: `DESIGN.md` at the repo root (read Overview, Colors, Components > Storm Core, and Do's and Don'ts). Project rules: `CLAUDE.md` at the repo root (read "Key conventions" and "Testing philosophy" before editing).

## Decisions already made by the user (do not relitigate)
- The dashboard's centrepiece is the real reactor, and **`storm` becomes the default renderer**. The setting still lets the user switch.
- When no Claude session is live, the console goes **"dark and cold"**: status reads STANDBY, the reactor idles dim, and it visibly powers up when a session starts.
- StormCore is the protected signature component. Its look is not to be redesigned.

## Acceptance criteria

**AC1: default renderer.** `src/state/initialState.ts:22` `renderer: 'classic'` → `'storm'`. Check how persisted state (`src/state/persistence.ts`) merges over defaults. Do NOT migrate or overwrite a persisted, explicitly chosen renderer; a fresh profile gets storm. If the persistence whitelist would drop or reset the field, report it (see the app-dev lesson: persisted-state whitelists silently drop fields).

**AC2: real reactor in the dashboard.** In `src/components/dashboard/ReactorStatusCard.tsx`, replace the 120px CSS stand-in (lines ~84-90: `ringOuterStyle`/`ringInnerStyle`/`glowDiscStyle`/`coreDiscStyle`) with the real `<Reactor />` from `src/components/reactor/Reactor.tsx`. Size it to fill the stand-in plus the ~250px void beneath it (the panel should no longer have a dead band between the KPI tiles and the action buttons). Scale it ONLY through a wrapper transform using `reactorNativeSize(state.cfg.renderer)`, the same way `src/components/layout/Sidebar.tsx:194-210` does (read its centering comments). Delete the now-unused stand-in styles.

**AC3: one primary action; the dead button goes.** Remove the inert `◇ COMPOSE MISSION` `<span>` (`ReactorStatusCard.tsx:~134-136`, and its comment and `composeActionStyle` if unused). The panel then has exactly ONE primary-styled action: OPEN TERMINAL gets the primary style (the `linear-gradient(180deg,#7ef0ff,#17b8d8)` fill used in this file); every other action is secondary. All actions use the `Button` primitive.

**AC4: honest readouts (dashboard scope).** On the Dashboard view no figure may contradict another, and no simulated or fallback value may render as if it were data:
- A value with no real source renders `—` (em dash), never a simulated number. This includes the rate readout (92,000 tok/min in browser mode) and the CONTEXT tile's simulated `[EST]` fallback (~line 48 of the relevant file).
- `src/components/dashboard/dashboardMath.ts:35` labels a monthly value "SESSION TOKENS": rename the label to **MONTH TOKENS** (or change the value to a real session value if one exists; pick one and report which).
- Uptime appears twice with different values (a session-info card vs the footer) and command count twice (163 vs "no commands run yet"). Find each pair's sources, make both read ONE source, and report the source you chose.
- Respect the binding cost rules in CLAUDE.md: estimates keep `~` and name their basis, exact values never do, and "no data" is `null`/`—`, never `0`.

**AC5: idle STANDBY ("dark and cold").**
- Find the canonical "a Claude session is live" signal in existing state (look at `useRealUsageSync.ts`, `useRealAgentsSync.ts`, `state/types.ts`). Do NOT invent a new IPC channel. Expose it through ONE pure, unit-tested function, e.g. `isSessionLive(state)`.
- When not live: the dashboard status text (`computeDashStatus`) reads **STANDBY** instead of NOMINAL, and the footer's ALL GOOD reads **STANDBY** too (you may edit only the status text and its colour in the footer's file). Rate readouts show `—`.
- Reactor dims: extend the filter computed in `src/components/reactor/reactorMath.ts` (`computeThemeFilter`, or a sibling pure function composed in `Reactor.tsx`) so that idle adds a dim, cold treatment (lower brightness and saturation, e.g. `brightness(.45) saturate(.35)`; tune by eye in a screenshot). Transition the change (use `motion.duration.slow` from `src/styles/tokens.ts`), so power-up is visible when a session starts. Pure filter logic gets unit tests. StormCore's behaviour when live must be byte-for-byte what it is today.
- Idle status uses text-muted/text-secondary, not cyan (cyan means live, per DESIGN.md).

## Files in scope (you may change)
`src/components/dashboard/**`, `src/components/reactor/Reactor.tsx`, `src/components/reactor/reactorMath.ts` (+ its test), `src/state/initialState.ts`, `src/state/persistence.ts` only if AC1 requires it, the footer component's status text/colour only, the uptime/commands card files only as far as AC4 needs, and tests alongside any of these.

## Do NOT
- Edit `src/components/reactor/StormCore.tsx`, `aetherStorm.ts`, `ReactorCore.tsx`, `drawWarp.ts`, `drawConduits.ts`, `drawHousing.ts`, `glShader.ts` (the Living Core rule).
- Touch focus styling, landmarks, headings, font sizes outside the lines you already edit, or `tokens.ts` colours; pass 2 owns those.
- Edit DESIGN.md, CLAUDE.md or PROGRESS.md; the orchestrator does that.
- Add model/API calls (see CLAUDE.md "Model calls"), push, or merge.

## Verify
1. Red-proof: each new logic test must FAIL before your implementation change and pass after. Record one red line per test file.
2. `npm test`, `npm run build`, `npm run typecheck:electron`: all green. Run `npm ci` first in your worktree if `node_modules` is missing.
3. Visual (renders are not unit-tested here, by project policy): start `npx vite --port 5201 --strictPort --host 127.0.0.1` in the background, take Playwright (headless Chromium, from node_modules) screenshots of the Dashboard at 1536x1024 in browser mode (idle, since no live session exists there), save them to `<handoffs>/aether-os/shots-pass1/` (outside the repo, on the machine that ran the pass), look at them, then stop the server. Report whether the reactor fills the panel, reads as dim and cold, and nothing overlaps.
