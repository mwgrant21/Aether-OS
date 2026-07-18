# Agents View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `Agents` tab's `ComingSoonPanel` placeholder with a real Agents view — a roster + detail screen that surfaces data the app already tracks (per-agent progress, task, files, token-draw history, idle agents, agent-tied approvals) but currently only exposes in fragments across Terminal and Dashboard — and give `state.selected` (currently write-only) its first reader.

**Architecture:** A master-detail layout, same shape as Terminal's card+rail split: `AgentRosterCard` (left, fixed width) lists every active agent plus the idle pool; `AgentDetailCard` (right, flex) renders full detail for whichever agent is selected. `AgentsView.tsx` composes the two and owns the one piece of derivation logic that decides *which* agent is "selected" right now — `pickSelectedAgent`, extracted into a tested pure module (`agentsMath.ts`) alongside `agentApprovals` and `agentStatusLabel`, following the same "math file feeds dumb components" split `dashboardMath.ts` established for Dashboard. Two new reducer actions are added (`TOGGLE_AGENT_PAUSE`, `REACTIVATE_AGENT`); everything else this view needs — pausing's effect on tick, per-agent files/hist, approvals, killing an agent — already exists and is reused as-is (`RESOLVE_APPROVAL`, `RUN_COMMAND raw:'kill <name>'`, `makeAgent()`).

**Tech Stack:** Same as the existing project — React 18, Vite 5, TypeScript 5 (strict), Vitest. No new dependencies.

## Global Constraints

- Project root: `C:\Users\Matt\projects\aether-os` (already scaffolded; this plan extends it, not a fresh `git init`).
- **Scope for this plan:** `src/components/agents/AgentsView.tsx` (+ `AgentRosterCard.tsx`, `AgentDetailCard.tsx`, `agentsMath.ts`), two new reducer actions, wiring the `Agents` view-registry entry to the real component, and one small honest fix to `Sidebar.tsx`'s "Recent Agents" list. Terminal's `ActiveAgentsCard` and Dashboard's `ActiveAgentsDigest` are **unchanged** — this plan gives their existing `SELECT_AGENT` dispatches a real destination for the first time; it does not touch how those two cards render.
- **Four scope decisions, made explicitly so they aren't mistaken for gaps later:**
  1. **Pause/resume is IN SCOPE.** `tick.ts` already freezes an agent's `pct` when `paused` is true (`a.paused ? a.pct : Math.min(99, ...)`), and the terminal `agents` command already prints `paused ? 'paused' : 'active'` — but nothing can set `paused` yet. This plan adds `TOGGLE_AGENT_PAUSE` (a one-line boolean flip) and a Pause/Resume button in the Agent Detail panel. No changes to `tick.ts` are needed; it already does the right thing once `paused` can be true.
  2. **Idle-agent reactivation is IN SCOPE**, via a `REACTIVATE_AGENT` action that reuses the terminal command module's already-tested `makeAgent(name)` to build the reactivated agent. Deliberately, this is a "spawn with a familiar name," not a "resume where it left off" — `IdleAgent` only ever stored `{ name, last }`, not the agent's old task/files/history, so there is nothing to actually resume. This mirrors the existing `spawn` command's semantics exactly (task resets to `'Initializing…'`, fresh `hist`, fresh `files`) and, like `spawn`, nudges `rate` up by the same `18000` — a newly-active agent draws power.
  3. **Agent-tied approvals (`state.approvals[].agent`) are IN SCOPE**, shown read-plus-action in the Agent Detail panel. This reuses the exact `RESOLVE_APPROVAL` action and the same Approve/Deny visual treatment already shipped in `TopBar.tsx` — no new approval logic, just a second, agent-filtered place to act on the same queue.
  4. **A "TERMINATE" action is IN SCOPE**, reusing the existing, already-tested terminal `kill <name>` command via `dispatch({ type: 'RUN_COMMAND', raw: `kill ${agent.name}` })` — the same "reuse an already-tested command instead of writing new reducer logic" pattern the Dashboard plan used for its "MEMORY SWEEP" button. Terminating moves the agent to `idleList` (exactly like running `kill` from the Terminal does today); this plan does not add a separate delete-forever action.
