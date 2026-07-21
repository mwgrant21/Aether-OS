# Real Active Agents (Phase 3, first slice) — Design

## Context

Phases 0-2 (shipped) gave aether-os a real Electron shell, a real terminal, and
real Dashboard token numbers — all additive, all leaving `state/tick.ts`'s
fictional simulation (agents, `sys` metrics, logs, alarm, reactor pulse)
completely untouched. Phase 3 is different in kind: it's the first phase that
touches what "Agents" *means*, and "Agents" is referenced by nearly every view
in the app (Terminal's `ActiveAgentsCard`, Dashboard's `ActiveAgentsDigest`,
Grid, Analytics' `AgentBreakdownCard`, Files, Memory's source tags, Chat's
per-agent channels, the Agents view itself). Attempting all of that at once
was explicitly rejected in favor of a deliberately narrow first slice: replace
only the two "Active Agents" summary widgets (Terminal's card, Dashboard's
digest) with real data about currently-running Claude Code subagent
dispatches. Every other view keeps reading the fictional `state.agents`
roster, completely unchanged.

Two rounds of research against this machine's real `~/.claude/projects` data
(not guessed) grounded this design:

**Round 1** (TokenMonitor's live-tailing mechanism + basic dispatch shape):
confirmed the real subagent-dispatch tool is named `"Agent"` (not "Task") on
this machine's actual transcripts — verified directly, and consistent with
the very tool this session itself uses to dispatch research/implementer
subagents. Found that TokenMonitor's own `liveSessionMonitor.js` only picks
"the most recently active session" **once at startup** and never re-checks,
despite its CLAUDE.md's description implying otherwise — a real bug, not
something to port forward. Found that the *first* `tool_result` a dispatch
receives is just a "launched successfully" acknowledgment (arrives within
~1 second), not real completion — TokenMonitor's own existing
"running agents" tracking (`aggregator.js`) closes its entry on this
misleading first signal, sometimes minutes before the dispatch actually
finishes (one measured case: 7.5 minutes early).

**Round 2** (verifying the *real* completion signal precisely, since the
first round's hypothesis — watching `type:"queue-operation"` lines — turned
out to be wrong): `queue-operation` is a generic message-queue event shared
with ordinary human-typed messages (of 3878 real `enqueue` events sampled,
only 703 were genuine task-notifications; the rest were plain user text) —
not a safe signal on its own. The actual reliable signal is a `type:"user"`
message carrying a structured, unambiguous `"origin":{"kind":"task-notification"}`
field, whose `message.content` string contains a `<task-notification>` XML
block with `<task-id>`, `<tool-use-id>`, `<status>` (enum: `completed`/
`failed`/`killed`), `<summary>`, `<note>`, `<result>`, and `<usage>` tags.
Regex extraction of `<tool-use-id>`/`<status>` from that content is safe
*provided* it's only run after `origin.kind` is confirmed — a broad
unscoped scan of transcripts for `<status>...</status>`-shaped text found
dozens of false positives from unrelated prose (e.g. `<status>PASSED</status>`
inside someone's report text).

## Goal

Replace Terminal's `ActiveAgentsCard` and Dashboard's `ActiveAgentsDigest`
with real data about currently-open `Agent`-tool dispatches in whatever
Claude Code session is most-recently-active across all of the user's
projects (matching Phase 2's own "global, not just this app's own terminal"
precedent) — live-tailed and updated roughly every second, correctly
distinguishing "dispatched" from "genuinely still running" from "finished."

## Non-goals

- **No changes to Grid, Analytics, Files, Memory, Chat, or the Agents view
  itself.** All of them keep reading the fictional `state.agents` roster,
  completely unchanged. This slice touches exactly two components.
- **No per-dispatch real token draw or history sparkline.** The completion
  XML's `<usage><subagent_tokens>` *is* real data and worth revisiting in a
  later increment, but this slice shows only: type, description, and live
  elapsed time while a dispatch is open.
- **No "recently completed" history list.** A dispatch simply disappears
  from the list once its completion event is seen — matching "Active Agents"
  semantics exactly (this is what "active" means), not a session log.
- **No actions on real dispatches** (no kill/interact button) — a real
  dispatch can't be controlled from aether-os in this slice. The fictional
  Agents view's TERMINATE button is unaffected and keeps working on the
  fictional roster.
- **The two redesigned cards lose their existing action controls**
  (`ActiveAgentsCard`'s "SPAWN +" button, `ActiveAgentsDigest`'s "VIEW ALL →"
  link) — both currently point at the fictional simulation (spawn a fictional
  agent; navigate to the still-fictional Agents view), which would be a
  confusing juxtaposition sitting directly above real dispatch data. Removed
  outright rather than left dangling; a natural fit for a future increment
  once there's a real per-dispatch detail view to link to.
- **No fictional-roster changes.** `state.agents`/`tick.ts`/`makeAgent()`/
  `RUN_COMMAND`'s `spawn`/`kill` commands are all untouched.

## Architecture

### Pure dispatch-tracking logic: `src/state/liveAgentsMath.ts` (new)

The core "given some raw transcript lines and the previously-known open
dispatches, what's the updated open-dispatch set" logic is pure and fully
testable — deliberately designed as `(currentOpen, newLines) => nextOpen`
rather than hidden mutable state, so the exact same function serves both a
full-file replay (`currentOpen: []`) and incremental live-tailing
(`currentOpen: <previous result>`) with no special-casing:

```ts
export interface RealAgentDispatch {
  toolUseId: string;
  subagentType: string;
  description: string;
  startedAt: string; // ISO timestamp
}

export function applyLinesToOpenDispatches(currentOpen: RealAgentDispatch[], rawLines: string[]): RealAgentDispatch[] {
  const open = new Map(currentOpen.map((d) => [d.toolUseId, d]));

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let json: any;
    try {
      json = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (json.type === 'assistant' && json.message) {
      const content = Array.isArray(json.message.content) ? json.message.content : [];
      for (const item of content) {
        if (item && item.type === 'tool_use' && item.name === 'Agent') {
          open.set(item.id, {
            toolUseId: item.id,
            subagentType: (item.input && item.input.subagent_type) || 'agent',
            description: (item.input && item.input.description) || '',
            startedAt: json.timestamp || new Date(0).toISOString(),
          });
        }
      }
      continue;
    }

    if (json.type === 'user' && json.origin && json.origin.kind === 'task-notification') {
      const content = typeof json.message?.content === 'string' ? json.message.content : '';
      const match = content.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
      if (match) open.delete(match[1]);
    }
  }

  return [...open.values()];
}
```

Deliberately does **not** key off `type:"queue-operation"` at all (Round 2's
central finding — it's not a reliable signal) and does **not** extract
`<status>` (irrelevant to this slice — completed/failed/killed all mean
"no longer active," so the dispatch is simply removed regardless of which).

### Live-tailing pipeline (main process, new)

- **`electron/activeSessionFinder.ts`** — TypeScript port of TokenMonitor's
  `src/main/activeSessionFinder.js`: walks every subdirectory of
  `~/.claude/projects/`, finds the highest-`mtimeMs` `.jsonl` file per
  directory, then the single highest across all directories.
- **`electron/transcriptTailer.ts`** — TypeScript port of TokenMonitor's
  `src/main/transcriptTailer.js`: given a file path and a byte offset, reads
  only the new bytes, truncates to the last complete newline (so a line
  still being written mid-write is never parsed half-formed), and returns
  the complete new lines plus the advanced offset.
- **`electron/liveAgentTracker.ts`** (new, not a port — this is genuinely
  new logic, since Round 1 found TokenMonitor's own completion-detection has
  the bug this design specifically fixes) — `createLiveAgentTracker(projectsRoot)`
  returns a `tick(): Promise<RealAgentDispatch[]>` closure:
  - Calls `findMostRecentSessionFile` on **every tick** (fixing TokenMonitor's
    "only once at startup" bug directly — this is the whole reason Round 1's
    finding mattered).
  - If the active file has changed (including the very first tick after
    launch): **replay the entire new file from byte 0** through
    `applyLinesToOpenDispatches([], allLines)`, rather than skipping to the
    file's current end. This is deliberately the same handling for "just
    switched sessions" and "just launched with a dispatch already running" —
    replaying the whole file is self-correcting (a dispatch that already
    completed has its completion event replayed too, which removes it from
    the map before replay finishes), so this never "floods" the UI with
    stale completed history despite reading the whole file.
  - If the active file is unchanged: read only new bytes since the last
    offset via `transcriptTailer`, and call
    `applyLinesToOpenDispatches(<previous result>, <new lines>)`.
  - Returns the resulting `RealAgentDispatch[]` either way.
- **`electron/main.ts`** (modified) — a new `setInterval(tick, 1000)` (its
  own independent timer, matching this file's existing pattern of one timer
  per concern — pty has none, usage-scan has its own 60s one), pushing the
  result via `mainWindow.webContents.send('agents:snapshot', dispatches)`.
- **`electron/preload.ts`** (modified) — adds a read-only
  `agents.onSnapshot(callback): () => void` listener, matching `usage`'s
  existing one-way push pattern.
- **`src/aetherElectron.d.ts`** (modified) — types it.

### State + renderer wiring

- `src/state/types.ts`: `RealAgentDispatch` (re-exported or duplicated from
  `liveAgentsMath.ts` — plan decides which) added to `AetherState` as
  `realAgents: RealAgentDispatch[]`.
- `src/state/initialState.ts`: seeded `realAgents: []` — also what a
  plain-browser session (`npm run dev`, no Electron) permanently shows, no
  special fallback UI needed (matching Phase 2's precedent).
- `src/state/reducer.ts`: new `SET_REAL_AGENTS` action, replacing
  `state.realAgents` wholesale on each push.
- **`src/state/useRealAgentsSync.ts`** (new) — mirrors `usePulseDurationVar`/
  `useRealUsageSync`'s pattern (a small effect-only hook, called once at the
  App root). Placed under `src/state/` rather than `src/components/dashboard/`
  (where Phase 2's equivalent lives) because this data is consumed by *two*
  feature areas (Terminal and Dashboard), not owned by either.
- `src/App.tsx`: a new `RealAgentsSync` component mounted alongside the
  existing `PulseDurationSync`/`RealUsageSync`.

### `src/utils/format.ts`: new `fmtElapsed(ms: number): string`

A real dispatch has no "% complete" — there's no equivalent to `Agent.pct`.
Both redesigned cards show a live-ticking elapsed-time readout instead,
computed client-side (`now - new Date(dispatch.startedAt).getTime()`, where
`now` is a local per-component `useState` ticked every second via its own
`useEffect`+`setInterval` — self-contained, doesn't touch global state or
`tick.ts`). `fmtElapsed` is a new small formatting helper (not a reuse of
the existing `fmtEta`, which has different semantics — "time until
depletion," including an `n/a` fallback for `<= 0` that would be wrong for
"time elapsed so far," where 0 is a normal, valid value right after a
dispatch starts):

```ts
export function fmtElapsed(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
```

### `ActiveAgentsCard.tsx` / `ActiveAgentsDigest.tsx` (both rewritten)

Both drop their `pct`-based fill bar (no real equivalent), per-agent `hue`
(a real dispatch has no per-agent color identity — both use a single fixed
accent color), the click-to-navigate/select behavior (nothing to navigate to
in this slice — see Non-goals), and their action controls (SPAWN+/VIEW ALL).
Both read `state.realAgents` instead of `state.agents`, showing
`subagentType` (in the name slot) and `description` (in the task slot), with
a live `fmtElapsed(now - startedAt)` readout in place of the `pct` badge.
Empty state ("no agents currently running") matches this project's
established empty-state-message convention (e.g. Memory's "no memories
logged yet").

## Data flow

App launches → `useRealAgentsSync()` registers a listener → main process's
`liveAgentTracker` fires its first tick, replays whatever session is
currently most-recently-active, and pushes the reconstructed open-dispatch
set → `SET_REAL_AGENTS` updates `state.realAgents` → both cards render real
data. Every second thereafter: the tracker re-checks which session is
active (switching and replaying if it changed), tails new lines from the
current file, updates its open-dispatch set, and pushes again. A dispatch
appears in the UI the moment its `tool_use` line is tailed, and disappears
the moment its real `task-notification` completion event is tailed —
independent of the earlier, misleading launch-acknowledgment `tool_result`
that Round 1 found TokenMonitor's own tracking incorrectly reacts to. In
plain-browser mode (`npm run dev`), `window.aetherElectron` is `undefined`,
`useRealAgentsSync`'s subscribe call is a no-op, and `state.realAgents`
never leaves its seeded empty array.

## Error handling / edge cases

- **No active session found** (`~/.claude/projects` doesn't exist, or is
  empty): `findMostRecentSessionFile` returns `null`; the tracker returns an
  empty array without error — both cards show their empty state.
- **Malformed/partial JSON line**: `applyLinesToOpenDispatches`'s `try/catch`
  around `JSON.parse` skips it silently — one bad line never crashes the
  whole tick (this matters more here than in Phase 2's batch scan, since a
  tail read can genuinely catch a line mid-write if the newline-truncation
  logic in `transcriptTailer` ever has an edge case; skipping unparseable
  lines is deliberately not treated as a hard error).
- **The `origin.kind === 'task-notification'` field convention changes in a
  future Claude Code CLI version**: this is empirically verified against
  real current data, not documented — accepted as the best available
  signal, but not a hard protocol guarantee. If it ever changes, the
  practical failure mode is graceful: dispatches would simply stop being
  detected as completing (appearing to run indefinitely) rather than the
  app crashing — noted here explicitly rather than silently assumed stable.
- **A completion event whose `tool-use-id` doesn't match any currently-open
  dispatch** (e.g. the dispatch's `tool_use` line was in a part of the file
  tailed before this feature existed, or belongs to a different, unrelated
  tool): `Map.delete` on a missing key is a safe no-op.

## Testing

**Unit tests** (`liveAgentsMath.test.ts`, new): `applyLinesToOpenDispatches`
gets real-shaped fixtures (matching the exact verified JSON structures from
both research rounds) covering: a dispatch start line adds an open entry; a
matching real completion line (`origin.kind:"task-notification"`, content
containing `<tool-use-id>`) removes it; **a `queue-operation` line must be
ignored even when its `content` contains `<task-notification>` XML** — this
is the single most important test in the whole suite, directly proving
Round 2's finding is actually implemented, not just described; an ordinary
`type:"user"` message without `origin.kind` set is not treated as a
completion signal; a `tool_use` block with a name other than `"Agent"` is
ignored; multiple simultaneously-open dispatches where only one completes
leaves the other open; a completion event for an unknown `tool-use-id` is a
safe no-op; malformed JSON lines are skipped without throwing; passing a
non-empty `currentOpen` (simulating incremental tailing) correctly continues
from and can remove entries in that prior state, not just a fresh `[]`.

**No new tests for `activeSessionFinder.ts`/`transcriptTailer.ts`** — both
are near-verbatim ports of already-tested TokenMonitor code, fs-touching
main-process code outside this project's Vitest/`tsc -b` gate (matching
Phase 0-2's established precedent for `electron/*.ts`).

**Manual verification (plan-exit):**
1. `npm run electron:dev` — with a real Claude Code session actively running
   somewhere on the machine (e.g. this very coding session, or a fresh
   dispatch triggered in aether-os's own real Terminal), confirm a real
   dispatch appears in both `ActiveAgentsCard` and `ActiveAgentsDigest`
   within about a second of it starting, showing its real subagent type and
   description with a live-ticking elapsed time.
2. Confirm the dispatch disappears from both cards only once it *actually*
   finishes — not within the first second or two (which would indicate the
   misleading launch-acknowledgment bug reappeared), by comparing against
   when the real work visibly completes.
3. Confirm switching to a different Claude Code session (e.g. opening a
   fresh terminal window elsewhere and starting a new session) causes the
   tracker to follow it — a dispatch from the newly-active session should
   appear; the previously-tracked session's dispatches (if any were open)
   should not carry over incorrectly.
4. Confirm both cards' empty states render correctly when no dispatches are
   open.
5. Confirm every other view (Agents, Grid, Analytics, Files, Memory, Chat)
   still renders exactly as before — untouched, still fictional.
6. Confirm `npm run dev` (plain browser) shows both cards' empty states
   without crashing.
