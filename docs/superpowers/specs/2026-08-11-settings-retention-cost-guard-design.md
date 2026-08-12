# Settings hardening: Retention & Purge, Cost Guard — design

**Status:** approved for planning
**Date:** 2026-08-11
**Companions:** `docs/privacy-and-data.md` §6 (binding requirement this closes), `docs/ideas/zero-cost-replacements-brainstorm.md` §4.1/4.2 (source ideas, both predate Stage 17/18)

## What this is

Two Settings cards, bundled as one stage because both are small, Settings-only, and have no
cross-dependency — the same shape as Stage 7's six-piece bundle.

1. **Retention & Purge card** — closes a binding requirement from `privacy-and-data.md` §6 that has
   sat unbuilt since the roadmap's cross-cutting constraints were written: *"A visible 'Purge all
   collected data' action in Settings that actually deletes, plus a readout of the store's current
   size and oldest retained row. If you cannot see what is stored and delete it in one click,
   'local-only' is a claim rather than a property."* Backend retention (`collector/src/retention.ts`,
   `collector-go/internal/retention/retention.go`) already runs a 30-day compaction automatically;
   nothing surfaces store state to the operator or lets them wipe it on demand.
2. **Cost Guard card** — the settings-card replacement for `ChatBackendCard`/`ModelPolicyCard`,
   proposed in the 2026-08-05 brainstorm right after Stage 13.5's API teardown, never built. Its
   original design (flat "0 egress") predates Stage 17 (cross-engine Codex verification) and Stage
   18 (Codex terminal), both of which added a real, disclosed, opt-in network path. This design
   updates the card's claim to stay honest against what actually shipped since.

## Retention & Purge

### Read side: `retention:status`

New `electron/retentionStore.ts`, `status()` function. Opens `collector.db` **read-only** — same
convention as `collectorStore.ts`, `main.ts`'s diagnostics reader, and `memoryStore.ts`. Returns:

```ts
interface RetentionStatus {
  exists: boolean;               // false if collector.db has never been created
  fileSizeBytes: number;
  oldestRetainedAtMs: number | null;   // null when exists but every table is empty
  rowCounts: {
    events: number; dailyRollups: number; usageEvents: number; toolCalls: number;
    dispatches: number; anomalies: number; dailyAnomalyRollups: number;
    driftLog: number; fleetSessions: number;
  };
}
```

- `fileSizeBytes`: `fs.statSync(dbPath).size`.
- `oldestRetainedAtMs`: `MIN(occurred_at_ms)` across `events`, `usage_events`, `MIN(started_at_ms)`
  across `dispatches`/`tool_calls`, `MIN(detected_at_ms)` across `anomalies` — the earliest live row
  across every raw (non-rollup) table. Rollup tables (`daily_rollups`, `daily_anomaly_rollups`) are
  keyed by day string, not a row timestamp, and are excluded from this calculation — they're already
  represented by the raw tables' own oldest row before compaction ages them out.
- `exists: false` (collector never run, or DB file missing) is a normal state, not an error — the
  card shows "No collector data yet" the same way other views degrade when the collector is absent.

### Write side: `retention:purge`

Same module, `purge()` function.

- Opens a **second, separate writable connection** to the same `collector.db` file — not the
  existing read-only handle. `PRAGMA busy_timeout = 5000` is set explicitly on this connection,
  compensating for `collector/src/schema.ts`'s `openDatabase()` never setting one on the Node
  collector's own connection (only `memoryStore.ts` and the Go backend's schema do). This connection
  is opened, used for one transaction, and closed — it is not held open for the app's lifetime like
  the read-only handles are.
- One transaction: `DELETE FROM` every data table —
  `events, daily_rollups, drift_log, usage_events, fleet_sessions, tool_calls, dispatches, anomalies,
  daily_anomaly_rollups`. Then `VACUUM` (outside the transaction — SQLite doesn't allow `VACUUM`
  inside one) so the file size readout actually drops; a `DELETE` without `VACUUM` leaves the
  on-disk file the same size, which would make the "current size" readout lie immediately after the
  action that's supposed to prove it works.
- **`schema_meta` is preserved** — schema-version bookkeeping, not collected data.
- **`transcript_files` is preserved, deliberately, and this is the load-bearing detail of the whole
  feature.** It's the per-file byte-offset cursor `transcriptScan.ts` uses to scan `.jsonl`
  transcripts incrementally. If it were wiped alongside the data tables, every cursor resets to 0 and
  the collector's very next scan tick replays full transcript history from byte zero, silently
  re-populating `dispatches`/`tool_calls`/`anomalies`/`usage_events` right back — the purge would
  appear to work and then undo itself within one tick interval. Leaving cursors where they are (past
  all historical content already scanned) is what makes deletion actually stick; only genuinely new
  transcript content ingests from here.
- **`memory.db` is never opened by this module.** It's a physically separate file specifically so a
  purge of `collector.db` can never take memory decisions down with it (see `memoryStore.ts`'s own
  header comment, which already names this as the reason for the file split).
