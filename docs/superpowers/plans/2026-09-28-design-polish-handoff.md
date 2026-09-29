# Handoff: design system + polish passes 1-2 (2026-09-28)

Branch **`design/document-system`** (pushed to origin). Base: `a0f2fc7` on master. Not merged to master and no PR is open. That is the next decision.
Written on the work machine (`work-it`) for continuation on the home machine.

## Pick up at home

```
git fetch origin
git checkout design/document-system      # or: git worktree add ../Aether-OS-design design/document-system
npm ci
npm test          # expect 181 files passed / 1 skipped, 2067 tests passed / 14 skipped
npm run dev       # browser mode (idle/STANDBY is expected there: no pty, no live tracking)
```

**Not in the repo, so set it up on the home machine:**
- **impeccable** (design skills used for the critique): `npx impeccable install --global --providers=claude --no-hooks`. It was installed without hooks on purpose. Its critique commands read `DESIGN.md` and `.impeccable/` from this repo.
- **The `ui-ux-designer` agent edits** (reference-brand anchors from VoltAgent/awesome-design-md pinned at `f696123`; DESIGN.md upkeep with Known Gaps / Responsive Behavior; do NOT use `@google/design.md lint`, which was tested and missed single defects and hangs). These live in `~/.claude/agents/ui-ux-designer.md` on the work machine. Copy them via Claude-Files / claude-config if you want them at home.
- **Prototype canvas** comparing the three North Stars and the three component feels: https://claude.ai/artifact/WCuoXq8AeFLjL4gRpVx5QS

## What was built (commits on the branch, oldest first)

| Commit | What |
|---|---|
| `d36a3e3` | `DESIGN.md` + `.impeccable/design.json`: the incumbent design system recorded. North Star "The Reactor Console"; StormCore is the protected signature ("Living Core Rule"); controls are "Tactile and lit"; dark-only by rule. |
| `e99d8ee`, `b7ba9ee` | **Pass 1**: the real `<Reactor/>` fills the dashboard's REACTOR STATUS panel (replacing a 120px CSS stand-in); `storm` is the default renderer for new profiles; COMPOSE MISSION (an inert span) is removed; readouts come from one source each and show `—` instead of simulated values; MONTH TOKENS relabel; idle **STANDBY** state ("dark and cold": the reactor dims via filter, status is muted). Rework fixed a live signal that could stick on after a pty crash, and a commands count that disagreed after a restart. |
| `5490c56`, `4fe36f9`, `192d22b`, `c6fe191`, `9485356` | **Pass 2**: keyboard focus ring plus the lit focus state in `Button`/`useHoverStyle` (gated on `:focus-visible`); header/nav/main/footer landmarks and a skip link; ~45 panel titles are now `<h2>`; aria-labels on glyph buttons; a scoped `aria-live`; the 11px floor for all functional text (0 sub-11px elements across 14 views, measured in the DOM); `textDim` `#4e7c8b` → `#568898` (5.10:1 on bg, 4.61:1 on panels, asserted in `tokens.test.ts`); sidebar legend honest ("REACTOR · — TOK/MIN / Reactor on standby"); the sidebar mini-reactor is a placeholder on the Dashboard (one reactor animates); zero-value TOKEN USAGE bars are baseline ticks. |
| `c674196` | DESIGN.md updated to match what shipped; specs, the critique snapshot and this handoff committed; PROGRESS.md entry. |
| `f67c6dc`, `6a3a07e` | **Pass 3** (found by the live Electron check): the dashboard CONTEXT tile read `~245%` (`ctxUsed / 200000`, unclamped, wrong window for 1M models; pre-existing on master). It now reads the same clamped statusline reading as the Context Window card through one function (`computeContextReading`); "~n/a" is gone from DEPLETION ETA; the month-scoped SESSION INFO "Tokens used" row is removed (no session total exists in state). |

Specs: `docs/superpowers/specs/2026-09-28-polish-pass1-reactor-design.md`, `...-pass2-a11y-type-design.md`.
Critique that drove them: `.impeccable/critique/2026-09-28T20-35-01Z__src-components-dashboard-dashboardview-tsx.md` (score **22/40**, 4 P1s: all four closed).

