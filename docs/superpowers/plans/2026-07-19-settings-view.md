# Settings View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `Settings` tab's `null` placeholder with a real Settings view — the first-ever UI for six `Cfg` fields (`pulseMode`, `glow`, `glowFx`, `capM`, `alarm`, `autoThrottle`, `sound`) that currently have no way to change them, plus a single authoritative screen showing all ten `Cfg` fields (reusing existing paths for `opMode`/`theme`/`renderer`).

**Architecture:** A two-column, three-card layout (no roster+detail — Settings is a form, not a list): `OperatingModeCard` (reuses `TopBar.tsx`'s existing PLAN/EDITS/AUTO toggle and `SET_OP_MODE` action) and `BudgetAlertsCard` (monthly cap, alarm threshold, auto-throttle, sound) stack in the left column; the taller `AppearanceCard` (theme, renderer, reactor pulse, glow intensity, glow effects) fills the right column. One new reducer action, `UPDATE_CFG`, patches any subset of `Cfg` in one dispatch — chosen over seven near-identical dedicated actions since this is a multi-field settings form, not a single-purpose mutation. `theme`/`renderer` continue to dispatch the existing `RUN_COMMAND` → `commands.ts` path (same "dispatch a command string from a UI element" pattern `ReactorStatusCard`/`AgentDetailCard` already use for spawn/kill/sweep) — no duplicated parsing logic. A tiny new `settingsMath.ts` provides the one genuinely new derivation: mapping `cfg.renderer`'s internal key back to the terminal's display word, so `AppearanceCard` can show which renderer option is active.

**Tech Stack:** Same as the existing project — React 18, Vite 5, TypeScript 5 (strict), Vitest. No new dependencies.

## Global Constraints

- Project root: `C:\Users\Matt\projects\aether-os` (already scaffolded; this plan extends it).
- Full design spec: `docs/superpowers/specs/2026-07-19-settings-view-design.md` (commit `18654bb`) — this plan implements it task-by-task; consult it for the "why" behind any decision below.
- **Scope for this plan:** `src/components/settings/` (new: `SettingsView.tsx`, `OperatingModeCard.tsx`, `AppearanceCard.tsx`, `BudgetAlertsCard.tsx`, `settingsMath.ts` + test), `src/state/reducer.ts` / `reducer.test.ts` (modified — one new action), `src/viewRegistry.ts` / `viewRegistry.test.ts` (modified — flip `Settings`'s component from `null`).
- **`opMode` reuses the existing `SET_OP_MODE` action verbatim — no new action for it.** `theme`/`renderer` reuse the existing `RUN_COMMAND` → `commands.ts` `theme`/`renderer` commands verbatim, dispatched as `{ type: 'RUN_COMMAND', raw: 'theme <name>' }` / `{ type: 'RUN_COMMAND', raw: 'renderer <word>' }` — this plan does not touch `commands.ts`, `TopBar.tsx`, or add any new parsing logic for these three fields.
- **`UPDATE_CFG` is the ONLY new reducer action, and it covers all seven remaining fields** (`pulseMode`, `glow`, `glowFx`, `capM`, `alarm`, `autoThrottle`, `sound`). Do not add per-field actions (`SET_GLOW`, `SET_ALARM`, etc.) — a settings-form screen editing many fields of one object is exactly the case a generic `{ type: 'UPDATE_CFG'; patch: Partial<Cfg> }` fits, deliberately departing from this app's usual one-action-per-concern precedent (`SELECT_AGENT`, `SET_OP_MODE`) for that reason.
- **No persistence changes anywhere in this plan.** `cfg` (the whole object) is already in `persistence.ts`'s `savePersisted` whitelist (`cfg: state.cfg`, present since the app's original scaffold) — verify this is still true in Task 1, but do not add anything.
- **Numeric ranges are enforced by the `<input type="range">` elements' own `min`/`max`/`step` attributes, not by reducer-side clamping:** glow `min={0} max={140} step={10}`; monthly cap `min={0.5} max={10} step={0.5}`; alarm threshold `min={50} max={200} step={10}`.
- **No real audio system is added for `sound`.** The toggle changes `cfg.sound` truthfully (already displayed as ON/OFF by the pre-existing, unmodified `SystemsCard.tsx`) but makes nothing audible — that's out of scope, not a bug.
- **Settings is sidebar-only, not top-bar** — `viewRegistry.ts`'s existing entry is `{ id: 'Settings', inTopBar: false, inSidebar: true, component: null }`; this plan only flips `component`, it does not change `inTopBar`/`inSidebar`.
- Match established visual/style conventions exactly: inline `CSSProperties` consts, `colors`/`fonts` tokens from `src/styles/tokens.ts`, `useAetherStore()`. Small per-file style-helper duplication (e.g. a local `toggleStyle` function repeated with minor size differences across `AppearanceCard.tsx`/`BudgetAlertsCard.tsx`) matches this codebase's existing convention (documented precedent: Projects view's plan explicitly calls this out as acceptable) — there is no shared style-helpers module to import from instead.
- New pure-logic module (`settingsMath.ts`) and the reducer addition get Vitest coverage. Presentational components (`OperatingModeCard`, `AppearanceCard`, `BudgetAlertsCard`, `SettingsView`) have no new testable logic of their own and are verified via typecheck + dev server, matching the precedent set by every prior view's cards.
- Run `npm test`, `npx tsc -b`, and `npm run build` clean before every commit. Baseline going into this plan: **248 passing tests across 24 files** (confirmed via `npm test` immediately before this plan was written).

