# Go Collector (Stage 10) — Design

## Context

Roadmap Stage 10 (`docs/roadmap.md` row 10, `*(optional)*`): "Drop-in swap behind the Stage 2
contract." Roadmap §2 already made the merit case: idle RAM drops from ~40-60MB (Node) to
~10MB (pure-Go `modernc.org/sqlite`, no CGO), at the cost of reimplementing everything from
scratch and re-earning test coverage. Explicitly optional — "if idle footprint ever matters,"
not a correctness or feature gap.

**Confirmed with the user before writing this spec:** this is a real ~2,300-line-of-logic
rewrite (18 source files, 2,608 lines of existing tests), not a small task despite the roadmap's
"~6 tasks" estimate. Scope is a full port, phased into per-module tasks. This session produces
the design spec only — the implementation plan and subagent execution are deferred to a future
session with a full budget, per explicit agreement.

## The contract Stage 10 must preserve

Per roadmap §1, the collector and Aether OS communicate through a deliberately
language-agnostic boundary: an append-only file spool in, SQLite out, no shared runtime types.
Concretely, verified against the current source:

- **Input**: `scripts/aether-hook-emit.mjs` (unchanged, not part of this port — it's a
  dependency-free Node script invoked by Claude Code's hook mechanism, appends one JSON line
  per hook event to `~/.aether-os/spool/<session-id>.jsonl`) and the real Claude Code transcript
  files under `~/.claude/projects/**/*.jsonl` (also not part of this port — external, owned by
  Claude Code itself).
- **Output**: `~/.aether-os/collector.db`, an 11-table SQLite database (`schema.ts:20-99`):
  `schema_meta`, `events`, `daily_rollups`, `drift_log`, `usage_events`, `transcript_files`,
  `fleet_sessions`, `tool_calls`, `dispatches`, `anomalies`, `daily_anomaly_rollups`. Plain SQL,
  no ORM, no Node-specific types in the schema itself — directly portable.
- **Reader side** (`electron/collectorStore.ts`, NOT part of this port — lives in the main
  Aether OS app): opens the same SQLite file read-only and queries these tables directly. As
  long as the Go collector produces byte-for-byte-equivalent rows, the reader needs zero
  changes. This is the actual test of whether the contract was real, per roadmap §2's own framing.

## Module inventory and Go mapping

Verified directly against `collector/src/*.ts` (line counts from `wc -l`, excludes `.test.ts`):

| TS module | Lines | Responsibility | Go package |
|---|---|---|---|
| `schema.ts` | 160 | `openDatabase`, `migrate` (the 11 tables above), heartbeat stamps | `internal/schema` |
| `spoolTailer.ts` | 53 | Watches spool dir, tails new `.jsonl` files, deletes consumed | `internal/spool` |
| `hookPayload.ts` | 49 | Parses one hook-event JSON line into a typed row | `internal/spool` (same package, types file) |
| `ingest.ts` | 58 | Writes a parsed hook event into `events`/`daily_rollups` | `internal/spool` |
| `usageIngest.ts` | 61 | Writes `usage_events` rows from assistant-turn usage data | `internal/transcript` |
| `transcriptParser.ts` | 129 | Parses one transcript `.jsonl` line into typed events | `internal/transcript` |
| `transcriptTailer.ts` | 22 | Byte-offset-aware incremental file reader | `internal/transcript` |
| `transcriptScan.ts` | 137 | Orchestrates: discover project dirs, tail each, ingest, update `transcript_files` | `internal/transcript` |
| `toolCallHistory.ts` | 115 | In-memory ring buffer per session, feeds anomaly detection | `internal/transcript` |
| `anomalyIngest.ts` | 114 | Anomaly detectors (re-read loops, zero-edit burns, etc.) + `INSERT OR IGNORE` dedup | `internal/anomaly` |
| `fleetPoll.ts` | 128 | Shells out to `claude agents --json`, parses, upserts `fleet_sessions` | `internal/fleet` |
| `ownSessionFile.ts` | 13 | Reads `own-session.json` for fleet self-exclusion | `internal/fleet` |
| `retention.ts` | 95 | Daily rollup compaction, row deletion per table's retention policy | `internal/retention` |
| `hookInstaller.ts` | 276 | Merges hook config into Claude Code's `settings.json` (install/uninstall) | `internal/hookinstall` |
| `autostart.ts` | 41 | OS-level autostart registration (Windows-specific per prior stages) | `internal/autostart` |
| `canary.ts` | 38 | Liveness/self-check | `internal/canary` |
| `cli.ts` | 74 | CLI entrypoint (install/uninstall/status commands) | `cmd/aether-collector-cli` |
| `index.ts` | 100 | Main orchestration: opens DB, starts spool tailer, timer-driven scan/compact/fleet-poll loops, SIGINT/SIGTERM shutdown | `cmd/aether-collector` |
| `memoryStore.ts` | 758 | ⚠️ Largest file by far (33% of total). Not yet read in detail for this spec — **first task of the real implementation plan must be reading this file and either adding it to the table above with its own Go package, or documenting why it's out of scope for the port** (e.g. if it turns out to be a separate, newer subsystem not part of the original Stage 2 contract). Flagging honestly rather than guessing its scope. |

