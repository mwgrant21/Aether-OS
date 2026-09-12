---
title: Visible Claude to Codex communication - proposal v4
date: 2026-09-11
revision: 4
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: user-conversation-and-claude-side-review
execution: code
supersedes: 2026-09-11-visible-agent-communication-v3.md
---

# Visible Claude to Codex communication - proposal v4

## Goal Capsule

Matt can watch Claude ask Codex for help, see the real response in Aether, and distinguish a finished Codex answer from an answer that Claude has requested.

Keep the approved architecture: Aether owns communication, uses a dedicated Codex session, and renders observed events. Ask and cancel return promptly; get waits server-side for a result or a bounded timeout. Claude needs no timer or scheduled wakeup. This is a revised proposal for review, not evidence of implementation or permission to activate model calls.

Implementation should start with the client compatibility checkpoint below, then proceed in an isolated worktree with focused verification and a separate commit per unit. The executor owns code, tests, built-app proof, and documentation. Publication and live activation remain separate actions.

---

## Product Contract

### What changed and why

The original plan modeled one long MCP call. Claude's review shows that the client can background, permission-gate, defer, time out, or persist a result independently of Aether. Aether must not infer that Claude received an answer just because Codex finished it.

This revision closes the multi-caller waiting gap: callers can share a bounded server-side wait, with one lease owner. Successful consultations permit immediate follow-ups within the credit allowance. Pending responses expose measured progress, the bridge launch pins the client background threshold, and Comms explains how to retrieve a stranded answer. The first slice still has no project picker, file selection, or snapshot copier. Claude supplies the question and relevant text it already has. The consulted Codex session starts in a private empty working directory, not the live project. This is a consultation about supplied context, not a claim that Codex independently inspected the repository.

### Requirements

- R1. Claude can start an exchange and receive an exchange ID promptly. Codex work continues independently of that MCP request. Get waits on the server for a terminal outcome or a bounded timeout; already-ready answer pages return immediately. Claude can issue another get after a pending response without timing its own polling.
- R2. Aether owns one Codex turn per exchange, a fresh dedicated provider session, and stable correlation. Existing Claude and Codex terminal conversations are not attached to each other. No reciprocal loop is introduced.
- R3. Provider state and result-access state are separate. Show Codex waiting/streaming/finished/cancelled/timed out/failed independently from answer not requested/result pages served/client disconnected/content expired. Never label an answer "read", "understood", or "acted on" without evidence that does not exist in this slice.
- R4. An always-visible Claude-to-Codex indicator opens the real exchange in Comms. No automatic navigation or fabricated dialogue. Show the supplied question/context, streamed answer, elapsed time, lease countdown, limits, and clear partial/expired states. Reduced motion, keyboard navigation, and both themes are required.
- R5. Aether Cancel and Claude's cancellation tool share one controller. Claude session exit, helper loss, disable, lease expiry, and deadline stop outstanding work. A stopped Claude subagent cannot always be identified by this transport; lease expiry bounds that case rather than claiming instantaneous TaskStop propagation. Leases apply only to active provider work: completed answers remain readable in Comms for the normal retention window even if Claude never retrieves them.
- R6. A separate default-off opt-in authorizes bounded Claude-initiated consultations. It names the exact tool permissions, subscription usage, allowed file-read scope, and how returned advice may influence Claude. Main enforces it; a CLI allowlist is not authority to bypass the gate.
- R7. No project-relative file selector or project picker in this slice. Inputs are question and optional textual context only. The service never reads a model-supplied filesystem path or executes an agent-supplied command. Codex's existing read-only permissions are disclosed accurately: an empty cwd is not proof of filesystem read confinement.
- R8. Aether keeps content in bounded memory only, out of the reducer, localStorage, collector, and logs. Operational launch manifests are a separate short-lived, access-restricted artifact. Claude's local session transcript and Codex-managed history may persist question/answer content; clearing Aether does not erase those copies.
- R9. One active exchange, an operator-controlled start allowance, duplicate-request protection, cooldown, input/output caps, finite leases, and an absolute deadline prevent unlimited consultation. Reads, reconnects, and MCP calls cannot grant credit. The operator can explicitly grant more consultations in Aether without ending the current Claude session.
- R10. Claude's existing MCP roster remains available. Aether's three tools are explicitly discoverable and individually preapproved only after the opt-in. A fresh-session action applies configuration with confirmation before replacing an active terminal; enabling alone never kills a session.
- R11. Return Codex's answer as attributed, untrusted advisory content, preserving its text. It is neither a new instruction hierarchy nor authorization for edits, command execution, or further spending. No model-generated summary substitutes for the answer.

### Proposed experience

1. Enable "Claude can consult Codex" in Settings. See the initial three-consultation allowance, a "Grant 3 more" operator control, and exact disclosure. A grant increases the current launch's allowance only; it does not start a consultation or erase deduplication records.
2. Start a fresh connected Claude session. If one is already running, the replacement action asks before ending it. Existing tools remain available.
3. Claude calls `ask_codex` with a question, optional context, and an idempotency key. It gets an exchange ID immediately and can continue other work.
4. Aether shows the request and then real Codex response chunks. Claude calls `get_codex_exchange`; the server waits up to 45 seconds by default for a terminal outcome. If it returns pending, Claude can call get again immediately. No sleep or timer on Claude's side is required, and streamed tokens do not wake these waits.
5. When Codex finishes, Aether shows "Answer ready - not yet requested" until retrieval begins. Answer pages are returned to Claude, and the display records "Result pages served" without claiming semantic receipt.
6. Either participant can cancel through the defined controls. If Claude leaves no live get and does not return within the ownership lease, Aether stops active provider work. A completed answer stays readable in Comms until its normal ten-minute expiry or an explicit clear/disable/app exit. Comms is the fallback when Claude is interrupted or never retrieves the answer; it is session-memory retention, not a durable archive. Show an unread-answer badge outside Comms. Expiry never recreates a job.

