# Aether OS — Diagnostic Thesis: Phased Plan

**Date:** 2026-07-27
**Thesis:** Aether OS detects when agents are thrashing, prices what it cost, and lets you intervene — with an ambient reactor so you notice before you look.
**Companion doc:** `docs/competitive-gap-analysis-2026-07.md`
**Conventions:** follows existing project discipline — additive slices, disjoint state fields, pure-function seam with unit tests, optional trailing parameters for backward-compatible extension, explicit non-goals per slice.

---

## 0. Corrections to the gap-analysis doc

Verified against primary docs 2026-07-27. Two corrections and several upgrades.

| Claim in gap doc | Verified status |
|---|---|
| `SubagentStop` carries `tokens_used.{input,output,cache_creation,cache_read}` | ❌ **WRONG.** Payload is `session_id`, `prompt_id`, `transcript_path`, `cwd`, `hook_event_name`, `agent_type`, `agent_id`, `last_assistant_message`, `exit_code`. No token fields. **Tier 1 item #2 must be rewritten** — see §4 for where per-dispatch tokens actually come from. |
| `PostToolUse` fires inside subagents with file paths | ✅ **Confirmed, stronger.** Payload includes `agent_id` (present only inside a subagent), `agent_type`, `tool_name`, full `tool_input` (incl. `file_path`), `tool_use_id`, `tool_output`, plus `permission_mode` and `effort.level`. |
| `PermissionRequest` enables a real approval queue | ✅ **Confirmed, stronger.** `hookSpecificOutput.decision.behavior` = `"allow"`\|`"deny"`, plus optional `updatedInput` to rewrite the tool input when allowing. Exit code 2 also denies. |
| `claude agents --json` is a fleet API | ✅ **Confirmed.** `--json` prints active sessions as a JSON array and exits; `--all` includes completed; `--cwd <path>` scopes it. |
| — | 🆕 **`PostToolUse` can block with a reason**: `{"decision":"block","reason":"..."}`. The reason goes back into the agent's context. Real mid-flight intervention. |
| — | 🆕 **`Notification` hook has typed `notification_type`**, including `agent_needs_input`, `agent_completed`, `permission_prompt`, `idle_prompt`, `elicitation_*`, `auth_success`. |
| — | 🆕 **Session lifecycle CLI exists**: `claude --bg "task"` (returns session ID), `claude stop\|kill <id>`, `claude rm <id>`, `claude logs <id>`, `claude respawn <id> [--all]`, `claude attach <id>`, `claude daemon status`. |
| — | ⚠️ **Confirmed limit:** no programmatic way to send input to a running background session. `attach` requires a terminal. Steering remains out of reach; stopping and denying do not. |
| — | 🆕 **`SubagentStop` can block the stop**: exit 2 or `{"continue": false}` keeps the subagent working. Powerful and dangerous; not used in this plan. |

---

## 1. Where this plan meets the in-flight TokenMonitor port

The token-optimization work already underway is the **third act** of this thesis, not a parallel track:

```
  DETECT                    PRICE                      REMEDIATE
  anomalyDetectors.ts   →   cost-of-thrash        →    TokenMonitor optimization port
  (shipped)                 (Phase B4, this plan)      (in flight)
```

Phase B4 is deliberately specified as producing a **typed cost-attribution record per anomaly window**, so the optimization layer can consume it without knowing anything about how anomalies are detected. If the port already defines its own recommendation type, B4 should emit into that shape rather than inventing one.

**Open question for the port:** what does TokenMonitor's optimization feature key off — raw token totals, cache-hit ratio, context growth, tool-call patterns, or something else? That determines whether B4 hands it anomaly windows, token deltas, or both. Worth settling before B4 is planned in detail.

---

## 2. Phase A — the hook bridge (foundation, no UI)

Everything downstream depends on this. Deliberately ships with **zero visible UI** so it can be reviewed on correctness alone, matching the Phase 0 / slice-1 precedent.

### A1 — Hook receiver

