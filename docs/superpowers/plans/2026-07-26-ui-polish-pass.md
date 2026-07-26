# UI Polish Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the floor on interaction polish and visual consistency across aether-os — real keyboard-accessible buttons, hover/focus states, a spacing scale, tooltips on icon-only actions, delete confirmations, and a light/dark theme toggle — applied via shared primitives rather than patched per-view.

**Architecture:** Two foundation tasks (spacing scale + hover-style hook; Button primitive) land first, then a light-theme-palette task (new `useColors()` hook, `Cfg.themeMode`, AppearanceCard toggle), then three sweep tasks apply the foundation across the 9 views identified in the design spec — grouped by how much shared context each group's changes need, not by file count.

**Tech Stack:** React 18, TypeScript (strict), inline-style convention (no CSS modules anywhere in this codebase — do not introduce one), Vitest for tests.

## Global Constraints

- No CSS modules or styled-components — every existing component uses inline `style={{...}}` objects and `CSSProperties`-typed style-object constants. Match this exactly; do not introduce a new styling mechanism.
- `npm test` and `npm run build` must be clean before every commit.
- Full spec: `docs/superpowers/specs/2026-07-26-ui-polish-pass-design.md` — read it for the "why" behind each decision below.
- Per the spec's Out of Scope: light theme only applies to views swept in this plan; other views keep the static dark import. Do not attempt a full-app theme migration.
- Per the spec: delete confirmations use native `confirm()` — no new confirmation UI component.
- Do not modify `electron/`, `src/state/reducer.ts`'s existing action handlers (only additive changes), or any file outside what each task lists.

---

### Task 1: Spacing scale + `useHoverStyle` hook

**Files:**
- Modify: `src/styles/tokens.ts` (add `space` export)
- Create: `src/components/shared/useHoverStyle.ts` + `useHoverStyle.test.ts`

**Interfaces:**
- Produces: `space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 }` (exported const, same file/export style as existing `colors`/`fonts`/`radii`).
- Produces: `useHoverStyle(base: CSSProperties, hover?: CSSProperties): { style: CSSProperties; onMouseEnter: () => void; onMouseLeave: () => void }` — a hook, not a pure function (it holds `useState` for hover-active). Default `hover` when the second arg is omitted: `{ filter: 'brightness(1.1)', borderColor: colors.activeBorder }`. Consumers spread `style` onto the element's existing style object as the LAST spread key (so hover overrides win) and pass through the two handlers as `onMouseEnter`/`onMouseLeave` props.

**Steps:**
- [ ] Add to `src/styles/tokens.ts`, after the existing `radii` export:
  ```ts
  export const space = {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
  } as const;
  ```
- [ ] Create `src/components/shared/useHoverStyle.ts`:
  ```ts
  import { useState, type CSSProperties } from 'react';
  import { colors } from '../../styles/tokens';

  const DEFAULT_HOVER: CSSProperties = {
    filter: 'brightness(1.1)',
    borderColor: colors.activeBorder,
  };

  export interface HoverStyleResult {
    style: CSSProperties;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
  }

  export function useHoverStyle(base: CSSProperties, hover: CSSProperties = DEFAULT_HOVER): HoverStyleResult {
    const [isHovering, setIsHovering] = useState(false);
    return {
      style: isHovering ? { ...base, ...hover } : base,
      onMouseEnter: () => setIsHovering(true),
      onMouseLeave: () => setIsHovering(false),
    };
  }
  ```
- [ ] Create `src/components/shared/useHoverStyle.test.ts` (uses `@testing-library/react`'s `renderHook`/`act` — check `package.json` for the exact installed testing-library packages and match the import style used by any existing hook test in this repo, e.g. `useViewportScale` has no test but is a hook; if no precedent exists, use `@testing-library/react`'s `renderHook` and `act` directly):
  ```ts
  import { describe, expect, it } from 'vitest';
  import { act, renderHook } from '@testing-library/react';
  import { useHoverStyle } from './useHoverStyle';

  describe('useHoverStyle', () => {
    it('returns base style when not hovering', () => {
      const { result } = renderHook(() => useHoverStyle({ color: 'red' }, { color: 'blue' }));
      expect(result.current.style).toEqual({ color: 'red' });
    });

    it('merges hover style over base on mouseEnter', () => {
      const { result } = renderHook(() => useHoverStyle({ color: 'red' }, { color: 'blue' }));
      act(() => result.current.onMouseEnter());
      expect(result.current.style).toEqual({ color: 'blue' });
    });

    it('reverts to base style on mouseLeave', () => {
      const { result } = renderHook(() => useHoverStyle({ color: 'red' }, { color: 'blue' }));
      act(() => result.current.onMouseEnter());
      act(() => result.current.onMouseLeave());
      expect(result.current.style).toEqual({ color: 'red' });
    });

    it('uses the default brightness/border hover when no override is passed', () => {
      const { result } = renderHook(() => useHoverStyle({ color: 'red' }));
      act(() => result.current.onMouseEnter());
      expect(result.current.style.filter).toBe('brightness(1.1)');
    });
  });
  ```
