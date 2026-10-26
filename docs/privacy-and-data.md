# Aether OS — Privacy & Data Model

**Status:** binding design constraint, not aspiration. Every stage in `docs/roadmap.md` is
subordinate to this document.

---

## 1. The stance

**Aether OS is single-user and local-first. The explicit outbound exceptions are Codex verification (§9), opted-in Claude–Codex communication (§13), operator-driven terminals (§11), and the opt-in, default-off background memory extraction through the Claude CLI (§14). The one deliberate inbound exception is the opt-in, off-at-every-launch, tailnet-only read-only chat view for a paired phone (§16), and, separately, the opt-in tailnet-only phone control path (§17), which unlike the viewer may be set to re-enable at launch (V1 is built: pairing, device auth and the `/ctl` handshake; terminals, typing and approvals are planned, not built; see §17).**

That is a stronger claim than TokenMonitor's, and deliberately so — the two products have different
audiences. TokenMonitor is a fleet tool: it writes per-seat daily reports to a shared network folder
by design, and its README carefully scopes what those reports may contain (usage metrics only,
never prompt content or code). Aether OS has no fleet, no sharing, no reporting, and no
externally-reachable listener — `electron/permissionServer.ts` does run a local HTTP server for
`PermissionRequest`/`PostToolUse`/`Notification` hook brokering, but it is bound to `127.0.0.1`
only, reachable only from this machine, with no port exposed externally. Loopback is reachable by
every local process and by browser pages, so since 2026-10-04 every request and response is
mutually authenticated with a per-launch HMAC secret held only in the user-only port file, which
is deleted on quit (`electron/permissionAuth.ts`; see §3). The listener exception is the opt-in remote chat view (§16): a read-only listener bound to the
Tailscale interface address only, off at every launch, enabled through a native confirmation, and gated by a pairing code and a
session cookie; it never binds a wildcard or LAN address. Phone control (§17) shares that tailnet-only listener and adds a separate bearer-token `/ctl` input path with its own toggle, token store and code directory; both bind only the Tailscale IPv4 address, never a wildcard or LAN address (V1 built for pairing and the handshake only; terminals and approvals planned; see §17). The single-user constraint is not a smaller version of TokenMonitor's
model; it removes the model entirely.

**Aether has no SDK, HTTP or key-loading path to billed model APIs.** (The opt-in Claude CLI
path in §14 is a different thing: it can bill API usage, depending on how Claude Code is
configured.) Stage 13.5 removed the Anthropic SDK,
chat API proxy, and `.env` key loading. The legacy deterministic Comms responder stays local.
Two independently default-off features can send content to OpenAI under the operator's Codex
subscription: manual verification (§9) and Claude-requested consultations (§13). Neither toggle
enables the other. The communication view displays real exchanges without asking another model
to summarize them.

**There is one background model call, and it is opt-in (§14).** The collector's memory
extractor (`collector/src/memoryExtract.ts`) calls `claude -p --model haiku`. It shipped with
Stage 13 and went unnoticed against the Stage 13.5 "no model call site" claim until issue #104;
it is now off by default and gated behind a Settings toggle. It goes through the Claude CLI,
not an SDK or HTTP call site, but it can still bill API usage depending on how Claude Code is
configured; §14 states exactly what is sent and under which conditions.

The embedded Claude terminal sends prompts to Anthropic under the user's Claude Code login.
Aether strips API-key, auth-token and base-URL overrides from the launch environment; the
terminal is not a network-isolated application. With §13 enabled and a connected session
explicitly started, Aether also provides the three disclosed consultation tools. Their results
can influence Claude's subsequent work, subject to Claude's normal action permissions.

**The same carve-out, additionally gated, now covers a second terminal.** A Codex terminal
(`electron/codexPtyManager.ts`) — a second, independent, real interactive `codex` CLI session —
exists alongside the Claude terminal. It uses the same lazy, mount-triggered spawn mechanism the
Claude terminal already uses — neither one launches unconditionally at app boot — but the Codex
terminal adds an extra gate the Claude terminal doesn't have: it only spawns once the operator has
also opted in via `codexTerminalCfg.enabled`, default `false`. See §11 for the full boundary.

**No telemetry. Ever.** Not opt-out, not anonymous, not aggregate. Worth stating explicitly because
it is a live differentiator: `agent-flow`, one of the two comparable agent-trace visualizers,
ships anonymous telemetry **enabled by default**.

**The main renderer window carries a Content Security Policy.** The renderer build injects it as a `<meta http-equiv>` tag (`vite-plugins/rendererCsp.ts`). In the packaged build it starts from `default-src 'none'` and allows only same-origin scripts, styles, images and fonts (images may also be `data:`), so the renderer cannot load or run script from anywhere else and cannot execute inline script. `connect-src 'none'` means renderer code cannot open its own `fetch`, XHR, WebSocket or EventSource connection to any host. (The §16 phone pages are served by the main process under their own, separate policy.) `object-src`, `base-uri` and `form-action` are `'none'`. Styles keep `'unsafe-inline'` because xterm.js injects a `<style>` element without nonce support; that affects CSS only, not scripts. The dev-server policy differs in exactly two places (inline script for React Fast Refresh, and a loopback WebSocket for HMR), and neither reaches the packaged build. This is a restriction on what the renderer page can load and connect to, not a navigation guard: it does not stop the window from being navigated or from opening other windows, which is a separate control.

---

## 2. What the single-user constraint deletes

Bank these as removed from scope, permanently:

- No multi-user account or organization authorization model; §13 uses a short-lived local launch capability
- No multi-tenant schema, no user/seat/org columns
- No shared folder, no report writing, no roll-up, no leaderboard
- No sharing links, no export-to-cloud, no sync
- **No externally-reachable listener.** Collector ingest is a file spool, not a listener at all
  (§3); the one real local HTTP server in this app (`electron/permissionServer.ts`, for permission
  and notification hook brokering) is bound to `127.0.0.1` only, with no port exposed externally,
  and authenticates both directions with a per-launch HMAC secret that never crosses the socket.
  **One deliberate, opt-in exception:** the read-only phone chat view (`electron/remote/`) listens on
  the Tailscale interface address only (never `0.0.0.0`, `::` or a LAN address), is off at every
  launch, needs a native confirmation to enable, and requires a pairing code and session cookie;
  see §16, and phone control, §17 (planned)

Every one of those is an attack surface that now simply does not exist.

---

## 3. Transport: a file spool, not a loopback HTTP listener

**This reverses the earlier recommendation in `docs/roadmap.md` §4, and the privacy constraint is
what reversed it.**

The original design had the collector listen on `127.0.0.1` with a per-install token in the URL
path, and hooks POST to it. That design has three problems that only become visible once
"nothing leaks" is the governing requirement:

1. **The token would have lived in `~/.claude/settings.json`**, inside the hook command string —
   a file that people screenshot when asking for help, paste into issues, and occasionally commit.
   A secret whose storage location is a config file users routinely share is not a secret.
2. **A listening socket is a permanent local attack surface.** Any process running as the user can
   reach it. And binding is exactly the kind of thing that gets fat-fingered from `127.0.0.1` to
   `0.0.0.0` in a refactor — the failure mode behind every "don't expose your self-hosted agent UI
   to the internet" warning in the 2026 landscape.
3. **An HTTP POST to a dead listener can hang**, and the single highest-severity constraint in this
   project is that *a hook must never degrade a real Claude Code session.* Making that safe requires
   correct timeout handling on every hook invocation, forever.

**The replacement: an append-only spool.**

```
hook fires
  → tiny Node script reads the payload on stdin
  → appends one JSON line to ~/.aether-os/spool/<session-id>.jsonl
  → exits 0
collector
  → tails the spool directory
  → derives signals, writes to SQLite
  → truncates/removes consumed spool files
```

This is better on every axis that matters here:

- **No port, no token, no auth surface.** There is nothing to scan, nothing to leak, nothing to
  misconfigure.
- **A file append cannot hang on a dead collector.** The highest-severity constraint is satisfied
  structurally rather than by careful timeout code. If the collector is not running, hooks keep
  appending and it catches up when it starts — which also means **no events are lost while the
  collector is down**, a property the HTTP design did not have.
- **Simpler.** No server, no framework, no request handling, no status codes.
- It reuses the exact pattern already established by the statusline script
  (`docs/superpowers/plans/2026-07-27-statusline-feed.md`, Task 3): tiny dependency-free Node
  script, atomic write, always exit 0.

