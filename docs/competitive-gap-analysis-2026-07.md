# Aether OS — Competitive Gap Analysis & Prioritized Backlog

**Date:** 2026-07-27
**Baseline:** PROGRESS.md @ 2026-07-26 (480/480 tests), README.md, source tree
**Comparison set:** agent-orchestration GUIs · first-party vendor UIs · chat-shell front ends · usage/observability tools

---

## 0. The one-paragraph read

The orchestration-GUI category you'd nominally be competing in **got flattened in 2026**, and you weren't in it — which turns out to be lucky. Meanwhile the category you *are* in — ambient observability and agent-behavior instrumentation — is the thinnest, least-served lane in the entire landscape. But Aether OS is currently reading Claude Code through a keyhole (batch-scanning historical JSONL) while Anthropic has spent 2026 building a **front door**: statusline JSON with authoritative rate-limit percentages, 30+ hook events, OTel metrics with subagent attribution, and dynamic-workflow run files on disk. **Three of your documented "architecturally impossible" and "not reliably derivable" decisions are now factually wrong.** That's the headline. The rest of this doc is the receipts and what to do about it.

---

## 1. Positioning: where you actually sit

### 1.1 The category collapse (this is context, not a threat)

Of the tools you'd have been benchmarked against a year ago:

| Tool | Peak traction | Status July 2026 |
|---|---|---|
| Vibe Kanban (BloopAI) | **27.1k ★** — most-starred in the category | **Sunsetting.** Parent company shut down Apr 2026. Explicit reason: free users wouldn't convert. |
| Claudia / opcode | 22.2k ★ | **Silently stale.** Last release v0.2.0, Aug 2025. Build broken on `main`; fixes coming from randoms, not maintainers. |
| Crystal (stravu) | 3.1k ★ | **Deprecated Feb 2026.** README redirects to Nimbalyst. |
| Terragon Labs | funded startup | **Shut down Feb 2026.** Had shipped Routines-equivalent ~a year before Anthropic. |
| Omnara, CUI | — | Archived Feb/Mar 2026. CUI's maintainers explicitly redirect users to *Anthropic's own* web/Remote Control/Cowork. |

Survivors: **Conductor** (Series A, ~12 releases in July alone, Mac-only), **CloudCLI** (ex-Claude Code UI, went managed hosting at $7/mo), **Emdash** (YC W26, Apache-2.0, best OSS successor), **Sculptor** (alive but Imbue's entire 2026 blog output is about *other* products).

Two structural lessons that matter to you: **stars are a lagging, useless health metric** (27.1k died, 818-star Nimbalyst ships weekly), and **monetization is what kills these, not features**. You have neither problem — this is a personal cockpit with an explicit non-goal of packaging. Your "deliberately not a distributed product" call reads, in hindsight, as the correct strategic decision rather than merely a scope cut.

### 1.2 What Anthropic shipped that eats the category

**April 14, 2026** — Claude Code Desktop redesign + Routines. Parallel sessions in auto-managed git worktrees at `<root>/.claude/worktrees/`, five graded permission modes, line-level diff comments, PR monitoring with auto-fix/auto-merge, a usage ring next to the model picker, drag-and-drop panes (chat/diff/browser/terminal/plan/tasks/subagent/iOS-Simulator), and side chat (`Cmd+;` / `/btw`) that reads the main thread's context and writes nothing back.

Plus, over the year: **`claude agents`** (a full-screen fleet TUI that is, honestly, the best multi-agent UI anyone shipped), **dynamic workflows** with a `/workflows` phase→agent drill-down, **Remote Control** (`claude remote-control`, QR code on spacebar), **Ultraplan**, **Channels**, **Dispatch**.

If your goal were "build a better Claude Code GUI," this would be a eulogy. It isn't, so it's just weather.

### 1.3 The lane that's actually open

The observability/behavior side is genuinely immature. The entire "agent traces, tool-call timelines, subagent trees" category is:

- **claude-workflow-viz** — the only real Gantt with a replay scrubber. **4 stars, 13 commits, no releases.**
- **agent-flow** — ~990★, interactive node graph, file-attention heatmap. Ships opt-out telemetry on by default.
- **disler/claude-code-hooks-multi-agent-observability** — 1.4k★, the canonical hooks demo, but it's an *event feed*, not a Gantt. No duration bars, no nested tree.
- **claude-devtools** — 3.4k★, best token attribution (7-category per-turn breakdown), compaction visualization.
- **claude-code-log** — real message DAG with subagent hierarchies, but the visual layer is explicitly WIP.

Nobody has combined a fleet view, behavioral anomaly detection, and ambient status into one surface. That's your lane, and you're already three-quarters of the way into it without having framed it that way.

---

## 2. What genuinely stands out about Aether OS

These aren't participation trophies. Each one is a thing I could not find a real equivalent for in the comparison set.

### 2.1 Behavioral anomaly detection on agent traces — nearly unique

`detectReReadLoop`, `detectWriteDeleteRewrite`, `detectZeroEditBurn`, `detectStalledPermission`. The closest things in the wild are **Sculptor's Verifier** (checks whether the agent's claims match its diff — the only shipped agent-honesty check I found) and **sniffly** (1.2k★, error analysis, lightly maintained at 33 commits). Neither does *pathological-loop* detection.

