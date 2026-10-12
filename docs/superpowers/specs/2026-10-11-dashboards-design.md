# Dashboards — design

Status: approved 2026-10-11. Amended 2026-10-12 (approved): the shared code
and the MCP server move to the Electron side, following the `aether-bridge`
precedent, because the repo never cross-imports runtime code between
`collector/` and the app (`collector/src/collectorSettings.ts` is a deliberate
duplicate of `electron/collectorSettings.ts`). The original text claimed that
Electron already imports from `collector/src`, but those imports are type-only.
Inspiration: Claude Dashboards (support.claude.com article 17454700) — ask in
plain language, Claude builds a chart, edit by asking, refresh without asking.

## Goal

Ask Claude in the Terminal tab something like "show my token spend by model per
day this month" and get a correct, refreshable chart in a new **Boards** tab.
Two purposes are first-class (operator choice "d: both"):

- **Cost / usage oversight** — spend by model, cache hit rate, when burn peaks.
- **Agent / workflow behavior** — tool-call mix, dispatch tokens and durations,
  anomalies over time.

Authoring is conversational only, plus two shipped starter boards
(operator choice "b").

## Constraints (binding, inherited)

- **No model calls from Aether.** Claude reaches the data through a local MCP
  server it spawns itself; refresh re-runs saved SQL locally.
  `src/shared/noApiCalls.test.ts` must keep passing.
- **Read-only.** Nothing in this feature writes to `collector.db`.
- **No absolute path crosses IPC.** Boards are addressed by `id`.
- **Exact vs estimated cost stay distinct** (`usd` vs `usdApprox`), and a bucket
  with no data is `null`, never `0` (CLAUDE.md, Stage 15).
- **Opt-in.** Nothing is registered by default.
- **Store the signal, not the payload** — the feature adds no new stored data
  beyond board definitions (SQL + layout).
- **Path columns are blocked** (operator decision 2026-10-12). `queryGuard`
  refuses any query naming `file_path_rel`, `project_rel_path`, `file_path`,
  `source_file_rel` or `detail` (anomaly text names files), and refuses `*`
  everywhere except `COUNT(*)`. Query results reach the model conversation,
  and paths are the store's remaining sensitive surface.
- Correction (2026-10-12): `dispatches.task_kind` is the subagent type, so
  "which subagent" IS answerable; the Agent fleet board gains a "Dispatches by
  agent type" panel. Gap 3 below is limited to "no model on dispatches".

## Naming

The sidebar already has a `Dashboard` view (`src/viewRegistry.ts:25`, the
landing view in `src/components/dashboard/`). To avoid a `Dashboard` /
`Dashboards` pair in the sidebar, the new view id is **`Boards`** and its
directory is `src/components/boards/`. The on-disk folder and MCP tools keep
the plainer word "dashboard" because nothing user-facing collides there.

## Data available (and what is not)

From `collector/src/schema.ts`:

| Table | Useful columns |
|---|---|
| `usage_events` | `occurred_at_ms`, `model`, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` |
| `tool_calls` | `tool_name`, `started_at_ms`, `closed_at_ms` |
| `dispatches` | `tokens`, `tool_uses`, `duration_ms`, `started_at_ms`, `ended_at_ms` |
| `anomalies` | `kind`, `detected_at_ms` |
| `daily_rollups`, `daily_anomaly_rollups` | pre-aggregated per day |
| `events` | `hook_event_name`, `tool_name`, `project_rel_path`, `occurred_at_ms` |

Known gaps, surfaced by `describe_schema` and in this spec's out-of-scope list:

1. **No stored dollar amounts.** Cost is computed by `src/shared/modelPricing.ts`
   / `ledgerMath.ts`. SQL cannot produce a cost column, so cost is added after
   the query runs — see "Cost post-processing".
2. **`usage_events` has no project or session column** — no spend-by-project.
3. **`dispatches` has no agent type or model** — no "which subagent", and the
   dispatch estimate is always tier-defaulted.

`memory.db` is not a source in v1.

## Architecture

```
Terminal: claude ──stdio──► aether-data MCP server (out/main/aether-data-mcp.js,
                              │  run as "Aether OS.exe" with ELECTRON_RUN_AS_NODE=1)
                              │ opens collector.db read-only, busy_timeout=5000
                              │ describe_schema · run_query · save_dashboard · update_chart
                              ▼
                 ~/.aether-os/dashboards/<id>.json   (tmp + rename)
                              ▲ fs.watch (debounced 250 ms)
