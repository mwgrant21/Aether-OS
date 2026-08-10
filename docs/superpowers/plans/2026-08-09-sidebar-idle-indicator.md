# Sidebar Idle Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pulse the sidebar dot on the Terminal and Codex nav items when that terminal has gone quiet for 3 seconds and isn't the currently active tab.

**Architecture:** Two new renderer-only hooks (`useTerminalIdleSync`/`useCodexTerminalIdleSync`) subscribe to the existing `pty.onData`/`codexPty.onData` streams as a second, independent listener alongside `PtyTerminal.tsx`/`PtyCodexTerminal.tsx`'s own, debounce a 3s idle timer, and dispatch `terminalIdle`/`codexTerminalIdle` booleans into AetherState. `Sidebar.tsx` renders a CSS pulse on a nav item's dot when `idle && id !== activeTab`.

**Tech Stack:** React, existing AetherState reducer/persistence layer, `@xterm`-fed Electron IPC (`window.aetherElectron.pty`/`.codexPty`, already exposed by earlier work — not modified here), inline `CSSProperties` + a new `@keyframes` entry in `src/styles/global.css` (this codebase's existing animation convention — see `breath`/`blink` keyframes already there).

## Global Constraints

- Idle threshold is **3000ms** of no new pty output, fixed (not user-configurable in v1).
- 100% renderer-side — no new IPC channels, no changes to `electron/main.ts`, `electron/preload.ts`, `electron/ptyManager.ts`, or `electron/codexPtyManager.ts`.
- `PtyTerminal.tsx`/`PtyCodexTerminal.tsx` are **not modified** — the new hooks register a second, independent `onData` listener (confirmed safe: `electron/preload.ts` registers pty:data/codexPty:data via `ipcRenderer.on`, which supports multiple independent listeners).
- `terminalIdle`/`codexTerminalIdle` are excluded from persistence (live/recomputed signals), mirroring `terminalAlive`/`codexTerminalAlive`'s existing exclusion entries in `src/state/persistence.ts`.
- Applies only to the `'Terminal'` and `'Codex'` sidebar ids — no other `Sidebar.tsx` nav item is affected.
- No sound, no OS notification, no taskbar/dock badge — sidebar dot only.

---

### Task 1: Idle state — types, initial state, reducer, persistence exclusions

**Files:**
- Modify: `src/state/types.ts` (add fields after `codexTerminalAlive`, ~line 279)
- Modify: `src/state/initialState.ts` (add defaults after `codexTerminalAlive`, ~line 155)
- Modify: `src/state/reducer.ts` (add to `Action` union ~line 37, add reducer cases ~line 193)
- Modify: `src/state/persistence.ts` (add exclusion entries ~line 49)
- Test: `src/state/reducer.test.ts` (append after the existing `SET_CODEX_TERMINAL_ALIVE` tests, ~line 143)

**Interfaces:**
- Produces: `state.terminalIdle: boolean`, `state.codexTerminalIdle: boolean` (both default `false`); `Action` variants `{ type: 'SET_TERMINAL_IDLE'; idle: boolean }` and `{ type: 'SET_CODEX_TERMINAL_IDLE'; idle: boolean }`. Task 2's hooks dispatch these exact action shapes.

- [ ] **Step 1: Write the failing reducer tests**

Append to `src/state/reducer.test.ts`, right after the existing `SET_CODEX_TERMINAL_ALIVE` test block:

```ts
  it('SET_TERMINAL_IDLE flips terminalIdle to true (no new pty output for the threshold window)', () => {
    const next = reducer(initialState, { type: 'SET_TERMINAL_IDLE', idle: true });
    expect(next.terminalIdle).toBe(true);
  });

  it('SET_TERMINAL_IDLE flips terminalIdle to false (new pty output arrived)', () => {
    const idle = reducer(initialState, { type: 'SET_TERMINAL_IDLE', idle: true });
    const next = reducer(idle, { type: 'SET_TERMINAL_IDLE', idle: false });
    expect(next.terminalIdle).toBe(false);
  });

  it('SET_CODEX_TERMINAL_IDLE flips codexTerminalIdle to true', () => {
    const next = reducer(initialState, { type: 'SET_CODEX_TERMINAL_IDLE', idle: true });
    expect(next.codexTerminalIdle).toBe(true);
  });

  it('SET_CODEX_TERMINAL_IDLE flips codexTerminalIdle to false', () => {
    const idle = reducer(initialState, { type: 'SET_CODEX_TERMINAL_IDLE', idle: true });
    const next = reducer(idle, { type: 'SET_CODEX_TERMINAL_IDLE', idle: false });
    expect(next.codexTerminalIdle).toBe(false);
  });

  it('SET_CODEX_TERMINAL_IDLE leaves terminalIdle (the Claude terminal\'s own flag) untouched', () => {
    const claudeIdle = reducer(initialState, { type: 'SET_TERMINAL_IDLE', idle: true });
    const next = reducer(claudeIdle, { type: 'SET_CODEX_TERMINAL_IDLE', idle: true });
    expect(next.terminalIdle).toBe(true);
    expect(next.codexTerminalIdle).toBe(true);
  });

  it('SET_TERMINAL_IDLE leaves codexTerminalIdle untouched', () => {
    const codexIdle = reducer(initialState, { type: 'SET_CODEX_TERMINAL_IDLE', idle: true });
    const next = reducer(codexIdle, { type: 'SET_TERMINAL_IDLE', idle: true });
    expect(next.codexTerminalIdle).toBe(true);
    expect(next.terminalIdle).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/state/reducer.test.ts`
Expected: FAIL — `Property 'terminalIdle' does not exist` / unknown action type `SET_TERMINAL_IDLE`, etc. (`types.ts`/`reducer.ts` don't have these yet).

- [ ] **Step 3: Add the state fields to `types.ts`**

In `src/state/types.ts`, immediately after the existing `codexTerminalAlive: boolean;` field (~line 279):

```ts
  // True whenever the embedded terminal's pty has produced no output for
  // IDLE_THRESHOLD_MS (useTerminalIdleSync.ts) -- an activity-silence proxy
  // for "probably awaiting input", not a literal one (a silent long-running
  // command also reads as idle). Drives the sidebar's pulsing nav-dot when
  // this tab isn't the active one (see Sidebar.tsx). Independent of
  // terminalAlive: a dead pty is never idle in this sense, it's just dead.
  terminalIdle: boolean;
  // Same pattern as terminalIdle, but for the independent Codex pty.
  codexTerminalIdle: boolean;
```

- [ ] **Step 4: Add the defaults to `initialState.ts`**

In `src/state/initialState.ts`, immediately after the existing `codexTerminalAlive: false,` line (~line 155):

```ts
  terminalIdle: false,
  codexTerminalIdle: false,
```

- [ ] **Step 5: Add the action variants and reducer cases to `reducer.ts`**

In `src/state/reducer.ts`, add to the `Action` union immediately after the existing `SET_CODEX_TERMINAL_ALIVE` line (~line 37):

```ts
  | { type: 'SET_TERMINAL_IDLE'; idle: boolean }
  | { type: 'SET_CODEX_TERMINAL_IDLE'; idle: boolean }
```

Add the reducer cases immediately after the existing `SET_CODEX_TERMINAL_ALIVE` case (~line 193):

```ts
    case 'SET_TERMINAL_IDLE':
      return { ...state, terminalIdle: action.idle };

    case 'SET_CODEX_TERMINAL_IDLE':
      return { ...state, codexTerminalIdle: action.idle };
```

- [ ] **Step 6: Add the persistence exclusion entries**

In `src/state/persistence.ts`, add to `PERSISTENCE_EXCLUSIONS` immediately after the existing `codexTerminalAlive` entry (~line 49):

```ts
  terminalIdle: "recomputed live -- derived from this session's own pty:data stream via useTerminalIdleSync (3s of silence = idle); a persisted value would show a stale idle/active state from a previous session with no pty behind it",
  codexTerminalIdle: "recomputed live -- derived from this session's own codexPty:data stream via useCodexTerminalIdleSync, same reasoning as terminalIdle",
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/state/reducer.test.ts src/state/persistence.test.ts`
Expected: PASS — including `persistence.test.ts`'s existing coverage-enforcement test (it fails automatically if a new `AetherState` key is missing from both the `savePersisted` whitelist and `PERSISTENCE_EXCLUSIONS`; adding the exclusion entries in Step 6 satisfies it without a new test).

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npx tsc -b && npx vitest run`
Expected: clean compile, all tests passing (no regressions).

- [ ] **Step 9: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/state/reducer.ts src/state/persistence.ts src/state/reducer.test.ts
git commit -m "feat(idle-indicator): add terminalIdle/codexTerminalIdle state"
```

---

### Task 2: Idle-tracking hooks, mounted in App.tsx

**Files:**
- Create: `src/state/useTerminalIdleSync.ts`
- Create: `src/state/useCodexTerminalIdleSync.ts`
- Create: `src/state/useTerminalIdleSync.test.ts`
- Create: `src/state/useCodexTerminalIdleSync.test.ts`
- Modify: `src/App.tsx` (import + mount two new wrapper components)

**Interfaces:**
- Consumes: `state.terminalIdle`/`state.codexTerminalIdle` and the `SET_TERMINAL_IDLE`/`SET_CODEX_TERMINAL_IDLE` actions from Task 1. `window.aetherElectron.pty.onData(cb): () => void`, `.onExit(cb): () => void` (and the identical `.codexPty` shape) — both already exist and are unmodified by this plan.
- Produces: `useTerminalIdleSync()`, `useCodexTerminalIdleSync()` — no-argument hooks, called once each from a wrapper component in `App.tsx`. Task 3 reads `state.terminalIdle`/`state.codexTerminalIdle` from the store; it does not call these hooks directly.

- [ ] **Step 1: Write the failing test for `useTerminalIdleSync`**

Create `src/state/useTerminalIdleSync.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTerminalIdleSync } from './useTerminalIdleSync';
import { AetherStoreProvider, useAetherStore } from './store';
import type { ReactNode } from 'react';

const IDLE_THRESHOLD_MS = 3000;

function wrapper({ children }: { children: ReactNode }) {
  return <AetherStoreProvider>{children}</AetherStoreProvider>;
}

describe('useTerminalIdleSync', () => {
  let dataCallback: ((data: string) => void) | undefined;
  let exitCallback: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    dataCallback = undefined;
    exitCallback = undefined;
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      pty: {
        onData: (cb: (data: string) => void) => {
          dataCallback = cb;
          return () => { dataCallback = undefined; };
        },
        onExit: (cb: () => void) => {
          exitCallback = cb;
          return () => { exitCallback = undefined; };
        },
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
  });

  it('does nothing when window.aetherElectron.pty is absent', () => {
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {};
    const { result } = renderHook(
      () => {
        useTerminalIdleSync();
        return useAetherStore().state.terminalIdle;
      },
      { wrapper },
    );
    expect(result.current).toBe(false);
  });

  it('marks terminalIdle=true after IDLE_THRESHOLD_MS of no data', () => {
    const { result } = renderHook(
      () => {
        useTerminalIdleSync();
        return useAetherStore().state.terminalIdle;
      },
      { wrapper },
    );
    expect(result.current).toBe(false);

    act(() => {
      dataCallback?.('some output');
      vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
    });

    expect(result.current).toBe(true);
  });

  it('resets to terminalIdle=false when new data arrives, then re-idles after another silent window', () => {
    const { result } = renderHook(
      () => {
        useTerminalIdleSync();
        return useAetherStore().state.terminalIdle;
      },
      { wrapper },
    );

    act(() => {
      dataCallback?.('burst 1');
      vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
    });
    expect(result.current).toBe(true);

    act(() => {
      dataCallback?.('burst 2');
    });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
    });
    expect(result.current).toBe(true);
  });

  it('does not throw when the pty exits mid-countdown', () => {
    renderHook(
      () => {
        useTerminalIdleSync();
        return useAetherStore().state.terminalIdle;
      },
      { wrapper },
    );

    expect(() => {
      act(() => {
        dataCallback?.('some output');
        exitCallback?.();
        vi.advanceTimersByTime(IDLE_THRESHOLD_MS);
      });
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/state/useTerminalIdleSync.test.ts`
Expected: FAIL — `Cannot find module './useTerminalIdleSync'`.

- [ ] **Step 3: Implement `useTerminalIdleSync`**

Create `src/state/useTerminalIdleSync.ts`:

```ts
import { useEffect } from 'react';
import { useAetherStore } from './store';

/** How long the embedded terminal's pty must produce no output before its
 *  sidebar tab is treated as idle -- see docs/superpowers/specs/
 *  2026-08-09-sidebar-idle-indicator-design.md §2 for why this is an
 *  activity-silence proxy rather than a literal "awaiting input" signal. */
export const IDLE_THRESHOLD_MS = 3000;

/** Mirrors useTerminalAliveSync.ts's subscribe-on-mount/unsubscribe-on-unmount
 *  shape, but derives state.terminalIdle from the pty:data stream instead of
 *  pty:alive/pty:exit. Registers its own independent onData listener
 *  alongside PtyTerminal.tsx's -- electron/preload.ts's ipcRenderer.on-based
 *  registration supports multiple concurrent listeners, so this never
 *  interferes with the terminal's own data-to-xterm wiring. */
export function useTerminalIdleSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const pty = window.aetherElectron?.pty;
    if (!pty) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const markIdle = () => {
      timer = null;
      dispatch({ type: 'SET_TERMINAL_IDLE', idle: true });
    };

    const markActive = () => {
      dispatch({ type: 'SET_TERMINAL_IDLE', idle: false });
      if (timer) clearTimeout(timer);
      timer = setTimeout(markIdle, IDLE_THRESHOLD_MS);
    };

    const unsubscribeData = pty.onData(markActive);
    // On exit, only clear the pending timer -- do not force idle back to
    // false. A dead pty has nothing new to report; terminalAlive already
    // communicates liveness separately (see spec §4).
    const unsubscribeExit = pty.onExit(() => {
      if (timer) clearTimeout(timer);
      timer = null;
    });

    return () => {
      unsubscribeData();
      unsubscribeExit();
      if (timer) clearTimeout(timer);
    };
  }, [dispatch]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/state/useTerminalIdleSync.test.ts`
Expected: PASS (4/4 tests).

- [ ] **Step 5: Write the failing test for `useCodexTerminalIdleSync`**

Create `src/state/useCodexTerminalIdleSync.test.ts` — identical to `useTerminalIdleSync.test.ts` from Step 1, with these substitutions throughout: `useTerminalIdleSync` → `useCodexTerminalIdleSync`, `./useTerminalIdleSync` → `./useCodexTerminalIdleSync`, `aetherElectron: { pty: {...} }` → `aetherElectron: { codexPty: {...} }`, `state.terminalIdle` → `state.codexTerminalIdle`.

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/state/useCodexTerminalIdleSync.test.ts`
Expected: FAIL — `Cannot find module './useCodexTerminalIdleSync'`.

- [ ] **Step 7: Implement `useCodexTerminalIdleSync`**

Create `src/state/useCodexTerminalIdleSync.ts` — identical to `useTerminalIdleSync.ts` from Step 3, with these substitutions: `useTerminalIdleSync` → `useCodexTerminalIdleSync`, `window.aetherElectron?.pty` → `window.aetherElectron?.codexPty`, `SET_TERMINAL_IDLE` → `SET_CODEX_TERMINAL_IDLE`, and the doc comment's "the embedded terminal's pty"/"PtyTerminal.tsx" references become "the independent Codex pty"/"PtyCodexTerminal.tsx". Do not re-export `IDLE_THRESHOLD_MS` from this file — import it from `./useTerminalIdleSync` instead, so the two hooks share one source of truth for the threshold:

```ts
import { useEffect } from 'react';
import { useAetherStore } from './store';
import { IDLE_THRESHOLD_MS } from './useTerminalIdleSync';

/** Mirrors useTerminalIdleSync.ts exactly, for the independent Codex pty. */
export function useCodexTerminalIdleSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const codexPty = window.aetherElectron?.codexPty;
    if (!codexPty) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const markIdle = () => {
      timer = null;
      dispatch({ type: 'SET_CODEX_TERMINAL_IDLE', idle: true });
    };

    const markActive = () => {
      dispatch({ type: 'SET_CODEX_TERMINAL_IDLE', idle: false });
      if (timer) clearTimeout(timer);
      timer = setTimeout(markIdle, IDLE_THRESHOLD_MS);
    };

    const unsubscribeData = codexPty.onData(markActive);
    const unsubscribeExit = codexPty.onExit(() => {
      if (timer) clearTimeout(timer);
      timer = null;
    });

    return () => {
      unsubscribeData();
      unsubscribeExit();
      if (timer) clearTimeout(timer);
    };
  }, [dispatch]);
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run src/state/useCodexTerminalIdleSync.test.ts`
Expected: PASS (4/4 tests).

- [ ] **Step 9: Mount both hooks in `App.tsx`**

In `src/App.tsx`, add two imports immediately after the existing `useCodexTerminalAliveSync` import (~line 17):

```ts
import { useTerminalIdleSync } from './state/useTerminalIdleSync';
import { useCodexTerminalIdleSync } from './state/useCodexTerminalIdleSync';
```

Add two wrapper components immediately after the existing `CodexTerminalAliveSync` component (~line 113):

```tsx
function TerminalIdleSync() {
  useTerminalIdleSync();
  return null;
}

