# Customizable Operator Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user set their own display name once (in Settings) and have it replace the hardcoded "operator"/"Operator" wherever it functions as a *display name* — the TopBar chip, and the instruction telling the model how to address the user, extended to every chat channel (today only AETHER does this).

**Architecture:** A new top-level `AetherState` field (`operatorName`, not a `Cfg` field) with its own dedicated action (`SET_OPERATOR_NAME`), a tiny new `resolveOperatorName` helper in `src/utils/format.ts` (blank/whitespace falls back to `'Operator'`, used in exactly two consumers so it's worth sharing), `systemPrompt.ts`'s `AETHER_VOICE` becoming a function and a new shared `referAsInstruction` sentence-builder appended to per-agent channels too, `TopBar.tsx`'s chip reading the resolved name, and a new `OperatorCard` in Settings' left column.

**Tech Stack:** Same as the existing project — React 18, Vite 5, TypeScript 5 (strict), Vitest. No new dependencies.

## Global Constraints

- Project root: `C:\Users\Matt\projects\aether-os` (already scaffolded; this plan extends it).
- Full design spec: `docs/superpowers/specs/2026-07-20-operator-name-design.md` (commit `0131e86`) — this plan implements it task-by-task; consult it for the "why" behind any decision below.
- **Scope for this plan:** `src/state/types.ts` / `initialState.ts` / `reducer.ts` / `reducer.test.ts` / `persistence.ts` / `persistence.test.ts` (new `operatorName` field, `SET_OPERATOR_NAME` action, persistence entry), `src/utils/format.ts` / `format.test.ts` (new `resolveOperatorName` helper), `src/components/chat/systemPrompt.ts` / `systemPrompt.test.ts` (AETHER_VOICE → function, new shared `referAsInstruction`, per-agent branches updated), `src/components/layout/TopBar.tsx` (chip reads the resolved name), `src/components/settings/OperatorCard.tsx` (new) / `SettingsView.tsx` (wiring).
- **Out of scope, explicitly:** the terminal's `operator@aether-core:~$` prompt (`commands.ts`, `TerminalView.tsx`) and Memory's `remember` command's `source: 'operator'` tag (`commands.ts`, `initialState.ts`) — neither is touched anywhere in this plan. Both are unrelated uses of the literal string, not display-name usages (see spec's Non-goals).
- **`operatorName` seeds as `'Operator'`** in `initialState.ts` — the exact string `systemPrompt.ts` hardcodes today, so the first render/reply after this ships is byte-identical to before it.
- **No reducer-side trimming/validation.** `SET_OPERATOR_NAME` stores `action.name` verbatim, including an empty string if that's what's dispatched — blank-handling happens only at the two *consumption* points (`TopBar.tsx`, `systemPrompt.ts`) via `resolveOperatorName`, never by the reducer rewriting what the user is mid-typing.
- **`resolveOperatorName` lives in `src/utils/format.ts`**, alongside this file's other tiny pure helpers (`fmt`, `short`, `fmtEta`, `spark`, `nowLong`, `nowShort`) — not a new dedicated module, since it's a single one-line function.
- **`referAsInstruction` is the single place the "You refer to the user as..." sentence's wording lives** — both the AETHER branch (via the new `aetherVoice` function) and the per-agent branch call it, so they cannot drift apart in wording. Do not duplicate the sentence text in two places.
- **Both of the per-agent branch's returns** in `buildSystemPrompt` (the normal case and the archived-channel fallback) must get the new addressing sentence — it is easy to update one and miss the other; the plan's tests explicitly cover both.
- Match established visual/style conventions exactly: inline `CSSProperties` consts, `colors`/`fonts` tokens from `src/styles/tokens.ts`, `useAetherStore()`. `OperatorCard.tsx` mirrors `OperatingModeCard.tsx`'s card shape.
- The reducer/persistence/format/systemPrompt additions get Vitest coverage. `TopBar.tsx` and `OperatorCard.tsx`/`SettingsView.tsx` have no new testable logic of their own (presentational) and are verified via typecheck + dev server.
- Run `npm test`, `npx tsc -b`, and `npm run build` clean before every commit. Baseline going into this plan: **257 passing tests across 25 files** (confirmed via `npm test` immediately before this plan was written).

---

## File Structure

