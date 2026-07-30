# Hardening (Stage 9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three concerns bundled into roadmap Stage 9 — Playwright `_electron` e2e
smoke tests, keyboard access for the four real raw-click gaps in the app, and
`prefersReducedMotion` support (CSS + the reactor's JS pulse loop) — per
`docs/superpowers/specs/2026-07-30-hardening-stage9-design.md`.

**Architecture:** Keyboard-nav tasks are small, targeted diffs to the four files with real
gaps (verified directly, not by broad grep — most of the app already uses the keyboard-native
`Button` component). Reduced-motion is two-tier: an additive CSS media query for the 15
`@keyframes` in one file, plus a small pure function + hook wired into the reactor's
`requestAnimationFrame` loop. E2e is new, separate infrastructure (`@playwright/test`,
`e2e/` directory), independent of the existing `vitest` suite.

**Tech Stack:** TypeScript, React, Vitest + `@testing-library/react` (existing), Playwright
`@playwright/test` (new).

## Global Constraints

- No accessibility audit beyond the four named keyboard gaps. No WCAG compliance claim.
- No change to `Button.tsx` itself — it already renders a real `<button>` and is correct.
- No change to `state.agents`, the fictional simulation, or any file not named in a task below.
- E2e tests must be written correctly regardless of whether they can be run to green in this
  session — state runnability honestly in Task 7's closing documentation, per this project's
  established practice of naming headless/display constraints plainly rather than silently
  claiming unverified success.
- Run `npm test` (root) after every keyboard-nav/reduced-motion task; e2e tests run separately
  via their own script, not part of `npm test`.

---

### Task 1: Keyboard access for Grid node selection

**Files:**
- Modify: `src/components/grid/OrchestrationGrid.tsx`
- Test: `src/components/grid/OrchestrationGrid.test.tsx` (new)

**Interfaces:** None new — `onSelectRealAgent: (toolUseId: string) => void` (existing prop)
is the callback both click and the new keyboard handler must call.

- [ ] **Step 1: Write the failing test**

Create `src/components/grid/OrchestrationGrid.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { OrchestrationGrid } from './OrchestrationGrid';
import type { RealActiveWork } from '../../state/liveAgentsMath';

afterEach(cleanup);

function agent(toolUseId: string, label: string): RealActiveWork {
  return { toolUseId, kind: 'agent', label, description: 'Explore the docs directory', startedAt: new Date().toISOString() };
}

describe('OrchestrationGrid keyboard access', () => {
  it('calls onSelectRealAgent when Enter is pressed on a focused node', () => {
    const onSelectRealAgent = vi.fn();
    const { getByRole } = render(
      <OrchestrationGrid agents={[agent('tu_1', 'Explore')]} rate={90000} anomalies={[]} onSelectRealAgent={onSelectRealAgent} />,
    );
    const node = getByRole('button', { name: /Explore/i });
    fireEvent.keyDown(node, { key: 'Enter' });
    expect(onSelectRealAgent).toHaveBeenCalledWith('tu_1');
  });

  it('calls onSelectRealAgent when Space is pressed on a focused node', () => {
    const onSelectRealAgent = vi.fn();
    const { getByRole } = render(
      <OrchestrationGrid agents={[agent('tu_1', 'Explore')]} rate={90000} anomalies={[]} onSelectRealAgent={onSelectRealAgent} />,
    );
    const node = getByRole('button', { name: /Explore/i });
    fireEvent.keyDown(node, { key: ' ' });
    expect(onSelectRealAgent).toHaveBeenCalledWith('tu_1');
  });

  it('the node is focusable via tabIndex', () => {
    const { getByRole } = render(
      <OrchestrationGrid agents={[agent('tu_1', 'Explore')]} rate={90000} anomalies={[]} onSelectRealAgent={vi.fn()} />,
    );
    expect(getByRole('button', { name: /Explore/i })).toHaveAttribute('tabindex', '0');
  });
});
```

`RealActiveWork`'s real shape (`src/state/liveAgentsMath.ts:83-89`) is `{ toolUseId: string;
kind: 'agent' | 'tool'; label: string; description: string; startedAt: string }` — the
fixture above matches it exactly.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- OrchestrationGrid` (from `C:/Users/Matt/projects/aether-os`)
Expected: FAIL — the `<g>` element has no `role="button"`, so `getByRole('button', { name:
/Explore/i })` cannot find it.