## How it was verified
Each pass: an Opus/Sonnet builder, then a fresh refuter per round, never reused. Pass 1 took 1 rework round (2 must-fixes). Pass 2 took 2 rework rounds (3 must-fixes, then 1). All final verdicts were ACCEPT. Refuters rendered the app with Playwright at 1536x1024 across all 14 views. The final integrated run on `9485356`: vitest 2067 passed / 14 skipped, `npm run build` ok, `npm run typecheck:electron` ok.

Known flaky/environmental: `electron/communicationBridge/launchConfig.test.ts` "real ConPTY Ctrl+C" failed once with `AttachConsole failed` in a console-less shell. It passes in a normal terminal.

## Decisions made (don't relitigate)
- StormCore's look is protected: never redesign or recolour it in a polish pass.
- Dark-only. No light theme.
- `storm` is the default for NEW profiles only. Saved profiles keep their renderer (no migration).
- STANDBY when no session is live. `isSessionLive` (`src/components/dashboard/dashboardMath.ts`) = burn rate > 0, OR an open dispatch while `terminalAlive`, OR a fresh statusline, OR a fleet row with status `busy`. An idle external Claude window does not count.
- TOP COMMANDS on the dashboard is session-scoped (header "THIS SESSION"); Analytics' TopCommandsCard still shows all history on purpose.

## Still open (also in DESIGN.md → Known Gaps)
1. **Re-run the critique** to measure the change: `/impeccable critique` on `src/components/dashboard/DashboardView.tsx` (baseline 22/40).
2. ~~**Duplicate STANDBY announcement**~~ **DONE 2026-09-28** (Codex P2 on PR #90): the two `aria-live="polite"` regions were the ReactorStatusCard DIV and the always-mounted Footer SPAN, not two elements in the card. The card's region is removed; the Footer is the one live region (`ReactorStatusCard.test.tsx`). The sidebar legend keeps its own scoped region ("Reactor on standby").
3. **Empty states** (was P2): panels with no data are one dim line in a big box. Add compact states with a next action.
4. **Token drift**: ~32 hardcoded colours in the shell chrome (TopBar 9, Sidebar 5, BottomMetricsRow 4); `radii`/`space` tokens barely used.
5. **Motion**: no designed easing curves yet (`motion.easing.standard`/`emphasis` are browser defaults), and the pressed state isn't implemented.
6. **Grid keyboard access**: OrchestrationGrid SVG nodes aren't focusable.
7. **Pre-existing clipping**: the RECENT AGENTS sidebar label, and the Settings left column under the bottom row.
8. ~~Live-mode check~~ **DONE 2026-09-28** on `6a3a07e`, in an isolated profile (e2e harness isolation plus a read-only junction to real transcripts and a copied statusline snapshot). STANDBY → NOMINAL power-up at +4.5s from a real burn rate; CONTEXT tile `52% · 515.9K / 1.00M` matches the card's `52% · 515,932 / 1,000,000`; no "n/a". Caution if you repeat it: unlink the junction (`[IO.Directory]::Delete(path, $false)`) BEFORE deleting the temp root, or a recursive delete follows it into your real `~/.claude/projects`.
9. Nit: `Sidebar.test.tsx:109-112` comment says "grandparent"; it's the parent.
10. `BottomMetricsRow.tsx:215` animates `height` (detector finding); switch to a transform.
11. Pass 3 nits: `ContextWindowCard.ringPct` is no longer rendered (the ring uses `ctxReading.pct`), so drop it or repoint its test; the `dashboardMath.ts:~138` `burn <= 0` guard lets NaN through (use `!(burn > 0)`); `fmtEta` can still put "n/a" in prose in `terminal/commands.ts:82` and `comms/localResponder.ts:19`.
12. The agent-improvement app-dev lesson "never sum cache-read tokens into a context-window figure" overgeneralises: for Claude Code's statusline `context_window.current_usage` (one request), input + cache_creation + cache_read IS the context and matches `used_percentage`. The rule holds only for summing across transcript records. Amend the lesson.

## Suggested next step
PR #90 is open (check its CI status on GitHub; the live check is done). Merge it when ready, then re-run the critique (item 1) to measure the change against 22/40, and pick the next pass from items 2-6 (empty states and token drift are the biggest).
