# Real severity: narration sub-project 1 (design)

- **Date:** 2026-09-30
- **Status:** design approved in conversation, awaiting written-spec review
- **Base:** master `499b7bc`
- **Amends:** `AGENT_PERSONALITY_LAYER_1.md` §4 (severity). The amendment is recorded here and in a dated revision note to be added to §4. §4 is not rewritten in place.
- **Line references** come from research at `9f74a8d`. #103 (`499b7bc`) has since touched `reducer.ts`, `types.ts` and `persistence.ts`, so re-locate lines at the plan's base before relying on them.
- **Research behind it:** `~/.claude/handoffs/aether-os/scratch-stage12-context.md` and `scratch-stage12-severity-signals.md` (on work-it, outside the repo).

## 1. Why

Stage 12 (voice packs and narration) shipped, but the narration runs on severity that is almost never real:

- **Failed and killed dispatches are recorded as successes.** A failed or killed Agent notification carries `<status>failed|killed</status>` and **no `<usage>` block**. Nothing reads `<status>`: `usageIngest.ts:48-60` and `liveAgentsMath.ts:51-62` read only the tool-use id, tokens, tool uses and duration. When the usage regex misses, the code falls back to 0/0/0 (`usageIngest.ts:58-60`) and stores the row as `exit_state 'ok'`, severity 1 (`usageIngest.ts:63-81`). `electron/main.ts:757-762` then feeds that 0 ms duration into the median baseline.
- **Production severity is effectively always 1.** The collector's `computeSeverity` (`personalitySpine.ts:94-124`) follows §4, but its callers hardcode exit `ok`, retries 0 and median null. The only path to anything else is the stale sweep, which gives 4 `fatal` (`staleDispatchSweep.ts:88-98`). The roster path does not use `computeSeverity` at all: `electron/narrationGenerator.ts:22-26` has its own copy that only raises severity for slowness, so it can only produce 1 or 2.
- **Consequence:** the dial floor, CINDER's `critic_tell`, the severity 3-4 sample lines and the interrupt bypass cannot be reached from real dispatches.
- **Retries have no signal anywhere.** Nothing in the notification or the parsers records one.

This sub-project makes severity real. It is the foundation for sub-project 2 (voice for severe events), sub-project 3 (failure post-mortems) and sub-project 4 (controls: terse, per-agent dial, the dead frozen phrases).

## 2. Operator intent (from the brainstorm)

- Narration is for **awareness with character**: distinct personas, but "details when needed". Routine runs stay quiet; runs that need attention are specific.
- Delivery (sub-project 2): **text, plus voice only for important moments**. Important means severity 3-4, so voice is useless until severity is real.
- **What the operator counts as needing them:** failed, stalled, and retries/repeated errors. Slowness does **not** count and stays informational.

## 3. Severity rules (amends §4)

The additive model is kept: base 1, bumps, a floor, clamp 0..4. The exit mapping and the retry rule change.

| Signal | `exit_state` stored | Severity | Change vs §4 |
|---|---|---|---|
| `<status>completed`, normal | `ok` | **1** | none |
| completed, elapsed > 3× median (median must be established, see §6) | `ok` | **2** | slowness alone is **capped at 2** |
| completed with **≥ 3 tool errors** in its own run (**only if the spike in §8 succeeds**) | `ok` | floor **3** | **replaces** `retries >= 2`, which has no source signal |
| `<status>failed` | `error` | **4** | §4 had `error → 3` |
| `<status>killed` | `killed` (**new value**) | **2** | new. A kill is almost always deliberate (an operator or orchestrator stop), so it is informational and never voiced |
| stalled (see §5) | `fatal` | **4** | unchanged |
| status tag missing or unrecognised | `ok` | **1** | new. **Never guess a failure.** One `[diag]` line per previously unseen status value |

- Failures and stalls both score 4, but keep different `exit_state` values so the Ledger and post-mortems can tell them apart.
- `TOOL_ERROR_FLOOR = 3` and `SLOW_FACTOR = 3` are named constants.
- The unused `exit` values in §4 (`partial`, `timeout`, `blocked`) stay in the type. Nothing produces them yet.

