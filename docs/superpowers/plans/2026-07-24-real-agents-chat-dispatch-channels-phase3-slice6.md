# Post-Mortem Channels for Completed Real Dispatches (Phase 3, slice 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third Chat channel kind, `dispatch`, for a post-mortem conversation about one specific completed real dispatch — manually created via a "+ NEW" picker (or auto-created if a new opt-in Settings toggle is on), permanent until manually removed, using the existing `FALLBACK_PERSONA` voice and a past-tense system prompt built from that dispatch's own real data. Every existing fictional channel, persona, and the action-verb pipeline stay completely untouched for `aether`/`agent` channels.

**Architecture:** Two new `AetherState` fields — a capped rolling pool (`recentCompletedDispatches`, source for the picker) and the actual created channels (`dispatchChannels`) — both populated by extending the `SET_REAL_AGENTS` reducer case a second time (already extended once, by Phase 3 slice 5, to create Memory entries; this plan adds pool/auto-create logic to the same case). Two new reducer actions (`CREATE_DISPATCH_CHANNEL`, `REMOVE_DISPATCH_CHANNEL`) handle the manual path. `chatChannels.ts` merges `dispatchChannels` into the derived channel list; `systemPrompt.ts` gets a new branch building a retrospective prompt from the channel's own stored dispatch data. `ChannelRail.tsx` gains a "+ NEW" picker and a per-row remove control; `ChatView.tsx` wires the new props through. `BudgetAlertsCard.tsx` gets one new boolean toggle, matching its existing `autoThrottle`/`sound` pattern exactly.

**Tech Stack:** Same as the existing project — React 18, Vite 5, TypeScript 5 (strict), Vitest. No new dependencies. No electron-layer changes at all.

## Global Constraints

- Project root: `C:\Users\Matt\projects\aether-os` (already scaffolded; this plan extends it).
- Full design spec: `docs/superpowers/specs/2026-07-24-real-agents-chat-dispatch-channels-phase3-slice6-design.md` (commit `27075fc`) — this plan implements it task-by-task; consult it for the "why" behind any decision below.
- **Correction from the design spec, found while writing this plan (not a design change, a real gap the spec missed):** the spec says `useChatChannels.ts` "needs no changes." That's wrong — `sendMessage`'s existing action-JSON handling (`if (action) { ... }`, calling `buildSafeCommandRaw`/`buildApprovalPayload` from `actionExecutor.ts`) runs unconditionally on every reply, and `actionExecutor.ts` never checks `channel.kind`. A dispatch channel's system prompt never invites the action-JSON convention (per the spec's own Non-goal), but if a reply ever emitted action-shaped JSON anyway (e.g. a model hallucination), nothing today would stop it from creating a bogus approval referencing a fake "agent" name that doesn't exist in `state.agents`. Task 4 below adds a one-line guard (`action && channel.kind !== 'dispatch'`) to close this — the only deviation from the spec's stated file list in this whole plan.
- **Scope for this plan:** `src/state/types.ts`, `src/state/initialState.ts`, `src/state/reducer.ts`/`reducer.test.ts`, `src/state/persistence.ts`, `src/components/chat/chatChannels.ts`/`chatChannels.test.ts`, `src/components/chat/systemPrompt.ts`/`systemPrompt.test.ts`, `src/components/chat/useChatChannels.ts` (one-line guard, see above), `src/components/chat/ChannelRail.tsx`, `src/components/chat/ChatView.tsx`, `src/components/settings/BudgetAlertsCard.tsx`. No other files.
- **No electron-layer changes.** Do not touch `electron/*.ts` or `src/aetherElectron.d.ts`.
- **No changes to any existing fictional-channel behavior, persona content, or the action-verb pipeline for `aether`/`agent` channels.** `personas.ts`, `actionExecutor.ts`, `actionParser.ts`, `commands.ts`, `localResponder.ts` are all untouched.
- **No new persona content** — dispatch channels reuse `FALLBACK_PERSONA.voice` verbatim from `personas.ts` (already exported; do not modify `personas.ts`).
- **No action-verb pipeline in dispatch channels** — the dispatch system prompt never mentions spawn/kill/theme/renderer/throttle, and (per the correction above) `useChatChannels.ts` never attempts to execute one even if a reply contained action-shaped JSON.
- **`recentCompletedDispatches` is capped at 20 entries, most-recent-first** (`[dispatch, ...pool].slice(0, 20)`). **`dispatchChannels` has no cap** — removed only by explicit `REMOVE_DISPATCH_CHANNEL`.
- **`autoCreateDispatchChannels` (new `Cfg` field) defaults to `false`** in `initialState.ts`.
- **`CREATE_DISPATCH_CHANNEL` and the auto-create path in `SET_REAL_AGENTS` must not create a duplicate channel for a `toolUseId` that already has one** — both no-op in that case.
- **`CREATE_DISPATCH_CHANNEL` for a `toolUseId` not present in `state.recentCompletedDispatches` is a no-op**, returning `state` unchanged (same reference), matching this app's established no-op convention (e.g. `RESOLVE_APPROVAL` with an unknown id, `TOGGLE_PROVIDER_CONNECTION` with an unknown name).
- Match established visual/style conventions exactly: inline `CSSProperties` consts, `colors`/`fonts` tokens from `src/styles/tokens.ts`. The new Settings toggle mirrors `BudgetAlertsCard.tsx`'s existing `toggleStyle`/`AUTO-THROTTLE`/`SOUND` rows exactly. The "+ NEW" button mirrors `UplinksView.tsx`/`FilesView.tsx`'s existing small-pill-button idiom. The per-row remove (×) mirrors `FilesView.tsx`'s existing delete-row idiom (`colors.dangerSoft`).
- Reducer changes get Vitest coverage. `chatChannels.ts`/`systemPrompt.ts` (pure functions) get Vitest coverage. `ChannelRail.tsx`/`ChatView.tsx`/`BudgetAlertsCard.tsx` have no new testable logic of their own and are verified via typecheck + manual GUI QA, matching every prior presentational-only component in this project.
- Run `npm test`, `npx tsc -b`, and `npm run build` clean before every commit. Baseline going into this plan: **312 passing tests across 28 files** (confirmed via `npm test` immediately before this plan was written).

