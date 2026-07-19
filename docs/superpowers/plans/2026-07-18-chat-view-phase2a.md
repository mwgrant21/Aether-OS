# Chat View (Phase 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Chat Phase 1's always-`null` `askClaude` stub with a real, working Claude-backed reply path: a Vite dev-server middleware proxy at `POST /api/chat` that calls the Anthropic Messages API (`claude-opus-4-8`) server-side, a `PERSONAS` map giving each real agent name a distinct conversational voice, a live-state-snapshot + Rules system-prompt builder that scopes what each channel "knows" (AETHER sees the whole fleet, an agent channel sees only its own work), and the real `askClaude()` client implementation that calls the proxy — all without changing the `askClaude`/`localResponder` fallback contract Phase 1 established.

**Architecture:** Phase 1 left a clean seam: `askClaude(system, messages)` always resolved `null`, and `useChatChannels.ts`'s send flow already unconditionally awaited it and fell back to `localResponder` prefixed `[offline]` on any failure. Phase 2a fills in both sides of that seam without touching the seam itself. On the client side, `askClaude` becomes a real `fetch('/api/chat', ...)` call that returns the reply string on success and `null` on *any* failure (network error, non-2xx, malformed key). On the server side, a new Vite plugin (`vite-plugins/chatProxyPlugin.ts`) registers a `configureServer` middleware that parses the POST body manually (Vite's connect-style server has no built-in body parser), reads `ANTHROPIC_API_KEY` from `process.env`, and calls `@anthropic-ai/sdk`'s `client.messages.create(...)`. The system prompt itself is now real: `personas.ts` maps every agent name that actually exists in this codebase's seed data and auto-spawn pool to a distinct voice (falling back to a generic persona for custom-spawned/`Auxiliary N` names), and `systemPrompt.ts` builds a compact JSON state snapshot — full fleet detail for AETHER, self-only detail for an agent channel — and appends the fixed Rules text. `useChatChannels.ts` changes by exactly one line (the placeholder `system` string becomes `buildSystemPrompt(channel, state)`); its send flow, typing indicator, persistence, and offline-fallback logic are untouched.

**Tech Stack:** React 18, Vite 5, TypeScript 5 (strict), Vitest — plus, as the one deliberate exception to "no new dependencies," `@anthropic-ai/sdk` (the official Messages API client, required to call Claude correctly rather than hand-rolling raw HTTP) and `@types/node` (a devDependency providing type declarations for the Node-side Vite plugin's use of `process.env`, `node:http`, and `Buffer` — this repo currently has zero Node-side TypeScript outside `vite.config.ts`, so no Node types are installed at all yet).

---

## Global Constraints

- Project root: `C:\Users\Matt\projects\aether-os`. This plan builds directly on top of Chat Phase 1 (`docs/superpowers/plans/2026-07-18-chat-view-phase1.md`), which is fully shipped, tested, and must not be broken.
- **Scope for this plan is Phase 2a only.** Explicitly **OUT of scope** (Phase 2b, a separate future plan): parsing the action-JSON line the system prompt now mentions as a convention, and executing any verb (`spawn|kill|theme|renderer|throttle`) — safe-verb auto-exec or risky-verb approval-queue push. Nothing in this plan reads or acts on that JSON line; it exists in the Rules text purely so Phase 2b can be a pure parsing-and-execution addition with **no system-prompt rewrite**. This was a real decision point (see Task 2) — the alternative (deferring the mention to 2b) was rejected because mentioning an unparsed convention now is harmless and avoids a second behavior-changing system-prompt plan later; flagged here explicitly rather than picked silently.
- **Never touch the `askClaude`/`localResponder` fallback contract.** `useChatChannels.ts`'s call site — `askClaude(system, toRecentTurns(historyWithUserMsg)).catch(() => null).then((reply) => { const finalText = reply ?? \`[offline] ${localResponder(...)}\`; ... })` — changes in exactly one place in this plan (Task 3: what `system` is built from). The awaiting, catching, fallback-prefixing, persistence, typing-indicator, and unread-badge logic are byte-for-byte unchanged from Phase 1.
- **Never see, request, guess, or write a real `ANTHROPIC_API_KEY` value.** This plan scaffolds `.env.example` (empty value) and a `.gitignore` entry for `.env`. The user adds their real key to a local `.env` themselves, after this plan lands. No task in this plan creates a real `.env` file or a placeholder value that looks like a real key.
- **Backend runtime is a Vite dev-server `configureServer` middleware plugin, not a standalone Express server.** Confirmed against this repo directly: `package.json`'s `dev` script is a bare `"vite"` (no Electron process, no `node-pty`, no existing backend infra of any kind exist anywhere in this repo — despite this app's fictional framing as an Electron dashboard, the actual scaffolded code is a pure Vite/React SPA). A `configureServer` plugin is therefore the correct, lowest-friction seam: it runs inside the same Node process Vite already starts for `npm run dev`, needs no new process to manage, and matches the designer's spec exactly.
  - **Known limitation, explicitly out of scope for this plan:** `configureServer` only runs under `vite`'s dev server (`npm run dev`). It does **not** run under `vite preview` or a production build. If this app is ever packaged (Electron or otherwise) beyond dev-mode, `/api/chat` will need a different runtime home — not solved here.
