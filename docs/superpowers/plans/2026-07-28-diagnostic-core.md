# Diagnostic Core (Stage 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the collector's already-detected diagnostic signal (anomalies, per-tool-call file touches, per-dispatch usage) to SQLite instead of losing it every process restart, and surface it as a dispatch timeline card plus a new Optimize finding for repeated-thrash cost.

**Architecture:** The collector (`collector/`) already tails every project's transcript JSONL incrementally (`transcriptScan.ts`, Stage 3) but only ingests `usage_events`. This stage ports the two already-tested, currently-Electron-only modules — `electron/toolCallHistory.ts` (tool-call open/close tracking, extracts `file_path`) and `src/shared/anomalyDetectors.ts` (the four anomaly rules) — into the collector, so the same detection that already runs live in `electron/liveAgentTracker.ts` also runs headlessly and persists. Three new tables (`tool_calls`, `dispatches`, `anomalies`) are written by a new per-scan-pass ingestion step in `transcriptScan.ts`. The read side follows the exact pattern Stage 3/4 established: a read-only `electron/collectorStore.ts` accessor gated on schema version and returning `null` (not stale/empty data) when the collector is unavailable, pushed to the renderer via a new IPC channel on the existing scan-tick pattern (`scanAndPushFleet` → `scanAndPushDiagnostics`), consumed by a new `useDiagnosticsSync` hook mirroring `useFleetSync`, and rendered by a new `DispatchTimeline` component. A new Optimize rule (`findCostOfThrash`) reuses the ported anomaly detection against the Optimize panel's existing in-memory event window — it does not read from the collector, matching how the other three rules already work.

**Tech Stack:** TypeScript, `node:sqlite` (collector + electron reader), React (renderer), Vitest.

## Global Constraints

- **No raw content in the store.** Per `docs/privacy-and-data.md` §4: file paths, tool names, timestamps, token counts, integers, booleans only. No file contents, no diffs, no command strings, no message text. The "Corollary for Stage 5" note (privacy-and-data.md:127-129) is explicit that any future content-requiring feature (e.g. a diff view) needs its own new privacy analysis — do not widen scope here.
- **File paths stored project-relative, never absolute/home-containing** (privacy-and-data.md §5), mirroring `transcriptScan.ts`'s existing `relativePath` handling for `transcript_files`.
- **Display basenames only** in any UI this stage adds (privacy-and-data.md §5) — use `path.win32.basename`, the same discipline `optimizeRules.ts` already applies.
- **Retention: aggregate rollups survive compaction, raw event rows do not** (privacy-and-data.md §6). This stage's new tables (`tool_calls`, `anomalies`, `dispatches`) must get the same 30-day raw-row deletion `retention.ts`'s `compact()` already does for `events`, with a new daily rollup for anomaly rate (§6 names "Anomaly-rate-over-time and weekly cost-of-thrash need daily aggregates" explicitly).
- **Reader-side null convention**: a collector-unavailable or below-minimum-schema-version condition returns `null`, never `[]` or stale data — the exact distinction `readFleetSessions`/`readUsageEventsSince` already enforce. `[]` means "confirmed zero," `null` means "can't tell."
- **Every new collector table addition bumps `SCHEMA_VERSION`** in `collector/src/schema.ts` (currently 3) and gets a new `MIN_SCHEMA_VERSION_FOR_*` constant on the electron read side, following `MIN_SCHEMA_VERSION_FOR_FLEET_SESSIONS`'s exact precedent.
- Run `npm test` (root) and `collector`'s own `npm test` (from `collector/`) after every task. Run `npx tsc -b` from repo root before every commit.

---

### Task 1: Port tool-use/tool-result parsing into the collector's transcript parser

**Files:**
- Modify: `collector/src/transcriptParser.ts`
- Modify: `collector/src/transcriptParser.test.ts` (create if it does not exist — check first)

