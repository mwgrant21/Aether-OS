# Full Light-Mode Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `useColors()`/`Button` theming foundation (already built and proven by the UI Polish Pass) to the 23 remaining files that still import the static dark `colors` object, so light mode no longer produces a half-light/half-dark app.

**Architecture:** For 22 of 23 files this is a mechanical substitution — `import { colors } from '../../styles/tokens'` becomes `import { useColors } from '../shared/useColors'` plus `const colors = useColors();` inside the component, which makes every existing `colors.*` reference theme-aware with zero other changes since the variable name doesn't change. Any bare `<span onClick>`/`<div onClick>` found along the way is converted to the `Button` primitive, matching the codebase's established convention. `PtyTerminal.tsx` is the one exception — its xterm.js `Terminal` instance sets its theme once at construction via a module-level singleton, requiring a reactive `useEffect` that reassigns `terminal.options.theme` on theme-mode change.

**Tech Stack:** TypeScript (strict), React 18, Vitest.

## Global Constraints

- No CSS modules or styled-components — inline styles only, per the codebase's established convention.
- `npm test` and `npm run build` clean before every commit.
- Full spec: `docs/superpowers/specs/2026-07-26-full-light-mode-design.md`.
- Do NOT touch `src/components/grid/OrchestrationGrid.tsx`, `src/components/reactor/ReactorCore.tsx`, or `src/components/reactor/StormCore.tsx` — explicitly out of scope, per prior documented decision (Instrument+Alarm's Global Constraints).
- This is a theming-correctness pass, not a redesign — do not change layout, spacing, or visual hierarchy beyond what the color-token swap itself produces.
- In every file, the substitution pattern is: replace the `colors` import from `'../../styles/tokens'` with `import { useColors } from '../shared/useColors';` (adjust the relative path per the file's actual directory depth — most of these files are two levels under `src/components/`, matching `'../shared/useColors'`; verify by checking how a sibling already-migrated file in the same directory imports it, or by counting directory levels back to `src/components/shared/`), keep any other named imports from `tokens.ts` (`fonts`, etc.) as a separate import line, and add `const colors = useColors();` as the first line inside the component function body, before any other logic that reads `colors`.

---

### Task 1: Dashboard sweep

**Files:**
- Modify: `src/components/dashboard/ActiveAgentsDigest.tsx`
- Modify: `src/components/dashboard/ProjectsDigest.tsx`
- Modify: `src/components/dashboard/ReactorStatusCard.tsx`
- Modify: `src/components/dashboard/RecentAlertsCard.tsx`
- Modify: `src/components/dashboard/SystemsCard.tsx`

**Interfaces:**
- Consumes: `useColors` (already exists at `src/components/shared/useColors.ts`), `Button` (already exists at `src/components/shared/Button.tsx`).

**Steps:**
- [ ] In all 5 files, apply the Global Constraints substitution pattern: swap the static `colors` import for `useColors()`, add `const colors = useColors();` inside the component body.
- [ ] `ProjectsDigest.tsx`: this file already imports `Button` and already uses it (line 19, the `SET_ACTIVE_TAB` "VIEW ALL" click) — no further onClick changes needed here beyond the color-hook migration.
- [ ] `ReactorStatusCard.tsx`: this file has FOUR raw `<span onClick={...} style={...}>` action buttons (`spawn`, `NEW_PROJECT`, one more around line 52 — read the file to see its exact handler, and the `SET_ACTIVE_TAB: 'Terminal'` one at line 60). Convert all four to `Button`, keeping each one's existing `onClick` handler and `style` prop unchanged, just swapping the element type from `span` to `Button` (opening and closing tags) and adding the `Button` import.
- [ ] `SystemsCard.tsx`: has one raw `<span onClick={...} style={viewAllStyle}>` (line 21, `SET_ACTIVE_TAB: 'Uplinks'`). Convert to `Button`, same pattern.
- [ ] `ActiveAgentsDigest.tsx` and `RecentAlertsCard.tsx`: no interactive elements — color-hook migration only.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean.
- [ ] Commit: `feat: extend light-theme support to Dashboard views`

---

### Task 2: Analytics sweep

**Files:**
- Modify: `src/components/analytics/AgentBreakdownCard.tsx`
- Modify: `src/components/analytics/LogFrequencyCard.tsx`
- Modify: `src/components/analytics/SystemMetricsCard.tsx`
- Modify: `src/components/analytics/TokenBurnCard.tsx`
- Modify: `src/components/analytics/TopCommandsCard.tsx`

**Interfaces:**
- Consumes: `useColors` (already exists).

**Steps:**
- [ ] All 5 files are pure display cards with no interactive elements (no `onClick` anywhere in any of them). Apply ONLY the Global Constraints color-hook substitution pattern to each — no `Button` conversions needed in this task.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean.
- [ ] Commit: `feat: extend light-theme support to Analytics views`

---

### Task 3: Terminal sweep (including the xterm.js theme fix)

**Files:**
- Modify: `src/components/terminal/ActiveAgentsCard.tsx`
- Modify: `src/components/terminal/LiveOutputCard.tsx`
- Modify: `src/components/terminal/PtyTerminal.tsx`
- Modify: `src/components/terminal/SystemOverviewCard.tsx`
- Modify: `src/components/terminal/TerminalView.tsx`

**Interfaces:**
- Consumes: `useColors` (already exists), `useAetherStore` (already exists at `src/state/store.ts`).

**Steps:**
- [ ] `ActiveAgentsCard.tsx`, `LiveOutputCard.tsx`, `SystemOverviewCard.tsx`, `TerminalView.tsx`: no interactive elements in any of these four (no `onClick`). Apply only the Global Constraints color-hook substitution pattern.
- [ ] `PtyTerminal.tsx` — the special case. Read the file in full first (it's short, ~80 lines). Do the following, in order:
  1. Do NOT remove the static `colors` import at the top of the file — the module-level `getOrCreateHost()` function and `fallbackStyle` constant both run/are-defined OUTSIDE the `PtyTerminal` component function, so they cannot call the `useColors()` hook (hooks only work inside component bodies). Leave `import { colors, fonts } from '../../styles/tokens';` as-is.
  2. Inside the `PtyTerminal()` component function, add `const colors = useColors();` (import `useColors` from `'../shared/useColors'`) and `const { state } = useAetherStore();` (import `useAetherStore` from `'../../state/store'`) as the first two lines of the function body. This shadows the module-level `colors` import inside the component's own scope, so `fallbackStyle`'s reference to the module-level `colors.textDim` (used only in the `!hasElectronPty` early-return branch, which is JSX referencing a module-level constant, not inside the function body's live scope) is UNAFFECTED — verify this by checking that `fallbackStyle` is declared as a module-level `const` (it is, at the bottom of the file) using the module-level `colors`, which is fine to leave dark-only since it's a rare fallback message, not a primary UI surface.
  3. Add a new `useEffect` inside the `PtyTerminal()` component, after the existing resize-observer `useEffect`, that reacts to the live theme:
     ```tsx
     useEffect(() => {
       if (!sharedTerm) return;
       sharedTerm.options.theme = {
         background: state.cfg.themeMode === 'light' ? colors.bgBase : '#06141c',
         foreground: colors.textBody,
       };
     }, [state.cfg.themeMode, colors]);
     ```
     This preserves the exact original dark-mode background (`'#06141c'`, a deliberately chosen shade slightly lighter than `colors.bgBase`'s `'#020a10'`) when `themeMode` is not `'light'`, and switches to the light palette's `bgBase` (`'#eaf6fb'`) in light mode — no new token needed. `sharedTerm` is the module-level singleton declared earlier in this file; this effect reads it directly (do not add it as a dependency — it's a mutable module-level `let`, not component state).
  4. Confirm `hasElectronPty`'s existing `useEffect` (the one calling `getOrCreateHost()`) is unaffected — you're adding a second, independent `useEffect`, not modifying the first.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean, `npm run electron:build` clean (this task touches the Electron-adjacent `window.aetherElectron` usage area, even though `PtyTerminal.tsx` itself is a renderer-side file — matching this plan's precedent of building electron alongside any terminal-adjacent change).
- [ ] Commit: `feat: extend light-theme support to Terminal views, including a reactive xterm.js theme update`

---

### Task 4: Chat sweep

**Files:**
- Modify: `src/components/chat/ChatView.tsx`
- Modify: `src/components/chat/MessageInput.tsx`
- Modify: `src/components/chat/MessageThread.tsx`

**Interfaces:**
- Consumes: `useColors` (already exists), `Button` (already exists).

**Steps:**
- [ ] In all 3 files, apply the Global Constraints color-hook substitution pattern.
- [ ] `MessageInput.tsx`: has one raw `<span onClick={disabled ? undefined : onSend} style={sendButtonStyle(disabled)}>` (line 29). Convert to `Button`, keeping the exact same conditional `onClick` expression and `style` call unchanged — note `Button`'s `onClick` prop type is `() => void`, so if `disabled ? undefined : onSend` currently relies on passing `undefined` to disable the native click (span has no real "disabled" semantics), check `Button.tsx`'s actual prop signature: it already accepts an optional `disabled?: boolean` prop that sets the native `<button disabled>` attribute. Use that instead — pass `disabled={disabled}` and always pass the real `onSend` as `onClick` (a disabled native `<button>` doesn't fire click handlers regardless of the handler itself, so this is safe and is the more correct approach the primitive already supports).
- [ ] `ChatView.tsx`, `MessageThread.tsx`: no interactive elements — color-hook migration only.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean.
- [ ] Commit: `feat: extend light-theme support to Chat views`

---

### Task 5: Detail cards sweep

**Files:**
- Modify: `src/components/agents/AgentDetailCard.tsx`
- Modify: `src/components/projects/ProjectDetailCard.tsx`

**Interfaces:**
- Consumes: `useColors` (already exists), `Button` (already exists).

**Steps:**
- [ ] In both files, apply the Global Constraints color-hook substitution pattern. Note `AgentDetailCard.tsx` does not currently call `useAetherStore()` at all (it receives its data via a `RealAgentDispatch` prop) — that's fine, `useColors()` calls `useAetherStore()` internally and works from any component regardless of whether that component already uses the store for other data.
- [ ] `ProjectDetailCard.tsx`: read the file around line 48 to find the exact `onClick={() => { ... }}` handler and its enclosing element's current tag/style. Convert that element to `Button`, keeping the handler body and style prop unchanged.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean.
- [ ] Commit: `feat: extend light-theme support to Agent/Project detail cards`

---

### Task 6: Layout misc sweep

**Files:**
- Modify: `src/components/layout/BottomMetricsRow.tsx`
- Modify: `src/components/layout/ComingSoonPanel.tsx`
- Modify: `src/components/layout/Footer.tsx`

**Interfaces:**
- Consumes: `useColors` (already exists), `Button` (already exists).

**Steps:**
- [ ] In all 3 files, apply the Global Constraints color-hook substitution pattern.
- [ ] `BottomMetricsRow.tsx`: has one raw `<span key={r} style={rangeChipStyle(range === r)} onClick={() => setRange(r)}>` inside what is presumably a `.map(...)` over a ranges array (read the file around line 58 to confirm). Convert to `Button`, keeping the `key`, the `style` call, and the `onClick` handler unchanged — `key` stays on the outermost element in the `.map()` callback (on `Button` itself, same as it was on `span`).
- [ ] `ComingSoonPanel.tsx`, `Footer.tsx`: no interactive elements — color-hook migration only.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean.
- [ ] Commit: `feat: extend light-theme support to remaining layout views`

---

### Task 7: Settings sweep

**Files:**
- Modify: `src/components/settings/OperatorCard.tsx`

**Interfaces:**
- Consumes: `useColors` (already exists).

**Steps:**
- [ ] Apply the Global Constraints color-hook substitution pattern. No interactive elements in this file (no `onClick`) — color-hook migration only.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean.
- [ ] Commit: `feat: extend light-theme support to OperatorCard`

---

After all seven tasks: whole-branch review, then a `PROGRESS.md` entry in the established format, explicitly noting: (a) light-mode coverage is now complete across the entire app except Grid/Reactor (unchanged, prior decision); (b) the xterm.js terminal's theme is now reactive to `state.cfg.themeMode` via a live `terminal.options.theme` reassignment, since xterm's `Terminal` instance is a module-level singleton outside React's render cycle; (c) this pass made no layout/spacing changes, only color-token correctness — visual verification of the actual light-mode appearance across all seven groups is deferred to the user via manual/live-window check, per this project's established pattern.
