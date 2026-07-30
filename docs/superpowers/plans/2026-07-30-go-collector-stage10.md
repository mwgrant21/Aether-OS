# Go Collector (Stage 10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Node `collector/` package to a new, sibling `collector-go/` package in Go,
byte-for-byte compatible with the existing SQLite schema and file-spool contract, per
`docs/superpowers/specs/2026-07-30-go-collector-stage10-design.md`.

**Architecture:** One Go module (`collector-go/`), package-per-responsibility matching the
design spec's module table. Each task ports one TS module (or a tightly-coupled cluster) by
reading the TS source AND its existing test file as the behavior source of truth — this plan
does not pre-write untested Go source, since the only verified-correct behavior is what's
already encoded in the Node implementation and its 2,608 lines of existing tests. Golden-file
parity (Task 9) is the acceptance gate, not any single task's own tests.

**Tech Stack:** Go 1.26 (verified installed this session — `go version` → `go1.26.5
windows/amd64`), `modernc.org/sqlite` (pure Go, no CGO), Go standard library only otherwise.

## Global Constraints

- **Go is newly installed on this machine** (`C:\Program Files\Go\bin`, not yet on PATH in
  fresh shells). Every Bash command in every task must be prefixed with:
  `export PATH="/c/Program Files/Go/bin:$PATH"` — this is not optional, `go` will not be found
  otherwise. State this exact prefix requirement to every dispatched implementer.