---

## File Structure

```
aether-os/
  src/
    state/
      types.ts              MODIFIED — DispatchChannelStub interface, 2 new AetherState fields, 1 new Cfg field
      initialState.ts        MODIFIED — seed values for the 3 new fields
      reducer.ts              MODIFIED — 2 new Action union members, extended SET_REAL_AGENTS, 2 new case blocks
      reducer.test.ts         MODIFIED — tests for the above
      persistence.ts           MODIFIED — 2 new whitelist entries
    components/
      chat/
        chatChannels.ts         MODIFIED — dispatch-kind channel derivation
        chatChannels.test.ts    MODIFIED — tests for the above
        systemPrompt.ts          MODIFIED — buildDispatchPrompt + new branch
        systemPrompt.test.ts     MODIFIED — tests for the above
        useChatChannels.ts        MODIFIED — one-line action-pipeline guard (see Global Constraints correction)
        ChannelRail.tsx            MODIFIED — "+ NEW" picker, per-row remove control
        ChatView.tsx                MODIFIED — new props passed to ChannelRail
      settings/
        BudgetAlertsCard.tsx        MODIFIED — new autoCreateDispatchChannels toggle
```

---

### Task 1: State + reducer

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/reducer.ts`
- Modify: `src/state/reducer.test.ts`
- Modify: `src/state/persistence.ts`

**Interfaces:**
- Consumes: `RealAgentDispatch` (already defined in `liveAgentsMath.ts`), `nowShort` (already imported in `reducer.ts`).
- Produces: `DispatchChannelStub` type (`types.ts`), `state.recentCompletedDispatches`/`state.dispatchChannels`/`cfg.autoCreateDispatchChannels` (all consumed by Tasks 2-4), `{ type: 'CREATE_DISPATCH_CHANNEL'; toolUseId: string }` / `{ type: 'REMOVE_DISPATCH_CHANNEL'; toolUseId: string }` actions (consumed by Task 4's `ChatView.tsx`).

- [ ] **Step 1: Add `DispatchChannelStub` and extend `AetherState`/`Cfg` in `src/state/types.ts`**

Add, immediately after the existing `MemoryStub` interface (around line 102):

```ts
export interface DispatchChannelStub {
  toolUseId: string;
  subagentType: string;
  description: string;
  prompt: string;
  model: string | null;
  startedAt: string;
  createdAt: string;
}
```

Change the `Cfg` interface's last field from:

```ts
  autoThrottle: boolean;
  sound: boolean;
}
```

to:

```ts
  autoThrottle: boolean;
  sound: boolean;
  autoCreateDispatchChannels: boolean;
}
```

Change `AetherState`'s last field from:

```ts
  realAgents: RealAgentDispatch[];
}
```

to:

```ts
  realAgents: RealAgentDispatch[];
  recentCompletedDispatches: RealAgentDispatch[];
  dispatchChannels: DispatchChannelStub[];
}
```

- [ ] **Step 2: Seed the new fields in `src/state/initialState.ts`**

Change the `cfg` object's last two lines from:

```ts
    autoThrottle: true,
    sound: false,
  },
```

to:

```ts
    autoThrottle: true,
    sound: false,
    autoCreateDispatchChannels: false,
  },