The only cost is latency — the collector polls rather than being pushed. For a dashboard whose
tightest existing loop is one second, that is not a cost.

---

## 4. Store the signal, not the payload

The single most effective privacy control is **not collecting the sensitive thing in the first
place.** Data you never stored cannot leak, cannot be subpoenaed, cannot be exfiltrated by the next
supply-chain compromise, and does not need encrypting.

Work backwards from what the detectors actually need:

| Consumer | Genuinely needs | Does **not** need |
|---|---|---|
| `detectReReadLoop` | file path, tool name, timestamp | file contents |
| `detectWriteDeleteRewrite` | file path, tool name, timestamp | file contents, diffs |
| `detectZeroEditBurn` | tool names, token counts | any content |
| `detectStalledPermission` | tool name, open/close timestamps | tool input |
| `unpinned-config-re-reads` | file path, read count | file contents |
| `opus-on-trivial-turns` | model, output token count | message text |
| `uncapped-bash-output` | **a boolean** (does the command contain a pagination hint) + result **length** | the command string, the output |

That last row is the important one. The rule needs the command string only to run one regex
(`/head|tail|select-object|measure-object|-first|-last/i`) and needs the result's *length*, not its
content. **Both reduce to a boolean and an integer computed at ingest.** The raw command never has
to be stored at all.

**Therefore the collector's ingest rule is: derive at the edge, persist the derived value, discard
the raw.** What lands in SQLite is file paths, tool names, timestamps, token counts, integers and
booleans. **No source code. No command strings. No tool outputs. No prompts. No message text.**

Contrast with the documented failure mode of `ccflare`, a comparable tool: its SQLite database
stores full request and response bodies — meaning your source code and any in-context secrets, in
plaintext, on disk. That is not a hypothetical; it is what happens when a tool stores raw payloads
because it might need them later.

**Corollary for Stage 5:** if a future feature genuinely requires content (a diff view, say), that
is a *new decision with its own privacy analysis*, not an incremental extension of an existing
store. Do not widen the schema to "keep options open."