- [ ] If `@testing-library/react` is not already a devDependency, run `npm install -D @testing-library/react` and confirm its version doesn't conflict with the installed React 18 (check `package.json` first — do not add a second copy of a testing-library package under a different major version).
- [ ] Verify: `npx tsc -b` clean, `npx vitest run src/components/shared/useHoverStyle.test.ts src/styles` (or full `npx vitest run`) — all passing.
- [ ] Commit: `feat: add spacing scale and useHoverStyle hook`

### Task 2: `Button` primitive

**Files:**
- Create: `src/components/shared/Button.tsx`

**Interfaces:**
- Consumes: `useHoverStyle` from Task 1.
- Produces: `Button` component with props `{ onClick: () => void; style: CSSProperties; hoverStyle?: CSSProperties; title?: string; disabled?: boolean; children: ReactNode }` — drop-in replacement for `<div onClick={fn} style={s}>...</div>` / `<span onClick={fn} style={s}>...</span>` at sweep call sites. `style` is the exact same style object the call site already passes to its `div`/`span` today; `Button` does NOT impose its own visual defaults beyond stripping native `<button>` chrome.

**Steps:**
- [ ] Create `src/components/shared/Button.tsx`:
  ```tsx
  import type { CSSProperties, ReactNode } from 'react';
  import { useHoverStyle } from './useHoverStyle';

  interface ButtonProps {
    onClick: () => void;
    style: CSSProperties;
    hoverStyle?: CSSProperties;
    title?: string;
    disabled?: boolean;
    children: ReactNode;
  }

  const RESET_STYLE: CSSProperties = {
    background: 'none',
    border: 'none',
    font: 'inherit',
    color: 'inherit',
    padding: 0,
    margin: 0,
    cursor: 'pointer',
    textAlign: 'inherit',
  };

  export function Button({ onClick, style, hoverStyle, title, disabled, children }: ButtonProps) {
    const { style: hoveredStyle, onMouseEnter, onMouseLeave } = useHoverStyle({ ...RESET_STYLE, ...style }, hoverStyle && { ...RESET_STYLE, ...style, ...hoverStyle });
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
  Note: passing `hoverStyle && {...}` as the second arg to `useHoverStyle` means callers who don't pass `hoverStyle` get `useHoverStyle`'s own default (brightness+border) applied on top of their `style`; callers who DO pass `hoverStyle` get exactly `{...style, ...hoverStyle}` on hover instead of the default. This matches "default hover treatment when no override is passed" from the spec.
- [ ] Verify: `npx tsc -b` clean, `npm run build` clean (no test needed — this is a styling wrapper with no branching logic beyond what Task 1 already tests).
- [ ] Commit: `feat: add Button primitive`

### Task 3: Light theme palette + theme-mode toggle

**Files:**
- Modify: `src/styles/tokens.ts` (add `colorsLight`)
- Create: `src/components/shared/useColors.ts`
- Modify: `src/state/types.ts` (add `themeMode` to `Cfg`)
- Modify: `src/state/initialState.ts` (default `themeMode: 'dark'`)
- Modify: `src/components/terminal/commands.ts` (add `thememode` command)
- Modify: `src/components/settings/AppearanceCard.tsx` (add toggle)

**Interfaces:**
- Produces: `colorsLight` — same keys as `colors` in `tokens.ts`.
- Produces: `useColors(): typeof colors` — reads `state.cfg.themeMode` via `useAetherStore()` and returns `colorsLight` when `'light'`, else `colors`.
- Consumes (Task 4-6 sweeps use this): views swept in later tasks replace `import { colors } from '../../styles/tokens'` with `const colors = useColors();` inside the component body.

**Steps:**
- [ ] Read `src/components/settings/AppearanceCard.tsx` in full before editing, to match its existing dispatch pattern exactly (it dispatches `{ type: 'RUN_COMMAND', raw: 'theme <name>' }` today via `THEME_NAMES.map(...)`).
- [ ] Add `colorsLight` to `src/styles/tokens.ts`, after `colors`:
  ```ts
  export const colorsLight = {
    bgBase: '#eaf6fb',
    pageRadial: 'radial-gradient(1400px 900px at 60% -10%, #d8ecf4 0%, #eef8fc 55%, #f5fbfd 100%)',
    panelGradient: 'linear-gradient(180deg, rgba(255,255,255,.85), rgba(235,248,252,.85))',
    panelBorder: 'rgba(23,140,180,.24)',
    chromeBorder: 'rgba(23,140,180,.16)',
    chipBorder: 'rgba(23,140,180,.25)',
    activeBorder: 'rgba(10,120,160,.45)',
    textPrimary: '#04222c',
    textBody: '#0c3540',
    textSecondary: '#3c6a76',
    textMuted: '#6f97a1',
    textDim: '#84a6ae',
    accentCyan: '#0aa9c4',
    accentCyanDeep: '#0c7f95',
    accentCyanSoft: '#3fb6cc',
    success: '#1f9d6c',
    warn: '#b8801f',
    danger: '#c73f4e',
    dangerSoft: '#e08a92',
    agentHues: ['#0aa9c4', '#4a7fd8', '#1fb894', '#3fb6cc', '#5a97d8'] as const,
  } as const;
  ```
- [ ] Create `src/components/shared/useColors.ts`:
  ```ts
  import { colors, colorsLight } from '../../styles/tokens';
  import { useAetherStore } from '../../state/store';

  export function useColors(): typeof colors {
    const { state } = useAetherStore();
    return state.cfg.themeMode === 'light' ? colorsLight : colors;
  }
  ```
- [ ] In `src/state/types.ts`, add `themeMode: 'dark' | 'light';` to the `Cfg` interface (alongside the existing `theme: ThemeName;` field).
- [ ] In `src/state/initialState.ts`, find the object literal that satisfies `Cfg` and add `themeMode: 'dark',` alongside the existing `theme: 'cyan',` (or equivalent) field.
- [ ] In `src/components/terminal/commands.ts`, add a new case to the `runCommand` switch, modeled directly on the existing `'theme'` case:
  ```ts
    case 'thememode': {
      const mode = (args[0] || '').toLowerCase();
      if (mode !== 'dark' && mode !== 'light') {
        out.push(line('✗ usage: thememode dark|light', BAD));
        return { kind: 'append', lines: out };
      }
      out.push(line(`✓ theme mode set to ${mode}`, GOOD));
      return { kind: 'append', lines: out, patch: { cfg: { ...state.cfg, themeMode: mode } } };
    }
  ```
  Also add `'thememode <dark|light>  switch light/dark palette'` to the `help` case's line list, matching the existing `renderer`/`theme` help lines' format.
- [ ] In `src/components/settings/AppearanceCard.tsx`, add a light/dark toggle row below the existing RENDERER row, following the exact same `.map(...)`-over-options + `dispatch({ type: 'RUN_COMMAND', raw: ... })` pattern used for `THEME_NAMES`/`RENDERER_WORDS`:
  ```tsx
        <div style={{ marginTop: 16 }}>
          <div style={labelStyle}>MODE</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            {(['dark', 'light'] as const).map((mode) => (
              <span
                key={mode}
                onClick={() => dispatch({ type: 'RUN_COMMAND', raw: `thememode ${mode}` })}
                style={toggleStyle(cfg.themeMode === mode)}
              >
                {mode}
              </span>
            ))}
          </div>
        </div>
  ```
  (Insert this block using whatever `toggleStyle` helper the RENDERER row already uses — do not define a new one.)
- [ ] Verify: `npx tsc -b` clean (this will surface any other file constructing a `Cfg` literal without `themeMode` — fix each one found by adding `themeMode: 'dark'`), `npx vitest run` clean, `npm run build` clean.
- [ ] Commit: `feat: add light theme palette and mode toggle`

### Task 4: Sweep — roster/list views (Agents, Memory, Projects)

**Files:**
- Modify: `src/components/agents/AgentRosterCard.tsx`
- Modify: `src/components/memory/MemoryRosterCard.tsx`
- Modify: `src/components/projects/ProjectRosterCard.tsx`

**Interfaces:**
- Consumes: `Button` (Task 2), `useColors` (Task 3).

**Steps:**
- [ ] In each of the three files: replace `import { colors } from '../../styles/tokens'` with `import { useColors } from '../shared/useColors';` and, at the top of the component function body, add `const colors = useColors();` — this makes every existing `colors.*` reference in the file automatically theme-aware with zero other changes, since the variable name is unchanged.
- [ ] In each file, find the row/item click handler (the `<div onClick={() => onSelect(...)} style={rowStyle(...)}>` pattern, or equivalent — read each file first to find its exact shape) and replace the outer `div`/`span` with `Button`, passing the existing `style` object through unchanged and adding `title` if the row currently has no visible label beyond an icon (check each file — if every row already shows a text name, no `title` is needed there; add `title={<item's name>}` only where the row is icon-only or truncates).
- [ ] Import `Button` from `'../shared/Button'` in each file.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean (existing tests for these views, if any, must still pass — check for `AgentRosterCard.test.tsx` etc. and run them specifically if found), `npm run build` clean.
- [ ] Commit: `feat: sweep roster views with Button primitive and theme-aware colors`

### Task 5: Sweep — action-heavy views (Files, Chat channels, Memory detail)

**Files:**
- Modify: `src/components/files/FilesView.tsx`
- Modify: `src/components/chat/ChannelRail.tsx`
- Modify: `src/components/memory/MemoryDetailCard.tsx`

**Interfaces:**
- Consumes: `Button` (Task 2), `useColors` (Task 3).

**Steps:**
- [ ] `FilesView.tsx`:
  - Add `const colors = useColors();` per Task 4's pattern (`colors` import → `useColors` hook).
  - Add a `const [loading, setLoading] = useState(false);` and set it `true`/`false` around the `refresh` function's `await` (`setLoading(true)` before the `attachments.list()` call, `setLoading(false)` in a `finally`), then render a brief `{loading && <div style={...}>loading…</div>}` matching the existing empty-state text styling in this file (read the file for its current empty-state JSX and mirror its style object).
  - Replace `<span onClick={addFile} style={addButtonStyle}>+ ADD FILE</span>` with `<Button onClick={addFile} style={addButtonStyle}>+ ADD FILE</Button>`.
  - Replace `<span onClick={() => removeFile(f.name)} style={deleteStyle}>×</span>` with:
    ```tsx
    <Button
      onClick={() => {
        if (confirm(`Delete "${f.name}"? This cannot be undone.`)) removeFile(f.name);
      }}
      style={deleteStyle}
      title={`Delete ${f.name}`}
    >
      ×
    </Button>
    ```
  - Leave the `openFile` click targets (`thumbStyle`/the flex-1 name div) as plain elements — they're navigation, not destructive or icon-only, out of this task's scope per the spec's item list.
- [ ] `ChannelRail.tsx`:
  - Add `const colors = useColors();` per the same pattern.
  - Replace `<span onClick={() => setPickerOpen((o) => !o)} style={newButtonStyle}>` with `<Button onClick={() => setPickerOpen((o) => !o)} style={newButtonStyle}>` (closing tag `</Button>` too).
  - Add outside-click/Escape close: add a `useRef<HTMLDivElement>(null)` on the picker's wrapping element and a `useEffect` (mirroring the standard pattern):
    ```tsx
    useEffect(() => {
      if (!pickerOpen) return;
      const onDocClick = (e: MouseEvent) => {
        if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
      };
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setPickerOpen(false);
      };
      document.addEventListener('mousedown', onDocClick);
      document.addEventListener('keydown', onKeyDown);
      return () => {
        document.removeEventListener('mousedown', onDocClick);
        document.removeEventListener('keydown', onKeyDown);
      };
    }, [pickerOpen]);
    ```
    Attach `ref={pickerRef}` to whichever element wraps both the "+ NEW" button and the dropdown list (read the file to find the correct wrapping element — likely the parent of the `{pickerOpen && (...)}` block).
  - Find the channel-remove `onClick={(e) => { ...; onRemoveDispatchChannel(c.toolUseId!); }}` handler (around line 73-75) and wrap the `onRemoveDispatchChannel` call in a confirm guard: `if (confirm('Remove this dispatch channel?')) onRemoveDispatchChannel(c.toolUseId!);` — keep any existing `e.stopPropagation()`/preventDefault logic in that handler exactly as-is, only adding the confirm around the removal call itself. Convert this element to `Button` if it isn't already a clickable icon without one (read the file to check its current tag).
- [ ] `MemoryDetailCard.tsx`:
  - Add `const colors = useColors();` per the same pattern.
  - Change the pin/unpin element (`onClick={() => dispatch({ type: 'TOGGLE_MEMORY_PIN', id: memory.id })}`, currently `style={memory.pinned ? dangerActionStyle : secondaryActionStyle}`) to use `secondaryActionStyle` in BOTH branches — unpinning is not destructive, per the spec: `style={secondaryActionStyle}` unconditionally (remove the ternary, remove now-unused `dangerActionStyle` only if nothing else in the file references it — grep the file first).
  - Convert this element to `Button`, adding `title={memory.pinned ? 'Unpin this memory' : 'Pin this memory'}`.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean.
- [ ] Commit: `feat: sweep Files/Chat/Memory-detail views with confirmations and tooltips`

### Task 6: Sweep — remaining views (Uplinks, Settings, digests, TopBar)

**Files:**
- Modify: `src/components/uplinks/UplinksView.tsx`
- Modify: `src/components/settings/*.tsx` (whichever card files contain clickable rows — read `src/components/settings/` directory listing first; likely `SettingsView.tsx` plus any card subcomponents with `onClick` rows, excluding `AppearanceCard.tsx` which Task 3 already touched)
- Modify: `src/components/dashboard/ProjectsDigest.tsx`
- Modify: `src/components/dashboard/SystemsCard.tsx` (or wherever the "view all" links actually live — confirm exact file via grep for `'view all'`-style text before editing)
- Modify: `src/components/layout/TopBar.tsx`

**Interfaces:**
- Consumes: `Button` (Task 2), `useColors` (Task 3).

**Steps:**
- [ ] `UplinksView.tsx`:
  - Add `const colors = useColors();` per the established pattern.
  - Convert connect/disconnect buttons and pill toggles to `Button`.
  - Find the provider/runtime row rendering and add an offline visual treatment: for rows where the provider is offline/disconnected, apply `opacity: 0.55` (or the file's existing dim convention if one already exists for a similar disabled state — check before introducing a new value) to the row's style object, conditionally based on whatever field the file already uses to determine online/offline state (read the file to find the exact field name — do not guess at a field that doesn't exist).
  - Where `marginTop: 24` (and similar ad hoc spacing literals matching `space.*` values) appears in this file, replace with the corresponding `space.*` reference (import `space` from `'../../styles/tokens'`) — only replace literals that exactly match a `space` value (4/8/12/16/24); leave any other literal untouched.
- [ ] Settings card files: for each file in `src/components/settings/` (other than `AppearanceCard.tsx`) that has an `onClick` on a `div`/`span`, add `const colors = useColors();` and convert those elements to `Button`, following the exact same pattern as Task 4.
- [ ] `ProjectsDigest.tsx` / wherever "view all" text lives: find the `<span onClick={...}>` (or equivalent) rendering "view all" (or similar) text, add a trailing `›` glyph and wrap in `Button`, with a `hoverStyle` prop of `{ textDecoration: 'underline' }` (passed explicitly, since this is a text link, not the default brightness/border treatment — per Task 2's `Button` interface, passing `hoverStyle` overrides the default).
- [ ] `TopBar.tsx`: find `windowControlBtnStyle` (added in Phase 6, Task 4) and the CLOSE button's specific JSX usage. Give the CLOSE button its own `hoverStyle` (if it isn't already using the `Button` primitive from Phase 6 — check first, since Phase 6 may have used a plain styled element) of `{ background: colors.danger, color: colors.textPrimary }` — if `TopBar.tsx` isn't yet using `useColors()` (it likely still imports the static `colors` per Phase 6, which predates this plan), add `const colors = useColors();` here too, replacing the static import, consistent with every other file in this sweep.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean.
- [ ] Commit: `feat: sweep Uplinks/Settings/dashboard/TopBar views with Button and theme-aware colors`

---

After all six tasks: whole-branch review, then a PROGRESS.md entry in the established format (mirroring the Phase 6 entry's structure), noting the partial-theme-coverage caveat from the spec's Out of Scope section explicitly so it isn't later mistaken for a bug.
