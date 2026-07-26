# UI Polish Pass — Design Spec

**Date:** 2026-07-26
**Status:** Approved, pending implementation plan

## Context

Following Phase 6 (Desktop Polish, merged to master), a codebase survey found aether-os's per-view UI has drifted: no shared spacing scale, no hover/focus states on interactive elements, most clickable rows/toggles are `<div onClick>`/`<span onClick>` rather than real `<button>` elements, icon-only actions have no tooltips, destructive actions (delete file, remove chat channel) fire with no confirmation, and Appearance settings implies a theme toggle that doesn't exist (only hue is switchable, not light/dark). Twelve concrete polish opportunities were identified across `src/components/{agents,chat,memory,projects,uplinks,files,settings,layout,dashboard}`.

Rather than patching each of the 12 items independently — which would mean writing hover/focus/button/tooltip logic a dozen separate times and having it drift again — this pass builds a small set of shared primitives first, then sweeps every flagged view to use them.

## Scope

All 12 items from the survey. Grouped:

**Foundation (new shared code):**
1. Spacing scale added to `src/styles/tokens.ts`.
2. Shared interactive-element hover/focus styling helper.
3. A `Button` primitive component replacing ad hoc `<div onClick>`/`<span onClick>` patterns, keyboard-focusable, with built-in `title` support.
4. A full light-mode color palette in `tokens.ts`, toggled via a new theme-mode setting.

**Applied across the sweep (using the foundation above):**
5. `AgentRosterCard`, `ChannelRail`, `MemoryRosterCard`, `MemoryDetailCard`, `ProjectRosterCard`, `UplinksView`, `FilesView`, `SettingsView` cards — clickable rows/toggles swapped to `Button`.
6. Icon-only actions (Files delete `×`, Memory pin/unpin, Chat channel remove `×`) get `title` tooltips.
7. `FilesView`'s delete and `ChannelRail`'s channel-remove gain a native `confirm()` guard before firing.
8. `FilesView` gains a loading state during `refresh()`.
9. `UplinksView` offline provider rows get a distinct visual treatment (reduced opacity or a status ring) so they're not easily missed next to online rows.
10. `ChannelRail`'s "+ NEW" picker closes on outside-click or Escape.
11. `MemoryDetailCard`'s unpin action loses the danger-red styling (unpinning isn't destructive).
12. `ProjectsDigest`/`SystemsCard` "view all" links get a hover/chevron affordance cue.
13. `TopBar`'s CLOSE window-control button gets red-on-hover, matching standard OS window-chrome convention.
14. `AppearanceCard` gains a light/dark theme-mode toggle wired to the new palette.

(Numbering above doesn't map 1:1 to the original 12-item survey list — items were regrouped by foundation vs. application during design.)

## Architecture

### Spacing scale

Added to `src/styles/tokens.ts`:

```ts
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;
```

Existing hardcoded spacing literals in the swept views are replaced with `space.*` references where they match one of these values; values that don't cleanly map are left as-is rather than forced to fit (no scope creep into a full spacing audit of every file in the app — only the views already touched by this pass).

### Interactive styling helper

A React hook, `useHoverStyle(base: CSSProperties, hover?: CSSProperties): { style: CSSProperties, onMouseEnter, onMouseLeave }`, matching the app's existing inline-style convention (no CSS modules are used anywhere in this codebase, so hover state is tracked in component state and merged into the inline style object rather than via a CSS class). Default hover treatment when no `hover` override is passed: `filter: brightness(1.1)` plus a border color bump to the existing `activeBorder` token. Consumers spread `style` onto the element and pass through the two handlers.

### `Button` primitive

New file: `src/components/shared/Button.tsx` (new `shared/` directory — doesn't exist yet).

A thin wrapper around a real `<button>` that:
- Strips default browser button chrome (background, border, font) so it visually matches whatever the call site currently renders via inline styles.
- Applies the interactive styling helper's hover/focus treatment automatically.
- Accepts `title` as a prop for tooltips.
- Is used as a drop-in replacement for `<div onClick={...}>`/`<span onClick={...}>` at each swept call site — same visual output, real semantics underneath.

This is NOT a full design-system component library — no variants system, no size props beyond what each call site already needs. It exists to eliminate the twelve-times-repeated `<div onClick>` pattern, nothing more.

### Light theme palette

A second `colors`-shaped object in `tokens.ts` (e.g. `colorsLight`), with the same keys as the existing dark `colors` export, values chosen to preserve the cyan-accent sci-fi identity in a light context (light backgrounds, darker text, same accent hues) rather than being a generic "invert everything" palette.

Theme mode (`'dark' | 'light'`) is added to app config (`Cfg` in `src/state/types.ts`, alongside the existing `theme`/`renderer` fields), persisted via the existing `persistence.ts` slice mechanism (no new persistence code).

Components currently `import { colors } from '../../styles/tokens'` directly at module scope, which can't respond to a runtime mode switch. This pass adds a `useColors()` hook (reading `cfg.themeMode` from `useAetherStore()` and returning either `colors` or `colorsLight`) and migrates only the views already being swept in this pass from the static import to the hook — this is the bulk of the theme-toggle implementation work. Views NOT otherwise touched by this polish pass keep the static dark-only import for now (a full-app migration to `useColors()` is future work, not blocking this pass, and is noted under Out of Scope).

`AppearanceCard.tsx` gains a light/dark toggle alongside its existing theme-hue/renderer/pulse controls, dispatching the same way those controls already do.

## Error handling / edge cases

- `confirm()` calls for delete actions are synchronous/blocking — acceptable for these low-frequency, deliberate actions; no new async confirmation UI.
- Outside-click/Escape handling for `ChannelRail`'s picker follows the standard `useEffect` + document-listener + cleanup pattern — no new shared abstraction for a single dropdown instance.
- Theme-mode switching must not require a page reload or lose any other persisted state — it's a pure re-render with a different palette object.

## Testing

- `space` scale: no logic to test (a static object).
- Interactive styling helper: unit-tested if it contains any branching logic beyond returning a merged style object; skipped if it's trivial.
- Light palette: no logic to test if it's a static object; if theme-mode resolution involves any function (e.g. a `getColors(mode)` accessor), that gets a colocated test.
- `Button` primitive: no meaningful unit test for a styling wrapper; correctness is visual.
- All hover states, button swaps, tooltip additions, confirmation dialogs, and theme-mode visual correctness are NOT unit-testable and are verified via manual/live-window check, consistent with this project's established pattern (Phase 6 deferred the same category of check).

## Out of scope

- No new light/dark auto-detection from OS preference — manual toggle only.
- Light/dark mode only applies to the views swept in this pass; views outside this pass's scope keep the static dark palette until a future full-app migration to `useColors()`. This means toggling to light mode will initially produce a partially-themed app — acceptable for this pass, called out explicitly so it isn't mistaken for a bug.
- No broader spacing-scale migration beyond the views already touched by this pass.
- No accessibility audit beyond the specific `Button`/tooltip/keyboard-nav items listed — this is not a full WCAG pass.
- No changes to reactor visualization, anomaly detection, or any Instrument+Alarm-track item — that remains a separately-scoped future track.
