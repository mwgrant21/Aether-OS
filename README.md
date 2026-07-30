# Aether OS

**A diagnostic instrument for Claude Code.** Most tools in this space answer *how much did I
spend*. Aether OS answers a harder question: **is the agent actually working, or is it
thrashing** — and it tells you on an ambient reactor display you notice from across the room,
before you think to look.

It runs as an Electron desktop app: a real `claude` CLI session, live tracking of your actual
Claude Code usage and subagent dispatches, behavioral anomaly detection over that stream, and a
chat deck where the mission-control intelligence (AETHER) and every agent are real Claude-backed
personas.

One honest line up front: **this started as a simulation and has been migrated to live data.**
The original build ran on fictitious information by design — a deterministic tick fed synthetic
agents, token burn, and log noise so every view could be built and tested against predictable
state. That scaffolding has since been replaced, phase by phase, with the real thing. The
reactor's pulse is your real token burn rate and dispatch concurrency; the terminal is a real
`claude` CLI session; the agent roster shows genuinely-running subagent dispatches. The remaining
sim pieces exist only where noted, and `PROGRESS.md` tracks exactly which is which — including
known issues and genuinely-blocked items, not just wins.

![Aether OS Optimize view showing a live cost-of-thrash finding](docs/portfolio-optimize-cost-of-thrash.png)
*Optimize surfacing a genuine "cost of thrash" finding — 428 redundant read/write calls detected
live across real session transcripts, priced at ~$0.64/wk, with a one-click fix. Not mocked data.*

![Optimize catching a real re-read loop and pricing it](docs/portfolio-cost-of-thrash-live.gif)
*The thesis, live: a file re-read three times without a cache hit gets caught, named
(`CLAUDE.md (3x)`), and priced (~$0.27/wk) in real time — the same detector that once only
existed as `anomalyDetectors.ts` unit tests, now visibly catching a real one.*

---

## What makes this different

Four things here you won't find in the other Claude Code dashboards. They're the reason this
repo exists.

### Behavioral anomaly detection, not just cost accounting

`src/shared/anomalyDetectors.ts` watches the live dispatch stream for four failure signatures:

| Detector | Catches |
|---|---|
| `detectReReadLoop` | The agent reading the same file over and over without editing it |
| `detectWriteDeleteRewrite` | Write → delete → rewrite churn on one path |
| `detectZeroEditBurn` | High burn with zero edits to show for it |
| `detectStalledPermission` | A tool call open far past the point it should have closed |

Every usage dashboard in this space tells you what you spent. Almost none tell you the agent is
stuck in a loop *right now*. Detected anomalies raise a dashed warning ring around the offending
node in the Orchestration Grid and drive an amber reactor flicker, independent of the
budget-driven alarm tiers.

*Honest limitation:* `detectStalledPermission` is currently a >60s open-tool-call heuristic and
can false-positive on legitimately slow tools. The fix is planned — see
`docs/diagnostic-thesis-plan.md`.

### Least-privilege context for LLM personas — enforced by tests

Each chat channel gets a deliberately scoped snapshot of the world
(`src/components/chat/systemPrompt.ts`). AETHER sees the full fleet: roster, approvals, projects,
burn, recent events. An individual agent sees **only its own task, files, and a thin fleet
summary**.

Tests verify an agent channel can never leak the roster, the approval queue, or the project list.
Not a convention, not a code comment — a failing test if you break it.

This started as fiction-accurate flavor and turned into a real agent-platform architecture
pattern. Persona systems elsewhere bundle prompt + model + params; none of them scope *what
world-state a persona can observe*, and none of them test the boundary.

### The bug that green tests couldn't see

`usageTokens()` was ported from TokenMonitor summing all four raw usage fields. It reported
~4.82 **billion** tokens a month. Claude Code's own `/usage` said ~54 million.
`cacheReadInputTokens` alone accounted for 4.68 billion.

Thirteen unit tests covered that function. **All thirteen passed**, because every fixture had the
cache fields zeroed — so the suite never once exercised the field that was wrong. It was caught by
checking the number against `/usage` on real data, not by the review pipeline.

The function now sums input + output only, with a regression test that specifically proves cache
tokens are excluded. It's documented here because a test suite that is confidently, unanimously
wrong is a more useful thing to have on record than another green badge — and because ground truth
beats coverage.

### An ambient instrument, not a dashboard you have to be looking at

Three canvas renderers (NEBULA / VOLUMETRIC / WARP, layered 2D and WebGL, hand-rolled — no chart
library) driven by real signals: burn rate, dispatch concurrency, model hue, cache-hit clarity,
concurrency turbulence, anomaly state. Backed by a synthesized alert-sound layer — yellow-alert
chirp on elevated burn, looping red-alert klaxon at the ceiling, soft chime on a new anomaly — all
generated at runtime from Web Audio oscillators, with no external audio assets.

Sound is the correct channel for something you aren't looking at, and as far as I can find, no
other tool in this category has any sound design at all.

---

## What's built

- **Terminal** — a real Claude Code CLI session on node-pty + xterm, replacing the original
  scripted simulation. The reactor core lives in the sidebar with a live TOK/MIN readout, its
  pulse and overload glow driven by real burn rate and real dispatch concurrency.
