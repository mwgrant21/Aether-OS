# Real Active Agents in the Agents View (Phase 3, slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Agents view's roster+detail pair (`AgentRosterCard`, `AgentDetailCard`) with real Claude Code `Agent`-dispatch data, the same `state.realAgents` source Terminal and Dashboard already read.

**Architecture:** Extend the existing `RealAgentDispatch` type with two new fields (`prompt`, `model`) read off data the live-tailing pipeline already parses — no new pipeline. Add a new, fully independent selection field (`state.selectedRealAgent`) rather than reusing the fictional-agent-only `state.selected`. Rewrite both cards to read `state.realAgents`, dropping every field/action with no real equivalent (pct, ETA, sparkline, files, approvals, pause, terminate, spawn, idle/reactivate).

**Tech Stack:** TypeScript, React 18, Vitest.

## Global Constraints

- `state.agents`/`tick.ts`/`makeAgent()` and every other view that reads `state.agents` (Grid, Analytics, Files, Memory, Chat) are untouched by this plan — only `src/components/agents/*` and small additive changes to `src/state/*`/`src/state/liveAgentsMath.ts`.
- No pct/ETA progress bar, no token-draw sparkline, no files list, no pending-authorization section, no PAUSE/TERMINATE/SPAWN+/IDLE/REACTIVATE — none of these have a real equivalent for a live subagent dispatch.
- `state.selectedRealAgent` is a new, fully independent field (mirroring `selectedProject`/`selectedMemory`'s existing pattern) — never conflated with `state.selected`, which stays exclusively "which fictional agent," still relied on by `GridView.tsx` and `FilesView.tsx`.
- `state.selectedRealAgent` is NOT added to `persistence.ts`'s save whitelist — a real dispatch's `toolUseId` from a prior session is almost certainly gone by the next app launch.
- `prompt` defaults to `''` when absent from a dispatch's `tool_use.input` (matching `description`'s existing fallback pattern); `model` defaults to `null` (not `''` — genuinely absent is different from an empty string).
- Known, accepted consequence (not to be "fixed" by this plan): once `AgentsView` reads `state.realAgents`, navigating here via Files' file-row click or Grid's node click (both of which set `state.selected` to a fictional agent name before navigating) will land on real dispatch data, not the fictional agent that was clicked. This is expected per the approved design spec, not a defect to patch.
- Baseline before this plan: 299 passing tests across 28 files, clean `tsc -b` (plain, not `--noEmit` — this project's composite tsconfig setup errors on that flag combination), clean `electron:build`, working tree clean (aside from pre-existing unrelated untracked screenshot `.jpg` files in the repo root) at commit `bbb3b03` (the spec commit).

---

## File Structure

| File | Change |
|---|---|
| `src/state/liveAgentsMath.ts` | Add `prompt: string`/`model: string \| null` to `RealAgentDispatch`; parse `item.input.prompt`/`item.input.model` in the existing `tool_use` branch. |
| `src/state/liveAgentsMath.test.ts` | Extend fixtures/assertions to cover the two new fields; add one new test for prompt/model capture. |
| `src/state/types.ts` | Add `selectedRealAgent: string \| null` to `AetherState`. |
| `src/state/initialState.ts` | Seed `selectedRealAgent: null`. |
| `src/state/reducer.ts` | Add `SELECT_REAL_AGENT` action + case. |
| `src/components/agents/agentsMath.ts` | Add `pickSelectedRealAgent` (Task 3, additive). Remove `pickSelectedAgent`/`agentApprovals`/`agentStatusLabel` (Task 6, once their last consumers are gone). |
| `src/components/agents/agentsMath.test.ts` | Add `pickSelectedRealAgent` tests (Task 3). Remove the three now-dead functions' `describe` blocks (Task 6). |
| `src/components/agents/AgentRosterCard.tsx` | Rewrite to read `state.realAgents`, drop SPAWN+/IDLE, dispatch `SELECT_REAL_AGENT`. |
| `src/components/agents/AgentDetailCard.tsx` | Rewrite to accept `RealAgentDispatch \| null`, drop pct/sparkline/files/approvals/actions, add prompt/model display. |
| `src/components/agents/AgentsView.tsx` | Swap `pickSelectedAgent(state.agents, state.selected)` for `pickSelectedRealAgent(state.realAgents, state.selectedRealAgent)`. |

---

### Task 1: Extend `RealAgentDispatch` with `prompt`/`model`

**Files:**
- Modify: `src/state/liveAgentsMath.ts`
- Modify: `src/state/liveAgentsMath.test.ts`

**Interfaces:**
- Produces: `RealAgentDispatch` gains `prompt: string; model: string | null;`. `applyLinesToOpenDispatches`'s signature is unchanged (`(currentOpen: RealAgentDispatch[], rawLines: string[]): RealAgentDispatch[]`), but every returned object now carries the two new fields. Later tasks (4, 5) read `agent.prompt`/`agent.model` from the objects this function returns.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `src/state/liveAgentsMath.test.ts` with:

```typescript
import { describe, expect, it } from 'vitest';
import { applyLinesToOpenDispatches, type RealAgentDispatch } from './liveAgentsMath';

function dispatchLine(
  id: string,
  subagentType: string,
  description: string,
  timestamp: string,
  prompt = '',
  model: string | null = null,
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: {
      content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: subagentType, description, prompt, model } }],
    },
  });
}

function completionLine(toolUseId: string, status = 'completed'): string {
  return JSON.stringify({
    type: 'user',
    origin: { kind: 'task-notification' },
    message: {
      content: `<task-notification><task-id>t1</task-id><tool-use-id>${toolUseId}</tool-use-id><status>${status}</status><summary>done</summary></task-notification>`,
    },
  });
}

describe('applyLinesToOpenDispatches', () => {
  it('adds an open dispatch from an Agent tool_use line', () => {
    const lines = [dispatchLine('tu_1', 'general-purpose', 'Explore the repo', '2026-07-20T10:00:00.000Z')];
    const result = applyLinesToOpenDispatches([], lines);
    expect(result).toEqual<RealAgentDispatch[]>([
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'Explore the repo', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null },
    ]);
  });

  it('captures prompt and model when present in tool_use.input', () => {
    const lines = [
      dispatchLine('tu_1', 'general-purpose', 'Explore the repo', '2026-07-20T10:00:00.000Z', 'Explore the repo and report findings.', 'claude-haiku-4-5'),
    ];
    const result = applyLinesToOpenDispatches([], lines);
    expect(result).toEqual<RealAgentDispatch[]>([
      {
        toolUseId: 'tu_1',
        subagentType: 'general-purpose',
        description: 'Explore the repo',
        startedAt: '2026-07-20T10:00:00.000Z',
        prompt: 'Explore the repo and report findings.',
        model: 'claude-haiku-4-5',
      },
    ]);
  });

  it('removes a dispatch on a matching real task-notification completion', () => {
    const lines = [dispatchLine('tu_1', 'general-purpose', 'Explore the repo', '2026-07-20T10:00:00.000Z'), completionLine('tu_1')];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([]);
  });

  it('removes a dispatch whose completion has status failed or killed, not just completed', () => {
    const lines = [dispatchLine('tu_1', 'general-purpose', 'desc', '2026-07-20T10:00:00.000Z'), completionLine('tu_1', 'failed')];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([]);
  });

  it('ignores queue-operation lines even when their content contains task-notification-shaped XML', () => {
    const queueLine = JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: '<task-notification><task-id>t1</task-id><tool-use-id>tu_1</tool-use-id><status>completed</status></task-notification>',
    });
    const lines = [dispatchLine('tu_1', 'general-purpose', 'desc', '2026-07-20T10:00:00.000Z'), queueLine];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'desc', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null },
    ]);
  });

  it('does not treat an ordinary user message without origin.kind as a completion signal', () => {
    const plainUserLine = JSON.stringify({ type: 'user', message: { content: 'just a normal reply' } });
    const lines = [dispatchLine('tu_1', 'general-purpose', 'desc', '2026-07-20T10:00:00.000Z'), plainUserLine];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'desc', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null },
    ]);
  });

  it('ignores tool_use blocks with a name other than Agent', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-20T10:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/x' } }] },
    });
    expect(applyLinesToOpenDispatches([], [line])).toEqual([]);
  });

  it('leaves other open dispatches alone when only one of several completes', () => {
    const lines = [
      dispatchLine('tu_1', 'general-purpose', 'first', '2026-07-20T10:00:00.000Z'),
      dispatchLine('tu_2', 'Explore', 'second', '2026-07-20T10:00:05.000Z'),
      completionLine('tu_1'),
    ];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([
      { toolUseId: 'tu_2', subagentType: 'Explore', description: 'second', startedAt: '2026-07-20T10:00:05.000Z', prompt: '', model: null },
    ]);
  });

  it('is a safe no-op for a completion event whose tool-use-id is not currently open', () => {
    expect(applyLinesToOpenDispatches([], [completionLine('unknown_id')])).toEqual([]);
  });

  it('skips malformed JSON lines without throwing', () => {
    expect(() => applyLinesToOpenDispatches([], ['not json', '', '   '])).not.toThrow();
    expect(applyLinesToOpenDispatches([], ['not json', '', '   '])).toEqual([]);
  });

  it('continues from a non-empty currentOpen list (incremental tailing)', () => {
    const priorOpen: RealAgentDispatch[] = [
      { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'first', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null },
    ];
    const result = applyLinesToOpenDispatches(priorOpen, [completionLine('tu_1')]);
    expect(result).toEqual([]);
  });

  it('defaults subagentType, description, prompt, and model when input fields are missing', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-20T10:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Agent', input: {} }] },
    });
    expect(applyLinesToOpenDispatches([], [line])).toEqual([
      { toolUseId: 'tu_1', subagentType: 'agent', description: '', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/state/liveAgentsMath.test.ts`
Expected: FAIL — the "captures prompt and model" test and most `toEqual` assertions fail because the implementation doesn't yet produce `prompt`/`model` fields.

- [ ] **Step 3: Update the implementation**

In `src/state/liveAgentsMath.ts`, update the `RealAgentDispatch` interface:

```typescript
export interface RealAgentDispatch {
  toolUseId: string;
  subagentType: string;
  description: string;
  startedAt: string;
  prompt: string;
  model: string | null;
}
```

Update the `open.set(item.id, { ... })` call inside `applyLinesToOpenDispatches` to:

```typescript
          open.set(item.id, {
            toolUseId: item.id,
            subagentType: (item.input && item.input.subagent_type) || 'agent',
            description: (item.input && item.input.description) || '',
            startedAt: json.timestamp || new Date(0).toISOString(),
            prompt: (item.input && item.input.prompt) || '',
            model: (item.input && item.input.model) || null,
          });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/state/liveAgentsMath.test.ts`
Expected: PASS — all 12 tests green.

- [ ] **Step 5: Run the full suite and type checker**

Run: `npm test && npx tsc -b`
Expected: all tests pass (299 baseline + 1 new = 300); `tsc -b` clean.

- [ ] **Step 6: Commit**

```bash
git add src/state/liveAgentsMath.ts src/state/liveAgentsMath.test.ts
git commit -m "feat: add prompt and model fields to RealAgentDispatch"
```

---

### Task 2: Add `selectedRealAgent` state and `SELECT_REAL_AGENT` action

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/reducer.ts`

**Interfaces:**
- Produces: `AetherState.selectedRealAgent: string | null`; action `{ type: 'SELECT_REAL_AGENT'; toolUseId: string }`. Task 3's `pickSelectedRealAgent` and Task 6's `AgentsView.tsx` consume `state.selectedRealAgent`; Task 4's `AgentRosterCard.tsx` dispatches `SELECT_REAL_AGENT`.

No new pure logic in this task — pure state wiring, no new test file.

- [ ] **Step 1: Add the type field**

In `src/state/types.ts`, add `selectedRealAgent: string | null;` to the `AetherState` interface, immediately after the existing `selectedMemory: string | null;` line:

```typescript
  selected: string | null;
  selectedProject: string | null;
  selectedMemory: string | null;
  selectedRealAgent: string | null;
```

- [ ] **Step 2: Seed the initial state**

In `src/state/initialState.ts`, add `selectedRealAgent: null,` immediately after the existing `selectedMemory: null,` line:

```typescript
  selected: null,
  selectedProject: null,
  selectedMemory: null,
  selectedRealAgent: null,
```

- [ ] **Step 3: Add the reducer action**

In `src/state/reducer.ts`, add a new member to the `Action` union, immediately after `| { type: 'SET_REAL_AGENTS'; agents: RealAgentDispatch[] };`:

```typescript
  | { type: 'SET_REAL_AGENTS'; agents: RealAgentDispatch[] }
  | { type: 'SELECT_REAL_AGENT'; toolUseId: string };
```

Add a new case in the `reducer` function's switch statement, immediately after the existing `case 'SET_REAL_AGENTS':` case:

```typescript
    case 'SET_REAL_AGENTS':
      return { ...state, realAgents: action.agents };

    case 'SELECT_REAL_AGENT':
      return { ...state, selectedRealAgent: action.toolUseId };
```

- [ ] **Step 4: Run the full suite and type checker**

Run: `npm test && npx tsc -b`
Expected: all 300 tests pass (no new tests in this task); `tsc -b` clean.

- [ ] **Step 5: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/state/reducer.ts
git commit -m "feat: add selectedRealAgent state and SELECT_REAL_AGENT action"
```

---

### Task 3: Add `pickSelectedRealAgent` selector

**Files:**
- Modify: `src/components/agents/agentsMath.ts`
- Modify: `src/components/agents/agentsMath.test.ts`

**Interfaces:**
- Consumes: `RealAgentDispatch` from `src/state/liveAgentsMath.ts` (Task 1).
- Produces: `pickSelectedRealAgent(agents: RealAgentDispatch[], selected: string | null): RealAgentDispatch | null`. Task 6's `AgentsView.tsx` calls this.

This task is purely additive — `pickSelectedAgent`/`agentApprovals`/`agentStatusLabel` are NOT removed here, even though they'll become unused once Tasks 4-6 land, because `AgentRosterCard.tsx`/`AgentDetailCard.tsx`/`AgentsView.tsx` still import and use them until those later tasks rewrite them. Removing them now would break the build. Task 6 removes them, once it's actually safe.

- [ ] **Step 1: Write the failing tests**

Add this import and `describe` block to `src/components/agents/agentsMath.test.ts` (add the import alongside the existing ones at the top; append the `describe` block after the existing three):

```typescript
import type { RealAgentDispatch } from '../../state/liveAgentsMath';
```

```typescript
describe('pickSelectedRealAgent', () => {
  const fixtures: RealAgentDispatch[] = [
    { toolUseId: 'tu_1', subagentType: 'general-purpose', description: 'first', startedAt: '2026-07-21T10:00:00.000Z', prompt: 'do the first thing', model: null },
    { toolUseId: 'tu_2', subagentType: 'Explore', description: 'second', startedAt: '2026-07-21T10:00:05.000Z', prompt: 'do the second thing', model: 'claude-haiku-4-5' },
  ];

  it('returns the dispatch matching the selected toolUseId when present', () => {
    const agent = pickSelectedRealAgent(fixtures, 'tu_2');
    expect(agent?.toolUseId).toBe('tu_2');
  });

  it('falls back to the first dispatch when selected is null', () => {
    const agent = pickSelectedRealAgent(fixtures, null);
    expect(agent?.toolUseId).toBe('tu_1');
  });

  it('falls back to the first dispatch when selected does not match any current dispatch', () => {
    const agent = pickSelectedRealAgent(fixtures, 'tu_unknown');
    expect(agent?.toolUseId).toBe('tu_1');
  });

  it('returns null when there are no real dispatches at all', () => {
    expect(pickSelectedRealAgent([], 'anything')).toBeNull();
  });
});
```

Also add `pickSelectedRealAgent` to the existing `import { agentApprovals, agentStatusLabel, pickSelectedAgent } from './agentsMath';` line (do not add a second import statement):

```typescript
import { agentApprovals, agentStatusLabel, pickSelectedAgent, pickSelectedRealAgent } from './agentsMath';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/components/agents/agentsMath.test.ts`
Expected: FAIL — `pickSelectedRealAgent is not exported`.

- [ ] **Step 3: Implement `pickSelectedRealAgent`**

Add this to `src/components/agents/agentsMath.ts`, alongside the existing `pickSelectedAgent`. Add the import at the top of the file, alongside the existing `Agent, Approval` import:

```typescript
import type { RealAgentDispatch } from '../../state/liveAgentsMath';
```

```typescript
export function pickSelectedRealAgent(agents: RealAgentDispatch[], selected: string | null): RealAgentDispatch | null {
  if (selected) {
    const match = agents.find((a) => a.toolUseId === selected);
    if (match) return match;
  }
  return agents[0] ?? null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/components/agents/agentsMath.test.ts`
Expected: PASS — all tests in the file green, including the 4 new ones plus the existing `pickSelectedAgent`/`agentApprovals`/`agentStatusLabel` tests (still present, still passing — not removed in this task).

- [ ] **Step 5: Run the full suite and type checker**

Run: `npm test && npx tsc -b`
Expected: 304 tests pass (300 + 4 new); `tsc -b` clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/agents/agentsMath.ts src/components/agents/agentsMath.test.ts
git commit -m "feat: add pickSelectedRealAgent selector"
```

---

### Task 4: Rewrite `AgentRosterCard.tsx`

**Files:**
- Modify: `src/components/agents/AgentRosterCard.tsx`

**Interfaces:**
- Consumes: `state.realAgents: RealAgentDispatch[]` (existing, shipped in Phase 3 slice 1); `fmtElapsed` from `src/utils/format.ts` (existing); `colors`/`fonts` from `../../styles/tokens` (existing).
- Produces: `AgentRosterCard` now takes `{ selectedToolUseId: string | null }` as its prop (renamed from the old `{ selectedName: string | null }`). Task 6's `AgentsView.tsx` passes this new prop name.

This task has no new pure logic — a component rewrite, verified by manual GUI verification in Task 6.

- [ ] **Step 1: Read the current file**

Read `src/components/agents/AgentRosterCard.tsx` in full before editing (required by this project's CLAUDE.md: read before editing).

- [ ] **Step 2: Rewrite the component**

Replace the full contents of `src/components/agents/AgentRosterCard.tsx` with:

```tsx
import { useEffect, useState, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { fmtElapsed } from '../../utils/format';

export function AgentRosterCard({ selectedToolUseId }: { selectedToolUseId: string | null }) {
  const { state, dispatch } = useAetherStore();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>AGENT ROSTER</div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {state.realAgents.map((a) => {
          const on = a.toolUseId === selectedToolUseId;
          return (
            <div key={a.toolUseId} onClick={() => dispatch({ type: 'SELECT_REAL_AGENT', toolUseId: a.toolUseId })} style={rowStyle(on)}>
              <span style={avatarStyle}>{a.subagentType.slice(0, 2).toUpperCase()}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={nameStyle}>{a.subagentType}</span>
                  <span style={{ font: `700 11px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>{fmtElapsed(now - new Date(a.startedAt).getTime())}</span>
                </div>
                <div style={descStyle}>{a.description}</div>
              </div>
            </div>
          );
        })}
        {!state.realAgents.length && <div style={emptyStyle}>no agents currently running</div>}
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
const avatarStyle: CSSProperties = {
  width: 30,
  height: 30,
  flex: 'none',
  borderRadius: 8,
  background: 'repeating-linear-gradient(45deg,#0e3340 0 5px,#123f4e 5px 10px)',
  border: `1px solid ${colors.accentCyanSoft}`,
  display: 'grid',
  placeItems: 'center',
  font: `700 11px/1 ${fonts.mono}`,
  color: colors.accentCyanSoft,
};
const nameStyle: CSSProperties = {
  font: `600 13px/1 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const descStyle: CSSProperties = {
  font: `400 11px/1.3 ${fonts.ui}`,
  color: colors.textDim,
  marginTop: 3,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
```

This reuses `cardStyle`/`titleStyle`/`rowStyle`/`nameStyle`/`emptyStyle` verbatim from the file's current content (preserving the card's existing chrome) — if your Step 1 read shows any of these differ from what's shown here, keep the file's actual current values for these five, not the ones printed above (this project's cards have accumulated small per-file styling differences; do not silently "correct" them). `spawnButtonStyle`/`idleHeaderStyle`/`idleRowStyle`/`idleNameStyle`/`reactivateButtonStyle`/`trackStyle`/`statusDotStyle`/the old `avatarStyle(hue)` function are all removed (no longer used). `avatarStyle` changes from a per-hue function to a fixed constant (matching the fixed-accent-color convention already established for real-data avatars in `ActiveAgentsCard.tsx`/`ActiveAgentsDigest.tsx`). `descStyle` is new, matching `ActiveAgentsCard.tsx`'s `taskStyle` convention for a secondary description line.

- [ ] **Step 3: Run the full suite and type checker**

Run: `npm test && npx tsc -b`
Expected: all 304 tests pass (no test file for this component, matching this project's convention of no tests for presentational card components); `tsc -b` will show an error here, because `AgentsView.tsx` still passes the old `selectedName` prop and `AgentDetailCard.tsx` still expects `Agent | null` — this is expected and resolved by Tasks 5 and 6. Do not attempt to fix `AgentsView.tsx`/`AgentDetailCard.tsx` in this task; confirm instead that the ONLY `tsc` errors are in those two files, not in `AgentRosterCard.tsx` itself.

- [ ] **Step 4: Commit**

```bash
git add src/components/agents/AgentRosterCard.tsx
git commit -m "feat: show real Active Agent dispatches in the Agents view roster"
```

---

### Task 5: Rewrite `AgentDetailCard.tsx`

**Files:**
- Modify: `src/components/agents/AgentDetailCard.tsx`

**Interfaces:**
- Consumes: `RealAgentDispatch` from `src/state/liveAgentsMath.ts` (Task 1); `fmtElapsed` from `src/utils/format.ts` (existing); `colors`/`fonts` from `../../styles/tokens` (existing).
- Produces: `AgentDetailCard` now takes `{ agent: RealAgentDispatch | null }` (changed from `{ agent: Agent | null }`). Task 6's `AgentsView.tsx` passes the result of `pickSelectedRealAgent`.

- [ ] **Step 1: Read the current file**

Read `src/components/agents/AgentDetailCard.tsx` in full before editing.

- [ ] **Step 2: Rewrite the component**

Replace the full contents of `src/components/agents/AgentDetailCard.tsx` with:

```tsx
import { useEffect, useState, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { fmtElapsed } from '../../utils/format';
import type { RealAgentDispatch } from '../../state/liveAgentsMath';

export function AgentDetailCard({ agent }: { agent: RealAgentDispatch | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!agent) {
    return (
      <div style={cardStyle}>
        <div style={emptyWrapStyle}>
          <div style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textSecondary }}>NO AGENT SELECTED</div>
          <div style={{ marginTop: 8, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textMuted }}>
            No agent dispatches are currently running.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={avatarStyle}>{agent.subagentType.slice(0, 2).toUpperCase()}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ font: `700 18px/1 ${fonts.ui}`, color: colors.textPrimary }}>{agent.subagentType}</div>
            {agent.model && <span style={modelBadgeStyle}>{agent.model}</span>}
          </div>
          <div style={descStyle}>{agent.description}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 11px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>
          {fmtElapsed(now - new Date(agent.startedAt).getTime())}
        </div>
      </div>

      <div style={promptWrapStyle}>
        <div style={sectionLabelStyle}>PROMPT</div>
        <div style={promptTextStyle}>{agent.prompt || 'no prompt text available'}</div>
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
const avatarStyle: CSSProperties = {
  width: 46,
  height: 46,
  flex: 'none',
  borderRadius: 10,
  background: 'repeating-linear-gradient(45deg,#0e3340 0 5px,#123f4e 5px 10px)',
  border: `1px solid ${colors.accentCyanSoft}`,
  display: 'grid',
  placeItems: 'center',
  font: `700 15px/1 ${fonts.mono}`,
  color: colors.accentCyanSoft,
};
const descStyle: CSSProperties = {
  marginTop: 4,
  font: `400 12px/1.4 ${fonts.ui}`,
  color: colors.textMuted,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const modelBadgeStyle: CSSProperties = {
  flex: 'none',
  font: `600 9px/1 ${fonts.mono}`,
  letterSpacing: 0.5,
  color: colors.textMuted,
  border: `1px solid ${colors.chipBorder}`,
  padding: '3px 7px',
  borderRadius: 5,
};
const sectionLabelStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
const promptWrapStyle: CSSProperties = { marginTop: 20, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' };
const promptTextStyle: CSSProperties = {
  marginTop: 8,
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  font: `400 13px/1.6 ${fonts.ui}`,
  color: colors.textSecondary,
  whiteSpace: 'pre-wrap',
};
```

This reuses `cardStyle`/`emptyWrapStyle`/`sectionLabelStyle` verbatim from the file's current content (as in Task 4: if your Step 1 read shows these differ from what's printed here, keep the file's actual current values, not these). `trackStyle`/`filesWrapStyle`/`apprRowStyle`/`riskBadgeStyle`/`approveBtnStyle`/`denyBtnStyle`/`secondaryActionStyle`/`dangerActionStyle` are all removed (approval/action-specific, no real equivalent). `avatarStyle` changes from a per-hue function to a fixed constant, matching Task 4's roster card. `modelBadgeStyle`/`promptWrapStyle`/`promptTextStyle` are new. Note this component no longer calls `useAetherStore()` or `dispatch` at all (no actions remain) — do not import `useAetherStore` in this file.

- [ ] **Step 3: Run the full suite and type checker**

Run: `npm test && npx tsc -b`
Expected: all 304 tests pass; `tsc -b` will still show an error in `AgentsView.tsx` only (it still calls `pickSelectedAgent(state.agents, state.selected)` and passes the result — now `Agent | null` — to both rewritten cards, which now expect `RealAgentDispatch | null`/a `selectedToolUseId` prop). Confirm the only remaining `tsc` error is in `AgentsView.tsx`; this is resolved by Task 6.

- [ ] **Step 4: Commit**

```bash
git add src/components/agents/AgentDetailCard.tsx
git commit -m "feat: show real Active Agent dispatch detail in the Agents view"
```

---

### Task 6: Wire `AgentsView.tsx`, remove dead code, manual verification

**Files:**
- Modify: `src/components/agents/AgentsView.tsx`
- Modify: `src/components/agents/agentsMath.ts`
- Modify: `src/components/agents/agentsMath.test.ts`

**Interfaces:**
- Consumes: `pickSelectedRealAgent` (Task 3), the rewritten `AgentRosterCard`/`AgentDetailCard` (Tasks 4-5).
- Produces: nothing new — this is the final integration point.

- [ ] **Step 1: Read the current `AgentsView.tsx`**

Read `src/components/agents/AgentsView.tsx` in full before editing.

- [ ] **Step 2: Rewrite `AgentsView.tsx`**

Replace the full contents of `src/components/agents/AgentsView.tsx` with:

```tsx
import type { CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { pickSelectedRealAgent } from './agentsMath';
import { AgentRosterCard } from './AgentRosterCard';
import { AgentDetailCard } from './AgentDetailCard';

export function AgentsView() {
  const { state } = useAetherStore();
  const selectedAgent = pickSelectedRealAgent(state.realAgents, state.selectedRealAgent);

  return (
    <div style={rootStyle}>
      <AgentRosterCard selectedToolUseId={selectedAgent?.toolUseId ?? null} />
      <AgentDetailCard agent={selectedAgent} />
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
```

(This file's `rootStyle` value should already match — if your Step 1 read shows it differs, keep the file's actual current value.)

- [ ] **Step 3: Run the full suite and type checker to confirm the view compiles**

Run: `npm test && npx tsc -b`
Expected: all 304 tests pass; `tsc -b` is now clean (no remaining errors — `AgentRosterCard`/`AgentDetailCard`/`AgentsView` are all mutually consistent). If `tsc -b` is NOT clean at this point, stop and fix before proceeding to Step 4 — do not remove the dead code below while the build is still broken.

- [ ] **Step 4: Remove the now-dead `pickSelectedAgent`/`agentApprovals`/`agentStatusLabel`**

Confirmed via `grep -r "pickSelectedAgent\|agentApprovals\|agentStatusLabel" src/` (or equivalent) that after Steps 1-3 of this task, these three functions have zero remaining call sites anywhere in `src/` outside their own definition and test files — every consumer (`AgentRosterCard.tsx`, `AgentDetailCard.tsx`, `AgentsView.tsx`) has been rewritten by Tasks 4-6 to no longer use them.

In `src/components/agents/agentsMath.ts`, remove the `pickSelectedAgent`, `agentApprovals`, and `agentStatusLabel` function definitions (and the now-unused `Agent, Approval` import from `../../state/types`, if nothing else in the file still needs it — check before removing the import line itself). Keep `pickSelectedRealAgent` and its `RealAgentDispatch` import.

In `src/components/agents/agentsMath.test.ts`, remove the `describe('pickSelectedAgent', ...)`, `describe('agentApprovals', ...)`, and `describe('agentStatusLabel', ...)` blocks, and remove `agentApprovals, agentStatusLabel, pickSelectedAgent` from the top import line (keep `pickSelectedRealAgent`). Also remove the now-unused `import { initialState } from '../../state/initialState';` line if nothing else in the file references `initialState` after these removals.

- [ ] **Step 5: Run the full suite and type checker**

Run: `npm test && npx tsc -b`
Expected: 297 tests pass (304 minus the 3 removed `describe` blocks' worth of tests: 4 in `pickSelectedAgent`, 2 in `agentApprovals`, 1 in `agentStatusLabel` — 7 tests total, so 304 - 7 = 297). Count the actual removed tests from your Step 1 read of the original three `describe` blocks and confirm the final number matches exactly — don't assume this arithmetic is right without checking against what you actually deleted. `tsc -b` clean.

- [ ] **Step 6: Manual verification**

Run: `npm run dev` (plain browser) or `npm run electron:dev` (if available in your environment).

1. With `state.realAgents` empty (default): confirm the roster shows `"no agents currently running"`, no SPAWN+/IDLE section, and the detail card shows `"NO AGENT SELECTED"` / `"No agent dispatches are currently running."`.
2. If you have access to a real Claude Code session actively dispatching subagents (this session dispatching a research/implementer subagent is sufficient, if your environment can observe it): confirm a real dispatch appears in the roster within about a second, showing its subagent type, elapsed time, and description; clicking it shows the full prompt text in the detail card, and the model badge if the dispatch specified one; the dispatch disappears from the roster (and detail card resets to empty if it was selected) once it actually completes.
3. Confirm Grid, Analytics, Memory, and Chat show zero regression — all four still reference the fictional `state.agents` roster exactly as before.
4. Confirm the known, accepted consequence from the design spec: clicking a file row in Files (or a node in Grid) still correctly sets `state.selected` and navigates to the Agents tab, but the tab now shows real dispatch data rather than the fictional agent's detail — expected, not a bug.

If your environment lacks GUI/browser inspection tooling, note in your report which of the above you could not verify and that it's deferred to the controller — this project's established convention for implementers without visual tooling.

- [ ] **Step 7: Commit**

```bash
git add src/components/agents/AgentsView.tsx src/components/agents/agentsMath.ts src/components/agents/agentsMath.test.ts
git commit -m "feat: wire real Active Agent data into AgentsView; remove dead fictional-agent selectors"
```

---

## Self-Review Notes

**Spec coverage:** Task 1 covers the `RealAgentDispatch` extension (prompt/model, with defaults). Task 2 covers the new independent `selectedRealAgent` state (not persisted, not conflated with `state.selected`). Task 3 covers `pickSelectedRealAgent`, deliberately additive-only to avoid a broken intermediate build. Tasks 4-5 cover both card rewrites, with every removed field/action from the Non-goals section (pct/ETA/sparkline/files/approvals/pause/terminate/spawn/idle/reactivate) explicitly named as removed. Task 6 covers the view wiring, the dead-code removal (only once genuinely safe), and the spec's full manual verification checklist including the explicitly-flagged known Files/Grid navigation consequence. No spec section is without a task.

**Placeholder scan:** no TBD/TODO; every step has complete, runnable code or an exact command with an expected result — including the one place a plan can't know an exact number in advance (Task 6 Step 5's test count), which is handled by telling the implementer exactly how to compute it from what they can observe, not by leaving a vague placeholder.

**Type consistency:** `RealAgentDispatch` (with `prompt`/`model`) is defined once in Task 1 and imported by name in every later task that needs it (Task 3's `agentsMath.ts`/test, Task 5's `AgentDetailCard.tsx`). `pickSelectedRealAgent(agents, selected)`'s signature is identical between its Task 3 test and Task 3 implementation, and consumed identically in Task 6. The `SELECT_REAL_AGENT` action's `toolUseId` field name is consistent between Task 2's reducer case and Task 4's dispatch call. `AgentRosterCard`'s prop rename (`selectedName` → `selectedToolUseId`) is consistent between Task 4's definition and Task 6's call site.
