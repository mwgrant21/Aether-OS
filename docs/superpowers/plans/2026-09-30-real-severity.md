# Real Severity (Narration Sub-project 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dispatch severity real: failed dispatches score 4 (`error`), killed score 2 (new `killed`), stalls score 4 (`fatal`), slowness is capped at 2, and a >= 3 tool-error floor gives 3 if the spike returns GO. All of this comes from one pure core shared by the live narration path and the collector.

**Architecture:** Pure core in `electron/severity/` (`parseDispatchOutcome`, `computeSeverity`, `isStalled`, `baselineMath`, and after a GO spike `subagentLink`). `scripts/sync-severity-core.mjs` generates a byte-checked copy into `collector/src/severity/`. The live path (`liveAgentTracker` -> `liveSeverity` narrator -> `agents:narration`) and the collector path (`usageIngest`, `staleDispatchSweep`) both call the core. Durations persist to `~/.aether-os/duration-baseline.json`. The collector's `dispatches` usage columns become nullable in schema v9.

**Tech Stack:** TypeScript, Electron main process, React renderer (jsdom vitest), standalone Node collector (`node:sqlite`, its own vitest), Go collector (schema parity only), vitest 2.

**Spec:** `docs/superpowers/specs/2026-09-30-real-severity-design.md` (commit `fd8af20`, branch `docs/real-severity-design`). Read it with this plan. The spec decides; this plan only says how.

**Pinned ground (spec-writer, 2026-09-30):**
- Repo `C:\Users\IT\Desktop\Aether-OS-severity` (git worktree), HEAD `fd8af20` on `docs/real-severity-design`, base master `499b7bc`. The working tree was clean. `node_modules` is a junction into `Aether-OS-livetest`. **Never run `npm ci` / `npm install`.**
- Root baseline: `npx vitest run` -> **Test Files 204 passed | 1 skipped (205); Tests 2286 passed | 19 skipped (2305)**, 0 failures, 29 s. The ConPTY Ctrl+C test (`private Windows launch > real ConPTY Ctrl+C interrupts...`) is known to be intermittent under load. It passed in this run. If it flakes, rerun it alone and do not chase it.
- Collector baseline: from `collector/`, `npx vitest run` -> **Test Files 32 passed (32); Tests 407 passed | 5 skipped (412)**.
- `npm run typecheck:electron` -> exit 0. From `collector/`, `npx tsc -p tsconfig.json --noEmit` -> exit 0. From `collector-go/`, `go test ./internal/schema/ ./internal/collector/` -> ok, ok (go1.26.5 is installed). The renderer typecheck (`npx tsc -p tsconfig.json --noEmit` at the root) was NOT baselined.
- `core.autocrlf=true` on this machine, so `.ts` files check out CRLF. `.gitattributes` pins only `*.go` to LF.

## Global Constraints

These values are copied from the spec. Every task's requirements include them.

- Severity table (spec §3). `<status>completed` normal -> `ok`, **1**. Completed and elapsed > 3x median (median established) -> `ok`, **2** ("slowness alone is **capped at 2**"). Completed with **>= 3 tool errors** (only if the §8 spike succeeds) -> `ok`, floor **3**. `<status>failed` -> `error`, **4**. `<status>killed` -> `killed` (**new value**), **2** ("informational and never voiced"). Stalled -> `fatal`, **4**. Status tag missing or unrecognised -> `ok`, **1** ("**Never guess a failure.** One `[diag]` line per previously unseen status value").
- "`TOOL_ERROR_FLOOR = 3` and `SLOW_FACTOR = 3` are named constants."
- "The unused `exit` values in §4 (`partial`, `timeout`, `blocked`) stay in the type. Nothing produces them yet."
- `parseDispatchOutcome`: "Never throws. Returns **no string fields other than `status`** ... A missing usage block gives `usage: undefined`, never zeros."
- `computeSeverity`: "The result carries `severity`, `exitState`, `elapsedMs` and `medianMs` (null when unestablished)."
- Stall: "`STALL_MS` = **30 min**". "A check roughly every 30 s". Stall becomes 4 `fatal` "**exactly once**". Recovery: "its real outcome replaces the stall ... a single 'recovered' narration line is emitted."
- Baseline: key `subagentType`. "Samples admitted: only `completed` outcomes with a usage block and `durationMs > 0`". "Window: last 20 per key". "Minimum samples: **5**". Persisted to `~/.aether-os/duration-baseline.json`, "numbers only, keyed by agent type", written "through `electron/atomicWrite.ts`". "A corrupt or unreadable file starts empty, with one `[diag]` line."
- Collector: "When the usage block is missing, tokens, tool uses and duration are stored as **NULL, not 0**." Median query: "successful rows, `duration_ms > 0`, last 20, minimum 5". "No migration and no history rewrite" of old rows' values.
- "Negative elapsed time (clock skew) gives no slowness bump." "A severity result never contains transcript text. Enforced by a test."
- "Every new test must be seen **failing before** its fix." "Fixtures: synthetic, with shapes taken from real transcripts. **No copied transcript content.**"
- "Existing tests that asserted today's severity-1-for-everything behaviour are updated, and each such change is listed in the builder report."
- Repo rules. `src/shared/noApiCalls.test.ts` and `src/state/noPayloadInStore.test.ts` stay green. Do not reintroduce user-wait subtraction from durations (CLAUDE.md gotcha). Write files as UTF-8 **without BOM**. New source is **ASCII only**; write an em dash as `'\u2014'`. Before committing, byte-check with `LC_ALL=C grep -n '[^[:print:][:space:]]' <files>`, which must print nothing. vitest runs never use exclude flags.

## Review Focus

1. **A `<result>` or `<summary>` body that quotes `<status>failed</status>` or usage tags must not change the outcome.** A reviewer's result text often quotes the notification format. Expected: status and usage come only from the structural tags. Pinned in **Task 2** (`parseDispatchOutcome.test.ts`, "ignores tags quoted inside summary/result").
2. **A live dispatch whose start timestamp is missing must not be declared stalled on the first check.** `liveAgentsMath.isoOrEpoch` turns a missing timestamp into `1970-01-01`, which reads as 56 years of inactivity. Expected: inactivity is measured from first sight. Pinned in **Task 7** (`liveSeverity.test.ts`, "epoch startedAt is measured from first sight").
3. **Upgrading a real v8 `collector.db` keeps every existing dispatch row and value.** A second migrate is a no-op. A database stamped v9 while physically still NOT NULL (Go-created) heals. Pinned in **Task 4** (`schema.test.ts` + Go `parity_test.go`).
4. **A `duration-baseline.json` that is valid JSON with the wrong shape must neither throw nor produce a NaN median.** Examples: `[]`, `{"version":1,"samples":{"x":["a",-1,null]}}`, `{"version":2,...}`. Expected: start empty with exactly one `[diag]` line. Pinned in **Task 6** (`durationBaseline.test.ts`, "wrong-shape JSON").
5. **A dispatch that completes before or on the tick it would have been flagged is narrated once, from its real outcome.** It gets no stall line and no "Recovered" line. A dispatch flagged once is not re-flagged on later ticks. Pinned in **Task 7** (`liveSeverity.test.ts`, "completion before the stall check").

---

## Spec vs code (read before Task 2)

