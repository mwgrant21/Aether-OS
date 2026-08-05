# Cost Forensics Implementation Plan (Stage 15)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `Ledger` view that answers "what did today cost me, and which dispatch was the
worst offender" from data already on this machine — with exact session totals, honestly-labelled
per-dispatch estimates, cache-hit dollar impact, and a permanent record that Aether's own spend
is structurally zero.

**Architecture:** Four movements. (1) Fix the foundation — verify the pricing table and add a
verification stamp, so no dollar figure in the view rests on a placeholder. (2) Widen
`electron/collectorStore.ts`'s dispatch reader to the schema-v5 columns it has been ignoring
since Stage 11, closing a gap named in the Stage 12 spec. (3) Build the aggregation layer as
pure, exhaustively-tested math in `src/shared/ledgerMath.ts`, keeping exact and estimated
figures in separate types so the distinction cannot be lost by accident. (4) Build the view.

**Tech Stack:** TypeScript (strict), React 18, Electron, Vitest.

## Global Constraints

- Full spec: `docs/superpowers/specs/2026-08-05-cost-forensics-stage15-design.md`. **Read "The
  data reality" and "Known limitations" before writing code** — this stage's failure mode is a
  view that looks precise and is wrong, and both sections exist to prevent it.
- **Exact and estimated figures must be different types, not the same type with a flag.**
  `ExactCost` and `EstimatedCost` as distinct shapes means the compiler catches a place that
  renders one as the other. A boolean field means it catches nothing.
- **No network call, ever.** Pricing rates are a committed constant verified by a human.
  `src/shared/noApiCalls.test.ts` (Stage 13.5) applies unchanged, including its generic
  `MODEL_ID_SHAPE` check — this stage will add model-tier strings to a pricing table, and
  `modelPricing.ts` must be added to that test's `LITERAL_EXCEPTIONS` **with a comment naming
  why**, exactly as `optimizeRules.ts` already is, if any new literal trips it.
- **Zero and unknown are different answers.** Any period with no collector data renders as an
  explicit gap. Do not default a missing bucket to `0` anywhere in the aggregation layer — make
  the type `number | null` and force every renderer to handle it.
- `npm test`, `npm run build`, and `npm run electron:build` clean before every commit. Task 2
  touches `electron/`.
- Use `useColors()` and the `Button` primitive per established conventions.

---

### Task 1: Verify and stamp the pricing table

**Files:**
- Modify: `src/shared/modelPricing.ts`, `src/shared/modelPricing.test.ts`

**Interfaces:**
- Provides (new): `PRICING_VERIFIED_AT: string` (an ISO date), consumed by the Ledger footer.
- Preserves: `PRICING_PER_MILLION_TOKENS`, `pricingTierForModel`, `costForEvent` — signatures
  unchanged, because `optimizeRules.ts` consumes `costForEvent` and must stay green.

**Steps:**
- [ ] **Ask the operator to verify the rates against Anthropic's current published pricing**
      before changing any number. This is a human verification step, not a lookup task — the
      plan cannot fetch it and must not guess. If the operator is unavailable, leave the numbers
      untouched and set `PRICING_VERIFIED_AT` to the date of the existing comment, so the
      staleness is at least legible. Do not silently invent rates.
- [ ] Add `export const PRICING_VERIFIED_AT = 'YYYY-MM-DD';` with a comment stating what was
      checked and against what source.
- [ ] Rewrite the file's header comment: it currently says the rates are PLACEHOLDERS. After
      this task it should say what they actually are and when they were last confirmed. If they
      remain unverified, say *that* — a comment that lies about its own confidence is worse than
      the placeholder warning it replaced.
- [ ] Same treatment for `CACHE_READ_DISCOUNT`. Its comment already admits it is "a reasonable
      approximation for v1" — either confirm it or keep the admission and surface it in the UI
      (Task 4 renders the pricing basis; this is what it renders).
- [ ] Add a test asserting `PRICING_VERIFIED_AT` parses as a valid date and is not in the
      future. Trivial, but it stops a typo from rendering as garbage in the footer.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean — **including `optimizeRules.test.ts`**,
      which has cost assertions that will move if any rate changed. If they move, update them and
      say so in the commit body; do not loosen the assertions to accommodate.
- [ ] Commit: `feat(ledger): verify and stamp the model pricing table`

---

### Task 2: Widen the collector dispatch reader

**Files:**
- Modify: `electron/collectorStore.ts`, `electron/collectorStore.test.ts`
- Modify: `src/state/types.ts` (the `DiagnosticsSnapshot` shape, if dispatch rows flow through it)

**Interfaces:**
- Extends the dispatch row shape with the schema-v5 columns: `agent_id`, `task_kind`,
  `severity`, `median_ms_at_eval`, `exit_state`, `retries`.

