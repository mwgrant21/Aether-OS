# Narration Spine (Stage 11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Layer 1 Phase 0 — `AgentEnvelope`/`ExitState`/`Severity` types, `computeSeverity()`,
`task_kind` capture, fatal-via-staleness detection, and per-run telemetry persisted keyed by
`(agent_id, task_kind)` — into the Node `collector/` package, per
`docs/superpowers/specs/2026-07-31-narration-spine-stage11-design.md`. **Ships zero visible
change**: no voice, no UI, nothing in the chat deck or any `electron/`/`src/` file.

**Architecture:** All new code lives in `collector/`, alongside the existing modules it extends.
One new file (`collector/src/personalitySpine.ts`) holds the types and the pure `computeSeverity`
function; the rest of the work is small, targeted edits to `toolCallHistory.ts`, `usageIngest.ts`,
`transcriptScan.ts`, and `schema.ts`, each read in full before editing (this is a small, dense
codebase where a line-count-guessing edit is more likely to be wrong than reading the file).

## Global Constraints

- `collector-go/` (Stage 10) is explicitly OUT OF SCOPE — do not touch anything under
  `collector-go/`. See the design spec's "Explicitly out of scope" section for why.
- No file under `electron/` or `src/` changes in this plan. If any task finds itself wanting to
  touch one, stop and re-read the design spec — that's a signal the task has drifted out of Stage
  11's scope, not a sign the constraint is wrong.
- `retries` is always `0` and `median_ms_at_eval` is always `null` for every real dispatch this
  stage produces. Do not invent a heuristic for either — this is a decided, named limitation (see
  design spec), not an oversight for an implementer to "improve."
- The existing anomaly detectors (`anomalyIngest.ts`) are NOT touched by this plan. Do not fold
  them into `Finding` objects — decided out of scope with the user.
- Every task that touches `schema.ts` uses the schema Task 1 defines; no later task redefines or
  duplicates a column.
- Run `npm test` (from `collector/`) after every task at minimum for the files that task touched,
  and the full `collector/` suite before any task's commit. Run `npm run build` (or `tsc -b`,
  whichever this package uses — confirm via `package.json`) and confirm clean.

---

### Task 1: Schema v5 — telemetry columns on `dispatches`

**Files:**
- Modify: `collector/src/schema.ts`, `collector/src/schema.test.ts`
- Modify: `collector/src/retention.ts` (only if the new columns change retention behavior — read
  first, see Step 4)

**Interfaces:**
- Produces: `dispatches` table gains `agent_id TEXT`, `task_kind TEXT`, `session_id TEXT`,
  `retries INTEGER NOT NULL DEFAULT 0`, `exit_state TEXT NOT NULL DEFAULT 'ok'`,
  `severity INTEGER`, `median_ms_at_eval INTEGER` — every later task's writes to `dispatches` use
  these exact column names.
- `SCHEMA_VERSION` bumps `4` → `5`.

- [ ] **Step 1: Read the current schema in full**

Read `collector/src/schema.ts` (161 lines) end to end, especially the `dispatches` table
definition (lines 79-86) and the existing migration/versioning pattern (`migrate`, `getSchemaVersion`,
lines 18-127). Also read `collector/src/schema.test.ts` in full to see the existing test shape and
what a version-bump test looks like today (if one exists from the v3→v4 anomaly-index change).

- [ ] **Step 2: Write failing tests**

Add to `schema.test.ts`:
- `migrate` on a fresh DB creates `dispatches` with all seven new columns (query
  `PRAGMA table_info(dispatches)` and assert the full column set, types, and defaults).
- `getSchemaVersion` returns `5` after `migrate`.
- **Backward compatibility**: migrate a DB that already has the v4 `dispatches` table (no new
  columns, real completed-dispatch rows) — confirm `migrate` adds the new columns via `ALTER
  TABLE` without dropping or corrupting existing rows, and that existing rows read back with
  `exit_state = 'ok'` (the correct default — every pre-Stage-11 row represents a real completion)
  and `retries = 0`.
