# Stage 13.5 — API teardown: design

**Status:** approved for planning
**Date:** 2026-08-05

## What this is

Stage 11.5 established the rule — *"Aether is meant to not cost a user money, full
stop"* — and built a policy module to enforce it by convention. Stage 13.5 removes the
capability instead of governing it.

On 2026-08-05 a second unexpected API charge locked the operator out of Aether at both
home and work. The diagnosis is on record: `modelPolicy.ts` was wired to
`claude-opus-4-8`, but the billed models were Sonnet 5 and Haiku 4.5 — so the spend did
**not** originate at Aether's own call site. The likely path was an `ANTHROPIC_API_KEY`
exported into the dev environment and billed directly by that day's heavy Claude Code
subagent work in this repo.

That distinction matters and this document will not soften it: **removing Chat's model
path does not fix what actually charged the account.** The environment-level fixes (no
key in either machine's shell, a hard spend cap on the console) are the load-bearing
ones, and they live outside this repo. What Stage 13.5 *can* guarantee is that Aether OS
is never again a candidate explanation — that when the next surprise charge is
investigated, this codebase is eliminated in one grep instead of one audit.

The July 31st precedent is instructive: `CLAUDE.md` already records that incident as
*"mostly unrelated Claude Code terminal spend, but real Aether spend too."* Twice now,
Aether has been a minority contributor to a bill it got blamed for. A minority
contribution is still a contribution, and a codebase that cannot contribute at all is
worth more here than a headline feature.

## Governing principle (upgraded from Stage 11.5)

Stage 11.5's rule was *"no feature may make an unprompted or periodic model call."*
Stage 13.5 upgrades it:

> **Aether OS contains no model call site of any kind, and cannot acquire one without
> reinstalling a dependency.**

A boolean returning `false` is a convention — future-you at 1am can flip it. A missing
`@anthropic-ai/sdk` is a compile error. The guarantee has to survive its author.

## In scope

1. **Dependency removal.** `@anthropic-ai/sdk` out of `package.json`.
2. **Call-path removal.** `chatCore.ts`, `claudeClient.ts`, `systemPrompt.ts`,
   `chatProxyPlugin.ts`, and the `chat:send`/`chat:hasKey` IPC pair.
3. **Key-reachability removal.** `electron/loadDotEnv.ts` and its call in `main.ts`, so
   the app cannot read a key from `.env` even if one exists on disk.
4. **Policy-module retirement.** `modelPolicy.ts` and `ModelPolicyCard.tsx` become
   vestigial once nothing can call a model. `modelPolicyEnforcement.test.ts` is
   *replaced*, not deleted — by a stricter guard that no longer depends on an allowlist.
5. **Chat → Comms rename.** `src/components/chat/` becomes `src/components/comms/` via
   `git mv`, preserving history. The three presentational files (`ChannelRail`,
   `MessageThread`, `MessageInput`) and `chatChannels.ts` survive the move; the
   model-path files are deleted during it.
6. **Settings reshuffle.** `ChatBackendCard` and `ModelPolicyCard` are removed;
   `AUTO HEADLINES` (already locally computed, already zero-cost) relocates rather than
   dying with the card that housed it.

## Explicitly NOT in scope

- **The COST GUARD settings card.** Declined by the operator this pass. The two removed
  cards leave a gap in the Settings column; Stage 15 fills it from the Ledger side
  instead. Named here so the gap reads as a decision, not an oversight.
- **A local-LLM (Ollama) backend.** Considered and deferred. It is still a model call,
  so it would need a module structurally incapable of reaching `api.anthropic.com` —
  which reopens exactly the door this stage is welding shut. If conversational chat is
  wanted later it gets its own stage, after Stage 14 has demonstrated whether the
  deterministic path is sufficient.
- **`electron/permissionServer.ts`.** Loopback HTTP, no outbound calls, unrelated. Named
  because "remove the HTTP server" is a plausible misreading of this stage's intent.
- **`modelPricing.ts`.** Retained deliberately — it is pricing math, never a call site,
  and Stage 15 depends on it. Its `optimizeRules.ts` consumer is unaffected.

## Decisions closed this pass

| Decision | Resolution | Why |
|---|---|---|
| Delete the Chat components or rename them? | `git mv chat/ → comms/`, deleting only the model-path files in the move | Delete-then-resurrect in Stage 14 loses blame history on ~400 lines of styling that is not the problem. The rail/thread/input markup never called a model. |
| Does the tab survive the teardown? | Yes — `Comms`, rendering `localResponder` only | Leaves no intermediate commit where the app is broken or a tab is inert. `localResponder.ts` is already state-aware, already the fallback, already free. Stage 14 fills it properly. |
| Keep `modelPolicy.ts` for the enforcement test? | No. Replace the test with `noApiCalls.test.ts`, which depends on no allowlist | An allowlist test asks *"is this model approved?"*. The right question is now *"does any call site exist at all?"* — a question with no allowlist in it. Keeping the module to satisfy its own test is circular. |
| `electron/modelSpendTracker.ts`? | Delete | It tracks Aether's own API spend, which is now structurally zero. Stage 15's ledger tracks Claude Code's spend from transcripts — a different source and a different module; this one is not a head start on it. |
| `src/components/chat/personas.ts`? | Delete | Spec §5.10 recorded personas coexisting with voice packs *because Chat existed*. With no model reply to characterize, `VOICE_PACKS` is the sole surviving personality surface. `agentVoiceRoles.ts` references `personas.ts` only in a prose comment; update the comment, drop the dependency. |
| `.env` handling? | Remove `loadDotEnv.ts` entirely; strip the key line from `.env.example` | Stage 0.5 added `.env` loading *specifically* so the Electron main process could see the key. Its only reason to exist is gone. Leaving it is leaving the door unlocked with the handle removed. |

## The guard test

`src/shared/noApiCalls.test.ts` replaces `modelPolicyEnforcement.test.ts`, reusing its
proven tree-walking shape (`ROOTS`, `SKIP_DIR_NAMES`, the `walk()` helper) and asserting
four things:

1. `@anthropic-ai/sdk` appears in neither `dependencies` nor `devDependencies` of
   `package.json`.
2. No source file imports `@anthropic-ai/sdk` or `Anthropic` from it.
3. No source file contains the string `api.anthropic.com`.
4. No source file contains a `messages.create(` call — carried forward verbatim from the
   test being replaced, since it is still the right assertion and already passes.

The existing generic `MODEL_ID_SHAPE` check (`/claude-[a-z]+-\d/`) is **retained** with
its `optimizeRules.ts` exception intact — a stray model ID is still a smell worth failing
on, even with no SDK present, and Stage 15 will add pricing-table entries that must not
quietly become call sites.

This is the same shape as `persistence.test.ts`'s coverage test: encode *why* a miss
matters, so the build fails loudly rather than the operator finding out from a billing
email.

## Known limitation, named plainly

**This stage cannot prevent the failure that motivated it.** If `ANTHROPIC_API_KEY`
remains exported in a shell where Claude Code runs, the next heavy subagent session bills
the same way, and Aether will be equally innocent and equally suspected. The environment
fixes are a checklist item for the operator, not a task in this plan, because nothing in
this repository can enforce them. Recording the limitation here is the honest alternative
to implying the teardown closes the loop.

## Testing

Standard project convention. The teardown is mostly deletion, so the meaningful test work
is: the new `noApiCalls.test.ts` guard; updating `persistence.test.ts`'s round-trip
coverage for the removed `Cfg` keys (its documented-exclusions list is the exact mechanism
for this, and this is precisely the recurring bug class Stage 0.5 built it to catch);
updating `viewRegistry.test.ts` for the `Chat` → `Comms` id change; and confirming
`npm test`, `npm run build`, and `npm run electron:build` all stay clean with the SDK
uninstalled.

## Next step

Hand off to `writing-plans`, saved to
`docs/superpowers/plans/2026-08-05-api-teardown-stage13.5.md`. Stage 14 (Comms Deck)
depends on this stage's `comms/` rename and should not start until it merges.