- `collector-go/` is a NEW sibling directory to the existing `collector/` (Node) — do not modify
  or delete anything under `collector/` in this plan. Both coexist; the cutover/retirement
  decision is explicitly out of scope (see design spec's Out of Scope section).
- `memoryStore.ts`/`memoryStore.test.ts` (758 lines, currently untracked/uncommitted in the
  main checkout) is CONFIRMED out of scope — it's a separate, unrelated, in-progress "Layer 2
  memory" feature, not part of the shipped Stage 2 contract. Do not port it, do not reference it.
- No feature changes, no schema changes, no behavior changes beyond what's needed for a
  faithful port. If a task's implementer notices something they'd want to fix or improve in the
  Go version, they must NOT do it silently — name it in their report as a deferred follow-up.
- The SQLite schema (11 tables, `SCHEMA_VERSION = 4`) is defined once in Task 1 and must never
  be redefined or duplicated by a later task — every later task that touches the database uses
  the schema Task 1 created.
- Run `go build ./...` and `go vet ./...` in `collector-go/` after every task; run `go test
  ./...` for the packages that task touched at minimum, and the full `go test ./...` before
  any task's commit.

---

### Task 1: Go module init + schema port

**Files:**
- Create: `collector-go/go.mod`, `collector-go/go.sum`
- Create: `collector-go/internal/schema/schema.go`
- Create: `collector-go/internal/schema/schema_test.go`

**Interfaces:**
- Produces: `func OpenDatabase(dbPath string) (*sql.DB, error)`, `func Migrate(db *sql.DB)
  error`, `func GetSchemaVersion(db *sql.DB) (int, error)`, `func StampFleetHeartbeat(db
  *sql.DB, nowMs int64) error`, `func StampTranscriptScanHeartbeat(db *sql.DB, nowMs int64)
  error`, and `const SchemaVersion = 4` — every later task's Go code that touches the database
  imports this package and uses these functions; do not let a later task open its own
  connection or redefine the schema.

- [ ] **Step 1: Initialize the Go module**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os
mkdir -p collector-go/internal/schema
cd collector-go
go mod init github.com/mwgrant21/aether-os/collector-go
go get modernc.org/sqlite
```

Confirm `go.mod`/`go.sum` were created and `modernc.org/sqlite` appears in `go.mod`'s require
block.

- [ ] **Step 2: Read the TS source of truth**

Read `C:/Users/Matt/projects/aether-os/collector/src/schema.ts` in full (160 lines) — this is
the exact schema to port. The 11 `CREATE TABLE IF NOT EXISTS` statements (lines 20-99) are
plain SQL, portable verbatim with zero translation needed. Also read the anomaly-dedup index
block (lines 101-115) and both heartbeat-stamp functions (lines 129-160) — their doc comments
explain WHY each exists; port the comments too, not just the code, since they document real
prior incidents (a shipped bug this project fixed, per the comments' own references).

- [ ] **Step 3: Write the failing test**

Create `collector-go/internal/schema/schema_test.go` covering:
- `OpenDatabase` + `Migrate` on a fresh temp-dir path succeeds and creates all 11 tables (query
  `sqlite_master` for `type='table'` and assert the full expected name set).
- `GetSchemaVersion` returns `4` after `Migrate`.
- `GetSchemaVersion` on a database with no `schema_meta` row returns `0` (not an error) —
  matches `schema.ts:122-127`'s `row ? Number(row.value) : 0` fallback exactly.
- `StampFleetHeartbeat`/`StampTranscriptScanHeartbeat` each write a value into `schema_meta`
  under the correct key (`'fleet_last_poll_ms'` / `'transcript_last_scan_ms'`) that a
  subsequent read confirms, and that calling twice with different values updates (not
  duplicates) the row — matches the `ON CONFLICT(key) DO UPDATE` upsert semantics in
  `schema.ts:139-142,156-159`.
- `Migrate` is idempotent — calling it twice on the same database does not error and does not
  duplicate the anomaly-dedup unique index (`schema.ts:113-114`'s `IF NOT EXISTS`).

- [ ] **Step 4: Run the test to verify it fails**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os/collector-go
go test ./internal/schema/...
```
Expected: FAIL — `schema.go` doesn't exist yet.

- [ ] **Step 5: Implement `schema.go`**

Port `schema.ts` faithfully into `collector-go/internal/schema/schema.go`, using
`database/sql` with `modernc.org/sqlite`'s driver (import path `_
"modernc.org/sqlite"`, driver name `"sqlite"`). `OpenDatabase` must create the parent
directory if it doesn't exist (matches `schema.ts:14`'s `mkdirSync(dirname(dbPath), {
recursive: true })` — Go equivalent: `os.MkdirAll(filepath.Dir(dbPath), 0755)`).

- [ ] **Step 6: Run the test to verify it passes**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os/collector-go
go test ./internal/schema/... -v
go build ./...
go vet ./...
```
Expected: PASS, clean build, clean vet.

- [ ] **Step 7: Commit**

```bash
git add collector-go/
git commit -m "feat(collector-go): initialize Go module, port SQLite schema (11 tables, v4)"
```

---

### Task 2: Spool ingest port (spoolTailer + hookPayload + ingest)

**Files:**
- Create: `collector-go/internal/spool/tailer.go`, `collector-go/internal/spool/payload.go`, `collector-go/internal/spool/ingest.go`
- Create: matching `_test.go` files for each

**Interfaces:**
- Consumes: `schema.OpenDatabase`/`schema.Migrate` from Task 1.
- Produces: `func StartSpoolTailer(db *sql.DB, spoolDir string, tailInterval time.Duration)
  (stop func())`, `func ParseHookPayload(line []byte) (*HookEvent, error)`, `func
  IngestHookEvent(db *sql.DB, event *HookEvent, nowMs int64) error` — Task 8 (main
  orchestration) wires `StartSpoolTailer` into the collector's startup sequence.

- [ ] **Step 1: Read the TS source of truth**

Read all three files in full: `collector/src/spoolTailer.ts` (53 lines — watches the spool
dir, tails new `.jsonl` files, deletes consumed files), `collector/src/hookPayload.ts` (49
lines — parses one hook-event JSON line into a typed row), `collector/src/ingest.ts` (58
lines — writes a parsed event into the `events` table and updates `daily_rollups`). Also read
their three test files (`*.test.ts`) in full — they are the exact behavior contract, including
edge cases (malformed lines, missing fields) that must port faithfully.

- [ ] **Step 2: Write failing tests**

Port every test case from the three `*.test.ts` files into Go, using `testing.T` and temp
directories/files (`t.TempDir()`) for filesystem-dependent cases. Do not skip edge-case tests
just because they're harder to port — a skipped edge case is a silent behavior gap in the port.

- [ ] **Step 3: Run tests to verify they fail**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os/collector-go
go test ./internal/spool/...
```

- [ ] **Step 4: Implement**

Port `spoolTailer.ts`/`hookPayload.ts`/`ingest.ts` faithfully. For file watching, check what
`spoolTailer.ts` actually does (polling on an interval, per its `tailIntervalMs` parameter
name, vs. real OS-level fs events) before choosing a Go approach — match the TS behavior
exactly (if it's poll-based, a Go `time.Ticker` re-reading the directory listing is the correct
port, not an `fsnotify`-based rewrite that changes timing behavior).

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os/collector-go
go test ./internal/spool/... -v
go build ./...
go vet ./...
```

- [ ] **Step 6: Commit**

```bash
git add collector-go/
git commit -m "feat(collector-go): port spool ingest (tailer, hook payload parsing, event ingest)"
```

---

### Task 3: Transcript parsing + tailing port

**Files:**
- Create: `collector-go/internal/transcript/parser.go`, `collector-go/internal/transcript/tailer.go`
- Create: matching `_test.go` files

**Interfaces:**
- Consumes: `schema` package from Task 1.
- Produces: types and functions matching `transcriptParser.ts`'s exports (read the file to
  get exact names — likely a `ParseTranscriptLine` function and typed event structs) and
  `transcriptTailer.ts`'s byte-offset-aware reader — Task 4 (transcript scan orchestration)
  consumes both.