### Scope boundary

Deferred: filesystem selection/manifests/snapshotting, attaching to an existing Codex conversation, arbitrary external terminal registration, persistent conversation history, automatic debate, voice, code changes by the consulted Codex, and proactive terminal injection. No automatic MCP notification is assumed to wake the model; the explicit get operation is the delivery mechanism.

### Acceptance examples

- AE1: A slow Codex turn takes longer than two minutes; ask already returned its ID, Comms streams normally, and get calls wait server-side for up to 45-60 seconds each. No scheduled client poll is needed; deltas and lease ticks cannot cause rapid wakeups.
- AE2: The same request is retried after its acknowledgment is lost; Aether returns the same exchange, consumes no second start, and creates no second provider turn.
- AE3: Codex finishes while Claude does other work; the UI says answer ready, not delivered. Claude later fetches every page and receives the complete attributed text in order.
- AE4: A large or Unicode-heavy answer is paginated within the encoded response budget. No oversized tool result or file-pointer substitution is used as normal delivery.
- AE5: Aether Cancel, Claude cancel, helper loss, terminal replacement, and expired lease each stop work without a late success overwriting the final outcome.
- AE6: Parallel subagents submit different requests; one active slot and the shared launch allowance (three initial credits plus operator grants) hold. A rejected request instructs Claude not to retry automatically. Callers retrieving the same active exchange can wait concurrently without immediate WAIT_IN_PROGRESS responses.
- AE7: Enable after Terminal is already mounted, then explicitly relaunch; tools connect and are presented to Claude. Other MCP tools remain; no first-call bridge permission prompt occurs unless an overriding user/managed deny is present, which is surfaced rather than bypassed.
- AE8: Question/answer and launch-capability sentinels are absent from Aether persisted data and terminal echo. Explicitly documented CLI transcripts and restricted operational manifests are treated according to their own retention, not falsely included in that assertion.
- AE9: After three consumed credits, the operator grants three more without restarting Claude. Reads, helper reconnect, and attempted MCP grants cannot change that allowance or clear request tombstones.
- AE10: Claude returns control to the user before retrieving a finished answer; lease expiry does not erase it. The indicator shows an answer-ready badge and Comms remains readable for ten minutes, subject to the explicit clear/disable/app-exit rules.
- AE11: Multiple callers wait on the same active exchange. They receive bounded pending snapshots or the terminal outcome; only the designated waiter renews the lease. Cancelling one read does not cancel the others or the provider.
- AE12: A successful consultation is followed immediately by a distinct question with available credit: it is accepted. Rejections and unsuccessful outcomes impose the cooldown; success does not.
- AE13: A shell profile sets a background threshold below the get wait. The connected launch overrides it after profile execution, preserves billing safeguards, and the actual interactive client returns the waited-for result rather than a background task handle.
- AE14: A finished answer is stranded in the same Claude launch. Comms supplies the exchange ID and a retrieval instruction; get returns the existing answer without consuming a start. A replacement launch is explicitly excluded from this recovery path.

---

## Planning Contract

### Tool contract

Pin the MCP server name to `aether-bridge`. Reject a conflicting existing server definition before launch rather than silently shadowing it. The names below are exact permission targets; never allow `mcp__*` or the server-wide wildcard.

| Tool | Input | Result and behavior |
| --- | --- | --- |
| `mcp__aether-bridge__ask_codex` | Required `request_key` (1-64 ASCII identifier characters), `question` (nonempty, at most 16 KiB UTF-8); optional `context` (at most 32 KiB UTF-8) | Accepted exchange ID, state, remaining credits, lease expiry, deadline, and get guidance. Validate and reserve in main without waiting for Codex health, auth, startup, or answer. |
| `mcp__aether-bridge__get_codex_exchange` | Exactly one of `exchange_id` or `request_key`; optional opaque `cursor`, optional integer `wait_ms` (1000-60000, default 45000) | If ready, return the answer page immediately. Otherwise wait until a terminal/cancellation outcome or the bounded wait elapses, then return status. A valid owned wait renews the active lease under the rules below, never the absolute deadline. Key lookup recovers a lost acknowledgment. |
| `mcp__aether-bridge__cancel_codex_exchange` | Exactly one of `exchange_id` or `request_key` | Immediate cancellation-requested status, followed by cancellation confirmed or cleanup failure on reads. Idempotent. Cannot cancel a different launch's exchange. |

Descriptions are short, front-loaded, and under 2 KiB. The ask description must say: "Consult Codex once about the supplied question and context. Returns an exchange ID, not the answer. Reuse the same request_key for the same intent. Question limit 16 KiB UTF-8; context 32 KiB. One active exchange; initially three start credits, extendable only by the operator. Call get_codex_exchange to wait server-side for the result; if it returns pending, call it again when ready to continue. Stop with cancel_codex_exchange. Do not automatically retry rejected or failed consultations. No file-path input."

