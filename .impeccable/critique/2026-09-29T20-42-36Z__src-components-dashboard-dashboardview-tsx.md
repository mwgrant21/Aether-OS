---
target: dashboard after readiness pass (design/readiness-pass @ 7583dcc)
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:C:\\Users\\IT\\Desktop\\Aether-OS-next\\src\\components\\dashboard\\DashboardView.tsx"
target_fingerprint: "sha256:ec0e5138ae1f20fb59565d09a5fb552f817cdc5dfa9f2b523540c870ff2b340e"
target_path: "C:\\Users\\IT\\Desktop\\Aether-OS-next\\src\\components\\dashboard\\DashboardView.tsx"
timestamp: 2026-09-29T20-42-36Z
slug: src-components-dashboard-dashboardview-tsx
---
Method: dual-agent (A: design review, own Playwright process · B: detector + browser overlay, own Playwright process), on branch design/readiness-pass @ 7583dcc (readiness pass merged). Each assessment used its own browser process and a fresh context per view; no overlay leaked into A.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Honest STANDBY everywhere; strip's sr-only h2 reads "Standby" even in a live session with no alerts (StandbyStrip.tsx:197, readinessMath.ts:297) |
| 2 | Match System / Real World | 3 | Plain sentences and real commands; "engrams" jargon; "BUDGET LEFT — / of 2.0M cap" |
| 3 | User Control and Freedom | 2 | Notifications: Escape + outside-click + focus return work. Approvals dropdown ignores Escape and does not move focus (TopBar.tsx ~95-160) |
| 4 | Consistency and Standards | 2 | Sibling dropdowns behave differently; collector copy "no events in the last 24h" vs Agents "isn't running"; padding 15/16 vs 20, gap 14 vs 16, OPEN TERMINAL radius 8 vs 9 token |
| 5 | Error Prevention | 3 | Disabled OPEN TERMINAL inert, focusable, explained |
| 6 | Recognition Rather Than Recall | 3 | Every unmet row says how to fix it; commands not copyable (ReadinessCard.tsx:95) |
| 7 | Flexibility and Efficiency | 1 | No shortcuts/palette; OPEN TERMINAL is Tab stop 22; fresh load lands on Terminal, not Dashboard (initialState.ts:10) |
| 8 | Aesthetic and Minimalist Design | 2 | ~330px dead glass inside READINESS between rows and CTA; desktop-app dependency stated three times |
| 9 | Error Recovery | 3 | Actionable, non-alarmist hints per unmet row |
| 10 | Help and Documentation | 2 | Hints are the only help; nothing explains what READINESS gates |
| **Total** | | **24/40** | **Acceptable** |

## Design Specificity Verdict

LLM: specific. Reactor as instrument, READINESS as a pre-flight checklist with real commands, honest "—" readouts. The idle composition still lets it down: the READINESS card now fills the column but the fill is empty glass with the CTA pinned to the bottom, and the only CTA is a disabled grey bar, so browser-mode STANDBY reads "blocked", not "ready when you are".

Detector: dashboard/ and shared/ 0 findings; layout/ 13 advisory design-system-color (BottomMetricsRow 163/169, Sidebar 173/188/198, TopBar 265/357/441/444/460). Overlay (1440x900): Dashboard 26 (15 ai-color-palette, 6 dark-glow, 4 clipped-overflow, 5 tiny-text, 1 radial-spotlight, 1 em-dash-overuse, 1 stripes); Terminal default 28; Agents 24 incl. 1 low-contrast 4.2:1 on the diagnostics p. False positives: reactor glow/gradients, HUD cyan accents, app-root clipping, body stripes. Real: 11px READINESS hints (tiny-text x4 + context-window caption), Agents low-contrast, em-dash density.

## Priority Issues

- [P1] Dead region inside READINESS at idle: fill={!anyDigest} (DashboardView.tsx:25 -> ReadinessCard.tsx:116 flex:1, :148 marginTop:auto) stretches the card and pins the CTA ~330px below the hints. Fix: CTA directly under the rows; use the space for a numbered "getting to live" sequence, or give it back to the reactor. /impeccable layout.
- [P1] Desktop-app dependency said three times: readinessMath.ts:221-222 row hint, :234 "Needs the desktop app.", :127 reason under the button. Fix: one browser-mode lead line with a copyable command; dependent rows marked blocked without their own hints. /impeccable clarify.
- [P1] Dropdown inconsistency and semantics: Approvals has no Escape/focus move; notifications panel is an unnamed tabIndex=-1 div (no role/label); Tab escapes and leaves it open (useDropdownFocus has no focusout close); opened from the strip it renders top-right over READINESS, far from the trigger. Fix: route approvals through useDropdownFocus, role="dialog" + aria-labelledby, close on focusout. /impeccable harden.
- [P2] Strip navigation drops focus to BODY (StandbyStrip.tsx:192 dispatches SET_ACTIVE_TAB with no focus target). Fix: focus the new view's h1/#main-content. /impeccable harden.
- [P2] Fixed-canvas downscale (0.879 at 1440x900, ~0.667 at 1024) takes 11px hints to ~9.7/7.3px effective; text-muted hints ~4.5:1 before scaling. Fix: clamp min scale or reflow <1280; hints to text-secondary. /impeccable adapt.

## Persona Red Flags

Alex: lands on Terminal not Dashboard; no shortcut/palette; commands not click-to-copy; four zero counts to drill into; "Alerts 0" duplicates the bell.
Sam: 21 Tab stops before OPEN TERMINAL (skip link mitigates); focus lost after strip navigation; unnamed notifications popover that Tab leaves open; approvals no Escape; four polite live regions may double-announce standby.

## Minor Observations

Disabled OPEN TERMINAL is a 536x29 full-width bar, radius 8px, tracking 1.5px (headings 3px, secondary buttons 2px) - reads as a divider; Agents secondary instance uses 9px. EDITS pill is the brightest cyan at STANDBY. Reactor still arcs at STANDBY. TOKEN USAGE shows a "LIVE" range chip at STANDBY. Sidebar "RECENT AGENTS" label clipped. Agents view: "Dispatch diagnostics are unavailable..." floats outside any panel (x~1175) at 4.2:1. Top-bar "Agent communication / Status unavailable" and placeholder "Operator / COMMAND DECK" chips add idle noise. 1024 view letterboxed ~40px top/bottom, no overflow.

## Questions to Consider

- In browser mode, should the Dashboard become an honest "preview - connect your desktop app" state with one real action (copy the command)?
- If READINESS is a checklist to reach live, why isn't it an ordered sequence with the CTA at its step?
- Does a strip of four zeros earn a row, or would "Nothing running yet" plus the memory count say it with less?
