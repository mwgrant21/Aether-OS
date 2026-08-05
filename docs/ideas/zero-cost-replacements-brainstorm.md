# Aether OS — Zero-Cost Replacements for the Stripped API Surfaces

Brainstorm doc, 2026-08-05. Not a spec. Everything here is deliberately listed rather
than pre-filtered — organize it down from here.

**Ground rule for every idea below:** it must be powerable by data the app already has
locally (parsed transcripts, IPC snapshots, reducer state, the filesystem, git) with no
outbound network call of any kind. Where an idea needs new plumbing, it says so.

---

## 0. First, the uncomfortable part

Your own diagnosis says the billed models were Sonnet 5 + Haiku 4.5 while `modelPolicy.ts`
was wired to an Opus tier — meaning **the spend did not come from Aether's call site**. The
most likely path was `ANTHROPIC_API_KEY` sitting in the dev environment and Claude Code's
subagent work billing against it directly. `CLAUDE.md` says roughly the same thing about the
July 31st incident: *"mostly unrelated Claude Code terminal spend, but real Aether spend too."*

So: stripping Chat out of Aether is a reasonable thing to do for its own reasons, but it is
**not the fix for what actually charged you**, either time. If the key is still reachable from
a shell where you run Claude Code, incident #3 is still on the table and Aether won't be
responsible for that one either.

The load-bearing fixes are environment-level, and they're cheap:

| Fix | Why it matters |
| --- | --- |
| No `ANTHROPIC_API_KEY` in either machine's environment at all | Claude Code on a subscription doesn't need one. A raw key in the env is what converts "I'm using my plan" into "I'm using metered API." |
| Delete `.env` and `.env.example`'s key line; remove `electron/loadDotEnv.ts` | The app becomes structurally unable to *see* a key, not just unwilling to use one. |
| Remove `@anthropic-ai/sdk` from `package.json` entirely | A boolean returning `false` is a convention. A missing dependency is a compile error. Strictly stronger. |
| Hard spend limit + low-balance alert on the Anthropic console, per key | The only control that works regardless of which process misbehaves. |
| A test that fails if `@anthropic-ai/sdk` reappears in deps | Same shape as your existing `modelPolicyEnforcement.test.ts`. It already guards model IDs; make it guard the SDK too. |

That last one is the one I'd actually push for, because it makes the guarantee survive
future-you re-adding the feature at 1am.

---

## 1. What real estate actually frees up

| Surface | What lives there now | Size |
| --- | --- | --- |
| **`Chat` top-bar tab** | `ChannelRail` (220px) + main panel: header, `MessageThread`, `MessageInput` | A full view — the biggest single chunk |
| **Settings → `ChatBackendCard`** | LIVE/OFFLINE/BROWSER chip + AUTO HEADLINES toggle | One card |
| **Settings → `ModelPolicyCard`** | Model tier selector | One card |
| **Chat header chip** | Backend state indicator | Inline chip |
| **State fields** | `chatActionResults`, `dispatchChannels`, chat-routed `Approval.channelId` | Plumbing, mostly reusable |
| **Sidebar/topbar entry** | `viewRegistry.ts` `{ id: 'Chat', inTopBar: true }` | One slot |

The important observation: the Chat shell is a **three-pane list/thread/input layout**. That
layout is generically useful. The expensive part was never the layout — it was the responder.
Several ideas below keep the shell and swap only what fills it.

---

## 2. Ideas that keep the Chat shell (rail + thread + input)

### 2.1 Transcript Deck — *watch the conversation you're already paying for* ⭐

The single strongest idea on this list, and the one I'd build first.

Claude Code already writes full JSONL transcripts. You already parse them —
`electron/transcriptParser.ts`, `liveAgentTracker.ts`, `src/state/liveAgentsMath.ts`. Every
message in every session and every subagent dispatch is sitting on disk, already generated,
already paid for by your subscription.

- **Rail** = live sessions + subagent dispatches (you already derive dispatch channels)
- **Thread** = the *actual* messages from the transcript, rendered as chat bubbles
- **Input** = becomes a filter/search box over the thread (`/tool Bash`, `/error`, freetext)
- **Header chip** = LIVE / REPLAY / ENDED instead of LIVE / OFFLINE

You get a Slack-like window into what your subagents are actually saying to each other while
they work. The old Chat was "type at a model that costs money." This is "watch the fleet,"
which is more on-theme for a mission-control cockpit anyway, and costs exactly nothing.

