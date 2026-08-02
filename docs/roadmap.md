# Aether OS — Multi-Stage Roadmap

**Date:** 2026-07-27 (amended)
**Companions:** `docs/competitive-gap-analysis-2026-07.md` (research), `docs/diagnostic-thesis-plan.md` (thesis)
**In flight:** `docs/superpowers/plans/2026-07-26-optimize-panel.md` is Stage 0. Nothing here touches it.

---

## 1. The architectural problem that reorders everything

Hooks fire when `claude` runs. **`claude` runs whether or not Aether OS is open.**

If the hook receiver lives inside the Electron main process, every event fired while the app is
closed is lost forever — hooks are push-only, with no replay. That makes a naive migration from
JSONL polling to hooks a *coverage regression*: transcripts sit on disk and can be scanned later;
hook events cannot.

This is the single most important design constraint in the whole roadmap, and it points at one
answer: **split the app into an always-on collector and a viewer.**

```
  ┌─────────────────────────────────────────┐
  │  aether-collector  (headless, always-on) │
  │   · spool watcher  ← hook-emit script    │
  │   · statusline payload watcher           │
  │   · claude agents --json poller          │
  │   · writes → SQLite                      │
  └────────────────┬────────────────────────┘
                   │  file spool + SQLite (language-agnostic contract)
  ┌────────────────▼────────────────────────┐
  │  Aether OS  (Electron viewer)            │
  │   · queries the store, renders           │
  │   · owns the pty and all UI              │
  └─────────────────────────────────────────┘
```

**What the split buys, beyond fixing hook coverage:** the SQLite history store flagged as missing
in the gap analysis; instant startup with no 60-second scan; a viewer that becomes a pure consumer
with all the polling, byte-0 replay and re-entrancy machinery gone; and a headless process that is
genuinely integration-testable in a way an Electron window is not.

**What it costs:** a second process to install, start, upgrade and reason about — plus the
cross-cutting concerns in §4, which are not optional.

---

## 2. The language question — answered

**Rewriting the app in Rust/Tauri would buy almost nothing.** The renderer stays TypeScript in a
webview either way; xterm.js stays JavaScript. What changes is the shell. Against that you'd
rewrite every Electron main-process module, lose electron-builder, and discard the AppContainer ACL
knowledge documented in CLAUDE.md — a large, high-risk rewrite to improve a metric nobody is
complaining about.

**The collector is the one place a language choice is defensible** — small, no UI, idles permanently.

| | Idle RAM | Build story on this box | Reuses existing code |
|---|---|---|---|
| **Node** (`node:sqlite`, RC since v25.7) | ~40–60MB | Zero new toolchain, **no native deps** | ✅ TS parsers port verbatim |
| **Go** (`modernc.org/sqlite`, pure Go, no CGO) | ~10MB static `.exe` | Single download, no C toolchain | ❌ Reimplement parsing |
| **Rust** (`rusqlite`, `axum`) | ~5–10MB | Fine — MSVC installed 2026-07-27 | ❌ Reimplement parsing |

**Recommendation: Node first, behind a deliberately language-agnostic contract** (HTTP in, SQLite
out, no shared runtime types across the boundary). Then swap to Go as optional Stage 10 if idle
footprint ever matters. That sequencing is also the better story — *"I split it behind a
language-agnostic contract, then swapped the implementation for a 5× memory reduction without
touching the UI"* proves the contract was real rather than aspirational.

**Why Node, restated on merit (revised 2026-07-27).** This table previously rejected Rust on
toolchain grounds — *"⚠️ Needs MSVC. CLAUDE.md documents 'no VS Build Tools on the dev box'"* —
and closed with *"Rust is the wrong call here on toolchain grounds, not merit."* Two problems with
that, both now fixed. The citation was dangling: CLAUDE.md never contained the claim. And MSVC is
now installed, so the constraint is gone regardless.