---

## File Structure

```
aether-os/
  src/
    components/
      settings/
        SettingsView.tsx           NEW — two-column composition, mounted by the view registry
        OperatingModeCard.tsx      NEW — PLAN/EDITS/AUTO toggle, mirrors TopBar.tsx exactly
        AppearanceCard.tsx         NEW — theme swatches, renderer toggle, pulse toggle, glow slider/toggle
        BudgetAlertsCard.tsx       NEW — monthly cap/alarm sliders, auto-throttle/sound toggles
        settingsMath.ts            NEW — pure derivation (renderer key->word), tested
        settingsMath.test.ts       NEW
    state/
      reducer.ts                   MODIFIED — UPDATE_CFG action
      reducer.test.ts              MODIFIED — test for UPDATE_CFG
    viewRegistry.ts                 MODIFIED — flip Settings' component from null to SettingsView
    viewRegistry.test.ts            MODIFIED — test that Settings now resolves
```

---

### Task 1: State — `UPDATE_CFG` action

Adds the one new reducer action this view needs. Verifies (does not modify) that `cfg` is already fully persisted.

**Files:**
- Modify: `src/state/reducer.ts`
- Modify: `src/state/reducer.test.ts`

**Interfaces:**
- Consumes: `Cfg` type from `./types` (already defined — `opMode`, `renderer`, `pulseMode`, `theme`, `glow`, `glowFx`, `capM`, `alarm`, `autoThrottle`, `sound`).
- Produces: `{ type: 'UPDATE_CFG'; patch: Partial<Cfg> }` added to the `Action` union — consumed by Task 3's `AppearanceCard` and Task 4's `BudgetAlertsCard`.

- [ ] **Step 1: Verify `cfg` is already in the persistence whitelist (no change needed)**

Run: `grep -n "cfg" src/state/persistence.ts`
Expected output includes a line `cfg: state.cfg,` inside `savePersisted`. If this line is missing, STOP and report BLOCKED — the plan's Global Constraints assume this is already true; do not add it yourself without re-confirming with the controller, since that would mean the spec's research was wrong.

- [ ] **Step 2: Write the failing test**

