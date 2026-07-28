# Viewer Reads the Store (Stage 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the expensive part of the Dashboard's usage scan — a full re-parse of every
`~/.claude/projects/**/*.jsonl` file, every 60 seconds — out of the Electron main process and into
the Stage-2 `collector/` process, which now tails every project's transcripts **incrementally**
(tracking a byte offset per file, never re-reading a file from position 0 twice) and persists one
row per assistant turn with usage into a new `usage_events` SQLite table. The Electron viewer's
`scanAndPushUsage()` becomes a cheap SQL query against that table, feeding the *exact same*,
already-tested `realUsageMath.ts` pure functions unchanged. If the collector has never run, or its
schema version doesn't match, the viewer falls back to today's `scanAllProjects()` direct-file scan
— per `docs/roadmap.md` §4.6's degradation contract, Aether OS must stay fully usable with no
collector running.

**Explicitly out of scope for this stage, decided with the user before writing this plan:** the 1s
live-agent-dispatch tick (`electron/liveAgentTracker.ts`) and anomaly detection are **not** touched.
`liveAgentTracker`'s live tracking is pinned to a *specific* session file via `notifyPtySpawned` —
a signal that only exists because Electron's main process knows when its own embedded terminal
spawned `claude`. A headless collector process has no pty and no equivalent signal; adopting the
codebase's existing `findMostRecentSessionFile()` heuristic instead would change real behavior (the
collector could end up tracking a *different*, more-recently-active Claude Code session elsewhere on
the machine, not the app's own terminal). That question is deferred to a later stage — plausibly
Stage 4, which already has to solve "which session is active" for the fleet/session-picker feature.

**Architecture:** Two new collector-side pure modules mirror the Electron ones they retire the need
for: `transcriptParser.ts` (ported near-verbatim — it already has zero Electron/Vite dependencies)
and `transcriptTailer.ts` (`readNewLines`, ported verbatim — already dependency-free). A new
`transcriptScan.ts` orchestrates: walk every project directory, discover `.jsonl` files, look up
each file's last-tailed byte offset in a new `transcript_files` table, tail only the new bytes,
parse, keep only `kind === 'assistant' && usage` rows, insert into `usage_events`. This runs on its
own poll interval in `collector/src/index.ts`, separate from the existing hook-spool tailer and
retention compaction. On the Electron side, a new `electron/collectorStore.ts` opens the collector's
SQLite file **read-only** (the collector owns the schema and writes; the viewer only ever reads,
per `docs/roadmap.md` §4.5), checks `schema_meta`'s version, and queries `usage_events` in whatever
time range `realUsageMath.ts`'s functions need — never importing anything from `collector/` (a
separate package with its own build), just the documented column contract.

**Tech Stack:** Same as Stage 2's `collector/` — TypeScript strict, `node:sqlite`'s `DatabaseSync`
(type-only import + `createRequire` runtime resolution — see "Global Constraints"), no npm runtime
dependencies added anywhere. Electron main process gets its first-ever `node:sqlite` usage in this
plan; Task 7 verifies the same Vite-transform workaround Stage 2 needed also applies (or doesn't)
under `electron-vite`'s bundler before the rest of the stage depends on it.

## Global Constraints

- **`node:sqlite`'s `DatabaseSync` can only ever be imported as a TYPE** (`import type { DatabaseSync } from 'node:sqlite';`)
  in both `collector/` and (as of this plan) `electron/` — a static VALUE import fails under Vite's
  dep-scanner (confirmed in Stage 2 for `vitest`, which is Vite-based; `electron-vite`'s bundler is
  also Vite-based, so the same failure is expected but must be *verified*, not assumed — see Task 7).
  The runtime value must be obtained via `createRequire(import.meta.url)('node:sqlite')` inside the
  one function that actually opens a database.
- **Relative imports need explicit `.js` extensions** everywhere in `collector/src/*.ts` — this
  project's `nodenext` module resolution requires it, and Stage 2's Task 8 found this breaks
  `tsc -b` silently if skipped. Add `.js` to every relative import from the start.
- **Verify the FULL build+test suite for every task**, not just the new test file: `cd collector && npx tsc -b`,
  `cd collector && npm run build`, `cd collector && npx vitest run` (whole suite) for
  collector-side tasks; `npx tsc -b && npm run build && npm run electron:build && npx vitest run`
  from the repo root for Electron-side tasks (Task 7 onward). Stage 2 shipped 8 tasks with a
  silently-broken `tsc -b` because only the new test file was ever checked — do not repeat that.
- **The collector's read-only reader in `electron/collectorStore.ts` must never write to the
  database** — open it with `node:sqlite`'s read-only option, so a bug in the viewer can never
  corrupt the collector's store.
- **Degradation contract is non-negotiable**: if `~/.aether-os/collector.db` doesn't exist, can't be
  opened, or its `schema_meta` version doesn't match what this plan's code expects, `scanAndPushUsage()`
  must fall back to the existing `scanAllProjects()` path — not throw, not show an empty dashboard.
- **No new IPC channels, no renderer-visible shape changes.** `scanAndPushUsage()`'s existing
  `usage:snapshot` payload (`weeklyTokens`, `dailyTokens`, `liveTokens`, `usedThisMonth`,
  `burnRatePerMin`, `weekOverWeekPct`, `lastScanAt`, `ctxUsed`) is unchanged — only where the
  `UsageEvent[]` array it's computed from comes from changes. `realUsageMath.ts` itself is untouched.
- Only `kind === 'assistant'` events with a non-null `usage` are ever persisted to `usage_events` —
  every one of `realUsageMath.ts`'s 7 functions ignores every other event shape, so storing anything
  else would be dead data. This also keeps the store privacy-minimal: no tool inputs, no message
  text, no `user`-kind events at all — timestamps, a model name string, and four token counts.

---

### Task 1: Add `usage_events` and `transcript_files` tables to the collector schema

**Files:**
- Modify: `collector/src/schema.ts`
- Modify: `collector/src/schema.test.ts`

**Interfaces:**
- Adds to `migrate(db)`: `usage_events(id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at_ms INTEGER NOT NULL, model TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_creation_input_tokens INTEGER NOT NULL, cache_read_input_tokens INTEGER NOT NULL)` and `transcript_files(file_path TEXT PRIMARY KEY, last_offset INTEGER NOT NULL, last_scanned_ms INTEGER NOT NULL)`.
- Does NOT bump `SCHEMA_VERSION` past what a version-mismatch check would treat as compatible for
  Stage 2's own tables — new tables are purely additive, but bump `SCHEMA_VERSION` to `2` anyway
  (Task 7's Electron-side reader checks for `>= 2` before trusting `usage_events` exists) so an
  old collector binary that predates this stage is unambiguously distinguishable from a new one.

- [ ] **Step 1: Write the failing test**

Add to `collector/src/schema.test.ts` (alongside the existing 3 tests, same file):

```typescript
it('migrate also creates usage_events and transcript_files, and bumps schema_meta to version 2', () => {
  const db = openDatabase(tempDbPath());
  migrate(db);
  expect(getSchemaVersion(db)).toBe(2);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r: any) => r.name);
  expect(tables).toEqual(['daily_rollups', 'drift_log', 'events', 'schema_meta', 'transcript_files', 'usage_events']);
  db.close();
});

it('usage_events accepts a full row insert', () => {
  const db = openDatabase(tempDbPath());
  migrate(db);
  db.prepare(
    `INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(1000, 'claude-sonnet-4-6', 100, 50, 0, 200);
  const row: any = db.prepare('SELECT * FROM usage_events').get();
  expect(row.model).toBe('claude-sonnet-4-6');
  expect(row.input_tokens).toBe(100);
  db.close();
});

