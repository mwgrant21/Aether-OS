# Phone Alerts (Aether Mobile) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paired Android phone raises a fixed-wording notification, within seconds and with the app closed or the phone locked, when the Claude process in Terminal Alpha stops and waits for the owner.

**Architecture:** The desktop gets an alert watcher (a debounced busy-to-idle edge from the thread feed, plus pending permission prompts) that reduces every event to one of three labels and sends one new frame, `alert {s, kind}`, only to sockets that authenticated with a separate alert-only credential. That credential is minted in the same pairing action as the main one, lives in its own hash-only store, and its sockets are counted apart from the main two. The phone holds the alert token in a non-fingerprint vault and a foreground service keeps the alert connection and posts the notifications. The main connection, its fingerprint lock and its 60 s background drop are not touched.

**Tech Stack:** TypeScript (Electron main, vitest), JSON protocol contract, Kotlin (Android JVM unit tests, foreground service), React (Settings card).

**Spec:** `docs/superpowers/specs/2026-11-07-phone-alerts-design.md` (approved by Matt 2026-11-07). Binding companions: `docs/privacy-and-data.md` section 17 and `CLAUDE.md` ("Privacy & data model", architecture map).

## Pinned ground

- Written against worktree `C:\Users\Matt\projects\aether-os\.worktrees\phone-alerts-spec`, branch `docs/phone-alerts-spec`, HEAD `2a1aabd` (= origin/master `e8a13b4` + the spec commit). Builders: create `feat/phone-alerts` from the commit that contains this plan; first command `git merge-base --is-ancestor 2a1aabd HEAD` must exit 0.
- Setup in the worktree: `npm ci --ignore-scripts` (plain `npm ci` if node-pty fails to load); copy the untracked `android/local.properties` from the main checkout (read only). Run `npx vitest run` and `cd android && ./gradlew.bat testDebugUnitTest` once and quote the counts before Task 1 (baseline NOT RUN when this plan was written).
- Commit with explicit paths: `git add -- <paths>` then `git commit -m "..." -- <paths>`; never `git add -A`. End every commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Plan-time finding, carried into the tasks: the spec's "one new frame" is not the only wire change. Issuing both credentials "in the same pairing action" also adds optional `alertToken` / `alertExpiresAtMs` to the `POST /api/device/pair` response (Task 2, 8, 9, 12), and `limits.maxAlertSockets` joins the JSON.

## Global Constraints

Values copied from the spec; every task includes these.

- **Scope:** Alpha only (`s` is `"claude"`, label "Terminal Alpha"). Non-goals, not built: Beta, Codex, Allow/Deny buttons, yes/no buttons, vibration or sound patterns, FCM or any Google/third-party delivery, any desktop-side notification change.
- **Alert kinds are a closed set** (`finished`, `question`, `input`) with fixed wording: finished = "Task finished"; question = "A question needs your attention"; input = "Input needed for clarification". Lock-screen text: "Terminal Alpha has finished" / "Terminal Alpha has a question" / "Terminal Alpha needs input".
- **Nothing derived from content may cross the wire or reach the screen.** The classifier runs on the desktop and reduces to one of the three labels; uncertain -> `input`; ends on "?" or carries a yes/no cue -> `question`; plain completed statement -> `finished`.
- **When to fire:** a debounced busy-to-idle edge (`ALERT_DEBOUNCE_MS = 4000`, a tunable constant); at most one alert per stop; none on a user interrupt; the 120 s stale drop (`THREAD_WORKING_STALE_MS`) never produces an alert; no replay on reconnect; no stored alert queue. A pending `permissionBroker` prompt also raises `input` (no Allow/Deny).
- **Credential:** separate alert-only credential and connection; hash-only, peer-bound, revocable with REVOKE / REVOKE ALL, off when phone control is off; issued in the same pairing action as the main credential; own scope and store (`~/.aether-os/alert-devices.json`) because `CONTROL_MAX_DEVICES = 1` would evict the first token. Alert sockets are counted apart from `CONTROL_MAX_SOCKETS = 2` (`CONTROL_MAX_ALERT_SOCKETS = 2`). An alert-scope socket is closed (`bye policy`) on any verb other than the `hello` handshake.
- **Main connection unchanged:** fingerprint to unlock, `AppFlow.RELOCK_AFTER_MS = 60_000L`, `CONTROL_MAX_SOCKETS = 2`, `CONTROL_MAX_DEVICES = 1`. `AppFlow.kt` and `auth/RelockPolicy.kt` must show no diff at the end (Task 15).
- **Watcher gating:** runs only while the new Settings switch "alerts" (`phoneAlerts`, default OFF) is on AND phone control is on, even with no phone connected; after a PC restart it resumes only if the existing `reenableAtLaunch` setting brings control back.
- **Wire frame:** `{"t":"alert","s":"claude","kind":"<finished|question|input>"}`, key order `t,s,kind`; added in all three mirrors (`CONTROL_MESSAGE_TYPES` in `src/shared/remote/types.ts`, `protocol/mobile-protocol.json`, Android `ControlProtocol.kt`).
- **Diag:** metadata-only fixed string `control: alert sent kind=<finished|question|input>`; no alert content, timing log or terminal name on disk or in `diag.log`.
- **Android:** foreground service holds the alert connection; persistent notification "Aether watching" / "Aether not connected"; alert notifications use lock-screen visibility private with a public version carrying only the generic text; on Android 13+ a denied POST_NOTIFICATIONS shows an in-app notice that alerts are off. No Google/FCM. minSdk 31, targetSdk 35.
- **Repo process:** TDD, one commit per task, Task 1 (docs) lands before any capability code; PROGRESS.md in the last task; treat the whole feature as R3 in review (every task gets a fresh reviewer briefed adversarially). Doze latency is measured on the S25 and reported, not assumed (Task 15).
- Tests in `electron/` start with `// @vitest-environment node`; run one file with `npx vitest run <file>`; typecheck with `npm run typecheck:electron`; Android with `cd android && ./gradlew.bat testDebugUnitTest --tests '<class>'`.

## Review Focus

Failure modes the spec implies; each has a test in the named task.

