# Memory Layer 2 — Phase D (The Surface) Design

**Design document**
Status: approved, ready for implementation plan
Companion to: `AETHER_MEMORY_LAYER_2.md` §7 (Phase D is this section's build item)

---

## 0. What this is

Phase D's spec checklist (`AETHER_MEMORY_LAYER_2.md:758-762`):

```
- [ ] Retire `MemoryStub` / `strength` / `sweep` / `pinned`
- [ ] Re-point roster + detail at collector rows
- [ ] Scope filter and tombstone view
```

Unlike Phases A–C, this phase's surface area is the **Electron app** (`src/`, `electron/`), not the collector. Nothing in `collector/` changes. The Memory view (`src/components/memory/`) currently renders entirely fake, locally-generated data — no memory-related IPC channel exists anywhere in `electron/main.ts` today. This document is the wiring: read-only IPC from `memory.db` into the renderer, replacing the fake `MemoryStub` model.

---

## 1. What's being retired, and why

`src/state/types.ts`'s `MemoryStub` (`{ id, name, content, source, ts, pinned, strength, toolUseId? }`) and everything downstream of it is **themed simulation**, per `AETHER_MEMORY_LAYER_2.md` §7: `strength` decays over time, `sweep` prunes weak unpinned entries, `pinned` protects an entry from that sweep. This is the exact anti-pattern the Layer 2 design rejects — *"a decision does not get less true because it has not come up lately."*

Three things are retired outright, all downstream of the same fake model:

1. **`strength`/`STRENGTH_TIER_COLOR`/decay.** No analogue in the real store — `MemoryRow` has no strength field. §5's hard-delete (SUPERSEDE) is the real store's only "this stopped being true" mechanism, and it's not gradual.
2. **`sweep` (terminal command).** Currently prunes `!pinned && strength <= 30`. Nothing to prune under the real model — there is no decaying field, and the real store's invalidation is Phase-A's `deleteMemory`/`SUPERSEDE`, not a client-side sweep.
3. **`remember <text>` (terminal command) and `pinned`.** Manual free-text memory entry has no path in the real architecture: `memory.db` has exactly one writer, the collector process (§3.1's single-writer invariant, structural, not a convention) — the Electron app has no legitimate write path to it at all, read-only is the only option. Separately, and just as decisive on its own: Layer 2's P1 principle is that memory is *never self-reported* — always extractor-written, runtime-validated. A user typing free text into a box and having it become a "memory" verbatim is exactly the self-report pattern P1 forbids, independent of which process would technically hold the pen. `pinned` (a UI-only affordance for protecting an entry from `sweep`) has nothing left to protect once `sweep` is gone — §4.4 already establishes that every shared entry is unconditionally injected, so "pinning" a shared entry is already a no-op today, and a private entry's real protection is `status`/`salience`/`kind`, not a boolean pin flag.

**What replaces them:** the real store fields — `scope`, `owner_agent`, `kind`, `content`, `status`, `salience`, `subject`, `created_at`, `updated_at`, `reference_count` — read directly, unconditional-shared-injection semantics preserved from §4.4 (no client-side filtering of shared entries), private entries shown as `scorePrivateCandidate`-ranked (matching what the extractor itself sees).

---

## 2. The read path — mirrors `electron/collectorStore.ts` exactly

`electron/collectorStore.ts` already establishes the pattern for every other collector-backed view (usage, fleet, diagnostics): a read-only `DatabaseSync` open, a schema-version gate, row-to-camelCase mapping, `try/finally` close. This document adds the same shape for `memory.db`.

### 2.1 New file: `electron/memoryStore.ts`

```ts
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

export type MemoryScope = 'shared' | 'private';
export type MemoryKind = 'decision' | 'preference' | 'overrule' | 'habit' | 'revision';
export type MemoryStatus = 'open' | 'moving' | 'settled';

export interface MemoryRowUI {
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

export interface MemoryTombstoneUI {
  id: number;
  scope: MemoryScope;
  ownerAgent: string | null;
  content: string;
  deletedAtMs: number;
  cause: 'superseded' | 'operator' | 'invalidated';
  supersededBy: number | null;
}

function openReadOnly(dbPath: string): DatabaseSync | null {
  if (!existsSync(dbPath)) return null;
  try {
    const sqlite = require('node:sqlite');
    return new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

// memory.db has no schema_meta table (unlike collector.db) -- Phase A's
// migrate() is a guarded-ALTER pattern keyed on PRAGMA table_info, not a
// version counter. Table existence is the liveness signal here: an absent
// `memories` table means the collector has never opened this store.
function hasMemoriesTable(db: DatabaseSync): boolean {
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
      .get();
    return !!row;
  } catch {
    return false;
  }
}

export function readMemories(dbPath: string): MemoryRowUI[] | null {
  const db = openReadOnly(dbPath);
  if (!db) return null;
  try {
    if (!hasMemoriesTable(db)) return null;
    const rows = db
      .prepare(
        `SELECT id, scope, owner_agent, kind, content, status, salience, subject,
                created_at, updated_at, reference_count
         FROM memories ORDER BY scope ASC, kind ASC, salience DESC, created_at ASC`
      )
      .all() as {
      id: number; scope: string; owner_agent: string | null; kind: string; content: string;
      status: string | null; salience: number; subject: string | null;
      created_at: number; updated_at: number; reference_count: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope as MemoryScope,
      ownerAgent: r.owner_agent,
      kind: r.kind as MemoryKind,
      content: r.content,
      status: r.status as MemoryStatus | null,
      salience: r.salience,
      subject: r.subject,
      createdAtMs: r.created_at * 1000,
      updatedAtMs: r.updated_at * 1000,
      referenceCount: r.reference_count,
    }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function readMemoryTombstones(dbPath: string): MemoryTombstoneUI[] | null {
  const db = openReadOnly(dbPath);
  if (!db) return null;
  try {
    if (!hasMemoriesTable(db)) return null;
    const rows = db
      .prepare(
        `SELECT id, scope, owner_agent, content, deleted_at, cause, superseded_by
         FROM memory_tombstones ORDER BY deleted_at DESC`
      )
      .all() as {
      id: number; scope: string; owner_agent: string | null; content: string;
      deleted_at: number; cause: string; superseded_by: number | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope as MemoryScope,
      ownerAgent: r.owner_agent,
      content: r.content,
      deletedAtMs: r.deleted_at * 1000,
      cause: r.cause as MemoryTombstoneUI['cause'],
      supersededBy: r.superseded_by,
    }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}
```

**No private-scope scoring/ranking in the read path.** `readMemories` returns every row, unfiltered and unranked — `scorePrivateCandidate` (collector-side, Phase C) is a *retrieval-for-extraction* ranking, not a *display* ranking. The Memory view is an audit surface (§7: "the roster... the audit path from §5 needs a surface, and this is it") — a human browsing their own memory store wants to see everything, groupable/filterable, not a truncated top-N. Client-side grouping/sorting for display is `memoryMath.ts`'s job (§4 below), operating on the full set.

**Timestamps converted seconds→ms at the read boundary** (`* 1000`), matching every other UI-facing timestamp in this codebase (`Date.now()`-based), so `memoryMath.ts` and the components never have to remember which unit a given field is in.

### 2.2 `electron/main.ts` wiring

Three additions, each mirroring the existing `readFleetSessions`/`scanAndPushFleet` shape exactly:

```ts
import { readMemories, readMemoryTombstones } from './memoryStore';

const memoryDbPath = join(os.homedir(), '.aether-os', 'memory.db');
const MEMORY_SCAN_INTERVAL_MS = 15000; // matches FLEET_SCAN_INTERVAL_MS/DIAGNOSTICS_SCAN_INTERVAL_MS

function scanAndPushMemory(): void {
  if (!mainWindow) return;
  const rows = readMemories(memoryDbPath);
  sendToWindow('memory:snapshot', rows);
  const tombstones = readMemoryTombstones(memoryDbPath);
  sendToWindow('memory:tombstones', tombstones);
}
```

...wired into the existing `setInterval` block alongside `scanAndPushFleet`/`scanAndPushDiagnostics`, plus one immediate call at startup (matching the existing pattern for those two).

### 2.3 `electron/preload.ts`

New `memory` namespace on `window.aetherElectron` (`electron/preload.ts:14`, `contextBridge.exposeInMainWorld('aetherElectron', {...})` — confirmed against the current file), mirroring `fleet`'s exact shape:

```ts
memory: {
  onSnapshot: (cb: (rows: MemoryRowUI[] | null) => void) => {
    const listener = (_event: unknown, rows: MemoryRowUI[] | null) => cb(rows);
    ipcRenderer.on('memory:snapshot', listener);
    return () => ipcRenderer.removeListener('memory:snapshot', listener);
  },
  onTombstones: (cb: (rows: MemoryTombstoneUI[] | null) => void) => {
    const listener = (_event: unknown, rows: MemoryTombstoneUI[] | null) => cb(rows);
    ipcRenderer.on('memory:tombstones', listener);
    return () => ipcRenderer.removeListener('memory:tombstones', listener);
  },
},
```

### 2.4 `src/state/useMemorySync.ts` (new, mirrors `useFleetSync.ts`)

```ts
import { useEffect } from 'react';
import { useAetherStore } from './store';

export function useMemorySync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const memory = window.aetherElectron?.memory;
    if (!memory) return;
    const offSnapshot = memory.onSnapshot((rows) => dispatch({ type: 'SET_MEMORIES', memories: rows ?? [] }));
    const offTombstones = memory.onTombstones((rows) => dispatch({ type: 'SET_MEMORY_TOMBSTONES', tombstones: rows ?? [] }));
    return () => { offSnapshot(); offTombstones(); };
  }, [dispatch]);
}
```

Wired into the app root alongside `useFleetSync()`/`useDiagnosticsSync()` (find and match their exact mount point).

---

## 3. State shape changes

`src/state/types.ts`:

- **Remove** `MemoryStub`.
- **Add** `MemoryRow` and `MemoryTombstone` (renderer-side names for the IPC payload shapes in §2.1 — re-declared here rather than imported from `electron/`, matching this codebase's existing convention of not sharing types across the `electron/`↔`src/` boundary via import, only via IPC payload shape agreement).
- `AetherState.memories: MemoryStub[]` → `memories: MemoryRow[]`.
- **Add** `AetherState.memoryTombstones: MemoryTombstone[]`.
- **Add** `AetherState.memoryScopeFilter: 'all' | 'shared' | string` (an `owner_agent` value selects that agent's private rows; `'shared'` selects shared rows; `'all'` is unfiltered) and `AetherState.memoryShowTombstones: boolean`.
- `selectedMemory: string | null` stays (already a string id, compatible with the new numeric `id` via `String(id)`, matching `pickSelectedMemory`'s existing `String(m.id) === selected` comparison).

`src/state/reducer.ts`:

- **Remove** the three inline `MemoryStub`-constructing blocks (currently at the three sites listed in the file's own grep — dispatch-completion tick handling, `RUN_COMMAND` intermediate patches, etc.) — these were the "fake data generator," now replaced by real IPC snapshots.
- **Remove** `TOGGLE_MEMORY_PIN` action and its case.
- **Add** `SET_MEMORIES` (`{ type: 'SET_MEMORIES'; memories: MemoryRow[] }`) — replaces `state.memories` wholesale, matching `SET_FLEET`'s existing pattern.
- **Add** `SET_MEMORY_TOMBSTONES` similarly.
- **Add** `SET_MEMORY_SCOPE_FILTER` (`{ type: 'SET_MEMORY_SCOPE_FILTER'; filter: string }`) and `TOGGLE_MEMORY_TOMBSTONE_VIEW` (`{ type: 'TOGGLE_MEMORY_TOMBSTONE_VIEW' }`).
- `SELECT_MEMORY` stays unchanged in shape.

`src/components/terminal/commands.ts`:

- **Remove** the `sweep` case entirely.
- **Remove** the `remember` case entirely.
- **Remove** both commands' `help` lines (`'  sweep               run memory consolidation'`, `'  remember <text>     log a manual memory'`).
- **Remove** the memory-constructing block inside whatever other command currently builds a `MemoryStub` (the third site the earlier grep found, at the dispatch-completion path) — dispatch-completion no longer fabricates a memory client-side; real memories arrive only via `SET_MEMORIES` from the collector.

---

## 4. `memoryMath.ts` — replaced, not extended

Current exports (`pickSelectedMemory`, `groupMemoriesForRoster`, `STRENGTH_TIER_COLOR`) all operate on the retired `pinned`/`strength` fields. Replacement:

```ts
export function pickSelectedMemory(memories: MemoryRow[], selected: string | null): MemoryRow | null {
  if (selected) {
    const match = memories.find((m) => String(m.id) === selected);
    if (match) return match;
  }
  return memories[0] ?? null;
}

// Scope filter + optional tombstone-view swap happen in the roster component
// (§5) via a plain array filter over state.memories/state.memoryTombstones --
// no new pure function needed for that; it's a one-line .filter().

export function groupMemoriesByScope(memories: MemoryRow[]): { shared: MemoryRow[]; byAgent: Map<string, MemoryRow[]> } {
  const shared = memories.filter((m) => m.scope === 'shared');
  const byAgent = new Map<string, MemoryRow[]>();
  for (const m of memories) {
    if (m.scope !== 'private' || !m.ownerAgent) continue;
    const list = byAgent.get(m.ownerAgent) ?? [];
    list.push(m);
    byAgent.set(m.ownerAgent, list);
  }
  return { shared, byAgent };
}

// Replaces STRENGTH_TIER_COLOR. Colors by kind, not a decaying strength --
// there is nothing left that decays. Palette matches the existing accent
// tokens already used elsewhere in this view (colors.accentCyanSoft-family),
// not new brand colors.
export function KIND_TIER_COLOR(kind: MemoryRow['kind']): string {
  switch (kind) {
    case 'overrule': return '#f5c66b'; // highest-priority private signal
    case 'decision':
    case 'preference': return '#3be0a0'; // shared, in force
    case 'revision': return '#8fd6ff';
    case 'habit':
    default: return '#4e7c8b';
  }
}
```

**Agent list for the scope filter** is derived, not hardcoded: `[...groupMemoriesByScope(memories).byAgent.keys()]`. `owner_agent` values are whatever real `subagent_type` strings appear in actual dispatches (e.g. `general-purpose`, `code-reviewer`) — there is no fixed roster of agent names anywhere in this codebase to hardcode against.

---

## 5. Component changes

### 5.1 `MemoryRosterCard.tsx`

- **Remove** the `remember`-text input row and its `submitRemember` handler entirely (§1 — no write path exists).
- **Remove** the "PINNED"/"ENGRAMS" grouping (`groupMemoriesForRoster`); replace with scope-based grouping (`groupMemoriesByScope`) — a "SHARED" section (unconditionally listed, matching §4.4's "every agent, every run, no cap") and one section per distinct `owner_agent` present in the current filtered set.
- **Add** a scope-filter control (a row of small toggle buttons or a `<select>`, matching this component's existing `Button`-based style — no new UI library) driving `SET_MEMORY_SCOPE_FILTER`: "All", "Shared", then one entry per agent found via `groupMemoriesByScope`.
- **Add** a tombstone-view toggle (a `Button`, matching the existing `rememberButtonStyle`-class of small icon-button) driving `TOGGLE_MEMORY_TOMBSTONE_VIEW`. When on, the roster's data source swaps from `state.memories` to `state.memoryTombstones` (mapped into the same row-rendering shape: tombstones show `content`/`scope`/`cause` instead of `kind`/`salience`).
- Row rendering: badge shows `kind` (was `source`), no strength number badge (nothing to show — `salience` could optionally render here as a small `1-5` badge instead, matching the removed strength badge's visual slot).

### 5.2 `MemoryDetailCard.tsx`

- **Remove** the strength bar/percentage entirely (`trackStyle`, the `${memory.strength}%` width bar, `STRENGTH_TIER_COLOR` usage).
- **Remove** the PIN/UNPIN button and its `TOGGLE_MEMORY_PIN` dispatch.
- Header badge shows `kind` (was `source`); add a `scope` badge (shared/private) and, for private rows, the `ownerAgent`.
- Timestamp line shows `createdAtMs` (formatted, matching the existing `memory.ts` display convention) — add `updatedAtMs` if it differs from `createdAtMs` (signals the row has been `UPDATE`d or `TOUCH`ed since creation).
- Content section unchanged in structure (still runs through `applyDensity`).
- **Add**, when viewing a tombstone: `cause` and, if `supersededBy` is set, a note/link-by-id to the replacement (no live navigation required — a plain "superseded by #N" text is sufficient; Phase D's spec item is "a tombstone view," not cross-row navigation).
- `usage`/`dispatchUsage` lookup (`memory.toolUseId`) has no analogue in `MemoryRow` — **remove** that block. (The real store's provenance is `source_run_id`, not persisted into `MemoryRowUI` per §2.1 since nothing currently reads it; if a future need arises to show "which run produced this," add `sourceRunId` to `MemoryRowUI` then — not speculatively now, per YAGNI.)

### 5.3 `MemoryView.tsx`

Minimal change: `pickSelectedMemory(state.memories, ...)` still works against the new `MemoryRow[]` shape (§4's replacement keeps the same function signature shape). No structural layout change — still a two-column roster+detail, per the earlier UI-scope decision.

---

## 6. What this document deliberately does not cover

- **A write path for the Memory view.** Read-only by design (§1) — no future work implied here; if a write need ever arises, it's a new architectural decision, not an extension of this one.
- **Cross-agent tombstone visibility rules beyond "show everything."** Layer 2 spec's open decision #2 ("does an agent see its own tombstones?") is about *agent-facing* reads, which don't exist in this Electron surface at all — the Memory view is an *operator-facing* admin surface (already reading via `store.admin.*`-equivalent unscoped queries on the collector side, since `readMemories`/`readMemoryTombstones` read every row, not scoped to one agent). Not a gap this document needs to resolve.
- **Real-time push on every memory write.** 15s poll interval, matching every other collector-backed view. No event-driven push; consistent with this app's existing architecture throughout.
- **Salience/kind color palette bikeshedding.** `KIND_TIER_COLOR`'s exact hex values in §4 reuse colors already present elsewhere in this view; revisit only if a real visual review flags it.
