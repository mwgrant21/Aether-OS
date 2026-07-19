# Memory View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `Memory` tab's `null` placeholder with a real Memory view — a named, browsable roster of "engrams" with pin/strength/detail, backed by real memory creation (manual + auto-triggered from live fleet events), decay, and sweep — closing the loop on the existing `sweep` command and Dashboard stats that already reference this data today.

**Architecture:** A master-detail layout, same shape as Projects/Agents: `MemoryRosterCard` (left, fixed width) lists every memory, pinned first then strength-descending; `MemoryDetailCard` (right, flex) renders full detail (content, source, timestamp, strength, pin toggle) for whichever memory is selected. `MemoryView.tsx` composes the two, using a new pure module (`memoryMath.ts`) for selection fallback, pinned/unpinned grouping, and a strength-tier color formula. `MemoryStub` gains `id`/`name`/`content`/`source`/`ts` fields (today it's only `{ pinned, strength }`, and nothing in the app ever creates one). Memories now come from three sources: a new terminal command (`remember <text>`), and two auto-triggers that already fire live today (agent kill, HIGH-risk approval resolution — at both of its existing call sites). Strength decays each tick for unpinned memories; the existing `sweep` command (unchanged) prunes weak ones. Two new state fields (`selectedMemory`, `memSeq`) and two new reducer actions (`SELECT_MEMORY`, `TOGGLE_MEMORY_PIN`) are added.

**Tech Stack:** Same as the existing project — React 18, Vite 5, TypeScript 5 (strict), Vitest. No new dependencies.

## Global Constraints

- Project root: `C:\Users\Matt\projects\aether-os` (already scaffolded; this plan extends it).
- Full design spec: `docs/superpowers/specs/2026-07-19-memory-view-design.md` (commit `610aa3b`, corrected in `6a1e657`) — this plan implements it task-by-task; consult it for the "why" behind any decision below.
- **Scope for this plan:** `src/components/memory/` (new: `MemoryView.tsx`, `MemoryRosterCard.tsx`, `MemoryDetailCard.tsx`, `memoryMath.ts` + test), `src/state/types.ts` / `initialState.ts` / `reducer.ts` / `reducer.test.ts` / `persistence.ts` / `persistence.test.ts` (modified — `MemoryStub` fields, two new state fields, two new actions, persistence-whitelist fix, seed data), `src/components/terminal/commands.ts` / `commands.test.ts` (modified — new `remember` command, kill/approve/deny auto-triggers), `src/state/tick.ts` / `tick.test.ts` (modified — decay), `src/viewRegistry.ts` / `viewRegistry.test.ts` (modified — flip `Memory`'s component from `null`).
- **Ship is explicitly NOT an auto-trigger.** Project status never transitions live anywhere in this app today (`SHIPPED` only ever appears as `initialState.ts` seed data) — only **kill** and **HIGH-risk approval resolution** (both call sites — see below) are wired as auto-triggers. Do not add a project-lifecycle mechanism as a side effect of this plan.
- **HIGH-approval auto-trigger has two independent call sites and both need the identical addition:** `applyApprovalResolution` in `reducer.ts` (used by `RESOLVE_APPROVAL` and chat's `autoResolve` path) **and** `commands.ts`'s own separate `approve`/`deny` case (typed `approve <n>`/`deny <n>` in the terminal — this does **not** call `applyApprovalResolution`, it has its own independent patch). The condition is `req.risk === 'HIGH'` **regardless of `ok`/approve-vs-deny** — a HIGH-risk request being denied is just as notable as one being approved. (This exact approve-only-vs-both bug was caught and fixed in the spec itself before this plan was written — see commit `6a1e657`.)
- **No "+ add" button in the roster.** Unlike `NEW_PROJECT`/`spawn` (need no free text, can be one-click buttons), `remember` exists specifically to capture arbitrary text — nothing in this codebase uses `window.prompt` or any modal-input pattern today, and introducing one here would be a new UI paradigm this design explicitly rules out. Manual memory creation is terminal-only: `remember <text>`, discoverable via `help`.
- **`selectedMemory` is a new, separate `AetherState` field — not a reuse of `selected`/`selectedProject`.** Same reasoning as the prior two: sharing a selection field across views would let selecting in one view silently clobber another.
- **The `memories`/`selectedMemory` persistence-whitelist entries are added proactively in Task 1**, not discovered during final QA. `memories` is missing from `savePersisted`'s whitelist *today* (a pre-existing bug independent of this plan, found during spec research) — this exact bug class has recurred across nearly every prior view in this repo (Dashboard's `projects`/`providers`/`routeDefault`, Agents' `selected`, Projects' `selectedProject`).
- Match established visual/style conventions exactly: inline `CSSProperties` consts, `colors`/`fonts` tokens from `src/styles/tokens.ts`, `useAetherStore()`. Hardcoded hex in `memoryMath.ts`'s `STRENGTH_TIER_COLOR` matches the existing precedent of `projectsMath.ts`'s `STATUS_COLOR` (neither imports `colors` — both inline the same hex values that also appear in `tokens.ts`).
- New pure-logic module (`memoryMath.ts`) and the reducer/persistence/tick/commands additions get Vitest coverage. Presentational components (`MemoryRosterCard`, `MemoryDetailCard`, `MemoryView`) have no new testable logic of their own and are verified via the dev server, matching the precedent set by `ProjectRosterCard`/`ProjectDetailCard`/`ProjectsView`.
- Run `npm test`, `npx tsc -b`, and `npm run build` clean before every commit. Baseline going into this plan: **215 passing tests across 22 files** (confirmed via `npm test` immediately before this plan was written).

---

## File Structure

```
aether-os/
  src/
    components/
      memory/
        MemoryView.tsx           NEW — 2-column composition, mounted by the view registry
        MemoryRosterCard.tsx      NEW — left rail: pinned-then-strength-sorted memory list (selectable), no add button
        MemoryDetailCard.tsx      NEW — right panel: selected memory's content/source/ts/strength + pin toggle
        memoryMath.ts             NEW — pure derivation, tested
        memoryMath.test.ts        NEW
      terminal/
        commands.ts               MODIFIED — new `remember` command; kill/approve/deny auto-create memories
        commands.test.ts          MODIFIED — tests for the above
    state/
      types.ts                    MODIFIED — MemoryStub gains id/name/content/source/ts; AetherState.selectedMemory, .memSeq
      initialState.ts             MODIFIED — selectedMemory: null, memSeq: 5, 4 seed memories
      reducer.ts                  MODIFIED — SELECT_MEMORY, TOGGLE_MEMORY_PIN actions; applyApprovalResolution HIGH-risk memory
      reducer.test.ts             MODIFIED — tests for the above
      persistence.ts              MODIFIED — memories + selectedMemory added to savePersisted whitelist
      persistence.test.ts         MODIFIED — round-trip test
      tick.ts                     MODIFIED — unpinned memory strength decay
      tick.test.ts                MODIFIED — tests for the above
    viewRegistry.ts                MODIFIED — flip Memory's component from null to MemoryView
    viewRegistry.test.ts           MODIFIED — test that Memory now resolves
```

---

### Task 1: State — `MemoryStub` fields, `selectedMemory`/`memSeq`, `SELECT_MEMORY`/`TOGGLE_MEMORY_PIN` actions, persistence, seed data

Gives memories real shape and gives the view something to show on first load. Bundles the persistence-whitelist fix in up front per the Global Constraints note above.

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/reducer.ts`
- Modify: `src/state/reducer.test.ts`
- Modify: `src/state/persistence.ts`
- Modify: `src/state/persistence.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `MemoryStub { id: number; name: string; content: string; source: string; ts: string; pinned: boolean; strength: number }`; `AetherState.selectedMemory: string | null`; `AetherState.memSeq: number`; `{ type: 'SELECT_MEMORY'; id: number }` and `{ type: 'TOGGLE_MEMORY_PIN'; id: number }` added to the `Action` union — all consumed by Task 2 (memSeq), Task 4 (memoryMath.ts), and Task 7's `MemoryView`.

- [ ] **Step 1: Write the failing tests**

Append to `src/state/reducer.test.ts` (inside the existing `describe('reducer', ...)` block, right after the `'SELECT_PROJECT sets selectedProject'` test):

```ts
  it('SELECT_MEMORY sets selectedMemory to the stringified id', () => {
    const next = reducer(initialState, { type: 'SELECT_MEMORY', id: 2 });
    expect(next.selectedMemory).toBe('2');
  });

  it('TOGGLE_MEMORY_PIN flips pinned on the matching memory only', () => {
    const next = reducer(initialState, { type: 'TOGGLE_MEMORY_PIN', id: 2 });
    expect(next.memories.find((m) => m.id === 2)?.pinned).toBe(true);
    expect(next.memories.find((m) => m.id === 1)?.pinned).toBe(true); // unchanged (already pinned in seed data)
    const restored = reducer(next, { type: 'TOGGLE_MEMORY_PIN', id: 2 });
    expect(restored.memories.find((m) => m.id === 2)?.pinned).toBe(false);
  });
```

Append to `src/state/persistence.test.ts` (inside the existing `describe('persistence', ...)` block, right after the `'persists the selected project across reloads'` test):

```ts
  it('persists memories and selectedMemory across reloads', () => {
    savePersisted({ ...initialState, selectedMemory: '2' });
    const loaded = loadPersisted();
    expect(loaded?.memories).toEqual(initialState.memories);
    expect(loaded?.selectedMemory).toBe('2');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- reducer persistence`
Expected: FAIL — `selectedMemory`/`memSeq` don't exist on `AetherState` yet, `SELECT_MEMORY`/`TOGGLE_MEMORY_PIN` aren't valid `Action`s, and seed `memories` is still `[]` (so `id: 1`/`id: 2` lookups find nothing).

- [ ] **Step 3: Expand `MemoryStub` in `src/state/types.ts`**

Change:

```ts
export interface MemoryStub {
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
}
```

- [ ] **Step 4: Add the new `AetherState` fields**

Change:

```ts
  selected: string | null;
  selectedProject: string | null;
```

to:

```ts
  selected: string | null;
  selectedProject: string | null;
  selectedMemory: string | null;
```

Change:

```ts
  memories: MemoryStub[];
```

to:

```ts
  memories: MemoryStub[];
  memSeq: number;
```

- [ ] **Step 5: Seed real memories and defaults in `src/state/initialState.ts`**

Change:

```ts
  selected: null,
  selectedProject: null,
```

to:

```ts
  selected: null,
  selectedProject: null,
  selectedMemory: null,
```

Change:

```ts
  memories: [],
```

to:

```ts
  memories: [
    {
      id: 1,
      name: 'Auth session-invalidation pattern',
      content: 'Code Builder found a reusable session-invalidation pattern while refactoring auth middleware.',
      source: 'Code Builder',
      ts: '09:14',
      pinned: true,
      strength: 92,
    },
    {
      id: 2,
      name: 'Schema migration 0043 shipped clean',
      content: "Database Agent's index migration on usage_events applied with no downtime.",
      source: 'Database Agent',
      ts: '10:02',
      pinned: false,
      strength: 68,
    },
    {
      id: 3,
      name: 'Dashboard card spacing conventions',
      content: 'UI Designer catalogued the spacing/shadow rules used across dashboard cards for future consistency.',
      source: 'UI Designer',
      ts: '11:20',
      pinned: false,
      strength: 41,
    },
    {
      id: 4,
      name: 'CLI Companion naming brainstorm',
      content: 'Early naming brainstorm for the CLI Companion project before the current name was chosen.',
      source: 'operator',
      ts: '08:47',
      pinned: false,
      strength: 22,
    },
  ],
  memSeq: 5,
```

- [ ] **Step 6: Add the two new actions to the `Action` union in `src/state/reducer.ts`**

Change the union's last member:

```ts
  | { type: 'SELECT_PROJECT'; name: string };
```

to:

```ts
  | { type: 'SELECT_PROJECT'; name: string }
  | { type: 'SELECT_MEMORY'; id: number }
  | { type: 'TOGGLE_MEMORY_PIN'; id: number };
```

- [ ] **Step 7: Add the `switch` cases**

In `src/state/reducer.ts`, right after the existing `case 'SELECT_PROJECT':` case:

```ts
    case 'SELECT_PROJECT':
      return { ...state, selectedProject: action.name };

    case 'SELECT_MEMORY':
      return { ...state, selectedMemory: String(action.id) };

    case 'TOGGLE_MEMORY_PIN':
      return {
        ...state,
        memories: state.memories.map((m) => (m.id === action.id ? { ...m, pinned: !m.pinned } : m)),
      };
```

- [ ] **Step 8: Add `memories`/`selectedMemory` to the persistence whitelist in `src/state/persistence.ts`**

Change:

```ts
      selected: state.selected,
      selectedProject: state.selectedProject,
      chatActionResults: state.chatActionResults,
```

to:

```ts
      selected: state.selected,
      selectedProject: state.selectedProject,
      selectedMemory: state.selectedMemory,
      memories: state.memories,
      chatActionResults: state.chatActionResults,
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm test -- reducer persistence`
Expected: PASS.

- [ ] **Step 10: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (218 total: 215 + 3 new), 0 type errors.

- [ ] **Step 11: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/state/reducer.ts src/state/reducer.test.ts src/state/persistence.ts src/state/persistence.test.ts
git commit -m "feat: expand MemoryStub with name/content/source/ts, add selectedMemory/memSeq state and their actions, fix memories persistence gap, seed real memories"
```

---

### Task 2: Memory creation — `remember` command, kill auto-trigger, HIGH-approval auto-trigger

Gives memories a real way to come into existence beyond the initial seed: a manual terminal command, plus the two live fleet events chosen as auto-triggers. Touches both places a HIGH-risk approval can be resolved (they're independent code paths today — see Global Constraints).

**Files:**
- Modify: `src/components/terminal/commands.ts`
- Modify: `src/components/terminal/commands.test.ts`
- Modify: `src/state/reducer.ts`
- Modify: `src/state/reducer.test.ts`

**Interfaces:**
- Consumes: `MemoryStub`, `state.memSeq`, `state.memories` from Task 1.
- Produces: `remember <text>` terminal command; kill and HIGH-approval resolution now append a `MemoryStub` and bump `memSeq` — consumed by nothing further in this plan (this is the mechanism `MemoryRosterCard`/`MemoryDetailCard` will display once built).

- [ ] **Step 1: Write the failing tests**

Append to `src/components/terminal/commands.test.ts` (inside the existing `describe('runCommand', ...)` block):

Change the `help` test's checked list:

```ts
    ['status', 'agents', 'spawn <name>', 'kill <name>', 'budget', 'projects', 'sweep', 'approvals', 'approve <n>', 'deny <n>', 'theme <name>', 'renderer <mode>', 'clear'].forEach(
```

to:

```ts
    ['status', 'agents', 'spawn <name>', 'kill <name>', 'budget', 'projects', 'sweep', 'remember <text>', 'approvals', 'approve <n>', 'deny <n>', 'theme <name>', 'renderer <mode>', 'clear'].forEach(
```

Add new tests, right after the existing `'kill on an unknown agent reports an error with no patch'` test:

```ts
  it('kill appends a memory referencing the terminated agent', () => {
    const result = runCommand(initialState, 'kill code builder');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.patch?.memories).toHaveLength(initialState.memories.length + 1);
    expect(result.patch?.memories?.at(-1)?.name).toBe('Code Builder decommissioned');
    expect(result.patch?.memSeq).toBe(initialState.memSeq + 1);
  });
```

Add new tests, right after the existing `'approve/deny on an out-of-range index reports an error'` test:

```ts
  it('approve on a HIGH-risk request appends a memory; a MED-risk deny does not', () => {
    const approveHigh = runCommand(initialState, 'approve 1');
    if (approveHigh.kind !== 'append') throw new Error('unreachable');
    expect(approveHigh.patch?.memories?.at(-1)?.name).toBe('Approved: Deploy build #214 to production');
    expect(approveHigh.patch?.memSeq).toBe(initialState.memSeq + 1);

    const denyMed = runCommand(initialState, 'deny 2');
    if (denyMed.kind !== 'append') throw new Error('unreachable');
    expect(denyMed.patch?.memories).toEqual(initialState.memories);
    expect(denyMed.patch?.memSeq).toBe(initialState.memSeq);
  });

  it('deny on a HIGH-risk request also appends a memory', () => {
    const denyHigh = runCommand(initialState, 'deny 1');
    if (denyHigh.kind !== 'append') throw new Error('unreachable');
    expect(denyHigh.patch?.memories?.at(-1)?.name).toBe('Denied: Deploy build #214 to production');
    expect(denyHigh.patch?.memSeq).toBe(initialState.memSeq + 1);
  });

  it('remember <text> logs a manual memory at full strength', () => {
    const result = runCommand(initialState, 'remember check the CDN purge before next deploy');
    if (result.kind !== 'append') throw new Error('unreachable');
    const added = result.patch?.memories?.at(-1);
    expect(added?.content).toBe('check the CDN purge before next deploy');
    expect(added?.source).toBe('operator');
    expect(added?.pinned).toBe(false);
    expect(added?.strength).toBe(100);
    expect(result.patch?.memSeq).toBe(initialState.memSeq + 1);
  });

  it('remember with no text reports a usage error and no patch', () => {
    const result = runCommand(initialState, 'remember');
    if (result.kind !== 'append') throw new Error('unreachable');
    expect(result.lines[1].t).toContain('usage: remember <text>');
    expect(result.patch).toBeUndefined();
  });
```

Append to `src/state/reducer.test.ts` (inside `describe('reducer', ...)`, right after the existing `'RESOLVE_APPROVAL on an unknown id is a no-op'` test):

```ts
  it('RESOLVE_APPROVAL appends a memory for HIGH-risk approvals on both approve and deny, but not for MED/LOW', () => {
    const approved = reducer(initialState, { type: 'RESOLVE_APPROVAL', id: 1, approve: true });
    expect(approved.memories).toHaveLength(initialState.memories.length + 1);
    expect(approved.memories.at(-1)?.name).toBe('Approved: Deploy build #214 to production');
    expect(approved.memSeq).toBe(initialState.memSeq + 1);

    const denied = reducer(initialState, { type: 'RESOLVE_APPROVAL', id: 1, approve: false });
    expect(denied.memories).toHaveLength(initialState.memories.length + 1);
    expect(denied.memories.at(-1)?.name).toBe('Denied: Deploy build #214 to production');

    const medResolved = reducer(initialState, { type: 'RESOLVE_APPROVAL', id: 2, approve: true });
    expect(medResolved.memories).toEqual(initialState.memories);
    expect(medResolved.memSeq).toBe(initialState.memSeq);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- commands reducer`
Expected: FAIL — `remember` is an unknown command; `kill`/`approve`/`deny` don't touch `memories`/`memSeq` yet; `applyApprovalResolution` doesn't either.

- [ ] **Step 3: Update imports in `src/components/terminal/commands.ts`**

Change:

```ts
import type { Agent, AetherState, CommandResult, TermLine, ThemeName, RendererMode } from '../../state/types';
import { fmt, fmtEta } from '../../utils/format';
```

to:

```ts
import type { Agent, AetherState, CommandResult, MemoryStub, TermLine, ThemeName, RendererMode } from '../../state/types';
import { fmt, fmtEta, nowShort } from '../../utils/format';
```

- [ ] **Step 4: Add `remember <text>` to the `help` listing**

Change:

```ts
        line('  sweep               run memory consolidation'),
        line('  approvals           list pending authorizations'),
```

to:

```ts
        line('  sweep               run memory consolidation'),
        line('  remember <text>     log a manual memory'),
        line('  approvals           list pending authorizations'),
```

- [ ] **Step 5: Update the `kill` case to append a memory**

Change:

```ts
    case 'kill': {
      const name = args.join(' ');
      const hit = state.agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
      if (!hit) {
        out.push(line(`✗ no agent named "${name}"`, BAD));
        return { kind: 'append', lines: out };
      }
      out.push(line(`✓ ${hit.name} terminated — returned to idle pool`, GOOD));
      return {
        kind: 'append',
        lines: out,
        patch: {
          agents: state.agents.filter((a) => a.name !== hit.name),
          idleList: [...state.idleList, { name: hit.name, last: 'just now' }],
        },
      };
    }
```

to:

```ts
    case 'kill': {
      const name = args.join(' ');
      const hit = state.agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
      if (!hit) {
        out.push(line(`✗ no agent named "${name}"`, BAD));
        return { kind: 'append', lines: out };
      }
      out.push(line(`✓ ${hit.name} terminated — returned to idle pool`, GOOD));
      const memory: MemoryStub = {
        id: state.memSeq,
        name: `${hit.name} decommissioned`,
        content: `${hit.name} was terminated and returned to the idle pool.`,
        source: hit.name,
        ts: nowShort(),
        pinned: false,
        strength: 100,
      };
      return {
        kind: 'append',
        lines: out,
        patch: {
          agents: state.agents.filter((a) => a.name !== hit.name),
          idleList: [...state.idleList, { name: hit.name, last: 'just now' }],
          memories: [...state.memories, memory],
          memSeq: state.memSeq + 1,
        },
      };
    }
```

- [ ] **Step 6: Add the `remember` case**

Right after the `case 'sweep':` case's closing brace:

```ts
    case 'remember': {
      const text = args.join(' ').trim();
      if (!text) {
        out.push(line('✗ usage: remember <text>', BAD));
        return { kind: 'append', lines: out };
      }
      const memory: MemoryStub = {
        id: state.memSeq,
        name: text.length > 40 ? `${text.slice(0, 40)}…` : text,
        content: text,
        source: 'operator',
        ts: nowShort(),
        pinned: false,
        strength: 100,
      };
      out.push(line(`✓ memory logged — "${memory.name}"`, GOOD));
      return { kind: 'append', lines: out, patch: { memories: [...state.memories, memory], memSeq: state.memSeq + 1 } };
    }
```

- [ ] **Step 7: Update the `approve`/`deny` case to append a memory for HIGH-risk requests**

Change:

```ts
    case 'approve':
    case 'deny': {
      const n = parseInt(args[0], 10);
      const req = state.approvals[n - 1];
      const approve = cmd.toLowerCase() === 'approve';
      if (!req) {
        out.push(line(`✗ no request [${args[0]}] — run 'approvals'`, BAD));
        return { kind: 'append', lines: out };
      }
      // Deviation from source: the original built this message via `cmd.toLowerCase() + 'd'`,
      // which produces "denyd" for the deny path. This port says "denied" correctly.
      out.push(line(`✓ ${approve ? 'approved' : 'denied'}: ${req.action}`, approve ? GOOD : BAD));
      return {
        kind: 'append',
        lines: out,
        patch: {
          approvals: state.approvals.filter((a) => a.id !== req.id),
          rate: approve && req.risk === 'HIGH' ? Math.min(168000, state.rate + 9000) : state.rate,
        },
      };
    }
```

to:

```ts
    case 'approve':
    case 'deny': {
      const n = parseInt(args[0], 10);
      const req = state.approvals[n - 1];
      const approve = cmd.toLowerCase() === 'approve';
      if (!req) {
        out.push(line(`✗ no request [${args[0]}] — run 'approvals'`, BAD));
        return { kind: 'append', lines: out };
      }
      // Deviation from source: the original built this message via `cmd.toLowerCase() + 'd'`,
      // which produces "denyd" for the deny path. This port says "denied" correctly.
      out.push(line(`✓ ${approve ? 'approved' : 'denied'}: ${req.action}`, approve ? GOOD : BAD));
      let memories = state.memories;
      let memSeq = state.memSeq;
      if (req.risk === 'HIGH') {
        const memory: MemoryStub = {
          id: memSeq,
          name: `${approve ? 'Approved' : 'Denied'}: ${req.action}`,
          content: `${req.agent} — HIGH-risk request ${approve ? 'approved' : 'denied'}: ${req.action}`,
          source: req.agent,
          ts: nowShort(),
          pinned: false,
          strength: 100,
        };
        memories = [...memories, memory];
        memSeq += 1;
      }
      return {
        kind: 'append',
        lines: out,
        patch: {
          approvals: state.approvals.filter((a) => a.id !== req.id),
          rate: approve && req.risk === 'HIGH' ? Math.min(168000, state.rate + 9000) : state.rate,
          memories,
          memSeq,
        },
      };
    }
```

- [ ] **Step 8: Update `src/state/reducer.ts`'s `applyApprovalResolution` for the second call site**

Change the import line:

```ts
import type { Approval, AetherState, OpMode } from './types';
```

to:

```ts
import type { Approval, AetherState, MemoryStub, OpMode } from './types';
```

Change (inside `applyApprovalResolution`, right after the existing `if (ok && req.verb === 'spawn' ...) { ... } else if (...) { ... }` chain):

```ts
  } else if (ok && req.risk === 'HIGH') {
    // Pre-existing generic shorthand -- only applies to no-verb approvals,
    // since a verb-carrying approval's own specific mutation above (or
    // deliberate lack of one, for kill/throttle) is the real effect now;
    // applying both would double up or contradict it.
    rate = Math.min(168000, rate + 9000);
  }

  const chatActionResults = req.channelId
```

to:

```ts
  } else if (ok && req.risk === 'HIGH') {
    // Pre-existing generic shorthand -- only applies to no-verb approvals,
    // since a verb-carrying approval's own specific mutation above (or
    // deliberate lack of one, for kill/throttle) is the real effect now;
    // applying both would double up or contradict it.
    rate = Math.min(168000, rate + 9000);
  }

  // A HIGH-risk request being resolved is notable regardless of outcome --
  // unlike the mutation branches above (which only ever apply on approve),
  // this fires on both approve and deny.
  let memories = state.memories;
  let memSeq = state.memSeq;
  if (req.risk === 'HIGH') {
    const memory: MemoryStub = {
      id: memSeq,
      name: `${ok ? 'Approved' : 'Denied'}: ${req.action}`,
      content: `${req.agent} — HIGH-risk request ${ok ? 'approved' : 'denied'}: ${req.action}`,
      source: req.agent,
      ts: nowShort(),
      pinned: false,
      strength: 100,
    };
    memories = [...memories, memory];
    memSeq += 1;
  }

  const chatActionResults = req.channelId
```

Change the function's `return` statement:

```ts
  return {
    ...state,
    agents,
    idleList,
    rate,
    chatActionResults,
    approvals: state.approvals.filter((a) => a.id !== req.id),
```

to:

```ts
  return {
    ...state,
    agents,
    idleList,
    rate,
    memories,
    memSeq,
    chatActionResults,
    approvals: state.approvals.filter((a) => a.id !== req.id),
```

Also add the `nowShort` import (already imported in `reducer.ts` — verify the existing `import { nowShort } from '../utils/format';` line is present; it is, no change needed there).

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm test -- commands reducer`
Expected: PASS.

- [ ] **Step 10: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (224 total: 218 + 6 new), 0 type errors.

- [ ] **Step 11: Commit**

```bash
git add src/components/terminal/commands.ts src/components/terminal/commands.test.ts src/state/reducer.ts src/state/reducer.test.ts
git commit -m "feat: add remember command and wire kill/HIGH-approval-resolution as memory auto-triggers"
```

---

### Task 3: Memory strength decay in `tick.ts`

Unpinned memories lose a small, fixed amount of strength every tick; pinned memories are untouched. This is what makes `sweep` meaningful over the course of a session instead of only reacting to freshly-created low-strength entries.

**Files:**
- Modify: `src/state/tick.ts`
- Modify: `src/state/tick.test.ts`

**Interfaces:**
- Consumes: `state.memories` from Task 1.
- Produces: `computeTick`'s returned patch now includes a decayed `memories` array — consumed by nothing further in this plan (visible once `MemoryRosterCard`/`MemoryDetailCard` are built).

- [ ] **Step 1: Write the failing tests**

Append to `src/state/tick.test.ts` (inside the existing `describe('computeTick', ...)` block):

```ts
  it('decays unpinned memory strength by a fixed amount per tick, leaving pinned memories untouched', () => {
    const state = {
      ...initialState,
      memories: [
        { id: 1, name: 'A', content: 'a', source: 'x', ts: '00:00', pinned: true, strength: 50 },
        { id: 2, name: 'B', content: 'b', source: 'x', ts: '00:00', pinned: false, strength: 50 },
      ],
    };
    const result = computeTick(state);
    expect(result.memories?.find((m) => m.id === 1)?.strength).toBe(50);
    expect(result.memories?.find((m) => m.id === 2)?.strength).toBeCloseTo(49.6, 5);
  });

  it('floors decayed memory strength at 0', () => {
    const state = { ...initialState, memories: [{ id: 1, name: 'A', content: 'a', source: 'x', ts: '00:00', pinned: false, strength: 0.1 }] };
    const result = computeTick(state);
    expect(result.memories?.[0].strength).toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tick`
Expected: FAIL — `computeTick`'s returned patch doesn't include `memories` yet.

- [ ] **Step 3: Add decay to `computeTick` in `src/state/tick.ts`**

Change:

```ts
  const sys = state.sys.map((m) => {
    const val = Math.max(6, Math.min(96, m.val + (Math.random() - 0.5) * 5));
    return { ...m, val, hist: m.hist.slice(1).concat(val) };
  });
```

to:

```ts
  const sys = state.sys.map((m) => {
    const val = Math.max(6, Math.min(96, m.val + (Math.random() - 0.5) * 5));
    return { ...m, val, hist: m.hist.slice(1).concat(val) };
  });

  const memories = state.memories.map((m) => (m.pinned ? m : { ...m, strength: Math.max(0, m.strength - 0.4) }));
```

Change the function's final `return` statement:

```ts
  return { rate, used, ctxUsed, weekRaw, agents, sys, logs, alarmLevel: level, notifs, unread, approvals, apprSeq };
```

to:

```ts
  return { rate, used, ctxUsed, weekRaw, agents, sys, logs, alarmLevel: level, notifs, unread, approvals, apprSeq, memories };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- tick`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (226 total: 224 + 2 new), 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/state/tick.ts src/state/tick.test.ts
git commit -m "feat: decay unpinned memory strength each tick"
```

---

### Task 4: Memory derivation math (`memoryMath.ts`)

The pure logic the view needs: which memory counts as "selected" (falling back sensibly, same shape as `pickSelectedProject`), splitting memories into pinned (array order) and unpinned (strength descending), and a strength-tier color formula for both the roster's numeric badge and the detail pane's strength bar.

**Files:**
- Create: `src/components/memory/memoryMath.ts`
- Test: `src/components/memory/memoryMath.test.ts`

**Interfaces:**
- Consumes: `MemoryStub` from `../../state/types`.
- Produces: `pickSelectedMemory(memories: MemoryStub[], selected: string | null): MemoryStub | null`, `groupMemoriesForRoster(memories: MemoryStub[]): { pinned: MemoryStub[]; unpinned: MemoryStub[] }`, `STRENGTH_TIER_COLOR(strength: number): string` — consumed by Task 5's `MemoryRosterCard`, Task 6's `MemoryDetailCard`, and Task 7's `MemoryView`.

- [ ] **Step 1: Write the failing tests**

`src/components/memory/memoryMath.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { STRENGTH_TIER_COLOR, groupMemoriesForRoster, pickSelectedMemory } from './memoryMath';
import { initialState } from '../../state/initialState';

describe('pickSelectedMemory', () => {
  it('returns the memory matching selected (by id, as a string) when present', () => {
    const memory = pickSelectedMemory(initialState.memories, '2');
    expect(memory?.id).toBe(2);
  });

  it('falls back to the first memory when selected is null', () => {
    const memory = pickSelectedMemory(initialState.memories, null);
    expect(memory?.id).toBe(initialState.memories[0].id);
  });

  it('falls back to the first memory when selected does not match any id', () => {
    const memory = pickSelectedMemory(initialState.memories, '999');
    expect(memory?.id).toBe(initialState.memories[0].id);
  });

  it('returns null when there are no memories at all', () => {
    expect(pickSelectedMemory([], 'Anything')).toBeNull();
  });
});

describe('groupMemoriesForRoster', () => {
  it('splits the seed memories into pinned (array order) and unpinned (strength descending)', () => {
    const { pinned, unpinned } = groupMemoriesForRoster(initialState.memories);
    expect(pinned.map((m) => m.id)).toEqual([1]);
    expect(unpinned.map((m) => m.id)).toEqual([2, 3, 4]);
  });

  it('returns an empty pinned array when nothing is pinned', () => {
    const allUnpinned = initialState.memories.map((m) => ({ ...m, pinned: false }));
    const { pinned } = groupMemoriesForRoster(allUnpinned);
    expect(pinned).toEqual([]);
  });

  it('returns both empty for an empty input', () => {
    expect(groupMemoriesForRoster([])).toEqual({ pinned: [], unpinned: [] });
  });
});

describe('STRENGTH_TIER_COLOR', () => {
  it('returns the healthy color above 60', () => {
    expect(STRENGTH_TIER_COLOR(92)).toBe('#3be0a0');
    expect(STRENGTH_TIER_COLOR(61)).toBe('#3be0a0');
  });

  it('returns the fading color from 31 to 60 inclusive', () => {
    expect(STRENGTH_TIER_COLOR(60)).toBe('#f5c66b');
    expect(STRENGTH_TIER_COLOR(31)).toBe('#f5c66b');
  });

  it('returns the dim/at-sweep-threshold color at 30 and below', () => {
    expect(STRENGTH_TIER_COLOR(30)).toBe('#4e7c8b');
    expect(STRENGTH_TIER_COLOR(0)).toBe('#4e7c8b');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- memoryMath`
Expected: FAIL — `memoryMath.ts` doesn't exist yet.

- [ ] **Step 3: Implement `src/components/memory/memoryMath.ts`**

```ts
import type { MemoryStub } from '../../state/types';

export function pickSelectedMemory(memories: MemoryStub[], selected: string | null): MemoryStub | null {
  if (selected) {
    const match = memories.find((m) => String(m.id) === selected);
    if (match) return match;
  }
  return memories[0] ?? null;
}

export function groupMemoriesForRoster(memories: MemoryStub[]): { pinned: MemoryStub[]; unpinned: MemoryStub[] } {
  const pinned = memories.filter((m) => m.pinned);
  const unpinned = memories.filter((m) => !m.pinned).sort((a, b) => b.strength - a.strength);
  return { pinned, unpinned };
}

export function STRENGTH_TIER_COLOR(strength: number): string {
  if (strength > 60) return '#3be0a0';
  if (strength > 30) return '#f5c66b';
  return '#4e7c8b';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- memoryMath`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (236 total: 226 + 10 new), 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/memory/memoryMath.ts src/components/memory/memoryMath.test.ts
git commit -m "feat: add Memory view derivation math (selection fallback, pinned/unpinned grouping, strength-tier color)"
```

---

### Task 5: Memory Roster card (pinned-then-strength list, no add button)

Left rail of the Memory view. Memories grouped via `groupMemoriesForRoster` — a PINNED section (only rendered when non-empty) above an ENGRAMS section — each a selectable row (source badge, name, strength number colored by tier). No header action button (see Global Constraints — `remember` is terminal-only).

**Files:**
- Create: `src/components/memory/MemoryRosterCard.tsx`

**Interfaces:**
- Consumes: `useAetherStore()`; `STRENGTH_TIER_COLOR`, `groupMemoriesForRoster` from `./memoryMath`; `colors`, `fonts` from `../../styles/tokens`.
- Produces: `MemoryRosterCard({ selectedId }: { selectedId: number | null })` — mounted by Task 7's `MemoryView`.

No new unit-testable logic — verify via dev server.

- [ ] **Step 1: Implement `src/components/memory/MemoryRosterCard.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { MemoryStub } from '../../state/types';
import { STRENGTH_TIER_COLOR, groupMemoriesForRoster } from './memoryMath';

export function MemoryRosterCard({ selectedId }: { selectedId: number | null }) {
  const { state, dispatch } = useAetherStore();
  const { pinned, unpinned } = groupMemoriesForRoster(state.memories);

  const row = (m: MemoryStub) => {
    const on = m.id === selectedId;
    return (
      <div key={m.id} onClick={() => dispatch({ type: 'SELECT_MEMORY', id: m.id })} style={rowStyle(on)}>
        <span style={sourceBadgeStyle}>{m.source}</span>
        <span style={nameStyle}>{m.name}</span>
        <span style={{ flex: 'none', font: `700 11px/1 ${fonts.mono}`, color: STRENGTH_TIER_COLOR(m.strength) }}>{Math.round(m.strength)}</span>
      </div>
    );
  };

  return (
    <div style={cardStyle}>
      <div style={{ flex: 'none' }}>
        <div style={titleStyle}>MEMORY</div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {pinned.length > 0 && (
          <div>
            <div style={groupHeaderStyle}>PINNED ({pinned.length})</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>{pinned.map(row)}</div>
          </div>
        )}
        <div>
          <div style={groupHeaderStyle}>ENGRAMS ({unpinned.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>{unpinned.map(row)}</div>
        </div>
        {!state.memories.length && <div style={emptyStyle}>no memories logged yet — try `remember &lt;text&gt;` in the Terminal</div>}
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
const groupHeaderStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textDim };
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
const nameStyle: CSSProperties = {
  flex: 1,
  font: `600 13px/1 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const sourceBadgeStyle: CSSProperties = {
  flex: 'none',
  font: `600 8px/1 ${fonts.ui}`,
  letterSpacing: 1,
  color: colors.accentCyanSoft,
  border: `1px solid rgba(95,220,255,.35)`,
  padding: '4px 7px',
  borderRadius: 4,
  maxWidth: 76,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'center',
};
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/memory/MemoryRosterCard.tsx
git commit -m "feat: build the Memory view roster card (pinned-then-strength list)"
```

---

### Task 6: Memory Detail card

Right panel of the Memory view. Shows the selected memory's name, source badge, timestamp, full content, a strength bar (colored by tier), and a pin/unpin toggle. Renders an honest empty state when there are no memories at all.

**Files:**
- Create: `src/components/memory/MemoryDetailCard.tsx`

**Interfaces:**
- Consumes: `useAetherStore()`; `STRENGTH_TIER_COLOR` from `./memoryMath`; `colors`, `fonts` from `../../styles/tokens`; `MemoryStub` type from `../../state/types`.
- Produces: `MemoryDetailCard({ memory }: { memory: MemoryStub | null })` — mounted by Task 7's `MemoryView`.

No new unit-testable logic (the math it uses is already tested in Task 4) — verify via dev server.

- [ ] **Step 1: Implement `src/components/memory/MemoryDetailCard.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import type { MemoryStub } from '../../state/types';
import { STRENGTH_TIER_COLOR } from './memoryMath';

export function MemoryDetailCard({ memory }: { memory: MemoryStub | null }) {
  const { dispatch } = useAetherStore();

  if (!memory) {
    return (
      <div style={cardStyle}>
        <div style={emptyWrapStyle}>
          <div style={{ font: `600 13px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textSecondary }}>NO MEMORIES YET</div>
          <div style={{ marginTop: 8, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textMuted }}>
            Log one with `remember &lt;text&gt;` in the Terminal.
          </div>
        </div>
      </div>
    );
  }

  const tierColor = STRENGTH_TIER_COLOR(memory.strength);

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: `700 18px/1 ${fonts.ui}`, color: colors.textPrimary }}>{memory.name}</div>
        </div>
        <span style={sourceBadgeStyle}>{memory.source}</span>
      </div>

      <div style={{ marginTop: 6, font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>{memory.ts}</div>

      <div style={trackStyle}>
        <div style={{ height: '100%', width: `${memory.strength}%`, background: tierColor, boxShadow: `0 0 10px ${tierColor}` }} />
      </div>
      <div style={{ marginTop: 6 }}>
        <span style={{ font: `700 13px/1 ${fonts.mono}`, color: tierColor }}>{Math.round(memory.strength)}% strength</span>
      </div>

      <div style={{ marginTop: 20, flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div style={sectionLabelStyle}>CONTENT</div>
        <div style={{ marginTop: 8, font: `400 13px/1.6 ${fonts.ui}`, color: colors.textBody }}>{memory.content}</div>
      </div>

      <div style={{ marginTop: 'auto', paddingTop: 16 }}>
        <span
          onClick={() => dispatch({ type: 'TOGGLE_MEMORY_PIN', id: memory.id })}
          style={memory.pinned ? dangerActionStyle : secondaryActionStyle}
        >
          {memory.pinned ? '✕ UNPIN' : '📌 PIN'}
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
const sourceBadgeStyle: CSSProperties = {
  flex: 'none',
  font: `600 8px/1 ${fonts.ui}`,
  letterSpacing: 1,
  color: colors.accentCyanSoft,
  border: `1px solid rgba(95,220,255,.35)`,
  padding: '4px 7px',
  borderRadius: 4,
  maxWidth: 120,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'center',
};
const trackStyle: CSSProperties = { height: 6, borderRadius: 3, background: 'rgba(20,50,64,.7)', overflow: 'hidden', marginTop: 18 };
const sectionLabelStyle: CSSProperties = { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
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
  width: 'fit-content',
  paddingLeft: 18,
  paddingRight: 18,
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
  background: 'rgba(255,120,120,.08)',
  width: 'fit-content',
  paddingLeft: 18,
  paddingRight: 18,
};
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/memory/MemoryDetailCard.tsx
git commit -m "feat: build the Memory view detail card (content, strength bar, pin toggle)"
```

---

### Task 7: Memory view composition + registry wiring

Composes the roster and detail cards using `pickSelectedMemory` to decide which memory's detail to show, then flips the `Memory` view-registry entry from `null` to the real component.

**Files:**
- Create: `src/components/memory/MemoryView.tsx`
- Modify: `src/viewRegistry.ts`
- Modify: `src/viewRegistry.test.ts`

**Interfaces:**
- Consumes: `useAetherStore()`; `pickSelectedMemory` from `./memoryMath`; `MemoryRosterCard`, `MemoryDetailCard`.
- Produces: `MemoryView()` — registered in `viewRegistry.ts`, completing the Memory slice.

- [ ] **Step 1: Implement `src/components/memory/MemoryView.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { pickSelectedMemory } from './memoryMath';
import { MemoryRosterCard } from './MemoryRosterCard';
import { MemoryDetailCard } from './MemoryDetailCard';

export function MemoryView() {
  const { state } = useAetherStore();
  const selectedMemory = pickSelectedMemory(state.memories, state.selectedMemory);

  return (
    <div style={rootStyle}>
      <MemoryRosterCard selectedId={selectedMemory?.id ?? null} />
      <MemoryDetailCard memory={selectedMemory} />
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
```

- [ ] **Step 2: Wire Memory into the registry**

In `src/viewRegistry.ts`, add the import:

```ts
import { MemoryView } from './components/memory/MemoryView';
```

Change:

```ts
  { id: 'Memory', inTopBar: true, inSidebar: true, component: null },
```

to:

```ts
  { id: 'Memory', inTopBar: true, inSidebar: true, component: MemoryView },
```

- [ ] **Step 3: Update `src/viewRegistry.test.ts`**

Add a new test confirming Memory now resolves (after the existing `'getViewComponent resolves Projects now that it is built'` test):

```ts
  it('getViewComponent resolves Memory now that it is built', () => {
    expect(getViewComponent('Memory')).not.toBeNull();
  });
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (237 total: 236 + 1 new), 0 type errors, build succeeds.

- [ ] **Step 5: Verify via dev server**

Run: `npm run dev`. Click the Memory tab (top bar or sidebar): the roster + detail two-column layout renders. The PINNED section shows the one seeded pinned memory; ENGRAMS shows the other three sorted strongest-first (68, 41, 22). Clicking other roster rows swaps the detail panel. Detail panel shows full content, source, timestamp, and a strength bar matching the roster's numeric badge color.

- [ ] **Step 6: Commit**

```bash
git add src/components/memory/MemoryView.tsx src/viewRegistry.ts src/viewRegistry.test.ts
git commit -m "feat: compose the Memory view and wire it into the view registry"
```

---

### Task 8: Final integration QA

**Files:** none (verification-only task).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (237/237), 0 type errors, build succeeds.

- [ ] **Step 2: Manual QA checklist**

Run: `npm run dev`, open the browser.

- [ ] Clicking the top bar's or sidebar's "Memory" entry shows the two-column roster + detail layout; the first memory (pinned one, by seed array order) is selected by default with no prior interaction.
- [ ] Roster shows the seeded PINNED section (1 memory) above ENGRAMS (3 memories, sorted 68/41/22).
- [ ] Clicking a different roster row swaps the detail panel to that memory (name, source, timestamp, content, strength bar all update); the previously-selected row loses its highlight and the new one gains it.
- [ ] In the Terminal, run `remember testing this out` — confirm the success line, then switch to the Memory tab and confirm a new memory appears in ENGRAMS at the top (strength 100), source "operator".
- [ ] In the Terminal, run `remember` with no text — confirm the usage error line, no new memory created.
- [ ] Kill an agent (via Terminal `kill <name>` or the Agents view's TERMINATE button) — confirm a new memory appears in the Memory view referencing that agent by name.
- [ ] Resolve a HIGH-risk approval by **approving** it (via the bell, an Agents card if applicable, or terminal `approve <n>`) — confirm a new "Approved: ..." memory appears.
- [ ] Resolve a HIGH-risk approval by **denying** it — confirm a new "Denied: ..." memory appears (this is the specific approve-vs-deny bug caught during spec review — verify it explicitly, not just approve).
- [ ] Resolve a MED or LOW-risk approval (approve or deny) — confirm no new memory is created.
- [ ] In the Memory view detail panel, click "📌 PIN" on an unpinned memory — it moves into the PINNED section; click "✕ UNPIN" — it moves back to ENGRAMS in its correct strength-sorted position.
- [ ] Let the dev server run for a minute or so with the Memory tab open — confirm an unpinned memory's strength number visibly ticks downward, while the pinned memory's strength stays fixed.
- [ ] Run `sweep` (Terminal command or Dashboard's "MEMORY SWEEP" button) — confirm any unpinned memory at or below strength 30 is removed, and the pinned memory survives regardless of its strength. Confirm the Dashboard's "MEMORY SWEEP" button still also switches the active tab to Memory afterward.
- [ ] Zero-memories edge case: temporarily set `memories: []` in `src/state/initialState.ts` (local, uncommitted edit), reload the dev server, and confirm both the roster's "no memories logged yet" and the detail panel's "NO MEMORIES YET" render without error. Revert the edit (`git checkout -- src/state/initialState.ts`) before continuing.
- [ ] Dashboard's `SystemsCard` "Memory engrams" and "Pinned" counts still update correctly as memories are added/removed/pinned (regression check — this card already read `state.memories` before this plan).
- [ ] Reload the page — confirm memories (including any created during this QA pass and their current decayed strengths) and the selected memory all persist (regression check on the Task 1 persistence-whitelist fix).
- [ ] Confirm no regressions elsewhere: Terminal, Dashboard, Agents, Grid, Chat, Projects, and remaining placeholder tabs still route and highlight correctly.

- [ ] **Step 3: Address any regression found in Step 2**

If Step 2 surfaces a real regression (not a pre-existing, already-documented quirk), fix it and commit separately with a `fix:` message before considering this plan done. If nothing was found, skip this step.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-19-memory-view.md`. Executed via the same per-task pipeline as prior plans in this repo: a fresh implementer subagent per task, a fresh reviewer subagent (spec compliance + code quality) before commit, then one whole-branch review after all tasks land.

### Critical Files for Implementation
- C:\Users\Matt\projects\aether-os\src\state\types.ts
- C:\Users\Matt\projects\aether-os\src\state\initialState.ts
- C:\Users\Matt\projects\aether-os\src\state\reducer.ts
- C:\Users\Matt\projects\aether-os\src\state\tick.ts
- C:\Users\Matt\projects\aether-os\src\state\persistence.ts
- C:\Users\Matt\projects\aether-os\src\components\terminal\commands.ts
- C:\Users\Matt\projects\aether-os\src\components\memory\memoryMath.ts
- C:\Users\Matt\projects\aether-os\src\components\memory\MemoryView.tsx
- C:\Users\Matt\projects\aether-os\src\viewRegistry.ts