Electron main ── electron/dashboardsStore.ts: list · load · validate · refresh
     │ IPC: dashboards:list, dashboards:refresh(id), dashboards:delete(id),
     │      dashboards:changed (push; ids only)
     ▼
Renderer: src/components/boards/ ── LinePanel · BarPanel · StatPanel · TablePanel
```

Pure shared code lives in `src/shared/dashboards/`, which Electron main, the
MCP entry and the renderer can all import. The MCP server is a second
electron-vite main entry, the same way `communication-mcp.js` is built for
`aether-bridge`. Nothing in `collector/` changes.

### Units

| Unit | Kind | Responsibility |
|---|---|---|
| `src/shared/dashboards/queryGuard.ts` | pure | Accept one `SELECT`/`WITH … SELECT` statement; reject `ATTACH`, `DETACH`, `PRAGMA`, `INSERT`/`UPDATE`/`DELETE`/`REPLACE`/`CREATE`/`DROP`/`ALTER`/`VACUUM`, multiple statements, and statements hidden after comments. Wraps the query as `SELECT * FROM (<sql>) LIMIT <cap+1>` so truncation is detectable. Defense in depth only — the read-only connection is the primary guard. |
| `src/shared/dashboards/spec.ts` | pure | `DashboardSpec` type + `validateSpec(json) → {ok, spec} \| {ok:false, errors[]}`. |
| `src/shared/dashboards/costing.ts` | pure | Cost post-processing (below). |
| `electron/dashboards/runQuery.ts` | I/O | Open `collector.db` with `readOnly: true`, set `busy_timeout=5000`, bind `:since`, run through `queryGuard` inside a `worker_threads` worker (`node:sqlite` is synchronous, so only terminating the worker can enforce the 5 s timeout), return `{columns, rows, truncated}`. Used by both the MCP server and Electron main. |
| `electron/dashboards/dataServer.ts` | MCP server factory | The four tools below; importable for tests. |
| `electron/dashboards/dataServerEntry.ts` | executable entry | stdio transport only; built to `out/main/aether-data-mcp.js`. |
| `src/shared/dashboards/starters.ts` | data | `spend-cache` and `agent-fleet` specs. |
| `electron/dashboardsStore.ts` | main | Watch folder, validate, refresh (query in a worker thread), cost post-processing, seed starters, delete. |
| `src/components/boards/` | renderer | View, tabs, panels. |

## Board file format (`version: 1`)

```json
{
  "version": 1,
  "id": "spend-cache",
  "title": "Spend & cache",
  "panels": [
    {
      "id": "daily-spend",
      "title": "Spend by day",
      "type": "line",
      "sql": "SELECT date(occurred_at_ms/1000,'unixepoch','localtime') AS day, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens FROM usage_events WHERE occurred_at_ms >= :since",
      "range": "30d",
      "cost": { "basis": "exact", "groupBy": "day" },
      "x": "day",
      "y": ["usd"]
    }
  ]
}
```

Rules enforced by `validateSpec`:

- `id` (board and panel): `^[a-z0-9-]{1,64}$`; the board `id` equals the file
  basename. Panel ids are unique within a board.
- `type`: `line` | `bar` | `stat` | `table`. `stat` has exactly one `y` and no
  `x`; `table` ignores `x`/`y` and shows all columns.
- `range`: `24h` | `7d` | `30d` | `90d` | `all` (default `30d`). It binds
  `:since` (epoch ms; `all` binds `0`). SQL that does not reference `:since` is
  valid and simply ignores the range.
- `cost` (optional):
  - `basis: "exact"` — query must return `model` and the four token columns;
    output gains a `usd` column per `groupBy` value.
  - `basis: "estimated"` — query must return `tokens`; output gains
    `usdApprox` per `groupBy` value.
  - A panel's `y` may name `usd` or `usdApprox`, never both.
- `x` and every `y` must be columns of the (post-processed) result. This is
  checked at dry-run time, not in the pure validator, because only a real
  execution knows the column list.

### Cost post-processing (`src/shared/dashboards/costing.ts`; used by main and the MCP server)

- **Exact:** for each row, `costForEvent({model, usage})` from
  `src/shared/modelPricing.ts`, summed per `groupBy`. Rows with `model IS NULL`
  are **excluded** and counted, and the panel shows "N rows unpriced". They are
  not priced at a default rate, because a default-rate figure is not exact.
  Non-null but unknown model ids follow `rateForModel`'s existing fallback,
  matching the Ledger.
- **Estimated:** `tokens × blendedRateForModel(null) / 1e6` (the same rate
  `estimateDispatchCost` in `src/shared/ledgerMath.ts` uses for a dispatch with
  no model), summed per `groupBy`. `dispatches` has no model, so the basis is
  always the defaulted tier. The panel renders `~$x.xx` with "est. (blended
  tier rate)".
- A `groupBy` value present in the time range but with zero rows renders `null`
  ("no data"), never `0`. For line and bar charts over days, the x-axis is
  filled to the full range so gaps are visible.
- The MCP server imports the same module, so the `save_dashboard` dry-run and
  `run_query` (given an optional `cost`) return the same `usd`/`usdApprox`
  columns the chart will show.

## MCP tools (`aether-data`)

| Tool | Input | Behavior |
|---|---|---|
| `describe_schema` | — | Tables, columns, row counts, the known-gaps list, and the board file format with one example. |
| `run_query` | `sql`, `range?`, `cost?` | Guard, run read-only, apply cost if given, return ≤200 rows + `truncated`. For exploration. |
| `save_dashboard` | full spec | Validate, dry-run every panel (column checks included), write atomically. All-or-nothing: on any error, return per-panel errors and write nothing. Overwrites an existing id. |
| `update_chart` | `dashboardId`, `panelId`, partial panel | Read, merge, then the same path as `save_dashboard`. Adding a new panel id appends it. |

There is no delete tool. Deletion is a UI action with a confirmation.

**Registration / opt-in:** the Boards "+" tab has a **Copy register command**
button. Main builds the command from `process.execPath` and its own
`__dirname`, and writes it to the clipboard itself, so the absolute paths never
cross IPC:

```
claude mcp add --scope user -e ELECTRON_RUN_AS_NODE=1 aether-data -- "<Aether OS.exe>" "<out/main>/aether-data-mcp.js"
```

The operator pastes and runs it. Aether never edits `~/.claude.json` and never
launches `claude` for this, which keeps `noApiCalls.test.ts`'s launch
allow-list unchanged. The server needs only an installed Aether, not a running
window or the collector's build.

## Electron main (`electron/dashboardsStore.ts`)

- **Folder:** `~/.aether-os/dashboards/`, created on first use.
- **Seeding:** on startup, copy a starter only if its id is not listed in the
  `.seeded` marker file and `<id>.json` does not exist, then add the id to
  `.seeded`. An edited starter is never overwritten, and a deleted one is not
  re-seeded.
- **Watch:** `fs.watch` on the folder, debounced 250 ms, then reload changed
  files and push `dashboards:changed` with the affected ids. A read that fails
  mid-write is retried on the next event.
- **Refresh:** `dashboards:refresh(id, rangeOverride?)` runs each panel's query
  in a worker thread with a 5 s timeout, applies cost post-processing, and
  returns per-panel `{columns, rows, truncated, unpricedRows?, error?, refreshedAt}`
  via `runQuery`'s worker.
  One panel failing does not fail the rest.
- **Busy timeout:** `openCollectorDbReadOnly` (`electron/main.ts:1080`) also
  gains `PRAGMA busy_timeout=5000`. This fixes the existing "database is
  locked" reads seen during collector backfill on 2026-10-11, not only the new
  ones.
- **Delete:** `dashboards:delete(id)` removes the file and is called only from
  the UI's inline confirm.

## Renderer (`src/components/boards/`)

- `viewRegistry` gets `{ id: 'Boards', inSidebar: true, component: BoardsView }`
  between `Ledger` and `Attachments`.
- One tab per board plus "+", which explains how to ask Claude and how to
  register `aether-data`.
- Board toolbar: range selector (overrides every panel's `range` for this
  view), Refresh, auto-refresh (off | 60 s | 5 min; off by default, stored in
  localStorage per board), "last refreshed" stamp.
- Each panel: title, chart, "show query" toggle that reveals the SQL read-only,
  and status text (truncated / N rows unpriced / busy, retry / error message).
- Charts are hand-built SVG with no chart library, colored through
  `useColors()`. Every interactive element is a `Button`. Delete uses an
  inline confirm and never `window.confirm`.
- Cost formatting follows Stage 15: `~` plus basis for `usdApprox`, never for
  `usd`, and "no data" rendered differently from `$0.00`.
- Data fetching uses a pull IPC into the view's own state, in the style of
  `useTranscriptSource`. Board rows are aggregates, not payload, but the
  shared store has no need for them.

## Starter boards

**Spend & cache** (`spend-cache`):
1. Spend by day (line, `usd`, 30d).
2. Spend by model (bar, `usd`, 30d).
3. Cache hit rate by day (line):
   `SUM(cache_read_input_tokens) * 1.0 / NULLIF(SUM(input_tokens + cache_read_input_tokens), 0)`.
   This is the definition in `src/shared/cacheHitRate.ts` (cache creation is
   excluded), so Boards and the Optimize panel agree.
4. Spend today (stat, `usd`, 24h).

**Agent fleet** (`agent-fleet`):
1. Tool calls by tool (bar, top 15, 7d).
2. Dispatches per day with median duration (line, 30d).
3. Dispatch spend by day (line, `usdApprox`, 30d).
4. Anomalies by kind per day (bar, from `daily_anomaly_rollups`, 30d).
5. Slowest dispatches (table, top 20 by `duration_ms`, 7d).

## Error handling

| Failure | Result |
|---|---|
| `collector.db` absent | View: "No collector data — start the collector (collector/README.md)". `describe_schema` returns the same. |
| `SQLITE_BUSY` after the 5 s busy timeout | That panel shows "busy, retry" and keeps its last good result. |
| Query error or 5 s timeout | That panel shows an error card with the SQLite message. |
| Invalid board file (hand edit) | Its tab shows "invalid: <first error>". Other boards are unaffected. |
| Result over the cap (1000 render / 200 tool) | Truncated, flagged. |
| Guard rejection | `run_query` / `save_dashboard` return the reason. Refresh shows it as a panel error. |

## Testing

- **`queryGuard`:** accept/reject table — multi-statement, `ATTACH`, `PRAGMA`,
  each write keyword, `WITH … INSERT`, comment-hidden second statement, string
  literals containing `;` or keywords (must be accepted).
- **`spec`:** valid fixtures and one invalid fixture per rule above.
- **Cost post-processing:** exact sums per group; null-model rows excluded and
  counted; empty groups are `null`; estimated produces `usdApprox` with basis;
  mixing `usd` and `usdApprox` on one panel is rejected.
- **`runQuery` / `dataServer`:** each tool against a temp `collector.db`. A
  write that gets past the guard (simulated by calling the connection directly)
  still fails on the read-only handle. A failed `save_dashboard` leaves the
  folder unchanged.
- **`dashboardsStore`:** seed-once/never-overwrite, debounce, per-panel failure
  isolation, and an IPC payload scan asserting no absolute path.
- **Build:** `electron.vite.config.ts` has the `aether-data-mcp` entry, and a
  test asserts it is there, so the registered file cannot silently disappear
  from a build.
- **`noApiCalls.test.ts`:** stays green.
- **Visual:** `electron-ui-verifier` screenshots both starters against real
  data. Charts are not unit-tested (repo convention).

## Out of scope (v1)

- An in-app query or board builder.
- `memory.db` as a source.
- Collector schema additions (project/session on `usage_events`, agent type or
  model on `dispatches`).
- Switching `collector.db` to WAL.
- Export, sharing, or multi-user anything (forbidden by the privacy stance anyway).
- A delete tool on the MCP server.