- [ ] **Step 3: Add keyboard access to the `<g>` node**

In `src/components/grid/OrchestrationGrid.tsx`, change (currently around line 109):

```tsx
<g key={node.agent.toolUseId} onClick={() => onSelectRealAgent(node.agent.toolUseId)} style={{ cursor: 'pointer' }}>
```

to:

```tsx
<g
  key={node.agent.toolUseId}
  onClick={() => onSelectRealAgent(node.agent.toolUseId)}
  onKeyDown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelectRealAgent(node.agent.toolUseId);
    }
  }}
  tabIndex={0}
  role="button"
  aria-label={node.agent.label}
  style={{ cursor: 'pointer' }}
>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- OrchestrationGrid`
Expected: PASS, all 3 cases.

- [ ] **Step 5: Commit**

```bash
git add src/components/grid/OrchestrationGrid.tsx src/components/grid/OrchestrationGrid.test.tsx
git commit -m "feat: keyboard access for Grid agent-node selection"
```

---

### Task 2: Keyboard access for chat channel selection

**Files:**
- Modify: `src/components/chat/ChannelRail.tsx`
- Modify: `src/components/shared/Button.tsx`
- Test: `src/components/chat/ChannelRail.test.tsx` (new)

**Interfaces:**
- Consumes: `onSelect: (id: string) => void` (existing prop).
- Produces: `Button`'s `ButtonProps` gains an optional `'aria-label'?: string`, passed through
  to the rendered `<button>` — available to any future caller, not only this task's.

- [ ] **Step 1: Write the failing test**

Create `src/components/chat/ChannelRail.test.tsx`. `ChatChannel`'s real shape
(`src/components/chat/chatChannels.ts:6-14`) is `{ id: string; kind: 'aether' | 'agent' |
'dispatch'; name: string; initials: string; hue: string; archived: boolean; toolUseId?:
string }`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ChannelRail } from './ChannelRail';
import type { ChatChannel } from './chatChannels';

afterEach(cleanup);

function channel(id: string, name: string): ChatChannel {
  return { id, name, initials: name.slice(0, 2).toUpperCase(), hue: '#7ef0ff', kind: 'aether', archived: false };
}

const baseProps = {
  channels: [channel('c1', 'Operator')],
  activeChannelId: 'c1',
  unreadCounts: {},
  recentCompletedDispatches: [],
  dispatchChannels: [],
  onCreateDispatchChannel: vi.fn(),
  onRemoveDispatchChannel: vi.fn(),
};

