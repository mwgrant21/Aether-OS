---
target: Aether OS dashboard
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
target_identity: "file:C:\\Users\\IT\\Desktop\\Aether-OS-design\\src\\components\\dashboard\\DashboardView.tsx"
target_fingerprint: "sha256:23b50dd58bd98e1575cd18ff90b6deff36d84b212564783c7faec201c283ec7b"
target_path: "C:\\Users\\IT\\Desktop\\Aether-OS-design\\src\\components\\dashboard\\DashboardView.tsx"
timestamp: 2026-09-28T20-35-01Z
slug: src-components-dashboard-dashboardview-tsx
---
Method: dual-agent (A: design review, Opus · B: detector, Sonnet)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Readouts contradict: 92,000 tok/min next to 0 session tokens, two uptimes, NOMINAL/ALL GOOD while the terminal is offline |
| 2 | Match System / Real World | 3 | Cockpit vocabulary fits; "engrams", "sweep" and "uplinks" are private jargon |
| 3 | User Control and Freedom | 3 | Modes are one click away and the nav is clear |
| 4 | Consistency and Standards | 2 | ACTIVE AGENTS heading off-style; three empty-state voices; ON toggles styled as primary buttons |
| 5 | Error Prevention | 2 | AUTO mode and LOW+MED auto-allow are single weightless clicks |
| 6 | Recognition Rather Than Recall | 2 | Approvals and notifications are icon-only glyphs named only by title text |
| 7 | Flexibility and Efficiency | 2 | Ctrl+K only mentioned in 9px dim text |
| 8 | Aesthetic and Minimalist Design | 2 | Four panels ~90% empty; bottom metrics row repeats on every view |
| 9 | Error Recovery | 2 | "collector isn't running" offers no next step |
| 10 | Help and Documentation | 2 | Help is hover-only title text |
| Total | | 22/40 | Acceptable |

## Design Specificity Verdict
The frame is authored for the product (Rajdhani + Space Mono, teal glass, lit nav, mode tray). The dashboard body is generic: five equal panels plus a 4-card metrics row. The signature StormCore is absent from the dashboard (CSS stand-in at ReactorStatusCard.tsx:84-90; StormCore only in the Sidebar miniature, and only when renderer = 'storm'; default is 'classic').
Detector: 49 CLI findings (advisory, exit 0). 47 colours outside DESIGN.md: 15 are StormCore/ReactorStatusCard glow (false positives), 32 are real drift (TopBar 9, Sidebar 5, BottomMetricsRow 4). layout-transition at BottomMetricsRow.tsx:215 (height). radius 3px at BottomMetricsRow.tsx:211. Browser injection: 47-57 flags per view, dominated by undersized functional text (<11px) and low contrast 3.8-3.9:1. dark-glow and ai-color-palette overruled except COMPOSE MISSION's resting glow. text-occlusion dropped as a re-injection artifact.

## Priority Issues
1. [P1] The storm reactor is not on the dashboard. Fix: mount the real Reactor in the REACTOR STATUS panel, scaled by wrapper only; decide storm-always vs follow-setting. Command: /impeccable layout
2. [P1] Readouts contradict each other (rate vs tokens, simulated CONTEXT fallback, two uptimes, 163 commands vs none, SESSION TOKENS shows a monthly value at dashboardMath.ts:35). Fix: one source per figure, "—" for no data, rename to MONTH TOKENS, suppress the rate with no live session. Command: /impeccable clarify
3. [P1] Not usable by keyboard and text too small: no focus ring in Button, hover is mouse-only, 0 headings/landmarks, no skip link, 8-10px labels, contrast 3.8-3.9:1. Fix: DESIGN.md focus ring via focus state, landmarks and h2 panel titles, 11px floor, raise textDim to 4.5:1. Command: /impeccable harden, /impeccable typeset
4. [P1] COMPOSE MISSION is an inert glowing span (ReactorStatusCard.tsx:136). Fix: remove it or render a disabled Button; OPEN TERMINAL becomes the only primary. Command: /impeccable distill
5. [P2] Empty states are dim one-liners in large panels; Token Usage bars render full height for a total of 0. Fix: compact empty states with a next action; draw zero bars as baseline ticks. Command: /impeccable onboard

## Persona Red Flags
Alex: Ctrl+K hidden in 9px text (SystemsCard.tsx:39); approvals behind a glyph at Tab stop 5; 14 ungrouped nav items; dead COMPOSE MISSION; bottom row repeats on every view.
Sam: no headings or landmarks (~27 flat buttons); glyph buttons named by title only; status by colour alone; 8-9px text shrinks further as the canvas scales down; no live region for changing readouts.

## Minor Observations
- RECENT AGENTS label half-clipped by the reactor miniature (Sidebar.tsx:43)
- Unstyled "collector isn't running" text on the Agents view
- ACTIVE AGENTS heading off-style (ActiveAgentsDigest.tsx:75)
- #8ab6ff off-palette (SystemsCard.tsx:17); 32 colour literals in the shell chrome
- BottomMetricsRow.tsx:215 animates height
- RecapBanner.tsx not mounted anywhere
- Top bar "Agent communication / Status unavailable" reads as a placeholder and is the first Tab stop

## Questions to Consider
- Should the reactor own the centre column instead of the top-left corner?
- With no live session, should the console go visibly dark instead of showing 92K tok/min and ALL GOOD?
- Is the bottom metrics row a second dashboard competing with the first?