1. **Schema version.** The spec says "schema v6 migration". The collector is at **v8** (`collector/src/schema.ts:8`). `dispatches.tokens/tool_uses/duration_ms` are `INTEGER NOT NULL` (`schema.ts:117-119`), and SQLite cannot drop NOT NULL in place. The migration is therefore **v9, a table rebuild** (Task 4).
2. **The Go collector is forced into scope, but only for its schema.** `collector-go/internal/schema/parity_test.go:52` hard-codes `SchemaVersion != 8`. `test-fixtures/collector-parity/expected.json` `schemaVersion` is asserted by both `collector/src/parity.test.ts` and `collector-go/internal/collector/parity_test.go:128`. Bumping Node to 9 fails CI unless Go is also at 9, and both collectors migrate the same database (issue #31). Task 4 bumps Go's schema and applies the same rebuild. **Go's dispatch INGEST (`collector-go/internal/transcript/usage.go:97`, base columns only) stays out of scope.** The orchestrator files the issue in "Post-merge".
3. **"Generated copy ... following the atomicWrite pattern."** `electron/atomicWrite.ts` -> `collector/src/atomicWrite.ts` is a hand-kept copy with a logic-line parity test (`electron/atomicWrite.parity.test.ts`). No generator exists today. This plan adds `scripts/sync-severity-core.mjs` and a stricter byte-level parity test, which is what the spec's word "generated" asks for.
4. **Line references.** At `fd8af20`, `usageIngest.ts:48-60 / 63-81`, `personalitySpine.ts:94-124` and `narrationGenerator.ts:22-26` are still accurate. The `main.ts` narration loop is now `electron/main.ts:739-766` (the spec cites 757-762). `reducer.ts:400` is now `reducer.ts:405`. `persistence.ts:46` is unchanged.
5. **Observed status values.** In this machine's transcripts (the spec-writer grep over `~/.claude/projects/*/*.jsonl`) the values were `completed` 2189, `failed` 108, `killed` 22 and **`running` 3**. There were also a few `completed|failed|killed` hits, which are documentation text inside results. By the spec, `running` is unrecognised -> `ok`/1 plus one `[diag]`. See RISKS for the closing behaviour.
6. **The live path has no "session" object.** `electron/main.ts` pins one pty-spawned transcript. "The owning Claude session has ended" is implemented as "the pinned pty has exited" (`main.ts:1185`, `main.ts:1219` onExit handlers), reset at each `liveAgentTracker.notifyPtySpawned` call (`main.ts:1187`, `main.ts:1226`).
7. **Stall lines reach the roster only, not Comms.** `reducer.ts:394-425` `SET_DISPATCH_NARRATION` adds a Comms message only when the dispatch is in `recentCompletedDispatches` or `dispatchChannels`. An open, stalled dispatch is in neither. The roster (`dispatchNarrations[toolUseId]`) does get the line. Renderer changes are not in this spec, so this is recorded and left as is.
8. **Killed is exactly 2, not `max(sev, 2)`.** "informational and never voiced" means it must never reach 3. `computeSeverity` therefore sets killed last.
9. **Missing usage means `elapsedMs = 0` on both paths**, so there is no slowness bump without a measured duration ("never guess").

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `docs/superpowers/specs/2026-09-30-subagent-link-spike.md` (Create) | 1 | Spike note, GO/NO-GO |
| `electron/severity/parseDispatchOutcome.ts` (Create) | 2 | Notification -> `{status, usage?}` |
| `electron/severity/computeSeverity.ts` (Create) | 2 (8 extends) | Types `Severity`/`ExitState`, `SLOW_FACTOR`, `exitStateForStatus`, `computeSeverity` |
| `electron/severity/isStalled.ts` (Create) | 2 | `STALL_MS`, `isStalled` |
| `electron/severity/baselineMath.ts` (Create) | 2 | `BASELINE_MIN_SAMPLES`, `BASELINE_WINDOW`, `isAdmissibleSample`, `medianOf` |
| `electron/severity/*.test.ts` (Create) | 2 | Core tests |
| `scripts/sync-severity-core.mjs` + `scripts/sync-severity-core.d.mts` (Create) | 3 | Generator + types for the test import |
| `collector/src/severity/*.ts` (Create, generated) | 3 | Collector copy |
| `electron/severity/severity.parity.test.ts` (Create) | 3 | Byte parity |
| `collector/src/personalitySpine.ts` (Modify) | 3 | Drop `computeSeverity`, re-export types |
| `collector/src/schema.ts`, `collector-go/internal/schema/schema.go`, `test-fixtures/collector-parity/expected.json` (Modify) | 4 | v9 nullable usage |
| `collector/src/usageIngest.ts`, `staleDispatchSweep.ts`, `transcriptScan.ts` (Modify) | 5 | Real outcomes, NULL usage, median, `isStalled` |
| `electron/severity/durationBaseline.ts` (Create) | 6 | Persisted baseline |
| `electron/severity/liveSeverity.ts` (Create), `src/state/liveAgentsMath.ts`, `electron/liveAgentTracker.ts`, `electron/narrationGenerator.ts`, `electron/main.ts` (Modify); `electron/durationBaseline.ts` (+test) (Delete) | 7 | Live path |
| `electron/severity/subagentLink.ts` (Create) + collector wiring | 8 (GO only) | Tool-error floor, subagent progress (collector) |
| live wiring of `subagentLink` | 9 (GO only) | Tool-error floor, subagent progress (live) |
| `electron/collectorStore.ts`, `src/components/agents/DispatchTimeline.tsx`, `src/components/ledger/DispatchCostTable.tsx`, `src/shared/frozenPhraseDetect.ts`, `src/components/comms/narrationFeed.ts` (Modify) | 10 | Every `exit_state` / nullable-usage consumer |
| Docs (`AGENT_PERSONALITY_LAYER_1.md`, `PROGRESS.md`, `CLAUDE.md`, 4 stale comments) | 11 | Docs |

## Order and parallelism

| Wave | Tasks | Notes |
|---|---|---|
| A | **T1**, **T2**, **T4** in parallel worktrees | No shared files |
| B | **T3** (after T2), **T6** (after T2) in parallel | T3 = collector files, T6 = `electron/severity/durationBaseline.ts` only |
| C | **T5** (after T3 + T4), **T7** (after T2 + T6), **T10** (after T4) in parallel | T5 = collector ingest; T7 = electron live; T10 = viewer consumers. Disjoint files. T10's NULL rendering does not need T5 merged |
| D | **T8** (after T1 = GO, T5), then **T9** (after T7, T8) | **Skip both if T1 = NO-GO** |
| E | **T11** docs (after all) | Needs T1's facts for the CLAUDE.md correction |

Each task commits on its own branch. The orchestrator merges in wave order. Rebase conflicts are not expected because the files are disjoint within a wave.

---

### Task 1: Spike: link an Agent dispatch to its subagent transcript (time box 45 min)

**Files:**
- Create: `docs/superpowers/specs/2026-09-30-subagent-link-spike.md`
- Scratch (NOT committed): `$TMPDIR/aether-spike.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: the GO/NO-GO decision that gates Tasks 8 and 9. On GO, the note must also confirm the link Task 8 codes against: `<session>/subagents/agent-<agentId>.meta.json` has a string `toolUseId` equal to the parent's Agent `tool_use.id`.

**Leads already found (spec-writer, one session, not yet a proof):**
- `~/.claude/projects/C--Users-IT/7f20ea77-.../subagents/` holds `agent-<agentId>.jsonl` plus `agent-<agentId>.meta.json`. The meta JSON has the keys `agentType, description, toolUseId, spawnDepth, requestShape, requestNonInteractive`.
- The parent transcript's `tool_result` for the Agent call carries `toolUseResult.agentId` = `<agentId>` (seen on a background dispatch: "Async agent launched").
- Subagent lines carry `"isSidechain":true`. This contradicts CLAUDE.md's "0 isSidechain lines" gotcha.
- Machine-wide: 623 subagent `.jsonl` and 663 `.meta.json` files.

- [ ] **Step 1: Write the measurement script to scratch (not the repo)**

```js
// aether-spike.mjs -- counts only; prints no transcript content.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const root = join(homedir(), '.claude', 'projects');
const since = Date.now() - 30 * 24 * 3600 * 1000;
const c = { subFiles: 0, recent: 0, withMeta: 0, metaHasToolUseId: 0, toolUseIdIsParentAgentCall: 0, parentAgentIdAgrees: 0, filesWithIsError: 0, isErrorResults: 0, sidechainLines: 0 };
for (const proj of readdirSync(root)) {
  const projDir = join(root, proj);
  if (!statSync(projDir).isDirectory()) continue;
  for (const sess of readdirSync(projDir)) {
    const subDir = join(projDir, sess, 'subagents');
    if (!existsSync(subDir) || !statSync(subDir).isDirectory()) continue;
    const parentPath = join(projDir, `${sess}.jsonl`);
    const parent = existsSync(parentPath) ? readFileSync(parentPath, 'utf8') : '';
    for (const f of readdirSync(subDir).filter((x) => x.endsWith('.jsonl'))) {
      c.subFiles++;
      const p = join(subDir, f);
      if (statSync(p).mtimeMs < since) continue;
      c.recent++;
      const agentId = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      const metaPath = p.replace(/\.jsonl$/, '.meta.json');
      if (existsSync(metaPath)) {
        c.withMeta++;
        let id = null;
        try { id = JSON.parse(readFileSync(metaPath, 'utf8')).toolUseId ?? null; } catch {}
        if (typeof id === 'string') {
          c.metaHasToolUseId++;
          if (new RegExp(`"id":"${id}"[^}]*"name":"Agent"`).test(parent)) c.toolUseIdIsParentAgentCall++;
          if (parent.includes(`"agentId":"${agentId}"`)) c.parentAgentIdAgrees++;
        }
      }
      let errs = 0;
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        if (line.includes('"isSidechain":true')) c.sidechainLines++;
        try {
          const content = JSON.parse(line)?.message?.content;
          if (Array.isArray(content)) for (const it of content) if (it?.type === 'tool_result' && it.is_error === true) errs++;
        } catch {}
      }
      if (errs > 0) c.filesWithIsError++;
      c.isErrorResults += errs;
    }
  }
}
console.log(JSON.stringify(c, null, 2));
```

- [ ] **Step 2: Run it**

Run: `node "$TMPDIR/aether-spike.mjs"`
Expected: a JSON object of counts. Record it verbatim in the note.

- [ ] **Step 3: Check the `running` status and whether a later notification follows it** (counts only)

Run: `grep -o '<status>running</status>' ~/.claude/projects/*/*.jsonl | cut -d: -f1 | sort | uniq -c`
Then, for each file listed, count the `<tool-use-id>` values that appear in both a `running` and a later `completed|failed|killed` notification: `grep -o '<tool-use-id>[^<]*</tool-use-id><[^>]*>*' <file>` or a short node one-off. Record counts only.

- [ ] **Step 4: Write the note** with these sections, and no transcript content:
  - `## Question` (spec §8, one line)
  - `## Method` (the script above, run date, machine `work-it`)
  - `## Counts` (the JSON)
  - `## Link` (which field links which, and how reliable it is: `toolUseIdIsParentAgentCall / metaHasToolUseId` and `withMeta / recent` as percentages)
  - `## Tool errors` (whether `is_error: true` tool_results appear in subagent files, and whether they can be counted per dispatch)
  - `## Status values` (counts, plus the `running` follow-up result)
  - `## Decision: GO | NO-GO`. **GO rule:** `withMeta/recent >= 95%` AND `toolUseIdIsParentAgentCall/metaHasToolUseId >= 95%` AND `isErrorResults > 0`. Otherwise NO-GO, with the reason. On GO via any link OTHER than `meta.json toolUseId`, write `GO (different link)` and stop. The orchestrator then needs a Task 8 delta.
  - `## Side finding` (the CLAUDE.md gotcha is wrong: `sidechainLines` count. Task 11 corrects it)

- [ ] **Step 5: Byte-check and commit**

Run: `LC_ALL=C grep -n '[^[:print:][:space:]]' docs/superpowers/specs/2026-09-30-subagent-link-spike.md` -> no output.
```bash
git add docs/superpowers/specs/2026-09-30-subagent-link-spike.md
git commit -m "docs(spike): subagent transcript link for real severity (GO|NO-GO)"
```

---

### Task 2: Severity core (pure)

**Files:**
- Create: `electron/severity/parseDispatchOutcome.ts`, `electron/severity/computeSeverity.ts`, `electron/severity/isStalled.ts`, `electron/severity/baselineMath.ts`
- Test: `electron/severity/parseDispatchOutcome.test.ts`, `electron/severity/computeSeverity.test.ts`, `electron/severity/isStalled.test.ts`, `electron/severity/baselineMath.test.ts`

**Interfaces:**
- Consumes: nothing. **Core rule:** these files import only `./`-relative siblings. No `node:` import, no `../`, no `src/`, because Task 3 copies them verbatim into the collector.
- Produces:
  - `type DispatchStatus = 'completed' | 'failed' | 'killed' | 'unknown'`
  - `interface DispatchUsage { tokens: number; toolUses: number; durationMs: number }`
  - `interface DispatchOutcome { status: DispatchStatus; usage?: DispatchUsage }`
  - `parseDispatchOutcome(notificationText: unknown): DispatchOutcome`
  - `unrecognisedStatusTag(notificationText: unknown): string | null`. Returns null when the status is recognised, otherwise `'<missing>'`, a raw tag matching `/^[a-z_]{1,24}$/`, or `'<unprintable>'`
  - `type Severity = 0|1|2|3|4`, `type ExitState = 'ok'|'partial'|'error'|'fatal'|'timeout'|'blocked'|'killed'`
  - `SLOW_FACTOR = 3`, `SLOWNESS_CAP = 2`
  - `interface SeverityInput { exit: ExitState; elapsedMs: number; medianMsAtEval: number | null; findingWeights?: readonly Severity[] }`
  - `interface SeverityResult { severity: Severity; exitState: ExitState; elapsedMs: number; medianMs: number | null }`
  - `exitStateForStatus(status: DispatchStatus): ExitState`, `computeSeverity(input: SeverityInput): SeverityResult`
  - `STALL_MS = 1_800_000`, `interface StallProbe { lastProgressMs: number; sessionEnded: boolean }`, `isStalled(probe: StallProbe, nowMs: number): boolean`
  - `BASELINE_MIN_SAMPLES = 5`, `BASELINE_WINDOW = 20`, `isAdmissibleSample(outcome: DispatchOutcome): boolean`, `medianOf(samples: readonly number[]): number | null`. `medianOf` expects oldest-first input and keeps the last 20 valid samples.

- [ ] **Step 1: Write the failing parser test** `electron/severity/parseDispatchOutcome.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { parseDispatchOutcome, unrecognisedStatusTag } from './parseDispatchOutcome';

// Synthetic notifications shaped like Claude Code's task-notification.
// No real transcript content.
function note(status: string | null, usage?: { tokens: number; toolUses: number; durationMs: number }, extra = ''): string {
  return (
    '<task-notification><task-id>t1</task-id><tool-use-id>tu_1</tool-use-id>' +
    (status === null ? '' : `<status>${status}</status>`) +
    '<summary>Agent "x" finished</summary>' +
    extra +
    (usage
      ? `<usage><subagent_tokens>${usage.tokens}</subagent_tokens><tool_uses>${usage.toolUses}</tool_uses><duration_ms>${usage.durationMs}</duration_ms></usage>`
      : '') +
    '</task-notification>'
  );
}

describe('parseDispatchOutcome', () => {
  it('completed with usage', () => {
    expect(parseDispatchOutcome(note('completed', { tokens: 1200, toolUses: 7, durationMs: 65000 }))).toEqual({
      status: 'completed',
      usage: { tokens: 1200, toolUses: 7, durationMs: 65000 },
    });
  });

  it('failed without usage gives usage undefined, never zeros', () => {
    const r = parseDispatchOutcome(note('failed'));
    expect(r.status).toBe('failed');
    expect(r.usage).toBeUndefined();
  });

  it('killed without usage', () => {
    const r = parseDispatchOutcome(note('killed'));
    expect(r).toEqual({ status: 'killed' });
  });

  it('missing status tag is unknown', () => {
    expect(parseDispatchOutcome(note(null)).status).toBe('unknown');
  });

  it('unrecognised status tag is unknown', () => {
    expect(parseDispatchOutcome(note('running')).status).toBe('unknown');
  });

  it('a partial usage block (one tag missing) is no usage, not zeros', () => {
    const text = '<status>completed</status><subagent_tokens>5</subagent_tokens><tool_uses>1</tool_uses>';
    expect(parseDispatchOutcome(text)).toEqual({ status: 'completed' });
  });

  it('never throws on non-string input', () => {
    for (const bad of [undefined, null, 42, {}, [], Symbol('x')]) {
      expect(() => parseDispatchOutcome(bad)).not.toThrow();
      expect(parseDispatchOutcome(bad)).toEqual({ status: 'unknown' });
    }
  });

  // Review Focus 1
  it('ignores tags quoted inside summary/result', () => {
    const quoted =
      '<result>The format is <status>failed</status> with <subagent_tokens>1</subagent_tokens><tool_uses>1</tool_uses><duration_ms>1</duration_ms></result>';
    const r = parseDispatchOutcome(note('completed', { tokens: 900, toolUses: 3, durationMs: 4000 }, quoted));
    expect(r).toEqual({ status: 'completed', usage: { tokens: 900, toolUses: 3, durationMs: 4000 } });

    const summaryQuote =
      '<task-notification><tool-use-id>tu_2</tool-use-id><summary>saw <status>failed</status></summary></task-notification>';
    expect(parseDispatchOutcome(summaryQuote).status).toBe('unknown');
  });

  it('result carries no string field other than status', () => {
    const inputs = [
      note('completed', { tokens: 1, toolUses: 1, durationMs: 1 }, '<result>secret source code</result>'),
      note('failed', undefined, '<result>stack trace here</result>'),
      note('weird'),
    ];
    for (const text of inputs) {
      const r = parseDispatchOutcome(text) as unknown as Record<string, unknown>;
      expect(Object.keys(r).every((k) => k === 'status' || k === 'usage')).toBe(true);
      if (r.usage !== undefined) {
        expect(Object.values(r.usage as object).every((v) => typeof v === 'number')).toBe(true);
      }
      expect(JSON.stringify(r)).not.toMatch(/secret|stack trace/);
    }
  });
});

describe('unrecognisedStatusTag', () => {
  it('is null for recognised statuses', () => {
    expect(unrecognisedStatusTag(note('completed'))).toBeNull();
    expect(unrecognisedStatusTag(note('failed'))).toBeNull();
    expect(unrecognisedStatusTag(note('killed'))).toBeNull();
  });
  it('names a plain unknown value, and hides anything else', () => {
    expect(unrecognisedStatusTag(note('running'))).toBe('running');
    expect(unrecognisedStatusTag(note(null))).toBe('<missing>');
    expect(unrecognisedStatusTag(note('C:\\Users\\bob secret'))).toBe('<unprintable>');
    expect(unrecognisedStatusTag(undefined)).toBe('<missing>');
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run electron/severity/parseDispatchOutcome.test.ts`
Expected: FAIL, "Failed to resolve import "./parseDispatchOutcome"".

- [ ] **Step 3: Implement** `electron/severity/parseDispatchOutcome.ts`

```ts
// electron/severity/parseDispatchOutcome.ts
// Pure. Reads an Agent dispatch's outcome from its task-notification text.
// Never throws. The result holds NO string except `status`: the <summary> and
// <result> bodies are transcript content, and they are removed BEFORE any tag
// is matched, so a result that quotes "<status>failed</status>" cannot flip
// the outcome. Spec: docs/superpowers/specs/2026-09-30-real-severity-design.md
// sections 3, 4 and 9.
//
// SOURCE OF TRUTH for collector/src/severity/parseDispatchOutcome.ts, which
// scripts/sync-severity-core.mjs generates. Edit here, then re-run it.

export type DispatchStatus = 'completed' | 'failed' | 'killed' | 'unknown';

export interface DispatchUsage {
  tokens: number;
  toolUses: number;
  durationMs: number;
}

export interface DispatchOutcome {
  status: DispatchStatus;
  usage?: DispatchUsage;
}

const CONTENT_BLOCKS = /<(summary|result)>[\s\S]*?<\/\1>/g;
const STATUS_TAG = /<status>([^<]*)<\/status>/;
const TOKENS_TAG = /<subagent_tokens>(\d+)<\/subagent_tokens>/;
const TOOL_USES_TAG = /<tool_uses>(\d+)<\/tool_uses>/;
const DURATION_TAG = /<duration_ms>(\d+)<\/duration_ms>/;
const DIAG_SAFE_TAG = /^[a-z_]{1,24}$/;

function structuralPart(text: string): string {
  return text.replace(CONTENT_BLOCKS, '');
}

function recognised(raw: string): raw is 'completed' | 'failed' | 'killed' {
  return raw === 'completed' || raw === 'failed' || raw === 'killed';
}

export function parseDispatchOutcome(notificationText: unknown): DispatchOutcome {
  if (typeof notificationText !== 'string') return { status: 'unknown' };
  const text = structuralPart(notificationText);

  const statusMatch = STATUS_TAG.exec(text);
  const raw = statusMatch ? statusMatch[1].trim() : '';
  const status: DispatchStatus = recognised(raw) ? raw : 'unknown';

  const tokens = TOKENS_TAG.exec(text);
  const toolUses = TOOL_USES_TAG.exec(text);
  const duration = DURATION_TAG.exec(text);
  if (tokens && toolUses && duration) {
    return {
      status,
      usage: { tokens: Number(tokens[1]), toolUses: Number(toolUses[1]), durationMs: Number(duration[1]) },
    };
  }
  return { status };
}

// For the one-per-value [diag] line ONLY, never for storage. Returns null
// when the status is recognised. Otherwise returns a short lowercase word,
// '<missing>', or '<unprintable>', so no free text can reach a log.
export function unrecognisedStatusTag(notificationText: unknown): string | null {
  if (typeof notificationText !== 'string') return '<missing>';
  const statusMatch = STATUS_TAG.exec(structuralPart(notificationText));
  if (!statusMatch) return '<missing>';
  const raw = statusMatch[1].trim();
  if (recognised(raw)) return null;
  return DIAG_SAFE_TAG.test(raw) ? raw : '<unprintable>';
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run electron/severity/parseDispatchOutcome.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Write the failing severity test** `electron/severity/computeSeverity.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { computeSeverity, exitStateForStatus, SLOW_FACTOR } from './computeSeverity';

const base = { elapsedMs: 1000, medianMsAtEval: null };

describe('computeSeverity (spec section 3 table)', () => {
  it('completed, normal -> ok, 1', () => {
    expect(computeSeverity({ exit: 'ok', ...base }).severity).toBe(1);
  });
  it('completed and slow (elapsed > 3x established median) -> 2', () => {
    expect(SLOW_FACTOR).toBe(3);
    expect(computeSeverity({ exit: 'ok', elapsedMs: 301, medianMsAtEval: 100 }).severity).toBe(2);
    expect(computeSeverity({ exit: 'ok', elapsedMs: 300, medianMsAtEval: 100 }).severity).toBe(1);
  });
  it('slowness alone is capped at 2, however slow', () => {
    expect(computeSeverity({ exit: 'ok', elapsedMs: 10_000_000, medianMsAtEval: 1 }).severity).toBe(2);
  });
  it('failed -> error, 4', () => {
    const r = computeSeverity({ exit: exitStateForStatus('failed'), ...base });
    expect(r.exitState).toBe('error');
    expect(r.severity).toBe(4);
  });
  it('killed -> killed, 2 (even when slow, and never above 2)', () => {
    expect(exitStateForStatus('killed')).toBe('killed');
    expect(computeSeverity({ exit: 'killed', ...base }).severity).toBe(2);
    expect(computeSeverity({ exit: 'killed', elapsedMs: 9_999, medianMsAtEval: 1 }).severity).toBe(2);
    expect(computeSeverity({ exit: 'killed', ...base, findingWeights: [4] }).severity).toBe(2);
  });
  it('stalled -> fatal, 4', () => {
    expect(computeSeverity({ exit: 'fatal', ...base }).severity).toBe(4);
  });
  it('unknown status -> ok, 1 (never guess a failure)', () => {
    expect(exitStateForStatus('unknown')).toBe('ok');
    expect(computeSeverity({ exit: exitStateForStatus('unknown'), ...base }).severity).toBe(1);
  });
  it('completed maps to ok', () => {
    expect(exitStateForStatus('completed')).toBe('ok');
  });
  it('unused exit values keep their section-4 floors', () => {
    expect(computeSeverity({ exit: 'partial', ...base }).severity).toBe(2);
    expect(computeSeverity({ exit: 'timeout', ...base }).severity).toBe(3);
    expect(computeSeverity({ exit: 'blocked', ...base }).severity).toBe(4);
  });
  it('negative elapsed (clock skew) gives no slowness bump', () => {
    expect(computeSeverity({ exit: 'ok', elapsedMs: -5000, medianMsAtEval: 100 }).severity).toBe(1);
  });
  it('an unusable median (0, negative, NaN) is treated as unestablished', () => {
    for (const m of [0, -1, Number.NaN]) {
      const r = computeSeverity({ exit: 'ok', elapsedMs: 1e9, medianMsAtEval: m });
      expect(r.severity).toBe(1);
      expect(r.medianMs).toBeNull();
    }
  });
  it('result carries exactly severity, exitState, elapsedMs, medianMs (no text)', () => {
    const r = computeSeverity({ exit: 'ok', elapsedMs: 840000, medianMsAtEval: 240000 });
    expect(Object.keys(r).sort()).toEqual(['elapsedMs', 'exitState', 'medianMs', 'severity']);
    expect(r).toEqual({ severity: 2, exitState: 'ok', elapsedMs: 840000, medianMs: 240000 });
  });
});
```

- [ ] **Step 6: Run it and see it fail**

Run: `npx vitest run electron/severity/computeSeverity.test.ts`
Expected: FAIL, unresolved import `./computeSeverity`.

- [ ] **Step 7: Implement** `electron/severity/computeSeverity.ts`

```ts
// electron/severity/computeSeverity.ts
// Pure severity derivation. Amends AGENT_PERSONALITY_LAYER_1.md section 4 per
// docs/superpowers/specs/2026-09-30-real-severity-design.md section 3:
//   failed -> error/4, killed -> killed/2 (never above 2), stalled -> fatal/4,
//   unknown -> ok/1, slowness alone capped at 2, retries rule removed (no source).
//
// SOURCE OF TRUTH for collector/src/severity/computeSeverity.ts, which
// scripts/sync-severity-core.mjs generates. Edit here, then re-run it.

import type { DispatchStatus } from './parseDispatchOutcome';

export type Severity = 0 | 1 | 2 | 3 | 4;

export type ExitState =
  | 'ok'
  | 'partial' // unused: nothing produces it yet
  | 'error' // <status>failed</status>
  | 'fatal' // stalled: no progress past STALL_MS, or the owning session ended
  | 'timeout' // unused: nothing produces it yet
  | 'blocked' // unused: nothing produces it yet
  | 'killed'; // <status>killed</status>: almost always a deliberate stop

export const SLOW_FACTOR = 3;
export const SLOWNESS_CAP = 2;

export interface SeverityInput {
  exit: ExitState;
  elapsedMs: number;
  medianMsAtEval: number | null;
  findingWeights?: readonly Severity[];
}

export interface SeverityResult {
  severity: Severity;
  exitState: ExitState;
  elapsedMs: number;
  medianMs: number | null;
}

export function exitStateForStatus(status: DispatchStatus): ExitState {
  if (status === 'failed') return 'error';
  if (status === 'killed') return 'killed';
  return 'ok';
}

export function computeSeverity(input: SeverityInput): SeverityResult {
  const { exit, elapsedMs, findingWeights = [] } = input;
  const m = input.medianMsAtEval;
  const medianMs = typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : null;

  let sev = 1;
  if (medianMs !== null && Number.isFinite(elapsedMs) && elapsedMs > 0 && elapsedMs > SLOW_FACTOR * medianMs) {
    sev = Math.min(sev + 1, SLOWNESS_CAP);
  }

  if (exit === 'partial') sev = Math.max(sev, 2);
  if (exit === 'timeout') sev = Math.max(sev, 3);
  if (exit === 'error') sev = Math.max(sev, 4);
  if (exit === 'fatal') sev = Math.max(sev, 4);
  if (exit === 'blocked') sev = 4;

  if (findingWeights.some((w) => w === 3)) sev = Math.max(sev, 3);
  if (findingWeights.some((w) => w === 4)) sev = Math.max(sev, 4);

  // Last on purpose: a kill is informational and must never reach the
  // severity >= 3 floor (dial bypass, voice), whatever else is true.
  if (exit === 'killed') sev = 2;

  sev = Math.min(4, Math.max(0, sev));
  return { severity: sev as Severity, exitState: exit, elapsedMs, medianMs };
}
```

- [ ] **Step 8: Run it and see it pass**

Run: `npx vitest run electron/severity/computeSeverity.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 9: Write the failing stall and baseline tests**

`electron/severity/isStalled.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { isStalled, STALL_MS } from './isStalled';

describe('isStalled', () => {
  it('STALL_MS is 30 minutes', () => {
    expect(STALL_MS).toBe(30 * 60 * 1000);
  });
  it('a fresh dispatch is not stalled', () => {
    expect(isStalled({ lastProgressMs: 1_000, sessionEnded: false }, 1_000 + 60_000)).toBe(false);
  });
  it('inactivity threshold: exactly STALL_MS is not stalled, one ms more is', () => {
    expect(isStalled({ lastProgressMs: 0, sessionEnded: false }, STALL_MS)).toBe(false);
    expect(isStalled({ lastProgressMs: 0, sessionEnded: false }, STALL_MS + 1)).toBe(true);
  });
  it('an ended session stalls an open dispatch immediately', () => {
    expect(isStalled({ lastProgressMs: 1_000, sessionEnded: true }, 1_001)).toBe(true);
  });
  it('non-finite progress is never an inactivity stall', () => {
    expect(isStalled({ lastProgressMs: Number.NaN, sessionEnded: false }, 1e15)).toBe(false);
  });
});
```

`electron/severity/baselineMath.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { medianOf, isAdmissibleSample, BASELINE_MIN_SAMPLES, BASELINE_WINDOW } from './baselineMath';

describe('medianOf', () => {
  it('needs 5 samples', () => {
    expect(BASELINE_MIN_SAMPLES).toBe(5);
    expect(medianOf([10, 20, 30, 40])).toBeNull();
    expect(medianOf([10, 20, 30, 40, 50])).toBe(30);
  });
  it('uses only the last 20 samples (oldest first in, oldest dropped)', () => {
    expect(BASELINE_WINDOW).toBe(20);
    const old = Array.from({ length: 20 }, () => 1_000_000);
    const recent = Array.from({ length: 20 }, () => 10);
    expect(medianOf([...old, ...recent])).toBe(10);
  });
  it('ignores zero, negative and non-finite entries', () => {
    expect(medianOf([0, 0, 0, -5, Number.NaN, 10, 20, 30, 40])).toBeNull();
    expect(medianOf([0, 10, 20, 30, 40, 50])).toBe(30);
  });
  it('even count averages the middle pair', () => {
    expect(medianOf([10, 20, 30, 40, 50, 60])).toBe(35);
  });
});

describe('isAdmissibleSample', () => {
  const usage = { tokens: 1, toolUses: 1, durationMs: 5000 };
  it('admits only completed outcomes with usage and durationMs > 0', () => {
    expect(isAdmissibleSample({ status: 'completed', usage })).toBe(true);
    expect(isAdmissibleSample({ status: 'completed' })).toBe(false);
    expect(isAdmissibleSample({ status: 'completed', usage: { ...usage, durationMs: 0 } })).toBe(false);
    expect(isAdmissibleSample({ status: 'failed', usage })).toBe(false);
    expect(isAdmissibleSample({ status: 'killed', usage })).toBe(false);
    expect(isAdmissibleSample({ status: 'unknown', usage })).toBe(false);
  });
});
```

- [ ] **Step 10: Run them and see them fail**

Run: `npx vitest run electron/severity/isStalled.test.ts electron/severity/baselineMath.test.ts`
Expected: FAIL, unresolved imports.

- [ ] **Step 11: Implement both**

`electron/severity/isStalled.ts`:
```ts
// electron/severity/isStalled.ts
// Pure. Spec section 5: stalled = no progress for longer than STALL_MS, OR the
// owning Claude session has ended while the dispatch is still open. Callers
// decide what "progress" and "session ended" mean on their path.
//
// SOURCE OF TRUTH for collector/src/severity/isStalled.ts (generated).

export const STALL_MS = 30 * 60 * 1000;

export interface StallProbe {
  lastProgressMs: number;
  sessionEnded: boolean;
}

export function isStalled(probe: StallProbe, nowMs: number): boolean {
  if (probe.sessionEnded) return true;
  if (!Number.isFinite(probe.lastProgressMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - probe.lastProgressMs > STALL_MS;
}
```

`electron/severity/baselineMath.ts`:
```ts
// electron/severity/baselineMath.ts
// Pure duration-baseline rules shared by the live store and the collector's
// median query. Spec section 6: only completed outcomes with a usage block and
// durationMs > 0 are admitted; last 20 per key; below 5 samples there is no
// median (null) and so no slowness bump.
//
// SOURCE OF TRUTH for collector/src/severity/baselineMath.ts (generated).

import type { DispatchOutcome } from './parseDispatchOutcome';

export const BASELINE_MIN_SAMPLES = 5;
export const BASELINE_WINDOW = 20;

export function isAdmissibleSample(outcome: DispatchOutcome): boolean {
  const d = outcome.usage?.durationMs;
  return outcome.status === 'completed' && typeof d === 'number' && Number.isFinite(d) && d > 0;
}

// samples: oldest first.
export function medianOf(samples: readonly number[]): number | null {
  const valid = samples.filter((n) => Number.isFinite(n) && n > 0).slice(-BASELINE_WINDOW);
  if (valid.length < BASELINE_MIN_SAMPLES) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
```

- [ ] **Step 12: Run all core tests and the electron typecheck**

Run: `npx vitest run electron/severity/` then `npm run typecheck:electron`
Expected: 4 files PASS. Typecheck exit 0.

- [ ] **Step 13: Byte-check and commit**

Run: `LC_ALL=C grep -n '[^[:print:][:space:]]' electron/severity/*.ts` -> no output.
```bash
git add electron/severity/
git commit -m "feat(severity): pure core - outcome parser, real severity rules, stall + baseline math"
```

---

### Task 3: Generated collector copy + parity test; move `computeSeverity` out of `personalitySpine`

**Files:**
- Create: `scripts/sync-severity-core.mjs`, `scripts/sync-severity-core.d.mts`, `electron/severity/severity.parity.test.ts`
- Create (generated, never hand-edited): `collector/src/severity/parseDispatchOutcome.ts`, `computeSeverity.ts`, `isStalled.ts`, `baselineMath.ts`
- Modify: `collector/src/personalitySpine.ts:21-29` (types) and `:80-124` (delete `computeSeverity`)
- Modify: `collector/src/usageIngest.ts:4,63-68`, `collector/src/staleDispatchSweep.ts:3,88-93`
- Modify tests: `collector/src/personalitySpine.test.ts` (rewrite), `collector/src/usageIngest.test.ts:9,236-243`, `collector/src/staleDispatchSweep.test.ts:8,140-142`, `collector/src/narrationSpine.integration.test.ts:7,75-82,122-129`

**Interfaces:**
- Consumes: Task 2's four core files and exports.
- Produces: `CORE_FILES: readonly string[]`, `renderCollectorCopy(source: string, fileName: string): string` (script). The collector imports `./severity/computeSeverity.js` etc. `personalitySpine.ts` still exports `Severity` and `ExitState` as re-exported types, so `electron/collectorStore.ts:10` and `src/components/ledger/DispatchCostTable.tsx:6` compile unchanged. **Behaviour is unchanged in this task** apart from the call shape. Ingest still writes `ok`/1 and the sweep still writes `fatal`/4. Task 5 changes behaviour.

- [ ] **Step 1: Write the failing parity test** `electron/severity/severity.parity.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { CORE_FILES, renderCollectorCopy } from '../../scripts/sync-severity-core.mjs';

// The collector is a standalone zero-dependency process, so it carries a
// GENERATED copy of the severity core. If the copies drift, this fails. Fix it
// by running `node scripts/sync-severity-core.mjs`, never by editing
// collector/src/severity/ by hand.
const repoRoot = join(__dirname, '..', '..');
const lf = (s: string) => s.replace(/\r\n/g, '\n');

describe('severity core: generated collector copy', () => {
  it.each([...CORE_FILES])('collector/src/severity/%s is exactly the generated form of the electron source', (f) => {
    const electron = readFileSync(join(repoRoot, 'electron', 'severity', f), 'utf8');
    const collector = readFileSync(join(repoRoot, 'collector', 'src', 'severity', f), 'utf8');
    expect(lf(collector)).toBe(lf(renderCollectorCopy(electron, f)));
  });

  it('collector/src/severity holds only generated core files', () => {
    const present = readdirSync(join(repoRoot, 'collector', 'src', 'severity')).sort();
    expect(present).toEqual([...CORE_FILES].sort());
  });

  it('core sources import only ./ siblings or node: builtins', () => {
    for (const f of CORE_FILES) {
      const src = readFileSync(join(repoRoot, 'electron', 'severity', f), 'utf8');
      for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        expect(m[1].startsWith('./') || m[1].startsWith('node:')).toBe(true);
      }
    }
  });

  it('rewrites relative imports to .js for the NodeNext collector', () => {
    const out = renderCollectorCopy("import type { X } from './parseDispatchOutcome';\nexport const a = 1;\n", 'x.ts');
    expect(out).toContain("from './parseDispatchOutcome.js'");
    expect(out.startsWith('// GENERATED from electron/severity/x.ts')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run electron/severity/severity.parity.test.ts`
Expected: FAIL, "Failed to resolve import "../../scripts/sync-severity-core.mjs"".

- [ ] **Step 3: Implement the generator and its type declaration**

`scripts/sync-severity-core.mjs`:
```js
#!/usr/bin/env node
// Generates collector/src/severity/*.ts from electron/severity/*.ts.
// The collector is a standalone package (NodeNext ESM, own build), so it
// cannot import from electron/. It gets a generated copy instead, and
// electron/severity/severity.parity.test.ts fails if the two drift.
// Usage: node scripts/sync-severity-core.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORE_FILES = ['parseDispatchOutcome.ts', 'computeSeverity.ts', 'isStalled.ts', 'baselineMath.ts'];

export function renderCollectorCopy(source, fileName) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const body = source.replace(/(from\s+['"])(\.\/[^'"]+?)(['"])/g, (match, head, spec, tail) =>
    spec.endsWith('.js') ? match : `${head}${spec}.js${tail}`,
  );
  return (
    `// GENERATED from electron/severity/${fileName} by scripts/sync-severity-core.mjs -- do not edit.${eol}` +
    `// Edit the electron copy, then run: node scripts/sync-severity-core.mjs${eol}` +
    body
  );
}

function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = join(repoRoot, 'collector', 'src', 'severity');
  mkdirSync(outDir, { recursive: true });
  for (const f of CORE_FILES) {
    const src = readFileSync(join(repoRoot, 'electron', 'severity', f), 'utf8');
    writeFileSync(join(outDir, f), renderCollectorCopy(src, f), 'utf8');
  }
  console.log(`sync-severity-core: wrote ${CORE_FILES.length} files to collector/src/severity`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : '';
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) main();
```

`scripts/sync-severity-core.d.mts`:
```ts
export declare const CORE_FILES: readonly string[];
export declare function renderCollectorCopy(source: string, fileName: string): string;
```

- [ ] **Step 4: Generate the copy**

Run: `node scripts/sync-severity-core.mjs`
Expected: `sync-severity-core: wrote 4 files to collector/src/severity`.

- [ ] **Step 5: Run the parity test and see it pass**

Run: `npx vitest run electron/severity/severity.parity.test.ts`
Expected: PASS (7 tests: 4 each, plus 3).

- [ ] **Step 6: Rewrite `collector/src/personalitySpine.test.ts` so it fails first.** It must exercise the GENERATED copy under the collector's own NodeNext build.

```ts
import { describe, it, expect } from 'vitest';
import { computeSeverity, exitStateForStatus } from './severity/computeSeverity.js';
import { parseDispatchOutcome } from './severity/parseDispatchOutcome.js';
import type { ExitState, Severity } from './personalitySpine.js';

// The rules themselves are tested in electron/severity/computeSeverity.test.ts.
// This proves the generated collector copy compiles and behaves the same under
// the collector's own build, and that personalitySpine still exports the types.
describe('collector severity copy', () => {
  it('failed -> error/4, killed -> killed/2, unknown -> ok/1', () => {
    const sev = (s: string) =>
      computeSeverity({ exit: exitStateForStatus(parseDispatchOutcome(`<status>${s}</status>`).status), elapsedMs: 0, medianMsAtEval: null });
    expect(sev('failed')).toMatchObject({ exitState: 'error', severity: 4 });
    expect(sev('killed')).toMatchObject({ exitState: 'killed', severity: 2 });
    expect(sev('running')).toMatchObject({ exitState: 'ok', severity: 1 });
  });

  it('personalitySpine re-exports ExitState including killed', () => {
    const e: ExitState = 'killed';
    const s: Severity = 2;
    expect([e, s]).toEqual(['killed', 2]);
  });
});
```

Run (from `collector/`): `npx vitest run src/personalitySpine.test.ts`
Expected: FAIL. At runtime vitest resolves `./severity/computeSeverity.js`, which exists after Step 4, so the likely failure is a type-level one. Confirm it with `npx tsc -p tsconfig.json --noEmit` (from `collector/`): "'killed' is not assignable to type 'ExitState'". Record whichever of the two failed.

- [ ] **Step 7: Edit `collector/src/personalitySpine.ts`**

Replace lines 21-29 (`export type Severity ...` through the `ExitState` union) with:
```ts
import type { Severity, ExitState } from './severity/computeSeverity.js';
export type { Severity, ExitState } from './severity/computeSeverity.js';
```
Delete lines 80-124 (the `computeSeverity` doc comment and function). Add one line to the header comment (after line 11): `// computeSeverity moved to ./severity/computeSeverity.js (generated from electron/severity/) -- spec 2026-09-30-real-severity-design.md section 4.`

- [ ] **Step 8: Rewire the two callers (same behaviour, new shape)**

`collector/src/usageIngest.ts`. Line 4 becomes `import { computeSeverity } from './severity/computeSeverity.js';`. Lines 63-68 become:
```ts
  const severity = computeSeverity({
    exit: 'ok',
    elapsedMs: durationMs,
    medianMsAtEval: null,
  }).severity;
```
`collector/src/staleDispatchSweep.ts`. Line 3 becomes `import { computeSeverity } from './severity/computeSeverity.js';`. Lines 88-93 become:
```ts
    const severity = computeSeverity({
      exit: 'fatal',
      elapsedMs: durationMs,
      medianMsAtEval: null,
    }).severity;
```

- [ ] **Step 9: Update the three test files that import `computeSeverity` from `personalitySpine`**

In each of `collector/src/usageIngest.test.ts:9`, `collector/src/staleDispatchSweep.test.ts:8` and `collector/src/narrationSpine.integration.test.ts:7`, change the import to `import { computeSeverity } from './severity/computeSeverity.js';`. In every `computeSeverity({...})` call in those files, delete the `retries: <n>,` property and append `.severity` to the call. Example (`staleDispatchSweep.test.ts:140`):
```ts
    const expectedSeverity = computeSeverity({ exit: 'fatal', elapsedMs: nowMs - startedAt, medianMsAtEval: null }).severity;
```
List every edited call site in the builder report.

- [ ] **Step 10: Verify**

Run: from `collector/`, `npx vitest run` and `npx tsc -p tsconfig.json --noEmit`. At the root, `npx vitest run electron/severity/` and `npm run typecheck:electron`.
Expected: collector 32 files, 0 failures (the pass count drops because the old per-rule `personalitySpine` tests are replaced by 2 copy tests; report the real count). tsc exit 0. Root severity tests PASS. electron typecheck exit 0.

- [ ] **Step 11: Byte-check and commit**

Run: `LC_ALL=C grep -n '[^[:print:][:space:]]' scripts/sync-severity-core.mjs scripts/sync-severity-core.d.mts collector/src/severity/*.ts electron/severity/severity.parity.test.ts collector/src/personalitySpine.ts` -> no output.
```bash
git add scripts/sync-severity-core.mjs scripts/sync-severity-core.d.mts collector/src/severity electron/severity/severity.parity.test.ts collector/src/personalitySpine.ts collector/src/personalitySpine.test.ts collector/src/usageIngest.ts collector/src/usageIngest.test.ts collector/src/staleDispatchSweep.ts collector/src/staleDispatchSweep.test.ts collector/src/narrationSpine.integration.test.ts
git commit -m "feat(collector): generated severity core copy + parity test; computeSeverity moves out of personalitySpine"
```

---

### Task 4: Schema v9, nullable dispatch usage columns (Node + Go)

**Files:**
- Modify: `collector/src/schema.ts:8` (version), `:115-122` (base `CREATE TABLE dispatches`), and add a v9 block after the v8 block (`:177-195`)
- Modify: `collector-go/internal/schema/schema.go:21` (version), `:158-165` (base CREATE), and add a v9 block before the "NEVER lower" guard (`:264`)
- Modify: `test-fixtures/collector-parity/expected.json` (`"schemaVersion": 9`)
- Test: `collector/src/schema.test.ts` (add), `collector-go/internal/schema/parity_test.go` (line 52 literal -> 9; add tests)

**Interfaces:**
- Consumes: nothing (independent of Tasks 2 and 3).
- Produces: `SCHEMA_VERSION = 9`. In `dispatches`, `tokens`, `tool_uses` and `duration_ms` are nullable on both fresh and upgraded databases. Column names are unchanged (parity `columns` unchanged).

- [ ] **Step 1: Write the failing Node tests** (append to `collector/src/schema.test.ts`; `openDatabase`, `migrate`, `getSchemaVersion` and `SCHEMA_VERSION` are already imported at line 5, and the file uses `mkdtempSync`/`tmpdir`/`join`. Add any missing import.)

```ts
describe('v9: dispatches usage columns are nullable', () => {
  function usageNotNull(db: ReturnType<typeof openDatabase>): Record<string, number> {
    const rows = db.prepare(`SELECT name, "notnull" AS nn FROM pragma_table_info('dispatches')`).all() as { name: string; nn: number }[];
    return Object.fromEntries(rows.filter((r) => ['tokens', 'tool_uses', 'duration_ms'].includes(r.name)).map((r) => [r.name, r.nn]));
  }
  const V8_DISPATCHES = `CREATE TABLE dispatches (tool_use_id TEXT PRIMARY KEY, tokens INTEGER NOT NULL, tool_uses INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER NOT NULL, agent_id TEXT, task_kind TEXT,
    session_id TEXT, retries INTEGER NOT NULL DEFAULT 0, exit_state TEXT NOT NULL DEFAULT 'ok', severity INTEGER, median_ms_at_eval INTEGER)`;
  function v8Db() {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'aether-schema-v9-')), 't.db'));
    migrate(db);
    db.exec(`DROP TABLE dispatches; ${V8_DISPATCHES};`);
    db.prepare("UPDATE schema_meta SET value = '8' WHERE key = 'version'").run();
    db.prepare(`INSERT INTO dispatches VALUES ('tu_a', 1200, 7, 65000, 1000, 66000, 'code-reviewer', 'code-reviewer', 's1', 0, 'ok', 1, NULL)`).run();
    db.prepare(`INSERT INTO dispatches VALUES ('tu_b', 0, 0, 1800000, 5, 1800005, 'general-purpose', 'general-purpose', 's1', 0, 'fatal', 4, NULL)`).run();
    return db;
  }

  it('SCHEMA_VERSION is 9', () => {
    expect(SCHEMA_VERSION).toBe(9);
  });

  it('a fresh database has nullable usage columns', () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'aether-schema-v9-')), 't.db'));
    migrate(db);
    expect(usageNotNull(db)).toEqual({ tokens: 0, tool_uses: 0, duration_ms: 0 });
    db.close();
  });

  // Review Focus 3
  it('upgrades a v8 database preserving every row and value, and is idempotent', () => {
    const db = v8Db();
    const before = db.prepare('SELECT * FROM dispatches ORDER BY tool_use_id').all();
    migrate(db);
    migrate(db);
    expect(usageNotNull(db)).toEqual({ tokens: 0, tool_uses: 0, duration_ms: 0 });
    expect(db.prepare('SELECT * FROM dispatches ORDER BY tool_use_id').all()).toEqual(before);
    expect(getSchemaVersion(db)).toBe(9);
    db.prepare(`INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms, exit_state)
                VALUES ('tu_null', NULL, NULL, NULL, 1, 2, 'error')`).run();
    expect(db.prepare("SELECT tokens FROM dispatches WHERE tool_use_id = 'tu_null'").get()).toEqual({ tokens: null });
    db.close();
  });

  it('heals a database stamped 9 that is physically still NOT NULL (e.g. created by an older Go collector)', () => {
    const db = v8Db();
    db.prepare("UPDATE schema_meta SET value = '9' WHERE key = 'version'").run();
    migrate(db);
    expect(usageNotNull(db)).toEqual({ tokens: 0, tool_uses: 0, duration_ms: 0 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM dispatches').get() as { n: number }).n).toBe(2);
    db.close();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run (from `collector/`): `npx vitest run src/schema.test.ts`
Expected: FAIL. `SCHEMA_VERSION` is 8 and `notnull` is 1.

- [ ] **Step 3: Implement the Node migration**

In `collector/src/schema.ts`, set `export const SCHEMA_VERSION = 9;`. In the base `CREATE TABLE IF NOT EXISTS dispatches` (lines 115-122), change the three columns to `tokens INTEGER,`, `tool_uses INTEGER,`, `duration_ms INTEGER,`. After the `if (currentVersion < 8) {...}` block and before the version stamp, add:

```ts
  // v9: dispatches.tokens / tool_uses / duration_ms become NULLABLE. A failed
  // or killed dispatch's notification carries no usage block, and storing 0
  // for "not reported" fed a 0 ms duration into the median baseline
  // (docs/superpowers/specs/2026-09-30-real-severity-design.md sections 1, 7).
  // SQLite cannot drop NOT NULL in place, so this is a table rebuild. It is
  // column-driven (it reads pragma notnull), not version-gated, so a database
  // stamped 9 by one collector but created NOT NULL by another still heals.
  // Existing values are copied unchanged: no history rewrite.
  if (dispatchUsageIsNotNull(db)) rebuildDispatchesWithNullableUsage(db);
```

Add these helpers above `migrate`:
```ts
const DISPATCH_USAGE_COLUMNS = ['tokens', 'tool_uses', 'duration_ms'];
const DISPATCH_COLUMNS_V9 =
  'tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms, agent_id, task_kind, session_id, retries, exit_state, severity, median_ms_at_eval';

function dispatchUsageIsNotNull(db: DatabaseSync): boolean {
  const rows = db.prepare(`SELECT name, "notnull" AS nn FROM pragma_table_info('dispatches')`).all() as { name: string; nn: number }[];
  return rows.some((r) => DISPATCH_USAGE_COLUMNS.includes(r.name) && r.nn === 1);
}

function rebuildDispatchesWithNullableUsage(db: DatabaseSync): void {
  // The copy below names all 13 columns, so make sure the v5 ones exist even
  // on a database whose recorded version skipped the v5 block.
  addColumnIfMissing(db, 'dispatches', 'agent_id', 'agent_id TEXT');
  addColumnIfMissing(db, 'dispatches', 'task_kind', 'task_kind TEXT');
  addColumnIfMissing(db, 'dispatches', 'session_id', 'session_id TEXT');
  addColumnIfMissing(db, 'dispatches', 'retries', 'retries INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'dispatches', 'exit_state', "exit_state TEXT NOT NULL DEFAULT 'ok'");
  addColumnIfMissing(db, 'dispatches', 'severity', 'severity INTEGER');
  addColumnIfMissing(db, 'dispatches', 'median_ms_at_eval', 'median_ms_at_eval INTEGER');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      DROP TABLE IF EXISTS dispatches_v9;
      CREATE TABLE dispatches_v9 (
        tool_use_id TEXT PRIMARY KEY,
        tokens INTEGER,
        tool_uses INTEGER,
        duration_ms INTEGER,
        started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER NOT NULL,
        agent_id TEXT,
        task_kind TEXT,
        session_id TEXT,
        retries INTEGER NOT NULL DEFAULT 0,
        exit_state TEXT NOT NULL DEFAULT 'ok',
        severity INTEGER,
        median_ms_at_eval INTEGER
      );
      INSERT INTO dispatches_v9 (${DISPATCH_COLUMNS_V9}) SELECT ${DISPATCH_COLUMNS_V9} FROM dispatches;
      DROP TABLE dispatches;
      ALTER TABLE dispatches_v9 RENAME TO dispatches;
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

Run (from `collector/`): `npx vitest run src/schema.test.ts src/parity.test.ts`
Expected: `schema.test.ts` PASS. `parity.test.ts` FAIL on `schemaVersion` (golden is 8). Set `"schemaVersion": 9` in `test-fixtures/collector-parity/expected.json` and rerun. Expected: PASS.

- [ ] **Step 4: Write the failing Go tests** (in `collector-go/internal/schema/parity_test.go`)

Change line 52-53 to `if SchemaVersion != 9 {` / `t.Errorf("SchemaVersion = %d, want 9 to match collector/src/schema.ts", SchemaVersion)`. Append:

```go
func usageNotNull(t *testing.T, db *sql.DB) map[string]int {
	t.Helper()
	rows, err := db.Query(`SELECT name, "notnull" FROM pragma_table_info('dispatches') WHERE name IN ('tokens','tool_uses','duration_ms')`)
	if err != nil {
		t.Fatalf("pragma: %v", err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var n string
		var nn int
		if err := rows.Scan(&n, &nn); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out[n] = nn
	}
	return out
}

func TestMigrateMakesDispatchUsageNullable(t *testing.T) {
	db := freshDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	for c, nn := range usageNotNull(t, db) {
		if nn != 0 {
			t.Errorf("dispatches.%s notnull = %d, want 0", c, nn)
		}
	}
}

func TestMigrateRebuildsNotNullDispatchesPreservingRows(t *testing.T) {
	db := freshDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	// One statement per Exec: do not rely on the driver running a multi-statement string.
	for _, stmt := range []string{
		`DROP TABLE dispatches`,
		`CREATE TABLE dispatches (tool_use_id TEXT PRIMARY KEY, tokens INTEGER NOT NULL, tool_uses INTEGER NOT NULL,
		duration_ms INTEGER NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER NOT NULL, agent_id TEXT, task_kind TEXT,
		session_id TEXT, retries INTEGER NOT NULL DEFAULT 0, exit_state TEXT NOT NULL DEFAULT 'ok', severity INTEGER, median_ms_at_eval INTEGER)`,
		`INSERT INTO dispatches VALUES ('tu_a', 1200, 7, 65000, 1000, 66000, 'x', 'x', 's1', 0, 'ok', 1, NULL)`,
		`UPDATE schema_meta SET value = '8' WHERE key = 'version'`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("seed v8 shape: %v", err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := Migrate(db); err != nil {
			t.Fatalf("Migrate run %d: %v", i+1, err)
		}
	}
	for c, nn := range usageNotNull(t, db) {
		if nn != 0 {
			t.Errorf("after rebuild dispatches.%s notnull = %d, want 0", c, nn)
		}
	}
	var tokens, dur int
	if err := db.QueryRow(`SELECT tokens, duration_ms FROM dispatches WHERE tool_use_id = 'tu_a'`).Scan(&tokens, &dur); err != nil {
		t.Fatalf("row lost in rebuild: %v", err)
	}
	if tokens != 1200 || dur != 65000 {
		t.Errorf("row values changed: tokens=%d duration=%d", tokens, dur)
	}
}
```

Run (from `collector-go/`): `go test ./internal/schema/`
Expected: FAIL (`SchemaVersion = 8, want 9`; notnull = 1).

- [ ] **Step 5: Implement the Go migration**

`collector-go/internal/schema/schema.go`: set `const SchemaVersion = 9`. In the base `CREATE TABLE IF NOT EXISTS dispatches` (lines 158-165), make `tokens INTEGER,`, `tool_uses INTEGER,` and `duration_ms INTEGER,` nullable. Before the `if current >= SchemaVersion {` guard, add:

```go
	// v9: dispatches usage columns become NULLABLE, mirroring schema.ts's v9
	// block. Column-driven (pragma notnull), not version-gated, so a database
	// stamped 9 by the Node collector but created NOT NULL here still heals.
	notNull, err := dispatchUsageIsNotNull(db)
	if err != nil {
		return err
	}
	if notNull {
		if err := rebuildDispatchesWithNullableUsage(db); err != nil {
			return err
		}
	}
```
Add these helpers next to `addColumnIfMissing`:
```go
const dispatchColumnsV9 = "tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms, agent_id, task_kind, session_id, retries, exit_state, severity, median_ms_at_eval"

func dispatchUsageIsNotNull(db *sql.DB) (bool, error) {
	var n int
	err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('dispatches')
		WHERE name IN ('tokens','tool_uses','duration_ms') AND "notnull" = 1`).Scan(&n)
	return n > 0, err
}

func rebuildDispatchesWithNullableUsage(db *sql.DB) error {
	for _, c := range [][2]string{
		{"agent_id", "agent_id TEXT"},
		{"task_kind", "task_kind TEXT"},
		{"session_id", "session_id TEXT"},
		{"retries", "retries INTEGER NOT NULL DEFAULT 0"},
		{"exit_state", "exit_state TEXT NOT NULL DEFAULT 'ok'"},
		{"severity", "severity INTEGER"},
		{"median_ms_at_eval", "median_ms_at_eval INTEGER"},
	} {
		if err := addColumnIfMissing(db, "dispatches", c[0], c[1]); err != nil {
			return err
		}
	}
	// Only the tx is used inside: the caller may set SetMaxOpenConns(1), and a
	// db.Exec while this tx holds the one connection would deadlock.
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, stmt := range []string{
		`DROP TABLE IF EXISTS dispatches_v9`,
		`CREATE TABLE dispatches_v9 (
			tool_use_id TEXT PRIMARY KEY,
			tokens INTEGER,
			tool_uses INTEGER,
			duration_ms INTEGER,
			started_at_ms INTEGER NOT NULL,
			ended_at_ms INTEGER NOT NULL,
			agent_id TEXT,
			task_kind TEXT,
			session_id TEXT,
			retries INTEGER NOT NULL DEFAULT 0,
			exit_state TEXT NOT NULL DEFAULT 'ok',
			severity INTEGER,
			median_ms_at_eval INTEGER
		)`,
		`INSERT INTO dispatches_v9 (` + dispatchColumnsV9 + `) SELECT ` + dispatchColumnsV9 + ` FROM dispatches`,
		`DROP TABLE dispatches`,
		`ALTER TABLE dispatches_v9 RENAME TO dispatches`,
	} {
		if _, err := tx.Exec(stmt); err != nil {
			return err
		}
	}
	return tx.Commit()
}
```

- [ ] **Step 6: Verify both collectors**

Run: from `collector-go/`, `gofmt -l ./internal/schema/` (expect no output), `go vet ./...` and `go test ./...`. From `collector/`, `npx vitest run` and `npx tsc -p tsconfig.json --noEmit`. At the root, `npx vitest run electron/collectorStore.test.ts`.
Expected: all green. Go `internal/collector` parity passes at golden 9.

- [ ] **Step 7: Byte-check and commit**

Run: `LC_ALL=C grep -n '[^[:print:][:space:]]' collector/src/schema.ts collector-go/internal/schema/schema.go collector-go/internal/schema/parity_test.go` -> no output.
```bash
git add collector/src/schema.ts collector/src/schema.test.ts collector-go/internal/schema/schema.go collector-go/internal/schema/parity_test.go test-fixtures/collector-parity/expected.json
git commit -m "feat(schema): v9 - nullable dispatch usage columns via column-driven rebuild (Node + Go)"
```

---

### Task 5: Collector records real outcomes (ingest, median, stall sweep, memory gate)

**Files:**
- Modify: `collector/src/usageIngest.ts:31-84`, `collector/src/staleDispatchSweep.ts` (whole function body, `:15-17` constant), `collector/src/transcriptScan.ts:157-167`
- Test: `collector/src/usageIngest.test.ts` (add; update `:176-186`), `collector/src/staleDispatchSweep.test.ts` (update `:146-147`; add), `collector/src/transcriptScan.test.ts` (add to the memory-extraction describe near `:413`)

**Interfaces:**
- Consumes: from Task 3, `./severity/parseDispatchOutcome.js` (`parseDispatchOutcome`, `unrecognisedStatusTag`), `./severity/computeSeverity.js` (`computeSeverity`, `exitStateForStatus`), `./severity/baselineMath.js` (`medianOf`, `BASELINE_WINDOW`) and `./severity/isStalled.js` (`isStalled`, `STALL_MS`). From Task 4, nullable usage columns.
- Produces:
  - `interface DispatchIngestOptions { diag?: (line: string) => void; reportedStatusTags?: Set<string> }`. Task 8 adds `toolErrorsFor`.
  - `ingestDispatchEvent(db, history, event, options?: DispatchIngestOptions): boolean`
  - `medianDurationMsFor(db: DatabaseSync, agentId: string | null, excludeToolUseId: string): number | null`
  - `sweepStaleDispatches(db, history, nowMs): { staleFound: number }` (same signature; Task 8 adds a 4th param)

- [ ] **Step 1: Write the failing ingest tests** (append inside `collector/src/usageIngest.test.ts`. Reuse its `freshDb`, `openDispatch` and `completionEvent` helpers.)

```ts
describe('ingestDispatchEvent -- real outcomes (spec 2026-09-30 sections 3, 6, 7)', () => {
  function notify(toolUseId: string, endedAtMs: number, body: string) {
    return { ...completionEvent(toolUseId, endedAtMs), humanText: `<tool-use-id>${toolUseId}</tool-use-id>${body}` };
  }
  const quiet = () => ({ diag: () => {}, reportedStatusTags: new Set<string>() });

  it('failed -> exit_state error, severity 4, NULL usage columns', () => {
    const db = freshDb();
    expect(ingestDispatchEvent(db, openDispatch('tu_f', 1000), notify('tu_f', 9000, '<status>failed</status>'), quiet())).toBe(true);
    const row: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu_f');
    expect(row).toMatchObject({ exit_state: 'error', severity: 4, tokens: null, tool_uses: null, duration_ms: null });
    db.close();
  });

  it('killed -> exit_state killed, severity 2, NULL usage columns', () => {
    const db = freshDb();
    ingestDispatchEvent(db, openDispatch('tu_k', 1000), notify('tu_k', 9000, '<status>killed</status>'), quiet());
    const row: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu_k');
    expect(row).toMatchObject({ exit_state: 'killed', severity: 2, tokens: null, tool_uses: null, duration_ms: null });
    db.close();
  });

  it('unrecognised status -> ok/1 and exactly one diag line per unseen value', () => {
    const db = freshDb();
    const lines: string[] = [];
    const opts = { diag: (l: string) => lines.push(l), reportedStatusTags: new Set<string>() };
    ingestDispatchEvent(db, openDispatch('tu_r1', 1000), notify('tu_r1', 2000, '<status>running</status>'), opts);
    ingestDispatchEvent(db, openDispatch('tu_r2', 1000), notify('tu_r2', 2000, '<status>running</status>'), opts);
    const row: any = db.prepare('SELECT exit_state, severity FROM dispatches WHERE tool_use_id = ?').get('tu_r1');
    expect(row).toEqual({ exit_state: 'ok', severity: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('tag=running');
    db.close();
  });

  it('uses the collector history median: slow completion after 5 prior successes -> 2, median recorded', () => {
    const db = freshDb();
    const opts = quiet();
    const usage = (d: number) => `<status>completed</status><subagent_tokens>10</subagent_tokens><tool_uses>1</tool_uses><duration_ms>${d}</duration_ms>`;
    [1000, 1000, 1000, 1000, 1000].forEach((d, i) => {
      const id = `tu_p${i}`;
      ingestDispatchEvent(db, openDispatch(id, 100 * i), notify(id, 100 * i + 50, usage(d)), opts);
    });
    ingestDispatchEvent(db, openDispatch('tu_slow', 9000), notify('tu_slow', 99999, usage(3001)), opts);
    const row: any = db.prepare('SELECT severity, median_ms_at_eval FROM dispatches WHERE tool_use_id = ?').get('tu_slow');
    expect(row).toEqual({ severity: 2, median_ms_at_eval: 1000 });
    db.close();
  });

  it('the median query ignores duration_ms = 0 and NULL rows and non-ok rows', () => {
    const db = freshDb();
    const ins = db.prepare(`INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms, agent_id, task_kind, exit_state)
                            VALUES (?, 0, 0, ?, 0, ?, 'general-purpose', 'general-purpose', ?)`);
    for (let i = 0; i < 10; i++) ins.run(`z${i}`, 0, i, 'ok');
    for (let i = 0; i < 4; i++) ins.run(`g${i}`, 500, 100 + i, 'ok');
    ins.run('e0', 99999, 200, 'error');
    expect(medianDurationMsFor(db, 'general-purpose', 'none')).toBeNull();
    ins.run('g4', 500, 300, 'ok');
    expect(medianDurationMsFor(db, 'general-purpose', 'none')).toBe(500);
    expect(medianDurationMsFor(db, null, 'none')).toBeNull();
    db.close();
  });

  it('a late completion replaces a fatal (stalled) row', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms, exit_state, severity)
                VALUES ('tu_late', NULL, NULL, 1800001, 1000, 1801001, 'fatal', 4)`).run();
    ingestDispatchEvent(db, openDispatch('tu_late', 1000), notify('tu_late', 1900000, '<status>completed</status><subagent_tokens>5</subagent_tokens><tool_uses>2</tool_uses><duration_ms>1899000</duration_ms>'), quiet());
    const row: any = db.prepare('SELECT exit_state, severity, duration_ms FROM dispatches WHERE tool_use_id = ?').get('tu_late');
    expect(row).toEqual({ exit_state: 'ok', severity: 1, duration_ms: 1899000 });
    db.close();
  });
});
```
Add `medianDurationMsFor` to the file's `./usageIngest.js` import. **Update** the existing test at `:176-186` ("defaults missing numeric tags to 0 rather than failing"). Rename it to `'stores NULL usage columns when the notification carries no usage tags'`, and change its three `.toBe(0)` assertions to `.toBeNull()`. List this in the report.

- [ ] **Step 2: Run it and see it fail**

Run (from `collector/`): `npx vitest run src/usageIngest.test.ts`
Expected: FAIL. `medianDurationMsFor` is not exported, failed rows are `ok`/1, and usage columns are 0.

- [ ] **Step 3: Implement in `collector/src/usageIngest.ts`**

Replace the import on line 4 with:
```ts
import { parseDispatchOutcome, unrecognisedStatusTag } from './severity/parseDispatchOutcome.js';
import { computeSeverity, exitStateForStatus } from './severity/computeSeverity.js';
import { medianOf, BASELINE_WINDOW } from './severity/baselineMath.js';
```
Add these above `ingestDispatchEvent`:
```ts
export interface DispatchIngestOptions {
  diag?: (line: string) => void;
  reportedStatusTags?: Set<string>;
}

const reportedStatusTagsForProcess = new Set<string>();

// Spec section 6: median of this agent type's own successful history, the
// same rules as the live baseline (ok rows, duration_ms > 0, last 20,
// minimum 5). duration_ms > 0 also skips NULL and the historic failures that
// were stored as ok with 0 ms. The row being ingested is excluded, so a
// re-ingest never compares a run against itself.
export function medianDurationMsFor(db: DatabaseSync, agentId: string | null, excludeToolUseId: string): number | null {
  if (agentId === null) return null;
  const rows = db
    .prepare(
      `SELECT duration_ms FROM dispatches
        WHERE agent_id = ? AND exit_state = 'ok' AND duration_ms > 0 AND tool_use_id != ?
        ORDER BY ended_at_ms DESC LIMIT ?`,
    )
    .all(agentId, excludeToolUseId, BASELINE_WINDOW) as { duration_ms: number }[];
  return medianOf(rows.map((r) => r.duration_ms).reverse());
}
```
Change the signature to `export function ingestDispatchEvent(db: DatabaseSync, history: ToolCallHistory, event: TranscriptEvent, options: DispatchIngestOptions = {}): boolean`. Replace lines 55-68 (the three regexes through the `computeSeverity` call) with:
```ts
  const outcome = parseDispatchOutcome(content);
  if (outcome.status === 'unknown') {
    const tag = unrecognisedStatusTag(content);
    const seen = options.reportedStatusTags ?? reportedStatusTagsForProcess;
    if (tag !== null && !seen.has(tag)) {
      seen.add(tag);
      (options.diag ?? ((l: string) => console.error(l)))(
        `[aether-collector] [diag] dispatch status not recognised tag=${tag}; stored as ok`,
      );
    }
  }
  const endedAtMs = event.timestamp.getTime();
  const result = computeSeverity({
    exit: exitStateForStatus(outcome.status),
    elapsedMs: outcome.usage?.durationMs ?? 0,
    medianMsAtEval: medianDurationMsFor(db, open.subagentType, dispatchToolUseId),
  });
```
In the `.run(...)` on lines 79-82, pass `outcome.usage?.tokens ?? null, outcome.usage?.toolUses ?? null, outcome.usage?.durationMs ?? null` for the three usage values, and `result.exitState, result.severity, result.medianMs` for the last three. Update the comment block at `:31-40` so its last sentence reads "...the token/tool-use/duration values are real, not estimated, and are NULL when the notification carries no usage block (failed/killed). The status comes from `<status>` via parseDispatchOutcome."

- [ ] **Step 4: Run it and see it pass**

Run (from `collector/`): `npx vitest run src/usageIngest.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing sweep and memory-gate tests**

In `collector/src/staleDispatchSweep.test.ts`, change `:146-147` to `expect(row.tokens).toBeNull();` / `expect(row.tool_uses).toBeNull();` (list it in the report), and append:
```ts
  it('stall boundary: exactly STALL_MS of inactivity is not stalled, one ms more is', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO fleet_sessions (session_id, pid, project_name, kind, status, name, started_at_ms, last_seen_ms)
       VALUES ('s1', NULL, 'proj', 'agent', 'running', 'agent', 0, ?)`
    ).run(THIRTY_MIN);
    expect(sweepStaleDispatches(db, historyWithOpen('tu_b', { startedAt: 0 }), THIRTY_MIN).staleFound).toBe(0);
    db.prepare("UPDATE fleet_sessions SET last_seen_ms = ? WHERE session_id = 's1'").run(THIRTY_MIN + 1);
    expect(sweepStaleDispatches(db, historyWithOpen('tu_b', { startedAt: 0 }), THIRTY_MIN + 1).staleFound).toBe(1);
    db.close();
  });
```
In `collector/src/transcriptScan.test.ts`, inside `describe('scanTranscriptsOnce -- memory extraction queueing'`, add a test. The existing `taskNotificationLine` has no `<status>`, so build the line inline:
```ts
  it('does not queue failed or killed dispatches, even substantive ones with usage', () => {
    for (const status of ['failed', 'killed']) {
      const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-mem-projects-'));
      const projDir = join(projectsRoot, 'my-project');
      mkdirSync(projDir);
      const content =
        '<task-notification>\n<tool-use-id>tu_x</tool-use-id>\n' +
        `<status>${status}</status>\n<result>Did a lot of work.</result>\n` +
        '<subagent_tokens>100</subagent_tokens>\n<tool_uses>9</tool_uses>\n<duration_ms>90000</duration_ms>\n</task-notification>';
      const notification = JSON.stringify({ type: 'user', sessionId: 's1', timestamp: '2026-07-08T09:01:30Z', origin: { kind: 'task-notification' }, message: { content } });
      writeFileSync(join(projDir, 'session.jsonl'), `${agentToolUseLine('tu_x', '2026-07-08T09:00:00Z')}\n${notification}\n`, 'utf8');
      const db = freshDb();
      const queue = createMemoryExtractQueue();
      scanTranscriptsOnce(db, projectsRoot, 2000, new Map(), queue);
      expect(queue.size()).toBe(0);
      db.close();
    }
  });
```

Run (from `collector/`): `npx vitest run src/staleDispatchSweep.test.ts src/transcriptScan.test.ts`
Expected: the sweep FAILS (tokens are 0, not NULL), and the boundary test FAILS on its first expectation (the old rule was `ageMs >= 30 min`, so exactly 30 min was already fatal; the spec says "longer than"). Record this behaviour change in the report. The memory-gate test PASSES once Step 3 is in, because the gate already reads `exit_state !== 'ok'`. That is expected; the test is a regression pin for spec §10 "the memory gate skips them". To see it fail, temporarily revert Step 3's `exit` argument to `'ok'`, run it, confirm FAIL, restore it, and record the red run in the report.

- [ ] **Step 6: Implement the sweep and the NULL-safe memory gate**

`collector/src/staleDispatchSweep.ts`. Add `import { isStalled } from './severity/isStalled.js';` and delete `FATAL_TIMEOUT_MS` (lines 15-17). Rewrite the doc comment's "(b)" line to: "(b) no progress for longer than STALL_MS (./severity/isStalled.js, 30 min), measured from the entry's start". Replace lines 76-85 with:
```ts
    const ageMs = nowMs - open.startedAt;

    let sessionEnded = false;
    if (ageMs >= SESSION_CHECK_MIN_AGE_MS) {
      const row = sessionLookup.get(open.sessionId) as { last_seen_ms: number } | undefined;
      sessionEnded = !row || nowMs - row.last_seen_ms > SESSION_STALE_MS;
    }

    if (!isStalled({ lastProgressMs: open.startedAt, sessionEnded }, nowMs)) continue;
```
In `upsert.run(...)` (line 95-98), change the second and third arguments from `0, 0` to `null, null`.

`collector/src/transcriptScan.ts:162`: change the row type to `duration_ms: number | null; tool_uses: number | null;`. After line 165 (`if (row.exit_state !== 'ok') continue;`), add:
```ts
          if (row.duration_ms === null || row.tool_uses === null) continue;
```

- [ ] **Step 7: Verify**

Run (from `collector/`): `npx vitest run` then `npx tsc -p tsconfig.json --noEmit`.
Expected: 0 failures, tsc exit 0. List every pre-existing test you changed.

- [ ] **Step 8: Commit**

```bash
git add collector/src/usageIngest.ts collector/src/usageIngest.test.ts collector/src/staleDispatchSweep.ts collector/src/staleDispatchSweep.test.ts collector/src/transcriptScan.ts collector/src/transcriptScan.test.ts
git commit -m "feat(collector): record real dispatch outcomes - failed/killed exit states, NULL usage, history median, shared isStalled"
```

---

### Task 6: Persisted duration baseline (live)

**Files:**
- Create: `electron/severity/durationBaseline.ts`
- Test: `electron/severity/durationBaseline.test.ts`

**Interfaces:**
- Consumes: from Task 2, `BASELINE_WINDOW`, `isAdmissibleSample`, `medianOf` (`./baselineMath`) and `DispatchOutcome` (`./parseDispatchOutcome`). `writeFileAtomically(targetPath: string, content: string): Promise<void>` from `electron/atomicWrite.ts:104`.
- Produces:
  - `DURATION_BASELINE_FILE = 'duration-baseline.json'`
  - `interface DurationBaselineStore { medianFor(key: string): number | null; record(key: string, outcome: DispatchOutcome): boolean; flush(): Promise<void> }`
  - `interface DurationBaselineOptions { filePath: string; diag: (line: string) => void; writeFile?: (path: string, content: string) => Promise<void>; readFile?: (path: string) => string }`
  - `loadDurationBaseline(opts: DurationBaselineOptions): DurationBaselineStore`
  - The file format is `{"version":1,"samples":{"<subagentType>":[<ms>, ...]}}`, holding numbers only.

- [ ] **Step 1: Write the failing test** `electron/severity/durationBaseline.test.ts`

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadDurationBaseline, DURATION_BASELINE_FILE } from './durationBaseline';

const done = (d: number) => ({ status: 'completed' as const, usage: { tokens: 1, toolUses: 1, durationMs: d } });
function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'aether-baseline-')), DURATION_BASELINE_FILE);
}

describe('loadDurationBaseline', () => {
  it('a missing file starts empty with no diag', () => {
    const diag: string[] = [];
    const b = loadDurationBaseline({ filePath: tempFile(), diag: (l) => diag.push(l) });
    expect(b.medianFor('x')).toBeNull();
    expect(diag).toEqual([]);
  });

  it('5-sample minimum', () => {
    const b = loadDurationBaseline({ filePath: tempFile(), diag: () => {}, writeFile: async () => {} });
    [100, 200, 300, 400].forEach((d) => b.record('x', done(d)));
    expect(b.medianFor('x')).toBeNull();
    b.record('x', done(500));
    expect(b.medianFor('x')).toBe(300);
  });

  it('20-sample window', () => {
    const b = loadDurationBaseline({ filePath: tempFile(), diag: () => {}, writeFile: async () => {} });
    for (let i = 0; i < 20; i++) b.record('x', done(1_000_000));
    for (let i = 0; i < 20; i++) b.record('x', done(10));
    expect(b.medianFor('x')).toBe(10);
  });

  it('rejects failed, killed, unknown, usage-less and zero-duration outcomes', () => {
    const b = loadDurationBaseline({ filePath: tempFile(), diag: () => {}, writeFile: async () => {} });
    const usage = { tokens: 1, toolUses: 1, durationMs: 5000 };
    expect(b.record('x', { status: 'failed', usage })).toBe(false);
    expect(b.record('x', { status: 'killed', usage })).toBe(false);
    expect(b.record('x', { status: 'unknown', usage })).toBe(false);
    expect(b.record('x', { status: 'completed' })).toBe(false);
    expect(b.record('x', done(0))).toBe(false);
    for (let i = 0; i < 5; i++) b.record('x', done(7));
    expect(b.medianFor('x')).toBe(7);
  });

  it('persistence round-trip through the real atomic writer; file holds numbers only', async () => {
    const filePath = tempFile();
    const a = loadDurationBaseline({ filePath, diag: () => {} });
    [10, 20, 30, 40, 50].forEach((d) => a.record('code-reviewer', done(d)));
    await a.flush();
    const json = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(json).toEqual({ version: 1, samples: { 'code-reviewer': [10, 20, 30, 40, 50] } });
    const b = loadDurationBaseline({ filePath, diag: () => {} });
    expect(b.medianFor('code-reviewer')).toBe(30);
  });

  it('a corrupt file starts empty with exactly one diag line', () => {
    const filePath = tempFile();
    writeFileSync(filePath, '{not json', 'utf8');
    const diag: string[] = [];
    const b = loadDurationBaseline({ filePath, diag: (l) => diag.push(l), writeFile: async () => {} });
    expect(b.medianFor('x')).toBeNull();
    expect(diag).toHaveLength(1);
    expect(diag[0]).toMatch(/^\[diag\] duration-baseline corrupt/);
  });

  // Review Focus 4
  it('wrong-shape JSON starts empty, one diag, never NaN', () => {
    for (const bad of ['[]', 'null', '42', '{"version":2,"samples":{}}', '{"version":1,"samples":{"x":["a",-1,null]}}', '{"version":1,"samples":[]}']) {
      const filePath = tempFile();
      writeFileSync(filePath, bad, 'utf8');
      const diag: string[] = [];
      const b = loadDurationBaseline({ filePath, diag: (l) => diag.push(l), writeFile: async () => {} });
      expect(b.medianFor('x')).toBeNull();
      expect(diag).toHaveLength(1);
      for (let i = 0; i < 5; i++) b.record('x', done(9));
      expect(b.medianFor('x')).toBe(9);
    }
  });

  it('an unreadable file (non-ENOENT read error) starts empty with one diag', () => {
    const diag: string[] = [];
    const b = loadDurationBaseline({
      filePath: 'irrelevant',
      diag: (l) => diag.push(l),
      readFile: () => { const e: NodeJS.ErrnoException = new Error('EACCES'); e.code = 'EACCES'; throw e; },
      writeFile: async () => {},
    });
    expect(b.medianFor('x')).toBeNull();
    expect(diag).toHaveLength(1);
    expect(diag[0]).toContain('code=EACCES');
  });

  it('a failed write is reported through diag and never rejects flush()', async () => {
    const diag: string[] = [];
    const b = loadDurationBaseline({ filePath: tempFile(), diag: (l) => diag.push(l), writeFile: async () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); } });
    b.record('x', done(5));
    await expect(b.flush()).resolves.toBeUndefined();
    expect(diag.some((l) => l.includes('write failed code=EPERM'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run electron/severity/durationBaseline.test.ts`
Expected: FAIL, unresolved import `./durationBaseline`.

- [ ] **Step 3: Implement** `electron/severity/durationBaseline.ts`

```ts
// electron/severity/durationBaseline.ts
// Per-subagentType duration baseline for live narration, persisted to
// ~/.aether-os/duration-baseline.json (spec 2026-09-30-real-severity-design.md
// section 6). Replaces electron/durationBaseline.ts, which was in-memory,
// lost everything on restart and had no minimum. Holds numbers only, keyed by
// agent type. Written through atomicWrite.ts so it inherits the #99
// user-only directory ACL. A corrupt or unreadable file starts empty with
// one [diag] line; a missing file is just a first run.
import { readFileSync } from 'node:fs';
import { writeFileAtomically } from '../atomicWrite';
import { BASELINE_WINDOW, isAdmissibleSample, medianOf } from './baselineMath';
import type { DispatchOutcome } from './parseDispatchOutcome';

export const DURATION_BASELINE_FILE = 'duration-baseline.json';
const FILE_VERSION = 1;

export interface DurationBaselineStore {
  medianFor(key: string): number | null;
  record(key: string, outcome: DispatchOutcome): boolean;
  flush(): Promise<void>;
}

export interface DurationBaselineOptions {
  filePath: string;
  diag: (line: string) => void;
  writeFile?: (path: string, content: string) => Promise<void>;
  readFile?: (path: string) => string;
}

function parseSamples(raw: string): Map<string, number[]> | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const { version, samples } = json as { version?: unknown; samples?: unknown };
  if (version !== FILE_VERSION || !samples || typeof samples !== 'object' || Array.isArray(samples)) return null;
  const out = new Map<string, number[]>();
  for (const [key, value] of Object.entries(samples as Record<string, unknown>)) {
    if (!Array.isArray(value)) return null;
    if (!value.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) return null;
    out.set(key, (value as number[]).slice(-BASELINE_WINDOW));
  }
  return out;
}

function errCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

export function loadDurationBaseline(opts: DurationBaselineOptions): DurationBaselineStore {
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const writeFile = opts.writeFile ?? writeFileAtomically;
  let samples = new Map<string, number[]>();

  let raw: string | null = null;
  try {
    raw = readFile(opts.filePath);
  } catch (err) {
    if (errCode(err) !== 'ENOENT') {
      opts.diag(`[diag] duration-baseline unreadable, starting empty code=${errCode(err)} at=${new Date().toISOString()}`);
    }
  }
  if (raw !== null) {
    const parsed = parseSamples(raw);
    if (parsed) samples = parsed;
    else opts.diag(`[diag] duration-baseline corrupt, starting empty at=${new Date().toISOString()}`);
  }

  let pending: Promise<void> = Promise.resolve();
  function persist(): void {
    const content = JSON.stringify({ version: FILE_VERSION, samples: Object.fromEntries(samples) });
    pending = pending
      .then(() => writeFile(opts.filePath, content))
      .catch((err) => {
        opts.diag(`[diag] duration-baseline write failed code=${errCode(err)} at=${new Date().toISOString()}`);
      });
  }

  return {
    medianFor(key) {
      return medianOf(samples.get(key) ?? []);
    },
    record(key, outcome) {
      const durationMs = outcome.usage?.durationMs;
      if (!isAdmissibleSample(outcome) || durationMs === undefined) return false;
      samples.set(key, [...(samples.get(key) ?? []), durationMs].slice(-BASELINE_WINDOW));
      persist();
      return true;
    },
    flush() {
      return pending;
    },
  };
}
```

- [ ] **Step 4: Run it and see it pass; typecheck**

Run: `npx vitest run electron/severity/durationBaseline.test.ts` then `npm run typecheck:electron`
Expected: PASS (9 tests). Exit 0.

- [ ] **Step 5: Byte-check and commit**

Run: `LC_ALL=C grep -n '[^[:print:][:space:]]' electron/severity/durationBaseline.ts electron/severity/durationBaseline.test.ts` -> no output.
```bash
git add electron/severity/durationBaseline.ts electron/severity/durationBaseline.test.ts
git commit -m "feat(severity): persisted per-agent duration baseline (min 5, window 20, atomic write)"
```

---

### Task 7: Live path: real outcomes, stall detection and recovery in narration

**Files:**
- Create: `electron/severity/liveSeverity.ts`, `electron/severity/liveSeverity.test.ts`
- Modify: `src/state/liveAgentsMath.ts:24-71` (optional 4th param + completedOut numbers from the parser), `electron/liveAgentTracker.ts:16-22,95-96,119` (`outcomes`), `electron/narrationGenerator.ts` (whole file), `electron/main.ts` (imports `:52-53`, `:126`, `:653`, the loop `:739-766`, pty sites `:1185,1187,1219-1222,1226`)
- Delete: `electron/durationBaseline.ts`, `electron/durationBaseline.test.ts`
- Modify tests: `electron/narrationGenerator.test.ts` (rewrite), `electron/main.narration.test.ts` (rewrite), `src/state/liveAgentsMath.test.ts` (add)

**Interfaces:**
- Consumes: Task 2 (`parseDispatchOutcome`, `unrecognisedStatusTag`, `DispatchOutcome`, `computeSeverity`, `exitStateForStatus`, `Severity`, `isStalled`) and Task 6 (`loadDurationBaseline`, `DURATION_BASELINE_FILE`, `DurationBaselineStore`).
- Produces:
  - `src/state/liveAgentsMath.ts`: `export interface TrackedOutcome { outcome: DispatchOutcome; unknownStatusTag: string | null }`, and `applyLinesToOpenDispatches(currentOpen, events, completedOut?, outcomesOut?: Map<string, TrackedOutcome>)`. `CompletedDispatchUsage` is **unchanged**, so the renderer and IPC shape are unchanged.
  - `electron/liveAgentTracker.ts`: `LiveAgentTick.outcomes?: ReadonlyMap<string, TrackedOutcome>` (optional, so the `recapAccumulator` tests are untouched).
  - `electron/narrationGenerator.ts`: `formatNarration(dispatch: { subagentType: string }, severity: Severity): NarrationResult | null`. `computeNarrationSeverity` is deleted.
  - `electron/severity/liveSeverity.ts`: `STALL_CHECK_INTERVAL_MS = 30_000`, `RECOVERED_PREFIX = 'Recovered. '`, `interface LiveNarrationPayload { toolUseId: string; narration: string; severity: Severity }`, `interface LiveSeverityDeps { baseline: Pick<DurationBaselineStore, 'medianFor' | 'record'>; narrate: (subagentType: string, severity: Severity) => string | null }`, `createLiveSeverityNarrator(deps): LiveSeverityNarrator` with `onCompleted(c: CompletedDispatchUsage, tracked: TrackedOutcome | undefined): LiveNarrationPayload | null` and `checkStalls(open: readonly RealAgentDispatch[], nowMs: number, sessionEnded: boolean): LiveNarrationPayload[]`. **Call order contract:** in a tick, call `onCompleted` for every completion BEFORE `checkStalls`.

- [ ] **Step 1: Write the failing tests**

`electron/severity/liveSeverity.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createLiveSeverityNarrator, RECOVERED_PREFIX, STALL_CHECK_INTERVAL_MS } from './liveSeverity';
import { STALL_MS } from './isStalled';
import { formatNarration } from '../narrationGenerator';
import { parseTranscriptLine, type TranscriptEvent } from '../transcriptParser';
import { applyLinesToOpenDispatches, type CompletedDispatchUsage, type RealAgentDispatch, type TrackedOutcome } from '../../src/state/liveAgentsMath';
import type { DispatchOutcome } from './parseDispatchOutcome';

function fakeBaseline(median: number | null = null) {
  const recorded: DispatchOutcome[] = [];
  return { recorded, medianFor: () => median, record: (_k: string, o: DispatchOutcome) => { recorded.push(o); return true; } };
}
const narrate = (t: string, s: 0 | 1 | 2 | 3 | 4) => formatNarration({ subagentType: t }, s)?.narration ?? null;
const T0 = Date.parse('2026-09-30T10:00:00.000Z');
function open(id: string, startedAt = new Date(T0).toISOString(), subagentType = 'code-reviewer'): RealAgentDispatch {
  return { toolUseId: id, subagentType, description: '', startedAt, prompt: '', model: null };
}
function completed(id: string, subagentType = 'code-reviewer'): CompletedDispatchUsage {
  return { ...open(id, new Date(T0).toISOString(), subagentType), tokens: 0, toolUses: 0, durationMs: 0 };
}
const tracked = (status: DispatchOutcome['status'], durationMs?: number): TrackedOutcome => ({
  outcome: durationMs === undefined ? { status } : { status, usage: { tokens: 1, toolUses: 1, durationMs } },
  unknownStatusTag: null,
});

describe('live severity: integration from transcript lines', () => {
  function line(obj: unknown): TranscriptEvent {
    return parseTranscriptLine(JSON.stringify(obj))!;
  }
  it('a failed notification reaches narration as severity 4 (it arrived as 1 before this change)', () => {
    const events = [
      line({ type: 'assistant', timestamp: '2026-09-30T10:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'tu_f', name: 'Agent', input: { subagent_type: 'code-reviewer' } }] } }),
      line({ type: 'user', timestamp: '2026-09-30T10:03:00.000Z', origin: { kind: 'task-notification' }, message: { content: '<task-notification><tool-use-id>tu_f</tool-use-id><status>failed</status><summary>x</summary></task-notification>' } }),
    ];
    const done: CompletedDispatchUsage[] = [];
    const outcomes = new Map<string, TrackedOutcome>();
    applyLinesToOpenDispatches([], events, done, outcomes);
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    const payload = n.onCompleted(done[0], outcomes.get('tu_f'));
    expect(payload).toEqual({ toolUseId: 'tu_f', severity: 4, narration: formatNarration({ subagentType: 'code-reviewer' }, 4)!.narration });
  });
});

describe('createLiveSeverityNarrator', () => {
  it('check interval is ~30 s', () => {
    expect(STALL_CHECK_INTERVAL_MS).toBe(30_000);
  });

  it('killed -> 2, unknown/missing outcome -> 1, slow -> 2 with the snapshot taken before recording', () => {
    const b = fakeBaseline(1000);
    const n = createLiveSeverityNarrator({ baseline: b, narrate });
    expect(n.onCompleted(completed('a'), tracked('killed'))!.severity).toBe(2);
    expect(n.onCompleted(completed('b'), undefined)!.severity).toBe(1);
    expect(n.onCompleted(completed('c'), tracked('completed', 3001))!.severity).toBe(2);
    expect(b.recorded.map((o) => o.status)).toEqual(['killed', 'unknown', 'completed']);
  });

  it('a stall fires exactly once across ticks, as severity 4', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    const d = [open('s')];
    expect(n.checkStalls(d, T0 + STALL_MS, false)).toEqual([]);
    const first = n.checkStalls(d, T0 + STALL_MS + 1, false);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ toolUseId: 's', severity: 4 });
    expect(n.checkStalls(d, T0 + STALL_MS + 30_000, false)).toEqual([]);
    expect(n.checkStalls(d, T0 + 5 * STALL_MS, true)).toEqual([]);
  });

  it('an ended session stalls every open dispatch once', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    const out = n.checkStalls([open('x'), open('y')], T0 + 1000, true);
    expect(out.map((p) => p.toolUseId).sort()).toEqual(['x', 'y']);
  });

  it('a late completion replaces the stall and emits one "Recovered" line', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    n.checkStalls([open('r')], T0 + STALL_MS + 1, false);
    const p = n.onCompleted(completed('r'), tracked('completed', 5000))!;
    expect(p.severity).toBe(1);
    expect(p.narration.startsWith(RECOVERED_PREFIX)).toBe(true);
    const again = n.onCompleted(completed('r'), tracked('completed', 5000));
    expect(again === null || !again.narration.startsWith(RECOVERED_PREFIX)).toBe(true);
  });

  it('a recovered FORGE dispatch at severity 1 (no sample) still gets the single Recovered line', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    n.checkStalls([open('g', new Date(T0).toISOString(), 'general-purpose')], T0 + STALL_MS + 1, false);
    expect(n.onCompleted(completed('g', 'general-purpose'), tracked('completed', 5000))).toEqual({ toolUseId: 'g', narration: 'Recovered.', severity: 1 });
  });

  // Review Focus 5
  it('completion before the stall check: narrated once from the real outcome, never as a stall', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    const p = n.onCompleted(completed('q'), tracked('failed'))!;
    expect(p.severity).toBe(4);
    expect(p.narration.startsWith(RECOVERED_PREFIX)).toBe(false);
    expect(n.checkStalls([], T0 + 10 * STALL_MS, true)).toEqual([]);
  });

  // Review Focus 2
  it('epoch startedAt is measured from first sight, not from 1970', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    const d = [open('e', new Date(0).toISOString())];
    expect(n.checkStalls(d, T0, false)).toEqual([]);
    expect(n.checkStalls(d, T0 + STALL_MS, false)).toEqual([]);
    expect(n.checkStalls(d, T0 + STALL_MS + 1, false)).toHaveLength(1);
  });

  it('payloads carry only toolUseId, narration, severity', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    const p = n.onCompleted(completed('k'), tracked('failed'))!;
    expect(Object.keys(p).sort()).toEqual(['narration', 'severity', 'toolUseId']);
  });
});
```

Rewrite `electron/narrationGenerator.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { formatNarration } from './narrationGenerator';

describe('formatNarration (render only; severity comes from electron/severity/computeSeverity)', () => {
  it('renders the role sample for the given severity', () => {
    expect(formatNarration({ subagentType: 'code-reviewer' }, 1)).toEqual({ narration: "It compiles. I'm thrilled.", severity: 1 });
    expect(formatNarration({ subagentType: 'code-reviewer' }, 2)).toEqual({ narration: "There's a retry loop in here. I'll assume that was deliberate.", severity: 2 });
  });
  it('returns null for FORGE at severity 1 (silent heartbeat)', () => {
    expect(formatNarration({ subagentType: 'general-purpose' }, 1)).toBeNull();
  });
  it('passes severity 4 through (the old local copy capped at 2)', () => {
    expect(formatNarration({ subagentType: 'code-reviewer' }, 4)?.severity).toBe(4);
  });
});
```

Rewrite `electron/main.narration.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { formatNarration } from './narrationGenerator';
import { createLiveSeverityNarrator } from './severity/liveSeverity';

// Pins the exact call shapes main.ts's tick loop uses. Durations are wall
// clock from the notification's own <duration_ms>; see
// docs/superpowers/specs/2026-09-16-user-wait-subtraction-removal.md before
// changing that.
describe('main.ts narration wiring shape', () => {
  it('formatNarration(dispatch, severity) -> {narration, severity} | null', () => {
    const r = formatNarration({ subagentType: 'code-reviewer' }, 1);
    expect(r === null || (typeof r.narration === 'string' && r.severity === 1)).toBe(true);
  });
  it('narrator exposes onCompleted(c, tracked) and checkStalls(open, nowMs, sessionEnded)', () => {
    const n = createLiveSeverityNarrator({ baseline: { medianFor: () => null, record: () => false }, narrate: () => 'x' });
    expect(typeof n.onCompleted).toBe('function');
    expect(n.checkStalls([], Date.now(), false)).toEqual([]);
  });
});
```

Append to `src/state/liveAgentsMath.test.ts` (it already has `dispatchLine`, `completionLine` and `completionLineWithUsage`):
```ts
describe('applyLinesToOpenDispatches -- outcomesOut', () => {
  it('records the parsed outcome per completed dispatch, with a diag tag only for unknown statuses', () => {
    const open = applyLinesToOpenDispatches([], [dispatchLine('tu_1', 'general-purpose', 'd', '2026-07-20T10:00:00.000Z'), dispatchLine('tu_2', 'general-purpose', 'd', '2026-07-20T10:00:00.000Z')]);
    const outcomes = new Map();
    applyLinesToOpenDispatches(open, [completionLine('tu_1', 'failed'), completionLineWithUsage('tu_2', 5, 2, 900, 'running')], [], outcomes);
    expect(outcomes.get('tu_1')).toEqual({ outcome: { status: 'failed' }, unknownStatusTag: null });
    expect(outcomes.get('tu_2')).toEqual({ outcome: { status: 'unknown', usage: { tokens: 5, toolUses: 2, durationMs: 900 } }, unknownStatusTag: 'running' });
  });
});
```
The existing `dispatchLine` helper's parameter order must match its definition in that file. Check it before running.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run electron/severity/liveSeverity.test.ts electron/narrationGenerator.test.ts electron/main.narration.test.ts src/state/liveAgentsMath.test.ts`
Expected: FAIL. `liveSeverity` is unresolved, `formatNarration` returns sev 1/2 for input 4 (the old signature takes `durationMs`), and `outcomesOut` is ignored.

- [ ] **Step 3: Implement `liveAgentsMath` and `liveAgentTracker`**

`src/state/liveAgentsMath.ts`. Add at the top:
```ts
import { parseDispatchOutcome, unrecognisedStatusTag, type DispatchOutcome } from '../../electron/severity/parseDispatchOutcome';

export interface TrackedOutcome {
  outcome: DispatchOutcome;
  /** Set only when outcome.status is 'unknown': a sanitised tag for the one-per-value [diag] line. */
  unknownStatusTag: string | null;
}
```
Change the signature to add `outcomesOut?: Map<string, TrackedOutcome>`. Replace the body of `if (match) { ... }` (lines 52-66) with:
```ts
      if (match) {
        const dispatch = open.get(match[1]);
        if (dispatch) {
          const outcome = parseDispatchOutcome(content);
          if (completedOut) {
            // Renderer/Ledger contract unchanged: a missing usage block still
            // reads as zeros HERE (LedgerView's dispatchUsage). Severity never
            // uses these zeros; it reads `outcome` via outcomesOut.
            completedOut.push({
              ...dispatch,
              tokens: outcome.usage?.tokens ?? 0,
              toolUses: outcome.usage?.toolUses ?? 0,
              durationMs: outcome.usage?.durationMs ?? 0,
            });
          }
          outcomesOut?.set(dispatch.toolUseId, {
            outcome,
            unknownStatusTag: outcome.status === 'unknown' ? unrecognisedStatusTag(content) : null,
          });
        }
        open.delete(match[1]);
      }
