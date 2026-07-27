# Full Light-Mode Coverage — Design Spec

## Goal

The original UI Polish Pass built the theming foundation (`useColors()` hook, `colors`/`colorsLight` palettes in `src/styles/tokens.ts`, the `Button` primitive) and swept a subset of views. Everything outside that sweep — Dashboard, Analytics, Terminal, Chat, the Agent/Project detail cards, a few layout misc files, and `OperatorCard` in Settings — still imports the static dark `colors` object directly. Toggling to light mode currently produces a jarring half-light/half-dark app: Sidebar and TopBar go white, but the Dashboard's own cards stay dark underneath them. This closes that gap for everything **except Grid/Reactor**, which stay dark-only by explicit, already-documented decision (Instrument+Alarm's Global Constraints: `computeCacheClarity`/`computeConcurrencyTurbulence` are WebGL-specific and out of scope for CSS-token theming).

## Scope: 23 files, 7 task groups

| Group | Files |
|---|---|
| Dashboard | `ActiveAgentsDigest.tsx`, `ProjectsDigest.tsx`, `ReactorStatusCard.tsx`, `RecentAlertsCard.tsx`, `SystemsCard.tsx` |
| Analytics | `AgentBreakdownCard.tsx`, `LogFrequencyCard.tsx`, `SystemMetricsCard.tsx`, `TokenBurnCard.tsx`, `TopCommandsCard.tsx` |
| Terminal | `ActiveAgentsCard.tsx`, `LiveOutputCard.tsx`, `PtyTerminal.tsx`, `SystemOverviewCard.tsx`, `TerminalView.tsx` |
| Chat | `ChatView.tsx`, `MessageInput.tsx`, `MessageThread.tsx` |
| Detail cards | `AgentDetailCard.tsx`, `ProjectDetailCard.tsx` |
| Layout misc | `BottomMetricsRow.tsx`, `ComingSoonPanel.tsx`, `Footer.tsx` |
| Settings | `OperatorCard.tsx` |

Each group becomes one implementation-plan task, mirroring the original UI Polish Pass's per-view sweep structure — the foundation already exists, so this is application work, not new infrastructure.

## Mechanical pattern (already established, applies to ~22 of 23 files)

For each file: replace `import { colors, ... } from '../../styles/tokens'` with `import { useColors } from '../shared/useColors'` (adjust relative path per file location) plus whatever non-color tokens (`fonts`, `space`, etc.) it still needs from `tokens.ts`. Add `const colors = useColors();` inside the component. Thread `colors` as a parameter into every module-level style function that currently closes over the static import, exactly as the original polish pass did for `Sidebar.tsx`/`AppearanceCard.tsx`/`TopBar.tsx`. Any raw `<span onClick>`/`<div onClick>` interactive element found along the way gets converted to the `Button` primitive, per the same established convention — this pass doesn't go looking for those, but fixes them opportunistically since the file is already open for the color migration.

## Special case: `PtyTerminal.tsx`'s xterm.js theme

xterm.js's `Terminal` instance sets its `theme: { background, foreground }` once at construction (line ~28) via a **module-level singleton** (`sharedTerm`), not a React-managed style prop. A CSS-token swap alone won't re-theme the actual terminal text/background, since xterm renders to its own canvas/DOM layer outside React's control.

Fix: add a `useEffect` in `PtyTerminal.tsx` that watches `state.cfg.themeMode` (via `useColors()`'s underlying source, or read `state.cfg.themeMode` directly from `useAetherStore()`) and reactively reassigns `sharedTerm.options.theme = { background: colors.bgTerminal ?? colors.bgBase, foreground: colors.textBody }` (xterm supports live theme reassignment via its `options` setter — no re-construction needed). Check whether `tokens.ts` already has a terminal-specific background token or whether `colors.bgBase` is the right substitute; add one if genuinely needed, following the existing token-naming convention (e.g. `panelInset`, `chromeBg` were both added mid-pass in the original polish pass when a gap was found — same precedent applies here if `bgBase` reads wrong for a terminal background specifically).

## Out of scope

- `OrchestrationGrid.tsx`, `ReactorCore.tsx`, `StormCore.tsx` — explicit prior decision, unchanged.
- No new visual redesign — this pass makes existing dark-mode visuals theme-correctly, it does not restyle anything.
- No accessibility audit beyond what falls out of using the existing light palette (already validated for contrast in the original pass).

## Verification

- `npx tsc -b`, `npx vitest run`, `npm run build`, `npm run electron:build` clean after every task.
- Manual/live-window check for the actual visual result in light mode across all 7 groups, plus specifically confirming the terminal's text is readable in both themes after the xterm fix — deferred to the user per this project's established pattern for anything visual.
