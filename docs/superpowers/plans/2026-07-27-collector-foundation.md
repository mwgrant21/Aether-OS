# Collector Foundation (Stage 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `collector/`, a standalone headless Node process that ingests Claude Code hook
events via an append-only file spool, derives privacy-safe signals at ingest, and persists them
to a versioned local SQLite store — with a matching hook installer, retention/purge, and Windows
autostart. The Electron app (Aether OS) is **not touched** in this stage; it still scans transcripts
exactly as it does today. Stage 3 is what makes the viewer read this store.

**Architecture:** `collector/` is a separate `package.json` inside this repo (not a workspace, not
published) — a standalone Node 22.5+ project using only `node:*` builtins plus `better-sqlite3`'s
built-in successor `node:sqlite`. It runs independently of Electron: `node collector/dist/index.js`.
A tiny dependency-free script (`scripts/aether-hook-emit.mjs`, sibling to the existing
`scripts/aether-statusline.mjs`) is what Claude Code actually invokes per hook event; it does the
absolute minimum (append one JSON line to a per-session spool file, exit 0, never throw) and defers
all parsing/deriving/schema work to the collector, which polls the spool directory, derives the
signal, writes one row, and deletes the consumed file. See `docs/privacy-and-data.md` §3–§7 — this
plan implements that document, not the older "HTTP receiver" phrasing still in `docs/roadmap.md`'s
Stage 2 table row (correct that row's wording as part of this plan's last task).

**Tech Stack:** TypeScript (strict), `node:sqlite` (`DatabaseSync`), `node:fs`/`node:path`/`node:os`
builtins only — no npm runtime dependencies in `collector/`. Vitest for collector tests (separate
config from the Electron app's). Node.js **22.5+** required to run the collector (`node:sqlite`
stabilized in that range; confirmed working on this box's Node 25.8.2 with no experimental flag).

## Global Constraints

- **No network listener of any kind.** Transport is the file spool described in
  `docs/privacy-and-data.md` §3, not HTTP. This is a binding privacy constraint, not a style choice.
- **Store the signal, not the payload** (`docs/privacy-and-data.md` §4). What lands in SQLite is
  file paths (project-relative, not absolute — §5), tool names, timestamps, small integers and
  booleans. **Never** a raw command string, file contents, tool output, or prompt/message text.
- **A hook must never degrade a real Claude Code session** — this is the single highest-severity
  constraint in the whole roadmap (`docs/roadmap.md` §4.1). `scripts/aether-hook-emit.mjs` must
  never throw, never exit non-zero, never write to stderr, and must have a hard low-ms budget —
  match `scripts/aether-statusline.mjs`'s exact discipline (every fallible step individually
  try/caught, absolute last-resort catch around `main()`).
- **`~/.aether-os/` (including `spool/`) should be user-only permissioned** per
  `docs/privacy-and-data.md` §7 — on Windows this means an explicit ACL, matching the AppContainer
  ACL discipline already documented in this repo's root `CLAUDE.md`. **Known gap, called out
  honestly rather than silently skipped:** neither this plan nor the prior Statusline Feed /
  Optimize Panel stages implement this ACL hardening — both already create files under
  `~/.aether-os/` via plain `mkdirSync(dir, { recursive: true })` with inherited-default
  permissions. This plan does not fix that gap either (it would be a cross-cutting fix touching
  code from two already-shipped stages, not scoped to "collector foundation"); Task 13 records it
  in PROGRESS.md explicitly as unresolved, so it doesn't quietly get forgotten.
- **Retention is a privacy control, decided before the schema ships** (`docs/privacy-and-data.md`
  §6), not an afterthought. This plan proposes a **30-day raw-event retention window with daily
  rollups surviving compaction** — confidence 6/10 on the exact number (no user-stated preference
  exists yet); flagged in Task 3, confirm or adjust before merging that task.
- **Contract drift must be caught loudly, not silently mis-ingested** (`docs/roadmap.md` §4.4) —
  every derived-event write is preceded by a canary check against the hook payload fields this
  collector depends on.
- **A version/schema handshake table ships from day one** (`docs/roadmap.md` §4.5), even though no
  consumer reads it until Stage 3 — the collector owns the schema; the viewer will only ever read.
- **Degradation contract:** Aether OS must remain fully usable with no collector and no hooks
  installed (`docs/roadmap.md` §4.6). Trivially true this stage since the Electron app is untouched,
  but verified explicitly in the last task rather than assumed.
- Follow this repo's established defensive-parsing convention (`src/shared/statuslinePayload.ts`):
  parsers never throw, unknown/malformed shapes degrade to a documented safe fallback, and every
  fallback path has its own test.

---

### Task 1: Scaffold the `collector/` project

**Files:**
- Create: `collector/package.json`
- Create: `collector/tsconfig.json`
- Create: `collector/vitest.config.ts`
- Create: `collector/src/index.ts`
- Create: `collector/README.md`

**Interfaces:**
- Produces: a standalone, independently buildable/testable Node project at `collector/`, with its
  own `npm test` / `npm run build` / `npm start`, entirely separate from the root `package.json`'s
  scripts (which continue to build/test only the Electron app).

- [ ] **Step 1: Create `collector/package.json`**

```json
{
  "name": "aether-collector",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22.5.0" },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "start": "node dist/index.js"
  },
  "devDependencies": {
    "@types/node": "^26.1.1",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `collector/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "composite": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `collector/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create a stub entrypoint `collector/src/index.ts`**

```typescript
console.log('[aether-collector] starting (stub -- Task 8 wires up the real tailer)');
```

- [ ] **Step 5: Create `collector/README.md`**

```markdown
# aether-collector

A standalone, headless Node process that ingests Claude Code hook events into a local SQLite
store. Runs independently of the Aether OS Electron app -- see `docs/roadmap.md` Stage 2 and
`docs/privacy-and-data.md` for the full design rationale.

## Run

```
npm install
npm run build
npm start
```

## Privacy

This process derives a minimal signal from each hook event (file paths, tool names, timestamps,
small counts) and never persists raw command strings, file contents, tool output, or message
text. See `../docs/privacy-and-data.md` for the full policy this process implements.

## Requires

Node.js 22.5 or later (`node:sqlite`).
```

- [ ] **Step 6: Verify the scaffold builds and tests run (zero tests yet)**

Run: `cd collector && npm install && npm run build && npm test`
Expected: build succeeds with no errors; vitest reports "No test files found" (expected — first
real test lands in Task 2) or 0 passed with exit code 0.

- [ ] **Step 7: Commit**

```bash
git add collector/package.json collector/tsconfig.json collector/vitest.config.ts collector/src/index.ts collector/README.md
git commit -m "feat: scaffold the standalone aether-collector project"
```

---

### Task 2: Hook payload types and defensive parser

**Files:**
- Create: `collector/src/hookPayload.ts`
- Create: `collector/src/hookPayload.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export type HookEventName = 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop';

  export interface ParsedHookEvent {
    hookEventName: HookEventName;
    sessionId: string;
    cwd: string | null;
    toolName: string | null;
    // true only when tool_input/tool_response was present and non-empty --
    // never the actual input/output content (privacy-and-data.md §4).
    hadToolInput: boolean;
    hadToolResponse: boolean;
    notificationType: string | null;
    occurredAtMs: number;
  }

  export function parseHookPayload(raw: unknown, receivedAtMs: number): ParsedHookEvent | null;
  ```

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { parseHookPayload } from './hookPayload';

describe('parseHookPayload', () => {
  it('parses a PreToolUse payload, deriving hadToolInput without keeping the input', () => {
    const raw = {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      cwd: 'C:\\Users\\test\\project',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /', foo: 'bar' },
    };
    const result = parseHookPayload(raw, 1000);
    expect(result).toEqual({
      hookEventName: 'PreToolUse',
      sessionId: 'sess-1',
      cwd: 'C:\\Users\\test\\project',
      toolName: 'Bash',
      hadToolInput: true,
      hadToolResponse: false,
      notificationType: null,
      occurredAtMs: 1000,
    });
    expect(JSON.stringify(result)).not.toContain('rm -rf');
  });

  it('parses a PostToolUse payload with a tool_response present', () => {
    const raw = {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-1',
      cwd: null,
      tool_name: 'Read',
      tool_input: { file_path: '/x' },
      tool_response: { content: 'secret file contents' },
    };
    const result = parseHookPayload(raw, 2000);
    expect(result?.hadToolResponse).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret file contents');
  });

  it('parses a Notification payload, keeping only the notification_type enum', () => {
    const raw = {
      hook_event_name: 'Notification',
      session_id: 'sess-2',
      cwd: null,
      notification_type: 'agent_needs_input',
      message: 'the agent is waiting on a decision only the user can make',
    };
    const result = parseHookPayload(raw, 3000);
    expect(result).toEqual({
      hookEventName: 'Notification',
      sessionId: 'sess-2',
      cwd: null,
      toolName: null,
      hadToolInput: false,
      hadToolResponse: false,
      notificationType: 'agent_needs_input',
      occurredAtMs: 3000,
    });
    expect(JSON.stringify(result)).not.toContain('waiting on a decision');
  });

  it('parses a Stop payload with no tool/notification fields', () => {
    const raw = { hook_event_name: 'Stop', session_id: 'sess-3', cwd: null };
    const result = parseHookPayload(raw, 4000);
    expect(result?.hookEventName).toBe('Stop');
    expect(result?.toolName).toBeNull();
  });

  it('returns null for an unrecognized hook_event_name', () => {
    const raw = { hook_event_name: 'SomeFutureEvent', session_id: 'sess-1' };
    expect(parseHookPayload(raw, 1000)).toBeNull();
  });

  it('returns null when session_id is missing or not a string', () => {
    expect(parseHookPayload({ hook_event_name: 'Stop' }, 1000)).toBeNull();
    expect(parseHookPayload({ hook_event_name: 'Stop', session_id: 42 }, 1000)).toBeNull();
  });

  it('returns null for non-object input, null, arrays, and malformed shapes', () => {
    expect(parseHookPayload(null, 1000)).toBeNull();
    expect(parseHookPayload('not an object', 1000)).toBeNull();
    expect(parseHookPayload([1, 2, 3], 1000)).toBeNull();
    expect(parseHookPayload(undefined, 1000)).toBeNull();
  });

  it('defaults cwd/toolName/notificationType to null when absent, not undefined or throwing', () => {
    const raw = { hook_event_name: 'PreToolUse', session_id: 'sess-1', tool_name: 'Edit' };
    const result = parseHookPayload(raw, 5000);
    expect(result?.cwd).toBeNull();
    expect(result?.notificationType).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npx vitest run src/hookPayload.test.ts`