- [ ] **Step 1: Read the TS source of truth**

Read `collector/src/transcriptParser.ts` (129 lines) and `collector/src/transcriptTailer.ts`
(22 lines) in full, plus their test files. `transcriptParser.ts` is the most behaviorally
subtle file in this port — `PROGRESS.md`'s Stage 5 entry documents a real, hard-won correction
here (dispatch-completion detection originally assumed the wrong signal shape; the actual
mechanism is a `'user'`-kind event with `originKind: 'task-notification'`, XML-tagged
completion data in `humanText`, dispatch opens tracked under tool name `'Agent'` not `'Task'`).
Read that PROGRESS.md entry (search for "Stage 5" and "dispatch-completion") before porting
this file — the Go port must replicate the CORRECTED behavior, not a naive re-derivation that
could re-introduce the original wrong assumption.

- [ ] **Step 2: Write failing tests**

Port every test case from both `.test.ts` files, with special attention to whatever fixture(s)
prove the dispatch-completion signal shape correction above — that test case is the single most
important one to get right.

- [ ] **Step 3: Run tests to verify they fail**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os/collector-go
go test ./internal/transcript/...
```

- [ ] **Step 4: Implement**

Port both files faithfully, preserving the corrected dispatch-completion logic exactly.

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os/collector-go
go test ./internal/transcript/... -v
go build ./...
go vet ./...
```

- [ ] **Step 6: Commit**

```bash
git add collector-go/
git commit -m "feat(collector-go): port transcript parser and byte-offset tailer"
```

---

### Task 4: Transcript scan orchestration + usage ingest + tool-call history

**Files:**
- Create: `collector-go/internal/transcript/scan.go`, `collector-go/internal/transcript/usage.go`, `collector-go/internal/transcript/toolcallhistory.go`
- Create: matching `_test.go` files

**Interfaces:**
- Consumes: `schema` (Task 1), the parser/tailer from Task 3.
- Produces: `func ScanTranscriptsOnce(db *sql.DB, projectsRoot string, nowMs int64,
  toolCallHistoryByFile map[string]*ToolCallHistory) error` (matching `transcriptScan.ts`'s
  signature shape) — Task 8 wires this into the collector's periodic scan loop.

- [ ] **Step 1: Read the TS source of truth**

Read `collector/src/transcriptScan.ts` (137 lines — orchestrates: discover project dirs, tail
each via Task 3's tailer, parse via Task 3's parser, ingest, update `transcript_files`),
`collector/src/usageIngest.ts` (61 lines — writes `usage_events` rows), and
`collector/src/toolCallHistory.ts` (115 lines — in-memory ring buffer per session, feeds
anomaly detection in Task 5), plus all three test files.

- [ ] **Step 2: Write failing tests**

Port every test case, including `transcriptScan.ts`'s incremental-rescan behavior (only
ingesting newly-appended lines on a second call, per its own test coverage per
`PROGRESS.md`'s Stage 3 entry description).

- [ ] **Step 3: Run tests to verify they fail**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os/collector-go
go test ./internal/transcript/...
```

- [ ] **Step 4: Implement**

Port all three files faithfully.

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os/collector-go
go test ./internal/transcript/... -v
go build ./...
go vet ./...
```

- [ ] **Step 6: Commit**

```bash
git add collector-go/
git commit -m "feat(collector-go): port transcript scan orchestration, usage ingest, tool-call history"
```

---

### Task 5: Anomaly detection port