describe('ChannelRail keyboard access', () => {
  it('calls onSelect when Enter is pressed on a focused channel row', () => {
    const onSelect = vi.fn();
    const { getByRole } = render(<ChannelRail {...baseProps} onSelect={onSelect} />);
    const row = getByRole('button', { name: /Operator/i });
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('calls onSelect when Space is pressed on a focused channel row', () => {
    const onSelect = vi.fn();
    const { getByRole } = render(<ChannelRail {...baseProps} onSelect={onSelect} />);
    const row = getByRole('button', { name: /Operator/i });
    fireEvent.keyDown(row, { key: ' ' });
    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('pressing Enter on the remove control does not also fire onSelect on the row', () => {
    const onSelect = vi.fn();
    const dispatchChannel: ChatChannel = { ...channel('c2', 'Dispatch'), kind: 'dispatch', toolUseId: 'tu_1' };
    const { getByRole } = render(
      <ChannelRail {...baseProps} channels={[dispatchChannel]} activeChannelId="c2" onSelect={onSelect} />,
    );
    const removeButton = getByRole('button', { name: 'Remove channel' });
    fireEvent.keyDown(removeButton, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
```

The remove control (`ChannelRail.tsx:94-103`) currently renders only "×" with no accessible
name — Step 3 below adds `aria-label="Remove channel"` to it, which this test's
`getByRole('button', { name: 'Remove channel' })` targets.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- ChannelRail`
Expected: FAIL — the row `<div>` has no `role="button"`, and (for the third test) pressing
Enter on the remove button's native `<button>` would currently bubble a `keydown` up to the
row's future `onKeyDown` once Step 3 exists — written now, before that handler exists, this
test fails simply because `getByRole('button', { name: /Operator/i })` can't find the row.

- [ ] **Step 3: Add keyboard access to the channel row, with a bubbling guard**

In `src/components/chat/ChannelRail.tsx`, change (currently around line 86):

```tsx
<div key={c.id} onClick={() => onSelect(c.id)} style={rowStyle(on, c.archived)}>
```

to:

```tsx
<div
  key={c.id}
  onClick={() => onSelect(c.id)}
  onKeyDown={(e) => {
    if (e.target !== e.currentTarget) return; // let the nested remove Button handle its own Enter/Space
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(c.id);
    }
  }}
  tabIndex={0}
  role="button"
  aria-label={c.name}
  style={rowStyle(on, c.archived)}
>
```

The `e.target !== e.currentTarget` guard is the fix for the bubbling risk named in the design
spec: without it, pressing Enter while focus is on the nested remove `Button` would fire both
the button's own click and this row's `onSelect`, since a `keydown` on the inner button
bubbles up to the row. `e.target` is the actual focused element that received the key; when
it's the inner `Button`, `e.target !== e.currentTarget` (the row `<div>`) is true, so the row's
handler no-ops and only the inner button's own `onClick`/native Enter-as-click behavior fires.

Also in this file: the remove `Button` (`ChannelRail.tsx:95-102`) renders only "×" as its
child, with no accessible name. Add `aria-label="Remove channel"` to it:

```tsx
<Button
  onClick={() => {
    if (confirm('Remove this dispatch channel?')) onRemoveDispatchChannel(c.toolUseId!);
  }}
  style={removeStyle(colors)}
  aria-label="Remove channel"
>
  ×
</Button>
```

This requires adding the optional prop to `Button.tsx` first. Change:

```tsx
interface ButtonProps {
  onClick: () => void;
  style: CSSProperties;
  hoverStyle?: CSSProperties;
  title?: string;
  disabled?: boolean;
  children: ReactNode;
}
```

to:

```tsx
interface ButtonProps {
  onClick: () => void;
  style: CSSProperties;
  hoverStyle?: CSSProperties;
  title?: string;
  disabled?: boolean;
  'aria-label'?: string;
  children: ReactNode;
}
```

and change the destructured props and rendered `<button>` from:

```tsx
export function Button({ onClick, style, hoverStyle, title, disabled, children }: ButtonProps) {
  const mergedStyle = { ...RESET_STYLE, ...withoutUndefined(style) };
  const mergedHoverStyle = hoverStyle && { ...mergedStyle, ...withoutUndefined(hoverStyle) };
  const { style: hoveredStyle, onMouseEnter, onMouseLeave } = useHoverStyle(mergedStyle, mergedHoverStyle);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={hoveredStyle}
      title={title}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
```

to:

```tsx
export function Button({ onClick, style, hoverStyle, title, disabled, 'aria-label': ariaLabel, children }: ButtonProps) {
  const mergedStyle = { ...RESET_STYLE, ...withoutUndefined(style) };
  const mergedHoverStyle = hoverStyle && { ...mergedStyle, ...withoutUndefined(hoverStyle) };
  const { style: hoveredStyle, onMouseEnter, onMouseLeave } = useHoverStyle(mergedStyle, mergedHoverStyle);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={hoveredStyle}
      title={title}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}
```

This is additive-only (a new optional prop, undefined for every existing call site) — no
other `Button` consumer in the codebase needs updating.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- ChannelRail`
Expected: PASS, all 3 cases.

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/ChannelRail.tsx src/components/shared/Button.tsx src/components/chat/ChannelRail.test.tsx
git commit -m "feat: keyboard access for chat channel row selection, guarded against remove-button bubbling"
```

---

### Task 3: Swap span-styled buttons for the real `Button` component

**Files:**
- Modify: `src/components/projects/ProjectRosterCard.tsx`
- Modify: `src/components/memory/MemoryRosterCard.tsx`
- Test: `src/components/projects/ProjectRosterCard.test.tsx` (new)
- Test: `src/components/memory/MemoryRosterCard.test.tsx` (new)

**Interfaces:** None new — both files already `import { Button } from '../shared/Button'`
and use it elsewhere in the same file.

- [ ] **Step 1: Write the failing tests**

Create `src/components/projects/ProjectRosterCard.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ProjectRosterCard } from './ProjectRosterCard';
import { AetherStoreProvider } from '../../state/store';

afterEach(cleanup);

describe('ProjectRosterCard keyboard access', () => {
  it('the ADD control is a real keyboard-native button', () => {
    const { getByRole } = render(
      <AetherStoreProvider>
        <ProjectRosterCard selectedName={null} />
      </AetherStoreProvider>,
    );
    const addButton = getByRole('button', { name: /ADD/i });
    expect(addButton.tagName).toBe('BUTTON');
  });
});
```

Create `src/components/memory/MemoryRosterCard.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryRosterCard } from './MemoryRosterCard';
import { AetherStoreProvider } from '../../state/store';

afterEach(cleanup);

describe('MemoryRosterCard keyboard access', () => {
  it('the remember-submit control is a real keyboard-native button', () => {
    const { getByRole } = render(
      <AetherStoreProvider>
        <MemoryRosterCard selectedId={null} />
      </AetherStoreProvider>,
    );
    const submitButton = getByRole('button', { name: '+' });
    expect(submitButton.tagName).toBe('BUTTON');
  });
});
```

Both fixtures follow `Button.test.tsx`'s existing pattern of wrapping in `AetherStoreProvider`
(read that file first for the exact import/wrapping convention if these calls need
adjustment — `useAetherStore()` requires the provider).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- ProjectRosterCard` and `npm test -- MemoryRosterCard`
Expected: FAIL — `getByRole('button', { name: /ADD/i })` / `{ name: '+' }` cannot find a
`<span>`.

- [ ] **Step 3: Swap the spans for `Button`**

In `src/components/projects/ProjectRosterCard.tsx`, change (currently line 17):

```tsx
<span onClick={() => dispatch({ type: 'NEW_PROJECT' })} style={addButtonStyle(colors)}>
  + ADD
</span>
```

to:

```tsx
<Button onClick={() => dispatch({ type: 'NEW_PROJECT' })} style={addButtonStyle(colors)}>
  + ADD
</Button>
```

In `src/components/memory/MemoryRosterCard.tsx`, change (currently line 51):

```tsx
<span onClick={submitRemember} style={rememberButtonStyle(colors)}>
  +
</span>
```

to:

```tsx
<Button onClick={submitRemember} style={rememberButtonStyle(colors)}>
  +
</Button>
```

Both files' `addButtonStyle`/`rememberButtonStyle` functions return a `CSSProperties` object
that already includes `cursor: 'pointer'` and font/padding — no style function changes needed;
`Button`'s own `RESET_STYLE` merge (see `Button.tsx`) already strips default `<button>` chrome
so the visual result should be unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- ProjectRosterCard` and `npm test -- MemoryRosterCard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/projects/ProjectRosterCard.tsx src/components/projects/ProjectRosterCard.test.tsx src/components/memory/MemoryRosterCard.tsx src/components/memory/MemoryRosterCard.test.tsx
git commit -m "feat: swap span-styled add/submit controls for the real keyboard-native Button component"
```

---

### Task 4: `prefersReducedMotion` — CSS tier

**Files:**
- Modify: `src/styles/global.css`

**Interfaces:** None — pure CSS, no code consumes this directly.

- [ ] **Step 1: Add the reduced-motion override block**

At the end of `src/styles/global.css`, add:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

This is a standard, broad override — it does not require enumerating the file's 15
`@keyframes` names individually; any element using `animation:`/`transition:` anywhere in the
app is covered by the universal selector.

- [ ] **Step 2: Verify manually (no automated test for this step)**

There is no meaningful automated test for a CSS media query in this project's `vitest`+jsdom
setup (jsdom does not apply CSS layout/media rules the way a real browser does). This is a
named, accepted verification gap — same category as this project's established practice of
naming visual/manual verification gaps rather than silently claiming coverage. Skip to commit.

- [ ] **Step 3: Commit**

```bash
git add src/styles/global.css
git commit -m "feat: add prefers-reduced-motion CSS override for all animations/transitions"
```

---

### Task 5: `prefersReducedMotion` — reactor pulse tier

**Files:**
- Create: `src/components/shared/useReducedMotion.ts`
- Create: `src/components/shared/useReducedMotion.test.ts`
- Modify: `src/components/reactor/reactorMath.ts`
- Modify: `src/components/reactor/reactorMath.test.ts`
- Modify: `src/components/reactor/useReactorCanvas.ts`

**Interfaces:**
- Produces: `export function useReducedMotion(): boolean` in
  `src/components/shared/useReducedMotion.ts` — a React hook reading
  `window.matchMedia('(prefers-reduced-motion: reduce)')`, updating on the media query's
  `change` event.
- Produces: `export function effectivePulseDuration(dur: number, reducedMotion: boolean):
  number` in `reactorMath.ts` — used by Task 5's own `useReactorCanvas.ts` changes only.

- [ ] **Step 1: Write the failing test for the hook**

Create `src/components/shared/useReducedMotion.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReducedMotion } from './useReducedMotion';

function mockMatchMedia(initialMatches: boolean) {
  let changeHandler: ((e: { matches: boolean }) => void) | null = null;
  const mql = {
    matches: initialMatches,
    addEventListener: vi.fn((event: string, handler: (e: { matches: boolean }) => void) => {
      if (event === 'change') changeHandler = handler;
    }),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql));
  return {
    triggerChange: (matches: boolean) => {
      mql.matches = matches;
      changeHandler?.({ matches });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useReducedMotion', () => {
  it('returns the initial matchMedia state', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  it('returns false when the OS setting is off', () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  it('updates when the media query change event fires', () => {
    const { triggerChange } = mockMatchMedia(false);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
    act(() => triggerChange(true));
    expect(result.current).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- useReducedMotion`
Expected: FAIL — `./useReducedMotion` module does not exist yet.

- [ ] **Step 3: Implement the hook**

Create `src/components/shared/useReducedMotion.ts`:

```ts
import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(QUERY).matches);

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- useReducedMotion`
Expected: PASS, all 3 cases.

- [ ] **Step 5: Write the failing test for `effectivePulseDuration`**

Add to `src/components/reactor/reactorMath.test.ts`:

```ts
describe('effectivePulseDuration', () => {
  it('passes through the computed duration when reduced motion is off', () => {
    expect(effectivePulseDuration(0.8, false)).toBe(0.8);
    expect(effectivePulseDuration(2.9, false)).toBe(2.9);
  });

  it('returns a calm constant, outside the normal 0.8-2.9s range, when reduced motion is on', () => {
    const reduced = effectivePulseDuration(0.8, true);
    expect(reduced).toBe(4.0);
    expect(reduced).toBeGreaterThan(2.9);
  });
});
```

Add `effectivePulseDuration` to the file's top `import { ... } from './reactorMath'` block.

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- reactorMath`
Expected: FAIL — `effectivePulseDuration` is not exported.

- [ ] **Step 7: Implement `effectivePulseDuration`**

In `src/components/reactor/reactorMath.ts`, add near `computePulseDuration` (after its
closing brace, currently around line 49):

```ts
// A deliberately calm, steady pulse when the OS's reduced-motion setting is on -- not a
// frozen/static reactor (which could misread as broken rather than motion-reduced), and well
// outside computePulseDuration's normal 0.8-2.9s range so the difference is unambiguous.
const REDUCED_MOTION_PULSE_DUR = 4.0;

export function effectivePulseDuration(dur: number, reducedMotion: boolean): number {
  return reducedMotion ? REDUCED_MOTION_PULSE_DUR : dur;
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm test -- reactorMath`
Expected: PASS.

- [ ] **Step 9: Wire both into `useReactorCanvas.ts`**

In `src/components/reactor/useReactorCanvas.ts`:

Add to the import block (currently lines 3-10):

```ts
import {
  advancePhase,
  computeConcurrencyTurbulence,
  computeDispatchIntensity,
  computePulseDuration,
  computeSurge,
  computeThemeFilter,
  effectivePulseDuration,
} from './reactorMath';
import { useReducedMotion } from '../shared/useReducedMotion';
```

In `usePulseDurationVar` (currently lines 29-35), change:

```ts
export function usePulseDurationVar() {
  const { state } = useAetherStore();
  useEffect(() => {
    const dur = computePulseDuration(state.momentum, state.cfg.pulseMode, state.alarmLevel);
    document.documentElement.style.setProperty('--pulse-dur', `${dur.toFixed(2)}s`);
  }, [state.momentum, state.cfg.pulseMode, state.alarmLevel]);
}
```

to:

```ts
export function usePulseDurationVar() {
  const { state } = useAetherStore();
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    const dur = effectivePulseDuration(computePulseDuration(state.momentum, state.cfg.pulseMode, state.alarmLevel), reducedMotion);
    document.documentElement.style.setProperty('--pulse-dur', `${dur.toFixed(2)}s`);
  }, [state.momentum, state.cfg.pulseMode, state.alarmLevel, reducedMotion]);
}
```

In `useReactorCanvas` (currently starting line 37), the `runFrame` function runs inside a
`requestAnimationFrame` loop and cannot call the `useReducedMotion()` hook itself (hooks are
only valid in a render context) — call it once at the top of `useReactorCanvas`, same as the
existing `state`/`stateRef` pattern, and read it from a ref inside `runFrame`. Add, near the
existing `stateRef`/`drawRef` declarations (currently around lines 38-53):

```ts
  const reducedMotion = useReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;
```

Then in `runFrame` (currently line 64), change:

```ts
        const dur = computePulseDuration(s.momentum, s.cfg.pulseMode, s.alarmLevel);
```

to:

```ts
        const dur = effectivePulseDuration(computePulseDuration(s.momentum, s.cfg.pulseMode, s.alarmLevel), reducedMotionRef.current);
```

- [ ] **Step 10: Run the full test suite and type-check**

Run: `npm test` and `npx tsc -b` (use `tsc -b`, not `tsc --noEmit` — this project's composite
tsconfig setup requires the build-mode flag; `--noEmit` produces a spurious `TS6305` error
unrelated to this change).
Expected: all tests pass, zero type errors.

- [ ] **Step 11: Commit**

```bash
git add src/components/shared/useReducedMotion.ts src/components/shared/useReducedMotion.test.ts src/components/reactor/reactorMath.ts src/components/reactor/reactorMath.test.ts src/components/reactor/useReactorCanvas.ts
git commit -m "feat: honor prefers-reduced-motion in the reactor's pulse-speed loop"
```

---

### Task 6: Playwright `_electron` e2e smoke tests

**Files:**
- Modify: `package.json`
- Create: `playwright.config.ts`
- Create: `e2e/electronHelpers.ts`
- Create: `e2e/app.spec.ts`

**Interfaces:** None consumed from earlier tasks — this is new, independent infrastructure.

- [ ] **Step 1: Install the dependency and add the npm script**

Run: `npm install --save-dev @playwright/test`

In `package.json`'s `"scripts"` block, add:

```json
    "test:e2e": "playwright test",
```

(placed alongside the existing `"test": "vitest run"` line).

- [ ] **Step 2: Create the Playwright config**

Create `playwright.config.ts` at the project root:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  reporter: 'list',
  workers: 1,
});
```

`workers: 1` because each test launches its own real Electron process — running them in
parallel risks the same single-instance-lock collision this project's own PROGRESS.md already
documented once (Stage 7's closing task hit exactly this between two concurrently-running
`electron:dev` instances).

- [ ] **Step 3: Create the launch helper**

Create `e2e/electronHelpers.ts`:

```ts
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
}

export async function launchApp(): Promise<LaunchedApp> {
  const app = await electron.launch({ args: ['.'] });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}
```

This launches against the project root's `package.json` `"main"` field
(`out/main/main.js`), which requires a prior `npm run electron:build` — note this in Step 5's
verification instructions, not as a step this task runs unconditionally (a stale build should
not silently pass).

- [ ] **Step 4: Write the smoke tests**

Create `e2e/app.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { launchApp } from './electronHelpers';

const SIDEBAR_TABS = ['Dashboard', 'Terminal', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Optimize', 'Uplinks', 'Settings'];

test.describe('Aether OS smoke', () => {
  test('launches without crashing', async () => {
    const { app, window } = await launchApp();
    await expect(window.locator('body')).toBeVisible();
    await app.close();
  });

  test('every sidebar tab renders its view with no console errors', async () => {
    const { app, window } = await launchApp();
    const consoleErrors: string[] = [];
    window.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    for (const tab of SIDEBAR_TABS) {
      await window.getByRole('button', { name: tab }).click();
      await window.waitForTimeout(200);
    }

    expect(consoleErrors).toEqual([]);
    await app.close();
  });

  test('the embedded terminal spawns a real pty and echoes a typed command', async () => {
    const { app, window } = await launchApp();
    await window.getByRole('button', { name: 'Terminal' }).click();
    await window.locator('.xterm-screen').waitFor({ state: 'visible', timeout: 10000 });

    const marker = `aether-e2e-${Date.now()}`;
    await window.locator('.xterm-helper-textarea').click();
    await window.keyboard.type(`echo ${marker}`);
    await window.keyboard.press('Enter');

    await expect(window.locator('.xterm-screen')).toContainText(marker, { timeout: 10000 });
    await app.close();
  });

  test('the dashboard metrics row renders real-usage data', async () => {
    const { app, window } = await launchApp();
    await expect(window.getByText('Tokens used')).toBeVisible({ timeout: 15000 });
    await app.close();
  });
});
```

The `.xterm-screen`/`.xterm-helper-textarea` selectors and the "Tokens used" text (from
`BottomMetricsRow.tsx`, globally mounted in `App.tsx`) are verified against the current
codebase, not guessed. If xterm's DOM structure differs from this at execution time (version
drift), the implementer should inspect the real rendered DOM (`page.locator('.xterm').screenshot()`
or `page.content()`) and adjust the selector — noted here as a known risk, not silently
papered over.

- [ ] **Step 5: Attempt real execution and report honestly**

```bash
npm run electron:build
npx playwright install chromium  # electron uses its own bundled Chromium, but this project's playwright.config has no browser project configured beyond electron -- if `npx playwright test` complains about a missing browser, this step's install may not be needed at all for _electron; verify against the actual error before assuming it's required
npm run test:e2e
```

This development environment's display availability has varied session-to-session across
this project's history (headless in Stages 4-6, a real display found in Stage 7's closing
task). Attempt the run for real. If it succeeds, record the pass count. If it fails due to a
missing display or another environment constraint (not a code defect), state that plainly in
the report — do not claim untested code is verified, and do not silently skip this step.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json playwright.config.ts e2e/
git commit -m "feat: add Playwright _electron e2e smoke tests for launch, nav, terminal, and dashboard"
```

---

### Task 7: Verify, document, close out Stage 9

**Files:**
- Modify: `PROGRESS.md`
- Modify: `docs/roadmap.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Full verification**

From `C:/Users/Matt/projects/aether-os`:

```bash
npm test
npx tsc -b
cd collector && npm test && cd ..
```

Expected: all green. If anything fails, stop and fix before documenting.

- [ ] **Step 2: Update `docs/roadmap.md`**

Change row 9 (currently `| **9** | **Hardening** | Playwright \`_electron\` e2e (retires the
recurring "verification deferred to the user"), keyboard nav, \`prefersReducedMotion\`. | ~6
tasks |`) to prepend a `**Status: shipped**` marker, matching the convention on rows 2-8:

```
| **9** | **Hardening** | **Status: shipped** — see `docs/superpowers/plans/2026-07-30-hardening-stage9.md`. Playwright `_electron` e2e (retires the recurring "verification deferred to the user"), keyboard nav, `prefersReducedMotion`. | ~6 tasks |
```

- [ ] **Step 3: Add a `PROGRESS.md` "Shipped plans" entry**

Add a new bullet at the top of the `## Shipped plans (newest first)` list, above the existing
newest entry, following the established style (bold linked title, plan-doc link, prose
summary, sub-bullets only for real corrections/deferrals that actually occurred — do not
invent one if the tasks went cleanly):

```
- **[Hardening (Stage 9)](docs/superpowers/plans/2026-07-30-hardening-stage9.md)** — all 7 tasks passed. Adds Playwright `_electron` e2e smoke tests (launch, sidebar nav, terminal pty echo, dashboard real-usage render), keyboard access for the four real raw-click gaps found by a precise audit (Grid agent-node selection, chat channel-row selection, and two span-styled buttons swapped for the existing keyboard-native `Button` component in Projects/Memory), and `prefers-reduced-motion` support at both tiers — a global CSS override for the app's 15 `@keyframes` animations, and a `useReducedMotion` hook feeding a calm, steady pulse duration into the reactor's own `requestAnimationFrame` loop instead of a CSS media query it can't reach.
```

If Task 6's e2e execution (Step 5) could not run to green in this environment, add one
sub-bullet stating that plainly, naming the actual blocker encountered — do not omit it or
imply the tests were verified if they weren't runnable here.

If the initial broad keyboard-nav audit (23 files, later corrected to 4 real gaps during
brainstorming) is worth a note for future readers, add one sub-bullet naming that correction —
otherwise omit sub-bullets entirely rather than inventing one.

- [ ] **Step 4: Commit**

```bash
git add PROGRESS.md docs/roadmap.md
git commit -m "docs: Stage 9 (Hardening) shipped -- roadmap/PROGRESS closeout"
```