Every usage dashboard in the landscape answers "how much did I spend." Almost none answer **"is the agent stuck in a stupid loop right now."** That's a different and more useful question, and you already answer it.

Caveat you already documented: `detectStalledPermission` is a >60s heuristic that false-positives on long-running tools. §4 has a fix that makes it exact.

### 2.2 Sonification — literally nobody else does this

`decideAlertActions` mapping alarm-state transitions to Web Audio oscillators (yellow-alert chirp on ok→warn, looping klaxon on →crit, anomaly chime on 0→N). The nearest neighbor in the entire survey is **Codex Micro's** color enum (White idle / Blue working / Green done-unread / Amber needs-input / Red error) — and that's a *hardware peripheral*, not software.

For agents that run 2–20 minutes unattended, audio is the correct channel and everyone is ignoring it. Anthropic's own answer to the away problem is contextual push nudges; Google's is a post-hoc Walkthrough artifact. Nobody thought about sound.

### 2.3 Least-privilege context scoping for LLM personas, with tests

`systemPrompt.ts` — AETHER gets the full fleet snapshot; an agent channel gets self-only, and tests verify an agent channel *cannot* leak the roster, approval queue, or project list.

Your README calls this "it started as fiction-accurate flavor and turned out to be a real agent-platform architecture pattern." That's correct and undersold. In the chat-shell world, personas are prompt+model+params bundles; **nobody scopes what world-state a persona can see, and nobody tests the boundary.** Given 2026's prompt-injection anxiety (Anthropic wraps Routine API payloads in `<routine-fire-payload>` labeled untrusted specifically because a leaked token should yield data, not instructions), this is on-trend and defensible.

### 2.4 The reactor as a *legible* continuous instrument

`computeModelHueShift`, `computeCacheClarity`, `computeConcurrencyTurbulence`, plus overload thresholds on real dispatch count and hue/glow driven by real burn rate.

The state of the art elsewhere is `claude agents`' **two-axis glyph** — color for logical state, shape for process liveness (`✻` alive / `∙` exited-but-resumable / `✢` sleeping-with-countdown). Genuinely clever, and you're encoding more axes than that in a continuous field rather than a discrete glyph. The REACTOR LEGEND toggle is what makes it an instrument rather than a screensaver; keep defending that.

### 2.5 Radical honesty about sim-vs-real

The README's "this started as a simulation and has been migrated to live data," the phase-by-phase ledger, the deletion of the SPAWN + button because it had "nowhere honest to point," the IDLE badge replacing the always-on STREAMING badge, dropping `logs` from the persistence whitelist so stale lines can't fake a streaming state.

This is rarer than it should be. Anthropic's own Routines docs earn credit for "*a green status does not mean the task in your prompt succeeded*"; your project is holding the same standard on itself. It's also why this gap analysis is possible at all.

---

## 3. Three decisions in PROGRESS.md that are now factually wrong

This is the most actionable section. Each of these is a documented, reasoned scope cut that was correct when made and is no longer true.

### 3.1 "Depletion ETA must be estimated" → **Claude Code hands you the real number**

Claude Code's `statusLine` scripts receive JSON on **stdin**. Among the fields:

