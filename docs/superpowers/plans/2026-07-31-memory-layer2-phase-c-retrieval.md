# Memory Layer 2 — Phase C (Retrieval) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `getPrivateCandidates`'s placeholder SQL ordering with the real §4.4 scoring formula, pinned by tests per weight/curve, per `docs/superpowers/specs/2026-07-31-memory-layer2-phase-c-retrieval-design.md`.

**Architecture:** One new pure, exported function (`scorePrivateCandidate`) added to the already-shipped `collector/src/memoryStore.ts`, alongside its existing free functions (`clampSalience`, `findForbiddenContent`). One existing function (`getPrivateCandidates`) modified to use it. No new files, no new dependencies, no caller-visible signature change — `memoryExtractQueue.ts`'s existing call (`store.getPrivateCandidates(item.agentId, 20)`, shipped in the wiring plan) needs no change and starts getting genuinely score-ranked results.

**Tech Stack:** TypeScript (`NodeNext`), `node:sqlite`, Vitest. Same conventions as every other file in `collector/src/`.

## Global Constraints

- Package root: `collector/` (Node >=22.5). Every relative import ends in `.js` (NodeNext). Zero new npm dependencies.
- **This plan modifies `collector/src/memoryStore.ts` directly** — unlike the Phase B and wiring plans, which were explicitly forbidden from touching it. That prohibition doesn't apply here: Phase C's own spec checklist (`AETHER_MEMORY_LAYER_2.md:751-756`) names this file's `getPrivateCandidates` as exactly what Phase C must finish.
- `getPrivateCandidates`'s public signature (`ownerAgent: string, limit = 200`) does not change. Its return type (`MemoryRow[]`) does not change. Only the ordering/selection logic inside it changes.
- All existing exports of `memoryStore.ts` (`createMemoryStore`, `MemoryStore`, `MemoryRow`, `MemoryKind`, etc.) must remain exported with unchanged signatures — this file has real, already-shipped consumers (`memoryExtractQueue.ts`).
- `row.created_at`/`row.updated_at` are **seconds** (the store's existing `now()` convention: `() => Math.floor(Date.now() / 1000)`, `memoryStore.ts:321`). `scorePrivateCandidate`'s `nowSeconds` parameter must be seconds too — no millisecond conversion anywhere in this plan's code.
- Source of truth for every formula/weight/curve: `docs/superpowers/specs/2026-07-31-memory-layer2-phase-c-retrieval-design.md` §1 (as currently committed, post unit-mismatch fix at `6a1179b`).
- Every task's final check runs `npx vitest run` and `npx tsc -b` from `collector/` before commit.

---

### Task 1: `scorePrivateCandidate` — the scoring function, pinned by tests

**Files:**
- Modify: `collector/src/memoryStore.ts`
- Modify: `collector/src/memoryStore.test.ts` (add a new `describe` block; every existing test in this file must keep passing unmodified)

**Interfaces:**
- Produces: `scorePrivateCandidate(row: MemoryRow, nowSeconds: number): number`, exported — used by Task 2. Consumes only the already-exported `MemoryRow`/`MemoryKind` types from the same file.

- [ ] **Step 1: Write the failing tests**

First, read the CURRENT content of `collector/src/memoryStore.ts` in full — in particular the `MemoryRow` interface (fields: `id`, `scope`, `owner_agent`, `kind`, `content`, `status`, `salience`, `subject`, `source_kind`, `source_run_id`, `created_at`, `updated_at`, `asked_at`, `reference_count`) and the existing free functions `clampSalience`/`findForbiddenContent`, so your addition matches the file's exact conventions (JSDoc-free code comments, `// DIVERGENCE:`-style callouts where relevant, etc.).

Add this `describe` block to `collector/src/memoryStore.test.ts` (a new top-level block; do not modify any existing `describe`/`it` in the file):

```typescript
import { scorePrivateCandidate } from './memoryStore.js';

describe('scorePrivateCandidate', () => {
  const NOW = 1_000_000; // seconds, arbitrary fixed epoch matching this file's `clock` convention
  const DAY = 86_400;

  function row(overrides: Partial<MemoryRow> = {}): MemoryRow {
    return {
      id: 1,
      scope: 'private',
      owner_agent: 'CINDER',
      kind: 'habit',
      content: 'x',
      status: null,
      salience: 3,
      subject: null,
      source_kind: 'run',
      source_run_id: null,
      created_at: NOW,
      updated_at: NOW,
      asked_at: null,
      reference_count: 0,
      ...overrides,
    };
  }

  it('weights kind in the order overrule > revision > habit, all else equal', () => {
    const overruleScore = scorePrivateCandidate(row({ kind: 'overrule' }), NOW);
    const revisionScore = scorePrivateCandidate(row({ kind: 'revision' }), NOW);
    const habitScore = scorePrivateCandidate(row({ kind: 'habit' }), NOW);
    expect(overruleScore).toBeGreaterThan(revisionScore);
    expect(revisionScore).toBeGreaterThan(habitScore);
  });

  it('pins the exact kind_weight values (overrule=1.0, revision=0.67, habit=0.33)', () => {
    // With salience=3 (norm 0.6), created_at=updated_at=NOW (recency=1, staleness_risk=0
    // since status defaults to null, not 'open'): score = 2.0*kindWeight + 1.5*0.6 + 1.0*1 - 0 = 2.0*kindWeight + 1.9
    expect(scorePrivateCandidate(row({ kind: 'overrule' }), NOW)).toBeCloseTo(2.0 * 1.0 + 1.9, 5);
    expect(scorePrivateCandidate(row({ kind: 'revision' }), NOW)).toBeCloseTo(2.0 * 0.67 + 1.9, 5);
    expect(scorePrivateCandidate(row({ kind: 'habit' }), NOW)).toBeCloseTo(2.0 * 0.33 + 1.9, 5);
  });

  it('scales linearly with salience via /5 normalization', () => {
    const low = scorePrivateCandidate(row({ salience: 1 }), NOW);
    const mid = scorePrivateCandidate(row({ salience: 3 }), NOW);
    const high = scorePrivateCandidate(row({ salience: 5 }), NOW);
    expect(high).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(low);
    // 1.5 * (salience/5) is the salience term's exact contribution; difference
    // between salience=5 and salience=1 is 1.5 * (5/5 - 1/5) = 1.5 * 0.8 = 1.2
    expect(high - low).toBeCloseTo(1.2, 5);
  });

  it('recency is 1.0 at age zero and 0.5 at exactly 90 days, keyed on created_at not updated_at', () => {
    const fresh = row({ created_at: NOW, updated_at: NOW });
    const ninetyDaysOld = row({ created_at: NOW - 90 * DAY, updated_at: NOW - 90 * DAY });
    const freshScore = scorePrivateCandidate(fresh, NOW);
    const oldScore = scorePrivateCandidate(ninetyDaysOld, NOW);
    // Both have kind='habit', salience=3, status=null (staleness_risk=0) --
    // only recency differs. recency term contribution: 1.0*1.0 vs 1.0*0.5,
    // so the score difference should be exactly 0.5 (the 1.0 coefficient on recency).
    expect(freshScore - oldScore).toBeCloseTo(0.5, 5);
  });

  it('a row updated recently (created long ago) still uses created_at for recency, not updated_at', () => {
    // created 200 days ago, but updated (e.g. via TOUCH) just now -- recency
    // must still reflect the OLD created_at, not the fresh updated_at, per
    // the design doc's explicit "keyed on created_at, never updated_at" rule.
    const oldButTouched = row({ created_at: NOW - 200 * DAY, updated_at: NOW, status: null });
    const trulyFresh = row({ created_at: NOW, updated_at: NOW, status: null });
    expect(scorePrivateCandidate(oldButTouched, NOW)).toBeLessThan(scorePrivateCandidate(trulyFresh, NOW));
  });

  it('staleness_risk is zero for any non-open status, regardless of updated_at age', () => {
    const veryStaleButSettled = row({ status: 'settled', updated_at: NOW - 300 * DAY });
    const veryStaleButMoving = row({ status: 'moving', updated_at: NOW - 300 * DAY });
    const veryStaleButNull = row({ status: null, updated_at: NOW - 300 * DAY });
    const fresh = row({ status: 'settled', updated_at: NOW });
    // All should score identically to their fresh-updated_at counterpart,
    // since staleness_risk only applies to status='open'.
    expect(scorePrivateCandidate(veryStaleButSettled, NOW)).toBeCloseTo(scorePrivateCandidate(fresh, NOW), 5);
    expect(scorePrivateCandidate(veryStaleButMoving, NOW)).toBeCloseTo(scorePrivateCandidate(fresh, NOW), 5);
    expect(scorePrivateCandidate(veryStaleButNull, NOW)).toBeCloseTo(scorePrivateCandidate(fresh, NOW), 5);
  });

  it('staleness_risk grows with updated_at age for open-status rows, 0 at age zero, 0.5 at 90 days', () => {
    const freshOpen = row({ status: 'open', updated_at: NOW });
    const ninetyDayOpen = row({ status: 'open', updated_at: NOW - 90 * DAY });
    const freshScore = scorePrivateCandidate(freshOpen, NOW);
    const staleScore = scorePrivateCandidate(ninetyDayOpen, NOW);
    // staleness_risk term contribution is -0.5*staleness_risk; at 90 days
    // staleness_risk=0.5, so the score difference should be exactly 0.25
    // (0.5 coefficient * 0.5 risk).
    expect(freshScore - staleScore).toBeCloseTo(0.25, 5);
  });

  it('an open row that was just TOUCHed (updated_at reset to now) has near-zero staleness_risk even if created long ago', () => {
    const justTouched = row({ status: 'open', created_at: NOW - 200 * DAY, updated_at: NOW });
    // staleness_risk depends on updated_at only, not created_at -- this row
    // should have staleness_risk ~= 0 despite being old.
    const scoreWithFreshTouch = scorePrivateCandidate(justTouched, NOW);
    const scoreIfNeverTouched = scorePrivateCandidate(
      row({ status: 'open', created_at: NOW - 200 * DAY, updated_at: NOW - 200 * DAY }),
      NOW,
    );
    expect(scoreWithFreshTouch).toBeGreaterThan(scoreIfNeverTouched);
  });

  it('has no overuse/reference_count term at all -- reference_count does not affect score', () => {
    const neverReferenced = row({ reference_count: 0 });
    const heavilyReferenced = row({ reference_count: 500 });
    expect(scorePrivateCandidate(neverReferenced, NOW)).toBe(scorePrivateCandidate(heavilyReferenced, NOW));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `collector/`): `npx vitest run src/memoryStore.test.ts`
Expected: FAIL — `scorePrivateCandidate` is not exported yet.

- [ ] **Step 3: Add the implementation to `memoryStore.ts`**

Add this exported function at module top level, near `clampSalience`/`findForbiddenContent` (both are defined outside `createMemoryStore`'s closure — place this alongside them, not inside the closure):

```typescript
// ---------------------------------------------------------------------------
// Private scoring (§4.4, Phase C)
// ---------------------------------------------------------------------------

/**
 * Weights/half-lives below are Phase C's initial defaults, not tuned values
 * -- Phase E ("parked, needs real traffic") owns tuning. Every constant here
 * is named and isolated specifically so that tuning is a numbers-only change,
 * never a structural one. See
 * docs/superpowers/specs/2026-07-31-memory-layer2-phase-c-retrieval-design.md §1.
 */

// Partial, not a full Record<MemoryKind, number>: shared kinds ('decision',
// 'preference') never reach this function -- getPrivateCandidates only ever
// queries scope='private' rows -- so they have no entry here.
const KIND_WEIGHT: Partial<Record<MemoryKind, number>> = {
  overrule: 1.0,
  revision: 0.67,
  habit: 0.33,
};

const RECENCY_HALF_LIFE_DAYS = 90;
const STALENESS_HALF_LIFE_DAYS = 90;
const SECONDS_PER_DAY = 86_400;

/**
 * score = 2.0*kind_weight + 1.5*salience(norm) + 1.0*recency - 0.5*staleness_risk
 *
 * `nowSeconds` matches the store's own now() convention exactly (seconds,
 * not milliseconds) -- see this file's `now` in MemoryStoreOptions. Pure,
 * no I/O, independently testable without a store.
 *
 * DIVERGENCE from Miriel: no `overuse` term. §4.4: "an agent that keeps
 * reaching for the same overrule is an agent that keeps hitting the same
 * wall, and that is signal, not noise."
 */
export function scorePrivateCandidate(row: MemoryRow, nowSeconds: number): number {
  const kindWeight = KIND_WEIGHT[row.kind] ?? 0;
  const salienceNorm = row.salience / 5;

  // Keyed on created_at, NEVER updated_at or a "last surfaced" timestamp --
  // §4.4's own documented trap: surfacing a memory must never raise its own
  // future score.
  const ageDaysSinceCreated = (nowSeconds - row.created_at) / SECONDS_PER_DAY;
  const recency = Math.pow(0.5, ageDaysSinceCreated / RECENCY_HALF_LIFE_DAYS);

  // Zero for any non-'open' status. Keyed on updated_at, which TOUCH
  // legitimately resets -- a TOUCHed open row's staleness_risk resetting is
  // correct (the extractor re-confirmed it's still live), not the same
  // feedback trap as recency/surfacing.
  const ageDaysSinceUpdated = (nowSeconds - row.updated_at) / SECONDS_PER_DAY;
  const stalenessRisk =
    row.status === 'open' ? 1 - Math.pow(0.5, ageDaysSinceUpdated / STALENESS_HALF_LIFE_DAYS) : 0;

  return 2.0 * kindWeight + 1.5 * salienceNorm + 1.0 * recency - 0.5 * stalenessRisk;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/memoryStore.test.ts`
Expected: PASS — all pre-existing Phase A tests in this file plus the 9 new `scorePrivateCandidate` tests.

- [ ] **Step 5: Commit**

```bash
cd collector
git add src/memoryStore.ts src/memoryStore.test.ts
git commit -m "feat(memory-layer-2): add scorePrivateCandidate, pinning every §4.4 weight"
```

---

### Task 2: Wire `scorePrivateCandidate` into `getPrivateCandidates`

**Files:**
- Modify: `collector/src/memoryStore.ts`
- Modify: `collector/src/memoryStore.test.ts` (add cases; existing cases must keep passing unmodified)

**Interfaces:**
- Consumes: `scorePrivateCandidate` (Task 1, same file).
- Produces: nothing new — `getPrivateCandidates`'s existing exported signature is unchanged; this task only changes its internal ranking, which is `memoryExtractQueue.ts`'s existing (unmodified, out of scope here) consumer's concern only insofar as ordering now reflects real scoring.

- [ ] **Step 1: Write the failing tests**

First, read the CURRENT content of `collector/src/memoryStore.ts`, specifically `stmtPrivate`'s definition and `getPrivateCandidates`'s current body, so your edit targets the real current code exactly.

Add these `it` blocks inside the existing `describe('...')` block in `collector/src/memoryStore.test.ts` that already covers `getPrivateCandidates` (search the file for its existing private-candidate tests and add alongside them, following the file's established `beforeEach`/`clock`/`cinder` conventions already shown at the top of the file):

```typescript
it('getPrivateCandidates orders by score, not raw salience/updated_at', () => {
  // A low-salience 'overrule' should outrank a high-salience 'habit', because
  // kind_weight (coefficient 2.0) dominates salience (coefficient 1.5) at
  // these values: overrule score ≈ 2.0*1.0 + 1.5*0.2 + 1.0 = 3.3;
  // habit score ≈ 2.0*0.33 + 1.5*1.0 + 1.0 = 3.16. The OLD placeholder
  // ordering (ORDER BY salience DESC) would have put the habit row first;
  // the real formula puts the overrule row first.
  store.applyOps([{ op: 'ADD', kind: 'overrule', content: 'Low-salience overrule.', salience: 1 }], cinder);
  store.applyOps([{ op: 'ADD', kind: 'habit', content: 'High-salience habit.', salience: 5 }], cinder);

  const results = store.getPrivateCandidates('CINDER');
  expect(results[0].kind).toBe('overrule');
  expect(results[1].kind).toBe('habit');
});

it('getPrivateCandidates still respects the caller-supplied limit after scoring', () => {
  for (let i = 0; i < 10; i++) {
    store.applyOps([{ op: 'ADD', kind: 'habit', content: `Habit ${i}.`, salience: 3 }], cinder);
  }
  const results = store.getPrivateCandidates('CINDER', 3);
  expect(results).toHaveLength(3);
});

it('getPrivateCandidates never returns a shared-scope row, regardless of score', () => {
  store.applyOps([{ op: 'ADD', kind: 'decision', content: 'A shared decision.', salience: 5 }], steward);
  store.applyOps([{ op: 'ADD', kind: 'habit', content: 'A private habit.', salience: 1 }], cinder);

  const results = store.getPrivateCandidates('CINDER');
  expect(results).toHaveLength(1);
  expect(results[0].kind).toBe('habit');
});

it('getPrivateCandidates still requires an ownerAgent (scope enforcement unchanged)', () => {
  expect(() => store.getPrivateCandidates('')).toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/memoryStore.test.ts`
Expected: FAIL — the first new test fails (current placeholder ordering puts the habit row first, not the overrule row); the other three may already pass against the old implementation (limit/scope enforcement predate this task) but must be re-verified passing after Step 3's change.

- [ ] **Step 3: Modify `getPrivateCandidates` and its backing statement**

Locate `stmtPrivate`'s definition (currently something like):

```typescript
const stmtPrivate = db.prepare(`
  SELECT * FROM memories WHERE scope = 'private' AND owner_agent = ?
  ORDER BY salience DESC, updated_at DESC
  LIMIT ?
`);
```

Add a new constant near the top of `createMemoryStore` (or alongside `EXISTING_MEMORIES_LIMIT`-style constants elsewhere in this codebase's convention — place it near `stmtPrivate`'s definition):

```typescript
// Internal pre-filter only, not the final ranking -- scorePrivateCandidate
// (§4.4, Phase C) does the real ranking in JS after this SQL query bounds
// the scan. Comfortably above getPrivateCandidates's public default (200)
// so the pre-filter essentially never discards a row a default-limit caller
// would have wanted, while still bounding a pathologically large private set.
const PRIVATE_CANDIDATE_INTERNAL_CAP = 500;
```

`stmtPrivate`'s own `ORDER BY`/`LIMIT` can stay as-is (it's now just a pre-filter, not the final order) — but change its bound parameter usage in `getPrivateCandidates`'s body, not the prepared statement text itself, per the step below. (If the prepared statement's `LIMIT ?` placeholder makes this awkward, it is acceptable to also simplify `stmtPrivate`'s SQL to drop its `ORDER BY` entirely, since JS re-sorts afterward — either is fine; pick whichever keeps the diff smaller given the actual current file content.)

Replace `getPrivateCandidates`'s current body:

```typescript
function getPrivateCandidates(ownerAgent: string, limit = 200): MemoryRow[] {
  if (!ownerAgent) throw new Error('getPrivateCandidates requires an ownerAgent');
  return stmtPrivate.all(ownerAgent, limit).map((r) => plain<MemoryRow>(r));
}
```

with:

```typescript
/**
 * Private candidates for one agent, ranked by scorePrivateCandidate (§4.4,
 * Phase C) -- not raw SQL order. `ownerAgent` is required and there is no
 * overload that omits it: cross-agent private reads are impossible by
 * construction, not by convention (Layer 1 §8).
 */
function getPrivateCandidates(ownerAgent: string, limit = 200): MemoryRow[] {
  if (!ownerAgent) throw new Error('getPrivateCandidates requires an ownerAgent');
  const t = now();
  return stmtPrivate
    .all(ownerAgent, PRIVATE_CANDIDATE_INTERNAL_CAP)
    .map((r) => plain<MemoryRow>(r))
    .map((row) => ({ row, score: scorePrivateCandidate(row, t) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.row);
}
```

(`now()` is the same injectable clock every write path in this file already uses — do not introduce a new clock source. `plain<MemoryRow>` is the existing helper already used elsewhere in this file for normalizing `node:sqlite`'s null-prototype row objects.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/memoryStore.test.ts`
Expected: PASS — every pre-existing test in the file, Task 1's 9 new tests, and Task 2's 4 new tests.

- [ ] **Step 5: Run the full collector suite and TypeScript build**

Run (from `collector/`): `npx vitest run`
Expected: PASS — every file in the package, including `memoryExtractQueue.test.ts` (an existing, unmodified consumer of `getPrivateCandidates` via `store.getPrivateCandidates(...)` in its own tests) must still pass unchanged, since the public signature and return shape are unchanged.

Run: `npx tsc -b`
Expected: exits 0, no errors.

- [ ] **Step 6: Update the Phase C checklist in the Layer 2 spec**

In `docs/superpowers/specs/AETHER_MEMORY_LAYER_2.md`, replace the Phase C block (currently around lines 751-756):

```markdown
### Phase C — retrieval

- [ ] Unconditional shared injection
- [ ] Private scoring function
- [ ] Tests pinning every weight (the Miriel discipline — a memory that quietly
      drifts is worse than no memory at all)
```

with:

```markdown
### Phase C — retrieval — ✅ WRITTEN AND GREEN

- [x] Unconditional shared injection — already done in Phase A (`getShared()`,
      `memoryStore.ts`); nothing to build
- [x] Private scoring function — `scorePrivateCandidate` in `memoryStore.ts`,
      wired into `getPrivateCandidates`; see
      `docs/superpowers/specs/2026-07-31-memory-layer2-phase-c-retrieval-design.md`
      for the exact formula and the initial weight/half-life defaults
- [x] Tests pinning every weight (the Miriel discipline — a memory that quietly
      drifts is worse than no memory at all) — 9 tests in `memoryStore.test.ts`
      pin `kind_weight`, salience normalization, the recency curve (keyed on
      `created_at`, never `updated_at`), and the staleness_risk curve
      (`open`-status only, keyed on `updated_at`)

**Status: Phase C is written and green.** No caller-visible signature change —
`memoryExtractQueue.ts`'s existing `getPrivateCandidates` call (Phase B
wiring) needed no change and now receives genuinely score-ranked results.
Weights and half-lives are Phase C's initial defaults, not tuned values —
Phase E owns tuning against real traffic.
```

- [ ] **Step 7: Commit**

```bash
git add collector/src/memoryStore.ts collector/src/memoryStore.test.ts docs/superpowers/specs/AETHER_MEMORY_LAYER_2.md
git commit -m "feat(memory-layer-2): rank getPrivateCandidates by score, close out Phase C"
```

---

## What this plan deliberately does not cover

(Mirrors `docs/superpowers/specs/2026-07-31-memory-layer2-phase-c-retrieval-design.md` §3.)

- **Tuning the weights/half-lives against real traffic.** Explicitly Phase E's job. Every constant this plan adds is named and isolated for exactly that future change.
- **`getShared()` changes.** Already correct from Phase A; not touched by this plan.
- **The Memory view (Phase D).** Nothing in this plan renders anything.
- **A non-linear salience normalization.** No evidence supports one; a Phase E change if real traffic later shows otherwise.