**Rendering is not storing (Stage 14 amendment, binding).** Stage 14's Comms deck reads real
transcript content and renders it in a mounted view — exactly the payload this section exists to
keep out of the store. The resolution is a distinction this rule already implied but never had to
state, because until now nothing rendered payload: transcript content may be read from disk and
held in the rendering component's own React state for as long as the view is mounted. It must
never enter the `useReducer` store, never enter `persistence.ts`'s whitelist, never be written to
`~/.aether-os/`, and never reach the collector's SQLite schema. The read path is pull-based —
requested by the mounted view (on mount, on an explicit refresh, and, for a live source, re-fetched
on the app's existing 900ms tick) — never a `state` push, and it is the one deliberate exception to
the `useRealAgentsSync.ts` pattern that feeds every other real-data surface into the store.
`src/state/noPayloadInStore.test.ts` is the mechanical enforcement: it asserts no
transcript-message type is reachable from `AetherState`. The operator is the only reader of their
own transcripts on their own machine, and nothing leaves it (except what §14 sends, when enabled) — the original rule was written to
prevent a *store* that could leak, not to prevent the operator from looking at their own session.

**Traffic tab amendment (Message Board v1).** The Traffic tab (`electron/board/*`,
`src/shared/board/*`, `src/components/board/*`) is a second pull-based transcript reader under the
same rule. It is Claude-only and read-only, and it spans every session under `~/.claude/projects`
rather than the one pinned session. The main process rebuilds the feed on each request (tab open,
session select, or the Refresh button; there is no timer and no dependence on the 900ms tick) and keeps
nothing between calls. The feed text lives only in `useBoard.ts`/`BoardView.tsx` React state: it never
enters the store, `persistence.ts`, `~/.aether-os/` or the collector, which the tab does not touch.
Obvious secrets (key/token/password shapes) are masked at feed-build time in the main process, so the
raw secret never crosses IPC, and bodies are capped at 8000 characters (the UI previews 280). Session titles
(the row label in the session list) cross IPC as masked prompt text, like post bodies: the first human
prompt of each session, masked and cut to 60
characters. Finding it reads only a bounded head of the
session file (4 MB), and titles are computed per request, never stored. Titles shorten common absolute paths (drive-letter, backslash UNC and multi-segment POSIX paths) to their last segment on a best-effort basis; some forms, such as paths containing spaces, `~/` paths and other unusual shapes, may be left partly or wholly as typed. This is cosmetic only: a title is the user's own prompt text, already masked for secrets. Project
identity crosses IPC only as `{key,name,worktree}`, never an absolute path. Message bodies can still
contain absolute paths, because they are dispatch prompts and are not altered. The guard is
`src/state/noPayloadInStore.test.ts` (`BoardPost`/`BoardFeed` must not be referenced from the
store, persistence or reducer). Masking is pattern-based and is not a DLP: a secret in an unusual shape
is shown as-is, PGP and PEM private-key blocks are masked from the BEGIN line to the first matching END line (or to the end of the text); overlapping or nested blocks, an unbalanced quote opened before a block, and a value shorter than 6 characters glued to the BEGIN line can leave text visible. Any other armored or PEM block given as a `key=value` value masks only its first token, dotted key names (`my.secret.key=...`) are not masked, and code-like
assignments may be masked (the only skipped value is an exact type keyword).

---

## 5. File paths are the remaining sensitive surface

Once contents are excluded, paths are the most sensitive thing left — they reveal project
structure, client names, and occasionally more than you would want in a screenshot.

- **Store paths relative to the project root** where the project root is known, rather than absolute
  paths including the home directory and username.
- **Display basenames only.** TokenMonitor already does this (`path.win32.basename`) in
  `optimizeRules.js`; carry the same discipline into every card, tooltip and timeline label. This
  matters most for the screenshots and GIFs in §5 of the roadmap — a portfolio artifact should not
  need redacting before it can be posted.
- Full-path hashing with a per-install salt is available if it ever becomes warranted, but is
  probably over-engineering for a local-only single-user tool. Note it as a known option, not a
  requirement.

---

## 6. Retention is a privacy control

`docs/roadmap.md` §4 originally framed retention as a disk-space concern. That framing was too
weak. **Retention is the primary mitigation for everything §4 does not prevent**, and it should be
designed as such:

- A default retention window (a rolling N days) with a compaction job, decided **before the schema
  ships**, not after the database is four gigabytes.
- Aggregate rollups survive compaction; individual event rows do not. Anomaly-rate-over-time and
  weekly cost-of-thrash need daily aggregates, not the underlying tool calls — so the useful
  analytics survive while the granular record ages out.
- A visible **Purge all collected data** action in Settings that actually deletes, plus a readout of
  the store's current size and oldest retained row. If you cannot see what is stored and delete it
  in one click, "local-only" is a claim rather than a property.

---

## 7. At rest

- `~/.aether-os/` (store, spool, statusline payload, attachments, codex-home) is made user-only at
  every app start (`electron/privateDir.ts`, issue #99). On Windows this is an explicit ACL rather
  than the inherited profile default: the directory's ACL is protected (inheritance from the profile
  disabled) and grants full control to the user and SYSTEM only, and everything under it inherits
  that. It is written only when something is missing, since a rewrite re-propagates to every child.
  An explicit grant some other tool added (seen in practice: the Codex sandbox group, which Codex
  needs for `codex-home`) is **kept, not stripped**, and each one on the directory or a top-level
  entry is recorded as a `[diag] private-dir extra` line in `diag.log` (entry name, account name,
  allow/deny, rights). Stripping it silently could break that tool; tolerating it silently would
  make the promise here unverifiable. On POSIX the directory is set to 0700 and its top-level
  files and directories to 0600/0700 (symlinked entries are skipped). If `~/.aether-os` itself is a
  symlink (or a junction on Windows), its real target is what gets secured. A failure is logged,
  not fatal.
- `~/.aether-os/remote-sessions.json` holds the paired phones for the remote chat view: a SHA-256 hash and three timestamps per phone, nothing else (§16). It is auth configuration, so Settings → Purge leaves it; REVOKE ALL PHONES empties it.
- `~/.aether-os/remote-devices.json` holds the paired phone-control apps: a SHA-256 hash, three timestamps and the phone's tailnet address per app, nothing else (§17). Same rules as `remote-sessions.json`: Purge leaves it, REVOKE ALL empties it (§17).
- `~/.aether-os/control-settings.json` holds `{"v":1,"reenableAtLaunch":boolean}` and nothing else: the one persisted phone-control setting (§17). It is auth configuration, not collected data, so Settings → Purge leaves it, like `remote-sessions.json` (Purge runs only the collector purge and the diag-log purge). A user disable from Settings clears the flag; quitting the app does not.
- The SQLite store is **not** encrypted, and the README should say so plainly rather than implying
  otherwise. Given §4, its contents are paths, names, timestamps and integers — the honest position
  is "here is exactly what is in it," not a security claim the implementation does not back.
- `.env` stays gitignored. Stage 13.5 removed key loading and the `chat:hasKey`/chat API
  handlers; there is no Aether API-key input path. Subscription adapter credentials remain
  subject to their explicit provider boundaries below.
- Spool files are deleted after consumption, not left to accumulate as a second copy of the data.
- `~/.aether-os/diag.log` (plus one rotated `diag.log.1`, about 2 MB total at most) records `[diag]` lifecycle lines for crash and white-screen diagnosis: event names, reasons, exit codes and, on most `[diag]` lines, an `at=` timestamp. The remote and phone-control lines (`remote: ...`, `control: ...`, §16 and §17) are fixed strings with no `[diag]` prefix and no timestamp; they can carry a tailnet address, counts, a reject reason or a 12-character token-hash ref. It holds no content, prompts or commands. `did-fail-load` includes the URL, which in practice is the app's own page (the dev server or the bundled `index.html`): the renderer has no external links, iframes or navigation, though there is no will-navigate guard. After an unlock or resume the app also writes one renderer probe line: counts (DOM root children, canvases, lost WebGL contexts), one computed body colour, the window size, and how many of five sampled pixels are white; no screenshot or DOM content is stored. Renderer console errors are forwarded as error text truncated to 300 chars plus a source file basename and line, capped at 20 lines per minute; that error text is the one field that could carry content, which is why it is capped and rate-limited. Settings → Purge deletes `diag.log` and `diag.log.1` along with the collected data, and reports a failure if either cannot be removed; logging resumes with a fresh file afterwards.

---

## 8. The LLM boundary — retired in Stage 13.5

The scoped-context work in `src/components/chat/systemPrompt.ts` used to be the privacy control
governing the one path where data left the machine: AETHER received the full fleet snapshot, an
individual agent channel received only its own task/files/a thin summary, and tests asserted an
agent channel could never leak the roster, approval queue, or project list.

**That file and its leak tests were retired in Stage 13.5** (`docs/roadmap.md` §3.5) along with the
rest of the model call path they scoped context for — the surface they guarded no longer exists,
since there is no longer any path by which chat context reaches a model at all. Recorded here as
history, not as an active control: if a future stage reintroduces a model call, this boundary (or
its equivalent) has to be rebuilt from scratch, not assumed to still be standing.

**Update (issue #104):** a model call was in fact reintroduced as an opt-in, default-off
background boundary: the collector's memory extraction via `claude -p` (§14). It does not
reuse this retired scoped-context design; the boundary that governs it is §14, and the guard
is `src/shared/noApiCalls.test.ts`'s claude-launch allow-list.

---

## 9. Cross-engine Codex verification — manual outbound exception

Shipped 2026-08-07 — see `docs/superpowers/plans/2026-08-07-codex-acp-cross-engine-verification.md`.
This explicit verification feature sends scoped evidence to a second vendor. It exists to let the
operator ask a different model family (OpenAI's Codex, via the Agent Client Protocol) whether a
Claude dispatch's claimed work is actually supported by its artifacts — see
`docs/ideas/cross-engine-verification.md` for the rationale (dissimilar redundancy).

**Default off, explicit opt-in, every time.** `state.crossEngineCfg.enabled` defaults to `false`
(`src/state/initialState.ts`). Turning it on in Settings → the Cross-Engine Verification card shows
a disclosure the operator must read and click through (`I UNDERSTAND, ENABLE` in
`CrossEngineVerificationCard.tsx`) before the toggle takes effect — there is no one-click enable.
The disclosure text, verbatim:

> Sends the selected verification snapshot to OpenAI Codex. Uses your ChatGPT Codex allowance.
> OpenAI API billing is disabled. OpenAI API keys and custom gateways are blocked. No automatic
> fallback.

**What is sent, and how it's scoped.** A verification run is always manual — the operator clicks
"Verify with Codex" on a specific dispatch row in the Ledger's `DispatchCostTable`
(`VerifyWithCodexButton.tsx`). `electron/crossEngine/codexVerifier.ts` then resolves that one
dispatch's evidence, builds a read-only file-system snapshot (`snapshotBuilder.ts`) containing the
full committed repository tree at the commit under test (a `git archive HEAD`-style copy, not the
live working tree) overlaid with the current content of that dispatch's approved touched files, and
formats a verification prompt from that evidence (`verificationPrompt.ts`). Only that scoped
snapshot and prompt are sent — never the fleet roster, approval queue, other dispatches, or
anything outside the one dispatch under review.

**Billing boundary, enforced structurally, not by convention.** The Codex adapter is driven over
the real ACP wire protocol (`session/new` → `session/prompt` → `session/update`, see
`electron/crossEngine/acpClient.ts`) through the official `codex-acp` executable, spawned with a
child environment that strips every OpenAI API-key/billing variable
(`electron/crossEngine/acpProcess.ts`, asserted by `acpProcess.test.ts`). Before every single
verification turn — not only at initial connect — `codexVerifier.ts` calls
`authentication/status` and refuses to run unless the status is exactly `chat-gpt`
(`isAllowedAuthStatus`, `codexSubscriptionPolicy.ts`); any other status, including
`unauthenticated`, a malformed response, or a timeout, fails closed. There is no code path, UI
control, or configuration key by which an OpenAI API key or a custom gateway URL can be supplied —
`src/shared/noApiCalls.test.ts`'s "cross-engine Codex boundary" suite fails the build if one
appears.

**Nothing raw is persisted.** `src/state/persistence.ts`'s persisted-fields whitelist carries only
`crossEngineCfg` (the opt-in boolean and connection state) — never a `VerificationResultV1`
payload. Findings, summaries, the prompt, the snapshot, and the raw Codex response live only in
Electron main-process memory and in-flight IPC events (`crossEngine:update`) for the duration of
one run; none of it reaches `localStorage`, the collector's SQLite schema, or disk. There is no
long-lived adapter process to terminate — each verification run spawns and disposes its own ACP
client (`electron/crossEngine/acpProcess.ts`, `acpClient.ts`). Disabling the feature
(`crossEngine:setEnabled(false)`) prevents any new run from starting; a run already in flight when
the toggle is switched off completes normally and is cleaned up the same way every run always is.

---

## 10. Historical correction before the Stage 13.5 API teardown

The pre-teardown project memory stated:

> The key is read server-side only (electron main process); `.env` is gitignored.

**The first clause was false at that point in development.** The key is read by `vite-plugins/chatProxyPlugin.ts` in the
Vite dev server; the Electron main process never sees it, which is precisely why Chat's real replies
do not work in the desktop app at all
(`docs/superpowers/plans/2026-07-27-chat-ipc-correctness.md`). The documented belief is what let the
defect hide for as long as it did.

The correction proposed at the time was *"read server-side only
(Vite dev-server plugin today; moving to the Electron main process in Stage 0.5)"* — an accurate
description of a broken state beats an aspirational one, which is this project's stated standard
everywhere else.

---

**Current status:** Stage 13.5 subsequently deleted both key-loading and chat API paths.
The preceding correction is retained as history, not an active implementation instruction.

## 11. Codex terminal — a second interactive session, same open-ended access as Claude's

Shipped 2026-08-09 — see `docs/superpowers/plans/2026-08-09-codex-terminal-view.md`. This is not a
new instance of §9's outbound-data exception — it does not send a scoped snapshot to anything.
It is a second interactive terminal, in the same category §1 already carves out for the Claude
terminal: a real, live `codex` CLI session with the same open-ended file-system and command access
the Claude terminal already has, running under the operator's own Codex/ChatGPT credentials, exactly
like running `codex` in any other terminal window. Aether does not scope, filter, or inspect what
happens inside that session any more than it does for the Claude terminal.

**Default off, gated behind its own toggle.** `state.codexTerminalCfg.enabled` defaults to `false`
(`src/state/initialState.ts`), folded into the same Cross-Engine Verification settings card as §9's
verifier toggle (`CrossEngineVerificationCard.tsx`) rather than a separate card. There is no
disclosure click-through for this toggle — unlike §9's verifier, this feature never sends anything
anywhere on Aether's behalf, so the disclosure language that governs an automatic outbound send does
not apply here.

**Mount-triggered spawn, not an app-boot launch.** Enabling the toggle alone does not start a
session. `CodexTerminalView` checks `state.codexTerminalCfg.enabled` before rendering
`<PtyCodexTerminal />` at all; when disabled it renders an explanatory message instead and
`getOrCreateHost()` — the function that actually calls `codexPty.start()` — never runs. The real
`codex` pty is created only the first time the operator, with the toggle already on, navigates to
the Codex sidebar view — the same lazy, mount-triggered mechanism the existing Claude terminal
already uses (`PtyTerminal.tsx`), not an unconditional launch at every app start regardless of
navigation.

**Turning the toggle off hides the view and blocks future spawns, but does not kill an
already-running session.** Disabling `codexTerminalCfg.enabled` makes `CodexTerminalView` render its
disabled message again and prevents any new `codexPty:start` call, but `main.ts`'s
`codexPtyLifecycle` keeps whatever `codex` pty is already running alive until the app quits (or the
operator exits `codex` inside that session themselves) — re-enabling the toggle reattaches to it
rather than spawning a second one. This is accepted current behavior, not a bug, but it is worth
stating plainly rather than letting the toggle's label imply the session is actually stopped.

**Shares the verifier's `CODEX_HOME` isolation and env-stripping.** `electron/codexPtyManager.ts`'s
`spawnCodexPty()` calls the same `resolveCodexHome()` (`electron/crossEngine/acpProcess.ts`) §9's
verifier uses, so the terminal session and the verifier read and write the same dedicated,
isolated Codex home directory — never the operator's global `~/.codex`. Before spawning, `buildCodexPtyEnv`
strips the same billing/auth-bypass vector list `acpProcess.ts`'s verifier already enumerates for
`codex` — `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`,
`MODEL_PROVIDER`, `DEFAULT_AUTH_REQUEST`, `CODEX_CONFIG`, `CODEX_PATH` — from the environment the
shell inherits (mirroring `ptyManager.ts`'s `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/
`ANTHROPIC_BASE_URL` scrubbing for the Claude terminal), so a key exported for other tools on the
operator's machine cannot be silently picked up by the session Aether starts.

**Named limitation, not glossed over: env-stripping cannot police what the operator types.** This is
a real, live, interactive terminal. Stripping the inherited environment closes exactly one path — a
key silently carried in from the shell — and nothing more. It does not and cannot stop the operator
from typing `codex login --api-key ...` (or pasting a key into any other prompt the `codex` CLI
offers) by hand inside the live session once it is running. This is not a gap specific to this
feature; it is the same category of limitation the Claude terminal's own environment-scrubbing
already has and already documents above — an interactive shell is, by construction, a surface Aether
cannot fully police from the outside.


---

## 12. Claude headless CLI adapter — built, deliberately not reachable

Added 2026-09-06 with the provider-neutral cross-engine adapter layer
(`electron/crossEngine/providers/`). Read this before wiring it to anything.

**Nothing about the shipped app's outbound behaviour changed.** `ClaudeHeadlessCliAdapter`
can spawn `claude -p`, but no IPC handler, no store action, and no UI control constructs it.
(It is not the only `claude -p` path in the repo: the collector's opt-in memory extractor, §14,
launches it directly and independently of this adapter.)
It is reachable only from tests, which drive an injected fake child process and never spawn a
real CLI. This adapter remains unreachable from product controls. The separate Codex consultation
path in §13 does not activate it.

**Why it is nonetheless a new boundary.** §11 categorises the Codex terminal with the Claude
terminal: an interactive session the operator drives directly, keystroke by keystroke. This
adapter is not that. It would be *Aether* composing a prompt and sending snapshot-derived
content to a model, on Aether's initiative, with no human typing the turn. That difference —
not the vendor — is what makes it a distinct exception. It is also not §9's exception: that one
is scoped to a second vendor and to one operator-triggered verification run.

**Conditions on ever making it reachable.** Wiring this to IPC or UI requires its own opt-in,
modelled on §9's and not folded into it:

- Default off, with a disclosure click-through naming what is sent, to which provider, under
  which login, and with which budget.
- A separate toggle from `state.crossEngineCfg.enabled`. Enabling Codex verification must not
  silently enable Claude deliberation.
- The same store-the-signal rule as everywhere else: structured claims, citations, hashes,
  usage and stop reasons may persist; prompts, source excerpts and provider streams stay
  ephemeral.

**Read-only is enforced by a measured flag set, not by one flag.** `--restricted` alone is not
sufficient and it would be wrong to document it as such. Measured against Claude Code 2.1.263,
`--restricted` left 110 tools available, **including `Write`, `Edit`, `NotebookEdit`, `Skill`
and MCP write tools**. The guarantee comes from the whole set:

| Flag | What it contributes |
|---|---|
| `--restricted` | drops code-running tools and WebFetch, ignores user/project/local settings, confines file tools to the working directory |
| `--strict-mcp-config` | no MCP servers at all (measured: `mcp_servers: []`, tool surface 110 → 21) |
| `--disable-slash-commands` | no skills; `Skill` survives `--restricted` |
| `--allowedTools Read Grep Glob` | fail-closed allowlist, not a denylist — a denylist would admit any newly added tool |
| `--permission-prompts none` | anything that would prompt is denied automatically, rather than incidentally |

Verified adversarially, not assumed: asked to write a file *and* to spawn a subagent that
writes a file, the session refused both — *"Permission for this tool use was denied. It
requires approval, and this session has no approval surface"* — and no file appeared on disk.
`src/shared/noApiCalls.test.ts` now fails if that flag set is weakened, or if any module other
than the reviewed adapter spawns the `claude` binary.

**Why not the Claude Agent SDK.** It would work, but adds a runtime dependency and a second
authentication path. The headless CLI needs neither and runs under the operator's existing
login. (`claude mcp serve` was also probed and rejected: it exposes Claude Code's tools to an
MCP client and has no session, turn, cancellation or approval semantics.)

---

## 13. Visible Claude–Codex communication — separate opt-in boundary

Implemented on `feat/visible-communication-u1` through U8; U9 component-path verification has passed; complete connected-launch verification remains in
progress. This section describes implementation and controls, not a passed production-path or
live-provider test. Consult the U9 results for those verdicts. One qualified live consultation was observed on 2026-09-14 (a single exchange through the
connected bridge with real tools, on the interactive client's default model; recorded in the
integration review notes). That establishes one successful delivery, not a reliability rate,
and no comprehensive live verification has been run. Packaged-runtime coverage as of
2026-09-14 is limited to Codex ACP readiness and bridge-helper component loading; the
app-server supervisor path, a complete connected launch, and normal-quit cleanup are not
verified under packaged Electron. Live consultations remain gated by the explicit
per-consultation allowance.

**Controls and authority.** Settings → Agent communication → Enable Claude–Codex communication
persists only `communicationCfg.enabled`, default false. Enabling alone launches no session and
spends no allowance. Main starts disabled until preference synchronization. Choose **Start fresh
connected Claude** to prepare a fresh native Windows Claude session; replacement of an active
terminal requires confirmation. No resume flag is added. Readiness is established by this
bridge's authenticated handshake and tool listing, not merely by writing a config file or by
the saved checkbox. During cleanup the saved preference can remain enabled while the bridge
is stopped; cleanup completion is not a promise to reconnect or launch automatically.

That session preapproves exactly `mcp__aether-bridge__ask_codex`,
`mcp__aether-bridge__get_codex_exchange`, and `mcp__aether-bridge__cancel_codex_exchange` through
session-scoped launch arguments. It does not write global allow rules or disable unrelated MCP
servers. Explicit deny, managed-policy, duplicate server-name, unsupported client-version and
launch-cleanup failures are surfaced; they are not bypassed. Main rechecks its gate for asks.
The connected client forces `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=120000` after shell profiles,
overriding customized thresholds for **all MCP servers in that Claude launch**. The prior shell
setting is restored when the connected launch ends; no user/machine environment setting is changed.

**Content and provider boundary.** Claude supplies a question and optional pasted context. No
project picker, automatic file ingestion or repository snapshot is part of this feature. Aether
sends these inputs to its Codex app-server adapter using the existing subscription-only health
check, isolated configuration, `approvalPolicy: never` and a read-only turn sandbox with tool
network access disabled. Each exchange gets a private empty working directory. This avoids
inherited project context; it does **not** confine filesystem reads to that directory or prove
that command execution is impossible. Write permission is not granted. Codex output is rendered
as text and returned as attributed advisory data, not authorization to act. The advisory framing
is guidance, not an instruction-isolation security boundary.

**Spending and lifetime.** One provider job can occupy the app slot at a time, including unresolved
cleanup. Each fresh connected launch has three provider-start credits shared by all callers and
subagents. Settings **Grant 3 more consultations** requires operator confirmation and adds three
without restarting Claude. MCP cannot grant credits. Reads, cancel, duplicate recovery and helper
reconnect cannot increase the allowance. Duplicate keys/exact content recover the existing job;
changed content under a reused key fails. Rejected input spends no credit; ambiguous provider
submission is charged conservatively. Grants do not reset cooldown or deduplication tombstones.

An active job has a 90-second renewable ownership lease and an absolute five-minute deadline.
`get` waits 45 seconds by default, at most 60; streamed chunks do not wake the wait. Up to 16
waiters may share a job, but only the designated owner renews the lease. Followers, cancelled
reads and Comms viewing do not renew it; a follower is not automatically promoted. Lease expiry,
cancel, helper loss or session replacement stops active work. Rejections and unsuccessful outcomes
impose a 30-second cooldown; repeated cooldown replies do not extend it and successful completion
permits immediate follow-up. Cancelled/timed-out outcomes cannot become late success. Unresolved
cleanup blocks new work; bounded shutdown waits observe the same cleanup operation rather than
starting duplicate disposal. Quit-anyway may leave provider processes running.

**Bounds and receipt semantics.** UTF-8 limits are 16 KiB question, 32 KiB optional context and
64 KiB answer. Source pages are at most 24 KiB; encoded envelopes at most 32 KiB, so escaping
can create extra pages. The client size annotation is 40000 characters, not a token estimate.
Request-key aliases are bounded at 32 per exchange. Retention reserves capacity before accepting
work; at most 20 retained records and a 2 MiB reservation budget may be occupied. Full retention
rejects new work rather than evicting an unexpired answer. Provider completion, answer availability
and unique pages served are distinct. Page replay cannot increase unique delivery counts, and
pages served do not prove Claude read, understood or acted on them.

**Retention and copies.** Aether retains exchange content in main memory and mounted Comms component
state. The cross-check composer additionally holds its question/context draft in a transient
App-level provider across navigation; discard or app exit clears that draft. Its reducer receives
validated metadata, not question/context/answer, keys or capabilities;
runtime metadata, selection and content are excluded from persistence. Completed content remains
available for ten minutes from completion despite lease/client loss. Clear, disable or app exit
can erase Aether's copy earlier. There is currently no visible Clear control; clear is a main/preload operation. Main retains launch tombstones to prevent duplicate spending;
payload expiry does not restore credits. Same-launch recovery uses the displayed exchange ID and
retrieval instruction. A replacement launch cannot retrieve its predecessor's answer through MCP;
the operator can explicitly copy a still-retained answer from Comms.

The short-lived launch capability travels in restrictive operational files/environment; only the
quoted config path is typed into the shell. It is never typed as inline secret JSON. Launch files
are cleaned on disable, replacement and exit, with stale-file cleanup on next startup. Their
existence is a disclosed exception to memory-only *content* handling, not a provider transcript.
**Claude Code's local session transcript, possible client tool-output files, and Codex-managed
history may retain content after Aether clears its memory.** Paging does not suppress normal
transcripts. Aether does not delete or alter those histories and does not claim provider
nonpersistence or an effective ephemeral-session flag. Explicit clipboard copies also leave
Aether's retention boundary. Nothing is forwarded to another model merely to display or summarize it.

**Cross-check display identity and client status (Tasks 2–5).** The runtime communication
snapshot includes an independently generated instance label, a numbered session label,
an allowlisted prompt observation (`unknown` or `folder-trust`), client lifecycle evidence
(`unknown`, `starting`, `running`, `exited`, or `failed`), and whether launch authority is
current. These display fields never authorize bridge operations. No pipe endpoint, capability,
raw terminal text, PID, or userData path crosses this status boundary. The existing runtime
snapshot persistence exclusion applies to all of these fields.

The main-process prompt detector retains only a bounded transient screen for the owning PTY
and launch; unsupported output and dimensions yield unknown. Positive client exit comes from
the launch receipt or an observed launched PID that no longer exists, never helper disconnect,
PTY shell liveness, silence, or prompt disappearance. Launch cleanup samples evidence before
removing its credential files; main may retain the observed PID in memory to check client exit
after helper loss. Status reads are bounded; unreadable status stays unknown. If cleanup occurs
before any PID/exit receipt can be observed, later exit cannot be confirmed.

Revocation immediately clears prompt evidence and authority. The session label and independently
observed lifecycle can remain as display history until replacement or disable, which discard
them; old asynchronous observations cannot update a replacement. Bridge tool listing does not
establish client input readiness. Focus connected terminal checks the displayed identity against
a fresh snapshot, navigates within the current Aether window, and focuses the existing terminal
without starting a session, accepting trust, pasting, or submitting a command.

**Cross-check composer and optional skill (Tasks 6–8).** The terminal and Comms actions share
the same transient draft. Opening, copying, and focusing send no model request, collect no files
or terminal history, and do not enable communication or start a connected session. Copy writes
the question, optional context, and a content-derived stable request key to the system clipboard;
that explicit copy leaves Aether's retention boundary. Changing content changes the key; restoring
identical content restores it. The displayed instance/session identifies the operator's target,
and a changed launch requires review before another copy or focus. It is not a routing credential:
the operator still chooses where to paste and submit the copied text.

The versioned `skills/aether-cross-check/SKILL.md` is installed separately at user scope. Installation
is a local file operation, not proof that a particular connected Claude client discovered or invoked
it. The skill requests only the three bridge tools using supplied context and stops with **Aether
bridge unavailable** when those tools are absent. It forbids alternate CLI, server, or delegated
routes and summaries of unretrieved pages. Normal skill invocation and unrelated action permissions
remain in effect. Source/installation checks, deterministic helper tests, and real-client discovery
or provider invocation are separate evidence; the first two do not establish the latter.

To use it, explicitly enable communication in Settings and start a connected Claude session,
reviewing any terminal prompt yourself. Open **Cross-check with Codex**, enter the question and
optional context, review its instance/session label, then choose **Copy request** and **Focus
connected terminal**. Review the terminal before manually pasting/submitting. Submission can spend
an existing consultation credit. Comms shows the real exchange and pages served; opening the answer
does not retrieve pages for Claude. If retrieval stops early, any summary must identify it as partial.

---

## 14. Memory extraction via the Claude CLI — opt-in background boundary

Added with issue #104 (2026-10-01). The collector (`collector/src/memoryExtract.ts`) turns
completed subagent dispatches into private memory atoms by running `claude -p --model haiku`.
That path shipped with Stage 13 and was missed by the Stage 13.5 teardown and its guard (the
guard only matched a literal `spawn('claude'`, not the promisified `execFileAsync('claude'`
the extractor uses). It is now an explicit boundary.

**Default off, and enabling requires a confirmation.** The Settings card `MEMORY EXTRACTION`
shows OFF until the operator clicks through a disclosure (`I UNDERSTAND, ENABLE`). The choice is
written to `~/.aether-os/collector-settings.json` by Electron main; that file, not the UI, is the
source of truth, because the collector is a separate process that runs without the app. The
collector re-reads the file on every scan and every drain tick (about 15 s), so toggling needs no
restart. With the setting off nothing is staged and nothing is sent: the transcript scan gets no
extraction queue, and a drain tick also discards anything already queued rather than sending it.
`CostGuardCard` lists the row as a network surface.

**What is sent, and to whom.** To Anthropic, or whichever provider Claude Code is configured
for (see below), from the collector, per qualifying dispatch: the agent id, the dispatch result text (`extractDispatchResultText` of the task-notification) plus up to 20
memories previously extracted for that agent. Aether-initiated with no human typing the turn,
which is what makes it a distinct boundary, like §12. It is usually sent within about 30 seconds
of the dispatch completing.

**What else `claude -p` brings along.** The call is a real Claude Code invocation: it also loads
the user's CLAUDE.md and auto-memory context and runs the user's configured hooks on every call.
None of that is controlled by Aether.

**Which login, and can it bill.** Only `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
`ANTHROPIC_BASE_URL` are removed from the call's environment. Otherwise it uses whatever Claude
Code is set up to use: the subscription login, an `apiKeyHelper`, an `env` key in Claude Code
settings, or Bedrock/Vertex. So it CAN bill API usage; "your Claude account" is the common case,
not a guarantee. Isolating the call from that ambient configuration is tracked in #111.

**What is stored.** Model-written memory atoms in `~/.aether-os/memory.db`. They derive from
transcript content, which strains the Stage 14 "never in `~/.aether-os/`" amendment in §4; this
section names that tension and does not resolve it.

**Backfill.** Scan offsets persist in `collector.db` (`transcript_files.last_offset`) and only
advance when a scan runs. Dispatches the collector scans while the setting is off are not
extracted later unless `collector.db` is deleted. Qualifying dispatches it has not yet scanned
are sent the next time it scans with the setting ON. That covers dispatches that started and
completed while the collector was not running, and every past dispatch when `collector.db` is fresh or deleted (the rescan starts at offset 0).

**Deployment caveat.** The gate takes effect only once the collector `dist` is rebuilt or
reinstalled. The installed collector runs from its built output, and a pre-#104 collector
extracts unconditionally.

**Guard.** `src/shared/noApiCalls.test.ts` fails on any literal `claude` process launch
(`spawn`, `exec*`, `fork`, including promisified and aliased forms) outside an exact-path
allow-list: the §12 adapter, `collector/src/fleetPoll.ts` (`claude agents --json` session
listing; no prompt, no model; argv pinned), and `memoryExtract.ts`. A launch whose command is a
variable is out of reach of a literal-string guard.

## 15. Boards and the aether-data MCP server — operator-driven read boundary

Added with the Boards feature (2026-10-12; spec `docs/superpowers/specs/2026-10-11-dashboards-design.md`).
Boards are saved SQL queries over `collector.db` rendered as charts, plus a local MCP server
(`aether-data`) that lets an operator-run Claude session read the same data and author boards.

**Boundary: an operator-driven terminal.** The `aether-data` server is registered only when the
operator runs the register command themselves. Aether copies the command to the clipboard from
main (the paths never cross IPC); the operator pastes and runs it. Aether never launches `claude`.
Once registered, the Claude session it serves can read `collector.db` and send query results to the
model as part of that conversation. Opt out with `claude mcp remove aether-data --scope user`.

**What is reachable.** The signal columns: token counts, tool names, durations, anomaly kinds.
The path-bearing columns `file_path_rel`, `project_rel_path`, `file_path`, `source_file_rel` and
`detail` (anomaly text names files) are blocked, along with the `transcript_files` table. Those
paths came from tool calls already sent in their original sessions; the block stops them being
re-sent in bulk.

**Enforcement is two layers.**
- A SQLite authorizer inside the query child process allows only SELECT, RECURSIVE, FUNCTION
  (except `load_extension`), READ (except the blocked columns, any column whose name contains
  "path", `transcript_files`, `sqlite_*` other than `sqlite_master`, and `pragma_*` other than
  `pragma_table_info`) and PRAGMA only for `table_info`. Every other action is denied.
- The text query guard (`src/shared/dashboards/queryGuard.ts`) refuses `SELECT *` (except
  `COUNT(*)`), NATURAL and USING joins, `pragma_*` other than `pragma_table_info`, the blocked
  names, and writes, ATTACH and PRAGMA. Star is refused so a column a later collector migration
  adds is never returned unnamed.

Each query runs in a killable child process (Electron as Node), at most 3 at a time (the cap is per
process: the app and each MCP server count separately), with output capped at 32 MB. Errors that
reach the model or the renderer are path-free.

**Caveat.** A slow Boards query holds a read lock that can make a collector write wait or fail.
The collector's spool ingest retries, so no data is lost.

**Busy timeouts.** Boards query children wait up to 5 s for a lock. The main-thread read-only
collector readers now use a 500 ms busy timeout (previously none); the retention purge keeps 5 s.

**What is stored.** Board definitions (title, SQL, chart layout) in `~/.aether-os/dashboards/*.json`.
No query results are persisted. Refresh runs locally and makes no model call.

**Writes.** None to `collector.db`: the connection is read-only and every query passes both layers.

**Not verified by unit tests.** Chart visuals, and the MCP server running inside a packaged
`app.asar` (a dev-build smoke test via Electron-as-node passed).

---

## 16. Remote read-only chat view over Tailscale — the one opt-in listener

Added with the mobile remote-access feature (2026-10-21; plan `~/.claude/handoffs/aether-os/2026-10-21-mobile-remote-access-plan.md`, outside the repo). It lets a paired phone on the owner's own tailnet read the chat of the pinned Claude session (read-only; typing and approvals are §17). It is the single deliberate exception to "no externally-reachable listener" (§1, §2), together with phone control, §17 (built in V1 for pairing and the connection handshake; terminals and approvals planned), which shares this listener. Code: `electron/remote/`.

**What is exposed.** Human prompts, Claude replies, agent-to-agent messages (dispatches, SendMessage posts, hand-backs, shown as traffic cards) and the **names** of the tools Claude called, for the one pinned Claude session. Never tool inputs, tool results, thinking blocks or file contents. No Codex session, no Terminal 2, no session picker and no subagent transcripts in v1.

**Masking.** Every message body goes through `maskSecrets` and then the 4000-character cap, in `chatParser.ts`, before it is buffered and before it reaches the wire: no chat event, event buffer or wire message holds an unmasked body. The one transient exception is the raw read: `chatFeed.ts` holds transcript bytes in memory (at most 4 MB of an unfinished line pending) until the parser has masked them, and does not keep them. The masker is pattern-based and conservative ("obvious secrets", not a DLP), with the known limits listed at the top of `src/shared/board/text.ts` (doubly-stringified keys, a quoted value spanning a real newline, backtick-quoted values masked to the first word, secrets in shapes it has no rule for). Labels and titles (session title, traffic `from`/`to`/`subject`) are also path-shortened and capped at 60 characters. **Message bodies are masked and capped but not path-shortened**, so a path the agent wrote in a reply is visible to the phone.

**Boundary.**
- Tailnet only. The server binds to the Tailscale interface's IPv4 address (`100.64.0.0/10`, found by interface name containing "tailscale"), port 47821, via `findTailnetAddress()`; no host is configurable. `assertBindableHost` refuses anything else (it also accepts 127.0.0.0/8, for tests). If no tailnet address exists, enabling reports "unavailable" and nothing listens. It never falls back to `0.0.0.0`, `::` or a LAN address. The address is chosen at enable time and is not re-bound if it changes; toggle off and on.
- **The viewer routes open only when the viewer is enabled.** `/pair`, `/assets/*`, the chat page and `/ws` stay closed unless the read-only viewer itself is enabled; enabling phone control (§17) does not open them (fail-closed).
- **Off at every launch.** Whether it is enabled is never persisted. Enabling needs a native confirm dialog in the main process and a request from the trusted app window.
- HTTP, not TLS, inside the WireGuard-encrypted tailnet. The session cookie is therefore not `Secure`; it is `HttpOnly; SameSite=Strict; Path=/` with a 30-day `Max-Age`.
- Every request (404s and the WebSocket upgrade included) is checked against the bound address as `Host`; the pairing POST and the upgrade also require a matching `Origin`. Only `GET /pair`, `GET /assets/pair.js`, `GET /assets/app.css` and `POST /api/pair` are public; the chat page, `viewer.js` and `/ws` need a valid cookie. At most 3 live viewer connections (control sockets are counted separately, at most 2, §17), a 1 KiB pairing body, 10 s request and header timeouts. Responses are `no-store` with a restrictive CSP.
- The `ws` server is `noServer: true` and the protocol has no phone-to-server message: any inbound frame (1 KiB max) closes the socket. A client is also dropped for pinging faster than 20 per second (queued auto-pongs cannot grow server memory) and when its unsent backlog passes 1 MiB (slow-consumer close).

**Auth model.**
- A pairing code is 8 characters shown as `XXXX-XXXX`, held in memory only. It lives 60 minutes, works once, and is burned after 5 wrong attempts. It travels in the QR/URL fragment (`#c=`), which the browser does not send to the server, and is posted in a request body. A new code replaces the old one, and disabling clears it.
- Redeeming issues a random 32-byte session token as a cookie; the server keeps only its SHA-256 hash. A session lasts 30 days absolute from pairing (not sliding), and at most 5 phones are kept: pairing a sixth drops the oldest. Revocation is re-checked on every open socket, so a revoked phone is disconnected right away on a desktop revoke.
- Disabling the listener does **not** revoke paired phones; they work again after the next enable without re-pairing. Settings → Purge does **not** delete the sessions file (it is auth configuration, not collected data); REVOKE ALL PHONES is the control.

**Exactly what is stored on disk.** One file, `~/.aether-os/remote-sessions.json`, shaped `{"v":1,"sessions":[{"hash","createdAtMs","expiresAtMs","lastSeenMs"}]}` and nothing else: `hash` is the SHA-256 of the cookie token. No token, no pairing code, no message text, no replay content, no user-agent, no IP address. Every read and write passes each entry through a field-by-field validator (64-hex hash, integer stamps) and caps the list at 20 entries, and a read ignores a file over 64 KB, so extra properties cannot reach disk. `lastSeenMs` is saved at most every 5 minutes from activity alone, but any pair or revoke save also writes the current value. The file lives in the user-only `~/.aether-os/` (§7) and is written atomically. A revoke removes that entry. An expired entry is dropped in memory when the file is loaded or its cookie is presented, and the file is rewritten at the next save. REVOKE ALL PHONES keeps the file with an empty list.

If a revoke cannot be saved, it still takes effect in memory at once, the status carries the fixed notice "Revoke not saved to disk yet", and the save is retried (up to 3 times, 5 s apart, and again before the next enable). At quit the app holds the quit open while the listener stops and the store flushes; if that times out, or a revoke is still unsaved, it writes a fixed `[diag]` line to `diag.log` (no content). A failed save is logged with a fixed string and never breaks authentication.

**What is held only in memory.** A replay buffer of at most 64 KB (UTF-8 bytes of the JSON form) of already-masked chat events, so a phone that joins mid-session sees recent history. When access is enabled it is seeded from the last 512 KB of the pinned transcript (a file Claude Code wrote, not Aether) and then follows new lines. It is cleared on disable, quit, session switch and transcript truncation, and is never written anywhere. Pairing codes and the live client list are memory-only too.

**Render, not store, on the phone.** The page builds its DOM with `textContent` only, keeps at most 200 bubbles, uses no storage APIs and no service worker, and is served `no-store`. The chat page has no input element, so nothing is typed, resized or sent to the terminal; the separate pairing page has one input, for the pairing code only.

**Read-only, no model calls.** `electron/remote/` imports no pty code, never calls `kill` or writes to a pty, and its only disk write is the sessions file. It makes no model or API call. `electron/remote/noWildcardListener.test.ts` guards this mechanically: no wildcard bind literal in `electron/` or `scripts/`, the one `listen(` call with an explicit host after `assertBindableHost`, no pty or value `electron` imports, `fs` confined to the transcript reader and the sessions store, and chat events built only in `chatParser.ts`.

**Visibility.** A top-bar chip reads `PHONE CONNECTED` (or `PHONE - N connected`) while at least one phone is connected and opens Settings. The Settings card `REMOTE ACCESS (READ-ONLY)` has the ENABLE/DISABLE button, PAIR A PHONE (QR, code and a countdown, cleared on Done or expiry), and a PAIRED PHONES list (short reference and three timestamps only) with per-phone REVOKE and REVOKE ALL PHONES. A "Revoke not saved to disk yet" warning shows there when a revoke could not be saved. Outside the desktop app (no bridge) the card says "Available in the desktop app".

**Limits, stated plainly.**
- It works only while the machine is awake with Aether open; closing the main window quits the app and ends the phone view.
- Any tailnet device that the tailnet ACLs let reach this machine's port 47821 can reach the pairing page; the pairing code or a paired cookie is what stops it. Anyone holding a valid code or cookie can read the chat. The ACLs belong to the owner.
- A lost or stolen paired phone keeps read access until its 30-day expiry or a revoke from the desktop; there is no remote kill switch.
- Masking is best effort (above). A secret in an unknown shape, or a path the agent wrote in a body, crosses the wire.
- Treat it as R3-class: the chat can contain anything said in the session.

**Not verified by unit tests.** Phone layout and legibility, the top-bar chip at narrow widths, Windows Firewall behaviour on first enable, how Chrome and Samsung Internet treat an `http://100.x` address, and a packaged-build run.

---

## 17. Phone control over Tailscale — the one opt-in input path

**Status: V1 built (pairing, device auth, `/ctl` hello/welcome with server proof, Settings block, chip, persisted re-enable). V2 desktop side built: the slot list and live, read-only terminal output over `/ctl` (the phone-side client and page are in the repo, but the Android Activity UI is not yet built, so the phone cannot show terminals yet). V3-Type desktop side built: typing into the three running slots over `/ctl` (verbs `in` and `ack`; per-device ordered, deduplicated and rate limited; no replay after a drop; only into a slot this socket has attached; only into a running slot). The Android app sends input from V3-Type. Approvals, starting a slot, reconnect and fit-to-phone are not built (planned, V3+).** This section is the binding description the build is held to (docs land before capability code). Each slice that changes behaviour updates it in the same change. Plan: `~/.claude/handoffs/aether-os/2026-10-22-aether-mobile-design.md` (outside the repo).

Added with Aether Mobile. A paired Android app on the owner's tailnet (at most 2 live control sockets at once) can see and type into the three terminal slots (Terminal, Terminal 2, Codex) and answer Claude permission prompts. **This is equivalent to the owner's keyboard on this machine: a connected, unlocked phone can run arbitrary commands as the owner.** It is separate from §16: its own toggle, pairing scope, token store and code directory (`electron/control/`). `electron/remote/` stays read-only, and the viewer keeps its off-at-every-launch rule (§16). The Android client lives in `android/` in this repository.

**Exposed.** As of V3-Type three things flow between an authenticated, attached phone and the desktop: the raw output of the three terminal slots (in the first item below), `welcome.sessions` (each slot's id, label, state, size and sequence number), and input bytes the phone types into a running slot it has attached (`in` frames, acknowledged by `ack`). Input is limited to 8 KB per frame, 256 KB per second and 100 frames per second per socket; over a limit the socket is closed with `bye rate-limit`. Frames carry a per-slot counter: a repeat is acknowledged without being written, a gap closes the socket, and a counter resumes after a reconnect only for the same app run (epoch). An `in` for a slot that is not running is acknowledged and dropped, and one for a slot the socket has not attached closes the socket. Starting a slot, permission prompts and the fit-to-phone resize are not built; the remaining items below are the planned scope, not current behaviour.
- Raw output of the three terminal slots, unmasked (the terminal is the content, as on the desktop).
- Input bytes into running slots, and starting a not-started fixed slot (Terminal, Terminal 2, and Codex only if the Codex terminal is enabled, `codexTerminalCfg.enabled`). Never replacing a running one.
- Claude permission prompts raised through the permission hook. The hook is global, so a prompt can come from any Claude session on this machine that carries it, not only the three slots, which is why the originating session is shown: tool name, risk, the originating session (the hook's `session_id`, passed through so the phone can label the prompt) and a masked 1200-character summary of the command or path, with Allow and Deny buttons. Approval stays one tap even for HIGH-risk tools (rm, sudo, curl-pipe-sh).
- Codex has no brokered prompts: its approvals are answered inside the Codex terminal, with a quick-key row on the phone (y, n, Enter, Esc, arrows).
- Terminal size: the phone mirrors the PC's PTY size by default. A "fit to phone" button resizes the PTYs while the phone is attached (the desktop terminal follows) and the desktop layout is restored on detach.

**Never exposed.** Killing or replacing a session, editing an approval, the auto-allow level, any setting, the communication bridge, files, transcripts, boards, the clipboard, arbitrary new sessions or commands, or any model call. The message set is a closed allow-list (`MESSAGE_TYPES.phoneToTitan`); a new verb fails the guard until the list, a test and this section change together.

**Boundary.**
- Shares §16's tailnet-only listener and port (47821): one `listen()`, never a wildcard or LAN address. `/ctl` accepts only a bearer token, never a cookie and never an `Origin`; a viewer cookie can never open `/ctl` and a control token can never open the viewer socket.
- **Off by default, with one opt-in persistence.** A fresh install starts with phone control off, and so does every launch unless the owner has turned on a separate setting. The owner may turn on "re-enable phone control at launch", so that a restart (an update, a crash, a reboot) while away from the desk does not strand the phone. That setting is default off, needs its own native confirm in the main process and a request from the trusted app window, and is stored as a single boolean and nothing else about the feature's state. The persisted flag is cleared when phone control is disabled from Settings, so after a manual disable the owner must opt in again, with the native confirm. That clearing is the fail-closed choice; it was observed working on the S25 build on 2026-10-23 (flag false after a disable, true across a real quit), but the owner has not explicitly confirmed the policy. The setting applies to phone control only. If the tailnet address is missing at launch, nothing listens. Pairing a new app always needs the desktop (below).
- While only phone control is enabled, `/pair`, `/assets/*`, the chat page, `POST /api/pair` and `/ws` all return 404; enabling control never opens them (§16).
- `POST /api/device/pair` is unauthenticated and answers whenever control is on (404 when it is off); it can succeed only while a pairing code is active (otherwise 401; 429 once the code is burned or the caller's address is locked out; 409 while another pairing confirm is already open); it also answers 401, before any wrong-code counting, when control is on but the caller's address is not an IPv4 address (a leading `::ffff:` is stripped first; anything else is refused), and 403 for any `Origin` header, when the owner declines or times out the native confirm, or when control is disabled or quit while the confirm is open; the response contains the token exactly once; the token is never logged.
- At most 2 live control sockets, counted separately from the 3 viewer connections (§16); at most 1 paired app (`CONTROL_MAX_DEVICES = 1`): pairing a new phone REPLACES the existing one, only after a native confirm that says so.
- HTTP and WebSocket, not TLS, inside the WireGuard-encrypted tailnet. The Android app connects to titan's tailnet IP, fixed at build time, with cleartext permitted to that one address only. No MagicDNS name, no `tailscale cert` (which would publish the tailnet hostname in public certificate-transparency logs). If the tailnet IP ever changes the app must be rebuilt.
- **Tailscale ACL (the owner's responsibility; Aether cannot enforce it).** Restrict `titan:47821` to the phone's node only, for example (placeholders, node names to be filled in at setup): `{"acls":[{"action":"accept","src":["<phone-node>"],"dst":["<titan-node>:47821"]}]}`. Without it any node the tailnet allows can reach the pairing endpoint; the token and the redeem-time confirm are what stop it.

**Auth.** Pairing code: 8 characters, memory-only, 5-minute TTL, single use, locked out per source address after 5 wrong attempts from that address, and burned for everyone after 15 wrong attempts in total (creating a new code lifts every lockout; the viewer-scope code keeps the global 5), issued only from a desktop click, plus a native confirm on the desktop at redeem time ("Allow this app to control your terminals?"), so a photographed QR is not enough. Token: 256-bit; only its SHA-256 hash is stored; sliding 30-day expiry, absolute 180 days; bound to the phone's tailnet source address; verified on the S25 on 2026-10-23: titan sees the phone's own tailnet IP (100.x) as the connection's source address, stored as `peer` and enforced on every device-token authentication. The phone holds the token encrypted under a hardware-backed key that requires a fingerprint to decrypt it on every cold open and after 60 seconds in the background; inside that window the app keeps the decrypted token in memory only and may reconnect silently once if Android drops its socket; "Lock now" and a revoked or expired token discard it at once. Revoke from the desktop (REVOKE and REVOKE ALL) takes effect at once and closes the socket; disabling control closes all control sockets but does not revoke.

**On disk.** `~/.aether-os/remote-devices.json`: `{"v":1,"sessions":[{"hash","createdAtMs","expiresAtMs","lastSeenMs","peer"}]}` and nothing else (same field-by-field validator, size cap and atomic write as §16; `peer` is the phone's tailnet address). Plus `~/.aether-os/control-settings.json` = `{"v":1,"reenableAtLaunch":boolean}` and nothing else (the single persisted boolean above; cleared by a user disable from Settings, not by quit). No keystrokes, output, prompts, tokens, pairing codes or summaries are ever written, by the app or in `diag.log`.

**In memory only.** Per terminal: a headless screen mirror (at most 2000 lines) and a 256 KB output ring. Both exist only while phone control is enabled (nothing is mirrored or ringed with control off, so enabling it mid-session shows a blank terminal until the next redraw). They are cleared when control is disabled and at quit (the hub drops its read hold on both paths), and a slot's mirror and ring are cleared when that slot exits and recreated when it starts again. A slot's final screen is therefore not retained after it exits: a phone that attaches afterwards gets an empty terminal and the state `exited`. Revoking a phone closes its socket but does not itself clear them; only disabling control (or quit) does. If the hub cannot take its read hold it logs `control: terminals unavailable` and control stays on with no mirror, so a phone gets empty snapshots. The 256 KB budget for the ring and for a snapshot is measured on the JSON-escaped length, not the raw bytes. Pending-prompt summaries until answered or expired, are planned and not built. Per-device input counters (the last applied `c` for each of the three slots, for one device) are held in memory only and are replaced when the app reconnects with a new epoch.

**Visibility.** A warning-coloured top-bar chip (`PHONE CONTROL - connected`) while an app is connected, and a separate warning-coloured block in the Settings remote-access card (toggle with its native confirm text, PAIR AN APP with QR, code and a 5-minute countdown, PAIRED APPS list with REVOKE and REVOKE ALL). `diag.log` gets metadata-only fixed-string lines, none with content: `control: enabled`, `control: disabled`, `control: listener unavailable reason=<reason>`, `control: paired`, `control: revoke after-approval-race`, `control: revoke all`, `control: revoke one ref=<ref>`, `control: connect ref=<ref> peer=<tailnet address or unknown>`, `control: disconnect ref=<ref>`, `control: hello accepted ref=<ref>`, `control: first input slot=<id> bytes=<n>` (the first input a connection applies), `control: input dropped slot=<id>` (typing into a slot that is not running; once per connection) and `control: input rate limit` (the socket is then closed), each with `ref=<ref>`, `control: attach slot=<id> mode=<snap|resume>` (written when the first frame of that attach is sent) and `control: detach slot=<id>` (only when an attachment existed; a socket closing detaches silently), both with `ref=<ref>`, `control: terminals unavailable`, the channel-violation lines (`control: hello deadline expired`, `control: oversize frame`, `control: invalid frame`, `control: repeated hello`, `control: unhandled frame type`, `control: attach before hello`, `control: detach before hello`, `control: no terminal port`, `control: input gap`, `control: invalid input`, `control: input before hello`, `control: no input port`, `control: input to unattached slot`, `control: input failed`, each with `ref=<ref>`), `control: device store save failed`, `control: settings write failed code=<code>`, and from the listener `remote: control client connected n=<count>` / `remote: control client disconnected n=<count>` plus the 401 reject reasons `remote: control reject reason=<reason>` and `remote: control recheck reject reason=<reason>` (reason is one of no-device, no-bearer, unknown, expired, peer-mismatch, error). `<ref>` is the first 12 hex characters of the token's SHA-256 hash, never the token. Quit adds `[diag] control stop failed at quit` and `[diag] control device store not saved at quit`. The app does not log prompt decisions. No typed bytes are ever logged: input lines carry the slot and a byte count only.

**Limits, stated plainly.**
- The unlock window on a lost phone is real. Kill switches: revoke from the desktop, or disable the device in Tailscale.
- Works only while the machine is awake with Aether open; with re-enable at launch it also recovers after a restart, but nothing wakes the PC.
- Terminal output is not masked, so a secret that appears on the terminal appears on the phone.
- Treat it as R3: a connected, unlocked phone is the owner's keyboard.
- A revoke takes effect in memory at once and closes the app's sockets, but it must also be written to remote-devices.json. If that write fails (disk full, a file lock), Settings shows "Revoke not saved to disk yet" and Aether retries (3 times, 5 s apart, again before the next enable, and once at quit). If every attempt fails and Aether then restarts, the revoked app is paired again because the file still lists it, and with "re-enable phone control at launch" on it can reconnect without a new pairing; its token still sits behind the phone's fingerprint-gated key and must come from its recorded tailnet address. When the notice shows, keep Aether open until it clears, or disable the device in Tailscale. Not fixed in V1: every remedy writes to the directory whose write just failed, and a durable revoke list would be a second storage layer.

**Guarded by.** `electron/control/controlBoundary.test.ts` (imports, input sink, message allow-list, escape hatches, file set for `electron/control/`), alongside `electron/remote/noWildcardListener.test.ts` (which also keeps `electron/remote/` free of any pty or write path and every wildcard bind out of `electron/` and `scripts/`).
