# Real Active Agents in the Agents View (Phase 3, slice 2) — Design

## Context

Phase 3's first slice (shipped, `0b8b7b5`) replaced exactly two widgets — Terminal's
`ActiveAgentsCard` and Dashboard's `ActiveAgentsDigest` — with real, live-tailed
Claude Code `Agent`-tool dispatch data, sourced from whichever session is globally
most-recently-active. Everything else (`state.agents`, Grid, Analytics, Files,
Memory, Chat, and the Agents view itself) was deliberately left reading the
fictional roster, on the explicit reasoning that "Agents" is referenced by nearly
every view and a full cutover in one pass was too large and risky.

This slice is the next deliberately narrow increment, chosen by the user from three
options (Agents view / per-dispatch history / a different phase): bring real data
into the Agents view specifically. Grid, Analytics, Files, Memory, and Chat remain
untouched and keep reading `state.agents` — this slice touches exactly the two
files that make up the Agents view's roster+detail pair, the same "narrow slice"
discipline as the first one.

## Goal

`AgentRosterCard` and `AgentDetailCard` (together, `AgentsView`) read
`state.realAgents` instead of `state.agents`. Selecting a real dispatch shows a
read-only detail summary, including two fields not yet surfaced anywhere in the
app: the dispatch's full `prompt` text and its `model` (when specified).

## Non-goals

- **No changes to Grid, Analytics, Files, Memory, or Chat.** All five keep reading
  the fictional `state.agents` roster, completely unchanged. `state.agents`/
  `tick.ts`/`makeAgent()` are untouched.
- **No pct/ETA progress bar, no token-draw sparkline, no files list, no pending-
  authorization section, no PAUSE/TERMINATE buttons.** None of these have a real
  equivalent for a live subagent dispatch — a real dispatch has no notion of
  "percent complete," no file-touch history visible to this app, no tie to the
  fictional approval queue (which is keyed by fictional agent name), and cannot be
  paused or killed from the UI (this app has no mechanism to send either signal
  into a real Claude Code session).
- **No IDLE section, no REACTIVATE action.** A real dispatch has no "idle,
  reactivatable" state — it is either currently open or already gone (its
  completion event removed it). The roster's `IDLE (N)` block and its
  `REACTIVATE` buttons are removed from this view entirely, not repurposed.
- **No SPAWN + button**, matching the first slice's identical removal from
  Terminal's card — this app has no real mechanism to launch a new Agent
  dispatch from a UI click.
- **No per-dispatch token/duration/tool-use history** (the completion event's
  `<usage>` XML) — still deliberately deferred, same as the first slice. This
  slice only ever shows *currently open* dispatches; a dispatch that's completed
  disappears, exactly as it does in the Terminal/Dashboard cards.
- **No new approvals, no new commands.** `commands.ts`'s `spawn`/`kill`/`pause`
  terminal commands are untouched and still operate on the fictional roster only.

### A real, known consequence of this scope — not fixed here, flagged for the user

`GridView.tsx`'s node clicks and `FilesView.tsx`'s file-row clicks both
currently dispatch `SELECT_AGENT` (a *fictional* agent name) followed by
`SET_ACTIVE_TAB: 'Agents'`, on the expectation that the Agents tab will show
that exact fictional agent's detail card. Once `AgentsView` reads
`state.realAgents`/`state.selectedRealAgent` instead, that expectation breaks:
clicking a file in Files (or a node in Grid) still correctly sets
`state.selected` and still navigates to the Agents tab, but the tab now shows
real dispatch data — not the fictional agent that was clicked. `state.selected`
itself is unaffected (still holds the right fictional name), but landing on the
Agents tab no longer surfaces it anywhere, since nothing in this slice's
rewritten `AgentsView` reads `state.selected` at all anymore.

This is an accepted, deliberate trade-off of the chosen scope (real dispatches
replace the roster, Grid/Files stay untouched) — not something this slice
attempts to fix, since fixing it would mean either reintroducing a fictional
section into `AgentsView` (the option explicitly not chosen) or changing
Grid/Files' navigation targets (out of this slice's Non-goals). Flagged here
explicitly rather than silently accepted, so it's a known and named consequence,
not a bug discovered later.

## Architecture

### `RealAgentDispatch` extended, not replaced

`src/state/liveAgentsMath.ts`'s existing interface gains two fields, read off the
same `tool_use` block `applyLinesToOpenDispatches` already parses (`item.input`):

```ts
export interface RealAgentDispatch {
  toolUseId: string;
  subagentType: string;
  description: string;
  startedAt: string;
  prompt: string;
  model: string | null;
}
```