```
aether-os/
  src/
    state/
      types.ts                    MODIFIED — AetherState.operatorName
      initialState.ts             MODIFIED — operatorName: 'Operator'
      reducer.ts                  MODIFIED — SET_OPERATOR_NAME action
      reducer.test.ts             MODIFIED — tests for the above
      persistence.ts              MODIFIED — operatorName added to savePersisted whitelist
      persistence.test.ts         MODIFIED — round-trip test
    utils/
      format.ts                    MODIFIED — new resolveOperatorName helper
      format.test.ts               MODIFIED — tests for the above
    components/
      chat/
        systemPrompt.ts            MODIFIED — AETHER_VOICE -> aetherVoice(), new referAsInstruction, per-agent branches updated
        systemPrompt.test.ts       MODIFIED — tests for the above
      layout/
        TopBar.tsx                 MODIFIED — chip reads resolveOperatorName(state.operatorName)
      settings/
        OperatorCard.tsx           NEW — name input, dispatches SET_OPERATOR_NAME
        SettingsView.tsx           MODIFIED — OperatorCard added to the left column
```

---

### Task 1: State — `operatorName` field, `SET_OPERATOR_NAME` action, persistence

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/reducer.ts`
- Modify: `src/state/reducer.test.ts`
- Modify: `src/state/persistence.ts`
- Modify: `src/state/persistence.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AetherState.operatorName: string`; `{ type: 'SET_OPERATOR_NAME'; name: string }` added to the `Action` union — consumed by Task 3 (`systemPrompt.ts`), Task 4 (`TopBar.tsx`), and Task 5 (`OperatorCard.tsx`).

- [ ] **Step 1: Write the failing tests**

Append to `src/state/reducer.test.ts` (inside the existing `describe('reducer', ...)` block, right after the `'SET_ROUTE_DEFAULT sets routeDefault, leaving providers unchanged'` test, before that block's closing `});`):

```ts
  it('SET_OPERATOR_NAME sets operatorName verbatim, leaving other state untouched', () => {
    const next = reducer(initialState, { type: 'SET_OPERATOR_NAME', name: 'Matt' });
    expect(next.operatorName).toBe('Matt');
    expect(next.routeDefault).toBe(initialState.routeDefault);
  });

  it('SET_OPERATOR_NAME accepts an empty string without trimming at the reducer layer', () => {
    const next = reducer(initialState, { type: 'SET_OPERATOR_NAME', name: '' });
    expect(next.operatorName).toBe('');
  });
