# Stage 14 — Comms Deck: design

**Status:** approved for planning
**Date:** 2026-08-05
**Depends on:** Stage 13.5 (API teardown) — must merge first; this stage builds on the
`src/components/comms/` rename.

## What this is

Stage 13.5 leaves the `Comms` tab structurally sound and substantively thin: a channel rail,
a message thread, and a keyword responder. This stage fills it with the two things that were
sitting unused in the repo the whole time.

**The observation this stage rests on:** Chat's expensive part was never the layout. It was
the responder. The three-pane rail/thread/input shell is generically useful, and there are
already two zero-cost sources that fit it exactly —

1. **Real transcript messages.** Claude Code writes full JSONL transcripts. `transcriptParser.ts`
   already turns them into typed `TranscriptEvent` objects, and `liveAgentTracker.ts` already
   tails them every tick. Every message from every session and every subagent dispatch is on
   disk, already generated, already paid for by the operator's subscription. Rendering them is
   free.
2. **The Stage 12 voice packs.** STEWARD, CINDER, PILGRIM, ASSAY, FORGE — archetypes,
   escalation curves, frozen phrases, severity-indexed samples, and a deterministic
   `renderNarration()`. Shipped 2026-08-03, currently rendering exactly one line per completed
   dispatch in the agent roster's DONE group. That is a fraction of what it can carry.

Together these convert the deck from *"type at a model that costs money"* to *"watch the
fleet, and hear it."* That is a better fit for a mission-control cockpit than a chat window
ever was, and it costs nothing.

## In scope

### A. Transcript Deck (the thread)

- Channels resolve to a **transcript source**: the pinned session, or a specific subagent
  dispatch by `toolUseId`.
- The thread renders real messages from that source — human prompts, assistant text, tool
  calls as compact rows (`Bash · npm test`, `Read · reducer.ts`), tool results as
  size-only chips.
- The input box becomes a **filter**, not a send box: freetext substring plus a small set of
  `/`-prefixed filters (`/tool <name>`, `/human`, `/error`).
- Header chip becomes `LIVE` / `REPLAY` / `ENDED`, driven by whether the underlying file is
  still being appended to.

### B. Comms Channel (the voices)

- Real events select an `EventKind` + `Severity`; `renderNarration()` produces the line; it
  is appended to the relevant channel as a message.