```
rate_limits.five_hour.used_percentage      // 0-100, server-side authoritative
rate_limits.five_hour.resets_at            // unix epoch seconds
rate_limits.seven_day.used_percentage
rate_limits.seven_day.resets_at
cost.total_cost_usd, total_duration_ms, total_api_duration_ms
context_window.used_percentage / remaining_percentage / context_window_size
context_window.current_usage.{input, output, cache_creation, cache_read}_tokens
session_id, transcript_path, model.{id,display_name}, effort.level
workspace.{current_dir, project_dir, git_worktree, repo.{host,owner,name}}
agent.name, pr.{number,url,review_state}
```

Updates are **event-driven** (new assistant message, `/compact` finish, permission-mode change) with 300ms debounce, plus a configurable `refreshInterval` for time-based segments.

Your DEPLETION ETA is a linear extrapolation off a 60-second batch rescan. `rate_limits.five_hour.resets_at` is the actual reset timestamp from the server. **This is the single highest value-to-effort item in this entire document.**

Note this also obsoletes a whole generation of tools: Claude-Code-Usage-Monitor's P90-over-192-hours limit detection exists purely to *estimate* what this field now reports exactly. It hasn't shipped in ~12 months, and its hardcoded plan table predates weekly limits.

### 3.2 "CONTEXT stays fictional — a single session's live context-window fill isn't reliably derivable from batch-scanning historical transcripts"

Correct premise, wrong conclusion. It isn't derivable *from batch-scanning transcripts*. It's sitting in the same statusline payload as `context_window.used_percentage`, with the four-way `current_usage` token split alongside it.

Two version-sensitive semantics to respect: `used_percentage` is **input-only** (input + cache_creation + cache_read, excluding output), and as of v2.1.132 `context_window.total_input_tokens` means *current occupancy*, not cumulative session total. `current_usage` is `null` before the first API call and again right after `/compact`.

This is your last fictional KPI tile. It doesn't have to be.

### 3.3 "Claude Code simply never persists which files a subagent touched"

The `isSidechain:true` investigation was sound and the conclusion held **for transcript scanning**. But:

- **Subagent transcripts moved to a `subagents/` subdirectory as of Claude Code 2.1.2+.** claude-code-log had to add explicit support for this. If your `isSidechain` grep predates that, it was looking in the wrong place.
- **Hooks give you it directly.** `PreToolUse` / `PostToolUse` / `PostToolBatch` fire *inside subagents* with `agent_id` and `agent_type` in the payload. That is a live tool-call log including file paths, pushed to you, keyed to the dispatch.

I'd rate the second point as certain and the first as worth a 5-minute re-check before you trust it.

---

## 4. The data sources you aren't using

Aether OS currently reads: JSONL transcripts (60s scan), the most-recently-active session tail (1s), a pty, and the Messages API. Here's the rest of the 2026 surface area, ranked by relevance.

### 4.1 Hooks — the biggest single unlock

