# Chat View (Phase 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the action-JSON convention Phase 2a's system prompt already documents (inert since Phase 2a shipped) into a real pipeline: parse it off the end of a genuine `askClaude` reply, strip it from what's displayed, auto-execute `theme`/`renderer` immediately (identically to Terminal), and route `spawn`/`kill`/`throttle` through the existing approval queue — with resolution (approve or deny, from whichever existing UI the user clicks) posting a confirmation line back into the chat channel that requested it.

**Architecture:** The parser (`actionParser.ts`) is a pure function over a reply string — no dependency on `askClaude` having actually run, so it is fully fixture-testable. The executor (`actionExecutor.ts`) is pure decision logic: given a parsed action + channel + live state, it decides whether the verb is safe (execute now) or risky (queue for approval), what raw Terminal-equivalent command or `Approval` payload to build, and whether OpMode `AUTO` means it should auto-resolve immediately. Both pure modules are wired together in `useChatChannels.ts`'s send flow (only place touched at the hook layer) and, on the resolution side, in an extended `RESOLVE_APPROVAL` reducer case — the single existing "approve/deny" action every approval-queue UI in this app already dispatches. A new, small, self-draining `chatActionResults` queue on `AetherState` is the bridge that lets a resolution that happens in a completely different, unrelated view (TopBar's global approval bell, or the Agents tab) get a confirmation line back into a chat channel whose `useChatChannels` hook may not even be mounted at the time — `useChatChannels` drains it into the right channel's persisted history whenever it next mounts/renders, which is correct whether Chat happens to be open live (the common case, since TopBar's approval bell is global chrome, so "approving from TopBar while Chat is open" is an expected, not edge-case, scenario) or closed at the time.

**Tech Stack:** Same as Phase 1/2a — React 18, Vite 5, TypeScript 5 strict, Vitest, no new dependencies. Every module this plan adds is pure logic (parser, executor, a tiny result-text formatter) plus small, additive changes to the existing reducer/types/persistence/commands modules — no new UI components.

---

## Global Constraints

