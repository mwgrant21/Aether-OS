# Settings hardening: Retention & Purge, Cost Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build two Settings cards — a Retention & Purge card that closes the `privacy-and-data.md` §6
requirement (visible store size/oldest-row readout plus a real "purge all collected data" action),
and a Cost Guard card that replaces the removed Chat backend settings with an honest statement of
what network paths actually exist post-Stage-13.5/17/18.

**Architecture:** A new `electron/retentionStore.ts` module owns both reading `collector.db`'s
current state (row counts, file size, oldest retained row — read-only connection) and purging it (a
second, short-lived writable connection, one transaction, then `VACUUM`). Two new IPC channels
(`retention:status`, `retention:purge`) expose this to the renderer through the existing
`window.aetherElectron` bridge. Two new presentational Settings cards consume it —
`RetentionCard.tsx` (live data, confirm-then-purge flow) and `CostGuardCard.tsx` (mostly static
copy, one live field reading existing `state.crossEngineCfg.enabled`).

**Tech Stack:** TypeScript, Electron (`node:sqlite` `DatabaseSync`), React, Vitest + Testing Library.

## Global Constraints

- `collector.db` tables (from `collector/src/schema.ts`): `schema_meta`, `events`, `daily_rollups`,
  `drift_log`, `usage_events`, `transcript_files`, `fleet_sessions`, `tool_calls`, `dispatches`,
  `anomalies`, `daily_anomaly_rollups`.
- Purge deletes exactly: `events, daily_rollups, drift_log, usage_events, fleet_sessions, tool_calls,
  dispatches, anomalies, daily_anomaly_rollups`. **Never** `schema_meta` (schema/heartbeat
  bookkeeping) or `transcript_files` (scan cursor — wiping it causes full history to silently
  re-ingest on the collector's next tick, undoing the purge).
- Purge never opens `memory.db` — a physically separate file, out of scope entirely.
- All local `.ts` imports between electron-side files use an explicit `.js` extension (nodenext
  module resolution) — e.g. `from './retentionStore.js'`. Type-only imports from `electron/` into
  `src/aetherElectron.d.ts` do **not** use `.js` (matches the existing `DiagnosticsSnapshot` import
  there).
- `node:sqlite` is accessed via `createRequire(import.meta.url)('node:sqlite')`, never a static
  `import` — matches every existing use in `electron/collectorStore.ts`, `electron/memoryStore.ts`,
  `electron/main.ts`.
- IPC channel naming: `retention:status`, `retention:purge` — matches the existing
  `crossEngine:status` / `crossEngine:connectCodexSubscription` convention.
- New Settings cards follow `CrossEngineVerificationCard.tsx`'s exact style-helper pattern
  (`cardStyle`, `titleStyle`, `toggleStyle`, `confirmWrapStyle`, `disclosureStyle`, `rowStyle`,
  `labelStyle`, `valueStyle`, `hintStyle` — same names, same shapes) and `StatuslineCard.tsx`'s
  fetch-on-mount + `refresh()`-after-action pattern.
- Byte formatting reuses `formatFileSize` from `src/components/files/attachmentsMath.ts` — do not
  write a second implementation.
- Test command: `npx vitest run <path>` for a single file, `npm run test` for the full suite.
  Typecheck: `npm run build` (`tsc -b && vite build`).

---

### Task 1: `retentionStore.ts` — read-only status

**Files:**
- Create: `electron/retentionStore.ts`
- Test: `electron/retentionStore.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RetentionRowCounts {
    events: number; dailyRollups: number; usageEvents: number; toolCalls: number;
    dispatches: number; anomalies: number; dailyAnomalyRollups: number;
    driftLog: number; fleetSessions: number;
  }
  export interface RetentionStatus {
    exists: boolean;
    fileSizeBytes: number;
    oldestRetainedAtMs: number | null;
    rowCounts: RetentionRowCounts;
  }
  export function readRetentionStatus(dbPath: string): RetentionStatus;
  ```

- [ ] **Step 1: Write the failing test**

Create `electron/retentionStore.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'node:module';
import { readRetentionStatus } from './retentionStore.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const FULL_SCHEMA = `
  CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, hook_event_name TEXT NOT NULL, session_id TEXT NOT NULL, project_rel_path TEXT, tool_name TEXT, had_tool_input INTEGER NOT NULL, had_tool_response INTEGER NOT NULL, notification_type TEXT, occurred_at_ms INTEGER NOT NULL);
  CREATE TABLE daily_rollups (day TEXT NOT NULL, hook_event_name TEXT NOT NULL, tool_name TEXT, event_count INTEGER NOT NULL, PRIMARY KEY (day, hook_event_name, tool_name));
  CREATE TABLE drift_log (id INTEGER PRIMARY KEY AUTOINCREMENT, detected_at_ms INTEGER NOT NULL, detail TEXT NOT NULL);
  CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at_ms INTEGER NOT NULL, model TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_creation_input_tokens INTEGER NOT NULL, cache_read_input_tokens INTEGER NOT NULL);
  CREATE TABLE transcript_files (file_path TEXT PRIMARY KEY, last_offset INTEGER NOT NULL, last_scanned_ms INTEGER NOT NULL);
  CREATE TABLE fleet_sessions (session_id TEXT PRIMARY KEY, pid INTEGER, project_name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, name TEXT NOT NULL, started_at_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL);
  CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, file_path_rel TEXT, started_at_ms INTEGER NOT NULL, closed_at_ms INTEGER NOT NULL);
  CREATE TABLE dispatches (tool_use_id TEXT PRIMARY KEY, tokens INTEGER NOT NULL, tool_uses INTEGER NOT NULL, duration_ms INTEGER NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER NOT NULL);
  CREATE TABLE anomalies (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, tool_use_id TEXT NOT NULL, detail TEXT NOT NULL, detected_at_ms INTEGER NOT NULL);
  CREATE TABLE daily_anomaly_rollups (day TEXT NOT NULL, kind TEXT NOT NULL, anomaly_count INTEGER NOT NULL, PRIMARY KEY (day, kind));