**Interfaces:**
- Consumes: nothing new.
- Produces: `TranscriptEvent` (collector's copy) gains `toolUses: TranscriptToolUse[]`, `toolResults: TranscriptToolResult[]`. Later tasks (2, 3) depend on these two fields existing on the collector's `TranscriptEvent`.

The collector's `transcriptParser.ts` is a stripped-down copy of `electron/transcriptParser.ts` that only parses `usage`/`model`/`kind`/`timestamp` — it drops `toolUses`/`toolResults` entirely (confirmed by diffing the two files). Bring it to parity for those two fields only (not `isHumanPrompt`/`humanText`/`originKind` — nothing in this stage needs them; adding unused fields is scope creep).

- [ ] **Step 1: Write the failing test**

Add to `collector/src/transcriptParser.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseTranscriptLine } from './transcriptParser.js';

describe('parseTranscriptLine tool use/result parsing', () => {
  it('extracts toolUses from an assistant message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-28T00:00:00.000Z',
      message: {
        model: 'claude-sonnet-5',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/abs/path/foo.ts' } },
          { type: 'text', text: 'reading' },
        ],
      },
    });
    const event = parseTranscriptLine(line);
    expect(event?.toolUses).toEqual([{ id: 'tu_1', name: 'Read', input: { file_path: '/abs/path/foo.ts' } }]);
  });

  it('extracts toolResults from a user message', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-07-28T00:00:01.000Z',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents here' }],
      },
    });
    const event = parseTranscriptLine(line);
    expect(event?.toolResults).toEqual([{ toolUseId: 'tu_1', resultLength: 21 }]);
  });

  it('returns empty arrays for events with no tool activity', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    const event = parseTranscriptLine(line);
    expect(event?.toolUses).toEqual([]);
    expect(event?.toolResults).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `collector/`): `npx vitest run transcriptParser.test.ts`
Expected: FAIL — `event?.toolUses` is `undefined`, not the expected array.

- [ ] **Step 3: Port the fields**

In `collector/src/transcriptParser.ts`, add the two interfaces (copy verbatim from `electron/transcriptParser.ts:8-17`):

```ts
export interface TranscriptToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface TranscriptToolResult {
  toolUseId: string;
  resultLength: number;
}
```

Add `toolUses: TranscriptToolUse[]` and `toolResults: TranscriptToolResult[]` to the `TranscriptEvent` interface.

In the `type === 'assistant'` branch, before the `return`:

```ts
const toolUses = content
  .filter((item: any) => item.type === 'tool_use')
  .map((item: any) => ({ id: item.id, name: item.name, input: item.input }));
```

(`content` already exists in this branch as `Array.isArray(msg.content) ? msg.content : []` — reuse it.) Add `toolUses` and `toolResults: []` to the returned object.

In the `type === 'user'` branch, before the `return`, the collector's version currently has no `content` extraction at all — add it:

```ts
const content = Array.isArray(msg.content) ? msg.content : [];
const toolResults = content
  .filter((item: any) => item.type === 'tool_result')
  .map((item: any) => ({
    toolUseId: item.tool_use_id,
    resultLength: JSON.stringify(item.content ?? '').length,
  }));
```

Add `toolUses: []` and `toolResults` to that branch's returned object.

Add `toolUses: [], toolResults: []` to the final fallback `kind: 'other'` return.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run transcriptParser.test.ts`
Expected: PASS, all 3 new tests green, and the pre-existing tests in that file still pass.

- [ ] **Step 5: Commit**

```bash
git add collector/src/transcriptParser.ts collector/src/transcriptParser.test.ts
git commit -m "feat(collector): port toolUses/toolResults parsing from electron's transcript parser"
```

---

### Task 2: Schema v4 — add tool_calls, dispatches, anomalies tables

**Files:**
- Modify: `collector/src/schema.ts`
- Modify: `collector/src/schema.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SCHEMA_VERSION = 4`. Three new tables later tasks write to and read from:
  - `tool_calls(id INTEGER PK AUTOINCREMENT, tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, file_path_rel TEXT, started_at_ms INTEGER NOT NULL, closed_at_ms INTEGER NOT NULL)`
  - `dispatches(tool_use_id TEXT PRIMARY KEY, tokens INTEGER NOT NULL, tool_uses INTEGER NOT NULL, duration_ms INTEGER NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER NOT NULL)`
  - `anomalies(id INTEGER PK AUTOINCREMENT, kind TEXT NOT NULL, tool_use_id TEXT NOT NULL, detail TEXT NOT NULL, detected_at_ms INTEGER NOT NULL)`
  - `daily_anomaly_rollups(day TEXT NOT NULL, kind TEXT NOT NULL, anomaly_count INTEGER NOT NULL, PRIMARY KEY (day, kind))`

- [ ] **Step 1: Write the failing test**

Add to `collector/src/schema.test.ts`:

```ts
it('creates tool_calls, dispatches, anomalies, and daily_anomaly_rollups tables at v4', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  expect(getSchemaVersion(db)).toBe(4);

  db.exec(`INSERT INTO tool_calls (tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms)
           VALUES ('tu_1', 'Read', 'src/foo.ts', 1000, 2000)`);
  db.exec(`INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms)
           VALUES ('tu_task_1', 5000, 3, 12000, 1000, 13000)`);
  db.exec(`INSERT INTO anomalies (kind, tool_use_id, detail, detected_at_ms)
           VALUES ('reReadLoop', 'tu_5', 'src/foo.ts read 3 times', 5000)`);
  db.exec(`INSERT INTO daily_anomaly_rollups (day, kind, anomaly_count) VALUES ('2026-07-28', 'reReadLoop', 1)`);

  const toolCall = db.prepare('SELECT * FROM tool_calls').get() as { tool_name: string };
  expect(toolCall.tool_name).toBe('Read');
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `collector/`): `npx vitest run schema.test.ts`
Expected: FAIL — `no such table: tool_calls`.

- [ ] **Step 3: Add the tables and bump the version**

In `collector/src/schema.ts`, change `export const SCHEMA_VERSION = 3;` to `4`, and append to the `db.exec` template literal in `migrate`:

```sql
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_use_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      file_path_rel TEXT,
      started_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dispatches (
      tool_use_id TEXT PRIMARY KEY,
      tokens INTEGER NOT NULL,
      tool_uses INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      started_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS anomalies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      tool_use_id TEXT NOT NULL,
      detail TEXT NOT NULL,
      detected_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_anomaly_rollups (
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      anomaly_count INTEGER NOT NULL,
      PRIMARY KEY (day, kind)
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run schema.test.ts`
Expected: PASS, all existing schema tests still green (existing tables/`getSchemaVersion` behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add collector/src/schema.ts collector/src/schema.test.ts
git commit -m "feat(collector): schema v4 — tool_calls, dispatches, anomalies, daily_anomaly_rollups tables"
```

---

### Task 3: Port `toolCallHistory` + `anomalyDetectors` into the collector and ingest tool_calls/anomalies

**Files:**
- Create: `collector/src/toolCallHistory.ts`
- Create: `collector/src/toolCallHistory.test.ts`
- Create: `collector/src/anomalyIngest.ts`
- Create: `collector/src/anomalyIngest.test.ts`
- Modify: `collector/src/transcriptScan.ts`
- Modify: `collector/src/transcriptScan.test.ts`

**Interfaces:**
- Consumes: `TranscriptEvent.toolUses`/`toolResults` (Task 1), `tool_calls`/`anomalies` tables (Task 2).
- Produces: `ingestToolCallsAndAnomalies(db: DatabaseSync, history: ToolCallHistory, events: TranscriptEvent[], nowMs: number): { history: ToolCallHistory; toolCallsIngested: number; anomaliesIngested: number }` — later tasks (4) call this per scan pass, threading `history` across ticks the same way `spoolTailer`/`transcriptScan` already thread `last_offset`.

`electron/toolCallHistory.ts` and `src/shared/anomalyDetectors.ts` are pure, already-tested, and only import from `./transcriptParser`/`../../electron/toolCallHistory` — both port with zero logic changes, only the relative import path to the collector's own `transcriptParser.ts`. The collector's anomaly detection differs from the live Electron tracker in one respect: it has no `RealActiveWork[]` (that's built from renderer-side dispatch state, not available headlessly), so `detectStalledPermission` is **not** ported here — it stays Electron-only. This is a deliberate scope line, not an oversight: `detectStalledPermission` needs "is this dispatch still open in the live UI," which only the pty-owning Electron process knows (the same reasoning `docs/roadmap.md` already used to defer the 1s live tick to a later stage).

- [ ] **Step 1: Write the failing test for the ported history tracker**

Create `collector/src/toolCallHistory.test.ts` — copy `electron/toolCallHistory.test.ts` verbatim if it exists (check `electron/toolCallHistory.test.ts` first with Read; if no test file exists there, write these three cases fresh):

```ts
import { describe, it, expect } from 'vitest';
import { createEmptyHistory, updateHistory } from './toolCallHistory.js';
import type { TranscriptEvent } from './transcriptParser.js';

function assistantEvent(toolUseId: string, toolName: string, filePath: string | null, timestamp: Date): TranscriptEvent {
  return {
    kind: 'assistant', sessionId: null, timestamp, cwd: null, model: null, usage: null,
    toolUses: [{ id: toolUseId, name: toolName, input: filePath ? { file_path: filePath } : {} }],
    toolResults: [],
  };
}

function userResultEvent(toolUseId: string, timestamp: Date): TranscriptEvent {
  return {
    kind: 'user', sessionId: null, timestamp, cwd: null, model: null, usage: null,
    toolUses: [], toolResults: [{ toolUseId, resultLength: 10 }],
  };
}

describe('collector toolCallHistory', () => {
  it('opens a tool call on tool_use and closes it on the matching tool_result', () => {
    const t0 = new Date('2026-07-28T00:00:00Z');
    const t1 = new Date('2026-07-28T00:00:01Z');
    let history = createEmptyHistory();
    history = updateHistory(history, [assistantEvent('tu_1', 'Read', 'src/foo.ts', t0)], t0.getTime());
    expect(history.events).toEqual([]);
    expect(history.openByToolUseId['tu_1']).toEqual({ toolName: 'Read', filePath: 'src/foo.ts', startedAt: t0.getTime() });

    history = updateHistory(history, [userResultEvent('tu_1', t1)], t1.getTime());
    expect(history.events).toEqual([
      { toolUseId: 'tu_1', toolName: 'Read', filePath: 'src/foo.ts', startedAt: t0.getTime(), closedAt: t1.getTime() },
    ]);
    expect(history.openByToolUseId['tu_1']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `collector/`): `npx vitest run toolCallHistory.test.ts`
Expected: FAIL — `Cannot find module './toolCallHistory.js'`.

- [ ] **Step 3: Port `toolCallHistory.ts`**

Create `collector/src/toolCallHistory.ts` as a byte-for-byte copy of `electron/toolCallHistory.ts`, with only the import path changed:

```ts
import { TranscriptEvent } from './transcriptParser.js';

export interface ClosedToolCall {
  toolUseId: string;
  toolName: string;
  filePath: string | null;
  startedAt: number;
  closedAt: number;
}

export interface ToolCallHistory {
  events: ClosedToolCall[];
  openByToolUseId: Record<string, { toolName: string; filePath: string | null; startedAt: number }>;
}

export const HISTORY_MAX_EVENTS = 500;

export function createEmptyHistory(): ToolCallHistory {
  return { events: [], openByToolUseId: {} };
}

export function updateHistory(
  history: ToolCallHistory,
  events: TranscriptEvent[],
  nowMs: number,
): ToolCallHistory {
  const newOpen = { ...history.openByToolUseId };
  let newEvents = [...history.events];

  for (const event of events) {
    for (const toolUse of event.toolUses) {
      const filePath = extractFilePath(toolUse.input);
      const startedAt = event.timestamp?.getTime() ?? nowMs;
      newOpen[toolUse.id] = { toolName: toolUse.name, filePath, startedAt };
    }

    for (const toolResult of event.toolResults) {
      const open = newOpen[toolResult.toolUseId];
      if (open) {
        const closedAt = event.timestamp?.getTime() ?? nowMs;
        newEvents.push({
          toolUseId: toolResult.toolUseId,
          toolName: open.toolName,
          filePath: open.filePath,
          startedAt: open.startedAt,
          closedAt,
        });
        delete newOpen[toolResult.toolUseId];
      }
    }
  }

  if (newEvents.length > HISTORY_MAX_EVENTS) {
    newEvents = newEvents.slice(newEvents.length - HISTORY_MAX_EVENTS);
  }

  return { events: newEvents, openByToolUseId: newOpen };
}

function extractFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const filePath = obj.file_path;
  if (typeof filePath === 'string') return filePath;
  return null;
}
```

Note: unlike the Electron original, the collector's `extractFilePath` result is later converted to a project-relative path before it's persisted (Step 5 below) — `toolCallHistory.ts` itself stays a pure port with absolute paths in-memory only, matching the original's contract exactly so its test coverage transfers unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run toolCallHistory.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for anomaly ingestion**

Create `collector/src/anomalyIngest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDatabase, migrate } from './schema.js';
import { ingestToolCallsAndAnomalies } from './anomalyIngest.js';
import { createEmptyHistory } from './toolCallHistory.js';
import type { TranscriptEvent } from './transcriptParser.js';

function readEvent(id: string, name: string, path: string, ts: number): TranscriptEvent {
  return {
    kind: 'assistant', sessionId: null, timestamp: new Date(ts), cwd: null, model: null, usage: null,
    toolUses: [{ id, name, input: { file_path: path } }], toolResults: [],
  };
}
function resultEvent(id: string, ts: number): TranscriptEvent {
  return {
    kind: 'user', sessionId: null, timestamp: new Date(ts), cwd: null, model: null, usage: null,
    toolUses: [], toolResults: [{ toolUseId: id, resultLength: 5 }],
  };
}

describe('ingestToolCallsAndAnomalies', () => {
  it('persists closed tool calls and flags a re-read-loop anomaly on the 3rd read', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    let history = createEmptyHistory();

    const events: TranscriptEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(readEvent(`tu_${i}`, 'Read', 'src/foo.ts', 1000 + i * 100));
      events.push(resultEvent(`tu_${i}`, 1050 + i * 100));
    }

    const result = ingestToolCallsAndAnomalies(db, history, events, 2000, 'proj-a');
    history = result.history;

    expect(result.toolCallsIngested).toBe(3);
    expect(result.anomaliesIngested).toBe(1);

    const rows = db.prepare('SELECT tool_name, file_path_rel FROM tool_calls').all() as { tool_name: string; file_path_rel: string }[];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ tool_name: 'Read', file_path_rel: 'src/foo.ts' });

    const anomalies = db.prepare('SELECT kind, detail FROM anomalies').all() as { kind: string; detail: string }[];
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].kind).toBe('reReadLoop');
    expect(anomalies[0].detail).toContain('src/foo.ts');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run anomalyIngest.test.ts`
Expected: FAIL — `Cannot find module './anomalyIngest.js'`.

- [ ] **Step 7: Write `anomalyIngest.ts`**

Create `collector/src/anomalyIngest.ts`. This ports `detectReReadLoop`/`detectWriteDeleteRewrite`/`detectZeroEditBurn` from `src/shared/anomalyDetectors.ts` (excluding `detectStalledPermission` per this task's header note) and adds the persistence step:

```ts
import type { DatabaseSync } from 'node:sqlite';
import { relative } from 'node:path';
import type { TranscriptEvent } from './transcriptParser.js';
import { type ToolCallHistory, type ClosedToolCall, updateHistory } from './toolCallHistory.js';