```

Change the file's last two lines from:

```ts
  realAgents: [],
};
```

to:

```ts
  realAgents: [],
  recentCompletedDispatches: [],
  dispatchChannels: [],
};
```

- [ ] **Step 3: Write the failing reducer tests**

Add the import to `src/state/reducer.test.ts` (the existing `import type { RealAgentDispatch } from './liveAgentsMath';` line, added by Phase 3 slice 5, is already there — no change to imports needed).

Append to `src/state/reducer.test.ts`, inside the `describe('reducer', ...)` block, immediately before its closing `});` at the end of the file (i.e. after the existing `describe('SET_REAL_AGENTS memory creation', ...)` block added by slice 5):

```ts

  describe('SET_REAL_AGENTS pool and auto-create', () => {
    const completedDispatch: RealAgentDispatch = {
      toolUseId: 'tu_1',
      subagentType: 'general-purpose',
      description: 'Explore the repo',
      startedAt: '2026-07-20T10:00:00.000Z',
      prompt: 'Explore the repo and report findings.',
      model: null,
    };

    it('pushes a completed dispatch into recentCompletedDispatches, most-recent-first', () => {
      const withOpenDispatch = { ...initialState, realAgents: [completedDispatch] };
      const next = reducer(withOpenDispatch, { type: 'SET_REAL_AGENTS', agents: [] });
      expect(next.recentCompletedDispatches[0]).toEqual(completedDispatch);
    });

    it('caps recentCompletedDispatches at 20 entries', () => {
      const existing: RealAgentDispatch[] = Array.from({ length: 20 }, (_, i) => ({ ...completedDispatch, toolUseId: `old_${i}` }));
      const withFullPoolAndOneOpen = { ...initialState, recentCompletedDispatches: existing, realAgents: [completedDispatch] };
      const next = reducer(withFullPoolAndOneOpen, { type: 'SET_REAL_AGENTS', agents: [] });
      expect(next.recentCompletedDispatches).toHaveLength(20);
      expect(next.recentCompletedDispatches[0]).toEqual(completedDispatch);
      expect(next.recentCompletedDispatches.map((d) => d.toolUseId)).not.toContain('old_19');
    });

    it('does not create a dispatch channel when autoCreateDispatchChannels is false (the default)', () => {
      const withOpenDispatch = { ...initialState, realAgents: [completedDispatch] };
      const next = reducer(withOpenDispatch, { type: 'SET_REAL_AGENTS', agents: [] });
      expect(next.dispatchChannels).toEqual([]);
    });

    it('auto-creates a dispatch channel when autoCreateDispatchChannels is true', () => {
      const withAutoCreate = { ...initialState, cfg: { ...initialState.cfg, autoCreateDispatchChannels: true }, realAgents: [completedDispatch] };
      const next = reducer(withAutoCreate, { type: 'SET_REAL_AGENTS', agents: [] });
      expect(next.dispatchChannels).toHaveLength(1);
      expect(next.dispatchChannels[0]).toMatchObject({
        toolUseId: 'tu_1',
        subagentType: 'general-purpose',
        description: 'Explore the repo',
        prompt: 'Explore the repo and report findings.',
        model: null,
      });
    });
  });

  describe('CREATE_DISPATCH_CHANNEL', () => {
    const pooled: RealAgentDispatch = {
      toolUseId: 'tu_2',
      subagentType: 'Explore',
      description: 'Map the docs',
      startedAt: '2026-07-20T10:05:00.000Z',
      prompt: 'Map the docs directory.',
      model: 'claude-haiku-4-5',
    };

    it('creates a channel stub from a pool entry, copying all fields', () => {
      const withPool = { ...initialState, recentCompletedDispatches: [pooled] };
      const next = reducer(withPool, { type: 'CREATE_DISPATCH_CHANNEL', toolUseId: 'tu_2' });
      expect(next.dispatchChannels).toHaveLength(1);
      expect(next.dispatchChannels[0]).toMatchObject({
        toolUseId: 'tu_2',
        subagentType: 'Explore',
        description: 'Map the docs',
        prompt: 'Map the docs directory.',
        model: 'claude-haiku-4-5',
      });
    });

    it('is a no-op for an unknown toolUseId', () => {
      const next = reducer(initialState, { type: 'CREATE_DISPATCH_CHANNEL', toolUseId: 'nonexistent' });
      expect(next).toBe(initialState);
    });

    it('is a no-op if a channel for that toolUseId already exists', () => {
      const existingStub = {
        toolUseId: 'tu_2',
        subagentType: 'Explore',
        description: 'Map the docs',
        prompt: '',
        model: null,
        startedAt: '2026-07-20T10:05:00.000Z',
        createdAt: '10:05:00',
      };
      const withBoth = { ...initialState, recentCompletedDispatches: [pooled], dispatchChannels: [existingStub] };
      const next = reducer(withBoth, { type: 'CREATE_DISPATCH_CHANNEL', toolUseId: 'tu_2' });
      expect(next.dispatchChannels).toHaveLength(1);
    });
  });

  describe('REMOVE_DISPATCH_CHANNEL', () => {
    const stub = {
      toolUseId: 'tu_3',
      subagentType: 'general-purpose',
      description: 'desc',
      prompt: '',
      model: null,
      startedAt: '2026-07-20T10:00:00.000Z',
      createdAt: '10:00:00',
    };

    it('removes the matching channel stub', () => {
      const withStub = { ...initialState, dispatchChannels: [stub] };
      const next = reducer(withStub, { type: 'REMOVE_DISPATCH_CHANNEL', toolUseId: 'tu_3' });
      expect(next.dispatchChannels).toEqual([]);
    });

    it('is a no-op for an unknown toolUseId', () => {
      const withStub = { ...initialState, dispatchChannels: [stub] };
      const next = reducer(withStub, { type: 'REMOVE_DISPATCH_CHANNEL', toolUseId: 'nonexistent' });
      expect(next.dispatchChannels).toEqual([stub]);
    });
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test -- reducer`
Expected: FAIL — `recentCompletedDispatches`/`dispatchChannels` don't exist on `AetherState` yet, and `CREATE_DISPATCH_CHANNEL`/`REMOVE_DISPATCH_CHANNEL` aren't valid `Action`s yet (TypeScript errors will also surface via `tsc`, but `npm test` alone should already fail at runtime/type-check on this project's Vitest+TS setup).

- [ ] **Step 5: Add the two new `Action` union members in `src/state/reducer.ts`**

Add the import for `DispatchChannelStub` — change:

```ts
import type { Approval, AetherState, Cfg, MemoryStub, OpMode, RealUsageSnapshot } from './types';
```

to:

```ts
import type { Approval, AetherState, Cfg, DispatchChannelStub, MemoryStub, OpMode, RealUsageSnapshot } from './types';
```

Change the `Action` union's last two members from:

```ts
  | { type: 'SET_REAL_AGENTS'; agents: RealAgentDispatch[] }
  | { type: 'SELECT_REAL_AGENT'; toolUseId: string };
```

to:

```ts
  | { type: 'SET_REAL_AGENTS'; agents: RealAgentDispatch[] }
  | { type: 'SELECT_REAL_AGENT'; toolUseId: string }
  | { type: 'CREATE_DISPATCH_CHANNEL'; toolUseId: string }
  | { type: 'REMOVE_DISPATCH_CHANNEL'; toolUseId: string };
```

- [ ] **Step 6: Extend the `SET_REAL_AGENTS` case and add the two new cases**

Change the `SET_REAL_AGENTS` case from:

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

to:

```ts
    case 'SET_REAL_AGENTS': {
      const completed = detectCompletedDispatches(state.realAgents, action.agents);
      let memories = state.memories;
      let memSeq = state.memSeq;
      let recentCompletedDispatches = state.recentCompletedDispatches;
      let dispatchChannels = state.dispatchChannels;
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

        recentCompletedDispatches = [dispatch, ...recentCompletedDispatches].slice(0, 20);

        if (state.cfg.autoCreateDispatchChannels) {
          dispatchChannels = [
            ...dispatchChannels,
            {
              toolUseId: dispatch.toolUseId,
              subagentType: dispatch.subagentType,
              description: dispatch.description,
              prompt: dispatch.prompt,
              model: dispatch.model,
              startedAt: dispatch.startedAt,
              createdAt: nowShort(),
            },
          ];
        }
      }
      return { ...state, realAgents: action.agents, memories, memSeq, recentCompletedDispatches, dispatchChannels };
    }

    case 'CREATE_DISPATCH_CHANNEL': {
      const alreadyExists = state.dispatchChannels.some((d) => d.toolUseId === action.toolUseId);
      const dispatch = state.recentCompletedDispatches.find((d) => d.toolUseId === action.toolUseId);
      if (alreadyExists || !dispatch) return state;
      const stub: DispatchChannelStub = {
        toolUseId: dispatch.toolUseId,
        subagentType: dispatch.subagentType,
        description: dispatch.description,
        prompt: dispatch.prompt,
        model: dispatch.model,
        startedAt: dispatch.startedAt,
        createdAt: nowShort(),
      };
      return { ...state, dispatchChannels: [...state.dispatchChannels, stub] };
    }

    case 'REMOVE_DISPATCH_CHANNEL':
      return { ...state, dispatchChannels: state.dispatchChannels.filter((d) => d.toolUseId !== action.toolUseId) };
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- reducer`
Expected: PASS.

- [ ] **Step 8: Add the two new fields to the persistence whitelist in `src/state/persistence.ts`**

Change:

```ts
      chatActionResults: state.chatActionResults,
    };