```
`electron/liveAgentTracker.ts`. Import `type TrackedOutcome` alongside the other `liveAgentsMath` imports. Add `outcomes?: ReadonlyMap<string, TrackedOutcome>;` to `LiveAgentTick`. At line 95-96 use:
```ts
      const completed: CompletedDispatchUsage[] = [];
      const outcomes = new Map<string, TrackedOutcome>();
      currentOpen = applyLinesToOpenDispatches(currentOpen, events, completed, outcomes);
```
and return `{ open: currentOpen, completed, outcomes, work: currentWork, anomalies, cacheHitRatio }` at line 119.

- [ ] **Step 4: Implement `narrationGenerator` and `liveSeverity`**

Replace `electron/narrationGenerator.ts` entirely:
```ts
// electron/narrationGenerator.ts
// Pure, deterministic -- no model call, no I/O, cannot fail (same shape as
// headlineGenerator.ts's formatHeadline(), for the same "Aether should not
// cost a user money" reason -- see docs/roadmap.md's Stage 11.5 addendum).
// Render only: severity is computed by electron/severity/computeSeverity.ts
// (via electron/severity/liveSeverity.ts) and passed in. The local severity
// copy that lived here could only produce 1 or 2 and was deleted by
// docs/superpowers/specs/2026-09-30-real-severity-design.md section 4.
import { resolveVoiceRole } from '../src/shared/agentVoiceRoles';
import { VOICE_PACKS, type Severity } from '../src/shared/voicePacks';
import { renderNarration } from '../src/shared/voiceRender';

