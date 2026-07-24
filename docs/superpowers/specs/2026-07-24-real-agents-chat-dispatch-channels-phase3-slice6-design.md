# Post-Mortem Channels for Completed Real Dispatches (Phase 3, slice 6) — Design

## Context

Chat's per-agent channels (`src/components/chat/`) are the last Phase 3 target still reading `state.agents`, the fictional roster, exclusively. Investigated before any design work, and found this is architecturally the most entangled of all five prior real-agents slices, for reasons distinct from each of them:

- **Channel identity is persistent and archived-not-deleted** (`chatChannels.ts`'s `deriveChannels`): a channel's `id` is the fictional agent's *name*, alive while the agent is in `state.agents`, archived (greyed, read-only, reactivatable) once it moves to `state.idleList`. Real dispatches carry an ephemeral `toolUseId` with no stable identity across app restarts — there is no real analog to "a channel you can always come back to."
- **There is no live connection to a real running subagent.** This app only ever *observes* a real dispatch by tailing its owning session's transcript file (`electron/liveAgentTracker.ts`); it has no IPC or API into that subagent's actual conversation. "Chatting with the real agent" cannot literally happen — a hard capability gap, not a data-availability gap like Files or Memory hit.
- **Personas are hand-authored voices keyed to 8 fixed fictional names** (`personas.ts`), with a generic `FALLBACK_PERSONA` for anything else. No personality data exists for an arbitrary real `subagentType`.
- **The action-verb pipeline (spawn/kill/theme/renderer/throttle) is fictional-simulation-specific** — `actionExecutor.ts`/`commands.ts` operate exclusively on `state.agents` entries. None of these verbs have a real-world equivalent for a completed real dispatch (you cannot "kill" or "throttle" something that already finished).

Raised to the user directly before any design: real per-agent chat, as it exists today, cannot be relabeled onto real data the way Grid/Agents/Analytics were. The user chose an **additive** direction, matching the spirit of Memory's slice 5 rather than Files' full pivot or Analytics' relabel: leave every existing fictional channel, persona, and action untouched, and add a new *kind* of channel — a post-mortem conversation about a specific completed real dispatch, using a generic persona that's been given that dispatch's real prompt/description as context. Not a live connection to the subagent; a conversation *about* what it was asked to do and (from the completion event) what it reported back.

Two follow-up questions resolved with the user during brainstorming:
- **Channel creation:** manual by default (a "+ NEW" picker in the channel rail), with an opt-in Settings toggle (`autoCreateDispatchChannels`, default **off**) to auto-create a channel on every completion instead — chosen over Memory's "every completion, no filter" precedent because a chat channel is a much heavier, more visible UI surface (the rail) than a list row, and could flood the rail during a busy session if made automatic by default.
- **Lifecycle:** permanent once created, with a manual remove — unlike every other permanent, non-deletable collection in this app (projects, memories), specifically because a post-mortem channel has no "reactivate" concept the way a killed fictional agent does, so an unbounded, un-prunable rail was judged a real problem worth a deliberate exception.

## Goal

Add a third channel kind to Chat — `dispatch` — representing a post-mortem conversation about one specific completed real dispatch. Manually created (or auto-created, if opted in) from a capped pool of recently-completed real dispatches; permanently listed until manually removed; uses a generic persona and a past-tense system prompt built from that dispatch's own real data; never offers the action-verb pipeline.

## Non-goals

- **No live connection to the actual subagent.** Established as impossible, not merely out of scope.
- **No action-verb pipeline in dispatch channels.** Spawn/kill/theme/renderer/throttle are never offered — none apply to a completed real dispatch. The action-JSON paragraph is omitted from this channel kind's system prompt entirely, not merely ignored if emitted.
- **No new persona content.** Reuses the existing `FALLBACK_PERSONA` voice verbatim rather than inventing per-`subagentType` personalities (there could be arbitrarily many real `subagentType` values; hand-authoring for each would be unbounded scope for a cosmetic detail).
- **No editing a dispatch channel's stored snapshot after creation.** The `prompt`/`description`/`subagentType`/`model` captured at creation time are fixed for that channel's lifetime.
- **No cap on `state.dispatchChannels` itself** — only the *pickable pool* (`state.recentCompletedDispatches`) is capped. A channel, once created, is not silently evicted; it's removed only by explicit user action.
- **No archive/reactivate concept for dispatch channels** — they are always either present (read/write, exactly like an active fictional channel) or removed (gone). No "TERMINATED" pill, no greyed-out state.
- **No change to the existing HIGH-risk-approval-resolution → chat bridge** (`state.chatActionResults`) — that mechanism is exclusively for the risky-verb pipeline, which dispatch channels never use.

## Architecture

### State (`src/state/types.ts`)

Two new `AetherState` fields:

```ts
recentCompletedDispatches: RealAgentDispatch[]; // capped pool, most-recent-first, source for the "+ NEW" picker
dispatchChannels: DispatchChannelStub[];          // channels the user has actually created
```

```ts
export interface DispatchChannelStub {
  toolUseId: string;
  subagentType: string;
  description: string;
  prompt: string;
  model: string | null;
  startedAt: string;
  createdAt: string; // when the channel itself was created, not when the dispatch started
}
```

`DispatchChannelStub` deliberately duplicates the source dispatch's fields rather than referencing it by `toolUseId` alone — once a channel exists, it must keep working even after its source entry ages out of the capped `recentCompletedDispatches` pool.

One new `Cfg` field: `autoCreateDispatchChannels: boolean` (seeded `false` in `initialState.ts`). No new reducer action needed for the toggle itself — it goes through the existing generic `UPDATE_CFG` action, same as every other Settings boolean (`glowFx`, `autoThrottle`, `sound`).

### Reducer (`src/state/reducer.ts`)

The `SET_REAL_AGENTS` case (already extended once, by slice 5, to create Memory entries on completion) gets a second extension in the same case, alongside the existing Memory-creation loop — not a separate action, since both are driven by the same `detectCompletedDispatches(state.realAgents, action.agents)` call already computed there:

```ts
for (const dispatch of completed) {
  // ...existing Memory-creation logic (slice 5, untouched)...

  recentCompletedDispatches = [dispatch, ...recentCompletedDispatches].slice(0, 20);

  if (state.cfg.autoCreateDispatchChannels) {
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
  }
}
```

(Cap of 20 for `recentCompletedDispatches`, matching this app's general small-rolling-list convention — e.g. `cmdHist`'s existing 30-entry cap, `logs.slice(-5)` in `buildAetherSnapshot`.)

Two new reducer actions for the manual path:

- `{ type: 'CREATE_DISPATCH_CHANNEL'; toolUseId: string }` — looks up the dispatch in `state.recentCompletedDispatches` by `toolUseId`; if found (and not already in `state.dispatchChannels`), appends a `DispatchChannelStub`. A no-op (returns `state` unchanged) if the `toolUseId` isn't found in the pool — matches this app's established no-op-on-unknown-id convention (`TOGGLE_PROVIDER_CONNECTION` on an unknown name, etc.).
- `{ type: 'REMOVE_DISPATCH_CHANNEL'; toolUseId: string }` — filters it out of `state.dispatchChannels`. A no-op if not present.

### `src/components/chat/chatChannels.ts`

`deriveChannels` merges in a third source, after the existing `archivedChannels`:

```ts
const dispatchChannelEntries: ChatChannel[] = state.dispatchChannels.map((d) => ({
  id: `dispatch:${d.toolUseId}`,
  kind: 'dispatch',
  name: d.description || d.subagentType,
  initials: d.subagentType.slice(0, 2).toUpperCase(),
  hue: colors.accentCyanSoft, // fixed accent, matching this migration's established real-data convention (Grid/Analytics both moved from per-item hue to a fixed accent for real data)
  archived: false,
  toolUseId: d.toolUseId, // new field on ChatChannel, dispatch-kind only
}));
```

`ChatChannel`'s interface gains one new optional field, `toolUseId?: string`, populated only for `kind: 'dispatch'` — needed so `ChannelRail`'s remove button can dispatch `REMOVE_DISPATCH_CHANNEL` without re-parsing the `dispatch:` prefix out of `id`.

### `src/components/chat/systemPrompt.ts`

`buildSystemPrompt` gains a third branch. A new pure builder, `buildDispatchPrompt`, mirrors `buildAgentSnapshot`'s shape but past-tense and without the action-JSON paragraph:

```ts
function buildDispatchPrompt(channel: ChatChannel, state: AetherState): string {
  const stub = state.dispatchChannels.find((d) => d.toolUseId === channel.toolUseId);
  // stub is always found in practice -- a dispatch channel can't exist without its stub existing
  // (CREATE_DISPATCH_CHANNEL and REMOVE_DISPATCH_CHANNEL keep them in lockstep) -- but this function
  // still guards defensively rather than assume, matching this codebase's general precedent
  // (e.g. buildSystemPrompt's own existing `if (!agent)` guard for a since-archived fictional channel).
  if (!stub) return `${FALLBACK_PERSONA.voice} ${referAsInstruction(state.operatorName)}\n\nNo record of this task is available.`;

  return (
    `${FALLBACK_PERSONA.voice} ${referAsInstruction(state.operatorName)}\n\n` +
    `You completed a real task earlier as a Claude Code subagent (type: ${stub.subagentType}). ` +
    `You were asked to: ${stub.prompt || stub.description || 'no task detail was recorded.'}\n\n` +
    `Reply in at most 3 sentences, plain prose only -- no bold, italics, headers, bullet lists, or code fences. ` +
    `Discuss this completed task retrospectively -- you cannot take any further action, spawn/kill/throttle any agent, ` +
    `or change any application setting from this channel.`
  );
}
```

This is a deliberately separate, shorter rules paragraph — not the shared `RULES` constant used by `aether`/`agent` channels — since the action-JSON convention must not appear here at all (a Non-goal above), and duplicating then hand-trimming the shared constant would be more error-prone than writing the (genuinely different) instruction fresh.

### `src/components/chat/ChannelRail.tsx` + `ChatView.tsx`

- `ChannelRail` gains a "+ NEW" row at the bottom of the channel list (below the last channel, matching this app's established "action affordance in the list's own flow" pattern — e.g. `UplinksView`'s pills, `FilesView`'s "+ ADD FILE" — rather than a modal, since this app has no `window.prompt`/modal-input precedent, called out explicitly in Memory's own design doc). Clicking it expands an inline list of `state.recentCompletedDispatches` entries not already present in `state.dispatchChannels` (filtered by `toolUseId`), each showing `subagentType`/`description`/a relative-time readout; clicking an entry dispatches `CREATE_DISPATCH_CHANNEL` and collapses the picker. If the pool is empty or fully already-channeled, the expanded list shows an empty-state line rather than nothing.
- Each `kind: 'dispatch'` row in the rendered channel list gets a small remove (×) affordance, dispatching `REMOVE_DISPATCH_CHANNEL` — visually matching Files' existing delete-row idiom (`colors.dangerSoft`, small `×` glyph).
- `ChatView.tsx` needs one small, mechanical change: pass `state.recentCompletedDispatches`, `state.dispatchChannels`, and `dispatch` (or two bound callbacks) through to `ChannelRail` as its new props. Its own header/message-thread/input rendering needs no logic changes at all — already generic over any `ChatChannel`, dispatch-kind included, since `kind: 'dispatch'` channels have `archived: false` like active fictional ones (so the existing archived-disables-input logic already does the right thing with zero changes there).

### `src/components/settings/` (a new small toggle)

One new control in `BudgetAlertsCard.tsx`, alongside `autoThrottle`/`sound` (this project's other pure-boolean `Cfg` toggles) — confirmed to fit: the file is 89 lines today, not crowded (`AppearanceCard.tsx`, doing meaningfully more, is 142). `dispatch({ type: 'UPDATE_CFG', patch: { autoCreateDispatchChannels: !cfg.autoCreateDispatchChannels } })`, matching the exact wiring of every other Settings toggle.

### Persistence (`src/state/persistence.ts`)

Two new whitelist entries needed: `recentCompletedDispatches` and `dispatchChannels`. `cfg` (and therefore the new `autoCreateDispatchChannels` field) is already whitelisted as a whole object — no change needed there, matching this project's established "no persistence fix needed when a field is added to an already-whitelisted parent object" pattern (Settings, Uplinks). **A real, deliberate decision, not an oversight:** `recentCompletedDispatches` — an ephemeral-feeling "recently completed" pool — is persisted too, not just `dispatchChannels`, so a picker entry from just before a reload/restart is still pickable afterward; this was weighed and chosen over leaving the pool in-memory-only, since losing pickable entries on every reload would be a worse experience than a small amount of possibly-stale pool data.

## Data flow

Every ~1s tick (unchanged cadence from Phase 3 slice 1): `SET_REAL_AGENTS` fires → `detectCompletedDispatches` diffs old vs. new `state.realAgents` → for each completion, a Memory entry is created (slice 5, unchanged), the completion is pushed into the capped `recentCompletedDispatches` pool, and — only if the Settings toggle is on — a `DispatchChannelStub` is also created immediately. With the toggle off (the default), the user later opens Chat, clicks "+ NEW," picks an entry from the pool, and `CREATE_DISPATCH_CHANNEL` does the same stub-creation the auto-path would have done. From that point on, the channel behaves exactly like any other `ChatChannel` — `useChatChannels.ts` needs **no changes** (it already treats `channel.kind`/`channel.archived` generically; only `buildSystemPrompt`'s dispatch branch and `deriveChannels`'s merge are kind-aware).

## Error handling / edge cases

- **`CREATE_DISPATCH_CHANNEL` for a `toolUseId` no longer in the pool** (evicted by the cap, or never existed): no-op, matching this app's established convention.
- **`CREATE_DISPATCH_CHANNEL` for a `toolUseId` already in `state.dispatchChannels`**: no-op (don't create a duplicate) — the picker's own filtering already prevents this from the UI, but the reducer guards it independently rather than trusting the caller.
- **Auto-create racing a manual pick** (toggle flipped on mid-session, then a completion fires the same tick the user happens to click a stale picker entry): not a realistic race — `CREATE_DISPATCH_CHANNEL`'s dedup-by-`toolUseId` guard (above) makes a double-create harmless regardless of ordering.
- **`buildDispatchPrompt` finding no matching stub**: defensive fallback text, per the code shown above — should be unreachable in practice (a dispatch channel's `id`/`toolUseId` only ever comes from `state.dispatchChannels` itself via `deriveChannels`), but not assumed unreachable without a guard, matching `buildSystemPrompt`'s own existing defensive pattern for archived fictional channels.
- **Empty `prompt` on the source dispatch** (real, documented possibility from `liveAgentsMath.ts`): `buildDispatchPrompt` falls back to `description`, then to a literal "no task detail was recorded" — never an empty instruction.
- **The pool empties out entirely** (no completions yet, or all evicted): "+ NEW" still renders; its expanded list shows an explicit empty-state line rather than an empty, confusing blank space.

## Testing

**Unit (`reducer.test.ts`):**
- `SET_REAL_AGENTS` pushes a completed dispatch into `recentCompletedDispatches`, capped at 20 (most-recent-first), alongside its existing Memory-creation behavior (slice 5, unaffected).
- `SET_REAL_AGENTS` with `cfg.autoCreateDispatchChannels: true` also creates a matching `DispatchChannelStub` in `dispatchChannels` for each completion; with it `false` (the default), it does not.
- `CREATE_DISPATCH_CHANNEL` creates a stub from a pool entry, copying all fields correctly.
- `CREATE_DISPATCH_CHANNEL` for an unknown `toolUseId` is a no-op.
- `CREATE_DISPATCH_CHANNEL` for a `toolUseId` already present in `dispatchChannels` is a no-op (no duplicate).
- `REMOVE_DISPATCH_CHANNEL` removes the matching stub; removing an unknown `toolUseId` is a no-op.

**Unit (`chatChannels.test.ts`):**
- `deriveChannels` includes one `ChatChannel` per `state.dispatchChannels` entry, `kind: 'dispatch'`, `id` prefixed `dispatch:`, `archived: false`, `toolUseId` populated.
- Ordering/interleaving with `aether`/`agent`/archived channels behaves sensibly (exact order is an implementer/reviewer call against the existing function's established order, not pinned here).

**Unit (`systemPrompt.test.ts`):**
- `buildSystemPrompt` for a `dispatch`-kind channel returns a prompt containing the stub's `prompt` (or `description` fallback, or the literal no-detail string), the `FALLBACK_PERSONA` voice text, and does **not** contain the action-JSON verb list (assert the shared `RULES` constant's distinguishing substring is absent).
- The defensive no-stub-found fallback path is covered directly (construct a channel/state pair where the stub is deliberately missing).

**Manual GUI QA (plan-exit, per this project's convention):** since triggering a real dispatch completion on demand isn't reliably reproducible (same accepted gap as slice 5), this pass is scoped to: creating a fake pool entry via a temporary state override (or waiting for an organic completion, if one happens to occur during the QA window) to confirm "+ NEW" → pick → channel appears → send a message → real reply references the dispatch's task correctly → remove → channel disappears; toggling the Settings control and confirming a subsequent completion auto-creates a channel with the toggle on; confirming zero regression in every existing fictional channel (send in AETHER, an active agent channel, and an archived one).