export interface Anomaly {
  kind: 'reReadLoop' | 'writeDeleteRewrite' | 'zeroEditBurn';
  toolUseId: string;
  detail: string;
}

function detectReReadLoop(events: ClosedToolCall[]): Anomaly[] {
  const byPath = new Map<string, ClosedToolCall[]>();
  for (const event of events) {
    if (event.toolName === 'Read' && event.filePath !== null) {
      if (!byPath.has(event.filePath)) byPath.set(event.filePath, []);
      byPath.get(event.filePath)!.push(event);
    }
  }
  const anomalies: Anomaly[] = [];
  for (const [filePath, reads] of byPath.entries()) {
    if (reads.length >= 3) {
      const mostRecent = reads.reduce((a, b) => (b.closedAt > a.closedAt ? b : a));
      anomalies.push({ kind: 'reReadLoop', toolUseId: mostRecent.toolUseId, detail: `${filePath} read ${reads.length} times` });
    }
  }
  return anomalies;
}

function detectWriteDeleteRewrite(events: ClosedToolCall[], nowMs: number): Anomaly[] {
  const windowStart = nowMs - 300000;
  const byPath = new Map<string, ClosedToolCall[]>();
  for (const event of events) {
    if ((event.toolName === 'Write' || event.toolName === 'Edit') && event.filePath !== null && event.closedAt >= windowStart) {
      if (!byPath.has(event.filePath)) byPath.set(event.filePath, []);
      byPath.get(event.filePath)!.push(event);
    }
  }
  const anomalies: Anomaly[] = [];
  for (const [filePath, writes] of byPath.entries()) {
    if (writes.length >= 3) {
      const mostRecent = writes.reduce((a, b) => (b.closedAt > a.closedAt ? b : a));
      anomalies.push({ kind: 'writeDeleteRewrite', toolUseId: mostRecent.toolUseId, detail: `${filePath} written ${writes.length} times in 5min` });
    }
  }
  return anomalies;
}

function detectZeroEditBurn(events: ClosedToolCall[], tokensUsed: number): Anomaly[] {
  if (tokensUsed < 20000) return [];
  const hasEdits = events.some((e) => e.toolName === 'Write' || e.toolName === 'Edit' || e.toolName === 'NotebookEdit');
  if (!hasEdits) {
    return [{ kind: 'zeroEditBurn', toolUseId: '', detail: `${tokensUsed} tokens used with zero file edits` }];
  }
  return [];
}

function toProjectRelative(filePath: string | null, projectRoot: string): string | null {
  if (filePath === null) return null;
  try {
    const rel = relative(projectRoot, filePath);
    return rel.startsWith('..') ? null : rel;
  } catch {
    return null;
  }
}

export function ingestToolCallsAndAnomalies(
  db: DatabaseSync,
  history: ToolCallHistory,
  events: TranscriptEvent[],
  nowMs: number,
  projectRoot: string,
): { history: ToolCallHistory; toolCallsIngested: number; anomaliesIngested: number } {
  const before = history.events.length;
  const newHistory = updateHistory(history, events, nowMs);
  const newlyClosed = newHistory.events.slice(before === newHistory.events.length ? newHistory.events.length : before);

  const insertToolCall = db.prepare(
    `INSERT INTO tool_calls (tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms) VALUES (?, ?, ?, ?, ?)`
  );
  for (const call of newlyClosed) {
    insertToolCall.run(call.toolUseId, call.toolName, toProjectRelative(call.filePath, projectRoot), call.startedAt, call.closedAt);
  }

  const recentWindow = newHistory.events.filter((e) => e.closedAt >= nowMs - 300000);
  const anomalies = [
    ...detectReReadLoop(recentWindow),
    ...detectWriteDeleteRewrite(recentWindow, nowMs),
    ...detectZeroEditBurn(recentWindow, 0),
  ];
  const insertAnomaly = db.prepare(
    `INSERT INTO anomalies (kind, tool_use_id, detail, detected_at_ms) VALUES (?, ?, ?, ?)`
  );
  for (const a of anomalies) {
    insertAnomaly.run(a.kind, a.toolUseId, a.detail, nowMs);
  }

  return { history: newHistory, toolCallsIngested: newlyClosed.length, anomaliesIngested: anomalies.length };
}
```

`detectZeroEditBurn` is called with `tokensUsed: 0` here deliberately — this ingestion pass has no access to a per-window token total (that's computed separately from `usage_events` in Task 7's Optimize rule, which is the one place `detectZeroEditBurn` genuinely needs live token counts). Wiring a real `tokensUsed` into the collector's own anomaly persistence is out of scope for this task; the `zeroEditBurn` branch here will not fire until a follow-up threads token totals through, and that limitation is intentional, not silently dropped — leave this exact comment in the code.

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run anomalyIngest.test.ts`
Expected: PASS.