```

Append to `src/state/persistence.test.ts` (inside the existing `describe('persistence', ...)` block, right after the `'persists chatActionResults across reloads'` test, before the `'returns null when nothing is stored'` test):

```ts
  it('persists operatorName across reloads', () => {
    savePersisted({ ...initialState, operatorName: 'Matt' });
    const loaded = loadPersisted();
    expect(loaded?.operatorName).toBe('Matt');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- reducer persistence`
Expected: FAIL — `operatorName` doesn't exist on `AetherState` yet; `SET_OPERATOR_NAME` isn't a valid `Action`.

- [ ] **Step 3: Add the field to `AetherState` in `src/state/types.ts`**

Change:

```ts
  routeDefault: string;
  chatActionResults: ChatActionResult[];
```

to:

```ts
  routeDefault: string;
  operatorName: string;
  chatActionResults: ChatActionResult[];
```

- [ ] **Step 4: Add the default in `src/state/initialState.ts`**

Change:

```ts
  routeDefault: 'Auto',
  chatActionResults: [],
```

to:

```ts
  routeDefault: 'Auto',
  operatorName: 'Operator',
  chatActionResults: [],
```

- [ ] **Step 5: Add the action to the `Action` union in `src/state/reducer.ts`**

Change the union's last member:

```ts
  | { type: 'TOGGLE_PROVIDER_CONNECTION'; name: string }
  | { type: 'SET_ROUTE_DEFAULT'; value: string };
```

to:

```ts
  | { type: 'TOGGLE_PROVIDER_CONNECTION'; name: string }
  | { type: 'SET_ROUTE_DEFAULT'; value: string }
  | { type: 'SET_OPERATOR_NAME'; name: string };
```

- [ ] **Step 6: Add the `switch` case**

In `src/state/reducer.ts`, right after the existing `case 'SET_ROUTE_DEFAULT':` case:

```ts
    case 'SET_ROUTE_DEFAULT':
      return { ...state, routeDefault: action.value };

    case 'SET_OPERATOR_NAME':
      return { ...state, operatorName: action.name };
```

- [ ] **Step 7: Add `operatorName` to the persistence whitelist in `src/state/persistence.ts`**

Change:

```ts
      providers: state.providers,
      routeDefault: state.routeDefault,
      selected: state.selected,
```

to:

```ts
      providers: state.providers,
      routeDefault: state.routeDefault,
      operatorName: state.operatorName,
      selected: state.selected,
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -- reducer persistence`
Expected: PASS.

- [ ] **Step 9: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (260 total: 257 + 3 new), 0 type errors.

- [ ] **Step 10: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/state/reducer.ts src/state/reducer.test.ts src/state/persistence.ts src/state/persistence.test.ts
git commit -m "feat: add operatorName state field, SET_OPERATOR_NAME action, and persistence"
```

---

### Task 2: `resolveOperatorName` helper

**Files:**
- Modify: `src/utils/format.ts`
- Modify: `src/utils/format.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `resolveOperatorName(name: string): string` — consumed by Task 3's `systemPrompt.ts` and Task 4's `TopBar.tsx`.

- [ ] **Step 1: Write the failing tests**

Append to `src/utils/format.test.ts` (after the existing `describe('nowLong/nowShort', ...)` block):

```ts
describe('resolveOperatorName', () => {
  it('returns the trimmed name when non-blank', () => {
    expect(resolveOperatorName('  Matt  ')).toBe('Matt');
  });

  it('falls back to "Operator" for an empty string', () => {
    expect(resolveOperatorName('')).toBe('Operator');
  });

  it('falls back to "Operator" for a whitespace-only string', () => {
    expect(resolveOperatorName('   ')).toBe('Operator');
  });
});
```

Update the import line at the top of the file:

```ts
import { fmt, fmtEta, nowLong, nowShort, short, spark } from './format';
```

to:

```ts
import { fmt, fmtEta, nowLong, nowShort, resolveOperatorName, short, spark } from './format';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- format`
Expected: FAIL — `resolveOperatorName` doesn't exist yet.

- [ ] **Step 3: Implement `resolveOperatorName` in `src/utils/format.ts`**

Append at the end of the file:

```ts
export function resolveOperatorName(name: string): string {
  return name.trim() || 'Operator';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- format`
Expected: PASS, 3 new tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (263 total: 260 + 3 new), 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/utils/format.ts src/utils/format.test.ts
git commit -m "feat: add resolveOperatorName helper (blank-name fallback)"
```

---

### Task 3: `systemPrompt.ts` — shared addressing instruction for every channel

**Files:**
- Modify: `src/components/chat/systemPrompt.ts`
- Modify: `src/components/chat/systemPrompt.test.ts`

**Interfaces:**
- Consumes: `resolveOperatorName` from `../../utils/format` (built in Task 2); `state.operatorName` (built in Task 1).
- Produces: `buildSystemPrompt` now threads `state.operatorName` into every channel's prompt — consumed by nothing further in this plan (this is the mechanism Task 6's manual QA verifies live).

- [ ] **Step 1: Write the failing tests**

Append to `src/components/chat/systemPrompt.test.ts` (inside the existing `describe('buildSystemPrompt', ...)` block):

```ts
  it('AETHER prompt addresses the user by a custom operatorName instead of the literal "Operator"', () => {
    const named: AetherState = { ...initialState, operatorName: 'Matt' };
    const prompt = buildSystemPrompt(aether, named);
    expect(prompt).toContain('"Matt."');
    expect(prompt).not.toContain('"Operator."');
  });

  it('per-agent channel prompt now also addresses the user by name (previously only AETHER did)', () => {
    const prompt = buildSystemPrompt(codeBuilder, initialState);
    expect(prompt).toContain('"Operator."');
  });

  it('archived-channel prompt also addresses the user by name', () => {
    const prompt = buildSystemPrompt(webScraper, initialState);
    expect(prompt).toContain('"Operator."');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- systemPrompt`
Expected: FAIL — per-agent/archived prompts don't yet contain `"Operator."`; the custom-name test finds the literal word "Operator" instead of "Matt".

- [ ] **Step 3: Add the `resolveOperatorName` import**

Change:

```ts
import type { Agent, AetherState } from '../../state/types';
import type { ChatChannel } from './chatChannels';
import { resolvePersona } from './personas';
```

to:

```ts
import type { Agent, AetherState } from '../../state/types';
import type { ChatChannel } from './chatChannels';
import { resolvePersona } from './personas';
import { resolveOperatorName } from '../../utils/format';
```

- [ ] **Step 4: Replace `AETHER_VOICE` with `referAsInstruction` + `aetherVoice`**

Change:

```ts
const AETHER_VOICE =
  'You are AETHER, the mission-control intelligence of this dashboard. ' +
  'Dry, precise, and economical with words. You refer to the user as "Operator."';
```

to:

```ts
function referAsInstruction(operatorName: string): string {
  return `You refer to the user as "${resolveOperatorName(operatorName)}."`;
}

function aetherVoice(operatorName: string): string {
  return (
    'You are AETHER, the mission-control intelligence of this dashboard. ' +
    'Dry, precise, and economical with words. ' +
    referAsInstruction(operatorName)
  );
}
```

- [ ] **Step 5: Update `buildSystemPrompt` to thread `state.operatorName` through every branch**

Change:

```ts
export function buildSystemPrompt(channel: ChatChannel, state: AetherState): string {
  if (channel.kind === 'aether') {
    const snapshot = buildAetherSnapshot(state);
    return `${AETHER_VOICE}\n\nCurrent state:\n${JSON.stringify(snapshot)}\n\n${RULES}`;
  }

  const persona = resolvePersona(channel.name);
  const agent = state.agents.find((a) => a.name === channel.name);
  if (!agent) {
    // Archived channels never reach askClaude in practice (useChatChannels
    // blocks sending when channel.archived is true), but build a safe
    // prompt anyway rather than assume every future caller guards this.
    return `You are ${channel.name}. ${persona.voice}\n\nYou are currently offline/archived.\n\n${RULES}`;
  }

  const snapshot = buildAgentSnapshot(state, agent);
  return `You are ${channel.name}. ${persona.voice}\n\nYour current state:\n${JSON.stringify(snapshot)}\n\n${RULES}`;
}
```

to:

```ts
export function buildSystemPrompt(channel: ChatChannel, state: AetherState): string {
  if (channel.kind === 'aether') {
    const snapshot = buildAetherSnapshot(state);
    return `${aetherVoice(state.operatorName)}\n\nCurrent state:\n${JSON.stringify(snapshot)}\n\n${RULES}`;
  }

  const persona = resolvePersona(channel.name);
  const agent = state.agents.find((a) => a.name === channel.name);
  if (!agent) {
    // Archived channels never reach askClaude in practice (useChatChannels
    // blocks sending when channel.archived is true), but build a safe
    // prompt anyway rather than assume every future caller guards this.
    return `You are ${channel.name}. ${persona.voice} ${referAsInstruction(state.operatorName)}\n\nYou are currently offline/archived.\n\n${RULES}`;
  }

  const snapshot = buildAgentSnapshot(state, agent);
  return `You are ${channel.name}. ${persona.voice} ${referAsInstruction(state.operatorName)}\n\nYour current state:\n${JSON.stringify(snapshot)}\n\n${RULES}`;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- systemPrompt`
Expected: PASS, including the pre-existing `'AETHER prompt addresses the user as Operator...'` test (still passes — `initialState.operatorName` is `'Operator'`, so the default output is unchanged).

- [ ] **Step 7: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (266 total: 263 + 3 new), 0 type errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/chat/systemPrompt.ts src/components/chat/systemPrompt.test.ts
git commit -m "feat: address the user by name in every chat channel, not just AETHER"
```

---

### Task 4: TopBar chip reads the resolved operator name

**Files:**
- Modify: `src/components/layout/TopBar.tsx`

**Interfaces:**
- Consumes: `resolveOperatorName` from `../../utils/format` (Task 2); `state.operatorName` (Task 1).
- Produces: no new exports — behavior fix to an existing component.

No new unit-testable logic (no `TopBar.test.ts` exists — this component has never had one) — verify via typecheck + dev server.

- [ ] **Step 1: Add the import**

Change:

```ts
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { OpMode } from '../../state/types';
import { VIEWS } from '../../viewRegistry';
```

to:

```ts
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { OpMode } from '../../state/types';
import { VIEWS } from '../../viewRegistry';
import { resolveOperatorName } from '../../utils/format';
```

- [ ] **Step 2: Replace the hardcoded chip text**

Change:

```tsx
          <div style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 1, color: colors.textPrimary }}>operator</div>