A loopback HTTP (or named-pipe) listener in the Electron main process. A tiny hook script registered in Claude Code settings POSTs each payload to it.

- **New state:** `state.hookEvents` — a rolling typed pool, disjoint from `realAgents` / `realUsage` / `dispatchUsage`.
- **Pure functions:** `parseHookEvent(raw) → HookEvent | null`, `classifyHookEvent`. Full unit coverage over recorded fixtures for each event type.
- **Security:** loopback bind only, per-launch token in the URL path, reject non-localhost. (Blubber OS uses the same loopback + per-process-token shape; it's the right pattern.)
- **Hooks registered in this slice:** `PostToolUse`, `SubagentStart`, `SubagentStop`, `Notification`, `SessionStart`, `SessionEnd`.
- **Non-goals:** no UI, no consumer, no replacement of the existing 1s tracker. The tracker keeps running unchanged; this is purely additive until A4.
- **Portfolio ↔ daily-tool conflict:** this requires writing to the user's `settings.json`. For a reviewer, "configure your machine before the app works" is friction. **Mitigation that serves both:** a one-click **Install hooks** action in Settings that writes the config and shows a verified/unverified badge, plus graceful degradation to the current tracker when hooks aren't installed. Good product *and* good demo.

### A2 — `claude agents --json` → real fleet

- Poll `claude agents --json` (and `--all` on demand) on a slow interval; parse to `state.fleet`.
- Replaces the "globally most-recently-active session" auto-pick with a **real session list and a picker**.
- **Retires:** the session-switch false-completion bug, and the byte-0 replay/backfill orphan problem, since dispatch identity now comes from `agent_id` rather than inference.
- **Durability win:** moves off the undocumented JSONL format onto a documented CLI contract.
- **Non-goals:** no session control yet (that's Phase D). Read-only.

### A3 — Statusline feed

- Register a `statusLine` script that writes its stdin JSON to a file the Electron side tails.
- **Wire:** `rate_limits.five_hour.used_percentage` + `resets_at` and `rate_limits.seven_day.*` → real DEPLETION ETA. `context_window.used_percentage` → **retires the last fictional KPI tile.**
- **Semantics to respect (documented, version-sensitive):** `used_percentage` is input-only (input + cache_creation + cache_read, excludes output); `current_usage` is `null` before the first API call and again immediately after `/compact`; as of v2.1.132 `total_input_tokens` means current occupancy, not a cumulative session total.
- **New state:** `state.statusline`, disjoint from `state.realUsage`.

### A4 — Retire the polling tracker

Only after A1–A3 are proven. Cut the 1s tick, per-tick session re-discovery, byte-0 replay, and the `agentTickInFlight` guard. Push replaces poll.

- **This is a deletion slice.** Net negative lines. Worth calling out explicitly in PROGRESS.md — the sim→live migration's final act is removing the scaffolding that compensated for not having a real feed.

---

## 3. Phase B — the diagnostic core (the thesis)

### B1 — Anomaly history store

`state.anomalies` is currently *current-state only*. Make it a log.

- **New state:** `state.anomalyLog` — `{ agentId, kind, firedAt, clearedAt | null, evidence }`.
- **Pure:** `deriveAnomalyTransitions(prev, next) → AnomalyTransition[]`. Trivially testable, no I/O.
- **Upgrade `detectStalledPermission` from heuristic to exact.** It currently guesses at >60s open tool-call age and false-positives on genuinely long tools. With `PermissionRequest` firing and `PostToolUse` closing, the stall is *observed*, not inferred. This retires a documented accuracy limitation.
- **Non-goals:** no UI in this slice.

### B2 — Real file-touch tracking per dispatch

From `PostToolUse` payloads where `agent_id` is present: `tool_name` + `tool_input.file_path` + timestamp.

- **Retires the "structurally impossible" note in PROGRESS.md.** Worth documenting as a reversal with the evidence, in the same style as the `usageTokens()` correction — reversals documented honestly are the project's best asset.
- **Un-strands `Agent.files` / `AgentFile`**, currently the last fictional type with no real counterpart.
- **Bonus for free:** a per-dispatch **file attention heatmap** (which files got touched how many times) falls straight out of this data. agent-flow is the only tool with one, and re-read loops *are* attention heatmap spikes — B2 and B1 corroborate each other.

### B3 — The dispatch timeline card ⭐

**This is the portfolio screenshot.** One dispatch, one horizontal timeline:

- Tool-call spans with real durations (from `PostToolUse` pairs)
- The anomaly strip underneath — fired/cleared bands from B1
- File touches as marks, colored by repeat count
- `last_assistant_message` and `exit_code` at the terminus

Lane-pack overlapping spans to recover parallelism. If OTel traces are wired later, layer `tool.blocked_on_user` as a distinct band to separate **human wait** from **machine thrash** on the same axis — a distinction nobody else visualizes.

- **Competitive position:** the entire "subagent tree / agent Gantt" category is claude-workflow-viz (4 stars, no releases) and agent-flow (~990 stars, opt-out telemetry on by default). This is the thinnest lane in the landscape.
- **Portfolio ↔ daily-tool:** heavily portfolio-weighted. Moderate daily utility, enormous legibility to a reviewer. Build it well; it's the artifact.

### B4 — Cost of thrash

Cross B1's anomaly windows with token spend to produce: *"re-read loops cost 340k tokens this week."*

**The token-source problem (this is the real architectural decision):**

| Source | Grain | Four-way split? | Cost |
|---|---|---|---|
| Existing `<usage>` XML at completion | per-dispatch | ✗ (no cache breakdown — documented limitation) | already built |
| Statusline `cost.*` / `context_window.current_usage` | session | ✓ | free once A3 lands |
| **OTel `claude_code.token.usage`** | **per-`query_source`/`agent.name`** | **✓** | needs an OTLP receiver in-app |

Per-dispatch four-way tokens require OTel. That's the only clean path — `query_source=subagent` is also the documented fix for the subagent double-counting every JSONL parser gets wrong.

- **Conflict, flagged as requested:** an embedded OTLP receiver is heavyweight for a personal cockpit. But it's the *only* way to produce the number that makes this thesis land, and "I embedded an OTLP receiver to attribute token spend per subagent" is a strong line in a portfolio. **Recommendation: do it, but as its own gated slice**, with the app fully functional without it.
- **OTel gotchas to design around:** env vars must be set before `claude` starts and are *not* inherited by Bash subprocesses, hooks, MCP servers or LSPs; default temporality is `delta`; spaces in `OTEL_RESOURCE_ATTRIBUTES` silently drop the whole string; without `OTEL_LOG_TOOL_DETAILS`, user-defined agents report as `custom` and third-party skills as `third-party` — i.e. attribution goes blank exactly where you care most.
- **Output contract:** emit a typed record per anomaly window that the TokenMonitor optimization layer consumes. See §1.

---

## 4. Phase C — closing the loop

### C1 — Real approval queue

`PermissionRequest` replaces the fictional `APPROVAL_POOL` and AUTO-mode simulation. The existing risk policy (kill=HIGH, spawn=MED, throttle=LOW) becomes a real classifier over `tool_name` + `tool_input`.

- **This is the largest fiction→real conversion left in the app**, and the moment Aether OS stops being a passive observer.
- The TopBar bell gets a real trigger from `Notification` with `notification_type: "permission_prompt"` / `"agent_needs_input"`.
- **Timeout policy matters.** A hook that never answers blocks the agent. Steal Jules' pattern: the gate **times out into a machine reviewer** rather than hanging or blanket-approving. Default to deny-on-timeout with a loud UI state.

### C2 — Editable permission scope

Use `decision.updatedInput` to let the approval card **rewrite** the request before allowing — widen a path, narrow a command, strip a flag. Antigravity's `action(target)` editable-target affordance, which the first-party survey rated the single best approval design shipped anywhere.

### C3 — Anomaly → intervention

`PostToolUse` with `{"decision":"block","reason":"..."}` when an anomaly fires. The reason enters the agent's context, so a re-read loop gets broken *and explained*: "you have read this file 6 times without editing it; state what you're looking for before reading again."

- **Detection → recommendation → action, closed.** This is what separates a dashboard from a tool, and it's the payoff for everything in Phase B.
- **Guard hard.** A buggy blocker breaks real work. Ship behind an explicit opt-in toggle, default off, with a dry-run mode that logs what it *would* have blocked. Dry-run mode is also the honest way to tune the detectors — and it's a better demo than the live version.

---

## 5. Phase D — session control (opportunistic)

`claude --bg "task"` returns a session ID; `claude stop|rm|respawn|logs <id>` manage it. The SPAWN + button deleted in Phase 3 slice 1 for having "nowhere honest to point" now has somewhere to point.

- **Portfolio ↔ daily-tool:** inverted from B3. High daily utility, low differentiation — every surviving competitor does this. Build it because you'll use it, not because it impresses.
- Pairs naturally with A2's fleet list.

---

## 6. Sequencing

```
A1 hook receiver ──┬── A2 fleet (--json) ──── A4 retire poller
                   ├── A3 statusline ──────── [retires fictional CONTEXT tile]
                   │
                   ├── B1 anomaly log ──┬── B3 timeline card ⭐
                   ├── B2 file touches ─┘
                   │                    └── B4 cost of thrash ──→ TokenMonitor port
                   │
                   └── C1 approvals ── C2 scope editing
                                    └── C3 intervention (needs B1)

                      D session control — anytime after A2
```

**If you only ship three things:** A1, B1+B3, B4. That's the thesis end to end, and it's demonstrable in a single screenshot plus a single sentence.

---

## 7. Portfolio ↔ daily-tool conflicts, collected

Flagged per request. Four real ones:

1. **Hook installation friction.** Required for everything; a reviewer must configure their machine. → One-click installer in Settings + graceful degradation. Serves both.
2. **Embedded OTLP receiver (B4).** Heavy for one user; the only path to the number that makes the thesis land. → Do it, gated, app works without it.
3. **B3 timeline card.** Portfolio-weighted. Moderate daily use, maximum legibility. → Build it well anyway; it's the artifact.
4. **Phase D session control.** Daily-weighted. Genuinely useful, zero differentiation. → Build it last, don't feature it.

Plus two standing items from the gap doc that are pure portfolio cost with no daily benefit:

- **Fixed 1536×1024 frame.** A reviewer on a 2560×1440 monitor sees letterboxing and reads *unfinished*, not *deliberate* — they don't have PROGRESS.md. Either make the frame breathe, or put the design-handoff rationale in the README where it's actually read.
- **"Manual verification deferred to the user"**, recurring across 8+ plans. Playwright's `_electron.launch()` drives an Electron main process and gives you the renderer — this is exactly what it's for. Closing it converts the one thing in the ledger that reads as a gap rather than a decision, and adds "e2e-tested Electron app" to the pitch.

---

## 8. README reframe

The reactor gets a reviewer to click. It does not get them to take you seriously. Suggested ordering:

1. **The thesis**, one sentence — detects thrashing, prices it, lets you intervene.
2. **The dispatch timeline screenshot** (B3).
3. **Least-privilege persona context scoping, with the test that proves an agent channel can't leak the roster.** Currently buried under "The design decision worth reading about" — right content, wrong position.
4. **Behavioral anomaly detection** — the four detectors, what each catches, what it cost.
5. **The sim→live migration ledger**, including the `usageTokens()` story: off by 4.68 billion because it summed cache tokens, and *all 13 unit tests had cache fields zeroed so the review pipeline never caught it* — found by checking against `/usage` on real data. That story shows you know tests can be confidently wrong and that ground truth beats green checkmarks. It is a better engineering signal than any feature in the app and it is currently one line in a 95KB file.
6. The reactor, as the ambient layer over all of it.