- [ ] **Step 9: Wire into `transcriptScan.ts`**

`scanTranscriptsOnce` currently scans per-project-directory and calls `ingestUsageEvent(db, event)` per line. Thread a `ToolCallHistory` map keyed by relative file path (mirroring how `transcript_files` already keys by relative path) through the scan, calling `ingestToolCallsAndAnomalies` alongside the existing `ingestUsageEvent` call:

```ts
import { ingestToolCallsAndAnomalies } from './anomalyIngest.js';
import { createEmptyHistory, type ToolCallHistory } from './toolCallHistory.js';

const historyByFile = new Map<string, ToolCallHistory>();

// inside the per-file loop, after computing `lines`:
const parsedEvents = lines.map((l) => parseTranscriptLine(l)).filter((e): e is NonNullable<typeof e> => e !== null);
for (const event of parsedEvents) {
  if (event && ingestUsageEvent(db, event)) eventsIngested += 1;
}
const priorHistory = historyByFile.get(relativePath) ?? createEmptyHistory();
const { history: newHistory } = ingestToolCallsAndAnomalies(db, priorHistory, parsedEvents, nowMs, dirPath);
historyByFile.set(relativePath, newHistory);
```

`historyByFile` must live outside `scanTranscriptsOnce`'s function body (module-level or passed in as a parameter, matching how `transcript_files`' byte offsets already persist across calls via the DB rather than in-memory) — since `scanTranscriptsOnce` is called fresh on every `setInterval` tick from `index.ts`, an in-memory `Map` declared inside the function would reset every tick and never see history older than one scan pass, silently breaking the 300ms `detectReReadLoop`/5-minute `detectWriteDeleteRewrite` windows. Change `scanTranscriptsOnce`'s signature to accept the map:

```ts
export function scanTranscriptsOnce(
  db: DatabaseSync,
  projectsRoot: string,
  nowMs: number,
  historyByFile: Map<string, ToolCallHistory>,
): { filesScanned: number; eventsIngested: number; toolCallsIngested: number; anomaliesIngested: number }
```

Update `collector/src/transcriptScan.test.ts`'s existing calls to `scanTranscriptsOnce` to pass `new Map()`, and add one new test asserting `toolCallsIngested`/`anomaliesIngested` are non-zero when a fixture transcript file contains 3+ reads of the same path (build the fixture the same way the existing usage-event tests in that file already construct fixture `.jsonl` content — follow that file's existing fixture-writing helper, do not invent a new one).

- [ ] **Step 10: Run the full collector suite**

Run (from `collector/`): `npm test`
Expected: all existing + new tests pass.

- [ ] **Step 11: Update `index.ts`'s call site**

In `collector/src/index.ts`, add `const toolCallHistoryByFile = new Map<string, ToolCallHistory>();` alongside the other `startCollector` state, and pass it to both `scanTranscriptsOnce` calls (the immediate call and the one inside `setInterval`).

- [ ] **Step 12: Commit**

```bash
git add collector/src/toolCallHistory.ts collector/src/toolCallHistory.test.ts collector/src/anomalyIngest.ts collector/src/anomalyIngest.test.ts collector/src/transcriptScan.ts collector/src/transcriptScan.test.ts collector/src/index.ts
git commit -m "feat(collector): persist tool_calls and anomalies from incremental transcript tailing"
```

---

### Task 4: Ingest `dispatches` from Task-completion usage events

**Files:**
- Modify: `collector/src/usageIngest.ts`
- Modify: `collector/src/usageIngest.test.ts`

**Interfaces:**
- Consumes: `dispatches` table (Task 2), `TranscriptEvent.toolUses` (Task 1).
- Produces: `ingestDispatchEvent(db: DatabaseSync, history: ToolCallHistory, event: TranscriptEvent): boolean` — a dispatch row per completed Task tool call.

A dispatch completion is recorded the same way `src/state/liveAgentsMath.ts`'s `applyLinesToOpenDispatches` already detects it: an assistant event whose `usage` is present is the completion signal for whichever `Task` tool call is still open in history at that moment (a subagent's own completion reports its token usage on the *parent* session's next assistant turn, not a separate transcript). Reuse the already-open `Task`-kind entries in `ToolCallHistory.openByToolUseId` to find which dispatch this usage belongs to.

- [ ] **Step 1: Write the failing test**

Add to `collector/src/usageIngest.test.ts`:

```ts
import { createEmptyHistory, updateHistory } from './toolCallHistory.js';

it('ingestDispatchEvent records a dispatches row when a Task tool call is still open', () => {
  const db = openDatabase(':memory:');
  migrate(db);

  let history = createEmptyHistory();
  history = updateHistory(history, [{
    kind: 'assistant', sessionId: null, timestamp: new Date(1000), cwd: null, model: null, usage: null,
    toolUses: [{ id: 'tu_task_1', name: 'Task', input: {} }], toolResults: [],
  }], 1000);

  const completionEvent = {
    kind: 'assistant' as const, sessionId: null, timestamp: new Date(13000), cwd: null,
    model: 'claude-sonnet-5',
    usage: { inputTokens: 4000, outputTokens: 1000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    toolUses: [], toolResults: [],
  };

  const ingested = ingestDispatchEvent(db, history, completionEvent, 'tu_task_1', 3);
  expect(ingested).toBe(true);

  const row = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu_task_1') as
    { tokens: number; tool_uses: number; started_at_ms: number; ended_at_ms: number };
  expect(row.tokens).toBe(5000);
  expect(row.tool_uses).toBe(3);
  expect(row.started_at_ms).toBe(1000);
  expect(row.ended_at_ms).toBe(13000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run usageIngest.test.ts`
Expected: FAIL — `ingestDispatchEvent is not defined`.

- [ ] **Step 3: Write `ingestDispatchEvent`**

Append to `collector/src/usageIngest.ts`:

```ts
import type { ToolCallHistory } from './toolCallHistory.js';

export function ingestDispatchEvent(
  db: DatabaseSync,
  history: ToolCallHistory,
  event: TranscriptEvent,
  dispatchToolUseId: string,
  toolUseCount: number,
): boolean {
  if (event.kind !== 'assistant' || event.usage === null || event.timestamp === null) return false;
  const open = history.openByToolUseId[dispatchToolUseId];
  if (!open || open.toolName !== 'Task') return false;

  const endedAtMs = event.timestamp.getTime();
  const tokens = event.usage.inputTokens + event.usage.outputTokens;

  db.prepare(
    `INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tool_use_id) DO UPDATE SET tokens = excluded.tokens, tool_uses = excluded.tool_uses,
       duration_ms = excluded.duration_ms, ended_at_ms = excluded.ended_at_ms`
  ).run(dispatchToolUseId, tokens, toolUseCount, endedAtMs - open.startedAt, open.startedAt, endedAtMs);
  return true;
}
```