- Project root: `C:\Users\Matt\projects\aether-os`. Builds directly on Phase 2a (shipped, 154 passing tests, 18 files — confirmed via `npm test` before starting this plan).
- **Never touch Phase 2a's contract.** `askClaude`'s signature/null-on-failure behavior, `buildSystemPrompt`'s composition, and `systemPrompt.ts`'s RULES text are untouched — the RULES text already documents exactly the five-verb convention this plan parses (`spawn|kill|theme|renderer|throttle`); no system-prompt rewrite is needed or performed.
- **`localResponder` output is NEVER parsed.** The action-JSON convention was only ever specified for real Claude replies (Phase 2a's RULES text is only sent to the real model). `useChatChannels.ts`'s existing `reply ?? \`[offline] ${localResponder(...)}\`` branch structure already makes this natural: the parser runs only inside the `reply` (non-null) branch, never on the `[offline]`-prefixed fallback string. This is explicitly asserted in Task 4's tests, not left as an accident of code structure.
- **Investigation finding — "status" verb does not exist in this codebase's convention and is not added.** The original designer spec mentioned a `status` verb, but Phase 2a's actual shipped `RULES` text (`src/components/chat/systemPrompt.ts`, confirmed by reading it directly) only ever documents `spawn|kill|theme|renderer|throttle` — no `status`. Separately, Terminal's `case 'status':` (`commands.ts`) is a pure read-only report with no `patch` at all — even if a model somehow emitted `{"verb":"status",...}` against its own instructions, there is no state mutation in this codebase for it to execute. Decision: `status` is not a recognized verb. If it ever appears in a reply (a model deviation from its own instructions), the parser's "unrecognized verb" branch applies (see Task 2) — the whole reply, JSON line included, is left as plain text, since the line was never validated as one of the five real verbs.
- **Investigation finding — `RESOLVE_APPROVAL` has no pre-existing execution mechanism to reuse.** Confirmed by reading `src/state/reducer.ts` and both call sites (`src/components/layout/TopBar.tsx:71-76`, `src/components/agents/AgentDetailCard.tsx` — both dispatch `{ type: 'RESOLVE_APPROVAL', id, approve }` and nothing else). The reducer's existing case only filters the approval out, pushes a notif/log line, and — only for an approved HIGH-risk item — bumps `rate` by a flat `+9000` as a cosmetic stand-in for "this was expensive," regardless of what `action` string it held. Neither of the two seed approvals (`Deploy build #214`, `Run schema migration 0043`) corresponds to any real spawn/kill in `state.agents`. This plan's design: **extend `RESOLVE_APPROVAL` itself** (not a new dispatch) to perform a real, verb-specific mutation, gated entirely on a new optional `Approval.verb` field Phase 2b introduces. Every pre-existing and future no-verb approval (seed data, `tick.ts`'s random `APPROVAL_POOL` generation) is provably unaffected — same filter/notif/log/rate-bump behavior, byte for byte. This satisfies "approving executes via the same store action the Agents tab uses" honestly: it is the literal same action type, dispatched from the literal same two UI call sites, with **zero changes needed to `TopBar.tsx` or `AgentDetailCard.tsx`** — confirmed and left unmodified by this plan.
- **Risk-level policy per verb** (a real decision, grounded in the seed data's own bar — a production deploy is HIGH, a schema migration is MED):
  - `kill` → **HIGH**. Terminates an agent's in-flight work with no undo — comparable blast radius/irreversibility to the seed "deploy to production."
  - `spawn` → **MED**. Adds cost/reactor load (`rate + 18000`, identical to Terminal's own `spawn`) but is reversible (`kill` undoes it) — comparable to the seed "schema migration": a real, structural change, but a contained and reversible one.
  - `throttle` → **LOW**. Caps one agent's `share` at a fixed ceiling; fully reversible, minimal blast radius.
- **AUTO OpMode consistency (new, but reuses an existing policy verbatim):** `src/state/tick.ts:77` already auto-approves any randomly-generated approval when `state.cfg.opMode === 'AUTO' && req.risk !== 'HIGH'`. Phase 2b's risky-verb path applies the *exact same rule* to chat-originated approvals — when OpMode is `AUTO` and risk is not `HIGH` (i.e. `spawn`/`throttle`, never `kill`), the hook immediately dispatches `ADD_APPROVAL` followed by `RESOLVE_APPROVAL(id, approve: true)` in the same tick, so the *same* reducer path executes the mutation and emits the *same* `chatActionResults` confirmation — no parallel "auto-exec" code path is invented. This was a genuine design question (should chat approvals respect an existing app-wide policy or ignore it?) resolved in favor of consistency.
- **What `throttle` actually does to state (new, minimal, no new subsystem):** caps the target `Agent.share` at a fixed ceiling, `THROTTLE_SHARE_CEILING = 0.08` — below every seed agent's current `share` (0.13–0.22), so the cap is always visibly enforced when applied (`share: Math.min(agent.share, 0.08)`, not increasable back up by a duplicate throttle). This reuses the existing `Agent.share` field (already the fraction-of-`rate` every other view/computation reads); no new `Cfg` field, no new "throttle management" feature — exactly the smallest addition the constraint asked for.
- **Approval → chat-channel routing:** `Approval` gains three optional fields — `verb?`, `targetAgentName?`, `channelId?` (see Task 1). A side-map in chat's own state was considered and rejected: the reducer *unavoidably* needs `verb`/`targetAgentName` on the `Approval` itself to execute the mutation (it has no visibility into any chat-feature-local state), and once those two fields already live on the shared type, splitting `channelId` into a separate side-mechanism would only reintroduce a fragile "diff `state.approvals` to infer approve-vs-deny after the fact" problem for no real benefit — the reducer already knows approve/deny deterministically at the point it resolves, so it can emit the exact right confirmation/denial text itself. All three fields are optional and ignored by every pre-existing approval (seed data, `tick.ts`'s pool) and every pre-existing reader of `Approval` (`TopBar.tsx`, `AgentDetailCard.tsx`, `commands.ts`'s `approvals`/`approve`/`deny` — none of which read the new fields, so they render/behave identically for Phase 2b approvals as for any other).
- **Terminal-originated (or any non-chat) approvals are the default, unaffected case.** They simply never have `channelId` set, so the `chatActionResults` emission branch never fires for them — `RESOLVE_APPROVAL`'s pre-existing behavior for such approvals (all of which lack `verb` too, since nothing outside this plan sets it) is untouched.
- **Safe-verb execution deliberately reuses `RUN_COMMAND` verbatim** — dispatching `{ type: 'RUN_COMMAND', raw: 'theme violet' }` (or `renderer volumetric`) from the chat pipeline is *exactly* "as if the user had typed the equivalent Terminal command," per this plan's own brief, literally. **This means a chat-triggered theme/renderer change also appends to Terminal's `termHist`/`cmdHist`/`commandsRun`, exactly like an operator-typed command would.** This is a deliberate, expected side effect (AETHER is executing the operator's request through the same reactor console the operator would have used) — not a bug to suppress. Documented here explicitly so no implementer "fixes" it by hiding it from `termHist`.
- **Every task's automated tests are fixture-based, no live API call required** — `actionParser.ts` and `actionExecutor.ts` are pure functions tested with literal fixture strings/objects; the reducer extension is tested with plain `reducer(state, action)` calls, no store/React/network involved.
- **The one thing that cannot be verified without a funded key** — whether the real Claude model reliably emits the action-JSON convention in practice — is isolated entirely in Task 6, marked BLOCKED/DEFERRED, mirroring Phase 2a's Task 7 exactly.
- Run `npm test`, `npx tsc -b`, and `npm run build` clean before every commit. Baseline going into this plan: **154 passing tests across 18 files** (confirmed via `npm test` before starting).

---

## File Structure

```
aether-os/
  src/
    state/
      types.ts                    MODIFIED — Approval gains verb/targetAgentName/channelId; new ChatActionResult type; AetherState gains chatActionResults
      initialState.ts             MODIFIED — chatActionResults: []
      persistence.ts              MODIFIED — whitelist gains chatActionResults
      persistence.test.ts         MODIFIED
      reducer.ts                  MODIFIED — ADD_APPROVAL, CLEAR_CHAT_ACTION_RESULTS actions; RESOLVE_APPROVAL extended with verb execution + chatActionResults emission
      reducer.test.ts             MODIFIED
      chatActionResult.ts         NEW — pure buildChatActionResultText(req, approved) formatter
      chatActionResult.test.ts    NEW
    components/
      terminal/
        commands.ts               MODIFIED — export THEME_NAMES, RENDERER_WORDS, nextAutoName (no behavior change)
        commands.test.ts          MODIFIED — confirms the new exports work
      chat/
        actionParser.ts           NEW — parseActionLine(reply): { text, action }
        actionParser.test.ts      NEW
        actionExecutor.ts         NEW — risk policy, safe-command builder, approval-payload builder, AUTO-eligibility
        actionExecutor.test.ts    NEW
        useChatChannels.ts        MODIFIED — wires parser+executor into the send flow; drains chatActionResults
```

---

### Task 1: Shared state model — `Approval` fields, `chatActionResults`, `ADD_APPROVAL`/`CLEAR_CHAT_ACTION_RESULTS`, `RESOLVE_APPROVAL` execution

The foundation everything else depends on. Extends the shared type/reducer/persistence layer additively; every existing approval (seed + `tick.ts`-generated) is provably unaffected.

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/state/initialState.ts`
- Modify: `src/state/persistence.ts`, `src/state/persistence.test.ts`
- Modify: `src/state/reducer.ts`, `src/state/reducer.test.ts`
- Modify: `src/components/terminal/commands.ts`, `src/components/terminal/commands.test.ts`
- Create: `src/state/chatActionResult.ts`, `src/state/chatActionResult.test.ts`

**Interfaces:**
- Produces: `Approval.verb?: 'spawn' | 'kill' | 'throttle'`, `Approval.targetAgentName?: string`, `Approval.channelId?: string`; `ChatActionResult { channelId: string; text: string }`; `AetherState.chatActionResults: ChatActionResult[]`; reducer actions `ADD_APPROVAL` and `CLEAR_CHAT_ACTION_RESULTS`; `buildChatActionResultText(req: Approval, approved: boolean): string` — all consumed by Task 3's executor and Task 4's hook wiring.
- Consumes: `makeAgent` (already imported into `reducer.ts`), newly exported `THEME_NAMES`/`RENDERER_WORDS`/`nextAutoName` from `commands.ts`.

- [ ] **Step 1: Extend `src/state/types.ts`**

```ts
export interface Approval {
  id: number;
  agent: string;
  i: string;
  hue: string;
  action: string;
  detail: string;
  risk: 'HIGH' | 'MED' | 'LOW';
  // Phase 2b (chat action-JSON pipeline) — optional, so every pre-existing
  // (seed + tick.ts-generated) approval is unaffected. Set together only by
  // the chat feature's risky-verb path (see actionExecutor.ts).
  verb?: 'spawn' | 'kill' | 'throttle';
  targetAgentName?: string; // spawn: name of the agent to create; kill/throttle: name of the existing agent targeted
  channelId?: string; // originating chat channel id, so resolution can post a confirmation back to it
}

export interface ChatActionResult {
  channelId: string;
  text: string;
}
```

Add `chatActionResults: ChatActionResult[];` to `AetherState`.

- [ ] **Step 2: `src/state/initialState.ts`** — add `chatActionResults: [],`.

- [ ] **Step 3: Write the failing test for `buildChatActionResultText`**

`src/state/chatActionResult.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildChatActionResultText } from './chatActionResult';
import type { Approval } from './types';

function approval(overrides: Partial<Approval> = {}): Approval {
  return { id: 1, agent: 'AETHER', i: 'AE', hue: '#7fd8ef', action: 'Spawn Nightwatch', detail: '', risk: 'MED', ...overrides };
}

describe('buildChatActionResultText', () => {
  it('formats an approved spawn', () => {
    expect(buildChatActionResultText(approval({ verb: 'spawn', targetAgentName: 'Nightwatch' }), true)).toBe('✓ Approved — Nightwatch spawned.');
  });
  it('formats an approved kill', () => {
    expect(buildChatActionResultText(approval({ verb: 'kill', targetAgentName: 'Code Builder' }), true)).toBe('✓ Approved — Code Builder terminated.');
  });
  it('formats an approved throttle', () => {
    expect(buildChatActionResultText(approval({ verb: 'throttle', targetAgentName: 'Code Builder' }), true)).toBe("✓ Approved — Code Builder's draw throttled.");
  });
  it('formats a denial regardless of verb', () => {
    expect(buildChatActionResultText(approval({ verb: 'kill', targetAgentName: 'Code Builder', action: 'Kill Code Builder' }), false)).toBe('✗ Denied: Kill Code Builder.');
  });
  it('falls back to the generic action string for a verb-less approval (defensive; should not occur in practice)', () => {
    expect(buildChatActionResultText(approval({ verb: undefined }), true)).toBe('✓ Approved: Spawn Nightwatch.');
  });
});
```

Run `npm test -- chatActionResult` → FAIL (module doesn't exist).

- [ ] **Step 4: Implement `src/state/chatActionResult.ts`**

```ts
import type { Approval } from './types';

export function buildChatActionResultText(req: Approval, approved: boolean): string {
  if (!approved) return `✗ Denied: ${req.action}.`;
  switch (req.verb) {
    case 'spawn':
      return `✓ Approved — ${req.targetAgentName} spawned.`;
    case 'kill':
      return `✓ Approved — ${req.targetAgentName} terminated.`;
    case 'throttle':
      return `✓ Approved — ${req.targetAgentName}'s draw throttled.`;
    default:
      return `✓ Approved: ${req.action}.`;
  }
}
```

Run `npm test -- chatActionResult` → PASS, 5 tests.

- [ ] **Step 5: Small, behavior-preserving exports in `src/components/terminal/commands.ts`**

Add `export` to the existing `THEME_NAMES` const; extract the renderer literal array to a new named export `export const RENDERER_WORDS = ['nebula', 'volumetric', 'warp'] as const;` and use it in the existing `case 'renderer':` switch instead of the inline array; add `export` to `nextAutoName`. No other line changes — behavior is identical.

Add to `commands.test.ts`:

```ts
it('exports THEME_NAMES, RENDERER_WORDS, and nextAutoName for reuse by the chat action executor', () => {
  expect(THEME_NAMES).toContain('violet');
  expect(RENDERER_WORDS).toContain('volumetric');
  expect(nextAutoName(initialState)).toBe('Image Gen');
});
```

(adjust the existing `import` line at the top of `commands.test.ts` to pull in the three new names). Run `npm test -- commands` → PASS.

- [ ] **Step 6: Write the failing reducer tests**

Add to `src/state/reducer.test.ts`:

```ts
import type { Approval } from './types';

function chatApproval(overrides: Partial<Approval>): Approval {
  return { id: 100, agent: 'AETHER', i: 'AE', hue: '#7fd8ef', action: 'Spawn Nightwatch', detail: 'requested via chat', risk: 'MED', ...overrides };
}

describe('reducer — Phase 2b chat action pipeline', () => {
  it('ADD_APPROVAL appends using apprSeq and increments it, leaving existing approvals untouched', () => {
    const next = reducer(initialState, { type: 'ADD_APPROVAL', approval: chatApproval({ id: undefined as any }) as any });
    expect(next.approvals).toHaveLength(3);
    expect(next.approvals[2].id).toBe(initialState.apprSeq);
    expect(next.apprSeq).toBe(initialState.apprSeq + 1);
  });

  it('RESOLVE_APPROVAL on an approved spawn approval creates the agent and bumps rate by 18000 (identical to Terminal spawn), skipping the generic HIGH-risk shorthand', () => {
    const withApproval = { ...initialState, approvals: [...initialState.approvals, chatApproval({ id: 50, verb: 'spawn', targetAgentName: 'Nightwatch', risk: 'MED', channelId: 'AETHER' })] };
    const next = reducer(withApproval, { type: 'RESOLVE_APPROVAL', id: 50, approve: true });
    expect(next.agents.map((a) => a.name)).toContain('Nightwatch');
    expect(next.rate).toBe(initialState.rate + 18000);
    expect(next.chatActionResults).toEqual([{ channelId: 'AETHER', text: '✓ Approved — Nightwatch spawned.' }]);
  });

  it('RESOLVE_APPROVAL on an approved kill approval moves the target agent to idleList and does not touch rate', () => {
    const withApproval = { ...initialState, approvals: [...initialState.approvals, chatApproval({ id: 51, verb: 'kill', targetAgentName: 'Test Runner', risk: 'HIGH', agent: 'AETHER', channelId: 'AETHER' })] };
    const next = reducer(withApproval, { type: 'RESOLVE_APPROVAL', id: 51, approve: true });
    expect(next.agents.map((a) => a.name)).not.toContain('Test Runner');
    expect(next.idleList.map((i) => i.name)).toContain('Test Runner');
    expect(next.rate).toBe(initialState.rate);
  });

  it('RESOLVE_APPROVAL on an approved throttle approval caps the target agent share at 0.08', () => {
    const withApproval = { ...initialState, approvals: [...initialState.approvals, chatApproval({ id: 52, verb: 'throttle', targetAgentName: 'Code Builder', risk: 'LOW', channelId: 'Code Builder' })] };
    const next = reducer(withApproval, { type: 'RESOLVE_APPROVAL', id: 52, approve: true });
    expect(next.agents.find((a) => a.name === 'Code Builder')?.share).toBe(0.08);
  });

  it('RESOLVE_APPROVAL gracefully no-ops the mutation (but still resolves + emits the result) when the target agent is already gone', () => {
    const withApproval = { ...initialState, approvals: [...initialState.approvals, chatApproval({ id: 53, verb: 'kill', targetAgentName: 'Nobody', risk: 'HIGH', channelId: 'AETHER' })] };
    const next = reducer(withApproval, { type: 'RESOLVE_APPROVAL', id: 53, approve: true });
    expect(next.approvals.map((a) => a.id)).not.toContain(53);
    expect(next.chatActionResults).toHaveLength(1);
  });

  it('RESOLVE_APPROVAL on a denied chat approval emits a denial line to its channel and applies no mutation', () => {
    const withApproval = { ...initialState, approvals: [...initialState.approvals, chatApproval({ id: 54, verb: 'spawn', targetAgentName: 'Nightwatch', risk: 'MED', channelId: 'AETHER' })] };
    const next = reducer(withApproval, { type: 'RESOLVE_APPROVAL', id: 54, approve: false });
    expect(next.agents.map((a) => a.name)).not.toContain('Nightwatch');
    expect(next.chatActionResults).toEqual([{ channelId: 'AETHER', text: '✗ Denied: Spawn Nightwatch.' }]);
  });

  it('RESOLVE_APPROVAL on the pre-existing seed approvals is byte-for-byte unchanged (no verb, no chatActionResults emitted)', () => {
    const next = reducer(initialState, { type: 'RESOLVE_APPROVAL', id: 1, approve: true });
    expect(next.rate).toBe(initialState.rate + 9000);
    expect(next.chatActionResults).toEqual([]);
  });

  it('CLEAR_CHAT_ACTION_RESULTS removes exactly the first N entries, preserving any added after', () => {
    const withResults = { ...initialState, chatActionResults: [{ channelId: 'a', text: '1' }, { channelId: 'b', text: '2' }, { channelId: 'c', text: '3' }] };
    const next = reducer(withResults, { type: 'CLEAR_CHAT_ACTION_RESULTS', count: 2 });
    expect(next.chatActionResults).toEqual([{ channelId: 'c', text: '3' }]);
  });
});
```

Run `npm test -- reducer` → FAIL (new action types/behavior don't exist yet).

- [ ] **Step 7: Implement in `src/state/reducer.ts`**

```ts
import { buildChatActionResultText } from './chatActionResult';
// ...
export type Action =
  | /* ...existing... */
  | { type: 'ADD_APPROVAL'; approval: Omit<Approval, 'id'> }
  | { type: 'CLEAR_CHAT_ACTION_RESULTS'; count: number };

const THROTTLE_SHARE_CEILING = 0.08;

// ... inside reducer(), add:
case 'ADD_APPROVAL':
  return {
    ...state,
    approvals: [...state.approvals, { ...action.approval, id: state.apprSeq }],
    apprSeq: state.apprSeq + 1,
  };

case 'CLEAR_CHAT_ACTION_RESULTS':
  return { ...state, chatActionResults: state.chatActionResults.slice(action.count) };

case 'RESOLVE_APPROVAL': {
  const req = state.approvals.find((a) => a.id === action.id);
  if (!req) return state;
  const ok = action.approve;

  // Phase 2b: verb-specific execution, mirroring the identical AetherState
  // mutation Terminal's own spawn/kill would produce (or, for throttle, a
  // new minimal Agent.share cap) -- applied only on approval, and only for
  // approvals Phase 2b itself created (req.verb set). Every pre-existing
  // (seed + tick.ts) approval has no verb and is completely unaffected.
  let agents = state.agents;
  let idleList = state.idleList;
  let rate = state.rate;
  if (ok && req.verb === 'spawn' && req.targetAgentName) {
    agents = [...agents, makeAgent(req.targetAgentName)];
    rate = Math.min(168000, rate + 18000); // identical to Terminal's spawn
  } else if (ok && req.verb === 'kill' && req.targetAgentName) {
    const hit = agents.find((a) => a.name === req.targetAgentName);
    if (hit) {
      agents = agents.filter((a) => a.name !== hit.name);
      idleList = [...idleList, { name: hit.name, last: 'just now' }];
    }
    // no rate change -- identical to Terminal's kill
  } else if (ok && req.verb === 'throttle' && req.targetAgentName) {
    agents = agents.map((a) => (a.name === req.targetAgentName ? { ...a, share: Math.min(a.share, THROTTLE_SHARE_CEILING) } : a));
  } else if (ok && req.risk === 'HIGH') {
    // Pre-existing generic shorthand -- only applies to no-verb approvals,
    // since a verb-carrying approval's own specific mutation above (or
    // deliberate lack of one, for kill/throttle) is the real effect now;
    // applying both would double up or contradict it.
    rate = Math.min(168000, rate + 9000);
  }

  const chatActionResults = req.channelId
    ? [...state.chatActionResults, { channelId: req.channelId, text: buildChatActionResultText(req, ok) }]
    : state.chatActionResults;

  return {
    ...state,
    agents,
    idleList,
    rate,
    chatActionResults,
    approvals: state.approvals.filter((a) => a.id !== action.id),
    notifs: [
      { t: nowShort(), m: `${ok ? 'Approved: ' : 'Denied: '}${req.action} (${req.agent})`, c: ok ? '#3be0a0' : '#ff9d9d' },
      ...state.notifs,
    ].slice(0, 12),
    logs: [
      ...state.logs,
      { t: nowShort(), m: `${req.agent}: ${ok ? 'authorization granted — ' : 'request denied — '}${req.action.toLowerCase()}`, c: ok ? '#3be0a0' : '#ff9d9d' },
    ].slice(-14),
  };
}
```

Run `npm test -- reducer` → PASS, all new + 13 existing tests.

- [ ] **Step 8: Whitelist `chatActionResults` in `src/state/persistence.ts`**

Add `chatActionResults: state.chatActionResults,` to the persisted slice — a legitimately-pending, not-yet-drained confirmation (approved/denied but Chat never reopened before a reload) shouldn't be silently lost; it's a tiny, self-clearing array so the cost is negligible. Add one test to `persistence.test.ts` asserting it round-trips.

- [ ] **Step 9: Run the full suite**

Run: `npm test && npx tsc -b` — expect all PASS (~172 total: 154 existing + ~18 new), 0 type errors.

- [ ] **Step 10: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/state/persistence.ts src/state/persistence.test.ts src/state/reducer.ts src/state/reducer.test.ts src/state/chatActionResult.ts src/state/chatActionResult.test.ts src/components/terminal/commands.ts src/components/terminal/commands.test.ts
git commit -m "feat: extend Approval + RESOLVE_APPROVAL to execute chat-originated spawn/kill/throttle actions"
```

---

### Task 2: Action-JSON line parser

Pure, fixture-tested. Detects and strips the convention Phase 2a's system prompt already documents.

**Files:**
- Create: `src/components/chat/actionParser.ts`
- Test: `src/components/chat/actionParser.test.ts`

**Interfaces:**
- Produces: `ChatAction { verb: 'spawn' | 'kill' | 'theme' | 'renderer' | 'throttle'; args: Record<string, unknown> }`, `parseActionLine(reply: string): { text: string; action: ChatAction | null }` — consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { parseActionLine } from './actionParser';

describe('parseActionLine', () => {
  it('strips a well-formed action line for a recognized verb and returns the parsed action', () => {
    const reply = 'I\'ll get a fresh set of hands on this.\n{"verb":"spawn","args":{"name":"Nightwatch"}}';
    const { text, action } = parseActionLine(reply);
    expect(text).toBe("I'll get a fresh set of hands on this.");
    expect(action).toEqual({ verb: 'spawn', args: { name: 'Nightwatch' } });
  });

  it('handles theme/renderer/kill/throttle verbs identically', () => {
    expect(parseActionLine('Done.\n{"verb":"theme","args":{"name":"violet"}}').action?.verb).toBe('theme');
    expect(parseActionLine('Done.\n{"verb":"renderer","args":{"mode":"warp"}}').action?.verb).toBe('renderer');
    expect(parseActionLine('Done.\n{"verb":"kill","args":{"name":"Code Builder"}}').action?.verb).toBe('kill');
    expect(parseActionLine('Done.\n{"verb":"throttle","args":{"name":"Code Builder"}}').action?.verb).toBe('throttle');
  });

  it('returns the whole reply unchanged with no action for plain prose (no JSON line)', () => {
    const { text, action } = parseActionLine('Just a normal reply.');
    expect(text).toBe('Just a normal reply.');
    expect(action).toBeNull();
  });

  it('returns the whole reply unchanged with no action when the last line is malformed JSON', () => {
    const reply = 'Reply text.\n{not valid json';
    const { text, action } = parseActionLine(reply);
    expect(text).toBe(reply);
    expect(action).toBeNull();
  });

  it('returns the whole reply unchanged with no action for an unrecognized verb (e.g. a stray "status")', () => {
    const reply = 'Reply text.\n{"verb":"status","args":{}}';
    const { text, action } = parseActionLine(reply);
    expect(text).toBe(reply);
    expect(action).toBeNull();
  });

  it('returns the whole reply unchanged when args is missing or not an object', () => {
    expect(parseActionLine('Reply.\n{"verb":"spawn"}').action).toBeNull();
    expect(parseActionLine('Reply.\n{"verb":"spawn","args":"nope"}').action).toBeNull();
  });

  it('handles trailing blank lines gracefully', () => {
    const reply = 'Reply text.\n{"verb":"theme","args":{"name":"amber"}}\n\n';
    const { text, action } = parseActionLine(reply);
    expect(text).toBe('Reply text.');
    expect(action?.verb).toBe('theme');
  });

  it('never throws on empty or whitespace-only input', () => {
    expect(() => parseActionLine('')).not.toThrow();
    expect(parseActionLine('   ').action).toBeNull();
  });
});
```

Run `npm test -- actionParser` → FAIL (module doesn't exist).

- [ ] **Step 2: Implement `src/components/chat/actionParser.ts`**

```ts
const RECOGNIZED_VERBS = ['spawn', 'kill', 'theme', 'renderer', 'throttle'] as const;
export type ActionVerb = (typeof RECOGNIZED_VERBS)[number];

export interface ChatAction {
  verb: ActionVerb;
  args: Record<string, unknown>;
}

function isRecognizedVerb(v: unknown): v is ActionVerb {
  return typeof v === 'string' && (RECOGNIZED_VERBS as readonly string[]).includes(v);
}

// Detects Phase 2a's system-prompt-documented convention: an optional final
// line containing a compact JSON object {"verb": ..., "args": {...}}. Only
// strips/parses it when the verb is one of the five real, recognized ones
// AND args is present as an object -- any other case (no JSON line, invalid
// JSON, unrecognized verb like a stray "status", missing/non-object args)
// leaves the reply completely untouched and returns action: null. Never
// throws, regardless of input. Only ever called against a genuine askClaude
// reply -- never against localResponder's offline fallback text (see
// useChatChannels.ts / Global Constraints).
export function parseActionLine(reply: string): { text: string; action: ChatAction | null } {
  const lines = reply.split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.length) return { text: reply, action: null };

  const lastLine = lines[lines.length - 1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    return { text: reply, action: null };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { text: reply, action: null };
  const obj = parsed as Record<string, unknown>;
  if (!isRecognizedVerb(obj.verb)) return { text: reply, action: null };
  if (typeof obj.args !== 'object' || obj.args === null || Array.isArray(obj.args)) return { text: reply, action: null };

  const strippedText = lines.slice(0, -1).join('\n').trimEnd();
  return { text: strippedText, action: { verb: obj.verb, args: obj.args as Record<string, unknown> } };
}
```

Run `npm test -- actionParser` → PASS, 9 tests.

- [ ] **Step 3: Run the full suite** — `npm test && npx tsc -b` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/actionParser.ts src/components/chat/actionParser.test.ts
git commit -m "feat: add the action-JSON line parser for chat replies"
```

---

### Task 3: Action executor — risk policy, safe-command builder, approval-payload builder

Pure decision logic bridging a parsed `ChatAction` to either a Terminal-equivalent raw command (safe verbs) or an `Approval` payload (risky verbs), plus the AUTO-mode auto-approval rule.

**Files:**
- Create: `src/components/chat/actionExecutor.ts`
- Test: `src/components/chat/actionExecutor.test.ts`

**Interfaces:**
- Consumes: `ChatAction` from `./actionParser`; `THEME_NAMES`, `RENDERER_WORDS` from `../terminal/commands`; `Approval`, `OpMode` from `../../state/types`.
- Produces: `SAFE_VERBS`, `RISKY_VERBS`, `RISK_POLICY`, `buildSafeCommandRaw(action): string | null`, `buildApprovalPayload(channel, action): Omit<Approval, 'id'> | null`, `shouldAutoApprove(risk, opMode): boolean` — consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { buildApprovalPayload, buildSafeCommandRaw, RISK_POLICY, shouldAutoApprove } from './actionExecutor';
import type { ChatChannel } from './chatChannels';

const aetherChannel: ChatChannel = { id: 'AETHER', kind: 'aether', name: 'AETHER', initials: 'AE', hue: '#7fd8ef', archived: false };
const agentChannel: ChatChannel = { id: 'Code Builder', kind: 'agent', name: 'Code Builder', initials: 'CB', hue: '#7ef0ff', archived: false };

describe('RISK_POLICY', () => {
  it('assigns kill=HIGH, spawn=MED, throttle=LOW', () => {
    expect(RISK_POLICY.kill).toBe('HIGH');
    expect(RISK_POLICY.spawn).toBe('MED');
    expect(RISK_POLICY.throttle).toBe('LOW');
  });
});

describe('buildSafeCommandRaw', () => {
  it('builds a valid theme raw command', () => {
    expect(buildSafeCommandRaw({ verb: 'theme', args: { name: 'violet' } })).toBe('theme violet');
  });
  it('builds a valid renderer raw command', () => {
    expect(buildSafeCommandRaw({ verb: 'renderer', args: { mode: 'volumetric' } })).toBe('renderer volumetric');
  });
  it('returns null for an invalid theme name', () => {
    expect(buildSafeCommandRaw({ verb: 'theme', args: { name: 'not-a-theme' } })).toBeNull();
  });
  it('returns null for an invalid renderer mode', () => {
    expect(buildSafeCommandRaw({ verb: 'renderer', args: { mode: 'chaos' } })).toBeNull();
  });
  it('returns null for a non-safe verb', () => {
    expect(buildSafeCommandRaw({ verb: 'spawn', args: { name: 'X' } })).toBeNull();
  });
  it('returns null when the relevant arg is missing or non-string', () => {
    expect(buildSafeCommandRaw({ verb: 'theme', args: {} })).toBeNull();
    expect(buildSafeCommandRaw({ verb: 'theme', args: { name: 42 } })).toBeNull();
  });
});

describe('buildApprovalPayload', () => {
  it('builds a spawn approval from the AETHER channel', () => {
    const payload = buildApprovalPayload(aetherChannel, { verb: 'spawn', args: { name: 'Nightwatch' } });
    expect(payload).toMatchObject({ agent: 'AETHER', risk: 'MED', verb: 'spawn', targetAgentName: 'Nightwatch', channelId: 'AETHER' });
  });
  it('builds a kill approval from an agent channel', () => {
    const payload = buildApprovalPayload(agentChannel, { verb: 'kill', args: { name: 'Test Runner' } });
    expect(payload).toMatchObject({ agent: 'Code Builder', risk: 'HIGH', verb: 'kill', targetAgentName: 'Test Runner', channelId: 'Code Builder' });
  });
  it('builds a throttle approval', () => {
    const payload = buildApprovalPayload(agentChannel, { verb: 'throttle', args: { name: 'Code Builder' } });
    expect(payload).toMatchObject({ risk: 'LOW', verb: 'throttle', targetAgentName: 'Code Builder' });
  });
  it('returns null for a non-risky verb', () => {
    expect(buildApprovalPayload(aetherChannel, { verb: 'theme', args: { name: 'cyan' } })).toBeNull();
  });
  it('returns null when args.name is missing or non-string', () => {
    expect(buildApprovalPayload(aetherChannel, { verb: 'spawn', args: {} })).toBeNull();
    expect(buildApprovalPayload(aetherChannel, { verb: 'kill', args: { name: 42 } })).toBeNull();
  });
});

describe('shouldAutoApprove', () => {
  it('is true only for AUTO opMode and non-HIGH risk', () => {
    expect(shouldAutoApprove('MED', 'AUTO')).toBe(true);
    expect(shouldAutoApprove('LOW', 'AUTO')).toBe(true);
    expect(shouldAutoApprove('HIGH', 'AUTO')).toBe(false);
    expect(shouldAutoApprove('MED', 'EDITS')).toBe(false);
    expect(shouldAutoApprove('MED', 'PLAN')).toBe(false);
  });
});
```

Run `npm test -- actionExecutor` → FAIL (module doesn't exist).

- [ ] **Step 2: Implement `src/components/chat/actionExecutor.ts`**

```ts
import type { ChatAction } from './actionParser';
import type { ChatChannel } from './chatChannels';
import type { Approval, OpMode } from '../../state/types';
import { THEME_NAMES, RENDERER_WORDS } from '../terminal/commands';

export const SAFE_VERBS = ['theme', 'renderer'] as const;
export const RISKY_VERBS = ['spawn', 'kill', 'throttle'] as const;

// Risk-level policy, grounded in the seed approvals' own bar (a production
// deploy is HIGH, a schema migration is MED): kill destroys an agent's
// in-flight work with no undo (HIGH); spawn adds cost/load but is reversible
// via kill (MED); throttle just caps one agent's share, fully reversible,
// minimal blast radius (LOW).
export const RISK_POLICY: Record<(typeof RISKY_VERBS)[number], Approval['risk']> = {
  kill: 'HIGH',
  spawn: 'MED',
  throttle: 'LOW',
};

function str(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Safe verbs execute immediately, "as if the user had typed the equivalent
// Terminal command" -- literally reusing commands.ts's own theme/renderer
// validation by building the exact raw string RUN_COMMAND would receive.
export function buildSafeCommandRaw(action: ChatAction): string | null {
  if (action.verb === 'theme') {
    const name = str(action.args, 'name')?.toLowerCase();
    if (!name || !(THEME_NAMES as readonly string[]).includes(name)) return null;
    return `theme ${name}`;
  }
  if (action.verb === 'renderer') {
    const mode = str(action.args, 'mode')?.toLowerCase();
    if (!mode || !(RENDERER_WORDS as readonly string[]).includes(mode)) return null;
    return `renderer ${mode}`;
  }
  return null;
}

// Risky verbs never execute directly -- they build an Approval payload
// pushed via ADD_APPROVAL, routed back to the originating channel via
// channelId (see reducer.ts's RESOLVE_APPROVAL extension).
export function buildApprovalPayload(channel: ChatChannel, action: ChatAction): Omit<Approval, 'id'> | null {
  if (action.verb !== 'spawn' && action.verb !== 'kill' && action.verb !== 'throttle') return null;
  const targetAgentName = str(action.args, 'name');
  if (!targetAgentName) return null;

  const risk = RISK_POLICY[action.verb];
  const actionLabel =
    action.verb === 'spawn' ? `Spawn ${targetAgentName}` : action.verb === 'kill' ? `Kill ${targetAgentName}` : `Throttle ${targetAgentName}`;

  return {
    agent: channel.name,
    i: channel.initials,
    hue: channel.hue,
    action: actionLabel,
    detail: `requested via ${channel.name} chat channel`,
    risk,
    verb: action.verb,
    targetAgentName,
    channelId: channel.id,
  };
}

// Mirrors tick.ts's existing AUTO-mode policy verbatim (`mode === 'AUTO' &&
// req.risk !== 'HIGH'`) rather than inventing a second one -- a chat-
// originated spawn/throttle request is auto-approved exactly as any other
// MED/LOW request already is in AUTO mode; kill (HIGH) never is.
export function shouldAutoApprove(risk: Approval['risk'], opMode: OpMode): boolean {
  return opMode === 'AUTO' && risk !== 'HIGH';
}
```

Run `npm test -- actionExecutor` → PASS, 16 tests.

- [ ] **Step 3: Run the full suite** — `npm test && npx tsc -b` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/actionExecutor.ts src/components/chat/actionExecutor.test.ts
git commit -m "feat: add the chat action executor (risk policy, safe-command + approval-payload builders, AUTO-mode rule)"
```

---

### Task 4: Wire the pipeline into `useChatChannels.ts`

The only hook-layer change. Parses a genuine `askClaude` reply, executes safe verbs immediately, routes risky verbs to the approval queue (with AUTO-mode auto-resolution), and drains `chatActionResults` back into whichever channel requested them.

**Files:**
- Modify: `src/components/chat/useChatChannels.ts`

**Interfaces:**
- Consumes (new): `parseActionLine` from `./actionParser`; `buildSafeCommandRaw`, `buildApprovalPayload`, `shouldAutoApprove` from `./actionExecutor`; `runCommand` from `../terminal/commands`; `dispatch` from `useAetherStore()` (already available at the `ChatView` call site — this hook needs to start receiving `dispatch`, not just `state`, as a parameter; confirm and update `ChatView.tsx`'s call to `useChatChannels(state, dispatch)`).

No new unit-testable logic of its own (per Phase 1/2a's established precedent — everything decision-worthy already lives in the tested `actionParser`/`actionExecutor` modules); this hook is thin composition, verified via the dev server in Task 6.

- [ ] **Step 1: Change `useChatChannels`'s signature to accept `dispatch`**

`ChatView.tsx`'s call becomes `useChatChannels(state, dispatch)` (both already destructured from `useAetherStore()` there — a one-line change).

- [ ] **Step 2: Insert the parsing + safe/risky handling into the send flow**

Replace the existing `.then((reply) => { const finalText = reply ?? ...; ... })` body:

```ts
askClaude(system, toRecentTurns(historyWithUserMsg))
  .catch(() => null)
  .then((reply) => {
    // The action-JSON convention is only ever meaningful for a genuine
    // Claude reply -- localResponder's [offline] fallback text is inert
    // canned prose and is never parsed (see Global Constraints).
    let displayText: string;
    let action: ChatAction | null = null;
    if (reply != null) {
      const parsed = parseActionLine(reply);
      displayText = parsed.text;
      action = parsed.action;
    } else {
      displayText = `[offline] ${localResponder(channel, text, state)}`;
    }

    const assistantMsg: ChatMessage = { id: makeMessageId(), role: 'assistant', text: displayText, t: nowShort() };
    const historyWithReply = appendChannelMessage(channelId, messagesByChannel[channelId] ?? historyWithUserMsg, assistantMsg);
    let finalHistory = historyWithReply;

    if (action) {
      if ((SAFE_VERBS as readonly string[]).includes(action.verb)) {
        const raw = buildSafeCommandRaw(action);
        if (raw) {
          const result = runCommand(state, raw);
          if (result.kind === 'append' && result.patch) {
            dispatch({ type: 'RUN_COMMAND', raw });
            const confirmLine = result.lines[1]?.t ?? `✓ ${raw} applied.`;
            const sysMsg: ChatMessage = { id: makeMessageId(), role: 'system', text: confirmLine, t: nowShort() };
            finalHistory = appendChannelMessage(channelId, finalHistory, sysMsg);
          }
          // Invalid args (defensively re-checked by runCommand) -> silent
          // no-op: the prose reply still displays; nothing executes.
        }
      } else if ((RISKY_VERBS as readonly string[]).includes(action.verb)) {
        const payload = buildApprovalPayload(channel, action);
        if (payload) {
          const newId = state.apprSeq;
          dispatch({ type: 'ADD_APPROVAL', approval: payload });
          if (shouldAutoApprove(payload.risk, state.cfg.opMode)) {
            dispatch({ type: 'RESOLVE_APPROVAL', id: newId, approve: true });
          }
          // No inline "queued" confirmation here -- the one, single source
          // of truth for a risky verb's outcome (auto-approved, manually
          // approved later, or denied later) is the chatActionResults drain
          // effect below, fed exclusively by RESOLVE_APPROVAL. This avoids
          // ever double-messaging a channel about the same resolution.
        }
      }
    }

    setMessagesByChannel((prev) => ({ ...prev, [channelId]: finalHistory }));
    setTypingChannelIds((prev) => { const next = new Set(prev); next.delete(channelId); return next; });
    setUnreadCounts((prev) => (channelId === activeChannelIdRef.current ? prev : { ...prev, [channelId]: (prev[channelId] ?? 0) + 1 }));
  });
```

- [ ] **Step 3: Add the `chatActionResults` drain effect**

```ts
// Bridges an approval resolved from anywhere else in the app (TopBar's
// global approval bell, or the Agents tab's per-agent card -- both dispatch
// the same RESOLVE_APPROVAL this hook never touches directly) back into the
// chat channel that requested it. Runs whenever state.chatActionResults
// changes -- correctly picks up a resolution that happened while this very
// channel was open (the common case, since TopBar's bell is global chrome)
// as well as one that happened while Chat wasn't mounted at all (drained
// lazily the next time Chat opens, since per-channel history is lazily
// hydrated from localStorage on open regardless).
useEffect(() => {
  if (!state.chatActionResults.length) return;
  let processed = 0;
  setMessagesByChannel((prev) => {
    let next = prev;
    for (const result of state.chatActionResults) {
      const sysMsg: ChatMessage = { id: makeMessageId(), role: 'system', text: result.text, t: nowShort() };
      const existing = next[result.channelId] ?? loadChannelMessages(result.channelId);
      next = { ...next, [result.channelId]: appendChannelMessage(result.channelId, existing, sysMsg) };
      processed += 1;
    }
    return next;
  });
  setUnreadCounts((prev) => {
    const next = { ...prev };
    for (const result of state.chatActionResults) {
      if (result.channelId !== activeChannelIdRef.current) next[result.channelId] = (next[result.channelId] ?? 0) + 1;
    }
    return next;
  });
  dispatch({ type: 'CLEAR_CHAT_ACTION_RESULTS', count: processed });
}, [state.chatActionResults]);
```

- [ ] **Step 4: Typecheck** — `npx tsc -b` → exits 0.

- [ ] **Step 5: Run the full suite** — `npm test && npx tsc -b && npm run build` → PASS (no new tests here; `useChatChannels.ts` remains untested directly, per established precedent — Tasks 1–3 already cover every decision this wiring makes).

- [ ] **Step 6: Verify via dev server** — `npm run dev`. With no real key, `askClaude` still resolves `null`; behavior is identical to Phase 2a's (offline fallback only). This step confirms the wiring didn't break the existing flow — the real click-through of the new pipeline happens in Task 6 via the fixture-injection method described there.

- [ ] **Step 7: Commit**

```bash
git add src/components/chat/useChatChannels.ts src/components/chat/ChatView.tsx
git commit -m "feat: wire the action-JSON parser/executor into the chat send flow, with a chatActionResults drain back to the originating channel"
```

---

### Task 5: Confirm the existing approval-queue UI needs zero changes

A verification-only task (no source files touched) — records the finding that made Task 1's design possible, and closes the loop end-to-end at the reducer level without going through React at all.

**Files:** none (verification-only; asserted already by Task 1's reducer tests).

- [ ] **Step 1: Re-confirm by direct code reading**

Re-read `src/components/layout/TopBar.tsx` (lines ~71–76) and `src/components/agents/AgentDetailCard.tsx` — both dispatch `{ type: 'RESOLVE_APPROVAL', id: ap.id, approve: true/false }` and nothing else, reading only `Approval.action`/`.detail`/`.risk`/`.agent`/`.i`/`.hue` for display (all present, unchanged, on every Phase 2b approval too). Confirm neither file references `verb`, `targetAgentName`, or `channelId` anywhere — they don't need to; the extended reducer does all the new work.

- [ ] **Step 2: Run the full suite one more time** — `npm test && npx tsc -b && npm run build` → PASS. No commit expected (nothing changed).

---

### Task 6: Final manual QA — gated (live model) + non-gated (pipeline click-test)

**Files:** none (verification-only task), except a temporary, fully-reverted edit to `src/components/chat/claudeClient.ts` during Step 4 (see below — explicitly not shipped).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (~190+ total), 0 type errors, build succeeds.

- [ ] **Step 2: Check whether a real key is available**

Per the user's current situation, there are no Anthropic billing credits, so `ANTHROPIC_API_KEY` is either absent or every real call returns a billing/auth error and `askClaude` resolves `null`. **Mark Step 3 below BLOCKED/DEFERRED** — do not silently skip it, and do not fake a pass by only exercising the offline path. Note explicitly which items are deferred so a follow-up session can complete them once a funded key is present.

- [ ] **Step 3: Manual QA checklist — BLOCKED/DEFERRED (requires a real, funded `ANTHROPIC_API_KEY`)**

- [ ] Ask AETHER something that plausibly implies a theme/renderer change and confirm the *real* model actually emits the documented action-JSON convention reliably (not just when explicitly instructed in a fixture) — this is the one thing genuinely impossible to verify without live credits.
- [ ] Confirm the real model's action-JSON line, when emitted, is well-formed enough for `parseActionLine` to strip it in practice (not just in hand-written fixtures).
- [ ] Confirm no persona voice ever leaks the JSON line into visible prose (i.e., the model reliably puts it on its own last line as instructed).

- [ ] **Step 4: Non-gated manual QA — click-test the full pipeline via a temporary fixture injection (works today, no credits needed)**

Since the parser/executor/reducer pipeline needs no live model, this is testable for real in the browser right now:

1. Open `src/components/chat/claudeClient.ts`.
2. Temporarily replace the body of `askClaude` with a hardcoded fixture reply, e.g.:
   ```ts
   export async function askClaude(_system: string, _messages: ChatTurn[]): Promise<string | null> {
     return 'Spinning up backup coverage now.\n{"verb":"spawn","args":{"name":"Fixture Agent"}}';
   }
   ```
3. Save — Vite HMR picks it up immediately, no restart needed.
4. Run `npm run dev`, open Chat, send any message in AETHER. Confirm: the displayed reply is only "Spinning up backup coverage now." (no raw JSON visible); a new HIGH/MED/LOW-appropriate entry appears in TopBar's approval queue; approving it from TopBar (while Chat stays open on AETHER) posts a `system`-role "✓ Approved — Fixture Agent spawned." line into the AETHER channel, and the agent actually appears in the Agents view roster.
5. Change the fixture to `'{"verb":"theme","args":{"name":"violet"}}'` (with leading prose) — confirm the theme applies immediately app-wide, a system confirmation line appears in the same channel, and the change also shows up in Terminal's transcript (documented, expected side effect).
6. Change the fixture to `'{"verb":"kill","args":{"name":"Test Runner"}}'` — confirm it queues as HIGH risk (never auto-approves even if OpMode is AUTO), and approving it from the **Agents tab's** per-agent card (not TopBar) still correctly posts the confirmation back to the right chat channel — proving both existing approval-queue UIs route through the same mechanism with zero changes to either.
7. Switch OpMode to AUTO, use a `spawn` or `throttle` fixture, and confirm it resolves immediately with no queue entry ever appearing, still producing a confirmation line in chat.
8. **Revert the temporary edit**: `git diff src/components/chat/claudeClient.ts` should show the fixture change; run `git checkout -- src/components/chat/claudeClient.ts` to discard it, then `git status` to confirm the file is clean again.

This monkey-patch-and-revert approach was chosen over a permanent dev-only affordance (e.g. a `?debug=` query flag or a localStorage override baked into `claudeClient.ts`) specifically so that **no test-only injection code ships** — confirm via `git status` after Step 4.8 that `claudeClient.ts` carries no leftover diff.

- [ ] **Step 5: Record the outcome**

No commit expected unless a genuine bug was found during Step 4 (fix and commit separately, `fix: <description>`). Note in the handoff: Step 4's non-gated pipeline QA is fully verified; Step 3's live-model QA is explicitly BLOCKED/DEFERRED pending a funded `ANTHROPIC_API_KEY`, consistent with Phase 2a's Task 7 precedent.

---

## Execution Handoff

Plan complete. Execute via the same per-task pipeline as Chat Phases 1 and 2a: a fresh implementer subagent per task, a fresh reviewer subagent (spec compliance + code quality) before commit, then one whole-branch review after all tasks land.

### Critical Files for Implementation
- C:\Users\Matt\projects\aether-os\src\state\reducer.ts
- C:\Users\Matt\projects\aether-os\src\state\types.ts
- C:\Users\Matt\projects\aether-os\src\components\chat\actionParser.ts
- C:\Users\Matt\projects\aether-os\src\components\chat\actionExecutor.ts
- C:\Users\Matt\projects\aether-os\src\components\chat\useChatChannels.ts