- `migrate` is idempotent — calling it twice does not error and does not attempt to re-add
  already-present columns (SQLite's `ALTER TABLE ADD COLUMN` errors on a duplicate column name,
  so this must be guarded, e.g. checking `PRAGMA table_info` before each `ALTER TABLE`, or
  wrapping in a version-gated block that only runs once per real upgrade).

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd collector && npm test -- schema
```

- [ ] **Step 4: Implement**

Add the seven columns via `ALTER TABLE dispatches ADD COLUMN ...` statements, guarded so they only
run when upgrading from schema version `< 5` (read the existing `migrate` function's structure
first — if prior versions already establish a "only run this block once" pattern for schema
changes past table creation, e.g. the v4 anomaly-index change at lines 101-115, follow that same
pattern rather than inventing a new one). Bump `SCHEMA_VERSION` to `5`. Read `retention.ts:92`'s
`DELETE FROM dispatches WHERE ended_at_ms < ?` — confirm the new columns don't need special
retention handling (they're deleted along with the row, same as `tokens`/`tool_uses` today); if
that's correct, no `retention.ts` change is needed — state that explicitly in the task report
rather than leaving it ambiguous.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd collector && npm test -- schema
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add collector/src/schema.ts collector/src/schema.test.ts
git commit -m "feat(collector): schema v5 -- telemetry columns on dispatches (agent_id, task_kind, session_id, retries, exit_state, severity, median_ms_at_eval)"
```

---

### Task 2: `AgentEnvelope` types + `computeSeverity()`

**Files:**
- Create: `collector/src/personalitySpine.ts`, `collector/src/personalitySpine.test.ts`

**Interfaces:**
- Produces: TS types `Severity`, `ExitState`, `AgentEnvelope<T>`, `Finding`, `Revision`,
  `DecisionRequest` (ported verbatim from `AGENT_PERSONALITY_LAYER_1.md` §3's `AgentEnvelope<T>`
  block), and `function computeSeverity(input: { exit: ExitState; retries: number; elapsedMs:
  number; medianMsAtEval: number | null; findingWeights?: Severity[] }): Severity` — Tasks 4 and 5
  call this to populate the `severity` column.

- [ ] **Step 1: Read the source of truth**

