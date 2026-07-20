# Uplinks View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `Uplinks` tab's `null` placeholder with a real Uplinks view — the first-ever UI for `providers[].connected` and `routeDefault`, both currently read-only (their only consumer is `SystemsCard.tsx`'s stats, which already dispatches into this tab via its pre-existing "UPLINKS →" link).

**Architecture:** A single new file, `UplinksView.tsx` — no roster+detail split (no rich per-item content) and no multi-card grid (thin enough for one card), unlike every other view built so far. Two sections: a PROVIDERS list (status dot, name, ONLINE/OFFLINE badge, connect/disconnect toggle per row) and a DEFAULT RUNTIME pill row (`Auto` + each provider's name). Two new, independent reducer actions — `TOGGLE_PROVIDER_CONNECTION` and `SET_ROUTE_DEFAULT` — one action per concern (matching Memory/Analytics' convention, not Settings' generic-patch case, since these are two unrelated fields rather than a multi-field form). No new pure-logic module — first view in this project with no non-trivial derivation to extract.

**Tech Stack:** Same as the existing project — React 18, Vite 5, TypeScript 5 (strict), Vitest. No new dependencies.

## Global Constraints

- Project root: `C:\Users\Matt\projects\aether-os` (already scaffolded; this plan extends it).
- Full design spec: `docs/superpowers/specs/2026-07-20-uplinks-view-design.md` (commit `b1b18eb`) — this plan implements it task-by-task; consult it for the "why" behind any decision below.
- **Scope for this plan:** `src/components/uplinks/UplinksView.tsx` (new — single file, no math module, no roster/detail split), `src/state/reducer.ts` / `reducer.test.ts` (modified — two new actions), `src/viewRegistry.ts` / `viewRegistry.test.ts` (modified — flip `Uplinks`'s component from `null`).
- **No provider add/remove/rename.** The three providers are a fixed set — no "add uplink" affordance anywhere in this plan.
- **No real network/API wiring.** `TOGGLE_PROVIDER_CONNECTION` toggles `connected` truthfully; it does not attempt any real connection. Chat's existing `/api/chat` proxy is unrelated and untouched.
- **The default-runtime selector (`Auto` + 3 provider names) has no filtering by connection state, and no auto-reset of `routeDefault` when its target provider disconnects.** Both are deliberate non-goals — do not add cross-field validation between `providers` and `routeDefault`.
- **No persistence changes.** `providers` and `routeDefault` are already both in `persistence.ts`'s `savePersisted` whitelist (verify in Task 1, do not add anything).
- **`SystemsCard.tsx`'s existing "UPLINKS →" link is unchanged** — it already dispatches `SET_ACTIVE_TAB('Uplinks')` and will now simply land on a real view.
- Match established visual/style conventions exactly: inline `CSSProperties` consts, `colors`/`fonts` tokens from `src/styles/tokens.ts`, `useAetherStore()`. The status-dot idiom mirrors `ReactorStatusCard.tsx`'s alarm indicator; the pill/toggle idiom mirrors Settings' `AppearanceCard.tsx`/`BudgetAlertsCard.tsx`.
- The reducer additions get Vitest coverage. `UplinksView.tsx` has no new testable logic of its own and is verified via typecheck + dev server, matching every prior presentational-only component.
- Run `npm test`, `npx tsc -b`, and `npm run build` clean before every commit. Baseline going into this plan: **253 passing tests across 25 files** (confirmed via `npm test` immediately before this plan was written).

---

## File Structure

```
aether-os/
  src/
    components/
      uplinks/
        UplinksView.tsx              NEW — single-card view: providers list + default-runtime pills
    state/
      reducer.ts                      MODIFIED — TOGGLE_PROVIDER_CONNECTION, SET_ROUTE_DEFAULT actions
      reducer.test.ts                 MODIFIED — tests for the above
    viewRegistry.ts                    MODIFIED — flip Uplinks' component from null to UplinksView
    viewRegistry.test.ts               MODIFIED — test that Uplinks now resolves
```

---

### Task 1: State — `TOGGLE_PROVIDER_CONNECTION`, `SET_ROUTE_DEFAULT` actions

Adds the two new reducer actions this view needs. Verifies (does not modify) that `providers`/`routeDefault` are already fully persisted.

**Files:**
- Modify: `src/state/reducer.ts`
- Modify: `src/state/reducer.test.ts`

**Interfaces:**
- Consumes: `Provider[]` shape (`{ name: string; connected: boolean }`, already defined in `types.ts`).
- Produces: `{ type: 'TOGGLE_PROVIDER_CONNECTION'; name: string }` and `{ type: 'SET_ROUTE_DEFAULT'; value: string }` added to the `Action` union — consumed by Task 2's `UplinksView`.

- [ ] **Step 1: Verify `providers`/`routeDefault` are already in the persistence whitelist (no change needed)**

Run: `grep -n "providers\|routeDefault" src/state/persistence.ts`
Expected output includes `providers: state.providers,` and `routeDefault: state.routeDefault,` inside `savePersisted`. If either line is missing, STOP and report BLOCKED — the plan's Global Constraints assume both are already true.

- [ ] **Step 2: Write the failing tests**

Append to `src/state/reducer.test.ts` (inside the existing `describe('reducer', ...)` block, right after the `'UPDATE_CFG merges a partial patch into cfg, leaving other cfg fields untouched'` test, before that block's closing `});`):

```ts
  it('TOGGLE_PROVIDER_CONNECTION flips the named provider\'s connected state only', () => {
    const next = reducer(initialState, { type: 'TOGGLE_PROVIDER_CONNECTION', name: 'OpenAI/Codex' });
    expect(next.providers.find((p) => p.name === 'OpenAI/Codex')?.connected).toBe(true);
    expect(next.providers.find((p) => p.name === 'Aether Core')?.connected).toBe(true);
    expect(next.providers.find((p) => p.name === 'Local Ollama')?.connected).toBe(false);
  });

  it('TOGGLE_PROVIDER_CONNECTION on an unrecognized name is a no-op', () => {
    const next = reducer(initialState, { type: 'TOGGLE_PROVIDER_CONNECTION', name: 'Nobody' });
    expect(next.providers).toEqual(initialState.providers);
  });

  it('SET_ROUTE_DEFAULT sets routeDefault, leaving providers unchanged', () => {
    const next = reducer(initialState, { type: 'SET_ROUTE_DEFAULT', value: 'Local Ollama' });
    expect(next.routeDefault).toBe('Local Ollama');
    expect(next.providers).toEqual(initialState.providers);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- reducer`
Expected: FAIL — `TOGGLE_PROVIDER_CONNECTION`/`SET_ROUTE_DEFAULT` aren't valid `Action`s yet.

- [ ] **Step 4: Add the two actions to the `Action` union**

Change the union's last member:

```ts
  | { type: 'SELECT_MEMORY'; id: number }
  | { type: 'TOGGLE_MEMORY_PIN'; id: number }
  | { type: 'UPDATE_CFG'; patch: Partial<Cfg> };
```

to:

```ts
  | { type: 'SELECT_MEMORY'; id: number }
  | { type: 'TOGGLE_MEMORY_PIN'; id: number }
  | { type: 'UPDATE_CFG'; patch: Partial<Cfg> }
  | { type: 'TOGGLE_PROVIDER_CONNECTION'; name: string }
  | { type: 'SET_ROUTE_DEFAULT'; value: string };
```

- [ ] **Step 5: Add the `switch` cases**

In `src/state/reducer.ts`, right after the existing `case 'UPDATE_CFG':` case:

```ts
    case 'UPDATE_CFG':
      return { ...state, cfg: { ...state.cfg, ...action.patch } };

    case 'TOGGLE_PROVIDER_CONNECTION':
      return {
        ...state,
        providers: state.providers.map((p) => (p.name === action.name ? { ...p, connected: !p.connected } : p)),
      };

    case 'SET_ROUTE_DEFAULT':
      return { ...state, routeDefault: action.value };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- reducer`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (256 total: 253 + 3 new), 0 type errors.

- [ ] **Step 8: Commit**

```bash
git add src/state/reducer.ts src/state/reducer.test.ts
git commit -m "feat: add TOGGLE_PROVIDER_CONNECTION and SET_ROUTE_DEFAULT reducer actions for the Uplinks view"
```

---

### Task 2: Uplinks view + registry wiring

Builds the single-file view (providers list + default-runtime pills) and wires it into the registry — no separate composition task needed since there's only one component.

**Files:**
- Create: `src/components/uplinks/UplinksView.tsx`
- Modify: `src/viewRegistry.ts`
- Modify: `src/viewRegistry.test.ts`

**Interfaces:**
- Consumes: `useAetherStore()`; `colors`, `fonts` from `../../styles/tokens`; `TOGGLE_PROVIDER_CONNECTION`/`SET_ROUTE_DEFAULT` actions from Task 1.
- Produces: `UplinksView()` — registered in `viewRegistry.ts`, completing the Uplinks slice.

- [ ] **Step 1: Implement `src/components/uplinks/UplinksView.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function UplinksView() {
  const { state, dispatch } = useAetherStore();
  const runtimeOptions = ['Auto', ...state.providers.map((p) => p.name)];

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>PROVIDERS</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        {state.providers.map((p) => (
          <div key={p.name} style={rowStyle}>
            <span style={dotStyle(p.connected)} />
            <span style={nameStyle}>{p.name}</span>
            <span style={badgeStyle(p.connected)}>{p.connected ? 'ONLINE' : 'OFFLINE'}</span>
            <span
              onClick={() => dispatch({ type: 'TOGGLE_PROVIDER_CONNECTION', name: p.name })}
              style={toggleButtonStyle(p.connected)}
            >
              {p.connected ? 'DISCONNECT' : 'CONNECT'}
            </span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 24 }}>
        <div style={titleStyle}>DEFAULT RUNTIME</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {runtimeOptions.map((option) => (
            <span
              key={option}
              onClick={() => dispatch({ type: 'SET_ROUTE_DEFAULT', value: option })}
              style={pillStyle(state.routeDefault === option)}
            >
              {option}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  padding: 18,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};
const titleStyle: CSSProperties = { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 12px',
  borderRadius: 9,
  border: '1px solid rgba(80,190,220,.16)',
  background: 'rgba(6,20,28,.5)',
};
function dotStyle(connected: boolean): CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flex: 'none',
    background: connected ? colors.success : colors.textDim,
    boxShadow: connected ? '0 0 8px rgba(59,224,160,.8)' : undefined,
  };
}
const nameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  font: `600 13px/1 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
function badgeStyle(connected: boolean): CSSProperties {
  const c = connected ? colors.success : colors.textDim;
  return { flex: 'none', font: `600 9px/1 ${fonts.ui}`, letterSpacing: 1, color: c, border: `1px solid ${c}55`, padding: '4px 8px', borderRadius: 4 };
}
function toggleButtonStyle(connected: boolean): CSSProperties {
  return {
    flex: 'none',
    cursor: 'pointer',
    textAlign: 'center',
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    padding: '6px 12px',
    borderRadius: 7,
    color: connected ? colors.dangerSoft : '#04202b',
    background: connected ? 'rgba(255,90,90,.06)' : 'linear-gradient(180deg,#7ef0ff,#17b8d8)',
    border: connected ? '1px solid rgba(255,120,120,.4)' : 'none',
    boxShadow: connected ? undefined : '0 0 10px rgba(95,220,255,.4)',
  };
}
function pillStyle(on: boolean): CSSProperties {
  return {
    cursor: 'pointer',
    textAlign: 'center',
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    padding: '7px 14px',
    borderRadius: 7,
    color: on ? '#04202b' : colors.textMuted,
    background: on ? 'linear-gradient(180deg,#7ef0ff,#17b8d8)' : 'rgba(10,32,43,.6)',
    boxShadow: on ? '0 0 10px rgba(95,220,255,.4)' : undefined,
    border: on ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
```

- [ ] **Step 2: Wire Uplinks into the registry**

In `src/viewRegistry.ts`, add the import:

```ts
import { UplinksView } from './components/uplinks/UplinksView';
```

Change:

```ts
  { id: 'Uplinks', inTopBar: false, inSidebar: true, component: null },
```

to:

```ts
  { id: 'Uplinks', inTopBar: false, inSidebar: true, component: UplinksView },
```

Do not change `inTopBar`/`inSidebar` — Uplinks stays sidebar-only, same as Settings.

- [ ] **Step 3: Update `src/viewRegistry.test.ts`**

Add a new test confirming Uplinks now resolves (after the existing `'getViewComponent resolves Settings now that it is built'` test):

```ts
  it('getViewComponent resolves Uplinks now that it is built', () => {
    expect(getViewComponent('Uplinks')).not.toBeNull();
  });
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (257 total: 256 + 1 new), 0 type errors, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/uplinks/UplinksView.tsx src/viewRegistry.ts src/viewRegistry.test.ts
git commit -m "feat: build the Uplinks view and wire it into the view registry"
```

---

### Task 3: Final integration QA

**Files:** none (verification-only task).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (257/257), 0 type errors, build succeeds.

- [ ] **Step 2: Manual QA checklist**

Run: `npm run dev`, open the browser. Uplinks is sidebar-only — use the left sidebar nav, not the top bar, to reach it (same as Settings).

- [ ] Clicking the sidebar's "Uplinks" entry shows the PROVIDERS list (3 seed providers) and the DEFAULT RUNTIME pill row (Auto + 3 names).
- [ ] Seed state renders correctly: Aether Core shows ONLINE/DISCONNECT, OpenAI/Codex and Local Ollama show OFFLINE/CONNECT.
- [ ] Toggling a provider's connect/disconnect button flips its badge and button label immediately.
- [ ] Switch to Dashboard — `SystemsCard`'s "Uplinks online X/Y" count reflects the toggle without a reload.
- [ ] Clicking a default-runtime pill highlights it and un-highlights the previous selection; switch to Dashboard and confirm `SystemsCard`'s "Default runtime" line matches.
- [ ] Disconnect the provider currently selected as the default runtime — confirm the pill stays highlighted (no auto-reset to Auto), matching this plan's explicit non-goal.
- [ ] Reload the page — both provider connection states and the selected default runtime persist.
- [ ] Confirm no regressions elsewhere: Terminal, Dashboard, Agents, Grid, Chat, Projects, Memory, Analytics, Settings, and the remaining placeholder tab (Files) still route and highlight correctly.

- [ ] **Step 3: Address any regression found in Step 2**

If Step 2 surfaces a real regression (not a pre-existing, already-documented quirk), fix it and commit separately with a `fix:` message before considering this plan done. If nothing was found, skip this step.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-20-uplinks-view.md`. Executed via the same per-task pipeline as prior plans in this repo: a fresh implementer subagent per task, a fresh reviewer subagent (spec compliance + code quality) before commit, then one whole-branch review after all tasks land.

### Critical Files for Implementation
- C:\Users\Matt\projects\aether-os\src\state\reducer.ts
- C:\Users\Matt\projects\aether-os\src\components\uplinks\UplinksView.tsx
- C:\Users\Matt\projects\aether-os\src\viewRegistry.ts
