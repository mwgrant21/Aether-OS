# API Teardown Implementation Plan (Stage 13.5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every model-calling capability from Aether OS, so the app cannot place a
paid API call without a dependency being reinstalled — replacing Stage 11.5's
policy-by-convention with structural impossibility. The `Chat` tab survives as `Comms`,
rendering the existing zero-cost `localResponder`, so no commit in this sequence leaves the
app broken or a tab inert.

**Architecture:** Four movements, in order. (1) Delete the call path — the SDK, `chatCore`,
`claudeClient`, `systemPrompt`, the Vite proxy plugin, and the `chat:*` IPC pair. (2) Delete
the key path — `loadDotEnv.ts` and its `main.ts` call site, so the process cannot read a key
from disk. (3) Retire the policy module and replace its allowlist test with a stricter
capability guard that depends on no allowlist. (4) Rename `src/components/chat/` →
`src/components/comms/` with `git mv` so the presentational rail/thread/input markup keeps its
history, and reshuffle Settings so `AUTO HEADLINES` outlives the card that housed it.

**Tech Stack:** TypeScript (strict), React 18, Electron, Vitest, Playwright.

## Global Constraints

- Full spec: `docs/superpowers/specs/2026-08-05-api-teardown-stage13.5-design.md`. Read it
  first — in particular the "Known limitation, named plainly" section, which states that this
  stage cannot prevent the failure that motivated it.
- `npm test`, `npm run build`, and `npm run electron:build` clean before every commit. This
  stage touches `electron/` in three separate tasks, so `electron:build` is not optional on
  any of them.
- **Use `git mv` for the `chat/` → `comms/` rename** (Task 6). Do not delete-and-recreate —
  blame history on the rail/thread markup is the whole reason the rename exists rather than a
  deletion.
- **Do not touch `src/shared/modelPricing.ts`.** It is pricing math, never a call site, and
  Stage 15 depends on it. Its `optimizeRules.ts` consumer must stay green.
- **Do not touch `electron/permissionServer.ts`.** Loopback-only HTTP for hook brokering,
  unrelated to API spend. Named explicitly because "remove the HTTP server" is a plausible
  misreading of this plan.
- **Do not touch `src/shared/voicePacks.ts`, `voiceRender.ts`, `narrationVerbosity.ts`,
  `interruptionBudget.ts`, or `attentionTracker.ts`.** The Stage 12 personality layer is
  deterministic, costs nothing, and is Stage 14's foundation.
- When removing a `Cfg` key or a top-level `AetherState` key, update
  `src/state/persistence.ts`'s whitelist **and** `persistence.test.ts`'s
  documented-exclusions list in the same commit. This is the exact recurring bug class Stage
  0.5 built that test to catch — three past misses are on record in `PROGRESS.md`.
- Deletions are expected to cascade into imports across `reducer.ts`, `types.ts`,
  `initialState.ts`, `preload.ts`, and `aetherElectron.d.ts`. Let `npx tsc -b` drive the
  cleanup — do not guess at the import graph, compile and fix what it names.

---

### Task 1: Remove the SDK and the model call path

**Files:**
- Modify: `package.json`
- Delete: `src/shared/chatCore.ts`, `src/shared/chatCore.test.ts`
- Delete: `src/components/chat/claudeClient.ts`, `src/components/chat/claudeClient.test.ts`
- Delete: `src/components/chat/systemPrompt.ts`, `src/components/chat/systemPrompt.test.ts`
- Delete: `vite-plugins/chatProxyPlugin.ts`, `vite-plugins/chatProxyPlugin.test.ts`
- Modify: `vite.config.ts`

**Interfaces:**
- Removes: `runChatRequest` (consumed by `electron/main.ts` — Task 2 handles that side),
  `askClaude` (consumed by `useChatChannels.ts` — Task 5), `buildSystemPrompt` and its scoped
  snapshot builders (consumed only by the deleted files and their own tests).

**Steps:**
- [ ] Remove `"@anthropic-ai/sdk": "^0.112.3"` from `package.json` `dependencies`. Run
      `npm install` so `package-lock.json` regenerates with the SDK and its transitive deps
      removed — commit the lockfile change.
