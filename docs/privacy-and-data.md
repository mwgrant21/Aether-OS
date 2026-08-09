# Aether OS — Privacy & Data Model

**Status:** binding design constraint, not aspiration. Every stage in `docs/roadmap.md` is
subordinate to this document.

---

## 1. The stance

**Aether OS is single-user, local-only. Nothing about your work leaves this machine.**

That is a stronger claim than TokenMonitor's, and deliberately so — the two products have different
audiences. TokenMonitor is a fleet tool: it writes per-seat daily reports to a shared network folder
by design, and its README carefully scopes what those reports may contain (usage metrics only,
never prompt content or code). Aether OS has no fleet, no sharing, no reporting, and no
externally-reachable listener — `electron/permissionServer.ts` does run a local HTTP server for
`PermissionRequest`/`PostToolUse`/`Notification` hook brokering, but it is bound to `127.0.0.1`
only, reachable only from this machine, with no port exposed externally and no token or auth
surface to leak (see §3). The single-user constraint is not a smaller version of TokenMonitor's
model; it removes the model entirely.

**Nothing leaves this machine, with exactly one named, default-off, opt-in exception.** As of
Stage 13.5 (`docs/roadmap.md` §3.5), there is no model call site anywhere in this codebase for
Aether's own features: the `@anthropic-ai/sdk` dependency is gone,
`chatCore.ts`/`claudeClient.ts`/`systemPrompt.ts`/`chatProxyPlugin.ts` and the `chat:*` IPC pair are
deleted, and `.env` key loading (`electron/loadDotEnv.ts`) is gone too — the app cannot read a key
from disk even if one exists. `Comms` (the renamed Chat tab) answers only through
`localResponder.ts`, a local, deterministic responder, with no network request. **Cross-engine
Codex verification (§10) is the sole exception** — an explicit, default-off, opt-in feature that
sends a scoped snapshot to a second vendor's agent, never automatic and never enabled by any other
feature in this app.

This claim is about Aether's own code and holds no API key — it does not extend to the embedded
terminal. The terminal auto-launches the user's own `claude` session (`electron/ptyManager.ts`),
which sends prompts to Anthropic on every turn under the user's own credentials, exactly like
running `claude` in any other terminal window. That traffic is the user's Claude Code usage, not
something Aether initiates, proxies, or can see — Aether has no visibility into it and no path to
influence it beyond scrubbing `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` from the
environment the terminal shell inherits, so a key exported for other tools on the operator's
machine cannot be picked up by the session Aether starts.

**The same carve-out, additionally gated, now covers a second terminal.** A Codex terminal
(`electron/codexPtyManager.ts`) — a second, independent, real interactive `codex` CLI session —
exists alongside the Claude terminal. Unlike the Claude terminal, it does not auto-launch: it only
spawns when the operator has both (a) opted in via `codexTerminalCfg.enabled`, default `false`, and
(b) navigated to the Codex sidebar view — the same lazy, mount-triggered mechanism the Claude
terminal already uses, not an unconditional app-boot launch. See §11 for the full boundary.

**No telemetry. Ever.** Not opt-out, not anonymous, not aggregate. Worth stating explicitly because
it is a live differentiator: `agent-flow`, one of the two comparable agent-trace visualizers,
ships anonymous telemetry **enabled by default**.

---

## 2. What the single-user constraint deletes

Bank these as removed from scope, permanently:

- No authentication or authorization model
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
- `.env` stays gitignored (it already is). The API key is read in the Electron main process only and
  is never exposed through preload, never returned from an IPC handler, and never logged.
  `chat:hasKey` returns a **boolean only** — never the key, never a prefix, never a length.
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

## 9. Cross-engine Codex verification — the one named outbound exception

Shipped 2026-08-07 — see `docs/superpowers/plans/2026-08-07-codex-acp-cross-engine-verification.md`.
This is the only feature in Aether OS that sends anything to a second vendor. It exists to let the
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

## 10. Correction to fix in `CLAUDE.md`

The current project memory states:

> The key is read server-side only (electron main process); `.env` is gitignored.

**The first clause is not true today.** The key is read by `vite-plugins/chatProxyPlugin.ts` in the
Vite dev server; the Electron main process never sees it, which is precisely why Chat's real replies
do not work in the desktop app at all
(`docs/superpowers/plans/2026-07-27-chat-ipc-correctness.md`). The documented belief is what let the
defect hide for as long as it did.

Stage 0.5 makes the statement true. Until it lands, the line should read *"read server-side only
(Vite dev-server plugin today; moving to the Electron main process in Stage 0.5)"* — an accurate
description of a broken state beats an aspirational one, which is this project's stated standard
everywhere else.

---

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

**Shares the verifier's `CODEX_HOME` isolation and env-stripping.** `electron/codexPtyManager.ts`'s
`spawnCodexPty()` calls the same `resolveCodexHome()` (`electron/crossEngine/acpProcess.ts`) §9's
verifier uses, so the terminal session and the verifier read and write the same dedicated,
isolated Codex home directory — never the operator's global `~/.codex`. Before spawning, `buildCodexPtyEnv`
strips `OPENAI_API_KEY` and `CODEX_API_KEY` from the environment the shell inherits (mirroring
`ptyManager.ts`'s `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` scrubbing for the
Claude terminal), so a key exported for other tools on the operator's machine cannot be silently
picked up by the session Aether starts.

**Named limitation, not glossed over: env-stripping cannot police what the operator types.** This is
a real, live, interactive terminal. Stripping the inherited environment closes exactly one path — a
key silently carried in from the shell — and nothing more. It does not and cannot stop the operator
from typing `codex login --api-key ...` (or pasting a key into any other prompt the `codex` CLI
offers) by hand inside the live session once it is running. This is not a gap specific to this
feature; it is the same category of limitation the Claude terminal's own environment-scrubbing
already has and already documents above — an interactive shell is, by construction, a surface Aether
cannot fully police from the outside.