**Files:**
- Create: `collector-go/internal/anomaly/ingest.go`
- Create: `collector-go/internal/anomaly/ingest_test.go`

**Interfaces:**
- Consumes: `schema` (Task 1), `ToolCallHistory` from Task 4.
- Produces: matching `anomalyIngest.ts`'s exported detector functions and the `INSERT OR
  IGNORE`-based dedup write path.

- [ ] **Step 1: Read the TS source of truth**

Read `collector/src/anomalyIngest.ts` (114 lines) in full, plus its test file. Pay attention to
`schema.ts:101-115`'s comment about anomaly dedup: detectors re-scan a rolling 5-minute window
on every ~15s tick, so the same real anomaly gets re-detected ~20 times — the unique index on
`(kind, tool_use_id)` plus `INSERT OR IGNORE` (not a plain `INSERT`) is what collapses that to
one row. The Go port must use the SQLite equivalent (`INSERT OR IGNORE INTO anomalies ...`,
same semantics) — a plain insert here would silently reintroduce duplicate rows.

- [ ] **Step 2: Write failing tests**

Port every test case, including one that explicitly proves the dedup behavior (insert the same
anomaly twice, assert only one row exists).

- [ ] **Step 3: Run tests to verify they fail**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os/collector-go
go test ./internal/anomaly/...
```

- [ ] **Step 4: Implement**

Port faithfully, using `INSERT OR IGNORE`.

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os/collector-go
go test ./internal/anomaly/... -v
go build ./...
go vet ./...
```

- [ ] **Step 6: Commit**

```bash
git add collector-go/
git commit -m "feat(collector-go): port anomaly detectors with INSERT OR IGNORE dedup"
```

---

### Task 6: Fleet polling port

**Files:**
- Create: `collector-go/internal/fleet/poll.go`, `collector-go/internal/fleet/ownsession.go`
- Create: matching `_test.go` files

**Interfaces:**
- Consumes: `schema` (Task 1).
- Produces: matching `fleetPoll.ts`'s `pollFleet`/`upsertFleetSessions` (injectable exec
  function for testability, same pattern the TS uses per `index.ts:9`'s `FleetExecFn` type)
  and `ownSessionFile.ts`'s `readOwnSessionId` — Task 8 wires both into the collector's
  periodic fleet-poll loop.

- [ ] **Step 1: Read the TS source of truth**

Read `collector/src/fleetPoll.ts` (128 lines — shells out to `claude agents --json`, parses,
upserts `fleet_sessions`) and `collector/src/ownSessionFile.ts` (13 lines), plus both test
files. Note the injectable-exec-function pattern (`index.ts:16-19`'s `FleetExecFn` type) —
port this as an injectable `func(...) ([]byte, error)` parameter in Go so tests can stub the
`claude agents --json` subprocess call without actually shelling out, matching the TS test
suite's approach exactly (needed to port those tests faithfully).

- [ ] **Step 2: Write failing tests**

Port every test case, including the malformed-row handling (`PROGRESS.md`'s Stage 2 entry
mentions a `drift_log` row logged per malformed `claude agents --json` row — that's this
file's `drift_log` write path, must be preserved).

- [ ] **Step 3: Run tests to verify they fail**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os/collector-go
go test ./internal/fleet/...
```

- [ ] **Step 4: Implement**

