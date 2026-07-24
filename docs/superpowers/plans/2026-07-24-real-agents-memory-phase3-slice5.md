# Real Dispatch Completions in Memory (Phase 3, slice 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a real dispatch disappears from `state.realAgents` (completes), automatically create a Memory entry sourced from its real `subagentType` — the first Memory-creation trigger in this app driven by real data, added alongside the existing fictional triggers (which stay untouched).

**Architecture:** A new pure function, `detectCompletedDispatches`, added to the existing `src/state/liveAgentsMath.ts` (symmetrical to that file's existing `applyLinesToOpenDispatches`) diffs the old vs. new `RealAgentDispatch[]` by `toolUseId` and returns whatever disappeared. The reducer's existing `SET_REAL_AGENTS` case is extended to call it and, for each completed dispatch, append one inline-built `MemoryStub` — matching the exact style of the existing HIGH-risk-approval memory-creation block already in the same file, not a new abstraction.

**Tech Stack:** Same as the existing project — React 18, Vite 5, TypeScript 5 (strict), Vitest. No new dependencies. No electron-layer changes at all.

## Global Constraints

- Project root: `C:\Users\Matt\projects\aether-os` (already scaffolded; this plan extends it).
- Full design spec: `docs/superpowers/specs/2026-07-24-real-agents-memory-phase3-slice5-design.md` (commit `40d43d2`) — this plan implements it task-by-task; consult it for the "why" behind any decision below.
- **Scope for this plan:** `src/state/liveAgentsMath.ts` / `liveAgentsMath.test.ts` (new function + tests), `src/state/reducer.ts` / `reducer.test.ts` (extended `SET_REAL_AGENTS` case + tests). No other files.
- **Do not touch any of the four existing Memory-creation trigger sites** (`reducer.ts`'s `applyApprovalResolution` HIGH-risk block, and `commands.ts`'s `kill`/`remember`/second approve-deny block) — this plan is purely additive.
- **No filtering, dedup, or rate-limiting** of which completions create a memory — every dispatch that disappears from `state.realAgents` creates exactly one `MemoryStub`.
- **No UI changes.** `MemoryRosterCard.tsx`/`MemoryDetailCard.tsx` already render `source` as a free-form string with no special-casing — verify this in Task 1 (do not modify either file).
- **No electron-layer changes.** Do not touch `electron/liveAgentTracker.ts`, `electron/main.ts`, `electron/preload.ts`, or `src/aetherElectron.d.ts`.
- **No new `AetherState` field, no new reducer action, no `persistence.ts` change** — this extends the payload of the existing `SET_REAL_AGENTS` case; `memories`/`memSeq` are already whitelisted.
- **Accepted, deliberately unsolved limitation:** a dispatch that's still genuinely running in a session the user switches away from (the existing "global, most-recently-active session" tracking) will look like it "completed" when it didn't — a known false-positive, not something this plan defends against.
- Memory shape for each completed dispatch, exactly: `{ id: memSeq, name: dispatch.description || dispatch.subagentType, content: \`${dispatch.subagentType} dispatch completed: ${dispatch.description || 'no description'}\`, source: dispatch.subagentType, ts: nowShort(), pinned: false, strength: 100 }`, with `memSeq` incremented once per completion.
- Run `npm test` and `npx tsc -b` clean before every commit. Baseline going into this plan: **301 passing tests across 28 files** (confirmed via `npm test` immediately before this plan was written).

---

## File Structure

```
aether-os/
  src/
    state/
      liveAgentsMath.ts        MODIFIED — new detectCompletedDispatches function
      liveAgentsMath.test.ts   MODIFIED — tests for the above
      reducer.ts                MODIFIED — SET_REAL_AGENTS case extended to create memories
      reducer.test.ts           MODIFIED — tests for the above
```

---

### Task 1: `detectCompletedDispatches` + `SET_REAL_AGENTS` memory creation

Both pieces land in one task — the reducer wiring has no independent value without the pure function, and the pure function's only consumer is this same reducer case; there's no meaningful point to review one without the other.

**Files:**
- Modify: `src/state/liveAgentsMath.ts`
- Modify: `src/state/liveAgentsMath.test.ts`
- Modify: `src/state/reducer.ts`
- Modify: `src/state/reducer.test.ts`

**Interfaces:**
- Consumes: `RealAgentDispatch` (already defined in `liveAgentsMath.ts`: `{ toolUseId, subagentType, description, startedAt, prompt, model }`), `MemoryStub` (already defined in `types.ts`), `nowShort` (already imported in `reducer.ts` from `../utils/format`).
- Produces: `detectCompletedDispatches(oldAgents: RealAgentDispatch[], newAgents: RealAgentDispatch[]): RealAgentDispatch[]` — exported from `liveAgentsMath.ts`, consumed by `reducer.ts`'s `SET_REAL_AGENTS` case within this same task.

- [ ] **Step 1: Write the failing tests for `detectCompletedDispatches`**

Append to `src/state/liveAgentsMath.test.ts` (after the existing `describe('applyLinesToOpenDispatches', ...)` block's closing `});`, as a new top-level `describe`):

```ts
describe('detectCompletedDispatches', () => {
  const tu1: RealAgentDispatch = {
    toolUseId: 'tu_1',
    subagentType: 'general-purpose',
    description: 'first',
    startedAt: '2026-07-20T10:00:00.000Z',
    prompt: '',
    model: null,
  };
  const tu2: RealAgentDispatch = {
    toolUseId: 'tu_2',
    subagentType: 'Explore',
    description: 'second',
    startedAt: '2026-07-20T10:00:05.000Z',
    prompt: '',
    model: null,
  };

  it('returns an empty array when the two lists are identical', () => {
    expect(detectCompletedDispatches([tu1, tu2], [tu1, tu2])).toEqual([]);
  });

  it('returns the one dispatch that disappeared', () => {
    expect(detectCompletedDispatches([tu1, tu2], [tu2])).toEqual([tu1]);
  });

  it('returns multiple dispatches when several disappear at once', () => {
    expect(detectCompletedDispatches([tu1, tu2], [])).toEqual([tu1, tu2]);
  });

  it('returns an empty array when a dispatch is only added, not removed', () => {
    expect(detectCompletedDispatches([tu1], [tu1, tu2])).toEqual([]);
  });

  it('separates a simultaneous add and remove correctly', () => {
    expect(detectCompletedDispatches([tu1], [tu2])).toEqual([tu1]);
  });
});
```

Update this file's import line (line 2) from:

```ts
import { applyLinesToOpenDispatches, type RealAgentDispatch } from './liveAgentsMath';
```

to:

```ts
import { applyLinesToOpenDispatches, detectCompletedDispatches, type RealAgentDispatch } from './liveAgentsMath';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- liveAgentsMath`
Expected: FAIL — `detectCompletedDispatches` is not exported yet.

- [ ] **Step 3: Implement `detectCompletedDispatches`**

Append to `src/state/liveAgentsMath.ts` (after the existing `applyLinesToOpenDispatches` function, at the end of the file):

```ts

export function detectCompletedDispatches(oldAgents: RealAgentDispatch[], newAgents: RealAgentDispatch[]): RealAgentDispatch[] {
  const stillOpen = new Set(newAgents.map((a) => a.toolUseId));
  return oldAgents.filter((a) => !stillOpen.has(a.toolUseId));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- liveAgentsMath`
Expected: PASS (17 tests: 12 existing `applyLinesToOpenDispatches` tests + 5 new).

- [ ] **Step 5: Write the failing tests for `SET_REAL_AGENTS` memory creation**

Add the import to `src/state/reducer.test.ts` (after the existing `import type { Approval } from './types';` line):

```ts
import type { RealAgentDispatch } from './liveAgentsMath';
```

Append to `src/state/reducer.test.ts`, inside the `describe('reducer', ...)` block, immediately before its closing `});` at the end of the file:

```ts

  describe('SET_REAL_AGENTS memory creation', () => {
    const completedDispatch: RealAgentDispatch = {
      toolUseId: 'tu_1',
      subagentType: 'general-purpose',
      description: 'Explore the repo',
      startedAt: '2026-07-20T10:00:00.000Z',
      prompt: '',
      model: null,
    };

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

    it('increments memSeq by exactly the number of dispatches that complete in one action', () => {
      const secondDispatch: RealAgentDispatch = { ...completedDispatch, toolUseId: 'tu_2', subagentType: 'Explore' };
      const withTwoOpen = { ...initialState, realAgents: [completedDispatch, secondDispatch] };
      const next = reducer(withTwoOpen, { type: 'SET_REAL_AGENTS', agents: [] });
      expect(next.memSeq).toBe(withTwoOpen.memSeq + 2);
      expect(next.memories).toHaveLength(withTwoOpen.memories.length + 2);
    });

    it('creates no new memory when nothing completed', () => {
      const withOpenDispatch = { ...initialState, realAgents: [completedDispatch] };
      const next = reducer(withOpenDispatch, { type: 'SET_REAL_AGENTS', agents: [completedDispatch] });
      expect(next.memories).toEqual(withOpenDispatch.memories);
      expect(next.memSeq).toBe(withOpenDispatch.memSeq);
    });

    it('falls back to subagentType and a placeholder when description is empty', () => {
      const noDescription: RealAgentDispatch = { ...completedDispatch, description: '' };
      const withOpenDispatch = { ...initialState, realAgents: [noDescription] };
      const next = reducer(withOpenDispatch, { type: 'SET_REAL_AGENTS', agents: [] });
      const created = next.memories.at(-1);
      expect(created?.name).toBe('general-purpose');
      expect(created?.content).toBe('general-purpose dispatch completed: no description');
    });

    it('preserves existing memories, appending rather than replacing', () => {
      const withOpenDispatch = { ...initialState, realAgents: [completedDispatch] };
      const next = reducer(withOpenDispatch, { type: 'SET_REAL_AGENTS', agents: [] });
      expect(next.memories.slice(0, -1)).toEqual(withOpenDispatch.memories);
    });

    it('still updates realAgents to the new list', () => {
      const withOpenDispatch = { ...initialState, realAgents: [completedDispatch] };
      const next = reducer(withOpenDispatch, { type: 'SET_REAL_AGENTS', agents: [] });
      expect(next.realAgents).toEqual([]);
    });
  });
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npm test -- reducer`
Expected: FAIL — `SET_REAL_AGENTS` currently just replaces `realAgents` and never touches `memories`/`memSeq`, so the new assertions fail.

- [ ] **Step 7: Extend the `SET_REAL_AGENTS` reducer case**

In `src/state/reducer.ts`, add the value import for `detectCompletedDispatches` — change:

```ts
import type { RealAgentDispatch } from './liveAgentsMath';
```

to:

```ts
import { detectCompletedDispatches, type RealAgentDispatch } from './liveAgentsMath';
```

Change the `SET_REAL_AGENTS` case from:

```ts
    case 'SET_REAL_AGENTS':
      return { ...state, realAgents: action.agents };
```

to:

```ts
    case 'SET_REAL_AGENTS': {
      const completed = detectCompletedDispatches(state.realAgents, action.agents);
      let memories = state.memories;
      let memSeq = state.memSeq;
      for (const dispatch of completed) {
        const label = dispatch.description || dispatch.subagentType;
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
        memSeq += 1;
      }
      return { ...state, realAgents: action.agents, memories, memSeq };
    }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -- reducer`
Expected: PASS.

- [ ] **Step 9: Verify no UI file needs changes**

Run: `grep -n "source" src/components/memory/MemoryRosterCard.tsx src/components/memory/MemoryDetailCard.tsx`
Expected output: each file's one existing line rendering `{memory.source}` / `{m.source}` directly as text, with no conditional branching on its value. If either file branches on `source`'s value in a way that would render a real `subagentType` differently or incorrectly, STOP and report BLOCKED — this plan's Global Constraints assume no UI changes are needed.

- [ ] **Step 10: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (312 total: 301 + 5 `liveAgentsMath` + 6 `reducer` new tests), 0 type errors.

- [ ] **Step 11: Commit**

```bash
git add src/state/liveAgentsMath.ts src/state/liveAgentsMath.test.ts src/state/reducer.ts src/state/reducer.test.ts
git commit -m "feat: create a Memory entry sourced from real subagentType when a live dispatch completes"
```

---

### Task 2: Final integration QA

**Files:** none (verification-only task).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (312/312), 0 type errors, build succeeds.

- [ ] **Step 2: Manual QA checklist**

Run: `npm run electron:dev`. Triggering a real dispatch to complete organically during a manual QA window isn't reliably reproducible on demand (same accepted gap as every prior Phase 3 slice's "no real dispatch was actively running to observe") — this checklist confirms no regression in the existing fictional triggers instead, with the new code path's correctness carried by Task 1's unit tests.

- [ ] Open the terminal, run `spawn TestAgent`, then `kill TestAgent` — confirm a new Memory entry appears in the Memory tab with `source: 'TestAgent'`, exactly as before this plan.
- [ ] Trigger a HIGH-risk approval (e.g. via chat's action pipeline or the terminal) and approve it — confirm a new Memory entry appears with `source` set to the fictional agent name, exactly as before this plan.
- [ ] Run `remember test note` in the terminal — confirm a new Memory entry appears with `source: 'operator'`, exactly as before this plan.
- [ ] If a real dispatch happens to complete while the app is open during this QA pass (e.g. from other work happening in another Claude Code session), confirm a new Memory entry appears with `source` equal to that dispatch's real `subagentType` and open its detail card to confirm the content reads sensibly.
- [ ] Confirm no regressions elsewhere: Terminal, Dashboard, Chat, Agents, Grid, Projects, Analytics, Files/Attachments, Uplinks, Settings all still route and highlight correctly.

- [ ] **Step 3: Address any regression found in Step 2**

If Step 2 surfaces a real regression (not a pre-existing, already-documented quirk), fix it and commit separately with a `fix:` message before considering this plan done. If nothing was found, skip this step.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-24-real-agents-memory-phase3-slice5.md`. Executed via the same per-task pipeline as prior plans in this repo: a fresh implementer subagent per task, a fresh reviewer subagent (spec compliance + code quality) before commit, then one whole-branch review after all tasks land.

### Critical Files for Implementation
- C:\Users\Matt\projects\aether-os\src\state\liveAgentsMath.ts
- C:\Users\Matt\projects\aether-os\src\state\reducer.ts