`;

export function seedCollectorDb(dir: string, name = 'collector.db'): { dbPath: string; db: InstanceType<typeof DatabaseSync> } {
  const dbPath = join(dir, name);
  const db = new DatabaseSync(dbPath);
  db.exec(FULL_SCHEMA);
  return { dbPath, db };
}

describe('readRetentionStatus', () => {
  it('returns exists:false and zeroed counts when the db file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-'));
    const status = readRetentionStatus(join(dir, 'missing.db'));
    expect(status.exists).toBe(false);
    expect(status.fileSizeBytes).toBe(0);
    expect(status.oldestRetainedAtMs).toBeNull();
    expect(status.rowCounts.events).toBe(0);
  });

  it('reports row counts across every data table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-'));
    const { dbPath, db } = seedCollectorDb(dir);
    db.prepare(
      'INSERT INTO events (hook_event_name, session_id, had_tool_input, had_tool_response, occurred_at_ms) VALUES (?, ?, ?, ?, ?)'
    ).run('PreToolUse', 's1', 1, 0, 5000);
    db.prepare(
      'INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(3000, 'claude-sonnet-4-6', 10, 5, 0, 0);
    db.prepare('INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms) VALUES (?, ?, ?, ?, ?, ?)').run(
      't1', 100, 1, 500, 4000, 4500
    );
    db.close();

    const status = readRetentionStatus(dbPath);
    expect(status.exists).toBe(true);
    expect(status.rowCounts.events).toBe(1);
    expect(status.rowCounts.usageEvents).toBe(1);
    expect(status.rowCounts.dispatches).toBe(1);
    expect(status.rowCounts.anomalies).toBe(0);
    expect(status.fileSizeBytes).toBeGreaterThan(0);
  });

  it('computes oldestRetainedAtMs as the earliest row across events/usage_events/dispatches/tool_calls/anomalies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-'));
    const { dbPath, db } = seedCollectorDb(dir);
    db.prepare(
      'INSERT INTO events (hook_event_name, session_id, had_tool_input, had_tool_response, occurred_at_ms) VALUES (?, ?, ?, ?, ?)'
    ).run('PreToolUse', 's1', 1, 0, 9000);
    db.prepare(
      'INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(2000, null, 1, 1, 0, 0); // earliest
    db.prepare('INSERT INTO anomalies (kind, tool_use_id, detail, detected_at_ms) VALUES (?, ?, ?, ?)').run('slow', 't1', '{}', 7000);
    db.close();

    const status = readRetentionStatus(dbPath);
    expect(status.oldestRetainedAtMs).toBe(2000);
  });

  it('returns oldestRetainedAtMs:null when every raw table is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-'));
    const { dbPath, db } = seedCollectorDb(dir);
    db.close();

    const status = readRetentionStatus(dbPath);
    expect(status.exists).toBe(true);
    expect(status.oldestRetainedAtMs).toBeNull();
  });

  it('never throws against a malformed/corrupt database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-corrupt-'));
    const dbPath = join(dir, 'test.db');
    require('fs').writeFileSync(dbPath, 'not a real sqlite file');
    expect(() => readRetentionStatus(dbPath)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/retentionStore.test.ts`
Expected: FAIL — `Cannot find module './retentionStore.js'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `electron/retentionStore.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';

const require = createRequire(import.meta.url);

export interface RetentionRowCounts {
  events: number;
  dailyRollups: number;
  usageEvents: number;
  toolCalls: number;
  dispatches: number;
  anomalies: number;
  dailyAnomalyRollups: number;
  driftLog: number;
  fleetSessions: number;
}

export interface RetentionStatus {
  exists: boolean;
  fileSizeBytes: number;
  oldestRetainedAtMs: number | null;
  rowCounts: RetentionRowCounts;
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

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
  return row.c;
}

// Returns null (not 0) so an empty table never masquerades as "oldest row at
// epoch 0" in the Math.min() below.
function minOf(db: DatabaseSync, table: string, column: string): number | null {
  const row = db.prepare(`SELECT MIN(${column}) as m FROM ${table}`).get() as { m: number | null };
  return row.m;
}