Note this task defines the function but does not yet wire it into `transcriptScan.ts`'s scan loop — that wiring needs the caller to know *which* `Task` tool call a given completion event belongs to and how many tool uses happened inside it, which requires correlating against `liveAgentsMath.ts`'s existing dispatch-boundary detection logic (`originKind === 'task-notification'`). Read `src/state/liveAgentsMath.ts`'s `applyLinesToOpenDispatches` in full before wiring this into the scan loop in Task 5 — do not guess at the correlation logic here.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run usageIngest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add collector/src/usageIngest.ts collector/src/usageIngest.test.ts
git commit -m "feat(collector): add ingestDispatchEvent, wiring deferred to Task 5"
```

---

### Task 5: Wire dispatch ingestion into the scan loop using liveAgentsMath's completion-detection logic

**Files:**
- Read first: `src/state/liveAgentsMath.ts` (full file — this task cannot be scoped further without it)
- Modify: `collector/src/transcriptScan.ts`
- Modify: `collector/src/transcriptScan.test.ts`

**Interfaces:**
- Consumes: `ingestDispatchEvent` (Task 4).
- Produces: `dispatches` table populated during the normal scan tick.

This task is intentionally left as a research-then-implement task rather than pre-written code: `applyLinesToOpenDispatches`' exact correlation logic (how it maps a completion event back to its originating `Task` tool-use id, using `originKind === 'task-notification'`) must be read and matched exactly, not re-derived — a plausible-but-wrong reimplementation would silently misattribute tokens to the wrong dispatch. Once read:

- [ ] **Step 1: Write a failing integration test** in `transcriptScan.test.ts` using a realistic two-line fixture (a `Task` tool_use line, then a later assistant line carrying `usage` and the matching `origin.kind: 'task-notification'` field) asserting a `dispatches` row appears after `scanTranscriptsOnce` runs.
- [ ] **Step 2: Run it, confirm it fails** (`npx vitest run transcriptScan.test.ts`).
- [ ] **Step 3: Call `ingestDispatchEvent` from `scanTranscriptsOnce`'s per-file loop**, using the same correlation rule `applyLinesToOpenDispatches` uses, threading the per-file `ToolCallHistory` from Task 3's Step 9 (already available in scope at that point).
- [ ] **Step 4: Run it, confirm it passes.**
- [ ] **Step 5: Run the full collector suite** (`npm test` from `collector/`) — confirm no regression in the existing usage-event/tool-call/anomaly tests from Tasks 1–4.
- [ ] **Step 6: Commit.**

```bash
git add collector/src/transcriptScan.ts collector/src/transcriptScan.test.ts
git commit -m "feat(collector): wire dispatch ingestion into the transcript scan loop"
```

---

### Task 6: Retention — daily anomaly rollups, raw-row deletion for tool_calls/dispatches/anomalies

**Files:**
- Modify: `collector/src/retention.ts`
- Modify: `collector/src/retention.test.ts`

**Interfaces:**
- Consumes: `tool_calls`, `dispatches`, `anomalies`, `daily_anomaly_rollups` tables (Task 2).
- Produces: `compact()`'s return type gains no new fields (existing `{ rolledUpDays, deletedRows }` stays about `events` only, per the existing convention where each table type has its own counters if needed) — but `compact()` itself now also compacts the three new tables.

Per `docs/privacy-and-data.md` §6: "Anomaly-rate-over-time and weekly cost-of-thrash need daily aggregates, not the underlying tool calls." `anomalies` gets a real rollup (mirroring `events`' rollup-then-delete pattern exactly). `tool_calls` and `dispatches` get **unconditional deletion past the retention window with no rollup** — unlike `anomalies`, there's no meaningful aggregate of "which files were touched" once 30 days have passed; the dispatch timeline is a recent-activity view, not a historical audit log, and `docs/privacy-and-data.md`'s minimize-and-derive stance argues against inventing a rollup shape nothing consumes yet.

- [ ] **Step 1: Write the failing test**

Add to `collector/src/retention.test.ts`:

```ts
it('rolls up anomalies into daily_anomaly_rollups and deletes stale tool_calls/dispatches unconditionally', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  const oldMs = Date.now() - RETENTION_WINDOW_MS - 1000;

  db.exec(`INSERT INTO anomalies (kind, tool_use_id, detail, detected_at_ms) VALUES ('reReadLoop', 'tu_1', 'x', ${oldMs})`);
  db.exec(`INSERT INTO tool_calls (tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms) VALUES ('tu_2', 'Read', 'a.ts', ${oldMs}, ${oldMs})`);
  db.exec(`INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms) VALUES ('tu_3', 100, 1, 500, ${oldMs}, ${oldMs})`);

  compact(db, Date.now());

  expect((db.prepare('SELECT COUNT(*) as c FROM anomalies').get() as { c: number }).c).toBe(0);
  expect((db.prepare('SELECT COUNT(*) as c FROM tool_calls').get() as { c: number }).c).toBe(0);
  expect((db.prepare('SELECT COUNT(*) as c FROM dispatches').get() as { c: number }).c).toBe(0);
  const rollup = db.prepare("SELECT anomaly_count FROM daily_anomaly_rollups WHERE kind = 'reReadLoop'").get() as { anomaly_count: number };
  expect(rollup.anomaly_count).toBe(1);

  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run retention.test.ts`
Expected: FAIL — `daily_anomaly_rollups` has no matching row (anomalies table untouched by `compact()` yet).

- [ ] **Step 3: Extend `compact()`**

Append to `collector/src/retention.ts`'s `compact` function, before its `return` statement:

```ts
  const staleAnomalies = db
    .prepare('SELECT id, kind, detected_at_ms FROM anomalies WHERE detected_at_ms < ?')
    .all(cutoffMs) as { id: number; kind: string; detected_at_ms: number }[];

  if (staleAnomalies.length > 0) {
    const anomalyGroups = new Map<string, number>();
    for (const row of staleAnomalies) {
      const key = `${dayKeyUtc(row.detected_at_ms)}|${row.kind}`;
      anomalyGroups.set(key, (anomalyGroups.get(key) ?? 0) + 1);
    }
    const upsertAnomalyRollup = db.prepare(
      `INSERT INTO daily_anomaly_rollups (day, kind, anomaly_count) VALUES (?, ?, ?)
       ON CONFLICT(day, kind) DO UPDATE SET anomaly_count = anomaly_count + excluded.anomaly_count`
    );
    for (const [key, count] of anomalyGroups.entries()) {
      const [day, kind] = key.split('|');
      upsertAnomalyRollup.run(day, kind, count);
    }
    db.prepare('DELETE FROM anomalies WHERE detected_at_ms < ?').run(cutoffMs);
  }

  // tool_calls/dispatches: unconditional deletion, no rollup -- see this
  // task's own header note for why (recent-activity view, not an audit log).
  db.prepare('DELETE FROM tool_calls WHERE closed_at_ms < ?').run(cutoffMs);
  db.prepare('DELETE FROM dispatches WHERE ended_at_ms < ?').run(cutoffMs);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run retention.test.ts`
Expected: PASS, existing `events`/`drift_log` retention tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add collector/src/retention.ts collector/src/retention.test.ts
git commit -m "feat(collector): retention for tool_calls, dispatches, anomalies (daily rollup for anomalies)"
```

---

### Task 7: Read-only accessors in `electron/collectorStore.ts`

**Files:**
- Modify: `electron/collectorStore.ts`
- Modify: `electron/collectorStore.test.ts`

**Interfaces:**
- Consumes: `tool_calls`, `dispatches`, `anomalies` tables (Task 2), `SCHEMA_VERSION = 4` (Task 2).
- Produces: `readDiagnostics(dbPath: string, sinceMs: number): DiagnosticsSnapshot | null`, where
  ```ts
  export interface DiagnosticsSnapshot {
    toolCalls: { toolUseId: string; toolName: string; filePathRel: string | null; startedAtMs: number; closedAtMs: number }[];
    dispatches: { toolUseId: string; tokens: number; toolUses: number; durationMs: number; startedAtMs: number; endedAtMs: number }[];
    anomalies: { kind: string; toolUseId: string; detail: string; detectedAtMs: number }[];
  }
  ```
  Later tasks (8) consume this exact type from `electron/main.ts`.

- [ ] **Step 1: Write the failing test**

Add to `electron/collectorStore.test.ts`:

```ts
it('readDiagnostics returns null when schema version is below 4', () => {
  const dbPath = makeTempDb(); // reuse this file's existing temp-db test helper
  const db = openDatabase(dbPath); // schema v3 fixture setup, matching existing below-minimum tests in this file
  migrateToVersion(db, 3); // reuse whatever helper the existing MIN_SCHEMA_VERSION_FOR_FLEET_SESSIONS test in this file already uses to pin an old version
  db.close();

  expect(readDiagnostics(dbPath, 0)).toBeNull();
});

it('readDiagnostics returns tool calls, dispatches, and anomalies since the given timestamp', () => {
  const dbPath = makeTempDb();
  const db = openDatabase(dbPath);
  migrate(db);
  db.exec(`INSERT INTO tool_calls (tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms) VALUES ('tu_1', 'Read', 'a.ts', 1000, 2000)`);
  db.exec(`INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms) VALUES ('tu_task', 500, 1, 1000, 1000, 2000)`);
  db.exec(`INSERT INTO anomalies (kind, tool_use_id, detail, detected_at_ms) VALUES ('reReadLoop', 'tu_1', 'a.ts read 3 times', 1500)`);
  db.close();

  const snapshot = readDiagnostics(dbPath, 0);
  expect(snapshot?.toolCalls).toHaveLength(1);
  expect(snapshot?.dispatches).toHaveLength(1);
  expect(snapshot?.anomalies).toHaveLength(1);
});
```

