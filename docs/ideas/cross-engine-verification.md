# Idea: Cross-Engine Verification

**Status:** implemented — see
`docs/superpowers/plans/2026-08-07-codex-acp-cross-engine-verification.md`. Shipped 2026-08-07 as
the ACP client this doc argued for, not a bespoke Codex integration. The shipped version is
**subscription-only ChatGPT billing** — the operator authenticates through their own ChatGPT
account, OpenAI API keys and custom gateways are structurally blocked — which resolves the "second
subscription, real cost" obstacle named below: it's the operator's existing Codex allowance, not a
new API bill.
**Earliest sensible start:** after Stage 5 (`docs/roadmap.md`). It is Stage 5's natural extension,
not a parallel track.

---

## The idea

While Claude Code is doing work, dispatch a **different model engine** — Codex, or anything else —
to independently verify it. Not a second opinion from the same family. A different engine, on
purpose.

## Why it isn't just "ask a second model"

The principle has a name in engineering: **dissimilar redundancy.** Avionics deliberately runs
different hardware *and* independently-written software for the same function, because identical
systems fail identically. Two Claude subagents reviewing each other share priors about what is
worth checking.

This is not hypothetical for this project. The pipeline is already fresh-implementer plus
fresh-reviewer, both Claude, and `PROGRESS.md` documents defects that walked straight through it.
The clearest is `usageTokens()`: thirteen unit tests passed while the function was wrong by 4.68
billion tokens, because every fixture zeroed the cache fields — the reviewer shared the author's
assumption about what a fixture needs to contain. It was caught by a human checking the number
against `/usage` on real data.

**The operator has been the decorrelating engine.** This idea is about automating that role.

## Feasibility: the mechanics are the easy part

`codex exec --json` is non-interactive with structured output, emitting a documented item taxonomy:
`agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`,
`todo_list`, `error`. That is a spawnable child process with parseable JSON — strictly *easier* to
drive than the `claude` pty this app already manages, because there is no TUI to scrape.

Codex's sandbox also happens to suit a verifier: internet is on during the setup script and **off
by default during the agent phase**, behind an HTTP proxy. A verifier that reads files and runs
tests cannot wander.

## The part that decides whether this is worth building

*"Ask Codex whether Claude was right"* is the version that produces confident noise — two models,
no ground truth. The value is entirely in what the check is anchored to, and Stage 5 builds exactly
those anchors:

**1. Claim versus artifact.** `SubagentStop` carries `last_assistant_message` — the agent's own
account of what it did. Stage 5's `PostToolUse` tracking carries the real file list. The verifier
receives the claim, the actual touched files, and the diff, and answers one grounded question:
*does the artifact support the claim?* Sculptor's Verifier is the only shipped implementation of
agent-honesty checking found anywhere in the 2026 landscape — and it uses the same model as the
author. Cross-model would be genuinely novel.

**2. Independent test authorship.** The verifier writes tests from the *stated intent*, never seeing
the implementation or the author's tests. An implementation that passes tests written by a model
which never saw it is *executable* evidence rather than an opinion. This is precisely the
`usageTokens()` shape: a model that did not write the fixtures has no reason to zero the same field.

The distance between framing 1/2 and "double-check this" is the whole idea. Same plumbing;
"I ask a second model to check" is a weekend hack, "I detect when an agent's claims diverge from its
artifacts, decorrelated across model families" is a contribution.

## Obstacles, honestly

- **ToS, and the distinction matters.** The loudest cause of third-party tool death in 2026 was
  vendors restricting subscription-account access from third-party clients. But **spawning a
  vendor's official CLI with the user's own credentials is a different act** from proxying a
  vendor's API with subscription credentials. This app is already on the safe side with `claude`;
  `codex exec` is the same pattern. Stay there.
- **A second subscription.** Codex requires an OpenAI plan. Real cost, real dependency, and a hard
  gate on whether this is worth building at all for a single user.
- **Cost per run.** Every verification is a full agent invocation. Firing on every `Stop` hook would
  be absurd. Trigger selectively: **anomaly-fired** (Stage 5 detects thrash → verify that dispatch)
  or manual from a dispatch card. Never automatic-on-everything.
- **Tree races.** A verifier reading the same working tree as a live Claude session is a race. This
  needs a read-only snapshot at the commit under test — `git archive` to a temp directory is
  sufficient. **Note this is a narrow, deliberate exception to the roadmap's "no git worktrees"
  exclusion**: the exclusion is about not building worktree *management UI* (that is Conductor's
  product); this is a read-only snapshot for isolation, which is a different thing at a fraction of
  the scope.

## The version worth building: an ACP client, not a Codex integration

The Agent Client Protocol is the only written-down spec covering tool-call kinds, statuses,
permission option kinds, plans, terminals, usage/cost, elicitation and session resume — and 36
agents plus a dozen editors already speak it. Zed and JetBrains drive Claude, Codex and Gemini
through it with no bespoke per-vendor extension.

One ACP client integration reaches Claude, Codex, Gemini, Copilot, Cursor and Cline, versus
reverse-engineering five proprietary JSON streams. For a cross-verification feature that is the
difference between *"I bolted on Codex"* and *"verification is engine-agnostic — here are three
engines cross-checking each other."* Same work, one layer lower, far more leverage.

**If this is ever built, build the ACP client. Not the Codex integration.**

## Dependencies

Hard prerequisites, all in Stage 5:

- Real per-dispatch file-touch tracking (`PostToolUse` with `agent_id`)
- The persisted anomaly log, to trigger verification selectively
- `last_assistant_message` per dispatch, to have a claim to check

The roadmap is already building all three without knowing it. The thing to resist is starting this
early because it is the most exciting item on the list — without the artifact layer underneath, it
degrades into exactly the ungrounded "ask a second model" version that does not work.

## Privacy note

Cross-engine verification transmits **code and diffs to a second vendor.** That is a materially
wider disclosure than anything else in this app — `docs/privacy-and-data.md` currently permits
exactly one outbound path (Chat's scoped snapshot to Anthropic, gated on a user-supplied key).

If this is ever built it needs its own entry in that document, its own explicit opt-in, and its own
default-off setting. It must not arrive as an incremental extension of an existing permission.