it('transcript_files tracks a per-file offset, upsertable by file_path', () => {
  const db = openDatabase(tempDbPath());
  migrate(db);
  db.prepare(
    `INSERT INTO transcript_files (file_path, last_offset, last_scanned_ms) VALUES (?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET last_offset = excluded.last_offset, last_scanned_ms = excluded.last_scanned_ms`
  ).run('/proj/session.jsonl', 500, 1000);
  db.prepare(
    `INSERT INTO transcript_files (file_path, last_offset, last_scanned_ms) VALUES (?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET last_offset = excluded.last_offset, last_scanned_ms = excluded.last_scanned_ms`
  ).run('/proj/session.jsonl', 900, 2000);
  const row: any = db.prepare('SELECT * FROM transcript_files').get();
  expect(row.last_offset).toBe(900);
  const count: any = db.prepare('SELECT COUNT(*) as c FROM transcript_files').get();
  expect(count.c).toBe(1);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npx vitest run src/schema.test.ts`
Expected: FAIL — the new tables and version 2 don't exist yet.

- [ ] **Step 3: Update the schema module**

In `collector/src/schema.ts`, change `export const SCHEMA_VERSION = 1;` to `export const SCHEMA_VERSION = 2;`,
and add to the `db.exec` template string inside `migrate`, alongside the four existing `CREATE TABLE IF NOT EXISTS` statements:

```sql
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at_ms INTEGER NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation_input_tokens INTEGER NOT NULL,
  cache_read_input_tokens INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transcript_files (
  file_path TEXT PRIMARY KEY,
  last_offset INTEGER NOT NULL,
  last_scanned_ms INTEGER NOT NULL
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npx vitest run src/schema.test.ts`
Expected: PASS, all 6 tests (3 original + 3 new).

- [ ] **Step 5: Commit**

```bash
git add collector/src/schema.ts collector/src/schema.test.ts
git commit -m "feat: add usage_events and transcript_files tables, bump schema to version 2"
```

---

### Task 2: Port `transcriptParser.ts` into `collector/`

**Files:**
- Create: `collector/src/transcriptParser.ts`
- Create: `collector/src/transcriptParser.test.ts`

**Interfaces:**
- Produces (identical shape to `electron/transcriptParser.ts`, which this plan does not modify —
  both copies now exist, one per package, since `collector/` cannot import across the package
  boundary into `electron/`):
  ```typescript
  export interface TranscriptUsage {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  }
  export interface TranscriptEvent {
    kind: 'assistant' | 'user' | 'other';
    sessionId: string | null;
    timestamp: Date | null;
    cwd: string | null;
    model: string | null;
    usage: TranscriptUsage | null;
  }
  export function parseTranscriptLine(rawLine: string): TranscriptEvent | null;
  ```
  This port intentionally DROPS `toolUses`/`toolResults`/`isHumanPrompt`/`humanText`/`originKind`
  from the Electron original's `TranscriptEvent` — nothing in this stage's scope (usage-token
  aggregation only) reads them, and per this plan's privacy-minimal-storage constraint, parsing
  fields this stage will never persist is dead code inviting a future task to "just store it since
  it's already parsed," which is exactly the anti-pattern `docs/privacy-and-data.md` §4 warns against.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { parseTranscriptLine } from './transcriptParser.js';

describe('parseTranscriptLine', () => {
  it('parses an assistant line with usage', () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-1',
      timestamp: '2026-07-08T09:00:00Z',
      cwd: '/proj',
      message: {
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 },
        content: [],
      },
    });
    const result = parseTranscriptLine(line);
    expect(result).toEqual({
      kind: 'assistant',
      sessionId: 'sess-1',
      timestamp: new Date('2026-07-08T09:00:00Z'),
      cwd: '/proj',
      model: 'claude-sonnet-4-6',
      usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 10, cacheReadInputTokens: 20 },
    });
  });

  it('parses an assistant line missing usage as usage: null', () => {
    const line = JSON.stringify({ type: 'assistant', sessionId: 's1', message: { model: 'x', content: [] } });
    const result = parseTranscriptLine(line);
    expect(result?.usage).toBeNull();
  });

  it('parses a user line as kind: user, usage: null, model: null', () => {
    const line = JSON.stringify({ type: 'user', sessionId: 's1', message: { content: 'hello' } });
    const result = parseTranscriptLine(line);
    expect(result).toEqual({
      kind: 'user',
      sessionId: 's1',
      timestamp: null,
      cwd: null,
      model: null,
      usage: null,
    });
  });

  it('parses an unrecognized type as kind: other', () => {
    const line = JSON.stringify({ type: 'summary', sessionId: 's1' });
    const result = parseTranscriptLine(line);
    expect(result?.kind).toBe('other');
  });

  it('returns null for empty or whitespace-only lines', () => {
    expect(parseTranscriptLine('')).toBeNull();
    expect(parseTranscriptLine('   \n')).toBeNull();
  });

  it('returns null for malformed JSON, never throws', () => {
    expect(() => parseTranscriptLine('not json{{')).not.toThrow();
    expect(parseTranscriptLine('not json{{')).toBeNull();
  });

  it('defaults missing sessionId/cwd/timestamp to null rather than throwing', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [] } });
    const result = parseTranscriptLine(line);
    expect(result?.sessionId).toBeNull();
    expect(result?.cwd).toBeNull();
    expect(result?.timestamp).toBeNull();
  });

  it('accepts session_id (snake_case) as a fallback for sessionId', () => {
    const line = JSON.stringify({ type: 'user', session_id: 's2', message: { content: '' } });
    const result = parseTranscriptLine(line);
    expect(result?.sessionId).toBe('s2');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npx vitest run src/transcriptParser.test.ts`
Expected: FAIL — `transcriptParser.ts` does not exist yet.

- [ ] **Step 3: Implement the parser**

```typescript
export interface TranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface TranscriptEvent {
  kind: 'assistant' | 'user' | 'other';
  sessionId: string | null;
  timestamp: Date | null;
  cwd: string | null;
  model: string | null;
  usage: TranscriptUsage | null;
}

export function parseTranscriptLine(rawLine: string): TranscriptEvent | null {
  const trimmed = (rawLine || '').trim();
  if (!trimmed) return null;

  let json: any;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const sessionId = json.sessionId || json.session_id || null;
  const timestamp = json.timestamp ? new Date(json.timestamp) : null;
  const cwd = json.cwd || null;

  if (json.type === 'assistant' && json.message) {
    const msg = json.message;
    const usage = msg.usage
      ? {
          inputTokens: msg.usage.input_tokens || 0,
          outputTokens: msg.usage.output_tokens || 0,
          cacheCreationInputTokens: msg.usage.cache_creation_input_tokens || 0,
          cacheReadInputTokens: msg.usage.cache_read_input_tokens || 0,
        }
      : null;
    return { kind: 'assistant', sessionId, timestamp, cwd, model: msg.model || null, usage };
  }

  if (json.type === 'user' && json.message) {
    return { kind: 'user', sessionId, timestamp, cwd, model: null, usage: null };
  }

  return { kind: 'other', sessionId, timestamp, cwd, model: null, usage: null };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npx vitest run src/transcriptParser.test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add collector/src/transcriptParser.ts collector/src/transcriptParser.test.ts
git commit -m "feat: port transcriptParser (usage-fields-only subset) into collector/"
```

---

### Task 3: Port `transcriptTailer.ts`'s `readNewLines` into `collector/`

**Files:**
- Create: `collector/src/transcriptTailer.ts`
- Create: `collector/src/transcriptTailer.test.ts`

**Interfaces:**
- Produces (verbatim port — this file already has zero Electron dependencies, only `node:fs`):
  ```typescript
  export function readNewLines(filePath: string, offset: number): Promise<{ lines: string[]; newOffset: number }>;
  ```

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readNewLines } from './transcriptTailer.js';

function tempFile(initialContent = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-tailer-'));
  const filePath = join(dir, 'session.jsonl');
  writeFileSync(filePath, initialContent, 'utf8');
  return filePath;
}

describe('readNewLines', () => {
  it('reads all complete lines from offset 0 on first read', async () => {
    const filePath = tempFile('line1\nline2\n');
    const { lines, newOffset } = await readNewLines(filePath, 0);
    expect(lines).toEqual(['line1', 'line2']);
    expect(newOffset).toBe(Buffer.byteLength('line1\nline2\n'));
  });

  it('reads only new lines when called again with the previous offset', async () => {
    const filePath = tempFile('line1\n');
    const first = await readNewLines(filePath, 0);
    appendFileSync(filePath, 'line2\n', 'utf8');
    const second = await readNewLines(filePath, first.newOffset);
    expect(second.lines).toEqual(['line2']);
  });

  it('does not return a trailing incomplete line still being written', async () => {
    const filePath = tempFile('line1\npartial-no-newline-yet');
    const { lines, newOffset } = await readNewLines(filePath, 0);
    expect(lines).toEqual(['line1']);
    expect(newOffset).toBe(Buffer.byteLength('line1\n'));
  });

  it('returns no lines and unchanged offset when nothing new has been written', async () => {
    const filePath = tempFile('line1\n');
    const first = await readNewLines(filePath, 0);
    const second = await readNewLines(filePath, first.newOffset);
    expect(second).toEqual({ lines: [], newOffset: first.newOffset });
  });

  it('returns no lines when offset already equals or exceeds the file size', async () => {
    const filePath = tempFile('short');
    const result = await readNewLines(filePath, 1000);
    expect(result).toEqual({ lines: [], newOffset: 1000 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npx vitest run src/transcriptTailer.test.ts`
Expected: FAIL — `transcriptTailer.ts` does not exist yet.

- [ ] **Step 3: Implement (verbatim port)**

```typescript
import { promises as fsp } from 'node:fs';

export async function readNewLines(filePath: string, offset: number): Promise<{ lines: string[]; newOffset: number }> {
  const stat = await fsp.stat(filePath);
  if (stat.size <= offset) return { lines: [], newOffset: offset };

  const length = stat.size - offset;
  const fd = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await fd.read(buffer, 0, length, offset);
    const text = buffer.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) return { lines: [], newOffset: offset };
    const complete = text.slice(0, lastNewline);
    const newOffset = offset + Buffer.byteLength(complete, 'utf8') + 1;
    const lines = complete.split('\n');
    return { lines, newOffset };
  } finally {
    await fd.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npx vitest run src/transcriptTailer.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add collector/src/transcriptTailer.ts collector/src/transcriptTailer.test.ts
git commit -m "feat: port transcriptTailer's readNewLines (verbatim, dependency-free) into collector/"
```

---

### Task 4: Usage-event ingest (parsed event → `usage_events` row, or skip)

**Files:**
- Create: `collector/src/usageIngest.ts`
- Create: `collector/src/usageIngest.test.ts`

**Interfaces:**
- Consumes: `TranscriptEvent` (Task 2), `DatabaseSync` (type-only, Task 1's schema).
- Produces:
  ```typescript
  export function ingestUsageEvent(db: DatabaseSync, event: TranscriptEvent): boolean;
  // Returns true if a row was inserted, false if the event was skipped (never throws).
  ```
  Skips (returns `false`, inserts nothing) any event that is not `kind === 'assistant'` or has
  `usage === null` or has no `timestamp` — matching this plan's Global Constraint that only
  usage-bearing assistant turns are ever persisted.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema.js';
import { ingestUsageEvent } from './usageIngest.js';
import type { TranscriptEvent } from './transcriptParser.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-usageingest-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return db;
}

function assistantEvent(overrides: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return {
    kind: 'assistant',
    sessionId: 's1',
    timestamp: new Date('2026-07-08T09:00:00Z'),
    cwd: null,
    model: 'claude-sonnet-4-6',
    usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

describe('ingestUsageEvent', () => {
  it('inserts a row for an assistant event with usage and returns true', () => {
    const db = freshDb();
    const inserted = ingestUsageEvent(db, assistantEvent());
    expect(inserted).toBe(true);
    const row: any = db.prepare('SELECT * FROM usage_events').get();
    expect(row.model).toBe('claude-sonnet-4-6');
    expect(row.input_tokens).toBe(100);
    expect(row.occurred_at_ms).toBe(new Date('2026-07-08T09:00:00Z').getTime());
    db.close();
  });

  it('skips a user-kind event and returns false', () => {
    const db = freshDb();
    const inserted = ingestUsageEvent(db, assistantEvent({ kind: 'user' }));
    expect(inserted).toBe(false);
    const count: any = db.prepare('SELECT COUNT(*) as c FROM usage_events').get();
    expect(count.c).toBe(0);
    db.close();
  });

  it('skips an assistant event with null usage and returns false', () => {
    const db = freshDb();
    const inserted = ingestUsageEvent(db, assistantEvent({ usage: null }));
    expect(inserted).toBe(false);
    db.close();
  });

  it('skips an event with a null timestamp and returns false', () => {
    const db = freshDb();
    const inserted = ingestUsageEvent(db, assistantEvent({ timestamp: null }));
    expect(inserted).toBe(false);
    db.close();
  });

  it('stores a null model as SQL NULL, not the string "null"', () => {
    const db = freshDb();
    ingestUsageEvent(db, assistantEvent({ model: null }));
    const row: any = db.prepare('SELECT model FROM usage_events').get();
    expect(row.model).toBeNull();
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npx vitest run src/usageIngest.test.ts`
Expected: FAIL — `usageIngest.ts` does not exist yet.

- [ ] **Step 3: Implement**

```typescript
import type { DatabaseSync } from 'node:sqlite';
import type { TranscriptEvent } from './transcriptParser.js';

export function ingestUsageEvent(db: DatabaseSync, event: TranscriptEvent): boolean {
  if (event.kind !== 'assistant' || event.usage === null || event.timestamp === null) return false;

  db.prepare(
    `INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    event.timestamp.getTime(),
    event.model,
    event.usage.inputTokens,
    event.usage.outputTokens,
    event.usage.cacheCreationInputTokens,
    event.usage.cacheReadInputTokens
  );
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npx vitest run src/usageIngest.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add collector/src/usageIngest.ts collector/src/usageIngest.test.ts
git commit -m "feat: add usage-event ingest (assistant+usage rows only)"
```

---

### Task 5: Transcript scan orchestrator (walk all projects, incremental per-file offsets)

**Files:**
- Create: `collector/src/transcriptScan.ts`
- Create: `collector/src/transcriptScan.test.ts`

**Interfaces:**
- Consumes: `readNewLines` (Task 3), `parseTranscriptLine` (Task 2), `ingestUsageEvent` (Task 4).
- Produces:
  ```typescript
  export function scanTranscriptsOnce(db: DatabaseSync, projectsRoot: string, nowMs: number): { filesScanned: number; eventsIngested: number };
  ```
  Walks every directory under `projectsRoot`, finds every `.jsonl` file in each, looks up (or
  defaults to `0` for) that file's `last_offset` in `transcript_files`, calls `readNewLines`, parses
  and ingests each new line via `ingestUsageEvent`, then upserts `transcript_files` with the new
  offset and `nowMs`. A missing `projectsRoot` or a per-file read error skips that file for this
  pass (never throws) — the byte offset for a file that errored is left unchanged, so it's retried
  whole (from the same offset) on the next scan rather than silently losing that file's remaining
  content.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema.js';
import { scanTranscriptsOnce } from './transcriptScan.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-scan-db-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return db;
}

function assistantLine(inputTokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    timestamp: '2026-07-08T09:00:00Z',
    message: { model: 'claude-sonnet-4-6', usage: { input_tokens: inputTokens, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [] },
  });
}

describe('scanTranscriptsOnce', () => {
  it('discovers project dirs, ingests assistant+usage lines, and records the file offset', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    writeFileSync(join(projDir, 'session.jsonl'), `${assistantLine(100)}\n${assistantLine(200)}\n`, 'utf8');

    const db = freshDb();
    const result = scanTranscriptsOnce(db, projectsRoot, 1000);
    expect(result).toEqual({ filesScanned: 1, eventsIngested: 2 });

    const count: any = db.prepare('SELECT COUNT(*) as c FROM usage_events').get();
    expect(count.c).toBe(2);
    const fileRow: any = db.prepare('SELECT * FROM transcript_files').get();
    expect(fileRow.last_scanned_ms).toBe(1000);
    expect(fileRow.last_offset).toBeGreaterThan(0);
    db.close();
  });

  it('on a second call, only ingests newly-appended lines, not the whole file again', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    const filePath = join(projDir, 'session.jsonl');
    writeFileSync(filePath, `${assistantLine(100)}\n`, 'utf8');

    const db = freshDb();
    scanTranscriptsOnce(db, projectsRoot, 1000);
    require('fs').appendFileSync(filePath, `${assistantLine(200)}\n`, 'utf8');
    const second = scanTranscriptsOnce(db, projectsRoot, 2000);
    expect(second.eventsIngested).toBe(1);

    const count: any = db.prepare('SELECT COUNT(*) as c FROM usage_events').get();
    expect(count.c).toBe(2);
    db.close();
  });

  it('ignores non-.jsonl files and non-directory entries under projectsRoot', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    writeFileSync(join(projectsRoot, 'not-a-dir.txt'), 'irrelevant', 'utf8');
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    writeFileSync(join(projDir, 'notes.txt'), 'irrelevant', 'utf8');

    const db = freshDb();
    const result = scanTranscriptsOnce(db, projectsRoot, 1000);
    expect(result).toEqual({ filesScanned: 0, eventsIngested: 0 });
    db.close();
  });

  it('returns zero counts and does not throw when projectsRoot does not exist', () => {
    const db = freshDb();
    const missingRoot = join(tmpdir(), 'aether-collector-does-not-exist-' + Date.now());
    expect(() => scanTranscriptsOnce(db, missingRoot, 1000)).not.toThrow();
    expect(scanTranscriptsOnce(db, missingRoot, 1000)).toEqual({ filesScanned: 0, eventsIngested: 0 });
    db.close();
  });

  it('skips non-assistant or usage-less lines within an otherwise-ingested file', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    const userLine = JSON.stringify({ type: 'user', sessionId: 's1', message: { content: 'hi' } });
    writeFileSync(join(projDir, 'session.jsonl'), `${userLine}\n${assistantLine(100)}\n`, 'utf8');

    const db = freshDb();
    const result = scanTranscriptsOnce(db, projectsRoot, 1000);
    expect(result.eventsIngested).toBe(1);
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd collector && npx vitest run src/transcriptScan.test.ts`
Expected: FAIL — `transcriptScan.ts` does not exist yet.

- [ ] **Step 3: Implement**

```typescript
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { readNewLines } from './transcriptTailer.js';
import { parseTranscriptLine } from './transcriptParser.js';
import { ingestUsageEvent } from './usageIngest.js';

function getLastOffset(db: DatabaseSync, filePath: string): number {
  const row = db.prepare('SELECT last_offset FROM transcript_files WHERE file_path = ?').get(filePath) as
    | { last_offset: number }
    | undefined;
  return row ? row.last_offset : 0;
}

function recordOffset(db: DatabaseSync, filePath: string, offset: number, nowMs: number): void {
  db.prepare(
    `INSERT INTO transcript_files (file_path, last_offset, last_scanned_ms) VALUES (?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET last_offset = excluded.last_offset, last_scanned_ms = excluded.last_scanned_ms`
  ).run(filePath, offset, nowMs);
}

export function scanTranscriptsOnce(
  db: DatabaseSync,
  projectsRoot: string,
  nowMs: number
): { filesScanned: number; eventsIngested: number } {
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return { filesScanned: 0, eventsIngested: 0 };
  }

  let filesScanned = 0;
  let eventsIngested = 0;

  for (const dirName of projectDirs) {
    const dirPath = join(projectsRoot, dirName);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(dirPath, file);
      const offset = getLastOffset(db, filePath);
      let lines: string[];
      let newOffset: number;
      try {
        const result = readNewLinesSync(filePath, offset);
        lines = result.lines;
        newOffset = result.newOffset;
      } catch {
        continue;
      }

      for (const line of lines) {
        const event = parseTranscriptLine(line);
        if (event && ingestUsageEvent(db, event)) eventsIngested += 1;
      }

      filesScanned += 1;
      recordOffset(db, filePath, newOffset, nowMs);
    }
  }

  return { filesScanned, eventsIngested };
}

// readNewLines is async (uses fsp.open/fd.read); this orchestrator's own
// test suite and the collector's poll loop are both fine awaiting it, but a
// synchronous wrapper keeps this function's own signature synchronous and
// simple to test/call from a plain setInterval tick without threading
// async/await through every caller. Uses the synchronous fs API directly
// rather than calling the async readNewLines, to avoid mixing sync directory
// walking with async file reads in the same loop.
import { statSync, openSync, readSync, closeSync } from 'node:fs';
function readNewLinesSync(filePath: string, offset: number): { lines: string[]; newOffset: number } {
  const stat = statSync(filePath);
  if (stat.size <= offset) return { lines: [], newOffset: offset };

  const length = stat.size - offset;
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    const text = buffer.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) return { lines: [], newOffset: offset };
    const complete = text.slice(0, lastNewline);
    const newOffset = offset + Buffer.byteLength(complete, 'utf8') + 1;
    return { lines: complete.split('\n'), newOffset };
  } finally {
    closeSync(fd);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd collector && npx vitest run src/transcriptScan.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Self-review note before committing**

This task's implementation defines its own synchronous `readNewLinesSync`, duplicating Task 3's
async `readNewLines` logic instead of importing and awaiting it. This is a deliberate, disclosed
deviation (explained in the code comment above) to keep `scanTranscriptsOnce` fully synchronous —
acceptable since both versions are ~15 lines of straightforward buffer arithmetic and Task 3's
`readNewLines` is still the one covered by dedicated tests and still the one this plan documents as
"the port." If a future task needs to unify these into one implementation, that is a reasonable
follow-up, not a blocker here.

- [ ] **Step 6: Commit**

```bash
git add collector/src/transcriptScan.ts collector/src/transcriptScan.test.ts
git commit -m "feat: add transcript scan orchestrator (incremental per-file offsets, all projects)"
```

---

### Task 6: Wire the transcript scan into the collector's main loop

**Files:**
- Modify: `collector/src/index.ts`

**Interfaces:**
- Consumes: `scanTranscriptsOnce` (Task 5).
- Modifies: `startCollector(options)` gains one more field, `transcriptScanIntervalMs`, and one more
  `setInterval`, stopped alongside the existing tailer/compaction intervals by the same returned
  stop function.

- [ ] **Step 1: Read the current `collector/src/index.ts` in full**, to match its existing
  `startCollector` structure exactly (it currently takes `{ dbPath, spoolDir, tailIntervalMs, compactIntervalMs }`
  and returns one stop function tearing down two intervals plus closing the db).

- [ ] **Step 2: Extend `startCollector`'s options and body**

```typescript
export function startCollector(options: {
  dbPath: string;
  spoolDir: string;
  tailIntervalMs: number;
  compactIntervalMs: number;
  projectsRoot: string;
  transcriptScanIntervalMs: number;
}): () => void {
  const db = openDatabase(options.dbPath);
  migrate(db);

  const stopTailer = startSpoolTailer(db, options.spoolDir, options.tailIntervalMs);
  const compactTimer = setInterval(() => compact(db, Date.now()), options.compactIntervalMs);
  const transcriptScanTimer = setInterval(
    () => scanTranscriptsOnce(db, options.projectsRoot, Date.now()),
    options.transcriptScanIntervalMs
  );

  return () => {
    stopTailer();
    clearInterval(compactTimer);
    clearInterval(transcriptScanTimer);
    db.close();
  };
}
```

Add `import { scanTranscriptsOnce } from './transcriptScan.js';` at the top. Update the module-level
`isMainModule` block's real invocation to pass `projectsRoot: join(homedir(), '.claude', 'projects')`
and `transcriptScanIntervalMs: 15000` (15s — cheap now that it's incremental; still coarser than the
1s live-dispatch tick this plan deliberately does not touch), and run an initial
`scanTranscriptsOnce(db, ..., Date.now())` call once synchronously before the interval starts (mirrors
how `tailIntervalMs`'s spool tailer already does an immediate first pass via `startSpoolTailer`'s own
internal first invocation — check that pattern and match it, so the very first scan doesn't wait a
full 15s after collector startup).

- [ ] **Step 3: Update `collector/src/index.test.ts`**

The existing integration test calls `startCollector({ dbPath, spoolDir, tailIntervalMs, compactIntervalMs })`
— add the two new required fields (`projectsRoot`, `transcriptScanIntervalMs`) to that call so it
still type-checks and runs; point `projectsRoot` at a fresh empty temp directory (the existing test
doesn't need real transcript data, just needs `scanTranscriptsOnce` to run without throwing against
an empty/missing directory).

- [ ] **Step 4: Run the full collector suite and build**

Run: `cd collector && npx vitest run` (all tests, all files, should now be more than the prior 49),
`cd collector && npx tsc -b`, `cd collector && npm run build` — confirm zero errors, zero regressions.

- [ ] **Step 5: Commit**

```bash
git add collector/src/index.ts collector/src/index.test.ts
git commit -m "feat: wire transcript scan into the collector's main loop (15s interval)"
```

---

### Task 7: Electron-side read-only collector store reader

**Files:**
- Create: `electron/collectorStore.ts`
- Create: `electron/collectorStore.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface CollectorUsageEvent {
    kind: 'assistant';
    timestamp: Date;
    usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number };
  }
  export function readUsageEventsSince(dbPath: string, sinceMs: number): CollectorUsageEvent[] | null;
  // Returns null (never throws) when the DB file doesn't exist, can't be opened, or its
  // schema_meta version is below 2 -- callers must treat null as "collector unavailable,
  // fall back to scanAllProjects," never as "zero usage."
  ```
  This is the FIRST use of `node:sqlite` anywhere under `electron/` — this task's Step 1 exists
  specifically to verify, not assume, that the same Vite-transform workaround Stage 2 needed for
  `vitest` also applies (or doesn't) for `electron-vite`'s bundler, since both are Vite-based but
  this has never actually been tested against `electron-vite` specifically.

- [ ] **Step 1: Spike — confirm (or refute) the `node:sqlite` + `electron-vite` interaction before writing the real module**

Create a throwaway one-line test file (do NOT commit it) that does a plain static
`import { DatabaseSync } from 'node:sqlite';` inside `electron/`, and run
`npx vitest run` against it (the root app's vitest config, which is also Vite-based, is the closest
available proxy for whether `electron-vite`'s bundler — also Vite — will choke the same way). If it
fails with the same `Failed to load url sqlite` error Stage 2 documented, proceed with Step 2's
`import type` + `createRequire` pattern exactly as written below. If it unexpectedly succeeds (Vite's
externals list may have been updated since Stage 2), simplify Step 2 to a plain static value import
instead and note the discrepancy in this task's commit message. Delete the throwaway test file either
way before continuing.

- [ ] **Step 2: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'node:module';
import { readUsageEventsSince } from './collectorStore.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

function tempDbWithUsageEvents(rows: { occurred_at_ms: number; model: string | null; input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }[], schemaVersion = 2): string {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collectorstore-'));
  const dbPath = join(dir, 'test.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at_ms INTEGER NOT NULL, model TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_creation_input_tokens INTEGER NOT NULL, cache_read_input_tokens INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?)").run(String(schemaVersion));
  const insert = db.prepare(
    'INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const r of rows) {
    insert.run(r.occurred_at_ms, r.model, r.input_tokens, r.output_tokens, r.cache_creation_input_tokens, r.cache_read_input_tokens);
  }
  db.close();
  return dbPath;
}

describe('readUsageEventsSince', () => {
  it('returns mapped events at or after sinceMs, sorted or not (callers do not depend on order)', () => {
    const dbPath = tempDbWithUsageEvents([
      { occurred_at_ms: 1000, model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 },
      { occurred_at_ms: 2000, model: null, input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ]);
    const events = readUsageEventsSince(dbPath, 0);
    expect(events).not.toBeNull();
    expect(events!.length).toBe(2);
    expect(events![0]).toEqual({
      kind: 'assistant',
      timestamp: new Date(1000),
      usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 10 },
    });
  });

  it('excludes events strictly before sinceMs', () => {
    const dbPath = tempDbWithUsageEvents([
      { occurred_at_ms: 1000, model: null, input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      { occurred_at_ms: 5000, model: null, input_tokens: 2, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ]);
    const events = readUsageEventsSince(dbPath, 3000);
    expect(events!.length).toBe(1);
    expect(events![0].timestamp).toEqual(new Date(5000));
  });

  it('returns null when the database file does not exist', () => {
    const missingPath = join(tmpdir(), 'aether-collectorstore-missing-' + Date.now(), 'test.db');
    expect(readUsageEventsSince(missingPath, 0)).toBeNull();
  });

  it('returns null when schema_meta version is below 2', () => {
    const dbPath = tempDbWithUsageEvents([], 1);
    expect(readUsageEventsSince(dbPath, 0)).toBeNull();
  });

  it('never throws even against a malformed/corrupt database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-collectorstore-corrupt-'));
    const dbPath = join(dir, 'test.db');
    require('fs').writeFileSync(dbPath, 'not a real sqlite file');
    expect(() => readUsageEventsSince(dbPath, 0)).not.toThrow();
    expect(readUsageEventsSince(dbPath, 0)).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run electron/collectorStore.test.ts`
Expected: FAIL — `collectorStore.ts` does not exist yet.

- [ ] **Step 4: Implement**

```typescript
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

export interface CollectorUsageEvent {
  kind: 'assistant';
  timestamp: Date;
  usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number };
}

const MIN_SUPPORTED_SCHEMA_VERSION = 2;

function openReadOnly(dbPath: string): DatabaseSync | null {
  if (!existsSync(dbPath)) return null;
  try {
    const sqlite = require('node:sqlite');
    return new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

function schemaVersionOf(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  } catch {
    return 0;
  }
}

export function readUsageEventsSince(dbPath: string, sinceMs: number): CollectorUsageEvent[] | null {
  const db = openReadOnly(dbPath);
  if (!db) return null;

  try {
    if (schemaVersionOf(db) < MIN_SUPPORTED_SCHEMA_VERSION) return null;

    const rows = db
      .prepare(
        'SELECT occurred_at_ms, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens FROM usage_events WHERE occurred_at_ms >= ?'
      )
      .all(sinceMs) as {
      occurred_at_ms: number;
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    }[];

    return rows.map((r) => ({
      kind: 'assistant' as const,
      timestamp: new Date(r.occurred_at_ms),
      usage: {
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheCreationInputTokens: r.cache_creation_input_tokens,
        cacheReadInputTokens: r.cache_read_input_tokens,
      },
    }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}
```

If Step 1's spike found the static import works fine under this bundler, replace the `require('node:sqlite')`
call inside `openReadOnly` with a top-level `import { DatabaseSync } from 'node:sqlite';` and drop the
`createRequire` machinery — but keep the `import type` version as the fallback default given Stage 2's
precedent, unless Step 1 proves otherwise on THIS specific bundler.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run electron/collectorStore.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 6: Commit**

```bash
git add electron/collectorStore.ts electron/collectorStore.test.ts
git commit -m "feat: add read-only collector-store reader (usage_events, version-gated)"
```

---

### Task 8: `scanAndPushUsage` reads from the collector first, falls back to `scanAllProjects`

**Files:**
- Modify: `electron/main.ts`

**Interfaces:**
- Consumes: `readUsageEventsSince` (Task 7).
- Modifies: `scanAndPushUsage()`'s event source only — every downstream `compute*` call and the
  `usage:snapshot` IPC payload shape are unchanged.

- [ ] **Step 1: Read `electron/main.ts`'s current `scanAndPushUsage` in full** (already read once
  this session — reproduced in this plan's "Architecture" section for reference, but re-read the
  live file before editing, since Stage 2's own work already touched nearby lines in this file).

- [ ] **Step 2: Add the collector DB path constant and a small selection helper**

Near the top of `main.ts`, alongside the existing `optimizeStatePath`/`statuslinePayloadPath` constants:

```typescript
const collectorDbPath = join(os.homedir(), '.aether-os', 'collector.db');
```

Add `import { readUsageEventsSince, type CollectorUsageEvent } from './collectorStore';` (note: no
`.js` extension needed here — `electron/`'s own tsconfig is NOT `nodenext`, this constraint is
specific to `collector/`'s package; check `electron/tsconfig.json` or the root `tsconfig.json` to
confirm before assuming either way, and match whatever the OTHER existing relative imports in this
same file already do).

- [ ] **Step 3: Change `scanAndPushUsage`'s event source, and make Optimize's `cwd` lookup on-demand instead of periodic**

`lastScannedEvents` exists ONLY to feed `optimizeProjectTargetPath` (used by the `optimize:targets`
and `optimize:apply` IPC handlers) with `cwd` data — a field `CollectorUsageEvent` never carries
(Task 2's scope cut) and that dashboard-tile computation doesn't need at all. Keeping a periodic full
`scanAllProjects()` call just to serve those two rarely-invoked, user-triggered handlers would defeat
this entire stage's point (the scan would still run every cycle regardless of which source feeds the
tiles). Instead, make the two Optimize IPC handlers do their OWN fresh, on-demand scan when actually
invoked (a user opening the Apply-fix target picker, or clicking Apply — infrequent, not a 60s
background cost), and remove `lastScannedEvents`'s role in the periodic scan entirely:

```typescript
async function scanAndPushUsage(): Promise<void> {
  if (!mainWindow) return;
  const now = new Date();

  // Prefer the collector's incrementally-tailed usage_events store; only fall
  // back to a full re-scan of every project's transcripts when the collector
  // hasn't run yet, isn't installed, or its schema predates this stage --
  // Aether OS must stay fully usable either way (docs/roadmap.md SS4.6).
  const sinceMs = now.getTime() - 31 * 24 * 60 * 60 * 1000; // covers computeUsedThisMonth's widest window with margin
  const collectorEvents = readUsageEventsSince(collectorDbPath, sinceMs);

  // CollectorUsageEvent is intentionally narrower than TranscriptEvent (no
  // sessionId/cwd/toolUses -- Task 2's scope cut). realUsageMath.ts's 7
  // functions only ever read .kind/.timestamp/.usage (confirmed by reading
  // every one during this plan's research), so this cast is safe for THIS
  // call site -- but a future realUsageMath function reading any other field
  // would silently break against the collector path. Don't add one without
  // widening CollectorUsageEvent and readUsageEventsSince's SELECT first.
  let events: TranscriptEvent[];
  if (collectorEvents !== null) {
    events = collectorEvents as unknown as TranscriptEvent[];
  } else {
    const projectsRoot = join(os.homedir(), '.claude', 'projects');
    events = await scanAllProjects(projectsRoot);
  }

  sendToWindow('usage:snapshot', {
    weeklyTokens: computeWeeklyTokens(events, now),
    dailyTokens: computeDailyTokens(events, now),
    liveTokens: computeLiveTokens(events, now),
    usedThisMonth: computeUsedThisMonth(events, now),
    burnRatePerMin: computeBurnRatePerMin(events, now),
    weekOverWeekPct: computeWeekOverWeekPct(events, now),
    lastScanAt: now.toISOString(),
    ctxUsed: computeContextWindow(events, now),
  });

  // The Optimize findings block below this point in the current file
  // (evaluateOptimizeRulesWithRecurrence, summarizeOptimize, gradeBreakdown,
  // sendToWindow('optimize:findings'/'optimize:summary'/'optimize:breakdown'))
  // is UNCHANGED and still reads `events` from the same variable -- it only
  // needs the same fields realUsageMath does (usage/timestamp/tool info
  // already narrowed at Task 6's optimizeRules level, not this stage's
  // concern), so it is unaffected by which source produced `events` above.
}
```

Now remove `lastScannedEvents`'s assignment from `scanAndPushUsage` entirely (delete the
`lastScannedEvents = events;` line the current file has), and change `optimizeGlobalTargetPath`/
`optimizeProjectTargetPath`'s two call sites (`optimize:targets` and `optimize:apply`) to scan
fresh, on demand:

```typescript
ipcMain.handle('optimize:targets', async () => {
  const globalPath = optimizeGlobalTargetPath();
  const projectsRoot = join(os.homedir(), '.claude', 'projects');
  const events = await scanAllProjects(projectsRoot);
  const projectPath = optimizeProjectTargetPath(events);
  async function pathExists(p: string): Promise<boolean> {
    try {
      await fsp.stat(p);
      return true;
    } catch {
      return false;
    }
  }
  return {
    global: { path: globalPath, exists: await pathExists(globalPath) },
    project: projectPath ? { path: projectPath, exists: await pathExists(projectPath) } : null,
  };
});
```

Apply the same `const events = await scanAllProjects(projectsRoot);` + `optimizeProjectTargetPath(events)`
pattern inside the `optimize:apply` handler, replacing its current reference to the module-level
`lastScannedEvents`. Delete the now-unused `let lastScannedEvents: TranscriptEvent[] = [];` module-level
declaration once both call sites no longer reference it — grep the file for `lastScannedEvents` after
this edit to confirm zero remaining references before deleting the declaration, since a stray
reference would be a compile error, not a silent bug, but check anyway rather than assuming.

- [ ] **Step 4: Full verification**

Run: `npx tsc -b && npm run build && npm run electron:build && npx vitest run` from the repo root.
Confirm zero errors, zero regressions across the full 633+ test suite.

- [ ] **Step 5: Manual verification**

Run the app (`npm run electron:dev`), confirm the Dashboard's tiles still render sensible numbers
with no collector running (fallback path), then (if the collector has been run at least once on this
box, producing `~/.aether-os/collector.db` with `usage_events` rows from Stage 2 testing or a fresh
`node collector/dist/index.js` run) confirm the tiles still render — comparing the two isn't expected
to produce identical numbers (different scan cutoffs/timing), just non-empty, sane-looking values in
both cases. Note the result in this task's report; if you cannot run the collector for real in this
environment, say so explicitly rather than claiming this was verified.

- [ ] **Step 6: Commit**

```bash
git add electron/main.ts
git commit -m "feat: scanAndPushUsage reads from the collector store, falls back to scanAllProjects"
```

---

### Task 9: Whole-branch review, degradation check, and roadmap/PROGRESS.md update

**Files:**
- Modify: `docs/roadmap.md`
- Modify: `PROGRESS.md`

- [ ] **Step 1: Full verification pass**

Run `cd collector && npm run build && npm test`, then from the repo root
`npx tsc -b && npm run build && npm run electron:build && npx vitest run`. Confirm both are
completely clean. Confirm the degradation contract by temporarily renaming/moving
`~/.aether-os/collector.db` out of the way (if it exists on this box) and re-running the Electron
app's dashboard scan path manually (or a targeted test) to confirm `scanAndPushUsage` genuinely falls
back to `scanAllProjects` rather than erroring or showing an empty dashboard; restore the file
afterward.

- [ ] **Step 2: Update `docs/roadmap.md`'s Stage 3 row**

Mark Stage 3 as shipped in the table (matching how Stage 0.5/1/2 rows or the surrounding prose
already signal completion in this document), and add a short note next to it: the 1s live-agent tick
and anomaly detection were explicitly deferred (not part of this stage), per the reasoning in this
plan's own header — cross-reference this plan file so a future reader knows why "Viewer reads the
store" didn't retire everything the original one-line description implied.

- [ ] **Step 3: Add a PROGRESS.md entry**

Follow this repo's established format (see the Collector Foundation, Statusline Feed, and Optimize
Panel entries). Cover: what moved (the 60s dashboard usage scan, not the 1s live-dispatch tick or
anomalies — name the deferral plainly, don't imply full completion); the incremental per-file-offset
design that makes the collector's own transcript scan cheap where the old one wasn't;
`CollectorUsageEvent`'s deliberately narrower shape than `TranscriptEvent` and the resulting
`lastScannedEvents`/Optimize `cwd` tradeoff from Task 8; whatever Task 7's Step 1 spike actually found
about `node:sqlite` under `electron-vite` (confirm or refute the assumption, don't just assert it
worked without saying which path was taken); and the degradation-contract verification result.

- [ ] **Step 4: Commit**

```bash
git add docs/roadmap.md PROGRESS.md
git commit -m "docs: mark Stage 3 shipped (usage scan only; live tick/anomalies explicitly deferred)"
```

---

After all nine tasks: dispatch a whole-branch review (per this project's established pattern)
focused especially on (a) the degradation-contract fallback in Task 8 — confirm it is truly
impossible for `scanAndPushUsage` to ever throw or show an empty/broken dashboard when the collector
isn't running; (b) the `lastScannedEvents`/Optimize `cwd` tradeoff named in Task 8 — confirm it was
actually resolved the way the task describes (a fresh unconditional `scanAllProjects` call feeding
`lastScannedEvents`) and not silently left broken; and (c) whether Task 7's Step 1 spike's finding
about `node:sqlite` under `electron-vite` was honestly reported either way.
