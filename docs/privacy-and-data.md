# Aether OS — Privacy & Data Model

**Status:** binding design constraint, not aspiration. Every stage in `docs/roadmap.md` is
subordinate to this document.

---

## 1. The stance

**Aether OS is single-user and local-first. The explicit outbound exceptions are Codex verification (§9), opted-in Claude–Codex communication (§13), and operator-driven terminals (§11).**

That is a stronger claim than TokenMonitor's, and deliberately so — the two products have different
audiences. TokenMonitor is a fleet tool: it writes per-seat daily reports to a shared network folder
by design, and its README carefully scopes what those reports may contain (usage metrics only,
never prompt content or code). Aether OS has no fleet, no sharing, no reporting, and no
externally-reachable listener — `electron/permissionServer.ts` does run a local HTTP server for
`PermissionRequest`/`PostToolUse`/`Notification` hook brokering, but it is bound to `127.0.0.1`
only, reachable only from this machine, with no port exposed externally and no token or auth
surface to leak (see §3). The single-user constraint is not a smaller version of TokenMonitor's
model; it removes the model entirely.

**Aether does not call billed model APIs.** Stage 13.5 removed the Anthropic SDK,
chat API proxy, and `.env` key loading. The legacy deterministic Comms responder stays local.
Two independently default-off features can send content to OpenAI under the operator's Codex
subscription: manual verification (§9) and Claude-requested consultations (§13). Neither toggle
enables the other. The communication view displays real exchanges without asking another model
to summarize them.

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
own transcripts on their own machine, and nothing leaves it — the original rule was written to
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

- `~/.aether-os/` (store, spool, statusline payload) is created with user-only permissions. On
  Windows this means an explicit ACL rather than relying on inherited defaults — this project
  already carries hard-won ACL knowledge from the AppContainer GPU issue; apply the same care here.
- The SQLite store is **not** encrypted, and the README should say so plainly rather than implying
  otherwise. Given §4, its contents are paths, names, timestamps and integers — the honest position
  is "here is exactly what is in it," not a security claim the implementation does not back.
- `.env` stays gitignored. Stage 13.5 removed key loading and the `chat:hasKey`/chat API
  handlers; there is no Aether API-key input path. Subscription adapter credentials remain
  subject to their explicit provider boundaries below.
- Spool files are deleted after consumption, not left to accumulate as a second copy of the data.

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
live-provider test. Consult the U9 results for those verdicts. No live cross-provider smoke has
been run for this feature; it requires a separate explicit one-consultation allowance.

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

**Retention and copies.** Aether retains content only in main memory and mounted Comms component
state. Its reducer receives validated metadata, not question/context/answer, keys or capabilities;
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

**Cross-check display identity and prompt status (Task 2).** The runtime communication
snapshot includes an independently generated instance label, a numbered current bridge-launch
label, and an allowlisted prompt observation (`unknown` or `folder-trust`). These display
labels are not credentials and are never accepted as authorization. The status contains no
pipe endpoint, capability, raw terminal text, or userData path. The existing runtime-snapshot
persistence exclusion applies to these fields too. Replacement and revocation clear the launch
label and prompt observation; an old launch cannot update its successor's status. Bridge tool
listing does not establish terminal input readiness. No detector is wired in Task 2, so normal
runtime prompt status remains unknown. Bridge revocation is not evidence of a client exit.