function CodexTerminalIdleSync() {
  useCodexTerminalIdleSync();
  return null;
}
```

Mount both immediately after the existing `<CodexTerminalAliveSync />` line (~line 46):

```tsx
        <TerminalIdleSync />
        <CodexTerminalIdleSync />
```

- [ ] **Step 10: Run the full suite and typecheck**

Run: `npx tsc -b && npx vitest run`
Expected: clean compile, all tests passing (no regressions).

- [ ] **Step 11: Commit**

```bash
git add src/state/useTerminalIdleSync.ts src/state/useTerminalIdleSync.test.ts src/state/useCodexTerminalIdleSync.ts src/state/useCodexTerminalIdleSync.test.ts src/App.tsx
git commit -m "feat(idle-indicator): add terminal/codex idle-tracking hooks, mount in App"
```

---

### Task 3: Sidebar pulse indicator

**Files:**
- Modify: `src/styles/global.css` (add `@keyframes idlePulse`)
- Modify: `src/components/layout/Sidebar.tsx` (compute idle-and-not-active per item, extend the nav dot)
- Create: `src/components/layout/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `state.terminalIdle`, `state.codexTerminalIdle`, `state.activeTab` from Task 1/existing state. No new exports — this is the terminal (pun intended) consumer of the whole feature.

