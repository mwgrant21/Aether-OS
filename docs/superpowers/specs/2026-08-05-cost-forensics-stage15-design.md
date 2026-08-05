# Stage 15 — Cost Forensics: design

**Status:** approved for planning
**Date:** 2026-08-05
**Depends on:** Stage 13.5 (API teardown). Independent of Stage 14 — the two can be built in
either order, but Stage 14 first is preferred so the transcript read path exists.

## What this is

A `Ledger` view: per-dispatch cost attribution, session and day and week rollups, cache-hit
dollar impact, and a plain answer to *"what did today cost me, and which dispatch was the
worst offender."*

The motivation is not abstract. Twice now — 2026-07-31 and 2026-08-05 — an API bill arrived
before any signal did, and both investigations had to reconstruct spend after the fact from a
billing page and a code audit. The second one concluded, correctly, that Aether wasn't the main
cause. That conclusion took hours and produced a teardown of a working feature. A ledger that
was already open would have answered it in a glance.

The thematic shape is deliberate: **the tab that burned the operator becomes the tab that
watches the burn.** Stage 13.5 removes Aether's ability to spend money. Stage 15 gives it the
ability to see money being spent — which is the more useful of the two capabilities, and the
one that was missing both times.

## The data reality (read this before scoping anything)

Cost attribution in this codebase has two tiers of fidelity, and conflating them would produce
a ledger that looks precise and is wrong.

