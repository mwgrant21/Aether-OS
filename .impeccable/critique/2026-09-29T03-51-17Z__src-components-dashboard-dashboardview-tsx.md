---
target: "dashboard (pass 4, PR #91)"
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:C:\\Users\\Matt\\projects\\Aether-OS-idle\\src\\components\\dashboard\\DashboardView.tsx"
target_fingerprint: "sha256:23b50dd58bd98e1575cd18ff90b6deff36d84b212564783c7faec201c283ec7b"
target_path: "C:\\Users\\Matt\\projects\\Aether-OS-idle\\src\\components\\dashboard\\DashboardView.tsx"
timestamp: 2026-09-29T03-51-17Z
slug: src-components-dashboard-dashboardview-tsx
---
Method: dual-agent (A: design review · B: detector + browser overlay), on branch design/idle-empty-states-a11y (PR #91, pass 4). Isolation note: the shared browser context carried B's overlay into A's first screenshot; A hid it for every later capture and no finding rests on it.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Footer dot still glows at STANDBY (Footer.tsx:25); rate line says "live-rate pulse · standby"; Terminal header says "session active" |
| 2 | Match System / Real World | 2 | Jargon: live-rate pulse, engrams, MEMORY SWEEP, Uplinks, EST/STALE; "2.0M cap" of what |
| 3 | User Control and Freedom | 2 | MEMORY SWEEP runs and navigates away, no undo; RecapBanner auto-dismisses for good |
| 4 | Consistency and Standards | 2 | Agents copy differs Dashboard vs Agents/Terminal; `#8ab6ff` off-palette; context shown twice |
| 5 | Error Prevention | 2 | Side-effecting MEMORY SWEEP at equal weight beside the primary |
| 6 | Recognition Rather Than Recall | 3 | CTRL+K only in 11px dim text in SYSTEMS |
| 7 | Flexibility and Efficiency | 2 | No drill-down from rows; no visible shortcuts; 21 tab stops to OPEN TERMINAL (skip link helps) |
| 8 | Aesthetic and Minimalist Design | 2 | Four panels mostly empty glass at idle, and four readouts duplicated with the bottom row/footer |
| 9 | Error Recovery | 2 | "Terminal OFFLINE" gives no reason or fix on the dashboard |
| 10 | Help and Documentation | 1 | Nothing explains EST/LIVE/STALE, `~`, or what a sweep does |
| **Total** | | **21/40** | **Acceptable** |

## Design Specificity Verdict

LLM: specific in the reactor quadrant only; the other ~60% is four equal translucent boxes with one line each. Idle is the live layout with nothing in it, not a designed "powered down" composition.

Detector: dashboard/ and shared/ have 0 findings (baseline: 1 in dashboard). layout/ has 13 advisory colour findings (baseline 18, and the `transition: height` warning is gone). Overlay: Dashboard 30 (baseline 38); the `low-contrast` hit from the baseline is gone; `layout-transition` gone. Remaining overlay hits are mostly intended cyan glow on the reactor/live elements (false positives), plus 5 shell clipped-overflow containers, 2 tiny-text.

## Priority Issues

- [P1] Idle layout is mostly dead glass (DashboardView.tsx:20-27, fixed `1fr 1fr` rows). Fix: an idle composition — a compact standby strip for the empty digests and the space given to the reactor plus a readiness checklist, or content-sized rows when empty. /impeccable layout then /impeccable onboard.
- [P1] Standby signals contradict each other: Footer dot glows at STANDBY (Footer.tsx:25), "live-rate pulse · standby" (dashboardMath.ts:45-48), Terminal header "session active". Fix: gate glow on live/alarm, drop the pulse string when idle, derive the terminal header from isSessionLive. /impeccable harden.
- [P2] MEMORY SWEEP is a side-effecting twin of the primary (ReactorStatusCard.tsx:150-158). Fix: move it to Memory/SYSTEMS or make it a quiet link, disabled at STANDBY; OPEN TERMINAL full width. /impeccable distill.
- [P2] Redundant readouts vs the bottom row/footer (context, agents active, commands run, uptime). Fix: swap the CONTEXT KPI for session cost; drop duplicates. /impeccable distill.
- [P3] Copy and colour drift: one sentence per concept across views; `#8ab6ff` (SystemsCard.tsx:17) and alert `nf.c` colours onto tokens; surface CTRL+K. /impeccable clarify, /impeccable colorize.

## Persona Red Flags

Alex: no drill-downs, one buried shortcut, 14 flat nav items, MEMORY SWEEP mis-click hazard, duplicated metrics.
Sam: mostly good now (skip link, landmarks, h1, aria-current/pressed, labelled reactor, visible ring). Remaining: Sidebar and Footer both announce standby; panels are divs not regions; KPI tiles read as loose strings; the comms button shows the browser outline instead of the designed ring.

## Minor Observations

Orphan "RECENT AGENTS" label over the sidebar placeholder; DispatchTimeline's sentence floats without a panel on Agents; Analytics shows TOP COMMANDS twice; "BUDGET LEFT — of 2.0M cap" unclear; button radius 8px vs 9px token, 4px source chip; green "0" for pending approvals.

## Questions to Consider

- Should STANDBY be a designed cold cockpit with its own composition and a readiness checklist?
- Does the Dashboard need its own agents/projects/alerts digests when the bottom row and views already carry them?
- Should the reactor carry a legend so the one spectacular element is also legible?