const EMPTY_STATUS: RetentionStatus = {
  exists: false,
  fileSizeBytes: 0,
  oldestRetainedAtMs: null,
  rowCounts: {
    events: 0,
    dailyRollups: 0,
    usageEvents: 0,
    toolCalls: 0,
    dispatches: 0,
    anomalies: 0,
    dailyAnomalyRollups: 0,
    driftLog: 0,
    fleetSessions: 0,
  },
};

export function readRetentionStatus(dbPath: string): RetentionStatus {
  const db = openReadOnly(dbPath);
  if (!db) return EMPTY_STATUS;

  try {
    const fileSizeBytes = statSync(dbPath).size;
    const rowCounts: RetentionRowCounts = {
      events: countRows(db, 'events'),
      dailyRollups: countRows(db, 'daily_rollups'),
      usageEvents: countRows(db, 'usage_events'),
      toolCalls: countRows(db, 'tool_calls'),
      dispatches: countRows(db, 'dispatches'),
      anomalies: countRows(db, 'anomalies'),
      dailyAnomalyRollups: countRows(db, 'daily_anomaly_rollups'),
      driftLog: countRows(db, 'drift_log'),
      fleetSessions: countRows(db, 'fleet_sessions'),
    };

    // Oldest live row across every RAW table -- rollup tables (daily_rollups,
    // daily_anomaly_rollups) are keyed by day string, not a row timestamp,
    // and are already represented by these tables' own oldest row before
    // compaction ages it out.
    const candidates = [
      minOf(db, 'events', 'occurred_at_ms'),
      minOf(db, 'usage_events', 'occurred_at_ms'),
      minOf(db, 'dispatches', 'started_at_ms'),
      minOf(db, 'tool_calls', 'started_at_ms'),
      minOf(db, 'anomalies', 'detected_at_ms'),
    ].filter((v): v is number => v !== null);

    const oldestRetainedAtMs = candidates.length > 0 ? Math.min(...candidates) : null;

    return { exists: true, fileSizeBytes, oldestRetainedAtMs, rowCounts };
  } catch {
    return EMPTY_STATUS;
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/retentionStore.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add electron/retentionStore.ts electron/retentionStore.test.ts
git commit -m "feat(settings): add read-only retention status (row counts, size, oldest row)"
```

---

### Task 2: `retentionStore.ts` — purge

**Files:**
- Modify: `electron/retentionStore.ts`
- Modify: `electron/retentionStore.test.ts`

**Interfaces:**
- Consumes: `seedCollectorDb(dir, name?)` from Task 1's test file (exported, reused here).
- Produces:
  ```ts
  export interface PurgeResult { ok: boolean; error?: string }
  export function purgeCollectedData(dbPath: string): PurgeResult;
  ```

- [ ] **Step 1: Write the failing test**

Append to `electron/retentionStore.test.ts` (add `purgeCollectedData` to the existing import line —
change it to `import { readRetentionStatus, purgeCollectedData } from './retentionStore.js';`):

```ts
describe('purgeCollectedData', () => {
  it('deletes every row in every data table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-purge-'));
    const { dbPath, db } = seedCollectorDb(dir);
    db.prepare(
      'INSERT INTO events (hook_event_name, session_id, had_tool_input, had_tool_response, occurred_at_ms) VALUES (?, ?, ?, ?, ?)'
    ).run('PreToolUse', 's1', 1, 0, 1000);
    db.prepare('INSERT INTO daily_rollups (day, hook_event_name, tool_name, event_count) VALUES (?, ?, ?, ?)').run(
      '2026-08-11', 'PreToolUse', '', 5
    );
    db.prepare('INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms) VALUES (?, ?, ?, ?, ?, ?)').run(
      't1', 100, 1, 500, 1000, 1500
    );
    db.prepare('INSERT INTO anomalies (kind, tool_use_id, detail, detected_at_ms) VALUES (?, ?, ?, ?)').run('slow', 't1', '{}', 1200);

    // Precondition: confirm the seed actually landed before asserting the purge cleared it.
    const before = readRetentionStatus(dbPath);
    expect(before.rowCounts.events).toBe(1);
    expect(before.rowCounts.dailyRollups).toBe(1);
    expect(before.rowCounts.dispatches).toBe(1);
    expect(before.rowCounts.anomalies).toBe(1);
    db.close();

    const result = purgeCollectedData(dbPath);
    expect(result.ok).toBe(true);

    const after = readRetentionStatus(dbPath);
    expect(after.rowCounts.events).toBe(0);
    expect(after.rowCounts.dailyRollups).toBe(0);
    expect(after.rowCounts.dispatches).toBe(0);
    expect(after.rowCounts.anomalies).toBe(0);
  });

  // The load-bearing regression test named in the design spec: wiping
  // transcript_files alongside the data tables would reset every scan
  // cursor to "unread," and the collector's very next scan tick would
  // replay full transcript history and silently re-populate everything
  // this test just confirmed was deleted.
  it('preserves transcript_files rows exactly, unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-purge-'));
    const { dbPath, db } = seedCollectorDb(dir);
    db.prepare('INSERT INTO transcript_files (file_path, last_offset, last_scanned_ms) VALUES (?, ?, ?)').run(
      '/home/user/.claude/projects/foo/session1.jsonl', 48213, 9999
    );
    db.close();

    purgeCollectedData(dbPath);

    const db2 = new DatabaseSync(dbPath, { readOnly: true });
    const row = db2.prepare('SELECT last_offset, last_scanned_ms FROM transcript_files WHERE file_path = ?').get(
      '/home/user/.claude/projects/foo/session1.jsonl'
    ) as { last_offset: number; last_scanned_ms: number };
    db2.close();
    expect(row.last_offset).toBe(48213);
    expect(row.last_scanned_ms).toBe(9999);
  });

  it('preserves schema_meta rows exactly, unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-purge-'));
    const { dbPath, db } = seedCollectorDb(dir);
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', '6')").run();
    db.close();

    purgeCollectedData(dbPath);

    const db2 = new DatabaseSync(dbPath, { readOnly: true });
    const row = db2.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string };
    db2.close();
    expect(row.value).toBe('6');
  });

  it('never opens or modifies a separate memory.db file in the same directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-purge-'));
    const { dbPath } = seedCollectorDb(dir, 'collector.db');
    const memDbPath = join(dir, 'memory.db');
    const memDb = new DatabaseSync(memDbPath);
    memDb.exec('CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT NOT NULL)');
    memDb.prepare('INSERT INTO memories (content) VALUES (?)').run('a real memory decision');
    memDb.close();

    purgeCollectedData(dbPath);

    const memDb2 = new DatabaseSync(memDbPath, { readOnly: true });
    const row = memDb2.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number };
    memDb2.close();
    expect(row.c).toBe(1);
  });

  it('reduces the on-disk file size after deleting rows (VACUUM actually ran)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-purge-'));
    const { dbPath, db } = seedCollectorDb(dir);
    const insert = db.prepare(
      'INSERT INTO events (hook_event_name, session_id, had_tool_input, had_tool_response, occurred_at_ms) VALUES (?, ?, ?, ?, ?)'
    );
    for (let i = 0; i < 500; i++) insert.run('PreToolUse', `s${i}`, 1, 0, i);
    db.close();

    const before = readRetentionStatus(dbPath).fileSizeBytes;
    purgeCollectedData(dbPath);
    const after = readRetentionStatus(dbPath).fileSizeBytes;
    expect(after).toBeLessThan(before);
  });

  it('is a no-op that returns ok:true when the db file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-retention-purge-'));
    const result = purgeCollectedData(join(dir, 'missing.db'));
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/retentionStore.test.ts`
Expected: FAIL — `purgeCollectedData is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `electron/retentionStore.ts`:

