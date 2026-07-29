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
| **2** | **Collector foundation** | Headless Node process: append-only file spool + spool watcher (not an HTTP receiver — see §3 of `docs/privacy-and-data.md`), SQLite schema, hook installer. **Aether OS unchanged.** Must carry the §4 constraints in scope. | ~10 tasks |
| **3** | **Viewer reads the store** | **Status: shipped** — see `docs/superpowers/plans/2026-07-27-viewer-reads-the-store.md`. Retires the 60s dashboard usage scan (falls back to it only when the collector hasn't run yet, isn't installed, or predates this schema). **The 1s live-agent-dispatch tick and anomaly detection were explicitly deferred, not shipped by this stage** — `liveAgentTracker`'s tracking depends on `notifyPtySpawned`, a signal only Electron's own pty-spawning main process can produce; a headless collector has no pty and no equivalent signal, so this is pushed to Stage 4, which already has to solve "which session is active" for the fleet/session picker. See this plan's own header for the full reasoning. | ~7 tasks |
| **4** | **Fleet + session picker** | **Status: shipped** — see `docs/superpowers/plans/2026-07-28-fleet-session-picker.md`. `claude agents --json` polled by the collector, a read-only fleet card in the viewer's Agents tab. Shipped as a **read-only fleet browser only**: no session control (start/stop/kill/attach/respawn), no `--all`/completed-session history, and no redirect of the app's own live tracking (Dashboard/Agents/Grid/Reactor/anomaly detection still track only Aether's own terminal session) — see `docs/superpowers/specs/2026-07-28-fleet-session-picker-design.md`'s "Out of scope" section for the full list. Stage 3's deferred "which session is active" question for the headless collector's own future live-tick/anomaly work is **not** resolved by this stage either — still open for a later one. **This stage does not retire this row's original "false-completion-bug" justification** — that heuristic was already replaced by session-file pinning in `8e0e9d4` (2026-07-24), three days before this roadmap doc was even written; see the design spec's "Context" section for the full correction. | ~5 tasks |
| **5** | **Diagnostic core** | **Status: shipped** — see `docs/superpowers/plans/2026-07-28-diagnostic-core.md`. Persisted anomaly log, real per-dispatch file touches, dispatch timeline card, cost-of-thrash feeding Optimize. **The thesis.** **Live screenshot/GIF portfolio artifacts (this stage's own closing task, roadmap §5) are explicitly deferred, not captured** — this development environment is headless, with no display to launch `npm run electron:dev` against and no way to generate real diagnostic data through a live session, the same constraint Stage 4 already hit and documented (see that row's item (d)). | ~9 tasks |
| **6** | **Closing the loop** | **Status: shipped** — see `docs/superpowers/plans/2026-07-28-closing-the-loop.md`. `PermissionRequest` approvals replacing the simulation, editable scope via `updatedInput`, `PostToolUse` block-with-reason. Ships a real, session-scoped approval console for Aether's own Claude Code session: a local HTTP server in Electron's main process brokers `PermissionRequest` (editable, per-tool-aware scope field) and anomaly-triggered `PostToolUse` flag-and-block review, reusing Stage 5's anomaly detectors via `liveAgentTracker.tick()` with zero added latency on clean tool calls. **Deferred, named plainly:** fleet-wide approval control (out of scope per the design spec — this is Aether's own session only, not other sessions on the machine); auto-approve by risk tier (this stage only added tool-based risk-tier *styling* on the approval cards — no automated auto-approve behavior); and live screenshot/GIF portfolio artifacts — this development environment is headless, with no display to launch `npm run electron:dev` against and no way to trigger a real `PermissionRequest`/`PostToolUse` hook without a live Claude Code session driving Aether's own pty, the same constraint Stage 4 and Stage 5 already hit and documented. | ~9 tasks |
| **7** | **Presentation & handoff** | The `claude agents` teardown lessons, which had no home in the first draft of this roadmap — see §3.2. | ~8 tasks |
| **8** | **Reactor redesign** | Derivative-not-level encoding, three nameable axes, real rate-limit denominator. Needs Stage 1. | ~5 tasks |
| **9** | **Hardening** | Playwright `_electron` e2e (retires the recurring "verification deferred to the user"), keyboard nav, `prefersReducedMotion`. | ~6 tasks |
| **10** | *(optional)* Go collector | Drop-in swap behind the Stage 2 contract. | ~6 tasks |

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
```

Stages 1 and 2 are independent and can run in either order. **Stage 0.5 first regardless.**

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