```

to:

```ts
      chatActionResults: state.chatActionResults,
      recentCompletedDispatches: state.recentCompletedDispatches,
      dispatchChannels: state.dispatchChannels,
    };
```

(`cfg` — and therefore the new `autoCreateDispatchChannels` field — is already whitelisted as a whole object; no change needed there.)

- [ ] **Step 9: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (321 total: 312 + 9 new), 0 type errors.

- [ ] **Step 10: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/state/reducer.ts src/state/reducer.test.ts src/state/persistence.ts
git commit -m "feat: add state and reducer support for post-mortem dispatch channels"
```

---

### Task 2: `chatChannels.ts` — dispatch-kind channel derivation

**Files:**
- Modify: `src/components/chat/chatChannels.ts`
- Modify: `src/components/chat/chatChannels.test.ts`

**Interfaces:**
- Consumes: `state.dispatchChannels` (Task 1).
- Produces: `ChatChannel.kind` now includes `'dispatch'`; `ChatChannel.toolUseId?: string` (new field, populated only for dispatch-kind channels) — consumed by Task 3 (`systemPrompt.ts`) and Task 4 (`ChannelRail.tsx`).

- [ ] **Step 1: Write the failing tests**

Append to `src/components/chat/chatChannels.test.ts`, inside the `describe('deriveChannels', ...)` block, immediately before its closing `});`:

```ts

  it('includes one dispatch-kind channel per state.dispatchChannels entry', () => {
    const withDispatch: AetherState = {
      ...initialState,
      dispatchChannels: [
        {
          toolUseId: 'tu_1',
          subagentType: 'general-purpose',
          description: 'Explore the repo',
          prompt: '',
          model: null,
          startedAt: '2026-07-20T10:00:00.000Z',
          createdAt: '10:00:00',
        },
      ],
    };
    const channels = deriveChannels(withDispatch);
    const dispatchChannel = channels.find((c) => c.kind === 'dispatch');
    expect(dispatchChannel).toMatchObject({ id: 'dispatch:tu_1', name: 'Explore the repo', archived: false, toolUseId: 'tu_1' });
  });

  it('falls back to subagentType for a dispatch channel name when description is empty', () => {
    const withDispatch: AetherState = {
      ...initialState,
      dispatchChannels: [
        { toolUseId: 'tu_2', subagentType: 'Explore', description: '', prompt: '', model: null, startedAt: '2026-07-20T10:00:00.000Z', createdAt: '10:00:00' },
      ],
    };
    const channels = deriveChannels(withDispatch);
    expect(channels.find((c) => c.kind === 'dispatch')?.name).toBe('Explore');
  });
```

