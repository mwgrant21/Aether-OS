# Real Live Output (Phase 4) — Design

## Context

Phase 3 (shipped, see `PROGRESS.md`) closed out the "real-agents migration" —
Terminal, Dashboard, Agents, Grid, Analytics, Memory, and Chat all read real
dispatch data now. One simulated surface was explicitly out of scope in every
prior phase's non-goals (Phase 1's design spec names it directly):
`LiveOutputCard` ("LIVE OUTPUT" panel, Terminal's side rail). It still reads
`state.logs`, which is written only by `src/state/tick.ts`'s `computeTick()`
— a 900ms interval that, 30% of each tick, appends a random line from a
hardcoded `LOG_MESSAGES` pool (`'Code Builder: merging changes…'`, etc.), and
separately appends a line whenever the fictional `AUTO`-mode approval
simulation auto-approves a fictional agent's fictional request. Neither
producer reflects anything actually happening in the app.

An exploration pass (this session, read every file in `src/state/`) found
several real events that already flow through the reducer but are currently
silent — no log line, no UI surface at all beyond their own specific
consumer:

- **Dispatch started** — `SET_REAL_AGENTS` receives a fresh snapshot every 1s
  from `liveAgentTracker.ts`'s transcript tail; a dispatch appearing in
  `action.agents` that wasn't in `state.realAgents` is a real start event,
  but nothing currently detects the *added* side of that diff (only
  `detectCompletedDispatches`, the *removed* side, exists — used to create a
  Memory entry).
- **Dispatch completed, with real usage** — `RECORD_DISPATCH_USAGE` fires
  from a wholly separate IPC event (`agents:completed`, sourced from
  `<task-notification>` lines in the transcript), carrying
  `CompletedDispatchUsage` — the dispatch's own `subagentType`/`description`
  plus real `tokens`/`toolUses`/`durationMs`. This is strictly richer than
  `SET_REAL_AGENTS`'s own completion diff (which only proves the dispatch
  disappeared, not why or with what cost) and is silent today.
- **Dispatch channel opened** — `CREATE_DISPATCH_CHANNEL` (manual "+ NEW"
  picker) and `SET_REAL_AGENTS`'s own auto-create branch (when
  `cfg.autoCreateDispatchChannels` is on) both construct a real
  `DispatchChannelStub` — silent today.

Per the user's explicit scope decision (confirmed before writing this spec,
via two design questions): this phase surfaces exactly these three real
event kinds — **dispatch started, dispatch completed (enriched with real
token/tool-use/duration usage), dispatch channel opened** — nothing else.
Tool-use-level activity (`state.activeWork`, one entry per individual tool
call, updated as a full-replacement snapshot every 1s) is deliberately
**not** wired in this phase — it would dominate the feed's volume for a
single dispatch doing many tool calls, a genuinely separate design question
the user chose to defer.

The user also chose an **honest empty state**: when there is no real
activity, the panel says so, rather than falling back to `tick.ts`'s old
random filler (which would just reintroduce the fictitious-data problem this
phase exists to fix, one level removed).

**A load-bearing existing precedent this spec follows exactly:** Phase 3
slice 7's ledger entry documents that `SET_REAL_AGENTS` (IPC event
`agents:snapshot`) and `RECORD_DISPATCH_USAGE` (IPC event `agents:completed`)
are **two independent pipelines with no ordering guarantee between them**,
confirmed safe specifically because they write to disjoint state fields.
This spec preserves that independence: the "dispatch completed" log line is
emitted **only** from `RECORD_DISPATCH_USAGE` (the one event that actually
carries usage numbers), not duplicated or coupled with `SET_REAL_AGENTS`'s
own completion diff. **Known, accepted limitation** (documented rather than
solved, matching this project's Memory-slice-5 precedent for the same class
of gap): if `agents:completed` never fires for a given dispatch — the
ledger's own documented edge case for a session-switch/replay scenario —
that dispatch gets no "completed" log line at all, even though
`SET_REAL_AGENTS`'s diff (and thus Memory's existing, unrelated trigger)
still correctly detects it. This does not affect Memory, Chat, or Analytics,
none of which this phase touches.

## Goal

