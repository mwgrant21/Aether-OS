# Chat IPC + Correctness Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a confirmed live defect — **Chat's real Claude replies do not work in the Electron
app at all** — plus two hygiene items that close a documented recurring bug class and an
open-source-readiness gap.

The defect: `chatProxyPlugin` is registered only in `vite.config.ts`. `electron.vite.config.ts`'s
renderer plugins array is `[react()]`. So in `npm run electron:dev` and every packaged build,
`fetch('/api/chat')` 404s, `askClaude()` honours its documented null-on-any-failure contract, and
`useChatChannels.ts` silently falls back to `localResponder`. Real replies work **only** in
`npm run dev` browser mode. Because the fallback is designed to be invisible and the README says
*"Without a key, the offline responder answers in-world instead; nothing breaks,"* a desktop user
sees in-world answers and concludes their API key isn't set.

There is a second half to the same defect: `vite.config.ts` loads `.env` via Vite's `loadEnv` into
`process.env`. The Electron main process has no Vite, so `process.env.ANTHROPIC_API_KEY` will not
resolve from `.env` there **even once an endpoint exists.** Both halves are fixed here.

**Architecture:** Extract the transport-agnostic core of `chatProxyPlugin.ts` (body validation,
text-block narrowing, the Anthropic call) into `src/shared/chatCore.ts`. The Vite plugin and a new
`ipcMain.handle('chat:send')` both become thin adapters over it — one HTTP, one IPC. `askClaude()`
prefers IPC when `window.aetherElectron` exists and falls back to `fetch` in browser mode, matching
the feature-detection pattern `TopBar.tsx` already uses for window controls. Electron main gains a
minimal dependency-free `.env` reader.

**Tech Stack:** TypeScript (strict), Electron main-process IPC, `@anthropic-ai/sdk`, Vitest.

## Global Constraints

- `npm test`, `npm run build`, and `npm run electron:build` clean before every commit that touches `electron/`.
- **`askClaude()`'s null-on-any-failure contract is load-bearing and must not change.**
  `useChatChannels.ts`'s "fall back to `localResponder` on null" branch has been unchanged since
  Phase 1 and this plan does not touch it. What changes is *which transport* is tried, never the
  contract.
- **The API key must never reach the renderer.** It is read in the Electron main process only, the
  same guarantee the Vite plugin currently provides server-side. Do not expose it through preload,
  do not return it from any IPC handler, do not log it.
- Browser mode (`npm run dev`) must keep working exactly as it does today, through the same Vite
  plugin. This plan adds a transport; it does not replace one.
- Do not touch `src/components/chat/useChatChannels.ts`, `localResponder.ts`, `personas.ts`, or
  `systemPrompt.ts`. The defect is entirely in transport.
- Do not touch `src/components/grid/` or `src/components/reactor/`.

---

### Task 1: Extract `src/shared/chatCore.ts` (transport-agnostic)

**Files:**
- Create: `src/shared/chatCore.ts` + `chatCore.test.ts`
- Modify: `vite-plugins/chatProxyPlugin.ts`, `vite-plugins/chatProxyPlugin.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ChatTurn { role: 'user' | 'assistant'; text: string }
  export interface ChatRequestBody { system: string; messages: ChatTurn[] }
  export type ChatCoreResult =
    | { ok: true; reply: string }
    | { ok: false; status: 400 | 500 | 503; error: string };

  export const CHAT_MODEL: string;   // 'claude-opus-4-8'
  export const CHAT_MAX_TOKENS: number; // 300

  export function isValidChatBody(body: unknown): body is ChatRequestBody;
  export function runChatRequest(body: unknown, apiKey: string | undefined): Promise<ChatCoreResult>;
  ```

**Steps:**
- [ ] **Read `vite-plugins/chatProxyPlugin.ts` in full first.** Move `ChatTurn`, `ChatRequestBody`,
      `isChatTurn`, `isValidChatBody`, `isTextBlock`, `MODEL` and `MAX_TOKENS` into `chatCore.ts`
      unchanged. Keep the existing explanatory comments verbatim — particularly the one documenting
      that `isTextBlock` was confirmed against `@anthropic-ai/sdk` 0.112.3's `ContentBlock` union,
      which is exactly the kind of note that stops a future reader re-deriving it.
