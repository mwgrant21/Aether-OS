# Comms Deck Implementation Plan (Stage 14)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the `Comms` tab with two zero-cost sources that already exist in the repo — real
Claude Code transcript messages rendered in the thread, and Stage 12's voice packs narrating
real events in-channel — so the deck reads as a live window onto the fleet rather than a
retired chat window.

**Architecture:** Three movements. (1) A pull-based transcript read path: a new
request/response IPC channel in Electron main that reads a bounded tail of a transcript file,
shapes it into display-only messages via the existing `parseTranscriptLine`, and returns it —
never touching the store. (2) The thread and rail re-pointed at that source, with the input box
becoming a filter. (3) The narration feed: real events mapped to `(EventKind, Severity)`,
rendered by Stage 12's `renderNarration()`, interleaved chronologically into the same thread,
gated by `narrationVerbosity` and ranked by `interruptionBudget`.

**Tech Stack:** TypeScript (strict), React 18, Electron, Vitest.

## Global Constraints

- Full spec: `docs/superpowers/specs/2026-08-05-comms-deck-stage14-design.md`. **Read "The
  privacy decision" section before writing any code** — it amends a document marked binding,
  and getting it wrong is the one failure in this stage that is not recoverable by a follow-up
  commit.
- **Depends on Stage 13.5.** Do not start until `docs/superpowers/plans/2026-08-05-api-teardown-stage13.5.md`
  has merged. Every path in this plan assumes `src/components/comms/`.
- **Transcript content never enters the store.** Not `AetherState`, not `persistence.ts`'s
  whitelist, not `~/.aether-os/`, not the collector's SQLite. It lives in the mounted
  component's own `useState` and dies with the view. Task 3 adds the test that enforces this;
  every task before it must not violate it.
- **Do not change `electron/transcriptParser.ts`'s `TranscriptEvent` contract.** `CLAUDE.md`
  names it as the single place raw lines become typed events, and both `liveAgentTracker.ts`
  and `src/state/liveAgentsMath.ts` consume it. Shape display messages in a *new* module that
  consumes `parseTranscriptLine`'s output — do not widen the parser.
- **Zero model calls.** Stage 13.5 removed the SDK; `src/shared/noApiCalls.test.ts` will fail
  the build if anything in this stage reintroduces one. There is no send path in this stage.
- Use `useColors()` and the `Button` primitive per the established conventions. Persistent
  quiet-chip backgrounds use `colors.panelInset` + `colors.chipBorder`.
- `npm test`, `npm run build`, and `npm run electron:build` clean before every commit. Tasks
  1–3 touch `electron/`, so `electron:build` is mandatory on those.

---

### Task 1: Verify the on-disk transcript layout, then build the read path

**Files:**
- Create: `electron/transcriptReader.ts`, `electron/transcriptReader.test.ts`
- Create: `e2e/fixtures/transcript-sample.jsonl` (or `electron/__fixtures__/`, matching
  whatever fixture convention already exists — check `collector/src/` first)
- Modify: `electron/main.ts`, `electron/preload.ts`, `src/aetherElectron.d.ts`

**Interfaces:**
- Consumes: `parseTranscriptLine` from `electron/transcriptParser.ts` (unchanged),
  `activeSessionFinder.ts` / `historyScanner.ts` for locating session files.
- Provides: `aetherElectron.transcript.read({ source, limit, before? })` →
  `Promise<DisplayMessage[]>`, and `aetherElectron.transcript.sources()` →
  `Promise<TranscriptSource[]>`.

**Steps:**
- [ ] **Before writing anything, verify the on-disk layout against real transcripts on this
      machine.** Open a recent session file under `~/.claude/projects/` and answer, in writing
      in the module's header comment: does a subagent dispatch's own conversation live in the
      parent transcript, in a separate file, or not on disk at all? The spec names this as an
      open question that must be verified, not assumed — the answer determines whether dispatch
      channels get their own source or a filtered window on the parent. **Record the answer in
      the commit message.**
- [ ] Define `DisplayMessage` in `transcriptReader.ts` — a display-only shape, deliberately
      separate from `TranscriptEvent`:
      `{ id: string; role: 'human' | 'assistant' | 'system'; atMs: number; text: string | null;
      toolCalls: { name: string; label: string }[]; toolResults: { resultLength: number }[] }`.
      Reuse `labelForToolUse` from `src/state/liveAgentsMath.ts` for `label` — it already
      produces exactly the `Bash · npm test` shape this needs, and duplicating it would let the
      two drift.