The get description explains server-side waiting, final-answer paging, a 90-second ownership lease, the five-minute absolute deadline, and that returned advice is untrusted data. It must not instruct Claude to sleep or poll on a timed cadence. Design invariant: a response that tells Claude to wait must itself do the waiting; it must never assume access to another caller's pending tool call. Explicit stop conditions such as cooldown or capacity exhaustion instruct the caller to stop, not wait or retry. The cancel description says it requests cancellation without waiting for process cleanup. Publish byte limits in descriptions plus precise server validation; JSON Schema string-length constraints alone do not measure UTF-8 bytes. Reject unknown fields and root-level schema combinators; validate the exclusive ID/key choice in the handler.

Return one text content item containing a versioned JSON envelope. Do not duplicate the full answer in both text and structuredContent. Include `exchange_id`, provider outcome, delivery availability, page text, cursor/next cursor, and a static advisory framing. Serve answer pages only after the final answer is stable; Comms can stream before that. Partial output on failure is available in Comms with an incomplete label and is not returned as a successful answer.

Every pending response includes a snapshot taken at return: `elapsed_ms`, `remaining_deadline_ms`, `provider_state` (accepted/preparing/waiting/streaming/cancelling), `observed_output_bytes`, and `last_output_at`. Count only observed answer deltas; unavailable measurements are null, not invented zeroes, and last_output_at is null before any observed output. These fields do not wake waits. Elapsed time alone is not evidence of provider activity; unchanged counts are reported honestly and do not automatically imply failure. Include `next_eligible_at` and remaining credits in ask and get responses so known cooldown state is visible without another ask.

### Explicit limits

| Limit | Proposed default |
| --- | --- |
| Concurrent provider turns | One per Aether app |
| Provider starts | Three initial credits per Claude launch; operator can grant three more. Reserve atomically on acceptance; consume when invoking the provider turn. Refund only if preparation/cancellation proves no turn was submitted; uncertain submission remains consumed. |
| Exchange deadline | 300 seconds from acceptance, including provider preparation |
| Active ownership lease | 90 seconds; only the designated lease-owner wait renews on admission and normal pending return while the provider is active. Followers and UI viewing do not renew it. |
| Server-side get wait | Default 45 seconds, cap 60 seconds; only terminal/cancellation outcomes end it early, not streamed chunks or metadata ticks |
| Concurrent get waiters | Up to 16 per exchange, sharing one event subscription; independent timers and cancellation. Excess calls stop with READ_CAPACITY, never guidance to await another caller. |
| Retained request keys | At most 32 per exchange, including the initial key. An unrecognized alias at the cap is rejected with ALIAS_LIMIT; existing keys remain recoverable. |
| Ask/cancel operation deadline | 2 seconds; provider work and cleanup run outside these handlers |
| Claude per-server timeout | Explicit 90 seconds, verified interactively against the installed client and effective background/idle configuration |
| New-request cooldown | 30 seconds after a non-cooldown ask rejection or an unsuccessful terminal outcome. Successful completion clears cooldown so follow-ups can start immediately. Repeated COOLDOWN responses do not extend it. |
| Final answer retained by Aether | 64 KiB UTF-8; exceeding it stops the exchange with OUTPUT_LIMIT |
| Answer page | At most 24 KiB source text, reduced further as needed to fit a 32 KiB serialized response envelope, including JSON escaping and framing |
| Client text-size annotation | `anthropic/maxResultSizeChars: 40000` on these tools after interactive compatibility proof; this is a character threshold, not a token estimate |
| Memory retention | Completed answer retained ten minutes, independent of lease/client retrieval. At most 20 metadata records and 2 MiB payload; admission reserves space and rejects if it would require early eviction of an unexpired answer. Explicit disable/clear/app exit may clear it. |
| Live validation spending | At most one real Codex consultation per explicitly approved live smoke; fake providers for all repeatable scenarios |

Request IDs, key mappings, canonical payload fingerprints, and budget tombstones survive payload expiry until the owning Claude launch ends. Same key with changed content is KEY_CONFLICT; identical question/context under a new key resolves to the existing exchange. Return recognized duplicates before applying cooldown or exhausted-credit checks so a lost acknowledgment remains recoverable. That does not catch semantic paraphrases, so the credit budget and cooldown remain necessary.

U1 review amendment: accepting a new alias requires retaining its mapping within the 32-key cap. Never return success for an unretained alias: losing that acknowledgment would make get-by-key recovery fail. ALIAS_LIMIT rejects the new alias without reserving credit or starting work and follows the normal rejection cooldown. Previously accepted keys still recover during cooldown and retain KEY_CONFLICT checks. Rejected keys acquire no mapping or acceptance guarantee.

Invalid input, busy, cooldown, disabled, and other pre-acceptance rejections consume no start credit. Preparation failure before turn submission releases its reservation. This clarifies v2 rather than accepting the review's assumption that three invalid inputs necessarily spend three paid starts. The cooldown limits repeated new intents even when those rejections are free to Aether. During cooldown return a deadline and "Do not automatically retry; the operator may request another consultation later." Do not require a model-side sleep. Get/cancel and duplicate lookups remain usable during cooldown.

Settings exposes "Grant 3 more" for the current launch with an explicit allowance confirmation. It increases granted credit only; it cannot clear cooldown, change an exchange outcome, erase tombstones, or automatically start work. No MCP grant endpoint exists. Main validates the renderer sender and grant quantity. Do not describe this UI boundary as proof of human identity against an agent capable of automating the desktop. Budget display distinguishes granted, consumed, and reserved credits.

Ordinary 64 KiB text normally needs three pages at the new source-page target. Escaping-heavy text may require more because the serialized cap always wins. No bytes-to-tokens ratio is a correctness argument. U0 must prove the character annotation and boundary behavior in this installed interactive client.

### Failure language