`index.ts`'s architecture (`index.ts:34-72`) is single-process, timer-driven: one SQLite
connection, a spool-tailer loop, and three independent `setInterval` loops (compact,
transcript-scan, fleet-poll), each wrapped so a failure in one doesn't kill the others. This
maps cleanly to Go: one `*sql.DB`, one goroutine per loop using `time.Ticker`, coordinated
shutdown via a `context.Context` cancelled on SIGINT/SIGTERM (replacing `index.ts:93-99`'s
`process.on` handlers).

## Toolchain and dependencies

Per roadmap §2's already-settled recommendation:

- **`modernc.org/sqlite`** — pure Go, no CGO, no C toolchain dependency (this box previously
  lacked one; roadmap §2 notes MSVC is now installed, but staying CGO-free keeps the *build*
  simple regardless, which is part of the original merit case, not just a historical constraint).
- Standard library `net/http`... **not needed** — confirmed above, the contract is file-spool +
  SQLite, not HTTP. No HTTP dependency at all, matching the Node collector's own "not an HTTP
  receiver" design correction (`PROGRESS.md`'s Stage 2 entry, item (a)).
- `github.com/fsnotify/fsnotify` (or equivalent) for spool-directory watching, replacing
  Node's `fs.watch`/polling in `spoolTailer.ts` — needs confirming against what
  `spoolTailer.ts` actually does (polling vs. real fs events) before the implementation plan
  locks this in.
- Go's standard `encoding/json` for both spool-line and transcript-line parsing — no external
  JSON library needed.
- Go module layout: `collector-go/` as a sibling directory to the existing `collector/`
  (Node), NOT a replacement in place — both must coexist until the swap is proven and the old
  one is deliberately retired, per "drop-in swap" implying a cutover point, not a simultaneous
  rewrite-in-place.

## Verification strategy — the actual hard part

This is the section that determines whether this port is trustworthy, not just plausible:

1. **Golden-file/fixture parity, not independent re-derivation of correctness.** The existing
   `collector/src/*.test.ts` (2,608 lines) already encodes the exact expected behavior —
   including hard-won corrections named in `PROGRESS.md` (the cross-drive path fix, the
   dispatch-completion signal correction, the anomaly-dedup unique index). Do NOT
   re-derive test cases from first principles in Go; port the *fixtures and expected outputs*
   directly, translating assertions 1:1 where the language allows, and treat any assertion that
   doesn't port cleanly as a flag to go re-read the original TS test's comment for *why* it
   exists before deciding how to adapt it.
2. **A real side-by-side run**, not just unit parity: run both collectors against the same
   real (or fixture) spool directory and transcript tree, pointed at two different SQLite
   files, and diff the resulting tables row-for-row (excluding autoincrement `id` columns and
   any inherently non-deterministic timestamp). This is the test that actually proves "drop-in"
   rather than "structurally similar."
3. **The reader side stays untouched as the acceptance test.** `electron/collectorStore.ts`
   should read the Go collector's output `collector.db` with zero code changes and produce
   identical UI state to reading the Node collector's output — this is the literal meaning of
   "drop-in swap behind the Stage 2 contract" and should be the final gate before calling this
   stage shipped.

## Scope boundaries

- `scripts/aether-hook-emit.mjs` and `scripts/aether-permission-hook.mjs` are NOT part of this
  port — they're invoked directly by Claude Code's hook mechanism as standalone scripts, not by
  the collector process itself, and stay Node/dependency-free regardless of what language the
  collector is written in.
- `electron/collectorStore.ts` and everything in `src/`/`electron/` (the actual Aether OS app)
  are explicitly out of scope — the entire point of the contract is that they don't need to
  change.
- No feature changes, no schema changes, no behavior changes beyond what's required for a
  faithful port. This is not the place to fix or improve anything found along the way — file
  those as separate, named follow-ups instead (matching this project's established practice of
  not silently bundling unrelated fixes into a stage's scope).
- `memoryStore.ts`'s disposition (port vs. out-of-scope) is explicitly **not decided by this
  spec** — flagged above as the first open question the implementation plan must resolve.

## Out of scope

- Deciding whether Stage 10 ships at all remains the user's call each time it's revisited —
  this spec documents *how* to do it, not a commitment that it will be done.
- Any UI/UX change, any new feature, any schema version bump.
- Packaging/distribution of the Go binary (installer integration, code signing) — a separate
  concern from the port itself, deferred to whenever this actually gets implemented.