30+ events. Every hook payload carries `session_id`, `prompt_id` (correlates with OTel's `prompt.id`), `transcript_path`, `cwd`, `permission_mode`, `effort.level`, plus `agent_id`/`agent_type` inside subagents.

The ones that map directly onto your existing architecture:

| Hook | What it fixes in Aether OS |
|---|---|
| `SubagentStart` / `SubagentStop` | **`SubagentStop` carries `tokens_used.{input, output, cache_creation, cache_read}`.** Kills the "cache-hit ratio is session-level, not per-dispatch" limitation outright. Also kills the replay-backfill orphan problem and the missing-completion-log-line bug — push events don't replay. |
| `TaskCreated` / `TaskCompleted` | Real dispatch lifecycle instead of diffing `realAgents` by `toolUseId`. Fixes the **session-switch false-completion bug** you documented and explicitly declined to fix the heavy way — this is the light way. |
| `PermissionRequest` / `PermissionDenied` | **Converts the entire fictional approval queue into a real one.** See §5. |
| `Notification` | Real trigger for the TopBar bell, which currently only fires on simulated auto-approvals. |
| `PreCompact` / `PostCompact` | Compaction events. vibe-log uses `PreCompact` specifically to capture transcripts before compaction destroys them — a genuinely smart trick worth stealing. |
| `SessionStart` / `SessionEnd` | Real session boundaries, and the foundation for a session picker. |
| `WorktreeCreate` / `WorktreeRemove` | If you ever want worktree awareness, it's free here. |
| `TeammateIdle`, `StopFailure`, `Elicitation` | Fleet/agent-teams awareness. |

Hooks are **push, not poll**. Your entire 1s-tick / re-discover-every-tick / replay-from-byte-0 machinery exists to compensate for polling a file. Most of it becomes unnecessary. That's a simplification, not just a feature.

### 4.2 OpenTelemetry — the attribution layer

8 metrics, ~15 log events, plus beta traces. The parts that matter:

- **`claude_code.token.usage`** with `type` ∈ {input, output, **cacheRead**, **cacheCreation**} and attributes `model`, **`query_source`** (main/subagent/auxiliary), `agent.name`, `skill.name`, `plugin.name`, `mcp_server.name`, `mcp_tool.name`, `effort`, `speed`.
- **`query_source=subagent`** is the clean fix for subagent double-counting that every JSONL-based parser gets wrong.
- **Traces (beta, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`)**: `claude_code.interaction` → `llm_request` / `hook` / `tool` → `tool.blocked_on_user` + `tool.execution`. **`blocked_on_user` isolates human wait time from machine time** — that's your `detectStalledPermission` becoming exact instead of heuristic.
- `claude_code.code_edit_tool.decision` with accept/reject by language, and `claude_code.active_time.total` split user-keyboard vs cli.

Gotchas: OTel is opt-in, env vars must be set **before** `claude` starts, and they're **not inherited** by Bash-tool subprocesses, hooks, MCP servers, or LSPs. Default temporality is `delta` (breaks Prometheus, which wants `cumulative`). Spaces in `OTEL_RESOURCE_ATTRIBUTES` silently drop the entire attribute string. Without `OTEL_LOG_TOOL_DETAILS`, your own agents report as `custom` and third-party skills as `third-party` — so out-of-box attribution is coarse exactly where you care.

For a single-user cockpit, hooks are the better first move; OTel is the right second move if you want the four-way token split and per-skill attribution without parsing anything.

### 4.3 Dynamic workflow run files — your Orchestration Grid's missing dataset

Claude Code v2.1.154+ has **dynamic workflows**: Claude writes a JS orchestration script, a runtime executes it out-of-context, `agent()` spawns, `pipeline()` fans out, up to **16 concurrent agents / 1,000 per run**. `/workflows` shows a phase→agent drill-down with per-phase agent count, token total, elapsed time.

These runs persist to `~/.claude/projects/<slug>/<session>/workflows/wf_<id>.json` (per claude-workflow-viz, which reads exactly this and is the only Gantt in the ecosystem — at 4 stars and no releases).

Your hub-and-spoke radial grid is **already the right visual for a fan-out DAG** and doesn't know this data exists. Caveat: this is a research-preview on-disk format and will move.

### 4.4 Native `/usage` — what it now includes

Worth knowing because it sets the expectation bar: session cost, API-vs-wall duration, lines added/removed, per-model four-way token split, and for subscription users **usage attribution by skill, subagent, plugin, and individual MCP server as % of total**, plus automatic flagging of any behavior accounting for ≥10% of recent usage (long context, cache misses) with remediation tips.

That last one — *behavioral cost drivers surfaced automatically* — is philosophically the same product as your anomaly detectors, shipped first-party. You should be aware you're now adjacent to a native feature, and lean into what it *doesn't* do (real-time, ambient, loop detection).

---

## 5. Gap matrix

Legend: **✓** shipped · **~** partial/simulated · **✗** absent · *TS* = table stakes in its category · *R* = rare/differentiating

| Capability | Aether | Category norm | Notes |
|---|---|---|---|
| **Usage / observability** |
| Four-way token split (in/out/cacheRead/cacheCreate) | ✗ | *TS* | You sum input+output only — correct for matching `/usage`, but cache reads are typically the **largest** category by 10× (940k cache read vs 1.2k input in Anthropic's own example). |
| Cache-hit ratio as a metric | ~ | *TS→* | `state.cacheHitRatio` exists and drives reactor clarity — but isn't a readout anywhere. Grafana dashboard 25255 has it; most tools don't. You're closer than you think. |
| Real 5h + 7d rate-limit % with reset timestamps | ✗ | *TS* | §3.1. This is now table stakes and you're estimating it. |
| Burn rate + depletion projection | ✓ | *TS* | Shipped, but built on the estimate. |
| Context-window occupancy | ~ *(fictional)* | *TS* | §3.2. |
| Dollar cost | ✗ *(explicit non-goal)* | *TS* | Defensible for a subscription user — the number is notional at list rates anyway. See §7. |
| Per-project / per-session / daily-weekly-monthly rollups | ~ | *TS* | You have session + aggregate. No historical rollups. |
| Attribution by subagent / skill / plugin / MCP server | ✗ | *TS as of 2026* | Native `/usage` has it; OTel `query_source` + `agent.name` give it to you. |
| Live **and** batch | ✓ | *TS* | 1s agent tick + 60s usage scan. Genuinely both. |
| **Behavior / traces** |
| Behavioral anomaly detection | ✓ | *R* | §2.1. Near-unique. |
| Subagent tree / parallel Gantt | ✗ | *R* | Whole category is 2 immature projects. Open lane. |
| Tool-call timeline with durations | ✗ | *R* | Available free via hooks or OTel traces. |
| Replay / scrubbing | ✗ | *R* | Only claude-workflow-viz. |
| "Where did my context go" attribution | ✗ | *R* | Only claude-devtools (7 categories). |
| Compaction visualization | ✗ | *R* | Only claude-devtools. `PreCompact`/`PostCompact` hooks make it cheap. |
| **Fleet / control** |
| Multiple concurrent sessions visible | ✗ | *TS* | Tracker auto-picks the globally most-recent. No picker, no fleet. |
| Session picker | ✗ | *TS* | |
| Start / stop / spawn real sessions | ✗ | *TS* | One pty, `pty:start` once per app lifetime. |
| Session history / resume / transcript browse | ✗ | *TS* | Rolling in-memory pools (cap 20 / cap 100), not a history store. |
| Git worktree isolation | ✗ | *TS* (the universal 2026 primitive) | Explicit non-goal territory — see §7. |
| Diff review | ✗ | *TS* | §7 — genuinely not your job. |
| Real per-tool-call approval gates | ~ *(fully fictional)* | *R!* | **Rare even among competitors.** `PermissionRequest` hook makes it real. Highest-payoff fiction→real conversion available. |
| PR status / CI | ✗ | *TS* | `pr.{number,url,review_state}` is in the statusline payload for free. |
| **Presentation** |
| Ambient/sonified status | ✓ | *unique* | §2.2. |
| Continuous multi-axis instrument | ✓ | *R* | §2.4. |
| Model-written status lines | ✗ | *R!* | `claude agents` runs a Haiku classifier rewriting each row's headline every 15s; for blocked sessions the summary **is the question**. Called the highest-leverage single idea in the first-party survey. You show raw `subagentType`/`description`. |
| Two-axis status glyphs (color=state, shape=liveness) | ~ | *R* | Your reactor does more; your *roster rows* don't. |
| Transcript density controls (Normal/Verbose/Summary) | ✗ | *TS* | Everyone converged on this. Anthropic's framing: "*use Summary when you're running multiple sessions and want to scan results quickly.*" |
| Light/dark theming | ✓ | *TS* | Done, incl. 24-file sweep. |
| Keyboard navigation / accessibility | ✗ | — | Clickable `<span>`s project-wide. Anthropic shipped a full screen-reader mode (`--ax-screen-reader`); nobody else has one. |
| Responsive layout | ~ *(letterbox scale)* | *TS* | Explicit non-goal. Fine. |
| Mobile access | ✗ | *TS* | Non-goal for a desktop cockpit. Fine. |
| **Configuration** |
| MCP server management UI | ✗ | *TS in chat-shells* | You don't use MCP at all. See §7 — probably correct. |
| Hooks / settings.json / subagent-definition management | ✗ | *R* | Nobody does this well. `ccexp` is a config *explorer* only. Possible niche. |
| Persona bundles (prompt+model+params+tools) | ~ | *TS in chat-shells* | `PERSONAS` is a hardcoded map keyed to 11 fictional agents. |
| Plugin / extension seam | ✗ | *R* | CloudCLI's plugin-tab system is the only good one. Not needed for one user. |

---

## 6. Prioritized backlog

Ranked by **value ÷ effort** for a personal cockpit, given your existing architecture (pure-function seam, additive-slice discipline, optional-trailing-parameter extension pattern).

### Tier 1 — do these next

**1. Statusline JSON feed → replace estimated usage with authoritative data.**
*Effort: S. Value: very high.* Register a `statusLine` script (or a small script that writes the payload to a file your Electron side tails). Wire `rate_limits.five_hour.used_percentage` + `resets_at` into DEPLETION ETA, and `context_window.used_percentage` into the CONTEXT tile — killing your last fictional KPI. New `state.statusline` slice, disjoint from `realUsage`, per your independent-pipeline discipline. Respect: `used_percentage` is input-only; `current_usage` is `null` pre-first-call and post-`/compact`.

**2. `SubagentStop` hook → real per-dispatch four-way token split.**
*Effort: S. Value: very high.* `tokens_used.{input, output, cache_creation, cache_read}` arrives per subagent. Kills three documented limitations at once: session-level-only cache ratio, replay-backfill orphans, missing completion log lines. Feeds `state.dispatchUsage` (already exists, cap 100) with strictly better data. Add a per-dispatch cache-hit-ratio readout on the Analytics card.

**3. `PermissionRequest` hook → make the approval queue real.**
*Effort: M. Value: very high, and it's the identity move.* Your approval queue, risk policy (kill=HIGH, spawn=MED, throttle=LOW), TopBar bell, and AUTO-mode are the largest remaining fictional subsystem. `PermissionRequest` gives you the real event; the hook's response controls allow/deny. Aether OS stops being a passive observer and becomes an **approval console** — without becoming a worktree manager. That's a coherent identity, and it's one integration away.
*Steal while you're here:* Antigravity's **editable permission target** — the approval card lets you widen `write_file(src/foo.ts)` to `write_file(src/**)` inline, validated for the session. Rated the single best approval affordance found anywhere. Nobody else ships it.

**4. Model-written status lines on the agent roster.**
*Effort: S–M. Value: high.* You already have a working Anthropic proxy and a persona system. Run a Haiku-class classifier over each live dispatch every ~15s and replace the raw `description` with a one-line headline. For a blocked/stalled dispatch, make the headline *the thing it's stuck on*. This is the difference between a roster that reads at a glance and a wall of tool names.
*Cost note:* trivial at Haiku rates, but it's real token spend on a dashboard whose job is watching token spend. Make it a `Cfg` toggle, default off, and it'll show up in your own burn readout — which is honest and slightly funny.

**5. Session picker + multi-session awareness.**
*Effort: M. Value: high.* `SessionStart`/`SessionEnd` hooks plus `session_id` in every payload. Removes the auto-pick-most-recent constraint and the session-switch false-completion bug in one move. Prerequisite for anything fleet-shaped.

### Tier 2 — high value, more work

**6. Tool-call timeline / subagent Gantt.**
*Effort: L. Value: high, and it's the open lane.* Hook events give you start/stop with durations and `agent_id`/`parent_agent_id`. OTel traces (beta) give you `blocked_on_user` isolated from `tool.execution` — human wait vs machine time, which also makes `detectStalledPermission` exact rather than a 60s heuristic. Lane-pack overlapping windows to recover parallelism. Genuinely nobody has done this well.

**7. Real file-touch tracking per dispatch.**
*Effort: M. Value: high — this reopens a closed door.* §3.3. `PreToolUse`/`PostToolUse` fire inside subagents with `agent_id`. This is the live tool-call log you concluded didn't exist. Would give `Agent.files` real data and un-strand the Files pivot.

**8. Dynamic-workflow run visualization on the Orchestration Grid.**
*Effort: M. Value: high if you use `ultracode`, zero if you don't.* §4.3. Your radial hub-and-spoke is already the right shape for fan-out. Read `workflows/wf_<id>.json`, render phases as rings. Caveat: research-preview format, will move — build it behind a feature flag and expect breakage.

**9. Transcript density control (Normal / Verbose / Summary).**
*Effort: S–M. Value: medium-high.* Universal convergence across every vendor. For Live Output and the dispatch feed, a density toggle is cheap and immediately useful once you're tracking >2 dispatches.

**10. Session history store.**
*Effort: M.* Your rolling pools (cap 20, cap 100) are deliberately not history. A real store enables day/week rollups, longest-dispatch trends, and anomaly-rate-over-time — which is where anomaly detection gets genuinely interesting.

### Tier 3 — worth it eventually

**11. OTel ingest** for four-way tokens + per-skill/plugin/MCP attribution without parsing. Set `OTEL_METRICS_INCLUDE_SESSION_ID=false` if it ever gets noisy; note env vars must precede `claude` startup and aren't inherited by subprocesses.

**12. Keyboard navigation.** Clickable `<span>`s are a project-wide convention and a project-wide wart. Anthropic shipping a screen-reader mode when nobody else has one suggests this is free differentiator ground — and for a cockpit you drive daily, it's ergonomics, not charity.

**13. Cache-hit-ratio and cost-driver readouts** in the style of native `/usage`'s ≥10% behavior flagging, but real-time. Philosophically the same product as your anomaly detectors.

**14. Fix the `/api/chat` production-build question.** PROGRESS.md describes the chat proxy as a **Vite dev-server middleware**. If that's literally true, real Claude replies in Chat may silently not work under `electron:build` — falling back to `localResponder`, which is exactly the kind of "looks alive, isn't" failure your whole honesty discipline exists to prevent. Worth 10 minutes against the source.

**15. Compaction visualization** via `PreCompact`/`PostCompact`. Only claude-devtools does this. Steal vibe-log's trick of using `PreCompact` to capture the transcript before compaction destroys it.

---

## 7. What to deliberately NOT build

Saying no is most of the value here.

- **Git worktrees, diff review, PR management.** Table stakes for orchestration GUIs — and Anthropic, Cursor, Conductor, Emdash and VS Code all ship them now. Building these makes you the 40th-best Conductor. Your non-goal is correct; keep it.
- **Packaging, installers, auto-update, fleet/team view.** Already non-goals. Bloop's shutdown post is the argument: they had 27k stars and no business model. You have no business model *by design*, which is only a problem if you build like you do.
- **MCP server management, plugin systems, marketplaces.** Baseline in chat-shells, overkill for one user. A hardcoded list of the servers you actually use beats a registry browser.
- **Multi-tenancy, RBAC, SSO, analytics-for-admins.** That's most of Open WebUI's and LibreChat's surface area and none of it applies.
- **Dollar cost — mostly.** On a subscription the number is notional (Portkey literally shows $0; everything else simulates list prices with no contract discounts). But *do* reconsider **four-way token split**, which is the real table-stakes item you're missing. Tokens by type ≫ dollars.
- **Native mobile, responsive reflow, cloud sync.** All correctly out of scope.
- **Chasing `claude agents` feature-for-feature.** It's better than anything third-party at being a fleet TUI. Steal its *ideas* (model-written headlines, two-axis glyphs, peek-without-leaving) and apply them to things it doesn't do: anomaly detection, ambient/continuous display, sound.

---

## 8. Two things worth watching

**ToS enforcement on third-party clients.** The loudest cause of third-party tool death in 2026 discourse isn't feature competition — it's Anthropic restricting subscription-account access from third-party clients. `claude-code-viewer` had to make Agent-SDK chat-sending opt-in after an April 2026 ToS constraint. Aether OS is on safe ground as I read it: you spawn the real `claude` CLI (intended use) and your Chat proxy uses a separate API key with its own billing. Worth staying on that side of the line — reading hooks/statusline/OTel output is explicitly sanctioned instrumentation.

**Transcript JSONL is an undocumented, unstable internal format.** Anthropic publishes no schema; `transcript_path` from hooks/statusline is the only sanctioned pointer to it. Subagent transcripts already moved to a `subagents/` subdirectory in 2.1.2+. Every migration in this backlog moves you from the unstable surface toward documented ones. That's a durability argument, not just a features argument.

---

## Sources

**Anthropic first-party** — [Statusline](https://code.claude.com/docs/en/statusline) · [Hooks reference](https://code.claude.com/docs/en/hooks) · [Monitoring with OpenTelemetry](https://code.claude.com/docs/en/monitoring-usage) · [Manage costs](https://code.claude.com/docs/en/costs) · [Agent view](https://code.claude.com/docs/en/agent-view) · [Dynamic workflows](https://code.claude.com/docs/en/workflows) · [Desktop app](https://code.claude.com/docs/en/desktop) · [Routines](https://code.claude.com/docs/en/routines) · [Remote Control](https://code.claude.com/docs/en/remote-control) · [Ultraplan](https://code.claude.com/docs/en/ultraplan) · [VS Code extension](https://code.claude.com/docs/en/vs-code) · [Checkpointing](https://code.claude.com/docs/en/checkpointing) · [Changelog](https://code.claude.com/docs/en/changelog) · [claude-code-monitoring-guide](https://github.com/anthropics/claude-code-monitoring-guide)

**Orchestration GUIs** — [winfunc/opcode](https://github.com/winfunc/opcode) · [HN: Claudia, 501 pts](https://news.ycombinator.com/item?id=44933255) · [siteboon/claudecodeui → CloudCLI](https://github.com/siteboon/claudecodeui) · [stravu/crystal (deprecated)](https://github.com/stravu/crystal) · [Nimbalyst](https://github.com/Nimbalyst/nimbalyst) · [conductor.build](https://www.conductor.build/) · [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) · [Vibe Kanban shutdown post](https://www.vibekanban.com/blog/shutdown) · [imbue.com/sculptor](https://imbue.com/sculptor/) · [terragon-labs/terragon-oss](https://github.com/terragon-labs/terragon-oss) · [generalaction/emdash](https://github.com/generalaction/emdash) · [coder/mux](https://github.com/coder/mux) · [awesome-agent-orchestrators (105 tools)](https://github.com/andyrewlee/awesome-agent-orchestrators)

**Observability / usage** — [ryoppippi/ccusage](https://github.com/ryoppippi/ccusage) · [ccusage cost modes](https://ccusage.com/guide/cost-modes) · [Maciek-roboblog/Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) · [vibe-log-cli](https://github.com/vibe-log/vibe-log-cli) · [tombii/better-ccflare](https://github.com/tombii/better-ccflare) · [matt1398/claude-devtools](https://github.com/matt1398/claude-devtools) · [daaain/claude-code-log](https://github.com/daaain/claude-code-log) · [chiphuyen/sniffly](https://github.com/chiphuyen/sniffly) · [democra-ai/claude-workflow-viz](https://github.com/democra-ai/claude-workflow-viz) · [patoles/agent-flow](https://github.com/patoles/agent-flow) · [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) · [Owloops/claude-powerline](https://github.com/Owloops/claude-powerline) · [Grafana dashboard 25255](https://grafana.com/grafana/dashboards/25255-claude-code-metrics-prometheus/) · [ColeMurray/claude-code-otel](https://github.com/ColeMurray/claude-code-otel)

**Other vendors** — [Antigravity permissions](https://antigravity.google/docs/permissions) · [Antigravity Walkthrough](https://antigravity.google/docs/ide/walkthrough) · [Jules review plan](https://jules.google/docs/review-plan/) · [Gemini CLI rewind](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/rewind.md) · [Cursor 3.0](https://cursor.com/changelog/3-0) · [Codex environments/modes](https://learn.chatgpt.com/docs/environments/modes.md) · [Zed Parallel Agents](https://zed.dev/blog/parallel-agents) · [Agent Client Protocol](https://agentclientprotocol.com/overview/introduction) · [VS Code Agents window](https://code.visualstudio.com/docs/agents/agents-window)

**Chat shells** — [Open WebUI features](https://docs.openwebui.com/features/) · [LibreChat 2026 roadmap](https://www.librechat.ai/blog/2026-02-18_2026_roadmap) · [Msty Studio features](https://msty.ai/studio/features) · [Jan changelog](https://www.jan.ai/changelog) · [MCP Apps announcement](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)

---

### Confidence notes

- Anthropic docs findings (statusline fields, hook events, OTel schema, `claude agents` behavior) are first-hand from primary docs — high confidence.
- Star counts and release dates for third-party tools are as of 2026-07-27; GitHub's API was unreachable during research, so maintenance verdicts rest on release dates and explicit project statements, not commit logs.
- `nimbalyst.com` dominates organic search for this topic and ranks itself #1 in its own listicles. Its comparative claims are treated as vendor marketing; its own repo facts were verified independently.
- JetBrains Air and VS Code Multi-Agent Mode details are single-sourced from vendor-competitor content — treat as unconfirmed.
- The dynamic-workflow on-disk path (`workflows/wf_<id>.json`) comes from claude-workflow-viz, a 4-star project reading a research-preview format. Verify before building on it.