- `prompt` defaults to `''` if absent (mirroring `description`'s existing
  `|| ''` fallback) — confirmed universal in real transcript data, but a fallback
  costs nothing and matches the file's existing defensive style.
- `model` defaults to `null` (not `''`) — it's genuinely absent on most real
  dispatches (only present when a dispatch explicitly overrides the default
  model), so a nullable field is the honest representation, distinct from "empty
  string was specified."

This is a backward-compatible extension of Task 1's existing pure function — no
new parsing branch, no new file. Terminal's `ActiveAgentsCard` and Dashboard's
`ActiveAgentsDigest` (first slice) are unaffected: they destructure only the
fields they already use and simply don't reference the two new ones.

### New selection state, independent of `state.selected`

`state.selected` is exclusively "which fictional agent is selected," relied on by
`GridView.tsx`'s node clicks and `FilesView.tsx`'s file-row navigation (both
dispatch `SELECT_AGENT` with a fictional agent's `name` and expect `state.selected`
to keep meaning that). Reusing it for real dispatches would collide: a
`toolUseId` is not a fictional agent name, and `pickSelectedAgent`'s fallback
logic (`agents.find(a => a.name === selected) ?? agents[0]`) has no meaningful
interpretation of a `toolUseId` value.

This slice adds a new, fully independent field, following the exact pattern
already established for `selectedProject`/`selectedMemory`:

```ts
// AetherState
selectedRealAgent: string | null; // a RealAgentDispatch.toolUseId, or null
```

```ts
// reducer.ts Action union
| { type: 'SELECT_REAL_AGENT'; toolUseId: string }
```

```ts
case 'SELECT_REAL_AGENT':
  return { ...state, selectedRealAgent: action.toolUseId };
```

A new pure selector in `agentsMath.ts` (or a small new file — see File Structure
below), mirroring `pickSelectedAgent`'s exact shape:

```ts
export function pickSelectedRealAgent(agents: RealAgentDispatch[], selected: string | null): RealAgentDispatch | null {
  if (selected) {
    const match = agents.find((a) => a.toolUseId === selected);
    if (match) return match;
  }
  return agents[0] ?? null;
}
```

`selectedRealAgent` is **not** added to `persistence.ts`'s whitelist — a real
dispatch's `toolUseId` from a prior app session is almost certainly gone by the
time the app reopens (the session that produced it has likely ended), so
persisting it would just select nothing (falling back to `agents[0]` per the
selector above) or, worse, silently select an unrelated dispatch that happens to
reuse a stale id. `state.selected`'s persistence (fictional agents, which *do*
survive reload since they're simulated) is untouched.

### `AgentRosterCard` (rewritten)

Rows read `state.realAgents` instead of `state.agents`: avatar (subagent-type
initials, fixed `colors.accentCyanSoft`, matching the first slice's card
convention exactly — no per-row hue, since real dispatches have no color
identity), `subagentType` + live-ticking `fmtElapsed`, `description` as a
secondary line. Clicking a row dispatches `SELECT_REAL_AGENT` (not
`SELECT_AGENT`). The `SPAWN +` header button and the entire `IDLE (N)` block are
removed. Empty-state copy becomes `"no agents currently running"`, matching the
first slice's established wording (replacing the old `"no active agents — spawn
one to get started"`, which references a spawn action that no longer exists in
this view).

### `AgentDetailCard` (rewritten)

Takes a `RealAgentDispatch | null` instead of `Agent | null`. When null: the
same "nothing selected" empty state, with copy updated to remove the "spawn or
reactivate" language (`"No agent dispatches are currently running."`). When a
dispatch is selected: avatar, `subagentType` as the heading (no per-fictional-
agent "name" concept), `model` shown as a small badge next to it when non-null
(omitted entirely when null — not an empty badge), a live `fmtElapsed` readout,
the `description`, and the full `prompt` text in its own labeled section (reusing
the file's existing `sectionLabelStyle` convention, e.g. under a `TASK` or
`PROMPT` label). No pct bar, sparkline, files section, approvals section, or
action buttons — the card is shorter than its fictional-agent predecessor,
which is expected given it now displays only fields with real backing data.

### File structure