- [ ] Write `runChatRequest(body, apiKey)` carrying over the existing status-code semantics exactly,
      because `askClaude()` already depends on all non-2xx behaving identically:
      - `!isValidChatBody(body)` → `{ ok: false, status: 400, error: 'body must be { system: string, messages: {role, text}[] }' }`
      - `!apiKey` → `{ ok: false, status: 503, error: 'ANTHROPIC_API_KEY is not set on the server' }`
      - SDK throw → `{ ok: false, status: 500, error: <message> }`
      - success → `{ ok: true, reply: textBlock?.text ?? '' }`
      Note that malformed-JSON handling stays in the HTTP adapter, since parsing is a transport
      concern — `runChatRequest` takes an already-parsed value.
- [ ] Rewrite `chatProxyPlugin.ts`'s `handleChatRequest` as a thin adapter: keep the `405` guard,
      keep `readRequestBody` and the `JSON.parse` try/catch producing `400 malformed JSON body`, then
      delegate to `runChatRequest(parsed, process.env.ANTHROPIC_API_KEY)` and map the result onto
      `sendJson`. **The plugin's externally observable behaviour must not change at all.**
- [ ] Move the `isValidChatBody` tests from `chatProxyPlugin.test.ts` into `chatCore.test.ts`, and
      add `runChatRequest` tests for the 400 and 503 branches (both reachable without any network —
      no SDK mocking required). Leave the HTTP-level tests (`readRequestBody`, the 405 guard, the
      malformed-JSON 400) in `chatProxyPlugin.test.ts`, since those test transport, not core.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean.
- [ ] Commit: `refactor: extract transport-agnostic chatCore from the Vite chat proxy`

---

### Task 2: `electron/loadDotEnv.ts` — dependency-free `.env` reader

**Files:**
- Create: `electron/loadDotEnv.ts` + `loadDotEnv.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function parseDotEnv(contents: string): Record<string, string>;
  export function loadDotEnvInto(envPath: string, target: NodeJS.ProcessEnv): void;
  ```

**Steps:**
- [ ] `parseDotEnv` is pure and gets the tests. Handle: `KEY=value`; surrounding single or double
      quotes stripped; `#` comment lines and blank lines skipped; leading `export ` stripped;
      whitespace trimmed around the key and around an unquoted value; and a value containing `=`
      preserved intact (split on the **first** `=` only — `KEY=a=b` yields `a=b`).
- [ ] `loadDotEnvInto(envPath, target)`: read the file inside a try/catch, and on any failure
      (missing file, unreadable) return silently. `.env` is optional by design — the app must run
      without one.
- [ ] **A real shell-exported variable always wins**: only assign when
      `target[key] === undefined`. This mirrors the precedence rule `vite.config.ts` already
      implements and documents; the two loaders must not disagree, or a developer will get one
      answer in browser mode and another in the desktop app.
- [ ] Tests using the temp-directory fixture pattern — **read `electron/windowBounds.test.ts` first**
      for this codebase's established convention. Cover each parse case above, plus: a missing file
      being a silent no-op, and an already-set `target` key not being overwritten.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean.
- [ ] Commit: `feat: add dependency-free .env loader for the Electron main process`

---

### Task 3: `chat:send` IPC handler in Electron main

**Files:**
- Modify: `electron/main.ts`

**Interfaces:**
- Consumes: `runChatRequest` (Task 1), `loadDotEnvInto` (Task 2).
- Produces: `ipcMain.handle('chat:send', ...)` returning `{ reply: string } | { error: string }`.

**Steps:**
- [ ] Near the top of app startup, before the window is created, call
      `loadDotEnvInto(join(app.getAppPath(), '.env'), process.env)`. **Read `main.ts`'s existing
      startup sequence first** and place this with the other early initialisation rather than
      inventing a new phase. Add a comment noting the packaged-app caveat: in a packaged build
      `app.getAppPath()` points inside `resources/app.asar`, so a `.env` shipped beside the
      executable will not be found there — a real shell-exported `ANTHROPIC_API_KEY` is the
      supported path for packaged builds, and Task 5's Settings surface must make that legible
      rather than leaving the user guessing.
- [ ] Add the handler near the existing `optimize:*` handlers for locality:
  ```ts
  ipcMain.handle('chat:send', async (_event, body: unknown) => {
    const result = await runChatRequest(body, process.env.ANTHROPIC_API_KEY);
    return result.ok ? { reply: result.reply } : { error: result.error };
  });
  ```
      **Deliberately do not surface the status code to the renderer.** `askClaude()` treats every
      failure identically, and returning a status would invite a future caller to branch on it and
      quietly break the null-on-any-failure contract.