- [ ] **Step 1: Add the pulse keyframe to `global.css`**

In `src/styles/global.css`, add immediately after the existing `@keyframes blink { ... }` block:

```css
@keyframes idlePulse {
  0%,
  100% {
    opacity: 1;
    box-shadow: 0 0 0 0 rgba(255, 176, 32, 0.55);
  }
  50% {
    opacity: 0.55;
    box-shadow: 0 0 0 4px rgba(255, 176, 32, 0);
  }
}
```

- [ ] **Step 2: Write the failing Sidebar test**

`Sidebar.tsx` reads state via `useAetherStore()` with no seam to inject a fake store, so the test drives real state through a small test-only wrapper that dispatches setup actions before render, then asserts on the rendered dot's `data-idle-pulse` attribute.

Create `src/components/layout/Sidebar.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar } from './Sidebar';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { useEffect, type ReactNode } from 'react';

function DispatchOnMount({ actions, children }: { actions: Array<{ type: string; [k: string]: unknown }>; children: ReactNode }) {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actions.forEach((a) => dispatch(a as any));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <>{children}</>;
}

function renderSidebar(actions: Array<{ type: string; [k: string]: unknown }> = []) {
  return render(
    <AetherStoreProvider>
      <DispatchOnMount actions={actions}>
        <Sidebar />
      </DispatchOnMount>
    </AetherStoreProvider>,
  );
}

describe('Sidebar idle indicator', () => {
  it('does not show an idle pulse on Terminal or Codex by default (neither idle)', () => {
    renderSidebar();
    expect(screen.getByText('Terminal').closest('button')?.querySelector('[data-idle-pulse="true"]')).toBeNull();
    expect(screen.getByText('Codex').closest('button')?.querySelector('[data-idle-pulse="true"]')).toBeNull();
  });

  it('shows an idle pulse on Terminal when terminalIdle=true and Terminal is not the active tab', () => {
    renderSidebar([
      { type: 'SET_ACTIVE_TAB', tab: 'Dashboard' },
      { type: 'SET_TERMINAL_IDLE', idle: true },
    ]);
    expect(screen.getByText('Terminal').closest('button')?.querySelector('[data-idle-pulse="true"]')).not.toBeNull();
  });

  it('does not show an idle pulse on Terminal when it IS the active tab, even if idle', () => {
    renderSidebar([
      { type: 'SET_ACTIVE_TAB', tab: 'Terminal' },
      { type: 'SET_TERMINAL_IDLE', idle: true },
    ]);
    expect(screen.getByText('Terminal').closest('button')?.querySelector('[data-idle-pulse="true"]')).toBeNull();
  });

  it('shows an idle pulse on Codex independently of Terminal\'s idle state', () => {
    renderSidebar([
      { type: 'SET_ACTIVE_TAB', tab: 'Dashboard' },
      { type: 'SET_CODEX_TERMINAL_IDLE', idle: true },
    ]);
    expect(screen.getByText('Codex').closest('button')?.querySelector('[data-idle-pulse="true"]')).not.toBeNull();
    expect(screen.getByText('Terminal').closest('button')?.querySelector('[data-idle-pulse="true"]')).toBeNull();
  });

  it('never shows an idle pulse on a sidebar item outside the Terminal/Codex scope', () => {
    renderSidebar([{ type: 'SET_ACTIVE_TAB', tab: 'Grid' }]);
    expect(screen.getByText('Dashboard').closest('button')?.querySelector('[data-idle-pulse="true"]')).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/components/layout/Sidebar.test.tsx`