The conclusion survives, but it has to stand on the last column instead. `transcriptParser.ts` and
`liveAgentTracker.ts` are the collector's actual substance — the parsing, the dispatch lifecycle,
the anomaly inputs — and in Node they move across unchanged, already covered by the existing
vitest suite. Rust and Go both mean reimplementing that from scratch and re-earning the test
coverage, to save ~35MB of idle RAM in a process that runs on one desktop. That is the argument;
the toolchain line was never more than a convenient tiebreak wearing the clothes of a reason.

Go remains the sensible Stage 10 swap if footprint ever genuinely matters — it never depended on
the MSVC constraint, and the whole point of the language-agnostic contract is that the swap stays
cheap.

*General lesson worth keeping: a decision justified by an environmental constraint has no defence
the day the constraint lifts. When a constraint is doing the arguing, write down the merit case
underneath it too.*

---

## 3. The stages

Each stage is one plan doc in `docs/superpowers/plans/`, executed with the existing
implementer + reviewer + whole-branch-review loop.

| # | Stage | Why | Size |
|---|---|---|---|
| **0** | Optimize panel port | *In flight.* Untouched by this roadmap. | 9 tasks |
| **0.5** | **Correctness & hygiene** | **A confirmed live defect in a shipped feature, plus two hygiene items.** Jumps the queue — see §3.1. | ~5 tasks |
| **1** | **Statusline feed** | Independent, no architecture change, retires the last fictional KPI. Best value-to-effort. Planned: `2026-07-27-statusline-feed.md`. | ~7 tasks |
| **2** | **Collector foundation** | **Status: shipped** — see `docs/superpowers/plans/2026-07-27-collector-foundation.md`. Headless Node process: append-only file spool + spool watcher (not an HTTP receiver — see §3 of `docs/privacy-and-data.md`), SQLite schema, hook installer. **Aether OS unchanged.** Must carry the §4 constraints in scope. | ~10 tasks |
| **3** | **Viewer reads the store** | **Status: shipped** — see `docs/superpowers/plans/2026-07-27-viewer-reads-the-store.md`. Retires the 60s dashboard usage scan (falls back to it only when the collector hasn't run yet, isn't installed, or predates this schema). **The 1s live-agent-dispatch tick and anomaly detection were explicitly deferred, not shipped by this stage** — `liveAgentTracker`'s tracking depends on `notifyPtySpawned`, a signal only Electron's own pty-spawning main process can produce; a headless collector has no pty and no equivalent signal, so this is pushed to Stage 4, which already has to solve "which session is active" for the fleet/session picker. See this plan's own header for the full reasoning. | ~7 tasks |
| **4** | **Fleet + session picker** | **Status: shipped** — see `docs/superpowers/plans/2026-07-28-fleet-session-picker.md`. `claude agents --json` polled by the collector, a read-only fleet card in the viewer's Agents tab. Shipped as a **read-only fleet browser only**: no session control (start/stop/kill/attach/respawn), no `--all`/completed-session history, and no redirect of the app's own live tracking (Dashboard/Agents/Grid/Reactor/anomaly detection still track only Aether's own terminal session) — see `docs/superpowers/specs/2026-07-28-fleet-session-picker-design.md`'s "Out of scope" section for the full list. Stage 3's deferred "which session is active" question for the headless collector's own future live-tick/anomaly work is **not** resolved by this stage either — still open for a later one. **This stage does not retire this row's original "false-completion-bug" justification** — that heuristic was already replaced by session-file pinning in `8e0e9d4` (2026-07-24), three days before this roadmap doc was even written; see the design spec's "Context" section for the full correction. | ~5 tasks |
| **5** | **Diagnostic core** | **Status: shipped** — see `docs/superpowers/plans/2026-07-28-diagnostic-core.md`. Persisted anomaly log, real per-dispatch file touches, dispatch timeline card, cost-of-thrash feeding Optimize. **The thesis.** **Live screenshot/GIF portfolio artifacts (this stage's own closing task, roadmap §5) are explicitly deferred, not captured** — this development environment is headless, with no display to launch `npm run electron:dev` against and no way to generate real diagnostic data through a live session, the same constraint Stage 4 already hit and documented (see that row's item (d)). | ~9 tasks |
| **6** | **Closing the loop** | **Status: shipped** — see `docs/superpowers/plans/2026-07-28-closing-the-loop.md`. `PermissionRequest` approvals replacing the simulation, editable scope via `updatedInput`, `PostToolUse` block-with-reason. Ships a real, session-scoped approval console for Aether's own Claude Code session: a local HTTP server in Electron's main process brokers `PermissionRequest` (editable, per-tool-aware scope field) and anomaly-triggered `PostToolUse` flag-and-block review, reusing Stage 5's anomaly detectors via `liveAgentTracker.tick()` with zero added latency on clean tool calls. **Deferred, named plainly:** fleet-wide approval control (out of scope per the design spec — this is Aether's own session only, not other sessions on the machine); auto-approve by risk tier (this stage only added tool-based risk-tier *styling* on the approval cards — no automated auto-approve behavior); and live screenshot/GIF portfolio artifacts — this development environment is headless, with no display to launch `npm run electron:dev` against and no way to trigger a real `PermissionRequest`/`PostToolUse` hook without a live Claude Code session driving Aether's own pty, the same constraint Stage 4 and Stage 5 already hit and documented. | ~9 tasks |
| **7** | **Presentation & handoff** | **Status: shipped** — see `docs/superpowers/plans/2026-07-29-presentation-handoff.md`. The `claude agents` teardown lessons, which had no home in the first draft of this roadmap — see §3.2. Ships `Notification`-hook-driven presence (badge/flash, suppressed while focused) with typed-reason sounds, an in-memory "since you last looked" recap banner, Haiku-written status headlines with a blocked-vs-periodic throttle split, `AgentRosterCard` grouped under NEEDS INPUT/WORKING/DONE with a two-axis glyph, and a global Normal/Verbose/Summary transcript density control. **Two deliberate scope simplifications, named plainly, not silently dropped:** the overlay badge (`electron/notificationBadge.ts`) is a fixed presence dot/ring, not a rendered digit count — an accurate count needs either a native `canvas` dependency or a hand-rolled bitmap font, judged out of proportion to the value for a personal-cockpit app; and the `blocked`-trigger headline call applies to the most-recently-started currently-open dispatch rather than a specific one, because the real `Notification` hook payload carries no per-dispatch correlating ID (`{ session_id, notification_type }` only — verified against three independent sources in this codebase, not guessed). | ~8 tasks |
| **8** | **Reactor redesign** | **Status: shipped** — see `docs/superpowers/plans/2026-07-30-reactor-redesign-stage8.md`. Derivative-not-level encoding, three nameable axes, real rate-limit denominator. | ~5 tasks |
| **9** | **Hardening** | **Status: shipped** — see `docs/superpowers/plans/2026-07-30-hardening-stage9.md`. Playwright `_electron` e2e (retires the recurring "verification deferred to the user"), keyboard nav, `prefersReducedMotion`. | ~6 tasks |
| **10** | **Go collector** | **Status: shipped** — see `docs/superpowers/plans/2026-07-30-go-collector-stage10.md`. Drop-in swap behind the Stage 2 contract, coexisting with the Node collector; cutover/retirement is a separate, later decision. | ~6 tasks |
| **10.5** | **Spec commit & link repair** | **Status: shipped.** Task 1 (commit `AGENT_PERSONALITY_LAYER_1.md`) shipped 2026-07-30. Tasks 2-3 (commit `AETHER_MEMORY_LAYER_2.md`, move the Phase A store into `collector/src/`, repair the remaining dead link) shipped 2026-07-31 — the Layer 2 spec is committed and its Phase A store (`memoryStore.ts`) lives in `collector/src/`, not on another machine. Both links now resolve. | ~3 tasks |
| **11** | **Narration spine** | **Status: shipped** — see `docs/superpowers/plans/2026-07-31-narration-spine-stage11.md`. Layer 1 Phase 0, mapped onto real dispatch data (Aether observes, it doesn't orchestrate). Schema v5 adds seven new columns to `dispatches`: `task_kind`, `agent_id`, `session_id`, `retries`, `exit_state`, `severity`, `median_ms_at_eval`; `AgentEnvelope`, `ExitState`, and `Severity` types ported from `AGENT_PERSONALITY_LAYER_1.md` into `collector/src/personalitySpine.ts`; subagent type and session ID captured at dispatch-open time; real dispatch completions now populate all columns via `computeSeverity()`; a stale-dispatch sweep detects Agent dispatches never completing and marks them `exit_state='fatal'`; telemetry persisted keyed by `(agent_id, task_kind)` for future baseline queries; end-to-end integration test. **Ships zero visible change** — no voice, no UI, nothing in the chat deck, zero `electron/`/`src/` files touched. **Named limitation:** fatal-via-staleness detection does not survive a collector restart — a dispatch hanging when the collector restarts is never swept and silently never gets a `dispatches` row. | 7 tasks |
| **11.5** | **Model policy** | **A shipped feature running a top-tier model nobody chose, plus no mechanism preventing the next one.** `CHAT_MODEL = 'claude-opus-4-8'` was typed once and never revisited; `headlineGenerator.ts` declares its own constant in a second file with a second convention. Replaces per-feature model literals with a single policy module features query by *tier*, an allowlist test that fails on any unapproved model, and a `Local`/`API`/`Off` policy governing every call site. Jumps ahead of Stage 12, which would otherwise add a third call site under the same defect — see §3.4. | ~7 tasks |
| **12** | **Voice packs & render** | **Layer 1 Phase 1.** Voice packs as data files, lazy narration generated in the viewer, verbosity dial with a severity floor, runtime-prepended frozen phrases, interruption-budget mechanism, attention hook. `personas.ts` is untouched — coexists, does not get folded in; see spec §5.10. The visible half. Planned: `2026-07-31-voice-packs-stage12.md`. | ~9 tasks |
| **13** | **Memory Layer 2** | **Status: shipped** — see `docs/superpowers/specs/AETHER_MEMORY_LAYER_2.md`. Phase A (the atom store, `collector/src/memoryStore.ts`, 50+ tests) through Phase D (the surface) all shipped: `prompt-safety` fencing and the extractor call path (`memoryExtract.ts`), real dispatch-completion wiring (`memoryExtractQueue.ts`, threaded into `transcriptScan.ts`/`index.ts`), `scorePrivateCandidate` private-retrieval ranking, and the Memory view rework (`electron/memoryStore.ts` read-only reader, scope filter, tombstone view). **Retires `MemoryStub`** — all six real construction sites removed, including `tick.ts`'s decay tick and `SystemsCard.tsx`'s Pinned stat, both caught during implementation. **Phase E (weight/half-life tuning) is parked** — needs real extraction traffic that doesn't exist yet on this machine; nothing to build until the collector has run for real over time. | ~10 tasks |

### 3.1 — Stage 0.5, and why it jumps the queue

**Status: shipped.** The defect below is described in the present tense because that's how it
was found; `docs/superpowers/plans/2026-07-27-chat-ipc-correctness.md` closed it — the
Electron main process now handles `chat:send` over IPC and loads `.env` itself, so real Claude
replies work in the desktop app, not only in `npm run dev` browser mode. Left here as the
historical record of why this stage jumped the queue.

**`POST /api/chat` does not exist in the Electron app.** `chatProxyPlugin` is registered only in
`vite.config.ts`; `electron.vite.config.ts`'s renderer plugins array is `[react()]`. So in
`npm run electron:dev` and in any packaged build, the fetch 404s, `askClaude()` honours its
null-on-failure contract, and Chat silently falls back to `localResponder`. Real Claude replies work
**only** in `npm run dev` browser mode.

The failure mode is what makes this urgent: the fallback is *designed* to be invisible, and the
README says *"Without a key, the offline responder answers in-world instead; nothing breaks"* — so a
desktop user sees in-world answers and concludes their key isn't set. This is the "looks alive,
isn't" class that the IDLE badge and the `logs` persistence exclusion exist to prevent, sitting in a
headline feature.

There is a **second half** to the same bug: `vite.config.ts` does the `.env` loading via `loadEnv`.
The Electron main process has no Vite, so `process.env.ANTHROPIC_API_KEY` will not resolve from
`.env` there even once an endpoint exists. Both halves need fixing together.

Stage 0.5 also carries two hygiene items:

- **No LICENSE file.** For a repo shown to employers, absent means "you may not use this" by
  default. Thirty-second fix, real consequence.
- **The persistence whitelist is a hand-maintained 22-key object literal**, and PROGRESS.md
  documents three separate past misses (`state.selected`; `projects`/`providers`/`routeDefault`;
  `memSeq` causing ID collisions). That's a *recurring bug class* being patched one instance at a
  time. A round-trip test that fails on any state key which is neither persisted nor on an explicit
  documented-exclusions list closes it permanently — the same shape as the `usageTokens()`
  regression test, encoding *why* rather than *what*.

### 3.2 — Stage 7, and what the first draft dropped

The `claude agents` teardown produced a set of transferable design lessons that the first version of
this roadmap silently omitted. Stage 8 covers the reactor; nothing covered the fleet presentation.
Stage 7 is that:

- **The "since you last looked" recap.** The biggest acknowledged gap across every vendor — only
  Antigravity's Walkthrough is purpose-built for it, and their notifications are the thinnest of
  anyone's. Aether OS is literally an app you leave open while away, already passively recording.
  Dispatches completed, anomalies fired and cleared, tokens burned, window % consumed — all since
  last focus.
- **Out-of-app presence.** `setOverlayIcon()` count badge and `flashFrame()` on Windows. Currently
  zero presence outside the app's own window.
- **Presence suppression.** Don't klaxon when the window is focused — the line between polished and
  annoying. Anthropic's equivalent is `CLAUDE_CLIENT_PRESENCE_FILE`.
- **Sound extension.** The `Notification` hook carries typed reasons (`agent_needs_input`,
  `agent_completed`, `permission_prompt`); the synthesis layer already exists.
- **Model-written status headlines.** A Haiku-class classifier rewriting each roster row's summary,
  and for a blocked dispatch making the summary *be the question*. Rated the highest-leverage single
  idea in the first-party survey. Note the real cost shape: while working, the summary comes from
  the session's own output with **no model request** (max once per 15s); only end-of-turn and
  periodic rewrites are actual requests.
- **Roster discipline:** group by state; two-axis glyphs (colour = state, shape = process liveness,
  ring = anomaly); no redundant pixels (if the group header says it, the row doesn't); and explicit
  survival rules under space pressure — in a fixed 1536×1024 frame, **anomalous dispatches always
  stay visible**.
- **Transcript density control** (Normal / Verbose / Summary). Universal vendor convergence.

### 3.3 — Stages 10.5–13, and why the personality layer splits in two

The Agent Personality Layer (Layer 1) and Agent Memory Layer (Layer 2) had no stage in this
roadmap at all until now, despite being the most developed design work in the project — Layer 1
at rev 3.1, Layer 2 at rev 1.1, with Layer 2's Phase A store written, `tsc --strict` clean, and
50 tests green. PROGRESS.md's own entry said so plainly ("`docs/roadmap.md` has no stage for any
of this yet"). These four rows close that.

**Status: shipped.** The state below is described in the present tense because that's how it
was found; Stage 10.5 closed it 2026-07-31 — both specs are committed, the Phase A store lives
in `collector/src/`, and both links resolve. Left here as the historical record of why this
stage jumped the queue.

**Stage 10.5 jumps the queue, and the reason is not cosmetic.** PROGRESS.md links to
`docs/superpowers/specs/AGENT_PERSONALITY_LAYER_1.md` and
`docs/superpowers/specs/AETHER_MEMORY_LAYER_2.md`. Neither file exists in this repo, and
`git log --all --diff-filter=A` confirms neither was ever added. `projects/aether-layer2-phase-a/`
is deliberately outside the repo per that entry's item (g), which is disclosed — but combined with
the two dead links it means **every artifact of Layer 1 and Layer 2 exists only on one machine**,
and what is version-controlled is a summary pointing at nothing. This is the same class as Stage
0.5's missing LICENSE: a thirty-second fix with a real consequence, made worse here because the
entry it belongs to is the strongest single piece of design work in the repo and the README does
not mention the layer at all. Stage 10.5 commits both specs, repairs the links, tracks the Phase A
store, and adds the README reference.

**Pass 2 placement follows §1's logic, not convenience.** Severity is computed by the collector
from telemetry it already owns (`elapsed_ms`, `retries`, `exit`) and persisted — no model call, and
it survives the viewer being closed, so the signal has the same always-on durability as every other
collector-owned fact. Narration is generated **lazily in the viewer, on read**. The alternative —
narrating at run time in the collector — costs a model call for every agent run whether or not
anyone ever opens it, which is the wrong shape for a personal cockpit. The split falls out cleanly:
**the signal is infrastructure, the voice is a render-time luxury.** Neither half is where it is by
default; both were placed against §1's coverage-regression rule.

**The layer splits into 11 and 12 because the spine is invisible and the voice is not.** Stage 11
ships nothing a user can see — no narration string reaches the chat deck. That is uncomfortable to
review and exactly why it should be its own stage: the two structural decisions it encodes (the
two-pass split, and severity-computed-never-self-reported) carry the entire design and were both
bugs in the first draft. Bundling them with voice packs means reviewing a circular-dependency fix
and a set of prose registers in the same diff. Stage 12 is then almost entirely data files and
render code, which is a genuinely different review.

**Stage 12's `personas.ts` question is now resolved, not just named.** `src/components/chat/personas.ts`
is a live, shipped, tested system — 11 hand-authored voices plus `FALLBACK_PERSONA`, resolved by
`resolvePersona(agentName)` and injected into each channel's system prompt by `systemPrompt.ts`.
It is the architecture Layer 1 rejects on its own terms: flat `voice: string` **in the system
prompt**, so voice is in context while work is generated; no severity, no escalation curve, no
telemetry coupling; and keyed on `Agent.name`, which that file's own header comment concedes is
the only stable per-agent identifier and which a user can change with `spawn <name>`. Voice packs
key on role instead. Those do not line up, and the decision was: **coexist, deliberately, not a
gap to close.** Chat's voice has to sit in the same call as the reply — there is no terminal
telemetry to narrate from until after the reply the user is waiting on already exists, so P1's
two-pass split does not fit that job at all, and forcing it on would mean either latency the user
feels on every message or a P1 exemption on the one surface where it would be noticed fastest.
Talking to the user in a chat channel and reporting fleet state through cadence are different
jobs with different constraints, not one job accidentally built twice. Recorded as §5.10 and
closed in §12 of the spec (revision 3) — Stage 12 builds voice packs only, `personas.ts` untouched.

**Stage 13 depends on Stage 11 for one type — the ordering held, and so did the reuse, as of
2026-08-02.** Layer 2's `revision` and `overrule` private memory kinds were meant to consume the
`Revision{finding_id, cause, detail}` object the spine introduces, so that landing Layer 2 first
wouldn't mean defining a placeholder and reworking it later. The sequencing avoided that
*placeholder-and-rework* failure mode as designed. It initially failed to avoid a second one on
the way there: `collector/src/memoryStore.ts:56` declared its own `RevisionCause` union while
`collector/src/personalitySpine.ts:61` declared the identical union inline on `Revision.cause`,
with zero cross-reference — independent duplication of one fact, arrived at by a different path
than a placeholder would have, but the same *two declarations of one fact* outcome this paragraph
exists to flag. **Closed, not just recorded:** `personalitySpine.ts` now imports `RevisionCause`
from `memoryStore.ts` rather than restating it (`personalitySpine.ts:15-18`) — one declaration,
verified via `tsc -b` clean and the full collector suite green. The Phase A drop-in itself was
independent — it was one deletion (its sandbox `schema.ts` stub) — but wasn't worth a stage of
its own, and `MemoryStub`'s retirement happened in the same change that replaced it rather than
leaving two memory systems live.

**Known and unscheduled, named rather than glossed:** Layer 1's Phase 3 calibration items —
rolling per-agent baselines, anomaly thresholds, the interruption-budget interval `N`, the second
round of frozen phrases — have no stage and deliberately should not get one yet. They are tunable
only against observed traffic, which does not exist until Stages 11 and 12 have been running for a
while. Stage 11's telemetry-persistence task is what makes them buildable later; skipping it means
starting the observation window from zero on the day that work begins.

**This is the same blocker as Layer 2's Phase E** (private scoring weights, `recency`/
`staleness_risk` half-lives — `docs/superpowers/specs/AETHER_MEMORY_LAYER_2.md`'s own Phase E),
not a coincidence worth two separate orphaned caveats. Both need the collector to have run for
real, over time, producing real dispatch/extraction rows — a deployment-and-observation gap, not
a coding one. They unblock together the day that traffic exists, from the same underlying
precondition. One entry point for "has the collector run long enough yet," not two.

### 3.4 — Stage 11.5, and the three days the roadmap was wrong

On 2026-07-31 a $24 day landed on the API key named `Aether OS`, and the
conclusion drawn from it was that the live reactor feed was expensive enough to
remove. That conclusion was wrong, and it stood for three days.

The check that settles it is model composition, not key name. Aether's entire
codebase makes model calls from exactly two sites — `chatCore.ts` (Opus 4.8) and
`headlineGenerator.ts` (Haiku 4.5) — verified by grepping `fetch(` /
`new Anthropic` / `messages.create` across `src electron collector
vite-plugins`. `src/components/reactor` and `src/state` make none at all. The
$24 bar is Sonnet 5, which appears nowhere in this repo: it is Claude Code
running in Aether's own pty, inheriting the key from the environment. Aether's
real contribution that day is the two thin bands at the top of the bar.

**Recorded because the near-miss is the point.** A diagnostic instrument built to
attribute token spend misattributed its own, and the wrong answer was one
deletion away from removing the feature the project exists for. The key name was
plausible enough that nobody checked the composition underneath it.

**Status: shipped.** `modelPolicy.ts` now owns every model ID; features request
a tier and cannot name a model; an allowlist test (`modelPolicyEnforcement.test.ts`)
goes red the moment an unapproved one becomes reachable; a `Local`/`API`/`Off`
policy setting (default `Local`) and a self-imposed monthly spend ceiling with
graceful degradation (`modelSpendTracker.ts`) govern every call site.

### Dependency graph

```
0 Optimize (in flight) ──────────────────────────────┐
0.5 Correctness ── (blocks nothing, do first)         │
                                                      │
1 Statusline ──┬────────────────────► 8 Reactor       │
               │                                       │
2 Collector ───┴─► 3 Viewer ─┬─► 4 Fleet ─► 7 Present │
                             │                         │
                             ├─► 5 Diagnostic ◄────────┘  (feeds Optimize)
                             │        │
                             │        └─► 6 Loop
                             │
                             └─► 10 Go swap (optional)

9 Hardening — anytime, ideally before Stage 5 so the timeline card gets e2e coverage

10.5 Spec commit ── (blocks nothing, do first — see §3.3)

2 Collector ──► 11 Narration spine ──┬──► 12 Voice packs & personas
                                      │
                                      └──► 13 Memory Layer 2
```

Stages 1 and 2 are independent and can run in either order. **Stage 0.5 first regardless.**

Stage 11 depends on Stage 2 only for the collector process that owns severity computation and
telemetry persistence; it needs nothing from Stages 3–10. Stages 12 and 13 are independent of each
other and can run in either order once 11 lands. **Stage 10.5 first regardless** — it is three
tasks and it stops the current state, where the repo's best design work is unrecoverable if one
disk fails.

---

## 4. Cross-cutting constraints — must be in Stage 2's scope, not discovered later

> **Governing document:** `docs/privacy-and-data.md`. Aether OS is single-user and local-only;
> nothing about your work leaves the machine except Chat's scoped snapshot to the Anthropic API,
> which requires a key you supply. That constraint is binding on every stage below and already
> reversed one decision here (constraint #7).

1. **Hook failure isolation is a safety requirement.** A hook command that hangs or blocks degrades
   *real Claude Code sessions*, every turn, in actual work. The hook must be fire-and-forget with a
   hard timeout, and must **exit 0 even when the collector is down**. This is the highest-severity
   constraint in the entire roadmap because its blast radius is outside this app.
2. **Data retention is a privacy control**, not a disk-space concern. It is the primary mitigation
   for anything constraint #3 does not prevent. Decide the retention window and compaction job
   **before the schema ships**: aggregate rollups survive, individual event rows age out, and
   Settings gets a visible store size, oldest-retained-row readout, and a real Purge action. If you
   cannot see what is stored and delete it in one click, "local-only" is a claim rather than a
   property.
3. **Privacy: store the signal, not the payload.** Governed by `docs/privacy-and-data.md` §4,
   which is binding on every stage. The collector derives what the detectors need **at ingest** and
   discards the raw: no source code, no command strings, no tool outputs, no prompts. Every detector
   and optimize rule was worked backwards to confirm this is sufficient — including
   `uncapped-bash-output`, whose command string reduces to one boolean and whose output reduces to
   an integer length. ccflare's documented failure mode (an unencrypted SQLite DB holding source and
   in-context secrets) is what happens when a tool stores raw payloads because it might need them
   later.
4. **Contract drift.** The roadmap rests on hook payloads, statusline fields and
   `claude agents --json` — and Anthropic has already changed `total_input_tokens` semantics in
   2.1.132 and `/clear` behaviour in 2.1.211. A canary that asserts known fields exist and logs
   loudly on drift is cheap insurance against silently-wrong numbers, which is the failure mode
   hardest to notice.
5. **Collector/viewer version handshake.** The collector owns the schema and migrations; the viewer
   only reads. Write a version table from day one and have the viewer refuse-with-a-message rather
   than mis-render against an unexpected schema.
6. **Degradation contract.** Aether OS must remain fully usable with **no collector and no hooks
   installed**, falling back to the current scan. Non-negotiable: a reviewer who clones the repo and
   runs `npm run electron:dev` has to see a working app.
7. **Transport: an append-only file spool — NOT a loopback HTTP listener.** *(Reversed 2026-07-27
   on the single-user/no-leak constraint — see `docs/privacy-and-data.md` §3.)* Hooks append one
   JSON line to `~/.aether-os/spool/<session-id>.jsonl`; the collector tails the directory. No
   port, no token, no auth surface. Critically, **a file append cannot hang on a dead collector**,
   so constraint #1 is satisfied structurally rather than by timeout code — and no events are lost
   while the collector is down. The rejected HTTP design would have put a secret in the hook command
   string inside `~/.claude/settings.json`, a file users routinely screenshot and share.
8. **Lifecycle.** A Windows Scheduled Task at logon needs no service wrapper and no admin rights.
   Aether OS should also be able to start the collector on demand if it isn't running.

---

## 5. Portfolio artifacts — currently unscheduled, and they need to be

The roadmap builds the thing but never produces what a reviewer actually looks at.

- **A screenshot in the README.** TokenMonitor has one; Aether has none. Stage 5's dispatch timeline
  was labelled "the portfolio screenshot" and nothing schedules taking it.
- **A short GIF** of the timeline catching a re-read loop and pricing it. That single artifact does
  more work than any individual feature, because it shows the thesis rather than describing it.
- **A written piece.** The `usageTokens()` story, the least-privilege persona scoping pattern, and
  the sim→live migration methodology are each a post. For an AI-company application, a written
  artifact showing how you think travels further than a repo does.

Schedule these as an explicit task at the end of Stage 5 rather than "when it's done."

---

## 6. What this roadmap deliberately does not do

- No git worktrees, diff review, or PR management. Anthropic, Cursor, Conductor and Emdash all ship
  these; building them makes this the 40th-best Conductor.
- No packaging, installers, auto-update, or fleet/team view. Those are TokenMonitor's job.
- No MCP server management, plugin system, or marketplace.
- No rewrite of the renderer, the reducer, the canvas layer, or the Electron shell.
- No native mobile, no cloud sync, no multi-user.