All responses are bounded and carry a safe code and actionable guidance. No raw provider stack trace enters metadata or logs. Rejected asks do not animate as requests sent to Codex. Operational tool errors use MCP isError with an envelope; a pending/rate-limited read is status, not a failed consultation.

| Code | Guidance to Claude |
| --- | --- |
| DISABLED / NOT_CONNECTED / AUTH_REQUIRED / POLICY_BLOCKED | Do not retry. The operator must enable, connect, sign in, or resolve policy in Aether. |
| BUSY | Do not start or re-key another consultation. An exchange is already active. Only inspect an exchange you own. |
| READ_CAPACITY | Too many concurrent reads. Stop this retrieval attempt; do not retry, re-key, or start a replacement consultation. The operator can inspect the answer in Comms. Cancel remains available. |
| BUDGET_EXHAUSTED | Do not retry or delegate another attempt. Ask the operator to grant more consultations in Aether; a session restart is unnecessary. |
| COOLDOWN | Do not automatically retry or paraphrase the request. The operator may request a new consultation after the supplied deadline. |
| RETENTION_FULL | Do not retry automatically. Existing answers are retained; the operator can clear an answer or wait for normal expiry. |
| INVALID_INPUT / INPUT_LIMIT / KEY_CONFLICT | Do not automatically resubmit. Explain the rejected input to the operator. |
| ALIAS_LIMIT | Do not retry or create another alias. Retrieve using a previously accepted request_key or known exchange_id. The new key was not accepted. |
| UNKNOWN_EXCHANGE / EXPIRED | No result can be recovered by this call. Do not recreate the consultation automatically. |
| CANCELLED / LEASE_EXPIRED / TIMEOUT / OUTPUT_LIMIT / PROVIDER_FAILED / CLEANUP_FAILED | The consultation did not complete successfully. Do not retry; the operator must decide whether to start another. |

Instructions discourage retries but do not enforce them. Main enforces the slot, budget, ownership, fingerprints, and deadlines across all callers sharing a launch, including subagents. MCP does not prove top-level-versus-subagent identity here, so do not claim a subagent deny policy exists.

### Lifecycle and delivery

Provider state: accepted -> preparing -> waiting -> streaming -> finished, or cancelling -> cancelled; timeout/failure/lease-expiry outcomes remain distinct. The active slot stays occupied during cleanup. Dispose must establish actual process-tree exit, including Codex's native child, before working-directory deletion or slot reuse. Late callbacks cannot overwrite terminal state.

Delivery state is independent: not requested, pages served (count), all pages served, client disconnected, or expired. A successful local write is transport evidence only. Do not claim Claude consumed or understood a response. Cursor replay returns the same page without extra spending or inflated unique-page counts.

Get waits for the result, not for arbitrary metadata revision. Stream chunks, preparing-to-waiting changes, elapsed ticks, and lease extensions update Comms without waking get. Bound each wait by wait_ms and the remaining exchange deadline. Admit up to 16 simultaneous waiters per exchange and wake all on a terminal outcome. They share event observation but have separate timers and read-cancellation handles. There is no WAIT_IN_PROGRESS result and no instruction to await another caller's request. Ordinary pending responses have isError=false; READ_CAPACITY is a distinct hard resource rejection, not a pending result.

When the lease-owner slot is empty, the next admitted get claims it, even if follower reads remain pending. Renew to now plus 90 seconds, capped at the hard deadline, on its admission and normal pending return. Additional waiters do not renew and are not promoted automatically. Release the owner slot when that read settles; a subsequent newly admitted get may claim it. This permits sustained legitimate waits without letting existing followers renew on their own. Each wait is at most 60 seconds; lease expiry, the absolute deadline, and terminal outcomes end remaining waits as appropriate. Aborted/disconnected owners receive no return renewal. Removing one waiter never cancels the others or the provider. If cancellation is requested, wake existing waiters once with Cancelling; subsequent gets can wait for termination without being woken repeatedly by the already-known cancelling state. No fake progress notifications are needed to mimic activity.

Once the provider has finished, stop the ownership lease timer permanently. Later lease expiry callbacks must be ignored; they cannot cancel, evict, or relabel a finished result. On helper/client loss keep completed content readable in Comms for the original ten-minute retention, without granting the next Claude launch access to it. Memory pressure rejects a new exchange rather than silently shortening this guarantee. Disable, explicit clear, and app exit remain clearly stated exceptions. Surface a persistent answer-ready badge until opened or expired; opening it in Comms does not mark it delivered to Claude.

For a retained answer in the same connected launch, show its exchange ID with: "Answer ready. Read it here for N more minutes, or ask Claude: check Codex exchange <id>." This retrieves the existing result without spending another start. Do not claim "Claude stopped waiting" solely from missing reads; the bridge cannot reliably observe Esc or a model turn ending. If the launch has ended or been replaced, say "Read here or copy the answer into your current conversation" instead; the new launch cannot retrieve the old exchange. Provide an explicit Copy answer action, never automatic clipboard writes or terminal injection. The UI and disclosure distinguish these recovery paths and their retention limit.

If ask cancellation arrives while its short request is still active, cancel any associated accepted job. Once an ID has returned, the explicit cancel tool controls the job. Cancelling a get request cancels only that read. TaskStop of an unrelated Claude/subagent task is not observable job cancellation; absent further reads, the 90-second lease bounds continued work. A real helper EOF or confirmed Claude process exit cancels immediately. Shell PTY liveness alone is not Claude process liveness.

### Launch, permissions, and discovery

