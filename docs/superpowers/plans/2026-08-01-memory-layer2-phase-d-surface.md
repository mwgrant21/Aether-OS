# Memory Layer 2 — Phase D (The Surface) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the real `memory.db` into the Electron app for the first time, retiring the fake `MemoryStub` simulation (`strength`/`sweep`/`pinned`/`remember`) and every place it's synthesized, per `docs/superpowers/specs/2026-08-01-memory-layer2-phase-d-surface-design.md`.

**Architecture:** New read-only `electron/memoryStore.ts` (mirrors `electron/collectorStore.ts`), polled from `electron/main.ts` and pushed via a new `memory:` IPC namespace (mirrors `fleet:`), consumed by a new `src/state/useMemorySync.ts` hook (mirrors `useFleetSync.ts`). `MemoryStub` and every site that constructs one are removed from `src/state/` and `src/components/terminal/commands.ts`. `src/components/memory/` is re-pointed at the real fields with a scope filter and tombstone view added.

**Tech Stack:** TypeScript, `node:sqlite` (electron side), React (renderer), Vitest, `@testing-library/react`. Two separate packages/tsconfigs (`electron/` and the root `src/`) — this plan touches both.

## Global Constraints

- Source of truth for every architectural decision: `docs/superpowers/specs/2026-08-01-memory-layer2-phase-d-surface-design.md` (as currently committed at `bb682d5`).
- `electron/memoryStore.ts` mirrors `electron/collectorStore.ts`'s exact conventions: `openReadOnly` via `createRequire('node:module')` + `require('node:sqlite')`, `{ readOnly: true }`, `try/finally` close, return `null` on any failure (missing file, missing table, any thrown error) — never throw to the caller.
- `memory.db` has **no `schema_meta` version table** (unlike `collector.db`) — Phase A's `memoryStore.ts` (collector-side) never created one; its migration convention is a guarded `ALTER TABLE` keyed on `PRAGMA table_info`, not a version counter. The liveness/readiness signal here is simply whether the `memories` table exists (`sqlite_master` lookup) — do not invent a `schema_meta` dependency this store doesn't have.
- Timestamps in `memories`/`memory_tombstones` are **seconds** (collector-side `now()` convention) — `electron/memoryStore.ts` converts to milliseconds (`* 1000`) at the read boundary, once, so every consumer downstream deals in ms like every other UI timestamp in this codebase.
- `window.aetherElectron` (confirmed name, `electron/preload.ts:14`) is the existing `contextBridge` namespace — the new `memory` sub-namespace goes there, mirroring `fleet`'s exact shape (`onSnapshot` returning an unsubscribe function).
- **Retirement is total, not partial.** Every one of the six `MemoryStub`-constructing sites named in the design doc §3 must be removed in this plan — approval/dispatch/kill/sweep/remember/commands.ts-approve-deny. None of these events disappear from the app; each already has an independent notifs/logs/TermLine path unaffected by this plan (design doc §3 names each one).
- `AetherState.memSeq` is removed entirely once all six sites are gone (design doc §3) — from `types.ts`, `initialState.ts`, `persistence.ts`, and every removed construction site.
- Run `npx vitest run` and `npx tsc -b` (or this repo's root equivalent — check `package.json` scripts, since the root app may use plain `tsc`/`vite build` rather than `tsc -b`) for **both** `electron/` and the root package before each task's commit, since this plan touches both.
- Every existing test in every file this plan touches must either keep passing unmodified, or be a test whose *subject* (a feature being retired) this plan explicitly removes — never leave a test asserting removed behavior.

---

### Task 1: `electron/memoryStore.ts` — the read-only reader

**Files:**
- Create: `electron/memoryStore.ts`
- Create: `electron/memoryStore.test.ts`

**Interfaces:**
- Produces: `MemoryScope`, `MemoryKind`, `MemoryStatus` (types), `MemoryRowUI`, `MemoryTombstoneUI` (interfaces), `readMemories(dbPath: string): MemoryRowUI[] | null`, `readMemoryTombstones(dbPath: string): MemoryTombstoneUI[] | null` — used by Task 2.

- [ ] **Step 1: Write the failing tests**

Read `electron/collectorStore.test.ts` in full first — this task's test file follows its exact conventions (raw `DatabaseSync` table creation via `createRequire('node:module')`, temp dir per test via `mkdtempSync`).

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'node:module';
import { readMemories, readMemoryTombstones } from './memoryStore.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

function tempMemoryDb(opts: { withMemoriesTable?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-memorystore-'));
  const dbPath = join(dir, 'memory.db');
  if (opts.withMemoriesTable === false) {
    // No tables at all -- simulates a collector that has never opened this store.
    return dbPath.replace('memory.db', 'nonexistent.db');
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL, owner_agent TEXT, kind TEXT NOT NULL, content TEXT NOT NULL,
      status TEXT, salience INTEGER NOT NULL DEFAULT 3, subject TEXT,
      source_kind TEXT NOT NULL, source_run_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      asked_at INTEGER, reference_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE memory_tombstones (
      id INTEGER PRIMARY KEY, scope TEXT NOT NULL, owner_agent TEXT, content TEXT NOT NULL,
      deleted_at INTEGER NOT NULL, cause TEXT NOT NULL, superseded_by INTEGER
    );
  `);
  db.close();
  return dbPath;
}

function insertMemory(dbPath: string, row: Record<string, unknown>): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO memories (scope, owner_agent, kind, content, status, salience, subject,
       source_kind, source_run_id, created_at, updated_at, reference_count)
     VALUES (@scope, @owner_agent, @kind, @content, @status, @salience, @subject,
       @source_kind, @source_run_id, @created_at, @updated_at, @reference_count)`
  ).run({
    owner_agent: null, status: null, subject: null, source_run_id: null, reference_count: 0,
    ...row,
  });
  db.close();
}

function insertTombstone(dbPath: string, row: Record<string, unknown>): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO memory_tombstones (id, scope, owner_agent, content, deleted_at, cause, superseded_by)
     VALUES (@id, @scope, @owner_agent, @content, @deleted_at, @cause, @superseded_by)`
  ).run({ owner_agent: null, superseded_by: null, ...row });
  db.close();
}

describe('readMemories', () => {
  it('reads and maps a shared and a private row, converting seconds to milliseconds', () => {
    const dbPath = tempMemoryDb();
    insertMemory(dbPath, { scope: 'shared', kind: 'decision', content: 'A shared decision.', salience: 4, source_kind: 'run', created_at: 1000, updated_at: 1000 });
    insertMemory(dbPath, { scope: 'private', owner_agent: 'CINDER', kind: 'habit', content: 'A private habit.', salience: 3, source_kind: 'run', created_at: 2000, updated_at: 2000 });

    const rows = readMemories(dbPath);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBe(2);
    const shared = rows!.find((r) => r.scope === 'shared')!;
    expect(shared).toMatchObject({ scope: 'shared', kind: 'decision', content: 'A shared decision.', salience: 4, ownerAgent: null });
    expect(shared.createdAtMs).toBe(1_000_000); // 1000s -> 1,000,000ms
    const priv = rows!.find((r) => r.scope === 'private')!;
    expect(priv).toMatchObject({ scope: 'private', ownerAgent: 'CINDER', kind: 'habit' });
  });

  it('returns an empty array (not null) when the memories table exists but has no rows', () => {
    const dbPath = tempMemoryDb();
    expect(readMemories(dbPath)).toEqual([]);
  });

  it('returns null when the database file does not exist', () => {
    const dbPath = tempMemoryDb({ withMemoriesTable: false });
    expect(readMemories(dbPath)).toBeNull();
  });
});

describe('readMemoryTombstones', () => {
  it('reads and maps a tombstone row, converting seconds to milliseconds', () => {
    const dbPath = tempMemoryDb();
    insertTombstone(dbPath, { id: 1, scope: 'private', owner_agent: 'CINDER', content: 'Old content.', deleted_at: 3000, cause: 'superseded', superseded_by: 2 });

    const rows = readMemoryTombstones(dbPath);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBe(1);
    expect(rows![0]).toMatchObject({ id: 1, scope: 'private', ownerAgent: 'CINDER', content: 'Old content.', cause: 'superseded', supersededBy: 2 });
    expect(rows![0].deletedAtMs).toBe(3_000_000);
  });

  it('returns null when the database file does not exist', () => {
    const dbPath = tempMemoryDb({ withMemoriesTable: false });
    expect(readMemoryTombstones(dbPath)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `electron/`): `npx vitest run memoryStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Use the exact code from `docs/superpowers/specs/2026-08-01-memory-layer2-phase-d-surface-design.md` §2.1 verbatim (the full `electron/memoryStore.ts` code block is already written there — copy it, do not re-derive it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run memoryStore.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/memoryStore.ts electron/memoryStore.test.ts
git commit -m "feat(memory-layer-2): add read-only memory.db reader for Electron main"
```

---

### Task 2: Wire polling + IPC into `electron/main.ts` and `electron/preload.ts`

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`

**Interfaces:**
- Consumes: `readMemories`, `readMemoryTombstones` (Task 1).
- Produces: `memory:snapshot`/`memory:tombstones` IPC events, `window.aetherElectron.memory.{onSnapshot,onTombstones}` — used by Task 3.

- [ ] **Step 1: Read the current files in full**

Read `electron/main.ts` and `electron/preload.ts` completely before editing — find the exact current lines for `collectorDbPath`, `FLEET_SCAN_INTERVAL_MS`/`DIAGNOSTICS_SCAN_INTERVAL_MS`, `scanAndPushFleet`/`scanAndPushDiagnostics`, their `setInterval` wiring, and the immediate-call-at-startup pattern (each existing scan function is called once immediately in addition to being intervalled — find where). Also find `fleet:`'s exact block in `preload.ts` (`contextBridge.exposeInMainWorld('aetherElectron', { ... fleet: { onSnapshot: ... } ... })`).

- [ ] **Step 2: Add to `electron/main.ts`**

Add the import:

```typescript
import { readMemories, readMemoryTombstones } from './memoryStore';
```

Add near `collectorDbPath`'s definition:

```typescript
const memoryDbPath = join(os.homedir(), '.aether-os', 'memory.db');
const MEMORY_SCAN_INTERVAL_MS = 15000; // matches FLEET_SCAN_INTERVAL_MS/DIAGNOSTICS_SCAN_INTERVAL_MS
```

Add near `scanAndPushFleet`/`scanAndPushDiagnostics`:

```typescript
function scanAndPushMemory(): void {
  if (!mainWindow) return;
  const rows = readMemories(memoryDbPath);
  sendToWindow('memory:snapshot', rows);
  const tombstones = readMemoryTombstones(memoryDbPath);
  sendToWindow('memory:tombstones', tombstones);
}
```

Wire `scanAndPushMemory` into the same place `scanAndPushFleet`/`scanAndPushDiagnostics` are: one immediate call at startup, and one `setInterval(scanAndPushMemory, MEMORY_SCAN_INTERVAL_MS)` alongside the existing `setInterval(scanAndPushFleet, FLEET_SCAN_INTERVAL_MS)`/`setInterval(scanAndPushDiagnostics, DIAGNOSTICS_SCAN_INTERVAL_MS)` calls.

- [ ] **Step 3: Add to `electron/preload.ts`**

Inside the `contextBridge.exposeInMainWorld('aetherElectron', { ... })` object, add a `memory` key alongside the existing `fleet` key:

```typescript
memory: {
  onSnapshot: (cb: (rows: unknown) => void) => {
    const listener = (_event: unknown, rows: unknown) => cb(rows);
    ipcRenderer.on('memory:snapshot', listener);
    return () => ipcRenderer.removeListener('memory:snapshot', listener);
  },
  onTombstones: (cb: (rows: unknown) => void) => {
    const listener = (_event: unknown, rows: unknown) => cb(rows);
    ipcRenderer.on('memory:tombstones', listener);
    return () => ipcRenderer.removeListener('memory:tombstones', listener);
  },
},
```

(Match `fleet`'s exact TypeScript typing convention in this file rather than `unknown` if `fleet`'s callback types are more specific — check the current file and mirror it exactly, including wherever `window.aetherElectron`'s type is declared, likely `src/aetherElectron.d.ts` per this repo's naming pattern seen in git history. If such a `.d.ts` file exists, add the `memory` namespace's type there too, mirroring `fleet`'s entry.)

- [ ] **Step 4: Verify build**

Run (from `electron/`, or repo root — check `package.json` for the actual script name): the TypeScript build/typecheck command for the `electron/` package. Expected: exits 0, no errors. (No new tests in this task — `main.ts`/`preload.ts` are process-entry files without their own unit test suites in this codebase; verification is the typecheck plus Task 1's already-passing reader tests.)

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts electron/preload.ts src/aetherElectron.d.ts
git commit -m "feat(memory-layer-2): poll memory.db and push snapshots over IPC"
```

(Adjust the file list if `src/aetherElectron.d.ts` doesn't exist or has a different name — use whatever Step 3 actually found and edited.)

---

### Task 3: State layer — types, reducer, retire all six `MemoryStub` sites, `memSeq`

> **Corrected mid-implementation.** The design doc's audit only searched for
> `MemoryStub`-*construction* sites, missing two *consumption* sites that
> also needed removal: `src/state/tick.ts` (the actual strength-decay tick,
> `m.strength - 0.4` every cycle — the literal mechanism this phase retires)
> and `src/components/dashboard/SystemsCard.tsx` (a dashboard "Pinned" stat
> row). Both are now in this task's scope. Also, `src/state/persistence.ts`
> was listed but its test file, `persistence.test.ts`, was not — three of
> its tests reference the old `MemoryStub`/`memSeq` shape directly and
> needed the same treatment as `reducer.test.ts`.

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/state/reducer.ts`
- Modify: `src/state/reducer.test.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/persistence.ts`
- Modify: `src/state/persistence.test.ts`
- Modify: `src/state/tick.ts`
- Modify: `src/state/tick.test.ts`
- Modify: `src/components/dashboard/SystemsCard.tsx`

**Interfaces:**
- Produces: `MemoryRow`, `MemoryTombstone` (types), `SET_MEMORIES`, `SET_MEMORY_TOMBSTONES`, `SET_MEMORY_SCOPE_FILTER`, `TOGGLE_MEMORY_TOMBSTONE_VIEW` (actions) — used by Task 4 (sync hook dispatches `SET_MEMORIES`/`SET_MEMORY_TOMBSTONES`) and Task 6 (components dispatch the filter/toggle actions).

- [ ] **Step 1: Read all five files in full**

This task touches five files with real cross-references (removing `MemoryStub` from `types.ts` breaks every file that imports it until they're all updated in the same pass) — read all five before making any edit.

- [ ] **Step 2: `src/state/types.ts`**

Replace the `MemoryStub` interface with:

```typescript
export type MemoryScope = 'shared' | 'private';
export type MemoryKind = 'decision' | 'preference' | 'overrule' | 'habit' | 'revision';
export type MemoryStatus = 'open' | 'moving' | 'settled';

export interface MemoryRow {
  id: number;
  scope: MemoryScope;
  ownerAgent: string | null;
  kind: MemoryKind;
  content: string;
  status: MemoryStatus | null;
  salience: number;
  subject: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  referenceCount: number;
}

export interface MemoryTombstone {
  id: number;
  scope: MemoryScope;
  ownerAgent: string | null;
  content: string;
  deletedAtMs: number;
  cause: 'superseded' | 'operator' | 'invalidated';
  supersededBy: number | null;
}
```

In `AetherState`: change `memories: MemoryStub[]` to `memories: MemoryRow[]`; remove `memSeq: number`; add `memoryTombstones: MemoryTombstone[]`, `memoryScopeFilter: 'all' | 'shared' | string`, `memoryShowTombstones: boolean`. Leave `selectedMemory: string | null` unchanged.

- [ ] **Step 3: `src/state/initialState.ts`**

Change `memories: [...]` (the hardcoded fake seed array) to `memories: []`. Remove `memSeq: 5`. Add `memoryTombstones: []`, `memoryScopeFilter: 'all'`, `memoryShowTombstones: false`.

- [ ] **Step 4: `src/state/persistence.ts`**

Remove the `memSeq: state.memSeq` line (`persistence.ts:73`). Check whether `memories` itself is persisted here (if so, decide based on what's actually in the file: real collector data shouldn't round-trip through this app's own local persistence layer as if it were locally-owned state, since it's re-fetched from `memory.db` on every poll — if `persistence.ts` currently persists `memories`, remove that too, matching how `realAgents`/`realUsage` — other collector-sourced fields — are handled in this same file; read the file to confirm the existing convention for collector-sourced vs. locally-owned state before deciding).

- [ ] **Step 5: `src/state/reducer.ts`**

Remove `TOGGLE_MEMORY_PIN` from the action union and its `case` block.

Add to the action union:

```typescript
| { type: 'SET_MEMORIES'; memories: MemoryRow[] }
| { type: 'SET_MEMORY_TOMBSTONES'; tombstones: MemoryTombstone[] }
| { type: 'SET_MEMORY_SCOPE_FILTER'; filter: string }
| { type: 'TOGGLE_MEMORY_TOMBSTONE_VIEW' }
```

Add cases:

```typescript
case 'SET_MEMORIES':
  return { ...state, memories: action.memories };

case 'SET_MEMORY_TOMBSTONES':
  return { ...state, memoryTombstones: action.tombstones };

case 'SET_MEMORY_SCOPE_FILTER':
  return { ...state, memoryScopeFilter: action.filter };

case 'TOGGLE_MEMORY_TOMBSTONE_VIEW':
  return { ...state, memoryShowTombstones: !state.memoryShowTombstones };
```

Remove `resolveApproval`'s HIGH-risk memory-construction block (`reducer.ts:105-119` in the pre-edit file — find the exact current lines): delete the `memories`/`memSeq` local variables and the `if (req.risk === 'HIGH') { ... }` block that builds a `MemoryStub`, and remove `memories`/`memSeq` from the returned state object at the end of `resolveApproval` (keep every other field in that return unchanged — `agents`, `idleList`, `rate`, `chatActionResults`, `approvals`, `notifs` all stay exactly as they are; only `memories`/`memSeq` are removed from the return).

Remove `SET_REAL_AGENTS`'s completed-dispatch memory-construction block (`reducer.ts:205-229` pre-edit): delete the `memories`/`memSeq` local variables and the `for (const dispatch of completed) { memories = [...memories, {...}] }` block. Keep the `started`/`completed` detection and the `logs`-building loop for `started` dispatches unchanged — only the `memories`-pushing loop for `completed` dispatches is removed. Remove `memories`/`memSeq` from `SET_REAL_AGENTS`'s final returned object (keep `realAgents`, `recentCompletedDispatches`, `dispatchChannels`, `logs` unchanged).

Update the `import type { ... }` line at the top of the file: remove `MemoryStub`, add `MemoryRow`, `MemoryTombstone`.

- [ ] **Step 6: `src/state/reducer.test.ts`**

Read the file in full to find every test whose subject is being removed and every test that references `memories`/`memSeq`/`pinned`/`MemoryStub`. Specifically:
- Remove the `'TOGGLE_MEMORY_PIN flips pinned...'` test entirely (its subject no longer exists).
- Update the `'SELECT_MEMORY sets selectedMemory...'` test if it references any removed field on the seed memory objects — the action itself (`SELECT_MEMORY`) is unchanged, only make sure the test's own fixture data is valid under the new `MemoryRow` shape (or switch to constructing a minimal state with `memories: [{ id: 2, ... } as MemoryRow]` inline, whatever's cleanest given what the test actually checks).
- The approval-resolution tests (around former lines 67-76) that assert `approved.memories`/`denied.memories` grew by one and check `.name` on the last entry — these assert exactly the behavior Step 5 removes. Rewrite them to assert `memories` is **unchanged** by an approval resolution (`expect(approved.memories).toEqual(initialState.memories)`), since that field is no longer touched by this action at all. Do NOT delete these tests outright — a HIGH-risk approval resolving should still correctly leave `memories` alone, which is worth pinning now that the coupling is gone.
- The dispatch-completion tests (around former lines 180-217) that assert `next.memories` grew — same treatment: rewrite to assert `memories` is unchanged by `SET_REAL_AGENTS`, keep whatever those tests also check about `logs`/`recentCompletedDispatches`/`dispatchChannels` (those parts of the tests are unaffected by this plan and must keep passing).
- Add one new small test: `SET_MEMORIES` replaces `state.memories` wholesale (mirror however this file already tests `SET_FLEET` or an equivalent wholesale-replace action, if one exists in this file, for the closest style match).

- [ ] **Step 7: Run tests**

Run (from repo root): `npx vitest run src/state/reducer.test.ts`
Expected: PASS — every test in the file, updated per Step 6.

- [ ] **Step 8: Run full root test suite and typecheck**

Run: `npx vitest run` (root package) and this repo's typecheck script (check `package.json`).
Expected: PASS / exits 0. This step will surface every OTHER file still importing `MemoryStub` or referencing `memSeq`/`pinned`/`strength` on a memory object that Tasks 3-4-6-7 haven't reached yet — if any such file exists outside this task's own file list, note it in your report; do not fix files outside this task's declared scope, the later tasks in this plan cover them.

- [ ] **Step 9: Commit**

```bash
git add src/state/types.ts src/state/reducer.ts src/state/reducer.test.ts src/state/initialState.ts src/state/persistence.ts
git commit -m "feat(memory-layer-2): retire MemoryStub/memSeq, add real MemoryRow state + actions"
```

---

### Task 4: `src/state/useMemorySync.ts` — the sync hook

**Files:**
- Create: `src/state/useMemorySync.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `window.aetherElectron.memory` (Task 2), `SET_MEMORIES`/`SET_MEMORY_TOMBSTONES` (Task 3).
- Produces: `useMemorySync()`, mounted in `App.tsx` — nothing later in this plan consumes it directly (it's a leaf effect, like `useFleetSync`).

- [ ] **Step 1: Read `src/state/useFleetSync.ts` and `src/App.tsx` in full**

- [ ] **Step 2: Create `src/state/useMemorySync.ts`**

```typescript
import { useEffect } from 'react';
import { useAetherStore } from './store';

export function useMemorySync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const memory = window.aetherElectron?.memory;
    if (!memory) return;
    const offSnapshot = memory.onSnapshot((rows) => dispatch({ type: 'SET_MEMORIES', memories: rows ?? [] }));
    const offTombstones = memory.onTombstones((rows) => dispatch({ type: 'SET_MEMORY_TOMBSTONES', tombstones: rows ?? [] }));
    return () => {
      offSnapshot();
      offTombstones();
    };
  }, [dispatch]);
}
```

- [ ] **Step 3: Wire into `App.tsx`**

Add the import (`import { useMemorySync } from './state/useMemorySync';`), add a `MemorySync` wrapper component mirroring `FleetSync`/`DiagnosticsSync` exactly (`function MemorySync() { useMemorySync(); return null; }`), and mount `<MemorySync />` alongside `<FleetSync />`/`<DiagnosticsSync />` in the render tree.

- [ ] **Step 4: Verify**

Run: this repo's typecheck script. Expected: exits 0. (No dedicated test file for this hook — matches `useFleetSync.ts`, which also has none; verification here is the typecheck plus Task 3's reducer tests already covering the actions it dispatches.)

- [ ] **Step 5: Commit**

```bash
git add src/state/useMemorySync.ts src/App.tsx
git commit -m "feat(memory-layer-2): mount memory sync hook in app root"
```

---

### Task 5: `memoryMath.ts` — replace, don't extend

**Files:**
- Modify: `src/components/memory/memoryMath.ts`
- Modify: `src/components/memory/memoryMath.test.ts`

**Interfaces:**
- Consumes: `MemoryRow` (Task 3).
- Produces: `pickSelectedMemory(memories: MemoryRow[], selected: string | null): MemoryRow | null`, `groupMemoriesByScope(memories: MemoryRow[]): { shared: MemoryRow[]; byAgent: Map<string, MemoryRow[]> }`, `KIND_TIER_COLOR(kind: MemoryRow['kind']): string` — used by Task 6.

- [ ] **Step 1: Read the current `memoryMath.ts` and `memoryMath.test.ts` in full**

- [ ] **Step 2: Write the failing tests**

Replace `memoryMath.test.ts`'s content (its existing tests assert `groupMemoriesForRoster`'s pinned/unpinned split and `STRENGTH_TIER_COLOR`'s tiers — both removed) with:

```typescript
import { describe, it, expect } from 'vitest';
import type { MemoryRow } from '../../state/types';
import { pickSelectedMemory, groupMemoriesByScope, KIND_TIER_COLOR } from './memoryMath';

function row(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: 1, scope: 'private', ownerAgent: 'CINDER', kind: 'habit', content: 'x',
    status: null, salience: 3, subject: null, createdAtMs: 0, updatedAtMs: 0,
    referenceCount: 0, ...overrides,
  };
}