- **Sidebar fidelity fix, done as part of this plan (not a separate plan):** `Sidebar.tsx`'s "Recent Agents" list is currently a hardcoded 4-entry array (`CB`/`UI`/`DB`/`TR`) with **no click handler at all** — confirmed by reading the file directly. This plan replaces it with a live `state.agents.slice(0, 4)` and wires each row to `SELECT_AGENT` + `SET_ACTIVE_TAB: 'Agents'`. This is both a small honest fix (the hardcoded list was already drifting from real state — e.g. a spawned or killed agent never showed up or disappeared) and the natural destination for `state.selected` now that something finally reads it.
- **Known pre-existing quirk, NOT fixed by this plan:** `spark()` (`src/utils/format.ts`) computes `x = (i / (hist.length - 1)) * 62`, which divides by zero the instant an array has exactly one element. `Agent.hist` starts as `[]` and gains its first element on an agent's very first tick after being spawned/reactivated, so there is a one-tick window where the Agent Detail sparkline's first (only) point is `NaN` — invalid, but SVG silently ignores it (doesn't crash), and it self-heals on the next tick once `hist.length` is 2. This already existed as a latent property of `spark()`; the Terminal view never noticed because `SysMetric.hist` is always a fixed length-8 array. Not touched here — same "document, don't silently rewrite shared logic" precedent as the two prior plans' fidelity notes.
- Match established visual/style conventions exactly: inline `CSSProperties` consts, `colors`/`fonts` tokens from `src/styles/tokens.ts`, `useAetherStore()`, the same avatar/track/badge visual language `ActiveAgentsCard.tsx` and `ActiveAgentsDigest.tsx` already established.
- New pure-logic modules (`agentsMath.ts`, reducer additions) get Vitest coverage. Presentational components (`AgentRosterCard`, `AgentDetailCard`, `AgentsView`, the `Sidebar` edit) have no new testable logic of their own and are verified via the dev server, matching the precedent set by `ReactorStatusCard`/`ActiveAgentsDigest`/etc.
- Run `npm test`, `npx tsc -b`, and `npm run build` clean before every commit. Baseline going into this plan: **56 passing tests** across 9 files (confirmed via `npm test` before starting).

---

## File Structure

```
aether-os/
  src/
    components/
      agents/
        AgentsView.tsx          NEW — 2-column composition, mounted by the view registry
        AgentRosterCard.tsx     NEW — left rail: active roster (selectable) + idle pool (reactivatable)
        AgentDetailCard.tsx     NEW — right panel: selected agent's full detail
        agentsMath.ts           NEW — pure derivation, tested
        agentsMath.test.ts      NEW
      layout/
        Sidebar.tsx             MODIFIED — "Recent Agents" becomes a live, clickable list
    state/
      reducer.ts                MODIFIED — TOGGLE_AGENT_PAUSE, REACTIVATE_AGENT actions
      reducer.test.ts           MODIFIED — tests for both new actions
    viewRegistry.ts              MODIFIED — flip Agents' component from null to AgentsView
    viewRegistry.test.ts         MODIFIED — test that Agents now resolves
```

---

### Task 1: Reducer — pause toggle and idle-agent reactivation

Adds the two pieces of new state-mutation logic this view needs. Everything else (per-agent `pct`/`hist`/`files`, `state.selected`, `state.approvals`) already exists in `AetherState` and needs no type changes.

**Files:**
- Modify: `src/state/reducer.ts`
- Modify: `src/state/reducer.test.ts`

**Interfaces:**
- Consumes: `makeAgent(name: string): Agent` from `../components/terminal/commands` (already exported, used today by the `spawn` command).
- Produces: `{ type: 'TOGGLE_AGENT_PAUSE'; name: string }` and `{ type: 'REACTIVATE_AGENT'; name: string }` additions to the `Action` union — consumed by Task 3's `AgentRosterCard` and Task 4's `AgentDetailCard`.

- [ ] **Step 1: Write the failing tests**

Append to `src/state/reducer.test.ts` (inside the existing `describe('reducer', ...)` block, before its closing `});`):

```ts
it('TOGGLE_AGENT_PAUSE flips paused on the named agent only', () => {
  const next = reducer(initialState, { type: 'TOGGLE_AGENT_PAUSE', name: 'Code Builder' });
  expect(next.agents.find((a) => a.name === 'Code Builder')?.paused).toBe(true);
  expect(next.agents.find((a) => a.name === 'UI Designer')?.paused).toBeUndefined();
  const restored = reducer(next, { type: 'TOGGLE_AGENT_PAUSE', name: 'Code Builder' });
  expect(restored.agents.find((a) => a.name === 'Code Builder')?.paused).toBe(false);
});

it('TOGGLE_AGENT_PAUSE on an unknown name is a no-op', () => {
  const next = reducer(initialState, { type: 'TOGGLE_AGENT_PAUSE', name: 'Nobody' });
  expect(next.agents).toEqual(initialState.agents);
});

it('REACTIVATE_AGENT moves an idle agent into the active roster, selects it, and raises the burn rate (mirrors spawn)', () => {
  const next = reducer(initialState, { type: 'REACTIVATE_AGENT', name: 'Web Scraper' });
  expect(next.idleList.map((i) => i.name)).toEqual(['Doc Helper']);
  expect(next.agents.map((a) => a.name)).toContain('Web Scraper');
  expect(next.selected).toBe('Web Scraper');
  expect(next.rate).toBe(Math.min(168000, initialState.rate + 18000));
});

it('REACTIVATE_AGENT on a name not in idleList is a no-op', () => {
  const next = reducer(initialState, { type: 'REACTIVATE_AGENT', name: 'Nobody' });
  expect(next).toBe(initialState);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- reducer`
Expected: FAIL — `TOGGLE_AGENT_PAUSE`/`REACTIVATE_AGENT` aren't valid `Action` types yet.

- [ ] **Step 3: Update the import line in src/state/reducer.ts**

Change:

```ts
import { runCommand } from '../components/terminal/commands';
```

to:

```ts
import { makeAgent, runCommand } from '../components/terminal/commands';
```

- [ ] **Step 4: Add the two new actions to the `Action` union**

Add these two members (anywhere in the union, e.g. next to `NEW_PROJECT`):

```ts
| { type: 'TOGGLE_AGENT_PAUSE'; name: string }
| { type: 'REACTIVATE_AGENT'; name: string }
```

- [ ] **Step 5: Add the two `switch` cases**

```ts
case 'TOGGLE_AGENT_PAUSE':
  return {
    ...state,
    agents: state.agents.map((a) => (a.name === action.name ? { ...a, paused: !a.paused } : a)),
  };

case 'REACTIVATE_AGENT': {
  const hit = state.idleList.find((i) => i.name === action.name);
  if (!hit) return state;
  return {
    ...state,
    idleList: state.idleList.filter((i) => i.name !== action.name),
    agents: [...state.agents, makeAgent(hit.name)],
    selected: hit.name,
    rate: Math.min(168000, state.rate + 18000),
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- reducer`
Expected: PASS, 13 tests (9 existing + 4 new).

- [ ] **Step 7: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (60 total), 0 type errors.

- [ ] **Step 8: Commit**

```bash
git add src/state/reducer.ts src/state/reducer.test.ts
git commit -m "feat: add TOGGLE_AGENT_PAUSE and REACTIVATE_AGENT reducer actions"
```

---

### Task 2: Agents view derivation math (agentsMath.ts)

The one piece of new pure logic this view needs: which agent counts as "selected" (falling back sensibly when `state.selected` is `null` or points at an agent that no longer exists — e.g. it was just terminated), which approvals belong to a given agent, and a small status-label helper shared by the roster and detail panels.

**Files:**
- Create: `src/components/agents/agentsMath.ts`
- Test: `src/components/agents/agentsMath.test.ts`

**Interfaces:**
- Consumes: `Agent`, `Approval` from `../../state/types`.
- Produces: `pickSelectedAgent(agents: Agent[], selected: string | null): Agent | null`, `agentApprovals(approvals: Approval[], agentName: string): Approval[]`, `agentStatusLabel(agent: Agent): 'PAUSED' | 'ACTIVE'` — consumed by Task 3's `AgentRosterCard`, Task 4's `AgentDetailCard`, and Task 5's `AgentsView`.

- [ ] **Step 1: Write the failing tests**

`src/components/agents/agentsMath.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { agentApprovals, agentStatusLabel, pickSelectedAgent } from './agentsMath';
import { initialState } from '../../state/initialState';

describe('pickSelectedAgent', () => {
  it('returns the agent matching state.selected when present', () => {
    const agent = pickSelectedAgent(initialState.agents, 'Database Agent');
    expect(agent?.name).toBe('Database Agent');
  });

  it('falls back to the first agent when selected is null', () => {
    const agent = pickSelectedAgent(initialState.agents, null);
    expect(agent?.name).toBe(initialState.agents[0].name);
  });

  it('falls back to the first agent when selected no longer exists (e.g. just terminated)', () => {
    const agent = pickSelectedAgent(initialState.agents, 'Nonexistent Agent');
    expect(agent?.name).toBe(initialState.agents[0].name);
  });

  it('returns null when there are no agents at all', () => {
    expect(pickSelectedAgent([], 'Anything')).toBeNull();
  });
});

describe('agentApprovals', () => {
  it('filters the approval queue down to one agent', () => {
    const result = agentApprovals(initialState.approvals, 'Code Builder');
    expect(result).toHaveLength(1);
    expect(result[0].agent).toBe('Code Builder');
  });

  it('returns an empty array for an agent with no pending approvals', () => {
    expect(agentApprovals(initialState.approvals, 'Test Runner')).toEqual([]);
  });
});

describe('agentStatusLabel', () => {
  it('labels a paused agent PAUSED and an unpaused (or unset) agent ACTIVE', () => {
    expect(agentStatusLabel({ ...initialState.agents[0], paused: true })).toBe('PAUSED');
    expect(agentStatusLabel({ ...initialState.agents[0], paused: false })).toBe('ACTIVE');
    expect(agentStatusLabel(initialState.agents[0])).toBe('ACTIVE');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- agentsMath`
Expected: FAIL — `agentsMath.ts` doesn't exist yet.

- [ ] **Step 3: Implement src/components/agents/agentsMath.ts**

```ts
import type { Agent, Approval } from '../../state/types';

export function pickSelectedAgent(agents: Agent[], selected: string | null): Agent | null {
  if (selected) {
    const match = agents.find((a) => a.name === selected);
    if (match) return match;
  }
  return agents[0] ?? null;
}

export function agentApprovals(approvals: Approval[], agentName: string): Approval[] {
  return approvals.filter((a) => a.agent === agentName);
}

export function agentStatusLabel(agent: Agent): 'PAUSED' | 'ACTIVE' {
  return agent.paused ? 'PAUSED' : 'ACTIVE';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- agentsMath`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/agents/agentsMath.ts src/components/agents/agentsMath.test.ts
git commit -m "feat: add Agents view derivation math (selected-agent fallback, agent approvals, status label)"
```

---

### Task 3: Agent Roster card (active roster + idle pool)

Left rail of the Agents view. Every active agent is a selectable row (avatar/name/thin progress bar/status dot, same visual language as `ActiveAgentsCard`), plus a "SPAWN +" button reusing the existing `spawn` command. Below it, the idle pool (`state.idleList`) with a "REACTIVATE" button per entry.

**Files:**
- Create: `src/components/agents/AgentRosterCard.tsx`

**Interfaces:**
- Consumes: `useAetherStore()`; `agentStatusLabel` from `./agentsMath`; `colors`, `fonts` from `../../styles/tokens`.
- Produces: `AgentRosterCard({ selectedName }: { selectedName: string | null })` — mounted by Task 5's `AgentsView`.

No new unit-testable logic — verify via dev server.

- [ ] **Step 1: Implement src/components/agents/AgentRosterCard.tsx**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { agentStatusLabel } from './agentsMath';

export function AgentRosterCard({ selectedName }: { selectedName: string | null }) {
  const { state, dispatch } = useAetherStore();

  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>AGENT ROSTER</div>
        <span onClick={() => dispatch({ type: 'RUN_COMMAND', raw: 'spawn' })} style={spawnButtonStyle}>
          SPAWN +
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {state.agents.map((a) => {
          const on = a.name === selectedName;
          const status = agentStatusLabel(a);
          const statusC = status === 'PAUSED' ? colors.warn : colors.success;
          return (
            <div key={a.name} onClick={() => dispatch({ type: 'SELECT_AGENT', name: a.name })} style={rowStyle(on)}>
              <span style={avatarStyle(a.hue)}>{a.i}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={nameStyle}>{a.name}</span>
                  <span style={{ font: `700 11px/1 ${fonts.mono}`, color: a.hue }}>{Math.round(a.pct)}%</span>
                </div>
                <div style={trackStyle}>
                  <div style={{ height: '100%', width: `${Math.round(a.pct)}%`, background: a.hue, boxShadow: `0 0 8px ${a.hue}` }} />
                </div>
              </div>
              <span style={{ ...statusDotStyle, background: statusC, boxShadow: `0 0 6px ${statusC}` }} title={status} />
            </div>
          );
        })}
        {!state.agents.length && <div style={emptyStyle}>no active agents — spawn one to get started</div>}
      </div>

      <div style={idleHeaderStyle}>IDLE ({state.idleList.length})</div>
      <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10, maxHeight: 140, overflow: 'auto' }}>
        {state.idleList.map((i) => (
          <div key={i.name} style={idleRowStyle}>
            <div style={{ minWidth: 0 }}>
              <div style={idleNameStyle}>{i.name}</div>
              <div style={{ font: `400 10px/1 ${fonts.mono}`, color: colors.textDim, marginTop: 3 }}>last active {i.last}</div>
            </div>
            <span onClick={() => dispatch({ type: 'REACTIVATE_AGENT', name: i.name })} style={reactivateButtonStyle}>
              REACTIVATE
            </span>
          </div>
        ))}
        {!state.idleList.length && <div style={emptyStyle}>no idle agents</div>}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  width: 300,
  flex: 'none',
  padding: 15,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const spawnButtonStyle: CSSProperties = {
  cursor: 'pointer',
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: 1,
  color: colors.accentCyanSoft,
  padding: '4px 9px',
  borderRadius: 6,
  border: '1px solid rgba(95,220,255,.35)',
};
function rowStyle(on: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 9px',
    borderRadius: 9,
    cursor: 'pointer',
    background: on ? 'rgba(23,184,216,.14)' : undefined,
    border: on ? '1px solid rgba(95,220,255,.4)' : '1px solid transparent',
  };
}
function avatarStyle(hue: string): CSSProperties {
  return {
    width: 30,
    height: 30,
    flex: 'none',
    borderRadius: 8,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 5px,#123f4e 5px 10px)',
    border: `1px solid ${hue}`,
    display: 'grid',
    placeItems: 'center',
    font: `700 11px/1 ${fonts.mono}`,
    color: hue,
  };
}
const nameStyle: CSSProperties = {
  font: `600 13px/1 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const trackStyle: CSSProperties = { height: 4, borderRadius: 2, background: 'rgba(20,50,64,.7)', overflow: 'hidden', marginTop: 5 };
const statusDotStyle: CSSProperties = { width: 7, height: 7, borderRadius: '50%', flex: 'none' };
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
const idleHeaderStyle: CSSProperties = {
  flex: 'none',
  font: `600 10px/1 ${fonts.ui}`,
  letterSpacing: 3,
  color: colors.textDim,
  marginTop: 16,
  paddingTop: 12,
  borderTop: `1px solid ${colors.chromeBorder}`,
};
const idleRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '8px 9px',
  borderRadius: 9,
  border: '1px solid rgba(80,190,220,.16)',
  background: 'rgba(6,20,28,.5)',
};
const idleNameStyle: CSSProperties = {
  font: `600 12px/1 ${fonts.ui}`,
  color: colors.textSecondary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const reactivateButtonStyle: CSSProperties = {
  flex: 'none',
  cursor: 'pointer',
  font: `600 9px/1 ${fonts.ui}`,
  letterSpacing: 1,
  color: colors.accentCyanSoft,
  padding: '5px 8px',
  borderRadius: 6,
  border: '1px solid rgba(95,220,255,.35)',
};
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/agents/AgentRosterCard.tsx
git commit -m "feat: build the Agents view roster card (active agents + idle pool)"
```

---

### Task 4: Agent Detail card

Right panel of the Agents view. Shows the selected agent's header (avatar/name/task/status), a larger progress bar with ETA, a token-draw sparkline (`spark(agent.hist)`, same SVG-polyline pattern `SystemOverviewCard` already uses), the file list, any approvals tied to this specific agent (reusing `RESOLVE_APPROVAL` and the same Approve/Deny visual treatment `TopBar.tsx` ships), and Pause/Resume + Terminate actions. Renders an honest empty state when no agent is selected (e.g. the roster is empty).

**Files:**
- Create: `src/components/agents/AgentDetailCard.tsx`

**Interfaces:**
- Consumes: `useAetherStore()`; `agentApprovals`, `agentStatusLabel` from `./agentsMath`; `spark` from `../../utils/format`; `colors`, `fonts` from `../../styles/tokens`; `Agent` type from `../../state/types`.
- Produces: `AgentDetailCard({ agent }: { agent: Agent | null })` — mounted by Task 5's `AgentsView`.

No new unit-testable logic (the math it uses is already tested in Task 2) — verify via dev server.

- [ ] **Step 1: Implement src/components/agents/AgentDetailCard.tsx**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { spark } from '../../utils/format';
import type { Agent } from '../../state/types';
import { agentApprovals, agentStatusLabel } from './agentsMath';

export function AgentDetailCard({ agent }: { agent: Agent | null }) {
  const { state, dispatch } = useAetherStore();

  if (!agent) {
    return (
      <div style={cardStyle}>
        <div style={emptyWrapStyle}>
          <div style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textSecondary }}>NO AGENT SELECTED</div>
          <div style={{ marginTop: 8, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textMuted }}>
            Spawn an agent or reactivate one from the idle pool to see it here.
          </div>
        </div>
      </div>
    );
  }

  const status = agentStatusLabel(agent);
  const statusC = status === 'PAUSED' ? colors.warn : colors.success;
  const approvals = agentApprovals(state.approvals, agent.name);

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={avatarStyle(agent.hue)}>{agent.i}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: `700 18px/1 ${fonts.ui}`, color: colors.textPrimary }}>{agent.name}</div>
          <div style={taskStyle}>{agent.task}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 11px/1 ${fonts.mono}`, color: statusC }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusC, boxShadow: `0 0 8px ${statusC}` }} />
          {status}
        </div>
      </div>

      <div style={trackStyle}>
        <div style={{ height: '100%', width: `${Math.round(agent.pct)}%`, background: agent.hue, boxShadow: `0 0 10px ${agent.hue}` }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
        <span style={{ font: `700 13px/1 ${fonts.mono}`, color: agent.hue }}>{Math.round(agent.pct)}% complete</span>
        <span style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>ETA {agent.eta}</span>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={sectionLabelStyle}>TOKEN DRAW</div>
        <svg viewBox="0 0 62 22" preserveAspectRatio="none" style={{ width: '100%', height: 44, marginTop: 7, display: 'block' }}>
          <polyline
            points={spark(agent.hist)}
            fill="none"
            stroke={agent.hue}
            strokeWidth={1.4}
            strokeLinejoin="round"
            style={{ filter: `drop-shadow(0 0 3px ${agent.hue})` }}
          />
        </svg>
      </div>

      <div style={filesWrapStyle}>
        <div style={sectionLabelStyle}>FILES</div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {agent.files.map((f, idx) => (
            <div key={idx} style={{ display: 'flex', gap: 8, font: `400 12px/1.5 ${fonts.mono}` }}>
              <span style={{ color: f.c, flex: 'none' }}>{f.s}</span>
              <span style={{ color: colors.textSecondary }}>{f.n}</span>
            </div>
          ))}
          {!agent.files.length && <div style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>no files touched yet</div>}
        </div>
      </div>

      {!!approvals.length && (
        <div style={{ marginTop: 16 }}>
          <div style={sectionLabelStyle}>PENDING AUTHORIZATION</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {approvals.map((ap) => (
              <div key={ap.id} style={apprRowStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ font: `600 12px/1.3 ${fonts.ui}`, color: colors.textPrimary }}>{ap.action}</span>
                  <span style={riskBadgeStyle(ap.risk)}>{ap.risk}</span>
                </div>
                <div style={{ font: `400 10px/1.5 ${fonts.mono}`, color: colors.textMuted, marginTop: 4 }}>{ap.detail}</div>
                <div style={{ display: 'flex', gap: 7, marginTop: 8 }}>
                  <span onClick={() => dispatch({ type: 'RESOLVE_APPROVAL', id: ap.id, approve: true })} style={approveBtnStyle}>
                    APPROVE
                  </span>
                  <span onClick={() => dispatch({ type: 'RESOLVE_APPROVAL', id: ap.id, approve: false })} style={denyBtnStyle}>
                    DENY
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 'auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, paddingTop: 16 }}>
        <span onClick={() => dispatch({ type: 'TOGGLE_AGENT_PAUSE', name: agent.name })} style={secondaryActionStyle}>
          {status === 'PAUSED' ? '▶ RESUME' : '⏸ PAUSE'}
        </span>
        <span onClick={() => dispatch({ type: 'RUN_COMMAND', raw: `kill ${agent.name}` })} style={dangerActionStyle}>
          ✕ TERMINATE
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
const emptyWrapStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
};
function avatarStyle(hue: string): CSSProperties {
  return {
    width: 46,
    height: 46,
    flex: 'none',
    borderRadius: 10,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 5px,#123f4e 5px 10px)',
    border: `1px solid ${hue}`,
    display: 'grid',
    placeItems: 'center',
    font: `700 15px/1 ${fonts.mono}`,
    color: hue,
  };
}
const taskStyle: CSSProperties = {
  marginTop: 4,
  font: `400 12px/1.4 ${fonts.ui}`,
  color: colors.textMuted,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const trackStyle: CSSProperties = { height: 6, borderRadius: 3, background: 'rgba(20,50,64,.7)', overflow: 'hidden', marginTop: 18 };
const sectionLabelStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
const filesWrapStyle: CSSProperties = { marginTop: 16, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' };
const apprRowStyle: CSSProperties = {
  padding: '10px 11px',
  borderRadius: 9,
  border: '1px solid rgba(80,190,220,.2)',
  background: 'rgba(9,28,38,.7)',
};
function riskBadgeStyle(risk: 'HIGH' | 'MED' | 'LOW'): CSSProperties {
  const c = risk === 'HIGH' ? colors.danger : risk === 'MED' ? colors.warn : colors.success;
  return { flex: 'none', font: `600 8px/1 ${fonts.ui}`, letterSpacing: 1, color: c, border: `1px solid ${c}55`, padding: '3px 6px', borderRadius: 4 };
}
const approveBtnStyle: CSSProperties = {
  flex: 1,
  textAlign: 'center',
  cursor: 'pointer',
  font: `600 10px/1 ${fonts.ui}`,
  letterSpacing: 1.5,
  color: colors.success,
  border: '1px solid rgba(59,224,160,.45)',
  padding: '7px 0',
  borderRadius: 6,
  background: 'rgba(59,224,160,.08)',
};
const denyBtnStyle: CSSProperties = {
  flex: 1,
  textAlign: 'center',
  cursor: 'pointer',
  font: `600 10px/1 ${fonts.ui}`,
  letterSpacing: 1.5,
  color: colors.dangerSoft,
  border: '1px solid rgba(255,120,120,.4)',
  padding: '7px 0',
  borderRadius: 6,
  background: 'rgba(255,90,90,.06)',
};
const secondaryActionStyle: CSSProperties = {
  textAlign: 'center',
  cursor: 'pointer',
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: 1.5,
  color: '#bff4ff',
  border: '1px solid rgba(95,220,255,.45)',
  padding: '10px 0',
  borderRadius: 8,
  background: 'rgba(23,184,216,.1)',
};
const dangerActionStyle: CSSProperties = {
  textAlign: 'center',
  cursor: 'pointer',
  font: `600 11px/1 ${fonts.ui}`,
  letterSpacing: 1.5,
  color: colors.dangerSoft,
  border: '1px solid rgba(255,120,120,.4)',
  padding: '10px 0',
  borderRadius: 8,
  background: 'rgba(255,90,90,.06)',
};
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/agents/AgentDetailCard.tsx
git commit -m "feat: build the Agents view detail card (progress, sparkline, files, approvals, pause/terminate)"
```

---

### Task 5: Agents view composition + registry wiring

Composes the roster and detail cards using `pickSelectedAgent` to decide which agent's detail to show, then flips the `Agents` view-registry entry from `null` to the real component.

**Files:**
- Create: `src/components/agents/AgentsView.tsx`
- Modify: `src/viewRegistry.ts`
- Modify: `src/viewRegistry.test.ts`

**Interfaces:**
- Consumes: `useAetherStore()`; `pickSelectedAgent` from `./agentsMath`; `AgentRosterCard`, `AgentDetailCard`.
- Produces: `AgentsView()` — registered in `viewRegistry.ts`, completing the Agents slice.

- [ ] **Step 1: Implement src/components/agents/AgentsView.tsx**

```tsx
import type { CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { pickSelectedAgent } from './agentsMath';
import { AgentRosterCard } from './AgentRosterCard';
import { AgentDetailCard } from './AgentDetailCard';

export function AgentsView() {
  const { state } = useAetherStore();
  const selectedAgent = pickSelectedAgent(state.agents, state.selected);

  return (
    <div style={rootStyle}>
      <AgentRosterCard selectedName={selectedAgent?.name ?? null} />
      <AgentDetailCard agent={selectedAgent} />
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
```

- [ ] **Step 2: Wire Agents into the registry**

In `src/viewRegistry.ts`, add the import and flip the entry:

```ts
import { AgentsView } from './components/agents/AgentsView';
// ...
{ id: 'Agents', inTopBar: true, inSidebar: true, component: AgentsView },
```

- [ ] **Step 3: Update src/viewRegistry.test.ts**

The existing `'getViewComponent returns null for ids with no built component'` test doesn't assert anything about `'Agents'`, so it needs no change. Add a new test confirming Agents now resolves:

```ts
it('getViewComponent resolves Agents now that it is built', () => {
  expect(getViewComponent('Agents')).not.toBeNull();
});
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (61 total: 60 from Tasks 1–2 + 1 new here), 0 type errors, build succeeds.

- [ ] **Step 5: Verify via dev server**

Run: `npm run dev`. Click the Agents tab (top bar or sidebar): the roster + detail two-column layout renders, the first agent is selected by default, clicking other roster rows swaps the detail panel, the idle pool shows both seeded idle agents.

- [ ] **Step 6: Commit**

```bash
git add src/components/agents/AgentsView.tsx src/viewRegistry.ts src/viewRegistry.test.ts
git commit -m "feat: compose the Agents view and wire it into the view registry"
```

---

### Task 6: Sidebar "Recent Agents" — make it live and clickable

Per the Global Constraints fidelity fix: `Sidebar.tsx`'s `RECENT_AGENTS` is currently a hardcoded, non-interactive array. This task replaces it with a live slice of `state.agents` and wires each row to select that agent and navigate to the new Agents view.

**Files:**
- Modify: `src/components/layout/Sidebar.tsx`

**Interfaces:**
- Consumes: `useAetherStore()` (already imported in this file).
- No new exports — internal behavior change only.

No new unit-testable logic — verify via dev server.

- [ ] **Step 1: Remove the hardcoded RECENT_AGENTS constant**

Delete:

```ts
const RECENT_AGENTS = [
  { i: 'CB', label: 'Code Builder', ring: '#7ef0ff' },
  { i: 'UI', label: 'UI Designer', ring: '#8ab6ff' },
  { i: 'DB', label: 'Database Agent', ring: '#5fffe0' },
  { i: 'TR', label: 'Test Runner', ring: '#7fd8ef' },
];
```

- [ ] **Step 2: Replace the "RECENT AGENTS" render block**

Change:

```tsx
<div style={{ ...sectionLabelStyle, marginTop: 14 }}>RECENT AGENTS</div>
{RECENT_AGENTS.map((r) => (
  <div key={r.i} style={recentRowStyle}>
    <span style={recentAvatarStyle(r.ring)}>{r.i}</span>
    <span style={{ font: `500 13px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textSecondary }}>{r.label}</span>
  </div>
))}
```

to:

```tsx
<div style={{ ...sectionLabelStyle, marginTop: 14 }}>RECENT AGENTS</div>
{state.agents.slice(0, 4).map((a) => (
  <div
    key={a.name}
    onClick={() => {
      dispatch({ type: 'SELECT_AGENT', name: a.name });
      dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Agents' });
    }}
    style={recentRowStyle}
  >
    <span style={recentAvatarStyle(a.hue)}>{a.i}</span>
    <span style={{ font: `500 13px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textSecondary }}>{a.name}</span>
  </div>
))}
{!state.agents.length && <div style={{ font: `400 11px/1 ${fonts.ui}`, color: colors.textDim, padding: '2px 10px' }}>no active agents</div>}
```

- [ ] **Step 3: Make each row clickable**

Update `recentRowStyle` to add `cursor: 'pointer'`:

```ts
const recentRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderRadius: 8, cursor: 'pointer' };
```

(`recentAvatarStyle`, `dispatch` destructuring from `useAetherStore()`, and everything else in the file are unchanged — `dispatch` is already pulled from `useAetherStore()` at the top of `Sidebar()`.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b`
Expected: exits 0. (Confirms removing `RECENT_AGENTS` didn't leave any dangling references, e.g. to the unused `r.ring`/`r.label`/`r.i` shape.)

- [ ] **Step 5: Verify via dev server**

Run: `npm run dev`. Confirm the sidebar's "Recent Agents" section shows real agent names/avatars from the live roster (not the old hardcoded 4), and clicking one navigates to Agents view with that agent selected in the detail panel. Spawn a new agent from Terminal or Dashboard and confirm the sidebar list can now include it (once within the first 4).

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/Sidebar.tsx
git commit -m "fix: make Sidebar's Recent Agents list live and clickable, routing to the new Agents view"
```

---

### Task 7: Final integration QA

**Files:** none (verification-only task).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (61/61), 0 type errors, build succeeds.

- [ ] **Step 2: Manual QA checklist**

Run: `npm run dev`, open the browser.

- [ ] Clicking the top bar's or sidebar's "Agents" entry shows the two-column roster + detail layout; the first agent in `state.agents` is selected by default with no prior interaction.
- [ ] Clicking a different roster row swaps the detail panel to that agent (task, pct, ETA, sparkline, files all update); the previously-selected row loses its highlight and the new one gains it.
- [ ] Click "⏸ PAUSE" on the selected agent — the detail panel's status flips to PAUSED, the roster row's status dot turns amber, and (waiting a few ticks) that agent's `pct` stops advancing while other agents' keep climbing. Click "▶ RESUME" — it starts advancing again.
- [ ] Click "✕ TERMINATE" on the selected agent — it disappears from the active roster and reappears in the Idle pool as "last active just now"; the detail panel automatically falls back to showing another active agent (or the "NO AGENT SELECTED" empty state if none remain).
- [ ] Click "REACTIVATE" on an idle agent — it moves into the active roster, becomes the selected agent in the detail panel (fresh task `"Initializing…"`, empty file list growing over the next few ticks), and the idle pool shrinks by one.
- [ ] If an agent shown has a pending approval (spawn a few agents and wait for the simulation tick to generate one, or check `Code Builder`/`Database Agent`'s seeded approvals), confirm the "PENDING AUTHORIZATION" section appears in that agent's detail panel with working APPROVE/DENY buttons, and that resolving it here also clears it from the TopBar's approval queue (same underlying `state.approvals`).
- [ ] Sidebar's "Recent Agents" section reflects the live roster and clicking an entry navigates to Agents view with that agent selected.
- [ ] "SPAWN AGENT" from Terminal's rail, Dashboard's hero card, and this view's own "SPAWN +" button all still work and the new agent appears in this view's roster.
- [ ] Reload the page — confirm the previously-selected agent is still shown in the Agents view detail panel (i.e. `state.selected` survived the reload). Check `src/state/persistence.ts`'s `savePersisted` whitelist: if `selected` isn't included, add it now as a small unplanned fix within this task's own verification scope (same "the persistence whitelist is easy to miss" precedent as the Dashboard plan's Task 7).
- [ ] Confirm no regressions elsewhere: Terminal, Dashboard, and all remaining `ComingSoonPanel` tabs still route and highlight correctly.

- [ ] **Step 3: Commit any fix from Step 2's persistence check, if needed**

If `selected` needed to be added to `src/state/persistence.ts`'s whitelist during Step 2, commit that as its own small fix:

```bash
git add src/state/persistence.ts
git commit -m "fix: persist the selected agent across reloads"
```

If no fix was needed, skip this step.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-18-agents-view.md`. Executed via the same per-task pipeline as the prior two plans: a fresh implementer subagent per task, a fresh reviewer subagent (spec compliance + code quality) before commit, then one whole-branch review after all tasks land.

### Critical Files for Implementation
- C:\Users\Matt\projects\aether-os\src\state\reducer.ts
- C:\Users\Matt\projects\aether-os\src\components\agents\agentsMath.ts
- C:\Users\Matt\projects\aether-os\src\components\agents\AgentsView.tsx
- C:\Users\Matt\projects\aether-os\src\viewRegistry.ts
- C:\Users\Matt\projects\aether-os\src\components\layout\Sidebar.tsx
