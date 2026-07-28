# Fleet Session Browser (Stage 4) — Design Spec

**Date:** 2026-07-28
**Status:** Approved, pending implementation plan

## Context

`docs/roadmap.md` names Stage 4 "Fleet + session picker": `claude agents --json` in the
collector, a picker in the viewer, retiring "the most-recently-active auto-pick and its
false-completion bug." Research before this design found that justification is stale — commit
`8e0e9d4` (2026-07-24, three days before the roadmap doc was written) already pinned
`electron/liveAgentTracker.ts`'s live tracking to the specific session file created by Aether's
own embedded terminal (via `notifyPtySpawned`), replacing the older "globally most-recently-active
session" heuristic that caused that bug. So Stage 4 is not fixing a live defect; it is adding a
capability that doesn't exist yet: **visibility into `claude` sessions other than the one running
in Aether's own terminal.**

`docs/superpowers/plans/2026-07-27-viewer-reads-the-store.md` explicitly deferred a related
question to this stage: giving the headless `collector/` process (no pty, no
`notifyPtySpawned`-equivalent signal) a way to know "which session is active" for the 1s
live-dispatch tick and anomaly detection. This design does **not** resolve that question — see
"Out of scope" — it deliberately narrows Stage 4 to a read-only fleet browser and leaves the
tracking-redirect question open for a later stage.

`claude agents --json` was run directly against this machine to confirm its real shape (not
assumed from prior docs):

```json
[
  {
    "pid": 6824,
    "cwd": "C:\\Users\\IT",
    "kind": "interactive",
    "startedAt": 1785255815376,
    "sessionId": "37d95054-b8c3-44c2-8422-06d7fd9d52d7",
    "name": "it-68",
    "status": "busy"
  }
]
```

`--all --json` additionally includes background/completed sessions, which use a `state` field
(e.g. `"failed"`) instead of `status`, and have no `pid`. This design uses **active-only**
(`claude agents --json`, no `--all`) — see "Out of scope."

## Scope

A new, read-only fleet browser: the collector polls `claude agents --json` on its own interval
and persists a current-state snapshot; the viewer reads it and renders a new card in the existing
Agents view listing every other `claude` session running on the machine (project name, session
name, status, running duration). Clicking a row expands the same already-polled fields in place —
no new data fetch per click.

## Out of scope

- **Session control** (start/stop/kill/attach/respawn) — read-only, matching
  `docs/diagnostic-thesis-plan.md`'s own Phase A2 framing ("no session control yet — Phase D").
- **`--all` / completed-session history** — active sessions only. No retention window to design,
  no second row shape (`state` vs `status`, missing `pid`) to reconcile.
- **Transcript reading for foreign sessions** — the peek shows only the fields `claude agents
  --json` already returned; it does not open or tail any other session's `.jsonl` file. Reading a
  session Aether didn't spawn raises real "store the signal not the payload" questions (§4.3 of
  the roadmap) that a fields-only peek avoids entirely.
- **Redirecting the app's existing live tracking.** Dashboard/Agents' `ActiveAgentsCard`/Grid/
  Reactor/anomaly detection continue to track only Aether's own terminal session, exactly as
  today. Picking a row in the new fleet card does not change what those views show.
- **Resolving Stage 3's deferred "which session is active" question** for the headless collector's
  own future live-tick/anomaly work. This stage's poll is a snapshot for display only; it is not
  wired into `liveAgentTracker` or any pty-spawn-equivalent signal. Left open for a future stage.

## Architecture

### Collector: `collector/src/fleetPoll.ts` (new)

```ts
export interface FleetSession {
  sessionId: string;
  pid: number | null;
  projectName: string;   // path.basename(cwd) — raw cwd is discarded immediately after deriving this
  kind: string;           // 'interactive' | 'background', passed through as-is
  status: string;         // passed through as-is (e.g. 'busy', 'idle')
  name: string;           // the session's free-text label, e.g. "it-68"
  startedAtMs: number;
}

export function parseFleetJson(raw: string): { sessions: FleetSession[] } | { drift: string[] };
export async function pollFleet(ownPtyPid: number | null): Promise<FleetSession[]>; // spawns `claude agents --json`, filters out ownPtyPid, calls parseFleetJson
export function upsertFleetSessions(db: DatabaseSync, sessions: FleetSession[], nowMs: number): void;
```

`pollFleet` spawns `claude agents --json` as a child process (no `--all`). `ownPtyPid` is passed
in from the collector's start options (plumbed from Electron via a small local file or CLI option
written by `ptyManager.ts` on spawn — exact mechanism is an implementation-plan detail) so Aether's
own terminal session — which `ActiveAgentsCard` already shows — never appears twice.

`parseFleetJson` validates each row has the expected fields; a row missing an expected key logs to
the collector's existing `drift_log` table via the same helper `collector/src/canary.ts` already
uses for hook-payload drift, and is dropped rather than mis-parsed. A spawn failure, non-zero exit,
or unparseable JSON is caught, logged the same way, and the poll cycle is skipped entirely —
existing rows are left to age out via the staleness prune below rather than the whole list being
wiped by one bad poll.