```ts
export interface PurgeResult {
  ok: boolean;
  error?: string;
}

// Order doesn't matter -- no foreign keys are declared in schema.ts, so
// there's no delete-order constraint between these tables.
const PURGE_TABLES = [
  'events',
  'daily_rollups',
  'drift_log',
  'usage_events',
  'fleet_sessions',
  'tool_calls',
  'dispatches',
  'anomalies',
  'daily_anomaly_rollups',
] as const;

export function purgeCollectedData(dbPath: string): PurgeResult {
  if (!existsSync(dbPath)) return { ok: true };

  let db: DatabaseSync | null = null;
  try {
    const sqlite = require('node:sqlite');
    // A second, separate writable connection -- collectorStore.ts/main.ts's
    // read-only handles are untouched. busy_timeout is set explicitly here
    // because schema.ts's openDatabase() (the Node collector's own
    // connection) never sets one on collector.db, unlike memory.db and the
    // Go backend -- without this, a purge landing mid-collector-write would
    // fail immediately instead of retrying.
    db = new sqlite.DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN');
    for (const table of PURGE_TABLES) {
      db.exec(`DELETE FROM ${table}`);
    }
    db.exec('COMMIT');
    // Outside the transaction -- SQLite does not allow VACUUM inside one.
    // Without this, DELETE alone leaves the on-disk file the same size, so
    // the "current size" readout would not visibly change right after the
    // one action that's supposed to prove it works.
    db.exec('VACUUM');
    return { ok: true };
  } catch (err) {
    try {
      db?.exec('ROLLBACK');
    } catch {
      // No transaction was open (e.g. BEGIN itself failed) -- nothing to roll back.
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    db?.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/retentionStore.test.ts`
Expected: PASS (all 11 tests across both describe blocks)

- [ ] **Step 5: Commit**

```bash
git add electron/retentionStore.ts electron/retentionStore.test.ts
git commit -m "feat(settings): add purgeCollectedData, preserving transcript_files and memory.db"
```

---

