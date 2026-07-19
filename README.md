# Aether OS

A mission-control dashboard for an AI agent fleet — reactor core, agent roster, orchestration
grid, and a chat deck where the mission-control intelligence (AETHER) and every agent are real
Claude-backed personas.

One honest line up front: **the fleet is simulated; the AI is real.** Agent progress, token
burn, and the approval queue are driven by a deterministic simulation tick. The chat, however,
talks to the live Anthropic API — each agent answers in character, scoped to what that agent
would actually know.

## What's built

- **Terminal** — command console plus the reactor core: three switchable renderers
  (NEBULA / VOLUMETRIC / WARP) on layered 2D/WebGL canvases, with a stall watchdog.
- **Dashboard** — reactor hero, active agents, projects, recent alerts, and systems cells on a
  single view registry.
- **Agents** — roster + detail: pause/resume, terminate (archives, never deletes), reactivate,
  and agent-tied approvals.
- **Grid** — radial hub-and-spoke SVG map of agents, projects, and animated assignment links.
- **Chat** — a channel per agent plus AETHER. Real Claude replies via a dev-server proxy
  (API key stays server-side), per-persona voices, and a state-aware local responder that takes
  over seamlessly when no key is configured. Replies can carry a trailing action-JSON
  convention: safe verbs (theme/renderer) execute immediately, risky verbs (spawn/kill/throttle)
  route through the approval queue with a real risk policy, and the eventual approve/deny posts
  back into the requesting channel.

Projects, Memory, Analytics, Uplinks, Files, and Settings currently show an honest
"not built yet" panel — next planned work is one of those.

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
npm run dev          # http://localhost:5173
```

Optional — real Claude replies in Chat: copy `.env.example` to `.env` and set
`ANTHROPIC_API_KEY`. Without a key, the offline responder answers in-world instead; nothing
breaks. The key is read server-side by the Vite middleware only and `.env` is gitignored.

```bash
npm test             # vitest — pure logic: reducer, tick, math, personas, prompt scoping, proxy validation
npm run build        # tsc -b && vite build
```

The frame is fixed at 1536×1024 by design — this is a faithful port of the original design
handoff, not a responsive app (yet).

## How this is being built

The UI was designed in Claude Designer; implementation is Claude Code working through phased
plan documents in `docs/superpowers/plans/`, one fresh implementer and one fresh reviewer
subagent per task, a whole-branch review after each plan, and `PROGRESS.md` as the honest
running state — including known issues and genuinely-blocked items, not just wins. Product
decisions, architecture direction, and acceptance criteria are mine; the keystrokes mostly are
not. I can explain why each piece exists, how it's meant to behave, and how it was validated;
for line-level detail, the plans and commit history are the record.

## Tech

React 18 · Vite 5 · TypeScript (strict) · Vitest — no CSS framework, no state library, no
canvas library. The single `useReducer` store and hand-rolled canvas renderers are the point.
