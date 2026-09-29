---
target: dashboard (post polish passes 1-3)
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:C:\\Users\\Matt\\projects\\aether-os\\src\\components\\dashboard\\DashboardView.tsx"
target_fingerprint: "sha256:23b50dd58bd98e1575cd18ff90b6deff36d84b212564783c7faec201c283ec7b"
target_path: "C:\\Users\\Matt\\projects\\aether-os\\src\\components\\dashboard\\DashboardView.tsx"
timestamp: 2026-09-29T02-29-31Z
slug: src-components-dashboard-dashboardview-tsx
---
Method: dual-agent (A: design review · B: detector + browser overlay). Browser mode at 1536x1024, STANDBY (no pty, no live tracking).

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Honest STANDBY + `—`, but four "no data" spellings (`—`, `--`, "No reading yet", "no reading yet") |
| 2 | Match System / Real World | 3 | "Memory engrams", "MEMORY SWEEP", "live-rate pulse" unexplained |
| 3 | User Control and Freedom | 2 | MEMORY SWEEP runs a command and navigates away in one click, no undo |
| 4 | Consistency and Standards | 2 | ACTIVE AGENTS card uses its own radius/bg/heading; two link patterns; off-palette `#8ab6ff` |
| 5 | Error Prevention | 2 | PLAN/EDITS/AUTO switches to auto-approve in one click; risk only in a tooltip |
| 6 | Recognition Rather Than Recall | 3 | Reactor legend hidden on the one view where the reactor is large |
| 7 | Flexibility and Efficiency | 2 | Only CTRL+K; panels not clickable into their views |
| 8 | Aesthetic and Minimalist Design | 2 | ~55% of the main area is empty teal panels at idle |
| 9 | Error Recovery | 1 | No error states; empty states offer no next action; raw unstyled collector error on Agents view |
| 10 | Help and Documentation | 1 | Nothing tells a first-run/browser user that STANDBY means "start a session" |
| **Total** | | **21/40** | **Acceptable** |

## Design Specificity Verdict

LLM: authored in about 30% of the canvas. The standby reactor is unmistakably this product; the four surrounding panels are a heading plus one dim line in a teal box and are category-interchangeable.

Detector: DashboardView.tsx itself is clean. dashboard/ has 1 advisory (`#bff4ff`, ReactorStatusCard.tsx:212). layout/ has 18: 1 `layout-transition` (BottomMetricsRow.tsx:212 height), 1 radius advisory (BottomMetricsRow.tsx:208), 16 colour advisories (Sidebar.tsx 168/183/193, TopBar.tsx 239/271/272/330/347/431/434/453, BottomMetricsRow.tsx 150/156). Overlay on Dashboard: 38 findings. False positives: dark-glow / cyan ai-color-palette / radial-spotlight (the reactor and live glow are the design, per the Living Core Rule), clipped-overflow on `div.pulse-anim`. Real: `transition: height`, a `low-contrast` hit (`#568898` on composited panel `#0a1d26` = 4.4:1, below 4.5), and the colour drift.

## Priority Issues

- [P1] Empty panels are dead space with no next action. ActiveAgentsDigest.tsx:30, ProjectsDigest.tsx:22, RecentAlertsCard.tsx:20, BottomMetricsRow zero states. Fix: compact empty states with one verb each, or an idle composition where the reactor and a "start a session" action take the space. /impeccable onboard, then /impeccable layout.
- [P1] State not exposed to assistive tech. Button (shared/Button.tsx) has no aria-pressed/aria-current passthrough; nav lacks aria-current, mode pills and LIVE/DAILY/WEEKLY lack aria-pressed; reactor canvas and context SVG unlabeled. Fix: add the props to Button, role="img" + aria-label on the reactor. /impeccable harden.
- [P2] ACTIVE AGENTS card breaks the panel system (ActiveAgentsDigest.tsx:36-54). Fix: one shared Panel + PanelHeading for all nine cards. /impeccable polish.
- [P2] "No data" vocabulary, glow and contrast drift. `--` at BottomMetricsRow.tsx:158; "No reading yet" set in bold mono; glowing 0% ring dot (BottomMetricsRow.tsx:147-152) breaks Glow-Is-State; `#8ab6ff` at SystemsCard.tsx:11; textDim 4.4:1 on composited panels. /impeccable clarify + /impeccable colorize.
- [P2] MEMORY SWEEP does too much for its weight (ReactorStatusCard.tsx:144-151). Fix: in STANDBY swap it for the action that ends standby; don't auto-navigate. /impeccable clarify.

## Persona Red Flags

Alex: 20 tab stops before the first dashboard control; 14-item flat sidebar; panels not clickable; AUTO one unguarded click; context shown 3 times, agents 3 times.
Sam: no aria-current / aria-pressed; no h1; unlabeled reactor canvas and context SVG; KPI tiles read as three loose strings; sidebar "no active agents" line below the nav scroll edge.

## Minor Observations

⚡ in "⚡ AUTO" renders as an orange emoji (accidental amber, TopBar.tsx:19); OPEN TERMINAL keeps a resting glow in STANDBY and retypes token literals (ReactorStatusCard.tsx:223-244); sidebar nav shows a scrollbar at the design canvas; unstyled "collector isn't running -- diagnostics unavailable" on Agents; Session start vs Uptime duplicated with footer; RecentAlertsCard uses array index keys; heading tracking varies (3px / 1.2px / 2px).

## Questions to Consider

- If STANDBY is what most sessions open on, should idle be its own composition rather than an empty LIVE layout?
- Is the reactor an instrument or an illustration if its legend is hidden where it is largest?
- Should each fact (context, agents, uptime) live in exactly one place?