- [ ] Delete the eight files listed above.
- [ ] `vite.config.ts`: remove the `chatProxyPlugin()` entry from the `plugins` array and its
      import. Read the file first — it also does `loadEnv` for `.env`, which Task 2 removes;
      leave that alone in this task to keep the two concerns in separate commits.
- [ ] Run `npx tsc -b` and fix every resulting error **by deletion, not by stubbing** —
      any code that only existed to feed a model call goes with it. Expect breakage in
      `electron/main.ts` and `src/components/chat/useChatChannels.ts`; those are Tasks 2 and 5,
      so if the errors are confined to those two files, note them and move on rather than
      pre-empting later tasks.
- [ ] Verify: `npx vitest run` — the deleted tests should be gone, remaining suite green.
- [ ] Commit: `feat(teardown): remove the Anthropic SDK and the model call path`

---

### Task 2: Remove the key path and the chat IPC

**Files:**
- Delete: `electron/loadDotEnv.ts`, `electron/loadDotEnv.test.ts`
- Delete: `electron/modelSpendTracker.ts`, `electron/modelSpendTracker.test.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/aetherElectron.d.ts`
- Modify: `vite.config.ts`
- Modify: `.env.example`

**Interfaces:**
- Removes from the preload bridge: `aetherElectron.chat.send`, `aetherElectron.chat.hasKey`,
  `aetherElectron.agents.setModelPolicyMode`, `aetherElectron.agents.getModelSpend`.
- Preserves: `aetherElectron.agents.setAutoHeadlines` and every `on*` subscription. Auto
  headlines are computed by `electron/headlineGenerator.ts`'s `formatHeadline()` with no model
  call — that function stays.

**Steps:**
- [ ] `electron/main.ts`: remove the `loadDotEnvInto(...)` call and its import; remove the
      `chat:send` and `chat:hasKey` `ipcMain.handle` registrations and `runChatRequest`;
      remove `modelPolicyMode` state, the `agents:setModelPolicyMode` handler, and the
      `agents:getModelSpend` handler. Read the file before editing — it is the largest file in
      `electron/` and these are scattered, not contiguous.
- [ ] `electron/preload.ts`: remove the `chat` object from the `contextBridge` exposure, and
      remove `setModelPolicyMode` / `getModelSpend` from the `agents` object. **Do not
      monkey-patch or reshape the rest of the bridge** — `CLAUDE.md` names this file as frozen
      by convention, matching TokenMonitor's.
- [ ] `src/aetherElectron.d.ts`: remove the same four members so the type declaration matches
      the real bridge exactly.
- [ ] Delete `electron/loadDotEnv.ts` + test and `electron/modelSpendTracker.ts` + test.
- [ ] `vite.config.ts`: remove the `loadEnv` call and any `define` entry that injected
      `ANTHROPIC_API_KEY` into the renderer. Read the file — if `loadEnv` is also feeding
      unrelated non-secret config, keep that and remove only the key handling.
- [ ] `.env.example`: remove the `ANTHROPIC_API_KEY=` line. If nothing else remains in the
      file, delete `.env.example` entirely and remove `.env` from `.gitignore`'s list only if
      no other `.env` consumer exists (check first — do not loosen `.gitignore` speculatively).
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean,
      `npm run electron:build` clean.
- [ ] Commit: `feat(teardown): remove .env key loading and the chat IPC surface`

---

### Task 3: Retire the policy module, replace its test with a capability guard

**Files:**
- Delete: `src/shared/modelPolicy.ts`, `src/shared/modelPolicy.test.ts`
- Delete: `src/shared/modelPolicyEnforcement.test.ts`
- Create: `src/shared/noApiCalls.test.ts`
- Modify: `src/state/types.ts`, `src/state/initialState.ts`, `src/state/reducer.ts`,
  `src/state/persistence.ts`, `src/state/persistence.test.ts`