- [ ] Add `ipcMain.handle('chat:hasKey', async () => typeof process.env.ANTHROPIC_API_KEY === 'string' && process.env.ANTHROPIC_API_KEY.length > 0)`
      for Task 5's Settings readout. **Returns a boolean only — never the key, never a prefix,
      never a length.**
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean, `npm run electron:build` clean.
- [ ] Commit: `feat: add chat:send IPC handler and .env loading to the Electron main process`

---

### Task 4: preload + `askClaude` transport selection

**Files:**
- Modify: `electron/preload.ts`, `src/aetherElectron.d.ts`, `src/components/chat/claudeClient.ts` (+ `claudeClient.test.ts`)

**Interfaces:**
- Produces: `window.aetherElectron.chat.{send,hasKey}`; `askClaude` unchanged in signature and contract.

**Steps:**
- [ ] `electron/preload.ts`: add a `chat` namespace following `attachments.list`'s invoke pattern —
      `send: (body) => ipcRenderer.invoke('chat:send', body)` and
      `hasKey: () => ipcRenderer.invoke('chat:hasKey')`.
- [ ] `src/aetherElectron.d.ts`: matching declarations in the style `optimize`/`attachments` already
      use — read the file first.
- [ ] In `claudeClient.ts`, change **only** the transport inside `askClaude`'s existing try/catch:
  ```ts
  const bridge = (window as { aetherElectron?: { chat?: { send(body: unknown): Promise<unknown> } } }).aetherElectron;
  if (bridge?.chat) {
    const data = (await bridge.chat.send({ system, messages })) as { reply?: unknown };
    return typeof data?.reply === 'string' && data.reply.length > 0 ? data.reply : null;
  }
  // browser mode (npm run dev) — the Vite plugin serves this route
  const res = await fetch('/api/chat', { ... });   // unchanged
  ```
      Feature-detect on `window.aetherElectron` exactly as `TopBar.tsx` already does for window
      controls — **read that file first** and match its detection style rather than introducing a
      second idiom for the same question.