```

to:

```tsx
          <div style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 1, color: colors.textPrimary }}>{resolveOperatorName(state.operatorName)}</div>
```

The "COMMAND DECK" subtitle line directly beneath it is unchanged.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/TopBar.tsx
git commit -m "feat: show the resolved operator name in the TopBar chip"
```

---

### Task 5: `OperatorCard` + Settings wiring

**Files:**
- Create: `src/components/settings/OperatorCard.tsx`
- Modify: `src/components/settings/SettingsView.tsx`

**Interfaces:**
- Consumes: `useAetherStore()`; `colors`, `fonts` from `../../styles/tokens`; the `SET_OPERATOR_NAME` action (Task 1).
- Produces: `OperatorCard()` — mounted by `SettingsView`.

No new unit-testable logic — verify via typecheck + dev server.

- [ ] **Step 1: Implement `src/components/settings/OperatorCard.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function OperatorCard() {
  const { state, dispatch } = useAetherStore();

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>IDENTITY</div>
      <div style={{ marginTop: 12 }}>
        <div style={labelStyle}>YOUR NAME</div>
        <input
          type="text"
          maxLength={24}
          value={state.operatorName}
          onChange={(e) => dispatch({ type: 'SET_OPERATOR_NAME', name: e.target.value })}
          placeholder="Operator"
          style={inputStyle}
        />
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
const inputStyle: CSSProperties = {
  width: '100%',
  marginTop: 8,
  padding: '9px 12px',
  borderRadius: 8,
  border: '1px solid rgba(80,190,220,.25)',
  background: 'rgba(10,32,43,.6)',
  color: colors.textPrimary,
  font: `600 13px/1 ${fonts.ui}`,
  outline: 'none',
};
```

