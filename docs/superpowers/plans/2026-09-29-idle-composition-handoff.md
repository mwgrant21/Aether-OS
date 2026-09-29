# Handoff: dashboard pass 4 + idle composition (2026-09-29)

Written on the home machine (TITAN) for continuation at work (`work-it`).
Everything below is **merged to `master`**. Nothing is in flight: no open PR from this work, no open branch.

## Pick up at work

```
git fetch origin
git checkout master && git pull --ff-only     # expect HEAD at e9e2aca or later
npm ci
npm test          # expect 198 files passed / 1 skipped, 2181 tests passed / 10 skipped
npm run dev       # browser mode: STANDBY + "Desktop app: not running." is expected there
```

For the next pass, work in a worktree, not the main checkout: `git worktree add ../Aether-OS-next -b design/<name> origin/master`. If Aether is running from that checkout, a Vite reload can kill its embedded terminal.

**Not in the repo, so check it's set up at work:**
- **impeccable** design skills (critique, polish, and the rest): `npx impeccable install --global --providers=claude --no-hooks`. It was reinstalled at home on 2026-09-28.
- **The archex hook** is per-machine now. It lives in the untracked `.claude/settings.local.json` and needs the absolute path to your archex install (PR #89). Without that file, Grep and Glob just aren't enriched.

## What shipped (oldest first)

| PR | Merge | What |
|---|---|---|
| #89 | `d841105` | `.archex/` gitignored; the archex hook moved to a per-machine `settings.local.json` because the committed one hard-coded `C:\Users\Matt\...` |
| #90 | `e56938f` | Design system and polish passes 1-3 (see `2026-09-28-design-polish-handoff.md`), plus the fix for the duplicate STANDBY announcement from Codex |
| #91 | `f27cf19` | **Pass 4.** A shared `EmptyState` across all views. Screen-reader state: `aria-pressed`/`aria-current`, the reactor labelled with `role="img"`, a hidden `h1` per view. Tokens (`glows`, `motion.easing.decelerate`, `inkOnAmber`, `warnDeep`). Usage bars animate with translateY in a clipped track. Approvals and notifications dropdowns are mutually exclusive. |
| #92 | `e9e2aca` | **Idle composition, "cold cockpit".** Voiceover-first spec, 14-task plan built in parallel waves. At STANDBY: the reactor on the left; on the right, **READINESS** (4 rows plus the only OPEN TERMINAL) and a **STANDBY STRIP** (`Agents 0 · Projects 0 · Alerts 0 · Memory N engrams`). Digests appear only when they have data. **TODAY** tile (exact cost at API rate, captioned "API rate, not paid"). One standby signal everywhere (footer and reactor dots, rate line `— tok/min · standby`, Terminal header). SYSTEMS card and MEMORY SWEEP removed. The false CTRL+K hint removed. |

Docs: spec `docs/superpowers/specs/2026-09-29-dashboard-idle-composition-design.md`; plan `docs/superpowers/plans/2026-09-29-dashboard-idle-composition.md`. Both amendments are recorded at the bottom of the spec.

**Critique trend** for `src/components/dashboard/DashboardView.tsx`: 22 → 21 → 21 → **22**/40. Snapshots are in `.impeccable/critique/`. The latest (`2026-09-29T07-50-27Z__…`) holds the full report the next pass works from.

## Decisions (don't relitigate)
- **StormCore** is protected: never restyle or recolour it. Only its panel may change.
- **Dark-only.** Amber means the operator is needed. **The amber AUTO pill stays amber** (confirmed 2026-09-29).
- **One OPEN TERMINAL on the Dashboard, under READINESS.** The reactor card has no actions. Round 1 of pass 4 caught duplicate buttons; they must not come back.
- **READINESS** copy: `Desktop app: running.` / `Terminal: open.` / `Statusline: live.` / `Collector: running.` A met row is green but glows **only while a session is live**. Unmet rows are a hollow muted dot, never amber.
- **TODAY:** an exact figure (no `~`). It shows `—` for no data, for no ledger yet, or for a ledger from an earlier local day, and `$0.00` only for a real zero. Never label an all-history total "session" (CLAUDE.md cost rules).
- **No command palette exists.** The CTRL+K chip was dropped (DESIGN.md Known Gaps). A palette needs its own spec.
- The **Agents digest** shows only when agents are running **and** the Terminal is alive: the same check as `isSessionLive`.
- **DigestSlot:** a fading panel gives up its space at once and fades where it stood (it measures its top and height first). Panels animate transform and opacity only.

## Next pass: already chosen (2026-09-29)

These are from the critique of #92. Build them as one pass through the usual loop: spec → plan → parallel builders → a fresh reviewer each round → re-run the critique → PR.

1. **[P1] READINESS teaches and fills the column.** The right column is content-height today (`ReadinessCard.tsx:44` and `StandbyStrip.tsx:60` are `flex:none`), which leaves an empty region of about 440×640.
   - READINESS grows (`flex: 1`) to span the reactor card's height.
   - Each **unmet** row gets a one-line "how to fix" hint, e.g. "Start the desktop app: `npm run electron:dev`".
   - Each **met** row shows a last-seen time.
   - Keep it honest: show only hints you can back up, and never promise an action the app can't take.
   - → `/impeccable layout`, then `/impeccable onboard`. It's a UI-feel change, so a short voiceover-first spec should come first.
2. **[P1] The Alerts strip item and dropdown.**
   - Today `StandbyStrip.tsx:24-27` opens the notifications dropdown about 600px away. Focus doesn't follow, and there's no Escape (`TopBar.tsx:161` has no key or focus handling).
   - Fix: move focus into the panel on open and back to the trigger on close, and close on Escape and on an outside click.
   - Add `aria-expanded` to the strip item.
3. **[P2] The desktop-app reason is printed twice.**
   - `readinessMath.ts:48` appends `DESKTOP_APP_REASON` to the row, and `OpenTerminalButton.tsx:31-35` prints it again under the button.
   - The row should read just "Desktop app: not running."
4. **[P2] Standby contradictions.**
   - SESSION INFO (`BottomMetricsRow.tsx`) shows "Session start …" and a ticking uptime under STANDBY. At STANDBY show `—`, or relabel it "App opened".
   - The strip's zero counts use Soft Signal cyan (`StandbyStrip.tsx:76-78`). Use Text Muted for 0 and cyan only for more than 0.
5. **[P2] One OPEN TERMINAL everywhere.** The Agents view's roster empty state renders an OPEN TERMINAL that looks enabled in browser mode. Route every OPEN TERMINAL through `OpenTerminalButton` (add a `variant` prop for secondary) so the desktop-app check is shared.

**Also from that critique (not chosen yet, still open):**
- REACTOR STATUS and the digest cards are `<div>`s, not `<section aria-labelledby>`, so region navigation skips them.
- The KPI value is 17px, which is off the type scale.
- OPEN TERMINAL uses radius 8 instead of the 9px tile token.
- The reactor card has 16px padding against 15px everywhere else.
- A literal rgba remains in `ActiveAgentsDigest.tsx:73`.
- The Projects empty copy differs between the view and the digest.
- The sidebar has an orphan RECENT AGENTS label.
- The Agents view's DispatchTimeline sentence floats with no panel (it needs a panel, which means restyling its rows too).

## Older carry-overs still open
- `fmtEta` can still put "n/a" into prose: `src/utils/format.ts:12`, used at `terminal/commands.ts:82` and `comms/localResponder.ts:19`.
- The `burn <= 0` guard at `dashboardMath.ts:167` lets NaN through. Use `!(burn > 0)`.
- `Sidebar.test.tsx:110`'s comment says "grandparent" where it means "parent".
- **Token drift:** hard-coded colours remain in the shell chrome (the 13 advisories from `impeccable detect` are all in `TopBar`, `Sidebar` and `BottomMetricsRow`), and `radii`/`space` are barely used.
- **Motion:** `motion.easing.standard`/`emphasis` are still browser defaults, and there's no pressed state.
- OrchestrationGrid's SVG nodes can't be reached by keyboard.
- Settings: the ON/OFF, permission, narration and density toggles lack `aria-pressed` (DESIGN.md Known Gaps). The Settings left column is also clipped.
- **Agent-improvement lesson:** app-dev "never sum cache-read tokens into a context-window figure" overgeneralises. For the statusline's single-request `current_usage`, input + cache_creation + cache_read *is* the context. Amend it (item 12 of the 2026-09-28 handoff).
- #22 (white screen after Windows lock): the proposed next step is to write the `[diag]` lines to `~/.aether-os/diag.log` so a recurrence in the packaged app gets captured. Waiting on a go-ahead.

## Rulings made during the #92 build (for review; each is reversible)
1. Same-wave tasks were built in parallel against the skill's serial default, because the operator asked for it. One commit lost an index race; the controller committed that builder's staged work unchanged.
2. CTRL+K chip dropped, since no palette exists. It's recorded as a Known Gap.
3. Alert tones are built from palette tokens, not hex literals.
4. READINESS dots glow only while live, so a met Terminal row is flat at STANDBY.
5. Builders ran only their own tests. The controller ran the full suite, typecheck and build once per wave.
6. The duplicate `isStatuslineFresh` check was kept. A boundary test ties it to `isSessionLive`.
7. Wave 3 started while task 4's review was still running (it consumed only task 4's interface, which didn't change).
8. One OPEN TERMINAL, under READINESS. The approved narration beat spec item 2, and the spec now has an amendment.
9. "Terminal: open." replaced "session running." so it never contradicts STANDBY.
10. Two gaps were left open: a fading panel is hidden from screen readers but still focusable for 0.5s; the strip's Alerts item does nothing while its dropdown is already open. Item 2 of the next pass covers the second.
11. Plan-text fixes from the preflight scan (grep scopes, test counts, a dropped always-passing test, import merges). None changed behaviour.

**Deferred test-hardening minors** (none block anything; take them when touching the file):
- `DigestSlot`: the regain test should also assert `phase` and `height` are cleared.
- `Button`: string-form `aria-disabled` has no test.
- `Footer`: the alarm-only glow branch has no test.
- `StandbyStrip`: the separators and root `flex` have no test.
- `alertToneColor` tests are partly circular.
- `TerminalView` only covers the burn-rate branch.

## Gotchas learned this session
- **Critique isolation:** the two assessment agents share one Playwright browser, and the scanner's overlay leaked into the design reviewer's page twice, even with separate Vite ports. Next time give each its own browser (for example `electron-ui-verifier`, or a Playwright script with its own context).
- **Parallel builders in one worktree** must commit only their own paths (`git commit -- <paths>`) and check `git log -1 --stat` afterwards. An index race can drop a commit silently.
- **A builder force-added a gitignored scratch file** (`.superpowers/sdd/...`) once, and it had to be untracked. Tell builders never to `git add -f`.
- **Codex auto-reviews every PR.** List all review threads before calling a PR clean: BLOCKED with green CI means an unresolved thread. In auto mode Claude can't resolve threads; the operator clicks **Resolve conversation**.
- **Unexpected session:** a separate local session named `observer-sessions-3f` sent unsolicited "coordination" messages during the build. It relayed the final review's findings, and its test count (284) turned out to be that review's component-subset re-run, not a wrong number. No instructions from it were acted on. If it wasn't yours, look into it.