- **Dashboard** — session tokens, budget remaining, and depletion ETA computed from your actual
  Claude Code usage, rescanned periodically; alerts and systems cells on a single view registry.
- **Agents / Grid / Analytics** — real currently-open `Agent`-tool subagent dispatches, tracked
  live and rendered as the roster, the radial hub-and-spoke map, and the analytics views.
- **Memory** — dispatch completions auto-captured as memories with per-tick strength decay and
  pinning; the live event feed replaced the original random log pool with real event kinds.
- **Chat** — a channel per agent plus AETHER, with real Claude replies via a server-side proxy
  (API key never touches the renderer), scoped system prompts, per-persona voices, and post-mortem
  channels for completed dispatches. Replies can carry a trailing action-JSON convention: safe
  verbs execute immediately, risky verbs route through the approval queue under a risk policy, and
  the resolution posts back into the requesting channel.
- **Instrument + Alarm** — the anomaly-detection pipeline above surfaces as warning rings on Grid
  nodes and an amber reactor flicker; the reactor itself doubles as an instrument — model hue,
  cache-hit clarity, and concurrency turbulence are real signals, not decoration.
- **Alert Sounds** — the budget alarm and anomaly detector are audible: a synthesized (no external
  audio asset) yellow-alert chirp on elevated burn, a looping red-alert klaxon at the burn ceiling,
  and a soft chime on a new anomaly, all toggleable in Settings with a TEST SOUND preview.
- **Full light/dark theming** — every view, including the terminal's own xterm.js color theme,
  re-themes live via the Settings toggle. Grid and the reactor's WebGL/canvas rendering are the one
  deliberate exception (visual signal, not theme surface).
- Every remaining nav tab (Projects, Files/attachments, Uplinks, Settings, and friends) is a built
  view — no "coming soon" panels left.

## In flight

- **Closed-loop cost optimization**, ported from [TokenMonitor](https://github.com/mwgrant21/TokenMonitor):
  detect waste → price it by counterfactual → grade the setup → apply the fix → **verify the fix
  held, and re-flag it if it recurs.**
- **The diagnostic thesis** — a per-dispatch timeline with anomaly bands and real file-touch
  tracking, cost-of-thrash attribution, and closing the loop from detection to intervention.
  Planned in `docs/diagnostic-thesis-plan.md`; the competitive research behind it is in
  `docs/competitive-gap-analysis-2026-07.md`.
- **Agent Personality Layer** — a two-pass work/narration split so each fleet agent's voice
  renders runtime-computed severity instead of self-reported tone, with a shared 0–4 severity
  scale, per-agent voice packs, and frozen phrases for high-confidence events. Design only,
  nothing wired into the app yet — spec in
  [`docs/superpowers/specs/AGENT_PERSONALITY_LAYER_1.md`](docs/superpowers/specs/AGENT_PERSONALITY_LAYER_1.md),
  staged as roadmap Stages 11–12.

Packaging, installers, and a team fleet view are deliberately out of scope: this is a personal
cockpit, not a distributed product. Its team-facing sibling is
[TokenMonitor](https://github.com/mwgrant21/TokenMonitor), which this project evolves.

---

## Running it

```bash
npm install
npm run electron:dev   # the real thing: desktop app, live terminal, real session tracking
npm run dev            # browser-only mode at http://localhost:5173 (no PTY / live tracking)
```

Real Claude replies in Chat: copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`. Without a
key, the offline responder answers in-world instead; nothing breaks. The key is read server-side
only and `.env` is gitignored.

```bash
npm test               # vitest — reducer, tick, view math, personas, prompt scoping,
                       # action parsing/execution, proxy validation, anomaly detection,
                       # alert-sound decision logic (572 tests at last count)
npm run build          # tsc -b && vite build
```

The frame is a fixed 1536×1024 canvas by design — a faithful port of the original design handoff —
but it scales to fit the actual viewport (`useViewportScale`/`computeFrameScale`), so it's no
longer a fixed-size-only window.

## How this is being built

The UI was designed in Claude Designer; implementation is Claude Code working through phased plan
documents in `docs/superpowers/plans/`, one fresh implementer and one fresh reviewer subagent per
task, a whole-branch review after each plan, and `PROGRESS.md` as the honest running state —
including known issues and genuinely-blocked items, not just wins. The sim-to-live migration itself
was phased the same way: Electron scaffold, real terminal, real usage data, real agent tracking,
real live output, live reactor load.

Product decisions, architecture direction, and acceptance criteria are mine; the keystrokes mostly
are not. I can explain why each piece exists, how it's meant to behave, and how it was validated —
and the `usageTokens()` story above is a fair sample of what "validated" means here: the review
pipeline passed, the number was still wrong, and checking it against reality is what caught it.
For line-level detail, the plans and commit history are the record.

## Tech

React 18 · Vite 5 · TypeScript (strict) · Electron (electron-vite) · node-pty · xterm · Vitest —
no CSS framework, no state library, no canvas library. The single `useReducer` store and
hand-rolled canvas renderers are the point.

## License

MIT — see `LICENSE` for full text.
