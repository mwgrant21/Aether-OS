# Chat View (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `Chat` tab's `ComingSoonPanel` placeholder with Phase 1 of the AI comms channel: a channel rail (AETHER + one channel per active agent, archived-not-deleted on termination) + message thread + input, per-channel localStorage persistence, and a real, working keyword-driven `localResponder` fallback — with the `askClaude(system, messages)` seam wired in as a genuinely-called, always-`null` stub so Phase 2 (a separate future plan) can drop a real Claude-backed proxy in behind it without touching any call site.

**Architecture:** Chat's state is deliberately kept out of `AetherState` entirely — channel membership is *derived live* every render from `state.agents`/`state.idleList` (an agent's channel is active while it's in `agents`, archived the instant it moves to `idleList`, with no separate "channel registry" to keep in sync), and each channel's message history lives in its own `localStorage` key (`aether-chat-<channelId>`, capped at 50), managed by a new `useChatChannels` hook that is this plan's message-send-flow: optimistic user-message render → typing indicator → `askClaude` (always fails in Phase 1) → fallback to `localResponder`, prefixed `[offline]`. Which channel is currently open is view-local `useState` inside that hook, not a reducer action — a different concept from `state.selected`/`SELECT_AGENT` (Grid/Agents' "which agent is selected"), documented explicitly so the two are never conflated. Pure logic (`chatChannels.ts`'s derivation, `chatPersistence.ts`'s per-channel storage, `claudeClient.ts`'s stub + turn-trimming helper, and `localResponder.ts` — the one piece of genuinely interesting logic in this plan) gets Vitest coverage, following the "math file feeds a dumb component" split every prior view plan established; the presentational shell (rail, thread, input, typing indicator) and the side-effectful `useChatChannels` hook are verified via the dev server, matching the precedent set for `store.tsx`/`useReactorCanvas`/`ReactorStatusCard`/etc.

**Tech Stack:** Same as the existing project — React 18, Vite 5, TypeScript 5 (strict), Vitest. No new dependencies, no backend/server work of any kind — this plan is UI shell + state model + local fallback logic only.

## Global Constraints

- Project root: `C:\Users\Matt\projects\aether-os` (already scaffolded; this plan extends it, not a fresh `git init`).
- **Scope for this plan is Phase 1 only**, per the designer's two-phase spec. **Explicitly OUT of scope** (Phase 2, a separate future plan): the real `POST /api/chat` backend proxy, the real Anthropic Messages API call, the `PERSONAS` map and full Persona + live-state-snapshot + Rules system-prompt construction, and the action-JSON regex/execution pipeline (safe-verb auto-exec, risky-verb approval-queue push). When Phase 2 lands, its proxy will be a Vite dev-server `configureServer` middleware, not a standalone Express server — noted here only so this plan's `askClaude`-shaped seam doesn't accidentally assume an Express-shaped backend; nothing in this plan builds that middleware.
- **This plan builds:** the Chat view's UI shell (channel rail + message thread + input, matching the existing dark blue-green panel / Rajdhani-labels / Space-Mono-numbers / `#7fd8ef` cyan-accent visual language), the channel model (AETHER + one channel per active agent, archived-not-deleted on termination), per-channel `localStorage` persistence capped at 50 messages, the message-send flow (optimistic render → typing indicator → reply), and a real, working `localResponder(channel, text, state)`.
- **Chat's per-channel persistence is a deliberately NEW, separate mechanism from `src/state/persistence.ts`'s single `aetheros-v1` blob — confirmed by reading that file directly.** `persistence.ts` whitelists a fixed, known set of `AetherState` fields into one JSON blob under one key. Chat's channel set is *dynamic* (one localStorage key born per agent, independent of any single fixed schema) and each channel's history is capped independently at 50 messages — cramming that into `AetherState`'s single whitelisted blob would mean the blob's size scales with however much every agent has ever said, forever, with no per-channel cap possible. A single `aether-chat-<channelId>` key per channel, each independently capped, is the correct shape for this problem and is intentionally not layered on top of the existing whitelist mechanism. **Nothing in `persistence.ts` needs to change for this plan** — confirmed by reading it: `AetherState` gains no new fields, so its whitelist is untouched. This is verified explicitly in Task 7, breaking with every prior plan's "check whether the whitelist needs a new field" precedent for the first time, because Chat's data was never part of `AetherState` to begin with.
- **Channel selection (`activeChannelId`) is view-local `useState`, not a reducer action** — a deliberate call, not an oversight. `state.selected` (written by `SELECT_AGENT`, read by `AgentsView`/Grid) answers "which agent is currently selected" for the Agents/Grid views; Chat's "which channel is open right now" is a different axis of state entirely — a channel can be AETHER (no agent at all), and even for an agent-channel, "I have this agent's chat window open" is not the same fact as "this agent is selected in the Agents roster." Conflating the two fields would make one view's navigation silently change the other's. `useChatChannels` (Task 5) owns this as its own `useState`, never touching `state.selected`.
- **Channel `id` is the agent's `name`, not `Agent.i`** — confirmed by reading `src/state/types.ts`: `Agent.i` is a 2-letter initials code with no uniqueness guarantee against other agents or idle-pool entries, whereas `name` is what `SELECT_AGENT`, `agentApprovals`, and every prior plan's per-agent lookups already key on. Consistent with that established precedent.
- **Archived-channel detection needs no new state at all — confirmed by reading `src/state/reducer.ts`'s `REACTIVATE_AGENT`/terminal `kill` command.** An agent moves from `state.agents` to `state.idleList` on termination and back on reactivation; a channel is archived if and only if its name is currently in `idleList` rather than `agents`, recomputed fresh on every render via `deriveChannels(state)`. This is a genuine, load-bearing simplification worth calling out: it means the app's two seed `idleList` entries (`Web Scraper`, `Doc Helper`, present from first load per `src/state/initialState.ts` — confirmed by reading it) show up as pre-archived channels immediately, with full history if any exists — which is correct by the same logic ("not currently active" is "not currently active," regardless of whether that's because it was just killed this session or seeded idle from the start), not a bug to special-case around.
- **`localResponder`'s design is this plan's own, not spec'd by the designer** (the designer's spec only requires that it exist as Phase 2's offline fallback). It's a keyword-driven switch in the same spirit as `src/components/terminal/commands.ts`'s `runCommand` — canned-but-contextual, not a randomly-cycled generic pool — and is genuinely state-aware: the AETHER channel references live burn rate/budget/alarm level/roster/approvals; a per-agent channel references that specific agent's task/pct/eta/files/paused state. It is the one piece of interesting, fully-tested pure logic in this plan.
- **`askClaude(system, messages)` exists now as a clearly-labeled, always-`null` stub** (`src/components/chat/claudeClient.ts`), called for real by the message-send flow on every send — not dead code waiting for Phase 2. Phase 2 replaces only this function's internals (a real `fetch('/api/chat', …)`); the call site and its "fall back to `localResponder` on `null`/rejection" branch do not change. The exact contents of the system-prompt string passed to it in Phase 1 (`useChatChannels.ts`) is an inert one-line placeholder, since Phase 1 never actually inspects it — the real Persona/state-snapshot/Rules construction is explicitly Phase 2 scope; only the *signature* (`system: string, messages: ChatTurn[]`) is load-bearing here.
- **Unread badges are minimal-but-real, not a stub.** Phase 1 has no proactive/background messaging — a channel's history only ever grows in response to a message the user typed into it. The one real scenario this plan's unread counter needs to handle correctly is: user sends a message in channel A, switches to channel B before the reply lands, and the reply arrives while A is no longer open — that increments A's badge; opening a channel clears its own badge. This is exercised via a ref (not the state closure) tracking which channel is open at reply-resolution time, documented at the point of use in Task 5.
- **Zero-active-agent and just-terminated-channel cases are explicit, not incidental:** `deriveChannels` returns just the AETHER channel (plus any archived channels already in `idleList`) when `state.agents` is empty — asserted directly in `chatChannels.test.ts` — and `localResponder` for a channel whose agent is no longer in `state.agents` (i.e. it's now archived) returns an honest "offline/archived" line rather than crashing on a missing agent lookup — also asserted directly.
- Match established visual/style conventions exactly: inline `CSSProperties` consts, `colors`/`fonts` tokens from `src/styles/tokens.ts` (confirmed: `accentCyanSoft` = `#7fd8ef`, `accentCyanDeep` = `#17b8d8`, `textBody` = `#d8f6ff`, `textDim`/`textMuted`/`textSecondary`/`textPrimary`/`danger`/`warn`/`success`/`panelBorder`/`panelGradient`/`chromeBorder` all present as read directly from the file), the avatar/track/badge visual language `AgentRosterCard.tsx`/`ChannelRail`'s closest sibling already established, and the master-detail two-column layout shape `AgentsView.tsx` established (rail + detail, same as this plan's rail + thread).
- No new dependencies, no backend/server work of any kind in this plan.
- New pure-logic modules (`chatChannels.ts`, `chatPersistence.ts`, `claudeClient.ts`, `localResponder.ts`) get Vitest coverage. The presentational shell (`ChannelRail`, `MessageThread`, `MessageInput`, `TypingIndicator`, `ChatView`) and the side-effectful `useChatChannels` hook have no new pure logic of their own and are verified via the dev server, per this project's established precedent (`store.tsx`, `useReactorCanvas`, `ReactorStatusCard`, `AgentRosterCard`, etc. all skip unit tests for the same reason).
- Run `npm test`, `npx tsc -b`, and `npm run build` clean before every commit. Baseline going into this plan: **92 passing tests across 11 files** (confirmed via `npm test` before starting).

---

## File Structure

```
aether-os/
  src/
    components/
      chat/
        chatChannels.ts          NEW — channel model + derivation (AETHER + active + archived), tested
        chatChannels.test.ts     NEW
        chatPersistence.ts       NEW — per-channel localStorage (aether-chat-<id>, capped 50), tested
        chatPersistence.test.ts  NEW
        claudeClient.ts          NEW — askClaude Phase-2 seam (always-null stub) + toRecentTurns, tested
        claudeClient.test.ts     NEW
        localResponder.ts        NEW — keyword-driven, state-aware fallback responder, tested
        localResponder.test.ts   NEW
        TypingIndicator.tsx      NEW — three pulsing dots in channel accent color
        ChannelRail.tsx          NEW — left rail: channel list, unread badges, archived/TERMINATED styling
        MessageThread.tsx        NEW — scrolling message list + typing indicator
        MessageInput.tsx         NEW — text input + send button, disabled/read-only when archived
        useChatChannels.ts       NEW — message-send flow hook (side-effectful; verified via dev server)
        ChatView.tsx             NEW — composition, mounted by the view registry
    styles/
      global.css                 MODIFIED — add @keyframes typingPulse
    viewRegistry.ts               MODIFIED — flip Chat's component from null to ChatView
    viewRegistry.test.ts          MODIFIED — test that Chat now resolves

```

---

### Task 1: Chat channel model & per-channel persistence

The state/persistence module this whole plan is built on: channel derivation (pure, needs only `AetherState`) and per-channel message storage (pure aside from `localStorage` itself, same "best-effort, never throws" shape as `src/state/persistence.ts`).

**Files:**
- Create: `src/components/chat/chatChannels.ts`
- Test: `src/components/chat/chatChannels.test.ts`
- Create: `src/components/chat/chatPersistence.ts`
- Test: `src/components/chat/chatPersistence.test.ts`

**Interfaces:**
- Consumes: `AetherState` from `../../state/types`; `colors` from `../../styles/tokens`.
- Produces: `ChatChannel` type, `AETHER_CHANNEL_ID`, `deriveChannels(state: AetherState): ChatChannel[]`, `findChannel(channels, id): ChatChannel | null` — consumed by every later task. `ChatMessage` type, `MAX_MESSAGES_PER_CHANNEL`, `loadChannelMessages(channelId): ChatMessage[]`, `saveChannelMessages(channelId, messages): void`, `appendChannelMessage(channelId, existing, message): ChatMessage[]` — consumed by Task 5's `useChatChannels`.

- [ ] **Step 1: Write the failing tests**

`src/components/chat/chatChannels.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AETHER_CHANNEL_ID, deriveChannels, findChannel } from './chatChannels';
import { initialState } from '../../state/initialState';
import { colors } from '../../styles/tokens';
import type { AetherState } from '../../state/types';

describe('deriveChannels', () => {
  it('always puts AETHER first, unarchived', () => {
    const channels = deriveChannels(initialState);
    expect(channels[0]).toMatchObject({ id: AETHER_CHANNEL_ID, kind: 'aether', archived: false });
  });

  it('adds one unarchived channel per active agent, in roster order', () => {
    const channels = deriveChannels(initialState);
    const agentChannels = channels.filter((c) => c.kind === 'agent' && !c.archived);
    expect(agentChannels.map((c) => c.id)).toEqual(initialState.agents.map((a) => a.name));
    expect(agentChannels.every((c) => c.hue !== colors.textMuted)).toBe(true);
  });

  it('adds one archived, muted-hue channel per idle agent', () => {
    const channels = deriveChannels(initialState);
    const archivedChannels = channels.filter((c) => c.archived);
    expect(archivedChannels.map((c) => c.id)).toEqual(initialState.idleList.map((i) => i.name));
    expect(archivedChannels.every((c) => c.hue === colors.textMuted)).toBe(true);
  });

  it('returns only AETHER when there are no active or idle agents', () => {
    const empty: AetherState = { ...initialState, agents: [], idleList: [] };
    expect(deriveChannels(empty)).toEqual([
      { id: AETHER_CHANNEL_ID, kind: 'aether', name: 'AETHER', initials: 'AE', hue: colors.accentCyanSoft, archived: false },
    ]);
  });
});

describe('findChannel', () => {
  it('finds a channel by id', () => {
    expect(findChannel(deriveChannels(initialState), 'Code Builder')?.name).toBe('Code Builder');
  });

  it('returns null for an unknown id', () => {
    expect(findChannel(deriveChannels(initialState), 'Nobody')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- chatChannels`
Expected: FAIL — `chatChannels.ts` doesn't exist yet.

- [ ] **Step 3: Implement `src/components/chat/chatChannels.ts`**

```ts
import type { AetherState } from '../../state/types';
import { colors } from '../../styles/tokens';

export const AETHER_CHANNEL_ID = 'AETHER';

export interface ChatChannel {
  id: string;
  kind: 'aether' | 'agent';
  name: string;
  initials: string;
  hue: string;
  archived: boolean;
}

function agentInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

// The channel list is derived fresh from live state on every call, not
// tracked in a separate registry: a channel is active exactly while its
// agent is in `state.agents`, and becomes archived the instant that agent
// moves to `state.idleList` (kill/terminate) -- and back to active on
// reactivation. This also means the app's seed idle agents show up as
// pre-archived channels from first load, correctly, since "idle" already
// means "not currently active" regardless of *why*. Idle agents don't carry
// a `hue` (that data doesn't survive termination), so archived channels get a
// flat muted tone -- which also happens to be the "greyed out" look the
// design spec calls for.
export function deriveChannels(state: AetherState): ChatChannel[] {
  const aether: ChatChannel = {
    id: AETHER_CHANNEL_ID,
    kind: 'aether',
    name: 'AETHER',
    initials: 'AE',
    hue: colors.accentCyanSoft,
    archived: false,
  };

  const activeChannels: ChatChannel[] = state.agents.map((a) => ({
    id: a.name,
    kind: 'agent',
    name: a.name,
    initials: a.i,
    hue: a.hue,
    archived: false,
  }));

  const archivedChannels: ChatChannel[] = state.idleList.map((idle) => ({
    id: idle.name,
    kind: 'agent',
    name: idle.name,
    initials: agentInitials(idle.name),
    hue: colors.textMuted,
    archived: true,
  }));

  return [aether, ...activeChannels, ...archivedChannels];
}

export function findChannel(channels: ChatChannel[], id: string): ChatChannel | null {
  return channels.find((c) => c.id === id) ?? null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- chatChannels`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing tests for persistence**

`src/components/chat/chatPersistence.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendChannelMessage, loadChannelMessages, MAX_MESSAGES_PER_CHANNEL, saveChannelMessages } from './chatPersistence';
import type { ChatMessage } from './chatPersistence';

beforeEach(() => {
  localStorage.clear();
});

function msg(text: string, role: ChatMessage['role'] = 'user'): ChatMessage {
  return { id: `${text}-${Math.random()}`, role, text, t: '00:00' };
}

describe('chatPersistence', () => {
  it('round-trips messages through a per-channel localStorage key', () => {
    saveChannelMessages('AETHER', [msg('hello'), msg('hi there', 'assistant')]);
    const loaded = loadChannelMessages('AETHER');
    expect(loaded).toHaveLength(2);
    expect(loaded[0].text).toBe('hello');
  });

  it("keeps channels independent — one channel's history does not leak into another", () => {
    saveChannelMessages('AETHER', [msg('a')]);
    saveChannelMessages('Code Builder', [msg('b')]);
    expect(loadChannelMessages('AETHER')).toHaveLength(1);
    expect(loadChannelMessages('Code Builder')).toHaveLength(1);
    expect(loadChannelMessages('AETHER')[0].text).toBe('a');
  });

  it('returns an empty array when nothing is stored for a channel', () => {
    expect(loadChannelMessages('Nobody')).toEqual([]);
  });

  it('returns an empty array on malformed JSON instead of throwing', () => {
    localStorage.setItem('aether-chat-AETHER', '{not json');
    expect(loadChannelMessages('AETHER')).toEqual([]);
  });

  it('does not throw when localStorage.setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => saveChannelMessages('AETHER', [msg('x')])).not.toThrow();
    vi.restoreAllMocks();
  });

  it('appendChannelMessage caps history at 50, dropping the oldest first', () => {
    let history: ChatMessage[] = [];
    for (let i = 0; i < 55; i++) {
      history = appendChannelMessage('AETHER', history, msg(`m${i}`));
    }
    expect(history).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
    expect(history[0].text).toBe('m5');
    expect(history[49].text).toBe('m54');
    expect(loadChannelMessages('AETHER')).toHaveLength(MAX_MESSAGES_PER_CHANNEL);
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npm test -- chatPersistence`
Expected: FAIL — `chatPersistence.ts` doesn't exist yet.

- [ ] **Step 7: Implement `src/components/chat/chatPersistence.ts`**

```ts
export interface ChatMessage {
  id: string;
  // 'system' is reserved for a future (Phase 2) action-confirmation/denial
  // line inserted by the action-execution pipeline — Phase 1 only ever
  // produces 'user' and 'assistant' messages, but the type carries the third
  // option now so Phase 2 doesn't need to touch this shape.
  role: 'user' | 'assistant' | 'system';
  text: string;
  t: string;
}

export const MAX_MESSAGES_PER_CHANNEL = 50;

function storageKey(channelId: string): string {
  return `aether-chat-${channelId}`;
}

export function loadChannelMessages(channelId: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(storageKey(channelId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

export function saveChannelMessages(channelId: string, messages: ChatMessage[]): void {
  try {
    localStorage.setItem(storageKey(channelId), JSON.stringify(messages.slice(-MAX_MESSAGES_PER_CHANNEL)));
  } catch {
    // localStorage unavailable (private mode, quota) — same best-effort precedent as state/persistence.ts
  }
}

export function appendChannelMessage(channelId: string, existing: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const next = [...existing, message].slice(-MAX_MESSAGES_PER_CHANNEL);
  saveChannelMessages(channelId, next);
  return next;
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -- chatPersistence`
Expected: PASS, 6 tests.

- [ ] **Step 9: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (104 total: 92 existing + 12 new), 0 type errors.

- [ ] **Step 10: Commit**

```bash
git add src/components/chat/chatChannels.ts src/components/chat/chatChannels.test.ts src/components/chat/chatPersistence.ts src/components/chat/chatPersistence.test.ts
git commit -m "feat: add Chat channel derivation and per-channel localStorage persistence"
```

---

### Task 2: `askClaude` Phase-2 seam (always-null stub) + recent-turns helper

The exact call-site shape Phase 2 lands on, kept genuinely exercised (not dead code) by Task 5's send flow always awaiting it.

**Files:**
- Create: `src/components/chat/claudeClient.ts`
- Test: `src/components/chat/claudeClient.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` from `./chatPersistence`.
- Produces: `ChatTurn` type, `askClaude(system: string, messages: ChatTurn[]): Promise<string | null>`, `toRecentTurns(messages: ChatMessage[], limit?: number): ChatTurn[]` — consumed by Task 5's `useChatChannels`.

- [ ] **Step 1: Write the failing tests**

`src/components/chat/claudeClient.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { askClaude, toRecentTurns } from './claudeClient';
import type { ChatMessage } from './chatPersistence';

function msg(role: ChatMessage['role'], text: string): ChatMessage {
  return { id: text, role, text, t: '00:00' };
}

describe('askClaude', () => {
  it('is an unimplemented Phase 2 seam that always resolves to null in Phase 1', async () => {
    await expect(askClaude('system prompt', [{ role: 'user', text: 'hi' }])).resolves.toBeNull();
  });

  it('never throws regardless of input, so the send-flow fallback is safe to await unconditionally', async () => {
    await expect(askClaude('', [])).resolves.toBeNull();
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
Expected: FAIL — `claudeClient.ts` doesn't exist yet.

- [ ] **Step 3: Implement `src/components/chat/claudeClient.ts`**

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

// Phase 2 (a separate, future plan) replaces this stub's internals with a
// real call to a Vite dev-server middleware proxy (`POST /api/chat`) that
// forwards `{ system, messages }` to the Anthropic Messages API — never
// exposing the API key client-side. This function's signature, and the
// message-send flow's "on failure, fall back to `localResponder`" branch
// (see `useChatChannels.ts`), are the seam Phase 2 lands on; only what runs
// inside this function's body changes then. In Phase 1 it always resolves to
// `null`, so that fallback path is real, exercised code today, not dead code.
export async function askClaude(_system: string, _messages: ChatTurn[]): Promise<string | null> {
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- claudeClient`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (108 total), 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/claudeClient.ts src/components/chat/claudeClient.test.ts
git commit -m "feat: add the askClaude Phase-2 seam as an always-null, genuinely-called stub"
```

---

### Task 3: `localResponder` — the state-aware fallback responder

The one piece of interesting logic in this plan. A keyword-driven switch, in the same spirit as `commands.ts`'s `runCommand`, that reacts to both what's typed and to the channel's live state.

**Files:**
- Create: `src/components/chat/localResponder.ts`
- Test: `src/components/chat/localResponder.test.ts`

**Interfaces:**
- Consumes: `AetherState` from `../../state/types`; `ChatChannel` from `./chatChannels`; `fmt`, `fmtEta` from `../../utils/format`.
- Produces: `localResponder(channel: ChatChannel, text: string, state: AetherState): string` — consumed by Task 5's `useChatChannels` as the offline/failure fallback.

- [ ] **Step 1: Write the failing tests**

`src/components/chat/localResponder.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { localResponder } from './localResponder';
import { AETHER_CHANNEL_ID, deriveChannels } from './chatChannels';
import { initialState } from '../../state/initialState';
import type { AetherState } from '../../state/types';

const channels = deriveChannels(initialState);
const aether = channels.find((c) => c.id === AETHER_CHANNEL_ID)!;
const codeBuilder = channels.find((c) => c.id === 'Code Builder')!;
const webScraper = channels.find((c) => c.id === 'Web Scraper')!; // archived (idle) channel

describe('localResponder — AETHER channel', () => {
  it('reports the live burn rate and active agent count', () => {
    const reply = localResponder(aether, "what's the burn rate?", initialState);
    expect(reply).toContain('92,000 tok/min');
    expect(reply).toContain('5 active agents');
  });

  it('reports remaining budget against the configured cap', () => {
    const reply = localResponder(aether, "how's our budget looking", initialState);
    expect(reply).toContain('2.0M cap');
  });

  it('reports a nominal reactor status with the pending approval count', () => {
    const reply = localResponder(aether, 'give me a status report', initialState);
    expect(reply).toContain('Reactor status: nominal');
    expect(reply).toContain('2 pending authorizations');
  });

  it('reports a critical reactor status when the alarm level is crit', () => {
    const critState: AetherState = { ...initialState, alarmLevel: 'crit' };
    const reply = localResponder(aether, 'status check', critState);
    expect(reply).toContain('Reactor status: critical');
  });

  it('lists the active roster by name', () => {
    const reply = localResponder(aether, "who's on the team right now", initialState);
    expect(reply).toContain('Code Builder');
    expect(reply).toContain('5 active');
  });

  it('reports an empty roster honestly instead of an empty list', () => {
    const empty: AetherState = { ...initialState, agents: [] };
    const reply = localResponder(aether, "who's active", empty);
    expect(reply).toContain('No agents are active');
  });

  it('greets in character', () => {
    const reply = localResponder(aether, 'hey', initialState);
    expect(reply).toContain('AETHER online');
  });

  it('falls back to an echo-and-hint reply for unrecognized input', () => {
    const reply = localResponder(aether, "what's your favorite color", initialState);
    expect(reply).toContain('favorite color');
    expect(reply.toLowerCase()).toContain('burn rate');
  });
});

describe('localResponder — per-agent channel', () => {
  it("reports the agent's own progress and ETA", () => {
    const reply = localResponder(codeBuilder, "how's it going", initialState);
    expect(reply).toContain('62% through "Refactoring auth middleware"');
    expect(reply).toContain('ETA 4m');
  });

  it("lists the agent's touched files", () => {
    const reply = localResponder(codeBuilder, 'what files have you touched', initialState);
    expect(reply).toContain('routes/auth.js');
    expect(reply).toContain('middleware/session.js');
  });

  it('reports no files touched yet when the file list is empty', () => {
    const freshAgent: AetherState = {
      ...initialState,
      agents: initialState.agents.map((a) => (a.name === 'Code Builder' ? { ...a, files: [] } : a)),
    };
    const reply = localResponder(codeBuilder, 'any files yet', freshAgent);
    expect(reply).toContain('No files touched yet');
  });

  it('describes the current task', () => {
    const reply = localResponder(codeBuilder, "what's your mission", initialState);
    expect(reply).toContain('Current task: "Refactoring auth middleware"');
  });

  it('reports still running when asked to pause but not yet paused', () => {
    const reply = localResponder(codeBuilder, 'can you hold for a sec', initialState);
    expect(reply).toContain('Still running');
  });

  it('reports paused status when the agent is paused', () => {
    const pausedState: AetherState = {
      ...initialState,
      agents: initialState.agents.map((a) => (a.name === 'Code Builder' ? { ...a, paused: true } : a)),
    };
    const reply = localResponder(codeBuilder, 'are you paused', pausedState);
    expect(reply).toContain("I'm paused");
  });

  it('greets in character with its own name and progress', () => {
    const reply = localResponder(codeBuilder, 'hello', initialState);
    expect(reply).toContain('Code Builder here');
  });

  it('reports offline for an archived (terminated) channel instead of guessing', () => {
    const reply = localResponder(webScraper, 'status?', initialState);
    expect(reply).toContain('Web Scraper is offline');
    expect(reply).toContain('archived');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- localResponder`
Expected: FAIL — `localResponder.ts` doesn't exist yet.

- [ ] **Step 3: Implement `src/components/chat/localResponder.ts`**

```ts
import type { AetherState } from '../../state/types';
import type { ChatChannel } from './chatChannels';
import { fmt, fmtEta } from '../../utils/format';

// The one piece of "interesting" logic in Phase 1: a keyword-driven,
// state-aware canned responder, in the same spirit as
// `components/terminal/commands.ts`'s `runCommand` -- a switch over
// recognized phrases producing contextual (not randomly-cycled) text. Phase 2
// treats this as the offline/failure fallback for the real Claude-backed
// responder (see `useChatChannels.ts`), so it must always return *something*
// usable, never throw, and never return an empty string.
function aetherReply(text: string, state: AetherState): string {
  const t = text.toLowerCase();
  const agentCount = state.agents.length;

  if (/budget|spend|\bcap\b|cost/.test(t)) {
    const remaining = Math.max(0, state.cfg.capM * 1e6 - state.used);
    return `${fmt(remaining)} tokens remain of the ${state.cfg.capM.toFixed(1)}M cap — depletes in ${fmtEta(remaining / (state.rate / 60))} at the current draw.`;
  }
  if (/burn|\brate\b|\btok/.test(t)) {
    return `Burn rate holding at ${fmt(state.rate)} tok/min across ${agentCount} active agent${agentCount === 1 ? '' : 's'}.`;
  }
  if (/alarm|alert|health|status/.test(t)) {
    const label = state.alarmLevel === 'crit' ? 'critical' : state.alarmLevel === 'warn' ? 'elevated' : 'nominal';
    return `Reactor status: ${label}. ${agentCount} agent${agentCount === 1 ? '' : 's'} active, ${state.approvals.length} pending authorization${state.approvals.length === 1 ? '' : 's'}.`;
  }
  if (/agent|team|roster|\bwho\b/.test(t)) {
    if (!agentCount) return 'No agents are active right now. Spawn one from Terminal, Dashboard, or Agents to get started.';
    return `${agentCount} active: ${state.agents.map((a) => a.name).join(', ')}.`;
  }
  if (/approv|pending|queue/.test(t)) {
    return state.approvals.length
      ? `${state.approvals.length} request${state.approvals.length === 1 ? '' : 's'} pending authorization — check the queue.`
      : 'Approval queue is clear.';
  }
  if (/\b(hi|hello|hey)\b/.test(t)) {
    return 'AETHER online. State your query — burn rate, budget, roster, or approvals.';
  }
  if (/thanks|thank you/.test(t)) {
    return 'Acknowledged.';
  }
  return `Acknowledged: "${text.trim().slice(0, 60)}". Ask about burn rate, budget, roster, or approvals for a live readout.`;
}

function agentReply(channel: ChatChannel, text: string, state: AetherState): string {
  const agent = state.agents.find((a) => a.name === channel.name);
  if (!agent) {
    return `${channel.name} is offline — this channel is archived. Reactivate the agent from the Agents view to resume the conversation.`;
  }
  const t = text.toLowerCase();
  if (/status|how|progress|going/.test(t)) {
    return `${Math.round(agent.pct)}% through "${agent.task}", ETA ${agent.eta}.`;
  }
  if (/file|touch|working on/.test(t)) {
    if (!agent.files.length) return `No files touched yet — still ${agent.task.toLowerCase()}.`;
    return `Touched ${agent.files.length} file${agent.files.length === 1 ? '' : 's'}: ${agent.files.map((f) => f.n).join(', ')}.`;
  }
  if (/task|doing|job|mission/.test(t)) {
    return `Current task: "${agent.task}" — ${Math.round(agent.pct)}% complete.`;
  }
  if (/pause|stop|hold/.test(t)) {
    return agent.paused
      ? "I'm paused — resume me from the Agents view when you're ready."
      : 'Still running. Pause me from the Agents view if you need me to hold.';
  }
  if (/\b(hi|hello|hey)\b/.test(t)) {
    return `${agent.name} here — ${Math.round(agent.pct)}% through "${agent.task}".`;
  }
  if (/thanks|thank you/.test(t)) {
    return 'On it.';
  }
  return `Noted: "${text.trim().slice(0, 60)}". Currently ${Math.round(agent.pct)}% through "${agent.task}".`;
}

export function localResponder(channel: ChatChannel, text: string, state: AetherState): string {
  return channel.kind === 'aether' ? aetherReply(text, state) : agentReply(channel, text, state);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- localResponder`
Expected: PASS, 16 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (124 total), 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/localResponder.ts src/components/chat/localResponder.test.ts
git commit -m "feat: add the state-aware localResponder fallback (AETHER + per-agent replies)"
```

---

### Task 4: Leaf presentational components — `TypingIndicator` + `ChannelRail`

Built bottom-up: the typing indicator has no dependencies on anything else in this plan, so it comes first, followed by the channel rail (depends only on `ChatChannel[]`, no message data).

**Files:**
- Modify: `src/styles/global.css` (add `@keyframes typingPulse`)
- Create: `src/components/chat/TypingIndicator.tsx`
- Create: `src/components/chat/ChannelRail.tsx`

**Interfaces:**
- Consumes: `colors`, `fonts` from `../../styles/tokens`; `ChatChannel` from `./chatChannels`.
- Produces: `TypingIndicator({ hue }: { hue: string })`, `ChannelRail({ channels, activeChannelId, unreadCounts, onSelect })` — mounted by Task 6's `ChatView`.

No new unit-testable logic — verify via dev server.

- [ ] **Step 1: Add the typing-pulse keyframe to `src/styles/global.css`**

Insert immediately after the existing `@keyframes dashFlowRev` block:

```css
@keyframes typingPulse {
  0%,
  80%,
  100% {
    opacity: 0.35;
    transform: scale(0.85);
  }
  40% {
    opacity: 1;
    transform: scale(1.15);
  }
}
```

- [ ] **Step 2: Implement `src/components/chat/TypingIndicator.tsx`**

```tsx
import type { CSSProperties } from 'react';

export function TypingIndicator({ hue }: { hue: string }) {
  return (
    <div style={wrapStyle}>
      <span style={dotStyle(hue, 0)} />
      <span style={dotStyle(hue, 0.15)} />
      <span style={dotStyle(hue, 0.3)} />
    </div>
  );
}

const wrapStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, padding: '8px 2px' };

function dotStyle(hue: string, delay: number): CSSProperties {
  return {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: hue,
    boxShadow: `0 0 6px ${hue}`,
    animation: `typingPulse 1.1s ease-in-out ${delay}s infinite`,
  };
}
```

- [ ] **Step 3: Implement `src/components/chat/ChannelRail.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import type { ChatChannel } from './chatChannels';

interface ChannelRailProps {
  channels: ChatChannel[];
  activeChannelId: string;
  unreadCounts: Record<string, number>;
  onSelect: (id: string) => void;
}

export function ChannelRail({ channels, activeChannelId, unreadCounts, onSelect }: ChannelRailProps) {
  return (
    <div style={railStyle}>
      <div style={titleStyle}>CHANNELS</div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {channels.map((c) => {
          const on = c.id === activeChannelId;
          const unread = unreadCounts[c.id] ?? 0;
          return (
            <div key={c.id} onClick={() => onSelect(c.id)} style={rowStyle(on, c.archived)}>
              <span style={avatarStyle(c.hue)}>{c.initials}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={nameStyle(c.archived)}>{c.name}</div>
                {c.archived && <div style={terminatedTagStyle}>TERMINATED</div>}
              </div>
              {!!unread && <span style={unreadBadgeStyle}>{unread}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const railStyle: CSSProperties = {
  width: 220,
  flex: 'none',
  padding: 15,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
function rowStyle(on: boolean, archived: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    padding: '8px 9px',
    borderRadius: 9,
    cursor: 'pointer',
    opacity: archived ? 0.55 : 1,
    background: on ? 'rgba(23,184,216,.14)' : undefined,
    border: on ? '1px solid rgba(95,220,255,.4)' : '1px solid transparent',
  };
}
function avatarStyle(hue: string): CSSProperties {
  return {
    width: 26,
    height: 26,
    flex: 'none',
    borderRadius: 7,
    background: 'repeating-linear-gradient(45deg,#0e3340 0 4px,#123f4e 4px 8px)',
    border: `1px solid ${hue}`,
    display: 'grid',
    placeItems: 'center',
    font: `700 10px/1 ${fonts.mono}`,
    color: hue,
  };
}
function nameStyle(archived: boolean): CSSProperties {
  return {
    font: `600 13px/1 ${fonts.ui}`,
    color: archived ? colors.textMuted : colors.textPrimary,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}
const terminatedTagStyle: CSSProperties = { marginTop: 2, font: `600 8px/1 ${fonts.ui}`, letterSpacing: 1, color: colors.textDim };
const unreadBadgeStyle: CSSProperties = {
  flex: 'none',
  minWidth: 16,
  height: 16,
  padding: '0 4px',
  borderRadius: 8,
  background: colors.accentCyanDeep,
  color: '#04202b',
  font: `700 10px/16px ${fonts.mono}`,
  textAlign: 'center',
};
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/styles/global.css src/components/chat/TypingIndicator.tsx src/components/chat/ChannelRail.tsx
git commit -m "feat: build the Chat view's typing indicator and channel rail"
```

---

### Task 5: `MessageThread` + `MessageInput` + `useChatChannels` (the message-send flow)

The message flow itself: optimistic user-message render, typing indicator, `askClaude` attempt, fallback to `localResponder` prefixed `[offline]`, per-channel persistence, and unread-badge bookkeeping for the one real cross-channel scenario Phase 1 supports.

**Files:**
- Create: `src/components/chat/MessageThread.tsx`
- Create: `src/components/chat/MessageInput.tsx`
- Create: `src/components/chat/useChatChannels.ts`

**Interfaces:**
- Consumes: `colors`, `fonts` from `../../styles/tokens`; `ChatChannel` from `./chatChannels`; `ChatMessage` from `./chatPersistence`; `TypingIndicator` from `./TypingIndicator`; `AetherState` from `../../state/types`; `deriveChannels`, `findChannel`, `AETHER_CHANNEL_ID` from `./chatChannels`; `loadChannelMessages`, `appendChannelMessage` from `./chatPersistence`; `askClaude`, `toRecentTurns` from `./claudeClient`; `localResponder` from `./localResponder`; `nowShort` from `../../utils/format`.
- Produces: `MessageThread({ channel, messages, isTyping })`, `MessageInput({ value, onChange, onSend, disabled, placeholder })`, `useChatChannels(state: AetherState): UseChatChannelsResult` — the last consumed by Task 6's `ChatView`.

No new unit-testable logic (the pure pieces it composes are already tested in Tasks 1–3) — verify via dev server.

- [ ] **Step 1: Implement `src/components/chat/MessageThread.tsx`**

```tsx
import { useEffect, useRef, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import type { ChatChannel } from './chatChannels';
import type { ChatMessage } from './chatPersistence';
import { TypingIndicator } from './TypingIndicator';

interface MessageThreadProps {
  channel: ChatChannel;
  messages: ChatMessage[];
  isTyping: boolean;
}

export function MessageThread({ channel, messages, isTyping }: MessageThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, isTyping]);

  return (
    <div ref={scrollRef} style={threadStyle}>
      {!messages.length && (
        <div style={emptyStyle}>
          {channel.archived
            ? `${channel.name} is archived — this is the full history from before it went idle.`
            : `Say hello to ${channel.name} to start the conversation.`}
        </div>
      )}
      {messages.map((m) => (
        <div key={m.id} style={rowStyle(m.role)}>
          <div style={metaRowStyle}>
            <span style={labelStyle(m.role === 'user' ? colors.textSecondary : channel.hue)}>{m.role === 'user' ? 'YOU' : channel.name}</span>
            <span style={{ color: colors.textDim, font: `400 10px/1 ${fonts.mono}` }}>{m.t}</span>
          </div>
          <div style={textStyle}>{m.text}</div>
        </div>
      ))}
      {isTyping && <TypingIndicator hue={channel.hue} />}
    </div>
  );
}

const threadStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 2px', display: 'flex', flexDirection: 'column', gap: 12 };
const emptyStyle: CSSProperties = { font: `400 12px/1.6 ${fonts.ui}`, color: colors.textMuted, padding: '8px 2px' };
function rowStyle(role: ChatMessage['role']): CSSProperties {
  return { display: 'flex', flexDirection: 'column', alignItems: role === 'user' ? 'flex-end' : 'flex-start' };
}
const metaRowStyle: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 8 };
function labelStyle(color: string): CSSProperties {
  return { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 1.5, color };
}
const textStyle: CSSProperties = {
  marginTop: 5,
  maxWidth: '80%',
  font: `400 13px/1.5 ${fonts.ui}`,
  color: colors.textBody,
  padding: '9px 12px',
  borderRadius: 10,
  border: `1px solid ${colors.chromeBorder}`,
  background: 'rgba(6,20,28,.55)',
};
```

- [ ] **Step 2: Implement `src/components/chat/MessageInput.tsx`**

```tsx
import type { CSSProperties, KeyboardEvent } from 'react';
import { colors, fonts } from '../../styles/tokens';

interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
  placeholder: string;
}

export function MessageInput({ value, onChange, onSend, disabled, placeholder }: MessageInputProps) {
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') onSend();
  }

  return (
    <div style={barStyle}>
      <div style={rowStyle}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          style={inputStyle}
        />
        <span onClick={disabled ? undefined : onSend} style={sendButtonStyle(disabled)}>
          ➤
        </span>
      </div>
    </div>
  );
}

const barStyle: CSSProperties = { flex: 'none', paddingTop: 12 };
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderRadius: 10,
  border: '1px solid rgba(80,190,220,.3)',
  background: 'rgba(6,20,28,.7)',
};
const inputStyle: CSSProperties = {
  flex: 1,
  font: `400 13px/1 ${fonts.ui}`,
  color: colors.textBody,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  caretColor: colors.accentCyan,
};
function sendButtonStyle(disabled: boolean): CSSProperties {
  return {
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    width: 30,
    height: 30,
    borderRadius: 8,
    background: 'linear-gradient(180deg,#17b8d8,#0f7f97)',
    display: 'grid',
    placeItems: 'center',
    color: colors.textPrimary,
    boxShadow: disabled ? 'none' : '0 0 14px rgba(95,240,255,.5)',
  };
}
```

- [ ] **Step 3: Implement `src/components/chat/useChatChannels.ts`**

```ts
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AetherState } from '../../state/types';
import { AETHER_CHANNEL_ID, deriveChannels, findChannel, type ChatChannel } from './chatChannels';
import { appendChannelMessage, loadChannelMessages, type ChatMessage } from './chatPersistence';
import { askClaude, toRecentTurns } from './claudeClient';
import { localResponder } from './localResponder';
import { nowShort } from '../../utils/format';

function makeMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface UseChatChannelsResult {
  channels: ChatChannel[];
  activeChannel: ChatChannel;
  activeChannelId: string;
  setActiveChannelId: (id: string) => void;
  messages: ChatMessage[];
  isTyping: boolean;
  unreadCounts: Record<string, number>;
  sendMessage: (text: string) => void;
}

// Owns the one piece of view-local, non-AetherState state this plan
// establishes as its own concept: which chat channel is currently open. This
// is deliberately NOT `state.selected`/`SELECT_AGENT` (that's "which agent is
// selected" for Grid/Agents) — Chat's "which channel is open" is a different
// axis entirely and would be wrong to conflate just because both happen to
// name an agent. See Global Constraints.
export function useChatChannels(state: AetherState): UseChatChannelsResult {
  const channels = useMemo(() => deriveChannels(state), [state.agents, state.idleList]);
  const [activeChannelId, setActiveChannelId] = useState<string>(AETHER_CHANNEL_ID);
  const [messagesByChannel, setMessagesByChannel] = useState<Record<string, ChatMessage[]>>({});
  const [typingChannelIds, setTypingChannelIds] = useState<Set<string>>(new Set());
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});

  // Tracked in a ref (not read from the `activeChannelId` state closure)
  // because a reply can resolve well after the user has switched to a
  // different channel — the unread bump below must check which channel is
  // open *at resolution time*, not at send time.
  const activeChannelIdRef = useRef(activeChannelId);
  useEffect(() => {
    activeChannelIdRef.current = activeChannelId;
  }, [activeChannelId]);

  // Lazy-load a channel's history from its own localStorage key the first
  // time it's opened, and clear its unread badge on open.
  useEffect(() => {
    setMessagesByChannel((prev) => (prev[activeChannelId] ? prev : { ...prev, [activeChannelId]: loadChannelMessages(activeChannelId) }));
    setUnreadCounts((prev) => (prev[activeChannelId] ? { ...prev, [activeChannelId]: 0 } : prev));
  }, [activeChannelId]);

  const activeChannel = findChannel(channels, activeChannelId) ?? channels[0];

  function sendMessage(rawText: string) {
    const text = rawText.trim();
    if (!text || activeChannel.archived) return;
    const channel = activeChannel;
    const channelId = channel.id;

    const userMsg: ChatMessage = { id: makeMessageId(), role: 'user', text, t: nowShort() };
    const historyWithUserMsg = appendChannelMessage(channelId, messagesByChannel[channelId] ?? [], userMsg);
    setMessagesByChannel((prev) => ({ ...prev, [channelId]: historyWithUserMsg }));
    setTypingChannelIds((prev) => new Set(prev).add(channelId));

    // Phase 2 (a separate, future plan) replaces this one-line placeholder
    // with the full Persona + live-state-snapshot + Rules system prompt the
    // designer's spec describes (see Global Constraints) — out of scope here.
    const system = `You are ${channel.name}, a channel inside the Aether OS comms system.`;

    askClaude(system, toRecentTurns(historyWithUserMsg))
      .catch(() => null)
      .then((reply) => {
        const finalText = reply ?? `[offline] ${localResponder(channel, text, state)}`;
        const assistantMsg: ChatMessage = { id: makeMessageId(), role: 'assistant', text: finalText, t: nowShort() };
        setMessagesByChannel((prev) => ({
          ...prev,
          [channelId]: appendChannelMessage(channelId, prev[channelId] ?? historyWithUserMsg, assistantMsg),
        }));
        setTypingChannelIds((prev) => {
          const next = new Set(prev);
          next.delete(channelId);
          return next;
        });
        setUnreadCounts((prev) => (channelId === activeChannelIdRef.current ? prev : { ...prev, [channelId]: (prev[channelId] ?? 0) + 1 }));
      });
  }

  return {
    channels,
    activeChannel,
    activeChannelId: activeChannel.id,
    setActiveChannelId,
    messages: messagesByChannel[activeChannel.id] ?? [],
    isTyping: typingChannelIds.has(activeChannel.id),
    unreadCounts,
    sendMessage,
  };
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/MessageThread.tsx src/components/chat/MessageInput.tsx src/components/chat/useChatChannels.ts
git commit -m "feat: build the Chat message thread, input, and send-flow hook (optimistic render, typing, offline fallback)"
```

---

### Task 6: `ChatView.tsx` composition + registry wiring

Wires the rail, thread, and input to `useChatChannels`, then flips the `Chat` view-registry entry from `null` to the real component — same shape as every prior view's final wiring task.

**Files:**
- Create: `src/components/chat/ChatView.tsx`
- Modify: `src/viewRegistry.ts`
- Modify: `src/viewRegistry.test.ts`

**Interfaces:**
- Consumes: `useAetherStore()`; `useChatChannels` from `./useChatChannels`; `ChannelRail`, `MessageThread`, `MessageInput`.
- Produces: `ChatView()` — registered in `viewRegistry.ts`, completing the Chat Phase 1 slice.

- [ ] **Step 1: Implement `src/components/chat/ChatView.tsx`**

```tsx
import { useState, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useChatChannels } from './useChatChannels';
import { ChannelRail } from './ChannelRail';
import { MessageThread } from './MessageThread';
import { MessageInput } from './MessageInput';

export function ChatView() {
  const { state } = useAetherStore();
  const chat = useChatChannels(state);
  const [draft, setDraft] = useState('');

  function send() {
    if (!draft.trim()) return;
    chat.sendMessage(draft);
    setDraft('');
  }

  return (
    <div style={rootStyle}>
      <ChannelRail channels={chat.channels} activeChannelId={chat.activeChannelId} unreadCounts={chat.unreadCounts} onSelect={chat.setActiveChannelId} />
      <div style={mainStyle}>
        <div style={headerStyle}>
          <span style={headerDotStyle(chat.activeChannel.hue)} />
          <span style={headerNameStyle}>{chat.activeChannel.name}</span>
          {chat.activeChannel.archived && <span style={archivedPillStyle}>TERMINATED</span>}
        </div>
        <MessageThread channel={chat.activeChannel} messages={chat.messages} isTyping={chat.isTyping} />
        <MessageInput
          value={draft}
          onChange={setDraft}
          onSend={send}
          disabled={chat.activeChannel.archived}
          placeholder={chat.activeChannel.archived ? 'This channel is archived — read only' : `Message ${chat.activeChannel.name}…`}
        />
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
const mainStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  padding: 16,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
};
const headerStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  paddingBottom: 12,
  borderBottom: `1px solid ${colors.chromeBorder}`,
};
function headerDotStyle(hue: string): CSSProperties {
  return { width: 8, height: 8, borderRadius: '50%', background: hue, boxShadow: `0 0 8px ${hue}` };
}
const headerNameStyle: CSSProperties = { font: `700 15px/1 ${fonts.ui}`, letterSpacing: 1, color: colors.textPrimary };
const archivedPillStyle: CSSProperties = {
  font: `600 9px/1 ${fonts.ui}`,
  letterSpacing: 1,
  color: colors.textDim,
  border: `1px solid ${colors.chromeBorder}`,
  padding: '3px 7px',
  borderRadius: 5,
};
```

- [ ] **Step 2: Wire Chat into the registry**

In `src/viewRegistry.ts`, add the import and flip the entry:

```ts
import { ChatView } from './components/chat/ChatView';
// ...
{ id: 'Chat', inTopBar: true, inSidebar: false, component: ChatView },
```

- [ ] **Step 3: Update `src/viewRegistry.test.ts`**

The existing `'getViewComponent returns null for ids with no built component'` test currently asserts `expect(getViewComponent('Chat')).toBeNull();` — that assertion must be removed now that Chat is built (leaving `'NotARealTab'` as its only remaining assertion). Add a new test confirming Chat now resolves:

```ts
it('getViewComponent resolves Chat now that it is built', () => {
  expect(getViewComponent('Chat')).not.toBeNull();
});
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (125 total: 124 from Tasks 1–3 + 1 new here), 0 type errors, build succeeds.

- [ ] **Step 5: Verify via dev server**

Run: `npm run dev`. Click the Chat tab (top bar only — confirm `inSidebar: false` still holds): the channel rail shows AETHER first, then the 5 active agents, then the 2 archived idle channels (greyed, TERMINATED tag); AETHER is selected by default; typing a message and hitting Enter renders it immediately, shows the typing indicator, then (after the stubbed `askClaude` resolves to `null`) shows a `[offline]`-prefixed reply from `localResponder`.

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/ChatView.tsx src/viewRegistry.ts src/viewRegistry.test.ts
git commit -m "feat: compose the Chat view and wire it into the view registry"
```

---

### Task 7: Final integration QA

**Files:** none (verification-only task).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (125/125), 0 type errors, build succeeds.

- [ ] **Step 2: Manual QA checklist**

Run: `npm run dev`, open the browser.

- [ ] Clicking the top bar's "Chat" entry (Chat has no sidebar entry — confirm the sidebar has no Chat item, matching `inSidebar: false`) shows the rail + thread + input layout.
- [ ] AETHER is always the first, unarchived channel; below it, one live channel per currently-active agent; below that, the 2 seeded idle agents (`Web Scraper`, `Doc Helper`) appear pre-archived with the TERMINATED tag and greyed styling, confirming archived detection needs no prior session history to work correctly.
- [ ] Send a message in AETHER referencing burn rate, budget, roster, and approvals (four separate messages) — confirm each `[offline]`-prefixed reply is genuinely contextual and matches the live numbers shown elsewhere (Terminal's `status`/`budget` commands, TopBar's approval count).
- [ ] Switch to an active agent's channel (e.g. Code Builder) and ask about its progress, files, and task — confirm the reply reflects that specific agent's live `pct`/`task`/`files`, not a generic response.
- [ ] Click an archived channel — confirm the input is disabled/read-only ("This channel is archived — read only" placeholder) and any prior history (there won't be any yet) is still visible; attempting to type and hit Enter does nothing.
- [ ] From the Agents view, terminate an active agent (e.g. Test Runner) via "✕ TERMINATE", then return to Chat: confirm that agent's channel is now archived (greyed, TERMINATED tag) — but if it had any chat history, confirm that history is still fully visible, not deleted.
- [ ] Reactivate an idle agent from the Agents view, then return to Chat: confirm its channel is active again (no TERMINATED tag), and if it had prior chat history (from before it was archived), that history is still there.
- [ ] Send a message in a channel, then immediately switch to a different channel before the reply lands (~a second) — confirm the first channel's unread badge increments once the reply arrives while it's not open, and clicking back into it clears the badge and reveals the reply.
- [ ] Reload the page: confirm each channel's message history survives the reload via its own `aether-chat-<channelId>` localStorage key — **explicitly confirm no changes were needed to `src/state/persistence.ts`'s whitelist**, since Chat's state was never part of `AetherState` (this breaks with every prior plan's "check the whitelist" precedent, deliberately, per Global Constraints — record here that this was checked and confirmed unnecessary rather than skipped).
- [ ] Send more than 50 messages into a single channel (scripted or by hand) and confirm only the most recent 50 remain after a reload — the cap is real, not just asserted in tests.
- [ ] With zero active agents (terminate all of them via the Agents view), confirm Chat still renders correctly: AETHER plus every now-archived channel, no crash, no empty-rail state.
- [ ] Confirm no regressions elsewhere: Terminal, Dashboard, Agents, Grid, and all remaining `ComingSoonPanel` tabs still route and highlight correctly.

- [ ] **Step 3: Note the persistence-whitelist finding**

No commit is expected from this step — Step 2 confirms `src/state/persistence.ts` needed no changes, since Chat's per-channel `localStorage` keys are an intentionally separate mechanism (see Global Constraints). If the manual check surfaces an actual gap (e.g. `Chat` isn't reachable after a reload for some unrelated reason), fix and commit it as its own small fix:

```bash
git add <touched files>
git commit -m "fix: <describe the gap found during Chat Phase 1 QA>"
```

If no fix was needed, skip this step.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-18-chat-view-phase1.md`. Executed via the same per-task pipeline as the prior four plans: a fresh implementer subagent per task, a fresh reviewer subagent (spec compliance + code quality) before commit, then one whole-branch review after all tasks land. Phase 2 (real Anthropic backend, personas, action-execution pipeline) is intentionally a separate future plan building on the seams this one leaves in place (`askClaude`'s signature, `ChatChannel`/`ChatMessage` shapes, `localResponder` as the documented offline fallback).

### Critical Files for Implementation
- C:\Users\Matt\projects\aether-os\src\components\chat\chatChannels.ts
- C:\Users\Matt\projects\aether-os\src\components\chat\chatPersistence.ts
- C:\Users\Matt\projects\aether-os\src\components\chat\localResponder.ts
- C:\Users\Matt\projects\aether-os\src\components\chat\useChatChannels.ts
- C:\Users\Matt\projects\aether-os\src\components\chat\ChatView.tsx
- C:\Users\Matt\projects\aether-os\src\viewRegistry.ts
