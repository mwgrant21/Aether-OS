# Fleet Session Browser (Stage 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the collector a new `fleetPoll` module that polls `claude agents --json` on its own
15s interval and persists a current-state snapshot to a new `fleet_sessions` table; give the
Electron viewer a read-only reader and a new `FleetCard` in the Agents view that lists every other
`claude` session running on the machine (project name, session name, status, running duration),
excluding Aether's own embedded-terminal session. Read-only, active-sessions-only, per
`docs/superpowers/specs/2026-07-28-fleet-session-picker-design.md` ("Approved, pending
implementation plan" — this plan is that next step).

**Architecture:** `collector/src/fleetPoll.ts` gets four pure/near-pure pieces built up task by
task: `parseFleetJson` (validates + maps raw `claude agents --json` rows, logging one `drift_log`
row per malformed row via `canary.ts`'s newly-exported `logDrift`), `filterOwnSession` (excludes
Aether's own session by exact `sessionId` match), `upsertFleetSessions` (upserts by `session_id`,
then unconditionally prunes any row whose `last_seen_ms` is older than 30s — the prune always runs,
even on a failed poll, so sustained collector-can't-reach-`claude` failures correctly age the list
down to empty rather than showing indefinitely-stale data), and `pollFleet` (the async orchestrator
that spawns the child process via an injectable exec function, so failure/malformed-output paths are
unit-testable without ever touching a real `claude` binary). On the Electron side,
`electron/collectorStore.ts` gains `readFleetSessions`, following the exact `null`-on-unavailable /
array-on-available convention `readUsageEventsSince` already established — necessary here because,
unlike usage tiles (which have a fictional-estimate fallback to distinguish LIVE from EST), a fleet
browser has no fallback data at all, so "collector isn't running" and "confirmed zero other
sessions" must be two distinct, non-colliding return shapes (`null` vs `[]`), not the same empty
array standing for both.

**A deliberate, disclosed deviation from the design spec's sketch:** the spec's architecture section
sketches self-exclusion via `pollFleet(ownPtyPid: number | null)` — an OS process-id match. That
does not actually work on this app: `ptyManager.ts` spawns a **shell** (`powershell.exe` on
Windows) and writes `claude\r` into it as a typed command, so the pty handle's own `.pid` is the
shell's PID, not the PID of the `claude` process `claude agents --json` later reports running
inside that shell — they are never equal. This plan instead identifies Aether's own session by
**`sessionId`**, which the app already derives reliably: `electron/liveAgentTracker.ts`'s private
`pinnedFile` is the exact transcript file Aether is tailing for its own terminal, and Claude Code
names transcript files `<sessionId>.jsonl` — so `path.basename(pinnedFile, '.jsonl')` **is** the
own session's id, no new discovery logic needed. That id is written to a small JSON file
(`~/.aether-os/own-session.json`, atomic tmp+rename write, mirroring
`scripts/aether-statusline.mjs`'s existing `persistSnapshot` pattern) whenever it changes, and the
collector reads it fresh on each 15s poll cycle. Task 7 implements the writer side; Task 4
implements the collector-side reader.

**Tech Stack:** Same as Stage 2/3's `collector/` — TypeScript strict, `node:sqlite`'s `DatabaseSync`
(type-only import + `createRequire` runtime resolution), no npm runtime dependencies added
anywhere. `pollFleet` uses `node:child_process`'s `execFile`, promisified via `node:util`'s
`promisify` — both Node builtins, no new dependency. Electron side reuses the exact
`node:sqlite`-as-type-plus-`createRequire` pattern `electron/collectorStore.ts` already established
in Stage 3 (already verified working under `electron-vite`'s bundler — no new spike needed this
stage).

## Global Constraints

- **`node:sqlite`'s `DatabaseSync` can only ever be imported as a TYPE**
  (`import type { DatabaseSync } from 'node:sqlite';`) in both `collector/` and `electron/` — a
  static VALUE import fails under Vite's dep-scanner. The runtime value is obtained via
  `createRequire(import.meta.url)('node:sqlite')` inside the one function that actually opens a
  database. This plan touches `electron/collectorStore.ts` (already using this pattern — do not
  change it) and does not add any new `node:sqlite`-opening call site in `electron/`.
- **Relative imports need explicit `.js` extensions** everywhere in `collector/src/*.ts` — this
  project's `nodenext` module resolution requires it. `electron/*.ts` and `src/*.ts` are NOT
  `nodenext` and use extension-less relative imports — match whichever package you are editing.
- **Verify the FULL build+test suite for every task**, not just the new test file:
  `cd collector && npx tsc -b && npm test` for collector-side tasks (Tasks 1–6);
  `npx tsc -b && npm run build && npm run electron:build && npx vitest run` from the repo root for
  Electron/renderer-side tasks (Tasks 7–11). Baseline counts confirmed immediately before writing
  this plan: collector `14 files / 76 tests`, root app `50 files / 639 tests` — both fully green.
  Stage 2 shipped 8 tasks with a silently-broken `tsc -b` because only the new test file was ever
  checked; do not repeat that.
- **`electron/collectorStore.ts` currently has ONE schema-version-gate constant,
  `MIN_SUPPORTED_SCHEMA_VERSION = 2`, used only by `readUsageEventsSince`.** This stage's
  `readFleetSessions` needs its own gate at version `3` (the `fleet_sessions` table does not exist
  in a version-2 database). **Do not raise the existing constant to 3 and share it** — that would
  make `readUsageEventsSince` reject a perfectly valid version-2 database that has `usage_events`
  but predates `fleet_sessions`, silently breaking Stage 3's already-shipped degradation contract
  for anyone whose collector hasn't been restarted since this stage shipped. Task 8 renames the
  existing constant to `MIN_SCHEMA_VERSION_FOR_USAGE_EVENTS` and adds a second,
  `MIN_SCHEMA_VERSION_FOR_FLEET_SESSIONS = 3`, each gating only its own reader function.
- **The staleness prune inside `upsertFleetSessions` must run unconditionally, including when this
  cycle's poll produced zero or failed sessions** — call it as `upsertFleetSessions(db, sessions ??
  [], nowMs)`, never skip the call outright on failure. This is what makes "existing rows age out
  via the 30s staleness prune" (the spec's stated degradation behavior) actually true; skipping the
  whole call on failure would leave arbitrarily stale rows forever if `claude` disappears from PATH.
- **`path.win32.basename`, not the platform-default `basename`, for deriving `project_name` from
  `cwd`.** `claude agents --json`'s `cwd` field is always a Windows-style path on this Windows-only
  personal app (see `CLAUDE.md`'s Gotchas — `schtasks.exe`, `powershell.exe`, no cross-platform
  claim anywhere in this codebase). Using the platform-default `basename` would behave correctly
  when collector runs on Windows (the only place it ever runs) but would make this task's own unit
  tests non-deterministic depending on which OS runs `vitest` — explicit `path.win32.basename`
  is correct AND deterministic everywhere.
- **Privacy: `cwd` is read only to derive `project_name`, then discarded immediately — never
  persisted or transmitted whole**, per `docs/privacy-and-data.md` and matching
  `electron/attachmentsStore.ts`'s existing convention. `name` (the session's short free-text label)
  is stored and displayed as-is, the same class of data as `subagentType` strings already surfaced
  elsewhere in this app.
- **`fleet` is a live external-process snapshot, never persisted to `localStorage`.** Add it to
  `PERSISTENCE_EXCLUSIONS` in the same commit that adds it to `AetherState` — `persistence.test.ts`
  has an existing coverage test (Stage 0.5) that fails on any state key which is neither persisted
  nor on the exclusions list, so forgetting this is a hard test failure, not a silent gap.

---

### Task 1: Add `fleet_sessions` table to the collector schema, bump `SCHEMA_VERSION` to 3

**Files:**
- Modify: `collector/src/schema.ts`
- Modify: `collector/src/schema.test.ts`

**Interfaces:**
- Adds to `migrate(db)`:
  `fleet_sessions(session_id TEXT PRIMARY KEY, pid INTEGER, project_name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, name TEXT NOT NULL, started_at_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL)`.
- `SCHEMA_VERSION` goes from `2` to `3` — purely additive (new table only), but the version bump
  lets Task 8's Electron-side reader distinguish "collector predates the fleet feature" from
  "collector has it."

- [ ] **Step 1: Write the failing test**

Add to `collector/src/schema.test.ts` (alongside the existing 6 tests, same file):

```typescript
it('migrate also creates fleet_sessions, and bumps schema_meta to version 3', () => {
  const db = openDatabase(tempDbPath());
  migrate(db);
  expect(getSchemaVersion(db)).toBe(3);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r: any) => r.name);
  expect(tables).toEqual([
    'daily_rollups',
    'drift_log',
    'events',
    'fleet_sessions',
    'schema_meta',
    'transcript_files',
    'usage_events',
  ]);
  db.close();
});