Read `docs/superpowers/specs/AGENT_PERSONALITY_LAYER_1.md` §3 (the full `AgentEnvelope`/`Finding`/
`Revision`/`DecisionRequest` TS block) and §4 (the severity derivation pseudocode and its
surrounding prose, especially the `error`/`fatal` split explanation and the "3× multiplier is a
placeholder, inert until baselines exist" note). Also read this plan's own design spec
(`docs/superpowers/specs/2026-07-31-narration-spine-stage11-design.md`)'s field-mapping table —
`findings`/`revision`/`decision`/`narration` are declared as types here but never populated by
real Stage 11 data; `computeSeverity` still needs to accept a `findingWeights` parameter per §4's
`any(f.weight==3/4)` rule even though Stage 11 never calls it with a non-empty array, so the
function is correct on day one for Stage 12/13 to actually use.

- [ ] **Step 2: Write failing tests**

Port §4's full derivation table into test cases against `computeSeverity`, including:
- No active run → not applicable here (Stage 11 always has a `run`; `sev=0`/idle is a UI-only
  concept per §4's own "no active run" framing — do not implement an idle branch in this pure
  function, document why in a comment if it's tempting to add one).
- `exit:'ok'`, 0 retries, no median → `sev=1`.
- `exit:'fatal'` → `sev=4`, regardless of other inputs (test with retries=0 AND retries=5 to prove
  `fatal` dominates).
- `retries>=2` with `exit:'ok'` → `sev=2` (the `sev+=1` retries branch — dead in real Stage 11 data
  since retries is always 0, but the function itself must be correct per the spec's own table;
  this is what proves it activates automatically once a later stage feeds real retry counts).
- `medianMsAtEval` non-null and `elapsedMs > 3× median` → `sev` bumped by 1 (also currently dead in
  real Stage 11 data since `medianMsAtEval` is always passed `null`, same reasoning).
- `findingWeights` containing a `3` → `sev = max(sev, 3)`; containing a `4` → `sev = max(sev, 4)`.
- Combine two+ triggering conditions and confirm `sev` is clamped to `[0,4]` and reflects the
  `max`/`+=` combination exactly as §4's pseudocode orders it (order matters — the exit-state
  `max()` calls happen after the retries/median `+=` calls in the spec's own pseudocode; a
  re-ordered implementation could produce a different result for some input combinations, so test
  at least one case where order would matter, e.g. `retries>=2` combined with `exit:'partial'`).

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd collector && npm test -- personalitySpine
```

- [ ] **Step 4: Implement**

Port the types and `computeSeverity` faithfully from §3/§4's pseudocode. Keep the function pure
(no DB access, no I/O) — Tasks 4 and 5 are the only callers, and both already have every input
value in hand before calling it.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd collector && npm test -- personalitySpine
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add collector/src/personalitySpine.ts collector/src/personalitySpine.test.ts
git commit -m "feat(collector): AgentEnvelope/ExitState/Severity types, computeSeverity per spec Sec4"
```

---

### Task 3: Capture `task_kind` + `session_id` at dispatch-open time

**Files:**
- Modify: `collector/src/toolCallHistory.ts`, `collector/src/toolCallHistory.test.ts`

**Interfaces:**
- Produces: `ToolCallHistory.openByToolUseId`'s value type gains `subagentType: string | null` and
  `sessionId: string | null` — Tasks 4 and 5 both read these off `history.openByToolUseId[id]`.

- [ ] **Step 1: Read the source of truth**

Read `toolCallHistory.ts` in full (116 lines), especially `updateHistory` (lines 69-107) where
`newOpen[toolUse.id] = { toolName: toolUse.name, filePath, startedAt }` is built, and
`extractFilePath` (lines 109-115) as the pattern to follow for a new `extractSubagentType`
extractor. Confirm the real field name against `collector/src/transcriptScan.test.ts:178` and
`collector/src/usageIngest.test.ts:35-38` — both already use `input: { subagent_type:
'general-purpose' }` as their fixture shape, which is the exact key to read.

- [ ] **Step 2: Write failing tests**

Extend `toolCallHistory.test.ts`: an `Agent`-named tool_use with `input: { subagent_type: 'X' }`
populates `openByToolUseId[id].subagentType === 'X'`; a tool_use with no `subagent_type` (or a
non-`Agent` tool_use) leaves it `null`; `event.sessionId` is captured into
`openByToolUseId[id].sessionId` for every tool_use regardless of tool name (needed later for the
fatal-staleness sweep in Task 5, which must work even though only `Agent`-named entries are ever
swept — capturing it uniformly is simpler than a name-conditional branch and costs nothing).

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd collector && npm test -- toolCallHistory
```

- [ ] **Step 4: Implement**

Add `extractSubagentType(input: unknown): string | null` next to `extractFilePath`, reading
`input.subagent_type`. Extend the `newOpen[toolUse.id] = {...}` assignment to include
`subagentType: extractSubagentType(toolUse.input)` and `sessionId: event.sessionId`. Update the
`ToolCallHistory` interface's `openByToolUseId` value type accordingly.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd collector && npm test -- toolCallHistory
npm run build
```

Also run the FULL `collector/` test suite once here — this is a shared-type change touching a
struct several other modules read (`anomalyIngest.ts`, `usageIngest.ts`), so a narrow test pass
isn't sufficient proof nothing else broke:

```bash
cd collector && npm test
```

- [ ] **Step 6: Commit**

```bash
git add collector/src/toolCallHistory.ts collector/src/toolCallHistory.test.ts
git commit -m "feat(collector): capture subagent_type and sessionId at dispatch-open time"
```

---

### Task 4: Wire `task_kind`/`agent_id`/severity into the real completion path

**Files:**
- Modify: `collector/src/usageIngest.ts`, `collector/src/usageIngest.test.ts`

**Interfaces:**
- Consumes: `computeSeverity` (Task 2), `openByToolUseId[id].subagentType`/`.sessionId` (Task 3).
- Produces: `ingestDispatchEvent`'s INSERT into `dispatches` populates all seven new columns.

- [ ] **Step 1: Read the source of truth**

Read `usageIngest.ts` in full (61 lines), specifically `ingestDispatchEvent` (lines 32-61) — the
`open` variable (line 42, `history.openByToolUseId[dispatchToolUseId]`) already has everything
Task 3 added available on it at this exact call site.

- [ ] **Step 2: Write failing tests**

Extend `usageIngest.test.ts`'s `ingestDispatchEvent` coverage: a real completion (matching the
existing test fixtures' `openDispatch` helper, which already passes `subagent_type:
'general-purpose'`, confirmed above) writes `task_kind = 'general-purpose'`, `agent_id =
'general-purpose'` (same value — see design spec's mapping table for why), `session_id` matching
the event's `sessionId`, `retries = 0`, `exit_state = 'ok'`, `severity = 1` (via `computeSeverity`
with `exit:'ok', retries:0, medianMsAtEval:null` — assert this is exactly what gets passed, not a
hand-rolled duplicate of the severity logic in this file), `median_ms_at_eval = null`. Also test
the `open.subagentType === null` case (no `subagent_type` in the original input) writes `task_kind
= null` / `agent_id = null` rather than throwing or coercing to a placeholder string.

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd collector && npm test -- usageIngest
```

- [ ] **Step 4: Implement**

Extend the `INSERT INTO dispatches (...)` statement (lines 54-59) to include the seven new
columns, sourcing `task_kind`/`agent_id` from `open.subagentType`, `session_id` from
`open.sessionId`, `retries` as the literal `0`, `exit_state` as the literal `'ok'`, and `severity`
from calling `computeSeverity({ exit: 'ok', retries: 0, elapsedMs: durationMs, medianMsAtEval:
null })`. Update the `ON CONFLICT` clause's `DO UPDATE SET` to also update the new columns (same
pattern as the existing `tokens`/`tool_uses`/`duration_ms`/`ended_at_ms` — a dispatch's completion
event should be idempotent to re-ingest, matching the existing conflict-handling philosophy).

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd collector && npm test -- usageIngest
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add collector/src/usageIngest.ts collector/src/usageIngest.test.ts
git commit -m "feat(collector): persist task_kind/agent_id/severity on real dispatch completion"
```

---

### Task 5: Fatal-via-staleness sweep

**Files:**
- Create: `collector/src/staleDispatchSweep.ts`, `collector/src/staleDispatchSweep.test.ts`
- Modify: `collector/src/transcriptScan.ts` (wire the sweep into the existing scan tick)

**Interfaces:**
- Consumes: `history.openByToolUseId` (Task 3's shape), `fleet_sessions` table (existing,
  `schema.ts:61-70`), `computeSeverity` (Task 2).
- Produces: `function sweepStaleDispatches(db: DatabaseSync, history: ToolCallHistory, nowMs:
  number): { staleFound: number }` — writes `exit_state='fatal'` rows into `dispatches` for
  qualifying open entries. `transcriptScan.ts`'s orchestration calls this once per scan tick,
  after its existing ingest work.

- [ ] **Step 1: Read the source of truth**

Read `transcriptScan.ts` in full (137 lines) to find exactly where in its orchestration a new
per-tick sweep call belongs (after transcript ingest, so `history` reflects this tick's state).
Read `fleetPoll.ts`'s `FleetSession` interface and confirm how to query `fleet_sessions` for a
given `session_id`'s `last_seen_ms` (a plain `SELECT last_seen_ms FROM fleet_sessions WHERE
session_id = ?` — no existing helper function for a single-row lookup by ID may exist yet; check,
and only add one if genuinely missing). Read this plan's design spec's "Fatal detection" section
for the exact two conditions (session gone via `last_seen_ms` older than ~30s, OR 30 minutes
elapsed since `started_at_ms` regardless of session state).

- [ ] **Step 2: Write failing tests**

Cover in `staleDispatchSweep.test.ts`:
- An `Agent`-named open entry whose `session_id` has no `fleet_sessions` row at all (never polled,
  or genuinely gone) → written as `fatal` if also past a minimum age (avoid flagging a dispatch
  that opened 2 seconds ago before its session was ever polled once — use a small grace period,
  e.g. require at least one fleet-poll interval, ~15s, before checking session liveness at all).
- An `Agent`-named open entry whose session's `last_seen_ms` is fresh (within ~30s) but has been
  open past the 30-minute fixed timeout → written as `fatal` (the second, session-independent
  condition).
- An `Agent`-named open entry whose session is fresh AND under 30 minutes old → NOT written,
  `staleFound` excludes it.
- A non-`Agent` open entry (any other tool call) is never swept, regardless of age.
- Sweeping twice on the same stale entry doesn't produce two rows or throw (upsert semantics via
  `ON CONFLICT(tool_use_id)`, matching Task 4's INSERT).
- The written `fatal` row's `severity` is exactly `4` (via `computeSeverity({ exit: 'fatal', ... })`
  — assert the real function is called, not a hardcoded `4` duplicating its logic).
- The written row's `duration_ms`/`ended_at_ms` reflect `nowMs` (the moment of detection), not a
  fabricated value — this is what lets Task 1's existing retention logic (`ended_at_ms <
  cutoffMs`) apply uniformly to fatal rows exactly like completed ones.

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd collector && npm test -- staleDispatchSweep
```