Append to `src/state/reducer.test.ts` (inside the existing `describe('reducer', ...)` block, right after the `'REACTIVATE_AGENT on a name not in idleList is a no-op'` test, before that block's closing `});`):

```ts
  it('UPDATE_CFG merges a partial patch into cfg, leaving other cfg fields untouched', () => {
    const next = reducer(initialState, { type: 'UPDATE_CFG', patch: { glow: 100, sound: true } });
    expect(next.cfg.glow).toBe(100);
    expect(next.cfg.sound).toBe(true);
    expect(next.cfg.theme).toBe(initialState.cfg.theme);
    expect(next.cfg.opMode).toBe(initialState.cfg.opMode);
    expect(next.cfg.alarm).toBe(initialState.cfg.alarm);
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- reducer`
Expected: FAIL — `UPDATE_CFG` isn't a valid `Action` yet.

- [ ] **Step 4: Add `Cfg` to the type import in `src/state/reducer.ts`**

Change:

```ts
import type { Approval, AetherState, MemoryStub, OpMode } from './types';
```

to:

```ts
import type { Approval, AetherState, Cfg, MemoryStub, OpMode } from './types';
```

- [ ] **Step 5: Add the action to the `Action` union**

Change the union's last member:

```ts
  | { type: 'SELECT_MEMORY'; id: number }
  | { type: 'TOGGLE_MEMORY_PIN'; id: number };
```

to:

```ts
  | { type: 'SELECT_MEMORY'; id: number }
  | { type: 'TOGGLE_MEMORY_PIN'; id: number }
  | { type: 'UPDATE_CFG'; patch: Partial<Cfg> };
```

- [ ] **Step 6: Add the `switch` case**

In `src/state/reducer.ts`, right after the existing `case 'SET_OP_MODE':` case (which ends with the `unread: state.unread + 1, };` closing brace):

```ts
    case 'SET_OP_MODE':
      return {
        ...state,
        cfg: { ...state.cfg, opMode: action.mode },
        notifs: [{ t: nowShort(), m: `Operating mode set to ${action.mode}`, c: '#7fd8ef' }, ...state.notifs].slice(0, 12),
        unread: state.unread + 1,
      };

    case 'UPDATE_CFG':
      return { ...state, cfg: { ...state.cfg, ...action.patch } };
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test -- reducer`
Expected: PASS.

- [ ] **Step 8: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (249 total: 248 + 1 new), 0 type errors.

- [ ] **Step 9: Commit**

```bash
git add src/state/reducer.ts src/state/reducer.test.ts
git commit -m "feat: add UPDATE_CFG reducer action for the Settings view"
```

---

### Task 2: Settings derivation math (`settingsMath.ts`)

The one genuinely new pure logic this view needs: mapping `cfg.renderer`'s internal key back to the terminal's display word.

**Files:**
- Create: `src/components/settings/settingsMath.ts`
- Test: `src/components/settings/settingsMath.test.ts`

**Interfaces:**
- Consumes: `RendererMode` type from `../../state/types`.
- Produces: `RENDERER_KEY_TO_WORD: Record<RendererMode, string>`, `rendererKeyToWord(renderer: RendererMode): string` — consumed by Task 3's `AppearanceCard`.

- [ ] **Step 1: Write the failing tests**

`src/components/settings/settingsMath.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RENDERER_KEY_TO_WORD, rendererKeyToWord } from './settingsMath';

describe('rendererKeyToWord', () => {
  it('maps the internal "classic" key to the terminal word "nebula"', () => {
    expect(rendererKeyToWord('classic')).toBe('nebula');
  });

  it('is an identity mapping for volumetric and warp', () => {
    expect(rendererKeyToWord('volumetric')).toBe('volumetric');
    expect(rendererKeyToWord('warp')).toBe('warp');
  });

  it('RENDERER_KEY_TO_WORD covers exactly the three RendererMode keys', () => {
    expect(Object.keys(RENDERER_KEY_TO_WORD).sort()).toEqual(['classic', 'volumetric', 'warp']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- settingsMath`
Expected: FAIL — `settingsMath.ts` doesn't exist yet.

- [ ] **Step 3: Implement `src/components/settings/settingsMath.ts`**

```ts
import type { RendererMode } from '../../state/types';

export const RENDERER_KEY_TO_WORD: Record<RendererMode, string> = {
  classic: 'nebula',
  volumetric: 'volumetric',
  warp: 'warp',
};

export function rendererKeyToWord(renderer: RendererMode): string {
  return RENDERER_KEY_TO_WORD[renderer];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- settingsMath`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (252 total: 249 + 3 new), 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/settingsMath.ts src/components/settings/settingsMath.test.ts
git commit -m "feat: add Settings view derivation math (renderer key-to-word mapping)"
```

---

### Task 3: Operating Mode card

Left column, top. Reuses `TopBar.tsx`'s exact PLAN/EDITS/AUTO data and the existing `SET_OP_MODE` action — no new state.

**Files:**
- Create: `src/components/settings/OperatingModeCard.tsx`

**Interfaces:**
- Consumes: `useAetherStore()`; `colors`, `fonts` from `../../styles/tokens`; `OpMode` type from `../../state/types`.
- Produces: `OperatingModeCard()` — mounted by Task 6's `SettingsView`.

No new unit-testable logic — verify via typecheck.

- [ ] **Step 1: Implement `src/components/settings/OperatingModeCard.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { OpMode } from '../../state/types';

const OP_MODES: { key: OpMode; label: string; tip: string }[] = [
  { key: 'PLAN', label: '◇ PLAN', tip: 'Brainstorm & plan — throttled burn, everything queued for approval' },
  { key: 'EDITS', label: '✎ EDITS', tip: 'Accept edits — agents work, risky actions queue for approval' },
  { key: 'AUTO', label: '⚡ AUTO', tip: 'Full auto — low/med actions auto-approved, max burn' },
];

export function OperatingModeCard() {
  const { state, dispatch } = useAetherStore();

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>OPERATING MODE</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        {OP_MODES.map((om) => {
          const on = state.cfg.opMode === om.key;
          return (
            <span key={om.key} title={om.tip} onClick={() => dispatch({ type: 'SET_OP_MODE', mode: om.key })} style={opModeStyle(on, om.key)}>
              {om.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  padding: 15,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};
const titleStyle: CSSProperties = { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
function opModeStyle(on: boolean, key: OpMode): CSSProperties {
  return {
    flex: 1,
    textAlign: 'center',
    cursor: 'pointer',
    padding: '10px 0',
    borderRadius: 8,
    font: `600 11px/1 ${fonts.ui}`,
    letterSpacing: 1.5,
    color: on ? (key === 'AUTO' ? '#1a1204' : '#04202b') : colors.textMuted,
    background: on ? (key === 'AUTO' ? 'linear-gradient(180deg,#f5c66b,#d9a13f)' : 'linear-gradient(180deg,#7ef0ff,#17b8d8)') : 'rgba(10,32,43,.6)',
    boxShadow: on ? (key === 'AUTO' ? '0 0 12px rgba(245,198,107,.45)' : '0 0 12px rgba(95,220,255,.4)') : undefined,
    border: on ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/settings/OperatingModeCard.tsx
git commit -m "feat: build the Settings view operating mode card"
```

---

### Task 4: Appearance card

Right column. Theme swatches, renderer toggle, reactor pulse toggle, glow intensity slider, glow effects toggle. `theme`/`renderer` dispatch `RUN_COMMAND`; the rest dispatch `UPDATE_CFG`.

**Files:**
- Create: `src/components/settings/AppearanceCard.tsx`

**Interfaces:**
- Consumes: `useAetherStore()`; `THEME_NAMES`, `RENDERER_WORDS` from `../terminal/commands` (already exported); `rendererKeyToWord` from `./settingsMath` (built in Task 2); `colors`, `fonts` from `../../styles/tokens`.
- Produces: `AppearanceCard()` — mounted by Task 6's `SettingsView`.

No new unit-testable logic (the one derivation it uses is already tested in Task 2) — verify via typecheck.

- [ ] **Step 1: Implement `src/components/settings/AppearanceCard.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { THEME_NAMES, RENDERER_WORDS } from '../terminal/commands';
import { rendererKeyToWord } from './settingsMath';

const THEME_HEX: Record<string, string> = {
  cyan: '#7ef0ff',
  blue: '#5fa8ff',
  teal: '#5fffe0',
  violet: '#c58bff',
  amber: '#f5c66b',
  red: '#ff6b7a',
};

export function AppearanceCard() {
  const { state, dispatch } = useAetherStore();
  const { cfg } = state;
  const activeRendererWord = rendererKeyToWord(cfg.renderer);

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>APPEARANCE</div>

      <div style={{ marginTop: 16 }}>
        <div style={labelStyle}>THEME</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {THEME_NAMES.map((name) => (
            <span
              key={name}
              title={name}
              onClick={() => dispatch({ type: 'RUN_COMMAND', raw: `theme ${name}` })}
              style={swatchStyle(THEME_HEX[name], cfg.theme === name)}
            />
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={labelStyle}>RENDERER</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          {RENDERER_WORDS.map((word) => (
            <span key={word} onClick={() => dispatch({ type: 'RUN_COMMAND', raw: `renderer ${word}` })} style={toggleStyle(activeRendererWord === word)}>
              {word}
            </span>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={labelStyle}>REACTOR PULSE</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          {(['live', 'ambient'] as const).map((mode) => (
            <span key={mode} onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { pulseMode: mode } })} style={toggleStyle(cfg.pulseMode === mode)}>
              {mode}
            </span>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div style={labelStyle}>CORE GLOW INTENSITY</div>
          <span style={valueStyle}>{cfg.glow}</span>
        </div>
        <input
          type="range"
          min={0}
          max={140}
          step={10}
          value={cfg.glow}
          onChange={(e) => dispatch({ type: 'UPDATE_CFG', patch: { glow: Number(e.target.value) } })}
          style={sliderStyle}
        />
      </div>

      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle}>GLOW EFFECTS</div>
        <span onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { glowFx: !cfg.glowFx } })} style={pillToggleStyle(cfg.glowFx)}>
          {cfg.glowFx ? 'ON' : 'OFF'}
        </span>
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  padding: 18,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
};
const titleStyle: CSSProperties = { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const labelStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
const valueStyle: CSSProperties = { font: `700 11px/1 ${fonts.mono}`, color: colors.textBody };
function swatchStyle(hex: string, on: boolean): CSSProperties {
  return {
    width: 26,
    height: 26,
    borderRadius: '50%',
    cursor: 'pointer',
    background: hex,
    boxShadow: on ? `0 0 0 2px ${colors.bgBase}, 0 0 0 4px ${hex}` : `0 0 8px ${hex}`,
  };
}
function toggleStyle(on: boolean): CSSProperties {
  return {
    flex: 1,
    textAlign: 'center',
    cursor: 'pointer',
    padding: '7px 0',
    borderRadius: 7,
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: on ? '#04202b' : colors.textMuted,
    background: on ? 'linear-gradient(180deg,#7ef0ff,#17b8d8)' : 'rgba(10,32,43,.6)',
    boxShadow: on ? '0 0 10px rgba(95,220,255,.4)' : undefined,
    border: on ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
function pillToggleStyle(on: boolean): CSSProperties {
  return {
    minWidth: 52,
    textAlign: 'center',
    cursor: 'pointer',
    padding: '6px 12px',
    borderRadius: 7,
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: on ? '#04202b' : colors.textMuted,
    background: on ? 'linear-gradient(180deg,#7ef0ff,#17b8d8)' : 'rgba(10,32,43,.6)',
    boxShadow: on ? '0 0 10px rgba(95,220,255,.4)' : undefined,
    border: on ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
const sliderStyle: CSSProperties = { width: '100%', marginTop: 8, accentColor: colors.accentCyanDeep };
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/settings/AppearanceCard.tsx
git commit -m "feat: build the Settings view appearance card (theme, renderer, pulse, glow)"
```

---

### Task 5: Budget & Alerts card

Left column, bottom. Monthly cap and alarm threshold sliders, auto-throttle and sound toggles — all four dispatch `UPDATE_CFG`.

**Files:**
- Create: `src/components/settings/BudgetAlertsCard.tsx`

**Interfaces:**
- Consumes: `useAetherStore()`; `colors`, `fonts` from `../../styles/tokens`.
- Produces: `BudgetAlertsCard()` — mounted by Task 6's `SettingsView`.

No new unit-testable logic — verify via typecheck.

- [ ] **Step 1: Implement `src/components/settings/BudgetAlertsCard.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function BudgetAlertsCard() {
  const { state, dispatch } = useAetherStore();
  const { cfg } = state;

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>BUDGET &amp; ALERTS</div>

      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div style={labelStyle}>MONTHLY CAP</div>
          <span style={valueStyle}>{cfg.capM.toFixed(1)}M tokens</span>
        </div>
        <input
          type="range"
          min={0.5}
          max={10}
          step={0.5}
          value={cfg.capM}
          onChange={(e) => dispatch({ type: 'UPDATE_CFG', patch: { capM: Number(e.target.value) } })}
          style={sliderStyle}
        />
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div style={labelStyle}>ALARM THRESHOLD</div>
          <span style={valueStyle}>{cfg.alarm}K tok/min</span>
        </div>
        <input
          type="range"
          min={50}
          max={200}
          step={10}
          value={cfg.alarm}
          onChange={(e) => dispatch({ type: 'UPDATE_CFG', patch: { alarm: Number(e.target.value) } })}
          style={sliderStyle}
        />
      </div>

      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle}>AUTO-THROTTLE</div>
        <span onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { autoThrottle: !cfg.autoThrottle } })} style={toggleStyle(cfg.autoThrottle)}>
          {cfg.autoThrottle ? 'ON' : 'OFF'}
        </span>
      </div>

      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle}>SOUND</div>
        <span onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { sound: !cfg.sound } })} style={toggleStyle(cfg.sound)}>
          {cfg.sound ? 'ON' : 'OFF'}
        </span>
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  padding: 15,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};
const titleStyle: CSSProperties = { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const labelStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
const valueStyle: CSSProperties = { font: `700 11px/1 ${fonts.mono}`, color: colors.textBody };
const sliderStyle: CSSProperties = { width: '100%', marginTop: 8, accentColor: colors.accentCyanDeep };
function toggleStyle(on: boolean): CSSProperties {
  return {
    minWidth: 52,
    textAlign: 'center',
    cursor: 'pointer',
    padding: '6px 12px',
    borderRadius: 7,
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: on ? '#04202b' : colors.textMuted,
    background: on ? 'linear-gradient(180deg,#7ef0ff,#17b8d8)' : 'rgba(10,32,43,.6)',
    boxShadow: on ? '0 0 10px rgba(95,220,255,.4)' : undefined,
    border: on ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/settings/BudgetAlertsCard.tsx
git commit -m "feat: build the Settings view budget and alerts card"
```

---

### Task 6: Settings view composition + registry wiring

Composes the three cards into the two-column layout, then flips the `Settings` view-registry entry from `null` to the real component.

**Files:**
- Create: `src/components/settings/SettingsView.tsx`
- Modify: `src/viewRegistry.ts`
- Modify: `src/viewRegistry.test.ts`

**Interfaces:**
- Consumes: `OperatingModeCard`, `AppearanceCard`, `BudgetAlertsCard`.
- Produces: `SettingsView()` — registered in `viewRegistry.ts`, completing the Settings slice.

- [ ] **Step 1: Implement `src/components/settings/SettingsView.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { OperatingModeCard } from './OperatingModeCard';
import { AppearanceCard } from './AppearanceCard';
import { BudgetAlertsCard } from './BudgetAlertsCard';

export function SettingsView() {
  return (
    <div style={rootStyle}>
      <div style={columnStyle}>
        <OperatingModeCard />
        <BudgetAlertsCard />
      </div>
      <AppearanceCard />
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
const columnStyle: CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 };
```

- [ ] **Step 2: Wire Settings into the registry**

In `src/viewRegistry.ts`, add the import:

```ts
import { SettingsView } from './components/settings/SettingsView';
```

Change:

```ts
  { id: 'Settings', inTopBar: false, inSidebar: true, component: null },
```

to:

```ts
  { id: 'Settings', inTopBar: false, inSidebar: true, component: SettingsView },
```

Do not change `inTopBar`/`inSidebar` — Settings stays sidebar-only.

- [ ] **Step 3: Update `src/viewRegistry.test.ts`**

Add a new test confirming Settings now resolves (after the existing `'getViewComponent resolves Analytics now that it is built'` test):

```ts
  it('getViewComponent resolves Settings now that it is built', () => {
    expect(getViewComponent('Settings')).not.toBeNull();
  });
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (253 total: 252 + 1 new), 0 type errors, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/SettingsView.tsx src/viewRegistry.ts src/viewRegistry.test.ts
git commit -m "feat: compose the Settings view and wire it into the view registry"
```

---

### Task 7: Final integration QA

**Files:** none (verification-only task).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (253/253), 0 type errors, build succeeds.

- [ ] **Step 2: Manual QA checklist**

Run: `npm run dev`, open the browser. Settings is sidebar-only — use the left sidebar nav, not the top bar, to reach it.

- [ ] Clicking the sidebar's "Settings" entry shows the two-column layout: Operating Mode + Budget & Alerts stacked on the left, Appearance on the right.
- [ ] Operating Mode toggle changes `state.cfg.opMode`; switch to the Terminal or Dashboard tab and confirm `TopBar.tsx`'s own PLAN/EDITS/AUTO toggle reflects the same value (shared state, not a separate mechanism).
- [ ] Clicking a theme swatch in Appearance visibly changes the reactor core's theme color (check on the Terminal or Dashboard view); confirm typing `theme <name>` in the terminal produces the identical result.
- [ ] Clicking a renderer option in Appearance changes the reactor core's renderer; confirm the active-option highlight matches `cfg.renderer` correctly (e.g. selecting "nebula" highlights it, and `cfg.renderer` is actually `'classic'` internally — verifies `rendererKeyToWord` round-trips correctly through the UI).
- [ ] Toggling reactor pulse (live/ambient) and moving the glow intensity slider visibly changes the reactor core's animation.
- [ ] Toggling glow effects on/off visibly changes the reactor core's glow filter.
- [ ] Moving the monthly cap slider changes Dashboard's "BUDGET LEFT" percentage and the terminal's `budget` command output correspondingly.
- [ ] Moving the alarm threshold slider changes when the burn alarm fires (observable via `alarmLevel`/the reactor status color over a few ticks — may need to wait or adjust the burn rate).
- [ ] Toggling auto-throttle changes whether the burn rate gets capped (compare rate ticking behavior with it on vs. off).
- [ ] Toggling sound changes `SystemsCard`'s existing "Sound: ON/OFF" display on the Dashboard.
- [ ] Reload the page — every changed value in this view persists (regression check that `cfg`'s pre-existing persistence still covers every field).
- [ ] Confirm no regressions elsewhere: Terminal, Dashboard, Agents, Grid, Chat, Projects, Memory, Analytics, and remaining placeholder tabs (Files, Uplinks) still route and highlight correctly.

- [ ] **Step 3: Address any regression found in Step 2**

If Step 2 surfaces a real regression (not a pre-existing, already-documented quirk), fix it and commit separately with a `fix:` message before considering this plan done. If nothing was found, skip this step.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-19-settings-view.md`. Executed via the same per-task pipeline as prior plans in this repo: a fresh implementer subagent per task, a fresh reviewer subagent (spec compliance + code quality) before commit, then one whole-branch review after all tasks land.

### Critical Files for Implementation
- C:\Users\Matt\projects\aether-os\src\state\reducer.ts
- C:\Users\Matt\projects\aether-os\src\components\settings\settingsMath.ts
- C:\Users\Matt\projects\aether-os\src\components\settings\SettingsView.tsx
- C:\Users\Matt\projects\aether-os\src\components\settings\AppearanceCard.tsx
- C:\Users\Matt\projects\aether-os\src\viewRegistry.ts