it('fleet_sessions accepts a full row insert, with pid nullable', () => {
  const db = openDatabase(tempDbPath());
  migrate(db);
  db.prepare(
    `INSERT INTO fleet_sessions (session_id, pid, project_name, kind, status, name, started_at_ms, last_seen_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('sess-1', 6824, 'IT', 'interactive', 'busy', 'it-68', 1000, 2000);
  const row: any = db.prepare('SELECT * FROM fleet_sessions').get();
  expect(row.session_id).toBe('sess-1');
  expect(row.pid).toBe(6824);

  db.prepare(
    `INSERT INTO fleet_sessions (session_id, pid, project_name, kind, status, name, started_at_ms, last_seen_ms)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`
  ).run('sess-2', 'proj', 'background', 'idle', 'bg-1', 3000, 4000);
  const row2: any = db.prepare('SELECT pid FROM fleet_sessions WHERE session_id = ?').get('sess-2');
  expect(row2.pid).toBeNull();
  db.close();
});

it('fleet_sessions is upsertable by session_id', () => {
  const db = openDatabase(tempDbPath());
  migrate(db);
  const upsert = db.prepare(
    `INSERT INTO fleet_sessions (session_id, pid, project_name, kind, status, name, started_at_ms, last_seen_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET status = excluded.status, last_seen_ms = excluded.last_seen_ms`
  );
  upsert.run('sess-1', 1, 'IT', 'interactive', 'busy', 'it-68', 1000, 2000);
  upsert.run('sess-1', 1, 'IT', 'interactive', 'idle', 'it-68', 1000, 5000);
  const row: any = db.prepare('SELECT * FROM fleet_sessions').get();
  expect(row.status).toBe('idle');
  expect(row.last_seen_ms).toBe(5000);
  const count: any = db.prepare('SELECT COUNT(*) as c FROM fleet_sessions').get();
  expect(count.c).toBe(1);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npx vitest run src/schema.test.ts`
Expected: FAIL — `fleet_sessions` and version 3 don't exist yet.

- [ ] **Step 3: Update the schema module**

In `collector/src/schema.ts`, change `export const SCHEMA_VERSION = 2;` to
`export const SCHEMA_VERSION = 3;`, and add to the `db.exec` template string inside `migrate`,
alongside the five existing `CREATE TABLE IF NOT EXISTS` statements:

```sql
CREATE TABLE IF NOT EXISTS fleet_sessions (
  session_id TEXT PRIMARY KEY,
  pid INTEGER,
  project_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  name TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npx vitest run src/schema.test.ts`
Expected: PASS, all 9 tests (6 original + 3 new).

- [ ] **Step 5: Commit**

```bash
git add collector/src/schema.ts collector/src/schema.test.ts
git commit -m "feat: add fleet_sessions table, bump collector schema to version 3"
```

---

### Task 2: `collector/src/fleetPoll.ts` — `parseFleetJson` and `filterOwnSession`

**Files:**
- Modify: `collector/src/canary.ts` (export `logDrift`)
- Create: `collector/src/fleetPoll.ts`
- Create: `collector/src/fleetPoll.test.ts`

**Interfaces:**
- `canary.ts` changes `function logDrift(...)` to `export function logDrift(...)` — no behavior
  change, just makes the existing drift-logging helper reusable outside `ingest.ts`, per the design
  spec's "logs to the collector's existing `drift_log` table via the same helper
  `collector/src/canary.ts` already uses."
- Produces:
  ```typescript
  export interface FleetSession {
    sessionId: string;
    pid: number | null;
    projectName: string;
    kind: string;
    status: string;
    name: string;
    startedAtMs: number;
  }
  export function parseFleetJson(raw: string): { sessions: FleetSession[]; driftDetails: string[] } | null;
  export function filterOwnSession(sessions: FleetSession[], ownSessionId: string | null): FleetSession[];
  ```
  `parseFleetJson` returns `null` only when `raw` is not valid JSON or does not parse to an array
  (a total, whole-payload failure — e.g. `claude`'s CLI output format changed shape entirely).
  Otherwise it returns `{ sessions, driftDetails }`: `sessions` holds every row that had all six
  required fields with the right types, and `driftDetails` holds one human-readable string per row
  that was missing/invalid and therefore dropped — both can be non-empty at once (a partially-good
  response). Task 5's `pollFleet` is what actually writes `driftDetails` entries to `drift_log`;
  this function is pure and touches no database.

- [ ] **Step 1: Export `logDrift` from `canary.ts`**

In `collector/src/canary.ts`, change:

```typescript
function logDrift(db: DatabaseSync, nowMs: number, detail: string): void {
```

to:

```typescript
export function logDrift(db: DatabaseSync, nowMs: number, detail: string): void {
```

No other change to that file. Run `cd collector && npx vitest run src/canary.test.ts` — expect the
existing 4 tests still PASS unchanged (this is a visibility-only change).

- [ ] **Step 2: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { parseFleetJson, filterOwnSession, type FleetSession } from './fleetPoll.js';

// Captured directly from `claude agents --json` on this machine — see
// docs/superpowers/specs/2026-07-28-fleet-session-picker-design.md.
const REAL_ROW = {
  pid: 6824,
  cwd: 'C:\\Users\\IT',
  kind: 'interactive',
  startedAt: 1785255815376,
  sessionId: '37d95054-b8c3-44c2-8422-06d7fd9d52d7',
  name: 'it-68',
  status: 'busy',
};

describe('parseFleetJson', () => {
  it('parses a real captured row, deriving projectName from cwd via win32 basename', () => {
    const result = parseFleetJson(JSON.stringify([REAL_ROW]));
    expect(result).not.toBeNull();
    expect(result!.driftDetails).toEqual([]);
    expect(result!.sessions).toEqual([
      {
        sessionId: '37d95054-b8c3-44c2-8422-06d7fd9d52d7',
        pid: 6824,
        projectName: 'IT',
        kind: 'interactive',
        status: 'busy',
        name: 'it-68',
        startedAtMs: 1785255815376,
      },
    ]);
  });

  it('parses an empty array as zero sessions, zero drift', () => {
    const result = parseFleetJson('[]');
    expect(result).toEqual({ sessions: [], driftDetails: [] });
  });

  it('treats a missing pid as null rather than dropping the row', () => {
    const { pid, ...withoutPid } = REAL_ROW;
    const result = parseFleetJson(JSON.stringify([withoutPid]));
    expect(result!.sessions[0].pid).toBeNull();
    expect(result!.driftDetails).toEqual([]);
  });

  it('drops a row missing a required field and records a drift detail, keeping other valid rows', () => {
    const { sessionId, ...missingSessionId } = REAL_ROW;
    const secondRow = { ...REAL_ROW, sessionId: 'other-session' };
    const result = parseFleetJson(JSON.stringify([missingSessionId, secondRow]));
    expect(result!.sessions).toEqual([
      {
        sessionId: 'other-session',
        pid: 6824,
        projectName: 'IT',
        kind: 'interactive',
        status: 'busy',
        name: 'it-68',
        startedAtMs: 1785255815376,
      },
    ]);
    expect(result!.driftDetails).toHaveLength(1);
    expect(result!.driftDetails[0]).toContain('sessionId');
  });

  it('returns null for malformed JSON', () => {
    expect(parseFleetJson('not json{{')).toBeNull();
  });

  it('returns null when the top-level value is not an array', () => {
    expect(parseFleetJson(JSON.stringify({ not: 'an array' }))).toBeNull();
  });
});

describe('filterOwnSession', () => {
  const sessions: FleetSession[] = [
    { sessionId: 'own', pid: 1, projectName: 'IT', kind: 'interactive', status: 'busy', name: 'it-1', startedAtMs: 1000 },
    { sessionId: 'other', pid: 2, projectName: 'proj', kind: 'interactive', status: 'idle', name: 'it-2', startedAtMs: 2000 },
  ];

  it('excludes the session whose sessionId matches ownSessionId', () => {
    expect(filterOwnSession(sessions, 'own')).toEqual([sessions[1]]);
  });

  it('returns every session unchanged when ownSessionId is null', () => {
    expect(filterOwnSession(sessions, null)).toEqual(sessions);
  });

  it('returns every session unchanged when ownSessionId matches nothing', () => {
    expect(filterOwnSession(sessions, 'no-such-session')).toEqual(sessions);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd collector && npx vitest run src/fleetPoll.test.ts`
Expected: FAIL — `fleetPoll.ts` does not exist yet.

- [ ] **Step 4: Implement**

```typescript
import { win32 } from 'node:path';

export interface FleetSession {
  sessionId: string;
  pid: number | null;
  projectName: string;
  kind: string;
  status: string;
  name: string;
  startedAtMs: number;
}

const REQUIRED_STRING_FIELDS = ['sessionId', 'cwd', 'kind', 'name', 'status'] as const;

function missingFieldsOf(row: unknown): string[] {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return ['row is not an object'];
  const obj = row as Record<string, unknown>;
  const missing: string[] = [];
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof obj[field] !== 'string') missing.push(field);
  }
  if (typeof obj.startedAt !== 'number') missing.push('startedAt');
  return missing;
}

// win32.basename (not the platform-default basename import): claude agents
// --json's cwd is always a Windows-style path on this Windows-only personal
// app -- see this plan's Global Constraints for why the platform-default
// variant would make this file's own tests non-deterministic across dev
// machines running vitest on a different OS.
function toFleetSession(row: Record<string, unknown>): FleetSession {
  return {
    sessionId: row.sessionId as string,
    pid: typeof row.pid === 'number' ? row.pid : null,
    projectName: win32.basename(row.cwd as string),
    kind: row.kind as string,
    status: row.status as string,
    name: row.name as string,
    startedAtMs: row.startedAt as number,
  };
}

export function parseFleetJson(raw: string): { sessions: FleetSession[]; driftDetails: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const sessions: FleetSession[] = [];
  const driftDetails: string[] = [];

  for (const row of parsed) {
    const missing = missingFieldsOf(row);
    if (missing.length > 0) {
      driftDetails.push(`claude agents --json row missing/invalid field(s): ${missing.join(', ')}`);
      continue;
    }
    sessions.push(toFleetSession(row as Record<string, unknown>));
  }

  return { sessions, driftDetails };
}

export function filterOwnSession(sessions: FleetSession[], ownSessionId: string | null): FleetSession[] {
  if (ownSessionId === null) return sessions;
  return sessions.filter((s) => s.sessionId !== ownSessionId);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd collector && npx vitest run src/fleetPoll.test.ts`
Expected: PASS, all 9 tests.

- [ ] **Step 6: Commit**

```bash
git add collector/src/canary.ts collector/src/fleetPoll.ts collector/src/fleetPoll.test.ts
git commit -m "feat: add parseFleetJson and filterOwnSession (pure fleet-row validation)"
```

---

### Task 3: `collector/src/fleetPoll.ts` (extend) — `upsertFleetSessions`

**Files:**
- Modify: `collector/src/fleetPoll.ts`
- Modify: `collector/src/fleetPoll.test.ts`

**Interfaces:**
- Consumes: `FleetSession` (Task 2), `DatabaseSync` (type-only, Task 1's schema).
- Produces: `export function upsertFleetSessions(db: DatabaseSync, sessions: FleetSession[], nowMs: number): void;`
  Upserts each session by `session_id` (stamping `last_seen_ms = nowMs` on every row, whether
  inserted or updated), then unconditionally deletes any `fleet_sessions` row whose `last_seen_ms`
  is older than `nowMs - 30000` — called even with `sessions = []`, so the prune step always runs
  (see this plan's Global Constraints on why skipping it on a failed poll would be wrong).

- [ ] **Step 1: Write the failing tests**

Add to `collector/src/fleetPoll.test.ts`:

```typescript
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema.js';
import { upsertFleetSessions } from './fleetPoll.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-fleetupsert-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return db;
}

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    sessionId: 's1',
    pid: 100,
    projectName: 'proj',
    kind: 'interactive',
    status: 'busy',
    name: 'it-1',
    startedAtMs: 1000,
    ...overrides,
  };
}

describe('upsertFleetSessions', () => {
  it('inserts a new session with last_seen_ms stamped to nowMs', () => {
    const db = freshDb();
    upsertFleetSessions(db, [session()], 5000);
    const row: any = db.prepare('SELECT * FROM fleet_sessions').get();
    expect(row.session_id).toBe('s1');
    expect(row.last_seen_ms).toBe(5000);
    db.close();
  });

  it('updates an existing session in place by session_id, not duplicating it', () => {
    const db = freshDb();
    upsertFleetSessions(db, [session({ status: 'busy' })], 1000);
    upsertFleetSessions(db, [session({ status: 'idle' })], 2000);
    const rows: any[] = db.prepare('SELECT * FROM fleet_sessions').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('idle');
    expect(rows[0].last_seen_ms).toBe(2000);
    db.close();
  });

  it('prunes a row whose last_seen_ms is older than 30 seconds before this call\'s nowMs', () => {
    const db = freshDb();
    upsertFleetSessions(db, [session({ sessionId: 'stale' })], 1000);
    upsertFleetSessions(db, [session({ sessionId: 'fresh' })], 40000);
    const rows: any[] = db.prepare('SELECT session_id FROM fleet_sessions').all();
    expect(rows.map((r) => r.session_id)).toEqual(['fresh']);
    db.close();
  });

  it('the prune runs even when called with an empty sessions array', () => {
    const db = freshDb();
    upsertFleetSessions(db, [session({ sessionId: 'stale' })], 1000);
    upsertFleetSessions(db, [], 40000);
    const count: any = db.prepare('SELECT COUNT(*) as c FROM fleet_sessions').get();
    expect(count.c).toBe(0);
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npx vitest run src/fleetPoll.test.ts`
Expected: FAIL — `upsertFleetSessions` does not exist yet.

- [ ] **Step 3: Implement**

Add to `collector/src/fleetPoll.ts`:

```typescript
import type { DatabaseSync } from 'node:sqlite';

const STALE_MS = 30000; // twice the 15s poll interval, matching retention.ts's staleness convention

export function upsertFleetSessions(db: DatabaseSync, sessions: FleetSession[], nowMs: number): void {
  const upsert = db.prepare(
    `INSERT INTO fleet_sessions (session_id, pid, project_name, kind, status, name, started_at_ms, last_seen_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       pid = excluded.pid,
       project_name = excluded.project_name,
       kind = excluded.kind,
       status = excluded.status,
       name = excluded.name,
       started_at_ms = excluded.started_at_ms,
       last_seen_ms = excluded.last_seen_ms`
  );
  for (const s of sessions) {
    upsert.run(s.sessionId, s.pid, s.projectName, s.kind, s.status, s.name, s.startedAtMs, nowMs);
  }
  db.prepare('DELETE FROM fleet_sessions WHERE last_seen_ms < ?').run(nowMs - STALE_MS);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npx vitest run src/fleetPoll.test.ts`
Expected: PASS, all 13 tests (9 from Task 2 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add collector/src/fleetPoll.ts collector/src/fleetPoll.test.ts
git commit -m "feat: add upsertFleetSessions (upsert by session_id, unconditional 30s staleness prune)"
```

---

### Task 4: `collector/src/ownSessionFile.ts` — read Aether's own session id

**Files:**
- Create: `collector/src/ownSessionFile.ts`
- Create: `collector/src/ownSessionFile.test.ts`

**Interfaces:**
- Produces: `export function readOwnSessionId(filePath: string): string | null;`
  Reads and parses the JSON file Task 7's Electron-side writer produces
  (`{ sessionId: string | null, updatedAtMs: number }`), returning `sessionId` when it is present
  and a non-empty string, `null` for every other case (file missing, unreadable, malformed JSON,
  `sessionId` absent/null/not-a-string) — never throws.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readOwnSessionId } from './ownSessionFile.js';

function tempFileWith(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-ownsession-'));
  const filePath = join(dir, 'own-session.json');
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

describe('readOwnSessionId', () => {
  it('returns the sessionId from a well-formed file', () => {
    const filePath = tempFileWith(JSON.stringify({ sessionId: 'sess-abc', updatedAtMs: 1000 }));
    expect(readOwnSessionId(filePath)).toBe('sess-abc');
  });

  it('returns null when sessionId is explicitly null (no pty currently pinned)', () => {
    const filePath = tempFileWith(JSON.stringify({ sessionId: null, updatedAtMs: 1000 }));
    expect(readOwnSessionId(filePath)).toBeNull();
  });

  it('returns null when the file does not exist', () => {
    const missingPath = join(tmpdir(), 'aether-collector-ownsession-missing-' + Date.now(), 'own-session.json');
    expect(readOwnSessionId(missingPath)).toBeNull();
  });

  it('returns null for malformed JSON, never throws', () => {
    const filePath = tempFileWith('not json{{');
    expect(() => readOwnSessionId(filePath)).not.toThrow();
    expect(readOwnSessionId(filePath)).toBeNull();
  });

  it('returns null when sessionId is missing or not a string', () => {
    expect(readOwnSessionId(tempFileWith(JSON.stringify({ updatedAtMs: 1000 })))).toBeNull();
    expect(readOwnSessionId(tempFileWith(JSON.stringify({ sessionId: 42 })))).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npx vitest run src/ownSessionFile.test.ts`
Expected: FAIL — `ownSessionFile.ts` does not exist yet.

- [ ] **Step 3: Implement**

```typescript
import { readFileSync } from 'node:fs';

export function readOwnSessionId(filePath: string): string | null {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const sessionId = (parsed as Record<string, unknown>).sessionId;
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npx vitest run src/ownSessionFile.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add collector/src/ownSessionFile.ts collector/src/ownSessionFile.test.ts
git commit -m "feat: add collector-side reader for Aether's own-session-id file"
```

---

### Task 5: `collector/src/fleetPoll.ts` (extend) — `pollFleet`

**Files:**
- Modify: `collector/src/fleetPoll.ts`
- Modify: `collector/src/fleetPoll.test.ts`

**Interfaces:**
- Consumes: `parseFleetJson`, `filterOwnSession` (Task 2), `logDrift` (Task 2's export from
  `canary.ts`), `DatabaseSync` (type-only).
- Produces:
  ```typescript
  export type FleetExecFn = () => Promise<{ stdout: string }>;
  export async function pollFleet(
    db: DatabaseSync,
    ownSessionId: string | null,
    nowMs: number,
    execFn?: FleetExecFn
  ): Promise<FleetSession[] | null>;
  ```
  `execFn` defaults to a real `execFile('claude', ['agents', '--json'])` call, promisified — the
  default is NOT unit tested directly (matches `collector/src/autostart.ts`'s established
  precedent of never unit-testing the real OS-touching call, only its pure/injectable parts);
  Task 6's manual verification step covers it live instead. Returns `null` (never throws) when the
  child process fails to spawn/exits non-zero/rejects, or when `parseFleetJson` returns `null` for
  the whole payload — both cases log one `drift_log` row via `logDrift` first. On a successful
  parse, any per-row `driftDetails` are also logged (one `drift_log` row each), and the function
  returns `filterOwnSession(sessions, ownSessionId)` — never `null` once parsing succeeded, even if
  every row was dropped (that's a legitimate "zero other sessions" result, not a failure).

- [ ] **Step 1: Write the failing tests**

Add to `collector/src/fleetPoll.test.ts`:

```typescript
import { pollFleet } from './fleetPoll.js';

describe('pollFleet', () => {
  it('returns parsed, self-filtered sessions on a successful poll', async () => {
    const db = freshDb();
    const stdout = JSON.stringify([
      { ...REAL_ROW, sessionId: 'own-session' },
      { ...REAL_ROW, sessionId: 'other-session', name: 'it-99' },
    ]);
    const result = await pollFleet(db, 'own-session', 1000, async () => ({ stdout }));
    expect(result).toEqual([
      { sessionId: 'other-session', pid: 6824, projectName: 'IT', kind: 'interactive', status: 'busy', name: 'it-99', startedAtMs: 1785255815376 },
    ]);
    db.close();
  });

  it('returns null and logs drift_log when the exec function throws (spawn failure / non-zero exit)', async () => {
    const db = freshDb();
    const result = await pollFleet(db, null, 1000, async () => {
      throw new Error('spawn claude ENOENT');
    });
    expect(result).toBeNull();
    const rows: any[] = db.prepare('SELECT detail FROM drift_log').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toContain('ENOENT');
    db.close();
  });

  it('returns null and logs drift_log when stdout is not valid JSON', async () => {
    const db = freshDb();
    const result = await pollFleet(db, null, 1000, async () => ({ stdout: 'not json{{' }));
    expect(result).toBeNull();
    const count: any = db.prepare('SELECT COUNT(*) as c FROM drift_log').get();
    expect(count.c).toBe(1);
    db.close();
  });

  it('logs one drift_log row per malformed row but still returns the valid ones (not null)', async () => {
    const db = freshDb();
    const { sessionId, ...missingSessionId } = REAL_ROW;
    const stdout = JSON.stringify([missingSessionId, { ...REAL_ROW, sessionId: 'ok-session' }]);
    const result = await pollFleet(db, null, 1000, async () => ({ stdout }));
    expect(result).toHaveLength(1);
    expect(result![0].sessionId).toBe('ok-session');
    const count: any = db.prepare('SELECT COUNT(*) as c FROM drift_log').get();
    expect(count.c).toBe(1);
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npx vitest run src/fleetPoll.test.ts`
Expected: FAIL — `pollFleet` does not exist yet.

- [ ] **Step 3: Implement**

Add to `collector/src/fleetPoll.ts`:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logDrift } from './canary.js';

const execFileAsync = promisify(execFile);

export type FleetExecFn = () => Promise<{ stdout: string }>;

async function defaultFleetExec(): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync('claude', ['agents', '--json']);
  return { stdout };
}

export async function pollFleet(
  db: DatabaseSync,
  ownSessionId: string | null,
  nowMs: number,
  execFn: FleetExecFn = defaultFleetExec
): Promise<FleetSession[] | null> {
  let stdout: string;
  try {
    stdout = (await execFn()).stdout;
  } catch (err) {
    logDrift(db, nowMs, `claude agents --json failed to run: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const parsed = parseFleetJson(stdout);
  if (parsed === null) {
    logDrift(db, nowMs, 'claude agents --json output was not a valid JSON array');
    return null;
  }
  for (const detail of parsed.driftDetails) logDrift(db, nowMs, detail);

  return filterOwnSession(parsed.sessions, ownSessionId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npx vitest run src/fleetPoll.test.ts`
Expected: PASS, all 17 tests (13 from Tasks 2–3 + 4 new).

- [ ] **Step 5: Run the full collector suite**

Run: `cd collector && npx tsc -b && npm test`
Expected: zero type errors, all tests pass (should now be 76 + 9 + 4 + 5 + 4 = 98, but count what
actually runs rather than assuming — report the real number).

- [ ] **Step 6: Commit**

```bash
git add collector/src/fleetPoll.ts collector/src/fleetPoll.test.ts
git commit -m "feat: add pollFleet (spawns claude agents --json, parses, self-filters, logs drift)"
```

---

### Task 6: Wire fleet polling into the collector's main loop

**Files:**
- Modify: `collector/src/index.ts`
- Modify: `collector/src/index.test.ts`

**Interfaces:**
- Consumes: `pollFleet`, `upsertFleetSessions` (Tasks 3, 5), `readOwnSessionId` (Task 4).
- Modifies: `startCollector(options)` gains two more fields, `ownSessionFilePath: string` and
  `fleetPollIntervalMs: number`, and one more interval, stopped alongside the existing three by the
  same returned stop function. This is the collector's FIRST async `setInterval` callback (the
  existing tailer/compaction/transcript-scan callbacks are all synchronous or already
  fire-and-forget in a different way) — follow `electron/main.ts`'s existing
  `somePromise().catch((err) => console.error(...))` convention for the async tick, since an
  unhandled rejection inside a `setInterval` callback would otherwise crash the whole collector
  process.

- [ ] **Step 1: Read the current `collector/src/index.ts` in full** (reproduced in this plan's
  "Architecture" section context, but re-read the live file before editing — Task 6 of the prior
  stage's plan already touched this file most recently).

- [ ] **Step 2: Add a `pollAndUpsertFleet` helper and wire it into `startCollector`**

```typescript
import { pollFleet, upsertFleetSessions } from './fleetPoll.js';
import { readOwnSessionId } from './ownSessionFile.js';

async function pollAndUpsertFleet(db: DatabaseSync, ownSessionFilePath: string): Promise<void> {
  const ownSessionId = readOwnSessionId(ownSessionFilePath);
  const nowMs = Date.now();
  const sessions = await pollFleet(db, ownSessionId, nowMs);
  upsertFleetSessions(db, sessions ?? [], nowMs);
}

export function startCollector(options: {
  dbPath: string;
  spoolDir: string;
  tailIntervalMs: number;
  compactIntervalMs: number;
  projectsRoot: string;
  transcriptScanIntervalMs: number;
  ownSessionFilePath: string;
  fleetPollIntervalMs: number;
}): () => void {
  const db = openDatabase(options.dbPath);
  migrate(db);

  const stopTailer = startSpoolTailer(db, options.spoolDir, options.tailIntervalMs);
  const compactTimer = setInterval(() => compact(db, Date.now()), options.compactIntervalMs);
  scanTranscriptsOnce(db, options.projectsRoot, Date.now());
  const transcriptScanTimer = setInterval(
    () => scanTranscriptsOnce(db, options.projectsRoot, Date.now()),
    options.transcriptScanIntervalMs
  );

  pollAndUpsertFleet(db, options.ownSessionFilePath).catch((err) =>
    console.error('[aether-collector] fleet poll failed:', err)
  );
  const fleetPollTimer = setInterval(() => {
    pollAndUpsertFleet(db, options.ownSessionFilePath).catch((err) =>
      console.error('[aether-collector] fleet poll failed:', err)
    );
  }, options.fleetPollIntervalMs);

  return () => {
    stopTailer();
    clearInterval(compactTimer);
    clearInterval(transcriptScanTimer);
    clearInterval(fleetPollTimer);
    db.close();
  };
}
```

Import `type { DatabaseSync } from 'node:sqlite';` at the top if not already present (it already
is, via `schema.js`'s re-exported usage elsewhere in this file — check before adding a duplicate).

- [ ] **Step 3: Update the module-level real invocation**

In the `isMainModule` block, add the two new fields, matching this file's existing `aetherDir`
convention:

```typescript
const stop = startCollector({
  dbPath: join(aetherDir, 'collector.db'),
  spoolDir: join(aetherDir, 'spool'),
  tailIntervalMs: 2000,
  compactIntervalMs: 60 * 60 * 1000,
  projectsRoot: join(homedir(), '.claude', 'projects'),
  transcriptScanIntervalMs: 15000,
  ownSessionFilePath: join(aetherDir, 'own-session.json'),
  fleetPollIntervalMs: 15000,
});
```

- [ ] **Step 4: Update `collector/src/index.test.ts`**

Add the two new required fields to the existing `startCollector({...})` call so it still
type-checks and runs; point `ownSessionFilePath` at a path inside the same temp dir the existing
test already creates (it need not exist — `readOwnSessionId` returns `null` for a missing file,
which is exactly the correct "no own session" behavior for this test's isolated environment).

```typescript
const stop = startCollector({
  dbPath,
  spoolDir,
  tailIntervalMs: 20,
  compactIntervalMs: 100000,
  projectsRoot,
  transcriptScanIntervalMs: 100000,
  ownSessionFilePath: join(dir, 'own-session.json'),
  fleetPollIntervalMs: 100000,
});
```

- [ ] **Step 5: Run the full collector suite and build**

Run: `cd collector && npx vitest run` (all files), `cd collector && npx tsc -b`,
`cd collector && npm run build` — confirm zero errors, zero regressions. Note: the existing
`index.test.ts` integration test does not itself assert anything about `fleet_sessions` (it spawns
a real, unmocked async fleet poll against whatever `claude` binary happens to be on the test
runner's PATH — this is intentionally not asserted on, since the test's 100ms wait is far shorter
than any real `claude agents --json` invocation and the point of this test is the spool-tailer path,
not the fleet path). Confirm the test still passes despite that timing mismatch — it should, since
the fleet poll's own failure (or success) is fully decoupled via `.catch()` and never blocks or
fails `startCollector` itself.

- [ ] **Step 6: Commit**

```bash
git add collector/src/index.ts collector/src/index.test.ts
git commit -m "feat: wire fleet polling into the collector's main loop (15s interval)"
```

---

### Task 7: Electron — expose Aether's own session id, write it atomically

**Files:**
- Create: `electron/ownSessionFile.ts`
- Create: `electron/ownSessionFile.test.ts`
- Modify: `electron/liveAgentTracker.ts`
- Modify: `electron/main.ts`

**Interfaces:**
- Produces (electron/ownSessionFile.ts):
  ```typescript
  export function ownSessionFilePath(aetherDir: string): string;
  export function writeOwnSessionFile(aetherDir: string, sessionId: string | null, nowMs: number): void;
  ```
  Atomic tmp-then-rename write (mirrors `scripts/aether-statusline.mjs`'s `persistSnapshot`), never
  throws (a write failure here must not crash the tick loop — swallow and continue, matching that
  script's established convention).
- Modifies `electron/liveAgentTracker.ts`'s returned object: adds
  `getPinnedSessionId(): string | null` (returns `path.basename(pinnedFile, '.jsonl')` when a file
  is pinned, else `null` — read-only, no new state).
- Modifies `electron/main.ts`'s `tickAndPushAgents`: after each tick, writes the current pinned
  session id to disk ONLY when it changed since the last write (a module-level
  `lastWrittenOwnSessionId` guard), so this does not add a disk write on every 1s tick.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ownSessionFilePath, writeOwnSessionFile } from './ownSessionFile';

describe('writeOwnSessionFile', () => {
  it('writes a JSON file with sessionId and updatedAtMs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-ownsession-'));
    writeOwnSessionFile(dir, 'sess-abc', 5000);
    const content = JSON.parse(readFileSync(ownSessionFilePath(dir), 'utf8'));
    expect(content).toEqual({ sessionId: 'sess-abc', updatedAtMs: 5000 });
  });

  it('writes sessionId: null when nothing is pinned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-ownsession-'));
    writeOwnSessionFile(dir, null, 1000);
    const content = JSON.parse(readFileSync(ownSessionFilePath(dir), 'utf8'));
    expect(content.sessionId).toBeNull();
  });

  it('creates the target directory if it does not exist yet', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'aether-ownsession-')), 'nested', '.aether-os');
    expect(existsSync(dir)).toBe(false);
    writeOwnSessionFile(dir, 'sess-1', 1000);
    expect(existsSync(ownSessionFilePath(dir))).toBe(true);
  });

  it('does not leave a stray .tmp file behind after a successful write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-ownsession-'));
    writeOwnSessionFile(dir, 'sess-1', 1000);
    expect(existsSync(`${ownSessionFilePath(dir)}.tmp`)).toBe(false);
  });

  it('never throws even if writing fails (e.g. a file exists where a directory is expected)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-ownsession-'));
    const blockerPath = join(dir, 'blocked');
    require('fs').writeFileSync(blockerPath, 'i am a file, not a directory');
    expect(() => writeOwnSessionFile(join(blockerPath, 'nested'), 'sess-1', 1000)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run electron/ownSessionFile.test.ts`
Expected: FAIL — `ownSessionFile.ts` does not exist yet.

- [ ] **Step 3: Implement**

```typescript
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export function ownSessionFilePath(aetherDir: string): string {
  return join(aetherDir, 'own-session.json');
}

/**
 * Atomic tmp-then-rename write, mirroring scripts/aether-statusline.mjs's
 * persistSnapshot -- a direct write to the target path would let the
 * collector's reader observe a partially-written file mid-write on its own
 * poll cycle. Never throws: a write failure here must not break the tick
 * loop it's called from.
 */
export function writeOwnSessionFile(aetherDir: string, sessionId: string | null, nowMs: number): void {
  try {
    mkdirSync(aetherDir, { recursive: true });
    const targetPath = ownSessionFilePath(aetherDir);
    const tmpPath = `${targetPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ sessionId, updatedAtMs: nowMs }), 'utf8');
    renameSync(tmpPath, targetPath);
  } catch {
    // Swallowed: a persistence failure here must not crash tickAndPushAgents.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run electron/ownSessionFile.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Expose the pinned session id from `liveAgentTracker`**

In `electron/liveAgentTracker.ts`, add one new method to the object `createLiveAgentTracker`
returns, alongside the existing `notifyPtySpawned` and `tick`:

```typescript
getPinnedSessionId(): string | null {
  return pinnedFile ? path.basename(pinnedFile, '.jsonl') : null;
},
```

(`path` is already imported at the top of this file — no new import needed. `pinnedFile` is the
same closure variable `tick()` already reads/writes; this is a read-only accessor, no new state.)

- [ ] **Step 6: Wire the write into `electron/main.ts`'s `tickAndPushAgents`**

Add near the top of the file, alongside the other `.aether-os`-rooted path constants:

```typescript
import { writeOwnSessionFile } from './ownSessionFile';
// ...
const aetherOsDir = join(os.homedir(), '.aether-os');
let lastWrittenOwnSessionId: string | null | undefined = undefined;
```

Inside `tickAndPushAgents`, right after the existing `const { open, completed, work, anomalies,
cacheHitRatio } = await liveAgentTracker.tick();` line:

```typescript
const pinnedSessionId = liveAgentTracker.getPinnedSessionId();
if (pinnedSessionId !== lastWrittenOwnSessionId) {
  writeOwnSessionFile(aetherOsDir, pinnedSessionId, Date.now());
  lastWrittenOwnSessionId = pinnedSessionId;
}
```

`lastWrittenOwnSessionId` starts as `undefined`, which is `!==` both `null` and any real session
id, so the very first tick after app launch always writes once — this self-heals a stale
`own-session.json` left over from a previous run (e.g. after a crash) rather than requiring an
explicit reset.

- [ ] **Step 7: Full verification**

Run: `npx tsc -b && npm run build && npm run electron:build && npx vitest run` from the repo root.
Confirm zero errors, zero regressions against the 639-test baseline (should now be 639 + 5 = 644).

- [ ] **Step 8: Commit**

```bash
git add electron/ownSessionFile.ts electron/ownSessionFile.test.ts electron/liveAgentTracker.ts electron/main.ts
git commit -m "feat: write Aether's own pinned session id to disk for the collector to read"
```

---

### Task 8: `electron/collectorStore.ts` (extend) — `readFleetSessions`

**Files:**
- Modify: `electron/collectorStore.ts`
- Modify: `electron/collectorStore.test.ts`

**Interfaces:**
- Renames the existing `MIN_SUPPORTED_SCHEMA_VERSION = 2` constant to
  `MIN_SCHEMA_VERSION_FOR_USAGE_EVENTS = 2` (update `readUsageEventsSince`'s one reference to
  match) — see this plan's Global Constraints for why sharing one constant across two readers with
  different real minimum versions would be wrong.
- Adds:
  ```typescript
  export interface FleetSessionRow {
    sessionId: string;
    pid: number | null;
    projectName: string;
    kind: string;
    status: string;
    name: string;
    startedAtMs: number;
  }
  export function readFleetSessions(dbPath: string): FleetSessionRow[] | null;
  ```
  `null` when the DB file doesn't exist, can't be opened, or `schema_meta`'s version is below 3
  (mirroring `readUsageEventsSince`'s exact convention) — this is what lets `FleetCard` (Task 11)
  distinguish "collector isn't running / predates this feature" from "confirmed zero other
  sessions," which a plain `[]` return could never do on its own.
  `FleetSessionRow` is defined in `src/state/types.ts` (Task 10, written first in this task's
  Step 1 below since `collectorStore.ts` needs to import it) rather than locally in
  `electron/collectorStore.ts` — matching the existing precedent that cross-boundary IPC payload
  types live under `src/` and `electron/` imports them (see `RealUsageSnapshot`, `RealAgentDispatch`
  in `preload.ts`'s own imports), not the reverse.

- [ ] **Step 1: Add `FleetSessionRow` to `src/state/types.ts`**

Near `RealUsageSnapshot` (both are IPC payload shapes defined in this file):

```typescript
export interface FleetSessionRow {
  sessionId: string;
  pid: number | null;
  projectName: string;
  kind: string;
  status: string;
  name: string;
  startedAtMs: number;
}
```

- [ ] **Step 2: Write the failing tests**

Add to `electron/collectorStore.test.ts`:

```typescript
function tempDbWithFleetSessions(rows: { session_id: string; pid: number | null; project_name: string; kind: string; status: string; name: string; started_at_ms: number; last_seen_ms: number }[], schemaVersion = 3): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collectorstore-fleet-'));
  const dbPath = join(dir, 'test.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE fleet_sessions (session_id TEXT PRIMARY KEY, pid INTEGER, project_name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, name TEXT NOT NULL, started_at_ms INTEGER NOT NULL, last_seen_ms INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)").run(String(schemaVersion));
  const insert = db.prepare(
    'INSERT INTO fleet_sessions (session_id, pid, project_name, kind, status, name, started_at_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const r of rows) {
    insert.run(r.session_id, r.pid, r.project_name, r.kind, r.status, r.name, r.started_at_ms, r.last_seen_ms);
  }
  db.close();
  return dbPath;
}

describe('readFleetSessions', () => {
  it('returns mapped fleet session rows', () => {
    const dbPath = tempDbWithFleetSessions([
      { session_id: 's1', pid: 100, project_name: 'proj', kind: 'interactive', status: 'busy', name: 'it-1', started_at_ms: 1000, last_seen_ms: 2000 },
    ]);
    const rows = readFleetSessions(dbPath);
    expect(rows).toEqual([
      { sessionId: 's1', pid: 100, projectName: 'proj', kind: 'interactive', status: 'busy', name: 'it-1', startedAtMs: 1000 },
    ]);
  });

  it('returns an empty array (not null) when the table exists but has zero rows', () => {
    const dbPath = tempDbWithFleetSessions([]);
    expect(readFleetSessions(dbPath)).toEqual([]);
  });

  it('maps a null pid through as null', () => {
    const dbPath = tempDbWithFleetSessions([
      { session_id: 's1', pid: null, project_name: 'proj', kind: 'background', status: 'idle', name: 'it-1', started_at_ms: 1000, last_seen_ms: 2000 },
    ]);
    expect(readFleetSessions(dbPath)![0].pid).toBeNull();
  });

  it('returns null when the database file does not exist', () => {
    const missingPath = join(tmpdir(), 'aether-collectorstore-fleet-missing-' + Date.now(), 'test.db');
    expect(readFleetSessions(missingPath)).toBeNull();
  });

  it('returns null when schema_meta version is below 3', () => {
    const dbPath = tempDbWithFleetSessions([], 2);
    expect(readFleetSessions(dbPath)).toBeNull();
  });

  it('never throws even against a malformed/corrupt database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-collectorstore-fleet-corrupt-'));
    const dbPath = join(dir, 'test.db');
    require('fs').writeFileSync(dbPath, 'not a real sqlite file');
    expect(() => readFleetSessions(dbPath)).not.toThrow();
    expect(readFleetSessions(dbPath)).toBeNull();
  });
});
```

Also add `import { readFleetSessions } from './collectorStore.js';` to the existing import line at
the top (alongside `readUsageEventsSince`).

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run electron/collectorStore.test.ts`
Expected: FAIL — `readFleetSessions` does not exist yet; the existing `readUsageEventsSince` tests
should still PASS unchanged at this point (confirms Step 1 alone didn't break anything).

- [ ] **Step 4: Implement**

In `electron/collectorStore.ts`: rename `MIN_SUPPORTED_SCHEMA_VERSION` to
`MIN_SCHEMA_VERSION_FOR_USAGE_EVENTS` (update its one use inside `readUsageEventsSince`), add
`import type { FleetSessionRow } from '../src/state/types';`, and add:

```typescript
const MIN_SCHEMA_VERSION_FOR_FLEET_SESSIONS = 3;

export function readFleetSessions(dbPath: string): FleetSessionRow[] | null {
  const db = openReadOnly(dbPath);
  if (!db) return null;

  try {
    if (schemaVersionOf(db) < MIN_SCHEMA_VERSION_FOR_FLEET_SESSIONS) return null;

    const rows = db
      .prepare('SELECT session_id, pid, project_name, kind, status, name, started_at_ms FROM fleet_sessions')
      .all() as {
      session_id: string;
      pid: number | null;
      project_name: string;
      kind: string;
      status: string;
      name: string;
      started_at_ms: number;
    }[];

    return rows.map((r) => ({
      sessionId: r.session_id,
      pid: r.pid,
      projectName: r.project_name,
      kind: r.kind,
      status: r.status,
      name: r.name,
      startedAtMs: r.started_at_ms,
    }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run electron/collectorStore.test.ts`
Expected: PASS, all 11 tests (5 existing `readUsageEventsSince` + 6 new `readFleetSessions`).

- [ ] **Step 6: Commit**

```bash
git add src/state/types.ts electron/collectorStore.ts electron/collectorStore.test.ts
git commit -m "feat: add read-only readFleetSessions (fleet_sessions, version-3-gated)"
```

---

### Task 9: Push `fleet:snapshot` over IPC — `main.ts`, `preload.ts`, `aetherElectron.d.ts`

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/aetherElectron.d.ts`

**Interfaces:**
- Consumes: `readFleetSessions` (Task 8).
- New IPC event `fleet:snapshot`, payload `FleetSessionRow[] | null`, pushed on its own interval —
  matching the existing `usage:snapshot`/`agents:snapshot` push pattern (immediate call once, then
  `setInterval`), not folded into `tickAndPushAgents`'s 1s cadence (fleet data only changes as
  often as the collector's own 15s poll, so pushing it every 1s would be pure waste).

- [ ] **Step 1: Add the push function and interval in `electron/main.ts`**

Near `scanAndPushUsage`, add:

```typescript
const FLEET_SCAN_INTERVAL_MS = 15000;

function scanAndPushFleet(): void {
  if (!mainWindow) return;
  const rows = readFleetSessions(collectorDbPath);
  sendToWindow('fleet:snapshot', rows);
}
```

Add `readFleetSessions` to the existing `import { readUsageEventsSince, ... } from './collectorStore';`
line. Inside `app.whenReady().then(...)`, alongside the existing `scanAndPushUsage`/
`tickAndPushAgents` wiring:

```typescript
scanAndPushFleet();
setInterval(scanAndPushFleet, FLEET_SCAN_INTERVAL_MS);
```

- [ ] **Step 2: Expose it in `electron/preload.ts`**

Add `import type { FleetSessionRow } from '../src/state/types';` to the top import block, and add a
new `fleet` section to the `contextBridge.exposeInMainWorld('aetherElectron', {...})` object,
alongside `usage`/`agents`:

```typescript
fleet: {
  onSnapshot: (callback: (rows: FleetSessionRow[] | null) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, rows: FleetSessionRow[] | null) => callback(rows);
    ipcRenderer.on('fleet:snapshot', listener);
    return () => ipcRenderer.removeListener('fleet:snapshot', listener);
  },
},
```

- [ ] **Step 3: Update the ambient type declaration**

Add `import type { FleetSessionRow } from './state/types';` to `src/aetherElectron.d.ts`'s import
block, and add the matching `fleet` section inside `interface Window { aetherElectron?: {...} }`,
alongside `usage`/`agents`:

```typescript
fleet: {
  onSnapshot: (callback: (rows: FleetSessionRow[] | null) => void) => () => void;
};
```

- [ ] **Step 4: Full verification**

Run: `npx tsc -b && npm run build && npm run electron:build && npx vitest run` from the repo root.
Confirm zero errors — this task adds no new test file (it's IPC wiring, matching how Stage 3's
Task 8 electron wiring had no dedicated test file either; `useFleetSync`'s hook in Task 10 and
`FleetCard`'s component tests in Task 11 are what exercise this path from the renderer side).

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts electron/preload.ts src/aetherElectron.d.ts
git commit -m "feat: push fleet:snapshot over IPC on its own 15s interval"
```

---

### Task 10: Renderer state — `state.fleet`, `SET_FLEET`, persistence exclusion, `useFleetSync`

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/reducer.ts`
- Modify: `src/state/persistence.ts`
- Create: `src/state/useFleetSync.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- `AetherState` gains `fleet: FleetSessionRow[] | null;` (type already added in Task 8's Step 1).
- New action: `{ type: 'SET_FLEET'; fleet: FleetSessionRow[] | null }`.
- `PERSISTENCE_EXCLUSIONS` gains a `fleet` entry — required, or `persistence.test.ts`'s existing
  coverage test fails (see Global Constraints).
- `useFleetSync()` mirrors `useRealAgentsSync.ts`'s single-subscription pattern exactly.

- [ ] **Step 1: Add `fleet` to `AetherState`**

In `src/state/types.ts`, add to the `AetherState` interface, alongside `statusline`:

```typescript
fleet: FleetSessionRow[] | null;
```

(`FleetSessionRow` is already defined in this same file from Task 8's Step 1 — no new import
needed.)

- [ ] **Step 2: Add the initial value**

In `src/state/initialState.ts`, alongside `cacheHitRatio: 0,`:

```typescript
fleet: null,
```

- [ ] **Step 3: Add the reducer case**

In `src/state/reducer.ts`, add the action to the `Action` union (alongside
`SET_CACHE_HIT_RATIO`):

```typescript
| { type: 'SET_FLEET'; fleet: FleetSessionRow[] | null }
```

(Import `FleetSessionRow` from `./types` if not already imported in this file — check the existing
import block first.) Add the case, alongside `SET_CACHE_HIT_RATIO`:

```typescript
case 'SET_FLEET':
  return { ...state, fleet: action.fleet };
```

- [ ] **Step 4: Add the persistence exclusion**

In `src/state/persistence.ts`, add to `PERSISTENCE_EXCLUSIONS`, alongside `statusline`:

```typescript
fleet: 'a live external-process snapshot of other claude sessions on the machine, stale the instant it is written to disk -- same reasoning as the logs exclusion',
```

- [ ] **Step 5: Write `useFleetSync.ts`**

```typescript
import { useEffect } from 'react';
import { useAetherStore } from './store';

export function useFleetSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const fleet = window.aetherElectron?.fleet;
    if (!fleet) return;
    return fleet.onSnapshot((rows) => {
      dispatch({ type: 'SET_FLEET', fleet: rows });
    });
  }, [dispatch]);
}
```

- [ ] **Step 6: Mount it in `src/App.tsx`**

Add the import, alongside `useStatuslineSync`:

```typescript
import { useFleetSync } from './state/useFleetSync';
```

Add a wrapper component, alongside `StatuslineSync`:

```typescript
function FleetSync() {
  useFleetSync();
  return null;
}
```

Mount it inside `<AppShell>`, alongside `<StatuslineSync />`:

```typescript
<FleetSync />
```

- [ ] **Step 7: Run the persistence coverage test specifically, then the full suite**

Run: `npx vitest run src/state/persistence.test.ts` — expect PASS (confirms the new `fleet` key was
correctly added to `PERSISTENCE_EXCLUSIONS`, not silently missed). Then run the full verification:
`npx tsc -b && npm run build && npm run electron:build && npx vitest run` from the repo root.
Confirm zero errors, zero regressions.

- [ ] **Step 8: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/state/reducer.ts src/state/persistence.ts src/state/useFleetSync.ts src/App.tsx
git commit -m "feat: add state.fleet, SET_FLEET, useFleetSync (renderer-side fleet snapshot wiring)"
```

---

### Task 11: `FleetCard` — new card in the Agents view

**Files:**
- Create: `src/components/agents/FleetCard.tsx`
- Create: `src/components/agents/FleetCard.test.tsx`
- Modify: `src/components/agents/AgentsView.tsx`

**Interfaces:**
- Consumes: `state.fleet: FleetSessionRow[] | null`.
- Renders three states: `fleet === null` → collector-unavailable message; `fleet.length === 0` →
  "No other sessions detected" empty message; otherwise → one row per session (project name,
  session name, a status badge, running duration derived from `startedAtMs` vs. a locally-ticked
  `now`, mirroring `AgentRosterCard`/`ActiveAgentsCard`'s existing `setInterval(…, 1000)` +
  `fmtElapsed` pattern). Clicking a row toggles local `expandedSessionId` state to show the same
  already-available fields in place — no new IPC call, no new data source, matching the spec's "no
  new data fetch per click."
- Placement note (a real, minor spec inaccuracy, resolved here rather than silently worked around):
  the design spec says this card goes "alongside `ActiveAgentsCard`," but `ActiveAgentsCard` is
  actually a `terminal/` component used by `TerminalView`, not by `AgentsView` (which instead uses
  `AgentRosterCard` + `AgentDetailCard`). This task follows the spec's explicit **scope** statement
  ("a new card in the existing Agents view") literally — `FleetCard` is added to `AgentsView.tsx` —
  while following its **styling** guidance ("mirror `ActiveAgentsCard`'s empty/unavailable-state
  convention") from the actual `terminal/ActiveAgentsCard.tsx` file, which is a style reference, not
  a placement instruction.

- [ ] **Step 1: Write the failing tests**

```typescript
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { FleetCard } from './FleetCard';
import type { FleetSessionRow } from '../../state/types';

afterEach(cleanup);

function Setter({ fleet }: { fleet: FleetSessionRow[] | null }) {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    dispatch({ type: 'SET_FLEET', fleet });
  }, [dispatch, fleet]);
  return null;
}

function renderWithFleet(fleet: FleetSessionRow[] | null) {
  return render(
    <AetherStoreProvider>
      <Setter fleet={fleet} />
      <FleetCard />
    </AetherStoreProvider>,
  );
}

const ROW: FleetSessionRow = {
  sessionId: 's1',
  pid: 100,
  projectName: 'my-project',
  kind: 'interactive',
  status: 'busy',
  name: 'it-68',
  startedAtMs: Date.now() - 60000,
};

describe('FleetCard', () => {
  it('shows the unavailable state when fleet is null (collector not running)', () => {
    renderWithFleet(null);
    expect(screen.getByText(/collector/i)).toBeInTheDocument();
  });

  it('shows the empty state when fleet is an empty array', () => {
    renderWithFleet([]);
    expect(screen.getByText(/no other sessions detected/i)).toBeInTheDocument();
  });

  it('renders a row for each fleet session, showing project name, session name, and status', () => {
    renderWithFleet([ROW]);
    expect(screen.getByText('my-project')).toBeInTheDocument();
    expect(screen.getByText('it-68')).toBeInTheDocument();
    expect(screen.getByText(/busy/i)).toBeInTheDocument();
  });

  it('expands a row in place on click, without any new data fetch', () => {
    renderWithFleet([ROW]);
    fireEvent.click(screen.getByText('my-project'));
    expect(screen.getByText(/interactive/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/agents/FleetCard.test.tsx`
Expected: FAIL — `FleetCard.tsx` does not exist yet.

- [ ] **Step 3: Implement**

```typescript
import { useEffect, useState, type CSSProperties } from 'react';
import { fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { fmtElapsed } from '../../utils/format';
import type { ColorPalette } from '../../styles/tokens';
import type { FleetSessionRow } from '../../state/types';

export function FleetCard() {
  const colors = useColors();
  const { state } = useAetherStore();
  const [now, setNow] = useState(() => Date.now());
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={cardStyle(colors)}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle(colors)}>FLEET</div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {state.fleet === null && <div style={emptyStyle(colors)}>collector isn&apos;t running -- fleet data unavailable</div>}
        {state.fleet !== null && state.fleet.length === 0 && <div style={emptyStyle(colors)}>No other sessions detected</div>}
        {state.fleet?.map((row) => (
          <FleetRow
            key={row.sessionId}
            row={row}
            now={now}
            colors={colors}
            expanded={row.sessionId === expandedSessionId}
            onToggle={() => setExpandedSessionId(expandedSessionId === row.sessionId ? null : row.sessionId)}
          />
        ))}
      </div>
    </div>
  );
}

function FleetRow({
  row,
  now,
  colors,
  expanded,
  onToggle,
}: {
  row: FleetSessionRow;
  now: number;
  colors: ColorPalette;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <Button onClick={onToggle} style={rowStyle(expanded)}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={nameStyle(colors)}>{row.projectName}</span>
          <span style={{ font: `700 11px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>{fmtElapsed(now - row.startedAtMs)}</span>
        </div>
        <div style={descStyle(colors)}>
          {row.name} · <span style={statusChipStyle(colors, row.status)}>{row.status}</span>
        </div>
        {expanded && (
          <div style={detailStyle(colors)}>
            kind: {row.kind}
            {row.pid !== null && ` · pid: ${row.pid}`}
          </div>
        )}
      </div>
    </Button>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
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
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function rowStyle(expanded: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 9px',
    borderRadius: 9,
    cursor: 'pointer',
    background: expanded ? 'rgba(23,184,216,.14)' : undefined,
    border: expanded ? '1px solid rgba(95,220,255,.4)' : '1px solid transparent',
  };
}
function nameStyle(colors: ColorPalette): CSSProperties {
  return {
    font: `600 13px/1 ${fonts.ui}`,
    color: colors.textPrimary,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}
function descStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 11px/1.3 ${fonts.ui}`, color: colors.textDim, marginTop: 3 };
}
function detailStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 10px/1.4 ${fonts.mono}`, color: colors.textDim, marginTop: 5 };
}
function statusChipStyle(colors: ColorPalette, status: string): CSSProperties {
  return {
    font: `700 9px/1 ${fonts.ui}`,
    letterSpacing: 0.5,
    color: status === 'busy' ? colors.success : colors.textMuted,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelInset,
    padding: '1px 4px',
    borderRadius: 4,
  };
}
function emptyStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 11px/1.3 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/agents/FleetCard.test.tsx`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Place `FleetCard` in `AgentsView.tsx`**

```typescript
import type { CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { pickSelectedRealAgent } from './agentsMath';
import { AgentRosterCard } from './AgentRosterCard';
import { AgentDetailCard } from './AgentDetailCard';
import { FleetCard } from './FleetCard';

export function AgentsView() {
  const { state } = useAetherStore();
  const selectedAgent = pickSelectedRealAgent(state.realAgents, state.selectedRealAgent);

  return (
    <div style={rootStyle}>
      <AgentRosterCard selectedToolUseId={selectedAgent?.toolUseId ?? null} />
      <AgentDetailCard agent={selectedAgent} />
      <FleetCard />
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
```

- [ ] **Step 6: Full verification**

Run: `npx tsc -b && npm run build && npm run electron:build && npx vitest run` from the repo root.
Confirm zero errors, zero regressions against the running baseline (639 + 5 + 11 + 4 = 659 —
confirm the actual number rather than assuming).

- [ ] **Step 7: Manual verification**

Run `npm run electron:dev`, open the Agents tab, confirm `FleetCard` renders. With no collector
running (the default on a fresh checkout), it should show the "collector isn't running" message. If
you can run the collector for real in this environment (`cd collector && npm run build && npm
start`, from a terminal separate from Aether's own embedded one, with at least one other `claude`
session active elsewhere on the machine), confirm a real row appears and that Aether's own terminal
session never appears in the list. State the result explicitly either way — if this environment is
headless and manual verification cannot be performed, say so rather than claiming it was checked,
per this project's established convention for deferred verification.

- [ ] **Step 8: Commit**

```bash
git add src/components/agents/FleetCard.tsx src/components/agents/FleetCard.test.tsx src/components/agents/AgentsView.tsx
git commit -m "feat: add FleetCard to the Agents view (read-only fleet session browser)"
```

---

### Task 12: Whole-branch review, degradation check, roadmap/PROGRESS.md update

**Files:**
- Modify: `docs/roadmap.md`
- Modify: `PROGRESS.md`

- [ ] **Step 1: Full verification pass**

Run `cd collector && npm run build && npm test`, then from the repo root `npx tsc -b && npm run
build && npm run electron:build && npx vitest run`. Confirm both are completely clean.

- [ ] **Step 2: Confirm the degradation contract explicitly**

With no `~/.aether-os/collector.db` on this box (or after temporarily renaming it out of the way if
one exists from earlier local testing, restoring it afterward), confirm `FleetCard` renders the
"collector isn't running" state rather than throwing or showing a broken/empty-looking card that's
indistinguishable from "confirmed zero sessions" — this is the whole reason `readFleetSessions`
returns `null` rather than `[]` for this case; confirm that distinction actually reaches the UI.

- [ ] **Step 3: Update `docs/roadmap.md`'s Stage 4 row**

Mark Stage 4 as shipped in the table, matching how Stage 1/2/3 rows already signal completion, and
add a short note: this stage shipped as a read-only fleet browser only (no session control, no
`--all`/completed-session history, no redirect of the app's own live tracking, and Stage 3's
deferred "which session is active for the headless collector's own live-tick/anomaly work" question
remains open for a future stage) — cross-reference
`docs/superpowers/specs/2026-07-28-fleet-session-picker-design.md`'s "Out of scope" section so a
future reader knows why "Fleet + session picker" didn't retire the roadmap's original
false-completion-bug justification (that was already fixed by `8e0e9d4` before this stage was
scoped — see the design spec's "Context" section).

- [ ] **Step 4: Add a `PROGRESS.md` entry**

Follow this repo's established format (see the Viewer Reads the Store, Collector Foundation, and
Statusline Feed entries). Cover: what shipped (read-only fleet browser, active-sessions-only); the
`sessionId`-based self-exclusion mechanism and why it replaced the design spec's PID-based sketch
(the pty-spawns-a-shell-not-claude-directly mismatch); the `null`-vs-`[]` distinction in
`readFleetSessions`/`FleetCard` and why it was necessary (no fallback-estimate path exists for fleet
data, unlike the usage tiles); the unconditional-staleness-prune design in `upsertFleetSessions`
and why skipping it on a failed poll would have been wrong; and the manual verification result from
Task 11's Step 7 (state plainly whether it was actually performed in this environment).

- [ ] **Step 5: Commit**

```bash
git add docs/roadmap.md PROGRESS.md
git commit -m "docs: mark Stage 4 shipped (read-only fleet session browser)"
```

---

After all twelve tasks: dispatch a whole-branch review (per this project's established pattern)
focused especially on (a) whether `filterOwnSession`'s `sessionId`-based matching genuinely excludes
Aether's own terminal session in a live run, not just in unit tests with synthetic fixtures; (b)
whether the `null`-vs-`[]` distinction from `readFleetSessions` all the way through to `FleetCard`'s
rendering actually holds end-to-end (no code path silently collapses one into the other); and (c)
whether Task 12's Step 2 degradation-contract check and Task 11's Step 7 manual verification were
honestly reported either way, not asserted without having been performed.