Port faithfully, including the injectable exec function and `drift_log` write on malformed rows.

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os/collector-go
go test ./internal/fleet/... -v
go build ./...
go vet ./...
```

- [ ] **Step 6: Commit**

```bash
git add collector-go/
git commit -m "feat(collector-go): port fleet polling (claude agents --json) and own-session exclusion"
```

---

### Task 7: Retention + hook installer + autostart + canary port

**Files:**
- Create: `collector-go/internal/retention/retention.go`
- Create: `collector-go/internal/hookinstall/installer.go`
- Create: `collector-go/internal/autostart/autostart.go`
- Create: `collector-go/internal/canary/canary.go`
- Create: matching `_test.go` files for each

**Interfaces:**
- Consumes: `schema` (Task 1) for retention only.
- Produces: matching each TS module's exported functions — Task 8 (CLI) wires
  `hookinstall`/`autostart` in, Task 8 (main) wires `retention`/`canary` in.

This task bundles four smaller, mostly-independent modules (95 + 276 + 41 + 38 = 450 lines)
since none depends on another and each is small enough that a separate task per file would be
sub-task-sized noise. If any one of them turns out to be larger or more subtle than its line
count suggests once read, it's fine to split it into its own follow-up task rather than forcing
it into this one — note that decision in the task's report if it happens.

- [ ] **Step 1: Read the TS sources of truth**

Read all four files and their test files in full: `collector/src/retention.ts` (95 lines —
daily rollup compaction, per-table retention policy), `collector/src/hookInstaller.ts` (276
lines — merges hook config into Claude Code's `settings.json`, install/uninstall, two
independently-installable hook groups per its own header comment about `MANAGED_HOOK_EVENTS`
vs `PERMISSION_HOOK_EVENTS`), `collector/src/autostart.ts` (41 lines — OS-level autostart
registration, Windows-specific per prior stages' documented platform scope), `collector/src/canary.ts`
(38 lines — liveness/self-check).

- [ ] **Step 2: Write failing tests**

Port every test case from all four `.test.ts` files.

- [ ] **Step 3: Run tests to verify they fail**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os/collector-go
go test ./internal/retention/... ./internal/hookinstall/... ./internal/autostart/... ./internal/canary/...
```

- [ ] **Step 4: Implement**

Port all four faithfully. `hookInstaller.ts`'s JSON-merge logic (reading/writing Claude Code's
real `settings.json`, preserving unrelated keys/hook groups) is the highest-risk file in this
batch — a bug here could corrupt a real user's Claude Code settings. Test against a realistic
fixture `settings.json` with pre-existing unrelated hook groups, not just an empty file.

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os/collector-go
go test ./internal/retention/... ./internal/hookinstall/... ./internal/autostart/... ./internal/canary/... -v
go build ./...
go vet ./...
```

- [ ] **Step 6: Commit**

```bash
git add collector-go/
git commit -m "feat(collector-go): port retention, hook installer, autostart, canary"
```

---

### Task 8: CLI + main orchestration

**Files:**
- Create: `collector-go/cmd/aether-collector/main.go`
- Create: `collector-go/cmd/aether-collector-cli/main.go`
- Create: `collector-go/internal/collector/collector.go` (the `StartCollector`-equivalent orchestration logic, separated from `main.go` so it's testable)
- Create: `collector-go/internal/collector/collector_test.go`

**Interfaces:**
- Consumes: every package from Tasks 1-7.
- Produces: two real binaries (`aether-collector`, `aether-collector-cli`), matching the two
  Node entrypoints (`index.ts`'s main process, `cli.ts`'s CLI).

- [ ] **Step 1: Read the TS sources of truth**

Read `collector/src/index.ts` (100 lines — full detail already extracted in the design spec's
Context section) and `collector/src/cli.ts` (74 lines) in full, plus `index.ts`'s test file.

- [ ] **Step 2: Write failing tests**

Port `index.ts`'s test coverage for `startCollector`'s orchestration logic (the injectable,
testable core — matching `index.ts`'s own separation between the exported `startCollector`
function and the `isMainModule` guard block that only runs in the real process). Test that:
starting the collector opens the DB, migrates it, and starts all four loops (spool tail,
compact, transcript scan, fleet poll); that stopping it (the returned `stop func()`) actually
halts all four and closes the DB; that a failure in one loop (e.g. fleet poll erroring) doesn't
crash the others — matches `index.ts:56-63`'s `.catch()`-wrapped fleet poll calls.

- [ ] **Step 3: Run tests to verify they fail**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os/collector-go
go test ./internal/collector/...
```

- [ ] **Step 4: Implement**