Replace `state.logs`'s only producer (`tick.ts`'s random filler) with real
event data, and make `LiveOutputCard` honestly reflect true idle state
instead of always claiming "STREAMING".

## Non-goals

- **No `state.activeWork` (tool-use-level) log lines this phase** — explicit
  user scope decision, see Context.
- **No changes to the fictional approval/notification system's own
  behavior** — `state.approvals`/`state.notifs`/`APPROVAL_POOL` and the
  auto-approval simulation branch in `tick.ts` stay exactly as fictional as
  they are today. The **only** change inside that branch is removing the one
  line that wrote into `state.logs` (see Architecture) — `notifs`/`unread`
  are untouched.
- **No changes to `ReactorCore`, `SystemOverviewCard`, or `ActiveAgentsCard`**
  — still fictional/real exactly as Phase 1/Phase 3 left them. `state.sys`
  (CPU/MEM/NET/DISK) and the approvals queue are separate future candidates,
  not this phase's job.
- **No new IPC channels, no electron-layer changes.** Every real event this
  phase surfaces already exists in `state` via an existing reducer action —
  this is a purely renderer-side (`src/state/`, one component) slice, like
  Memory's slice 5.
- **No change to `Analytics`' `LogFrequencyCard`** — it already buckets
  `state.logs` by the three colors used app-wide; this phase's new log
  entries use colors already in that set (`#7fd8ef`, `#3be0a0`), so no
  bucket/color-mapping change is needed. (Verified: `LogFrequencyCard`'s
  color list was grepped from every log-producing site at Analytics-view
  design time; this phase does not introduce a new color.)

## Architecture

### `src/state/liveAgentsMath.ts` (modified)

Add `detectStartedDispatches`, the symmetric counterpart to the existing
`detectCompletedDispatches` (same file, same diff-by-`toolUseId` approach,
opposite direction):

```ts
export function detectStartedDispatches(oldAgents: RealAgentDispatch[], newAgents: RealAgentDispatch[]): RealAgentDispatch[] {
  const wasOpen = new Set(oldAgents.map((a) => a.toolUseId));
  return newAgents.filter((a) => !wasOpen.has(a.toolUseId));
}
```

### `src/state/reducer.ts` (modified)

Import `detectStartedDispatches` alongside the existing
`detectCompletedDispatches` import (line 2), and `nowLong`/`short` alongside
the existing `nowShort` import (line 5 — `short` is `src/utils/format.ts`'s
existing token-abbreviation helper, e.g. `12500` → `'12.5K'`, already used
elsewhere in the app for token counts; `nowLong` is the existing
`HH:MM:SS`-format helper `tick.ts` used for every prior `logs` entry —
reusing it keeps this phase's new entries visually identical in timestamp
format to the old fictional ones).

Three case bodies gain a `logs` write, all using the same
`.concat({...}).slice(-14)` cap `tick.ts`'s removed code used (kept
identical so `LiveOutputCard`'s `.slice(-8)` display window and
`LogFrequencyCard`'s bucketing behavior are unaffected by the cap size):

**`SET_REAL_AGENTS`** — add a `started` diff alongside the existing
`completed` diff, and a `logs` accumulator alongside the existing
`memories`/`memSeq`/`recentCompletedDispatches`/`dispatchChannels`
accumulators:

```ts
case 'SET_REAL_AGENTS': {
  const completed = detectCompletedDispatches(state.realAgents, action.agents);
  const started = detectStartedDispatches(state.realAgents, action.agents);
  let memories = state.memories;
  let memSeq = state.memSeq;
  let recentCompletedDispatches = state.recentCompletedDispatches;
  let dispatchChannels = state.dispatchChannels;
  let logs = state.logs;

  for (const dispatch of started) {
    logs = logs.concat({ t: nowLong(), m: `${dispatch.subagentType}: ${dispatch.description || 'dispatch started'}`, c: '#7fd8ef' }).slice(-14);
  }

  for (const dispatch of completed) {
    const label = dispatch.description || dispatch.subagentType;
    memories = [
      ...memories,
      {
        id: memSeq,
        name: label,
        content: `${dispatch.subagentType} dispatch completed: ${dispatch.description || 'no description'}`,
        source: dispatch.subagentType,
        ts: nowShort(),
        pinned: false,
        strength: 100,
        toolUseId: dispatch.toolUseId,
      },
    ];
    memSeq += 1;

    recentCompletedDispatches = [dispatch, ...recentCompletedDispatches].slice(0, 20);

    if (state.cfg.autoCreateDispatchChannels && !dispatchChannels.some((d) => d.toolUseId === dispatch.toolUseId)) {
      dispatchChannels = [
        ...dispatchChannels,
        {
          toolUseId: dispatch.toolUseId,
          subagentType: dispatch.subagentType,
          description: dispatch.description,
          prompt: dispatch.prompt,
          model: dispatch.model,
          startedAt: dispatch.startedAt,
          createdAt: nowShort(),
        },
      ];
      logs = logs.concat({ t: nowLong(), m: `${dispatch.subagentType}: dispatch channel opened`, c: '#7fd8ef' }).slice(-14);
    }
  }
  return { ...state, realAgents: action.agents, memories, memSeq, recentCompletedDispatches, dispatchChannels, logs };
}
```

