# Aether OS — Privacy & Data Model

**Status:** binding design constraint, not aspiration. Every stage in `docs/roadmap.md` is
subordinate to this document.

---

## 1. The stance

**Aether OS is single-user and local-first. The explicit outbound exceptions are Codex verification (§9), opted-in Claude–Codex communication (§13), operator-driven terminals (§11), and the opt-in, default-off background memory extraction through the Claude CLI (§14), and, as a model-launch boundary, the opt-in voice gateway, which starts a `claude -p` session, launched with hooks disabled, under the owner's login (§18). The deliberate inbound exceptions are, first, the opt-in, off-at-every-launch, tailnet-only read-only chat view for a paired phone (§16), and, separately, the opt-in tailnet-only phone control path (§17), which unlike the viewer may be set to re-enable at launch (built: pairing, device auth, the `/ctl` handshake, terminal output and typing into a running slot; approvals, starting a slot and fit-to-phone are planned, not built; phone alerts, an alert-only credential and a desktop watcher that sends a three-value label, are built, PR #198, with the permission-prompt hook installed by hand; see §17). Third is the opt-in, off-at-every-launch, tailnet-only voice gateway on its own listener (port 47822), through which a paired phone can talk to a Claude session on this PC (§18).**

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
session cookie; it never binds a wildcard or LAN address. Phone control (§17) shares that tailnet-only listener and adds a separate bearer-token `/ctl` input path with its own toggle, token store and code directory; both bind only the Tailscale IPv4 address, never a wildcard or LAN address (built: pairing, the handshake, terminal output, typing, the read-only thread and prompt display, and the read-only Ledger; approvals planned; see §17). The voice gateway (§18) is a second, separate listener with the same rules: Tailscale IPv4 only, off at every launch, native confirm, pairing code and cookie, and it refuses any request that carries an `Origin` header. The single-user constraint is not a smaller version of TokenMonitor's
model; it removes the model entirely.

**Aether has no SDK, HTTP or key-loading path to billed model APIs.** (The opt-in Claude CLI
path in §14 is a different thing: it is refused unless Claude Code reports a subscription
login, and whether the call then uses that credential is not checked on a live run.) Stage 13.5 removed the Anthropic SDK,
chat API proxy, and `.env` key loading. The legacy deterministic Comms responder stays local.
Two independently default-off features can send content to OpenAI under the operator's Codex
subscription: manual verification (§9) and Claude-requested consultations (§13). Neither toggle
enables the other. The communication view displays real exchanges without asking another model
to summarize them.