(Match this file's actual existing test-fixture helpers for creating a temp SQLite file and pinning a specific schema version — `readFleetSessions`' own below-minimum-version test already does this; copy that pattern exactly rather than inventing new helper names.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/collectorStore.test.ts`
Expected: FAIL — `readDiagnostics is not defined`.

- [ ] **Step 3: Implement `readDiagnostics`**

Add to `electron/collectorStore.ts`, following `readUsageEventsSince`'s exact shape:

```ts
const MIN_SCHEMA_VERSION_FOR_DIAGNOSTICS = 4;

export interface DiagnosticsSnapshot {
  toolCalls: { toolUseId: string; toolName: string; filePathRel: string | null; startedAtMs: number; closedAtMs: number }[];
  dispatches: { toolUseId: string; tokens: number; toolUses: number; durationMs: number; startedAtMs: number; endedAtMs: number }[];
  anomalies: { kind: string; toolUseId: string; detail: string; detectedAtMs: number }[];
}

export function readDiagnostics(dbPath: string, sinceMs: number): DiagnosticsSnapshot | null {
  const db = openReadOnly(dbPath);
  if (!db) return null;

  try {
    if (schemaVersionOf(db) < MIN_SCHEMA_VERSION_FOR_DIAGNOSTICS) return null;

    const toolCallRows = db
      .prepare('SELECT tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms FROM tool_calls WHERE closed_at_ms >= ?')
      .all(sinceMs) as { tool_use_id: string; tool_name: string; file_path_rel: string | null; started_at_ms: number; closed_at_ms: number }[];

    const dispatchRows = db
      .prepare('SELECT tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms FROM dispatches WHERE ended_at_ms >= ?')
      .all(sinceMs) as { tool_use_id: string; tokens: number; tool_uses: number; duration_ms: number; started_at_ms: number; ended_at_ms: number }[];

    const anomalyRows = db
      .prepare('SELECT kind, tool_use_id, detail, detected_at_ms FROM anomalies WHERE detected_at_ms >= ?')
      .all(sinceMs) as { kind: string; tool_use_id: string; detail: string; detected_at_ms: number }[];

    return {
      toolCalls: toolCallRows.map((r) => ({ toolUseId: r.tool_use_id, toolName: r.tool_name, filePathRel: r.file_path_rel, startedAtMs: r.started_at_ms, closedAtMs: r.closed_at_ms })),
      dispatches: dispatchRows.map((r) => ({ toolUseId: r.tool_use_id, tokens: r.tokens, toolUses: r.tool_uses, durationMs: r.duration_ms, startedAtMs: r.started_at_ms, endedAtMs: r.ended_at_ms })),
      anomalies: anomalyRows.map((r) => ({ kind: r.kind, toolUseId: r.tool_use_id, detail: r.detail, detectedAtMs: r.detected_at_ms })),
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/collectorStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/collectorStore.ts electron/collectorStore.test.ts
git commit -m "feat(electron): readDiagnostics collector-store accessor for tool calls, dispatches, anomalies"
```

---

### Task 8: Push diagnostics to the renderer and render the DispatchTimeline card

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/aetherElectron.d.ts`
- Modify: `src/state/types.ts`
- Modify: `src/state/reducer.ts`
- Create: `src/state/useDiagnosticsSync.ts`
- Create: `src/components/agents/DispatchTimeline.tsx`
- Create: `src/components/agents/DispatchTimeline.test.tsx`
- Modify: `src/components/agents/AgentsView.tsx`

**Interfaces:**
- Consumes: `DiagnosticsSnapshot` (Task 7).
- Produces: `state.diagnostics: DiagnosticsSnapshot | null`, `SET_DIAGNOSTICS` action, `window.aetherElectron.diagnostics.onSnapshot`.

Follow the Stage 4 fleet-sync pattern exactly (`scanAndPushFleet` → `fleet:snapshot` IPC channel → `useFleetSync` → `SET_FLEET` → `FleetCard`), substituting `diagnostics` throughout.

- [ ] **Step 1: Add `scanAndPushDiagnostics` to `electron/main.ts`**

Add a constant `const DIAGNOSTICS_SCAN_INTERVAL_MS = 15000;` near `FLEET_SCAN_INTERVAL_MS` (electron/main.ts:127), and near `scanAndPushFleet` (electron/main.ts:206):

```ts
function scanAndPushDiagnostics(): void {
  if (!mainWindow) return;
  const snapshot = readDiagnostics(collectorDbPath, Date.now() - 24 * 60 * 60 * 1000);
  sendToWindow('diagnostics:snapshot', snapshot);
}
```

(24h lookback: enough for a same-day timeline view without shipping the full 30-day retention window to the renderer on every tick.) Import `readDiagnostics` from `./collectorStore`. Call `scanAndPushDiagnostics(); setInterval(scanAndPushDiagnostics, DIAGNOSTICS_SCAN_INTERVAL_MS);` alongside the existing `scanAndPushFleet()` call site (electron/main.ts:274-275).

- [ ] **Step 2: Add the preload channel**

In `electron/preload.ts`, alongside the existing `fleet` block (line 56), add:

```ts
diagnostics: {
  onSnapshot(callback: (snapshot: DiagnosticsSnapshot | null) => void) {
    const listener = (_event: unknown, snapshot: DiagnosticsSnapshot | null) => callback(snapshot);
    ipcRenderer.on('diagnostics:snapshot', listener);
    return () => ipcRenderer.removeListener('diagnostics:snapshot', listener);
  },
},
```

Import `DiagnosticsSnapshot` from `./collectorStore`.

- [ ] **Step 3: Add the type to `src/aetherElectron.d.ts`**

Mirror the existing `fleet` entry's shape, substituting `diagnostics`/`DiagnosticsSnapshot`.

- [ ] **Step 4: Add state, reducer action, and the sync hook**

In `src/state/types.ts`, add `diagnostics: DiagnosticsSnapshot | null;` to the state interface and import `DiagnosticsSnapshot` from `../../electron/collectorStore`.

In `src/state/reducer.ts`, add `| { type: 'SET_DIAGNOSTICS'; diagnostics: DiagnosticsSnapshot | null }` to the action union (mirroring line 43's `SET_FLEET`) and a `case 'SET_DIAGNOSTICS': return { ...state, diagnostics: action.diagnostics };` (mirroring line 249's `SET_FLEET` case).

Create `src/state/useDiagnosticsSync.ts`:

```ts
import { useEffect } from 'react';
import { useAetherStore } from './store';

export function useDiagnosticsSync() {
  const { dispatch } = useAetherStore();

  useEffect(() => {
    const diagnostics = window.aetherElectron?.diagnostics;
    if (!diagnostics) return;
    return diagnostics.onSnapshot((snapshot) => {
      dispatch({ type: 'SET_DIAGNOSTICS', diagnostics: snapshot });
    });
  }, [dispatch]);
}
```

Call `useDiagnosticsSync()` from wherever `useFleetSync()` is currently called (find that call site and add the new hook next to it).

- [ ] **Step 5: Write the failing component test**

Create `src/components/agents/DispatchTimeline.test.tsx`, mirroring `FleetCard.test.tsx`'s structure (same test-provider/store-mocking setup):

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DispatchTimeline } from './DispatchTimeline';

describe('DispatchTimeline', () => {
  it('shows "collector isn\'t running" when diagnostics is null', () => {
    render(<DispatchTimeline diagnostics={null} />);
    expect(screen.getByText(/collector isn't running/i)).toBeInTheDocument();
  });

  it('shows "No recent activity" when diagnostics is an empty snapshot', () => {
    render(<DispatchTimeline diagnostics={{ toolCalls: [], dispatches: [], anomalies: [] }} />);
    expect(screen.getByText(/no recent activity/i)).toBeInTheDocument();
  });

  it('renders a basename-only file path, never the full relative path with directories collapsed away from view', () => {
    render(
      <DispatchTimeline
        diagnostics={{
          toolCalls: [{ toolUseId: 'tu_1', toolName: 'Read', filePathRel: 'src/deep/nested/foo.ts', startedAtMs: 1000, closedAtMs: 2000 }],
          dispatches: [],
          anomalies: [],
        }}
      />
    );
    expect(screen.getByText('foo.ts')).toBeInTheDocument();
  });

  it('renders an anomaly row with its kind and detail', () => {
    render(
      <DispatchTimeline
        diagnostics={{
          toolCalls: [],
          dispatches: [],
          anomalies: [{ kind: 'reReadLoop', toolUseId: 'tu_1', detail: 'foo.ts read 3 times', detectedAtMs: 1000 }],
        }}
      />
    );
    expect(screen.getByText('foo.ts read 3 times')).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run DispatchTimeline.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `DispatchTimeline.tsx`**

```tsx
import { basename } from 'path-browserify'; // check package.json first: if this dependency doesn't already exist, use a plain string split instead: filePath.split(/[\\/]/).pop()
import type { DiagnosticsSnapshot } from '../../../electron/collectorStore';

export function DispatchTimeline({ diagnostics }: { diagnostics: DiagnosticsSnapshot | null }) {
  if (diagnostics === null) {
    return <div className="dispatch-timeline dispatch-timeline--unavailable">collector isn't running -- diagnostics unavailable</div>;
  }

  const isEmpty = diagnostics.toolCalls.length === 0 && diagnostics.dispatches.length === 0 && diagnostics.anomalies.length === 0;
  if (isEmpty) {
    return <div className="dispatch-timeline dispatch-timeline--empty">No recent activity</div>;
  }

  const items = [
    ...diagnostics.toolCalls.map((t) => ({ atMs: t.closedAtMs, kind: 'toolCall' as const, data: t })),
    ...diagnostics.anomalies.map((a) => ({ atMs: a.detectedAtMs, kind: 'anomaly' as const, data: a })),
  ].sort((a, b) => b.atMs - a.atMs);

  return (
    <div className="dispatch-timeline">
      {items.map((item, i) =>
        item.kind === 'toolCall' ? (
          <div key={`tc-${i}`} className="dispatch-timeline__row dispatch-timeline__row--tool-call">
            <span>{item.data.toolName}</span>
            {item.data.filePathRel && <span>{item.data.filePathRel.split(/[\\/]/).pop()}</span>}
          </div>
        ) : (
          <div key={`an-${i}`} className="dispatch-timeline__row dispatch-timeline__row--anomaly">
            <span>{item.data.kind}</span>
            <span>{item.data.detail}</span>
          </div>
        ),
      )}
    </div>
  );
}
```

Check `package.json` for an existing basename utility before adding the `path-browserify` import — `optimizeRules.ts`'s basename discipline (privacy-and-data.md §5) runs server-side with Node's real `path` module; a renderer component needs a browser-safe equivalent or the plain split shown in the fallback comment. Prefer the plain split unless the codebase already depends on a browser-safe path lib elsewhere in `src/`.

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run DispatchTimeline.test.tsx`
Expected: PASS.

- [ ] **Step 9: Mount it in `AgentsView.tsx`**

Add `<DispatchTimeline diagnostics={state.diagnostics} />` alongside the existing `<FleetCard />` mount in `src/components/agents/AgentsView.tsx` (per PROGRESS.md's Fleet Session Browser entry item (g), `FleetCard` is already appended after `AgentDetailCard` — append `DispatchTimeline` after `FleetCard`, accepting the same known layout quirk noted there rather than restructuring the flex layout as part of this task).

- [ ] **Step 10: Run the full test suite and typecheck**

Run: `npx vitest run` (root) and `npx tsc -b` (root).
Expected: all green, no new type errors.

- [ ] **Step 11: Commit**

```bash
git add electron/main.ts electron/preload.ts src/aetherElectron.d.ts src/state/types.ts src/state/reducer.ts src/state/useDiagnosticsSync.ts src/components/agents/DispatchTimeline.tsx src/components/agents/DispatchTimeline.test.tsx src/components/agents/AgentsView.tsx
git commit -m "feat: push collector diagnostics to renderer, add DispatchTimeline card"
```

---

### Task 9: Optimize rule — `findCostOfThrash`

**Files:**
- Modify: `src/shared/optimizeRules.ts`
- Modify: `src/shared/optimizeRules.test.ts`

**Interfaces:**
- Consumes: `TranscriptEvent[]` (same input every other rule in this file already takes — this rule does **not** read from the collector; it operates on the Optimize panel's existing in-memory event window, exactly like `findOpusOnTrivialTurns`/`findUnpinnedConfigRereads`/`findUncappedBashOutput`).
- Produces: extends `OptimizeFinding['id']` union with `'cost-of-thrash'`, adds an entry to `RULES_BY_ID`.

This rule reuses the re-read/rewrite detection logic already proven in Task 3's `anomalyIngest.ts` port, applied here against the Optimize panel's event window instead of the collector's persisted history — the two run independently (Optimize's existing rules are all self-contained per-rule functions over the same `events` array; this one is no different). Cost is a **rough estimate**, following this file's existing "~4 chars per token" precedent in `findUncappedBashOutput` — extra (beyond-the-first) reads/writes of the same file are charged at a flat per-call token estimate, not a measured cost, because the codebase's transcript format has no way to know how many tokens a given file's content occupies once already in context.

- [ ] **Step 1: Write the failing test**

Add to `src/shared/optimizeRules.test.ts`:

```ts
it('findCostOfThrash flags files re-read 3+ times and estimates weekly cost', () => {
  const windowMs = 60 * 60 * 1000; // 1 hour window
  const events: TranscriptEvent[] = [];
  for (let i = 0; i < 3; i++) {
    events.push({
      kind: 'assistant', sessionId: null, timestamp: new Date(1000 + i * 100), cwd: null, model: 'claude-sonnet-5', usage: null,
      toolUses: [{ id: `tu_${i}`, name: 'Read', input: { file_path: '/proj/src/foo.ts' } }], toolResults: [],
      isHumanPrompt: false, humanText: null, originKind: null,
    });
    events.push({
      kind: 'user', sessionId: null, timestamp: new Date(1050 + i * 100), cwd: null, model: null, usage: null,
      toolUses: [], toolResults: [{ toolUseId: `tu_${i}`, resultLength: 10 }],
      isHumanPrompt: false, humanText: null, originKind: null,
    });
  }

  const findings = evaluateOptimizeRules(events, windowMs);
  const thrash = findings.find((f) => f.id === 'cost-of-thrash');
  expect(thrash).toBeDefined();
  expect(thrash!.detail).toContain('foo.ts');
  expect(thrash!.estSavingsPerWeek).toBeGreaterThan(0);
});

it('findCostOfThrash returns no finding when no file is read/written 3+ times', () => {
  const events: TranscriptEvent[] = [{
    kind: 'assistant', sessionId: null, timestamp: new Date(1000), cwd: null, model: 'claude-sonnet-5', usage: null,
    toolUses: [{ id: 'tu_0', name: 'Read', input: { file_path: '/proj/src/foo.ts' } }], toolResults: [],
    isHumanPrompt: false, humanText: null, originKind: null,
  }];
  const findings = evaluateOptimizeRules(events, 60000);
  expect(findings.find((f) => f.id === 'cost-of-thrash')).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (root): `npx vitest run optimizeRules.test.ts`
Expected: FAIL — `findings.find((f) => f.id === 'cost-of-thrash')` is always `undefined` since the rule doesn't exist yet.

- [ ] **Step 3: Implement `findCostOfThrash`**

Add near the other `find*` functions in `src/shared/optimizeRules.ts`:

```ts
// Rough per-extra-call token estimate for a file already read/written once --
// there is no way to know the file's real size from transcript data alone
// (privacy-and-data.md SS4: content is never stored), so this mirrors
// findUncappedBashOutput's existing "rough estimate" precedent rather than
// pretending to a precision the data doesn't support.
const ESTIMATED_TOKENS_PER_REDUNDANT_TOOL_CALL = 500;
const THRASH_THRESHOLD = 3;

function findCostOfThrash(events: TranscriptEvent[], windowMs: number): OptimizeFinding | null {
  const readCounts = new Map<string, number>();
  const writeCounts = new Map<string, number>();
  const openByToolUseId = new Map<string, { name: string; filePath: string | null }>();

  for (const e of events) {
    if (e.kind === 'assistant') {
      for (const toolUse of e.toolUses) {
        const filePath = stringField(toolUse.input, 'file_path') ?? null;
        openByToolUseId.set(toolUse.id, { name: toolUse.name, filePath });
      }
    }
    if (e.kind === 'user') {
      for (const result of e.toolResults) {
        const open = openByToolUseId.get(result.toolUseId);
        if (!open || !open.filePath) continue;
        if (open.name === 'Read') readCounts.set(open.filePath, (readCounts.get(open.filePath) ?? 0) + 1);
        if (open.name === 'Write' || open.name === 'Edit') writeCounts.set(open.filePath, (writeCounts.get(open.filePath) ?? 0) + 1);
      }
    }
  }

  let redundantCalls = 0;
  const offendingFiles: string[] = [];
  for (const [filePath, count] of readCounts.entries()) {
    if (count >= THRASH_THRESHOLD) {
      redundantCalls += count - 1;
      offendingFiles.push(path.win32.basename(filePath));
    }
  }
  for (const [filePath, count] of writeCounts.entries()) {
    if (count >= THRASH_THRESHOLD) {
      redundantCalls += count - 1;
      offendingFiles.push(path.win32.basename(filePath));
    }
  }

  if (redundantCalls === 0) return null;

  const estimatedTokens = redundantCalls * ESTIMATED_TOKENS_PER_REDUNDANT_TOOL_CALL;
  const estimatedCost = (estimatedTokens / 1_000_000) * PRICING_PER_MILLION_TOKENS.sonnet.input;
  const listed = offendingFiles.slice(0, MAX_LISTED_FILES).join(', ');
  const extra = offendingFiles.length > MAX_LISTED_FILES ? ` (+${offendingFiles.length - MAX_LISTED_FILES} more)` : '';

  return {
    id: 'cost-of-thrash',
    title: 'Cost of thrash',
    detail: `${redundantCalls} redundant read/write calls across ${listed}${extra}`,
    estSavingsPerWeek: extrapolateToWeekly(estimatedCost, windowMs),
    fixText: 'cache file contents across turns instead of re-reading/re-writing the same file repeatedly',
  };
}
```

Add `'cost-of-thrash'` to `OptimizeFinding['id']`'s union type, and add `'cost-of-thrash': findCostOfThrash,` to the `RULES_BY_ID` map.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run optimizeRules.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full root test suite and typecheck**

Run: `npx vitest run` and `npx tsc -b`.
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/shared/optimizeRules.ts src/shared/optimizeRules.test.ts
git commit -m "feat: add cost-of-thrash Optimize finding, sourced from the same re-read/rewrite detection Stage 5 persists"
```

---

### Task 10: Portfolio artifacts (per roadmap §5) and roadmap/PROGRESS closeout

**Files:**
- Modify: `README.md`
- Modify: `docs/roadmap.md`
- Modify: `PROGRESS.md`

Per `docs/roadmap.md` §5: "Schedule these as an explicit task at the end of Stage 5 rather than 'when it's done.'" This closes that gap rather than leaving it implicit.

- [ ] **Step 1: Take a screenshot of the DispatchTimeline card** (with real dispatch/anomaly data visible — run `npm run electron:dev`, generate some Read/Write activity in a tracked session, wait for a scan tick) and save it to `docs/screenshots/dispatch-timeline.png`. Add it to `README.md` near the top, following TokenMonitor's README screenshot placement as the reference (per roadmap §5's explicit comparison).

- [ ] **Step 2: Record a short GIF** of the timeline catching a re-read loop and pricing it (re-read the same file 3+ times in a tracked session, show the anomaly appear in the timeline and the corresponding Optimize finding). Save to `docs/screenshots/dispatch-timeline-catch.gif`, link from `README.md`.

- [ ] **Step 3: Update `docs/roadmap.md`'s Stage 5 row** to `**Status: shipped**`, matching the exact phrasing convention Stage 3/4's rows already use, with a one-line pointer to this plan file.

- [ ] **Step 4: Add a PROGRESS.md entry** for Stage 5 following the established convention in that file (see the Stage 4 entry added by this repo's most recent merge for the exact voice/structure/lettered-subpoints convention) — name plainly what shipped (`tool_calls`/`dispatches`/`anomalies` persistence, `DispatchTimeline`, `cost-of-thrash`) and what's explicitly deferred (`detectStalledPermission` stays Electron-only per Task 3's scope note; `zeroEditBurn` doesn't yet fire from the collector's own ingestion per Task 3 Step 7's note).

- [ ] **Step 5: Final whole-repo verification pass**

Run from repo root: `npx tsc -b`, `npm run build`, `npm run electron:build`, `npx vitest run`. Run from `collector/`: `npm run build`, `npm test`. Confirm all green before the closing commit.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/roadmap.md PROGRESS.md docs/screenshots/
git commit -m "docs: Stage 5 (Diagnostic core) shipped — portfolio screenshot, GIF, roadmap/PROGRESS closeout"
```