### Schema: `fleet_sessions` table (additive, bumps `SCHEMA_VERSION` to 3)

```sql
CREATE TABLE fleet_sessions (
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

Each poll upserts by `session_id` (updating `last_seen_ms`), then deletes any row whose
`last_seen_ms` is older than 30 seconds (twice the poll interval) — chosen over delete-then-
reinsert so a single failed/slow poll degrades to "slightly stale list" rather than "empty list for
one cycle," mirroring the existing staleness-driven cleanup already established in
`collector/src/retention.ts`.

`collector/src/index.ts` runs `pollFleet` + `upsertFleetSessions` on its own `setInterval`, 15
seconds (matching the existing `transcriptScanIntervalMs` cadence), independent of the spool
tailer and transcript-scan timers.

### Electron: `electron/collectorStore.ts` (extend)

```ts
export interface FleetSessionRow { sessionId: string; pid: number | null; projectName: string; kind: string; status: string; name: string; startedAtMs: number; }
export function readFleetSessions(dbPath: string): FleetSessionRow[]; // [] if db/table missing or schema version < 3 — same gate pattern as readUsageEventsSince
```

`electron/main.ts` reads this on its own interval and pushes a new `fleet:snapshot` IPC event,
following the same push pattern `useRealAgentsSync.ts` already established for real-agents data.

### Renderer state

- New disjoint field `state.fleet: FleetSessionRow[]`, its own reducer case (`SET_FLEET`).
- New `src/state/useFleetSync.ts` hook, mounted bare as a wrapper component in `App.tsx`, mirroring
  `useRealAgentsSync`'s existing IPC-reactive-hook convention.
- Not persisted (`PERSISTENCE_EXCLUSIONS`) — it's a live external-process snapshot, stale the
  instant it's written to disk, same reasoning already applied to `state.logs`.

### UI: `FleetCard`

New card in the existing Agents view, alongside `ActiveAgentsCard`. Lists each `state.fleet` row:
project name, session name, a status badge (busy/idle), and running duration derived from
`startedAtMs`. Clicking a row expands it in place to show the same fields at slightly more detail
— no new IPC call, no new data source. Empty state ("No other sessions detected") and an
"unavailable — collector isn't running" state both mirror `ActiveAgentsCard`'s and the Stage 3
usage tiles' existing empty/unavailable-state conventions respectively.

## Privacy

Governed by `docs/privacy-and-data.md`, binding on this stage like every other. Raw `cwd` is never
persisted or transmitted to the renderer — `fleetPoll.ts` derives `project_name` via
`path.basename(cwd)` at ingest (the same convention `electron/attachmentsStore.ts` already uses)
and discards the raw path immediately after. `name` (the session's short free-text label) is
stored and displayed as-is — it is a short user-assigned label, not tool output or message content,
the same class of data as the `subagentType` strings this app already surfaces elsewhere. No
transcript content, prompts, or tool inputs from any other session are ever read, stored, or
displayed.

## Error handling & degradation

- **Poll failure** (missing `claude` binary, spawn error, non-zero exit, malformed JSON): logged
  to `drift_log`, poll cycle skipped, existing rows age out via the 30s staleness prune rather than
  the list going empty immediately.
- **Collector not running / `fleet_sessions` missing / schema version < 3**: `readFleetSessions`
  returns `[]`; `FleetCard` shows the same "collector isn't running" state Stage 3 established for
  the usage tiles. No throw, no broken card — the degradation contract (roadmap §4.6) holds.
- **Contract drift**: `claude agents --json`'s shape is an undocumented, CLI-versioned surface,
  the same risk class the roadmap's §4.4 constraint already flags for hook payloads and statusline
  fields. `parseFleetJson` logs to `drift_log` on any row missing an expected field rather than
  silently mis-parsing it.

## Testing

- `parseFleetJson` unit-tested against fixtures built from the real captured output above (both
  the interactive-only shape and a deliberately-malformed/missing-field row).
- Schema migration (`fleet_sessions` table, version bump to 3) tested the same way as Stage 3's
  Task 1 (`schema.test.ts`).
- Upsert + staleness-prune logic tested directly against the SQLite table (insert, re-poll with a
  stale row, confirm prune), mirroring `retention.test.ts`'s existing style.
- `readFleetSessions` tested for its schema-version-gate / missing-db fallback path, mirroring
  `collectorStore.test.ts`'s existing coverage of `readUsageEventsSince`.
- Self-session filtering tested with a fixture row whose `pid` matches the passed-in own-pty-pid,
  confirming it's excluded from `pollFleet`'s output.
- `FleetCard` gets standard component tests for its data/empty/unavailable states; live visual
  verification in `electron:dev` is deferred to the user, per this project's established and
  repeatedly-stated pattern for anything requiring a live window.