| File | Change |
|---|---|
| `src/state/liveAgentsMath.ts` | Add `prompt`/`model` to `RealAgentDispatch`; extend the one existing parsing branch to read `item.input.prompt`/`item.input.model`. |
| `src/state/liveAgentsMath.test.ts` | Extend existing fixtures/assertions to cover the two new fields (present, absent-defaults). |
| `src/state/types.ts` | Add `selectedRealAgent: string | null` to `AetherState`. |
| `src/state/initialState.ts` | Seed `selectedRealAgent: null`. |
| `src/state/reducer.ts` | Add `SELECT_REAL_AGENT` action + case. |
| `src/components/agents/agentsMath.ts` | Add `pickSelectedRealAgent` (pure, mirrors `pickSelectedAgent`). |
| `src/components/agents/agentsMath.test.ts` | New tests for `pickSelectedRealAgent`. |
| `src/components/agents/AgentRosterCard.tsx` | Rewrite to read `state.realAgents`, drop SPAWN+/IDLE, dispatch `SELECT_REAL_AGENT`. |
| `src/components/agents/AgentDetailCard.tsx` | Rewrite to accept `RealAgentDispatch \| null`, drop pct/sparkline/files/approvals/actions, add prompt/model display. |
| `src/components/agents/AgentsView.tsx` | Swap `pickSelectedAgent(state.agents, state.selected)` for `pickSelectedRealAgent(state.realAgents, state.selectedRealAgent)`; pass the new selection type through to both cards. |

No changes to `electron/*.ts`, `src/state/useRealAgentsSync.ts`, or the IPC
pipeline — this slice is entirely a renderer-side consumer change plus the
small `liveAgentsMath.ts` field extension; the live-tailing pipeline already
delivers everything needed.

## Data flow

Unchanged from the first slice up through `state.realAgents` — this slice only
changes who reads it. `AgentsView` now derives its selection via
`pickSelectedRealAgent(state.realAgents, state.selectedRealAgent)` instead of
`pickSelectedAgent(state.agents, state.selected)`; clicking a roster row
dispatches `SELECT_REAL_AGENT` with that row's `toolUseId`; the detail card
receives the resolved `RealAgentDispatch | null` and renders directly from it.
When the live tracker's next snapshot removes a completed dispatch from
`state.realAgents`, `pickSelectedRealAgent` naturally falls through to
`agents[0] ?? null` on the next render (identical fallback behavior to the
existing `pickSelectedAgent`) — no explicit "clear selection on completion"
logic is needed.

## Error handling / edge cases

- **A dispatch with no `prompt` in its `tool_use.input`** (should not occur in
  practice per empirical research, but not guaranteed by any schema): renders as
  an empty prompt section rather than `undefined`/crashing, via the same
  `|| ''` fallback pattern `description` already uses.
- **`selectedRealAgent` pointing at a `toolUseId` that's no longer in
  `state.realAgents`** (the dispatch completed since it was selected): handled
  identically to the existing fictional-agent case — `pickSelectedRealAgent`
  falls back to the first remaining dispatch, or `null` if none remain, which
  `AgentDetailCard` already renders as its empty state.
- **`state.realAgents` empty on a plain-browser session** (`npm run dev`, no
  Electron): both cards render their empty states, exactly as the first slice's
  cards already do — no new fallback logic needed here either.

## Testing

**Unit tests:**
- `liveAgentsMath.test.ts`: extend the existing `dispatchLine` test helper (or
  add a variant) to assert `prompt`/`model` are captured when present in
  `tool_use.input`, and default to `''`/`null` when absent — at least one new
  case for each.
- `agentsMath.test.ts`: `pickSelectedRealAgent` gets the same three cases
  `pickSelectedAgent` already has coverage for (matches a valid `toolUseId`,
  falls back to first when `selected` is null, falls back to first when
  `selected` doesn't match any current dispatch), plus the empty-array case
  (`null`).

**No new tests for `AgentRosterCard.tsx`/`AgentDetailCard.tsx`/`AgentsView.tsx`**
 — matching this project's established convention of manual GUI verification for
presentational components, same as the first slice's two card rewrites.

**Manual verification (plan-exit):**
1. With `state.realAgents` empty (default / plain-browser session): confirm the
   roster shows `"no agents currently running"`, no SPAWN+/IDLE section, and the
   detail card shows its empty state.
2. With a real Claude Code session actively dispatching subagents somewhere on
   the machine (this session dispatching a research/implementer subagent is
   sufficient): confirm a real dispatch appears in the roster within about a
   second, showing its subagent type, elapsed time, and description; clicking it
   shows the full prompt text and (if present) the model badge in the detail
   card; the dispatch disappears from both roster and (if selected) resets the
   detail card to empty once it actually completes.
3. Confirm Grid, Analytics, Memory, and Chat show zero regression — all four
   still reference the fictional `state.agents` roster exactly as before, with
   no dependency on the Agents tab's own content.
4. Confirm the known, accepted consequence described above: clicking a file row
   in Files (or a node in Grid) still correctly sets `state.selected` to the
   right fictional agent name and still navigates to the Agents tab, but the
   tab now shows real dispatch data rather than that fictional agent's detail
   card — expected, not a bug, per this slice's chosen scope.
