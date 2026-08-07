# Stage 12 — Voice Packs & Render: design

**Status:** approved for planning
**Date:** 2026-08-03

## What this is

Scoping document for roadmap Stage 12 (`docs/roadmap.md` row 12), which
implements Phase 1 of `AGENT_PERSONALITY_LAYER_1.md` (see that spec's §5
Voice packs, §6 Frozen phrases, §8 STEWARD as attention broker, §11 Phase 1
checklist). The spec already fully designs voice-pack content, escalation
curves, and enforcement mechanics — this document scopes what Stage 12
specifically builds against the real codebase, and records the four
decisions closed during this scoping pass (now folded into the spec's §12 as
the authoritative record; this file is the narrower, dated account of why).

## In scope (spec §11 Phase 1 checklist)

- Voice packs as data files, one per agent role (§5)
- `max_chars` fleet defaults + re-prompt/sentence-boundary enforcement (§5.3)
- Render layer: pack + severity → agent roster row
- Runtime prepend for the four frozen phrases (§6)
- Verbosity dial: full / terse / silent, global and per-agent, with the
  severity-≥3 floor that always renders regardless of dial
- Interruption budget *mechanism* (window, single-spend, direct-answer
  exemption), ranking on severity — not the traffic-tuned `N` (Phase 3)
- Render-layer attention hook, instrumented but unconsumed

**Out of scope:** Phase 2 (update contract, §7), Phase 3 (traffic-tuned
calibration — baselines, anomaly thresholds, interruption interval `N`,
second frozen-phrase round), Phase 4 (disagreement triage/adjudication,
memory — already tracked separately as Layer 2, Stage 13, shipped).

## Gaps found in the existing codebase (not previously scoped)

1. **`electron/collectorStore.ts`'s dispatch reader is stale, but it is not
   on Stage 12's critical path.** ✅ **CLOSED by Stage 15** — see
   `docs/superpowers/plans/2026-08-05-cost-forensics-stage15.md` Task 2. The
   reader now selects all seven v5 columns (this list named six; it omitted
   `session_id`), degrades to null telemetry on a pre-v5 database rather than
   throwing, and narrows `exit_state`/`severity` at the boundary instead of
   casting. The Ledger's dispatch table is the consumer that finally needed
   them. The original text follows unchanged, for the record:

   It selects
   `tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms`
   only — the Stage 11 schema-v5 columns (`agent_id`, `task_kind`,
   `severity`, `median_ms_at_eval`, `exit_state`, `retries`) exist in SQLite
   but are never read into the viewer. This remains a real, named gap
   (nothing surfaces the collector's persisted telemetry), but the roster's
   live narration doesn't need it: `main.ts#tickAndPushAgents` already
   receives `result.completed` (`CompletedDispatchUsage[]`, with
   `durationMs`/`toolUses`) fresh from `liveAgentTracker.tick()` every tick,
   in the same process, and can call `computeSeverity()` directly on that —
   exactly how the collector's own `ingestDispatchEvent` does it
   (`exit: 'ok'`, `retries: 0`, hardcoded the same way Stage 11 hardcodes
   them today). Left as unscheduled follow-up, not folded into this stage's
   tasks — named rather than glossed, per this project's own documentation
   standard.
2. **No role-mapping layer exists.** `agent_id`/`task_kind` are populated
   directly from the real `subagent_type` string at dispatch time
   (`collector/src/usageIngest.ts`, `open.subagentType`) — e.g.
   `code-reviewer`, `general-purpose`, `explore`. Voice packs key on one of
   5 fixed roles (§5.1), and nothing before Stage 12 translates between the
   two.
3. **Roadmap references a spec section that didn't exist.** `docs/roadmap.md`
   claimed the `personas.ts` coexistence decision was "recorded as §5.10" —
   the spec stopped at §5.9. Fixed as part of this scoping pass; see the
   spec's new §5.10.

## Decisions closed this pass

| Decision | Resolution | Why |
|---|---|---|
| Which model runs Pass 2 narration? | No model call — deterministic template renderer (§5's `samples` per role/severity, real facts substituted in), same shape as `formatHeadline()` | Reversed after finding roadmap Stage 11.5's addendum: "Aether is meant to not cost a user money, full stop." Narration is unprompted/continuous, same shape as the retired Auto Headlines call — fails that bar identically |
| Where does narration render? | `AgentRosterCard` rows (Stage 7), grouped by NEEDS INPUT/WORKING/DONE | Matches the "cadence you register before reading" framing; keeps `personas.ts`'s chat-reply voice untouched (spec §5.10) |
| Keep alchemical names or rename? | Keep: STEWARD/CINDER/PILGRIM/ASSAY/FORGE | Coherence over bikeshedding |
| FORGE's sev-1 heartbeat: weighted or binary? | Binary (pulse/no-pulse) for Phase 1 | Duration-aware weighting needs real traffic to tune against — Phase 3 item |
| How do real `subagent_type` values map to the 5 roles? | Static lookup table, unmapped → FORGE | Mirrors `personas.ts`'s own `FALLBACK_PERSONA` fallback pattern; cheap, extensible, auditable |

## Testing

Standard project convention: pure logic (role-mapping table, `max_chars`
enforcement, interruption-budget mechanism, frozen-phrase prepend) goes in
`src/shared/` or `collector/src/` with matching `test/*.test.ts` /
`*.test.ts` files; render-layer wiring gets component tests on
`AgentRosterCard`. Run `npm test` (root) before declaring any task done.

## Governing constraint (added after initial scoping)

`docs/roadmap.md`'s Stage 11.5 addendum (2026-08-02): *"Aether is meant to
not cost a user money, full stop... the only feature for which 'the user
asked for this specific reply' is unambiguously true[ is] the bar every
model call in this project should have to clear."* Narration is unprompted
and continuous, so it fails that bar the same way the retired Auto Headlines
call did. Applies project-wide, not just to this stage — any future call
site needs to clear the same bar.

## Next step

Hand off to `writing-plans` for the numbered task breakdown, saved to
`docs/superpowers/plans/2026-07-31-voice-packs-stage12.md` (matching the
filename `docs/roadmap.md` row 12 already references, so that link resolves
without another dead-link fix).