Expected: FAIL on the idle-pulse assertions (`Sidebar.tsx` renders no `data-idle-pulse` attribute yet).

- [ ] **Step 4: Extend `Sidebar.tsx` with the idle-pulse indicator**

In `src/components/layout/Sidebar.tsx`, add a helper immediately after the `REACTOR_MINI_SIZE` constant (~line 11):

```ts
const IDLE_PULSE_IDS = new Set(['Terminal', 'Codex']);
```

Replace the `{SIDEBAR_IDS.map((label) => { ... })}` block (~lines 20-30) with:

```tsx
        {SIDEBAR_IDS.map((label) => {
          const on = label === state.activeTab;
          const idleFlag = label === 'Terminal' ? state.terminalIdle : label === 'Codex' ? state.codexTerminalIdle : false;
          const showIdlePulse = IDLE_PULSE_IDS.has(label) && idleFlag && !on;
          return (
            <Button key={label} onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: label })} style={navItemStyle(colors, on)}>
              <span style={navDotWrapStyle(on)}>
                <span style={navDotStyle(colors, on)} data-idle-pulse={showIdlePulse ? 'true' : undefined} />
              </span>
              <span style={{ font: `600 14px/1 ${fonts.ui}`, letterSpacing: 1 }}>{label}</span>
            </Button>
          );
        })}
```