## 4. Architecture

Three pure units form one source of truth.

| Unit | Contract | Depends on |
|---|---|---|
| `parseDispatchOutcome(notificationText)` | Returns `{ status: 'completed' \| 'failed' \| 'killed' \| 'unknown', usage?: { tokens, toolUses, durationMs } }`. Never throws. Returns **no string fields other than `status`**: `<summary>` and `<result>` are never read into the result. A missing usage block gives `usage: undefined`, never zeros. | nothing |
| `computeSeverity(input)` | Moved from `collector/src/personalitySpine.ts`, with the §3 rules applied. The result carries `severity`, `exitState`, `elapsedMs` and `medianMs` (null when unestablished) so that narration can say "took 14m, usually 4m". | nothing |
| `isStalled(dispatch, nowMs)` | See §5. | nothing |
| `DurationBaseline` | See §6. | persistence adapter only |

- **Location:** `electron/severity/`. The collector gets a **generated copy plus a parity test**, following the existing `electron/atomicWrite.ts` → `collector/src/atomicWrite.ts` + `atomicWrite.parity.test.ts` pattern, because the collector is a standalone zero-dependency process. If the two copies drift, CI fails.
- **Live path**, which drives narration and later voice. It covers the pinned session only, as today:
  `liveAgentTracker` notification → `parseDispatchOutcome` → `computeSeverity` (with the baseline) → narrationGenerator → roster, Comms, dial floor.
  **Delete** the re-implementation in `narrationGenerator.ts:22-26`.
- **Collector path** (history): `usageIngest` uses the same parser and `computeSeverity`, and the stale sweep calls `isStalled`.

## 5. Stall detection

- **Definition** (shared `isStalled`): no progress for longer than `STALL_MS`, **or** the owning Claude session has ended while the dispatch is still open. Progress means a new transcript line attributable to that dispatch: on the main thread, or in its subagent file if §8 finds the link.
- `STALL_MS` = **30 min**. That matches the collector today, and it is deliberately conservative, because 4 means "needs you now" and long agents can legitimately be quiet.
- **Live path (new):** a check roughly every 30 s over the open dispatches.
  - A dispatch that crosses the threshold becomes severity 4 `fatal` **exactly once**. It is not re-announced on later ticks.
  - **Recovery:** if a stalled dispatch later completes, its real outcome replaces the stall. The severity is recomputed from the outcome, and a single "recovered" narration line is emitted.
- **Collector path:** the existing sweep is kept and calls `isStalled`. Known limitation, still out of scope: stall state does not survive a collector restart.

## 6. Duration baseline

| Rule | Value |
|---|---|
| Key | `subagentType` (equal to `agent_id` and `task_kind` in practice, `usageIngest.ts:81`) |
| Samples admitted | only `completed` outcomes with a usage block and `durationMs > 0`. Failed, killed, stalled and unknown outcomes are never admitted |
| Window | last 20 per key |
| Minimum samples | **5**. Below that, the median is `null` and there is no slowness bump |
| Slowness | `elapsed > SLOW_FACTOR × median` gives +1, with the result capped at 2 by the slowness rule |

- **Live persistence:** `~/.aether-os/duration-baseline.json`. It holds numbers only, keyed by agent type, and passes `noPayloadInStore`. It is written through `electron/atomicWrite.ts`, so it inherits the #99 user-only directory ACL. It replaces the in-memory-only `electron/durationBaseline.ts` behaviour, which lost everything on restart and had no minimum. A corrupt or unreadable file starts empty, with one `[diag]` line.
- **Collector:** `median_ms_at_eval` is computed by a query over its own `dispatches` history with the same rules (successful rows, `duration_ms > 0`, last 20, minimum 5). The `> 0` filter excludes the historic rows where failures were recorded as `ok` with 0 ms. No migration and no history rewrite.

## 7. Collector changes

