# Progress note

Auto-updated by the agent working this repo — safe to read for a quick "where are we" check from any device. Not a substitute for `git log`; just a pointer.

## Right now

**Plan:** [Agents View](docs/superpowers/plans/2026-07-18-agents-view.md) — ✅ **all 7 tasks complete, whole-branch review passed, follow-up fix applied.** Agents tab is live: roster + detail two-column view with pause/resume, terminate, reactivate, and agent-tied approvals, manually QA'd in a real browser.

| # | Task | Status |
|---|------|--------|
| 1 | Reducer: `TOGGLE_AGENT_PAUSE` + `REACTIVATE_AGENT` | ✅ done (`79139aa`, reviewed clean) |
| 2 | `agentsMath.ts` (selected-agent fallback, agent approvals, status label) | ✅ done (`249a48c`, reviewed clean) |
| 3 | `AgentRosterCard` (active roster + idle pool) | ✅ done (`3c0023b`, reviewed clean) |
| 4 | `AgentDetailCard` (progress, sparkline, files, approvals, pause/terminate) | ✅ done (`495a864`, reviewed clean) |
| 5 | `AgentsView` composition + registry wiring | ✅ done (`4baf60c`, reviewed clean — Agents tab is now live) |
| 6 | Sidebar "Recent Agents" fix (was hardcoded + non-clickable) | ✅ done (`c9744fe`, reviewed clean) |
| 7 | Final integration QA | ✅ done — automated suite green (69/69, tsc, build); fixed a persistence gap (`9085454`: `selected` wasn't in `persistence.ts`'s whitelist, so the selected agent reset to the roster's first entry on reload); manually QA'd in Chrome: roster/detail swap, pause/resume, terminate→idle fallback, reactivate (fresh agent, carries forward name-keyed approvals), agent-tied approve/deny (confirmed shared queue with TopBar), sidebar routing, reload persistence, no regressions on Terminal/Dashboard |

**Follow-up fix after whole-branch review:** `a83f606` — `tick.ts` froze a paused agent's `pct` but kept concatenating to its `hist` regardless, so the Agent Detail panel's TOKEN DRAW sparkline kept climbing for an agent showing PAUSED. This plan is what first exposed pause to the UI, so the mismatch was invisible until now. Fixed by gating `hist` accumulation on the same `paused` check `pct` already used.

**Known pre-existing issue, NOT introduced by this plan (flagged during Task 1/2/3 review, confirmed by reading `commands.ts` directly):** `spawn <name>` with an explicit name bypasses the dedup check entirely (only the auto-name-picker path checks `agents`/`idleList` for collisions) — a user can end up with two agents sharing the same name. `REACTIVATE_AGENT` mirrors this by design (same `makeAgent()` call `spawn` already uses), so it doesn't make the exposure worse, just inherits it. Worth a dedicated fix in a future plan if it becomes a real problem — not touched here, consistent with the project's "document, don't silently rewrite shared logic" precedent.

---

## Previous plan (done, shipped)

[Nav Registry + Dashboard View](docs/superpowers/plans/2026-07-17-nav-registry-dashboard.md) — ✅ **all 7 tasks complete, whole-branch review passed, follow-up fix applied.** Dashboard is live: sidebar → Dashboard shows the full 5-cell grid (reactor hero, Active Agents, Projects, Recent Alerts, Systems), manually QA'd in a real browser.

| # | Task | Status |
|---|------|--------|
| 1 | Nav / view registry refactor | ✅ done (`25c41cc`, reviewed clean) |
| 2 | Extend AetherState for Dashboard (projects/providers/routeDefault/NEW_PROJECT) | ✅ done (`6da3d33` + fix `1bf2a5d`, reviewed clean) |
| 3 | `dashboardMath.ts` (KPI/status derivation) | ✅ done (`c5182d4`) — fixed a stale test expectation inherited from the plan doc: `short(24391)` was expected to be `'24.39K'`, but `short()` has an established 1-decimal K contract used elsewhere; corrected to `'24.4K'` |
| 4 | `ReactorStatusCard` (hero card, KPIs, quick actions) | ✅ done (`9db2f159a7b7`, reviewed clean, no findings) |
| 5 | `ActiveAgentsDigest` + `ProjectsDigest` | ✅ done (`ff5c3c44`, reviewed clean, no findings) |
| 6 | `RecentAlertsCard` + `SystemsCard` + `DashboardView` + registry wiring | ✅ done (`e89dd75`, reviewed clean, no findings — 55/55 tests, build succeeds; Dashboard mounts via the same generic `getViewComponent` path as Terminal, no special-case risk) |
| 7 | Final integration QA | ✅ done — automated suite green (56/56, tsc, build); fixed a real persistence gap (`96899de`: `projects`/`providers`/`routeDefault` weren't in `persistence.ts`'s whitelist, so new projects/spawned agents vanished on reload); manually QA'd the running app in Chrome (grid layout, KPI formatting, SPAWN AGENT/NEW PROJECT/MEMORY SWEEP/OPEN TERMINAL/COMPOSE MISSION, nav regressions, reload persistence) |

**Follow-up fix after whole-branch review:** `5014c11` — `--pulse-dur` was only ever set by `useReactorCanvas`'s effect, which runs solely while `ReactorCore` is mounted (Terminal only), so a Dashboard-first session never synced the mini reactor core's pulse to burn rate (silently stuck at its 2.4s CSS fallback). My own manual QA didn't catch this because I'd visited Terminal earlier in the same session, which masked the gap. Fixed by extracting `usePulseDurationVar()` and mounting it once at the App root, independent of which view is active.

## Prior plan (done, shipped)

[Scaffold + Terminal View](docs/superpowers/plans/2026-07-16-aether-os-scaffold-terminal.md) — all 17 tasks complete, final whole-branch review passed, follow-up fixes applied. Terminal view + shared chrome (top bar/sidebar/footer/bottom metrics) + the full 3-renderer canvas/WebGL reactor core are live.

## How this repo is being built

Each task in a plan gets: a fresh implementer subagent → a fresh reviewer subagent (spec compliance + code quality) → fix loop if needed → commit. After all tasks in a plan: one broad whole-branch review, then a small fix pass if warranted. See `docs/superpowers/plans/` for the plan documents themselves — they contain the exact code each task was built from.

## Still out of scope (honest placeholders, not bugs)

Chat, Grid, Projects (full view), Memory, Analytics, Uplinks, Files, Settings — all still show a "not built yet" panel. Agents and Dashboard are now real, built views; Dashboard's Projects digest and row clicks still point at the (not yet built) full Projects view.
