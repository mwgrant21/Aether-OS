# Memory Layer 2 — Phase C (Retrieval) Design

**Design document**
Status: approved, ready for implementation plan
Companion to: `AETHER_MEMORY_LAYER_2.md` §4.4 (Phase C is this section's build item)

---

## 0. What this is

Phase C's spec checklist (`AETHER_MEMORY_LAYER_2.md:751-756`):

```
- [ ] Unconditional shared injection
- [ ] Private scoring function
- [ ] Tests pinning every weight
```

**Item 1 is already done.** `createMemoryStore`'s `getShared()` (`memoryStore.ts:696-699`, shipped in Phase A) already reads every in-force shared judgment unconditionally — no scoring, no cap, no relevance filter, exactly per §4.4. Nothing to build.

**Item 2 is not done.** `getPrivateCandidates` (`memoryStore.ts:701-709`) currently orders candidates with a placeholder SQL clause — `ORDER BY salience DESC, updated_at DESC` — not the formula §4.4 actually specifies. This document designs and replaces that with the real scoring function.

**Item 3 follows from item 2**: once the formula is a named, testable function, pin every weight and curve with unit tests — the "Miriel discipline" the spec repeatedly invokes (a memory that quietly drifts is worse than no memory at all).

---

## 1. The formula

From `AETHER_MEMORY_LAYER_2.md` §4.4:

```
score = 2.0·kind_weight + 1.5·salience + 1.0·recency − 0.5·staleness_risk
```

The spec gives the shape, the relative coefficients, and qualitative behavior for each term, but not exact numbers — and Phase E (`docs/superpowers/specs/AETHER_MEMORY_LAYER_2.md:764-766`) explicitly parks precise tuning as future work needing real traffic. This document picks concrete, defensible defaults and documents them as exactly that: a first cut, not a tuned result.

### 1.1 `kind_weight`

Spec: *"`overrule` outranks `revision` outranks `habit`. An agent should reach its own reversals first."* Three-tier ordinal, normalized to `[0, 1]` so it composes cleanly with the other 0-1-ish terms under the formula's coefficients:

```ts
// Partial, not a full Record<MemoryKind, number>: shared kinds ('decision',
// 'preference') never reach this function -- getPrivateCandidates only ever
// queries scope='private' rows -- so they have no entry here.
const KIND_WEIGHT: Partial<Record<MemoryKind, number>> = {
  overrule: 1.0,
  revision: 0.67,
  habit: 0.33,
};
```

### 1.2 `salience`

Spec: *"extractor's 1–5 judgment, normalised. Ported from Miriel intact."* Normalized as `salience / 5`, giving `[0.2, 1.0]` — the simplest linear normalization consistent with "ported... intact" (Miriel's own salience column is the same 1-5 int, and nothing in the spec suggests a nonlinear transform).

### 1.3 `recency`

Spec: *"decays over ~90 days since written, not since surfaced."* Exponential decay from `created_at`, half-life 90 days — a common, well-understood decay shape, and "half-life" is a natural reading of "decays over ~90 days":

```
recency = 0.5 ^ (ageDaysSinceCreated / 90)
```

`recency(0) = 1.0`, `recency(90) = 0.5`, `recency(180) = 0.25`, asymptotic toward 0. Deliberately keyed on `created_at`, never `updated_at` or a "last surfaced" timestamp — the spec's own point (§4.4's "the trap this creates, found the hard way in Phase A") is that surfacing must never feed back into score, and this document's `recency` term does not touch `TOUCH`'s `updated_at` bump at all.

### 1.4 `staleness_risk`

Spec: *"grows with `updated_at` age for `open`-status entries only. An unsettled judgment that has not moved in months is more likely to be about a world that changed than one settled long ago."*

- **Zero for any non-`'open'` status** (`'moving'`, `'settled'`, or `null`) — the risk this term models only applies to a judgment still marked as unresolved.
- For `'open'` rows, grows from 0 toward 1 with the same 90-day half-life character as recency, but inverted (risk *rises* with age rather than falling):

```
staleness_risk = status === 'open'
  ? 1 - 0.5 ^ (ageDaysSinceUpdated / 90)
  : 0
```

`staleness_risk(0) = 0`, `staleness_risk(90) = 0.5`, `staleness_risk(180) = 0.75`, asymptotic toward 1. Keyed on `updated_at`, which `TOUCH` legitimately bumps (§4.4: *"the extractor saw this again and it is still live"* — a `TOUCH`ed open row resetting its staleness_risk is correct, not the same feedback trap as `recency`/surfacing, because `TOUCH` is the extractor re-confirming the judgment is still live, not merely a read-side surfacing event).

### 1.5 Composition

```ts
function scorePrivateCandidate(row: MemoryRow, nowMs: number): number {
  const kindWeight = KIND_WEIGHT[row.kind] ?? 0;
  const salienceNorm = row.salience / 5;
  const ageDaysSinceCreated = (nowMs / 1000 - row.created_at) / 86_400;
  const recency = Math.pow(0.5, ageDaysSinceCreated / 90);
  const ageDaysSinceUpdated = (nowMs / 1000 - row.updated_at) / 86_400;
  const stalenessRisk = row.status === 'open' ? 1 - Math.pow(0.5, ageDaysSinceUpdated / 90) : 0;
  return 2.0 * kindWeight + 1.5 * salienceNorm + 1.0 * recency - 0.5 * stalenessRisk;
}
```

(`row.created_at`/`row.updated_at` are seconds, per the store's existing `now()` convention — `memoryStore.ts:321`; `nowMs` here is milliseconds to match `Date.now()`/injectable-clock convention elsewhere in this plan's own code, converted once at the top.)

No `overuse` term — the spec is explicit this is deliberate (§4.4: *"an agent that keeps reaching for the same overrule is an agent that keeps hitting the same wall, and that is signal, not noise"*). This document does not add one.

---

## 2. Where this lands

`memoryStore.ts` (already shipped) is the only file this document modifies. Two changes:

1. **New exported pure function** `scorePrivateCandidate(row: MemoryRow, nowMs: number): number` — same file, alongside the existing `clampSalience`/`findForbiddenContent` free functions, so it is independently unit-testable without spinning up a store.
2. **`getPrivateCandidates` re-implemented** to use it: fetch a bounded candidate set from SQLite (existing `stmtPrivate`, but widen its `ORDER BY`/`LIMIT` to a generous internal cap — e.g. 500 — since the real ranking now happens in JS, not SQL), score each row with `scorePrivateCandidate`, sort descending by score, then slice to the caller's requested `limit`. `getPrivateCandidates`'s own public signature (`ownerAgent: string, limit = 200`) does not change — only what determines the returned order and which rows survive the cut.

```ts
function getPrivateCandidates(ownerAgent: string, limit = 200): MemoryRow[] {
  if (!ownerAgent) throw new Error('getPrivateCandidates requires an ownerAgent');
  const now = Date.now();
  return stmtPrivate
    .all(ownerAgent, PRIVATE_CANDIDATE_INTERNAL_CAP)
    .map((r) => plain<MemoryRow>(r))
    .map((row) => ({ row, score: scorePrivateCandidate(row, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.row);
}
```

`stmtPrivate`'s SQL `ORDER BY`/`LIMIT` becomes an internal pre-filter only (bound the SQLite scan for a pathologically large private memory set), not the final ranking — the real ranking is `scorePrivateCandidate`'s job. `PRIVATE_CANDIDATE_INTERNAL_CAP` is a new constant (proposed: 500 — comfortably above the `getPrivateCandidates` public default of 200, so the pre-filter essentially never discards a row a caller with the default limit would have wanted, while still bounding pathological cases).

**No caller-visible signature change.** `memoryExtractQueue.ts`'s existing `store.getPrivateCandidates(item.agentId, 20)` call (Phase B/wiring, already shipped) needs no change — it starts returning genuinely score-ranked results instead of the placeholder ordering, which is a strict improvement to the extraction prompt's existing-memories context with zero call-site changes required.

---

## 3. What this document deliberately does not cover

- **Tuning the weights/half-lives against real traffic.** Explicitly Phase E's job (`AETHER_MEMORY_LAYER_2.md:764-766`), not this document's. Every constant here is named and isolated specifically so Phase E can change them without touching the formula's structure.
- **`getShared()` changes.** Already correct from Phase A; not touched.
- **The Memory view (Phase D).** Nothing here renders anything; `getPrivateCandidates` already has one real caller (`memoryExtractQueue.ts`) and this document doesn't add a second one.
- **A `salience` normalization scheme other than linear `/5`.** No evidence in the spec or Miriel's port notes suggests otherwise; if real traffic later shows salience should be non-linear, that's a Phase E tuning change, not a structural one.