describe('pickSelectedMemory', () => {
  it('returns the memory matching the stringified selected id', () => {
    const memories = [row({ id: 1 }), row({ id: 2 })];
    expect(pickSelectedMemory(memories, '2')?.id).toBe(2);
  });

  it('falls back to the first memory when selected is null', () => {
    const memories = [row({ id: 5 }), row({ id: 6 })];
    expect(pickSelectedMemory(memories, null)?.id).toBe(5);
  });

  it('falls back to the first memory when selected matches nothing', () => {
    const memories = [row({ id: 5 })];
    expect(pickSelectedMemory(memories, '999')?.id).toBe(5);
  });

  it('returns null for an empty list', () => {
    expect(pickSelectedMemory([], null)).toBeNull();
  });
});

describe('groupMemoriesByScope', () => {
  it('splits shared rows and groups private rows by ownerAgent', () => {
    const memories = [
      row({ id: 1, scope: 'shared', ownerAgent: null, kind: 'decision' }),
      row({ id: 2, scope: 'private', ownerAgent: 'CINDER' }),
      row({ id: 3, scope: 'private', ownerAgent: 'FORGE' }),
      row({ id: 4, scope: 'private', ownerAgent: 'CINDER' }),
    ];
    const { shared, byAgent } = groupMemoriesByScope(memories);
    expect(shared.map((m) => m.id)).toEqual([1]);
    expect(byAgent.get('CINDER')?.map((m) => m.id)).toEqual([2, 4]);
    expect(byAgent.get('FORGE')?.map((m) => m.id)).toEqual([3]);
  });

  it('skips a private row with a null ownerAgent rather than throwing', () => {
    const memories = [row({ scope: 'private', ownerAgent: null })];
    const { byAgent } = groupMemoriesByScope(memories);
    expect(byAgent.size).toBe(0);
  });

  it('returns an empty shared array and empty map for no memories', () => {
    const { shared, byAgent } = groupMemoriesByScope([]);
    expect(shared).toEqual([]);
    expect(byAgent.size).toBe(0);
  });
});

