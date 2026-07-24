# Real Dispatch Token/Tool-Use History (Phase 3, slice 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture real `tokens`/`toolUses`/`durationMs` at the moment a dispatch completes, store it keyed by `toolUseId`, and surface it in Analytics (a new card, recently-completed dispatches ranked by token burn), Memory (a usage line on completion-triggered entries), and Chat (a sentence in the retrospective dispatch-channel prompt).

**Architecture:** `applyLinesToOpenDispatches` gains one new **optional** parameter (an out-array the caller passes in to receive completions with usage stats) — zero change to its existing return type or its 12 existing tests. The reducer's new `RECORD_DISPATCH_USAGE` action and `state.dispatchUsage` field are built **before** the electron-layer threading that dispatches it, so no task ever typechecks against an action that doesn't exist yet. `liveAgentTracker.tick()`'s return shape changes to `{open, completed}`; `main.ts` keeps `agents:snapshot` unchanged and adds a new `agents:completed` IPC event. Every consumer (Memory's detail card, Chat's system prompt, Analytics' new card) looks the usage data up **at render/prompt-build time**, never at creation time, avoiding any ordering dependency between this new pipeline and the existing renderer-diff mechanism slices 5/6 already built for Memory/Chat creation.

**Tech Stack:** Same as the existing project — React 18, Vite 5, TypeScript 5 (strict), Vitest, Electron. No new dependencies.

## Global Constraints