Replace the `navDotStyle` function (~line 116) to apply the pulse animation when the dot carries `data-idle-pulse="true"`. Since `CSSProperties` can't key off the element's own `data-*` attribute, compute the style with the same `showIdlePulse` boolean instead of relying on the attribute selector — update the call site above and the function together:

```tsx
              <span style={navDotStyle(colors, on, showIdlePulse)} data-idle-pulse={showIdlePulse ? 'true' : undefined} />
```

```ts
function navDotStyle(colors: ColorPalette, on: boolean, idlePulse = false): CSSProperties {
  return {
    width: 7,
    height: 7,
    borderRadius: 2,
    background: idlePulse ? '#ffb020' : on ? colors.accentCyan : '#3d6572',
    animation: idlePulse ? 'idlePulse 1.6s ease-in-out infinite' : undefined,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**
Run: `npx vitest run src/components/layout/Sidebar.test.tsx`
Expected: PASS (5/5 tests).

- [ ] **Step 6: Run the full suite and typecheck**
Run: `npx tsc -b && npx vitest run`
Expected: clean compile, all tests passing (no regressions).

- [ ] **Step 7: Manual smoke test**
Run: `npm run electron:dev`, enable the Codex terminal toggle (Settings → Cross-Engine Verification card), navigate to Codex, let it sit idle for 3+ seconds, then switch to a different tab (e.g. Dashboard) and confirm the Codex sidebar dot pulses amber. Type something in the Codex terminal and confirm the pulse stops immediately. Repeat for Terminal.

- [ ] **Step 8: Commit**
```bash
git add src/styles/global.css src/components/layout/Sidebar.tsx src/components/layout/Sidebar.test.tsx
git commit -m "feat(idle-indicator): pulse the sidebar dot for an idle Terminal/Codex tab"
```

---

## Final Review

After all 3 tasks are complete and individually reviewed, run a whole-branch review per `superpowers:subagent-driven-development`'s process. Specifically verify:

1. **No interference with `PtyTerminal.tsx`/`PtyCodexTerminal.tsx`.** Confirm neither file was modified, and confirm (by reading the diff, not assuming) that registering a second `onData` listener via the new hooks does not affect what the existing xterm-feeding listener receives (both listeners should independently receive every data event).
2. **Idle state resets correctly across a pty exit and restart.** If a terminal's pty exits while idle, then a new one starts (e.g. re-enabling the Codex toggle), confirm the idle flag behaves sanely (starts false again from `useTerminalIdleSync`'s effect re-running, since `onData`'s first call after restart calls `markActive`).
3. **Timer cleanup.** Confirm no timer leak: unmounting `TerminalIdleSync`/`CodexTerminalIdleSync` (which in practice never happens, since they're mounted for the app's lifetime, but verify defensively) clears any pending timeout.
