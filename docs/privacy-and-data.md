# Aether OS — Privacy & Data Model

**Status:** binding design constraint, not aspiration. Every stage in `docs/roadmap.md` is
subordinate to this document.

---

## 1. The stance

**Aether OS is single-user and local-first. The explicit outbound exceptions are Codex verification (§9), opted-in Claude–Codex communication (§13), operator-driven terminals (§11), and the opt-in, default-off background memory extraction through the Claude CLI (§14).**

That is a stronger claim than TokenMonitor's, and deliberately so — the two products have different
audiences. TokenMonitor is a fleet tool: it writes per-seat daily reports to a shared network folder
by design, and its README carefully scopes what those reports may contain (usage metrics only,
never prompt content or code). Aether OS has no fleet, no sharing, no reporting, and no
externally-reachable listener — `electron/permissionServer.ts` does run a local HTTP server for
`PermissionRequest`/`PostToolUse`/`Notification` hook brokering, but it is bound to `127.0.0.1`
only, reachable only from this machine, with no port exposed externally and no token or auth
surface to leak (see §3). The single-user constraint is not a smaller version of TokenMonitor's
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

---

## 2. What the single-user constraint deletes

Bank these as removed from scope, permanently:

- No multi-user account or organization authorization model; §13 uses a short-lived local launch capability
- No multi-tenant schema, no user/seat/org columns
- No shared folder, no report writing, no roll-up, no leaderboard
- No sharing links, no export-to-cloud, no sync
- **No externally-reachable listener.** Collector ingest is a file spool, not a listener at all
  (§3); the one real local HTTP server in this app (`electron/permissionServer.ts`, for permission
  and notification hook brokering) is bound to `127.0.0.1` only, with no port exposed externally
  and no token or auth surface

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
- The SQLite store is **not** encrypted, and the README should say so plainly rather than implying
  otherwise. Given §4, its contents are paths, names, timestamps and integers — the honest position
  is "here is exactly what is in it," not a security claim the implementation does not back.
- `.env` stays gitignored. Stage 13.5 removed key loading and the `chat:hasKey`/chat API
  handlers; there is no Aether API-key input path. Subscription adapter credentials remain
  subject to their explicit provider boundaries below.
- Spool files are deleted after consumption, not left to accumulate as a second copy of the data.
- `~/.aether-os/diag.log` (plus one rotated `diag.log.1`, about 2 MB total at most) records `[diag]` lifecycle lines for crash and white-screen diagnosis: timestamps, event names, reasons and exit codes only. It holds no content, prompts or commands. `did-fail-load` includes the URL, which in practice is the app's own page (the dev server or the bundled `index.html`): the renderer has no external links, iframes or navigation, though there is no will-navigate guard. After an unlock or resume the app also writes one renderer probe line: counts (DOM root children, canvases, lost WebGL contexts), one computed body colour, the window size, and how many of five sampled pixels are white; no screenshot or DOM content is stored. Renderer console errors are forwarded as error text truncated to 300 chars plus a source file basename and line, capped at 20 lines per minute; that error text is the one field that could carry content, which is why it is capped and rate-limited. Settings → Purge deletes `diag.log` and `diag.log.1` along with the collected data, and reports a failure if either cannot be removed; logging resumes with a fresh file afterwards.

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