Note: the existing `'returns only AETHER when there are no active or idle agents'` test does not need modification — it only sets `agents: []`/`idleList: []`, leaving `dispatchChannels` at `initialState`'s seeded `[]`, so it still produces exactly `[aether]`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- chatChannels`
Expected: FAIL — `dispatch`-kind channels aren't derived yet.

- [ ] **Step 3: Extend `ChatChannel` and `deriveChannels` in `src/components/chat/chatChannels.ts`**

Change the `ChatChannel` interface from:

```ts
export interface ChatChannel {
  id: string;
  kind: 'aether' | 'agent';
  name: string;
  initials: string;
  hue: string;
  archived: boolean;
}
```

to:

```ts
export interface ChatChannel {
  id: string;
  kind: 'aether' | 'agent' | 'dispatch';
  name: string;
  initials: string;
  hue: string;
  archived: boolean;
  toolUseId?: string;
}
```

Change `deriveChannels`'s body — from:

```ts
  const archivedChannels: ChatChannel[] = state.idleList.map((idle) => ({
    id: idle.name,
    kind: 'agent',
    name: idle.name,
    initials: agentInitials(idle.name),
    hue: colors.textMuted,
    archived: true,
  }));

  return [aether, ...activeChannels, ...archivedChannels];
}
```

to:

```ts
  const archivedChannels: ChatChannel[] = state.idleList.map((idle) => ({
    id: idle.name,
    kind: 'agent',
    name: idle.name,
    initials: agentInitials(idle.name),
    hue: colors.textMuted,
    archived: true,
  }));

  const dispatchChannelEntries: ChatChannel[] = state.dispatchChannels.map((d) => ({
    id: `dispatch:${d.toolUseId}`,
    kind: 'dispatch',
    name: d.description || d.subagentType,
    initials: d.subagentType.slice(0, 2).toUpperCase(),
    hue: colors.accentCyanSoft,
    archived: false,
    toolUseId: d.toolUseId,
  }));

  return [aether, ...activeChannels, ...archivedChannels, ...dispatchChannelEntries];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- chatChannels`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (323 total: 321 + 2 new), 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/chatChannels.ts src/components/chat/chatChannels.test.ts
git commit -m "feat: derive dispatch-kind chat channels from state.dispatchChannels"
```

---

### Task 3: `systemPrompt.ts` — retrospective dispatch-channel prompt

**Files:**
- Modify: `src/components/chat/systemPrompt.ts`
- Modify: `src/components/chat/systemPrompt.test.ts`

**Interfaces:**
- Consumes: `ChatChannel` (Task 2, `kind`/`toolUseId` fields), `state.dispatchChannels` (Task 1), `FALLBACK_PERSONA` (already exported from `./personas`, unmodified).
- Produces: `buildSystemPrompt` now handles `channel.kind === 'dispatch'` — consumed unchanged by `useChatChannels.ts` (Task 4).

- [ ] **Step 1: Write the failing tests**

Add the type import to `src/components/chat/systemPrompt.test.ts` — change:

```ts
import { deriveChannels, AETHER_CHANNEL_ID } from './chatChannels';
```

to:

```ts
import { deriveChannels, AETHER_CHANNEL_ID, type ChatChannel } from './chatChannels';
```

Append to `src/components/chat/systemPrompt.test.ts`, at the end of the file (after the existing `describe('buildSystemPrompt', ...)` block's closing `});`):

```ts