- **Model is `claude-opus-4-8`, exact string, non-negotiable for this plan** — confirmed by the user in this session over cheaper alternatives despite short replies. Do not substitute Sonnet or Haiku.
- **No `thinking`/`effort` parameters on the Anthropic call.** This is a short, low-latency conversational persona reply, not an agentic task — extended/adaptive thinking would add latency for no benefit here. `max_tokens: 300` is enough headroom for a ≤3-sentence reply plus the optional one-line action-JSON convention text (Phase 2b concern; not parsed here).
- **`PERSONAS` map is keyed by `Agent.name`** (the exact string), confirmed against `src/state/types.ts`'s `Agent` interface: there is no separate stable "role" field distinct from the dynamic `task` string, so `name` is the only stable per-agent identifier available. Keys were chosen by reading the actual seed roster (`src/state/initialState.ts`: 5 active agents + 2 idle/archived agents) and the actual auto-spawn name pool (`src/components/terminal/commands.ts`'s `nextAutoName`: 5 more names) — **11 real names total**, not invented archetypes. Any agent name outside that set (a custom `spawn <name>`, or the `Auxiliary N` overflow name) resolves to a single generic `FALLBACK_PERSONA`. The designer's example persona list said "Data Agent" — this repo's actual name is `Database Agent`; the map uses the real name.
- **State snapshot scoping is asymmetric by design:** AETHER's system prompt gets the full fleet snapshot (burn rate, budget, alarm level, every agent's `{name, role, status, tokenDraw}`, every project's `{name, status, crew}`, the full pending-approvals list, and the last 5 system log entries). A per-agent channel's system prompt gets only that agent's own work in detail (`task`, `pct`, `eta`, `paused`, `files`) plus a light-touch fleet summary (active agent count, burn rate, alarm level) — it never sees other agents' names/tasks, the approvals queue, or the project list. This matches the designer's "agents only know their own work in detail; AETHER knows everything" rule literally.
- **`role` in the snapshot maps to `Agent.task`** — there is no dedicated `role` field on `Agent` (confirmed above), so the AETHER snapshot's per-agent `role` field is populated from the agent's current `task` string, which is the closest stable stand-in the real data model offers. Documented at the point of use in `systemPrompt.ts`, not silently aliased.
- Match this project's established TDD-then-typecheck-then-commit rhythm per task, and its precedent that thin/wiring-only code (a `configureServer` registration, `vite.config.ts` changes) is verified via the dev server rather than unit-tested, while pure logic (`personas.ts`, `systemPrompt.ts`, the plugin's body-parsing/validation helpers, `claudeClient.ts`) gets Vitest coverage.
- Run `npm test`, `npx tsc -b`, and `npm run build` clean before every commit. Baseline going into this plan: **125 passing tests across ~16 files** (Chat Phase 1's final count).

---

## File Structure

```
aether-os/
  .env.example                        NEW — documents ANTHROPIC_API_KEY=, no real value
  .gitignore                          MODIFIED — add `.env` (bare; *.local already covers .env.local)
  package.json                        MODIFIED — + @anthropic-ai/sdk (dep), + @types/node (devDep)
  tsconfig.node.json                  MODIFIED — include vite-plugins/**/*.ts
  vite.config.ts                      MODIFIED — loadEnv() + chatProxyPlugin() registration
  vite-plugins/
    chatProxyPlugin.ts                NEW — POST /api/chat middleware, calls Anthropic Messages API
    chatProxyPlugin.test.ts           NEW — tests the pure body-parsing/validation helpers
  src/
    components/
      chat/
        personas.ts                  NEW — PERSONAS map keyed by real agent names + fallback
        personas.test.ts             NEW
        systemPrompt.ts              NEW — buildAetherSnapshot/buildAgentSnapshot/buildSystemPrompt
        systemPrompt.test.ts         NEW
        claudeClient.ts              MODIFIED — real fetch('/api/chat', ...) implementation
        claudeClient.test.ts         MODIFIED — mocked-fetch tests replace the "always null" tests
        useChatChannels.ts           MODIFIED — one line: system = buildSystemPrompt(channel, state)
```

---

### Task 1: `PERSONAS` map keyed by real agent names

Grounds every persona key in this codebase's actual roster before anything else is built on top of it.

**Files:**
- Create: `src/components/chat/personas.ts`
- Test: `src/components/chat/personas.test.ts`

**Interfaces:**
- Consumes: nothing (pure data + lookup).
- Produces: `Persona` type, `PERSONAS: Record<string, Persona>`, `FALLBACK_PERSONA: Persona`, `resolvePersona(agentName: string): Persona` — consumed by Task 2's `systemPrompt.ts`.

- [ ] **Step 1: Write the failing tests**

`src/components/chat/personas.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FALLBACK_PERSONA, PERSONAS, resolvePersona } from './personas';
import { initialState } from '../../state/initialState';

// Every name that actually exists in this codebase's seed roster and
// auto-spawn pool must have a dedicated persona -- not the fallback. The
// auto-spawn pool itself isn't exported from commands.ts (it's a local
// const inside `nextAutoName`), so these five are duplicated here as
// literals; keep them in sync with src/components/terminal/commands.ts's
// `nextAutoName` pool if that list ever changes.
const AUTO_SPAWN_POOL = ['Image Gen', 'Sentry', 'Doc Writer', 'Optimizer', 'Auditor'];

describe('resolvePersona', () => {
  it('returns a dedicated persona for every active seed agent name', () => {
    for (const agent of initialState.agents) {
      expect(resolvePersona(agent.name)).not.toBe(FALLBACK_PERSONA);
      expect(PERSONAS[agent.name]).toBeDefined();
    }
  });

  it('returns a dedicated persona for every idle/archived seed agent name', () => {
    for (const idle of initialState.idleList) {
      expect(resolvePersona(idle.name)).not.toBe(FALLBACK_PERSONA);
    }
  });

  it('returns a dedicated persona for every auto-spawn pool name', () => {
    for (const name of AUTO_SPAWN_POOL) {
      expect(resolvePersona(name)).not.toBe(FALLBACK_PERSONA);
    }
  });

  it('falls back to FALLBACK_PERSONA for a custom-spawned name', () => {
    expect(resolvePersona('My Custom Agent Name')).toBe(FALLBACK_PERSONA);
  });

  it('falls back to FALLBACK_PERSONA for the Auxiliary-N overflow name', () => {
    expect(resolvePersona('Auxiliary 6')).toBe(FALLBACK_PERSONA);
  });

  it('gives Code Builder a terse/technical voice, matching the designer spec', () => {
    expect(PERSONAS['Code Builder'].voice.toLowerCase()).toContain('terse');
  });

  it('gives Database Agent a numbers-first voice (not the invented "Data Agent" name)', () => {
    expect(PERSONAS['Database Agent']).toBeDefined();
    expect(PERSONAS['Database Agent'].voice.toLowerCase()).toContain('numbers');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- personas`
Expected: FAIL — `personas.ts` doesn't exist yet.

- [ ] **Step 3: Implement `src/components/chat/personas.ts`**

```ts
// Per-agent conversational persona, used by systemPrompt.ts to build each
// channel's system prompt. Keyed by Agent.name -- the only stable per-agent
// identifier in this codebase (there is no separate "role" field distinct
// from the dynamic `task` string; see src/state/types.ts's Agent interface).
//
// Keys below are every agent name that actually exists in this codebase:
// the 5 active + 2 idle/archived seed agents (src/state/initialState.ts)
// and the 4 remaining names in the auto-spawn pool (Doc Writer overlaps with
// the seed roster; src/components/terminal/commands.ts's `nextAutoName`) --
// not invented archetypes. Any other name (a custom `spawn <name>`, or the
// `Auxiliary N` overflow name `nextAutoName` falls back to) resolves to
// FALLBACK_PERSONA.
export interface Persona {
  voice: string;
}

export const PERSONAS: Record<string, Persona> = {
  'Code Builder': {
    voice: 'Terse and technical. You talk in file paths, diffs, and test results — no filler.',
  },
  'UI Designer': {
    voice: 'Craft-opinionated. You notice spacing, motion, and hierarchy, and say so plainly.',
  },
  'Database Agent': {
    voice: 'Numbers-first. You lead with row counts, query costs, and index names.',
  },
  'Test Runner': {
    voice: 'Methodical and pass/fail-oriented. You report outcomes plainly: green or red, and why.',
  },
  'Doc Writer': {
    voice: 'Precise and editorial. You favor clarity over cleverness and flag ambiguous wording.',
  },
  'Web Scraper': {
    voice: 'Terse and utilitarian. You talk in URLs, selectors, and rate limits.',
  },
  'Doc Helper': {
    voice: 'Plain and helpful, like a good reference desk — short, accurate answers.',
  },
  'Image Gen': {
    voice: 'Visual and descriptive. You think in prompts, styles, and compositions.',
  },
  Sentry: {
    voice: 'Vigilant and clipped. You report anomalies before anything else.',
  },
  Optimizer: {
    voice: 'Efficiency-obsessed. You talk in percentages and tradeoffs.',
  },
  Auditor: {
    voice: 'Formal and exacting. You reference policy and evidence.',
  },
};

export const FALLBACK_PERSONA: Persona = {
  voice: 'A capable, no-nonsense engineering agent — professional, brief, and focused on the task at hand.',
};

export function resolvePersona(agentName: string): Persona {
  return PERSONAS[agentName] ?? FALLBACK_PERSONA;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- personas`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (132 total: 125 existing + 7 new), 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/personas.ts src/components/chat/personas.test.ts
git commit -m "feat: add PERSONAS map keyed by this codebase's real agent names"
```

---

### Task 2: Live-state snapshot + system-prompt builder

Composes Persona + a scoped live-state JSON snapshot + the fixed Rules text into the exact system-prompt string Phase 2a needs. Replaces Phase 1's one-line inert placeholder.

**Files:**
- Create: `src/components/chat/systemPrompt.ts`
- Test: `src/components/chat/systemPrompt.test.ts`

**Interfaces:**
- Consumes: `AetherState`, `Agent` from `../../state/types`; `ChatChannel` from `./chatChannels`; `resolvePersona` from `./personas`.
- Produces: `AetherSnapshot`/`AgentSnapshot` types, `buildAetherSnapshot(state)`, `buildAgentSnapshot(state, agent)`, `buildSystemPrompt(channel, state): string` — consumed by Task 3's `useChatChannels.ts`.

- [ ] **Step 1: Write the failing tests**

`src/components/chat/systemPrompt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildAetherSnapshot, buildAgentSnapshot, buildSystemPrompt } from './systemPrompt';
import { deriveChannels, AETHER_CHANNEL_ID } from './chatChannels';
import { initialState } from '../../state/initialState';
import type { AetherState } from '../../state/types';