1. **A stop alerts twice, or alerts when it should not.** History re-read after `/clear`, a thread re-attach, a session switch or a socket reconnect must not fire (Task 4 live-only turn marks, Task 5); a user interrupt, a second idle line without an intervening busy mark, and the 120 s stale drop must not fire (Task 4, 5); a brief idle between text and a tool call must not fire (debounce, Task 5).
2. **The alert credential does anything but receive alerts.** `in`, `attach`, `thread.attach`, `ledger.attach`, `view.attach` and any future verb on an alert-scope socket must close it before touching a terminal, a feed or the input router; a main token must not be mistaken for an alert token or the reverse (Task 7, 9).
3. **Content leaks into the label or the notification.** A last message that ends in "?" and contains a secret path must produce exactly `question`; a hostile `alert` frame with extra `text` fields must not change the notification wording (Task 3, 5, 2, 13).
4. **Revoke, disable and switch-off leave something running.** REVOKE closes the alert socket and kills the alert token; disabling phone control or turning the alerts switch off stops the watcher and the thread polling it holds; re-pairing replaces the alert token; a main-only revoke path must not leave a live alert token (Task 9, 10).
5. **A missed alert is silent.** No phone connected -> the alert is dropped, not queued or replayed when a phone connects (Task 10); notification permission denied, unpaired, or PC unreachable -> the phone says so in the persistent notification or the in-app notice (Task 13, 14). A lost alert socket must reconnect with backoff, not stay dead (Task 13, 14).

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/remote/types.ts` | alert constants/types, `ControlScope`, `ThreadTap.turn`, pair-result alert fields |
| `electron/control/protocol.ts` | `encodeAlert` |
| `electron/control/alertClassifier.ts` (new) | pure `classifyStop` text -> label |
| `electron/control/alertWatcher.ts` (new) | debounce/dedupe state machine over `ThreadReadPort` + `PromptReadPort` |
| `electron/threadParser.ts`, `electron/threadFeed.ts` | `interrupted` on idle marks; live-only `turn` taps |
| `electron/remote/remoteAuth.ts` | `DeviceAuth.issue(peer)` (mint without a code) |
| `electron/control/controlGateway.ts` | alert scope handling, `ControlSession.alert` |
| `electron/remote/remoteServer.ts` | per-scope socket counts, alert fields in the pair response |
| `electron/control/controlHub.ts`, `electron/controlSettings.ts`, `electron/control/controlIpc.ts` | alert auth/store, watcher lifecycle, delivery, `phoneAlerts` setting + IPC |
| `electron/main.ts`, `electron/preload.ts`, `src/aetherElectron.d.ts`, `src/components/settings/ControlAccessCard.tsx` | wiring and the Settings switch |
| `android/.../protocol/ControlProtocol.kt`, `net/ControlClient.kt`, `auth/Pairing.kt` | wire mirror, alert frame delivery, pair response |
| `android/.../auth/AlertVault.kt`, `alerts/*` (new) | alert token vault, pure text/backoff/status models, notifier, service, boot receiver |

---

### Task 1: Rewrite privacy section 17 and the CLAUDE.md note (docs first)

**Files:**
- Modify: `docs/privacy-and-data.md` (section 17: Status paragraph, Exposed, Never exposed, Boundary, Auth, On disk, In memory only, Visibility, Limits)
- Modify: `CLAUDE.md` (architecture map `control/` entry; the "Separate second opt-in: phone control" bullet in "Privacy & data model")

**Interfaces:**
- Produces: the binding text every later task is held to. No code.

- [ ] **Step 1: Edit section 17.** One change per place, all stated as binding behaviour with "(phone alerts, planned in `feat/phone-alerts`; flipped to built by Task 15)" on the Status line:
  - **Exposed:** new bullet "Phone alerts": a socket authenticated with the alert credential receives `alert {s:"claude", kind}` where `kind` is `finished`, `question` or `input`, and nothing else; no terminal output, thread, ledger, view or prompt text; fixed wording lives on the phone.
  - **Never exposed:** add "any text, path, tool name or timing derived from the terminal or transcript in an alert; the alert credential cannot attach, type, read a feed or answer a prompt".
  - **Boundary:** alert-scope sockets are counted apart from the 2 control sockets (at most 2, so a reconnect overlap is not refused); an alert-scope socket is closed with `bye policy` on any verb except the `hello` handshake; the alert credential cannot open the viewer socket and a main token cannot be used as an alert token (scopes are separate stores).
  - **Auth:** the alert token is minted in the same pairing action (the redeem response also carries `alertToken`, `alertExpiresAtMs`), same 256-bit/SHA-256-hash-only/peer-bound/sliding 30 d/absolute 180 d rules, own store, revoked by REVOKE and REVOKE ALL together with the main device, replaced by re-pairing, unusable while phone control is off. State plainly: on the phone it is NOT behind the fingerprint (a background service must read it), so a phone that is lost unlocked or rooted leaks the existence and kind of Alpha stops and nothing else; kill switches are the same.
  - **On disk:** `~/.aether-os/alert-devices.json` has the same shape as `remote-devices.json`; `control-settings.json` becomes `{"v":1,"reenableAtLaunch":boolean,"phoneTyping":boolean,"phoneAlerts":boolean}` (`phoneAlerts` default false, true only when stored `=== true`); the phone stores the alert token encrypted under a Keystore key that needs no user authentication.
  - **In memory only:** replace "the thread ring ... exists only while at least one socket is thread-attached" with: the thread ring also exists while the alerts watcher is running (phone control on AND the alerts switch on, even with no phone connected); the watcher keeps the last Claude message of the current turn only to classify it, a debounce timer and a set of at most 64 prompt ids, and only a label leaves it. Delete or rewrite any statement that nothing runs while detached.
  - **Visibility:** the Settings "Phone alerts" switch (default OFF, no native confirm); new diag line `control: alert sent kind=<finished|question|input>` (written once per alert that reached at least one phone); the phone's persistent "Aether watching" / "Aether not connected" notification.
  - **Limits:** alerts are best effort (Doze/battery can delay a foreground-service socket; delivery latency is measured, not promised); an alert is dropped, never stored or replayed, when no phone is connected; the label can be wrong (a wrong label costs a glance and exposes nothing); a permission prompt is not attributed to a slot (the hook is global), so "Terminal Alpha needs input" can come from another Claude session; a phone paired before this change must be re-paired once to receive an alert credential.
- [ ] **Step 2: Edit `CLAUDE.md`.** In the architecture map add `alertClassifier.ts` / `alertWatcher.ts` to the `control/` entry and `alert-devices.json` to the persistence mentions; in the phone-control privacy bullet add one sentence: phone alerts (privacy 17) add an alert-only credential and a desktop watcher that runs while control and the alerts switch are on; only a three-value label crosses the wire. Do not mark anything BUILT yet.
- [ ] **Step 3: Verify.** Run `git diff --stat` (two files changed) and `npx vitest run src/shared/remote electron/control/protocol.test.ts` (docs-only change: still green).
- [ ] **Step 4: Commit.** `git add -- docs/privacy-and-data.md CLAUDE.md` then `git commit -m "docs(privacy): phone alerts - alert credential, watcher, new frame (section 17)" -- docs/privacy-and-data.md CLAUDE.md`.

---

### Task 2: Alert wire contract in all three mirrors

**Files:**
- Modify: `src/shared/remote/types.ts`, `electron/control/protocol.ts`, `protocol/mobile-protocol.json`
- Modify: `android/app/src/main/java/com/matt/aethermobile/protocol/ControlProtocol.kt`
- Test: `electron/control/protocol.test.ts`, `src/shared/remote/mobileProtocol.test.ts`, `android/app/src/test/java/com/matt/aethermobile/protocol/ControlProtocolTest.kt`

**Interfaces:**
- Produces (TS, `src/shared/remote/types.ts`): `ALERT_KINDS = ['finished','question','input'] as const`; `type AlertKind`; `ALERT_SLOT = 'claude' as const`; `type ControlScope = 'main' | 'alert'`; `CONTROL_MAX_ALERT_SOCKETS = 2`; `ControlIdentity.scope?: ControlScope` (absent = main); `'alert'` appended to `CONTROL_MESSAGE_TYPES.titanToPhone`; `ControlPairResult` 200 variant gains `alertToken?: string; alertExpiresAtMs?: number`.
- Produces (TS, `protocol.ts`): `encodeAlert(kind: AlertKind): string`.
- Produces (Kotlin): `ControlProtocol.AlertKind` (enum with `wire`: `FINISHED("finished")`, `QUESTION("question")`, `INPUT("input")`), `ControlProtocol.AlertFrame(val s: String, val kind: AlertKind)`, `ControlProtocol.parseAlertFrame(text: String): AlertFrame?`, `ControlProtocol.MAX_ALERT_SOCKETS = 2`.
- JSON: `messages.titanToPhone` gains `"alert"`; `messages.alertKinds = ["finished","question","input"]`; `limits.maxAlertSockets = 2`; `pairResponses.optionalBody = ["alertToken","alertExpiresAtMs"]` (`successBody` stays `["token","expiresAtMs"]`).

- [ ] **Step 1: Write failing tests.**
  - `protocol.test.ts`: `encodeAlert('finished')` equals `'{"t":"alert","s":"claude","kind":"finished"}'`; same for `question`, `input`; `encodeAlert('C:\\secret' as never)` throws `RangeError`; `MESSAGE_TYPES.titanToPhone` still equals `CONTROL_MESSAGE_TYPES.titanToPhone` and contains `'alert'`; `MESSAGE_TYPES.phoneToTitan` is unchanged (alert scope adds no phone verb, so controlBoundary rule 3 stays satisfied).
  - `mobileProtocol.test.ts`: `spec.messages.alertKinds` equals `[...ALERT_KINDS]`; `spec.limits.maxAlertSockets` equals `CONTROL_MAX_ALERT_SOCKETS` (update the `toEqual` on `limits`); `spec.pairResponses.optionalBody` equals `['alertToken','alertExpiresAtMs']`.
  - `ControlProtocolTest.kt`: constants equal the JSON (`MAX_ALERT_SOCKETS`, `AlertKind` wire values in JSON order); `parseAlertFrame("""{"t":"alert","s":"claude","kind":"question"}""")` equals `AlertFrame("claude", QUESTION)`; null for an unknown kind, an unknown slot (`"terminal2"`), a missing `kind`, non-JSON; a frame with an extra `"text":"C:\\secret"` key parses to the same `AlertFrame` (the field is ignored, not carried).
- [ ] **Step 2: Run to verify failure.** `npx vitest run electron/control/protocol.test.ts src/shared/remote/mobileProtocol.test.ts` and `cd android && ./gradlew.bat testDebugUnitTest --tests '*ControlProtocolTest'`. Expected: FAIL (missing exports / constants).
- [ ] **Step 3: Implement** the Interfaces above in the three mirrors. `encodeAlert` builds the string from a literal object in key order `t,s,kind` and throws `RangeError('unknown alert kind')` when `kind` is not in `ALERT_KINDS`. `parseAlertFrame` returns null unless `t == "alert"`, `s == "claude"` and `kind` is one of the three wire values.
- [ ] **Step 4: Run to verify pass.** Same commands as Step 2, plus `npm run typecheck:electron`. Expected: PASS.
- [ ] **Step 5: Commit** the six files: `feat(control): alert frame in all three protocol mirrors`.

---

### Task 3: Stop classifier (pure)

**Files:**
- Create: `electron/control/alertClassifier.ts`
- Test: `electron/control/alertClassifier.test.ts`
- Modify: `electron/control/controlBoundary.test.ts` (OWN_FILES + narrowed imports, see Task 5 Step 1; do both file names here)

**Interfaces:**
- Consumes: `AlertKind` (Task 2).
- Produces: `classifyStop(lastAssistantText: string | null): AlertKind`. Pure; no logging; no I/O. Its only import is `type { AlertKind }` from `../../src/shared/remote/types`.

- [ ] **Step 1: Write the failing table test** (`it.each`, each row `[text, kind]`):
  - `null`, `''`, `'   \n '` -> `input` (uncertain).
  - `'All tests pass.'`, `'Done. I committed the change to feat/x!'`, `'Refactored the parser.\n\nAll 12 tests pass.'` -> `finished`.
  - `'Which option do you prefer?'`, `'Shall I continue?)'`, `'Want me to push?"'`, `'Should I delete the worktrees? Y/N?'` -> `question`.
  - yes/no cue without a trailing "?": `'Continue (y/n)'`, `'Proceed [Y/n]'`, `'Reply yes or no'` -> `question`.
  - trailing "?" wins over a finished-looking tail only when it is the last character after stripping closers `)"'*_` and whitespace: `'Done. Want me to open a PR?'` -> `question`; `'Is it ready? I think so.'` -> `finished`.
  - last paragraph is a list, a code fence, or ends on `:` / no terminal punctuation: `'Options:\n- a\n- b'`, `'Here is the diff:\n```\nx\n```'`, `'I need the API key:'`, `'working on it'` -> `input`.
  - hostile content never changes the type of result: `'Looked in C:\\Users\\Matt\\.ssh\\id_rsa - what next?'` -> `question`; `'token=ghp_ABC123 done.'` -> `finished`. Assert the return value `toBe` one of the three literals.
- [ ] **Step 2: Run to verify failure.** `npx vitest run electron/control/alertClassifier.test.ts` -> FAIL (module not found).
- [ ] **Step 3: Implement `classifyStop`** with this precedence: (1) blank -> `input`; (2) strip trailing whitespace and closers, then a final `?` -> `question`; (3) a yes/no cue (`(y/n)`, `[y/N]` any case, `yes or no`, `y/n`) or a question-opening phrase in the last paragraph (`should I`, `shall I`, `would you like`, `do you want`, `want me to`, `let me know`) -> `question`; (4) last non-empty line is not a list item, not inside or ending a code fence, and ends in `.` or `!` -> `finished`; (5) else `input`.
- [ ] **Step 4: Run to verify pass.** `npx vitest run electron/control/alertClassifier.test.ts` -> PASS.
- [ ] **Step 5: Commit** `feat(control): alert stop classifier (three labels only)` with the three files (the narrowed import rules for these two files land in Task 5).

> Note: the controlBoundary file allow-list rejects unknown files in `electron/control/`, so add `alertClassifier` and `alertWatcher` to `OWN_FILES` in THIS task's commit (a one-line edit to `controlBoundary.test.ts`) so the full suite stays green; Task 5 adds the narrowed imports.

---

### Task 4: Live-only turn marks from the thread feed

**Files:**
- Modify: `electron/threadParser.ts` (`TurnMark`, `turnMark`), `electron/threadFeed.ts` (`consume`, `follow`, `attachSession`), `src/shared/remote/types.ts` (`ThreadTap`)
- Test: `electron/threadParser.test.ts`, `electron/threadFeed.test.ts`

**Interfaces:**
- Produces: `TurnMark.interrupted?: boolean` (true only for the user-interrupt idle line); `ThreadTap.turn?(e: { mark: 'busy' | 'idle'; interrupted: boolean }): void` (optional, so the gateway's taps stay valid). `turn` is delivered once per mark line found in lines appended while following, in file order, AFTER the `events` frame for the same chunk, and never for the seed read on attach/re-attach/replace/truncate and never for the 120 s stale expiry.

- [ ] **Step 1: Write failing tests.**
  - `threadParser.test.ts`: the existing interrupt line (the `INTERRUPT_RE` fixture already used there) gives `{ mark: 'idle', interrupted: true }`; an `end_turn` assistant line gives `mark: 'idle'` with `interrupted` falsy; a human prompt gives `mark: 'busy'`.
  - `threadFeed.test.ts` (use the existing fake-fs/fake-timer helpers in that file): (a) a feed attached to a file that already ends in an `end_turn` line delivers `snap` and NO `turn`; (b) appending a user prompt line, a `tool_use` line, then an `end_turn` line in separate polls delivers `turn` busy, busy, idle in order, and the `events` callback for each chunk runs before its `turn`; (c) appending an interrupt line delivers `turn { mark: 'idle', interrupted: true }`; (d) advancing the clock 121 s past the last growth while busy emits `state` working=false and zero `turn` calls; (e) replacing the file at the same path (new inode) re-seeds with zero `turn` calls even if the new file ends in `end_turn`; (f) a tap without `turn` still works (no throw).
- [ ] **Step 2: Run to verify failure.** `npx vitest run electron/threadParser.test.ts electron/threadFeed.test.ts` -> FAIL.
- [ ] **Step 3: Implement.** `turnMark` adds `interrupted: true` on the interrupt branch only. In `threadFeed.ts` have `consume` record each parsed mark into a local array that only `follow` reads (after `pushRing`/`broadcast` of `events`) and `attachSession` discards; broadcast with `t.turn?.(...)` through the existing `broadcast` helper so a throwing tap is dropped as today.
- [ ] **Step 4: Run to verify pass.** Same command -> PASS; also `npx vitest run electron/control` (gateway taps unaffected).
- [ ] **Step 5: Commit** `feat(thread): live-only turn marks for the alert watcher`.

---

### Task 5: Alert watcher state machine

**Files:**
- Create: `electron/control/alertWatcher.ts`
- Test: `electron/control/alertWatcher.test.ts`
- Modify: `electron/control/controlBoundary.test.ts` (narrow imports; fixtures)

**Interfaces:**
- Consumes: `classifyStop` (Task 3); `ThreadReadPort`, `ThreadTap.turn` (Task 4); `PromptReadPort`, `AlertKind` (existing/Task 2).
- Produces:
  ```ts
  export const ALERT_DEBOUNCE_MS = 4000;
  export interface AlertWatcherDeps {
    threads: ThreadReadPort;
    prompts?: PromptReadPort;
    onAlert(kind: AlertKind): void;
    debounceMs?: number;
    setTimeoutFn?: (fn: () => void, ms: number) => unknown;
    clearTimeoutFn?: (h: unknown) => void;
  }
  export interface AlertWatcher { start(): void; stop(): void; running(): boolean }
  export function createAlertWatcher(deps: AlertWatcherDeps): AlertWatcher;
  ```
  `onAlert` is the only output and takes only an `AlertKind`; the watcher imports nothing but `alertClassifier` and `src/shared/remote/types`.

- [ ] **Step 1: Write failing tests** (fake ports and a manual timer; `onAlert` is a spy):
  1. busy, idle, advance `ALERT_DEBOUNCE_MS - 1` -> no alert; advance 1 more -> exactly one alert.
  2. the classifier input is the last `claude` event text since the last `user` event: feed `events` [user, claude 'Which file?'] then idle -> `onAlert('question')`; feed [claude 'All done.'] -> `finished`; no claude text at all -> `input`.
  3. busy-idle-busy inside the debounce window -> zero alerts; the next real idle fires one.
  4. a second idle with no busy between (and after the alert fired) -> still one alert; a `state` callback (working false at 120 s) in between changes nothing.
  5. an idle with `interrupted: true` -> zero alerts, and a following plain idle with no busy between is also silent.
  6. `snap` containing history (no `turn`) -> zero alerts at attach; stop() then start() again re-attaches and still alerts nothing from history.
  7. a pending prompt present at `start()` (replayed synchronously by `prompts.attach`) -> no alert; a prompt opened later and still open after `ALERT_DEBOUNCE_MS` -> one `input`; closed before the debounce -> none; the same prompt id twice -> one alert.
  8. hostile content: last claude text `'Open C:\\secret\\key.pem ? token=ghp_X'`-style content yields only a literal in `ALERT_KINDS`; `JSON.stringify(onAlert.mock.calls)` contains none of the input text.
  9. `stop()` cancels pending timers (advance past debounce after stop -> no alert), detaches both taps (fake `detach` spies called once), `running()` is false; calling `start()` twice attaches once.
- [ ] **Step 2: Run to verify failure.** `npx vitest run electron/control/alertWatcher.test.ts` -> FAIL.
- [ ] **Step 3: Implement `createAlertWatcher`.** State: `armed` timer handle, `fired` flag, `lastClaudeText`, `seenPromptIds` (Set, drop oldest beyond 64), a `replaying` flag set while `prompts.attach` runs. `turn busy` -> cancel timer, `fired=false`; `turn idle` -> interrupted: cancel timer, `fired=true`; else if `!fired && no timer` arm the debounce, whose callback sets `fired=true` and calls `onAlert(classifyStop(lastClaudeText))`. `snap`/`events` update `lastClaudeText` (reset on a `user` event, `snap` rebuilds it from its events); `state` is a no-op. Prompts: per-id debounce timers cancelled on `closed`.
- [ ] **Step 4: Boundary edits, then run.** In `controlBoundary.test.ts` narrow `allowedImports`: for `alertClassifier.ts` allow only `src/shared/remote/types` (type-only); for `alertWatcher.ts` allow only `./alertClassifier`, and `src/shared/remote/types`. Add one CLEAN row (a watcher importing `./alertClassifier`) and two BAD rows (`alertWatcher.ts` importing `./controlGateway`, and `alertClassifier.ts` importing `./protocol`; rule `module`, `has: 'allow-list'`). Run `npx vitest run electron/control/alertWatcher.test.ts electron/control/controlBoundary.test.ts` -> PASS.
- [ ] **Step 5: Commit** `feat(control): alert watcher (debounced edge, dedupe, prompts, label-only output)`.

---

### Task 6: Mint a credential without a code (`DeviceAuth.issue`)

**Files:**
- Modify: `electron/remote/remoteAuth.ts` (interface `DeviceAuth`, `self`)
- Test: `electron/remote/remoteAuth.test.ts`

**Interfaces:**
- Produces: `DeviceAuth.issue(peer: string | undefined): { token: string; expiresAtMs: number } | null`. Device profile only. Null when `peer` is not an IPv4 (after stripping a leading `::ffff:`). Otherwise behaves like the tail of `redeemDevice`: new 32-byte base64url token, hash-only entry bound to that peer, `expiresAtMs = now + slidingMs`, eviction by `maxSessions`, persisted, `onChange` fired. It does not touch the pairing code or its counters.

- [ ] **Step 1: Write failing tests** (`createDeviceAuth` with a memory `store`, `maxSessions: 1`): issued token authenticates from the same peer (`ControlIdentity.ref` is the first 12 hex of its hash) and fails with reason `peer-mismatch` from another address; `issue(undefined)` and `issue('::1')` return null and add no session; `::ffff:100.64.0.7` is accepted and bound as `100.64.0.7`; issuing twice leaves one session and the first token fails with `unknown`; the stored entry (`store.save` arg) holds only `hash`, three timestamps and `peer`, never the token; `revokeAll()` then authenticate -> `unknown`; the viewer-profile auth has no `issue` effect (calling it on a `createRemoteAuth()` viewer throws or returns null - pick null and assert it).
- [ ] **Step 2: Run to verify failure.** `npx vitest run electron/remote/remoteAuth.test.ts` -> FAIL.
- [ ] **Step 3: Implement `issue`** by extracting the token-mint and `addSession` lines of `redeemDevice` into a private helper both use.
- [ ] **Step 4: Run to verify pass.** Same command -> PASS (existing tests unchanged).
- [ ] **Step 5: Commit** `feat(auth): DeviceAuth.issue mints a peer-bound token without a code`.

---

### Task 7: Gateway alert scope

**Files:**
- Modify: `electron/control/controlGateway.ts`
- Test: `electron/control/controlGateway.test.ts`

**Interfaces:**
- Consumes: `ControlIdentity.scope` and `encodeAlert` (Task 2).
- Produces: `ControlSession` gains `alert(kind: AlertKind): boolean` (true only when the socket is an alert-scope socket, has completed `hello`, and is not closed; sends `encodeAlert(kind)`). For `identity.scope === 'alert'`: `hello` is answered with `encodeWelcome({ proof, serverTimeMs, expiresAtMs })` (no sessions, no views), no `input.open`, no terminal `onState` subscription; every other verb -> `violation('control: alert scope verb')` (closes with `bye policy`, code 1008). For main scope (scope absent or `'main'`): `alert()` returns false and sends nothing. The switch statement keeps comparing `msg.t` only against string literals so controlBoundary rule 3 still holds.

- [ ] **Step 1: Write failing tests** (reuse the file's fake socket/ports; add a spy `input.open` and `terminals`):
  1. alert-scope socket, `hello` -> welcome with `sessions: []`, `views: []`, valid proof; `terminals.onState` and `input.open` never called.
  2. `it.each(MESSAGE_TYPES.phoneToTitan.filter(t => t !== 'hello'))`: after hello, a well-formed frame of that verb closes the socket with `bye policy`; asserts the terminal read port, input router, thread, ledger and view ports saw zero calls. This loop is the guard for "any future verb".
  3. `alert('finished')` after hello sends the exact `encodeAlert('finished')` string and returns true; before hello it returns false and sends nothing; after close it returns false.
  4. main-scope session: `alert('input')` returns false and the socket received no `alert` frame; a main-scope socket's behaviour for every existing verb is unchanged (the existing tests still pass untouched).
  5. the 5 s hello deadline still applies to alert scope.
- [ ] **Step 2: Run to verify failure.** `npx vitest run electron/control/controlGateway.test.ts` -> FAIL.
- [ ] **Step 3: Implement** in `attach()`: derive `const alertScope = identity.scope === 'alert'`; guard at the top of the post-parse switch with `if (alertScope && msg.t !== 'hello') return violation('control: alert scope verb')`; branch the `hello` case for alert scope; add `alert` to the returned session.
- [ ] **Step 4: Run to verify pass.** `npx vitest run electron/control` -> PASS (boundary included).
- [ ] **Step 5: Commit** `feat(control): alert-scope sockets handshake and receive alerts only`.

---

### Task 8: Listener - per-scope socket counts and the pair response

**Files:**
- Modify: `electron/remote/remoteServer.ts` (`CtlClient`, `upgradeControl`, `handleDevicePair`)
- Test: `electron/remote/remoteServer.test.ts`

**Interfaces:**
- Consumes: `ControlIdentity.scope`, `CONTROL_MAX_ALERT_SOCKETS`, `CONTROL_MAX_SOCKETS`, `ControlPairResult` alert fields (Task 2).
- Produces: the upgrade gate counts only same-scope clients: main scope refuses a 3rd with 503, alert scope a 3rd with 503, and neither scope's count blocks the other. `POST /api/device/pair` 200 body is `{token, expiresAtMs}` plus `alertToken` and `alertExpiresAtMs` only when the port result carries them. `opts.onControlClients` / `controlClients()` keep reporting the total (the hub's connected count comes from the hub, not here).

- [ ] **Step 1: Write failing tests** (use the file's fake `ControlPort` and ws client helpers): with `authenticate` returning scope `main` for token A and `alert` for token B: two A connections succeed and a third gets 503; with two A open, a B connection still succeeds, a second B succeeds, a third B gets 503; closing one A frees an A slot only. Pair route: port result `{status:200, token:'t', expiresAtMs:1, alertToken:'a', alertExpiresAtMs:2}` -> body has all four keys; without alert fields -> body is exactly `{token, expiresAtMs}` (back-compat for the existing client tests).
- [ ] **Step 2: Run to verify failure.** `npx vitest run electron/remote/remoteServer.test.ts` -> FAIL.
- [ ] **Step 3: Implement.** Store `scope: identity.scope ?? 'main'` on `CtlClient`; replace the single `ctlClients.size >= control.maxSockets` check with a count of clients of the identity's scope against `control.maxSockets` or `CONTROL_MAX_ALERT_SOCKETS`; spread the optional alert fields into the JSON.
- [ ] **Step 4: Run to verify pass.** `npx vitest run electron/remote` -> PASS (includes `noWildcardListener.test.ts`).
- [ ] **Step 5: Commit** `feat(remote): separate alert socket budget and alert token in the pair response`.

---

### Task 9: Hub - alert credential (pair, authenticate, revoke, disable)

**Files:**
- Modify: `electron/control/controlHub.ts`, `electron/main.ts` (one store line)
- Test: `electron/control/controlHub.test.ts`

**Interfaces:**
- Consumes: `DeviceAuth.issue` (Task 6), `ControlSession` / alert scope (Task 7), `ControlPairResult` alert fields (Task 2).
- Produces: `ControlHubDeps.alertStore?: RemoteAuthOptions['store']`. Inside the hub: a second `DeviceAuth` (`alertAuth`) built in `init()` with `maxSessions: CONTROL_MAX_DEVICES`, `peerBinding: PEER_BINDING_ENFORCED`, `store: deps.alertStore`. Behaviour: (a) `redeem` returns `alertToken`/`alertExpiresAtMs` from `alertAuth.issue(peer)` after the existing race checks; (b) `port.authenticate` tries the main auth, then the alert auth, and returns the identity with `scope: 'main' | 'alert'`; the `onReject` reason reported is the main auth's unless it was `unknown`, then the alert auth's; (c) `open()` keeps alert-scope sessions in a separate `alertSessions` map (superseding an older session with the same ref) so `status().connected` counts main sockets only; (d) `revokeAll` also revokes the alert auth; `revokeOne(ref)` also revokes the alert auth when the main revoke matched; `dropRevokedSessions` covers both maps against both auths' lists; (e) `teardown` closes alert sessions too; `settle`/`stop` flush both stores; (f) `status().devices` is unchanged (main device only).
- `main.ts`: pass `alertStore: createSessionStore(join(aetherOsDir, 'alert-devices.json'), { peer: true })`.

- [ ] **Step 1: Write failing tests** (existing fake deps; add an in-memory `alertStore`):
  1. pairing returns a main token and an alert token that differ; the alert token authenticates with scope `alert`, the main with scope `main`; a main token never authenticates as alert and vice versa (swap them -> `null`, reason `unknown`).
  2. alert token from a different peer -> `peer-mismatch`.
  3. pairing a second phone replaces both: the first phone's main AND alert tokens return `null`.
  4. `revokeAll()` -> alert token `null`, an open alert session is closed with `revoked`; `revokeOne(mainRef)` -> same; `revokeOne('000000000000')` (no match) leaves the alert token valid.
  5. `setEnabled(false)` closes an open alert session with `disabled`; after re-enable the alert token still authenticates (control back on) but no socket exists until the phone reconnects.
  6. `status().connected` stays 0 with only an alert session open and 1 with a main session; `status().devices.length` is 1 after pairing (the alert credential is not listed).
  7. `alertStore.save` receives entries with only `hash`, timestamps and `peer`; the token text is absent from every `log` line and every saved payload.
  8. disabled hub: `authenticate` of a valid alert token still returns a result from the auth, but `open` is only reachable through the listener, which is down - assert via the existing "off" pattern that `pair` returns 401 while off (no alert token minted).
- [ ] **Step 2: Run to verify failure.** `npx vitest run electron/control/controlHub.test.ts` -> FAIL.
- [ ] **Step 3: Implement** the Interfaces behaviour in `controlHub.ts`; `main.ts` gets the one store line.
- [ ] **Step 4: Run to verify pass.** `npx vitest run electron/control` and `npm run typecheck:electron` -> PASS.
- [ ] **Step 5: Commit** `feat(control): alert credential issued, scoped, revoked and flushed with the main one`.

---

### Task 10: Hub - alerts switch, watcher lifecycle, delivery

**Files:**
- Modify: `electron/controlSettings.ts`, `electron/control/controlHub.ts`, `electron/control/controlIpc.ts`, `src/shared/remote/types.ts` (`ControlStatus.phoneAlerts?: boolean`), `electron/main.ts` (settings port lines)
- Test: `electron/controlSettings.test.ts`, `electron/control/controlHub.test.ts`, `electron/control/controlIpc.test.ts`

**Interfaces:**
- Consumes: `createAlertWatcher`, `ALERT_DEBOUNCE_MS` (Task 5); `ControlSession.alert` (Task 7); `alertSessions` (Task 9).
- Produces: `ControlSettings.phoneAlerts: boolean`; `readPhoneAlerts(filePath: string): boolean` (true only when the stored value `=== true`); `writePhoneAlerts(aetherDir: string, on: boolean, log?): boolean` (returns the readback; preserves the other two flags; file shape `{"v":1,"reenableAtLaunch","phoneTyping","phoneAlerts"}`). `ControlSettingsPort.readAlerts?(): boolean`, `persistAlerts?(on: boolean): boolean`. `ControlHub.setPhoneAlerts(on: boolean): Promise<ControlStatus>`; `ControlStatus.phoneAlerts` reflects the switch. IPC channel `control:setPhoneAlerts` (one boolean, trusted sender, no native confirm), and `ControlHubLike.setPhoneAlerts`.
- Hub behaviour: a private `syncAlerts()` starts the watcher iff `state === 'on' && !stopped && alertsOn && deps.threads` and stops it otherwise; it runs after a successful `acquire`, in `teardown` (before the listener is released), after `setPhoneAlerts`, and in `stop`. The watcher's `onAlert(kind)` calls `alert(kind)` on every open alert session, counts those that returned true and, when at least one did, logs exactly `control: alert sent kind=${kind}`. Nothing is queued: an alert with no connected alert session is dropped silently.
- `main.ts`: `readAlerts: () => readPhoneAlerts(controlSettingsPath(aetherOsDir))`, `persistAlerts: on => writePhoneAlerts(aetherOsDir, on, l => diagLog.write(l))`.

- [ ] **Step 1: Write failing tests.**
  - `controlSettings.test.ts`: default false for a missing, corrupt or `"yes"` value; `writePhoneAlerts(dir, true)` returns true and leaves `reenableAtLaunch`/`phoneTyping` as they were; `writeReenable`/`writePhoneTyping` do not reset `phoneAlerts`; file content is exactly the four-key JSON.
  - `controlHub.test.ts` (fake `threads`/`prompts` ports that expose their taps, manual timers): (1) control on + alerts off -> `threads.attach` never called; turn alerts on -> attached once, `status().phoneAlerts` true; alerts off -> detached; (2) control off with alerts on -> not attached; `setEnabled(true)` -> attached; `setEnabled(false)` -> detached before the listener release; `stop()` -> detached; (3) `autoEnable()` with `reenableAtLaunch` true and alerts true -> attached, with `reenableAtLaunch` false -> never attached; (4) busy/idle then debounce with an open alert session -> that socket receives `encodeAlert(kind)` and the log has exactly one `control: alert sent kind=finished` line; an open MAIN session receives none; (5) alert fired with no alert session -> no frame, no log line; connecting an alert session afterwards receives nothing (no replay); (6) log lines contain no transcript text; (7) `persistAlerts` readback is what `status()` reports (a failing persist keeps the old value).
  - `controlIpc.test.ts`: `control:setPhoneAlerts` rejects non-boolean and an untrusted sender, and passes a boolean straight to the hub without calling any confirm.
- [ ] **Step 2: Run to verify failure.** `npx vitest run electron/controlSettings.test.ts electron/control/controlHub.test.ts electron/control/controlIpc.test.ts` -> FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run to verify pass.** `npx vitest run electron` and `npm run typecheck:electron` -> PASS.
- [ ] **Step 5: Commit** `feat(control): alerts switch, watcher lifecycle and label-only delivery`.

---

### Task 11: Settings switch "Phone alerts"

**Files:**
- Modify: `electron/preload.ts` (next to line `setPhoneTyping`), `src/aetherElectron.d.ts` (`setPhoneAlerts: (on: boolean) => Promise<ControlStatus>`), `src/components/settings/ControlAccessCard.tsx`
- Test: `src/components/settings/ControlAccessCard.test.tsx`

**Interfaces:**
- Consumes: `ControlStatus.phoneAlerts` and `control:setPhoneAlerts` (Task 10).
- Produces: a checkbox labelled "Phone alerts" in the phone-control block, mirroring "Allow phone typing" (busy guard against double clicks, adopts the returned status), `checked={status.phoneAlerts === true}`, helper text "Notify the phone when Terminal Alpha finishes, asks a question or needs input. Only a fixed label leaves this PC. Needs phone control on."

- [ ] **Step 1: Write failing tests** in the existing card test style: renders unchecked when `phoneAlerts` is false or absent; clicking calls `control.setPhoneAlerts(true)` once and shows the returned status; a second click while the first is pending is ignored; the label text and helper text are present.
- [ ] **Step 2: Run to verify failure.** `npx vitest run src/components/settings/ControlAccessCard.test.tsx` -> FAIL.
- [ ] **Step 3: Implement** the preload entry (`ipcRenderer.invoke('control:setPhoneAlerts', on)`), the typing, and the checkbox (copy the `setTyping` handler shape; use the existing form primitives, not a bare clickable span).
- [ ] **Step 4: Run to verify pass.** `npx vitest run src/components electron/preload` and `npm run typecheck:electron` and `npm run build` -> PASS.
- [ ] **Step 5: Commit** `feat(settings): Phone alerts switch`.

---

### Task 12: Android - pair response, alert vault, ControlClient alert delivery

**Files:**
- Modify: `android/.../auth/Pairing.kt`, `android/.../net/ControlClient.kt`, `android/.../MainActivity.kt` (the `PairResult.Paired` branch in `onPairResult`, after the existing save flow is started)
- Create: `android/.../auth/AlertVault.kt`
- Test: `android/app/src/test/java/.../auth/PairingTest.kt`, `net/ControlClientTest.kt`, `auth/VaultFormatTest.kt` (reuse; extend only if a shared helper changes)

**Interfaces:**
- Produces: `PairResult.Paired(token: String, expiresAtMs: Long, alertToken: String? = null, alertExpiresAtMs: Long? = null)` (`toString` redacts both tokens); `PairingClient.parsePaired` reads the optional fields (well-formed per `Pairing.isWellFormedToken` or ignored); `class AlertVault(context: Context)` with `fun save(token: String): Boolean`, `fun load(): String?`, `fun clear()`, `fun hasToken(): Boolean`, file under `noBackupFilesDir`, AES-GCM with an AndroidKeyStore key created with `setUserAuthenticationRequired(false)`, reusing `VaultFormat.encode/decode/writeAtomically`; `ControlClient` constructor gains `onAlertFrame: (ControlProtocol.AlertFrame) -> Unit = {}` and handles frame type `"alert"` after welcome (bad frame or before welcome -> `Failed(Protocol)` like the other types).

- [ ] **Step 1: Write failing tests.**
  - `PairingTest`: a 200 body with `alertToken` (43-char base64url) and `alertExpiresAtMs` -> `Paired` carries both; a body without them -> `alertToken == null` (older desktop); a malformed `alertToken` -> main pairing still succeeds with `alertToken == null`; `Paired.toString()` contains neither token.
  - `ControlClientTest` (fake `Transport`): after a valid welcome an `alert` frame calls `onAlertFrame` with `AlertFrame("claude", FINISHED)`; an `alert` frame before welcome fails with `Failure.Protocol`; an `alert` frame with an unknown kind fails with `Failure.Protocol`; existing frame types unchanged.
- [ ] **Step 2: Run to verify failure.** `cd android && ./gradlew.bat testDebugUnitTest --tests '*PairingTest' --tests '*ControlClientTest'` -> FAIL.
- [ ] **Step 3: Implement.** `AlertVault` is not unit tested (Keystore/Context); keep its logic to key handling and the shared `VaultFormat`. In `MainActivity.onPairResult`, when `result.alertToken != null` call `AlertVault(this).save(it)` best effort (never block or fail the main pairing on it) and then start the alert service via the helper added in Task 14 (call `AlertController.onPaired(context)`, a deliberate no-op in `alerts/AlertController.kt` until Task 14 gives it behaviour).
- [ ] **Step 4: Run to verify pass.** `cd android && ./gradlew.bat testDebugUnitTest` and `./gradlew.bat lintDebug` -> PASS.
- [ ] **Step 5: Commit** `feat(android): alert token from pairing, alert vault, alert frame delivery`.

---

### Task 13: Android - pure alert models (text, backoff, status)

**Files:**
- Create: `android/.../alerts/AlertText.kt`, `alerts/AlertReconnectPolicy.kt`, `alerts/AlertsStatus.kt`
- Test: `android/app/src/test/java/.../alerts/AlertTextTest.kt`, `AlertReconnectPolicyTest.kt`, `AlertsStatusTest.kt`

**Interfaces:**
- Produces:
  - `object AlertText { fun title(kind: ControlProtocol.AlertKind): String; fun publicText(slotLabel: String, kind: ControlProtocol.AlertKind): String; const val WATCHING = "Aether watching"; const val NOT_CONNECTED = "Aether not connected"; const val PERMISSION_OFF = "Alerts are off: allow notifications for Aether in Android settings." }`. `title` returns "Task finished", "A question needs your attention", "Input needed for clarification". `publicText` returns "<label> has finished" / "<label> has a question" / "<label> needs input" (so "Terminal Alpha has finished", ...). No function takes free text from a frame.
  - `class AlertReconnectPolicy(baseMs: Long = 2_000L, capMs: Long = 60_000L) { fun nextDelayMs(): Long; fun reset() }` - doubles from `baseMs` to `capMs`.
  - `enum class AlertsStatus { NOT_PAIRED, PERMISSION_OFF, WATCHING, NOT_CONNECTED }` and `fun alertsStatus(hasToken: Boolean, notificationsAllowed: Boolean, connected: Boolean): AlertsStatus` with precedence NOT_PAIRED, PERMISSION_OFF, then WATCHING / NOT_CONNECTED.

- [ ] **Step 1: Write failing tests.** Exact strings for every kind in both functions; a hostile-input test is structural (no overload accepts a String body), so assert `AlertText.publicText(SLOTS[0].label, k)` for all `AlertKind.values()` equals the three listed strings; backoff sequence `2000, 4000, 8000, 16000, 32000, 60000, 60000`, then `reset()` -> `2000`; `alertsStatus` truth table over the three booleans (8 rows).
- [ ] **Step 2: Run to verify failure.** `cd android && ./gradlew.bat testDebugUnitTest --tests '*Alert*'` -> FAIL.
- [ ] **Step 3: Implement** the three small files.
- [ ] **Step 4: Run to verify pass.** Same command -> PASS.
- [ ] **Step 5: Commit** `feat(android): alert text, reconnect backoff and status models`.

---

### Task 14: Android - foreground service, notifications, permission notice, boot start

**Files:**
- Create: `android/.../alerts/AlertService.kt`, `alerts/AlertNotifier.kt`, `alerts/BootReceiver.kt`; fill in `alerts/AlertController.kt` (stub from Task 12)
- Modify: `android/app/src/main/AndroidManifest.xml`, `MainActivity.kt` (start the service on launch when `AlertVault.hasToken()`, request `POST_NOTIFICATIONS` on API 33+ once after pairing, show the permission notice), the shell screen that hosts `AeNoticeBox` (`ui/shell/ShellScreen.kt`), `net/OkHttpTransport.kt` (an alert-only client with `pingInterval(30, SECONDS)` via a new `defaultAlertClient()`; the existing `defaultClient()` is not changed)

**Interfaces:**
- Consumes: Task 12 (`AlertVault`, `onAlertFrame`), Task 13 (`AlertText`, `AlertReconnectPolicy`, `alertsStatus`).
- Produces: `object AlertController { fun onPaired(context: Context); fun ensureRunning(context: Context); fun status(context: Context): AlertsStatus }`. Manifest: permissions `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`; `<service android:name=".alerts.AlertService" android:foregroundServiceType="specialUse" android:exported="false">` with the `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` property (value "owner-only desktop alert socket"); `<receiver android:name=".alerts.BootReceiver" android:exported="false">` for `BOOT_COMPLETED`. Decision recorded for review: `specialUse`, not `dataSync`, because a targetSdk 35 `dataSync` service is time-limited; the implementer confirms both claims against the Android developer docs for foreground service types before relying on them (UNVERIFIED here).
- Service behaviour: `onStartCommand` reads the token from `AlertVault`; no token -> `stopSelf()`. Otherwise `startForeground` with the ongoing notification (channel `aether_watch`, importance LOW; text `AlertText.WATCHING` when connected, `AlertText.NOT_CONNECTED` otherwise), builds a `ControlClient(host = BuildConfig.TITAN_IP, appVersion = BuildConfig.VERSION_NAME, transport = OkHttpTransport(OkHttpTransport.defaultAlertClient()), onState, onAlertFrame)` and `connect(token)`. `Connected` -> reset backoff, update text. `Revoked` -> `AlertVault.clear()`, `stopSelf()`. `Superseded`, `Disabled`, `Closed`, `Failed` -> text `NOT_CONNECTED`, reconnect after `AlertReconnectPolicy.nextDelayMs()`. Returns `START_STICKY`. `onAlertFrame` -> `AlertNotifier.post(kind)`: channel `aether_alerts` (importance HIGH, `lockscreenVisibility = VISIBILITY_PRIVATE`, no custom sound or vibration code), a single replaced notification id, title `AlertText.title(kind)`, text the slot label, `setVisibility(VISIBILITY_PRIVATE)` and `setPublicVersion(...)` whose only text is `AlertText.publicText(label, kind)`, content intent opens `MainActivity` (immutable `PendingIntent`). The service never starts the main connection and never reads the main vault.

- [ ] **Step 1: Write failing tests** for the only pure seam added here: extract the frame -> notification-fields mapping as `fun alertNotification(frame: ControlProtocol.AlertFrame): AlertNotificationFields(title, text, publicText)` in `AlertNotifier.kt` and test it in `alerts/AlertNotifierTest.kt`: for each kind the three strings equal Task 13's; a frame parsed from a hostile JSON (`"text":"C:\\secret"` extra key, via `parseAlertFrame`) yields the same fields as the clean frame. Everything else in this task is Android framework glue, verified by build, lint and Task 15 on the device (stated so, not claimed as unit-tested).
- [ ] **Step 2: Run to verify failure.** `cd android && ./gradlew.bat testDebugUnitTest --tests '*AlertNotifierTest'` -> FAIL.
- [ ] **Step 3: Implement** the files in Interfaces. Notice: when `AlertController.status(context) == PERMISSION_OFF` the shell shows `AeNoticeBox(AlertText.PERMISSION_OFF, amber = true)`; on API 31-32 `notificationsAllowed` is true by definition.
- [ ] **Step 4: Run to verify pass.** `cd android && ./gradlew.bat testDebugUnitTest lintDebug assembleDebug -PAETHER_TITAN_TAILNET_IP=100.84.175.105` -> PASS, zero new lint errors.
- [ ] **Step 5: Commit** `feat(android): alert foreground service, notifications and permission notice`.

---

### Task 15: Whole-branch verification, device run, Doze latency, docs flip

**Files:**
- Modify: `docs/privacy-and-data.md` (Status line: phone alerts built; add measured latency under Limits), `CLAUDE.md` (mark `alertClassifier.ts` / `alertWatcher.ts` BUILT), `PROGRESS.md` (a "Shipped plans" entry: branch, task commits, what exists, what was and was not live-verified, the measured latency table)

**Interfaces:**
- Consumes: everything above. No new code.

- [ ] **Step 1: Full suites.** `npx vitest run`, `npm run typecheck:electron`, `npm run build`, `cd android && ./gradlew.bat testDebugUnitTest lintDebug`. Quote the counts against the baseline. Expected: no failures, no new skips.
- [ ] **Step 2: Main connection untouched.** `git diff 2a1aabd..HEAD -- android/app/src/main/java/com/matt/aethermobile/AppFlow.kt android/app/src/main/java/com/matt/aethermobile/auth/RelockPolicy.kt` must print nothing; `git diff 2a1aabd..HEAD -- src/shared/remote/types.ts` shows `CONTROL_MAX_SOCKETS = 2` and `CONTROL_MAX_DEVICES = 1` unchanged.
- [ ] **Step 3: Device run on the S25** (debug-signed install over the existing one: `adb install -r`, never uninstall - the vault lives in app data; build with `-PAETHER_TITAN_TAILNET_IP=100.84.175.105`). Use a packaged-or-dev Aether that is not the session's own host (see the memory note: never restart the dev instance that hosts the terminal). Checklist, each reported as Passed / Incomplete / Failed with the observed result: (a) re-pair once, alerts switch on -> persistent "Aether watching"; (b) Alpha finishes a turn with the phone locked -> lock screen shows only "Terminal Alpha has finished"; unlocked shade shows "Task finished"; (c) a reply ending in "?" -> question wording; (d) a permission prompt left pending -> input wording; (e) Esc-interrupt in Alpha -> no notification; (f) REVOKE on the desktop -> notification flips to not connected and the service stops; (g) deny notification permission -> in-app notice; (h) switch alerts off on the desktop -> no further alerts and no thread polling (diag shows no `control: thread` activity); (i) kill the PC listener -> "Aether not connected", then reconnects after the PC returns; (j) reboot the phone -> service returns without opening the app (record whether `BootReceiver` works; if not, record that opening the app is required, do not claim otherwise).
- [ ] **Step 4: Measure delivery latency; assume nothing.** Record, for the phone (1) screen on and app foreground, (2) screen off, charging, (3) screen off, unplugged, battery-optimised default, idle for at least 30 minutes (deep Doze), and (4) the same with battery optimisation set to unrestricted for Aether: for each, 5 trials of "turn ends on the PC -> notification posted", taking the PC time from `diag.log` (`control: alert sent`) and the phone time from `adb logcat` / `dumpsys notification`. Write the raw numbers, min/median/max and the exact state of the phone into PROGRESS.md. There is no pass/fail threshold; if a case never delivers, report that as the result.
- [ ] **Step 5: Docs flip and PROGRESS.** Update the three docs; list in PROGRESS.md anything not verified (anything marked Incomplete in Step 3) as NOT done.
- [ ] **Step 6: Commit** `docs: phone alerts built; device results and Doze latency` with the three files. Then request the whole-branch R3 review (fresh reviewer, adversarial brief: hunt for any path where content, a second alert, a replay, or a non-hello verb gets through an alert-scope socket).

---

## Self-Review

**1. Spec coverage.** Goals: notification within seconds, locked/backgrounded (Task 14, 15); three kinds with fixed wording (2, 3, 13, 14); lock-screen generic text (13, 14); fires every stop with no threshold (5); main connection unchanged (Global Constraints, 15 step 2). Decisions: separate alert credential (6, 7, 8, 9); closed text set (2, 13); Alpha only (2, Global Constraints); watcher behind a default-off Settings switch even with no phone (10, 11). My calls: same-pairing issuance (9, 12); foreground service, persistent notification, private lock-screen (14); classifier reduced to a label, uncertain -> input (3); debounced edge, no interrupt, no stale second alert (4, 5); prompt -> input (5); separate socket count and own store (8, 9); one frame in three mirrors with rule 3 (2; phoneToTitan is unchanged, so rule 3 holds and the new-credential guard is the Task 7 all-verbs loop plus the Task 5 boundary rows); permission-denied notice and "not connected" text (13, 14); alerts only while control is on and restart rule (10); at most one alert per stop, no replay or queue (5, 10). Constraints: hash-only/peer-bound/revocable/off when control off (6, 9); metadata-only diag (10); docs first (1) and PROGRESS last (15); tests: boundary guards (5, 7), classifier table (3), no-duplicate for the 120 s rule (4, 5), Android JVM only for pure logic (12-14). Open items: Doze latency (15 step 4), reuse of existing slot labels (`SLOTS`, Task 13).

**2. Step scan.** Code steps carry signatures, files and pinned values; no function bodies. The classifier precedence in Task 3 is spelled out because the table alone does not determine it.

**3. Type consistency.** `AlertKind` / `ALERT_KINDS` (Task 2) used in 3, 5, 7, 10; `ControlScope` and `ControlIdentity.scope` (2) used in 7, 8, 9; `ThreadTap.turn` (4) used in 5; `DeviceAuth.issue` (6) used in 9; `ControlSession.alert` (7) used in 10; `alertSessions` / `alertAuth` (9) used in 10; `ControlStatus.phoneAlerts` and `setPhoneAlerts` (10) used in 11; Kotlin `AlertKind`, `AlertFrame`, `parseAlertFrame` (2) used in 12-14; `AlertText`, `AlertReconnectPolicy`, `alertsStatus` (13) used in 14; `AlertController` stub (12) filled in 14.

**4. Review Focus.** Each of the five has a test in the owning task (named at the end of each line above).

**5. Proportion.** One task per reviewable seam; tests are listed by behaviour and exact value, bodies are left to the implementer.