describe('buildSystemPrompt (dispatch channels)', () => {
  const dispatchChannelState: AetherState = {
    ...initialState,
    dispatchChannels: [
      {
        toolUseId: 'tu_1',
        subagentType: 'general-purpose',
        description: 'Explore the repo',
        prompt: 'Explore the repo and report findings.',
        model: null,
        startedAt: '2026-07-20T10:00:00.000Z',
        createdAt: '10:00:00',
      },
    ],
  };
  const dispatchChannel = deriveChannels(dispatchChannelState).find((c) => c.kind === 'dispatch')!;

  it("uses the dispatch's real prompt and subagentType, and the fallback persona voice", () => {
    const prompt = buildSystemPrompt(dispatchChannel, dispatchChannelState);
    expect(prompt).toContain('Explore the repo and report findings.');
    expect(prompt).toContain('general-purpose');
    expect(prompt.toLowerCase()).toContain('no-nonsense');
  });

  it('does not mention the action-JSON verb pipeline', () => {
    const prompt = buildSystemPrompt(dispatchChannel, dispatchChannelState);
    expect(prompt).not.toContain('spawn|kill|throttle');
    expect(prompt).not.toContain('"verb"');
  });

  it('addresses the user by name like every other channel kind', () => {
    const prompt = buildSystemPrompt(dispatchChannel, dispatchChannelState);
    expect(prompt).toContain('"Operator."');
  });

  it('falls back to description when prompt is empty, and to a literal no-detail string when both are empty', () => {
    const noPrompt: AetherState = {
      ...dispatchChannelState,
      dispatchChannels: [{ ...dispatchChannelState.dispatchChannels[0], prompt: '' }],
    };
    const channel = deriveChannels(noPrompt).find((c) => c.kind === 'dispatch')!;
    expect(buildSystemPrompt(channel, noPrompt)).toContain('Explore the repo');

    const noDetail: AetherState = {
      ...dispatchChannelState,
      dispatchChannels: [{ ...dispatchChannelState.dispatchChannels[0], prompt: '', description: '' }],
    };
    const channel2 = deriveChannels(noDetail).find((c) => c.kind === 'dispatch')!;
    expect(buildSystemPrompt(channel2, noDetail)).toContain('no task detail was recorded');
  });

  it('returns a safe fallback prompt when the channel has no matching stub (defensive)', () => {
    const orphanChannel: ChatChannel = {
      id: 'dispatch:ghost',
      kind: 'dispatch',
      name: 'ghost',
      initials: 'GH',
      hue: '#000',
      archived: false,
      toolUseId: 'ghost',
    };
    const prompt = buildSystemPrompt(orphanChannel, initialState);
    expect(prompt).toContain('No record of this task is available.');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- systemPrompt`
Expected: FAIL — `buildSystemPrompt` doesn't handle `kind: 'dispatch'` yet (falls through to the `agent` branch, which will produce a mismatched prompt or throw on `state.agents.find` returning undefined for a name that isn't a real agent).

- [ ] **Step 3: Implement `buildDispatchPrompt` and extend `buildSystemPrompt` in `src/components/chat/systemPrompt.ts`**

Change the import from:

```ts
import { resolvePersona } from './personas';
```

to:

```ts
import { resolvePersona, FALLBACK_PERSONA } from './personas';
```

Add, immediately after `buildAgentSnapshot` and before the `RULES` constant:

```ts

// Post-mortem channels (Phase 3, slice 6) never learn a persona -- there is
// no personality data for an arbitrary real subagentType, and inventing one
// per type would be unbounded scope. Reuses FALLBACK_PERSONA's existing
// generic voice verbatim. Past-tense framing throughout: this channel is a
// retrospective conversation about a completed task, not an ongoing one, and
// deliberately never mentions the action-JSON convention -- none of
// spawn/kill/theme/renderer/throttle apply to a dispatch that already
// finished.
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

Change `buildSystemPrompt` from:

```ts
export function buildSystemPrompt(channel: ChatChannel, state: AetherState): string {
  if (channel.kind === 'aether') {
    const snapshot = buildAetherSnapshot(state);
    return `${aetherVoice(state.operatorName)}\n\nCurrent state:\n${JSON.stringify(snapshot)}\n\n${RULES}`;
  }

  const persona = resolvePersona(channel.name);
```

to:

```ts
export function buildSystemPrompt(channel: ChatChannel, state: AetherState): string {
  if (channel.kind === 'aether') {
    const snapshot = buildAetherSnapshot(state);
    return `${aetherVoice(state.operatorName)}\n\nCurrent state:\n${JSON.stringify(snapshot)}\n\n${RULES}`;
  }

  if (channel.kind === 'dispatch') {
    return buildDispatchPrompt(channel, state);
  }

  const persona = resolvePersona(channel.name);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- systemPrompt`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (328 total: 323 + 5 new), 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/systemPrompt.ts src/components/chat/systemPrompt.test.ts
git commit -m "feat: build a retrospective system prompt for post-mortem dispatch channels"
```

---

### Task 4: UI — Settings toggle, channel picker, remove control, action-pipeline guard

**Files:**
- Modify: `src/components/settings/BudgetAlertsCard.tsx`
- Modify: `src/components/chat/ChannelRail.tsx`
- Modify: `src/components/chat/ChatView.tsx`
- Modify: `src/components/chat/useChatChannels.ts`

**Interfaces:**
- Consumes: `state.recentCompletedDispatches`/`state.dispatchChannels` (Task 1), `CREATE_DISPATCH_CHANNEL`/`REMOVE_DISPATCH_CHANNEL` actions (Task 1), `ChatChannel.kind`/`toolUseId` (Task 2).
- Produces: the full user-facing feature — no further tasks depend on this one beyond Task 5's QA.

- [ ] **Step 1: Add the Settings toggle to `src/components/settings/BudgetAlertsCard.tsx`**

Change the file's last content block before the closing `</div>\n  );\n}` — from:

```tsx
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle}>SOUND</div>
        <span onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { sound: !cfg.sound } })} style={toggleStyle(cfg.sound)}>
          {cfg.sound ? 'ON' : 'OFF'}
        </span>
      </div>
    </div>
  );
}
```

to:

```tsx
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle}>SOUND</div>
        <span onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { sound: !cfg.sound } })} style={toggleStyle(cfg.sound)}>
          {cfg.sound ? 'ON' : 'OFF'}
        </span>
      </div>

      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={labelStyle}>AUTO-CREATE DISPATCH CHANNELS</div>
        <span
          onClick={() => dispatch({ type: 'UPDATE_CFG', patch: { autoCreateDispatchChannels: !cfg.autoCreateDispatchChannels } })}
          style={toggleStyle(cfg.autoCreateDispatchChannels)}
        >
          {cfg.autoCreateDispatchChannels ? 'ON' : 'OFF'}
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the action-pipeline guard to `src/components/chat/useChatChannels.ts`**