Expected: FAIL — `hookPayload.ts` does not exist yet.

- [ ] **Step 3: Implement the parser**

```typescript
export type HookEventName = 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop';

const KNOWN_EVENT_NAMES: readonly HookEventName[] = ['PreToolUse', 'PostToolUse', 'Notification', 'Stop'];

export interface ParsedHookEvent {
  hookEventName: HookEventName;
  sessionId: string;
  cwd: string | null;
  toolName: string | null;
  hadToolInput: boolean;
  hadToolResponse: boolean;
  notificationType: string | null;
  occurredAtMs: number;
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Parses one raw hook JSON payload (as Claude Code sends it on stdin) into the
 * minimal derived shape this collector persists. Deliberately drops
 * `tool_input`/`tool_response`/`message` content entirely -- only their
 * *presence* is recorded (privacy-and-data.md SS4: store the signal, not the
 * payload). Never throws: any malformed or unrecognized shape returns null,
 * which callers must treat as "skip this line," not an error.
 */
export function parseHookPayload(raw: unknown, receivedAtMs: number): ParsedHookEvent | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const hookEventName = stringField(obj, 'hook_event_name');
  if (hookEventName === null || !KNOWN_EVENT_NAMES.includes(hookEventName as HookEventName)) return null;

  const sessionId = stringField(obj, 'session_id');
  if (sessionId === null) return null;

  return {
    hookEventName: hookEventName as HookEventName,
    sessionId,
    cwd: stringField(obj, 'cwd'),
    toolName: stringField(obj, 'tool_name'),
    hadToolInput: obj.tool_input !== undefined && obj.tool_input !== null,
    hadToolResponse: obj.tool_response !== undefined && obj.tool_response !== null,
    notificationType: stringField(obj, 'notification_type'),
    occurredAtMs: receivedAtMs,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npx vitest run src/hookPayload.test.ts`
Expected: PASS, all 9 tests.

- [ ] **Step 5: Commit**

```bash
git add collector/src/hookPayload.ts collector/src/hookPayload.test.ts
git commit -m "feat: add defensive hook payload parser (signal only, never raw content)"
```

---

### Task 3: Versioned SQLite schema and DB bootstrap

**Files:**
- Create: `collector/src/schema.ts`
- Create: `collector/src/schema.test.ts`

**Interfaces:**
- Consumes: `node:sqlite`'s `DatabaseSync`.
- Produces:
  ```typescript
  export const SCHEMA_VERSION = 1;

  export function openDatabase(dbPath: string): DatabaseSync;
  export function migrate(db: DatabaseSync): void; // idempotent -- safe to call every startup
  export function getSchemaVersion(db: DatabaseSync): number; // Stage 3's viewer reads this
  ```
  Tables created by `migrate`:
  - `schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)` -- holds `('version', '1')`.
  - `events(id INTEGER PRIMARY KEY AUTOINCREMENT, hook_event_name TEXT NOT NULL, session_id TEXT NOT NULL, project_rel_path TEXT, tool_name TEXT, had_tool_input INTEGER NOT NULL, had_tool_response INTEGER NOT NULL, notification_type TEXT, occurred_at_ms INTEGER NOT NULL)`.
  - `daily_rollups(day TEXT NOT NULL, hook_event_name TEXT NOT NULL, tool_name TEXT, event_count INTEGER NOT NULL, PRIMARY KEY (day, hook_event_name, tool_name))` -- populated by Task 5's retention job before raw rows age out.
  - `drift_log(id INTEGER PRIMARY KEY AUTOINCREMENT, detected_at_ms INTEGER NOT NULL, detail TEXT NOT NULL)` -- Task 4's canary writes here.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate, getSchemaVersion, SCHEMA_VERSION } from './schema';

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-schema-'));
  return join(dir, 'test.db');
}