export interface NarrationResult {
  narration: string;
  severity: Severity;
}

export function formatNarration(dispatch: { subagentType: string }, severity: Severity): NarrationResult | null {
  const pack = VOICE_PACKS[resolveVoiceRole(dispatch.subagentType)];
  const narration = renderNarration(pack, severity, null);
  return narration ? { narration, severity } : null;
}
```

Create `electron/severity/liveSeverity.ts`:
```ts
// electron/severity/liveSeverity.ts
// Live severity for the pinned session's dispatches (spec
// 2026-09-30-real-severity-design.md sections 4 and 5). Completion: real
// outcome -> computeSeverity with the baseline snapshot taken BEFORE this run
// is recorded. Stall: no progress past STALL_MS or the pinned pty exited ->
// fatal/4 exactly once. A later real completion replaces the stall and emits
// one "Recovered." line.
// Call order per tick: onCompleted for every completion, THEN checkStalls.
import type { CompletedDispatchUsage, RealAgentDispatch, TrackedOutcome } from '../../src/state/liveAgentsMath';
import { computeSeverity, exitStateForStatus, type Severity } from './computeSeverity';
import { isStalled } from './isStalled';
import type { DurationBaselineStore } from './durationBaseline';

export const STALL_CHECK_INTERVAL_MS = 30_000;
export const RECOVERED_PREFIX = 'Recovered. ';