### Task 3: IPC wiring — `retention:status` / `retention:purge`

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/aetherElectron.d.ts`

**Interfaces:**
- Consumes: `readRetentionStatus`, `purgeCollectedData`, `RetentionStatus`, `PurgeResult` from
  `electron/retentionStore.ts` (Tasks 1-2); `collectorDbPath` (existing module-scope const in
  `electron/main.ts:228`).
- Produces: `window.aetherElectron.retention.status(): Promise<RetentionStatus>` and
  `window.aetherElectron.retention.purge(): Promise<PurgeResult>`, consumed by Task 4's
  `RetentionCard.tsx`.

This task has no dedicated unit test of its own — IPC handler wiring in this codebase is verified by
typecheck plus the component tests in Task 4, which mock `window.aetherElectron.retention` directly.
Both steps below are edits, not a TDD cycle.

- [ ] **Step 1: Add the IPC handlers in `electron/main.ts`**

Near the top, alongside the other electron-module imports (find the line importing from
`./collectorStore.js`), add:

```ts
import { readRetentionStatus, purgeCollectedData } from './retentionStore.js';
```

Then, near the existing `crossEngine:status` handler (around line 710), add:

```ts
ipcMain.handle('retention:status', () => readRetentionStatus(collectorDbPath));
ipcMain.handle('retention:purge', () => purgeCollectedData(collectorDbPath));
```

- [ ] **Step 2: Expose the bridge in `electron/preload.ts`**

Add to the top-of-file type imports (alongside the existing `import type { DiagnosticsSnapshot }
from './collectorStore';` line):

```ts
import type { RetentionStatus, PurgeResult } from './retentionStore';
```

Add a new namespace to the `contextBridge.exposeInMainWorld('aetherElectron', { ... })` object,
alongside the existing `crossEngine: { ... }` block:

```ts
retention: {
  status: (): Promise<RetentionStatus> => ipcRenderer.invoke('retention:status'),
  purge: (): Promise<PurgeResult> => ipcRenderer.invoke('retention:purge'),
},
```

- [ ] **Step 3: Add the ambient types in `src/aetherElectron.d.ts`**

Add to the top-of-file type imports (alongside the existing `import type { DiagnosticsSnapshot }
from '../electron/collectorStore';` line):

```ts
import type { RetentionStatus, PurgeResult } from '../electron/retentionStore';
```

Add to the `Window.aetherElectron` interface, alongside the existing `crossEngine: { ... }` block:

```ts
retention: {
  status: () => Promise<RetentionStatus>;
  purge: () => Promise<PurgeResult>;
};
```

- [ ] **Step 4: Typecheck**

Run: `npm run build`
Expected: succeeds with no TypeScript errors (`tsc -b` passes, `vite build` completes).

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts electron/preload.ts src/aetherElectron.d.ts
git commit -m "feat(settings): wire retention:status/retention:purge IPC channels"
```

---

### Task 4: `RetentionCard.tsx`

**Files:**
- Create: `src/components/settings/RetentionCard.tsx`
- Test: `src/components/settings/RetentionCard.test.tsx`

**Interfaces:**
- Consumes: `window.aetherElectron.retention.status()` / `.purge()` (Task 3);
  `formatFileSize(bytes: number): string` from `src/components/files/attachmentsMath.ts`
  (existing, unmodified).
- Produces: `RetentionCard` component, consumed by Task 6's `SettingsView.tsx`.

- [ ] **Step 1: Write the failing test**

Create `src/components/settings/RetentionCard.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RetentionCard } from './RetentionCard';

afterEach(() => {
  cleanup();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

function mockRetention(overrides: Partial<{
  status: ReturnType<typeof vi.fn>;
  purge: ReturnType<typeof vi.fn>;
}> = {}) {
  const status =
    overrides.status ??
    vi.fn().mockResolvedValue({
      exists: true,
      fileSizeBytes: 2_400_000,
      oldestRetainedAtMs: Date.UTC(2026, 6, 1),
      rowCounts: {
        events: 120, dailyRollups: 8, usageEvents: 40, toolCalls: 55,
        dispatches: 12, anomalies: 3, dailyAnomalyRollups: 2, driftLog: 0, fleetSessions: 1,
      },
    });
  const purge = overrides.purge ?? vi.fn().mockResolvedValue({ ok: true });
  (window as unknown as { aetherElectron: unknown }).aetherElectron = {
    retention: { status, purge },
  };
  return { status, purge };
}

describe('RetentionCard', () => {
  it('shows "No collector data yet" when the store does not exist', async () => {
    mockRetention({
      status: vi.fn().mockResolvedValue({
        exists: false, fileSizeBytes: 0, oldestRetainedAtMs: null,
        rowCounts: { events: 0, dailyRollups: 0, usageEvents: 0, toolCalls: 0, dispatches: 0, anomalies: 0, dailyAnomalyRollups: 0, driftLog: 0, fleetSessions: 0 },
      }),
    });
    render(<RetentionCard />);
    await waitFor(() => expect(screen.getByText(/no collector data yet/i)).toBeTruthy());
  });

  it('renders the formatted store size and row count on load', async () => {
    mockRetention();
    render(<RetentionCard />);
    await waitFor(() => expect(screen.getByText('2.4 MB')).toBeTruthy());
  });

  it('does not purge on the first click -- shows an inline confirm instead', async () => {
    const { purge } = mockRetention();
    render(<RetentionCard />);
    await waitFor(() => expect(screen.getByText('2.4 MB')).toBeTruthy());

    fireEvent.click(screen.getByText(/purge all collected data/i));

    expect(screen.getByText(/cannot be undone/i)).toBeTruthy();
    expect(purge).not.toHaveBeenCalled();
  });

  it('cancel closes the confirm panel without purging', async () => {
    const { purge } = mockRetention();
    render(<RetentionCard />);
    await waitFor(() => expect(screen.getByText('2.4 MB')).toBeTruthy());

    fireEvent.click(screen.getByText(/purge all collected data/i));
    fireEvent.click(screen.getByText('CANCEL'));

    expect(screen.queryByText(/cannot be undone/i)).toBeNull();
    expect(purge).not.toHaveBeenCalled();
  });

  it('confirming calls purge and refreshes the status afterward', async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce({
        exists: true, fileSizeBytes: 2_400_000, oldestRetainedAtMs: Date.UTC(2026, 6, 1),
        rowCounts: { events: 120, dailyRollups: 8, usageEvents: 40, toolCalls: 55, dispatches: 12, anomalies: 3, dailyAnomalyRollups: 2, driftLog: 0, fleetSessions: 1 },
      })
      .mockResolvedValueOnce({
        exists: true, fileSizeBytes: 4096, oldestRetainedAtMs: null,
        rowCounts: { events: 0, dailyRollups: 0, usageEvents: 0, toolCalls: 0, dispatches: 0, anomalies: 0, dailyAnomalyRollups: 0, driftLog: 0, fleetSessions: 0 },
      });
    const { purge } = mockRetention({ status });
    render(<RetentionCard />);
    await waitFor(() => expect(screen.getByText('2.4 MB')).toBeTruthy());

    fireEvent.click(screen.getByText(/purge all collected data/i));
    fireEvent.click(screen.getByText(/I UNDERSTAND, PURGE/i));

    await waitFor(() => expect(purge).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('4.1 KB')).toBeTruthy());
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('surfaces a purge failure inline instead of swallowing it', async () => {
    mockRetention({ purge: vi.fn().mockResolvedValue({ ok: false, error: 'disk full' }) });
    render(<RetentionCard />);
    await waitFor(() => expect(screen.getByText('2.4 MB')).toBeTruthy());

    fireEvent.click(screen.getByText(/purge all collected data/i));
    fireEvent.click(screen.getByText(/I UNDERSTAND, PURGE/i));

    await waitFor(() => expect(screen.getByText(/disk full/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/settings/RetentionCard.test.tsx`