describe('schema', () => {
  it('creates all expected tables and the version row on first migrate', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual(['daily_rollups', 'drift_log', 'events', 'schema_meta']);
    db.close();
  });

  it('migrate is idempotent -- calling it twice does not throw or duplicate the version row', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    migrate(db);
    const rows = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").all();
    expect(rows.length).toBe(1);
    db.close();
  });

  it('events table accepts a full row insert with the documented columns', () => {
    const db = openDatabase(tempDbPath());
    migrate(db);
    db.prepare(
      `INSERT INTO events (hook_event_name, session_id, project_rel_path, tool_name, had_tool_input, had_tool_response, notification_type, occurred_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('PreToolUse', 'sess-1', 'src/index.ts', 'Bash', 1, 0, null, 1000);
    const row: any = db.prepare('SELECT * FROM events').get();
    expect(row.hook_event_name).toBe('PreToolUse');
    expect(row.had_tool_input).toBe(1);
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npx vitest run src/schema.test.ts`
Expected: FAIL — `schema.ts` does not exist yet.

- [ ] **Step 3: Implement the schema module**

```typescript
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 1;

export function openDatabase(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  return new DatabaseSync(dbPath);
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hook_event_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_rel_path TEXT,
      tool_name TEXT,
      had_tool_input INTEGER NOT NULL,
      had_tool_response INTEGER NOT NULL,
      notification_type TEXT,
      occurred_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_rollups (
      day TEXT NOT NULL,
      hook_event_name TEXT NOT NULL,
      tool_name TEXT,
      event_count INTEGER NOT NULL,
      PRIMARY KEY (day, hook_event_name, tool_name)
    );
    CREATE TABLE IF NOT EXISTS drift_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      detected_at_ms INTEGER NOT NULL,
      detail TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(SCHEMA_VERSION));
}

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npx vitest run src/schema.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add collector/src/schema.ts collector/src/schema.test.ts
git commit -m "feat: add versioned SQLite schema (events, daily_rollups, drift_log, schema_meta)"
```

---

### Task 4: Contract-drift canary

**Files:**
- Create: `collector/src/canary.ts`
- Create: `collector/src/canary.test.ts`

**Interfaces:**
- Consumes: raw parsed JSON (the same `unknown` shape `parseHookPayload` receives), `DatabaseSync`
  from Task 3.
- Produces:
  ```typescript
  export function checkForDrift(raw: unknown, db: DatabaseSync, nowMs: number): void;
  ```
  Never throws. Writes one `drift_log` row and does a single loud `console.error` when a known
  `hook_event_name` is present but an expected field for that event type is missing (e.g. a
  `PreToolUse` payload with no `tool_name`) -- a signal that Claude Code's hook payload shape has
  changed since this collector was written. Does **not** duplicate `parseHookPayload`'s null-return
  logic (a wholly unrecognized `hook_event_name` is `parseHookPayload`'s job to reject, not a drift
  event -- drift is specifically "we know this event, but a field we depend on vanished").

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema';
import { checkForDrift } from './canary';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-canary-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return db;
}

describe('checkForDrift', () => {
  it('does not log drift for a well-formed PreToolUse payload', () => {
    const db = freshDb();
    checkForDrift(
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash' },
      db,
      1000
    );
    const rows = db.prepare('SELECT * FROM drift_log').all();
    expect(rows.length).toBe(0);
    db.close();
  });

  it('logs drift when a PreToolUse payload is missing tool_name', () => {
    const db = freshDb();
    checkForDrift({ hook_event_name: 'PreToolUse', session_id: 's1' }, db, 2000);
    const rows: any[] = db.prepare('SELECT * FROM drift_log').all();
    expect(rows.length).toBe(1);
    expect(rows[0].detected_at_ms).toBe(2000);
    expect(rows[0].detail).toContain('PreToolUse');
    expect(rows[0].detail).toContain('tool_name');
    db.close();
  });

  it('logs drift when a Notification payload is missing notification_type', () => {
    const db = freshDb();
    checkForDrift({ hook_event_name: 'Notification', session_id: 's1' }, db, 3000);
    const rows: any[] = db.prepare('SELECT * FROM drift_log').all();
    expect(rows.length).toBe(1);
    expect(rows[0].detail).toContain('notification_type');
    db.close();
  });

  it('does not throw and does not log drift for non-object or unrecognized-event input', () => {
    const db = freshDb();
    expect(() => checkForDrift(null, db, 4000)).not.toThrow();
    expect(() => checkForDrift('not an object', db, 4000)).not.toThrow();
    expect(() => checkForDrift({ hook_event_name: 'FutureEvent' }, db, 4000)).not.toThrow();
    const rows = db.prepare('SELECT * FROM drift_log').all();
    expect(rows.length).toBe(0);
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npx vitest run src/canary.test.ts`
Expected: FAIL — `canary.ts` does not exist yet.

- [ ] **Step 3: Implement the canary**

```typescript
import type { DatabaseSync } from 'node:sqlite';

const REQUIRED_FIELDS_BY_EVENT: Record<string, string[]> = {
  PreToolUse: ['tool_name'],
  PostToolUse: ['tool_name'],
  Notification: ['notification_type'],
  Stop: [],
};

function logDrift(db: DatabaseSync, nowMs: number, detail: string): void {
  console.error(`[aether-collector] contract drift detected: ${detail}`);
  db.prepare('INSERT INTO drift_log (detected_at_ms, detail) VALUES (?, ?)').run(nowMs, detail);
}

/**
 * Checks a raw (unparsed) hook payload against the fields this collector
 * depends on for its KNOWN event types, logging loudly (console.error + a
 * drift_log row) when a known event is missing a field it should have --
 * signals Claude Code's hook payload shape drifted since this was written.
 * Never throws and never blocks ingest; a wholly unrecognized event name is
 * parseHookPayload's concern (silently skipped there), not drift here.
 */
export function checkForDrift(raw: unknown, db: DatabaseSync, nowMs: number): void {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
    const obj = raw as Record<string, unknown>;
    const eventName = typeof obj.hook_event_name === 'string' ? obj.hook_event_name : null;
    if (eventName === null || !(eventName in REQUIRED_FIELDS_BY_EVENT)) return;

    const required = REQUIRED_FIELDS_BY_EVENT[eventName];
    const missing = required.filter((field) => obj[field] === undefined || obj[field] === null);
    if (missing.length > 0) {
      logDrift(db, nowMs, `${eventName} payload missing expected field(s): ${missing.join(', ')}`);
    }
  } catch {
    // Never let a canary bug break ingest.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npx vitest run src/canary.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add collector/src/canary.ts collector/src/canary.test.ts
git commit -m "feat: add contract-drift canary logging to drift_log"
```

---

### Task 5: Retention and daily-rollup compaction

**Files:**
- Create: `collector/src/retention.ts`
- Create: `collector/src/retention.test.ts`

**Interfaces:**
- Consumes: `DatabaseSync` from Task 3.
- Produces:
  ```typescript
  export const RETENTION_WINDOW_MS: number; // 30 days -- confidence 6/10, confirm with user

  export function compact(db: DatabaseSync, nowMs: number): { rolledUpDays: number; deletedRows: number };
  ```
  For every distinct day (UTC `YYYY-MM-DD` of `occurred_at_ms`) older than the retention window:
  upserts one `daily_rollups` row per `(day, hook_event_name, tool_name)` with the count of matching
  `events` rows, then deletes those raw `events` rows. Days within the window are untouched. Safe to
  call repeatedly (already-rolled-up days re-aggregate to the same counts, then find zero raw rows
  left to delete).

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema';
import { compact, RETENTION_WINDOW_MS } from './retention';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-retention-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return db;
}

function insertEvent(db: any, occurredAtMs: number, toolName: string) {
  db.prepare(
    `INSERT INTO events (hook_event_name, session_id, project_rel_path, tool_name, had_tool_input, had_tool_response, notification_type, occurred_at_ms)
     VALUES ('PreToolUse', 's1', NULL, ?, 1, 0, NULL, ?)`
  ).run(toolName, occurredAtMs);
}

describe('compact', () => {
  it('rolls up and deletes rows older than the retention window, leaving recent rows untouched', () => {
    const db = freshDb();
    const now = Date.parse('2026-08-01T00:00:00Z');
    const oldDay = Date.parse('2026-06-01T10:00:00Z'); // well past 30 days
    const recentDay = now - 60_000; // 1 minute ago

    insertEvent(db, oldDay, 'Bash');
    insertEvent(db, oldDay, 'Bash');
    insertEvent(db, oldDay, 'Read');
    insertEvent(db, recentDay, 'Bash');

    const result = compact(db, now);
    expect(result.rolledUpDays).toBe(1);
    expect(result.deletedRows).toBe(3);

    const remaining = db.prepare('SELECT COUNT(*) as c FROM events').get() as any;
    expect(remaining.c).toBe(1); // only the recent row survives

    const rollups = db.prepare('SELECT * FROM daily_rollups ORDER BY tool_name').all() as any[];
    expect(rollups).toEqual([
      { day: '2026-06-01', hook_event_name: 'PreToolUse', tool_name: 'Bash', event_count: 2 },
      { day: '2026-06-01', hook_event_name: 'PreToolUse', tool_name: 'Read', event_count: 1 },
    ]);
    db.close();
  });

  it('is idempotent -- calling compact twice does not duplicate or change rollup counts', () => {
    const db = freshDb();
    const now = Date.parse('2026-08-01T00:00:00Z');
    const oldDay = Date.parse('2026-06-01T10:00:00Z');
    insertEvent(db, oldDay, 'Bash');

    compact(db, now);
    const second = compact(db, now);
    expect(second.rolledUpDays).toBe(0); // nothing left to roll up
    expect(second.deletedRows).toBe(0);

    const rollups = db.prepare('SELECT event_count FROM daily_rollups').all() as any[];
    expect(rollups).toEqual([{ event_count: 1 }]);
    db.close();
  });

  it('leaves a day with no events past the window untouched (no rollup row, nothing to delete)', () => {
    const db = freshDb();
    const now = Date.parse('2026-08-01T00:00:00Z');
    const result = compact(db, now);
    expect(result).toEqual({ rolledUpDays: 0, deletedRows: 0 });
    db.close();
  });

  it('RETENTION_WINDOW_MS is exactly 30 days', () => {
    expect(RETENTION_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npx vitest run src/retention.test.ts`
Expected: FAIL — `retention.ts` does not exist yet.

- [ ] **Step 3: Implement the retention/compaction module**

```typescript
import type { DatabaseSync } from 'node:sqlite';

export const RETENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function dayKeyUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Rolls up and deletes raw `events` rows older than RETENTION_WINDOW_MS,
 * grouped by UTC day/hook_event_name/tool_name. Aggregate counts survive in
 * `daily_rollups`; the underlying rows do not (privacy-and-data.md SS6).
 * Idempotent: re-running finds nothing left to delete for an already-rolled-up
 * day and leaves its rollup row's count unchanged.
 */
export function compact(db: DatabaseSync, nowMs: number): { rolledUpDays: number; deletedRows: number } {
  const cutoffMs = nowMs - RETENTION_WINDOW_MS;

  const staleRows = db
    .prepare('SELECT id, hook_event_name, tool_name, occurred_at_ms FROM events WHERE occurred_at_ms < ?')
    .all(cutoffMs) as { id: number; hook_event_name: string; tool_name: string | null; occurred_at_ms: number }[];

  if (staleRows.length === 0) {
    return { rolledUpDays: 0, deletedRows: 0 };
  }

  const groups = new Map<string, { day: string; hookEventName: string; toolName: string | null; count: number }>();
  for (const row of staleRows) {
    const day = dayKeyUtc(row.occurred_at_ms);
    const key = `${day}\u0000${row.hook_event_name}\u0000${row.tool_name ?? ''}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(key, { day, hookEventName: row.hook_event_name, toolName: row.tool_name, count: 1 });
    }
  }

  const upsert = db.prepare(
    `INSERT INTO daily_rollups (day, hook_event_name, tool_name, event_count) VALUES (?, ?, ?, ?)
     ON CONFLICT(day, hook_event_name, tool_name) DO UPDATE SET event_count = event_count + excluded.event_count`
  );
  for (const g of groups.values()) {
    upsert.run(g.day, g.hookEventName, g.toolName, g.count);
  }

  const deleteStale = db.prepare('DELETE FROM events WHERE occurred_at_ms < ?');
  deleteStale.run(cutoffMs);

  const distinctDays = new Set(Array.from(groups.values()).map((g) => g.day));
  return { rolledUpDays: distinctDays.size, deletedRows: staleRows.length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npx vitest run src/retention.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add collector/src/retention.ts collector/src/retention.test.ts
git commit -m "feat: add 30-day retention with daily-rollup compaction before raw-row deletion"
```

---

### Task 6: Ingest pipeline (spool line → derived event row)

**Files:**
- Create: `collector/src/ingest.ts`
- Create: `collector/src/ingest.test.ts`

**Interfaces:**
- Consumes: `parseHookPayload` (Task 2), `checkForDrift` (Task 4), `DatabaseSync` (Task 3).
- Produces:
  ```typescript
  export function ingestLine(db: DatabaseSync, rawLine: string, receivedAtMs: number): boolean;
  // Returns true if a row was inserted, false if the line was unparseable/skipped (never throws).
  ```
  Order of operations per line: `JSON.parse` (malformed JSON -> return false, no drift check
  possible); run `checkForDrift` against the parsed object regardless of whether `parseHookPayload`
  later accepts it (drift detection must see payloads `parseHookPayload` would also reject, since a
  totally-unrecognized-but-still-JSON-object payload is itself a signal); then `parseHookPayload` --
  null -> return false; otherwise insert one `events` row and return true. `cwd` is stored as-is for
  this stage (project-relative path derivation is Stage 3's job, once the viewer's existing
  `cwdToProjectDirName`-style helpers are available to the collector -- noted as a follow-up, not
  silently done wrong here).

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema';
import { ingestLine } from './ingest';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-ingest-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return db;
}

describe('ingestLine', () => {
  it('inserts one events row for a valid PreToolUse line and returns true', () => {
    const db = freshDb();
    const line = JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      cwd: '/proj',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    const inserted = ingestLine(db, line, 1000);
    expect(inserted).toBe(true);
    const row: any = db.prepare('SELECT * FROM events').get();
    expect(row.tool_name).toBe('Bash');
    expect(row.had_tool_input).toBe(1);
    expect(JSON.stringify(row)).not.toContain('ls');
    db.close();
  });

  it('returns false and inserts nothing for malformed JSON', () => {
    const db = freshDb();
    const inserted = ingestLine(db, 'not json{{', 1000);
    expect(inserted).toBe(false);
    const count: any = db.prepare('SELECT COUNT(*) as c FROM events').get();
    expect(count.c).toBe(0);
    db.close();
  });

  it('returns false for a well-formed JSON line with an unrecognized hook_event_name', () => {
    const db = freshDb();
    const line = JSON.stringify({ hook_event_name: 'FutureEvent', session_id: 's1' });
    expect(ingestLine(db, line, 1000)).toBe(false);
    db.close();
  });

  it('logs drift for a known event missing a required field, but still returns false (not ingested)', () => {
    const db = freshDb();
    const line = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1' }); // no tool_name
    const inserted = ingestLine(db, line, 1000);
    expect(inserted).toBe(false);
    const drift: any = db.prepare('SELECT COUNT(*) as c FROM drift_log').get();
    expect(drift.c).toBe(1);
    db.close();
  });

  it('never throws on an empty string line', () => {
    const db = freshDb();
    expect(() => ingestLine(db, '', 1000)).not.toThrow();
    expect(ingestLine(db, '', 1000)).toBe(false);
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npx vitest run src/ingest.test.ts`
Expected: FAIL — `ingest.ts` does not exist yet.

- [ ] **Step 3: Implement the ingest pipeline**

```typescript
import type { DatabaseSync } from 'node:sqlite';
import { parseHookPayload } from './hookPayload';
import { checkForDrift } from './canary';

/**
 * Ingests one raw spool line: parses JSON, runs the drift canary against
 * whatever parsed regardless of outcome, then parses into the derived shape
 * and inserts one events row. Never throws -- any failure at any stage simply
 * skips the line (returns false), since a single corrupt line must never stop
 * the tailer from processing the rest of the spool.
 */
export function ingestLine(db: DatabaseSync, rawLine: string, receivedAtMs: number): boolean {
  let parsed: unknown;
  try {
    if (rawLine.trim().length === 0) return false;
    parsed = JSON.parse(rawLine);
  } catch {
    return false;
  }

  try {
    checkForDrift(parsed, db, receivedAtMs);
  } catch {
    // checkForDrift already guards itself; this is a final backstop.
  }

  const event = parseHookPayload(parsed, receivedAtMs);
  if (event === null) return false;

  try {
    db.prepare(
      `INSERT INTO events (hook_event_name, session_id, project_rel_path, tool_name, had_tool_input, had_tool_response, notification_type, occurred_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.hookEventName,
      event.sessionId,
      event.cwd,
      event.toolName,
      event.hadToolInput ? 1 : 0,
      event.hadToolResponse ? 1 : 0,
      event.notificationType,
      event.occurredAtMs
    );
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npx vitest run src/ingest.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add collector/src/ingest.ts collector/src/ingest.test.ts
git commit -m "feat: add spool-line ingest pipeline (parse, canary, derive, insert)"
```

---

### Task 7: Spool directory tailer

**Files:**
- Create: `collector/src/spoolTailer.ts`
- Create: `collector/src/spoolTailer.test.ts`

**Interfaces:**
- Consumes: `ingestLine` (Task 6), `DatabaseSync` (Task 3).
- Produces:
  ```typescript
  export function tailSpoolOnce(db: DatabaseSync, spoolDir: string, nowMs: number): { filesProcessed: number; linesIngested: number };
  export function startSpoolTailer(db: DatabaseSync, spoolDir: string, intervalMs: number): () => void;
  ```
  `tailSpoolOnce` scans `spoolDir` for `*.jsonl` files, reads each fully, splits into lines,
  `ingestLine`s each, then **deletes** the file (not truncates -- privacy-and-data.md §7: spool
  files must not accumulate as a second copy of the data once consumed). A read error on one file
  (e.g. a concurrent write mid-append) skips that file for this pass rather than throwing --
  it will be picked up whole on the next poll once the writer has finished appending.
  `startSpoolTailer` wraps `tailSpoolOnce` in a `setInterval` poll (matching this repo's established
  `fs.watchFile`-over-`fs.watch` preference for reliability across platforms -- a plain interval poll
  over a directory listing is the same idea, simpler, and this process has no renderer to keep
  in sync with sub-second latency) and returns a stop function.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema';
import { tailSpoolOnce } from './spoolTailer';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-tailer-db-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return db;
}

function freshSpoolDir(): string {
  return mkdtempSync(join(tmpdir(), 'aether-collector-tailer-spool-'));
}

describe('tailSpoolOnce', () => {
  it('ingests every line in every .jsonl file and deletes each file after processing', () => {
    const db = freshDb();
    const spoolDir = freshSpoolDir();
    const line1 = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash' });
    const line2 = JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' });
    const file1 = join(spoolDir, 's1.jsonl');
    writeFileSync(file1, `${line1}\n${line2}\n`, 'utf8');

    const result = tailSpoolOnce(db, spoolDir, 1000);
    expect(result).toEqual({ filesProcessed: 1, linesIngested: 2 });
    expect(existsSync(file1)).toBe(false);

    const count: any = db.prepare('SELECT COUNT(*) as c FROM events').get();
    expect(count.c).toBe(2);
    db.close();
  });

  it('ignores non-.jsonl files in the spool directory', () => {
    const db = freshDb();
    const spoolDir = freshSpoolDir();
    writeFileSync(join(spoolDir, 'notes.txt'), 'irrelevant', 'utf8');

    const result = tailSpoolOnce(db, spoolDir, 1000);
    expect(result).toEqual({ filesProcessed: 0, linesIngested: 0 });
    expect(existsSync(join(spoolDir, 'notes.txt'))).toBe(true);
    db.close();
  });

  it('returns zero counts and does not throw when the spool directory does not exist', () => {
    const db = freshDb();
    const missingDir = join(tmpdir(), 'aether-collector-does-not-exist-' + Date.now());
    expect(() => tailSpoolOnce(db, missingDir, 1000)).not.toThrow();
    expect(tailSpoolOnce(db, missingDir, 1000)).toEqual({ filesProcessed: 0, linesIngested: 0 });
    db.close();
  });

  it('skips blank lines within a file without counting them as ingested', () => {
    const db = freshDb();
    const spoolDir = freshSpoolDir();
    const line = JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' });
    writeFileSync(join(spoolDir, 's1.jsonl'), `\n${line}\n\n`, 'utf8');

    const result = tailSpoolOnce(db, spoolDir, 1000);
    expect(result.linesIngested).toBe(1);
    db.close();
  });

  it('processes multiple spool files in one pass', () => {
    const db = freshDb();
    const spoolDir = freshSpoolDir();
    writeFileSync(join(spoolDir, 's1.jsonl'), JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }) + '\n', 'utf8');
    writeFileSync(join(spoolDir, 's2.jsonl'), JSON.stringify({ hook_event_name: 'Stop', session_id: 's2' }) + '\n', 'utf8');

    const result = tailSpoolOnce(db, spoolDir, 1000);
    expect(result).toEqual({ filesProcessed: 2, linesIngested: 2 });
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npx vitest run src/spoolTailer.test.ts`
Expected: FAIL — `spoolTailer.ts` does not exist yet.

- [ ] **Step 3: Implement the tailer**

```typescript
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ingestLine } from './ingest';

export function tailSpoolOnce(
  db: DatabaseSync,
  spoolDir: string,
  nowMs: number
): { filesProcessed: number; linesIngested: number } {
  let entries: string[];
  try {
    entries = readdirSync(spoolDir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return { filesProcessed: 0, linesIngested: 0 };
  }

  let filesProcessed = 0;
  let linesIngested = 0;

  for (const name of entries) {
    const filePath = join(spoolDir, name);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      // Racing an in-progress append -- leave the file for the next poll.
      continue;
    }

    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    for (const line of lines) {
      if (ingestLine(db, line, nowMs)) linesIngested += 1;
    }
    filesProcessed += 1;

    try {
      rmSync(filePath, { force: true });
    } catch {
      // If deletion fails, the file's lines get re-ingested next pass -- an
      // events row is not unique-constrained on content, so a rare duplicate
      // insert here is a strictly safer failure mode than losing the file
      // (and its consumption) silently.
    }
  }

  return { filesProcessed, linesIngested };
}

export function startSpoolTailer(db: DatabaseSync, spoolDir: string, intervalMs: number): () => void {
  const timer = setInterval(() => tailSpoolOnce(db, spoolDir, Date.now()), intervalMs);
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npx vitest run src/spoolTailer.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add collector/src/spoolTailer.ts collector/src/spoolTailer.test.ts
git commit -m "feat: add spool directory tailer (ingest then delete consumed files)"
```

---

### Task 8: Collector entrypoint (wires schema + tailer + graceful shutdown)

**Files:**
- Modify: `collector/src/index.ts`
- Create: `collector/src/index.test.ts`

**Interfaces:**
- Consumes: `openDatabase`/`migrate` (Task 3), `startSpoolTailer` (Task 7), `compact` (Task 5).
- Produces:
  ```typescript
  export function startCollector(options: { dbPath: string; spoolDir: string; tailIntervalMs: number; compactIntervalMs: number }): () => void;
  ```
  Opens/migrates the DB, starts the spool tailer, and runs `compact` on its own interval (separate
  from the tail interval -- compaction is cheap but need not run every tail tick). Returns a single
  stop function that tears down both intervals and closes the DB. `index.ts`'s module-level code
  calls `startCollector` with real paths (`~/.aether-os/collector.db`, `~/.aether-os/spool/`) and
  registers `SIGINT`/`SIGTERM` handlers that call the returned stop function then `process.exit(0)`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startCollector } from './index';
import { openDatabase } from './schema';

describe('startCollector', () => {
  it('picks up a pre-existing spool file, ingests it, and the DB file exists on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-collector-e2e-'));
    const spoolDir = join(dir, 'spool');
    const dbPath = join(dir, 'collector.db');
    require('fs').mkdirSync(spoolDir, { recursive: true });
    writeFileSync(
      join(spoolDir, 's1.jsonl'),
      JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }) + '\n',
      'utf8'
    );

    const stop = startCollector({ dbPath, spoolDir, tailIntervalMs: 20, compactIntervalMs: 100000 });
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the first tick fire

    expect(existsSync(dbPath)).toBe(true);
    const db = openDatabase(dbPath);
    const count: any = db.prepare('SELECT COUNT(*) as c FROM events').get();
    expect(count.c).toBe(1);
    db.close();
    stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd collector && npx vitest run src/index.test.ts`
Expected: FAIL — `startCollector` is not exported yet.

- [ ] **Step 3: Implement `startCollector` and wire the real entrypoint**

```typescript
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDatabase, migrate } from './schema';
import { startSpoolTailer } from './spoolTailer';
import { compact } from './retention';

export function startCollector(options: {
  dbPath: string;
  spoolDir: string;
  tailIntervalMs: number;
  compactIntervalMs: number;
}): () => void {
  const db = openDatabase(options.dbPath);
  migrate(db);

  const stopTailer = startSpoolTailer(db, options.spoolDir, options.tailIntervalMs);
  const compactTimer = setInterval(() => compact(db, Date.now()), options.compactIntervalMs);

  return () => {
    stopTailer();
    clearInterval(compactTimer);
    db.close();
  };
}

// Only run the real process wiring when this module is the actual entrypoint
// (not when imported by index.test.ts), so tests can import startCollector
// without a second background process spinning up alongside the test's own.
const isMainModule = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts');
if (isMainModule) {
  const aetherDir = join(homedir(), '.aether-os');
  const stop = startCollector({
    dbPath: join(aetherDir, 'collector.db'),
    spoolDir: join(aetherDir, 'spool'),
    tailIntervalMs: 2000,
    compactIntervalMs: 60 * 60 * 1000, // hourly
  });

  console.log('[aether-collector] running');

  const shutdown = () => {
    console.log('[aether-collector] shutting down');
    stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd collector && npx vitest run src/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Manually verify the real entrypoint runs end-to-end**

Run:
```bash
cd collector
npm run build
mkdir -p /tmp/aether-manual-test/spool
echo '{"hook_event_name":"Stop","session_id":"manual-1"}' > /tmp/aether-manual-test/spool/manual.jsonl
HOME=/tmp/aether-manual-test node dist/index.js &
sleep 3
kill %1
```
Expected: console prints `[aether-collector] running`, the spool file at
`/tmp/aether-manual-test/spool/manual.jsonl` is gone after ~2s, and
`/tmp/aether-manual-test/.aether-os/collector.db` exists. (On Windows, run the equivalent with
`$env:HOME` or simply point `dbPath`/`spoolDir` at a temp folder manually for this one manual check.)

- [ ] **Step 6: Commit**

```bash
git add collector/src/index.ts collector/src/index.test.ts
git commit -m "feat: wire collector entrypoint (schema + tailer + hourly compaction + graceful shutdown)"
```

---

### Task 9: Dependency-free hook-emit script

**Files:**
- Create: `scripts/aether-hook-emit.mjs`
- Create: `scripts/aether-hook-emit.test.ts`

**Interfaces:**
- Produces: a standalone script, installed as the `command` for each hook event this plan registers
  (`PreToolUse`, `PostToolUse`, `Notification`, `Stop`). Reads the hook JSON Claude Code passes on
  stdin, appends it as one line to `~/.aether-os/spool/<session_id>.jsonl` (falling back to
  `unknown-session.jsonl` if `session_id` is missing/malformed, so a payload is never silently
  dropped), and **always** exits 0. Mirrors `scripts/aether-statusline.mjs`'s exact hard-requirement
  discipline verbatim -- this script has the same "never degrade a real session" stakes.

- [ ] **Step 1: Write the failing tests (spawns the script as a real subprocess)**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const scriptPath = fileURLToPath(new URL('./aether-hook-emit.mjs', import.meta.url));

function runScript(stdin: string, homeDir: string) {
  return spawnSync('node', [scriptPath], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
  });
}

describe('aether-hook-emit.mjs', () => {
  it('appends the raw stdin line to the session spool file and exits 0', () => {
    const home = mkdtempSync(join(tmpdir(), 'aether-hook-emit-'));
    const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-abc' });
    const result = runScript(payload, home);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const spoolFile = join(home, '.aether-os', 'spool', 'sess-abc.jsonl');
    expect(existsSync(spoolFile)).toBe(true);
    expect(readFileSync(spoolFile, 'utf8')).toBe(payload + '\n');
  });

  it('appends a second event to the SAME session file rather than overwriting', () => {
    const home = mkdtempSync(join(tmpdir(), 'aether-hook-emit-'));
    const p1 = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sess-xyz', tool_name: 'Bash' });
    const p2 = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'sess-xyz', tool_name: 'Bash' });
    runScript(p1, home);
    runScript(p2, home);

    const spoolFile = join(home, '.aether-os', 'spool', 'sess-xyz.jsonl');
    expect(readFileSync(spoolFile, 'utf8')).toBe(p1 + '\n' + p2 + '\n');
  });

  it('exits 0 with no stderr on malformed JSON stdin, and still writes to a fallback file', () => {
    const home = mkdtempSync(join(tmpdir(), 'aether-hook-emit-'));
    const result = runScript('not json{{', home);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const fallback = join(home, '.aether-os', 'spool', 'unknown-session.jsonl');
    expect(existsSync(fallback)).toBe(true);
  });

  it('exits 0 with no stderr on completely empty stdin', () => {
    const home = mkdtempSync(join(tmpdir(), 'aether-hook-emit-'));
    const result = runScript('', home);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('falls back to unknown-session.jsonl when session_id is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'aether-hook-emit-'));
    const payload = JSON.stringify({ hook_event_name: 'Stop' });
    runScript(payload, home);
    const fallback = join(home, '.aether-os', 'spool', 'unknown-session.jsonl');
    expect(existsSync(fallback)).toBe(true);
  });
});
```

- [ ] **Step 2: Update `collector/vitest.config.ts` to also pick up the colocated script test, then run it to see it fail**

This test file lives under `scripts/` alongside the script it tests (matching this repo's convention
of colocating a script with its test), so `collector/vitest.config.ts`'s `include` array needs a
second pattern:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', '../scripts/**/*.test.ts'],
  },
});
```

Run: `cd collector && npx vitest run ../scripts/aether-hook-emit.test.ts`
Expected: FAIL — `aether-hook-emit.mjs` does not exist yet.

- [ ] **Step 3: Implement the script**

```javascript
#!/usr/bin/env node
// Aether OS hook event emitter.
//
// Installed as the `command` for PreToolUse/PostToolUse/Notification/Stop hooks
// (collector/src/hookInstaller.ts wires this up). Claude Code invokes this on
// every matching event, passing a JSON payload on stdin.
//
// HARD REQUIREMENT: this must never throw, never exit non-zero, and never write
// to stderr, under any input whatsoever -- a bug here degrades the user's live
// coding session, not just this app. Mirrors aether-statusline.mjs's exact
// discipline: every fallible step individually guarded, one last-resort catch
// around main().
//
// Node builtins only -- no imports from src/ or electron/ or collector/, and no
// npm dependencies. Executed by Claude Code from an arbitrary working directory.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';

const FALLBACK_SESSION_FILE = 'unknown-session';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function extractSessionId(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.session_id === 'string' && parsed.session_id.length > 0) {
      return parsed.session_id;
    }
  } catch {
    // Malformed JSON -- fall through to the fallback file below.
  }
  return FALLBACK_SESSION_FILE;
}

function appendToSpool(sessionId, rawLine) {
  try {
    const spoolDir = join(homedir(), '.aether-os', 'spool');
    mkdirSync(spoolDir, { recursive: true });
    const spoolFile = join(spoolDir, `${sessionId}.jsonl`);
    // A single appendFileSync call is not cross-process-atomic against another
    // concurrent writer to the SAME session file, but Claude Code invokes hooks
    // for one session serially (never two hook processes for the same
    // session_id at once), so this is safe in practice -- unlike the
    // statusline script's single shared target file, each session has its own.
    appendFileSync(spoolFile, rawLine.trimEnd() + '\n', 'utf8');
  } catch {
    // Intentionally swallowed: a spool-write failure must never surface to
    // Claude Code as a hook error. The event is simply lost this one time.
  }
}

function main() {
  const raw = readStdin();
  if (raw.trim().length === 0) return; // nothing to append

  const sessionId = extractSessionId(raw);
  appendToSpool(sessionId, raw);
}

try {
  main();
} catch {
  // Absolute last resort: something above threw despite every internal guard.
  // Still must never throw uncaught or exit non-zero.
}

// No explicit process.exit(0): nothing async is pending after main() returns,
// so the process exits 0 on its own, same reasoning as aether-statusline.mjs.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npx vitest run ../scripts/aether-hook-emit.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/aether-hook-emit.mjs scripts/aether-hook-emit.test.ts collector/vitest.config.ts
git commit -m "feat: add dependency-free hook-emit script (append raw payload to session spool)"
```

---

### Task 10: Hook installer (settings.json `hooks` merge, non-destructive)

**Files:**
- Create: `collector/src/hookInstaller.ts`
- Create: `collector/src/hookInstaller.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export const MANAGED_HOOK_EVENTS: readonly string[]; // ['PreToolUse', 'PostToolUse', 'Notification', 'Stop']

  export interface HookInstallState {
    installedEvents: string[]; // which of MANAGED_HOOK_EVENTS already have our entry
    settingsPath: string;
    scriptPath: string;
  }

  export function readHookInstallState(settingsPath: string, scriptPath: string): Promise<HookInstallState>;
  export function installHooks(settingsPath: string, scriptPath: string): Promise<{ ok: boolean; backupPath?: string | null; error?: string }>;
  export function uninstallHooks(settingsPath: string): Promise<{ ok: boolean; backupPath?: string | null; error?: string }>;
  ```
  Unlike `electron/statuslineInstaller.ts` (which owns and replaces the entire `statusLine` key),
  this installer must be **additive and non-destructive**: `settings.json`'s `hooks` object commonly
  already has unrelated entries (this very repo's own dev machine has `SessionStart`/`Stop` hooks
  for `agent-learn`/`daily-triage`) for events this plan also manages (`Stop`). Install must append
  our own hook object into each managed event's array without touching any other entry already
  there; uninstall must remove only the entry whose `command` contains our `scriptPath`, leaving
  every other hook (for that event or any other) completely untouched.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readHookInstallState, installHooks, uninstallHooks, MANAGED_HOOK_EVENTS } from './hookInstaller';

const SCRIPT_PATH = 'C:\\Users\\test\\.aether-os\\aether-hook-emit.mjs';

function tempSettingsPath(initialContent?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-hookinstaller-'));
  const p = join(dir, 'settings.json');
  if (initialContent !== undefined) writeFileSync(p, initialContent, 'utf8');
  return p;
}

describe('hookInstaller', () => {
  it('readHookInstallState reports no managed events installed when settings.json does not exist', async () => {
    const settingsPath = tempSettingsPath();
    const state = await readHookInstallState(settingsPath, SCRIPT_PATH);
    expect(state.installedEvents).toEqual([]);
  });

  it('installHooks adds an entry to every managed event, creating the hooks object if absent', async () => {
    const settingsPath = tempSettingsPath('{}');
    const result = await installHooks(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(true);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    for (const eventName of MANAGED_HOOK_EVENTS) {
      expect(written.hooks[eventName]).toHaveLength(1);
      expect(written.hooks[eventName][0].hooks[0].command).toContain(SCRIPT_PATH);
    }
  });

  it('installHooks preserves an existing unrelated hook entry for a managed event', async () => {
    const existing = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'powershell -File some-other-script.ps1' }] }],
      },
    };
    const settingsPath = tempSettingsPath(JSON.stringify(existing));
    await installHooks(settingsPath, SCRIPT_PATH);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.Stop).toHaveLength(2);
    expect(written.hooks.Stop[0].hooks[0].command).toContain('some-other-script.ps1');
    expect(written.hooks.Stop[1].hooks[0].command).toContain(SCRIPT_PATH);
  });

  it('installHooks is idempotent -- installing twice does not duplicate our own entry', async () => {
    const settingsPath = tempSettingsPath('{}');
    await installHooks(settingsPath, SCRIPT_PATH);
    await installHooks(settingsPath, SCRIPT_PATH);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.Stop).toHaveLength(1);
  });

  it('readHookInstallState reports all managed events installed after installHooks', async () => {
    const settingsPath = tempSettingsPath('{}');
    await installHooks(settingsPath, SCRIPT_PATH);
    const state = await readHookInstallState(settingsPath, SCRIPT_PATH);
    expect(state.installedEvents.sort()).toEqual([...MANAGED_HOOK_EVENTS].sort());
  });

  it('uninstallHooks removes only our own entry, leaving an unrelated Stop hook intact', async () => {
    const existing = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'powershell -File some-other-script.ps1' }] }],
      },
    };
    const settingsPath = tempSettingsPath(JSON.stringify(existing));
    await installHooks(settingsPath, SCRIPT_PATH);
    const result = await uninstallHooks(settingsPath);
    expect(result.ok).toBe(true);

    const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.Stop).toHaveLength(1);
    expect(written.hooks.Stop[0].hooks[0].command).toContain('some-other-script.ps1');
  });

  it('uninstallHooks writes a timestamped backup before modifying settings.json', async () => {
    const settingsPath = tempSettingsPath('{}');
    await installHooks(settingsPath, SCRIPT_PATH);
    const result = await uninstallHooks(settingsPath);
    expect(result.backupPath).toBeTruthy();
    expect(readFileSync(result.backupPath!, 'utf8')).toContain(SCRIPT_PATH);
  });

  it('refuses to overwrite an unparseable settings.json', async () => {
    const settingsPath = tempSettingsPath('not valid json {{');
    const result = await installHooks(settingsPath, SCRIPT_PATH);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npx vitest run src/hookInstaller.test.ts`
Expected: FAIL — `hookInstaller.ts` does not exist yet.

- [ ] **Step 3: Implement the hook installer**

```typescript
import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';

export const MANAGED_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'Notification', 'Stop'] as const;

export interface HookInstallState {
  installedEvents: string[];
  settingsPath: string;
  scriptPath: string;
}

interface HookGroup {
  hooks?: { type?: string; command?: string }[];
}

function isOurGroup(group: unknown, scriptPath: string): boolean {
  if (typeof group !== 'object' || group === null) return false;
  const hooks = (group as HookGroup).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h) => typeof h?.command === 'string' && h.command.includes(scriptPath));
}

