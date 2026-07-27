# Aether OS

A mission-control desktop dashboard for working with Claude Code — reactor core, live agent
tracking, orchestration grid, and a chat deck where the mission-control intelligence (AETHER)
and every agent are real Claude-backed personas.

One honest line up front: **this started as a simulation and has been migrated to live data.**
The original build ran on fictitious information by design — a deterministic tick fed synthetic
agents, token burn, and log noise so every view could be built and tested against predictable
state. That scaffolding has since been replaced, phase by phase, with the real thing: the app
now runs as an Electron desktop tool that tracks actual Claude Code sessions. The reactor's
pulse is your real token burn rate and dispatch concurrency; the terminal is a real `claude`
CLI session; the agent roster shows genuinely-running subagent dispatches. The remaining sim
pieces exist only where noted, and `PROGRESS.md` tracks exactly which is which.

## What's built

- **Terminal** — a real Claude Code CLI session on node-pty + xterm, replacing the original
  scripted simulation. The reactor core (three renderers: NEBULA / VOLUMETRIC / WARP on
  layered 2D/WebGL canvases) lives in the sidebar with a live TOK/MIN readout, its pulse and
  overload glow driven by real burn rate and real dispatch concurrency.
- **Dashboard** — session tokens, budget remaining, and depletion ETA computed from your
  actual Claude Code usage, rescanned periodically; alerts and systems cells on a single view
  registry.
- **Agents / Grid / Analytics** — real currently-open `Agent`-tool subagent dispatches,
  tracked live and rendered as the roster, the radial hub-and-spoke map, and the analytics
  views.
- **Memory** — dispatch completions auto-captured as memories with per-tick strength decay
  and pinning; the live event feed replaced the original random log pool with real event
  kinds.
- **Chat** — a channel per agent plus AETHER, with real Claude replies via a server-side
  proxy (API key never touches the renderer), per-persona voices, and post-mortem channels
  for completed dispatches. Replies can carry a trailing action-JSON convention: safe verbs
  execute immediately, risky verbs route through the approval queue under a risk policy, and
  the resolution posts back into the requesting channel.
- Every remaining nav tab (Projects, Files/attachments, Uplinks, Settings, and friends) is a
  built view — no "coming soon" panels left.
- **Instrument + Alarm** — a real anomaly-detection pipeline (re-read loops, write-delete-rewrite
  cycles, high burn with zero edits, stalled permission prompts) surfaces as warning rings on
  Grid nodes and an amber reactor flicker; the reactor itself doubles as an instrument — model
  hue, cache-hit clarity, and concurrency turbulence are real signals, not decoration.
- **Alert Sounds** — the budget alarm and anomaly detector are audible: a synthesized (no
  external audio asset) yellow-alert chirp on elevated burn, a looping red-alert klaxon at the
  burn ceiling, and a soft chime on a new anomaly, all toggleable in Settings with a TEST SOUND
  preview.
- **Full light/dark theming** — every view, including the terminal's own xterm.js color theme,
  now re-themes live via the Settings toggle. Grid and the reactor's WebGL/canvas rendering are
  the one deliberate exception (visual signal, not theme surface).

Packaging, installers, and a team fleet view are deliberately out of scope: this is a
personal cockpit, not a distributed product. Its team-facing sibling is
[TokenMonitor](https://github.com/mwgrant21/TokenMonitor), which this project evolves.

## The design decision worth reading about

Each chat channel gets a deliberately scoped snapshot of the world (`src/components/chat/systemPrompt.ts`):
AETHER sees the full fleet — roster, approvals, projects, burn, recent events — while an
individual agent sees only its own task, files, and a thin fleet summary. Tests verify an agent
channel can never leak the roster, the approval queue, or the project list. Least-privilege
context for LLM personas: it started as fiction-accurate flavor and turned out to be a real
agent-platform architecture pattern.

## Running it

```bash
npm install
npm run electron:dev   # the real thing: desktop app, live terminal, real session tracking
npm run dev            # browser-only mode at http://localhost:5173 (no PTY / live tracking)
```

Real Claude replies in Chat: copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`.
Without a key, the offline responder answers in-world instead; nothing breaks. The key is read
server-side only and `.env` is gitignored.

```bash
npm test               # vitest — reducer, tick, view math, personas, prompt scoping,
                       # action parsing/execution, proxy validation, anomaly detection,
                       # alert-sound decision logic (951 tests at last count)
npm run build          # tsc -b && vite build
```

The frame is a fixed 1536×1024 canvas by design — a faithful port of the original design
handoff — but it scales to fit the actual viewport (`useViewportScale`/`computeFrameScale`),
so it's no longer a fixed-size-only window.

## How this is being built

The UI was designed in Claude Designer; implementation is Claude Code working through phased
plan documents in `docs/superpowers/plans/`, one fresh implementer and one fresh reviewer
subagent per task, a whole-branch review after each plan, and `PROGRESS.md` as the honest
running state — including known issues and genuinely-blocked items, not just wins. The
sim-to-live migration itself was phased the same way: Electron scaffold, real terminal, real
usage data, real agent tracking, real live output, live reactor load. Product decisions,
architecture direction, and acceptance criteria are mine; the keystrokes mostly are not. I can
explain why each piece exists, how it's meant to behave, and how it was validated; for
line-level detail, the plans and commit history are the record.

## Tech

React 18 · Vite 5 · TypeScript (strict) · Electron (electron-vite) · node-pty · xterm ·
Vitest — no CSS framework, no state library, no canvas library. The single `useReducer` store
and hand-rolled canvas renderers are the point.