export interface LiveNarrationPayload {
  toolUseId: string;
  narration: string;
  severity: Severity;
}

export interface LiveSeverityDeps {
  baseline: Pick<DurationBaselineStore, 'medianFor' | 'record'>;
  narrate: (subagentType: string, severity: Severity) => string | null;
}

export interface LiveSeverityNarrator {
  onCompleted(completed: CompletedDispatchUsage, tracked: TrackedOutcome | undefined): LiveNarrationPayload | null;
  checkStalls(open: readonly RealAgentDispatch[], nowMs: number, sessionEnded: boolean): LiveNarrationPayload[];
}

export function createLiveSeverityNarrator(deps: LiveSeverityDeps): LiveSeverityNarrator {
  const stalled = new Set<string>();
  const firstSeenMs = new Map<string, number>();

  return {
    onCompleted(c, tracked) {
      const outcome = tracked?.outcome ?? { status: 'unknown' as const };
      const medianMsAtEval = deps.baseline.medianFor(c.subagentType);
      const result = computeSeverity({
        exit: exitStateForStatus(outcome.status),
        elapsedMs: outcome.usage?.durationMs ?? 0,
        medianMsAtEval,
      });
      deps.baseline.record(c.subagentType, outcome);
      firstSeenMs.delete(c.toolUseId);
      const wasStalled = stalled.delete(c.toolUseId);
      const text = deps.narrate(c.subagentType, result.severity);
      if (wasStalled) {
        return { toolUseId: c.toolUseId, narration: text ? `${RECOVERED_PREFIX}${text}` : RECOVERED_PREFIX.trim(), severity: result.severity };
      }
      return text ? { toolUseId: c.toolUseId, narration: text, severity: result.severity } : null;
    },

    checkStalls(open, nowMs, sessionEnded) {
      const openIds = new Set(open.map((d) => d.toolUseId));
      for (const id of [...firstSeenMs.keys()]) if (!openIds.has(id)) firstSeenMs.delete(id);
      for (const id of [...stalled]) if (!openIds.has(id)) stalled.delete(id);

      const out: LiveNarrationPayload[] = [];
      for (const d of open) {
        if (!firstSeenMs.has(d.toolUseId)) firstSeenMs.set(d.toolUseId, nowMs);
        if (stalled.has(d.toolUseId)) continue;
        // liveAgentsMath turns a missing timestamp into the 1970 epoch; that
        // is "unknown", so measure from when this narrator first saw it.
        const startedMs = Date.parse(d.startedAt);
        const lastProgressMs = Number.isFinite(startedMs) && startedMs > 0 ? startedMs : firstSeenMs.get(d.toolUseId) ?? nowMs;
        if (!isStalled({ lastProgressMs, sessionEnded }, nowMs)) continue;
        stalled.add(d.toolUseId);
        const result = computeSeverity({ exit: 'fatal', elapsedMs: nowMs - lastProgressMs, medianMsAtEval: deps.baseline.medianFor(d.subagentType) });
        const text = deps.narrate(d.subagentType, result.severity);
        if (text) out.push({ toolUseId: d.toolUseId, narration: text, severity: result.severity });
      }
      return out;
    },
  };
}
```

- [ ] **Step 5: Run the new tests and see them pass**

Run: `npx vitest run electron/severity/liveSeverity.test.ts electron/narrationGenerator.test.ts electron/main.narration.test.ts src/state/liveAgentsMath.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire `electron/main.ts`; delete the old baseline**