function ourGroup(scriptPath: string): HookGroup {
  return { hooks: [{ type: 'command', command: `node "${scriptPath}"` }] };
}

async function readSettings(
  settingsPath: string
): Promise<
  | { ok: true; fileExisted: boolean; raw: string; parsed: Record<string, unknown> }
  | { ok: false; error: string }
> {
  let raw = '';
  let fileExisted = true;
  try {
    raw = await fsp.readFile(settingsPath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { ok: true, fileExisted: false, raw: '', parsed: {} };
    return { ok: false, error: err?.message ?? String(err) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'existing settings.json is not a JSON object; refusing to overwrite' };
    }
    return { ok: true, fileExisted, raw, parsed: parsed as Record<string, unknown> };
  } catch (err: any) {
    return { ok: false, error: `could not parse existing settings.json: ${err?.message ?? String(err)}` };
  }
}

async function writeBackup(settingsPath: string, raw: string): Promise<string> {
  const backupPath = `${settingsPath}.aetherbak-${Date.now()}`;
  await fsp.writeFile(backupPath, raw, 'utf8');
  return backupPath;
}

async function writeSettingsAtomically(settingsPath: string, content: string): Promise<void> {
  const tmpPath = `${settingsPath}.aethertmp-${Date.now()}`;
  await fsp.writeFile(tmpPath, content, 'utf8');
  await fsp.rename(tmpPath, settingsPath);
}

