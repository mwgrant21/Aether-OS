# CLAUDE.md — Aether OS

Project memory for Claude Code. This file is auto-loaded at session start when
Claude runs with this repo as its working directory. Keep it current — it is the
fastest way for a fresh session (on any machine) to know what this project is
and how it works. See `README.md` for the user-facing pitch and `PROGRESS.md`
for the detailed, honest running log of what's shipped and what's known-broken.

## What this is

**Aether OS** — a mission-control desktop dashboard for working with Claude Code:
reactor core, live agent tracking, orchestration grid, and a chat deck where the
mission-control persona (AETHER) and every agent are real Claude-backed personas.
It's the personal-cockpit sibling of `TokenMonitor` (team-facing) — same underlying
idea (surface Claude Code activity/spend live), different audience and scope.

It started as a themed simulation (deterministic fake tick, fictitious agents/log
noise) and has been migrated phase-by-phase to real data: real terminal (node-pty +
xterm), real usage/burn tracking, real subagent dispatch tracking, real anomaly
detection, real reactor semantics. `PROGRESS.md`'s "Right now" section is the
authoritative account of exactly which pieces are real vs. still-simulated —
read it before assuming any given view's data source.

Packaging/installer/fleet-view are explicitly out of scope — this is a personal
tool, not a distributed product.

## Run / test / build

```
npm install
npm run electron:dev   # the real thing: desktop app, live terminal, real session tracking
npm run dev            # browser-only mode at http://localhost:5173 (no PTY / live tracking)
npm test                # vitest run — 572 tests at last count
npm run build           # tsc -b && vite build (renderer)
npm run electron:build  # electron-vite build (main + preload + renderer, for the Electron app)
```


## Architecture map

```
src/
  components/    React views, one directory per nav tab (agents/, analytics/, comms/,
                 dashboard/, files/, grid/, layout/, ledger/, memory/, projects/,
                 reactor/, settings/, terminal/, uplinks/) plus components/shared/ for the
                 cross-cutting primitives (Button, useColors, useHoverStyle). comms/
                 (renamed from chat/, Stage 13.5) holds the Comms deck: real
                 transcript rendering, filter parsing, narration through the
                 Stage 12 voice packs, and the frozen-phrase predicates.
  shared/        PURE logic, unit-tested, imported by both main and renderer:
                 alertSounds.ts (decideAlertActions + Web Audio synthesis),
                 anomalyDetectors.ts (the 4 anomaly detectors), chatActionResult.ts,
                 modelPricing.ts (the verified rate table + costForEvent /
                 costBreakdownForEvent), ledgerMath.ts (Stage 15 cost aggregation:
                 sessionLedger, estimateDispatchCost, reconcile, bucketByDay,
                 cacheImpact, buildLedgerSnapshot).
  state/         The single useReducer store — no external state library.
                 store.tsx (AetherStoreProvider/useAetherStore), reducer.ts,
                 types.ts (AetherState shape), initialState.ts, tick.ts (the
                 per-tick pure state transition, incl. alarmLevel derivation),
                 useRealAgentsSync.ts / useAlertSounds.ts (IPC-reactive hooks,
                 mounted bare as wrapper components in App.tsx), persistence.ts.
  styles/        tokens.ts — the ColorPalette interface + `colors` (dark) and
                 `colorsLight` (light) palettes, `fonts`, `radii`, `space`.
                 global.css for keyframes (`blink`, etc.) reused across components.
electron/        Electron main process (Node). IPC handlers, pty, file/OS access.
  main.ts               app entry: window, IPC wiring, per-tick pushes to renderer.
  ptyManager.ts         spawns the real `claude` CLI session via node-pty.
  liveAgentTracker.ts   tails the pinned session transcript; tick() returns
                        open/completed dispatches, activeWork, anomalies,
                        cacheHitRatio — the core of the "live tracking" feature.
  transcriptParser.ts   parseTranscriptLine(): the one place raw JSONL transcript
                        lines become typed TranscriptEvent objects. Both
                        liveAgentTracker.ts and src/state/liveAgentsMath.ts
                        consume this — never re-parse raw lines elsewhere.
  toolCallHistory.ts    ring buffer of closed tool calls, feeds anomaly detection.
  historyScanner.ts / activeSessionFinder.ts   discover/rescan session files.
  attachmentsStore.ts   the local file-attachment library backing Files/Attachments.
  preload.ts            contextBridge → window.aetherElectron.* (frozen; matches
                         TokenMonitor's convention — do not monkey-patch).
docs/superpowers/
  specs/         design specs, one per feature, YYYY-MM-DD-<topic>-design.md.
  plans/         implementation plans consumed by subagent-driven-development,
                 YYYY-MM-DD-<topic>.md. Read a recent one (e.g.
                 2026-07-26-full-light-mode.md) to see the established plan
                 format and task granularity this repo expects.
```