const channels = deriveChannels(initialState);
const aether = channels.find((c) => c.id === AETHER_CHANNEL_ID)!;
const codeBuilder = channels.find((c) => c.id === 'Code Builder')!;
const webScraper = channels.find((c) => c.id === 'Web Scraper')!; // archived

describe('buildAetherSnapshot', () => {
  it('reports full fleet detail', () => {
    const snap = buildAetherSnapshot(initialState);
    expect(snap.burnRateTokPerMin).toBe(92000);
    expect(snap.budget).toEqual({ usedTokens: 24391, capTokens: 2_000_000 });
    expect(snap.alarmLevel).toBe('ok');
    expect(snap.agents).toHaveLength(5);
    expect(snap.agents[0]).toEqual({ name: 'Code Builder', role: 'Refactoring auth middleware', status: 'active', tokenDraw: Math.round(0.22 * 92000) });
    expect(snap.projects.map((p) => p.name)).toContain('CLI Companion');
    expect(snap.pendingApprovals).toHaveLength(2);
  });

  it('marks a paused agent status correctly', () => {
    const paused: AetherState = { ...initialState, agents: initialState.agents.map((a) => (a.name === 'Code Builder' ? { ...a, paused: true } : a)) };
    const snap = buildAetherSnapshot(paused);
    expect(snap.agents.find((a) => a.name === 'Code Builder')?.status).toBe('paused');
  });

  it('caps recentEvents at the last 5 log entries', () => {
    const withLogs: AetherState = { ...initialState, logs: Array.from({ length: 8 }, (_, i) => ({ t: `t${i}`, m: `m${i}`, c: '#fff' })) };
    const snap = buildAetherSnapshot(withLogs);
    expect(snap.recentEvents).toHaveLength(5);
    expect(snap.recentEvents[4].message).toBe('m7');
  });
});