- [ ] Implement a **bounded tail read**. Do not `readFileSync` the whole file — the spec names
      multi-megabyte transcripts as a real stall risk on the main process. Read from the end in
      chunks until `limit` complete lines are collected, or the file start is reached. Take
      `before` (a message id or byte offset) to support "load older".
- [ ] Implement `sources()`: enumerate the pinned/active session plus any separately-addressable
      dispatch transcripts (per the Step 1 finding). Return
      `{ id, kind: 'session' | 'dispatch', label, isLive }` — `isLive` from whether the file's
      mtime is advancing.
- [ ] Register `transcript:read` and `transcript:sources` as `ipcMain.handle` request/response
      channels in `main.ts`. **Do not push them on the tick** and do not add a `useSyncX` hook
      for them — the spec's pull-only decision exists specifically to keep payload out of the
      store, and the established `useRealAgentsSync.ts` pattern is the wrong one here. Add a
      comment at the registration site saying so, since it is the first deliberate deviation
      from that pattern in the app.
- [ ] Expose both on the `contextBridge` in `preload.ts` under a new `transcript` object, and
      declare them in `src/aetherElectron.d.ts`.
- [ ] Write `transcriptReader.test.ts` against a committed fixture JSONL containing: a human
      prompt, an assistant message with two `tool_use` blocks, a user message with a
      `tool_result`, a `task-notification` completion, and one malformed line. Assert the
      malformed line is skipped (matching `parseTranscriptLine`'s null contract) rather than
      throwing.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run electron:build` clean.
- [ ] Commit: `feat(comms): add a bounded, pull-based transcript read path` — including the
      Step 1 finding in the body.

---

### Task 2: Filter expressions

**Files:**
- Create: `src/components/comms/transcriptFilter.ts`, `src/components/comms/transcriptFilter.test.ts`

**Interfaces:**
- Provides: `parseFilter(raw: string): Filter` and `applyFilter(messages: DisplayMessage[], f: Filter): DisplayMessage[]`.

**Steps:**
- [ ] `parseFilter` handles: bare text (case-insensitive substring across `text` and tool
      labels), `/tool <name>`, `/human`, `/error`. Unrecognized `/verbs` fall through to bare
      text rather than erroring — same spirit as `localResponder`'s catch-all, and a filter box
      that rejects input is worse than one that over-matches.
- [ ] `/error` matches on tool-result presence combined with a failure-shaped tool label. Be
      conservative and **document what it misses in a comment** — result *content* is not
      available (`TranscriptToolResult` carries `resultLength` only), so this cannot detect a
      command that failed quietly. Say so in the code, not just here.
- [ ] An empty filter returns the input array unchanged, by identity, so the thread does not
      re-render on every keystroke that clears the box.
- [ ] Exhaustive unit tests — this is pure logic and the project's testing philosophy is
      explicit that pure logic gets exhaustive coverage.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean.
- [ ] Commit: `feat(comms): add transcript filter expressions`

---

### Task 3: Re-point the thread and rail at transcripts

**Files:**
- Modify: `src/components/comms/CommsView.tsx`, `MessageThread.tsx`, `MessageInput.tsx`,
  `ChannelRail.tsx`, `useCommsChannels.ts`, `commsChannels.ts`
- Create: `src/components/comms/useTranscriptSource.ts`
- Create: `src/state/noPayloadInStore.test.ts`
- Modify: `src/components/comms/MessageThread.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `aetherElectron.transcript.*`, `parseFilter`/`applyFilter`.
- `useTranscriptSource(sourceId)` owns the fetched messages in its **own `useState`** and
  exposes `{ messages, isLive, loadOlder, refresh }`.

**Steps:**
- [ ] Write `src/state/noPayloadInStore.test.ts` **first**, before wiring anything. Assert that
      `AetherState` (via `initialState`) contains no key holding transcript message content,
      and that `persistence.ts`'s whitelist contains no such key. Reuse the tree-walking shape
      from `noApiCalls.test.ts` if a source-scan is the clearer assertion. This test exists so
      the constraint outlives this plan — write it first so it is never retrofitted around
      code that already violates it.
- [ ] `useTranscriptSource.ts`: fetch on mount and on `sourceId` change; re-fetch the tail on
      the app's existing tick **only when `isLive`**; expose `loadOlder()` calling
      `transcript.read({ before })`. Hold everything in local state. Add a header comment
      stating the render-not-store rule and pointing at `docs/privacy-and-data.md`.
- [ ] `commsChannels.ts`: extend `deriveChannels` so each channel carries a `transcriptSourceId`
      (or `null` for channels with no backing source — archived agents, for instance). Keep the
      existing derivation semantics; this adds a field, it does not change which channels exist.
- [ ] `MessageThread.tsx`: render `DisplayMessage`. Three visual treatments — human prompt,
      assistant text, and a compact tool row. Tool rows show `name · label` and, when a matching
      result exists, a size chip. **Do not attempt to render result content** — it is not in the
      data (see the parser's `TranscriptToolResult`).
- [ ] `MessageInput.tsx`: becomes the filter box. Placeholder
      `Filter ${channel.name}… (/tool, /human, /error)`. Remove the send affordance entirely —
      there is no send path in this stage and a disabled send button is exactly the
      looks-alive-isn't class this project has repeatedly designed against.
- [ ] `CommsView.tsx`: replace the `LIVE`/`OFFLINE`/`BROWSER` chip (removed in Stage 13.5) with
      `LIVE` / `REPLAY` / `ENDED` from `isLive` plus whether the source resolved at all.
- [ ] Keep `localResponder` reachable: if the filter box's content is not a filter expression
      and the active channel is AETHER, the existing responder still answers into the thread.
      If that proves awkward in practice, **say so in `PROGRESS.md` rather than silently
      dropping it** — the spec commits to keeping it.
- [ ] Component tests: thread renders each of the three message kinds; rail derives a source id
      per channel; the filter box narrows the rendered set.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean,
      `npm run electron:build` clean.
- [ ] Commit: `feat(comms): render real transcript messages in the thread`

---

### Task 4: Frozen-phrase predicates

**Files:**
- Create: `src/shared/frozenPhraseDetect.ts`, `src/shared/frozenPhraseDetect.test.ts`

**Interfaces:**
- Consumes: `EventKind` and `VoiceRole` from `voicePacks.ts` / `agentVoiceRoles.ts`.
- Provides: `detectEventKind(input: FrozenPhraseInput): EventKind | null`.

**Steps:**
- [ ] Implement the four predicates from the spec's table:
      `all_clear` (STEWARD; zero open dispatches, zero anomalies, zero pending permission
      requests), `empty_result` (PILGRIM; a completed dispatch whose tool calls were all
      read/search shaped and whose result lengths were all trivially small),
      `no_signal` (ASSAY; fatal exit state, or zero tool calls where tool calls were expected),
      `critic_tell` (CINDER; a completed review dispatch at severity ≥ 3).
- [ ] **Every predicate returns `null` when uncertain.** The spec is explicit that under-firing
      is the acceptable failure direction and misfiring is not. Encode that as the default
      branch, not as a comment.
- [ ] Give each predicate a comment naming what it cannot detect. `empty_result` in particular
      is inferring "found nothing" from result *lengths*, because result content is not
      available — write that limitation down where the next reader will find it.
- [ ] This closes the Stage 12 open item recorded in `docs/roadmap.md` row 12 ("all 4 frozen
      phrases remain unreachable"). Reference that row in the module header so the connection
      is discoverable from either end.
- [ ] Exhaustive unit tests, including the uncertain-input cases that must return `null`.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean.
- [ ] Commit: `feat(comms): detect the four frozen-phrase event kinds`

---

### Task 5: The narration feed

**Files:**
- Create: `src/components/comms/narrationFeed.ts`, `src/components/comms/narrationFeed.test.ts`
- Modify: `src/components/comms/useCommsChannels.ts`, `MessageThread.tsx`
- Modify: `src/state/types.ts`, `src/state/reducer.ts`, `src/state/reducer.narration.test.ts`

**Interfaces:**
- Consumes: `VOICE_PACKS`, `resolveVoiceRole`, `renderNarration`, `detectEventKind`,
  `applyVerbosity` (`narrationVerbosity.ts`), `interruptionBudget.ts`.
- Provides: `narrationForEvent(event, state): NarrationMessage | null`.

**Steps:**
- [ ] Map real events to `(VoiceRole, EventKind | null, Severity)`. Sources, all already in
      state or already arriving over IPC: dispatch completion (`agents:onCompleted`, carrying
      real severity since the Stage 12 follow-up), anomaly detected/cleared (`state.anomalies`),
      permission request pending (`state.pendingPermissionRequest`), post-tool flag
      (`state.pendingPostToolFlag`). The AETHER channel binds to STEWARD per spec §8; agent and
      dispatch channels bind via `resolveVoiceRole(subagentType)`.
- [ ] Call `renderNarration(pack, severity, eventKind)` — **passing the real `eventKind` from
      Task 4, not `null`.** That single argument is what makes the frozen phrases reachable;
      it is the point of Task 4 and the closing of the Stage 12 gap.
- [ ] Apply `narrationVerbosity` exactly as the roster does, **including the severity-≥3 floor
      that renders regardless of the dial** and ASSAY's sev-4 exemption. Do not reimplement the
      dial — call the existing `applyVerbosity`. If its current signature does not fit a feed
      context, extend it in `narrationVerbosity.ts` rather than forking the logic.
- [ ] **Give `interruptionBudget.ts` its first real consumer.** It has been instrumented and
      unconsumed since Stage 12. Use it to rank which narration lines may raise a channel's
      unread badge; lines that lose the ranking still appear in-thread, they just do not
      interrupt. Note in `PROGRESS.md` that this closes the "unconsumed scaffolding" item.
- [ ] Narration messages are appended to the channel's message list **in the reducer**, not held
      in view state — they are derived from events, contain no transcript payload, and are
      already the same category as `dispatchNarrations`, which the store holds today. Interleave
      them chronologically with transcript messages at render time in `MessageThread.tsx`,
      visually distinct (voice name + the character-styled line, not a chat bubble).
- [ ] Add the narration message list to `persistence.ts`'s whitelist **or** its documented
      exclusions — decide which and write down why. A session-scoped feed is a defensible
      exclusion; an undocumented one is the bug class Stage 0.5 closed.
- [ ] Tests: event→voice mapping per role; verbosity dial including the sev-3 floor; frozen
      phrase reaching the rendered line end-to-end for at least one role; interruption-budget
      ranking.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean.
- [ ] Commit: `feat(comms): narrate real events through the voice packs`

---

### Task 6: Privacy amendment and documentation

**Files:**
- Modify: `docs/privacy-and-data.md`, `CLAUDE.md`, `docs/roadmap.md`, `README.md`, `PROGRESS.md`

**Steps:**
- [ ] `docs/privacy-and-data.md`: add the **render-vs-store** distinction as a first-class
      paragraph under "Store the signal, not the payload", in the spec's wording: transcript
      content may be read and rendered in a mounted view, and must never enter the store,
      persistence, `~/.aether-os/`, or the collector schema. Name `noPayloadInStore.test.ts` as
      the enforcement. **This is an amendment to a binding document — flag it explicitly in the
      whole-branch review, not just in the diff.**
- [ ] `CLAUDE.md`: add `comms/` to the architecture map's component list; note that the
      transcript read path is the app's one deliberate exception to the `useRealAgentsSync.ts`
      push pattern, and why.
- [ ] `docs/roadmap.md`: add the Stage 14 row. **Update row 12's "Still open, not glossed"
      text** — the frozen phrases are reachable now, and leaving that sentence stale would be
      the same dangling-citation class §3.4 and the CLAUDE.md MSVC gotcha both had to correct.
- [ ] `README.md`: describe the Comms deck as it actually shipped.
- [ ] `PROGRESS.md`: entry in the established format, stating plainly: (a) the Task 1 finding
      about subagent transcript addressability and which fallback shipped if they were not
      separable; (b) that tool result *content* is unavailable and the thread shows size chips
      only; (c) that the frozen-phrase predicates are conservative heuristics that under-fire by
      design; (d) that `interruptionBudget.ts` now has a real consumer; (e) whether
      `localResponder` survived in practice; (f) that visual verification of the live deck is
      deferred to the operator, per this project's established pattern for anything needing real
      session data.
- [ ] Commit: `docs: record the Stage 14 Comms deck and amend the privacy stance`

---

After all six tasks: whole-branch review, with two questions the reviewer must answer
explicitly rather than by reading the test names —

1. **Can transcript content reach the store, persistence, or disk by any path?** Answer by
   reading, independently of `noPayloadInStore.test.ts`.
2. **Does the privacy amendment say what the code actually does?** The document is binding, and
   the next feature will cite whichever version it finds.