## Key conventions (read before touching UI code)

- **Theming**: every themed component calls `useColors()` (from
  `src/components/shared/useColors.ts`) instead of importing the static `colors`
  object from `tokens.ts` directly. Style functions take `colors: ColorPalette`
  as their first parameter. **Exception**: `Grid`/`Reactor` (`OrchestrationGrid.tsx`,
  `ReactorCore.tsx`, `StormCore.tsx`) are deliberately excluded — their
  visuals are a signal (anomaly rings, burn-rate hue) not a theme surface, and
  `PtyTerminal.tsx`'s xterm.js `Terminal` instance needs its own reactive
  `useEffect` (`sharedTerm.options.theme = {...}`) since it's a module-level
  singleton constructed once outside React's render cycle — see that file's
  comments for why the static `colors` import (renamed `darkColors`) stays there.
- **Interactive elements**: use the `Button` primitive
  (`src/components/shared/Button.tsx`), never a bare `<span onClick>`/`<div onClick>`.
  `Button` strips `undefined`-valued style keys before merging over its
  `RESET_STYLE` — if you write a conditional style like
  `background: on ? 'x' : undefined`, that's exactly the pattern `Button` is
  built to handle safely; do NOT go back to raw elements to avoid it.
- **Hover states**: `useHoverStyle()` — its default (no explicit `hoverStyle`
  passed) is theme-aware (`brightness(1.1)` + `colors.activeBorder`), sourced
  live via `useColors()` inside the hook itself.
- **Persistent "quiet chip" backgrounds** (inactive nav items, tabs, small
  overlays): `colors.panelInset` + `colors.chipBorder`/`colors.chromeBorder` —
  an established pair, not per-component magic rgba values.
- **State**: one `useReducer` store (`src/state/store.tsx`), no Redux/Zustand/etc.
  IPC-driven state (live agents, anomalies, usage) flows in via hooks that
  dispatch actions on IPC events — see `useRealAgentsSync.ts` for the pattern;
  new IPC-reactive features should mirror it, not invent a new subscription style.
  **One deliberate exception**: `src/components/comms/useTranscriptSource.ts`
  (Stage 14) reads real transcript content over a pull-based, request/response
  IPC channel — on mount, on explicit refresh, and, for a live source, re-fetched
  on the existing 1s tick — and holds it only in the view's own React state. It
  never dispatches into the store, because transcript *content* is exactly the
  payload `docs/privacy-and-data.md`'s "store the signal, not the payload" rule
  exists to keep out; see that doc's Stage 14 amendment for the full reasoning.
- **Cost figures (Stage 15, binding)**: exact and estimated dollar amounts are
  **distinct types and must stay that way**. `ExactCost` (`usd`) comes from a
  full input/output/cache token split and is exact to the pricing table;
  `EstimatedCost` (`usdApprox`) comes from a scalar token count with no split
  available. They share no supertype **and no field names** — the differing
  field name is what makes the compiler reject substituting one for the other,
  since TypeScript is structural and a shared `usd` field would let an estimate
  pass silently where an exact figure was expected. Do **not** "simplify" these
  into one type with an `isEstimate` flag: a boolean is checkable only if
  someone remembers to check it, and it would compile cleanly at exactly the
  call site where being wrong matters most. In the UI, an estimated figure
  always carries a `~` and names its basis; an exact one never does. Equally
  binding: a cost bucket with no observed data is `null`, never `0` — see
  `RollupCard`, where "no data" and "$0.00" are deliberately different
  renderings, and `bucketByDay`, whose return type forces the distinction.
- **Model calls**: no model call site exists anywhere in this repo. The
  `@anthropic-ai/sdk` dependency is gone from `package.json`; `chatCore.ts`,
  `claudeClient.ts`, `systemPrompt.ts`, `chatProxyPlugin.ts`, the `chat:*` IPC
  pair, `.env` key loading (`electron/loadDotEnv.ts`), and the `modelPolicy.ts`
  allowlist module have all been deleted (Stage 13.5). `Comms` (the renamed
  `Chat` tab) answers only through `localResponder.ts` — a local, deterministic
  responder, no network request. `src/shared/noApiCalls.test.ts` is the guard:
  it fails the build if `@anthropic-ai/sdk` reappears in `package.json`, if any
  source file imports it or references `api.anthropic.com`, or if a
  `messages.create(` call site reappears. There is no allowlist to consult
  because there is nothing to allow. If a new feature seems to need a model
  call (a "live"-feeling status line, a background summarizer, anything
  ticking on a timer), prefer a deterministic, local formatter instead, the way
  `electron/headlineGenerator.ts`'s `formatHeadline()` replaced the old billed
  Haiku headline rewrite — this is now the only option, not the preference.
  See `docs/roadmap.md` §3.5 for the incident that motivated the teardown and
  its honest limitation: this stage cannot verify or fix the environment-level
  cause of the spend that triggered it.