**Steps:**
- [ ] Read `collector/src/schema.ts` first to confirm the exact v5 column names and types, and
      `collector/src/personalitySpine.ts` for the `ExitState` / `Severity` type definitions —
      reuse those types rather than redeclaring them viewer-side.
- [ ] Widen the `SELECT` in `collectorStore.ts`'s dispatch reader and extend its returned row
      type. This closes the gap named in
      `docs/superpowers/specs/2026-08-03-voice-packs-stage12-design.md` §"Gaps found in the
      existing codebase" item 1 — **cite that document in the code comment** so the closure is
      discoverable from the gap's original home.
- [ ] **Handle the schema-version mismatch case explicitly.** A collector database written
      before v5 will not have these columns. Detect the schema version (the collector tracks it)
      and return `null` for the new fields rather than throwing — an operator with an old
      database should get a degraded Ledger, not a crash. Test this path with a fixture.
- [ ] Extend `collectorStore.test.ts` against a fixture database covering: a v5 row with all
      columns, a pre-v5 row, and a row with `exit_state` fatal and `retries > 0` (the
      cost-of-failure case the Ledger will surface).
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run electron:build` clean.
- [ ] Commit: `feat(ledger): read the schema-v5 dispatch columns the viewer has been ignoring`

---

### Task 3: The aggregation layer

**Files:**
- Create: `src/shared/ledgerMath.ts`, `src/shared/ledgerMath.test.ts`

**Interfaces:**
- Consumes: `costForEvent`, `pricingTierForModel`, `PRICING_PER_MILLION_TOKENS` from
  `modelPricing.ts`; `TranscriptEvent` from `electron/transcriptParser.ts`;
  `CompletedDispatchUsage` from `src/state/liveAgentsMath.ts`; `RealUsageSnapshot`;
  `cacheHitRate.ts`.
- Provides: `ExactCost`, `EstimatedCost`, `sessionLedger()`, `estimateDispatchCost()`,
  `bucketByDay()`, `cacheImpact()`, `reconcile()`.

**Steps:**
- [ ] Define the two cost types as **structurally distinct**, per the Global Constraints:
      `ExactCost { usd: number; breakdown: { input; output; cacheCreation; cacheRead } }` and
      `EstimatedCost { usdApprox: number; basis: 'blended-tier-rate'; tokens: number }`. No
      shared supertype that would let one substitute for the other.
- [ ] `sessionLedger(events)`: sum `costForEvent` across assistant events, returning an
      `ExactCost` with the four-way breakdown preserved. This is the Tier 1 path and it is the
      only exact number in the stage.
- [ ] `estimateDispatchCost(dispatch)`: apply a blended rate for the dispatch's model tier to
      `CompletedDispatchUsage.tokens`. **Document the blend ratio and why it was chosen** — a
      scalar token count with no input/output split forces an assumption about the mix, and that
      assumption is the estimate's entire error term. Pick a defensible ratio, write down the
      reasoning, and note that a real mix skews cheaper or dearer depending on how output-heavy
      the dispatch was.
- [ ] `reconcile(exact, estimates)`: return the residual between the session total and the sum
      of dispatch estimates. **Do not normalize it away.** The spec is explicit: a ledger that
      balances by hiding its error is lying. The view renders this residual.
- [ ] `bucketByDay(events, tz)`: day/week/month buckets returning `number | null` per bucket —
      `null` for periods with no data, never `0`. Take the timezone explicitly rather than
      reading the system default inside the function, so the tests are deterministic.
- [ ] `cacheImpact(events)`: the counterfactual — what the cache reads would have cost at full
      input rate, minus what they did cost. This is the view's most actionable number.
- [ ] Exhaustive unit tests. The project's testing philosophy is explicit that pure logic gets
      exhaustive coverage, and every number in this view flows through this file. Cover at
      minimum: empty input, a single event, mixed model tiers in one session, a zero-token
      dispatch, a period with no data (asserting `null`, not `0`), and a reconciliation with a
      non-zero residual.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean.
- [ ] Commit: `feat(ledger): add the cost aggregation layer`

---

### Task 4: The Ledger view

**Files:**
- Create: `src/components/ledger/LedgerView.tsx`, `SessionCostCard.tsx`, `DispatchCostTable.tsx`,
  `RollupCard.tsx`, `CacheImpactCard.tsx`, `PricingBasisFooter.tsx`
- Create: `src/components/ledger/DispatchCostTable.test.tsx`, `LedgerView.test.tsx`
- Modify: `src/viewRegistry.ts`, `src/viewRegistry.test.ts`

**Interfaces:**
- Consumes: `ledgerMath.ts`, `useAetherStore`, `useColors`, `Button`,
  `aetherElectron.diagnostics.onSnapshot` (for persisted dispatch history).

**Steps:**
- [ ] `viewRegistry.ts`: add `{ id: 'Ledger', inTopBar: true, inSidebar: true, component: LedgerView }`.
      Update `viewRegistry.test.ts`. Place it adjacent to `Analytics` in the array — related
      neighbourhood, distinct concern.
- [ ] `SessionCostCard.tsx`: the exact session total with its four-way breakdown and the model
      tier(s) involved. No `~`, because this figure is exact to the pricing table.
- [ ] `DispatchCostTable.tsx`: one row per completed dispatch — description, subagent type,
      duration, tool uses, tokens, `~$` estimate, and (from Task 2) `exit_state` / `retries`
      when available. **Default sort: cost descending.** Rows with a fatal exit or retries > 0
      get the anomaly-adjacent treatment already established elsewhere in the app — this is the
      cost-of-failure view and those rows are the point.
- [ ] **Every estimated figure carries a `~` and a tooltip** naming the basis (`blended tier
      rate applied to a scalar token count; no input/output split is available from the
      completion notification`). Do not shorten this to "estimated" — the operator will want to
      know *why* when it matters.
- [ ] Render the reconciliation residual visibly, as its own row or footnote: *"dispatch
      estimates account for $X of the $Y session total; $Z unattributed."* Never hide it.
- [ ] `RollupCard.tsx`: today / week / month. A `null` bucket renders as `no data — collector
      not running` **and never as `$0.00`**. This is the single most important rendering rule in
      the view.
- [ ] `CacheImpactCard.tsx`: the counterfactual saving from `cacheImpact()`, alongside the
      existing hit ratio from `cacheHitRate.ts`.
- [ ] Add the **Aether spend row**: a permanent `Aether OS itself: $0.00 — no model call sites
      exist` line, with a short note pointing at `src/shared/noApiCalls.test.ts` as what
      guarantees it. This is the surviving piece of the declined COST GUARD card.
- [ ] `PricingBasisFooter.tsx`: renders `PRICING_VERIFIED_AT`, the per-tier rates in use, and
      the cache-read discount. Small, dim, always present. This is what stops the table from
      silently aging into wrong.
- [ ] **Scope the view's claim in its own copy.** A header line reading *"observed in this
      machine's Claude Code transcripts"* — not *"your bill."* The spec's Limitation 5 is that
      spend outside a transcript is invisible here, which is precisely the shape of both
      incidents that motivated the stage. The view must not read as authoritative about the
      account.
- [ ] Component tests: the table sorts by cost descending by default; an estimated figure
      renders its `~`; a `null` rollup bucket renders the no-data state and not `$0.00`; the
      residual row appears when the residual is non-zero.
- [ ] Verify: `npx tsc -b` clean, `npx vitest run` clean, `npm run build` clean,
      `npm run electron:build` clean.
- [ ] Commit: `feat(ledger): add the Cost Forensics view`

---

### Task 5: Documentation

**Files:**
- Modify: `CLAUDE.md`, `docs/roadmap.md`, `README.md`, `PROGRESS.md`
- Modify: `docs/superpowers/specs/2026-08-03-voice-packs-stage12-design.md` (gap closure note)

**Steps:**
- [ ] `CLAUDE.md`: add `ledger/` to the architecture map. Add a convention note: **exact and
      estimated cost figures are distinct types and must stay that way** — this is the kind of
      rule that erodes silently once someone finds it inconvenient.
- [ ] `docs/roadmap.md`: add the Stage 15 row in the established format.
- [ ] `docs/superpowers/specs/2026-08-03-voice-packs-stage12-design.md`: annotate the §"Gaps
      found in the existing codebase" item 1 as **closed by Stage 15**, with a link. The gap was
      named honestly there; closing it silently elsewhere would leave the original reader with a
      stale warning — the same dangling-citation class the roadmap §3.4 and the CLAUDE.md MSVC
      gotcha both had to correct.
- [ ] `README.md`: describe the Ledger, using the scoped claim, not "your bill."
- [ ] `PROGRESS.md`: entry in the established format, stating plainly: (a) whether the pricing
      table was actually verified by the operator or left stamped-but-unverified; (b) the
      blend-ratio assumption in `estimateDispatchCost` and its error direction; (c) that the
      residual is rendered rather than normalized; (d) that periods without collector data
      render as gaps, not zeroes; (e) **Limitation 5 — spend that did not pass through a
      transcript is invisible here, which includes the exact failure mode of both incidents that
      motivated this stage.** Do not let the entry oversell what shipped.
- [ ] Commit: `docs: record the Stage 15 Cost Forensics ledger`

---

After all five tasks: whole-branch review. Three questions the reviewer must answer explicitly:

1. **Can an estimated figure render anywhere without its `~` and its basis?** Answer by reading
   the components, not by trusting the types.
2. **Does any code path turn a missing bucket into `$0.00`?**
3. **Does the view's copy claim more than the data supports?** Specifically: could an operator
   read this view, see a small number, and conclude their account was not charged? If yes, the
   copy is wrong regardless of whether the math is right.
