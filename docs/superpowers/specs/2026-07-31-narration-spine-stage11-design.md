# Narration Spine (Stage 11) — Design

## Context

Roadmap Stage 11 (`docs/roadmap.md` row 11): "Layer 1 Phase 0" — the six checkboxes in
`docs/superpowers/specs/AGENT_PERSONALITY_LAYER_1.md` §11's Phase 0 list. **Ships zero visible
change** — no voice, no UI, nothing in the chat deck. This spec exists because Phase 0, written
before any collector-code archaeology happened, describes an idealized `AgentEnvelope` for a
hypothetical fleet of agents Aether OS orchestrates directly. Aether OS does not do that today —
it passively *observes* real Claude Code `Task`-tool subagent dispatches by tailing transcript
files (`docs/roadmap.md` §1, `collector/src/transcriptParser.ts`). Every field in `AgentEnvelope`
needs a real-data mapping before Stage 11 can be a task list instead of a restatement of the spec.
This document is that mapping, confirmed against the actual current source, not assumed.

## What exists today (verified against source)

The `dispatches` table (`schema.ts:79-86`) is the closest thing to a "run" record:
`tool_use_id` (PK), `tokens`, `tool_uses`, `duration_ms`, `started_at_ms`, `ended_at_ms`. It gets
exactly one row, written once, by `usageIngest.ts:32-61`'s `ingestDispatchEvent`, and only when a
`task-notification` completion event arrives (`<tool-use-id>`/`<subagent_tokens>`/`<tool_uses>`/
`<duration_ms>` tags Claude Code itself writes into the notification text).

Two concrete gaps, not design choices — data that's either discarded or never existed:

1. **`subagent_type` is parsed and thrown away.** `transcriptParser.ts:69-71` extracts every
   `tool_use`'s full `input` (confirmed shape via `transcriptScan.test.ts:178` and
   `usageIngest.test.ts:35-38`'s fixtures: `{ subagent_type: 'general-purpose' }`, present the
   moment the `Agent` tool_use opens). `toolCallHistory.ts:83`'s `updateHistory` only retains
   `{ toolName, filePath, startedAt }` in `openByToolUseId` — `subagent_type` never survives past
   that line. It is the only stable, recurring category a real dispatch has (no persistent
   per-instance agent identity exists — each dispatch is a fresh `tool_use_id`), so it is the
   forced answer for `task_kind`.
