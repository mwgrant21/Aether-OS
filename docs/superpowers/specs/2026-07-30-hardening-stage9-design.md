# Hardening (Stage 9) — Design

## Context

Roadmap Stage 9 (`docs/roadmap.md` row 9): "Playwright `_electron` e2e (retires the recurring
'verification deferred to the user'), keyboard nav, `prefersReducedMotion`." One line covering
three distinct concerns, sized at ~6 tasks. This doc scopes each concern concretely.

**Why now:** every prior stage's PROGRESS.md entry has repeated some version of "manual/live
verification deferred — this dev environment is headless" (Stages 4, 5, 6, 7 all say this
explicitly). Playwright's `_electron` runner can drive a real Electron window
programmatically without a human present, closing that recurring gap for the flows that
matter most.

**Existing state, verified directly against the codebase, not assumed:**
- Zero e2e infrastructure exists (no `playwright.config.ts`, no `@playwright/test` dependency).
- Keyboard nav: most interactive elements across the app already route through the shared
  `Button` component (`src/components/shared/Button.tsx`), which renders a real `<button>` —
  already keyboard-native (Enter/Space trigger `onClick`, tab order is automatic). An initial
  broad grep for `onClick` misidentified ~20 files as gaps; a precise recheck (excluding
  `<Button>` usage) found exactly four real raw-element click handlers with no keyboard path:
  - `src/components/grid/OrchestrationGrid.tsx:109` — `<g onClick={...}>`, selects an agent
    node in the Grid view's SVG.
  - `src/components/chat/ChannelRail.tsx:86` — `<div onClick={() => onSelect(c.id)}>`, selects
    a chat channel row.
  - `src/components/projects/ProjectRosterCard.tsx:17` — `<span onClick={...}>` styled as an
    "add project" button, instead of the real `Button` component.
  - `src/components/memory/MemoryRosterCard.tsx:51` — `<span onClick={submitRemember}>` styled
    as a "remember" submit button, same pattern.
- `prefersReducedMotion`: not read anywhere in the codebase. All CSS `@keyframes` (15 of them)
  live in one file, `src/styles/global.css`. The reactor's own animation is a `requestAnimationFrame`
  loop (`src/components/reactor/useReactorCanvas.ts`), not CSS — a media query alone cannot
  stop it.

## Design

### 1. Playwright `_electron` e2e

New `e2e/` directory, `@playwright/test` as a devDependency, separate from the existing
`vitest` suite (`npm test`) — e2e tests need a real Electron process, not jsdom.

**Smoke tests only**, covering exactly the class of thing repeatedly marked
"verification deferred" in PROGRESS.md:
- App window launches without crashing.
- Each sidebar tab (`Terminal`, `Dashboard`, `Agents`, `Grid`, `Files`, `Memory`, `Chat`,
  `Optimize`, `Uplinks`, `Settings`) renders its view when clicked, with no console error.
- The embedded terminal's pty spawns and echoes a typed command back.
- The Dashboard shows real usage data (not the fictional-simulation fallback) once the app's
  real-usage scan completes.

Not covered: the permission-approval round-trip or reactor visuals (per your scope decision) —
those need a live Claude Code session driving the pty, a harder e2e setup than this stage's
budget covers; left as a named future gap, not silently skipped.

**Honesty about this dev environment:** this box has been alternately headless and displayed
across prior stages (Stage 7's own PROGRESS.md entry found a real display here). The e2e
tests will be written correctly and are runnable in principle; whether they can actually be
run to green *in this session* depends on display availability at execution time. If they
can't run here, that gets stated plainly in the closing task's PROGRESS.md entry — same
practice as every prior stage's honest headless-environment notes — not silently claimed as
verified.

### 2. Keyboard nav — the four real gaps

- **`OrchestrationGrid.tsx`**: the `<g onClick>` node becomes keyboard-operable — add
  `tabIndex={0}`, `role="button"`, an `aria-label` naming the agent, and an `onKeyDown`
  handler firing the same `onSelectRealAgent` callback on `Enter`/`Space`.
- **`ChannelRail.tsx`**: the `<div onClick={() => onSelect(c.id)}>` row gets the same
  treatment — `tabIndex={0}`, `role="button"`, `onKeyDown` for Enter/Space calling `onSelect`.
  The nested `<span onClick={(e) => e.stopPropagation()}>` (the channel-remove control) is
  already noted in this project's own history (Task 5 of the UI-Polish pass, per
  `PROGRESS.md`) as a structural wart worth revisiting — out of scope here unless it blocks
  the row fix; if it needs touching to keep the remove control from being triggered by the
  row's own new keyboard handler, that's a one-line guard, not a redesign.