describe('KIND_TIER_COLOR', () => {
  it('returns a color for every MemoryKind without throwing', () => {
    const kinds: MemoryRow['kind'][] = ['decision', 'preference', 'overrule', 'habit', 'revision'];
    for (const kind of kinds) {
      expect(typeof KIND_TIER_COLOR(kind)).toBe('string');
      expect(KIND_TIER_COLOR(kind).length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run (from repo root): `npx vitest run src/components/memory/memoryMath.test.ts`
Expected: FAIL — `groupMemoriesByScope`/`KIND_TIER_COLOR` not exported yet.

- [ ] **Step 4: Rewrite `memoryMath.ts`**

Use the code from `docs/superpowers/specs/2026-08-01-memory-layer2-phase-d-surface-design.md` §4 verbatim (already written there) for `pickSelectedMemory`, `groupMemoriesByScope`, `KIND_TIER_COLOR`. Remove `groupMemoriesForRoster` and `STRENGTH_TIER_COLOR` entirely — nothing calls them after this task (Task 6 re-points the components that did).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/components/memory/memoryMath.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/memory/memoryMath.ts src/components/memory/memoryMath.test.ts
git commit -m "feat(memory-layer-2): replace memoryMath with scope-based grouping, no strength/pinned"
```

---

### Task 6: Re-point `MemoryRosterCard.tsx`/`MemoryDetailCard.tsx`/`MemoryView.tsx`

**Files:**
- Modify: `src/components/memory/MemoryRosterCard.tsx`
- Modify: `src/components/memory/MemoryRosterCard.test.tsx`
- Modify: `src/components/memory/MemoryDetailCard.tsx`
- Modify: `src/components/memory/MemoryView.tsx`

**Interfaces:**
- Consumes: `MemoryRow`, `MemoryTombstone` (Task 3); `pickSelectedMemory`, `groupMemoriesByScope`, `KIND_TIER_COLOR` (Task 5); `SET_MEMORY_SCOPE_FILTER`, `TOGGLE_MEMORY_TOMBSTONE_VIEW` (Task 3).
- Produces: nothing new — this is the plan's UI-surface task.

- [ ] **Step 1: Read all four files in full**

Also re-read `docs/superpowers/specs/2026-08-01-memory-layer2-phase-d-surface-design.md` §5 (`MemoryRosterCard.tsx`/`MemoryDetailCard.tsx`/`MemoryView.tsx` subsections) — it specifies exactly what changes in each component; this step turns that prose spec into code against the real current files.

- [ ] **Step 2: `MemoryRosterCard.tsx`**

- Remove the `rememberText` state, `submitRemember` function, and the entire remember-input `<div>` row (the `<input>` + `+` `<Button>`).
- Remove `groupMemoriesForRoster` import; import `groupMemoriesByScope`, `KIND_TIER_COLOR` from `./memoryMath` instead.
- Add scope-filter controls: derive the agent list via `groupMemoriesByScope(state.memories).byAgent` keys; render a row of small toggle `Button`s (or a native `<select>`, whichever better matches this file's existing `Button`-based idiom on inspection) for "All" / "Shared" / one per agent, each dispatching `{ type: 'SET_MEMORY_SCOPE_FILTER', filter: <value> }`. Apply the filter as a plain `.filter()` over `state.memories` before grouping/rendering (`'all'` → no filter; `'shared'` → `m.scope === 'shared'`; any other string → `m.scope === 'private' && m.ownerAgent === filterValue`).
- Add a tombstone-view toggle `Button` (small icon-button style, matching the existing `rememberButtonStyle` class of control being removed) dispatching `{ type: 'TOGGLE_MEMORY_TOMBSTONE_VIEW' }`. When `state.memoryShowTombstones` is true, the roster's row source becomes `state.memoryTombstones` (filtered by the same scope filter, comparing `t.scope`/`t.ownerAgent`) instead of `state.memories`; render each tombstone row showing `content`/`scope`/`cause` (no `kind`/`salience` — tombstones don't have those fields).
- Rewrite the roster's grouping/rendering: replace the "PINNED"/"ENGRAMS" `<div>` blocks with one "SHARED" section (always shown when the current filter includes shared rows) and one section per agent key present in the filtered set (skip entirely when `memoryShowTombstones` is true — render a flat tombstone list instead, no shared/private grouping, since tombstones don't distinguish that way for display purposes here beyond the `scope` badge on each row).
- Row badge: show `m.kind` (was `m.source`) via `KIND_TIER_COLOR(m.kind)` for its accent color instead of `STRENGTH_TIER_COLOR(m.strength)`; drop the strength number badge entirely (nothing replaces it — `salience` may optionally render as a small `1-5` badge in that visual slot if it reads cleanly, but this is not required).
- Update the empty-state message (currently references `remember <text>`, which no longer exists) to something like "no memories captured yet" with no command hint.

- [ ] **Step 3: `MemoryRosterCard.test.tsx`**

The existing test (`'the remember-submit control is a real keyboard-native button'`) asserts on the removed `+` button — its subject no longer exists. Replace it with a test appropriate to what actually remains keyboard-accessible now (e.g. assert the scope-filter/tombstone-toggle controls render as real `<button>` elements, following the same `getByRole('button', ...)` pattern this file already uses) — write at least one test proving the new interactive controls are genuine buttons, not `<div onClick>`.

- [ ] **Step 4: `MemoryDetailCard.tsx`**

- Remove the strength bar (`trackStyle` div and its `${memory.strength}%` width), the strength percentage text, and `STRENGTH_TIER_COLOR` import/usage.
- Remove the PIN/UNPIN `Button` and its `TOGGLE_MEMORY_PIN` dispatch.
- Remove the `usage`/`state.dispatchUsage[memory.toolUseId]` block — `MemoryRow` has no `toolUseId`.
- Header: badge shows `memory.kind` (was `memory.source`), colored via `KIND_TIER_COLOR`; add a second small badge showing `memory.scope`, and for private rows, `memory.ownerAgent`.
- Timestamp line: show `memory.createdAtMs` formatted (match this file's existing date-formatting convention — check what `memory.ts` currently used, e.g. a shared `short`/date-format util already imported here); if `memory.updatedAtMs !== memory.createdAtMs`, show both (signals an `UPDATE`/`TOUCH` happened since creation).
- When the currently-selected item is a tombstone (`state.memoryShowTombstones` true), render its `cause` and, if `supersededBy` is set, a plain text note like `superseded by #${supersededBy}` (no navigation/linking required).
- Content section (the `applyDensity(...)` block) stays structurally the same, just fed from `memory.content`/tombstone `content` as appropriate.
- Update the empty-state message (currently references `remember <text>`) similarly to Step 2's roster empty-state fix.

- [ ] **Step 5: `MemoryView.tsx`**

Minimal — `pickSelectedMemory(state.memories, state.selectedMemory)` already works against the new `MemoryRow[]` shape (Task 5 kept the same function signature). Confirm no other reference in this file needs updating; if `MemoryDetailCard`/`MemoryRosterCard` now need additional props (e.g. tombstone-aware selection), thread them through here. No layout change (still two-column).

- [ ] **Step 6: Run tests**

Run (from repo root): `npx vitest run src/components/memory/`
Expected: PASS — all tests in the directory.

- [ ] **Step 7: Run full root test suite and typecheck**

Run: `npx vitest run` and the root typecheck script.
Expected: PASS / exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/components/memory/MemoryRosterCard.tsx src/components/memory/MemoryRosterCard.test.tsx src/components/memory/MemoryDetailCard.tsx src/components/memory/MemoryView.tsx
git commit -m "feat(memory-layer-2): re-point Memory view at real rows, add scope filter + tombstone view"
```

---

### Task 7: Retire `sweep`/`remember`/`kill`-memory/`approve`-`deny`-memory in `commands.ts`

**Files:**
- Modify: `src/components/terminal/commands.ts`
- Modify: `src/components/terminal/commands.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — this is the plan's terminal-command cleanup task.

- [ ] **Step 1: Read both files in full**

- [ ] **Step 2: `commands.ts`**

- Remove the `sweep` case entirely (`commands.ts:148-152` pre-edit).
- Remove the `remember` case entirely (`commands.ts:154-171` pre-edit).
- Remove the help-text lines for both (`'  sweep               run memory consolidation'`, `'  remember <text>     log a manual memory'`).
- In the `kill` case: remove the `memory`/`MemoryStub` construction and drop `memories: [...state.memories, memory]`/`memSeq: state.memSeq + 1` from its returned `patch` — keep everything else in that case (`agents`, `idleList`) unchanged.
- In the `approve`/`deny` case: remove the `memories`/`memSeq` local variables and the `if (req.risk === 'HIGH') { ... }` memory-construction block; drop `memories`/`memSeq` from the returned `patch` — keep `approvals`, `rate` unchanged.
- Update the `import type { ... }` line: remove `MemoryStub` if nothing else in this file references it after the above edits.

- [ ] **Step 3: `commands.test.ts`**

- Remove `'sweep'` and `'remember <text>'` from the help-text array test (the list of expected command names).
- Remove the two `remember`-specific tests (`'remember <text> logs a manual memory at full strength'`, `'remember with no text reports a usage error and no patch'`) entirely.
- Rewrite the `kill` test's assertion from `expect(result.patch?.memories).toHaveLength(...)` / `.at(-1)?.name` to assert `memories` is **absent from or unchanged in** the patch (check whatever the rest of that test still validates about `agents`/`idleList` and keep that part).
- Rewrite the `approve`/`deny` HIGH-risk tests similarly — remove the `.patch?.memories?.at(-1)?.name` assertions, keep whatever else those tests check (`approvals`, `rate`, output lines).
- Search the file for any other `sweep`/`remember` case-specific test blocks beyond the ones already named and remove/adjust them the same way.

- [ ] **Step 4: Run tests**

Run (from repo root): `npx vitest run src/components/terminal/commands.test.ts`
Expected: PASS — every remaining test.

- [ ] **Step 5: Commit**

```bash
git add src/components/terminal/commands.ts src/components/terminal/commands.test.ts
git commit -m "feat(memory-layer-2): retire sweep/remember commands and kill/approve-deny memory synthesis"
```

---

### Task 8: Full-suite verification

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces: nothing — this is the plan's final gate.

- [ ] **Step 1: Search for any remaining `MemoryStub`/`memSeq`/`pinned`/`strength`-on-memory reference**

Run: `grep -rn "MemoryStub\|memSeq" src/ electron/ --include="*.ts" --include="*.tsx"` (excluding `dist/`/`node_modules/` if the grep tool doesn't already). Expected: zero matches. If any remain, they are a real gap in an earlier task — go back and fix that task's files, do not patch around it here.

- [ ] **Step 2: Run both packages' full test suites**

Run (repo root): `npx vitest run`
Run (`collector/` — unaffected by this plan, confirm it's still green as a sanity check that nothing outside this plan's scope broke): `cd collector && npx vitest run`

Expected: both PASS in full.

- [ ] **Step 3: Run both packages' typechecks**

Run the root package's typecheck script and `electron/`'s (check both `package.json`s for the actual script names — likely `tsc --noEmit` or similar for the root, `tsc -b` for `electron/` if it has its own `tsconfig.json`).
Expected: both exit 0.

- [ ] **Step 4: Manual GUI verification**

Per this repo's `CLAUDE.md` convention ("For UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete"): start the app (`npm start` or this repo's equivalent dev script) and, using Electron remote debugging + CDP per this repo's established GUI-verification convention (`Input` domain for trusted clicks, `Runtime.evaluate` for DOM inspection — never PrintWindow/SendInput), confirm:
- The Memory tab loads without error and shows either real data (if a `memory.db` exists on this machine with rows in it) or a clean empty state (if not) — no crash either way.
- The scope-filter controls render and are clickable.
- The tombstone-view toggle renders and is clickable, and swaps the roster's displayed rows.
- The Terminal's `help` output no longer lists `sweep`/`remember`.
- Typing `sweep` or `remember foo` into the Terminal produces the "unknown command" fallback, not a crash.

Report exactly what was observed (with a screenshot if this environment supports capturing one) — do not claim GUI verification passed without having actually driven the app.

- [ ] **Step 5: Commit (if Step 4 surfaced any fix)**

Only if Step 4 found something needing a code change — otherwise this task produces no commit, it's pure verification. If a fix is needed, make the smallest correction in the relevant already-touched file, re-verify, and commit as `fix(memory-layer-2): <what was wrong>`.

---

## What this plan deliberately does not cover

(Mirrors `docs/superpowers/specs/2026-08-01-memory-layer2-phase-d-surface-design.md` §6.)

- **A write path for the Memory view.** Read-only by design.
- **A replacement activity-log surface** for the approval/dispatch/kill events that no longer appear in the Memory tab — confirmed as an acceptable loss from that specific screen (design doc §3), since each already surfaces elsewhere.
- **Cross-agent tombstone visibility rules.** This surface already reads every row unscoped (operator-facing, not agent-facing) — no open question to resolve.
- **Real-time push on every memory write.** 15s poll, matching every other collector-backed view in this app.
- **Wiring `runExtractor`'s actual trigger conditions further, or Phase E's scoring-weight tuning.** Out of scope for this UI-surface plan entirely.