Port `index.ts`'s orchestration into `internal/collector/collector.go` as a `StartCollector`
function returning a stop function (or, more idiomatically for Go, a `context.CancelFunc` plus
a `sync.WaitGroup`/error channel — your call on the most natural Go shape, as long as the
observable behavior matches: all four loops start, all four loops stop cleanly, one loop's
error doesn't kill the others). `cmd/aether-collector/main.go` is a thin wrapper: parse the
same options `index.ts:79-89` hardcodes (paths under `~/.aether-os`, `~/.claude/projects`,
the same interval values: 2000ms tail, hourly compact, 15000ms transcript scan, 15000ms fleet
poll), call `StartCollector`, and handle `SIGINT`/`SIGTERM` for graceful shutdown (Go's
`os/signal` package, matching `index.ts:93-99`'s `process.on` handlers).

`cmd/aether-collector-cli/main.go` ports `cli.ts`'s install/uninstall/status commands, wiring
into Task 7's `hookinstall`/`autostart` packages.

- [ ] **Step 5: Run tests to verify they pass, then a real smoke run**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os/collector-go
go test ./... -v
go build ./...
go vet ./...
go build -o /tmp/aether-collector-go.exe ./cmd/aether-collector
```

Then run the built binary against a temp `--dbPath`-equivalent (however you wired the option
parsing — a flag, an env var, or a hardcoded temp-dir override for this smoke test) for a few
seconds, confirm it logs a startup message, doesn't crash, and produces a valid SQLite file
with all 11 tables when inspected. Kill it and confirm it shuts down cleanly on SIGINT (Go's
`os.Interrupt` — on Windows this needs testing since SIGINT emulation differs from POSIX; note
in your report if Windows-specific signal handling needs a follow-up).

- [ ] **Step 6: Commit**

```bash
git add collector-go/
git commit -m "feat(collector-go): port CLI and main orchestration (StartCollector, both entrypoints)"
```

---

### Task 9: Golden-file parity verification + closeout

**Files:**
- Create: `collector-go/parity_test.go` (or a `scripts/` helper, whichever fits better once you see what's needed)
- Modify: `PROGRESS.md`
- Modify: `docs/roadmap.md`

**Interfaces:** None new — this is the acceptance gate for everything built in Tasks 1-8.

- [ ] **Step 1: Build both collectors**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os/collector
npm run build
cd ../collector-go
go build -o /tmp/aether-collector-go.exe ./cmd/aether-collector
```

- [ ] **Step 2: Run both against the same fixture inputs, diff the output**

Construct (or reuse, if the existing TS test suites already have one) a realistic fixture: a
spool directory with a handful of hook-event `.jsonl` lines, and a small transcript directory
tree with a few sessions' worth of `.jsonl` files. Run the Node collector against it pointed at
`dbA.sqlite`, run the Go collector against the identical fixture pointed at `dbB.sqlite`. Diff
every table row-for-row EXCLUDING autoincrement `id` columns and any inherently
non-deterministic timestamp columns that reflect wall-clock time at ingest (document exactly
which columns you exclude and why for each table). Any row-level divergence beyond the excluded
columns is a real bug in the port — find it, fix it in the relevant earlier task's package
(not by patching over it here), and re-run this comparison until it's clean.

- [ ] **Step 3: Confirm the reader side is unaffected**

Point `electron/collectorStore.ts` (read-only, via the existing Electron app — you do not need
to modify this file) at the Go collector's output `collector.db` instead of the Node
collector's, and confirm the app's Dashboard/Agents/Grid views render identically to pointing
it at the Node collector's output. If this development environment is headless (check per this
project's established practice — prior stages found this varies session to session), state
that plainly rather than skipping the check silently; if a display is available, actually do
it and report what you saw.

- [ ] **Step 4: Full verification**

```bash
export PATH="/c/Program Files/Go/bin:$PATH"
cd C:/Users/Matt/projects/aether-os/collector-go
go test ./... -v
go build ./...
go vet ./...
cd ../collector
npm test
```
All must be green.

- [ ] **Step 5: Update `docs/roadmap.md`**

Change row 10 to add a `**Status: shipped**` marker (drop the `*(optional)*` framing since it
now describes something that exists, not a hypothetical), referencing this plan:

```
| **10** | **Go collector** | **Status: shipped** — see `docs/superpowers/plans/2026-07-30-go-collector-stage10.md`. Drop-in swap behind the Stage 2 contract, coexisting with the Node collector; cutover/retirement is a separate, later decision. | ~6 tasks |
```

- [ ] **Step 6: Add a `PROGRESS.md` "Shipped plans" entry**

Add a new bullet at the top of the `## Shipped plans (newest first)` list, following the
established style (bold linked title, plan-doc link, prose summary). Name plainly: the idle-RAM
measurement you actually observed (if you measured it — if not, say you didn't rather than
inventing a number), any real corrections found during the port (reference this task's own
findings from Step 2's diff process if any bugs were caught and fixed), and that the Node
collector was NOT removed/retired — both coexist, cutover is a deferred decision.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs: Stage 10 (Go collector) shipped -- roadmap/PROGRESS closeout, golden-file parity verified"
```