1. Replace the imports at lines 52-53 with:
```ts
import { formatNarration } from './narrationGenerator';
import { loadDurationBaseline, DURATION_BASELINE_FILE } from './severity/durationBaseline';
import { createLiveSeverityNarrator, STALL_CHECK_INTERVAL_MS } from './severity/liveSeverity';
```
2. Delete line 126 (`const narrationDurationBaseline = createDurationBaseline();`).
3. Immediately after line 653 (`const liveAgentTracker = createLiveAgentTracker(os.homedir());`) add:
```ts
// Real severity (docs/superpowers/specs/2026-09-30-real-severity-design.md).
// Persisted per-agent baseline; corrupt/unreadable -> empty + one [diag].
const narrationDurationBaseline = loadDurationBaseline({
  filePath: join(aetherOsDir, DURATION_BASELINE_FILE),
  diag: (line) => diagLog.write(line),
});
const liveSeverity = createLiveSeverityNarrator({
  baseline: narrationDurationBaseline,
  narrate: (subagentType, severity) => formatNarration({ subagentType }, severity)?.narration ?? null,
});
const reportedUnknownStatusTags = new Set<string>();
let lastStallCheckMs = 0;
// "The owning session has ended" on the live path = the pinned pty exited.
let pinnedPtyExited = false;
```
4. In `tickAndPushAgents`, keep the "WALL CLOCK, deliberately." comment block (lines 745-756) **verbatim**. Replace the loop body after it (lines 757-765: `const measuredMs` through the closing `}` of `if (narrated)`) with:
```ts
      const tracked = result.outcomes?.get(c.toolUseId);
      if (tracked?.unknownStatusTag && !reportedUnknownStatusTags.has(tracked.unknownStatusTag)) {
        reportedUnknownStatusTags.add(tracked.unknownStatusTag);
        diagLog.write(`[diag] dispatch status not recognised tag=${tracked.unknownStatusTag}; narrated as ok at=${new Date().toISOString()}`);
      }
      const payload = liveSeverity.onCompleted(c, tracked);
      if (payload) sendToWindow('agents:narration', payload);
    }

    // Stall check, ~every 30 s, AFTER completions (liveSeverity.ts contract).
    const stallNowMs = Date.now();
    if (stallNowMs - lastStallCheckMs >= STALL_CHECK_INTERVAL_MS) {
      lastStallCheckMs = stallNowMs;
      for (const payload of liveSeverity.checkStalls(result.open, stallNowMs, pinnedPtyExited)) {
        sendToWindow('agents:narration', payload);
      }
```
The existing closing `}` of the `for` loop now closes the `if`. Make sure the braces balance; `npm run typecheck:electron` will tell you. Also update the comment at lines 739-743 to say the voice line is rendered "at the severity computed from the real outcome (electron/severity/liveSeverity.ts)".
5. At `main.ts:1185`, change the onExit to `onExit: () => { pinnedPtyExited = true; onExit(); sendToWindow('pty:exit', undefined); planUsageScraper.reset(); },`. At `:1219-1222`, add `pinnedPtyExited = true;` as the first statement of that `onExit`. Immediately before each `liveAgentTracker.notifyPtySpawned(Date.now());` (`:1187`, `:1226`), add `pinnedPtyExited = false;`.
6. Delete `electron/durationBaseline.ts` and `electron/durationBaseline.test.ts` (`git rm`). Confirm no importer remains: `grep -rn "durationBaseline'" electron src` should print only `electron/severity/` paths.