**There is one background model call, and it is opt-in (§14).** The collector's memory
extractor (`collector/src/memoryExtract.ts`) calls `claude -p --model haiku`. It shipped with
Stage 13 and went unnoticed against the Stage 13.5 "no model call site" claim until issue #104;
it is now off by default and gated behind a Settings toggle. It goes through the Claude CLI,
not an SDK or HTTP call site, and it is refused unless Claude Code reports a subscription login
(whether the call then uses that credential is not checked on a live run); §14 states exactly what is sent and under which conditions.

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
  see §16, and phone control, §17 (built). **A second deliberate, opt-in listener:** the voice
  gateway (`electron/voice/`, port 47822) follows the same rules (tailnet address only, off at every
  launch, native confirm, pairing code and cookie, no request with an `Origin` header) and is also a
  model-launch boundary; see §18

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
- `~/.aether-os/voice-sessions.json` holds the paired phones for the voice gateway: a SHA-256 hash and three timestamps per phone, nothing else (§18). Same store, validator and rules as `remote-sessions.json`: Purge leaves it, REVOKE ALL empties it. No prompt, reply or transcript of the voice session is written by Aether.
- `~/.aether-os/alert-devices.json` (phone alerts, built) holds the alert-only credentials of the paired phone-control apps, in the same shape as `remote-devices.json`: a SHA-256 hash, three timestamps and the phone's tailnet address per app, nothing else (§17). Same rules: Purge leaves it, REVOKE and REVOKE ALL empty it together with the main device.
- `~/.aether-os/control-settings.json` holds `{"v":1,"reenableAtLaunch":boolean,"phoneTyping":boolean,"phoneAlerts":boolean}` and nothing else: the three persisted phone-control settings (§17; `phoneAlerts` defaults to false and is true only when the stored value is `=== true`). It is auth configuration, not collected data, so Settings → Purge leaves it, like `remote-sessions.json` (Purge runs only the collector purge and the diag-log purge). A user disable from Settings clears only `reenableAtLaunch`; quitting the app clears neither.
- `~/.aether-os/aether-choice-picks.json` (AetherChoice per-thread model/effort picks, `{"v":1,"threads":{...}}`) holds only thread ids, model and effort names, boolean flags (live, pending step-down, halted), short reason text (at most 200 characters), timestamps and the Claude version string. It holds no prompt, reply or transcript and no paths, is capped at 64 KB on load, and is validated field by field (anything unrecognised is dropped). Settings → Purge leaves it: Purge runs only the collector purge and the diag-log purge (`retention:purge` in `electron/main.ts`), so it does not delete this file. It is written on every pick change only when `AETHER_CHOICE_HOST=1` is set; the switch is off by default, and with it unset the file is never written. While a Claude slot (Terminal Alpha, Terminal Beta) runs, a headless in-memory screen mirror of that slot exists; it is reduced to one enum and is never logged, stored or sent, and is cleared when the slot exits. Independently of AetherChoice, main now keeps one such mirror for every running terminal slot (Alpha, Beta, Codex) for the app's lifetime, only so the desktop window can be repainted after a reload; see section 17. `~/.aether-os/diag.log` gets `[aetherchoice]` lines holding model and effort names, the slot name (`claude` or `terminal2`, which is also the thread id), the pick source, a timestamp, trigger and outcome only. When `AETHER_CHOICE_HOST=1` and the off-by-default `AETHER_CHOICE_TRACE=1` are both set, it additionally gets a `trace` line whenever a slot's screen reading, the detected Claude version or its quiet flag changes, holding the slot name, a reading keyword, the version number, a true/false flag and two elapsed-millisecond counts, never any screen text. The app types exactly one command into a Claude slot, `/effort <level>`, at a confirmed idle prompt, and adds `--model` and `--effort` to the launch line; it never edits `~/.claude/settings.json`. The renderer receives a push `aetherChoice:halted` carrying models and efforts only.
- `~/.aether-os/gui-projects.json` (the GUI variant's pinned folders, `{"v":1,"projects":[{"id","path","addedAt"}]}`) holds the absolute paths of folders the user chose with the native folder picker: the one place Aether stores absolute paths, by the user's choice. It lives in the private `~/.aether-os` directory, is capped at 64 KB on load and is validated entry by entry; on Windows, UNC and extended paths (`\\host\share`, `\\?\`) are refused on add and on load. The renderer only ever receives `{id,name}` (the folder's basename), never a path. It is written only when `AETHER_GUI=1` is set and the user pins a folder; with the switch unset the file is never read or written. Settings → Purge leaves it.
- The SQLite store is **not** encrypted, and the README should say so plainly rather than implying
  otherwise. Given §4, its contents are paths, names, timestamps and integers — the honest position
  is "here is exactly what is in it," not a security claim the implementation does not back.
- `collector.db` may have `collector.db-wal` and `collector.db-shm` siblings holding the same kinds of
  data until they are checkpointed. Settings → Purge checkpoints and truncates them after the purge;
  deleting `collector.db` by hand should also delete both siblings.
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
launches it directly and independently of this adapter, and the opt-in voice gateway, §18, launches
a long-lived `claude` session launched with hooks disabled from `electron/voice/voiceSession.ts`, a file allow-listed in
`src/shared/noApiCalls.test.ts`. Neither goes through this adapter.)
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

Implemented through U8 and merged to master in #76 (2026-09-15); U9 component-path verification has passed; complete connected-launch verification remains in
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

**What is sent, and to whom.** To Anthropic under a Claude subscription login (see Isolation
below), from the collector, per qualifying dispatch: the agent id, the dispatch result text (`extractDispatchResultText` of the task-notification; when that result is the harness stub or empty, the subagent's own hand-back report, at most 8,000 characters, is sent instead) plus up to 20
memories previously extracted for that agent. Aether-initiated with no human typing the turn,
which is what makes it a distinct boundary, like §12. It is usually sent within about 30 seconds
of the dispatch completing.

**Isolation (issue #111).** The call is a real Claude Code invocation, so it is isolated from the
user's Claude Code configuration by flags, environment and working directory. None of this is
checked directly on a live run: the evidence is the flags and their documented effects (the same
standard as the §18 `Hooks disabled.` bullet). The argv, pinned in
`collector/src/memoryExtract.test.ts`, is `-p <prompt> --model haiku --output-format text
--setting-sources project --settings {"disableAllHooks":true} --strict-mcp-config --mcp-config
{"mcpServers":{}} --disable-slash-commands`, launched with no shell.

- **Subscription login required.** Before every call (per item, no cache) the collector runs
  `claude auth status --json` in the same environment and working directory and refuses unless it
  exits 0 with `authMethod` exactly `claude.ai` or `oauth_token`. Anything else, including a future
  value, a timeout (15 s), a non-zero exit, a launch error or unparseable output, refuses and no
  `-p` process is started. Refusals are logged as `exec_refused: <reason>` with a fixed reason:
  `auth_api_key`, `auth_api_key_helper`, `auth_third_party`, `auth_none`, `auth_method_unknown`,
  `auth_status_timeout`, `auth_status_exit`, `auth_status_error`, `auth_status_unparseable`, or
  one of the working-folder reasons below. Unverified: that `auth status` makes no model call, and
  that its `authMethod` is the credential the later `-p` run actually uses. `auth status` cannot be
  given `--setting-sources`, so it also reads user settings: a user whose `apiKeyHelper` lives only
  in `~/.claude/settings.json` is refused (`auth_api_key_helper`) even though the `-p` child
  excludes user settings. That false refusal is accepted as the conservative direction.
- **Environment.** Removed, case-insensitively: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL` and every `CLAUDE_CODE_USE_*` variable (Bedrock/Vertex/Foundry switches).
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` is set. `CLAUDE_CODE_OAUTH_TOKEN` (a subscription setup token)
  is kept. The collector's own environment is not modified.
- **Settings, MCP, slash commands.** `--setting-sources project` loads no user settings (where
  `env` keys, `apiKeyHelper`, plugins and hooks live) and, because the working folder is empty, no
  project settings either; `--settings {"disableAllHooks":true}` disables hooks;
  `--strict-mcp-config` with an empty `mcpServers` object loads no MCP servers;
  `--disable-slash-commands` turns off skills and commands. Managed/policy settings
  (`C:\Program Files\ClaudeCode`) cannot be excluded and remain in effect; whether they can
  re-enable hooks is unverified. Unverified: that an empty `mcpServers` object is accepted, that
  the subscription login still resolves under `project`, and the exact `project` semantics. If a
  live run forces a fallback to `--setting-sources user`, that is not a one-word switch: `user`
  reloads settings `env` and `apiKeyHelper`, which would then have to be overridden in `--settings`
  or the design re-reviewed.
- **Working folder.** `%ProgramData%\AetherOS\memory-extract-cwd`, created lazily and never under
  the user profile or `%TEMP%`, because Claude Code loads `CLAUDE.md` from every ancestor of its
  working directory. If `ProgramData` is unset or the folder cannot be created there is no
  fallback: the call is refused (`cwd_unavailable`). Before each spawn (the auth check and the `-p`
  call, so a swap between them is caught) the collector checks that it is a real directory, not a
  link or junction, and that its real path matches (`cwd_unsafe`); that it is strictly empty, so a
  planted `claude.exe`, `.claude` or `CLAUDE.md` refuses (`cwd_dirty`; on some Node versions a
  `claude.exe` in the working folder is resolved before `PATH`, which is why the folder must be
  strictly empty); and that neither it nor any
  ancestor up to the drive root holds a `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` or
  `.claude/settings*.json` (`cwd_ancestor_memory`). Aether never deletes the folder; it stays empty
  and is safe to delete (it is recreated on next use). This assumes a single-user machine: another
  local account with write access to that folder, or able to pre-create it, could plant files, and
  the per-call checks narrow that to a race without closing it. No ACL hardening is done.
- **What still loads.** `~/.claude/CLAUDE.md` and any managed `CLAUDE.md` MAY still be loaded, and
  if so that text is sent along with the dispatch; under `--setting-sources project` it may not load
  at all, which is unverified. The call still writes an ordinary Claude session transcript under
  `~/.claude/projects/` for the working folder (`--no-session-persistence` is not used).
- **Which login, and can it bill.** The gate above means the call is not made on an API key,
  `apiKeyHelper`, Bedrock/Vertex/Foundry or `ANTHROPIC_BASE_URL` setup that Claude Code reports.
  Whether `-p` then uses the credential `auth status` reported is not checked on a live run, so
  this is a strong guard, not a guarantee.

**What is stored.** Model-written memory atoms in `~/.aether-os/memory.db`. They derive from
transcript content, which strains the Stage 14 "never in `~/.aether-os/`" amendment in §4; this
section names that tension and does not resolve it. `memory.db` is created the first time the
collector drains an extraction item with the setting ON. With the setting OFF (the default), or ON
with nothing to extract, the collector never creates it, and a file left by an earlier version or
by earlier use stays on disk, empty or not, until the operator deletes it.

**Backfill.** Scan offsets persist in `collector.db` (`transcript_files.last_offset`) and only
advance when a scan runs. Dispatches the collector scans while the setting is off are not
extracted later unless `collector.db` (and its `-wal`/`-shm` files) is deleted. Qualifying dispatches it has not yet scanned
are sent the next time it scans with the setting ON. That covers dispatches that started and
completed while the collector was not running, and every past dispatch when `collector.db` is fresh or deleted (the rescan starts at offset 0).

**Deployment caveat.** The gate takes effect only once the collector `dist` is rebuilt or
reinstalled. The installed collector runs from its built output, and a pre-#104 collector
extracts unconditionally.

**Guard.** `src/shared/noApiCalls.test.ts` fails on any literal `claude` process launch
(`spawn`, `exec*`, `fork`, including promisified and aliased forms) outside an exact-path
allow-list: the §12 adapter, `collector/src/fleetPoll.ts` (`claude agents --json` session
listing; no prompt, no model; argv pinned), and `memoryExtract.ts`, which now makes two literal
launches (`auth status --json` and `-p`) under its unchanged allow-list entry. The `-p` argv pin
lives in `collector/src/memoryExtract.test.ts`, not in `noApiCalls.test.ts`, which pins only
`fleetPoll.ts`'s argv. A launch whose command is a variable is out of reach of a literal-string
guard.

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

**What is exposed.** Human prompts, Claude replies, agent-to-agent messages (dispatches, SendMessage posts, hand-backs, shown as traffic cards) and the **names** of the tools Claude called, for the one pinned Claude session. Never tool inputs, tool results, thinking blocks or file contents. No Codex session, no Terminal Beta, no session picker and no subagent transcripts in v1.

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

**Following `/clear`.** When Claude's `/clear` starts a new session in the same pty, the live-agent tracker moves its pin to the successor transcript so the phone Thread follows the live conversation. To find it, the tracker (`clearSuccessorFinder.ts`) also reads the first 2 MiB at most of other `.jsonl` files in the pinned project directory that are newer than the pin, and only regex-matches them for a `/clear` record and the session id of this app's own launch; no content from those files is retained, logged or sent, and only a file proving it descends from the launch id can take the pin. The scan runs at most every 3 seconds. The follow happens at the first prompt after `/clear` (Claude Code creates the new file lazily).

**Not verified by unit tests.** Phone layout and legibility, the top-bar chip at narrow widths, Windows Firewall behaviour on first enable, how Chrome and Samsung Internet treat an `http://100.x` address, and a packaged-build run.

---

## 17. Phone control over Tailscale — the one opt-in input path

**Status: V1 built (pairing, device auth, `/ctl` hello/welcome with server proof, Settings block, chip, persisted re-enable). V2 desktop side built: the slot list and live, read-only terminal output over `/ctl` (the phone-side client and page are in the repo, but the Android Activity UI is not yet built, so the phone cannot show terminals yet). V3-Type desktop side built: typing into the three running slots over `/ctl` (verbs `in` and `ack`; per-device ordered, deduplicated and rate limited; no replay after a drop; only into a slot this socket has attached; only into a running slot). The Android app sends input from V3-Type. Slice 1 (phone thread) desktop side built: a read-only thread view of the Claude session transcript (verbs `thread.attach` / `thread.detach`) and a read-only display of pending permission prompts, pushed only to a thread-attached socket. Approve and deny verbs are NOT built: the phone cannot answer a prompt yet. Read-only Ledger feed built: a socket that sends `ledger.attach` receives derived cost numbers (verbs `ledger.attach` / `ledger.detach`, frame `ledger.snap`); the Android screen is a separate task. Generic view channel mechanism built (verbs `view.attach` / `view.detach`, frame `view.snap`, and `welcome.views`), with five views registered, `projects`, `memory`, `dash`, `analytics` and `agents` (their Exposed bullets are below); the channel exposes nothing by itself, and each later pane adds its own Exposed bullet in the change that registers it. Starting a slot, reconnect and fit-to-phone are not built (planned, V3+). Phone alerts built in `feat/phone-alerts` (device checks are partial and delivery latency is not measured; see PROGRESS.md): an alert-only credential and a desktop watcher that sends a three-value label (`finished`, `question`, `input`) for Terminal Alpha stops; described in the items marked "phone alerts" below.** This section is the binding description the build is held to (docs land before capability code). Each slice that changes behaviour updates it in the same change. Plan: `~/.claude/handoffs/aether-os/2026-10-22-aether-mobile-design.md` (outside the repo).

Added with Aether Mobile. A paired Android app on the owner's tailnet (at most 2 live control sockets at once) can see and type into the three terminal slots (Terminal Alpha, Terminal Beta, Codex) and answer Claude permission prompts. **This is equivalent to the owner's keyboard on this machine: a connected, unlocked phone can run arbitrary commands as the owner.** It is separate from §16: its own toggle, pairing scope, token store and code directory (`electron/control/`). `electron/remote/` stays read-only, and the viewer keeps its off-at-every-launch rule (§16). The Android client lives in `android/` in this repository.

**Exposed.** As of V3-Type three things flow between an authenticated, attached phone and the desktop (plus the alert-only flow in the Phone alerts item, which needs no attach): the raw output of the three terminal slots (in the first item below), `welcome.sessions` (each slot's id, label, state, size and sequence number), and input bytes the phone types into a running slot it has attached (`in` frames, acknowledged by `ack`). Input is limited to 8 KB per frame, 256 KB per second and 100 frames per second per socket; over a limit the socket is closed with `bye rate-limit`. The Android app sends a paste of up to 64 KB as 4 KB frames (the frame limit and the 256 KB per second and 100 frames per second limits are unchanged); a larger paste is refused on the phone. Frames carry a per-slot counter: a repeat is acknowledged without being written, a gap closes the socket, and a counter resumes after a reconnect only for the same app run (epoch). An `in` for a slot that is not running, or while typing is off, is answered with a `nak` and never written, and one for a slot the socket has not attached closes the socket. Starting a slot, answering permission prompts and the fit-to-phone resize are not built; the remaining items below are the planned scope, not current behaviour, except the two thread items and the Ledger item just below.
- **Thread (slice 1, built).** For the Claude slot only, a per-slot thread view of the Claude session transcript, sent only to a socket that has sent `thread.attach`: user prompts, assistant text, and tool events (tool name, a one-line target of at most 160 characters, optional added/removed line counts). Text is size-capped (8000 characters per event, 200 events or 200 KB per snapshot) and is NOT masked and not path-shortened: it shows what the transcript shows, secrets included. Tool results and thinking blocks are never sent. The `working` flag is derived on the desktop from turn marks, not from the last event: busy on a human prompt, a `tool_use` or `stop_reason` `tool_use`; idle on `end_turn`, any other terminal stop reason or an interrupt; and reported idle once the transcript has not grown for 120 seconds. Frames: `thread.snap`, `thread.ev`, `thread.state` (to the phone), `thread.attach`, `thread.detach` (from the phone).
- **Ledger (built, read-only).** For a socket that has sent `ledger.attach`, one `ledger.snap` frame is sent at once and again after each transcript scan (about every 60 seconds) until `ledger.detach` or close: the observed total cost and its four-part split (input, output, cache write, cache read), the pricing tiers seen, the today, 7-day and month rollups (a bucket with no activity is null), and cache impact (cache-read tokens, the counterfactual cost with and without the cache, the saving, and the hit rate). Derived numbers only, rounded to 4 decimals; every dollar figure is an API-rate counterfactual, not a bill. No transcript text, no prompts, no per-session or per-project breakdown, no dispatch rows, no time zone. If any value fails validation the frame carries `ledger: null` instead. The phone keeps it in memory only and drops it on detach, disconnect and lock. Frames: `ledger.snap` (to the phone), `ledger.attach`, `ledger.detach` (from the phone).
- **Generic views (mechanism; five views registered, `projects`, `memory`, `dash`, `analytics` and `agents`).** A phone may send `view.attach` / `view.detach` with a view id from a closed list (`projects`, `memory`, `dash`, `analytics`, `agents`, `comms`, `comms.thread`, `comms.exchange`); `comms.thread` and `comms.exchange` may add a small parameters object (at most 512 bytes serialised; any other view with parameters, or an id outside the list, closes the socket). The desktop answers with `view.snap` frames carrying `v` and a payload `d`, which is `null` when there is no data yet or the view's encoder failed validation. `welcome.views` lists the view ids this desktop can serve; a `welcome` with no `views` key comes from a desktop built before the channel, so a phone must treat that as "no generic views" and never send `view.attach` to it (such a desktop closes the socket on an unknown verb). One attachment per socket per view; a repeated `view.attach` replaces it. `welcome.views` lists only registered views (currently `["projects","memory","dash","analytics","agents"]`); a `view.attach` for any other id closes the socket. What each view carries is stated in its own bullet below.
- **Projects view (built, read-only).** For a socket attached to `projects`, one `view.snap` frame is sent at once and again after each transcript scan (about every 60 seconds) until `view.detach` or close: the global Ledger numbers (`all`), the numbers for events with no resolvable project (`unscoped`, or null), and per project root: an opaque key (never a path), the repository's folder name, the same derived cost, token, tier, rollup and cache-impact numbers as the Ledger item, and, when the repository has more than one checkout, one entry per checkout (an opaque key, the worktree folder name or null for the main checkout, and the same numbers). At most 50 projects and 20 checkouts per project, in the order the desktop shows them. Folder names are passed through `maskSecrets` and cut to 60 characters. Every dollar figure is an API-rate counterfactual, not a bill. No paths, no optimize findings or advice, no transcript titles or text, no session counts, no time zone. If any value fails validation, or the Ledger or project snapshot does not exist yet, `d` is null. Frame: `view.snap` with `v:"projects"`.
- **Memory view (built, read-only; this one carries free text).** For a socket attached to `memory`, one `view.snap` frame is sent at once and again after each memory scan (about every 15 seconds) until `view.detach` or close. It carries the owner's own memory entries from `~/.aether-os/memory.db`, which the desktop opens read-only: counts of live and removed entries (totals before capping), then up to 150 live entries (highest salience first, then most recently updated) and up to 60 removed entries (newest first). A live entry has its id, scope (shared or private), owning agent name, kind, status, salience, subject, content, and created and updated times; a removed entry has its id, scope, owning agent name, content, removal time, cause and the id of the entry that replaced it, if any. Subject, content and agent name are passed through `maskSecrets` and then cut to 80, 600 and 60 characters. Reference counts and any extraction cost are never sent (the frame carries a reserved `extraction` field that is always null). Private entries are sent too, labelled with their owner; the phone decides how to group them. If the database is missing or unreadable, or any value fails validation, `d` is null. Frame: `view.snap` with `v:"memory"`.
- **Dashboard view (built, read-only; renderer-fed; enums, numbers and counts only, no text).** For a socket attached to `dash`, one `view.snap` frame is sent at once and again whenever the desktop window publishes a changed reading (at most once a second) until `view.detach` or close. The desktop window computes it with the same functions the Dashboard uses and hands it to main over the renderer publish bridge (see "In memory only"); main re-validates it field by field before it is sent. It carries: the time it was computed (so the phone can show the reading's age; live/standby and the ETA are judged at that instant and are not re-judged until the next publish), whether a Claude session is live, the alarm level (`ok`, `warn` or `crit`), the token rate per minute, the month's token count, today's API-rate cost, the percentage of the monthly cap left and the cap itself in millions of tokens, the depletion estimate (a kind of `none`, `now` or `secs`, the seconds, its source of `scan`, `live` or `stale`, and the milliseconds until the rate-limit window resets), for each of the four readiness rows (desktop, terminal, statusline, collector) whether it is met, whether it glows and the time it was last true, a recap summary of four counts (dispatches completed, anomalies detected, anomalies cleared, tokens burned) or null, and three counts (running agents, alerts, memory entries). A value that was not measured is null, never 0. It carries no text at all: no readiness or KPI wording (the phone has its own), no digest rows, no alert or notification text, no recap entry details, no command history, no agent names, and no settings (only the cap). If any value is NaN, negative, out of range or an unknown enum, `d` is null; if the window has published nothing yet, or phone control was off or has been turned off, `d` is null. Frame: `view.snap` with `v:"dash"`.
- **Analytics view (built, read-only; renderer-fed; counts plus a small amount of free text).** For a socket attached to `analytics`, one `view.snap` frame is sent at once and again whenever the desktop window publishes a changed reading (at most once a second) until `view.detach` or close. The desktop window computes it with the same functions the Analytics pane uses and hands it to main over the renderer publish bridge (see "In memory only"); main masks and caps the text and re-validates every field before it is sent. It carries: the time it was computed, four log counts (success, info, denied, other; the log lines themselves are not sent), up to eight of the longest-running agent dispatches (agent type, description, and the instant it started), up to five of the most token-hungry recently completed dispatches (agent type, description, tokens, tool calls or null, duration), and up to five of the most frequent commands you have typed in the Aether command line, each as its first word only with a count. **Exposed free text, stated plainly:** dispatch descriptions (what an agent was asked to do, in a few words) and the first words of your own typed commands. The command counts come from the persisted command history (the last 30 lines you typed, kept across restarts), so the phone can show first words from past sessions, not just the current one; this mirrors the desktop Top Commands card. Descriptions are passed through the secret masker and cut to 80 characters, agent types to 40 and command words to 24; only the top five commands are sent. Never sent: dispatch prompts, full command lines or their arguments, raw log text, transcript text. If any number is NaN, negative or not a whole count, or a command word contains whitespace, `d` is null; if the window has published nothing yet, or phone control was off or has been turned off, `d` is null. Frame: `view.snap` with `v:"analytics"`.
- **Agents view (built; read-only; roster renderer-fed, fleet and timeline collector-fed; free text including dispatch prompts).** For a socket attached to `agents`, one `view.snap` frame is sent at once and again whenever the desktop window publishes a changed roster or the collector reads change the fleet or timeline (at most once a second) until `view.detach` or close. The desktop window groups dispatches with the same function the Agent Roster card uses and hands the result to main over the renderer publish bridge (see "In memory only"); main masks and caps the text and re-validates every field before it is sent. It carries: the time it was computed; up to 30 running dispatches, those with an anomaly first (an opaque id, agent type, description, start instant, model or null, headline, the current narration line or null, `needsInput`, the anomaly kind and detail or null, and the dispatch prompt); and up to 20 recently completed dispatches (id, type, description, start instant, tokens, tool calls and duration each null when not measured, headline). `needsInput` is true exactly when the roster shows an anomaly for that dispatch (re-read loop, write-delete-rewrite, zero-edit burn, stalled permission); it is NOT the permission queue and says nothing about a pending approval. The frame also carries `fleet` and `timeline`, read by the desktop from the collector database with the same reads the Fleet and Dispatch Timeline cards use (every 15 seconds); each is null when the collector is absent or its heartbeat is stale and an empty list when the collector is present but has nothing. `fleet` is up to 50 sessions, oldest first: an opaque key (a salted hash of the session id, different on every app run, never the session id), the project title (the project's folder name only), the session name, start instant, status (`busy` or `idle`), kind and process id or null. `timeline` is up to 60 entries, newest first, from the last 24 hours: a kind (`tool`, `dispatch` or `anomaly`), the instant, one label, and for a dispatch its tokens, tool calls and duration (each null when not measured). A tool label is the tool name plus the file's BASENAME only (as the desktop card shows it); an anomaly label is its kind plus its detail with any path reduced to the file name; a dispatch label is the word `Agent`. **Exposed free text, stated plainly:** what each running agent was asked to do, including the full PROMPT text, plus its headline and narration line; the names of your other Claude sessions and their project folders; and the names of the tools and files the agents touched recently (file names, not directories). Masking runs on the raw text first and the cut comes after (descriptions 120, headlines 120, narration 160, anomaly details 120, prompts 1200 characters, agent types and model names 40). An anomaly detail that opens with a file path is reduced to the file name. Fleet titles and names are masked, and, where the text holds a path separator, reduced to the text after its last separator (so a directory name, spaced or not, never survives; a name that ends in a separator keeps its last folder name, as the project title does), then cut to 60 characters (kind: reduced the same way, then limited to letters, digits, `_`, `.` and `-` or shown as `unknown`; tool names reduced the same way); timeline labels are masked first, then reduced, then cut to 80. The fleet and timeline are encoded in main as the collector is read and only the encoded rows (at most 50 and 60, no paths, no session ids) are kept in memory, never written to disk or `diag.log`, are not collected at all while phone control is off, and are dropped when phone control leaves the on state and at quit. A fleet or timeline row with a bad number, status or time is left out of its list; a non-empty source with no valid row sends null. The Thread view already shows transcript text unmasked, so for the same session the phone shows masked text here and unmasked text in Thread; this view is the stricter of the two, and masking is a floor, not a guarantee. The id is the dispatch's tool-use id as an opaque string of letters, digits, `_` and `-` (up to 64); nothing else about the tool call is sent. Never sent: permission or flag requests (Phase B), Verify-with-Codex, tool inputs or results, file contents, any directory path, a session id, a working directory, the collector's source file paths or tool-use ids on the timeline. A dispatch with an unreadable start time or an unsafe id is left out of the list; if any number is NaN or negative, an id or anomaly kind is not valid, or `needsInput` disagrees with the anomaly, `d` is null; if the window has published nothing yet, or phone control was off or has been turned off, `d` is null. Frame: `view.snap` with `v:"agents"`.
- **Approval display (slice 1, built, read-only).** Pending Claude permission prompts are shown to a thread-attached socket: tool name, risk (LOW, MED or HIGH), a summary of the command or path of at most 1200 characters (NOT masked), and the remaining time. Frames: `prompt` and `prompt.closed` (reason `answered-desktop` or `timeout`). The phone cannot answer: Allow and Deny render disabled and no approve verb exists. The hook does not carry the originating session to a slot, so the prompt is shown on the Claude thread labelled by tool.
- **Phone alerts (built).** A socket authenticated with the alert credential receives `alert {s:"claude", kind}` where `kind` is `finished`, `question` or `input`, and nothing else: no terminal output, thread, ledger, view or prompt text. The alert text is a closed set of fixed strings and the fixed wording lives on the phone; nothing in it is derived from the terminal or transcript.
- Raw output of the three terminal slots, unmasked (the terminal is the content, as on the desktop).
- Input bytes into running slots, and starting a not-started fixed slot (Terminal Alpha, Terminal Beta, and Codex only if the Codex terminal is enabled, `codexTerminalCfg.enabled`). Never replacing a running one.
- Claude permission prompts raised through the permission hook (planned: answering them from the phone; slice 1 displays them read-only, see the approval display item above). The hook acts only for the one session recorded in `own-session.json`, which need not be Alpha, and a prompt that Aether auto-allows by risk (`shouldAutoAllow`, `electron/main.ts`) raises no alert. The `session_id` is not passed through, so a prompt is not attributed to a slot. Shown: tool name, risk and an unmasked summary of at most 1200 characters of the command or path; the planned Allow and Deny buttons are not built. Approval stays one tap even for HIGH-risk tools (rm, sudo, curl-pipe-sh).
- Codex has no brokered prompts: its approvals are answered inside the Codex terminal, with a quick-key row on the phone (y, n, Enter, Esc, arrows).
- Terminal size: the phone mirrors the PC's PTY size by default. A "fit to phone" button resizes the PTYs while the phone is attached (the desktop terminal follows) and the desktop layout is restored on detach.

**Never exposed.** Killing or replacing a session, editing an approval, the auto-allow level, any setting, the communication bridge, files, transcript files, tool results and thinking blocks (only the thread events listed under Exposed are sent), boards, the clipboard, arbitrary new sessions or commands, or any model call; any text, path, tool name or timing derived from the terminal or transcript in an alert (the alert credential cannot attach, type, read a feed or answer a prompt). Nothing from the Ledger beyond the derived numbers listed under Exposed: no dispatch table, no quota or plan figures, no transcript text. Per-project numbers are limited to the Projects view bullet, and memory text to the Memory view bullet (no reference counts, no extraction cost). The generic view channel carries only what a registered view's own Exposed bullet lists (currently Projects: no paths, no optimize findings, no transcript titles; Memory: masked and capped entries only; Dashboard: enums, numbers and counts only, no text; Analytics: counts, plus masked and capped dispatch descriptions and the first words of your own typed commands, top few only; Agents: masked and capped dispatch text including prompts, fleet session and project names and timeline tool names with file basenames, no directory paths anywhere, no session ids (fleet keys are salted hashes), no working directories, no permission or flag requests, no Verify-with-Codex, no tool-use ids beyond an opaque id string). The message set is a closed allow-list (`MESSAGE_TYPES.phoneToTitan`); a new verb fails the guard until the list, a test and this section change together.

**Boundary.**
- Shares §16's tailnet-only listener and port (47821): one `listen()`, never a wildcard or LAN address. `/ctl` accepts only a bearer token, never a cookie and never an `Origin`; a viewer cookie can never open `/ctl` and a control token can never open the viewer socket.
- **Off by default, with one opt-in persistence.** A fresh install starts with phone control off, and so does every launch unless the owner has turned on a separate setting. The owner may turn on "re-enable phone control at launch", so that a restart (an update, a crash, a reboot) while away from the desk does not strand the phone. That setting is default off, needs its own native confirm in the main process and a request from the trusted app window, and is stored in the persisted settings listed under On disk and nothing else about the feature's state. The persisted flag is cleared when phone control is disabled from Settings, so after a manual disable the owner must opt in again, with the native confirm. That clearing is the fail-closed choice; it was observed working on the S25 build on 2026-10-23 (flag false after a disable, true across a real quit), but the owner has not explicitly confirmed the policy. The setting applies to phone control only. If the tailnet address is missing at launch, nothing listens. Pairing a new app always needs the desktop (below).
- **Phone typing switch.** A separate Settings switch, "Allow phone typing", is on by default and persisted in `control-settings.json` (the `phoneTyping` boolean). It is independent of the PHONE CONTROL toggle (a user disable of phone control leaves it as set) and asks no confirm, including when it goes back on. When it is off, every `in` frame is answered with `nak typing-off` and nothing is written to a terminal; it takes effect on the next frame of an already-open socket, and the phone is not told in advance that typing is off. Watching terminals is unaffected.
- **Phone alerts switch (built).** A separate Settings switch, "Phone alerts", is default OFF, asks no native confirm, and is persisted in `control-settings.json` (the `phoneAlerts` boolean). It is independent of the PHONE CONTROL toggle, but the alerts watcher runs only while BOTH phone control and the alerts switch are on.
- While only phone control is enabled, `/pair`, `/assets/*`, the chat page, `POST /api/pair` and `/ws` all return 404; enabling control never opens them (§16).
- `POST /api/device/pair` is unauthenticated and answers whenever control is on (404 when it is off); it can succeed only while a pairing code is active (otherwise 401; 429 once the code is burned or the caller's address is locked out; 409 while another pairing confirm is already open); it also answers 401, before any wrong-code counting, when control is on but the caller's address is not an IPv4 address (a leading `::ffff:` is stripped first; anything else is refused), and 403 for any `Origin` header, when the owner declines or times out the native confirm, or when control is disabled or quit while the confirm is open; the response contains the tokens (main and, phone alerts, planned and not built, alert) exactly once; neither is logged.
- **Alert sockets (phone alerts, built).** Alert-scope sockets are counted apart from the 2 control sockets (at most 2, so a reconnect overlap is not refused). An alert-scope socket is closed with `bye policy` on any verb except the `hello` handshake. The alert credential cannot open the viewer socket, and a main token cannot be used as an alert token (the scopes are separate stores).
- At most 2 live control sockets, counted separately from the 3 viewer connections (§16); at most 1 paired app (`CONTROL_MAX_DEVICES = 1`): pairing a new phone REPLACES the existing one, only after a native confirm that says so.
- HTTP and WebSocket, not TLS, inside the WireGuard-encrypted tailnet. The Android app connects to titan's tailnet IP, fixed at build time, with cleartext permitted to that one address only. No MagicDNS name, no `tailscale cert` (which would publish the tailnet hostname in public certificate-transparency logs). If the tailnet IP ever changes the app must be rebuilt.
- **Tailscale ACL (the owner's responsibility; Aether cannot enforce it).** Restrict `titan:47821` to the phone's node only, for example (placeholders, node names to be filled in at setup): `{"acls":[{"action":"accept","src":["<phone-node>"],"dst":["<titan-node>:47821"]}]}`. Without it any node the tailnet allows can reach the pairing endpoint; the token and the redeem-time confirm are what stop it.

**Auth.** Pairing code: 8 characters, memory-only, 5-minute TTL, single use, locked out per source address after 5 wrong attempts from that address, and burned for everyone after 15 wrong attempts in total (creating a new code lifts every lockout; the viewer-scope code keeps the global 5), issued only from a desktop click, plus a native confirm on the desktop at redeem time ("Allow this app to control your terminals?"), so a photographed QR is not enough. Token: 256-bit; only its SHA-256 hash is stored; sliding 30-day expiry, absolute 180 days; bound to the phone's tailnet source address; verified on the S25 on 2026-10-23: titan sees the phone's own tailnet IP (100.x) as the connection's source address, stored as `peer` and enforced on every device-token authentication. The phone holds the token encrypted under a hardware-backed key that requires a fingerprint to decrypt it on every cold open and after 60 seconds in the background; inside that window the app keeps the decrypted token in memory only and may reconnect silently once if Android drops its socket; "Lock now" and a revoked or expired token discard it at once. Revoke from the desktop (REVOKE and REVOKE ALL) takes effect at once and closes the socket; disabling control closes all control sockets but does not revoke.

**Alert credential (phone alerts, built).** The alert token is minted in the same pairing action (the redeem response also carries `alertToken` and `alertExpiresAtMs`), with the same rules: 256-bit, only its SHA-256 hash stored, bound to the peer address, sliding 30 days, absolute 180 days. It has its own store, is revoked by REVOKE and REVOKE ALL together with the main device, is replaced by re-pairing, and is unusable while phone control is off. **On the phone it is NOT behind the fingerprint:** it is stored under a Keystore key without a user-authentication requirement because a background service must read it (owner-approved decision). The main connection's fingerprint lock and its roughly 60 second background drop are unchanged. A phone that is lost unlocked or rooted therefore leaks the existence and kind of Alpha stops and nothing else; the kill switches are the same as above. A phone paired before this change must be re-paired once to receive an alert credential.

**On disk.** `~/.aether-os/remote-devices.json`: `{"v":1,"sessions":[{"hash","createdAtMs","expiresAtMs","lastSeenMs","peer"}]}` and nothing else (same field-by-field validator, size cap and atomic write as §16; `peer` is the phone's tailnet address). Plus (phone alerts, built) `~/.aether-os/alert-devices.json`, the same shape as `remote-devices.json`, holding the alert credentials; the phone stores the alert token encrypted under a Keystore key that needs no user authentication. Plus `~/.aether-os/control-settings.json` = `{"v":1,"reenableAtLaunch":boolean,"phoneTyping":boolean,"phoneAlerts":boolean}` and nothing else (the three persisted booleans; `phoneAlerts` defaults to false and is true only when the stored value is `=== true`; a user disable from Settings clears only `reenableAtLaunch`, and quit clears neither). No keystrokes, output, prompts, tokens, pairing codes or summaries are ever written, by the app or in `diag.log`.

**In memory only.** Per terminal: a headless screen mirror (at most 2000 lines) and a 256 KB output ring. Both exist for each running terminal slot for the app's lifetime, because main itself holds a read on the hub from startup so the desktop window can be repainted after a reload (renderer reload or a new window). That desktop hold is in-memory only: the mirror is never logged, stored or sent anywhere except to the desktop window on a re-attach, and a phone reads it only while phone control is enabled. Both are cleared at quit (main drops its hold in `before-quit`; phone control drops its own when disabled, which on its own no longer clears them), and a slot's mirror and ring are cleared when that slot exits and recreated when it starts again. A slot's final screen is therefore not retained after it exits: a phone that attaches afterwards gets an empty terminal and the state `exited`. Revoking a phone closes its socket but does not itself clear them; only quit does. If the hub cannot take its read hold it logs `control: terminals unavailable` and control stays on with no mirror, so a phone gets empty snapshots. The 256 KB budget for the ring and for a snapshot is measured on the JSON-escaped length, not the raw bytes. The thread ring (at most 200 events, with the working state) exists while at least one socket is thread-attached, and (phone alerts, built) also while the alerts watcher is running, which is while phone control is on AND the alerts switch is on, even with no phone connected; it is dropped on the last detach when the watcher is not running, when control is disabled and at quit; it is never written to disk or `diag.log`. The alerts watcher keeps only the last Claude message of the current turn (to classify it), a debounce timer and a set of at most 64 prompt ids, in memory; only a label leaves it. The Ledger feed holds no copy of its own: it re-reads main's existing in-memory ledger cache on each delivery and keeps only the list of attached sockets, so nothing about it persists once a socket detaches or closes, and it is never written to disk or `diag.log`. The pending-prompt registry (tool, risk, summary, expiry) holds each prompt only until it is answered on the desktop or expires, and is likewise memory-only. The generic view channel keeps only, per socket, the set of attached view ids and each attachment handle; it holds no payload of its own, so nothing persists once a socket detaches or closes, and view payloads and parameters are never written to disk or `diag.log`. The Projects feed likewise re-reads main's existing project and Ledger caches on each delivery and keeps only its list of attached sockets. The Memory feed re-reads memory.db (read-only) on each delivery and keeps only its list of attached sockets; the memory text it sends is never written to disk or `diag.log`. The renderer publish bridge (`phoneView:publish`, accepted only from the main window's main frame) lets the desktop window hand main the payloads it derives for views that cannot be built in main. Main holds only the latest payload per view id, in memory, at most 128 KiB serialised each; it is not written to disk or `diag.log`, it is ignored while phone control is off, and it is cleared when control is disabled and at quit. The bridge is a mechanism only: a payload reaches a phone only through a registered view's own encoder and Exposed bullet; the views that use it so far are `dash`, `analytics` and `agents`. Per-device input counters (the last applied `c` for each of the three slots, for one device) are held in memory only and are replaced when the app reconnects with a new epoch.

**Visibility.** A warning-coloured top-bar chip (`PHONE CONTROL - connected`) while an app is connected, and a separate warning-coloured block in the Settings remote-access card (toggle with its native confirm text, PAIR AN APP with QR, code and a 5-minute countdown, PAIRED APPS list with REVOKE and REVOKE ALL). Phone alerts (built) add a Settings "Phone alerts" switch (default OFF, no native confirm) and the phone's persistent "Aether watching" / "Aether not connected" notification. `diag.log` gets metadata-only fixed-string lines, none with content:

Control lifecycle:
- `control: enabled`
- `control: disabled`
- `control: listener unavailable reason=<reason>`
- `control: paired`
- `control: revoke after-approval-race`
- `control: revoke all`
- `control: revoke one ref=<ref>`
- `control: connect ref=<ref> peer=<tailnet address or unknown>`
- `control: disconnect ref=<ref>`
- `control: hello accepted ref=<ref>`

Input:
- `control: first input slot=<id> bytes=<n>` (the first input a connection applies)
- `control: input rejected slot=<id> reason=<not-running|typing-off>` (typing that was refused; once per connection and reason)
- `control: input rate limit` (the socket is then closed)

(The input lines above each carry `ref=<ref>`.)

Attach and detach:
- `control: attach slot=<id> mode=<snap|resume>` (written when the first frame of that attach is sent)
- `control: detach slot=<id>` (only when an attachment existed; a socket closing detaches silently)
- `control: terminals unavailable`
- `control: thread transcript unreadable` (the pinned transcript cannot be read; logged once per outage, fixed string with no path or content)
- `control: thread attach` (slice 1)
- `control: thread detach` (slice 1)
- `control: ledger attach`
- `control: ledger detach`
- `control: view attach v=<id>`
- `control: view detach v=<id>`
- `control: alert sent kind=<finished|question|input>` (phone alerts; written once per alert that reached at least one phone)

(Attach and detach carry `ref=<ref>`; the view lines also carry the view id from the closed list, never the parameters; for the Projects, Memory, Dashboard, Analytics and Agents views they read `control: view attach v=projects`, `control: view attach v=memory`, `control: view attach v=dash`, `control: view attach v=analytics`, `control: view attach v=agents` and the matching `detach` lines. The Memory feed adds no log line of its own.)

Channel violations (each with `ref=<ref>`):
- `control: hello deadline expired`
- `control: oversize frame`
- `control: invalid frame`
- `control: repeated hello`
- `control: unhandled frame type`
- `control: attach before hello`
- `control: detach before hello`
- `control: no terminal port`
- `control: thread before hello`
- `control: no thread port`
- `control: ledger before hello`
- `control: no ledger port`
- `control: view before hello`
- `control: no view port`
- `control: input gap`
- `control: invalid input`
- `control: input before hello`
- `control: no input port`
- `control: input to unattached slot`
- `control: input failed`

Store and settings:
- `control: device store save failed`
- `control: settings write failed code=<code>`

Listener and 401 reasons:
- `remote: control client connected n=<count>`
- `remote: control client disconnected n=<count>`
- `remote: control reject reason=<reason>`
- `remote: control recheck reject reason=<reason>`

The reject reason is one of no-device, no-bearer, unknown, expired, peer-mismatch, error. `<ref>` is the first 12 hex characters of the token's SHA-256 hash, never the token. Quit adds `[diag] control stop failed at quit` and `[diag] control device store not saved at quit`. The app does not log prompt decisions. No typed bytes are ever logged: input lines carry the slot and a byte count or reason.

**Limits, stated plainly.**
- The unlock window on a lost phone is real. Kill switches: revoke from the desktop, or disable the device in Tailscale.
- Works only while the machine is awake with Aether open; with re-enable at launch it also recovers after a restart, but nothing wakes the PC.
- Terminal output is not masked, so a secret that appears on the terminal appears on the phone. The same holds for the thread and the prompt summaries: they show what the transcript and the permission hook show, secrets included. The Ledger carries no text, only cost and token numbers derived from transcripts. The Memory view does carry text: `maskSecrets` and the length caps are a floor, not a guarantee (a secret in a form the masker does not recognise, or split across the cap, can reach the phone), and memory entries are the owner's own decisions and overrules.
- Treat it as R3: a connected, unlocked phone is the owner's keyboard.
- Phone alerts (built) are best effort: Doze or battery saving can delay a foreground-service socket, and delivery latency is NOT yet measured and is not promised. An alert is dropped, never stored or replayed, when no phone is connected. The label can be wrong; a wrong label costs a glance and exposes nothing. A permission prompt raises an `input` alert only when it is routed through Aether's `PermissionRequest` hook (`scripts/aether-permission-hook.mjs`), which acts only for Aether's tracked session (`~/.aether-os/own-session.json`) and which no shipped flow installs: `installPermissionHooks` in `collector/src/hookInstaller.ts` can register it, but no CLI command or app code calls it (`install-hooks` does not), so it has to be added to `~/.claude/settings.json` by hand. Without the hook a native Claude Code prompt raises no alert, and this path was NOT verified on the device. A permission prompt is not attributed to a slot (the hook acts only for the session in `own-session.json`, which need not be Alpha, and a prompt auto-allowed by risk raises no alert), so "Terminal Alpha needs input" can come from another, non-Alpha Claude session (accepted limit). A phone paired before this change must be re-paired once to receive an alert credential.
- A revoke takes effect in memory at once and closes the app's sockets, but it must also be written to remote-devices.json (and, phone alerts, to alert-devices.json). If either write fails (disk full, a file lock), Settings shows "Revoke not saved to disk yet" and Aether retries (3 times, 5 s apart, again before the next enable, and once at quit). If every attempt fails and Aether then restarts, the revoked app is paired again because the file still lists it, and with "re-enable phone control at launch" on it can reconnect without a new pairing; its main token still sits behind the phone's fingerprint-gated key and must come from its recorded tailnet address. The fingerprint-gated claim covers the MAIN token only: under phone alerts the alert token is NOT behind the fingerprint, so a revoked phone whose alert revoke did not save keeps receiving alerts after a restart, from its recorded tailnet address, until the revoke saves or the device is removed in Tailscale. The "Revoke not saved to disk yet" notice (provisional ruling, not device-verified) covers either store failing: one notice, cleared only when both writes have succeeded. When the notice shows, keep Aether open until it clears, or disable the device in Tailscale. Not fixed in V1: every remedy writes to the directory whose write just failed, and a durable revoke list would be a second storage layer.

**Guarded by.** `electron/control/controlBoundary.test.ts` (imports, input sink, message allow-list, escape hatches, file set for `electron/control/`), alongside `electron/remote/noWildcardListener.test.ts` (which also keeps `electron/remote/` free of any pty or write path and every wildcard bind out of `electron/` and `scripts/`).

---

## 18. Voice gateway over Tailscale — the second opt-in listener and a model-launch boundary

Added with the voice gateway (milestone 1, 2026-10-31; spec `~/.claude/handoffs/aether-os/2026-10-31-voice-gateway-m1-spec.md`, outside the repo). It lets a paired phone on the owner's own tailnet speak or type to a Claude session running on this PC and hear or read the reply. It is a **second deliberate, opt-in listener** (after §16/§17) and a **new model-launch boundary**: enabling it makes Aether start a `claude -p` child under the owner's Claude login. Code: `electron/voice/`; the settings card is `VoiceGatewayCard.tsx`. This milestone has no speech-to-text, text-to-speech, Android client or memory feature; the phone side is a contract only.

**What a paired phone can do.** Send a text turn (up to 4000 characters) to a single Claude session on this PC, interrupt it, and answer its permission requests with an explicit approve or deny. This is a conversational channel with the session's tool permissions, not a read-only view: a connected phone can make Claude run tools exactly as a terminal session could, bounded by those permissions and by the tap-to-approve rule. The child is started with `--permission-mode manual`, so a tool call that needs permission raises a request that the phone must answer; the request is denied automatically after 60 seconds, or at once when no phone is connected. Without that flag, a live probe (CLI 2.1.316, 2026-10-31) showed the owner's own Claude settings auto-allowing Write and Bash with no request, which is why `manual` is pinned; with it, the one probed tool (a Write outside the working directory) raised a request. Whether every tool and every owner permission rule behaves the same under `manual` has not been checked. Classify it as R3, like §17: a connected, paired phone can direct a model that can act on this machine.

**What is exposed back.** Masked spoken text and one masked display block of Claude's reply; the **names** of the tools Claude used (masked and cut to 40 characters); and one-line permission summaries. A summary is `<tool>: <hint>` cut to 160 characters and masked: the hint is the first 80 characters of a command string (masked first), or the file name of a `file_path` or `path` value, not the full path. Never tool inputs beyond that, tool results, thinking blocks or transcript files. A command hint can still contain a path or an argument the agent chose.

**Masking.** Every spoken unit and the display block go through `maskSecrets` before they leave `electron/voice/` (`speechFilter.ts`, `voiceGateway.ts`), so no logged event, resume buffer entry or wire message holds reply text that has not passed `maskSecrets`. The masker is pattern-based and conservative ("obvious secrets", not a DLP), with the known limits listed at the top of `src/shared/board/text.ts`. The filter releases text only in whole units (a newline, or a sentence end followed by whitespace) so a secret split across streamed deltas is masked as one piece, and it avoids cutting between a secret label and its value. The residual limit: a stretch of more than 300 characters with no sentence break is force-released at its last safe whitespace (at 16 KiB if it has none), so a secret shape longer than that can straddle the cut. A PEM block is held whole up to 16 KiB. Spoken text ends at the unit that reaches 600 characters, or at a line containing only `---`; the rest of the reply is the display block, cut to 4000 characters. Message bodies are masked but not path-shortened, so a path the agent wrote in a reply is visible to the phone. The system prompt also tells the model never to read out keys, tokens or passwords; that is a request to the model, not a control.

**Boundary.**
- Its own listener, separate from the §16/§17 one: port 47822 (`VOICE_PORT`), bound to the Tailscale IPv4 address (`100.64.0.0/10`, found by interface name) via `findTailnetAddress()`; no host is configurable. `assertBindableHost` refuses anything else (it also accepts 127.0.0.0/8, for tests). If no tailnet address exists, enabling reports "unavailable" and nothing listens. It never falls back to `0.0.0.0`, `::` or a LAN address.
- **Off at every launch.** Whether it is enabled is never persisted and there is no re-enable-at-launch setting. Enabling needs a native confirm dialog in the main process (default button Cancel) and a request from the trusted app window. Paired phones survive a restart; access itself does not.
- HTTP and WebSocket, not TLS, inside the WireGuard-encrypted tailnet. The session cookie is therefore not `Secure`; it is `HttpOnly; SameSite=Strict; Path=/` with a 30-day `Max-Age`.
- Every request and the WebSocket upgrade are checked against the bound address as `Host`, and **any request that carries an `Origin` header is rejected (403)**: browsers send `Origin` on WebSocket upgrades and cross-origin POSTs, so a web page cannot use this endpoint, and the `Host` check also blocks DNS rebinding; neither is a control against a local non-browser process. Only `POST /api/voice/pair` is public (a JSON body of at most 1 KiB); the `/voice` WebSocket needs a valid cookie. 10 s request and header timeouts. Responses are `no-store`.
- The `ws` server is `noServer: true`, with permessage-deflate off and a 16 KiB limit per message. The server admits at most 2 sockets (`maxClients: 2`, so a reconnecting phone is admitted while its half-dead old socket is still closing); the connection layer then keeps **exactly one live connection**: a new authenticated socket replaces the old one (the old one gets `error replaced` and close 4000). A third concurrent socket is refused with 503. A client is dropped for sending more than 20 pings per second (close 1008), for an unparseable message (close 1008), for a frame over 16 KiB (close 1009, from the ws library), for a binary frame (close 1003), and when its unsent backlog passes 1 MiB (close 1013). The client message set is closed at four messages: `turn.start`, `turn.cancel`, `permission.reply` and `resume`.
- Revocation is re-checked on every open socket every 30 seconds and at each revoke, so a revoked phone is disconnected (close 4001).

**Auth model.** The viewer profile of the shared pairing code, not the device profile of §17.
- A pairing code is 8 characters shown as `XXXX-XXXX`, held in memory only. It lives 60 minutes, works once, and is burned after 5 wrong attempts. It travels in the QR payload `aether-voice://<address>/?c=<code>` and is posted in a request body. A new code replaces the old one, and disabling clears it.
- Redeeming issues a random 32-byte token as a cookie; the server keeps only its SHA-256 hash. A session lasts 30 days absolute from pairing (not sliding), and at most 2 phones are kept: pairing a third drops the oldest.
- Disabling the listener does **not** revoke paired phones; they work again after the next enable without re-pairing. Settings → Purge does **not** delete the sessions file (it is auth configuration, not collected data); REVOKE ALL PHONES is the control.

**What the voice session stores on disk.** Two files. The session store, `~/.aether-os/voice-sessions.json`, shaped `{"v":1,"sessions":[{"hash","createdAtMs","expiresAtMs","lastSeenMs"}]}` and nothing else: `hash` is the SHA-256 of the cookie token. No token, no pairing code, no prompt, no reply, no replay content, no user-agent, no IP address. It is the same store as §16 (`electron/remote/sessionStore.ts`): every read and write passes each entry through a field-by-field validator and caps the list, a read ignores a file over 64 KB, and the write is atomic in the user-only `~/.aether-os/` (§7). `lastSeenMs` is saved at most every 5 minutes from activity alone. Settings → Purge leaves the file; REVOKE ALL PHONES keeps it with an empty list. `electron/voice/` opens no files itself (`voiceBoundary.test.ts` guards that); the second file is `~/.aether-os/diag.log`, which receives the fixed-format gateway lines described under "held only in memory" below, and Settings → Purge deletes it via the diag-log purge.

If a revoke cannot be saved, it still takes effect in memory at once and the status carries the fixed notice "Revoke not saved to disk yet". While the gateway is on, the save is retried up to 3 times, 5 s apart. **While the gateway is off, a revoke is a single attempt**: no timer is scheduled, and the unsaved revoke is retried only at the next enable and once at quit. If that save keeps failing, the entry can come back from the file at the next launch.

**What is held only in memory.** A replay buffer of at most 64 KB of already-masked events (so a reconnecting phone can resume after a drop), cleared on disable and quit and never written anywhere; it is not cleared when the Claude child restarts. Pairing codes and the live connection are memory-only too, as is the child's stderr, kept in an 8 KiB in-memory ring and never logged. The Claude session's own conversation context lives in the child process and goes with it. Each child start sends a one-word "ready" prime turn to the model, which is a billed model call on first connect. Prompts and replies are never logged by Aether: `diag.log` lines for the gateway are fixed-format lines carrying only the tailnet address, connection counts, a connection reference, state names and an exit code.

**Model-launch facts.** Enabling does not start Claude. The child is started lazily when the first authenticated connection attaches, then supervised for the rest of that enabled run (restarted with a back-off after a crash, and marked down after repeated failures). It is a `claude` process launched by `electron/voice/voiceSession.ts`, the only file in that directory that imports `child_process` and the one allow-listed for it in `src/shared/noApiCalls.test.ts`, with no shell and a hidden window, and a fixed argument set: `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --model sonnet --effort medium --strict-mcp-config --no-session-persistence --permission-mode manual --permission-prompt-tool stdio`, an appended system prompt, and `--settings {"disableAllHooks":true}`.
- **Hooks disabled.** Launched with `--settings {"disableAllHooks":true}`, whose documented effect is that no hook runs for this session, collector and permission hooks included. This is not checked directly on a live run; the evidence is the flag and its documented effect.
- **No transcript.** `--no-session-persistence` is meant to keep the conversation out of `~/.claude/projects` (the opt-in live test checks only the tmpdir-derived project folder under `~/.claude/projects`), where Aether's trackers and memory extraction look. The cost is that a crash loses the conversation context: the client is told the session is restarting.
- **No MCP servers.** `--strict-mcp-config` with no config loads none.
- **Environment.** Built only from the allowlist in `buildAllowlistedChildEnv` (OS basics such as `PATH`, `HOME`, `APPDATA`, `TEMP`), so no `ANTHROPIC_*` or `OPENAI_*` variable is inherited and the session runs under the owner's Claude login; Aether adds only `AETHER_STATUSLINE_NO_PERSIST=1`, so the statusline script does not write a snapshot for this session. The working directory is the OS temp directory.
- **Stop.** At disable or quit the child gets stdin closed, then a forced `taskkill /T /F` of its tree after a 400 ms grace and another 400 ms wait; the stop runs inside the app's held quit (bounded at 1.5 s), concurrently with the listener stop.
- **Billing and visibility.** Prompts go to Anthropic under the owner's Claude Code login, like the embedded terminal. While it runs, the child may appear in `claude agents --json` (which the collector's `fleetPoll.ts` polls), so it can show up in fleet views; this has not been checked on a live run.
- No Aether code path summarises, stores or forwards the conversation anywhere else.

**Visibility.** The Settings card `VOICE GATEWAY (CLAUDE ON THIS PC)` has the ENABLE/DISABLE button, PAIR A PHONE (QR, code and a countdown, hidden on Done, expiry or unmount; the code stays valid until used, replaced, disabled or expired), and a PAIRED PHONES list (short reference and timestamps only) with per-phone REVOKE and REVOKE ALL PHONES (both work while off). Outside the desktop app (no bridge) the card says "Available in the desktop app".

**Limits, stated plainly.**
- It works only while the machine is awake with Aether open; closing the main window quits the app and ends the voice session.
- Any tailnet device that the tailnet ACLs let reach this machine's port 47822 can reach the pairing endpoint; the pairing code or a paired cookie is what stops it. The ACLs, and a host firewall rule scoped to the tailnet range, belong to the owner.
- A lost or stolen paired phone keeps access until its 30-day expiry or a revoke from the desktop; there is no remote kill switch.
- Anyone holding a valid cookie can connect and, because the newest connection wins, replace the paired phone's live connection; with both of the 2 paired slots in use, either cookie can do so.
- A revoke made while the gateway is off, with a save that keeps failing, is attempted once (see above).
- Masking is best effort (above). A secret in an unknown shape, a path the agent wrote in a reply, or a command fragment in a permission summary crosses the wire.
- Treat it as R3-class: a pairing code or a paired phone is a password to a model that can act on this PC.

**Guarded by.** `electron/voice/voiceBoundary.test.ts` (one `listen(` call after `assertBindableHost`, `noServer` WebSockets, one `claude` launch with the pinned flags, no disk writes, no pty or Electron value imports, no wildcard literal, no `process.env` spread, closed client message set), alongside `electron/remote/noWildcardListener.test.ts` (which keeps every wildcard bind out of `electron/` and `scripts/`) and `src/shared/noApiCalls.test.ts` (which allow-lists `voiceSession.ts` as a `claude` launch site).

---

## 19. Terminal board (Alpha/Beta coordination file) - local files only, no listener

Added with S3 of the terminal identity work (2026-11-05). It lets the agents in Terminal Alpha and Terminal Beta see what the other is working on so they do not collide. It is two small local files and nothing else: no listener, no IPC channel, nothing sent over the tailnet, nothing in the phone view. Code: `src/shared/terminalBoard.ts` (schema, validation, staleness) and `electron/terminalBoard.ts` (read and reset).

**What is stored.** `~/.aether-os/terminal-board/alpha.json` and `beta.json`, one per terminal. Each holds a schema version, the terminal name, an `updatedAt` heartbeat, a `task` (title, project, status: working, idle, blocked or waiting-on-user) or null, a list of claims (kind: pr, branch, worktree or file; a ref; a `since` time; an optional note) and a list of `blockedBy` (a ref and which terminal owns it).

**Signal, not payload.** The limits are enforced when a file is read: title up to 120 characters, project up to 80, ref up to 200, note up to 200, at most 50 claims and 50 blockedBy entries. A ref is a PR number, a branch name or a project-relative path, never an absolute path (a ref that starts with a drive letter, `/`, `\` or `~` is rejected; so is a `file:` URL, or a ref with a `..` path segment). No prompts, no command text, no tool output. Strings with control characters (so no newlines) are rejected, and a file that breaks any rule is treated as invalid rather than trimmed.

**Who writes.** Aether's main process writes only an EMPTY entry (no task, no claims), when a terminal's PTY starts and again when it exits. The Codex terminal has no board. The `aether-board` command (`scripts/aether-board.mjs`, shipped with the app) can fill an entry; it writes only the caller's own file (chosen from `AETHER_TERMINAL`), applies the same limits and path rules as the reader. The skill `skills/aether-terminal-board/SKILL.md` tells an agent in an Aether terminal to use that command.

**Identity.** Aether sets `AETHER_TERMINAL=alpha|beta` in the environment of the Alpha and Beta Claude terminals (`terminalIdentityEnv`, `electron/ptyManager.ts:77`) and of the connected-Claude launch; the Codex terminal gets none. A shell with no such value is not an Aether terminal and the CLI refuses to write. Aether also sets `AETHER_BOARD_CLI`, the absolute path to `aether-board.mjs` (`resolveBoardCliPath` in `electron/ptyManager.ts`: `resources/scripts` when packaged, `<repo>/scripts` in dev), for Alpha, Beta and the connected Claude only, only when that file exists, and never for Codex. It is a path: no prompt content and no board data. The path can contain the OS username, and like every other environment variable in that shell it is visible to any local process that can read the shell's environment. Checked live on the installed 0.7.4 build on 2026-11-06 (S6): Alpha printed `alpha` and Beta `beta`; `AETHER_BOARD_CLI` resolved to `resources\scripts\aether-board.mjs` in Alpha and the quoted backslash path ran (`ls`, `whoami`); a claim conflict returned exit 3 with nothing written; the board files held no absolute paths while claims were live; and `AETHER_BOARD_CLI` was empty in the Codex terminal. Not checked: `AETHER_TERMINAL` in the Codex terminal, and Beta's own `echo` of `AETHER_BOARD_CLI` (its board commands ran through the CLI, so it was set).

**How the skill gets to an agent.** The skill is versioned in the repo and installed by copying it to `~/.claude/skills/aether-terminal-board/` (user scope); nothing in Aether installs it, same as `aether-cross-check` (section 13). Installation is a local file copy, not proof that a client discovered it. No global always-on rule exists; the skill's description is its trigger. The CLI ships in `resources/scripts` in a packaged build (no packaging change was needed). The skill uses `$AETHER_BOARD_CLI` when it is set and the file exists, and falls back to its own lookup (git toplevel, then the installed-build default) on older builds that do not set it.

**Known limit: the folder ACL.** The CLI creates `~/.aether-os/terminal-board` with `mkdirSync(..., {recursive:true, mode:0o700})` (`scripts/aether-board.mjs`, `persist`). On Windows the mode bits do nothing, so if the CLI is run (with `AETHER_TERMINAL` set by hand) before Aether has ever created `~/.aether-os`, the folder gets the profile's default ACL instead of the user-only ACL of section 7. Aether applies the user-only ACL to `~/.aether-os` at every launch (`ensurePrivateDir(aetherOsDir)`, `electron/main.ts:966`; it writes only when the ACL is missing, see the `electron/privateDir.ts` header), so the gap closes the next time the app starts. Inside an Aether terminal the app has already started, so this only affects a hand-run CLI. Verified by reading the code; not reproduced on a clean profile.

**Who reads.** Any local process running as you. The file is readable by any process running as the user; there is no access control beyond the folder's. Aether itself has a read function (`readTerminalBoardSnapshot`) but no screen or IPC uses it yet.

**At rest.** Inside `~/.aether-os`, so the user-only protections described in section 7 apply. Writes go through the same atomic-replace helper as other Aether files.

**Retention and staleness.** An entry whose `updatedAt` is more than 4 hours old is treated as stale and its claims do not block. The files are reset on every PTY start and exit and are otherwise kept; Settings → Purge does not delete them. The board is advisory: nothing enforces it.

## 20. AFK standing terms and night state - local files, no listener, no model call

Added with AFK Phase 1 (2026-11-05). Phase 1 only prepares an overnight run and records what Matt approved; it does not run anything unattended. It is a Node command line tool (`scripts/afk/afk.mjs`, logic in `scripts/afk/`) plus a skill template (`skills/afk-preflight/SKILL.md`). No listener, no IPC channel, nothing in the phone view, and Aether's Electron code does not read or write these files.

**What is stored.** Four files in `~/.aether-os/afk/`. `terms.json` holds the standing terms (a version, window, push, merge, the review count, the Opus and Fable switches, notifications fixed at silent, and the barred delete and force-push flags). `draft.json` is the one draft, replaced wholesale by every `compile`: for each item an id, the project leaf name, kind, artifact, a title of at most 140 characters, its source (the kind of source and the file BASENAME, plus the item number `n` for a handoff item only; ledger and plan sources are just kind and file), a verdict with reasons, a confirmed flag and, if it names a plan, a `planRef` (the plan's basename and a `specApproved` flag); plus the night's amendments and warnings (project names and basenames). `approved.json` is the one approved record: night id, approval time, target window start, the standing and the effective terms, the amendments, the confirmed items (id, project, kind, artifact, title, source), the held items (id, title, verdict, first reason), the allowlist, a `via: tty` label and the record's own SHA-256. `last-approved.json` is a pointer to it (night id, record hash, approval time).

**Signal, not payload.** The fields AFK composes itself are names, ids, hashes and flags: the `source` and `planRef` basenames, the compiler's warnings (project names and basenames), `projects`, and the generated title of a plan item, `Execute plan <basename>`. Any other title is COPIED text: the first 140 characters of a handoff Next-steps item (continuation lines joined before the cut) or of a ledger todo line, with whitespace collapsed and the list number or the `- [todo]` / `- [pending ...]` prefix stripped. It is not masked or scrubbed, so it holds whatever the source line holds, including an absolute path or a secret, and it is stored in `draft.json` and `approved.json`. The one absolute path AFK composes into a file is the `afk.mjs` path rendered into the installed skill (below). The reader refuses a JSON file over 1 MiB.

**The feasibility probe.** For build items it checks that named keys and paths are present; it does not print, return or store a key's value.

**No network call, no model call.** The CLI imports Node built-ins (`fs`, `path`, `url`, `crypto`, `os`, `readline`) and starts no child process, so it launches no `claude` and makes no API call of its own. `scripts/afk/afkBoundary.test.ts` fails on a `child_process` import, a listener, `fetch`, `node:http` or `node:net`, and on a file write outside the two reviewed writer modules (`fsJson.mjs`, `installSkill.mjs`) or a delete outside `fsJson.mjs`.

**Who can write, and why the TTY check is a drift guard.** The four verbs that change state on Matt's behalf (`terms set`, `amend`, `confirm`, `approve`) refuse with exit 3, before reading or creating anything, unless both stdin and stdout are a terminal, and `approve` also needs the exact phrase `APPROVE` plus the first 8 hex digits of the effective terms' hash typed back. That guards against accident and drift; it is not a sandbox: a process that can write the folder (an editor tool, a shell redirect, a real terminal) can write these files directly. `compile` (which replaces the draft), `install-skill` and the read-only verbs are not TTY-gated. Matt's T13 probe note (`~/.claude/handoffs/aether-os/2026-11-04-afk-phase1-live-check.md`, 2026-11-05; not checked by code) records that the `!` escape inside an Aether terminal has no TTY, so the gated verbs are run in a plain PowerShell window. The record's hash and the pointer detect accidental or partial edits only; someone who rewrites both with valid hashes is not detected.

**The deny rules: UNVERIFIED as enforcement.** `afk deny-rules` prints two groups of Claude Code permission rules, and Phase 1 installs neither. The `protect` group is four path rules that Matt would paste into his global `~/.claude/settings.json` himself: `Edit(~/.aether-os/afk/**)`, `Write(~/.aether-os/afk/**)`, `Edit(~/.claude/away*)` and `Write(~/.claude/away*)`. The `run` group is Phase 2's per-run disallow list and is NOT installed globally, because it is meant to block ordinary delete and worktree-cleanup work in every session: `rm`, `rmdir`, `del`, `rd`, `erase`, `Remove-Item`, `ri`, `git clean`, `git rm`, `git branch -D`, `-d` and `--delete`, `git worktree remove` and `prune`, `git push --force`, `-f`, `--force-with-lease` and `--delete`, and the exact forms `git push origin HEAD:master` and `HEAD:main` (all as `Bash(<command>:*)` prefix rules), plus `Bash(git push:*)` when the push term is off and `Bash(git merge:*)` and `Bash(gh pr merge:*)` when merge is off. Neither group may be described as protection yet: whether they block anything is UNVERIFIED until Matt's live check M2 has been run and its result recorded. The `run` rules are `Bash(...)` rules, and whether those cover this machine's PowerShell tool is also UNVERIFIED until M2, so Phase 2 may need mirrored PowerShell rules. Prefix rules may miss some spellings of a force push, a branch delete by push or a push to master (for example `+main`, `:branch`, `origin main --force`, `HEAD:refs/heads/master`); the plan names an outside layer, the cc-safety-net hook (plan read 2026-11-04), which is not in this repo and is unverified until M2b.

**The allowlist is data.** The approval record stores a list of `Bash(...)` allow rules (a fixed set of `git` and `gh` commands (`git status`, `diff`, `log`, `show`, `rev-parse`, `merge-base`, `fetch` and `gh pr` / `gh run` view-type commands), `git push` when the push term is on, `git merge --ff-only` when merge is gated, and the command prefix of each confirmed build item's recipe), so Phase 2 uses what Matt saw at approval. Phase 1 does not install or enforce it, and how a headless run treats it is UNVERIFIED until Matt's live check M5.

**The skill install.** `afk install-skill`, run by Matt, writes one file, `~/.claude/skills/afk-preflight/SKILL.md`, rendered from `skills/afk-preflight/SKILL.md` with the absolute path of this machine's `afk.mjs` substituted in. An installed build is meant to ship the template in `resources/skills/` (`docs/packaging.md` section 1; UNVERIFIED until T21 M3).

**Retention and removal.** The `afk` folder is kept until Matt deletes it. Settings -> Purge clears collected data and the diagnostic log (`electron/main.ts`, `retention:purge`) and names no AFK path.

## 21. PTY owner helper - a detached local process that can outlive the app

Off by default. It runs only when `AETHER_PTY_OWNER=1` is set in the environment on Windows (`ptyOwnerEnabled`, `electron/main.ts`); without it nothing in this section exists and the three terminals are in-process exactly as before.

**What it is.** A second, detached process: `Aether OS.exe` started with `ELECTRON_RUN_AS_NODE=1` running `out/main/pty-owner.js` (`electron/ptyOwner/ownerEntry.ts`, `ownerCore.ts`). It owns the Claude, Terminal 2 and Codex shells so a main-process restart (dev reload, crash) does not kill them; the restarted main finds the helper and adopts the running slots (`electron/ptyOwner/adopt.ts`). Adoption at startup does not call `aetherChoice.onForeignLaunch`. A connected-session spawn stays in-process and is never helper-owned.

**It can outlive the app, with the sessions it owns.** If the app dies without a deliberate quit (crash, `taskkill /F` of the main process), the helper and the shells it owns keep running for a grace window of 15 minutes (`AETHER_PTY_OWNER_GRACE_MS`, default set by `ownerLauncher.ts` and `ownerEntry.ts`), then tear down. A Task-Manager end-task of only the main `Aether OS.exe` leaves the helper's `Aether OS.exe` process in the list until the grace window ends (plain node parent measured in the spike; the packaged route is UNVERIFIED). A deliberate Quit ENDS the terminals: `PTY_OWNER_ON_QUIT = 'shutdown'` (`electron/main.ts`) sends `shutdown` to the helper. Changing that constant to `'release'` would instead leave the sessions running for the grace window; it is not changed by any setting. Updates and uninstalls are meant to end the helper too (see `docs/packaging.md`; UNVERIFIED until the live T8 report exists). A Quit that begins while the helper is still launching can leave an empty helper (no shell) running until its 30 s idle timer (`IDLE_EXIT_MS`, `ownerCore.ts`) expires; no shell leaks.

**The listener is a local named pipe, not a network listener.** It is a `\\.\pipe\...` endpoint (the one reviewed entry in `electron/remote/noWildcardListener.test.ts`), reachable only on this machine, with no TCP port, no tailnet or LAN bind and no `0.0.0.0`. It is a different class from the reviewed tailnet binds (§16-18). Every verb except hello/auth needs a mutual HMAC proof (`electron/ptyOwner/protocol.ts`).

**Discovery file.** `~/.aether-os/pty-owner-<8 hex of the userData hash>-p<proto>.json` holds three things: the pipe name, the helper pid and the secret. No terminal content, no paths of user content. Its protection is the user-only ACL on `~/.aether-os` (§7, `electron/privateDir.ts`); this section depends on that ACL. **The secret is equivalent to "run commands as the user":** the spawn spec's `writes` are typed into the shell, so anyone who can read the discovery file and speak the protocol can make the helper's shells execute arbitrary commands. Restricting the shell to `powershell.exe` does not narrow that.

**The raw ring.** The helper keeps up to 256 KiB (`RING_MAX`, `protocol.ts`) of raw terminal output per slot in memory only, so an adopting main can repaint. It holds terminal output, so it is the same sensitivity as the §11 terminals and the hub ring. It is cleared when the slot exits or the helper exits, and is never written to disk, logged or sent anywhere except over the local pipe to the authenticated main.

**Helper environment.** The helper's own environment is a minimal allowlist (`minimalHelperEnv`, `ownerLauncher.ts`; never a `process.env` spread): the three `AETHER_PTY_OWNER_*` settings, `ELECTRON_RUN_AS_NODE` and a short list of system variables. The shells get the spawn spec's `env`, the same environment the in-process path builds (§11, §19); an env over 32 KiB (`ENV_MAX_BYTES`) is refused and that spawn runs in-process.

**Diagnostics.** Helper-related lines in `diag.log` are fixed strings with two variable tails: `pty-owner error <code>` (helper-supplied, validated to `[a-z0-9_-]{1,64}` in `protocol.ts`) and `pty-owner connection lost: <reason>` (a fixed word, or `discovery file <errno code>`, e.g. `ENOENT`, when the discovery file cannot be read on reconnect; the path and Node's error text are never logged). Never terminal output, env, secrets or discovery contents.

**Accepted residual.** An old pty's in-flight frame can reach a re-spawned slot (a sub-millisecond race; fixing it needs a protocol generation field). The feature is OFF, so this is accepted for now.

**UNVERIFIED / UNEXERCISED until the live T8 report exists:** the packaged launch of the built ESM file from the asar tree, survival of a Quit-less main death (`taskkill /F`, crash) from the packaged app, cold-start latency of the helper, whether the resize nudge repaints a full-screen TUI after adoption, and the typical Windows env size against the 32 KiB cap. The only measurements behind the design are the earlier spike results (a plain `node` helper: a hard-killed parent left a detached helper and its shell alive, and a hard-killed ConPTY creator took its shell down; Electron-as-node and the packaged route were not part of it).

Cross-references: §7 (the ACL the discovery file relies on), §11 (the terminals' open-ended access), §17 (phone typing reaches the same shells through the hub), §19 (terminal board env).