- **Purge is a strict superset of `compact()`'s effect, not a bigger version of the same operation.**
  `compact()` preserves rollups (`daily_rollups`/`daily_anomaly_rollups` survive as the whole point
  of that job) and only ages out rows past the 30-day window. Purge deletes the rollups too and has
  no age cutoff — it is "start over," not "run retention early." This distinction goes in the card's
  confirmation copy so it isn't mistaken for a bigger compaction pass.
- **Works identically regardless of which collector backend (Node or Go) is currently running.**
  Electron opens the same `collector.db` file directly; there is no per-backend purge code, no
  process to locate or spawn, and nothing to keep in sync between the two backend implementations.

### IPC

`retention:status` / `retention:purge`, following the `crossEngine:status` /
`crossEngine:connectCodexSubscription` naming convention already in `electron/main.ts` /
`electron/preload.ts`.

### UI: `RetentionCard.tsx`

- Fetch-on-mount + `refresh()`-after-action, same shape as `StatuslineCard.tsx`.
- Renders `fileSizeBytes` (human-readable), `oldestRetainedAtMs` (relative + absolute), and a total
  row count. "No collector data yet" when `exists: false`.
- Purge button reveals an inline confirm block, reusing `CrossEngineVerificationCard.tsx`'s
  click-to-reveal-disclosure pattern: warning copy states this deletes rollups too (not just raw
  rows) and cannot be undone, restates the live size/row-count/oldest-row figures being deleted, then
  Confirm/Cancel. On confirm: call `retention:purge`, show a busy state, then `refresh()` so the
  card immediately reflects the post-purge (near-zero) state.
- Purge failure (e.g. a transaction error): surfaced inline in the card, not swallowed — same
  standard as the rest of this project's IPC error handling.

## Cost Guard

Purely presentational, `CostGuardCard.tsx`, no new IPC.

```
COST GUARD
  ANTHROPIC API        DISABLED · no SDK installed, no key-reachable path
  MODEL CALLS BY AETHER NONE · zero call sites (noApiCalls.test.ts enforced)
  CROSS-ENGINE VERIFY   OFF | ON — ChatGPT subscription only, no API key path
  AUTO HEADLINES        computed locally, no API call
```

- Rows 1, 2, 4 are static copy — true by construction since Stage 13.5 (`@anthropic-ai/sdk` removed
  from `package.json`, `noApiCalls.test.ts` enforces it) and Stage 11.5's Addendum (Auto Headlines'
  Haiku call site retired, deterministic formatting only). No live check needed; nothing in the app
  can make these false without a compile-time change this card doesn't need to detect.
- Row 3 reads the existing `state.crossEngineCfg.enabled` from the store (already populated,
  already used by `CrossEngineVerificationCard.tsx`) — live, not static. **This is the one line that
  keeps the card honest against Stage 17/18**: cross-engine verification is a real, disclosed,
  opt-in network path (ChatGPT-subscription-authenticated, no API key code path per
  `noApiCalls.test.ts`'s cross-engine boundary suite), and a Cost Guard card that omitted it or
  implied zero egress unconditionally would misstate what the app currently does when that toggle
  is on. The Codex terminal (Stage 18) is not listed here — it's categorized with the Claude
  terminal itself (an interactive session the operator drives directly, not a call Aether makes on
  their behalf), consistent with how `docs/privacy-and-data.md` §1 already carves out the terminal.

## Testing

- **`retentionStore.test.ts`**: `status()` against a seeded DB with known row counts and a known
  oldest timestamp returns the correct numbers; `status()` against a missing DB file returns
  `exists: false` rather than throwing. `purge()` wipes every data table (asserted nonzero before,
  zero after — not just "did not throw"), preserves `schema_meta` and `transcript_files` row
  contents exactly, and leaves a separately seeded `memory.db` fixture completely untouched.
  Non-vacuous check per this project's standing convention: seed the DB, purge, then run a second
  scan-simulation and confirm `transcript_files`' untouched offsets prevent old data from
  reappearing (the specific failure mode named above).
- **Component tests**: `RetentionCard` confirm-flow open/cancel/confirm; a purge failure path
  surfaces the error inline rather than silently resetting to the pre-purge state. `CostGuardCard`
  renders the ON/OFF row correctly for both values of `crossEngineCfg.enabled`.
- **Visual judgement manual**, per this project's established practice — neither card has been seen
  in a running window before merge.

## Out of scope

- `memory.db` — never opened or touched by this feature; see "why" above.
- The attachments library (`attachmentsStore.ts`) — user-authored content, not collector telemetry;
  "all collected data" is scoped to what the collector observed, not everything Aether has stored.
- Spool files — already self-cleaning (deleted after consumption, per `privacy-and-data.md` §7), not
  a purge target.
- Electron spawning/managing the collector process — the roadmap's own lifecycle constraint (§4.8,
  "Aether OS should also be able to start the collector on demand") was never built and this feature
  does not build it either; Purge only ever opens a direct connection to the DB file.
- A typed-confirmation ("type PURGE to confirm") gate — the existing inline-confirm pattern is used
  as-is, matching every other consequential toggle in this Settings view.
- Any change to `compact()`'s automatic 30-day retention job — Purge is a new, separate, manually
  triggered action alongside it, not a replacement.

## Next step

Hand off to `writing-plans`, saved to a plan doc under `docs/superpowers/plans/`.