Note: this deliberately does **not** add a log line for `completed` itself
(only for `started` and for the auto-create-channel side effect within that
same loop) — the "dispatch completed" line comes from `RECORD_DISPATCH_USAGE`
below, per the Context section's independent-pipelines rationale. The
existing Memory-creation logic in this loop is untouched byte-for-byte.

**`RECORD_DISPATCH_USAGE`** — the actual source of "dispatch completed" log
lines, since `CompletedDispatchUsage` (the `action.completed` element type)
already extends `RealAgentDispatch`, giving it `subagentType` for free
alongside the real `tokens`/`toolUses`/`durationMs`:

```ts
case 'RECORD_DISPATCH_USAGE': {
  let dispatchUsage = state.dispatchUsage;
  let logs = state.logs;
  for (const c of action.completed) {
    dispatchUsage = { ...dispatchUsage, [c.toolUseId]: { tokens: c.tokens, toolUses: c.toolUses, durationMs: c.durationMs } };
    logs = logs.concat({ t: nowLong(), m: `${c.subagentType}: ${short(c.tokens)} tok · ${c.toolUses} tool call${c.toolUses === 1 ? '' : 's'} · ${fmtElapsed(c.durationMs)}`, c: '#3be0a0' }).slice(-14);
  }
  const keys = Object.keys(dispatchUsage);
  if (keys.length > 100) {
    const toEvict = new Set(keys.slice(0, keys.length - 100));
    dispatchUsage = Object.fromEntries(Object.entries(dispatchUsage).filter(([k]) => !toEvict.has(k)));
  }
  return { ...state, dispatchUsage, logs };
}
```

(`fmtElapsed` is `src/utils/format.ts`'s existing ms→human-duration helper,
already imported by other files for the same "how long did this take"
purpose — add it to reducer.ts's `../utils/format` import alongside
`nowShort`/`nowLong`/`short`.)

**`CREATE_DISPATCH_CHANNEL`** (the manual "+ NEW" picker path — the other of
the two places a `DispatchChannelStub` gets constructed) — same log line as
`SET_REAL_AGENTS`'s auto-create branch, for the same real event:

```ts
case 'CREATE_DISPATCH_CHANNEL': {
  const alreadyExists = state.dispatchChannels.some((d) => d.toolUseId === action.toolUseId);
  const dispatch = state.recentCompletedDispatches.find((d) => d.toolUseId === action.toolUseId);
  if (alreadyExists || !dispatch) return state;
  const stub: DispatchChannelStub = {
    toolUseId: dispatch.toolUseId,
    subagentType: dispatch.subagentType,
    description: dispatch.description,
    prompt: dispatch.prompt,
    model: dispatch.model,
    startedAt: dispatch.startedAt,
    createdAt: nowShort(),
  };
  const logs = state.logs.concat({ t: nowLong(), m: `${dispatch.subagentType}: dispatch channel opened`, c: '#7fd8ef' }).slice(-14);
  return { ...state, dispatchChannels: [...state.dispatchChannels, stub], logs };
}
```

### `src/state/tick.ts` (modified)