- [ ] **Step 7: Verify**

Run: `npm run typecheck:electron`, `npx tsc -p tsconfig.json --noEmit` (renderer; `liveAgentsMath` now imports from `electron/severity`), then `npx vitest run`.
Expected: exit 0, exit 0, 0 failures (ConPTY flake excepted; rerun it alone if it fires). `src/shared/noApiCalls.test.ts` and `src/state/noPayloadInStore.test.ts` pass.

- [ ] **Step 8: Byte-check and commit**

Run: `LC_ALL=C grep -n '[^[:print:][:space:]]' electron/severity/liveSeverity.ts electron/severity/liveSeverity.test.ts electron/narrationGenerator.ts electron/main.narration.test.ts electron/narrationGenerator.test.ts` -> no output. (`main.ts`, `liveAgentsMath.ts` and `liveAgentsMath.test.ts` may already contain non-ASCII. Check that `git diff` adds none: `git diff -U0 | grep '^+' | LC_ALL=C grep -n '[^[:print:][:space:]]'` -> no output.)
```bash
git add -A electron/severity electron/narrationGenerator.ts electron/narrationGenerator.test.ts electron/main.ts electron/main.narration.test.ts electron/liveAgentTracker.ts src/state/liveAgentsMath.ts src/state/liveAgentsMath.test.ts
git rm electron/durationBaseline.ts electron/durationBaseline.test.ts
git commit -m "feat(narration): live path uses real outcomes, persisted baseline, stall-once + recovered line"
```

---

### Task 8 (GO only): Tool-error floor + subagent progress, core and collector

**Skip this task and Task 9 if Task 1's note says NO-GO.** If it says `GO (different link)`, stop and ask the orchestrator for a delta.

**Files:**
- Create: `electron/severity/subagentLink.ts`, `electron/severity/subagentLink.test.ts`
- Modify: `electron/severity/computeSeverity.ts` (+ test), `scripts/sync-severity-core.mjs` (`CORE_FILES` += `'subagentLink.ts'`), regenerate `collector/src/severity/`
- Modify: `collector/src/usageIngest.ts` (options), `collector/src/staleDispatchSweep.ts` (4th param), `collector/src/transcriptScan.ts` (probe wiring at `:140-142` and `:186`)
- Test: `collector/src/usageIngest.test.ts`, `collector/src/staleDispatchSweep.test.ts`, `collector/src/transcriptScan.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3 and 5.
- Produces:
  - `TOOL_ERROR_FLOOR = 3`. `SeverityInput.toolErrors?: number | null` (applied only when `exit === 'ok'`; callers pass it only for `completed`).
  - `subagentLink.ts`: `toolUseIdFromSubagentMeta(metaJson: string): string | null`, `countToolErrors(lines: readonly string[]): number`, `interface SubagentFileProbe { toolErrorsFor(toolUseId: string): number | null; lastWriteMsFor(toolUseId: string): number | null }`, `createSubagentFileProbe(subagentsDir: string): SubagentFileProbe` (uses `node:fs`; never throws)
  - `DispatchIngestOptions.toolErrorsFor?: (toolUseId: string) => number | null`
  - `sweepStaleDispatches(db, history, nowMs, lastProgressFor?: (toolUseId: string) => number | null)`

- [ ] **Step 1: Write the failing tests**

Append to `electron/severity/computeSeverity.test.ts`:
```ts
import { TOOL_ERROR_FLOOR } from './computeSeverity';
describe('tool-error floor (spike GO)', () => {
  it('completed with >= 3 tool errors -> floor 3; 2 errors -> no floor', () => {
    expect(TOOL_ERROR_FLOOR).toBe(3);
    expect(computeSeverity({ exit: 'ok', elapsedMs: 1, medianMsAtEval: null, toolErrors: 3 }).severity).toBe(3);
    expect(computeSeverity({ exit: 'ok', elapsedMs: 1, medianMsAtEval: null, toolErrors: 2 }).severity).toBe(1);
    expect(computeSeverity({ exit: 'ok', elapsedMs: 1, medianMsAtEval: null, toolErrors: null }).severity).toBe(1);
  });
  it('never lifts killed above 2, never lowers failed', () => {
    expect(computeSeverity({ exit: 'killed', elapsedMs: 1, medianMsAtEval: null, toolErrors: 9 }).severity).toBe(2);
    expect(computeSeverity({ exit: 'error', elapsedMs: 1, medianMsAtEval: null, toolErrors: 9 }).severity).toBe(4);
  });
});
```
Create `electron/severity/subagentLink.test.ts`:
```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { toolUseIdFromSubagentMeta, countToolErrors, createSubagentFileProbe } from './subagentLink';

const result = (isError: boolean) => JSON.stringify({ type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: isError, content: 'x' }] } });

describe('subagentLink', () => {
  it('reads toolUseId from meta JSON, null on anything else', () => {
    expect(toolUseIdFromSubagentMeta('{"agentType":"x","toolUseId":"toolu_1"}')).toBe('toolu_1');
    expect(toolUseIdFromSubagentMeta('{"toolUseId":5}')).toBeNull();
    expect(toolUseIdFromSubagentMeta('nope')).toBeNull();
  });
  it('counts is_error:true tool_results, ignores malformed lines', () => {
    expect(countToolErrors([result(true), result(false), result(true), '{bad', '', result(true)])).toBe(3);
  });
  it('probe links a dispatch to its subagent file via meta.json', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'aether-sub-')), 'subagents');
    mkdirSync(dir);
    writeFileSync(join(dir, 'agent-a1.meta.json'), '{"toolUseId":"toolu_A"}');
    writeFileSync(join(dir, 'agent-a1.jsonl'), [result(true), result(true), result(true)].join('\n'));
    utimesSync(join(dir, 'agent-a1.jsonl'), 1_700_000_000, 1_700_000_000);
    const p = createSubagentFileProbe(dir);
    expect(p.toolErrorsFor('toolu_A')).toBe(3);
    expect(p.lastWriteMsFor('toolu_A')).toBe(1_700_000_000_000);
    expect(p.toolErrorsFor('toolu_missing')).toBeNull();
    expect(createSubagentFileProbe(join(dir, 'nope')).toolErrorsFor('toolu_A')).toBeNull();
  });
});
```
Collector tests (append):
- `usageIngest.test.ts`: `it('completed with 3 tool errors in its subagent file -> ok, severity 3', ...)`. It calls `ingestDispatchEvent(db, openDispatch('tu_t', 1000), notify('tu_t', 5000, '<status>completed</status>'), { ...quiet(), toolErrorsFor: (id) => (id === 'tu_t' ? 3 : null) })` and expects `{ exit_state: 'ok', severity: 3 }`. A second call with `'<status>failed</status>'` and `toolErrorsFor: () => 9` expects severity 4.
- `staleDispatchSweep.test.ts`: `it('recent subagent-file progress keeps a long dispatch from stalling', ...)`. Setup: `historyWithOpen('tu_p', { startedAt: 0 })`, fresh session row, `nowMs = THIRTY_MIN * 2`, and `sweepStaleDispatches(db, h, nowMs, () => nowMs - 60_000)`. Expect `staleFound` 0. Without the 4th arg, expect 1.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run electron/severity/` and, from `collector/`, `npx vitest run src/usageIngest.test.ts src/staleDispatchSweep.test.ts`
Expected: FAIL (unresolved `subagentLink`, no `TOOL_ERROR_FLOOR`, unknown option ignored).

- [ ] **Step 3: Implement the core additions**

In `electron/severity/computeSeverity.ts`, add `export const TOOL_ERROR_FLOOR = 3;` after `SLOWNESS_CAP`, add `toolErrors?: number | null;` to `SeverityInput`, destructure it, and insert this right after the slowness block:
```ts
  // Spec section 3 (spike GO): a completed run with >= 3 tool errors in its
  // own subagent transcript is a floor of 3. Callers pass toolErrors only for
  // <status>completed</status>; killed is still forced to 2 below.
  if (exit === 'ok' && typeof toolErrors === 'number' && toolErrors >= TOOL_ERROR_FLOOR) sev = Math.max(sev, 3);
```
Create `electron/severity/subagentLink.ts`:
```ts
// electron/severity/subagentLink.ts
// Links an Agent dispatch to its subagent transcript via
// <session>/subagents/agent-<id>.meta.json's toolUseId (spike note
// docs/superpowers/specs/2026-09-30-subagent-link-spike.md). Reads counts and
// mtimes only; no transcript text leaves this module. Never throws.
//
// SOURCE OF TRUTH for collector/src/severity/subagentLink.ts (generated).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface SubagentFileProbe {
  toolErrorsFor(toolUseId: string): number | null;
  lastWriteMsFor(toolUseId: string): number | null;
}

export function toolUseIdFromSubagentMeta(metaJson: string): string | null {
  try {
    const id = (JSON.parse(metaJson) as { toolUseId?: unknown } | null)?.toolUseId;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

export function countToolErrors(lines: readonly string[]): number {
  let n = 0;
  for (const line of lines) {
    if (!line) continue;
    try {
      const content = (JSON.parse(line) as { message?: { content?: unknown } } | null)?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'tool_result' && (item as { is_error?: unknown }).is_error === true) n += 1;
      }
    } catch {
      // malformed line: not an error signal
    }
  }
  return n;
}

export function createSubagentFileProbe(subagentsDir: string): SubagentFileProbe {
  let index: Map<string, string> | null = null;
  function fileFor(toolUseId: string): string | null {
    if (index === null) {
      index = new Map();
      let names: string[] = [];
      try {
        names = readdirSync(subagentsDir).filter((f) => f.endsWith('.meta.json'));
      } catch {
        names = [];
      }
      for (const meta of names) {
        try {
          const id = toolUseIdFromSubagentMeta(readFileSync(join(subagentsDir, meta), 'utf8'));
          if (id) index.set(id, join(subagentsDir, meta.replace(/\.meta\.json$/, '.jsonl')));
        } catch {
          // unreadable meta: skip
        }
      }
    }
    return index.get(toolUseId) ?? null;
  }
  return {
    toolErrorsFor(toolUseId) {
      const f = fileFor(toolUseId);
      if (!f) return null;
      try {
        return countToolErrors(readFileSync(f, 'utf8').split('\n'));
      } catch {
        return null;
      }
    },
    lastWriteMsFor(toolUseId) {
      const f = fileFor(toolUseId);
      if (!f) return null;
      try {
        return statSync(f).mtimeMs;
      } catch {
        return null;
      }
    },
  };
}
```
Add `'subagentLink.ts'` to `CORE_FILES` in `scripts/sync-severity-core.mjs`, then run `node scripts/sync-severity-core.mjs`. Expected: `wrote 5 files`.

- [ ] **Step 4: Wire the collector**

`collector/src/usageIngest.ts`. Add `toolErrorsFor?: (toolUseId: string) => number | null;` to `DispatchIngestOptions`, and pass `toolErrors: outcome.status === 'completed' ? options.toolErrorsFor?.(dispatchToolUseId) ?? null : null,` into `computeSeverity`.
`collector/src/staleDispatchSweep.ts`. Add a 4th parameter `lastProgressFor?: (toolUseId: string) => number | null`. In the `isStalled` call, use `lastProgressMs: Math.max(open.startedAt, lastProgressFor?.(toolUseId) ?? open.startedAt)`.
`collector/src/transcriptScan.ts`. Move `const sessionBase = file.replace(/\.jsonl$/, '');` (currently `:193`) up to before the ingest loop at `:140`. Add `const subagentProbe = createSubagentFileProbe(join(dirPath, sessionBase, 'subagents'));` (import from `./severity/subagentLink.js`). Call `ingestDispatchEvent(db, anomalyResult.history, event, { toolErrorsFor: (id) => subagentProbe.toolErrorsFor(id) })` and `sweepStaleDispatches(db, anomalyResult.history, nowMs, (id) => subagentProbe.lastWriteMsFor(id))`. Keep the later `subagentsDir` use; it can reuse `sessionBase`.

- [ ] **Step 5: Verify**