**Plumbing needed:** the parser currently discards message content (privacy stance says
"store the signal, not the payload"). This view would need a *display-only, never-persisted*
read path — render from the file, don't put it in the store. That's a real design decision and
should go in the spec, because it brushes against your binding privacy doc.

### 2.2 Dispatch Debrief

Per-dispatch after-action report, threaded. You already have `recentCompletedDispatches`,
`dispatchUsage` (tokens/toolUses/durationMs), `dispatchHeadlines`, `toolCallHistory.ts`,
`anomalies`.

Thread renders as: prompt → tool calls in order → files touched → tokens/duration → any
anomalies raised → outcome. Purely deterministic assembly from data you already hold.

### 2.3 Comms Channel — wire up the personality layer you already built ⭐

You built `voicePacks.ts`, `agentVoiceRoles.ts`, `voiceRender.ts`, `narrationVerbosity.ts`
three days ago. STEWARD, CINDER, PILGRIM, ASSAY, FORGE — archetypes, escalation curves,
frozen lines, severity-indexed samples. **That is a deterministic personality engine and it
costs zero.**

Point it at the chat thread. Real events (anomaly detected, dispatch completed, blocked,
empty result, no signal) select an `EventKind` + severity, `voiceRender` produces the line,
it lands in the channel. STEWARD gets the AETHER channel; role-matched packs get the agent
channels.

You lose "ask a question, get a novel answer." You keep the entire *feel* of the chat deck —
characters with voices reacting to real state — which was arguably 80% of why it was fun. And
CINDER's `"Oh. That's actually interesting."` firing because a real anomaly detector tripped
is more satisfying than the same line coming from a paid completion.

**Plumbing needed:** an event→(EventKind, severity) mapper, and an append path into the thread.
Both small and unit-testable, which fits your testing philosophy exactly.

### 2.4 Local query console (promote `localResponder.ts`)

`localResponder.ts` is already a state-aware keyword responder and already handles burn, budget,
roster, approvals, per-agent status. It's currently the *fallback*. Make it the product.

Grow it into a proper local query surface — same spirit as `commands.ts`'s `runCommand`:

- `burn today` / `burn week` — from `realUsage`
- `who's slow` — dispatches past their median duration
- `what failed` — anomalies + failed tool calls from `toolCallHistory`
- `cost <dispatch>` — `dispatchUsage` × `modelPricing.ts`
- `files` — everything touched this session
- `why` — last anomaly with its detector's reasoning

Deterministic, testable, instant, free. It's not conversational, but it answers the questions
you actually asked the old chat.

### 2.5 Ollama backend (the one that keeps real conversation)

You have Ollama installed and — per your own stated direction — want a local-LLM fallback path
in projects rather than API-only. `localhost:11434` cannot bill you. Ever.

Caveats worth being honest about:
- This is still a "model call," so it needs a code path that is **structurally** incapable of
  reaching `api.anthropic.com` — not a config flag, a separate module with no SDK import and a
  hardcoded loopback base URL. Otherwise you've rebuilt the thing that scared you.
- Quality drops a lot vs. Sonnet for the "summarize my fleet state" job.
- It's the heaviest lift on this list.

I'd list it, not lead with it. If you want conversation back later, this is the door. But 2.1 +
2.3 together probably scratch the itch without opening any door at all.

### 2.6 Alert Inbox

Rail = alert streams (anomalies / permission requests / post-tool flags / budget). Thread =
chronological alerts with ack/dismiss and sound via `alertSounds.ts`. You have `notifs`,
`anomalies`, `pendingPermissionRequest`, `pendingPostToolFlag`, `lastNotification` already.
Mostly a re-presentation of existing data into a better layout.

### 2.7 Approvals Deck

`PermissionCardStack` is currently a small stack. The permission/post-tool-flag loop is one of
the genuinely real, genuinely useful features in this app and it's living in a corner. Give it
the full three-pane shell: rail = sessions, thread = request history with outcomes, input =
the editable-field box (`permissionEditableField.ts` already exists for exactly this).

### 2.8 Memory Deck

Layer 2 memory (decisions, overrules, revisions, supersedes edges, tombstones) rendered as a
threaded conversation per agent rather than a roster. Possibly redundant with `MemoryView` —
listing it for completeness, not recommending it.

---

## 3. Ideas that replace the tab outright

### 3.1 Cost Forensics / Spend Ledger ⭐

The thematically perfect answer: **the tab that burned you becomes the tab that watches the burn.**

