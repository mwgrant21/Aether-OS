---
target: "dashboard (idle composition, PR #92)"
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:C:\\Users\\Matt\\projects\\Aether-OS-cold\\src\\components\\dashboard\\DashboardView.tsx"
target_fingerprint: "sha256:1b8aa895178b62411662472c31fea4e470631fda354752c0c526ef98e8980529"
target_path: "C:\\Users\\Matt\\projects\\Aether-OS-cold\\src\\components\\dashboard\\DashboardView.tsx"
timestamp: 2026-09-29T07-50-27Z
slug: src-components-dashboard-dashboardview-tsx
---
Method: dual-agent (A: design review · B: detector + browser overlay), on PR #92 (idle composition / cold cockpit). Partial isolation: the agents share one Playwright browser; B injected its overlay once into A's page before correcting (A hid all overlay nodes and did not read them).

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | STANDBY consistent; SESSION INFO shows a session start + ticking uptime under STANDBY |
| 2 | Match System / Real World | 3 | Plain readiness sentences; Collector/Statusline/engrams unexplained |
| 3 | User Control and Freedom | 2 | Alerts strip item opens a far-away dropdown with no Escape and no focus move |
| 4 | Consistency and Standards | 2 | OPEN TERMINAL disabled on Dashboard but enabled-looking on Agents in browser mode; section vs div panels |
| 5 | Error Prevention | 3 | aria-disabled primary, focusable, explained |
| 6 | Recognition Rather Than Recall | 3 | Strip items say where they go; Alerts opening a dropdown is a surprise |
| 7 | Flexibility and Efficiency | 1 | No shortcuts, no palette, 21 tab stops to OPEN TERMINAL |
| 8 | Aesthetic and Minimalist Design | 2 | ~440x640 empty region under READINESS; reason printed twice; eight "—" readouts |
| 9 | Error Recovery | 2 | Four unmet readiness rows, no way to resolve any |
| 10 | Help and Documentation | 1 | Nothing explains readiness items or how to fix them |
| **Total** | | **22/40** | **Acceptable** |

## Design Specificity Verdict

LLM: specific — the reactor is the centrepiece and the standby honesty is right. The idle composition swapped empty boxes for an empty region: the right column is content-height (READINESS and the strip are flex:none), leaving ~45% of the main area bare.

Detector: dashboard/ and shared/ 0 findings; layout/ 13 advisory colours (same as before). Overlay: Dashboard 33 (mostly intended cyan glow on the reactor/live elements), 4 shell clipped-overflow, 1 tiny-text, 1 em-dash-overuse.

## Priority Issues

- [P1] Idle right column leaves a dead void (DashboardView.tsx:23,48; ReadinessCard.tsx:44 and StandbyStrip.tsx:60 flex:none). Fix: make the column span the reactor's height on purpose — READINESS grows with per-row fix hints/actions, or the strip anchors to the bottom, or a recap block fills the lower half. /impeccable layout then /impeccable onboard.
- [P1] Alerts strip item opens the notifications dropdown ~600px away; no Escape, no focus move (StandbyStrip.tsx:24-27; TopBar.tsx:161). Fix: focus into the panel and back, Escape + outside-click close. /impeccable harden.
- [P2] Desktop-app reason printed twice (readinessMath.ts:48 + OpenTerminalButton.tsx:31-35). Fix: row reads "Desktop app: not running."; reason only under the button. /impeccable distill.
- [P2] Standby contradictions: SESSION INFO session start/uptime under STANDBY; cyan zero counts in the strip (StandbyStrip.tsx:76-78). Fix: "—"/"App opened"; zeros in Text Muted. /impeccable colorize, /impeccable clarify.
- [P2] OPEN TERMINAL enabled-looking on the Agents view in browser mode. Fix: route every OPEN TERMINAL through OpenTerminalButton. /impeccable harden.

Also (Codex on PR #92): ACTIVE AGENTS digest can stay visible after the pty dies because presence ignores terminalAlive (readinessMath.ts:79); DigestSlot keeps its flex share during the 500ms exit, so the column can compress/overflow (DigestSlot.tsx:59).

## Persona Red Flags

Alex: no shortcuts/palette; duplicated "nothing" readouts; no way to act on READINESS; zero-count Memory link.
Sam: 21 tab stops (skip link works); Alerts dropdown has no focus transfer or Escape; REACTOR STATUS and digests are divs not regions; strip buttons don't say they navigate; comms button shows browser outline.

## Minor Observations

KPI value 17px off-scale; radius 8 vs 9 token on OPEN TERMINAL; reactor card padding 16 vs 15; literal rgba in ActiveAgentsDigest:73; orphan RECENT AGENTS label; Projects empty copy differs between view and digest; Agents diagnostics sentence floats.

## Questions to Consider

- Should the idle right column tell the last session's story, with readiness shrinking once met?
- Should browser mode show a real preview state instead of a wall of "not running"?
- Could READINESS fill the height as a power-up sequence that lights row by row?