- [ ] **Step 4: Implement**

Write `sweepStaleDispatches`. Use the same `INSERT INTO dispatches (...) ON CONFLICT(tool_use_id)
DO UPDATE SET ...` shape Task 4 established, populating `tokens`/`tool_uses` as `0` (unknown for a
dispatch that never completed — do not guess a partial count from `tool_calls` unless the design
spec's mapping table says to; it doesn't), `task_kind`/`agent_id` from
`open.subagentType`, `session_id` from `open.sessionId`, `retries: 0`, `exit_state: 'fatal'`,
`severity` from `computeSeverity`, `median_ms_at_eval: null`. Wire the call into
`transcriptScan.ts`'s existing per-tick orchestration, after its current ingest work, passing the
already-updated `history`.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd collector && npm test -- staleDispatchSweep transcriptScan
npm run build
```

Run the full suite once more here — `transcriptScan.ts` is the collector's central orchestration
point and several existing tests assert its exact behavior per tick:

```bash
cd collector && npm test
```

- [ ] **Step 6: Commit**

```bash
git add collector/src/staleDispatchSweep.ts collector/src/staleDispatchSweep.test.ts collector/src/transcriptScan.ts
git commit -m "feat(collector): fatal-via-staleness sweep for dispatches that never complete"
```

---

### Task 6: End-to-end integration test

**Files:**
- Create: `collector/src/narrationSpine.integration.test.ts` (or fold into `index.test.ts` if that
  file already has an equivalent full-pipeline fixture pattern to extend — check first)

**Interfaces:** None new — this is the acceptance gate for Tasks 1-5 working together.

- [ ] **Step 1: Read `index.test.ts` for the existing full-pipeline test pattern**

Confirm whether an existing test already drives a realistic transcript fixture through
`startCollector` (or the individual scan/ingest functions in sequence) end to end. Reuse that
harness if it exists rather than building a second one.

- [ ] **Step 2: Write the integration test**

One scenario proving a real `sev=1` row: a transcript fixture with an `Agent` tool_use (`input:
{ subagent_type: 'code-reviewer' }`) that opens and completes normally → after running
ingest, `dispatches` has one row with `task_kind='code-reviewer'`, `exit_state='ok'`,
`severity=1`.

One scenario proving a real `sev=4` row: a transcript fixture with an `Agent` tool_use that opens
and never completes, its session's `fleet_sessions` row absent (or `last_seen_ms` old) → after
running the sweep, `dispatches` has one row for that `tool_use_id` with `exit_state='fatal'`,
`severity=4`.

Confirm both rows carry the SAME `agent_id`/`task_kind` value shape (i.e., the two write paths
from Tasks 4 and 5 populate the columns identically, not two subtly different conventions).

- [ ] **Step 3: Run and confirm both pass**

```bash
cd collector && npm test
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add collector/src/narrationSpine.integration.test.ts
git commit -m "test(collector): end-to-end proof of sev=1 (ok completion) and sev=4 (fatal staleness) rows"
```

---

### Task 7: Closeout — roadmap, PROGRESS.md, named deferrals

**Files:**
- Modify: `docs/roadmap.md`
- Modify: `PROGRESS.md`

**Interfaces:** None.

- [ ] **Step 1: Update `docs/roadmap.md` row 11**

Add `**Status: shipped**`, referencing this plan doc, following the exact style of rows 8-10 (e.g.
row 10's `**Status: shipped** — see \`docs/superpowers/plans/2026-07-30-go-collector-stage10.md\`.
...`).