Run: at the root, `npx vitest run electron/severity/` (parity must pass with 5 files). From `collector/`, `npx vitest run` and `npx tsc -p tsconfig.json --noEmit`. Then `npm run typecheck:electron`.
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add electron/severity scripts/sync-severity-core.mjs collector/src/severity collector/src/usageIngest.ts collector/src/usageIngest.test.ts collector/src/staleDispatchSweep.ts collector/src/staleDispatchSweep.test.ts collector/src/transcriptScan.ts
git commit -m "feat(severity): tool-error floor (>=3 -> 3) and subagent-file progress, collector path"
```

---

### Task 9 (GO only): Tool-error floor + subagent progress on the live path

**Files:**
- Modify: `electron/liveAgentTracker.ts` (add `getSubagentsDir()`), `electron/severity/liveSeverity.ts`, `electron/main.ts` (the tick loop from Task 7)
- Test: `electron/severity/liveSeverity.test.ts`

**Interfaces:**
- Consumes: Task 8 `createSubagentFileProbe`, `SubagentFileProbe`; Task 7 narrator.
- Produces: `onCompleted(c, tracked, toolErrors?: number | null)`, `checkStalls(open, nowMs, sessionEnded, lastProgressFor?: (toolUseId: string) => number | null)`, `liveAgentTracker.getSubagentsDir(): string | null`.

- [ ] **Step 1: Write the failing tests** (append to `electron/severity/liveSeverity.test.ts`)

```ts
describe('live tool-error floor and subagent progress (spike GO)', () => {
  it('completed with 3 tool errors -> severity 3; killed with 9 -> 2', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    expect(n.onCompleted(completed('t1'), tracked('completed', 1000), 3)!.severity).toBe(3);
    expect(n.onCompleted(completed('t2'), tracked('killed'), 9)!.severity).toBe(2);
  });
  it('recent subagent-file writes count as progress', () => {
    const n = createLiveSeverityNarrator({ baseline: fakeBaseline(), narrate });
    const d = [open('p')];
    expect(n.checkStalls(d, T0 + 2 * STALL_MS, false, () => T0 + 2 * STALL_MS - 1000)).toEqual([]);
    expect(n.checkStalls(d, T0 + 2 * STALL_MS, false, () => null)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run electron/severity/liveSeverity.test.ts`
Expected: FAIL (the extra args are ignored, so the severity is 1 and the dispatch stalls).

- [ ] **Step 3: Implement**

`liveSeverity.ts`. Extend the interface and implementation: `onCompleted(c, tracked, toolErrors: number | null = null)` passes `toolErrors: outcome.status === 'completed' ? toolErrors : null` into `computeSeverity`. `checkStalls(open, nowMs, sessionEnded, lastProgressFor?)` computes `const base = ...existing lastProgressMs...; const lastProgressMs = Math.max(base, lastProgressFor?.(d.toolUseId) ?? base);`.
`liveAgentTracker.ts`. Add to the returned object:
```ts
    getSubagentsDir(): string | null {
      return pinnedFile ? path.join(pinnedFile.replace(/\.jsonl$/, ''), 'subagents') : null;
    },
```
`main.ts` (the Task 7 loop). Before the `for (const c of result.completed)` loop add:
```ts
    const subagentsDir = liveAgentTracker.getSubagentsDir();
    const subagentProbe = subagentsDir ? createSubagentFileProbe(subagentsDir) : null;
```
(import `createSubagentFileProbe` from `./severity/subagentLink`). Call `liveSeverity.onCompleted(c, tracked, subagentProbe?.toolErrorsFor(c.toolUseId) ?? null)` and `liveSeverity.checkStalls(result.open, stallNowMs, pinnedPtyExited, subagentProbe ? (id) => subagentProbe.lastWriteMsFor(id) : undefined)`.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run electron/`, `npm run typecheck:electron`
Expected: green.
```bash
git add electron/severity/liveSeverity.ts electron/severity/liveSeverity.test.ts electron/liveAgentTracker.ts electron/main.ts
git commit -m "feat(narration): live tool-error floor and subagent-file progress for stalls"
```

---

### Task 10: Every consumer handles `killed` and NULL usage

**Files:**
- Modify: `electron/collectorStore.ts:58-72` (DispatchRow), `:97-104` (EXIT_STATES), `:249-257` (mapping)
- Modify: `src/components/agents/DispatchTimeline.tsx:42-44`
- Modify: `src/components/ledger/DispatchCostTable.tsx:131-146`
- Modify: `src/shared/frozenPhraseDetect.ts:35,150-167`, `src/components/comms/narrationFeed.ts:40`
- Test: `electron/collectorStore.test.ts`, `src/components/agents/DispatchTimeline.test.tsx`, `src/components/ledger/DispatchCostTable.test.tsx`, `src/shared/frozenPhraseDetect.test.ts`

**Interfaces:**
- Consumes: the `ExitState` type from `collector/src/personalitySpine` (Task 3, which includes `killed`). If Task 3 is not merged yet, `'killed'` will not typecheck, so run this task after Task 3 is merged, or on top of it.
- Produces: `DispatchRow.tokens/toolUses/durationMs: number | null`.

Consumer audit of `exit_state` (spec §7 "every consumer ... must handle the new value"), done by grep at `fd8af20`:
- `electron/collectorStore.ts:97` narrows to a set that lacks `killed`, so it would read as null. **Fix.**
- `src/components/ledger/DispatchCostTable.tsx:135` treats any non-ok/partial as failed, so killed would be styled as a failure. **Fix:** label it, do not style it as trouble.
- `src/components/ledger/LedgerView.tsx:255` passes through; no change.
- `src/shared/frozenPhraseDetect.ts:161` makes ASSAY `no_signal` fire on any non-ok exit with zero tool uses, so killed would fire. **Fix:** killed is informational.
- `src/components/comms/narrationFeed.ts:40` has an inline union. **Add `killed`.**
- `collector/src/transcriptScan.ts:165` has `!== 'ok'`, so killed is skipped. Correct as is (Task 5 pins it).
- `collector/src/staleDispatchSweep.ts:73` skips any existing row, which is correct.

- [ ] **Step 1: Write the failing tests**

`electron/collectorStore.test.ts` (next to "reads a fatal exit with retries > 0"):
```ts
  it('reads a killed exit and NULL usage columns (schema v9) as killed / null, never 0', () => {
    const dbPath = tempDbForDiagnostics(5);
    const db = new DatabaseSync(dbPath);
    db.exec(`DROP TABLE dispatches;
      CREATE TABLE dispatches (tool_use_id TEXT PRIMARY KEY, tokens INTEGER, tool_uses INTEGER, duration_ms INTEGER, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER NOT NULL, agent_id TEXT, task_kind TEXT, session_id TEXT, retries INTEGER NOT NULL DEFAULT 0, exit_state TEXT NOT NULL DEFAULT 'ok', severity INTEGER, median_ms_at_eval INTEGER);
      INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms, exit_state, severity)
      VALUES ('tu_k', NULL, NULL, NULL, 1000, 61000, 'killed', 2);`);
    db.close();
    const row = readDiagnostics(dbPath, 0)!.dispatches[0];
    expect(row).toMatchObject({ exitState: 'killed', severity: 2, tokens: null, toolUses: null, durationMs: null });
  });
```
`src/components/agents/DispatchTimeline.test.tsx`. Use the file's existing `dispatch(...)` helper (`:12`) and `render` convention, and add:
```ts
  it('renders an em dash, not "null" or NaN, for a dispatch with no reported usage', () => {
    const { container } = render(
      <DispatchTimeline diagnostics={{ toolCalls: [], anomalies: [], dispatches: [dispatch({ toolUseId: 'tu_n', tokens: null, toolUses: null, durationMs: null, startedAtMs: 1, endedAtMs: 2 })] }} />,
    );
    expect(container.textContent).not.toMatch(/null|NaN/);
    expect(container.textContent).toContain('\u2014 tokens');
  });
```
Widen the helper's `Pick<DispatchRow, ...>` if needed. It follows `DispatchRow`, so it widens automatically.
`src/components/ledger/DispatchCostTable.test.tsx`:
```ts
  it('labels a killed dispatch without failure styling', () => {
    render(<DispatchCostTable rows={[row({ toolUseId: 'k', exitState: 'killed' }), row({ toolUseId: 'c', exitState: 'ok' })]} />);
    expect(screen.getByText(/killed/)).toBeTruthy();
    const [, killedRow, cleanRow] = screen.getAllByRole('row');
    expect(killedRow.getAttribute('style')).toBe(cleanRow.getAttribute('style'));
  });
```
(Row 0 is the header row. Confirm this by reading the table's markup, and adjust the destructuring if the header is not `role="row"`.)
`src/shared/frozenPhraseDetect.test.ts` (inside `describe('no_signal (ASSAY)'`):
```ts
    it('does not fire for a killed dispatch (a kill is deliberate, not "no signal")', () => {
      expect(detectEventKind({ dispatch: { subagentType: 'pr-test-analyzer', severity: 2, completed: true, toolUses: [], exitState: 'killed' } })).not.toBe('no_signal');
    });
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run electron/collectorStore.test.ts src/components/agents/DispatchTimeline.test.tsx src/components/ledger/DispatchCostTable.test.tsx src/shared/frozenPhraseDetect.test.ts`
Expected: FAIL. `exitState` is null for killed, the timeline shows "null tokens", the killed row has trouble styling, `no_signal` fires, and the TS unions reject `'killed'` (vitest does not typecheck, so type errors show up in Step 4).

- [ ] **Step 3: Implement**

`electron/collectorStore.ts`. In `DispatchRow`, set `tokens: number | null; toolUses: number | null; durationMs: number | null;`, and add to the doc comment: "tokens/toolUses/durationMs are null when the notification carried no usage block (schema v9: failed/killed/stalled dispatches); render null as a dash, never 0." Add `'killed',` to `EXIT_STATES`. In the mapping, set `tokens: asNullableNumber(r.tokens), toolUses: asNullableNumber(r.tool_uses), durationMs: asNullableNumber(r.duration_ms),`.
`src/components/agents/DispatchTimeline.tsx:42-44`:
```tsx
            <span>{item.data.tokens ?? '\u2014'} tokens</span>
            <span>{item.data.toolUses ?? '\u2014'} tool uses</span>
            <span>{item.data.durationMs === null ? '\u2014' : `${Math.round(item.data.durationMs / 1000)}s`}</span>
```
`src/components/ledger/DispatchCostTable.tsx`. Replace lines 135-146's `failed`/`troubled`/flag logic with:
```tsx
          // 'killed' is informational (almost always a deliberate stop, spec
          // 2026-09-30-real-severity-design.md section 3): labelled, never styled as trouble.
          const killed = row.exitState === 'killed';
          const failed = row.exitState !== null && row.exitState !== 'ok' && row.exitState !== 'partial' && !killed;
          const troubled = failed || (row.retries !== null && row.retries > 0);
          return (
            <div role="row" key={row.toolUseId} style={bodyRowStyle(colors, troubled)}>
              <span role="cell" style={{ ...colDesc, ...descCellStyle(colors) }} title={row.description}>
                {row.description}
                {(troubled || killed) && (
                  <span style={flagStyle(colors)}>
                    {failed || killed ? row.exitState : null}
                    {(failed || killed) && row.retries ? ' \u00b7 ' : null}
                    {row.retries ? `${row.retries} ${row.retries === 1 ? 'retry' : 'retries'}` : null}
                  </span>
                )}
              </span>
```
The original line 144 uses a literal middle dot. Keep whatever byte form the file already uses there (check with `git diff`); `' \u00b7 '` is the ASCII-safe spelling.
`src/shared/frozenPhraseDetect.ts`. Add `| 'killed'` to the union at `:35`. In `detectNoSignal`, after `if (role !== 'ASSAY') return false;`, add `if (exitState === 'killed') return false; // deliberate stop, not "no signal"`.
`src/components/comms/narrationFeed.ts:40`: add `| 'killed'` to the union.

- [ ] **Step 4: Verify**

Run: the four test files from Step 2, then `npm run typecheck:electron`, `npx tsc -p tsconfig.json --noEmit`, `npx vitest run`.
Expected: all green. List any other test broken by the `DispatchRow` nullability and how you fixed it.

- [ ] **Step 5: Byte-check and commit**

Run: `git diff -U0 | grep '^+' | LC_ALL=C grep -n '[^[:print:][:space:]]'` -> no output.
```bash
git add electron/collectorStore.ts electron/collectorStore.test.ts src/components/agents/DispatchTimeline.tsx src/components/agents/DispatchTimeline.test.tsx src/components/ledger/DispatchCostTable.tsx src/components/ledger/DispatchCostTable.test.tsx src/shared/frozenPhraseDetect.ts src/shared/frozenPhraseDetect.test.ts src/components/comms/narrationFeed.ts
git commit -m "feat(viewer): render killed exits and NULL dispatch usage (Ledger, timeline, frozen phrases)"
```

---

### Task 11: Docs

**Files:**
- Modify: `docs/superpowers/specs/AGENT_PERSONALITY_LAYER_1.md` (insert after the `## 4. Severity model` heading at line 213), `PROGRESS.md` (the top entry under `## Shipped plans (newest first)`, line 25), `CLAUDE.md` (the sidechain gotcha around lines 263-277), `src/components/comms/narrationFeed.ts:10`, `src/state/types.ts:52`, `src/state/reducer.ts:405`, `src/state/persistence.ts:46`

**Interfaces:** Consumes Task 1's note (the counts for the CLAUDE.md correction) and the final test counts. Produces nothing.

- [ ] **Step 1: §4 revision note.** Insert directly under `## 4. Severity model`:
```markdown
> **Revision 2026-09-30:** amended by `docs/superpowers/specs/2026-09-30-real-severity-design.md` section 3. `failed` -> `error` at 4 (was 3), new exit `killed` at 2 (never voiced), stall -> `fatal` 4, unknown status -> `ok` 1, slowness alone capped at 2, and the `retries >= 2` rule is replaced by a >= 3 tool-error floor [only if the subagent-link spike was GO]. Implementation: `electron/severity/` (collector copy generated into `collector/src/severity/`). This section is not rewritten in place.
```
If Task 1 was NO-GO, replace the bracketed clause with "(the >= 3 tool-error floor is deferred: subagent-link spike NO-GO)".

- [ ] **Step 2: CLAUDE.md gotcha.** In the "Do not reintroduce user-wait subtraction" bullet, replace the parenthetical "(measured: 0 `isSidechain:true` lines across 570 transcripts / 549 MB, and a live probe dispatch's inner calls appeared nowhere)" with a sentence that states the Task 1 counts. Example: "(corrected 2026-09-30: a subagent's tool calls ARE written, to `<session>/subagents/agent-<id>.jsonl` with `isSidechain:true`, <N> lines in <M> files, linked to the dispatch by `agent-<id>.meta.json`'s `toolUseId`; they are NOT in the main transcript. See docs/superpowers/specs/2026-09-30-subagent-link-spike.md.)". Keep the conclusion that approval-wait attribution is still unsolved **unless the spike shows otherwise**. Do not decide that here; say "not re-evaluated by this change".

- [ ] **Step 3: Stale comments.** "model-written" -> "deterministic (electron/narrationGenerator.ts, no model call)" at `narrationFeed.ts:10`, `types.ts:52`, `reducer.ts:405` and `persistence.ts:46` (the `dispatchNarrations` entry only; line 45's `dispatchHeadlines` is out of scope).

- [ ] **Step 4: PROGRESS.md entry** at the top of "Shipped plans". Include: plan link; what shipped (bullets per task); GO/NO-GO; test counts (root and collector, from a final `npx vitest run` in each); the known limitations: stall lines show on the roster, not in Comms; stall state does not survive a collector restart; the Go collector's ingest still writes 0/'ok' (issue link from Post-merge); a `running` status notification closes a dispatch.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run src/shared/noApiCalls.test.ts src/state/noPayloadInStore.test.ts`, then `git diff -U0 | grep '^+' | LC_ALL=C grep -n '[^[:print:][:space:]]'` -> no output.
```bash
git add docs/superpowers/specs/AGENT_PERSONALITY_LAYER_1.md PROGRESS.md CLAUDE.md src/components/comms/narrationFeed.ts src/state/types.ts src/state/reducer.ts src/state/persistence.ts
git commit -m "docs: real severity - section 4 revision note, PROGRESS, sidechain gotcha, deterministic narration comments"
```

---

## Post-merge (orchestrator, not a builder)

- File a GitHub issue next to #65: "Go collector dispatch ingest ignores `<status>`: failed/killed stored as `ok` with 0 usage (collector-go/internal/transcript/usage.go:97). Node side fixed by the real-severity plan; the Go schema is at v9 and already nullable." Only a user-approved push or `gh` call does this.
- Full-suite gate: root `npx vitest run`, from `collector/` `npx vitest run` + `npm run build`, from `collector-go/` `go vet ./... && go test ./...`, plus `npm run typecheck:electron` and `npm run build`.

## RISKS (out of scope, one line each)

- A `<status>running</status>` notification (3 seen locally) closes the dispatch in both `liveAgentsMath` and `usageIngest` today. If a real completion follows, it is dropped (no open entry). Task 1 measures whether this happens.
- `electron/main.ts:914` (`onPostToolUse`) calls `liveAgentTracker.tick()` too. Completions consumed by that tick never reach `tickAndPushAgents`' narration loop, so they are never narrated. The bug predates this plan; real severity makes it more visible.
- `<tool-use-id>` is still matched anywhere in the notification text (not only structurally) by `liveAgentsMath`, `usageIngest` and `transcriptScan`.
- `recentCompletedDispatches`/`dispatchUsage` in the renderer still record 0 for missing usage (the Ledger shows `$0`-class figures for failed runs). This is the renderer contract and was not changed by this spec.
```

## Self-review (spec-writer, done)

1. **Spec coverage.** §3 table: T2 + T5 + T7 (+T8/T9 floor). §4 units: T2, T6. Generated copy + parity: T3. Delete the `narrationGenerator` re-implementation: T7. Collector path: T5. §5 stall live/collector/recovery: T7/T5. §6 baseline live/collector: T6/T5. §7 NULL/schema: T4/T5. Ledger `killed`: T10. Memory gate: T5. Go: T4 schema + Post-merge issue. §8 spike: T1 (T8/T9 gated), gotcha: T11. §9 errors: T2/T6/T7. §10 tests: all listed per task. §12 docs: T11. Gap check found none.
2. **Placeholder scan.** No TBD/TODO. Every "similar" step repeats its code. Task 11's CLAUDE.md sentence has `<N>/<M>` slots, which are filled from Task 1's measured output by design.
3. **Type consistency.** `DispatchOutcome`/`DispatchStatus`/`TrackedOutcome`/`SeverityResult`/`LiveNarrationPayload` names match across T2, T5, T6, T7, T8 and T9. `computeSeverity` returns an object everywhere, and every collector call site appends `.severity`. `formatNarration(dispatch, severity)` matches in T7 main, the tests and narrate.
4. **Review Focus.** Five lines, each pinned in its owning task's tests (T2, T7 x2, T4, T6).