describe('buildAgentSnapshot', () => {
  it("reports only that agent's own work, plus a light fleet summary", () => {
    const agent = initialState.agents.find((a) => a.name === 'Code Builder')!;
    const snap = buildAgentSnapshot(initialState, agent);
    expect(snap.self).toEqual({
      name: 'Code Builder',
      task: 'Refactoring auth middleware',
      pctComplete: 62,
      eta: '4m',
      paused: false,
      filesTouched: ['routes/auth.js', 'middleware/session.js'],
    });
    expect(snap.fleet).toEqual({ activeAgentCount: 5, burnRateTokPerMin: 92000, alarmLevel: 'ok' });
  });
});

describe('buildSystemPrompt', () => {
  it('AETHER prompt addresses the user as Operator and includes the full snapshot + Rules', () => {
    const prompt = buildSystemPrompt(aether, initialState);
    expect(prompt).toContain('Operator');
    expect(prompt).toContain('"burnRateTokPerMin":92000');
    expect(prompt).toContain('3 sentences');
    expect(prompt).not.toContain('markdown');  // guard against accidentally instructing markdown ON
  });

  it("agent-channel prompt uses that agent's persona and does not leak other agents' names", () => {
    const prompt = buildSystemPrompt(codeBuilder, initialState);
    expect(prompt.toLowerCase()).toContain('terse');
    expect(prompt).toContain('Refactoring auth middleware');
    expect(prompt).not.toContain('UI Designer');
    expect(prompt).not.toContain('Database Agent');
    expect(prompt).not.toContain('pendingApprovals');
  });

  it('falls back to FALLBACK_PERSONA voice for a custom-spawned agent name', () => {
    const custom = { ...codeBuilder, id: 'My Custom Agent', name: 'My Custom Agent' };
    const withCustom: AetherState = { ...initialState, agents: [...initialState.agents, { ...initialState.agents[0], name: 'My Custom Agent' }] };
    const prompt = buildSystemPrompt(custom, withCustom);
    expect(prompt.toLowerCase()).toContain('no-nonsense');
  });

  it('builds a safe, non-crashing prompt for an archived channel', () => {
    const prompt = buildSystemPrompt(webScraper, initialState);
    expect(prompt).toContain('Web Scraper');
    expect(prompt.toLowerCase()).toContain('offline');
  });

  it('mentions the action-JSON convention (Phase 2b will parse it; this prompt only documents it)', () => {
    const prompt = buildSystemPrompt(aether, initialState);
    expect(prompt).toContain('"verb"');
    expect(prompt).toContain('spawn');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- systemPrompt`
Expected: FAIL — `systemPrompt.ts` doesn't exist yet.

- [ ] **Step 3: Implement `src/components/chat/systemPrompt.ts`**

```ts
import type { Agent, AetherState } from '../../state/types';
import type { ChatChannel } from './chatChannels';
import { resolvePersona } from './personas';

const AETHER_VOICE =
  'You are AETHER, the mission-control intelligence of this dashboard. ' +
  'Dry, precise, and economical with words. You refer to the user as "Operator."';

// AETHER "knows everything" -- a full fleet snapshot.
export interface AetherSnapshot {
  burnRateTokPerMin: number;
  budget: { usedTokens: number; capTokens: number };
  alarmLevel: AetherState['alarmLevel'];
  agents: { name: string; role: string; status: 'active' | 'paused'; tokenDraw: number }[];
  projects: { name: string; status: string; crew: string[] }[];
  pendingApprovals: { agent: string; action: string; risk: string }[];
  recentEvents: { time: string; message: string }[];
}

export function buildAetherSnapshot(state: AetherState): AetherSnapshot {
  return {
    burnRateTokPerMin: Math.round(state.rate),
    budget: { usedTokens: Math.round(state.used), capTokens: Math.round(state.cfg.capM * 1e6) },
    alarmLevel: state.alarmLevel,
    // `role` has no dedicated field on Agent -- `task` (the dynamic mission
    // description) is the closest stable stand-in this data model offers.
    agents: state.agents.map((a) => ({
      name: a.name,
      role: a.task,
      status: a.paused ? ('paused' as const) : ('active' as const),
      tokenDraw: Math.round(a.share * state.rate),
    })),
    projects: state.projects.map((p) => ({ name: p.name, status: p.status, crew: p.crew })),
    pendingApprovals: state.approvals.map((a) => ({ agent: a.agent, action: a.action, risk: a.risk })),
    recentEvents: state.logs.slice(-5).map((l) => ({ time: l.t, message: l.m })),
  };
}

// Agents "only know their own work in detail" -- deliberately narrower than
// buildAetherSnapshot: no roster, no approvals, no projects. Just this
// agent's own work plus a light-touch fleet summary.
export interface AgentSnapshot {
  self: { name: string; task: string; pctComplete: number; eta: string; paused: boolean; filesTouched: string[] };
  fleet: { activeAgentCount: number; burnRateTokPerMin: number; alarmLevel: AetherState['alarmLevel'] };
}

export function buildAgentSnapshot(state: AetherState, agent: Agent): AgentSnapshot {
  return {
    self: {
      name: agent.name,
      task: agent.task,
      pctComplete: Math.round(agent.pct),
      eta: agent.eta,
      paused: !!agent.paused,
      filesTouched: agent.files.map((f) => f.n),
    },
    fleet: {
      activeAgentCount: state.agents.length,
      burnRateTokPerMin: Math.round(state.rate),
      alarmLevel: state.alarmLevel,
    },
  };
}

// The action-JSON-on-last-line convention (verb in spawn|kill|theme|renderer|
// throttle) is mentioned here now, even though nothing parses it yet --
// Phase 2b (a separate future plan) adds the parser/executor as a pure
// addition with NO further system-prompt rewrite. This was a real decision
// point: the alternative was deferring this sentence to 2b entirely. Mention-
// now was chosen because it's harmless (unparsed JSON in a chat reply is
// just inert text today) and avoids a second prompt-behavior-changing plan.
const RULES =
  'Reply in at most 3 sentences. Stay in character. Do not format your reply with markdown. ' +
  'If your reply implies a concrete action you could take (spawn, kill, theme, renderer, throttle), ' +
  'you may end your reply with one extra line containing a compact JSON object of the shape ' +
  '{"verb": "spawn|kill|theme|renderer|throttle", "args": {...}}. This is optional and only ' +
  'meaningful for actions in your own domain -- omit it for ordinary conversational replies.';

// Composes Persona + live-state snapshot (JSON) + Rules into the exact
// system-prompt string passed to askClaude. Replaces Phase 1's one-line
// placeholder in useChatChannels.ts (see Task 3).
export function buildSystemPrompt(channel: ChatChannel, state: AetherState): string {
  if (channel.kind === 'aether') {
    const snapshot = buildAetherSnapshot(state);
    return `${AETHER_VOICE}\n\nCurrent state:\n${JSON.stringify(snapshot)}\n\n${RULES}`;
  }

  const persona = resolvePersona(channel.name);
  const agent = state.agents.find((a) => a.name === channel.name);
  if (!agent) {
    // Archived channels never reach askClaude in practice (useChatChannels
    // blocks sending when channel.archived is true), but build a safe
    // prompt anyway rather than assume every future caller guards this.
    return `You are ${channel.name}. ${persona.voice}\n\nYou are currently offline/archived.\n\n${RULES}`;
  }

  const snapshot = buildAgentSnapshot(state, agent);
  return `You are ${channel.name}. ${persona.voice}\n\nYour current state:\n${JSON.stringify(snapshot)}\n\n${RULES}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- systemPrompt`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (141 total), 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/systemPrompt.ts src/components/chat/systemPrompt.test.ts
git commit -m "feat: add scoped live-state snapshot + system-prompt builder (Persona + state + Rules)"
```

---

### Task 3: Wire `buildSystemPrompt` into `useChatChannels.ts`

The only change to Phase 1's send-flow file. A one-line swap, no other logic touched.

**Files:**
- Modify: `src/components/chat/useChatChannels.ts`

**Interfaces:**
- Consumes (new): `buildSystemPrompt` from `./systemPrompt`.

- [ ] **Step 1: Make the change**

In `src/components/chat/useChatChannels.ts`, add the import:

```ts
import { buildSystemPrompt } from './systemPrompt';
```

Replace:

```ts
    // Phase 2 (a separate, future plan) replaces this one-line placeholder
    // with the full Persona + live-state-snapshot + Rules system prompt the
    // designer's spec describes (see Global Constraints) — out of scope here.
    const system = `You are ${channel.name}, a channel inside the Aether OS comms system.`;
```

with:

```ts
    // Phase 2a's real Persona + live-state-snapshot + Rules system prompt.
    // Everything below this line (askClaude call, catch, localResponder
    // fallback, persistence, unread bookkeeping) is unchanged from Phase 1.
    const system = buildSystemPrompt(channel, state);
```

Nothing else in this file changes — `askClaude(system, toRecentTurns(historyWithUserMsg)).catch(() => null).then(...)` and everything after it stays exactly as Phase 1 left it.

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all PASS (141 total — no new tests here; `useChatChannels.ts` has no dedicated test file per Phase 1 precedent, verified via dev server).

- [ ] **Step 4: Verify via dev server**

Run: `npm run dev`. `askClaude` is still Phase 1's always-`null` stub at this point in the plan, so behavior should look **identical** to Chat Phase 1's final state: sending a message in any channel still falls back to a `[offline]`-prefixed `localResponder` reply. This step exists only to confirm the system-prompt content swap didn't break anything — the real Claude call doesn't exist yet (Task 6).

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/useChatChannels.ts
git commit -m "feat: wire the real Persona+state+Rules system prompt into the chat send flow"
```

---

### Task 4: Secrets scaffolding — `.env.example` + `.gitignore`

Pure scaffolding, no code. Sets up the plumbing for the user to add their own key after this plan lands.

**Files:**
- Create: `.env.example`
- Modify: `.gitignore`

- [ ] **Step 1: Create `.env.example`**

```
# Copy this file to .env and set your real Anthropic API key there.
# Never commit the real .env file — it is gitignored.
ANTHROPIC_API_KEY=
```

- [ ] **Step 2: Update `.gitignore`**

Current contents:

```
node_modules
dist
.DS_Store
*.local
*.tsbuildinfo
vite.config.d.ts
vite.config.js
```

`*.local` already covers `.env.local`/`.env.production.local` etc. (Vite's own convention) since those filenames end in `.local`, but it does **not** cover a bare `.env`. Add that line:

```
node_modules
dist
.DS_Store
*.local
*.tsbuildinfo
vite.config.d.ts
vite.config.js
.env
```

- [ ] **Step 3: Do NOT create a real `.env` file**

Task 5's Vite config change (`loadEnv`) tolerates `.env` being entirely absent — `loadEnv` simply returns an empty object for any file that doesn't exist. No placeholder `.env` file is created in this task or any other task in this plan.

- [ ] **Step 4: Commit**

```bash
git add .env.example .gitignore
git commit -m "chore: scaffold ANTHROPIC_API_KEY env plumbing (.env.example, gitignore .env)"
```

---

### Task 5: `POST /api/chat` Vite dev-server middleware plugin

The backend seam: a `configureServer` plugin that parses the request body manually, validates it, reads the API key from `process.env`, and calls the Anthropic Messages API via `@anthropic-ai/sdk`.

**New dependencies (justified exceptions to "no new deps"):**
- `@anthropic-ai/sdk` (runtime) — the official Anthropic Messages API client; hand-rolling raw `fetch` against `api.anthropic.com` is explicitly disallowed per this plan's constraints.
- `@types/node` (dev) — this repo has zero Node-side TypeScript today outside `vite.config.ts` (whose own tsconfig, `tsconfig.node.json`, has no Node types installed either); the plugin's use of `process.env`, `node:http` types, and `Buffer` needs them.

```bash
npm install @anthropic-ai/sdk
npm install -D @types/node
```

**Files:**
- Create: `vite-plugins/chatProxyPlugin.ts`
- Test: `vite-plugins/chatProxyPlugin.test.ts`
- Modify: `tsconfig.node.json` (add `vite-plugins/**/*.ts` to `include`)
- Modify: `vite.config.ts` (register the plugin, load `.env` into `process.env`)

**Interfaces:**
- Consumes: `@anthropic-ai/sdk`'s `Anthropic` client; Node's `node:http` types.
- Produces: `chatProxyPlugin(): Plugin`, plus the exported pure helpers `readRequestBody(req)` and `isValidChatBody(body)` — consumed only by `vite.config.ts` and this task's own test file.

- [ ] **Step 1: Write the failing tests for the pure helpers**

`vite-plugins/chatProxyPlugin.test.ts`:

```ts
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { isValidChatBody, readRequestBody } from './chatProxyPlugin';

function fakeRequest(body: string): IncomingMessage {
  const stream = Readable.from([Buffer.from(body, 'utf8')]);
  return stream as unknown as IncomingMessage;
}

describe('readRequestBody', () => {
  it('collects a chunked request body into a single string', async () => {
    const result = await readRequestBody(fakeRequest('{"hello":"world"}'));
    expect(result).toBe('{"hello":"world"}');
  });

  it('resolves to an empty string for an empty body', async () => {
    const result = await readRequestBody(fakeRequest(''));
    expect(result).toBe('');
  });
});

describe('isValidChatBody', () => {
  it('accepts a well-formed body', () => {
    expect(isValidChatBody({ system: 'you are X', messages: [{ role: 'user', text: 'hi' }] })).toBe(true);
  });

  it('rejects a missing system field', () => {
    expect(isValidChatBody({ messages: [{ role: 'user', text: 'hi' }] })).toBe(false);
  });

  it('rejects a non-string system field', () => {
    expect(isValidChatBody({ system: 42, messages: [{ role: 'user', text: 'hi' }] })).toBe(false);
  });

  it('rejects an empty messages array', () => {
    expect(isValidChatBody({ system: 'x', messages: [] })).toBe(false);
  });

  it('rejects a malformed turn (bad role)', () => {
    expect(isValidChatBody({ system: 'x', messages: [{ role: 'system', text: 'hi' }] })).toBe(false);
  });

  it('rejects a turn with a non-string text field', () => {
    expect(isValidChatBody({ system: 'x', messages: [{ role: 'user', text: 42 }] })).toBe(false);
  });

  it('rejects a completely malformed body (null, array, primitive)', () => {
    expect(isValidChatBody(null)).toBe(false);
    expect(isValidChatBody([])).toBe(false);
    expect(isValidChatBody('nope')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- chatProxyPlugin`
Expected: FAIL — `chatProxyPlugin.ts` doesn't exist yet.

- [ ] **Step 3: Implement `vite-plugins/chatProxyPlugin.ts`**

> **Implementer note:** verify the exact `@anthropic-ai/sdk` TypeScript call shape against the version actually installed (`client.messages.create({ model, max_tokens, system, messages })`, response `content: ContentBlock[]` narrowed via `block.type === 'text'`) before relying on the snippet below — the exact exported type name for a text content block (e.g. `Anthropic.TextBlock` vs. a nested namespace) should be confirmed against the installed package's `.d.ts` rather than guessed. Also confirm the exact model ID string `claude-opus-4-8` is accepted by the installed SDK version (it should be, per current Anthropic model docs) rather than assuming a date-suffixed variant is required.

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 300;

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

interface ChatRequestBody {
  system: string;
  messages: ChatTurn[];
}

// Vite's connect-style dev server has no built-in JSON body parser (unlike
// Express's express.json()) -- the raw request body must be collected
// manually from the stream before it can be parsed.
export function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isChatTurn(value: unknown): value is ChatTurn {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v.role === 'user' || v.role === 'assistant') && typeof v.text === 'string';
}

export function isValidChatBody(body: unknown): body is ChatRequestBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.system !== 'string') return false;
  if (!Array.isArray(b.messages) || b.messages.length === 0) return false;
  return b.messages.every(isChatTurn);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function handleChatRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  let parsed: unknown;
  try {
    const raw = await readRequestBody(req);
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'malformed JSON body' });
    return;
  }

  if (!isValidChatBody(parsed)) {
    sendJson(res, 400, { error: 'body must be { system: string, messages: {role, text}[] }' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Deliberately a clear, non-crashing error status -- askClaude() (Task 6)
    // treats any non-2xx as a signal to return null and fall back to
    // localResponder. The dev server itself never crashes on a missing key.
    sendJson(res, 503, { error: 'ANTHROPIC_API_KEY is not set on the server' });
    return;
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: parsed.system,
      messages: parsed.messages.map((m) => ({ role: m.role, content: m.text })),
    });
    const textBlock = response.content.find((block) => block.type === 'text');
    const reply = textBlock && 'text' in textBlock ? textBlock.text : '';
    sendJson(res, 200, { reply });
  } catch (err) {
    // Never let an Anthropic SDK error (rate limit, auth, network, etc.)
    // crash the dev server -- surface it as a clean 500 and let askClaude()
    // fall back to localResponder.
    sendJson(res, 500, { error: err instanceof Error ? err.message : 'unknown error calling Anthropic' });
  }
}

export function chatProxyPlugin(): Plugin {
  return {
    name: 'aether-chat-proxy',
    configureServer(server) {
      const middleware: Connect.NextHandleFunction = (req, res) => {
        handleChatRequest(req, res).catch((err) => {
          sendJson(res, 500, { error: err instanceof Error ? err.message : 'unknown error' });
        });
      };
      server.middlewares.use('/api/chat', middleware);
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- chatProxyPlugin`
Expected: PASS, 9 tests.

- [ ] **Step 5: Update `tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts", "vite-plugins/**/*.ts"]
}
```

- [ ] **Step 6: Wire the plugin into `vite.config.ts`**

> **Implementer note:** Vite's own env loading (`import.meta.env`) only populates variables for **client** code — it does not automatically set `process.env` for the dev server's own Node process (i.e., for plugin code like `configureServer`). The standard pattern for a plugin that needs a `.env`-sourced secret in `process.env` is to call `loadEnv(mode, cwd, '')` inside the function form of `defineConfig` and merge the result into `process.env` before the plugin runs. Verify this against the currently-installed Vite 5 behavior before relying on it.

```ts
/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { chatProxyPlugin } from './vite-plugins/chatProxyPlugin';

export default defineConfig(({ mode }) => {
  // Populate process.env from .env / .env.local for the dev server's own
  // Node process (plugin code) -- Vite only does this automatically for
  // import.meta.env in client code. A real shell-exported env var always
  // wins over a .env-file value.
  const env = loadEnv(mode, process.cwd(), '');
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return {
    plugins: [react(), chatProxyPlugin()],
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test-setup.ts'],
    },
  };
});
```

- [ ] **Step 7: Run the full suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (150 total: 141 from Tasks 1–3 + 9 new here), 0 type errors, build succeeds.

- [ ] **Step 8: Verify via dev server (without a real key)**

Run: `npm run dev`. With no `.env` present (or an empty `ANTHROPIC_API_KEY=`), open the browser dev tools Network tab, and manually `fetch('/api/chat', { method: 'POST', body: JSON.stringify({ system: 'x', messages: [{ role: 'user', text: 'hi' }] }) })` from the console — confirm it returns HTTP 503 with `{ error: 'ANTHROPIC_API_KEY is not set on the server' }`, and that the dev server process itself keeps running (check the terminal `npm run dev` was started in — no crash, no unhandled rejection printed).

- [ ] **Step 9: Commit**

```bash
git add vite-plugins/chatProxyPlugin.ts vite-plugins/chatProxyPlugin.test.ts tsconfig.node.json vite.config.ts package.json package-lock.json
git commit -m "feat: add POST /api/chat Vite dev-server middleware proxying to the Anthropic Messages API"
```

---

### Task 6: Real `askClaude()` client implementation

Replaces the always-`null` stub with a real `fetch('/api/chat', ...)` call, preserving the exact signature and null-on-any-failure contract Phase 1 established.

**Files:**
- Modify: `src/components/chat/claudeClient.ts`
- Modify: `src/components/chat/claudeClient.test.ts`

**Interfaces:**
- Unchanged: `ChatTurn`, `toRecentTurns(messages, limit?)`.
- Changed body only: `askClaude(system: string, messages: ChatTurn[]): Promise<string | null>` — same signature, same call site in `useChatChannels.ts` (untouched).

- [ ] **Step 1: Replace the tests for `askClaude`**

`src/components/chat/claudeClient.test.ts` — replace the `describe('askClaude', ...)` block (keep `toRecentTurns`'s tests as-is):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { askClaude, toRecentTurns } from './claudeClient';
import type { ChatMessage } from './chatPersistence';

function msg(role: ChatMessage['role'], text: string): ChatMessage {
  return { id: text, role, text, t: '00:00' };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('askClaude', () => {
  it('returns the reply string on a successful proxy response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reply: 'Hello, Operator.' }) }),
    );
    await expect(askClaude('system prompt', [{ role: 'user', text: 'hi' }])).resolves.toBe('Hello, Operator.');
  });

  it('posts { system, messages } as the request body to /api/chat', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reply: 'ok' }) });
    vi.stubGlobal('fetch', fetchMock);
    await askClaude('sys', [{ role: 'user', text: 'hi' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ system: 'sys', messages: [{ role: 'user', text: 'hi' }] }),
      }),
    );
  });

  it('resolves to null on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'nope' }) }));
    await expect(askClaude('system prompt', [{ role: 'user', text: 'hi' }])).resolves.toBeNull();
  });

  it('resolves to null when the reply field is missing or empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reply: '' }) }));
    await expect(askClaude('system prompt', [])).resolves.toBeNull();
  });

  it('resolves to null on a network error, never throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(askClaude('', [])).resolves.toBeNull();
  });

  it('resolves to null on a malformed (non-JSON) response body, never throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }));
    await expect(askClaude('system prompt', [{ role: 'user', text: 'hi' }])).resolves.toBeNull();
  });
});

describe('toRecentTurns', () => {
  it('keeps only user/assistant messages, dropping any reserved system entries', () => {
    const turns = toRecentTurns([msg('user', 'hi'), msg('system', 'internal note'), msg('assistant', 'hello')]);
    expect(turns).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
    ]);
  });

  it('limits to the last 10 turns by default', () => {
    const messages = Array.from({ length: 15 }, (_, i) => msg(i % 2 === 0 ? 'user' : 'assistant', `m${i}`));
    const turns = toRecentTurns(messages);
    expect(turns).toHaveLength(10);
    expect(turns[0].text).toBe('m5');
    expect(turns[9].text).toBe('m14');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- claudeClient`
Expected: FAIL — `askClaude` still always resolves `null` unconditionally (old stub), so the "successful response" and "posts body" tests fail.

- [ ] **Step 3: Implement the real `askClaude` in `src/components/chat/claudeClient.ts`**

```ts
import type { ChatMessage } from './chatPersistence';

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

const RECENT_TURN_LIMIT = 10;

// Trims a channel's message history down to the last N user/assistant turns
// (dropping any reserved 'system' entries) for the shape askClaude expects.
export function toRecentTurns(messages: ChatMessage[], limit: number = RECENT_TURN_LIMIT): ChatTurn[] {
  return messages
    .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
    .slice(-limit)
    .map((m) => ({ role: m.role, text: m.text }));
}

// Calls the Vite dev-server middleware proxy (Task 5's POST /api/chat),
// which forwards { system, messages } to the Anthropic Messages API
// server-side -- the API key never reaches this client-side code. Returns
// the reply string on success, or null on ANY failure (network error,
// non-2xx status, missing/empty reply field, malformed response body) so
// useChatChannels.ts's existing "fall back to localResponder on null" branch
// (unchanged from Phase 1) is always safe to await unconditionally.
export async function askClaude(system: string, messages: ChatTurn[]): Promise<string | null> {
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system, messages }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { reply?: unknown };
    return typeof data.reply === 'string' && data.reply.length > 0 ? data.reply : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- claudeClient`
Expected: PASS, 8 tests (6 `askClaude` + 2 `toRecentTurns`).

- [ ] **Step 5: Run the full suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (~154 total), 0 type errors, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/claudeClient.ts src/components/chat/claudeClient.test.ts
git commit -m "feat: implement the real askClaude() client call against POST /api/chat"
```

---

### Task 7: Final end-to-end manual QA (requires a real `ANTHROPIC_API_KEY`)

**Files:** none (verification-only task).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS, 0 type errors, build succeeds.

- [ ] **Step 2: Check whether a real key is available**

This step's remaining checklist items require a real Anthropic API key in a local `.env` (`ANTHROPIC_API_KEY=sk-ant-...`), which the user adds themselves per this plan's Global Constraints — **the implementer/reviewer running this plan must never generate, guess, or ask the user to paste that key into chat.** If `.env` doesn't exist yet or `ANTHROPIC_API_KEY` is empty when this task is reached, **mark the remaining steps below as BLOCKED/DEFERRED** (do not silently skip them, and do not fake a "pass" by only exercising the offline-fallback path) — note explicitly in the handoff which checklist items were deferred and why, so a follow-up session can complete them once the key is present.

- [x] **Step 3: Manual QA checklist (requires the real key from Step 2)** — completed 2026-07-19, funded credits.

Run: `npm run dev` (after adding the real key to `.env`), open the browser.

- [x] Send a message in AETHER — confirm the reply is a real, in-character Claude response (dry, mission-control tone, addresses you as "Operator"), not `[offline]`-prefixed. **PASS.**
- [x] Send a message in an active agent's channel (e.g. Code Builder) — confirm the reply reflects that agent's distinct persona (terse/technical) and, where relevant, its actual live task/progress from the state snapshot. **PASS** — cited real file paths (`routes/auth.js`, `middleware/session.js`) and exact progress/ETA.
- [x] Send a message in a different active agent's channel (e.g. UI Designer or Database Agent) — confirm the voice is genuinely different from Code Builder's, not a repeated generic tone. **PASS** — UI Designer's reply used design vocabulary ("breathe", "vertical rhythm"), longer/more expressive sentences, clearly distinct from Code Builder's clipped technical style.
- [x] Spawn a custom-named agent via Terminal (`spawn Whatever Name`), open its chat channel, and send a message — confirm it gets `FALLBACK_PERSONA`'s generic voice (not a crash, not an empty reply). **PASS** — spawned "Nightwatch", got a sensible generic just-initializing reply.
- [x] Open the browser Network tab and inspect one `/api/chat` request — confirm the request body's `system` field contains the live burn rate / agent task / etc. matching what's currently shown elsewhere in the dashboard, and that no API key appears anywhere in the request or response bodies visible to the client. **PASS** — verified via a temporary fetch interceptor: `system` field contained the live burn rate (matching the dashboard exactly) and real per-agent task data; regex-scanned the full request body for an `sk-ant-` pattern, none found.
- [x] Temporarily rename/remove `.env` (or blank out the key) and restart `npm run dev` — confirm chat replies fall back to the `[offline]`-prefixed `localResponder` exactly as in Phase 1, with no crash in the terminal running the dev server. Restore the real key afterward. **PASS** — blanked the key (backed up first, restored after), got `[offline] Acknowledged: "Still there?"...`, dev server log had zero error/exception/500 lines.
- [x] Confirm no regressions: Terminal, Dashboard, Agents, Grid still route and function correctly; Chat Phase 1's full manual QA checklist (channel rail, archived channels, unread badges, 50-message cap, reload persistence) still holds with the real backend wired in. **PASS** — spot-checked Terminal/Dashboard/Agents/Grid, all healthy; reload persistence confirmed (full AETHER history + both new agents survived a hard reload); archived channels (Web Scraper, Doc Helper) correctly show "TERMINATED".

- [x] **Step 4: Record the outcome**

Phase 2a is now fully verified end-to-end (2026-07-19). All Step 3 items passed. One genuine bug was found during this QA pass — not in Phase 2a's own code, but exposed by it once a real model was in the loop — and fixed separately (commit `45af729`, see Phase 2b's Task 6 below, since the bug was in the shared `RULES`/action-JSON schema that only Phase 2b's executor consumes). No commit was needed against Phase 2a's own files.

<details><summary>Original (superseded) Step 4 instructions</summary>

No commit is expected from Step 3 unless a real gap is found. If every item passed, note in the handoff that Phase 2a is fully verified end-to-end. If Step 2 found no key present, note explicitly which Step 3 items are deferred pending the user adding their key, and that this is expected per the Global Constraints (not a bug, not skipped silently). If a genuine bug is found, fix and commit it as its own small fix:

```bash
git add <touched files>
git commit -m "fix: <describe the gap found during Chat Phase 2a end-to-end QA>"
```

</details>

---

## Execution Handoff

Plan complete. Execute via the same per-task pipeline as Chat Phase 1: a fresh implementer subagent per task, a fresh reviewer subagent (spec compliance + code quality) before commit, then one whole-branch review after all tasks land. Phase 2b (action-JSON parsing and safe/risky-verb execution wired to the approval queue) is intentionally a separate future plan, unblocked by this one — the Rules text already documents the action-JSON convention (Task 2's explicit decision), so 2b should be pure parsing-and-execution work with no further system-prompt rewrite.

### Critical Files for Implementation
- C:\Users\Matt\projects\aether-os\src\components\chat\personas.ts
- C:\Users\Matt\projects\aether-os\src\components\chat\systemPrompt.ts
- C:\Users\Matt\projects\aether-os\src\components\chat\claudeClient.ts
- C:\Users\Matt\projects\aether-os\vite-plugins\chatProxyPlugin.ts
- C:\Users\Matt\projects\aether-os\vite.config.ts
- C:\Users\Matt\projects\aether-os\src\components\chat\useChatChannels.ts