- Start the local pipe endpoint before launching Claude. The helper can complete initialize/tools/list without connecting to a model. Report "Tools connected" after a real authenticated connection and tool-list exchange for aether-bridge alone, without waiting for the rest of the user's MCP roster. Model-level presentation still requires the compatibility smoke.
- Use session-scoped `--mcp-config` with `alwaysLoad: true` on `aether-bridge`, preserving other servers. Keep concise server instructions describing when to consult Codex and how to finish an exchange. Do not globally disable tool search or use strict MCP mode merely to make three tools discoverable.
- Preapprove exactly the three names above using session-scoped `--allowedTools` launch arguments after opt-in. Do not write allow rules into user/global settings. Verify this in an interactive TTY, not just print mode. Preserve other permissions. Do not override explicit user/managed deny rules; report the limitation. Main rechecks its gate for every ask and revokes the capability on disable.
- For bridge-enabled launches, seed `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=120000` in the PTY environment and reapply it immediately after shell-profile execution, before invoking Claude. The post-profile assignment is authoritative. Preserve existing API-variable removal and profile-provided PATH. Scope the override to the connected launch and preserve the prior environment value separately where restoration is needed; do not modify user/machine settings or leave the override in a reusable shell. The setting is client-wide within this launch: it forces 120000, overriding customized thresholds for other MCP servers and, according to Claude's binary review, bypassing the client's default feature-flag branch. Disclose that effect; do not claim it merely restores a default or is isolated to this server. U0 must prove the effective value inside the launched client and actual 60-second blocking behavior. The existing buildUnsetCommand removes variables only; add a tested launch-scoped assignment rather than treating removal as a setter. Echoing this nonsecret assignment is acceptable; add a source comment explaining why it must follow profiles. This does not relax the ban on echoed capabilities, prompts, context, or project paths.
- Never type inline configuration JSON, capabilities, prompts, or project paths into the shell. Use a private temporary configuration file and only its properly quoted path in the launch command. If capability transfer needs a manifest env entry, that secret is explicitly classified as short-lived operational data with restrictive Windows ACL/Unix mode, cleanup on disable/replacement/exit, and stale-manifest cleanup on next startup. The preferred transfer is inherited environment if the actual client preserves it; verify rather than assume. No fallback to inline secrets.
- Existing PowerShell launch commands are echoed. Tests must inspect actual PowerShell stdin/PTY output and shell-history behavior, not merely an execFile argument array. A config file path may be visible; the capability, question, context, and project paths must not be.
- Track real Claude lifetime, not just the shell that launched it. Revoke capabilities when Claude exits even if PowerShell remains. A reconnect cannot restore a cancelled exchange or reset spending. A failed helper requires a visible recovery action; configuration written is not readiness.
- Provide the explicit fresh-session action and avoid PtyTerminal's once-per-app mount trap or duplicate start after a Settings launch. A fresh session remains fresh; do not introduce resume flags.

### Provider, content, and trust

Reuse CodexAppServerAdapter, its subscription health check, isolated configuration, and denial policy. Each exchange uses a private empty cwd and no automatic file ingestion. Apply the actual turn sandboxPolicy schema with tool network disabled; verify the effective configuration prevents recursive bridge access. Preserve the shipped verifier and its adapter behavior.

Do not promise that read-only means no reads outside cwd or no command execution. The opt-in names the actual permission boundary. Provider tools must not acquire write permission. An ephemeral session flag is available in the pinned schema but must be tested before claiming nonpersistence. No raw answer or source text is sent to another model merely for display or summarization.

Comms presents exactly what Claude supplied and Codex returned. Render with safe text semantics. MCP result framing attributes the response to Codex and tells Claude to assess it against user instructions and evidence, not execute embedded instructions automatically. That framing is guidance, not a security boundary; normal Claude action permissions still apply.

The disclosure must explicitly name Claude Code's local session transcript, possible client tool-output files, and Codex-managed history. Aether expiry clears only Aether's retained copy. Paging is intended to avoid overflow artifacts but does not suppress the normal transcript. Do not delete or alter provider histories as part of this feature.

---

## Review Disposition and Evidence

Claude's three reviews are inputs, not unquestioned runtime truth. Prior local checks reported Claude Code 2.1.267; no version upgrade check was performed during v4 editing. Prior binary inspection found auto-background timeout, idle-timeout, output-limit, alwaysLoad, and per-tool result-size markers. The second review corrects the first review's absent CLAUDE_CODE_DISABLE_MCP_AUTO_BACKGROUND_TASKS suggestion to CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS and reports the default background threshold as 120000 ms. This redesign has not independently exercised those settings through an interactive model call. Marker presence establishes availability hints, not effective runtime behavior. Current ptyManager.ts confirms inherited environment sanitization plus post-profile removal before Claude launch; it does not yet implement this threshold assignment.

