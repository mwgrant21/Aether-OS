# Spec: Aether OS polish pass 2: keyboard focus, landmarks, 11px type floor, contrast

Written 2026-09-28 against commit **b7ba9ee** (branch `design/document-system`, after pass 1 merged). Stop if that commit is not an ancestor of your HEAD.
Design authority: `DESIGN.md` at the repo root (Components > Buttons > "Keyboard focus", Typography, Do's and Don'ts). Project rules: `CLAUDE.md` ("Key conventions": useColors, Button, useHoverStyle; "Testing philosophy").

## Acceptance criteria

**AC1: focus ring on every interactive element.** `src/components/shared/Button.tsx` and `useHoverStyle.ts` handle mouse hover only (styles are inline objects, so there are no `:focus-visible` CSS rules). Implement keyboard focus:
- Track focus-visible state (onFocus/onBlur, gating on `:focus-visible` via `e.currentTarget.matches(':focus-visible')` so mouse clicks don't show the ring).
- While focus-visible: apply the DESIGN.md ring, `outline: 2px solid <colors.textPrimary>` with `outlineOffset: 3px`, AND the same lit treatment as hover (keyboard users get the "lit" state, not just a ring).
- Unit-test: focus shows the ring, blur removes it, a mouse click does not show it (extend `Button.test.tsx` / `useHoverStyle.test.ts`).
- Replace the two `outline: 'none'` sites (`MessageInput.tsx:~63`, `OperatorCard.tsx:~59`) with a visible focus treatment per DESIGN.md Inputs > Focus (cyan border plus a 3px translucent cyan ring).
- Any remaining interactive raw element (`<div onClick>`/`<span onClick>`) found in `src/components/**`: convert to `Button`, and list each in the report.

**AC2: landmarks, headings, skip link, names.**
- App frame: top bar = `<header>`, sidebar = `<nav aria-label="Main">`, content = `<main>`, footer = `<footer>`. Add a visually hidden "Skip to content" link as the first focusable element that becomes visible on focus and moves focus to `<main>`.
- Panel titles become real `<h2>` elements (same visual style; reset margins). Do this at least for every panel on the Dashboard and in the bottom metrics row; list the other views you covered.
- Icon/glyph-only buttons (the approvals ⛉ and notifications ◈ in the top bar, and any others) get an `aria-label` naming the action and count, e.g. "3 pending approvals".
- Readouts that change live (reactor status text, pending-approval count) get `aria-live="polite"` on their container; not on every ticking number.

**AC3: 11px floor for functional text.** No readable text (labels, chips, captions, table values, button text) renders below **11px**. Today ~25 styles use 8-9px and ~79 use 10px (the `font:` shorthand, e.g. `` `600 10px/1 ${fonts.ui}` ``). Raise them to 11px. Exception: purely decorative glyphs with `aria-hidden` (e.g. tick marks). The frame is a FIXED 1536x1024 canvas (no reflow), so bigger text can overflow; fix any overflow you cause (tighten letter-spacing a step, not the size).

**AC4: contrast.** `colors.textDim` (#4e7c8b) measures ~3.8-3.9:1. Raise it in `src/styles/tokens.ts` to reach **≥4.5:1** against both `bgBase` (#020a10) and the panel surface (take `rgba(9,28,38,.8)` composited over #020a10). Keep the hue; raise lightness. Write the contrast computation as a unit test in `src/styles/tokens.test.ts` so it can't regress. Also mirror the value in `global.css` if it appears there. Check the new value still reads as "dimmer than textMuted".

**AC5: finish readout honesty outside the dashboard panel (left over from pass 1).** Pass 1 added `isSessionLive`, `computeRateReadout` and `NO_DATA` in `src/components/dashboard/dashboardMath.ts`; reuse them and don't re-derive.
- Sidebar reactor legend (`src/components/layout/Sidebar.tsx:~75-78`) still reads "REACTOR · 92.0K TOK/MIN" and "Reactor nominal — N agents drawing power" in bright cyan while the rest of the app says STANDBY. When not live, show `REACTOR · — TOK/MIN` and "Reactor on standby" in text-muted; when live, keep today's text. The rate must come from the same source pass 1 chose (`computeRateReadout`), not `state.rate`.
- Hide the sidebar reactor miniature while the Dashboard tab is active (the dashboard now shows the full reactor, so two are redundant). Keep the space stable: no layout jump in the sidebar nav when switching tabs.
- TOKEN USAGE card (bottom metrics row): before the first scan the total reads `—`, not `0`; zero-value day bars render as a thin baseline tick, not at full height.
- The reactor caption "— tok/min · live-rate pulse · cyan core" (`ReactorStatusCard.tsx`) must not say "cyan core" when idle; say "standby" instead.
- Unit-test each piece of text logic (pure functions); rendering is checked in the screenshots.

**AC6: carried nits from pass 1's refuter (small; do them while the files are open).**
- `src/components/layout/BottomMetricsRow.tsx:~50` uses a literal `'—'`; import and use `NO_DATA` from `src/components/dashboard/dashboardMath.ts`.
- `dashboardMath.ts:~59-64` `sessionCommandHistory` docstring overclaims past the 30-entry cap: reword to "the last min(commandsRun, 30) commands of this session".

## Files in scope
`src/components/**` (except the reactor internals listed below), `src/styles/tokens.ts`, `src/styles/global.css`, `src/App.tsx`, tests alongside.

## Do NOT
- Edit `src/components/reactor/StormCore.tsx`, `aetherStorm.ts`, `ReactorCore.tsx`, `drawWarp.ts`, `drawConduits.ts`, `drawHousing.ts`, `glShader.ts`.
- Change pass 1's behaviour (the dashboard reactor, readouts, STANDBY state), apart from AC5's caption fix. In those files you may only raise font sizes and add focus handling and landmarks.
- Change colours other than `textDim`; add a light theme; edit DESIGN.md/CLAUDE.md/PROGRESS.md; push or merge.

## Verify
1. Red-proof every new test (fails before, passes after); record one red line per test file.
2. `npm test`, `npm run build`, `npm run typecheck:electron`: all green (`npm ci` first if `node_modules` is missing).
3. Grep proof: a command showing zero remaining `[89]px/` and `10px/` font shorthands in `src/components/**` outside allowed decorative exceptions (list them).
4. Visual: `npx vite --port 5202 --strictPort --host 127.0.0.1` in the background. Playwright headless at 1536x1024: screenshot Dashboard, Agents, Ledger and Settings, plus a Tab walk (press Tab 6 times from the top and screenshot) to show the skip link and focus ring. Save to `<handoffs>/aether-os/shots-pass2/` (outside the repo, on the machine that ran the pass), look for overflow and clipping, then stop the server.