- Per-dispatch cost attribution: `dispatchUsage` × `modelPricing.ts`
- Session/day/week rollups from `realUsage`
- "What did today cost me, and which dispatch was the worst offender"
- Cache hit ratio's actual dollar impact (`cacheHitRate.ts` exists)
- A running total that is *observed*, not projected

This is the view you'd have wanted open on both of the days that bit you. It's read-only,
local, and it directly converts your two worst incidents into the app's most useful screen.

### 3.2 Key & Egress Monitor ⭐

A shields-status panel. Zero cost, pure introspection:

- Is `ANTHROPIC_API_KEY` visible to this process? (should read **ABSENT**)
- Does a `.env` exist beside the app? Does it contain a key line?
- Is `@anthropic-ai/sdk` present in `node_modules`?
- Outbound requests to `api.anthropic.com` this session: **0** (a monotonic counter that should
  never move — if it ever does, that's a klaxon)
- Model policy state: **OFF, hard-wired**

Given the actual root cause was an exported key in a dev shell, this is a real instrument and
not just theatre. It's the panel that would have told you on the *first* day.

### 3.3 Session Timeline / Swimlanes

`DispatchTimeline.tsx` exists but small. Expand into a full-view Gantt: one lane per agent,
tool calls as blocks along a time axis, anomalies as markers, hover for detail. Everything it
needs is in `toolCallHistory` + `liveAgentTracker`. High visual payoff, very on-brand for the
cockpit aesthetic, entirely local.

### 3.4 Flight Log / Operator Journal

Manual notes interleaved with auto-inserted event markers (session start, dispatch completed,
anomaly, permission granted). Free-text entries persisted locally. For someone doing IT support
work, "what did I actually do today, and when" is a genuinely valuable artifact — and it's the
kind of thing that writes your own promotion case for you.

### 3.5 Hook & Spool Inspector

Raw view of the `~/.aether-os/spool/` append-only stream and `permissionServer.ts` brokering:
ingest rate, spool size on disk, last N hook events by type, parse failures. Diagnostic value
when the live tracker misbehaves, which is the kind of thing you currently debug by tailing
logs.

### 3.6 Working Set / Diff View

Which files the fleet touched this session, with local `git diff` rendering. Shells out to git
only — no network. Answers "what did the agents actually change" without leaving the cockpit.

### 3.7 Repo Vitals

Run local tooling on demand and surface it: `tsc --noEmit` error count, eslint findings,
`vitest run` pass/fail/skip counts, `git status` cleanliness, worktree list (you have a stated
gotcha about stale `.worktrees/` inflating test counts — this panel would surface that
directly). All local processes.

### 3.8 Reactor Diagnostics / Instrumentation

A deep panel for the reactor itself: renderer mode, FPS, shader state, `rateHistory` traces,
alarm level derivation shown step by step. Pure eye candy plus genuine debug value, zero data
sources needed beyond what's rendering already.

---

## 4. Filling the two Settings cards

### 4.1 COST GUARD card — replaces both ⭐

One card that does what `ChatBackendCard` + `ModelPolicyCard` used to occupy, inverted:

```
COST GUARD
  MODEL CALLS      DISABLED · hard-wired
  API KEY          not visible to this process
  SDK              not installed
  EGRESS           0 requests this session
  AUTO HEADLINES   [ON]   locally computed, no API call
```

Same footprint, same visual weight, opposite meaning. The `AUTO HEADLINES` toggle survives
intact — its hint text already says "computed locally with no API call and no cost," so it was
never part of the problem.

### 4.2 Retention & Purge card

Your privacy doc says *"Settings exposes store size plus a real Purge action."* If that isn't
built yet, this slot is where it goes.

### 4.3 Voice & Narration card

Grow `NarrationVerbosityCard` into full voice-pack selection with live preview of each pack's
severity samples. Pairs with 2.3.

### 4.4 Local Model card

Only if you take 2.5. Ollama endpoint, model list, health check, and an explicit "this endpoint
is loopback-only" assertion.

---

## 5. Rough shortlist, if you want one

Ignore this section if you'd rather organize from the full list yourself.

**Build:** 2.1 Transcript Deck (fills the tab, best payoff) + 2.3 Comms Channel (reuses the
personality layer you just built) + 4.1 Cost Guard card.
**Next:** 3.1 Cost Forensics as its own tab, since 2.1 will already have taught you the
transcript read path.
**Do regardless of any of this:** the environment fixes in §0, and the dependency-guard test.