- **`ProjectRosterCard.tsx`** and **`MemoryRosterCard.tsx`**: swap the `<span onClick>` for
  the real `Button` component (already imported and used elsewhere in this codebase) —
  the simplest fix, since `Button` already solves keyboard access correctly.

No changes to any other file. No accessibility audit (contrast, screen-reader labels, focus
trapping) — that's a different, larger effort the roadmap's line doesn't imply.

### 3. `prefersReducedMotion` — two-tier

**CSS tier:** add one `@media (prefers-reduced-motion: reduce)` block to
`src/styles/global.css` that disables/shortens the 15 existing `@keyframes` animations and any
`transition` declarations to near-zero duration, following the standard pattern
(`animation-duration: 0.01ms !important; animation-iteration-count: 1 !important;
transition-duration: 0.01ms !important;` scoped broadly via `*`). This is additive and
mechanical — no per-component changes needed.

**Reactor tier:** the pulse loop is JS-driven (`useReactorCanvas.ts`'s `runFrame`,
consuming `computePulseDuration`/`computeMomentum` from `reactorMath.ts`), so the CSS media
query cannot reach it. Add a small pure function to `reactorMath.ts`:

```ts
export function effectivePulseDuration(dur: number, reducedMotion: boolean): number {
  return reducedMotion ? REDUCED_MOTION_PULSE_DUR : dur;
}
```

with `REDUCED_MOTION_PULSE_DUR` a slow, steady constant (e.g. `4.0`, well outside the normal
`0.8`–`2.9` range `computePulseDuration` already produces — a deliberately calmer pulse, not a
frozen one, since a fully static reactor could misread as broken/idle rather than
motion-reduced). `useReactorCanvas.ts` reads `window.matchMedia('(prefers-reduced-motion:
reduce)').matches` (with a `change` event listener, since the OS setting can toggle at
runtime) and passes it through this new function before using the result for
`advancePhase`/`computeSurge`.

### Scope boundaries

- No WCAG compliance claim — "hardening," not certification.
- No change to `Button.tsx` itself — it's already correct.
- `ChannelRail.tsx`'s pre-existing `stopPropagation` wart is touched only if the keyboard fix
  requires it, not redesigned.
- Reduced-motion doesn't touch `Concurrency`'s glow/turbulence or `Pressure`'s hue — only pulse
  timing, the literal "motion" component.

## Testing

- **E2e**: new `e2e/*.spec.ts` files, run via a new `npm run test:e2e` script (`playwright
  test`), separate from `npm test`. Written and correct; runnability in this session is stated
  honestly per the Context section above.
- **Keyboard nav**: `@testing-library/react` component tests per touched file — `fireEvent.keyDown`
  with `Enter` and `Space` on the target element asserts the same dispatch/callback as a click
  fires. One test file per touched component (or added cases to an existing test file if one
  already exists for that component).
- **Reduced motion**: `reactorMath.test.ts` gets cases for `effectivePulseDuration` (reduced
  → constant, not-reduced → passthrough of the input `dur`). The CSS media query itself has no
  meaningful automated test — noted as a known, accepted verification gap (visual-only,
  consistent with this project's established honesty about what a jsdom/vitest suite cannot
  verify).

## Out of scope

- Full accessibility audit beyond the four named keyboard gaps.
- E2e coverage of the permission-approval round-trip or reactor visuals.
- Any change to `state.agents`, the fictional simulation, or any view not named above.