Current official documentation describes a two-minute background threshold and per-server timeout/deferral/result-size controls. The new design uses explicit 90-second server timeouts with get capped at 60 seconds. U0 must check effective background and idle settings, including overrides that could shorten those bounds. These controls are documented in [Claude's MCP reference](https://code.claude.com/docs/en/mcp). Local help confirms `--mcp-config`, `--allowedTools`, and `--strict-mcp-config`; no live model was invoked for these checks.

| Review item | Revision response |
| --- | --- |
| B1: backgrounding and receipt | Short ask/cancel and bounded get; independent provider/delivery states; explicit ownership lease and cancellation semantics |
| B2: hidden permission prompt | Exact-name per-session approvals; main opt-in remains authoritative; overriding denies remain visible |
| B3: client output cap and overflow | Bounded encoded pages and tested per-tool size annotation; no byte-to-token estimate; CLI copies disclosed |
| B4: deferred tool discovery | Targeted alwaysLoad plus server instructions; preserve existing tools; actual model presentation is a gate |
| B5: unknown file anchor | Remove file selection, project picker, and snapshot copying from slice 1 |
| S6: retries/subagents | Idempotency, exact-payload dedup, shared launch budget, one active slot, nonretry guidance |
| S7: idle timeout | Get waits at most 60 seconds within a tested 90-second client timeout; ask/cancel return promptly; no fake progress heartbeat |
| S8: echoed launch configuration | Restricted manifest/environment transfer, never inline secrets; actual PowerShell echo/history tests |
| S9: answer as instructions | Attributed advisory-data envelope, transparent influence disclosure, ordinary action permissions preserved |
| S10: Claude transcript persistence | Explicit local transcript and tool-results disclosure separate from Aether retention |
| Smaller points | Fixed server name, collision detection, handshake-driven connectivity, five-minute job cap, explicit one-consultation live smoke ceiling |
| C1: no model-side scheduler | Replace timed polling with a 45-second default server wait, capped at 60 seconds; chunks do not wake it. Concurrent cancel remains responsive. |
| C2: excessive paging overhead | Increase source pages to 24 KiB and serialized envelopes to 32 KiB, with a proposed 40000-character annotation subject to U0; escaping can require more than three pages. |
| C3: credit exhaustion disrupts session | Operator can grant three credits in Settings without restarting Claude. No MCP grant; no reset of cooldown or tombstones. |
| C4: finished answers need a fallback | Completed answers survive lease/client loss for ten minutes in Comms, with a badge; reserve memory before acceptance to prevent early eviction. |
| C5: paraphrase/retry storms | Thirty-second cooldown after rejection or unsuccessful outcome; successful completion permits follow-ups. Repeated cooldown responses do not extend it. Rejected inputs spend no credit; ambiguous provider submission does. |
| C6: exact interactive launch behavior | Session-scoped --allowedTools only, interactive TTY proof in U0, and readiness based only on this bridge's handshake. |
| D1: second caller cannot await another tool call | Multiple bounded waiters share terminal notifications; one active lease-owner read. Remove WAIT_IN_PROGRESS and make the waiting invariant explicit. Capacity overflow is a stop condition. |
| D2: successful follow-ups blocked | Success clears cooldown; rejection and unsuccessful outcomes retain it. Include next_eligible_at in normal responses. |
| D3: indistinguishable pending returns | Return measured state, elapsed/remaining time, observed bytes, and last observed output timestamp, without waking on progress. |
| D4: probe does not bind launch environment | Pin 120000 after profiles for the connected Claude process, test it interactively, and disclose the effect on other servers in that launch. |
| D5: stranded-answer recovery | Show the exchange ID and same-launch retrieval instruction; ended/replaced launches use explicit manual copy. Never infer client interruption from silence. |
| D6: inconsistent allowance and read classification | AE6 uses the current shared allowance; pending is a successful status, with no WAIT_IN_PROGRESS code. |

Product Contract changes from v3 refine R1 concurrent waiting/progress, R9 cooldown scope, and R10 launch behavior, while making R5's recovery path actionable. These remain proposed defaults for Matt's review.

### Claude v4 review disposition

Claude's fourth review signs off with no blocking client-side findings and closes D1-D6. Retain v4; the next evidence gate is U0, not another speculative redesign. The nonblocking launch notes above clarify that the pin forces a value, seed it in the initial environment as well as after profiles, and permit echoing that nonsecret assignment. Binary-branch details are reviewer-provided evidence, not an independently executed client test.

Keep the conservative follower lease policy. If the owner is interrupted and no subsequent newly admitted read claims ownership, followers cannot extend the lease; active work may expire. Add that exact interleaving to U3 so it is deliberate and visible rather than an unexpected cancellation.

**Passed:** Claude-side document review; no blockers remain in that review. **Incomplete:** U0 and implementation. The review's claim that all U0 checks require no spend is too broad: no Codex turn is needed, but actual Claude model-presentation and model-driven tool checks can consume subscription usage. Configuration and fake-server checks alone do not prove those model-level properties. Preserve U0's explicit allowance boundary.

---

## Implementation Units

New paths below are proposed. Existing paths must be read and callers traced before editing. Each unit is a separate verify-and-commit checkpoint; keep the unit scope distinct even when adjacent work touches a common file.

### U0. Prove the client contract before feature implementation

Use a disposable fake MCP server and the installed Claude client in an interactive TTY to check alwaysLoad amid the existing roster, session-scoped exact tool approval, 45/60-second quiet get waits within the explicit 90-second timeout, result-size annotation, paging, collision behavior, and capability transfer. Check effective auto-background and idle overrides rather than trusting defaults. Prove that ordinary pending responses permit another wait without a model-side timer, and that tool discovery/readiness does not wait for unrelated servers. Record which observations use the actual model versus only configuration/handshake. Use no real Codex turn. Any Claude model-based probe requires its own explicit allowance; source/handshake evidence cannot substitute for it. If probes contradict a design premise, revise this proposal before building UI around it.

Include concurrent same-exchange gets, distinct progress snapshots across pending returns, and a profile that deliberately lowers the background threshold. Prove the post-profile 120000 pin reaches the actual client, get stays blocking for 60 seconds, and launch cleanup preserves the prior shell setting. A process environment dump alone is not evidence of MCP blocking behavior. Record any version-specific limitation before proceeding.

**Files:** protocol fixtures under `e2e/fixtures/communication/` (new), compatibility evidence under the implementation workspace's scratch directory. **Verify:** actually call all three fake tools with the installed client; confirm tool presentation, no hidden prompt, no output spill at page boundaries, and no secrets in terminal/history. Until that real client check runs, client compatibility is Incomplete.

### U1. Define asynchronous contracts and budget transitions

**Files:** `src/shared/communicationTypes.ts`, `src/shared/communicationLifecycle.ts`, `src/shared/communicationLifecycle.test.ts` (new). **Covers:** R1-R3, R8-R9.

Define separate safe metadata and content types, immutable identities, versioned pages, safe errors, reservation/consumption/refund transitions, duplicate-key/content behavior, lease/deadline transitions, and unique page-serve accounting. **Verify:** lost acknowledgment/retry, changed key content, identical payload under different key, duplicate recovery during cooldown/exhaustion, subagent fan-out, no refund on ambiguous submission, zero spend on rejected input, cooldown not extended by COOLDOWN replies, grant preserving tombstones, terminal-state stickiness, null usage, expiry tombstones, and separate finished/served outcomes.

Also verify immediate distinct follow-up after success, success clearing an earlier busy-rejection cooldown, unsuccessful outcomes retaining cooldown, accurate next_eligible_at, and absent progress remaining null. READ_CAPACITY is a retrieval rejection; it never changes provider outcome or consumes credit.

### U2. Establish provider process supervision

**Files:** `electron/crossEngine/providers/codexAppServer.ts`, `providers/providers.test.ts`, `providers/providerProcess.test.ts` (new; paths relative to the same crossEngine directory). **Covers:** R2, R5-R7.

Preserve existing callers while making cancellation/disposal reflect the actual process tree. Validate turn sandboxPolicy against the installed generated schema and disable tool network. **Verify:** real stubborn descendant, kill failure, late acceptance, no premature dispose success, conformance/legacy verifier regression, and no recursive bridge configuration. No real model needed for supervision tests.

### U3. Implement the bounded exchange controller

**Files:** `electron/communicationBridge/exchangeController.ts` and `.test.ts` (new). **Depends on:** U1-U2. **Covers:** R1-R3, R5-R9.

Accept synchronously into reserved memory and start the provider asynchronously. Use a fresh private empty cwd. Own server-side waits, lease, absolute deadline, start budget, idempotency, cancellation, payload paging/expiry, and disposal. **Verify:** five-minute fake turn with 45/60-second waits, no wake on streamed chunks or metadata, multiple pending waiters with one lease owner, follower non-renewal, owner cancellation without cancelling followers, no automatic follower promotion, newly admitted read claiming a vacant owner slot, 16-waiter cap, terminal broadcast, accurate progress at return, aborted wait not renewing on return, lease expiry, no renewal by UI, deadline not extended by reads, cancellation before startup, initial three-start ceiling and explicit grants, cleanup before slot reuse, output cap, Unicode/JSON-escaping page boundaries, stable cursor replay, and lost-ack lookup. Prove completed content survives stale lease callbacks/client loss, expires at its original deadline, and RETENTION_FULL rejects new work rather than evicting an unexpired answer.

### U4. Build MCP helper and authenticated local pipe

**Files:** `electron/communicationBridge/mcpServer.ts`, `pipeServer.ts`, `protocol.test.ts` (new), `electron.vite.config.ts`, `package.json`, `package-lock.json`. **Depends on:** U0, U3. **Covers:** R1, R5-R6, R9-R11.

Use the official SDK version proved by U0. Implement the exact three-tool interface, discovery instructions, size annotation, short ask/cancel and bounded get, EOF/cancel handling, and safe responses. Multiplex requests so a waiting get never blocks cancel processing. Main owns authorization and spending; caller-supplied identity is not trusted. **Verify:** real stdio client/server round trip with fake provider, framed/partial/oversized pipe messages, wrong capability, protocol-only stdout, accepted-ask cancellation race, cancel handled while get is waiting, get cancellation not cancelling job, reconnect not starting work, and unavailable main returning promptly.

### U5. Integrate the bridge with main and preload

**Files:** `electron/main.ts`, `electron/preload.ts`, `src/aetherElectron.d.ts`, `electron/communicationBridge/mainIntegration.test.ts` (new). **Depends on:** U4. **Covers:** R3, R5-R9.

Initialize the listener before client startup, wire metadata pushes and payload reads, validate IPC, revoke launch capabilities, and use bounded shutdown. **Verify:** Settings never visited, disabled state, malformed IPC, helper/Claude exit, cleanup failure surfaced, all buffers cleared on disable, and no listener accepting work after revocation.

### U6. Add preference and safe session launch

**Files:** `src/state/types.ts`, `initialState.ts`, `reducer.ts`, `persistence.ts`, `src/state/useCommunicationSync.ts` (new), `src/App.tsx`, `src/components/settings/CommunicationCard.tsx` and `.test.tsx` (new), `SettingsView.tsx`, `electron/ptyManager.ts` and `.test.ts`, `electron/ptyLifecycle.ts` and `.test.ts`, `src/components/terminal/PtyTerminal.tsx`, `electron/communicationBridge/launchConfig.test.ts` (new). **Depends on:** U5. **Covers:** R6, R8-R10.

This unit has four separate checkpoints: preference/bootstrap sync; restricted launch configuration with exact permissions; explicit fresh-session UI and Claude-lifetime tracking; operator credit-grant control and confirmation. Each is verified and committed before the next.

**Verify:** enabled preference without spending, main default disabled until synchronized, active terminal unchanged until replacement confirmation, failed/cancelled replacement, once-per-app mount regression, no duplicate start, true Claude exit with shell still alive, retained global MCP tools, exact approval names, collision/managed deny presentation, and real PowerShell quoting/echo/history. Verify grants affect only the current launch, do not restart it or start work, and cannot be duplicated by repeat submission of one confirmation. Retain billing-variable stripping and post-profile safeguards. Test manifest ACLs, revocation, normal/stale cleanup, and permission failures. Never weaken shell/permission policy to pass a launch test.

The launch checkpoint includes initial-environment seeding and threshold pinning after profile execution. Test unset and customized prior values, profiles that overwrite the seed, absent/failed profiles, launch failure, ordinary exit, and interruption cleanup; ordinary non-bridge launches retain their existing behavior. Confirm API keys remain stripped and PATH still resolves the installed CLI. Verify the assignment may echo while secret sentinels remain absent. Display the client-wide threshold override in the connected-session disclosure.

### U7. Add safe metadata and the global activity indicator

**Files:** `src/state/useCommunicationSync.ts`, `src/state/reducer.ts`, `types.ts`, `persistence.ts`, `src/components/layout/CommunicationIndicator.tsx` and `.test.tsx` (new), the existing layout integration point located through App. **Depends on:** U6. **Covers:** R3-R4, R8.

Push content-free metadata, render genuine request/reply direction, show answer-ready versus pages-served, and navigate only on click. **Verify:** status distinctions, no false receipt claim, no auto focus change, keyboard/reduced-motion behavior, cleanup states, and metadata excluded from persistence.

### U8. Render actual exchanges in Comms

**Files:** `src/components/comms/CommsView.tsx` and `.test.tsx`, `ExchangeView.tsx` and `.test.tsx`, `useExchangeSource.ts` and `.test.ts` (new where absent), `src/state/noPayloadInStore.test.ts`. **Depends on:** U7. **Covers:** R3-R5, R8, R11.

Use mounted view state and bounded pulls from main, bypassing commsPersistence message helpers. Render supplied context, actual answer stream, provider/delivery states, active lease/elapsed display, cancel, and expiry. **Verify:** rapid selection changes, stale reads, answer before mount, unmount cleanup, full answer while Claude fetches pages, unread-answer badge clearing on open without marking Claude receipt, completed answer after client loss, ten-minute expiry, partial failure, malicious markup as text, and persisted-sentinel absence. Describe Comms retention as session memory, not a durable archive.

Verify recovery copy includes the correct exchange ID, same-launch get consumes no credit, a replacement launch has no access to the old exchange, and Copy answer runs only on an explicit click. Do not falsely label missing retrieval as observed Claude interruption; do not inject the answer into a terminal.

### U9. Verify the complete path and update product documentation

**Files:** `e2e/communication.spec.ts` (new), `e2e/electronHelpers.ts`, `src/shared/noApiCalls.test.ts`, `docs/privacy-and-data.md`, `PROGRESS.md`, `PROGRESS.standing-decisions.md`, applicable source instructions. **Depends on:** U0-U8. **Covers:** all requirements and acceptance examples.

Use real Electron, a real helper, and a deterministic fake provider to demonstrate the full flow. Add narrow guard updates for the new provider call site. Document exact controls, limits, lease-driven cancellation, histories, and advisory-data semantics. **Verify:** AE1-AE14, no runaway subprocesses, privacy serialization, actual visuals, and independent whole-branch review. Live Claude-to-Codex verification is a separate explicitly approved one-consultation smoke, not part of normal test discovery.

---

## Verification Contract

1. U0 client compatibility: actual installed Claude, not a hand-written imitation; report configuration, handshake, model-presentation, and tool-call evidence separately.
2. Per-unit tests plus `npm test`, `npm run typecheck:electron`, `npm run build`, and `npm run electron:build`.
3. Real-process integration and `npm run test:e2e`, with no paid provider behind repeatable test discovery.
4. Real Electron visual/interaction proof, including ready-but-not-requested, paged serving, cancel, disconnect, expiry, both themes, and reduced motion.
5. When approved, one real consultation through installed Claude and real Codex, logging only safe outcome/usage evidence. Do not call it passed from a fake-provider run.

Runtime invariants that must fail tests when broken: accepting before budget/memory reservation; duplicate key starts twice; get starts work or wakes on each token; UI renews lease; stale lease erases a finished answer; provider finish implies Claude receipt; cursor replay inflates delivery; helper reconnect resets budget; MCP grants credit; ambiguous submission refunds credit; waiting get blocks cancel; leaked capability in echoed shell input; process cleanup resolves before native descendant exit; plaintext payload enters persisted Aether state.

V4 invariants: another caller's active get produces no immediate wait instruction; followers do not renew the lease; one cancelled read cannot cancel other waiters; pending is not isError; success imposes no cooldown; progress is measured rather than fabricated; post-profile overrides cannot shorten the pinned background threshold for the connected launch; a new launch cannot retrieve a predecessor's answer.

---

## Definition of Done

The implementation satisfies AE1-AE14, passes code/build/integration gates, and matches the documented permission and lifecycle behavior. Actual Claude compatibility must pass U0, and the live cross-provider smoke has its own explicit verdict. If that smoke is not authorized, report implementation ready for live validation rather than fully live-verified.

This proposal's current evidence is source, official documentation, CLI help/version, and marker inspection. The new protocol and UI are not implemented or runtime-tested. Proposed limits and client configuration must be validated before activation; no live call has been made by this redesign.