Remove the now-dead `LOG_MESSAGES` const (lines 4-13) entirely — nothing
else references it. Remove the `let logs = state.logs; if (Math.random() <
0.3) { ... }` block (lines 50-54) entirely — `logs` is no longer read or
written anywhere in this file. In the `AUTO`-mode auto-approval branch,
remove only the one line that wrote to `logs`:

```ts
    if (mode === 'AUTO' && req.risk !== 'HIGH') {
      logs = logs.concat({ t: nowLong(), m: `${ag.name}: auto-approved — ${req.action.toLowerCase()}`, c: '#3be0a0' }).slice(-14);
      notifs = [{ t: nowShort(), m: `Auto-approved: ${req.action} (${ag.name})`, c: '#3be0a0' }, ...notifs].slice(0, 12);
      unread += 1;
    } else {
```

becomes:

```ts
    if (mode === 'AUTO' && req.risk !== 'HIGH') {
      notifs = [{ t: nowShort(), m: `Auto-approved: ${req.action} (${ag.name})`, c: '#3be0a0' }, ...notifs].slice(0, 12);
      unread += 1;
    } else {
```

`notifs`/`unread`/the whole rest of the fictional approval simulation is
otherwise byte-for-byte unchanged (Non-goals). Remove `logs` from the final
return object literal (`computeTick` no longer produces it at all — `TICK`'s
existing reducer case, `{ ...state, ...computeTick(state) }`, leaves
`state.logs` untouched by ticks, exactly as intended). Remove the now-unused
`nowLong` import (`nowShort` stays, still used by the alarm/approval `notifs`
lines).

### `src/components/terminal/LiveOutputCard.tsx` (modified)

