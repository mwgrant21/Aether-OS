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

Real Claude replies in Chat need `ANTHROPIC_API_KEY`: copy `.env.example` to `.env`.
Without a key, an offline in-world responder answers instead — nothing breaks.
The key is read server-side only, and real replies work in both the Electron app and browser
dev mode. In the Electron app, `askClaude()` (`src/components/chat/claudeClient.ts`) calls
`chat:send` over IPC to the main process, which loads `.env` (`electron/loadDotEnv.ts`) and
runs the request through `src/shared/chatCore.ts` (`electron/main.ts`'s `runChatRequest`). In
browser mode (`npm run dev`, no `window.aetherElectron`), `askClaude()` falls back to POSTing
the Vite dev-server plugin's `/api/chat` route (`vite-plugins/chatProxyPlugin.ts`). Stage 0.5
(`docs/superpowers/plans/2026-07-27-chat-ipc-correctness.md`) shipped this IPC path — see
`ChatBackendCard.tsx` (Settings) and the chat header chip for a live Live/Offline/Browser
indicator of which backend is actually answering. `.env` is gitignored.

## Architecture map

```
src/
  components/    React views, one directory per nav tab (agents/, analytics/, chat/,
                 dashboard/, files/, grid/, layout/, memory/, projects/, reactor/,
                 settings/, terminal/, uplinks/) plus components/shared/ for the
                 cross-cutting primitives (Button, useColors, useHoverStyle).
  shared/        PURE logic, unit-tested, imported by both main and renderer:
                 alertSounds.ts (decideAlertActions + Web Audio synthesis),
                 anomalyDetectors.ts (the 4 anomaly detectors), chatActionResult.ts.
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

- **Nothing leaves this machine** except Chat's scoped context snapshot to the Anthropic Messages
  API, which requires a key the user supplies. Without a key, nothing leaves at all.
- **No telemetry, ever.** Not opt-out, not anonymous, not aggregate.
- **No network listener.** Hook ingest is an append-only file spool
  (`~/.aether-os/spool/`), never a loopback HTTP server — no port, no token, no auth surface, and
  a file append cannot hang a real Claude Code session the way a POST to a dead listener can.
- **Store the signal, not the payload.** Derive what the detectors need at ingest and discard the
  raw: **no source code, no command strings, no tool outputs, no prompts** in the store. Every
  detector and optimize rule has been checked against this and none of them need content.
- **Paths are the remaining sensitive surface** — store project-relative, display basenames only.
- **Retention is a privacy control**, not a disk concern. Aggregates survive, event rows age out,
  and Settings exposes store size plus a real Purge action.
- `systemPrompt.ts`'s scoped snapshots are a privacy control, not just an architecture pattern:
  any new field added to a chat snapshot is a decision about what gets transmitted. Keep the
  leak tests current when the snapshot shape changes.

Single-user also **deletes** a lot of scope permanently: no auth model, no multi-tenant schema, no
shared folder or report writing, no roll-up, no sharing links, no cloud sync. TokenMonitor is the
fleet product and writes per-seat reports to a shared folder by design; Aether OS has no equivalent
and should never grow one.

## Gotchas

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