- `usageIngest` uses the shared parser. `failed` → `exit_state 'error'` and `killed` → `'killed'`, with severity from §3.
- When the usage block is missing, tokens, tool uses and duration are stored as **NULL, not 0**. **Spec-writer check:** if those `dispatches` columns are `NOT NULL`, this needs a schema v9 migration (the base was v8; shipped as v9). Specify it; do not work around it.
- **The Ledger must render `killed`** (it reads `exit_state` and `retries`). **Spec-writer check:** every consumer of `exit_state` must handle the new value.
- **Memory extraction interaction:** `transcriptScan.ts:165` sends only `exit_state === 'ok'` dispatches to extraction. With real outcomes, failed and killed runs stop being sent. This is intended, and it is related to #104.
- **The Go collector** (`collector-go/`) has its own ingest. It is out of scope unless an existing parity test forces it in. If it stays out, file an issue next to #65.

## 8. Spike (the plan's first task, time-boxed)

- **Question:** how does an Agent dispatch's `tool_use_id` in the main transcript link to its subagent transcript (`<session>/subagents/agent-*.jsonl`)? The main transcript carries an `agentId` field whose link was not located. The collector already scans subagent files (`transcriptScan.ts:196-239`).
- **Output:** a written note (go/no-go) recording the link, its reliability across the observed transcripts, and whether `is_error` tool results in the subagent file can be counted per dispatch.
- **Go:** the ≥ 3 tool errors floor (§3) is built in this plan, and subagent-file lines also count as progress for §5.
- **No-go:** this slice ships severity 4 / 2 / 1 without the severity-3 rule, and severity 3 becomes its own later slice. Everything else in this spec is unaffected.
- **Side finding to record, not fix:** the subagent files contradict CLAUDE.md's gotcha ("0 isSidechain lines / tool calls in NO transcript"). Correct that gotcha in the same PR.

## 9. Error handling

- The parser never throws. Unknown input gives `status: 'unknown'`, which is treated as `ok` at severity 1 (§3).
- Negative elapsed time (clock skew) gives no slowness bump.
- A corrupt baseline file starts empty and writes a `[diag]` line (§6).
- A severity result never contains transcript text. Enforced by a test.

## 10. Testing

Every new test must be seen **failing before** its fix.

- **Parser:** completed with usage; failed without usage; killed without usage; missing tag; unknown tag. Assert that the result has no string field other than `status`.
- **computeSeverity:** one test per §3 table row, including killed → 2, slowness capped at 2, unknown → 1, and the tool-error floor if the spike returns go.
- **isStalled:** inactivity threshold, session ended, and a fresh dispatch.
- **Baseline:** the 5-sample minimum, the 20-sample window, rejection of failed/killed/zero durations, the persistence round-trip, and a corrupt file.
- **Live integration:** a failed notification reaches narration as **severity 4** (red today: it arrives as 1). A stall fires exactly once across ticks. A late completion replaces the stall and emits one "recovered" line.
- **Collector:** failed and killed rows get the right `exit_state` and NULL usage columns; the memory gate skips them; the median query ignores `duration_ms = 0` rows.
- **Guards:** the new parity test for the generated severity copy; `noApiCalls.test.ts` and `noPayloadInStore.test.ts` stay green.
- **Fixtures:** synthetic, with shapes taken from real transcripts. **No copied transcript content.**
- **Existing tests that asserted today's severity-1-for-everything behaviour** are updated, and each such change is listed in the builder report.

## 11. Out of scope

- Voice (sub-project 2), failure post-mortems (3), controls, `terse` and the dead frozen phrases (4).
- The collector's model call (#104).
- The Go collector (unless forced in, §7).
- Live-path coverage of sessions other than the pinned one.
- Stall-state persistence across collector restarts.
- Retries as a signal (there is no source).

## 12. Docs to update in the implementing PR

- A dated revision note in `AGENT_PERSONALITY_LAYER_1.md` §4 pointing here.
- `PROGRESS.md`.
- The CLAUDE.md sidechain gotcha (§8).
- Stale "model-written" comments on `dispatchNarrations`: `narrationFeed.ts:10`, `types.ts:52`, `reducer.ts:400`, `persistence.ts:46`. That path is deterministic.