Expected: FAIL — `Cannot find module './RetentionCard'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/settings/RetentionCard.tsx`:

```tsx
import { useEffect, useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { formatFileSize } from '../files/attachmentsMath';
import type { RetentionStatus } from '../../../electron/retentionStore';

export function RetentionCard() {
  const colors = useColors();
  const [status, setStatus] = useState<RetentionStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function refresh() {
    const retention = window.aetherElectron?.retention;
    if (!retention) return;
    const s = await retention.status();
    setStatus(s);
  }

  useEffect(() => {
    refresh();
  }, []);

  const totalRows = status
    ? Object.values(status.rowCounts).reduce((sum, n) => sum + n, 0)
    : 0;

  async function runPurge() {
    const retention = window.aetherElectron?.retention;
    if (!retention) return;
    setBusy(true);
    setErrorMsg(null);
    const result = await retention.purge();
    setBusy(false);
    setConfirming(false);
    if (!result.ok) {
      setErrorMsg(result.error || 'Purge failed');
      return;
    }
    await refresh();
  }

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>RETENTION &amp; PURGE</div>

      {!status && <div style={hintStyle(colors)}>Checking…</div>}

      {status && !status.exists && <div style={hintStyle(colors)}>No collector data yet.</div>}

      {status && status.exists && (
        <>
          <div style={rowStyle(colors)}>
            <div style={labelStyle(colors)}>STORE SIZE</div>
            <div style={valueStyle(colors)}>{formatFileSize(status.fileSizeBytes)}</div>
          </div>
          <div style={rowStyle(colors)}>
            <div style={labelStyle(colors)}>ROWS RETAINED</div>
            <div style={valueStyle(colors)}>{totalRows}</div>
          </div>
          <div style={rowStyle(colors)}>
            <div style={labelStyle(colors)}>OLDEST RETAINED</div>
            <div style={valueStyle(colors)}>
              {status.oldestRetainedAtMs === null ? '—' : new Date(status.oldestRetainedAtMs).toLocaleString()}
            </div>
          </div>

          <Button
            onClick={() => setConfirming(true)}
            disabled={busy}
            style={{ ...toggleStyle(colors, false), marginTop: 12 }}
          >
            PURGE ALL COLLECTED DATA
          </Button>

          {confirming && (
            <div style={confirmWrapStyle(colors)}>
              <p style={disclosureStyle(colors)}>
                Permanently deletes everything the collector has observed on this machine — every
                event, dispatch, tool call, anomaly, and rollup — including the daily rollups that
                normally survive automatic 30-day retention. This cannot be undone. Memory decisions
                (`memory.db`) are a separate store and are not affected.
              </p>
              <p style={disclosureStyle(colors)}>
                Deleting {formatFileSize(status.fileSizeBytes)} across {totalRows} rows, oldest from{' '}
                {status.oldestRetainedAtMs === null ? 'n/a' : new Date(status.oldestRetainedAtMs).toLocaleDateString()}.
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Button onClick={runPurge} disabled={busy} style={toggleStyle(colors, true)}>
                  {busy ? 'PURGING…' : 'I UNDERSTAND, PURGE'}
                </Button>
                <Button onClick={() => setConfirming(false)} disabled={busy} style={toggleStyle(colors, false)}>
                  CANCEL
                </Button>
              </div>
            </div>
          )}

          {errorMsg && <p style={{ ...hintStyle(colors), color: colors.textSecondary }}>{errorMsg}</p>}
        </>
      )}
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: 15,
    borderRadius: 14,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    flexShrink: 0,
  };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function toggleStyle(colors: ColorPalette, on: boolean): CSSProperties {
  return {
    minWidth: 52,
    textAlign: 'center',
    cursor: 'pointer',
    padding: '6px 12px',
    borderRadius: 7,
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: on ? '#04202b' : colors.textMuted,
    background: on ? 'linear-gradient(180deg,#7ef0ff,#17b8d8)' : 'rgba(10,32,43,.6)',
    boxShadow: on ? '0 0 10px rgba(95,220,255,.4)' : undefined,
    border: on ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
function confirmWrapStyle(colors: ColorPalette): CSSProperties {
  return {
    marginTop: 10,
    padding: 10,
    borderRadius: 8,
    border: `1px solid ${colors.chipBorder}`,
    background: 'rgba(10,32,43,.4)',
  };
}
function disclosureStyle(colors: ColorPalette): CSSProperties {
  return { margin: 0, font: `500 11px/1.4 ${fonts.ui}`, color: colors.textMuted };
}
function rowStyle(_colors: ColorPalette): CSSProperties {
  return { marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' };
}
function labelStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
}
function valueStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 11px/1 ${fonts.mono}`, color: colors.textSecondary };
}
function hintStyle(colors: ColorPalette): CSSProperties {
  return { marginTop: 10, font: `500 11px/1.4 ${fonts.ui}`, color: colors.textMuted };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/settings/RetentionCard.test.tsx`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/RetentionCard.tsx src/components/settings/RetentionCard.test.tsx
git commit -m "feat(settings): add RetentionCard with confirm-then-purge flow"
```

---

### Task 5: `CostGuardCard.tsx`

**Files:**
- Create: `src/components/settings/CostGuardCard.tsx`
- Test: `src/components/settings/CostGuardCard.test.tsx`

**Interfaces:**
- Consumes: `useAetherStore()` from `../../state/store` (existing) → `state.crossEngineCfg.enabled`
  (existing field, `src/state/types.ts:315`).
- Produces: `CostGuardCard` component, consumed by Task 6's `SettingsView.tsx`.

- [ ] **Step 1: Write the failing test**

Create `src/components/settings/CostGuardCard.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { CostGuardCard } from './CostGuardCard';
import { CrossEngineVerificationCard } from './CrossEngineVerificationCard';
import { AetherStoreProvider } from '../../state/store';

afterEach(() => {
  cleanup();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

function crossEngineRow() {
  return screen.getByText('CROSS-ENGINE VERIFICATION').closest('div')!.parentElement!;
}

describe('CostGuardCard', () => {
  it('always shows Anthropic API and model-calls-by-Aether as disabled, unconditionally', () => {
    render(
      <AetherStoreProvider>
        <CostGuardCard />
      </AetherStoreProvider>,
    );
    expect(screen.getByText(/no sdk installed/i)).toBeTruthy();
    expect(screen.getByText(/zero call sites/i)).toBeTruthy();
  });

  it('shows cross-engine verification as OFF by default', () => {
    render(
      <AetherStoreProvider>
        <CostGuardCard />
      </AetherStoreProvider>,
    );
    const row = screen.getByText('CROSS-ENGINE VERIFY').closest('div')!.parentElement!;
    expect(within(row).getByText('OFF')).toBeTruthy();
  });

  it('shows cross-engine verification as ON when crossEngineCfg.enabled is true', () => {
    render(
      <AetherStoreProvider>
        <CrossEngineVerificationCard />
        <CostGuardCard />
      </AetherStoreProvider>,
    );

    fireEvent.click(within(crossEngineRow()).getByText('ENABLE'));
    fireEvent.click(screen.getByText('I UNDERSTAND, ENABLE'));

    const row = screen.getByText('CROSS-ENGINE VERIFY').closest('div')!.parentElement!;
    expect(within(row).getByText('ON')).toBeTruthy();
  });

  it('shows Auto Headlines as locally computed, no API call', () => {
    render(
      <AetherStoreProvider>
        <CostGuardCard />
      </AetherStoreProvider>,
    );
    expect(screen.getByText(/computed locally, no api call/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/settings/CostGuardCard.test.tsx`
Expected: FAIL — `Cannot find module './CostGuardCard'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/settings/CostGuardCard.tsx`:

```tsx
import type { CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { useAetherStore } from '../../state/store';

export function CostGuardCard() {
  const colors = useColors();
  const { state } = useAetherStore();
  const crossEngineOn = state.crossEngineCfg.enabled;

  return (
    <div style={cardStyle(colors)}>
      <div style={titleStyle(colors)}>COST GUARD</div>

      <div style={rowStyle(colors)}>
        <div style={labelStyle(colors)}>ANTHROPIC API</div>
        <div style={valueStyle(colors)}>DISABLED · no SDK installed, no key-reachable path</div>
      </div>
      <div style={rowStyle(colors)}>
        <div style={labelStyle(colors)}>MODEL CALLS BY AETHER</div>
        <div style={valueStyle(colors)}>NONE · zero call sites</div>
      </div>
      <div style={rowStyle(colors)}>
        <div style={labelStyle(colors)}>CROSS-ENGINE VERIFY</div>
        <div style={valueStyle(colors)}>
          {crossEngineOn ? 'ON · ChatGPT subscription only, no API key path' : 'OFF'}
        </div>
      </div>
      <div style={rowStyle(colors)}>
        <div style={labelStyle(colors)}>AUTO HEADLINES</div>
        <div style={valueStyle(colors)}>computed locally, no API call</div>
      </div>

      <p style={hintStyle(colors)}>
        `@anthropic-ai/sdk` was removed from this app and its model-calling code paths deleted in
        Stage 13.5 — there is no key-reachable path left for Aether to call the Anthropic API on
        your behalf. Cross-engine verification (above) is the one real network exception, and it
        only ever runs when you enable it.
      </p>
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: 15,
    borderRadius: 14,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    flexShrink: 0,
  };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function rowStyle(_colors: ColorPalette): CSSProperties {
  return { marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 };
}
function labelStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted, flexShrink: 0 };
}
function valueStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 11px/1 ${fonts.mono}`, color: colors.textSecondary, textAlign: 'right' };
}
function hintStyle(colors: ColorPalette): CSSProperties {
  return { marginTop: 12, font: `500 11px/1.4 ${fonts.ui}`, color: colors.textMuted };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/settings/CostGuardCard.test.tsx`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/CostGuardCard.tsx src/components/settings/CostGuardCard.test.tsx
git commit -m "feat(settings): add CostGuardCard, honest against Stage 17/18's cross-engine path"
```

---

### Task 6: Wire both cards into `SettingsView.tsx`, final verification

**Files:**
- Modify: `src/components/settings/SettingsView.tsx`

**Interfaces:**
- Consumes: `RetentionCard` (Task 4), `CostGuardCard` (Task 5).

- [ ] **Step 1: Add both cards to the Settings column**

Edit `src/components/settings/SettingsView.tsx`:

```tsx
import type { CSSProperties } from 'react';
import { OperatingModeCard } from './OperatingModeCard';
import { AppearanceCard } from './AppearanceCard';
import { BudgetAlertsCard } from './BudgetAlertsCard';
import { OperatorCard } from './OperatorCard';
import { NarrationVerbosityCard } from './NarrationVerbosityCard';
import { StatuslineCard } from './StatuslineCard';
import { CrossEngineVerificationCard } from './CrossEngineVerificationCard';
import { CostGuardCard } from './CostGuardCard';
import { RetentionCard } from './RetentionCard';

export function SettingsView() {
  return (
    <div style={rootStyle}>
      <div style={columnStyle}>
        <OperatorCard />
        <OperatingModeCard />
        <NarrationVerbosityCard />
        <BudgetAlertsCard />
        <StatuslineCard />
        <CrossEngineVerificationCard />
        <CostGuardCard />
        <RetentionCard />
      </div>
      <AppearanceCard />
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
const columnStyle: CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' };
```

Placement: Cost Guard directly below Cross-Engine Verification (the one card whose live state it
reports on), Retention & Purge last (a standalone, destructive action deserves to be the final,
most-deliberate item in the column, not buried mid-list).

- [ ] **Step 2: Run the full test suite**

Run: `npm run test`
Expected: PASS — every existing test still green, plus the new suites from Tasks 1, 2, 4, 5.

- [ ] **Step 3: Typecheck and build**

Run: `npm run build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/SettingsView.tsx
git commit -m "feat(settings): wire CostGuardCard and RetentionCard into SettingsView"
```

- [ ] **Step 5: Manual visual verification**

Per this project's established practice, run the app and look at the Settings tab:

```bash
npm run electron:dev
```

Confirm: both cards render without layout overflow, the Retention card's confirm panel reads clearly
and the PURGE/CANCEL buttons are both reachable, and Cost Guard's CROSS-ENGINE VERIFY row correctly
flips between OFF/ON when the Cross-Engine Verification card above it is toggled. This has not been
checked in a running window before this step — note the result (pass, or what's off) in the plan's
completion summary.

---

## Known limitations, carried from the design spec

1. Retention status and the purge action are Node-`node:sqlite`-specific (matches every existing
   read path in this codebase) — works identically regardless of whether the Node or Go collector
   backend produced `collector.db`, since both write to the same file format.
2. No typed-confirmation gate on Purge (e.g. typing "PURGE") — the existing inline-confirm pattern
   is used as-is, per the approved design.
3. `RetentionCard`'s `oldestRetainedAtMs` and `formatFileSize` readouts have not been visually
   verified against a real, long-running `collector.db` — only against seeded fixtures in tests and
   the Task 6 manual pass above.