- [ ] Update the comment above `askClaude`. It currently says *"Calls the Vite dev-server middleware
      proxy (Task 5's POST /api/chat)"*, which is now only half true and is precisely the stale
      comment that made this defect easy to miss. State both transports and the selection rule.
- [ ] Tests: extend `claudeClient.test.ts` (**read it first** for how it currently stubs `fetch`) to
      cover — IPC path used when `window.aetherElectron.chat` exists, returning the reply; fetch path
      used when it does not; IPC returning `{ error }` yielding `null`; IPC returning an empty-string
      reply yielding `null`; IPC **throwing** yielding `null` rather than propagating. That last one
      matters most: an IPC rejection must be caught by the same outer try/catch that already absorbs
      network errors, or the fallback stops working.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean, `npm run electron:build` clean.
- [ ] Commit: `fix: route Chat through Electron IPC in the desktop app, restoring real Claude replies`

---

### Task 5: Make the failure legible in Settings

**Files:**
- Modify: `src/components/settings/OperatingModeCard.tsx` *(or create a small card — see steps)*, `src/components/chat/ChatView.tsx`

**Steps:**
- [ ] **Read `OperatingModeCard.tsx` first.** If a chat/API row fits its existing purpose, add there;
      if not, create `src/components/settings/ChatBackendCard.tsx` and register it in
      `SettingsView.tsx` alongside the other cards. Do not force it into an unrelated card.
- [ ] Show a single honest line driven by `window.aetherElectron.chat.hasKey()`: **`Live · Claude
      replies enabled`** when true, **`Offline · in-world responder (no ANTHROPIC_API_KEY)`** when
      false, and **`Browser mode · replies via dev-server proxy`** when `window.aetherElectron` is
      absent entirely.
- [ ] In `ChatView.tsx`, add a small dim chip in the channel header showing `LIVE` or `OFFLINE`,
      using the existing `chipBorder`/`panelInset` quiet-chip convention. **This is the actual
      lesson of this defect:** the bug survived because a silent fallback is indistinguishable from
      success. A one-word indicator makes it structurally impossible for the same class of failure
      to hide again — the same reasoning behind the Live Output IDLE badge.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean, `npm run electron:build` clean. No new unit-testable logic here; note in the task report which of the three states were exercised by hand.
- [ ] Commit: `feat: surface chat backend state in Settings and the chat header`

---

### Task 6: Close the persistence-whitelist bug class

**Files:**
- Modify: `src/state/persistence.ts` (+ create `persistence.test.ts` if absent, else extend)

**Steps:**
- [ ] **Read `src/state/persistence.ts` and `src/state/types.ts` in full first.**
- [ ] Add an exported, explicitly commented exclusion list naming every `AetherState` key that is
      deliberately **not** persisted, each with its reason:
  ```ts
  /** Keys deliberately excluded from persistence, with the reason each is excluded.
   *  A rehydrated value for any of these would be actively misleading rather than merely stale. */
  export const PERSISTENCE_EXCLUSIONS: Record<string, string> = {
    logs: 'stale lines would fake a live STREAMING state after restart',
    selectedRealAgent: 'keyed on a toolUseId that will not exist in a new session',
    // ...one entry per excluded key
  };
  ```
- [ ] Add a test that iterates the keys of a fully-populated `AetherState` (build it from
      `initialState`) and asserts every key is **either** present in the object `savePersisted`
      writes **or** listed in `PERSISTENCE_EXCLUSIONS`. Fail with a message naming the offending key
      and telling the reader to either persist it or document why not.
- [ ] Add a round-trip test: populate a state, `savePersisted`, `loadPersisted`, and assert every
      persisted key survives with its value intact — this catches the `memSeq`-style class where a
      key is listed but the value is wrong or the sequence collides.
- [ ] In the test file header, add a comment recording *why* this test exists: PROGRESS.md documents
      three separate misses from this hand-maintained whitelist (`state.selected`;
      `projects`/`providers`/`routeDefault`; `memSeq` causing ID collisions). This converts a
      recurring bug class into a compile-time-adjacent guarantee — a new state field cannot be added
      without a deliberate decision about its persistence.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean.
- [ ] Commit: `test: assert every state key is either persisted or documented as excluded`

---

### Task 7: LICENSE

**Files:**
- Create: `LICENSE`
- Modify: `README.md`, `package.json`

**Steps:**
- [ ] **Ask the user which licence before writing one** — this is a product decision, not an
      implementation detail, and it is not reversible in any meaningful sense once the repo is
      public. Note for that conversation: TokenMonitor is unlicensed too; Blubber OS uses Apache-2.0
      for code with brand assets excluded; MIT is the most permissive and most common for portfolio
      work; Apache-2.0 adds an explicit patent grant. **If and only if the user does not express a
      preference, default to MIT** and say so in the task report.
- [ ] Write `LICENSE` with the correct year and copyright holder.
- [ ] Add `"license": "<SPDX id>"` to `package.json`.
- [ ] Add a one-line `## License` section at the end of `README.md`.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean.
- [ ] Commit: `chore: add LICENSE`

---

After all seven tasks: whole-branch review, then a `PROGRESS.md` entry in the established format,
explicitly noting:

- **(a)** Chat's real Claude replies were **broken in every Electron build** since the feature
  shipped — `chatProxyPlugin` was registered only in `vite.config.ts`, so `/api/chat` 404'd and
  `askClaude()`'s null-on-failure contract silently routed every reply to `localResponder`. Live
  model QA on 2026-07-19 passed because it was performed in browser mode. Record this as a defect
  found by static inspection during roadmap review, in the same style as the `usageTokens()` entry.
- **(b)** The second half: `.env` was loaded only by Vite's `loadEnv`, so the key would not have
  resolved in Electron even once an endpoint existed. Both halves fixed together.
- **(c)** The structural lesson, and the reason for the `LIVE`/`OFFLINE` chip: a fallback designed
  to be invisible is indistinguishable from success, and this app has now been bitten by that
  exact shape twice (the always-on STREAMING badge, and this). Silent degradation now gets a
  visible indicator by convention, not by case-by-case judgement.
- **(d)** Packaged builds resolve `ANTHROPIC_API_KEY` from the real environment only, not from a
  `.env` beside the executable, because `app.getAppPath()` resolves inside `app.asar`. The Settings
  readout makes this legible rather than silent.
- **(e)** `PERSISTENCE_EXCLUSIONS` plus the coverage test closes the recurring whitelist bug class
  documented three times in this file's own history.
- **(f)** Which licence was chosen and on whose decision.