- **Testing philosophy**: pure logic (reducers, `tick.ts`, `anomalyDetectors.ts`,
  `alertSounds.ts`'s `decideAlertActions`) is exhaustively unit tested. Anything
  requiring a real `AudioContext`, real WebGL/canvas, or actual visual judgment
  (does the reactor pulse look right, does the yellow chirp sound right) is
  explicitly NOT unit tested — verification for those is manual/live-window,
  a deliberate and repeated pattern across every feature shipped so far, not
  an oversight. Don't try to force a jsdom test onto genuinely-visual/audio code.

## Development workflow

Features go through brainstorming → a written design spec
(`docs/superpowers/specs/`) → an implementation plan
(`docs/superpowers/plans/`) → subagent-driven-development execution in an
isolated git worktree (`.worktrees/<branch>/`, gitignored) — one fresh
implementer subagent per task, one fresh reviewer per task, a whole-branch
review before merge. `PROGRESS.md`'s "Shipped plans" section has a detailed
paragraph per feature — read the most recent few entries there for the fullest,
most current picture of what's real, what's still simulated, and what
deliberate scope exclusions exist (Grid/Reactor theming, packaging, etc.).


## Privacy & data model (binding)

**Aether OS is single-user and local-only.** Full stance in `docs/privacy-and-data.md` — read it
before designing anything that persists or transmits data. The short version:

- **Nothing leaves this machine. There is no exception.**
- **No telemetry, ever.** Not opt-out, not anonymous, not aggregate.
- **No externally-reachable listener.** Hook ingest itself is an append-only file spool
  (`~/.aether-os/spool/`), not an HTTP server. Separately, `electron/permissionServer.ts` runs a
  local HTTP server bound to `127.0.0.1` (never `0.0.0.0`) for `PermissionRequest`/`PostToolUse`/
  `Notification` hook brokering — reachable only from this machine, with no port exposed
  externally, no token, and nothing bound off-loopback.
- **Store the signal, not the payload.** Derive what the detectors need at ingest and discard the
  raw: **no source code, no command strings, no tool outputs, no prompts** in the store. Every
  detector and optimize rule has been checked against this and none of them need content.
- **Paths are the remaining sensitive surface** — store project-relative, display basenames only.
- **Retention is a privacy control**, not a disk concern. Aggregates survive, event rows age out,
  and Settings exposes store size plus a real Purge action.
- `systemPrompt.ts` and its scoped-snapshot leak tests were retired in Stage 13.5 along with the
  rest of the model call path — the surface they guarded no longer exists.

Single-user also **deletes** a lot of scope permanently: no auth model, no multi-tenant schema, no
shared folder or report writing, no roll-up, no sharing links, no cloud sync. TokenMonitor is the
fleet product and writes per-seat reports to a shared folder by design; Aether OS has no equivalent
and should never grow one.

## Gotchas

- **Native module toolchain (changed 2026-07-27).** MSVC / VS Build Tools **is
  now installed on this box.** `docs/roadmap.md` §2 previously cited CLAUDE.md
  as documenting the opposite — that citation was always dangling (this file
  never said it) and the underlying fact is now false either way. Both have
  been corrected. What this does and does not change:
  - Native modules (`better-sqlite3`, `node-pty` from source) can now be built
    here. `node-pty` keeps using prebuilds — they work, and a prebuilt path is
    still the lower-maintenance one.
  - **A native module inside Electron still costs an `electron-rebuild` on
    every Electron version bump.** That tax is why the Stage 2 collector, a
    plain Node process, remains the right home for anything SQLite-backed —
    a conclusion that no longer depends on the toolchain at all.
  - `node:sqlite` went **release candidate (stability 1.2) in Node v25.7.0**
    and is still RC as of v26.5 — no longer experimental, no warning on a
    modern Node. Pin the collector to Node 26.
- **node v25** breaks bare-directory `node --test` invocations elsewhere in
  this user's other projects — not directly relevant here since this repo
  uses `vitest`, but worth knowing if debugging cross-project tooling.
- **Vitest test count from a bare-checkout run vs. from inside a worktree**:
  running `npx vitest run` from the main checkout can pick up stray leftover
  `.worktrees/*` directories if any exist and aren't excluded, inflating the
  count. Running from inside a worktree only scans that worktree's own tree.
  Always remove a worktree (`git worktree remove .worktrees/<name>`) as soon
  as its branch is merged — don't leave completed ones lying around.
- **The frame is a fixed 1536×1024 design canvas that scales to fit the
  viewport** (`src/components/layout/useViewportScale.ts` /
  `frameScale.ts`) — it is not a fully responsive reflow, just a uniform
  scale transform. Don't assume arbitrary viewport widths reflow the layout.