export async function readHookInstallState(settingsPath: string, scriptPath: string): Promise<HookInstallState> {
  const result = await readSettings(settingsPath);
  const installedEvents: string[] = [];
  if (result.ok) {
    const hooks = (result.parsed.hooks && typeof result.parsed.hooks === 'object' ? result.parsed.hooks : {}) as Record<
      string,
      unknown
    >;
    for (const eventName of MANAGED_HOOK_EVENTS) {
      const groups = hooks[eventName];
      if (Array.isArray(groups) && groups.some((g) => isOurGroup(g, scriptPath))) {
        installedEvents.push(eventName);
      }
    }
  }
  return { installedEvents, settingsPath, scriptPath };
}

export async function installHooks(
  settingsPath: string,
  scriptPath: string
): Promise<{ ok: boolean; backupPath?: string | null; error?: string }> {
  const result = await readSettings(settingsPath);
  if (!result.ok) return { ok: false, error: result.error };
  const { fileExisted, raw, parsed } = result;

  try {
    let backupPath: string | null = null;
    if (fileExisted) backupPath = await writeBackup(settingsPath, raw);

    const hooks = (parsed.hooks && typeof parsed.hooks === 'object' ? { ...(parsed.hooks as Record<string, unknown>) } : {}) as Record<
      string,
      unknown[]
    >;
    for (const eventName of MANAGED_HOOK_EVENTS) {
      const existingGroups = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
      const alreadyInstalled = existingGroups.some((g) => isOurGroup(g, scriptPath));
      hooks[eventName] = alreadyInstalled ? existingGroups : [...existingGroups, ourGroup(scriptPath)];
    }

    const merged = { ...parsed, hooks };
    await fsp.mkdir(dirname(settingsPath), { recursive: true });
    await writeSettingsAtomically(settingsPath, JSON.stringify(merged, null, 2));
    return { ok: true, backupPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function uninstallHooks(
  settingsPath: string
): Promise<{ ok: boolean; backupPath?: string | null; error?: string }> {
  const result = await readSettings(settingsPath);
  if (!result.ok) return { ok: false, error: result.error };
  const { fileExisted, raw, parsed } = result;

  if (!fileExisted || typeof parsed.hooks !== 'object' || parsed.hooks === null) {
    return { ok: true, backupPath: null };
  }

  try {
    const backupPath = await writeBackup(settingsPath, raw);
    const hooks = { ...(parsed.hooks as Record<string, unknown[]>) };
    // scriptPath is not known at uninstall time in general (the caller may not
    // have it handy) -- but every MANAGED_HOOK_EVENTS entry we would have added
    // has a command containing the literal substring "aether-hook-emit.mjs",
    // which is a stable, sufficiently specific marker for "ours" without
    // requiring the caller to pass scriptPath through this call.
    for (const eventName of MANAGED_HOOK_EVENTS) {
      const groups = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
      const filtered = groups.filter((g) => !isOurGroup(g, 'aether-hook-emit.mjs'));
      if (filtered.length > 0) {
        hooks[eventName] = filtered;
      } else {
        delete hooks[eventName];
      }
    }

    const merged = { ...parsed, hooks };
    await writeSettingsAtomically(settingsPath, JSON.stringify(merged, null, 2));
    return { ok: true, backupPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npx vitest run src/hookInstaller.test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add collector/src/hookInstaller.ts collector/src/hookInstaller.test.ts
git commit -m "feat: add non-destructive settings.json hook installer/uninstaller"
```

---

### Task 11: Collector CLI (install-hooks / uninstall-hooks / status)

**Files:**
- Create: `collector/src/cli.ts`
- Modify: `collector/package.json`

**Interfaces:**
- Produces: `node dist/cli.js install-hooks|uninstall-hooks|status`, resolving the real
  `~/.claude/settings.json` and the real installed `scripts/aether-hook-emit.mjs` path (this repo's
  checkout location -- printed plainly if the script can't be found, matching the "refuse rather
  than write a broken command" discipline already established for the statusline installer).
  This stage has no Electron UI for these actions (`Aether OS unchanged` per roadmap.md) -- the CLI
  is the only way to install/uninstall hooks until a later stage wires a Settings card for it.

- [ ] **Step 1: Implement the CLI**

```typescript
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readHookInstallState, installHooks, uninstallHooks, MANAGED_HOOK_EVENTS } from './hookInstaller';

const settingsPath = join(homedir(), '.claude', 'settings.json');
// This repo's own scripts/ directory, resolved relative to this compiled
// file's location (collector/dist/cli.js -> ../../scripts/aether-hook-emit.mjs).
const scriptPath = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'scripts', 'aether-hook-emit.mjs');

async function main() {
  const command = process.argv[2];

  if (!existsSync(scriptPath)) {
    console.error(`aether-hook-emit.mjs not found at ${scriptPath} -- refusing to modify settings.json`);
    process.exitCode = 1;
    return;
  }

  if (command === 'status') {
    const state = await readHookInstallState(settingsPath, scriptPath);
    console.log(`settings.json: ${settingsPath}`);
    console.log(`script: ${scriptPath}`);
    for (const eventName of MANAGED_HOOK_EVENTS) {
      console.log(`  ${eventName}: ${state.installedEvents.includes(eventName) ? 'installed' : 'not installed'}`);
    }
    return;
  }

  if (command === 'install-hooks') {
    const result = await installHooks(settingsPath, scriptPath);
    if (!result.ok) {
      console.error(`install failed: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(result.backupPath ? `installed (backup: ${result.backupPath})` : 'installed');
    return;
  }

  if (command === 'uninstall-hooks') {
    const result = await uninstallHooks(settingsPath);
    if (!result.ok) {
      console.error(`uninstall failed: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(result.backupPath ? `uninstalled (backup: ${result.backupPath})` : 'uninstalled (nothing was installed)');
    return;
  }

  console.error('usage: node dist/cli.js <status|install-hooks|uninstall-hooks>');
  process.exitCode = 1;
}

main();
```

- [ ] **Step 2: Add the CLI script to `collector/package.json`**

```json
{
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "start": "node dist/index.js",
    "cli": "node dist/cli.js"
  }
}
```

- [ ] **Step 3: Manually verify against a real (backed-up) settings.json copy**

Run:
```bash
cd collector
npm run build
cp ~/.claude/settings.json ~/.claude/settings.json.manualtest-backup
npm run cli status
npm run cli -- install-hooks
npm run cli status
npm run cli -- uninstall-hooks
diff ~/.claude/settings.json ~/.claude/settings.json.manualtest-backup
rm ~/.claude/settings.json.manualtest-backup
```
Expected: `status` shows all four events "not installed" initially; after `install-hooks`, all four
show "installed" and every pre-existing hook entry (this box's own `SessionStart`/`Stop` entries)
is still present in `~/.claude/settings.json`; after `uninstall-hooks`, the `diff` against the
manual backup shows no differences (byte-for-byte restored, modulo key ordering from
`JSON.stringify` re-serialization, which is the same documented, accepted tradeoff
`statuslineInstaller.ts` already makes).

- [ ] **Step 4: Commit**

```bash
git add collector/src/cli.ts collector/package.json
git commit -m "feat: add collector CLI (status / install-hooks / uninstall-hooks)"
```

---

### Task 12: Windows autostart (Scheduled Task at logon)

**Files:**
- Create: `collector/src/autostart.ts`
- Create: `collector/src/autostart.test.ts`
- Modify: `collector/src/cli.ts`

**Interfaces:**
- Produces:
  ```typescript
  export function buildScheduledTaskCommand(action: 'create' | 'delete', nodePath: string, entrypointPath: string): string[];
  // Returns the exact argv for schtasks.exe -- pure and testable without touching the real OS.
  export function installAutostart(nodePath: string, entrypointPath: string): { ok: boolean; error?: string };
  export function uninstallAutostart(): { ok: boolean; error?: string };
  ```
  `installAutostart`/`uninstallAutostart` shell out to `schtasks.exe /Create` / `/Delete` with
  `/SC ONLOGON` and no elevation flag (constraint #8: no service wrapper, no admin rights). The argv
  construction is factored into the pure, directly-testable `buildScheduledTaskCommand` so the test
  suite verifies the exact command without actually registering a scheduled task on the CI/dev box.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { buildScheduledTaskCommand } from './autostart';

describe('buildScheduledTaskCommand', () => {
  it('builds a /Create command with ONLOGON trigger, no elevation, quoted paths', () => {
    const argv = buildScheduledTaskCommand('create', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\test\\aether-os\\collector\\dist\\index.js');
    expect(argv).toEqual([
      '/Create',
      '/TN', 'AetherCollector',
      '/TR', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\test\\aether-os\\collector\\dist\\index.js"',
      '/SC', 'ONLOGON',
      '/RL', 'LIMITED',
      '/F',
    ]);
  });

  it('builds a /Delete command by task name only', () => {
    const argv = buildScheduledTaskCommand('delete', 'unused', 'unused');
    expect(argv).toEqual(['/Delete', '/TN', 'AetherCollector', '/F']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npx vitest run src/autostart.test.ts`
Expected: FAIL — `autostart.ts` does not exist yet.

- [ ] **Step 3: Implement**

```typescript
import { execFileSync } from 'node:child_process';

const TASK_NAME = 'AetherCollector';

/**
 * Pure argv builder for schtasks.exe -- kept separate from the actual
 * execFileSync call below so this logic is testable without ever touching
 * the real Windows Task Scheduler. /RL LIMITED explicitly requests standard
 * (non-admin) privilege -- constraint #8 requires no elevation.
 */
export function buildScheduledTaskCommand(action: 'create' | 'delete', nodePath: string, entrypointPath: string): string[] {
  if (action === 'delete') {
    return ['/Delete', '/TN', TASK_NAME, '/F'];
  }
  return [
    '/Create',
    '/TN', TASK_NAME,
    '/TR', `"${nodePath}" "${entrypointPath}"`,
    '/SC', 'ONLOGON',
    '/RL', 'LIMITED',
    '/F',
  ];
}

export function installAutostart(nodePath: string, entrypointPath: string): { ok: boolean; error?: string } {
  try {
    execFileSync('schtasks.exe', buildScheduledTaskCommand('create', nodePath, entrypointPath));
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export function uninstallAutostart(): { ok: boolean; error?: string } {
  try {
    execFileSync('schtasks.exe', buildScheduledTaskCommand('delete', 'unused', 'unused'));
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npx vitest run src/autostart.test.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Wire `install-autostart` / `uninstall-autostart` into the CLI**

Add to `collector/src/cli.ts`, alongside the existing `install-hooks`/`uninstall-hooks` branches:

```typescript
  if (command === 'install-autostart') {
    const nodePath = process.execPath;
    const entrypointPath = resolve(fileURLToPath(import.meta.url), '..', 'index.js');
    const result = installAutostart(nodePath, entrypointPath);
    console.log(result.ok ? 'autostart installed' : `autostart install failed: ${result.error}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'uninstall-autostart') {
    const result = uninstallAutostart();
    console.log(result.ok ? 'autostart uninstalled' : `autostart uninstall failed: ${result.error}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
```

(Add the corresponding `import { installAutostart, uninstallAutostart } from './autostart';` at the
top, and mention both new subcommands in the usage line's error message.)

- [ ] **Step 6: Manually verify on this Windows box (optional but recommended -- mutates real Task Scheduler state)**

Run:
```bash
cd collector && npm run build
npm run cli -- install-autostart
schtasks /Query /TN AetherCollector
npm run cli -- uninstall-autostart
schtasks /Query /TN AetherCollector
```
Expected: the task appears in the first `/Query` (trigger: at log on, no elevation) and the second
`/Query` reports the task no longer exists.

- [ ] **Step 7: Commit**

```bash
git add collector/src/autostart.ts collector/src/autostart.test.ts collector/src/cli.ts
git commit -m "feat: add Windows Scheduled Task autostart (no service, no elevation)"
```

---

### Task 13: Whole-branch review, degradation check, and roadmap correction

**Files:**
- Modify: `docs/roadmap.md`
- Modify: `PROGRESS.md`

- [ ] **Step 1: Full verification pass**

Run:
```bash
cd collector && npm run build && npm test
cd .. && npx tsc -b && npm run build && npm run electron:build && npx vitest run
```
Expected: `collector/`'s own build and full test suite pass; the root Electron app's build, electron
build, and existing test suite (633+ tests as of Stage 1) are **completely unaffected** — this stage
touches zero files under `electron/`, `src/`, or `scripts/aether-statusline.mjs`, confirming the
degradation contract (constraint #6) trivially: nothing in Aether OS depends on the collector yet.

- [ ] **Step 2: Correct `docs/roadmap.md`'s Stage 2 table row**

Change the Stage 2 row's "Why" column from describing an "HTTP receiver" to reference the actual
file-spool transport, matching `docs/privacy-and-data.md` §3's binding correction (which the roadmap
table text was never updated to reflect). Also update the architecture diagram in §1 of the roadmap
to replace the `HTTP receiver on loopback ← hooks` line with `spool watcher ← hook-emit script`.

- [ ] **Step 3: Add a PROGRESS.md entry for Stage 2**

Follow this repo's established format (see the Statusline Feed and Optimize Panel entries) — one
bullet in "Shipped plans," covering: what `collector/` is and why it's a separate process; the
transport correction (file spool, not HTTP, per the privacy doc reversing the roadmap's original
text); the four managed hook events and why those specifically; the 30-day retention default and
that it's a judgment call flagged for the user rather than a hard requirement; that hook
install/uninstall is CLI-only this stage (no Settings UI yet — that's a natural Stage 3 follow-up);
and that autostart was verified manually against this box's real Task Scheduler (or explicitly note
if that manual step was skipped, per this project's established honesty convention for deferred
verification). Also explicitly record the known, still-open gap that `~/.aether-os/` is not yet
given user-only Windows ACL hardening despite `docs/privacy-and-data.md` §7 calling for it — true
since Stage 1, not introduced by this stage, but worth a named follow-up rather than silence.

- [ ] **Step 4: Commit**

```bash
git add docs/roadmap.md PROGRESS.md
git commit -m "docs: correct roadmap's Stage 2 transport description, add PROGRESS.md entry"
```

---

After all thirteen tasks: dispatch a whole-branch review (per this project's established pattern)
focused especially on (a) the hook installer's non-destructive merge/removal logic — the highest-risk
code in this plan, since it mutates the user's real `~/.claude/settings.json` and must never disturb
unrelated hooks; (b) confirming no raw command strings, file contents, or message text ever reaches
`ingestLine`'s SQLite insert, per `docs/privacy-and-data.md` §4; and (c) the 30-day retention default
— surface it to the user explicitly as a decision to confirm, not something the review should treat
as settled.