- [ ] **Step 2: Add a `PROGRESS.md` "Shipped plans" entry**

Follow the established style (bold linked title, plan-doc link, prose summary). Name plainly, not
just positively:
- What real data now exists that didn't before (`task_kind`/`agent_id`/`severity`/`exit_state` on
  `dispatches`, keyed for future baseline queries by `(agent_id, task_kind)`).
- The fatal-staleness heuristic's two fixed constants (session-gone threshold, 30-minute timeout)
  are guesses, named as guesses, not measured — worth flagging for future tuning exactly like
  `AGENT_PERSONALITY_LAYER_1.md` §5.3 anticipates for `max_chars`.
- `retries` is always `0` and `median_ms_at_eval` is always `null` for every real row this stage
  produces — both are correctly-typed dead branches in `computeSeverity`, not missing features.
- `collector-go/` parity, Phase 3 baseline calibration, and folding `anomalyIngest.ts` into
  `Finding` objects are all explicitly deferred, not silently dropped — reference the design
  spec's "Explicitly out of scope" section rather than re-explaining inline.
- Confirm and state plainly: zero `electron/`/`src/` files changed, matching Stage 11's "ships
  zero visible change" framing from the roadmap itself.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: Stage 11 (narration spine) shipped -- roadmap/PROGRESS closeout"
```
