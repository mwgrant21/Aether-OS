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

**Nothing leaves this machine. There is no exception.** As of Stage 13.5 (`docs/roadmap.md` §3.5),
there is no model call site anywhere in this codebase: the `@anthropic-ai/sdk` dependency is gone,
`chatCore.ts`/`claudeClient.ts`/`systemPrompt.ts`/`chatProxyPlugin.ts` and the `chat:*` IPC pair are
deleted, and `.env` key loading (`electron/loadDotEnv.ts`) is gone too — the app cannot read a key
from disk even if one exists. `Comms` (the renamed Chat tab) answers only through
`localResponder.ts`, a local, deterministic responder. No feature in this app makes a network
request, now or on the roadmap.

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

## 9. Correction to fix in `CLAUDE.md`

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