Honest empty state, mirroring `ActiveAgentsCard.tsx`'s exact established
convention (`emptyStyle` constant, lowercase sentence, `colors.textDim`,
rendered inline in the scrollable area) — the same "no agents currently
running" pattern this app already uses for real-only real-time data:

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function LiveOutputCard() {
  const { state } = useAetherStore();
  const logs = state.logs.slice(-8);
  const isActive = logs.length > 0;
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flex: 'none' }}>
        <div style={titleStyle}>LIVE OUTPUT</div>
        {isActive ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 10px/1 ${fonts.mono}`, color: colors.accentCyan }}>
            <span style={blinkDotStyle} />
            STREAMING
          </div>
        ) : (
          <div style={{ font: `400 10px/1 ${fonts.mono}`, color: colors.textDim }}>IDLE</div>
        )}
      </div>
      <div style={logListStyle}>
        {logs.map((l, idx) => (
          <div key={idx} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ color: colors.textDim }}>[{l.t}]</span> <span style={{ color: l.c }}>{l.m}</span>
          </div>
        ))}
        {!isActive && <div style={emptyStyle}>no activity yet</div>}
      </div>
    </div>
  );
}
```

Add one new style constant, copied verbatim from `ActiveAgentsCard.tsx`'s
own `emptyStyle` (same file already establishes this exact convention):

```ts
const emptyStyle: CSSProperties = {
  font: `500 12px/1.4 ${fonts.ui}`,
  color: colors.textDim,
  padding: '8px 2px',
};
```

`isActive` is derived from `logs.length > 0` (the already-sliced last-8
view, not the full `state.logs`) — deliberately simple presence check, not a
staleness/recency window (e.g. "activity in the last N minutes"); a
timestamp-based staleness check was considered and rejected as unnecessary
scope for this phase — `state.logs` only ever grows from genuinely real
events now, so any entry present is honest by construction, whether it
happened 5 seconds or 5 hours ago. `blinkDotStyle`/`cardStyle`/`titleStyle`/
`logListStyle` are all pre-existing, untouched.

## Data flow

Dispatch starts (real `Agent` tool_use appears in a tailed transcript) →
`liveAgentTracker.ts` → IPC `agents:snapshot` → `useRealAgentsSync.ts` →
`SET_REAL_AGENTS` → `detectStartedDispatches` finds it new → a log line is
appended. Independently and asynchronously, when that same dispatch's
`<task-notification>` completion line is tailed → IPC `agents:completed` →
`RECORD_DISPATCH_USAGE` → a second, separate log line is appended (with real
usage numbers) — not derived from or ordered against the first pipeline in
any way, per the Context section's precedent. Opening a dispatch channel
(auto or manual) appends a third kind of line from whichever of
`SET_REAL_AGENTS`/`CREATE_DISPATCH_CHANNEL` triggered it.

## Error handling / edge cases

- **`agents:completed` never fires for a given dispatch** (documented
  Phase-3 edge case): that dispatch gets a "started" line but no "completed"
  line. Accepted, matching the Context section's stated precedent — Memory's
  own completion tracking is unaffected (different pipeline).
- **Multiple dispatches start/complete in the same 1s tick**: both loops
  (`started`/`completed` in `SET_REAL_AGENTS`, `action.completed` in
  `RECORD_DISPATCH_USAGE`) already iterate arrays, so multiple simultaneous
  events each get their own line, in array order — no different from how
  `completed`'s existing Memory-creation loop already handles multiple
  simultaneous completions today.
- **`state.logs` cap (`slice(-14)`)**: unchanged from `tick.ts`'s original
  cap value — a burst of real events (e.g. 5 dispatches completing at once)
  can still push older real lines out exactly as a burst of fictional ones
  could before; not a new failure mode, just the same existing cap now
  fed by real data.

## Testing

**Unit tests** (`src/state/liveAgentsMath.test.ts`, new `describe` block
mirroring the existing `detectCompletedDispatches` block's exact fixtures
and structure):

```ts
describe('detectStartedDispatches', () => {
  const tu1: RealAgentDispatch = {
    toolUseId: 'tu_1',
    subagentType: 'general-purpose',
    description: 'first',
    startedAt: '2026-07-20T10:00:00.000Z',
    prompt: '',
    model: null,
  };
  const tu2: RealAgentDispatch = {
    toolUseId: 'tu_2',
    subagentType: 'Explore',
    description: 'second',
    startedAt: '2026-07-20T10:00:05.000Z',
    prompt: '',
    model: null,
  };

  it('returns an empty array when the two lists are identical', () => {
    expect(detectStartedDispatches([tu1, tu2], [tu1, tu2])).toEqual([]);
  });

  it('returns the one dispatch that newly appeared', () => {
    expect(detectStartedDispatches([tu1], [tu1, tu2])).toEqual([tu2]);
  });

  it('returns multiple dispatches when several appear at once', () => {
    expect(detectStartedDispatches([], [tu1, tu2])).toEqual([tu1, tu2]);
  });

  it('returns an empty array when a dispatch is only removed, not added', () => {
    expect(detectStartedDispatches([tu1, tu2], [tu1])).toEqual([]);
  });

  it('separates a simultaneous add and remove correctly', () => {
    expect(detectStartedDispatches([tu1], [tu2])).toEqual([tu2]);
  });
});
```

**Reducer tests** (`src/state/reducer.test.ts`): new assertions that
`SET_REAL_AGENTS` appends a `logs` entry for a newly-started dispatch and
for an auto-created channel (extending existing `SET_REAL_AGENTS` test
setup already in this file), that `RECORD_DISPATCH_USAGE` appends a `logs`
entry containing the dispatch's `subagentType` and formatted token/duration
figures, and that `CREATE_DISPATCH_CHANNEL` appends a `logs` entry.

**`tick.test.ts`**: existing tests referencing `logs` in `computeTick`'s
return value (if any — check via `grep -n logs src/state/tick.test.ts`
before writing this task) need updating to assert `logs` is no longer part
of the returned patch at all, rather than asserting on its old random
content.

**Manual verification (plan-exit, via `npm run electron:dev`):**
1. With no dispatch running, confirm LiveOutputCard shows "no activity yet"
   and the "IDLE" badge (not "STREAMING").
2. Trigger a real dispatch (e.g. via a `spawn`-style real Agent tool call
   from Claude in the pty terminal) and confirm a "dispatch started" line
   appears in real time.
3. Let it complete and confirm a second line appears with real token/tool-
   use/duration numbers, and that the badge/empty-state correctly flips to
   "STREAMING" once the first real line lands.
4. Confirm Analytics' `LogFrequencyCard` counts still update correctly for
   the two new colors used (`#7fd8ef`/`#3be0a0`, both already in its
   existing bucket set).
5. Confirm the fictional AUTO-mode approval simulation still fires its
   `notifs` entry (bell icon) exactly as before, but no longer writes
   anything into Live Output.
