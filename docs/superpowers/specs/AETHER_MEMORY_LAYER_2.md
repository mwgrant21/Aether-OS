# Aether OS — Agent Memory Layer

**Design document**
Status: draft for implementation
Last updated: 2026-07-27
Revision: 1.1 (toolchain constraint lifted; §9 #3 closed)
Companion to: `AGENT_PERSONALITY_LAYER_1.md` (§3, §7, §8, §10)
Source assessment: `Miriels-publish/data/memory-{store,engine}.js`, read 2026-07-27

---

## 0. What this is

Layer 1 gave agents a *voice*. This gives them a *past*.

Specifically: the durable store behind §10 of the personality document — what an
agent is allowed to remember about you between sessions, how it gets written,
how it gets retrieved, and how it is destroyed when it stops being true.

Roughly 60–70% of this is a port of the Miriel memory engine, which solved a
structurally similar problem for a tarot reader and solved several parts of it
better than a from-scratch attempt would. The port boundary is drawn in §2. The
parts that do not port are not incidental gaps — they are places where a tarot
reader and a code critic have **opposite failure modes**, and each one is called
out as such.

**Non-goal:** same as Layer 1. This is a personal cockpit. Nothing here is
designed for other users, multi-tenancy, or configurability.

---

## 1. Governing principles

Layer 2 adds no new principles. It inherits Layer 1's four, and one house rule
from `CLAUDE.md` that turns out to be the same rule wearing a different hat.

| | |
|---|---|
| **P1** — telemetry underneath, personality on top | Memory is written by a cheap extractor and validated by the runtime. An agent never writes its own memory directly, exactly as it never reports its own severity. |
| **P2** — escalate on taste, never on facts | Memory stores *your* judgments. Anything a command can settle is not memory, it is a lookup. |
| **P3** — remember judgments, never state | The load-bearing one. Everything in §5 (invalidation) is P3 with teeth. |
| **P4** — findings survive social pressure | §6's `Revision` audit trail. A stored concession must record *why*. |
| **House rule** — *store the signal, not the payload* (`CLAUDE.md`) | No source code, no command strings, no tool outputs, no prompts in the store. This is P3 restated as a privacy control, and the two reinforce each other: content that cannot be stored cannot go stale. |

### The filter for anything new

Layer 1's filter was *"does it let me know something faster?"* Layer 2's is
narrower and harsher:

> **If this entry were wrong, how would I find out?**

An entry with no answer to that question does not get stored. This single test
kills cached findings, kills location-anchored judgments, and kills suppression
rules — the three failure modes §10 named — without needing three separate rules.

---

## 2. The port boundary

Drawn explicitly so that "we ported Miriel" never becomes a vague claim.

### Ported substantially intact

**The atom store shape.** One typed row per specific sentence, closed enums
validated before write, provenance columns, guarded `ALTER TABLE` migrations
(because `CREATE TABLE IF NOT EXISTS` never alters an existing database —
Miriel hit this adding `asked_at` in her phase 2 and left the guard behind, so
we get the pattern for free).

One qualifier on "closed enums validated before write": Miriel validates `type`
with a reject but silently coerces an unrecognised `status` to `null` and
applies the operation anyway. We port the mechanism, not that asymmetry.

**The two-model write path.** The expensive model does the work; a cheap model
does the structured side-channel; the runtime validates before anything touches
disk. This is *literally* Layer 1 §2's two-pass architecture applied to memory
instead of narration. Both designs landed on it without reference to each
other, which is mild corroboration that the shape is a sensible default — not
proof of anything, since "cheap structured extractor beside an expensive
generator" is a common pattern with obvious cost reasons behind it.

**The claim→verdict loop.** Miriel's `prediction` type — stored as a checkable
claim, later graded against one of the three `VERDICTS`
(`came_to_pass | did_not | partly`), with the outcome stored as its own atom
joined by a `resolves` edge — is `Revision` from Layer 1 §3 with different
nouns. `'too_soon'` is not a fourth verdict but a separate defer branch
(`memory-store.js:220–226`): it re-stamps `asked_at`, leaves the row open, and
deliberately stores no outcome. That distinction is the good part — it maps onto
*deferred, not conceded*, which Layer 1 does not have and should.

**Prompt-safety fencing.** Two functions: `fence()` wraps a string in a named
tag the model is told to treat as data; `sanitizeUntrusted()` strips control
characters and smuggled tags without wrapping. The threat model — LLM-extracted
memories feeding later LLM prompts — is precisely ours. Port both.

> **Do not port the call sites.** `docs/memory-engine.md` claims *every*
> user-originated string entering a prompt is fenced. The code does not match:
> `memory-engine.js:155` interpolates dormant-thread `content` raw, and `:158`
> and `:163` do the same for season and temporal-callback facts. All three are
> LLM-extracted memory going straight back into a prompt — the exact
> second-order path the module exists to guard. Miriel's coverage has holes;
> port the module, audit our own call sites independently, and treat "every
> string entering a prompt is fenced" as a property to establish here rather
> than one inherited.

**Capture-prompt discipline.** Paraphrasing `EXTRACT_SYSTEM` and the ADD rules
(`memory-engine.js:289–319`): be conservative, record only what is explicitly
present, return an empty operations list when there is nothing worth
remembering, never invent. Memory that skews sparse-but-right beats memory that
skews dense-but-confabulated. Keep the shape; §4.3 rewrites the rules.

**The `(id % 7)` jitter trick.** A stable per-row offset computed as a pure
function of the primary key, so a row never flickers in and out of a time window
between queries. Miriel uses it for both dormant-thread wake-ups
(`memory-store.js:136`) and prediction ripening (`:122`). **Planned** for Layer 1
§8's interruption budget for the same reason — that section currently specifies
only "at most once per N minutes" with no jitter, so this is a port to make, not
one already made.

**Test discipline.** The principle — a memory that quietly drifts is worse than
no memory at all — is the thing worth porting. *"Every weight, window and TTL
pinned by tests"* is the Miriel author's own claim in `docs/memory-engine.md`;
`tests/memory-store.test.js` pins the store operations and the jitter windows,
and `tests/memory-engine.test.js` exists but was not read. Treat the discipline
as the lesson and the coverage claim as unverified.

### Replaced

**The scoring function.**

```
score = 3.0·overlap + 1.5·salience + 1.5·status + 0.5·freshness − 0.4·overuse
```

Three independent reasons, ascending in severity:

1. `overlap` dominates *by design* — relevance to this reading matters most —
   and it is stopword-filtered keyword intersection against a natural-language
   question plus card names. Our query is `(agent_id, task_kind, file set)`.
   Overlap between *"Matt accepts unbounded retry on token refresh"* and a
   `task_kind` of `review` is approximately zero. The dominant term goes dead
   and the formula degenerates into `salience + status`.
2. `freshness` and `overuse` **invert.** They exist so no single memory becomes
   Miriel's catchphrase — a real problem for a character, a disaster for a
   contract. §10's entire premise is that *every agent knows you said no*. You
   want that injected every time. Miriel's formula penalises a decision
   precisely for being repeatedly relevant.
3. Shared decisions should not be *scored at all* (§4.4).

**`better-sqlite3` → `node:sqlite`.** See §3.1. Toolchain, not preference.

**Silent op rejection.** Miriel's `applyOps` does `if (!TYPES.includes(op.type))
continue;`. Ours returns rejects. See §4.2.

### Added

- **Agent scope and ownership** (`scope`, `owner_agent`). Not a new mechanism —
  Miriel's `reader_slug` is a NOT NULL, four-way-indexed ownership column
  threaded through nearly every statement, and ours is the same pattern with a
  second axis. What is new is the *shared/private* distinction and the read
  enforcement built on it (§3.2).
- **Hard delete plus a `supersedes` audit edge and tombstones** (§5). No Miriel
  analogue — her store has no delete at all.
- **The substance-not-location rule** in the capture prompt (§4.3). No analogue.
- **The anti-suppression rule** in the capture prompt (§4.3). No analogue.
- **Status validated with a reject.** Miriel validates `type` with a reject but
  silently coerces an unrecognised `status` to `null` and applies the operation
  anyway (`memory-store.js:195`, `:209`). Harmless there; here it would let a
  malformed op through as a well-formed one, which is §4.2's whole objection.

### Not ported and not replaced — deliberately dropped

`salience`-as-extractor-judgment survives, but Miriel's *emotional seasons*,
*warmth tiers*, *curiosity detection* and *temporal callbacks* are all character
machinery for a reader who must feel like a person across months. Layer 1
already produces character through voice packs and severity. Duplicating it in
the memory layer would give two independent systems a vote on the same
impression, and they would drift.

---

## 3. The store

### 3.1 Where it runs — and why that is not a detail

**Layer 2 lives in the Stage 2 collector process, not in Electron main.**

> **Revised 2026-07-27, one day after this section was first written.** The
> original text opened *"Forced by toolchain"* and rested the decision on there
> being no VS Build Tools on this box — a fact it attributed to `CLAUDE.md`,
> which never actually stated it (the claim lives in `docs/roadmap.md` §2, which
> attributes it to `CLAUDE.md` in turn; the citation chain was dangling from the
> start). MSVC has since been installed, so the constraint is gone regardless.
>
> **The conclusion is unchanged and the argument is now better**, because it has
> to stand on merit instead of on an accident of this machine. Preserved here
> deliberately rather than quietly rewritten: a decision justified by an
> environmental constraint has no defence the day the constraint lifts, and this
> one had less than twenty-four hours.

**Update 2026-07-28: the collector already exists.** `collector/` shipped as
Stage 2 — a standalone Node >=22.5 process with its own `package.json`,
`tsconfig.json` (`NodeNext`) and `vitest.config.ts`, no npm runtime
dependencies, ingesting hook events into `~/.aether-os/collector.db`. Layer 2 is
**no longer blocked on anything**; Phase A already conforms to its conventions
and drops into `collector/src/`.

Three reasons, in descending order of how much weight they carry:

1. **The single-writer property (load-bearing, toolchain-independent).** See the
   next paragraph. This is the real reason and it was always the real reason.
2. **The native-module tax inside Electron.** `better-sqlite3` is buildable here
   now, but a native module in Electron still needs an `electron-rebuild` on
   every Electron version bump, forever. `node:sqlite` in a plain Node process
   has none of that. Note this is a *maintenance* argument, not a *capability*
   one — the capability objection is dead.
3. **The store is already going there.** `docs/roadmap.md` Stage 2 puts the
   history store in a headless Node collector and Stage 3 has the viewer read
   from it. Memory in Electron main plus history in the collector is two SQLite
   files in two processes, for no benefit.

On versions: `node:sqlite` reached **release candidate (stability 1.2) in Node
v25.7.0** and remains RC as of v26.5 — no longer experimental, no longer warns.
Electron 31 ships Node 20, so it is still unavailable in Electron main.
`collector/package.json` already declares `engines.node >= 22.5.0`.
`better-sqlite3` is now a viable fallback *within the collector* if RC status
ever bites, which is the one genuine thing MSVC bought this design.

### 3.1a Two binding conventions inherited from `collector/`

**`node:sqlite` may only be imported as a TYPE.** `import type { DatabaseSync }
from 'node:sqlite'`, with the runtime value pulled through `createRequire`
inside `schema.ts`'s `openDatabase()`. A static value import fails under
vitest's Vite transform because Vite 5's dependency scanner does not recognise
the newer builtin. This is recorded in `PROGRESS.md` as a load-bearing
convention for all of `collector/`, and it supersedes the `resolve.alias` shim
described later in this section — same problem, and the collector's fix is
strictly better because it needs no test config and works in production too.

**`NodeNext` module resolution means relative imports carry `.js`.** Omitting
them broke the collector's build silently for several tasks because reviews ran
only `vitest` and never `tsc -b`. Run both.

### 3.1b A separate database file — `memory.db`, never `collector.db`

The collector database's defining behaviour is **retention**: `retention.ts`
rolls raw `events` rows into `daily_rollups` and then deletes them past a 30-day
window, and Settings exposes a real Purge action over the same store
(`privacy-and-data.md` §6). Both are correct for telemetry and catastrophic for
memory — a standing decision must survive every purge and every retention sweep.

Same lifecycle, same file; different lifecycle, different file. Layer 2 opens
`~/.aether-os/memory.db` beside `~/.aether-os/collector.db`, reusing
`openDatabase()` but nothing else. This is not tidiness: a single `DELETE`
in a retention sweep that ever learned about a `memories` table would silently
destroy the store's entire reason for existing, and P3's whole argument is that
silent staleness is worse than absence.

**The single writer is the actual argument.** Layer 1 §10 requires that agents *propose* to
shared memory and `STEWARD` *commits* — a single writer. In-process that is a
discipline you can violate by accident. Across a process boundary, where the
only write path is the collector's own contract, it is **structural**. Miriel
has no concurrency control whatsoever — no versioning, no batch transaction, no
uniqueness constraint, prompt-level dedup only. That is not a latent bug in her
deployment: a local single-user desktop app does not produce two concurrent
captures on the same reader. It is safe *because of* the deployment, and the
property does not travel with the code. We get the single writer from an
architectural decision made for unrelated reasons — which is worth stating
plainly, because it means Layer 2 *inherits* this property rather than owning
it.

**Corollary: do not build optimistic locking — for now.** This is a judgement
call, not a derivation, and it rests on an invariant Layer 2 inherits rather
than owns: the collector happens to be the only writer because of an
architectural decision made for unrelated reasons. The bet is that an untested
conflict path is worse than none, and that if the invariant ever breaks, fixing
it at the boundary beats papering over it with `if_version`. If a second writer
ever becomes desirable — a second collector, a CLI that writes directly — this
decision is the first thing to revisit, not the last.

**Known trap, verified 2026-07-27 on Node 22.22.** Vite resolves builtins from
`module.builtinModules`, and on that version the list **does not contain
`sqlite`**. A bare
`import { DatabaseSync } from 'node:sqlite'` therefore fails under `vitest` with
`Failed to load url sqlite`, even though the identical import runs fine under
plain `node`. Neither `ssr.external` nor a `resolveId` plugin fixes it; the
working fix is a `resolve.alias` in the test config pointing at a shim that
pulls the module through `createRequire`. Production is unaffected — only the
bundler is confused. Ten minutes to find, thirty seconds to fix, and guaranteed
to be rediscovered the hard way if it is not written down.

**Re-check this on Node 26 before porting the workaround.** `sqlite` may well
have entered `builtinModules` when the module went release candidate in v25.7,
in which case the shim is dead weight. The alias is cheap and harmless either
way, but it should be deleted rather than inherited if the trap no longer
exists — a workaround kept past its cause is how a codebase accumulates
folklore.

### 3.2 Schema

```sql
CREATE TABLE IF NOT EXISTS memories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,

  -- ---- SCOPE: who may read this. Enforced in the store, never in a prompt. ----
  scope         TEXT NOT NULL,          -- 'shared' | 'private'
  owner_agent   TEXT,                   -- NULL iff scope='shared'; agent_id otherwise

  -- ---- CONTENT ----
  kind          TEXT NOT NULL,          -- see MemoryKind below
  content       TEXT NOT NULL,          -- ONE specific sentence
  status        TEXT,                   -- 'open' | 'moving' | 'settled'
  salience      INTEGER NOT NULL DEFAULT 3,   -- 1..5
  subject       TEXT,                   -- short tag, for grouping

  -- ---- PROVENANCE ----
  source_kind   TEXT NOT NULL,          -- 'run' | 'operator' | 'backfill'
  source_run_id TEXT,

  -- ---- LIFECYCLE ----
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  asked_at      INTEGER,
  reference_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mem_scope       ON memories(scope);
CREATE INDEX IF NOT EXISTS idx_mem_owner       ON memories(scope, owner_agent);
CREATE INDEX IF NOT EXISTS idx_mem_owner_kind  ON memories(scope, owner_agent, kind);

-- Audit edges. Agents never read this table.
CREATE TABLE IF NOT EXISTS memory_links (
  from_id  INTEGER NOT NULL,
  to_id    INTEGER NOT NULL,
  relation TEXT NOT NULL,               -- 'supersedes' | 'revises'
  PRIMARY KEY (from_id, to_id, relation)
);

-- Tombstones. Survive the hard delete of the row they describe (§5).
CREATE TABLE IF NOT EXISTS memory_tombstones (
  id            INTEGER PRIMARY KEY,    -- the deleted memories.id, preserved
  scope         TEXT NOT NULL,
  owner_agent   TEXT,
  content       TEXT NOT NULL,
  deleted_at    INTEGER NOT NULL,
  cause         TEXT NOT NULL,          -- 'superseded' | 'operator' | 'invalidated'
  superseded_by INTEGER                 -- memories.id of the replacement, if any
);

CREATE TABLE IF NOT EXISTS memory_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

Note the deliberate absence of a foreign key from `memory_links` to `memories`.
Miriel has `ON DELETE CASCADE` there; we hard-delete rows and must keep the
audit edge, so the link table is intentionally loose and the tombstone carries
the content. **Cascading deletes would destroy the audit trail that justifies
the delete.**

### 3.3 The type system

```ts
type MemoryScope = 'shared' | 'private'

type MemoryKind =
  // ---- SHARED: your standing judgments. Written by STEWARD only. ----
  | 'decision'     // "Matt accepts unbounded retry on token refresh"
  | 'preference'   // "Matt wants diffs before explanations"
  | 'constraint'   // see §9 #3 — this kind is now RESOLVED OUT; see below
  // ---- PRIVATE: an agent's own history with you, in its own domain. ----
  | 'overrule'     // this agent made a call; you went the other way
  | 'habit'        // "Matt always asks about electron/ after a main.ts change"
  | 'revision'     // this agent changed a stated position, and why

type MemoryStatus = 'open' | 'moving' | 'settled'
```

Three changes from Miriel's taxonomy, each with a reason:

1. **Typed by epistemic kind, not narrative kind.** Miriel asks *is this a
   person, a feeling, a foretelling?* We ask *is this your judgment or this
   agent's history?* Those are orthogonal, and ours is the one that determines
   who may read a row.
2. **`dormant` is gone from `MemoryStatus`.** Miriel needs a "quiet but alive"
   state so she can gently wonder aloud about it later. A standing decision is
   never dormant; it is in force or it is deleted (§5).
3. **`revision` is a first-class kind**, not a special case of something else.
   Layer 1 §7 makes it the enforceable half of P4, so it gets a row.

### 3.4 What must never be stored

Enforced by the capture prompt *and* by a content check at write time, because a
prompt rule is a request and a write check is a guarantee.

| Forbidden | Because |
|---|---|
| Source code, diffs, command strings, tool output, prompts | `CLAUDE.md` house rule. Also: it is all payload, and payload goes stale the moment the file changes. |
| File paths, line numbers, symbol names | **P3, sharpest edge.** A judgment anchored to a location goes stale exactly like a finding does. See §4.3. |
| Any finding about the code | P3, flatly. Findings are re-derived every run. A cached finding is an agent reasoning confidently from a repo that no longer exists. |
| A suppression rule (*"don't flag retry loops"*) | §10's nastiest failure mode. An agent that stops looking produces an absence, and **you cannot notice an absence.** |

---

## 4. The write path

### 4.1 Shape

```
┌─ AGENT RUN (Layer 1, Pass 1) ─────────────────────────┐
│  Produces result, findings, revision.                  │
│  Writes NOTHING to memory. Cannot reach the store.     │
└───────────────────────────────────────────────────────┘
                        ↓
┌─ EXTRACTOR (cheap model, narrow job) ─────────────────┐
│  In:  run summary + what is already remembered         │
│  Out: JSON operation list — ADD | UPDATE | SUPERSEDE   │
│       | REVISE | TOUCH. Nothing else.                  │
└───────────────────────────────────────────────────────┘
                        ↓
┌─ RUNTIME (collector) ─────────────────────────────────┐
│  Validates every op against enums, scope, and §3.4.    │
│  Applies survivors in ONE transaction.                 │
│  RETURNS REJECTS. Does not swallow them.               │
└───────────────────────────────────────────────────────┘
```

The agent never touches the store. Same reasoning as Layer 1 §2: an agent that
can write its own memory can write itself a more flattering past, and P1 says
self-report is inadmissible.

### 4.2 `applyOps` returns rejects

Miriel's version silently `continue`s past an invalid op. That is correct for a
tarot reader — a dropped memory costs nothing.

It is wrong here, and specifically it breaks Layer 1 §7. That section says *"a
finding whose stated position changed without an accompanying `Revision` is a
contract breach the runtime can detect."* If the extractor emits a malformed
`REVISE` and the store drops it silently, the runtime detects **nothing** — it
sees a well-formed stream that has already discarded the violation. Phase 2's
schema validation would be validating a lie.

```ts
interface ApplyResult {
  added: number
  updated: number
  superseded: number
  revised: number
  touched: number
  rejected: Array<{
    op:     unknown          // the offending operation, verbatim
    reason: RejectReason
  }>
}

type RejectReason =
  | 'unknown_op'
  | 'invalid_kind'
  | 'invalid_status'
  | 'empty_content'
  | 'not_found'
  | 'scope_violation'        // an agent tried to write outside its own private scope
  | 'forbidden_content'      // tripped a §3.4 check
  | 'missing_revision_cause'
```

Any non-empty `rejected` array is surfaced, not logged and forgotten. A steady
trickle of `forbidden_content` means the capture prompt is drifting; a
`scope_violation` means something is wrong at the process boundary and is a
five-alarm event.

### 4.3 The capture prompt

Ports Miriel's shape and conservatism; replaces her rules with four of ours.
These are the load-bearing strings in this document.

> **Substance, never location.** Record what the judgment *is about*, never
> where it lives. *"Matt accepted this tradeoff in `auth.ts:47`"* is forbidden —
> after the refactor an agent will cite your acceptance of a tradeoff that no
> longer exists, confidently, in voice, with the authority of a correct memory.
> *"Matt accepts unbounded retry on token refresh in exchange for simpler error
> handling"* carries the substance and is **self-invalidating**: when unbounded
> retry is gone, the entry is visibly no longer about anything.

> **Record decisions, never suppression rules.** *"Matt accepts unbounded retry
> on token refresh"* is context. *"Don't flag retry loops"* is the agent
> lobotomising itself on your behalf. A stored overrule is evidence about his
> preferences; it is **never** licence to stop looking. If you are about to
> write an instruction to yourself rather than a fact about him, write nothing.

> **Never invent.** Record only what is explicitly present in what he said or
> chose. Not what he probably meant, not what follows from it, not the general
> principle behind it. If there is genuinely nothing worth remembering, return
> no operations. Sparse and right beats dense and confabulated.

> **One specific sentence per entry.** If it needs a second sentence it is two
> entries, or it is a finding and does not belong here at all.

The first two have no Miriel analogue and are the highest-risk strings in the
system. **A model will write the forbidden version of both if not explicitly
forbidden** — location-anchoring because it is more precise, and suppression
rules because they are more helpful. Both instincts are correct in general and
catastrophic here.

### 4.4 Retrieval

Two entirely separate paths. This is the sharpest departure from Miriel, where
one scoring function served everything.

**Shared scope — unconditional injection, no scoring.**

Every agent, every run, gets every in-force `decision`, `preference` and
`constraint`. No relevance filter, no freshness term, no cap.

§10's premise is that *every agent knows you said no*. A scored decision is a
decision that sometimes silently fails to appear — and the failure is invisible,
because you cannot notice an absence. The bound on this set is not a score
threshold; it is **§5**. If shared memory grows large enough to need trimming,
the answer is that stale decisions are not being deleted, and the fix is
upstream.

Practical ceiling: a few hundred short sentences is a few thousand tokens. If it
ever exceeds that, revisit — but revisit by deleting, not by scoring.

**Private scope — scored, per owning agent.**

```
score = 2.0·kind_weight + 1.5·salience + 1.0·recency − 0.5·staleness_risk
```

- `kind_weight` — `overrule` outranks `revision` outranks `habit`. An agent
  should reach its own reversals first.
- `salience` — extractor's 1–5 judgment, normalised. Ported from Miriel intact.
- `recency` — decays over ~90 days *since written*, not since surfaced. Miriel's
  `freshness` measures since-last-surfaced, which is anti-repetition machinery;
  we want age.
- `staleness_risk` — grows with `updated_at` age for `open`-status entries only.
  An unsettled judgment that has not moved in months is more likely to be about
  a world that changed than one settled long ago.

Explicitly **no `overuse` term.** Miriel penalises repetition to protect a
character's voice. We have no such problem: an agent that keeps reaching for the
same overrule is an agent that keeps hitting the same wall, and that is signal,
not noise.

> **The trap this creates, found the hard way in Phase A.** Removing `overuse`
> is not sufficient to remove the surfacing→score feedback loop. If
> `markReferenced` shares a statement with `TOUCH` it also writes `updated_at`,
> which resets `staleness_risk` — so surfacing a memory *raises* its own future
> score. Same loop, opposite sign, and far harder to notice than the term we
> deliberately deleted. Miriel keeps `stmtMarkRef` and `stmtTouch` separate for
> the mirror-image reason. Collapsing them is the obvious simplification and it
> is wrong; there is a regression test pinning it.

**Cross-agent read enforcement — stated precisely, because the loose version is
a lie.** No *agent-facing* read omits `owner_agent`: `getShared` reads shared
scope only, and `getPrivateCandidates` requires an owner and throws without one.
Unscoped queries do exist — `admin.listAll()` returns every private row of every
agent, and the Memory view needs exactly that. They live behind `store.admin.*`
so any agent-facing use is conspicuous in review. **That is a guard by
convention, not by construction.** Layer 1 §8 keeps the requirement modest:
`STEWARD` compares agents using **runtime telemetry**, never peer memory, so
nothing in the design wants a cross-agent read in the first place.

---

## 5. Invalidation

The section with no Miriel analogue, and the one P3 exists to force.

### The decision

**Hard delete from the retrievable set, plus a `supersedes` edge and a tombstone
on a separate audit path agents never read.**

### Why not soft status

Miriel's answer to *"that's over"* is `status: 'resolved'`, which zeroes the
status term (`statusW = 0`) — but leaves the other four terms intact, so a
resolved atom with strong keyword overlap still scores well above zero and can
still surface. Two things bound this in her deployment: candidates are capped at
the top 200 by `(status='open') DESC, salience DESC`, so resolved rows fall off
first, and `recall` discards anything scoring ≤ 0. Neither is invalidation —
both are pressure. For a tarot reader that is
charming: *"you once asked about this."*

For us it is the exact hazard §10 names — **an agent citing a preference you
reversed, in voice, with the authority of a correct memory.** A soft status
behind a score penalty is one forgotten `WHERE` clause from resurrection, and
the resurrection is silent. The whole point of the shared store is that its
contents are trustworthy without inspection; anything that can silently
resurrect defeats that.

### How it works

```
SUPERSEDE(old_id, new_content):
  BEGIN
    new_id ← INSERT the replacement row
    INSERT INTO memory_tombstones (id, scope, owner_agent, content,
                                   deleted_at, cause, superseded_by)
           SELECT id, scope, owner_agent, content, :now, 'superseded', :new_id
           FROM memories WHERE id = old_id
    INSERT INTO memory_links (from_id, to_id, relation)
           VALUES (new_id, old_id, 'supersedes')
    DELETE FROM memories WHERE id = old_id
  COMMIT
```

After this the old judgment is **unreachable from every agent-facing query**,
because it is not in the table those queries read. The history is fully intact
in `memory_tombstones` + `memory_links` for the Memory view, and no agent has a
code path that reaches either.

Three deletion causes: `superseded` (replaced by a newer judgment),
`operator` (you deleted it), `invalidated` (the runtime determined its subject
no longer exists). The third is reachable today — `deleteMemory(id,
'invalidated')` accepts it — but nothing currently *produces* it, because no
detector exists to notice that a judgment's subject is gone. The value ships
anyway: retrofitting a cause taxonomy is miserable and this one is free.

### The test this passes

> *If this entry were wrong, how would I find out?*

Under soft status: you would not. It scores low, surfaces occasionally, and
reads exactly like a correct memory when it does. Under hard delete the question
is malformed — a wrong entry is not in the set, so there is nothing to find out
about.

---

## 6. `Revision` — Layer 1 §7's durable half

Layer 1 §3 defines `Revision` as a work-channel field on the envelope. That
makes it checkable **within a run**. Layer 2 makes it durable.

Miriel's prediction loop is the implementation, near enough to lift directly:

| Miriel | Layer 2 |
|---|---|
| `prediction` atom, `status: open` | An agent's stated finding, carried into the store as `kind: 'revision'` only once it moves |
| `RESOLVE` with `verdict` | `REVISE` with `cause: 'new_evidence' \| 'reasoning_flaw'` |
| `came_to_pass \| did_not \| partly` | The `detail` that moved it — the specific fact or flaw |
| `too_soon` (defer, re-stamp `asked_at`, store no outcome) | **Adopt this.** Layer 1 §7 has no "not yet settled" state and needs one; a forced binary invites a false concession. |
| outcome stored as its own atom, joined by a `resolves` edge | Replacement stored as its own row, joined by a `revises` edge |

Miriel's design note on this is worth quoting because it is the same argument
Layer 1 §7 makes from the other direction: *missed prophecies are included on
purpose — "you foretold X, it did not come to pass" is exactly the kind of
honesty that makes the fulfilled ones credible.*

Applied here: an agent's memory of **its own wrong calls** is what makes its
confident ones worth anything. That is P4 as a durable property rather than a
per-session instruction, and it is the single strongest argument for building
Layer 2 at all.

---

## 7. Collision with the existing Memory view

`src/components/memory/` and `MemoryStub` exist today and are **themed
simulation**, per `docs/superpowers/specs/2026-07-19-memory-view-design.md`:
`{ name, content, source, ts, pinned, strength }`, with strength decaying over
time and a `sweep` command pruning weak unpinned entries.

That is **decay-based forgetting of standing decisions** — the same anti-pattern
this document rejects in `freshness`/`overuse`, already shipped as fiction. A
decision does not get less true because it has not come up lately, and `sweep`
would silently delete an in-force constraint for being quiet.

The view is the right render surface. The model is not.

- `MemoryStub`, `strength`, and `sweep` are **retired**, not extended.
- `MemoryRosterCard` / `MemoryDetailCard` are re-pointed at collector-backed
  rows. Neither branches on `source`'s value today, so the render path survives.
- The roster gains a scope filter (shared / per-agent) and a **tombstone view** —
  the audit path from §5 needs a surface, and this is it.
- `pinned` disappears. Under §4.4 every shared entry is already unconditionally
  injected; pinning is a no-op dressed as a feature.

Deliberately kept: the reactor-console styling. It is the one part of the
simulation that was never a lie.

---

## 8. Build order

Sequenced by dependency. Stage 2 (the collector process) was the one hard
prerequisite and **it shipped on 2026-07-27**, so nothing here is blocked. Layer
1 Phases 0–3 remain entirely independent of all of it.

### Phase A — the store — ✅ WRITTEN AND GREEN

- [x] Schema + guarded migrations against `node:sqlite`
- [x] `applyOps` with full enum/scope/content validation
- [x] **`ApplyResult.rejected`** — rejects returned, never swallowed
- [x] Scope-enforcing read API (`owner_agent` required on every agent-facing read)
- [x] `SUPERSEDE` as a single transaction: insert, tombstone, link, delete
- [x] Tests: supersede makes the old row unreachable; every reject reason fires
- [x] ~~`resolve.alias` shim for `node:sqlite`~~ — **not needed.** Superseded by
      the collector's type-only-import + `createRequire` convention (§3.1a),
      which is the better fix. The shim has been deleted.
- [ ] **Move `aether-layer2-phase-a/` into `collector/src/`** — delete its
      sandbox `schema.ts` stub (byte-identical to the collector's real one) and
      the import resolves unchanged. One deletion, no code edits.

Nothing above needs a model. It is all pure, synchronous, and testable — which
is why it is first.

**Status: Phase A is written and green** — `memoryStore.ts` + 50 passing tests,
`tsc --strict` clean. Delivered as a standalone package
(`projects/aether-layer2-phase-a/`) rather than inside the repo, because the collector process does not exist yet and a
`.test.ts` file dropped anywhere under the repo root would be picked up by the
existing `vitest run` and fail on the alias above. Move it to
`collector/memory/` when Stage 2 lands.

### Phase B — the write path — ✅ WRITTEN AND GREEN

- [x] Extractor prompt with all four §4.3 rules — `collector/src/memoryExtractPrompt.ts`
- [x] Tolerant JSON parser (ported from Miriel's `parseExtractorOutput`) —
      `collector/src/memoryExtractParser.ts`
- [x] `prompt-safety` fencing ported and wired — `collector/src/promptSafety.ts`,
      wired into every untrusted string `memoryExtractPrompt.ts` embeds
- [x] ~~Content check for §3.4 forbidden classes at write time~~ — landed in
      Phase A alongside the rest of `applyOps` validation; it is one of the
      cheapest guarantees in the system and there was no reason to defer it
- [x] Single-writer enforcement at the collector boundary — `memoryExtract.ts`'s
      `runExtractor` takes `writer` as a caller-supplied parameter; model
      output has no writer/identity field in any op shape, so `applyOps`'s
      existing `ctx.writer` check is the only thing that can authorize a
      write, exercised end-to-end by `memoryExtract.test.ts`'s
      "enforces single-writer" case
- [x] Tests pinning the forbidden-content check against real violation
      examples — pinned at two layers: `memoryStore.test.ts` (Phase A, unit)
      and `memoryExtract.test.ts` (Phase B, through the full model-call →
      parse → apply pipeline)

**Status: Phase B is written and green** — 4 new modules
(`promptSafety.ts`, `memoryExtractParser.ts`, `memoryExtractPrompt.ts`,
`memoryExtract.ts`) in `collector/src/`, 28 new tests, `tsc -b` clean.
`runExtractor`'s real model call (`defaultExtractExec`) shells out to
`claude -p <prompt> --model haiku --output-format text`, following the same
injected-exec-function pattern `fleetPoll.ts` established for `claude agents
--json` — nothing in this phase has been run against the real CLI yet
outside its own test suite; that is Phase C/D's job once retrieval exists to
give the extractor a real run to summarize.

### Phase C — retrieval

- [ ] Unconditional shared injection
- [ ] Private scoring function
- [ ] Tests pinning every weight (the Miriel discipline — a memory that quietly
      drifts is worse than no memory at all)

### Phase D — the surface

- [ ] Retire `MemoryStub` / `strength` / `sweep` / `pinned`
- [ ] Re-point roster + detail at collector rows
- [ ] Scope filter and tombstone view

### Phase E — parked, needs real traffic

- [ ] Tune the private scoring weights
- [ ] `recency` and `staleness_risk` half-lives
- [ ] Whether `habit` earns its place as a kind at all

---

## 9. Open decisions

| # | Decision | Notes |
|---|---|---|
| 1 | ~~Does `STEWARD` commit shared writes, or does the collector?~~ | **Closed: the collector commits.** `STEWARD` is Layer 1's viewer-side persona — it narrates the orchestration grid and the attention broker (§8); it is not a process and has no code path to `memory.db`. §3.1's single-writer property is already structural: the collector is the only process that can open the store, so "agents propose, `STEWARD` commits" (Layer 1 §10) is satisfied concretely by *agent run → extractor proposes ops → collector's `applyOps` validates and commits in one transaction* — no separate `STEWARD` write path to build. `STEWARD`'s narration of shared-memory events (if any) reads the committed result after the fact, same as any other agent. Distinction without a difference, confirmed. |
| 2 | Does an agent see its own tombstones? | Argument for: *"I used to think X, he overruled it"* is exactly the P4-relevant history. Argument against: it reintroduces the resurrection hazard §5 exists to kill. Leaning no — but the argument for is not weak. |
| 3 | ~~Does `constraint` belong in memory at all?~~ | **Closed: no. Drop the kind.** The example this decision was written around — *"no VS Build Tools on this box"* — went stale **the day after it was written**, when MSVC was installed. It was also never true of `CLAUDE.md` in the first place. A world-fact masquerading as a judgment, wrong on arrival and falsified within a day, is as clean a demonstration of P2 as the design will ever get: if a build probe can settle it, storing it is not memory, it is a stale cache with the authority of a decision. `MemoryKind` loses `constraint`; `SHARED_KINDS` becomes `decision \| preference`. |
| 4 | Backfill from existing transcripts? | Miriel backfills in chunks of 12 behind an all-or-nothing meta flag. We have months of transcripts. Tempting, and the highest-risk operation in the document: bulk extraction with no human in the loop, writing to a store whose whole value is trustworthiness. |
| 5 | `too_soon` in Layer 1's `Revision`? | §6 argues yes. It is a Layer 1 schema change, so it belongs in that document's next revision, not this one. |

---

## 10. The honest summary

Miriel gives us the **plumbing, the epistemics, and the discipline**: a typed
store, a cheap-extractor write path, a claim→verdict audit loop, prompt-injection
hardening, and a test culture — all already built, already run in anger, already
debugged against failure modes that would otherwise have to be rediscovered.

It does **not** give us retrieval, and its concurrency model is safe here only
because the architecture happens to agree with it.

The part worth flagging: both systems landed on the same core move — **a cheap
model doing a narrow structured job alongside an expensive model doing the real
one, with the runtime validating between them.** Layer 1 arrived at it for
narration; Miriel arrived at it for extraction; neither referenced the other.

That is mild corroboration that the shape is a sensible default, and nothing
stronger. It is a common pattern with obvious cost reasons behind it, so two
designs reaching it is weak evidence at best — an earlier draft of this section
called it *"the strongest evidence available that Layer 1's principles describe
something real,"* which is exactly the kind of unfalsifiable flourish P4 exists
to distrust. The principles earn their keep in §9 #3, where one of them deleted
a feature; convergence stories are not evidence.