**Interfaces:**
- Removes: `ModelPolicyMode`, `isModelCallAllowed()`, `resolveModel()`, `ALLOWED_MODELS`, and
  `Cfg.modelPolicyMode`.
- Creates: no runtime exports — `noApiCalls.test.ts` is a test-only file.

**Steps:**
- [ ] Write `src/shared/noApiCalls.test.ts` **before** deleting anything, so the new guard is
      proven to pass on the current tree first. Lift the `ROOTS` / `SKIP_DIR_NAMES` / `walk()`
      / `allSourceFiles()` scaffolding verbatim from `modelPolicyEnforcement.test.ts` — it is
      proven and this is deliberate reuse, not duplication. Assert four things:
  1. `@anthropic-ai/sdk` appears in neither `dependencies` nor `devDependencies` of
     `package.json` (read and `JSON.parse` the file).
  2. No source file contains `@anthropic-ai/sdk` (catches a stray import even if the dep is
     absent).
  3. No source file contains the string `api.anthropic.com`.
  4. No source file contains a `messages.create(` call — carry the existing regex
     `/messages\.create\s*\(/` over verbatim, dropping its `chatCore.ts` exemption since that
     file no longer exists.
- [ ] Carry over the generic `MODEL_ID_SHAPE` check (`/claude-[a-z]+-\d/`) into the same file,
      **keeping the `src/shared/optimizeRules.ts` entry in `LITERAL_EXCEPTIONS`** with its
      existing explanatory comment. It is a pricing comparison, not a call site, and Stage 15
      will lean on the same pattern. Since `ALLOWED_MODELS` is going away, this generic check
      becomes the only model-ID guard — that is intended.
- [ ] Confirm the new test passes against the current tree, then delete `modelPolicy.ts`,
      `modelPolicy.test.ts`, and `modelPolicyEnforcement.test.ts`.
- [ ] `src/state/types.ts`: remove `modelPolicyMode` from `Cfg` and the `ModelPolicyMode`
      import.
- [ ] `src/state/initialState.ts`: remove its `modelPolicyMode` default.
- [ ] `src/state/reducer.ts`: remove any `UPDATE_CFG` handling specific to `modelPolicyMode`
      (likely none — it flows through the generic patch — but check).
- [ ] `src/state/persistence.ts` + `persistence.test.ts`: remove `modelPolicyMode` from the
      persisted whitelist and update the round-trip coverage test. If the test's
      documented-exclusions list needs a new entry, add it **with a comment naming why**, per
      that file's established convention.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean.
- [ ] Commit: `feat(teardown): replace the model-policy allowlist with a capability guard`

---

### Task 4: Settings reshuffle — preserve AUTO HEADLINES

**Files:**
- Delete: `src/components/settings/ChatBackendCard.tsx`
- Delete: `src/components/settings/ModelPolicyCard.tsx`
- Modify: `src/components/settings/OperatingModeCard.tsx`
- Modify: `src/components/settings/SettingsView.tsx`

**Interfaces:**
- Consumes: `useColors`, `Button`, `useAetherStore` — all already imported by
  `OperatingModeCard.tsx`.
- Preserves: `Cfg.autoHeadlines` and the `window.aetherElectron?.agents.setAutoHeadlines()`
  push-on-mount effect, moved intact.

**Steps:**
- [ ] Read `OperatingModeCard.tsx` and `ChatBackendCard.tsx` side by side. Move the
      `AUTO HEADLINES` label, its `Button` toggle, its `hintStyle` copy, **and its
      `useEffect` that pushes the persisted preference to main on every mount** into
      `OperatingModeCard.tsx`. That effect is load-bearing: `main.ts` starts with its own
      default until told otherwise, so dropping it silently desyncs the setting across app
      restarts.