- Channel-to-voice binding: the AETHER channel is STEWARD (spec §8's attention-broker role);
  agent and dispatch channels resolve via `resolveVoiceRole(subagentType)`.
- `narrationVerbosity` governs the feed exactly as it governs the roster, including the
  severity-≥3 floor.
- `interruptionBudget.ts` — instrumented but unconsumed since Stage 12 — gets its first real
  consumer here: it ranks which narration lines are allowed to raise an unread badge, as
  opposed to merely appearing in-thread.

### C. Frozen phrases — closing a named Stage 12 gap

Stage 12 shipped with all four frozen phrases unreachable, and said so plainly: *"`formatNarration`
always passes `eventKind: null`, since detecting `all_clear`/`empty_result`/`no_signal`/
`critic_tell` needs per-role business logic this stage's data doesn't carry."*

The Comms deck carries it. Each detection is a small, testable predicate over data the app
already holds:

| Frozen phrase | Role | Detection |
|---|---|---|
| `Nothing requires you.` | STEWARD | Zero open dispatches, zero anomalies, zero pending permission requests |
| `The path exists. It's empty.` | PILGRIM | A completed dispatch whose tool calls were all reads/searches and whose result lengths were all trivially small |
| `Treat everything unverified.` | ASSAY | A completed dispatch with `exit_state` fatal, or zero tool calls where tool calls were expected |
| `Oh. That's actually interesting.` | CINDER | A completed review dispatch at severity ≥ 3 |

These are heuristics and the spec says so. Each one gets a unit test with its own honest
comment about what it can miss. A frozen phrase firing slightly too rarely is the acceptable
failure direction; firing wrongly is not, so every predicate is written conservative-by-default.

## Out of scope

- **Sending anything.** The input box filters; it does not transmit. There is no send path in
  this stage, to any backend, local or remote.
- **Editing or replying into a transcript.** Read-only, permanently.
- **The Ollama backend.** Deferred at Stage 13.5 and still deferred. If the deterministic deck
  proves sufficient — which is this stage's implicit hypothesis — it never gets built.
- **Cross-session search.** One source at a time. A global search across every transcript on
  the machine is a different feature with a different performance profile.
- **Retiring `localResponder.ts`.** It stays as the AETHER channel's answer to a typed query
  that isn't a filter expression. It is free, tested, and already state-aware.

## The privacy decision (binding, and the hard part of this stage)

`docs/privacy-and-data.md` is explicit: **"Store the signal, not the payload. Derive what the
detectors need at ingest and discard the raw: no source code, no command strings, no tool
outputs, no prompts in the store."**

A transcript reader renders exactly the payload that rule exists to keep out of the store. The
resolution is a distinction the rule already implies but never had to state, because until now
nothing rendered payload:

> **Rendering is not storing.** Transcript content may be read from disk and held in the
> rendering component's own React state for as long as the view is mounted. It must never
> enter the `useReducer` store, never enter `persistence.ts`'s whitelist, never be written to
> `~/.aether-os/`, and never reach the collector's SQLite schema.

Concretely, this means:

- A new IPC channel returns transcript messages **on request** — on view mount, on an explicit
  refresh, and, for a live source only, re-fetched on the app's existing 900ms tick
  (`useTranscriptSource.ts`'s tick-triggered re-fetch, gated on `isLive`). It is a pull, never a
  `state` push: the tick triggers a request/response read, not a broadcast, and it does not use
  the `useRealAgentsSync.ts` pattern, which exists to feed the store; this is the first IPC
  consumer in the app that deliberately does not. The distinction that matters for the privacy
  rule is not "on the tick or not" but **push vs. pull** — the payload is fetched by request and
  held only in the view's own state, never broadcast into anything that could route it into the
  store.
- `persistence.test.ts`'s round-trip coverage test is the mechanical enforcement: if a future
  change routes transcript content through the store, the test's documented-exclusions list
  forces someone to write down why.
- A new test asserts no transcript-message type is reachable from `AetherState`.
- `docs/privacy-and-data.md` gains the render-vs-store distinction as a first-class paragraph.
  This is a real amendment to a document marked binding, and it should be reviewed as one — not
  slipped in as a Stage 14 implementation detail.

The operator is the only reader of their own transcripts on their own machine, and nothing
leaves it. The rule was written to prevent a *store* that could leak, not to prevent the
operator from looking at their own session. But the amendment must be explicit, because the
next feature will cite whichever version it finds.

## Decisions closed this pass

| Decision | Resolution | Why |
|---|---|---|
| Where does transcript reading happen? | Electron main, over a new request/response IPC channel | The renderer has no filesystem access, and main already owns transcript tailing. Adding a second reader in the renderer would duplicate `transcriptParser.ts`'s contract — `CLAUDE.md` names that file as the one place raw lines become typed events. |
| Push or pull? | Pull — on view mount, on an explicit refresh, and (for a live source) re-fetched on the app's existing 900ms tick | A `state` push would tempt a future change into caching payload in the store. Pull keeps the payload's lifetime tied to the view's, even when the tick is what triggers the re-fetch. |
| How much of a transcript loads at once? | Last N messages, N tunable, with a "load older" action | Transcripts run to tens of megabytes. Naive full-file reads will stall the main process on a long session. |
| Does the thread live-follow an active session? | Yes, but by re-requesting the tail on the existing tick, not by streaming | Reuses the cadence the app already has. Streaming is a second transport for no added value at this scale. |
| Does narration go into the same thread as transcript messages? | Yes — interleaved chronologically, visually distinct | Two panes would waste the shell's whole advantage. The voices commenting on the work, in line with the work, is the feature. |
| What happens to `localResponder`? | Kept, as the AETHER channel's fallback for non-filter input | Free, tested, and it answers the questions the old chat was actually asked. |

## Known limitations, named plainly

1. **Tool results are size-only.** `TranscriptToolResult` carries `resultLength`, not content —
   `parseTranscriptLine` never captured it. Rendering result *content* would require changing
   that parser's contract, which `CLAUDE.md` names as the single place raw lines become typed
   events and which `liveAgentTracker` and `liveAgentsMath` both consume. Out of scope; the
   thread shows a size chip, not output.
2. **Subagent transcripts may not be separately addressable.** Whether a dispatch's own
   messages live in the parent transcript or a separate file is a question about Claude Code's
   on-disk layout that must be **verified against real transcripts on this machine before
   Task 1 is written**, not assumed. If dispatch messages are not separable, dispatch channels
   render the parent transcript filtered to that dispatch's window — a degraded but honest
   fallback, and the plan must say which one shipped.
3. **The frozen-phrase predicates are heuristics.** See the table above. They will
   under-fire more often than they misfire, by design.
4. **`ROLE_MAP` coverage is still spot-verified, not exhaustive** — inherited from Stage 12
   and not fixed here. An unmapped `subagent_type` gets FORGE, which is silent at nominal
   severity, so the failure mode is a quiet channel rather than a wrong voice.

## Testing

Per project convention. Pure logic — filter parsing, the four frozen-phrase predicates,
event→(EventKind, severity) mapping, transcript-message shaping, the interruption-budget
ranking — goes in `src/shared/` or `src/components/comms/` with matching `*.test.ts`.
Component tests cover the thread's rendering of each message kind and the rail's channel
derivation. The IPC read path gets a test against a fixture JSONL file, not a live session.
Visual verification of the deck in a live window is manual, per this project's established and
repeated pattern for anything requiring real session data.

## Next step

Hand off to `writing-plans`, saved to
`docs/superpowers/plans/2026-08-05-comms-deck-stage14.md`.