- [ ] **Step 2: Wire it into `SettingsView.tsx`**

Change:

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
```

to:

```tsx
import type { CSSProperties } from 'react';
import { OperatingModeCard } from './OperatingModeCard';
import { AppearanceCard } from './AppearanceCard';
import { BudgetAlertsCard } from './BudgetAlertsCard';
import { OperatorCard } from './OperatorCard';

export function SettingsView() {
  return (
    <div style={rootStyle}>
      <div style={columnStyle}>
        <OperatorCard />
        <OperatingModeCard />
        <BudgetAlertsCard />
      </div>
      <AppearanceCard />
    </div>
  );
}
```

- [ ] **Step 3: Run the full suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (266/266, unchanged — this task adds no new tests), 0 type errors, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/OperatorCard.tsx src/components/settings/SettingsView.tsx
git commit -m "feat: add an identity card to Settings for setting the operator's name"
```

---

### Task 6: Final integration QA

**Files:** none (verification-only task).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (266/266), 0 type errors, build succeeds.

- [ ] **Step 2: Manual QA checklist**

Run: `npm run dev`, open the browser.

- [ ] Settings' new IDENTITY card (top of the left column) renders with the current name (default "Operator") and accepts typed input.
- [ ] Typing a new name updates the TopBar chip immediately, with no reload.
- [ ] Switch to Chat, message AETHER — confirm the reply addresses the user by the new name in a natural sentence (not literally echoing "Operator").
- [ ] Message a per-agent channel (e.g. Code Builder) — confirm it also now addresses the user by the new name, which it never did before this plan.
- [ ] Clear the name field entirely — confirm the TopBar chip falls back to "Operator" rather than going blank, and a subsequent chat reply still addresses the user as "Operator" (the fallback) rather than producing an awkward blank-name sentence.
- [ ] Reload the page — the custom name persists in both the TopBar chip and the next chat reply.
- [ ] Confirm the terminal's `operator@aether-core:~$` prompt and Memory's `remember`-tagged `source: 'operator'` are both unchanged (non-goals held) — run `remember test` in the Terminal, then check the new memory's source badge in the Memory view still reads "operator", not the custom name.
- [ ] Confirm no regressions elsewhere: Terminal, Dashboard, Agents, Grid, Projects, Memory, Analytics, Settings, Uplinks, and the remaining placeholder tab (Files) still route and highlight correctly.

- [ ] **Step 3: Address any regression found in Step 2**

If Step 2 surfaces a real regression (not a pre-existing, already-documented quirk), fix it and commit separately with a `fix:` message before considering this plan done. If nothing was found, skip this step.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-20-operator-name.md`. Executed via the same per-task pipeline as prior plans in this repo: a fresh implementer subagent per task, a fresh reviewer subagent (spec compliance + code quality) before commit, then one whole-branch review after all tasks land.

### Critical Files for Implementation
- C:\Users\Matt\projects\aether-os\src\state\reducer.ts
- C:\Users\Matt\projects\aether-os\src\utils\format.ts
- C:\Users\Matt\projects\aether-os\src\components\chat\systemPrompt.ts
- C:\Users\Matt\projects\aether-os\src\components\layout\TopBar.tsx
- C:\Users\Matt\projects\aether-os\src\components\settings\OperatorCard.tsx