- [ ] Update the moved hint copy — the current text ("computed locally with no API call and no
      cost") is still accurate and should stay, but drop any sentence that positions it
      relative to a Chat backend that no longer exists.
- [ ] Delete `ChatBackendCard.tsx` and `ModelPolicyCard.tsx`.
- [ ] `SettingsView.tsx`: remove both imports and both elements from the column. Do not
      reorder the surviving cards — the column order is established and this is a teardown,
      not a redesign. The column will be visibly shorter; Stage 15 addresses that gap from the
      Ledger side, and the spec records the decision not to backfill it here.
- [ ] Delete `src/components/chat/useChatBackendState.ts` (its only consumers were the two
      deleted cards and the Chat header chip, which Task 5 removes).
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean,
      `npm run electron:build` clean.
- [ ] Commit: `feat(teardown): fold AUTO HEADLINES into OperatingModeCard, remove the chat/model settings cards`

---

### Task 5: Reduce the chat feature to the local responder

**Files:**
- Modify: `src/components/chat/useChatChannels.ts`
- Modify: `src/components/chat/ChatView.tsx`
- Delete: `src/components/chat/personas.ts`, `src/components/chat/personas.test.ts`
- Modify: `src/shared/agentVoiceRoles.ts` (comment only)
- Modify: `src/components/terminal/commands.ts` (only if it references a removed export)

**Interfaces:**
- `useChatChannels` keeps its full public shape (`channels`, `activeChannel`,
  `activeChannelId`, `setActiveChannelId`, `messages`, `unreadCounts`, `isTyping`,
  `sendMessage`) — Stage 14 builds on it. Only its internals change.

**Steps:**
- [ ] Read `useChatChannels.ts` in full (~10KB) before editing. Remove the `askClaude` call,
      the try/fallback branching around it, and the action-JSON parse/execute path if it is
      reachable only from a model reply. `sendMessage` should now call `localResponder()`
      directly and unconditionally.
- [ ] Keep `isTyping` and the artificial reply delay if one exists — an instant reply reads as
      broken, and the typing indicator is presentational, not a model artifact. If no delay
      exists, do not add one; this is a teardown.
- [ ] **Decide and record:** `actionParser.ts` / `actionExecutor.ts` implement the
      spawn/kill/throttle approval pipeline that was fed by model-emitted action JSON. Check
      whether `commands.ts`'s Terminal `approvals`/`approve`/`deny` commands or `tick.ts`'s
      risk-event generator still reach `ADD_APPROVAL` independently. If they do, **keep both
      files and the `Approval` type** — `types.ts`'s existing comment already documents that
      this system is separate from the real `PermissionRequest` loop and was deliberately kept.
      If the model reply was the only remaining producer, delete `actionParser.ts`,
      `actionExecutor.ts`, their tests, and `state/chatActionResult.ts`, and remove
      `chatActionResults` from `AetherState` + the persistence whitelist. Do not guess —
      grep for `ADD_APPROVAL` and follow every call site.
- [ ] `ChatView.tsx`: remove the backend chip (`CHIP_LABEL`, `CHIP_TITLE`, `backendChipStyle`,
      the `useChatBackendState` import and its render branch). Leave the header dot, name, and
      TERMINATED pill.
- [ ] Delete `personas.ts` + test. Update the prose comment at the top of
      `src/shared/agentVoiceRoles.ts` that cites `personas.ts`'s `FALLBACK_PERSONA` pattern —
      the pattern reference is still valid history, so reword to past tense rather than
      deleting the explanation of *why* the map has a named default.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean.
- [ ] Commit: `feat(teardown): reduce chat replies to the local responder`

---

### Task 6: Rename Chat to Comms

**Files:**
- Rename (via `git mv`): `src/components/chat/` → `src/components/comms/`
- Rename: `ChatView.tsx` → `CommsView.tsx`, `useChatChannels.ts` → `useCommsChannels.ts`,
  `chatChannels.ts` → `commsChannels.ts`, `chatPersistence.ts` → `commsPersistence.ts`
  (and each one's `.test.ts` sibling)
- Modify: `src/viewRegistry.ts`, `src/viewRegistry.test.ts`
- Modify: `src/state/persistence.ts` (if `activeTab` can persist the string `'Chat'`)

**Interfaces:**
- `VIEWS` gains `{ id: 'Comms', inTopBar: true, inSidebar: false, component: CommsView }`
  in the same array position `Chat` occupied.

**Steps:**
- [ ] `git mv src/components/chat src/components/comms`, then `git mv` each of the four
      file-level renames above plus their tests. Verify with `git status` that all show as
      renames (`R`), not as add+delete — if any shows as add+delete, the rename was done
      wrong and history is lost.
- [ ] Update every import path across the tree. `npx tsc -b` will name them all; work through
      its output rather than grepping speculatively.
- [ ] Rename the symbols inside the moved files: `ChatView` → `CommsView`,
      `useChatChannels` → `useCommsChannels`, `ChatChannel` → `CommsChannel`,
      `deriveChannels` keeps its name. Keep `AETHER_CHANNEL_ID` as-is — it names the AETHER
      persona, not the chat feature.
- [ ] `viewRegistry.ts`: change the entry's `id` from `'Chat'` to `'Comms'` and the import.
      Leave `inTopBar: true, inSidebar: false` unchanged.
- [ ] `viewRegistry.test.ts`: update any assertion naming `'Chat'`.
- [ ] **Check `state.activeTab` persistence.** If a persisted `activeTab: 'Chat'` from a prior
      run would now resolve to no view, add a migration or a fallback in
      `persistence.ts`/`initialState.ts` so a returning user lands on Dashboard rather than a
      blank frame. Read `getViewComponent()`'s null-return path first — if `App.tsx` already
      handles an unknown tab gracefully, note that and skip the migration.
- [ ] `e2e/app.spec.ts`: update any selector or tab-name assertion referencing Chat.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean,
      `npm run electron:build` clean, `npm run test:e2e` clean.
- [ ] Commit: `refactor: rename the Chat tab to Comms ahead of Stage 14`

---

### Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `docs/roadmap.md`, `docs/privacy-and-data.md`,
  `PROGRESS.md`

**Steps:**
- [ ] `CLAUDE.md`: delete the "Real Claude replies in Chat need `ANTHROPIC_API_KEY`…"
      paragraph in "Run / test / build" entirely. Rewrite the **Model calls** bullet under
      "Key conventions" to state the new rule: *no model call site exists; the SDK is not a
      dependency; `noApiCalls.test.ts` fails the build if either changes.* Keep the
      `formatHeadline()` guidance — the prefer-a-deterministic-formatter advice is now the
      only option, not the preference.
- [ ] `docs/privacy-and-data.md`: the "Nothing leaves this machine **except** Chat's scoped
      context snapshot" clause is now unconditional. Rewrite to *"Nothing leaves this machine.
      There is no exception."* Remove the `systemPrompt.ts` snapshot-leak-test bullet, and
      note in its place that the leak tests were retired because the surface they guarded no
      longer exists.
- [ ] `README.md`: remove Chat-as-Claude-backed from the feature list; describe `Comms` as it
      actually is after this stage, without overselling what Stage 14 will add.
- [ ] `docs/roadmap.md`: add a Stage 13.5 row to the §3 table in the established format,
      linking this plan. Add a short §3.5 subsection explaining why it jumped the queue,
      matching §3.4's shape — **and carrying forward the spec's honest finding that the
      billed models did not match Aether's configured tier, so this stage hardens the app
      without being the fix for what actually charged the account.** Do not let the roadmap
      claim more than the spec does.
- [ ] `PROGRESS.md`: entry in the established format. State plainly: (a) what was removed and
      that the SDK is gone from `package.json`; (b) that `Comms` currently answers via
      `localResponder` only and Stage 14 fills it; (c) the Task 5 decision about
      `actionParser`/`actionExecutor` and which way it went, with the reasoning; (d) that the
      environment-level fixes are the operator's, outside this repo, and unverifiable from
      here.
- [ ] Commit: `docs: record the Stage 13.5 API teardown`

---

After all seven tasks: whole-branch review. The single most important review question is not
"did the tests pass" but **"can this tree place a paid API call?"** — the reviewer should try
to answer it by reading, independently of `noApiCalls.test.ts`, and should say so explicitly
in the review. A guard test that agrees with itself proves nothing.