Change:

```ts
        if (action) {
          if ((SAFE_VERBS as readonly string[]).includes(action.verb)) {
```

to:

```ts
        // Dispatch channels never invite the action-JSON convention (their system
        // prompt omits it entirely -- see systemPrompt.ts's buildDispatchPrompt) and
        // never execute one even if a reply contained action-shaped JSON anyway --
        // none of spawn/kill/theme/renderer/throttle have a real-world meaning for a
        // completed real dispatch, and channel.name for a dispatch channel is a task
        // description, not a valid fictional agent name.
        if (action && channel.kind !== 'dispatch') {
          if ((SAFE_VERBS as readonly string[]).includes(action.verb)) {
```

- [ ] **Step 3: Implement the "+ NEW" picker and per-row remove control in `src/components/chat/ChannelRail.tsx`**

Replace the entire file:

```tsx
import { useState, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import type { ChatChannel } from './chatChannels';
import type { RealAgentDispatch } from '../../state/liveAgentsMath';
import type { DispatchChannelStub } from '../../state/types';

interface ChannelRailProps {
  channels: ChatChannel[];
  activeChannelId: string;
  unreadCounts: Record<string, number>;
  onSelect: (id: string) => void;
  recentCompletedDispatches: RealAgentDispatch[];
  dispatchChannels: DispatchChannelStub[];
  onCreateDispatchChannel: (toolUseId: string) => void;
  onRemoveDispatchChannel: (toolUseId: string) => void;
}

export function ChannelRail({
  channels,
  activeChannelId,
  unreadCounts,
  onSelect,
  recentCompletedDispatches,
  dispatchChannels,
  onCreateDispatchChannel,
  onRemoveDispatchChannel,
}: ChannelRailProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const poolable = recentCompletedDispatches.filter((d) => !dispatchChannels.some((c) => c.toolUseId === d.toolUseId));

  return (
    <div style={railStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle}>CHANNELS</div>
        <span onClick={() => setPickerOpen((o) => !o)} style={newButtonStyle}>
          + NEW
        </span>
      </div>

      {pickerOpen && (
        <div style={pickerStyle}>
          {poolable.length === 0 && <div style={pickerEmptyStyle}>no completed dispatches to start a channel for</div>}
          {poolable.map((d) => (
            <div
              key={d.toolUseId}
              onClick={() => {
                onCreateDispatchChannel(d.toolUseId);
                setPickerOpen(false);
              }}
              style={pickerRowStyle}
            >
              <div style={pickerNameStyle}>{d.description || d.subagentType}</div>
              <div style={pickerTypeStyle}>{d.subagentType}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {channels.map((c) => {
          const on = c.id === activeChannelId;
          const unread = unreadCounts[c.id] ?? 0;
          return (
            <div key={c.id} onClick={() => onSelect(c.id)} style={rowStyle(on, c.archived)}>
              <span style={avatarStyle(c.hue)}>{c.initials}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={nameStyle(c.archived)}>{c.name}</div>
                {c.archived && <div style={terminatedTagStyle}>TERMINATED</div>}
              </div>
              {!!unread && <span style={unreadBadgeStyle}>{unread}</span>}
              {c.kind === 'dispatch' && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveDispatchChannel(c.toolUseId!);
                  }}
                  style={removeStyle}
                >
                  ×
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const railStyle: CSSProperties = {
  width: 220,
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
const newButtonStyle: CSSProperties = {
  cursor: 'pointer',
  font: `600 9px/1 ${fonts.ui}`,
  letterSpacing: 1,
  padding: '5px 9px',
  borderRadius: 6,
  color: '#04202b',
  background: 'linear-gradient(180deg,#7ef0ff,#17b8d8)',
};
const pickerStyle: CSSProperties = {
  marginTop: 10,
  padding: 8,
  borderRadius: 9,
  border: `1px solid ${colors.chipBorder}`,
  background: 'rgba(6,20,28,.6)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};
const pickerEmptyStyle: CSSProperties = { font: `400 10px/1.3 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
const pickerRowStyle: CSSProperties = { cursor: 'pointer', padding: '5px 6px', borderRadius: 6 };
const pickerNameStyle: CSSProperties = {
  font: `600 11px/1.3 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const pickerTypeStyle: CSSProperties = { font: `400 9px/1.3 ${fonts.mono}`, color: colors.textDim, marginTop: 1 };
function rowStyle(on: boolean, archived: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    padding: '8px 9px',
    borderRadius: 9,
    cursor: 'pointer',
    opacity: archived ? 0.55 : 1,
    background: on ? 'rgba(23,184,216,.14)' : undefined,
    border: on ? '1px solid rgba(95,220,255,.4)' : '1px solid transparent',
  };
}
function avatarStyle(hue: string): CSSProperties {
  return {
    width: 26,
    height: 26,
    flex: 'none',
    borderRadius: 7,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 4px,#123f4e 4px 8px)',
    border: `1px solid ${hue}`,
    display: 'grid',
    placeItems: 'center',
    font: `700 10px/1 ${fonts.mono}`,
    color: hue,
  };
}
function nameStyle(archived: boolean): CSSProperties {
  return {
    font: `600 13px/1 ${fonts.ui}`,
    color: archived ? colors.textMuted : colors.textPrimary,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}
const terminatedTagStyle: CSSProperties = { marginTop: 2, font: `600 8px/1 ${fonts.ui}`, letterSpacing: 1, color: colors.textDim };
const unreadBadgeStyle: CSSProperties = {
  flex: 'none',
  minWidth: 16,
  height: 16,
  padding: '0 4px',
  borderRadius: 8,
  background: colors.accentCyanDeep,
  color: '#04202b',
  font: `700 10px/16px ${fonts.mono}`,
  textAlign: 'center',
};
const removeStyle: CSSProperties = { flex: 'none', cursor: 'pointer', font: `700 13px/1 ${fonts.ui}`, color: colors.dangerSoft, padding: '2px 5px' };
```

- [ ] **Step 4: Wire the new props through in `src/components/chat/ChatView.tsx`**

Change:

```tsx
      <ChannelRail channels={chat.channels} activeChannelId={chat.activeChannelId} unreadCounts={chat.unreadCounts} onSelect={chat.setActiveChannelId} />
```

to:

```tsx
      <ChannelRail
        channels={chat.channels}
        activeChannelId={chat.activeChannelId}
        unreadCounts={chat.unreadCounts}
        onSelect={chat.setActiveChannelId}
        recentCompletedDispatches={state.recentCompletedDispatches}
        dispatchChannels={state.dispatchChannels}
        onCreateDispatchChannel={(toolUseId) => dispatch({ type: 'CREATE_DISPATCH_CHANNEL', toolUseId })}
        onRemoveDispatchChannel={(toolUseId) => dispatch({ type: 'REMOVE_DISPATCH_CHANNEL', toolUseId })}
      />
```

(`state`/`dispatch` are already destructured from `useAetherStore()` at the top of this component — no new import needed.)

- [ ] **Step 5: Run the full suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (328/328, unchanged from Task 3 — this task adds no new unit tests, matching this project's precedent for presentational-only components), 0 type errors, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/BudgetAlertsCard.tsx src/components/chat/ChannelRail.tsx src/components/chat/ChatView.tsx src/components/chat/useChatChannels.ts
git commit -m "feat: add dispatch-channel picker, remove control, Settings toggle, and action-pipeline guard"
```

---

### Task 5: Final integration QA

**Files:** none (verification-only task).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (328/328), 0 type errors, build succeeds.

- [ ] **Step 2: Manual QA checklist**

Run: `npm run electron:dev`. Triggering a real dispatch completion on demand isn't reliably reproducible (same accepted gap as every prior Phase 3 slice touching real data) — this checklist substitutes a manually-injected pool entry where needed, and otherwise confirms zero regression in the existing fictional Chat behavior.

- [ ] Open Chat. Confirm the "+ NEW" control renders in the channel rail and, when clicked with an empty `recentCompletedDispatches` pool (the common case on a fresh session), shows the "no completed dispatches to start a channel for" empty state.
- [ ] If a real dispatch happens to complete while the app is open during this QA pass, confirm it appears in the "+ NEW" picker, and that clicking it creates a new channel, switches nothing automatically (still on whichever channel was previously active — confirm this is the actual, intended behavior by re-reading `sendMessage`'s caller path, not assumed), and the new channel is selectable and shows up correctly styled (fixed accent hue, no "TERMINATED" pill).
- [ ] Send a message in the new dispatch channel — confirm a real reply arrives, is retrospective/past-tense in tone, references the dispatch's actual task, and never contains visible action-JSON.
- [ ] Click the new channel's remove (×) — confirm it disappears from the rail immediately.
- [ ] Toggle Settings' new "AUTO-CREATE DISPATCH CHANNELS" control on; if another real dispatch completes while it's on, confirm a channel appears automatically with no manual pick needed. Toggle it back off afterward.
- [ ] Reload the app (or restart `electron:dev`) — confirm any created dispatch channel(s) and their message history persist.
- [ ] Confirm zero regression in every existing fictional channel: send a message in AETHER, an active agent channel, and confirm an archived channel still shows "TERMINATED" and blocks input exactly as before.
- [ ] Confirm no regressions elsewhere: Terminal, Dashboard, Agents, Grid, Projects, Memory, Analytics, Attachments, Uplinks, Settings all still route and highlight correctly.

- [ ] **Step 3: Address any regression found in Step 2**

If Step 2 surfaces a real regression (not a pre-existing, already-documented quirk), fix it and commit separately with a `fix:` message before considering this plan done. If nothing was found, skip this step.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-24-real-agents-chat-dispatch-channels-phase3-slice6.md`. Executed via the same per-task pipeline as prior plans in this repo: a fresh implementer subagent per task, a fresh reviewer subagent (spec compliance + code quality) before commit, then one whole-branch review after all tasks land.

### Critical Files for Implementation
- C:\Users\Matt\projects\aether-os\src\state\types.ts
- C:\Users\Matt\projects\aether-os\src\state\reducer.ts
- C:\Users\Matt\projects\aether-os\src\components\chat\chatChannels.ts
- C:\Users\Matt\projects\aether-os\src\components\chat\systemPrompt.ts
- C:\Users\Matt\projects\aether-os\src\components\chat\useChatChannels.ts
- C:\Users\Matt\projects\aether-os\src\components\chat\ChannelRail.tsx
- C:\Users\Matt\projects\aether-os\src\components\chat\ChatView.tsx