- Project root: `C:\Users\Matt\projects\aether-os` (already scaffolded; this plan extends it).
- Full design spec: `docs/superpowers/specs/2026-07-24-real-agents-dispatch-usage-phase3-slice7-design.md` (commit `09eab9f`) — this plan implements it task-by-task; consult it for the "why" behind any decision below.
- **`applyLinesToOpenDispatches`'s existing return type and all 12 existing tests in `liveAgentsMath.test.ts` must remain byte-for-byte unaffected.** The new capability is added via an optional third parameter only.
- **No change to the existing `SET_REAL_AGENTS`-driven renderer-diff mechanism** (`detectCompletedDispatches`, slices 5/6's Memory-creation and dispatch-channel-creation logic) beyond adding `toolUseId` to the memory object it already builds. The new `RECORD_DISPATCH_USAGE` action and `dispatchUsage` state field are a fully independent, parallel pipeline.
- **`dispatchUsage` is capped at 100 entries**, independent of `recentCompletedDispatches`'s 20-item cap. Eviction relies on `Object.keys()` preserving insertion order for non-integer-like string keys (`toolUseId` values are never plain-integer strings) — document this assumption with a code comment where it's used, since it's a subtle correctness dependency.
- **No UI display for Chat's dispatch channels** — enrichment there is prompt-only, one additional sentence in `buildDispatchPrompt`, no visible stat line.
- **Only `MemoryDetailCard.tsx` gets the usage enrichment, not `MemoryRosterCard.tsx`** — the roster's existing compact row (badge + name + strength) has no room for it and doesn't show `content` either; this is a deliberate scope decision, not an oversight.
- **Analytics' three existing cards (`TopCommandsCard`/`SystemMetricsCard`/`LogFrequencyCard`) are untouched** — only `AgentBreakdownCard`'s sibling grid layout changes to fit a fifth card, and `AgentBreakdownCard` itself is untouched (this slice adds a new, second card, not a further redesign of that one).
- **No electron-layer test coverage** for `liveAgentTracker.ts`/`main.ts`/`preload.ts` changes, matching this project's established precedent — verify via `tsc -b`/`build` only.
- **Task ordering is deliberate:** state/reducer work (Task 2) lands before electron-layer threading (Task 3), even though the design doc introduced them in the reverse order, specifically so `useRealAgentsSync.ts`'s new `dispatch({ type: 'RECORD_DISPATCH_USAGE', ... })` call always typechecks against an `Action` union that already includes it — no task should ever leave `tsc -b` failing on a forward reference.
- Match established visual/style conventions exactly: inline `CSSProperties` consts, `colors`/`fonts` tokens, the exact row/avatar/name/desc idiom `AgentBreakdownCard.tsx` already established for real-dispatch-data cards.
- Run `npm test`, `npx tsc -b`, and `npm run build` clean before every commit. Baseline going into this plan: **329 passing tests across 28 files** (confirmed via `npm test` immediately before this plan was written).

---

## File Structure

```
aether-os/
  src/
    state/
      liveAgentsMath.ts        MODIFIED — CompletedDispatchUsage type, optional completedOut param
      liveAgentsMath.test.ts   MODIFIED — new tests for the above
      types.ts                  MODIFIED — DispatchUsage interface, AetherState.dispatchUsage, MemoryStub.toolUseId
      initialState.ts            MODIFIED — seed dispatchUsage: {}
      reducer.ts                  MODIFIED — RECORD_DISPATCH_USAGE action, toolUseId on created memories
      reducer.test.ts             MODIFIED — tests for the above
      persistence.ts                MODIFIED — dispatchUsage whitelist entry
      useRealAgentsSync.ts           MODIFIED — subscribe to agents.onCompleted
    components/
      memory/
        MemoryDetailCard.tsx         MODIFIED — usage line
      chat/
        systemPrompt.ts               MODIFIED — usage sentence in buildDispatchPrompt
        systemPrompt.test.ts          MODIFIED — tests for the above
      analytics/
        analyticsMath.ts               MODIFIED — computeCompletedDispatchBurn
        analyticsMath.test.ts          MODIFIED — tests for the above
        TokenBurnCard.tsx                NEW — the new Analytics card
        AnalyticsView.tsx                MODIFIED — grid layout + new card
  electron/
    liveAgentTracker.ts          MODIFIED — LiveAgentTick shape, threads completedOut through
    main.ts                       MODIFIED — pushes agents:completed
    preload.ts                     MODIFIED — agents.onCompleted
  src/
    aetherElectron.d.ts             MODIFIED — agents.onCompleted type declaration
```

---

### Task 1: Pure logic — capture usage stats in `applyLinesToOpenDispatches`

**Files:**
- Modify: `src/state/liveAgentsMath.ts`
- Modify: `src/state/liveAgentsMath.test.ts`

**Interfaces:**
- Produces: `CompletedDispatchUsage` (extends `RealAgentDispatch` with `tokens`/`toolUses`/`durationMs`), `applyLinesToOpenDispatches`'s new optional third parameter — consumed by Task 3's `liveAgentTracker.ts`.

- [ ] **Step 1: Write the failing tests**

Add a new helper function to `src/state/liveAgentsMath.test.ts`, immediately after the existing `completionLine` function:

```ts
function completionLineWithUsage(toolUseId: string, tokens: number, toolUses: number, durationMs: number, status = 'completed'): string {
  return JSON.stringify({
    type: 'user',
    origin: { kind: 'task-notification' },
    message: {
      content: `<task-notification><task-id>t1</task-id><tool-use-id>${toolUseId}</tool-use-id><status>${status}</status><summary>done</summary><usage><subagent_tokens>${tokens}</subagent_tokens><tool_uses>${toolUses}</tool_uses><duration_ms>${durationMs}</duration_ms></usage></task-notification>`,
    },
  });
}
```

Update the import line from:

```ts
import { applyLinesToOpenDispatches, type RealAgentDispatch } from './liveAgentsMath';
```

to:

```ts
import { applyLinesToOpenDispatches, type RealAgentDispatch, type CompletedDispatchUsage } from './liveAgentsMath';
```

Append to the end of the file (after the existing `describe('applyLinesToOpenDispatches', ...)` block's closing `});`):

```ts

describe('applyLinesToOpenDispatches — completedOut parameter', () => {
  it('is fully backward compatible: omitting completedOut behaves identically to before', () => {
    const lines = [dispatchLine('tu_1', 'general-purpose', 'Explore the repo', '2026-07-20T10:00:00.000Z'), completionLine('tu_1')];
    expect(applyLinesToOpenDispatches([], lines)).toEqual([]);
  });

  it('captures usage stats for a dispatch that opens and completes across two calls', () => {
    const openResult = applyLinesToOpenDispatches([], [dispatchLine('tu_1', 'general-purpose', 'Explore the repo', '2026-07-20T10:00:00.000Z')]);
    const completedOut: CompletedDispatchUsage[] = [];
    applyLinesToOpenDispatches(openResult, [completionLineWithUsage('tu_1', 12345, 8, 194546)], completedOut);
    expect(completedOut).toHaveLength(1);
    expect(completedOut[0]).toMatchObject({
      toolUseId: 'tu_1',
      subagentType: 'general-purpose',
      description: 'Explore the repo',
      tokens: 12345,
      toolUses: 8,
      durationMs: 194546,
    });
  });

  it('captures usage stats for a dispatch that opens and completes within the same batch of lines', () => {
    const lines = [
      dispatchLine('tu_1', 'general-purpose', 'Explore the repo', '2026-07-20T10:00:00.000Z'),
      completionLineWithUsage('tu_1', 500, 2, 1000),
    ];
    const completedOut: CompletedDispatchUsage[] = [];
    applyLinesToOpenDispatches([], lines, completedOut);
    expect(completedOut).toHaveLength(1);
    expect(completedOut[0]).toMatchObject({ toolUseId: 'tu_1', tokens: 500, toolUses: 2, durationMs: 1000 });
  });

  it('defaults missing or malformed usage sub-fields to 0', () => {
    const malformedLine = JSON.stringify({
      type: 'user',
      origin: { kind: 'task-notification' },
      message: {
        content: '<task-notification><task-id>t1</task-id><tool-use-id>tu_1</tool-use-id><status>completed</status><summary>done</summary></task-notification>',
      },
    });
    const openResult = applyLinesToOpenDispatches([], [dispatchLine('tu_1', 'general-purpose', 'desc', '2026-07-20T10:00:00.000Z')]);
    const completedOut: CompletedDispatchUsage[] = [];
    applyLinesToOpenDispatches(openResult, [malformedLine], completedOut);
    expect(completedOut).toHaveLength(1);
    expect(completedOut[0]).toMatchObject({ tokens: 0, toolUses: 0, durationMs: 0 });
  });

  it('does not push a completedOut entry for a completion event whose tool-use-id is not currently open', () => {
    const completedOut: CompletedDispatchUsage[] = [];
    applyLinesToOpenDispatches([], [completionLineWithUsage('unknown_id', 100, 1, 500)], completedOut);
    expect(completedOut).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- liveAgentsMath`
Expected: FAIL — `CompletedDispatchUsage` isn't exported yet, and `applyLinesToOpenDispatches` doesn't accept a third argument.

- [ ] **Step 3: Implement the change in `src/state/liveAgentsMath.ts`**

Add the new type immediately after the existing `RealAgentDispatch` interface:

```ts
export interface CompletedDispatchUsage extends RealAgentDispatch {
  tokens: number;
  toolUses: number;
  durationMs: number;
}
```

Change the function signature from:

```ts
export function applyLinesToOpenDispatches(currentOpen: RealAgentDispatch[], rawLines: string[]): RealAgentDispatch[] {
```

to:

```ts
export function applyLinesToOpenDispatches(
  currentOpen: RealAgentDispatch[],
  rawLines: string[],
  completedOut?: CompletedDispatchUsage[],
): RealAgentDispatch[] {
```

Change the completion-handling branch from:

```ts
    if (json.type === 'user' && json.origin && json.origin.kind === 'task-notification') {
      const content = typeof json.message?.content === 'string' ? json.message.content : '';
      const match = content.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
      if (match) open.delete(match[1]);
    }
```

to:

```ts
    if (json.type === 'user' && json.origin && json.origin.kind === 'task-notification') {
      const content = typeof json.message?.content === 'string' ? json.message.content : '';
      const match = content.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
      if (match) {
        const dispatch = open.get(match[1]);
        if (dispatch && completedOut) {
          const tokensMatch = content.match(/<subagent_tokens>(\d+)<\/subagent_tokens>/);
          const toolUsesMatch = content.match(/<tool_uses>(\d+)<\/tool_uses>/);
          const durationMatch = content.match(/<duration_ms>(\d+)<\/duration_ms>/);
          completedOut.push({
            ...dispatch,
            tokens: tokensMatch ? Number(tokensMatch[1]) : 0,
            toolUses: toolUsesMatch ? Number(toolUsesMatch[1]) : 0,
            durationMs: durationMatch ? Number(durationMatch[1]) : 0,
          });
        }
        open.delete(match[1]);
      }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- liveAgentsMath`
Expected: PASS (22 tests: 12 existing `applyLinesToOpenDispatches` + 5 existing `detectCompletedDispatches` + 5 new).

- [ ] **Step 5: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (334 total: 329 + 5 new), 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/state/liveAgentsMath.ts src/state/liveAgentsMath.test.ts
git commit -m "feat: capture real token/tool-use/duration stats on dispatch completion"
```

---

### Task 2: State + reducer — `RECORD_DISPATCH_USAGE`, `dispatchUsage`, memory `toolUseId`

Lands before the electron-layer threading (Task 3) so that task's new dispatch call always typechecks against an `Action` union that already includes it.

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/reducer.ts`
- Modify: `src/state/reducer.test.ts`
- Modify: `src/state/persistence.ts`

**Interfaces:**
- Consumes: `CompletedDispatchUsage` (Task 1).
- Produces: `DispatchUsage` type, `state.dispatchUsage: Record<string, DispatchUsage>`, `MemoryStub.toolUseId?: string`, `{ type: 'RECORD_DISPATCH_USAGE'; completed: CompletedDispatchUsage[] }` action — consumed by Task 3 and Tasks 4/5/6.

- [ ] **Step 1: Add `DispatchUsage` and extend `AetherState`/`MemoryStub` in `src/state/types.ts`**

Add, immediately after the existing `MemoryStub` interface:

```ts
export interface DispatchUsage {
  tokens: number;
  toolUses: number;
  durationMs: number;
}
```

Change `MemoryStub` from:

```ts
export interface MemoryStub {
  id: number;
  name: string;
  content: string;
  source: string;
  ts: string;
  pinned: boolean;
  strength: number;
}
```

to:

```ts
export interface MemoryStub {
  id: number;
  name: string;
  content: string;
  source: string;
  ts: string;
  pinned: boolean;
  strength: number;
  toolUseId?: string;
}
```

Change `AetherState`'s last field from:

```ts
  recentCompletedDispatches: RealAgentDispatch[];
  dispatchChannels: DispatchChannelStub[];
}
```

to:

```ts
  recentCompletedDispatches: RealAgentDispatch[];
  dispatchChannels: DispatchChannelStub[];
  dispatchUsage: Record<string, DispatchUsage>;
}
```

- [ ] **Step 2: Seed `dispatchUsage` in `src/state/initialState.ts`**

Change the file's last three lines from:

```ts
  recentCompletedDispatches: [],
  dispatchChannels: [],
};
```

to:

```ts
  recentCompletedDispatches: [],
  dispatchChannels: [],
  dispatchUsage: {},
};
```

- [ ] **Step 3: Write the failing reducer tests**

Change the existing test (inside `describe('SET_REAL_AGENTS memory creation', ...)`) from:

```ts
    it('creates a memory sourced from the real dispatch when it disappears from realAgents', () => {
      const withOpenDispatch = { ...initialState, realAgents: [completedDispatch] };
      const next = reducer(withOpenDispatch, { type: 'SET_REAL_AGENTS', agents: [] });
      expect(next.memories).toHaveLength(withOpenDispatch.memories.length + 1);
      const created = next.memories.at(-1);
      expect(created?.source).toBe('general-purpose');
      expect(created?.name).toBe('Explore the repo');
      expect(created?.content).toBe('general-purpose dispatch completed: Explore the repo');
      expect(created?.pinned).toBe(false);
      expect(created?.strength).toBe(100);
    });
```

to:

```ts
    it('creates a memory sourced from the real dispatch when it disappears from realAgents', () => {
      const withOpenDispatch = { ...initialState, realAgents: [completedDispatch] };
      const next = reducer(withOpenDispatch, { type: 'SET_REAL_AGENTS', agents: [] });
      expect(next.memories).toHaveLength(withOpenDispatch.memories.length + 1);
      const created = next.memories.at(-1);
      expect(created?.source).toBe('general-purpose');
      expect(created?.name).toBe('Explore the repo');
      expect(created?.content).toBe('general-purpose dispatch completed: Explore the repo');
      expect(created?.pinned).toBe(false);
      expect(created?.strength).toBe(100);
      expect(created?.toolUseId).toBe('tu_1');
    });
```

Append to `src/state/reducer.test.ts`, inside the `describe('reducer', ...)` block, immediately before its closing `});` at the end of the file:

```ts

  describe('RECORD_DISPATCH_USAGE', () => {
    it('merges one completion into dispatchUsage, keyed by toolUseId', () => {
      const next = reducer(initialState, {
        type: 'RECORD_DISPATCH_USAGE',
        completed: [
          {
            toolUseId: 'tu_1',
            subagentType: 'general-purpose',
            description: 'desc',
            startedAt: '2026-07-20T10:00:00.000Z',
            prompt: '',
            model: null,
            tokens: 1234,
            toolUses: 5,
            durationMs: 6789,
          },
        ],
      });
      expect(next.dispatchUsage['tu_1']).toEqual({ tokens: 1234, toolUses: 5, durationMs: 6789 });
    });

    it('merges multiple completions in one action, preserving existing entries', () => {
      const withOne = { ...initialState, dispatchUsage: { tu_0: { tokens: 1, toolUses: 1, durationMs: 1 } } };
      const next = reducer(withOne, {
        type: 'RECORD_DISPATCH_USAGE',
        completed: [
          { toolUseId: 'tu_1', subagentType: 'a', description: '', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null, tokens: 100, toolUses: 2, durationMs: 300 },
          { toolUseId: 'tu_2', subagentType: 'b', description: '', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null, tokens: 400, toolUses: 5, durationMs: 600 },
        ],
      });
      expect(Object.keys(next.dispatchUsage)).toEqual(['tu_0', 'tu_1', 'tu_2']);
      expect(next.dispatchUsage['tu_1']).toEqual({ tokens: 100, toolUses: 2, durationMs: 300 });
      expect(next.dispatchUsage['tu_2']).toEqual({ tokens: 400, toolUses: 5, durationMs: 600 });
    });

    it('caps dispatchUsage at 100 entries, evicting the oldest first', () => {
      const existing = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`old_${i}`, { tokens: i, toolUses: 1, durationMs: 1 }]));
      const withFull = { ...initialState, dispatchUsage: existing };
      const next = reducer(withFull, {
        type: 'RECORD_DISPATCH_USAGE',
        completed: [{ toolUseId: 'new_1', subagentType: 'a', description: '', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null, tokens: 1, toolUses: 1, durationMs: 1 }],
      });
      expect(Object.keys(next.dispatchUsage)).toHaveLength(100);
      expect(next.dispatchUsage['old_0']).toBeUndefined();
      expect(next.dispatchUsage['old_1']).toBeDefined();
      expect(next.dispatchUsage['new_1']).toBeDefined();
    });
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test -- reducer`
Expected: FAIL — `RECORD_DISPATCH_USAGE` isn't a valid `Action` yet, and the memory-creation test's new `toolUseId` assertion fails since the reducer doesn't set it yet.

- [ ] **Step 5: Add the new `Action` union member in `src/state/reducer.ts`**

Add the import for `CompletedDispatchUsage` — change:

```ts
import { detectCompletedDispatches, type RealAgentDispatch } from './liveAgentsMath';
```

to:

```ts
import { detectCompletedDispatches, type CompletedDispatchUsage, type RealAgentDispatch } from './liveAgentsMath';
```

Change the `Action` union's last two members from:

```ts
  | { type: 'CREATE_DISPATCH_CHANNEL'; toolUseId: string }
  | { type: 'REMOVE_DISPATCH_CHANNEL'; toolUseId: string };
```

to:

```ts
  | { type: 'CREATE_DISPATCH_CHANNEL'; toolUseId: string }
  | { type: 'REMOVE_DISPATCH_CHANNEL'; toolUseId: string }
  | { type: 'RECORD_DISPATCH_USAGE'; completed: CompletedDispatchUsage[] };
```

- [ ] **Step 6: Add `toolUseId` to the memory object built in the `SET_REAL_AGENTS` case**

Change:

```ts
        memories = [
          ...memories,
          {
            id: memSeq,
            name: label,
            content: `${dispatch.subagentType} dispatch completed: ${dispatch.description || 'no description'}`,
            source: dispatch.subagentType,
            ts: nowShort(),
            pinned: false,
            strength: 100,
          },
        ];
```

to:

```ts
        memories = [
          ...memories,
          {
            id: memSeq,
            name: label,
            content: `${dispatch.subagentType} dispatch completed: ${dispatch.description || 'no description'}`,
            source: dispatch.subagentType,
            ts: nowShort(),
            pinned: false,
            strength: 100,
            toolUseId: dispatch.toolUseId,
          },
        ];
```

- [ ] **Step 7: Add the `RECORD_DISPATCH_USAGE` case**

Add, immediately after the existing `REMOVE_DISPATCH_CHANNEL` case (before `SELECT_REAL_AGENT`):

```ts

    case 'RECORD_DISPATCH_USAGE': {
      let dispatchUsage = state.dispatchUsage;
      for (const c of action.completed) {
        dispatchUsage = { ...dispatchUsage, [c.toolUseId]: { tokens: c.tokens, toolUses: c.toolUses, durationMs: c.durationMs } };
      }
      const keys = Object.keys(dispatchUsage);
      if (keys.length > 100) {
        // Object.keys() preserves insertion order for non-integer-like string
        // keys (toolUseId values are never plain-integer strings) -- relied on
        // here to evict the oldest entries first, not a random subset.
        const toEvict = new Set(keys.slice(0, keys.length - 100));
        dispatchUsage = Object.fromEntries(Object.entries(dispatchUsage).filter(([k]) => !toEvict.has(k)));
      }
      return { ...state, dispatchUsage };
    }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -- reducer`
Expected: PASS.

- [ ] **Step 9: Add `dispatchUsage` to the persistence whitelist in `src/state/persistence.ts`**

Change:

```ts
      recentCompletedDispatches: state.recentCompletedDispatches,
      dispatchChannels: state.dispatchChannels,
    };
```

to:

```ts
      recentCompletedDispatches: state.recentCompletedDispatches,
      dispatchChannels: state.dispatchChannels,
      dispatchUsage: state.dispatchUsage,
    };
```

- [ ] **Step 10: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (337 total: 334 + 3 new `RECORD_DISPATCH_USAGE` tests; the modified memory-creation test doesn't change the count), 0 type errors.

- [ ] **Step 11: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/state/reducer.ts src/state/reducer.test.ts src/state/persistence.ts
git commit -m "feat: add RECORD_DISPATCH_USAGE action and dispatchUsage state, tag memories with toolUseId"
```

---

### Task 3: Electron threading — `liveAgentTracker.ts`, `main.ts`, `preload.ts`, `aetherElectron.d.ts`, `useRealAgentsSync.ts`

**Files:**
- Modify: `electron/liveAgentTracker.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/aetherElectron.d.ts`
- Modify: `src/state/useRealAgentsSync.ts`

**Interfaces:**
- Consumes: `CompletedDispatchUsage` (Task 1), the `RECORD_DISPATCH_USAGE` action (Task 2 — already valid by the time this task's `useRealAgentsSync.ts` change dispatches it).
- Produces: `window.aetherElectron.agents.onCompleted(callback)` — no further task depends on this one beyond Tasks 4/5/6 already depending on Task 2's state.

- [ ] **Step 1: Update `electron/liveAgentTracker.ts`**

Change the import from:

```ts
import { applyLinesToOpenDispatches, type RealAgentDispatch } from '../src/state/liveAgentsMath';
```

to:

```ts
import { applyLinesToOpenDispatches, type RealAgentDispatch, type CompletedDispatchUsage } from '../src/state/liveAgentsMath';
```

Replace the entire file body after the import with:

```ts

export interface LiveAgentTick {
  open: RealAgentDispatch[];
  completed: CompletedDispatchUsage[];
}

export function createLiveAgentTracker(projectsRoot: string) {
  let currentFile: string | null = null;
  let currentOffset = 0;
  let currentOpen: RealAgentDispatch[] = [];

  return {
    async tick(): Promise<LiveAgentTick> {
      const activeFile = await findMostRecentSessionFile(projectsRoot);

      if (activeFile !== currentFile) {
        currentFile = activeFile;
        currentOffset = 0;
        currentOpen = [];
        if (!activeFile) return { open: currentOpen, completed: [] };
        const { lines, newOffset } = await readNewLines(activeFile, 0);
        currentOffset = newOffset;
        const completed: CompletedDispatchUsage[] = [];
        currentOpen = applyLinesToOpenDispatches(currentOpen, lines, completed);
        return { open: currentOpen, completed };
      }

      if (!currentFile) return { open: currentOpen, completed: [] };
      const { lines, newOffset } = await readNewLines(currentFile, currentOffset);
      if (lines.length === 0) return { open: currentOpen, completed: [] };
      currentOffset = newOffset;
      const completed: CompletedDispatchUsage[] = [];
      currentOpen = applyLinesToOpenDispatches(currentOpen, lines, completed);
      return { open: currentOpen, completed };
    },
  };
}
```

- [ ] **Step 2: Update `electron/main.ts`**

Change `tickAndPushAgents` from:

```ts
async function tickAndPushAgents(): Promise<void> {
  if (!mainWindow || agentTickInFlight) return;
  agentTickInFlight = true;
  try {
    const dispatches = await liveAgentTracker.tick();
    mainWindow.webContents.send('agents:snapshot', dispatches);
  } finally {
    agentTickInFlight = false;
  }
}
```

to:

```ts
async function tickAndPushAgents(): Promise<void> {
  if (!mainWindow || agentTickInFlight) return;
  agentTickInFlight = true;
  try {
    const { open, completed } = await liveAgentTracker.tick();
    mainWindow.webContents.send('agents:snapshot', open);
    if (completed.length) mainWindow.webContents.send('agents:completed', completed);
  } finally {
    agentTickInFlight = false;
  }
}
```

- [ ] **Step 3: Update `electron/preload.ts`**

Change the import from:

```ts
import type { RealAgentDispatch } from '../src/state/liveAgentsMath';
```

to:

```ts
import type { RealAgentDispatch, CompletedDispatchUsage } from '../src/state/liveAgentsMath';
```

Change the `agents` block from:

```ts
  agents: {
    onSnapshot: (callback: (dispatches: RealAgentDispatch[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, dispatches: RealAgentDispatch[]) => callback(dispatches);
      ipcRenderer.on('agents:snapshot', listener);
      return () => ipcRenderer.removeListener('agents:snapshot', listener);
    },
  },
```

to:

```ts
  agents: {
    onSnapshot: (callback: (dispatches: RealAgentDispatch[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, dispatches: RealAgentDispatch[]) => callback(dispatches);
      ipcRenderer.on('agents:snapshot', listener);
      return () => ipcRenderer.removeListener('agents:snapshot', listener);
    },
    onCompleted: (callback: (completed: CompletedDispatchUsage[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, completed: CompletedDispatchUsage[]) => callback(completed);
      ipcRenderer.on('agents:completed', listener);
      return () => ipcRenderer.removeListener('agents:completed', listener);
    },
  },
```

- [ ] **Step 4: Update `src/aetherElectron.d.ts`**

Change the import from:

```ts
import type { RealAgentDispatch } from './state/liveAgentsMath';
```

to:

```ts
import type { RealAgentDispatch, CompletedDispatchUsage } from './state/liveAgentsMath';
```

Change the `agents` block from:

```ts
      agents: {
        onSnapshot: (callback: (dispatches: RealAgentDispatch[]) => void) => () => void;
      };
```

to:

```ts
      agents: {
        onSnapshot: (callback: (dispatches: RealAgentDispatch[]) => void) => () => void;
        onCompleted: (callback: (completed: CompletedDispatchUsage[]) => void) => () => void;
      };
```

- [ ] **Step 5: Update `src/state/useRealAgentsSync.ts`**

Replace the entire file:

```ts
import { useEffect } from 'react';
import { useAetherStore } from './store';

export function useRealAgentsSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const agents = window.aetherElectron?.agents;
    if (!agents) return;
    return agents.onSnapshot((dispatches) => {
      dispatch({ type: 'SET_REAL_AGENTS', agents: dispatches });
    });
  }, [dispatch]);

  useEffect(() => {
    const agents = window.aetherElectron?.agents;
    if (!agents) return;
    return agents.onCompleted((completed) => {
      dispatch({ type: 'RECORD_DISPATCH_USAGE', completed });
    });
  }, [dispatch]);
}
```

- [ ] **Step 6: Run the full suite, typecheck, and build**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (337/337, unchanged from Task 2 — this task adds no new unit tests, matching this project's precedent for `electron/*.ts`), 0 type errors, build succeeds. `RECORD_DISPATCH_USAGE` is already a valid `Action` (Task 2 landed first), so `useRealAgentsSync.ts`'s new dispatch call should typecheck cleanly with no transient gap.

- [ ] **Step 7: Commit**

```bash
git add electron/liveAgentTracker.ts electron/main.ts electron/preload.ts src/aetherElectron.d.ts src/state/useRealAgentsSync.ts
git commit -m "feat: thread real dispatch usage stats from the electron tailer to the renderer"
```

---

### Task 4: Memory enrichment — `MemoryDetailCard.tsx`

**Files:**
- Modify: `src/components/memory/MemoryDetailCard.tsx`

**Interfaces:**
- Consumes: `state.dispatchUsage` (Task 2), `memory.toolUseId` (Task 2).

- [ ] **Step 1: Add the usage line**

Change the import block from:

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { MemoryStub } from '../../state/types';
import { STRENGTH_TIER_COLOR } from './memoryMath';

export function MemoryDetailCard({ memory }: { memory: MemoryStub | null }) {
  const { dispatch } = useAetherStore();
```

to:

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { MemoryStub } from '../../state/types';
import { STRENGTH_TIER_COLOR } from './memoryMath';
import { short, fmtElapsed } from '../../utils/format';

export function MemoryDetailCard({ memory }: { memory: MemoryStub | null }) {
  const { state, dispatch } = useAetherStore();
```

Change:

```tsx
  const tierColor = STRENGTH_TIER_COLOR(memory.strength);

  return (
```

to:

```tsx
  const tierColor = STRENGTH_TIER_COLOR(memory.strength);
  const usage = memory.toolUseId ? state.dispatchUsage[memory.toolUseId] : undefined;

  return (
```

Change:

```tsx
      <div style={{ marginTop: 20, flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div style={sectionLabelStyle}>CONTENT</div>
        <div style={{ marginTop: 8, font: `400 13px/1.6 ${fonts.ui}`, color: colors.textBody }}>{memory.content}</div>
      </div>
```

to:

```tsx
      <div style={{ marginTop: 20, flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div style={sectionLabelStyle}>CONTENT</div>
        <div style={{ marginTop: 8, font: `400 13px/1.6 ${fonts.ui}`, color: colors.textBody }}>{memory.content}</div>
        {usage && (
          <div style={{ marginTop: 12, font: `400 11px/1.4 ${fonts.mono}`, color: colors.textDim }}>
            Used {short(usage.tokens)} tokens · {usage.toolUses} tool call{usage.toolUses === 1 ? '' : 's'} · {fmtElapsed(usage.durationMs)}
          </div>
        )}
      </div>
```

- [ ] **Step 2: Run the full suite, typecheck, and build**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (337/337, unchanged — this task adds no new tests, matching this project's precedent for presentational-only components), 0 type errors, build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/memory/MemoryDetailCard.tsx
git commit -m "feat: show real token/tool-use/duration usage on Memory entries sourced from a completed dispatch"
```

---

### Task 5: Chat enrichment — usage sentence in `buildDispatchPrompt`

**Files:**
- Modify: `src/components/chat/systemPrompt.ts`
- Modify: `src/components/chat/systemPrompt.test.ts`

**Interfaces:**
- Consumes: `state.dispatchUsage` (Task 2).

- [ ] **Step 1: Write the failing tests**

Append to `src/components/chat/systemPrompt.test.ts`, inside the `describe('buildSystemPrompt (dispatch channels)', ...)` block, immediately before its closing `});`:

```ts

  it('includes a usage sentence with real tokens/tool-uses/duration when state.dispatchUsage has a matching entry', () => {
    const withUsage: AetherState = { ...dispatchChannelState, dispatchUsage: { tu_1: { tokens: 12345, toolUses: 8, durationMs: 194546 } } };
    const prompt = buildSystemPrompt(dispatchChannel, withUsage);
    expect(prompt).toContain('12,345 tokens');
    expect(prompt).toContain('8 tool calls');
    expect(prompt).toContain('195s');
  });

  it('omits the usage sentence when no matching dispatchUsage entry exists', () => {
    const prompt = buildSystemPrompt(dispatchChannel, dispatchChannelState);
    expect(prompt).not.toContain('tokens across');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- systemPrompt`
Expected: FAIL — `buildDispatchPrompt` doesn't build a usage sentence yet.

- [ ] **Step 3: Implement the change in `src/components/chat/systemPrompt.ts`**

Change `buildDispatchPrompt` from:

```ts
function buildDispatchPrompt(channel: ChatChannel, state: AetherState): string {
  const stub = state.dispatchChannels.find((d) => d.toolUseId === channel.toolUseId);
  if (!stub) {
    return `${FALLBACK_PERSONA.voice} ${referAsInstruction(state.operatorName)}\n\nNo record of this task is available.`;
  }

  return (
    `${FALLBACK_PERSONA.voice} ${referAsInstruction(state.operatorName)}\n\n` +
    `You completed a real task earlier as a Claude Code subagent (type: ${stub.subagentType}). ` +
    `You were asked to: ${stub.prompt || stub.description || 'no task detail was recorded.'}\n\n` +
    `Reply in at most 3 sentences, plain prose only -- no bold, italics, headers, bullet lists, or code fences. ` +
    `Discuss this completed task retrospectively -- you cannot take any further action, spawn/kill/throttle any agent, ` +
    `or change any application setting from this channel.`
  );
}
```

to:

```ts
function buildDispatchPrompt(channel: ChatChannel, state: AetherState): string {
  const stub = state.dispatchChannels.find((d) => d.toolUseId === channel.toolUseId);
  if (!stub) {
    return `${FALLBACK_PERSONA.voice} ${referAsInstruction(state.operatorName)}\n\nNo record of this task is available.`;
  }

  const usage = state.dispatchUsage[stub.toolUseId];
  const usageSentence = usage
    ? ` You used approximately ${usage.tokens.toLocaleString()} tokens across ${usage.toolUses} tool call${usage.toolUses === 1 ? '' : 's'}, taking about ${Math.round(usage.durationMs / 1000)}s.`
    : '';

  return (
    `${FALLBACK_PERSONA.voice} ${referAsInstruction(state.operatorName)}\n\n` +
    `You completed a real task earlier as a Claude Code subagent (type: ${stub.subagentType}). ` +
    `You were asked to: ${stub.prompt || stub.description || 'no task detail was recorded.'}${usageSentence}\n\n` +
    `Reply in at most 3 sentences, plain prose only -- no bold, italics, headers, bullet lists, or code fences. ` +
    `Discuss this completed task retrospectively -- you cannot take any further action, spawn/kill/throttle any agent, ` +
    `or change any application setting from this channel.`
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- systemPrompt`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (339 total: 337 + 2 new), 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/systemPrompt.ts src/components/chat/systemPrompt.test.ts
git commit -m "feat: mention real token/tool-use usage in the dispatch-channel retrospective prompt"
```

---

### Task 6: Analytics enrichment — new "real token burn" card

**Files:**
- Modify: `src/components/analytics/analyticsMath.ts`
- Modify: `src/components/analytics/analyticsMath.test.ts`
- Create: `src/components/analytics/TokenBurnCard.tsx`
- Modify: `src/components/analytics/AnalyticsView.tsx`

**Interfaces:**
- Consumes: `state.recentCompletedDispatches` (already exists, slice 6), `state.dispatchUsage` (Task 2).
- Produces: `computeCompletedDispatchBurn`, `TokenBurnCard` — no other task depends on this one.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/analytics/analyticsMath.test.ts`, at the end of the file:

```ts

describe('computeCompletedDispatchBurn', () => {
  it('sorts by tokens descending and filters out pool entries with no matching usage data', () => {
    const pool = [
      mockRealAgent('tu_1', '2026-07-22T10:00:00.000Z', 'general-purpose', 'low'),
      mockRealAgent('tu_2', '2026-07-22T10:00:00.000Z', 'Explore', 'high'),
      mockRealAgent('tu_3', '2026-07-22T10:00:00.000Z', 'fork', 'no-usage-yet'),
    ];
    const usage = {
      tu_1: { tokens: 1000, toolUses: 2, durationMs: 5000 },
      tu_2: { tokens: 5000, toolUses: 4, durationMs: 10000 },
    };
    const rows = computeCompletedDispatchBurn(pool, usage);
    expect(rows.map((r) => r.toolUseId)).toEqual(['tu_2', 'tu_1']);
  });

  it('respects the display limit', () => {
    const pool = Array.from({ length: 10 }, (_, i) => mockRealAgent(`tu_${i}`, '2026-07-22T10:00:00.000Z'));
    const usage = Object.fromEntries(pool.map((d, i) => [d.toolUseId, { tokens: i, toolUses: 1, durationMs: 1000 }]));
    expect(computeCompletedDispatchBurn(pool, usage, 5)).toHaveLength(5);
  });

  it('returns an empty array for an empty pool', () => {
    expect(computeCompletedDispatchBurn([], {})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- analyticsMath`
Expected: FAIL — `computeCompletedDispatchBurn` doesn't exist yet.

- [ ] **Step 3: Implement `computeCompletedDispatchBurn` in `src/components/analytics/analyticsMath.ts`**

Append to the end of the file:

```ts

export interface CompletedDispatchBurnRow {
  toolUseId: string;
  subagentType: string;
  description: string;
  tokens: number;
  toolUses: number;
  durationMs: number;
}

export function computeCompletedDispatchBurn(
  pool: RealAgentDispatch[],
  usage: Record<string, { tokens: number; toolUses: number; durationMs: number }>,
  limit = 5,
): CompletedDispatchBurnRow[] {
  return pool
    .filter((d) => usage[d.toolUseId])
    .map((d) => ({
      toolUseId: d.toolUseId,
      subagentType: d.subagentType,
      description: d.description,
      tokens: usage[d.toolUseId].tokens,
      toolUses: usage[d.toolUseId].toolUses,
      durationMs: usage[d.toolUseId].durationMs,
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, limit);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- analyticsMath`
Expected: PASS.

- [ ] **Step 5: Create `src/components/analytics/TokenBurnCard.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { short, fmtElapsed } from '../../utils/format';
import { computeCompletedDispatchBurn } from './analyticsMath';

export function TokenBurnCard() {
  const { state } = useAetherStore();
  const rows = computeCompletedDispatchBurn(state.recentCompletedDispatches, state.dispatchUsage);

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>REAL TOKEN BURN</div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r) => (
          <div key={r.toolUseId} style={rowStyle}>
            <span style={avatarStyle}>{r.subagentType.slice(0, 2).toUpperCase()}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={nameStyle}>{r.subagentType}</div>
              <div style={descStyle}>{r.description}</div>
            </div>
            <div style={{ flex: 'none', textAlign: 'right' }}>
              <div style={{ font: `700 13px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>{short(r.tokens)} tok</div>
              <div style={{ marginTop: 2, font: `400 10px/1 ${fonts.mono}`, color: colors.textDim }}>
                {r.toolUses} calls · {fmtElapsed(r.durationMs)}
              </div>
            </div>
          </div>
        ))}
        {!rows.length && <div style={emptyStyle}>no completed dispatches with real usage data yet</div>}
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
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
const avatarStyle: CSSProperties = {
  width: 26,
  height: 26,
  flex: 'none',
  borderRadius: 7,
  display: 'grid',
  placeItems: 'center',
  font: `700 10px/1 ${fonts.mono}`,
  color: colors.accentCyanSoft,
  background: 'rgba(127,216,239,0.12)',
  border: `1px solid ${colors.accentCyanSoft}`,
};
const nameStyle: CSSProperties = {
  font: `600 13px/1 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const descStyle: CSSProperties = {
  marginTop: 2,
  font: `400 11px/1.3 ${fonts.ui}`,
  color: colors.textDim,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
```

- [ ] **Step 6: Wire it into `src/components/analytics/AnalyticsView.tsx`**

Replace the entire file:

```tsx
import type { CSSProperties } from 'react';
import { AgentBreakdownCard } from './AgentBreakdownCard';
import { TopCommandsCard } from './TopCommandsCard';
import { SystemMetricsCard } from './SystemMetricsCard';
import { LogFrequencyCard } from './LogFrequencyCard';
import { TokenBurnCard } from './TokenBurnCard';

export function AnalyticsView() {
  return (
    <div style={gridStyle}>
      <AgentBreakdownCard />
      <TopCommandsCard />
      <SystemMetricsCard />
      <LogFrequencyCard />
      <div style={{ gridColumn: '1 / -1' }}>
        <TokenBurnCard />
      </div>
    </div>
  );
}

const gridStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr auto', gap: 14 };
```

- [ ] **Step 7: Run the full suite, typecheck, and build**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (342 total: 339 + 3 new), 0 type errors, build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/components/analytics/analyticsMath.ts src/components/analytics/analyticsMath.test.ts src/components/analytics/TokenBurnCard.tsx src/components/analytics/AnalyticsView.tsx
git commit -m "feat: add a real token-burn Analytics card for recently-completed dispatches"
```

---

### Task 7: Final integration QA

**Files:** none (verification-only task).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (342/342 — re-derive this number from the actual sequence of test additions across Tasks 1/2/5/6 rather than trusting this plan's own running arithmetic, and flag to the controller if it disagrees), 0 type errors, build succeeds.

- [ ] **Step 2: Manual QA checklist**

Run: `npm run electron:dev`. Triggering a real dispatch completion on demand isn't reliably reproducible (same accepted gap as every real-data-dependent slice so far).

- [ ] Open Analytics — confirm the new "REAL TOKEN BURN" card renders (empty state if no usage data has arrived yet), spans the full width below the existing 2×2 grid, and the other three untouched cards (Top Commands, System Metrics, Log Frequency) plus the existing Longest-Running Agents card all still render correctly.
- [ ] Open Memory — confirm existing entries (kill/HIGH-approval/remember-sourced, none of which have a `toolUseId`) show no usage line, exactly as before this plan.
- [ ] Open Chat — confirm the AETHER channel, an active fictional agent channel, and an archived one all still work exactly as before; if a dispatch channel exists, confirm its prompt still works (with or without a usage sentence, depending on whether real usage data has arrived for it).
- [ ] If a real dispatch happens to complete while the app is open during this QA pass: confirm a Memory entry appears with a usage line, the Analytics card shows it (if a channel or the pool references that `toolUseId`), and — if a dispatch channel exists for it — a chat message in that channel gets a persona reply that can reference the real usage numbers.
- [ ] Confirm no regressions elsewhere: Terminal, Dashboard, Agents, Grid, Projects, Attachments, Uplinks, Settings all still route and highlight correctly.

- [ ] **Step 3: Address any regression found in Step 2**

If Step 2 surfaces a real regression (not a pre-existing, already-documented quirk), fix it and commit separately with a `fix:` message before considering this plan done. If nothing was found, skip this step.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-24-real-agents-dispatch-usage-phase3-slice7.md`. Executed via the same per-task pipeline as prior plans in this repo: a fresh implementer subagent per task, a fresh reviewer subagent (spec compliance + code quality) before commit, then one whole-branch review after all tasks land.

### Critical Files for Implementation
- C:\Users\Matt\projects\aether-os\src\state\liveAgentsMath.ts
- C:\Users\Matt\projects\aether-os\src\state\reducer.ts
- C:\Users\Matt\projects\aether-os\electron\liveAgentTracker.ts
- C:\Users\Matt\projects\aether-os\electron\main.ts
- C:\Users\Matt\projects\aether-os\src\components\memory\MemoryDetailCard.tsx
- C:\Users\Matt\projects\aether-os\src\components\chat\systemPrompt.ts
- C:\Users\Matt\projects\aether-os\src\components\analytics\TokenBurnCard.tsx
- C:\Users\Matt\projects\aether-os\src\components\analytics\AnalyticsView.tsx