**Tier 1 — exact, per message.** `TranscriptEvent.usage` carries the full split:
`inputTokens`, `outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, alongside
`model`. `costForEvent()` in `src/shared/modelPricing.ts` already computes a dollar figure from
exactly that shape and is already consumed by `optimizeRules.ts`. Summing `costForEvent` across
every assistant event in a transcript gives a **session total that is as accurate as the
pricing table**.

**Tier 2 — approximate, per dispatch.** A subagent dispatch's completion arrives as a
`task-notification` carrying `<subagent_tokens>`, `<tool_uses>`, `<duration_ms>` — parsed in
`src/state/liveAgentsMath.ts` into `CompletedDispatchUsage.tokens`, a **single scalar with no
input/output/cache split**. `costForEvent` cannot consume it. Per-dispatch cost must therefore
be estimated by applying a blended rate for the dispatch's model tier to that scalar.

This is the single most important honesty constraint in the stage:

> **Session totals are exact (to the pricing table). Per-dispatch figures are estimates.** The
> UI must distinguish them visually and in copy — an estimate row carries a `~` and a tooltip
> naming why. A ledger that renders both at the same confidence is worse than no ledger,
> because it will be trusted in the exact moment accuracy matters.

Closing the gap properly would mean attributing individual assistant events to the dispatch
that was open when they occurred. That is feasible — the transcript is ordered and dispatch
open/close boundaries are already tracked — but it is a correlation layer with its own failure
modes, and it is **out of scope for this stage**, named as the obvious follow-up rather than
half-built.

## The pricing table problem

`src/shared/modelPricing.ts` says so itself:

> *"These are PLACEHOLDERS to make the spend/cost math concrete and testable end to end —
> verify against current published rates before trusting the dollar figures in production."*

A ledger built on unverified placeholder rates is theatre. Stage 15 must resolve this, and
there are only two acceptable resolutions:

1. **Verify the rates** against Anthropic's published pricing at build time and update the
   table, with the verification date recorded in a comment.
2. **Label every dollar figure as an estimate** in the UI, prominently, with the pricing basis
   visible somewhere the operator can check it.

The recommendation is **both** — verify the rates *and* keep the basis visible, because rates
change and the next reader will not know when the table was last touched. A `PRICING_VERIFIED_AT`
constant rendered in the Ledger's footer costs nothing and prevents the table from silently
aging into wrong.

Note also that `CACHE_READ_DISCOUNT = 0.1` is a stated approximation ("a reasonable
approximation for v1"). Same treatment: verify or label.

## In scope

- **`Ledger` view**, new entry in `viewRegistry.ts`, `inTopBar: true`.
- **Session ledger.** Exact cost from the transcript's assistant events, broken out by
  input / output / cache-creation / cache-read, with the model tier shown.
- **Dispatch table.** One row per completed dispatch: description, subagent type, duration,
  tool uses, tokens, `~$` estimate. Sortable by cost descending — the "worst offender" question
  is the one the view exists to answer, so it is the default sort.
- **Rollups.** Today / this week / this month, from `RealUsageSnapshot` and the transcript scan
  that `realUsageMath.ts` already performs.
- **Cache-hit dollar impact.** `cacheHitRate.ts` already computes the ratio; this renders what
  that ratio is worth — the counterfactual cost had every cache read been a fresh input token.
  This is the most actionable number in the view and it currently exists nowhere.
- **Aether's own spend row.** A permanent `$0.00 — no call sites exist` line, sourced from the
  Stage 13.5 guard, so the question *"did Aether do this?"* has a visible answer instead of
  requiring an audit. This is the only surviving piece of the declined COST GUARD card, and it
  belongs here rather than in Settings.
- **Close the stale `collectorStore.ts` dispatch reader** — see below.

## Closing a named Stage 12 gap

The Stage 12 design doc recorded this and left it unscheduled:

> *"`electron/collectorStore.ts`'s dispatch reader is stale… It selects `tool_use_id, tokens,
> tool_uses, duration_ms, started_at_ms, ended_at_ms` only — the Stage 11 schema-v5 columns
> (`agent_id`, `task_kind`, `severity`, `median_ms_at_eval`, `exit_state`, `retries`) exist in
> SQLite but are never read into the viewer. This remains a real, named gap (nothing surfaces
> the collector's persisted telemetry)."*

The Ledger is the natural consumer. Persisted dispatch history is exactly what a ledger needs
to show more than the current session, and `exit_state` / `retries` turn the cost table into a
**cost-of-failure** table: what did the dispatches that failed or retried cost? That is the
Optimize panel's cost-of-thrash thesis, expressed in dollars.

Widening that reader is in scope. Building new Optimize findings on top of it is not.

## Out of scope

- **Per-dispatch exact attribution** (correlating assistant events to open dispatches). Named
  above as the follow-up.
- **Budget enforcement or alerting.** `BudgetAlertsCard` already exists in Settings; the Ledger
  reports, it does not police. Wiring the two together is a later decision.
- **Cross-project rollups.** Single-user, single-cockpit — `docs/privacy-and-data.md`'s
  single-user stance deletes the shared-report scope permanently, and a multi-project roll-up
  is the thin end of it.
- **Historical backfill beyond what the collector already persisted.** If the collector wasn't
  running, that period has no data. The view says so rather than interpolating.
- **Any network call.** Pricing rates are a committed constant, verified by a human at build
  time, not fetched. Stage 13.5's guard test applies unchanged.

## Decisions closed this pass

| Decision | Resolution | Why |
|---|---|---|
| New tab, or fold into Analytics? | New `Ledger` tab | Analytics is token-and-activity shaped; this is money shaped. Folding it in would bury the one number the operator now most wants at a glance. |
| Exact and estimated figures in one table? | Yes, but visually distinguished, with `~` on estimates | Two tables would hide the relationship between session total and its dispatch breakdown. Same table, honest typography. |
| Verify the pricing table, or label the output? | Both | Verification goes stale silently; a visible `PRICING_VERIFIED_AT` makes staleness legible. Neither alone is sufficient. |
| Default sort on the dispatch table? | Cost descending | The view exists to answer "what was the worst offender." Any other default makes the reader work for it. |
| Where does "Aether spent $0" live? | Ledger, not Settings | The COST GUARD card was declined this pass. The claim still needs a home, and it is more useful next to the real spend it is being contrasted against. |
| Widen `collectorStore.ts`'s dispatch reader? | Yes | Named gap since Stage 12, and the Ledger is its first genuine consumer. Closing it here beats leaving it unscheduled for a fourth stage. |

## Known limitations, named plainly

1. **Per-dispatch dollars are estimates** and will not sum exactly to the session total. The UI
   must show the residual rather than silently forcing the numbers to reconcile — a ledger that
   balances by hiding its error is lying.
2. **Pricing is a committed constant.** Correct on the day it was verified; the footer says
   which day.
3. **Cache-read pricing is approximated** at 10% of the tier's input rate. Same treatment.
4. **No data means no data.** Periods where the collector wasn't running render as an explicit
   gap, not as zero. Zero and unknown are different answers and this view of all views must not
   confuse them.
5. **This view cannot see spend that did not pass through a transcript.** A raw API key billed
   by something else entirely — the exact shape of both incidents that motivated this stage —
   is invisible here. The Ledger narrows the search; it does not close it.

Limitation 5 deserves emphasis, because it is the same honesty this project applied to the
IDLE badge and the `logs` persistence exclusion: the looks-alive-isn't failure class. A ledger
showing `$4.12` for the day when the card was charged `$26` must not read as authoritative. The
view's own copy should scope its claim — *"observed in this machine's Claude Code transcripts"*
— rather than implying it is the account's bill.

## Testing

Per convention. Pure logic — cost aggregation, the blended-rate estimator, rollup bucketing,
cache-impact math, the exact-vs-estimate residual — goes in `src/shared/` or
`src/components/ledger/` with matching `*.test.ts`, exhaustively. The widened `collectorStore`
reader gets a test against a fixture SQLite database, matching the existing
`collectorStore.test.ts` pattern. Rendering is component-tested; visual judgment is manual, per
established practice.

## Next step

Hand off to `writing-plans`, saved to
`docs/superpowers/plans/2026-08-05-cost-forensics-stage15.md`.