2. **A dispatch that opens and never completes is invisible, not unflagged.** Since the only
   INSERT into `dispatches` happens on a completion event, a dispatch that never sends one
   (subagent crashed, its owning Claude Code session itself ended, or it's simply still running)
   produces no row at all. This is exactly `AGENT_PERSONALITY_LAYER_1.md`'s own claim about
   `exit: 'fatal'` — "a test runner that never started ... is easily mistaken for success" — except
   today the mistake is structural: there is no row to mistake, the case is unrepresented.

No other exit state has real signal. Claude Code's completion notification carries only
token/tool-use/duration numbers, never a success/failure flag for the subagent's own task. So
`partial` / `error` / `timeout` / `blocked` are declared in the type for spec fidelity but stay
unreachable from real dispatches until a richer signal exists — same honest-gap pattern as Stage
7's "no per-dispatch correlating ID" and Stage 4's "no session control." Not invented here.

`retries` has no real signal at the dispatch level either — Claude Code doesn't expose "attempt N
of M" in the transcript, and there is no reliable way to distinguish a deliberate re-dispatch from
an unrelated new one from the data this app has. Declared in the schema, always `0` for real
dispatches, named as a limitation rather than guessed at.

## Real-data field mapping

| `AgentEnvelope` field | Real-data source | Notes |
|---|---|---|
| `agent_id` | = `task_kind` (below) | No finer per-instance identity exists for a real dispatch; two fields would coincide, so `agent_id` is populated but not a distinct dimension yet. |
| `task_kind` | `toolUse.input.subagent_type` at dispatch-open | The only stable, recurring category. Baselines (Phase 3, parked) will key on this. |
| `result` | Not modeled — real dispatch output is the transcript itself, out of scope for telemetry rows | |
| `findings` | Deliberately NOT populated by Stage 11 | Decided with the user: the existing anomaly detectors (`anomalyIngest.ts` — `reReadLoop`/`writeDeleteRewrite`/`zeroEditBurn`) stay independent for now. Folding them into `Finding` objects is a deliberate follow-up once Stage 12 gives findings a render surface — matches the roadmap's own "spine only" framing for this stage. |
| `revision` | Not applicable — no revision concept exists for a passively-observed dispatch | Stage 13 consumes this type for Layer 2 private memory; declared here, unused here. |
| `decision` | Not applicable, same reasoning as `revision` | |
| `narration` | Not written by Stage 11 at all | Per the roadmap's own placement argument (§3.3): narration is generated lazily in the viewer, on read, in Stage 12 — never at collector ingest time. |
| `telemetry.started_at` | `open.startedAt` (dispatch-open time, already tracked) | |
| `telemetry.elapsed_ms` | `duration_ms` on completion; `nowMs - started_at_ms` at the moment a fatal sweep fires | |
| `telemetry.retries` | Always `0` | No real signal; named limitation, not a guess. |
| `telemetry.tokens` | `tokens` (already tracked) | |
| `telemetry.exit` | `'ok'` on a real completion event; `'fatal'` via the staleness heuristic below | `'partial'`/`'error'`/`'timeout'`/`'blocked'` stay type-valid but unreachable from real data this stage. |
| `telemetry.median_ms_at_eval` | Always `null` in Stage 11 | No baseline history exists yet — Stage 11 is what starts persisting the history Phase 3 needs (`(agent_id, task_kind)`-keyed). Matches the spec's own note that the `3×` multiplier is "inert until baselines exist." |
| `telemetry.severity` | `computeSeverity()`, ported verbatim from `AGENT_PERSONALITY_LAYER_1.md` §4's derivation rules | With `retries` fixed at 0 and `median_ms_at_eval` fixed at `null`, only the `exit` branches are live in Stage 11: `exit:'ok'` → `sev=1`; `exit:'fatal'` → `sev=4`. The `retries>=2` and `median` branches are dead code paths in Stage 11, not removed — they activate automatically once Stage 11's own `retries`/median wiring is later filled in, with zero changes to `computeSeverity` itself. |

## Fatal detection — the staleness heuristic

Decided with the user (Recommended option, not the completion-only alternative): a dispatch is
marked `exit: 'fatal'` once **either** condition holds, whichever is checked first:

1. **Its owning session is gone.** Every transcript event carries `sessionId`
   (`transcriptParser.ts:19-39`'s `TranscriptEvent.sessionId`) — captured alongside `toolName`/
   `filePath`/`startedAt` in `openByToolUseId` (currently dropped, same gap class as
   `subagent_type`). `fleet_sessions.last_seen_ms` (`schema.ts:61-70`, upserted every fleet-poll
   tick per `fleetPoll.ts`) tells us the session is no longer being reported by `claude agents
   --json` once `last_seen_ms` is older than roughly 2× the fleet-poll interval (30s at the
   current 15000ms default — a session that's still live gets re-stamped every cycle, so one
   missed cycle is noise, two is signal).
2. **A fixed timeout elapses regardless of session state** — a dispatch still open 30 minutes
   after `started_at_ms` with no completion event, even if its session is still alive (covers a
   subagent that's hung without its parent session ending). **Guessed value, not traffic-derived**
   — same spirit as `AGENT_PERSONALITY_LAYER_1.md` §5.3's `max_chars` defaults ("ship guessed
   values … tune them by irritation"). 30 minutes chosen because it's comfortably longer than any
   dispatch duration this project has actually observed (per `PROGRESS.md`'s existing
   diagnostic-core entries) without being so long that a genuinely-hung dispatch sits unflagged
   for hours.

Detection runs as part of the existing transcript-scan tick (`transcriptScan.ts`, already
15000ms), not a new timer — it's a cheap sweep over `openByToolUseId`, no new I/O beyond the
`fleet_sessions` read the fleet-poll path already performs.

## Explicitly out of scope for Stage 11

- **`collector-go/` parity.** Stage 10 shipped `collector-go` as a byte-for-byte parity port of
  the Node collector, but Stage 11's schema/logic additions are new surface, not a port of
  something already proven. Porting Stage 11 into Go at the same time it's still being designed
  against real traffic would mean re-deriving these same real-data mapping decisions twice before
  either is settled. Deferred as a named follow-up once Stage 11 has run against real usage in the
  Node collector, matching Stage 10's own precedent of treating "cutover/retirement" as a
  separate, later decision.
- **Phase 3 calibration** (rolling baselines, the `3×` anomaly multiplier, interruption-budget
  interval `N`) — already parked in the spec itself, reaffirmed here: Stage 11 persists the
  `(agent_id, task_kind)`-keyed history Phase 3 will need; it does not compute anything from it.
- **Any reader-side (`electron/`) or UI change.** Confirmed zero: the `dispatches` table gains
  columns; `electron/collectorStore.ts` and every view that reads it are untouched by this stage.
- **Folding `anomalyIngest.ts`'s detectors into `Finding` objects** — decided with the user, see
  the `findings` row above.
