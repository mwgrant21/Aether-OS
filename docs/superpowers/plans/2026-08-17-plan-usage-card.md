# Plan Usage Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `PlanUsageCard` to `TerminalView`'s right rail (replacing the slot `SystemOverviewCard` used to occupy) showing real plan-usage tracking: Session (5h) and Week (7d) bars sourced live from the existing statusline watcher, plus a manually-synced Pro/Max tier badge and per-model week breakdown scraped from Claude Code's `/usage` TUI.

**Architecture:** Session/Week percentages read `state.statusline` directly (already live, already real — no new plumbing). Tier/per-model data comes from a new, narrow `/usage` scraper (`electron/planUsageScraper.ts`) that hooks the existing Terminal pty's `onData` path, driven by a new, pure, fully-unit-testable quiescence-polling function (`electron/planUsageSync.ts`) wired into a new `plan:sync` IPC handler. No second pty is spawned — the scrape reuses aether-os's existing, always-on Terminal pty, manually triggered by a Sync button.

**Tech Stack:** TypeScript, React, Electron (main + renderer + preload IPC), Vitest, `@testing-library/react`.

**Spec:** `docs/superpowers/specs/2026-08-17-plan-usage-card-design.md`

## Global Constraints

- No separate background pty — every pty write in this plan goes through the existing `ptyLifecycle` singleton in `electron/main.ts`.
- No re-scraping Session/Week percentages — the scraper only tracks the per-model week line; `state.statusline` is the sole source for Session/Week.
- Manual Sync only — no automatic/periodic sync trigger anywhere in this plan.
- `electron/main.ts` and `electron/preload.ts` are not unit-testable in this repo (no Electron/node-pty in the Vitest environment — see `ptyLifecycle.ts`'s own header comment). Tasks touching those two files are verified via `npx tsc -b` and the Task 11 manual checklist, not new unit tests — this is an intentional, established boundary in this codebase, not a gap in this plan.
- Every task ends with the test command listed in that task passing, plus a commit. Do not batch commits across tasks.
- Repo root for all commands: `C:\Users\Matt\projects\aether-os`.

---

### Task 1: Add `planUsageTier` state field (type, default, persistence)

**Files:**
- Modify: `src/state/types.ts` (add `PlanUsageTier`/`PlanUsageSyncResult` interfaces near the top, and `planUsageTier` to the `AetherState` interface at line 225)
- Modify: `src/state/initialState.ts` (line 85, right after `statusline: null,`)
- Modify: `src/state/persistence.ts` (line 79, right after `codexTerminalCfg: state.codexTerminalCfg,`)
- Test: `src/state/persistence.test.ts`

**Interfaces:**
- Produces: `PlanUsageTier` (`{ tier: 'pro' | 'max'; weekModel: { pct: number } | null; capturedAtMs: number }`), exported from `src/state/types.ts` — consumed by Task 2 (reducer action), Task 4 (scraper), Task 5 (sync function), Task 9 (component).
- Produces: `PlanUsageSyncResult` (`{ ok: boolean; tier?: 'pro' | 'max'; weekModel?: { pct: number } | null; capturedAtMs?: number; error?: string }`), exported from `src/state/types.ts` — consumed by Task 5 (sync function's return type), Task 8 (preload/d.ts).
- Produces: `AetherState.planUsageTier: PlanUsageTier | null`, default `null`.

This task deliberately bundles three files that must land together: `types.ts` alone would break `tsc -b` (`initialState.ts`'s object literal would be missing a required property), and `initialState.ts` alone would break `persistence.test.ts`'s existing exhaustiveness test (a new top-level `AetherState` key that is neither persisted nor excluded fails that test by design — see that file's own header comment for why). They are not independently reviewable or committable.

- [ ] **Step 1: Add the two interfaces to `types.ts`**

In `src/state/types.ts`, add near the top of the file (alongside the other small interfaces like `Notif`, `LogEntry`):

```typescript
export interface PlanUsageTier {
  tier: 'pro' | 'max';
  weekModel: { pct: number } | null;
  capturedAtMs: number;
}

export interface PlanUsageSyncResult {
  ok: boolean;
  tier?: 'pro' | 'max';
  weekModel?: { pct: number } | null;
  capturedAtMs?: number;
  error?: string;
}
```

- [ ] **Step 2: Add the field to `AetherState`**

In `src/state/types.ts`, in the `AetherState` interface, add right after `statusline: StatuslineSnapshot | null;` (line 225):

```typescript
  planUsageTier: PlanUsageTier | null;
```

- [ ] **Step 3: Add the default to `initialState.ts`**

In `src/state/initialState.ts`, add right after `statusline: null,` (line 85):

```typescript
  planUsageTier: null,
```

- [ ] **Step 4: Run `tsc -b` to confirm the type change compiles**

Run: `npx tsc -b`
Expected: PASS (no errors — `initialState`'s object literal now satisfies `AetherState` again)

- [ ] **Step 5: Write the failing persistence round-trip test**

In `src/state/persistence.test.ts`, add a new test (near the other `persists the selected X` tests):

```typescript
  it('persists planUsageTier across reloads', () => {
    savePersisted({ ...initialState, planUsageTier: { tier: 'max', weekModel: { pct: 52 }, capturedAtMs: 1700000000000 } });
    const loaded = loadPersisted();
    expect(loaded?.planUsageTier).toEqual({ tier: 'max', weekModel: { pct: 52 }, capturedAtMs: 1700000000000 });
  });
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/state/persistence.test.ts`
Expected: FAIL — `loaded?.planUsageTier` is `undefined` (not yet added to `savePersisted`'s slice)

- [ ] **Step 7: Add `planUsageTier` to the persisted slice**

In `src/state/persistence.ts`, in `savePersisted`'s `slice` object literal, add right after `codexTerminalCfg: state.codexTerminalCfg,` (line 79):

```typescript
      planUsageTier: state.planUsageTier,
```

Do **not** add `planUsageTier` to `PERSISTENCE_EXCLUSIONS` — this is the one deliberately persisted piece of this feature (tier rarely changes; a per-model week % is still meaningful minutes-to-hours old, unlike this app's other per-session live feeds).

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run src/state/persistence.test.ts`
Expected: PASS (all tests in the file, including the pre-existing exhaustiveness test)

- [ ] **Step 9: Commit**

```bash
git add src/state/types.ts src/state/initialState.ts src/state/persistence.ts src/state/persistence.test.ts
git commit -m "feat: add planUsageTier state field with persistence"
```

---

### Task 2: Add `SET_PLAN_USAGE_TIER` reducer action

**Files:**
- Modify: `src/state/reducer.ts`
- Test: `src/state/reducer.test.ts`

**Interfaces:**
- Consumes: `PlanUsageTier` (Task 1, `src/state/types.ts`).
- Produces: `Action` union member `{ type: 'SET_PLAN_USAGE_TIER'; snapshot: PlanUsageTier }`, consumed by Task 9 (component's dispatch call).

- [ ] **Step 1: Write the failing reducer tests**

In `src/state/reducer.test.ts`, add a new `describe` block (near the other single-action `describe`/`it` blocks):

```typescript
describe('SET_PLAN_USAGE_TIER', () => {
  it('replaces state.planUsageTier with the given snapshot', () => {
    const next = reducer(initialState, {
      type: 'SET_PLAN_USAGE_TIER',
      snapshot: { tier: 'max', weekModel: { pct: 52 }, capturedAtMs: 1700000000000 },
    });
    expect(next.planUsageTier).toEqual({ tier: 'max', weekModel: { pct: 52 }, capturedAtMs: 1700000000000 });
  });

  it('touches nothing else in state', () => {
    const next = reducer(initialState, {
      type: 'SET_PLAN_USAGE_TIER',
      snapshot: { tier: 'pro', weekModel: null, capturedAtMs: 1700000000000 },
    });
    expect(next.rate).toBe(initialState.rate);
    expect(next.statusline).toBe(initialState.statusline);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/state/reducer.test.ts`
Expected: FAIL with a TypeScript error (`'SET_PLAN_USAGE_TIER'` is not assignable to the `Action` union) or a runtime failure if TS errors are not enforced by the test runner — either way, `next.planUsageTier` is not `{ tier: 'max', ... }` yet.

- [ ] **Step 3: Add the action type**

In `src/state/reducer.ts`, add to the `Action` union type (near `SELECT_REAL_AGENT`):

```typescript
  | { type: 'SET_PLAN_USAGE_TIER'; snapshot: PlanUsageTier }
```

In `src/state/reducer.ts`, change the existing import at line 1 from:

```typescript
import type { AetherState, Cfg, DispatchChannelStub, FleetSessionRow, MemoryRow, MemoryTombstone, OpMode, PermissionRequestUI, PostToolFlagRequestUI, RealUsageSnapshot, RecapPayload } from './types';
```

to:

```typescript
import type { AetherState, Cfg, DispatchChannelStub, FleetSessionRow, MemoryRow, MemoryTombstone, OpMode, PermissionRequestUI, PlanUsageTier, PostToolFlagRequestUI, RealUsageSnapshot, RecapPayload } from './types';
```

- [ ] **Step 4: Add the reducer case**

In `src/state/reducer.ts`, add a new `case` right after the existing `case 'SELECT_REAL_AGENT':` block (line 428-429):

```typescript
    case 'SET_PLAN_USAGE_TIER':
      return { ...state, planUsageTier: action.snapshot };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/state/reducer.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/state/reducer.ts src/state/reducer.test.ts
git commit -m "feat: add SET_PLAN_USAGE_TIER reducer action"
```

---

### Task 3: Add `stripAnsi` utility

**Files:**
- Create: `electron/ansiStrip.ts`
- Test: `electron/ansiStrip.test.ts`

**Interfaces:**
- Produces: `stripAnsi(chunk: unknown): string`, consumed by Task 4 (`planUsageScraper.ts`).

aether-os has no existing ANSI-stripping utility (checked: no file anywhere under `electron/` or `src/shared/`). This is a direct TypeScript port of TokenMonitor's `src/shared/ansiStrip.js` — pure, no dependencies.

- [ ] **Step 1: Write the failing tests**

Create `electron/ansiStrip.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { stripAnsi } from './ansiStrip';

describe('stripAnsi', () => {
  it('strips CSI sequences (colors, cursor movement)', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('strips OSC sequences (window title, hyperlinks)', () => {
    expect(stripAnsi('\x1b]0;title\x07visible')).toBe('visible');
  });

  it('strips other escape sequences', () => {
    expect(stripAnsi('\x1bMreverse-index-visible')).toBe('reverse-index-visible');
  });

  it('strips C0 control characters but preserves newline, tab, and carriage return', () => {
    expect(stripAnsi('a\x00b\nc\td\re')).toBe('ab\nc\td\re');
  });

  it('returns an empty string for null or undefined input', () => {
    expect(stripAnsi(null)).toBe('');
    expect(stripAnsi(undefined)).toBe('');
  });

  it('passes plain text through unchanged', () => {
    expect(stripAnsi('plain text, no escapes')).toBe('plain text, no escapes');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run electron/ansiStrip.test.ts`
Expected: FAIL — `./ansiStrip` does not exist yet

- [ ] **Step 3: Implement `stripAnsi`**

Create `electron/ansiStrip.ts`:

```typescript
const CSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
const OTHER_ESC = /\x1b[@-_]/g;
const C0 = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g; // keep \n \t \r

export function stripAnsi(chunk: unknown): string {
  return String(chunk == null ? '' : chunk).replace(CSI, '').replace(OSC, '').replace(OTHER_ESC, '').replace(C0, '');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run electron/ansiStrip.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/ansiStrip.ts electron/ansiStrip.test.ts
git commit -m "feat: add stripAnsi utility, ported from TokenMonitor"
```

---

### Task 4: Add `planUsageScraper`

**Files:**
- Create: `electron/planUsageScraper.ts`
- Test: `electron/planUsageScraper.test.ts`

**Interfaces:**
- Consumes: `stripAnsi` (Task 3, `electron/ansiStrip.ts`), `PlanUsageTier` (Task 1, `../src/state/types`).
- Produces: `createPlanUsageScraper(now?: () => number): { ingest(chunk: string): void; getSnapshot(): PlanUsageTier | null; hasSeenUsagePane(): boolean; reset(): void }` — consumed by Task 6 (main.ts wiring) and Task 7 (main.ts's `plan:sync` handler, via the same instance).

This is the one signal aether-os needs from `/usage` that `state.statusline` cannot provide: whether a per-model week-usage line rendered (which is also how tier is inferred — see the design spec's Context section). `hasSeenUsagePane()` exists specifically to distinguish "confirmed Pro" (the pane opened, no model line ever appeared) from "the pane never opened at all" (e.g. no `claude` session running in this pty) — without it, both cases look identical (`getSnapshot()` returns `null`), and a sync would silently report a wrong "Pro" in the second case.

- [ ] **Step 1: Write the failing tests**

Create `electron/planUsageScraper.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { createPlanUsageScraper } from './planUsageScraper';

describe('createPlanUsageScraper', () => {
  it('sets tier "max" and weekModel.pct once a per-model week line appears', () => {
    const scraper = createPlanUsageScraper(() => 1000);
    scraper.ingest(
      'Current session 46%used\nCurrent week (all models) 30%used\nCurrent week (Claude Opus 4) 52%used Resets 1:19am (America/Denver)\n',
    );
    expect(scraper.getSnapshot()).toEqual({ tier: 'max', weekModel: { pct: 52 }, capturedAtMs: 1000 });
  });

  it('never sets a snapshot when only a non-model week line has been seen (Pro shape)', () => {
    const scraper = createPlanUsageScraper(() => 1000);
    scraper.ingest('Current session 46%used\nCurrent week (all models) 30%used Resets 1:19am (America/Denver)\n');
    expect(scraper.getSnapshot()).toBeNull();
  });

  it('never sets a snapshot when no usage pane text has been seen at all', () => {
    const scraper = createPlanUsageScraper(() => 1000);
    scraper.ingest('$ ls\nREADME.md  package.json\n');
    expect(scraper.getSnapshot()).toBeNull();
  });

  it('uses the LAST model-line match when the buffer contains a repainted (earlier + later) frame', () => {
    const scraper = createPlanUsageScraper(() => 1000);
    scraper.ingest('Current week (Claude Opus 4) 10%used');
    scraper.ingest('Current week (Claude Opus 4) 52%used Resets 1:19am (America/Denver)');
    expect(scraper.getSnapshot()?.weekModel).toEqual({ pct: 52 });
  });

  it('never throws on garbage/partial ANSI-laden input', () => {
    const scraper = createPlanUsageScraper();
    expect(() => scraper.ingest('\x1b[31m\x1b[unterminated garbage \x00\x01')).not.toThrow();
    expect(scraper.getSnapshot()).toBeNull();
  });

  it('hasSeenUsagePane() is false before any /usage-pane text is ingested, true once "Current session" appears (even without a model line)', () => {
    const scraper = createPlanUsageScraper();
    expect(scraper.hasSeenUsagePane()).toBe(false);
    scraper.ingest('Current session 12%used\n');
    expect(scraper.hasSeenUsagePane()).toBe(true);
  });

  it('reset() clears the buffer, the snapshot, and hasSeenUsagePane()', () => {
    const scraper = createPlanUsageScraper(() => 1000);
    scraper.ingest('Current session 46%used\nCurrent week (Claude Opus 4) 52%used Resets 1:19am (America/Denver)\n');
    expect(scraper.getSnapshot()).not.toBeNull();
    expect(scraper.hasSeenUsagePane()).toBe(true);
    scraper.reset();
    expect(scraper.getSnapshot()).toBeNull();
    expect(scraper.hasSeenUsagePane()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run electron/planUsageScraper.test.ts`
Expected: FAIL — `./planUsageScraper` does not exist yet

- [ ] **Step 3: Implement `planUsageScraper.ts`**

Create `electron/planUsageScraper.ts`:

```typescript
import { stripAnsi } from './ansiStrip';
import type { PlanUsageTier } from '../src/state/types';

const BUFFER_CAP = 16384;
// Matches TokenMonitor's usageParser.js WEEK_MODEL_RE exactly -- same TUI,
// same calibration history (see that file's own comment for why the
// pattern is shaped this way).
const WEEK_MODEL_RE = /Current week \((?!all models)[^)]+\)[\s\S]{0,150}?(\d{1,3})\s*%\s*used/i;

// Liveness-only signal, reusing TokenMonitor's own SESSION_RE calibration --
// NOT used for its percentage (state.statusline already has that), only to
// prove the /usage pane actually opened at all.
const SESSION_SEEN_RE = /Current session/i;

function matchLast(re: RegExp, text: string): RegExpExecArray | null {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null = null;
  let cur: RegExpExecArray | null;
  while ((cur = g.exec(text)) !== null) m = cur;
  return m;
}

export function createPlanUsageScraper(now: () => number = Date.now) {
  let buffer = '';
  let snapshot: PlanUsageTier | null = null;
  let sawUsagePane = false;

  function ingest(chunk: string): void {
    try {
      buffer = (buffer + stripAnsi(chunk)).slice(-BUFFER_CAP);
      if (SESSION_SEEN_RE.test(buffer)) sawUsagePane = true;
      const model = matchLast(WEEK_MODEL_RE, buffer);
      if (model) {
        const pct = Number(model[1]);
        if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
          snapshot = { tier: 'max', weekModel: { pct }, capturedAtMs: now() };
        }
      }
    } catch {
      /* parsing must never break the pty data path -- same rule as TokenMonitor's scraper */
    }
  }

  function getSnapshot(): PlanUsageTier | null {
    return snapshot;
  }

  /** True once any /usage pane text has been seen since the last reset() --
   *  distinguishes "confirmed Pro" from "the pane never opened." */
  function hasSeenUsagePane(): boolean {
    return sawUsagePane;
  }

  function reset(): void {
    buffer = '';
    snapshot = null;
    sawUsagePane = false;
  }

  return { ingest, getSnapshot, hasSeenUsagePane, reset };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run electron/planUsageScraper.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/planUsageScraper.ts electron/planUsageScraper.test.ts
git commit -m "feat: add planUsageScraper (tier + per-model week inference)"
```

---

### Task 5: Add `runPlanUsageSync` (pure quiescence-polling function)

**Files:**
- Create: `electron/planUsageSync.ts`
- Test: `electron/planUsageSync.test.ts`

**Interfaces:**
- Consumes: `PlanUsageTier`, `PlanUsageSyncResult` (Task 1, `../src/state/types`).
- Produces: `runPlanUsageSync(deps: PlanUsageSyncDeps): Promise<PlanUsageSyncResult>`, where `PlanUsageSyncDeps` is `{ write: (input: string) => void; getSnapshot: () => PlanUsageTier | null; hasSeenUsagePane: () => boolean; reset: () => void; sleep: (ms: number) => Promise<void>; now: () => number }` — consumed by Task 7 (main.ts's `plan:sync` handler).

This is the polling loop, extracted into a pure function that takes its clock and pty-access as injected dependencies — exactly `ptyLifecycle.ts`'s own precedent for keeping tricky logic testable without Electron or real timers. All four tests below run with a hand-controlled fake clock, no `vi.useFakeTimers()` needed, and no real waiting.

- [ ] **Step 1: Write the failing tests**

Create `electron/planUsageSync.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { runPlanUsageSync } from './planUsageSync';

function makeClock(startMs: number) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('runPlanUsageSync', () => {
  it('writes /usage, waits for quiescence (>=2000ms with no new capture), then Escapes and returns the settled snapshot', async () => {
    const clock = makeClock(0);
    const writes: string[] = [];
    let calls = 0;
    const result = await runPlanUsageSync({
      write: (s) => writes.push(s),
      getSnapshot: () => {
        calls += 1;
        // First call computes `before` -- must be null so a later capture reads as fresh.
        return calls === 1 ? null : { tier: 'max' as const, weekModel: { pct: 52 }, capturedAtMs: 250 };
      },
      hasSeenUsagePane: () => true,
      reset: () => {},
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(writes).toEqual(['/usage\r', '\x1b']);
    expect(result).toEqual({ ok: true, tier: 'max', weekModel: { pct: 52 }, capturedAtMs: 250 });
    // 9 polls of 250ms to accumulate 2000ms of no-change after the capture lands at t=250.
    expect(clock.now()).toBe(2250);
  });

  it('returns ok:false when the /usage pane never renders (e.g. no claude session in this pty)', async () => {
    const clock = makeClock(0);
    const writes: string[] = [];
    let resetCalled = false;
    const result = await runPlanUsageSync({
      write: (s) => writes.push(s),
      getSnapshot: () => null,
      hasSeenUsagePane: () => false,
      reset: () => {
        resetCalled = true;
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({ ok: false, error: 'could not read /usage' });
    expect(writes).toEqual(['/usage\r', '\x1b']);
    expect(resetCalled).toBe(true);
    expect(clock.now()).toBe(10000); // ran the full deadline
  });

  it('returns tier: "pro" when the pane settles with no model line, but hasSeenUsagePane confirms it opened', async () => {
    const clock = makeClock(0);
    let resetCalled = false;
    const result = await runPlanUsageSync({
      write: () => {},
      getSnapshot: () => null, // Pro: scraper never sets a snapshot (no model line ever appears)
      hasSeenUsagePane: () => true, // but "Current session..." did render
      reset: () => {
        resetCalled = true;
      },
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({ ok: true, tier: 'pro', weekModel: null, capturedAtMs: 10000 });
    expect(resetCalled).toBe(true);
  });

  it('returns the last-captured snapshot at the 10s deadline when quiescence is never reached (value keeps changing)', async () => {
    const clock = makeClock(0);
    const writes: string[] = [];
    const result = await runPlanUsageSync({
      write: (s) => writes.push(s),
      getSnapshot: () => ({ tier: 'max' as const, weekModel: { pct: 10 }, capturedAtMs: clock.now() }),
      hasSeenUsagePane: () => true,
      reset: () => {},
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({ ok: true, tier: 'max', weekModel: { pct: 10 }, capturedAtMs: 10000 });
    expect(writes).toEqual(['/usage\r', '\x1b']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run electron/planUsageSync.test.ts`
Expected: FAIL — `./planUsageSync` does not exist yet

- [ ] **Step 3: Implement `planUsageSync.ts`**

Create `electron/planUsageSync.ts`:

```typescript
import type { PlanUsageTier, PlanUsageSyncResult } from '../src/state/types';

export interface PlanUsageSyncDeps {
  write: (input: string) => void;
  getSnapshot: () => PlanUsageTier | null;
  hasSeenUsagePane: () => boolean;
  reset: () => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

// Same quiescence rule as TokenMonitor's plan:sync (src/main/main.js) and for
// the same reason: /usage repaints an unsettled frame before the model line
// (if any) renders, so a fresh parse alone is not enough signal to Esc.
export async function runPlanUsageSync(deps: PlanUsageSyncDeps): Promise<PlanUsageSyncResult> {
  const before = deps.getSnapshot()?.capturedAtMs ?? 0;
  deps.write('/usage\r');

  const deadline = deps.now() + 10000;
  let lastCapturedAt = before;
  let lastChangeAt: number | null = null;
  let sawAnyFreshParse = false;

  while (deps.now() < deadline) {
    await deps.sleep(250);
    const snap = deps.getSnapshot();
    const capturedAt = snap?.capturedAtMs ?? 0;
    if (capturedAt > before) {
      sawAnyFreshParse = true;
      if (capturedAt !== lastCapturedAt) {
        lastCapturedAt = capturedAt;
        lastChangeAt = deps.now();
      } else if (lastChangeAt !== null && deps.now() - lastChangeAt >= 2000) {
        deps.write('\x1b');
        return { ok: true, tier: snap!.tier, weekModel: snap!.weekModel, capturedAtMs: snap!.capturedAtMs };
      }
    }
  }

  deps.write('\x1b');
  if (sawAnyFreshParse) {
    const snap = deps.getSnapshot()!;
    return { ok: true, tier: snap.tier, weekModel: snap.weekModel, capturedAtMs: snap.capturedAtMs };
  }

  // Deadline hit with no model line ever seen. Distinguish "confirmed Pro"
  // from "the pane never opened at all" (claude not running in this pty,
  // wrong shell, etc.) using the liveness flag.
  const confirmedPro = deps.hasSeenUsagePane();
  deps.reset(); // clears the buffer AND the liveness flag for the next sync
  if (confirmedPro) return { ok: true, tier: 'pro', weekModel: null, capturedAtMs: deps.now() };
  return { ok: false, error: 'could not read /usage' };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run electron/planUsageSync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/planUsageSync.ts electron/planUsageSync.test.ts
git commit -m "feat: add runPlanUsageSync, a pure quiescence-polling function"
```

---

### Task 6: Wire `planUsageScraper` into the Terminal pty's data path

**Files:**
- Modify: `electron/main.ts`

**Interfaces:**
- Consumes: `createPlanUsageScraper` (Task 4, `./planUsageScraper`).
- Produces: a module-level `planUsageScraper` instance in `main.ts`, consumed by Task 7 (`plan:sync` handler).

Per Global Constraints, `main.ts` is not unit-testable in this repo. Verification is `npx tsc -b` plus the Task 11 manual checklist.

- [ ] **Step 1: Add the import**

In `electron/main.ts`, add near the existing `import { spawnPty } from './ptyManager';` (line 6):

```typescript
import { createPlanUsageScraper } from './planUsageScraper';
```

- [ ] **Step 2: Add the module-level scraper instance**

In `electron/main.ts`, add right after `const ptyLifecycle = new PtyLifecycle();` (line 901):

```typescript
const planUsageScraper = createPlanUsageScraper();
```

- [ ] **Step 3: Feed the scraper from the existing `pty:start` handler**

In `electron/main.ts`, modify the existing `pty:start` handler (lines 903-918) from:

```typescript
ipcMain.handle('pty:start', (event, { cols, rows }: { cols: number; rows: number }) => {
  const sender = event.sender;
  ptyLifecycle.start(() => spawnPty(cols, rows), {
    onData: (data) => {
      if (!sender.isDestroyed()) sender.send('pty:data', data);
    },
    onAlive: () => sendToWindow('pty:alive', undefined),
    onExit: () => sendToWindow('pty:exit', undefined),
  });
  liveAgentTracker.notifyPtySpawned(Date.now());
});
```

to:

```typescript
ipcMain.handle('pty:start', (event, { cols, rows }: { cols: number; rows: number }) => {
  const sender = event.sender;
  ptyLifecycle.start(() => spawnPty(cols, rows), {
    onData: (data) => {
      if (!sender.isDestroyed()) sender.send('pty:data', data);
      planUsageScraper.ingest(data);
    },
    onAlive: () => sendToWindow('pty:alive', undefined),
    onExit: () => {
      sendToWindow('pty:exit', undefined);
      planUsageScraper.reset(); // a new pty means a fresh /usage read next time
    },
  });
  liveAgentTracker.notifyPtySpawned(Date.now());
});
```

- [ ] **Step 4: Run `tsc -b` to confirm the wiring compiles**

Run: `npx tsc -b`
Expected: PASS

- [ ] **Step 5: Run the full test suite to confirm nothing else broke**

Run: `npx vitest run`
Expected: PASS (all files, including the ones from Tasks 1-5)

- [ ] **Step 6: Commit**

```bash
git add electron/main.ts
git commit -m "feat: feed the Terminal pty's data path into planUsageScraper"
```

---

### Task 7: Add the `plan:sync` IPC handler

**Files:**
- Modify: `electron/main.ts`

**Interfaces:**
- Consumes: `runPlanUsageSync` (Task 5, `./planUsageSync`), `planUsageScraper`/`ptyLifecycle` (module-level instances from Task 6 and the pre-existing `ptyLifecycle`).
- Produces: IPC handler `plan:sync` returning `Promise<PlanUsageSyncResult>`, consumed by Task 8 (preload.ts).

- [ ] **Step 1: Add the import**

In `electron/main.ts`, add alongside the `createPlanUsageScraper` import from Task 6:

```typescript
import { runPlanUsageSync } from './planUsageSync';
```

- [ ] **Step 2: Add the handler**

In `electron/main.ts`, add right after the existing `pty:resize` handler (after line 926, before the codex pty section):

```typescript
ipcMain.handle('plan:sync', async () => {
  if (!ptyLifecycle.current) return { ok: false, error: 'no terminal' };
  return runPlanUsageSync({
    write: (input) => ptyLifecycle.write(input),
    getSnapshot: () => planUsageScraper.getSnapshot(),
    hasSeenUsagePane: () => planUsageScraper.hasSeenUsagePane(),
    reset: () => planUsageScraper.reset(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  });
});
```

- [ ] **Step 3: Run `tsc -b` to confirm the wiring compiles**

Run: `npx tsc -b`
Expected: PASS

- [ ] **Step 4: Run the full test suite to confirm nothing else broke**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts
git commit -m "feat: add plan:sync IPC handler"
```

---

### Task 8: Expose `plan.sync()` through preload

**Files:**
- Modify: `src/aetherElectron.d.ts`
- Modify: `electron/preload.ts`

**Interfaces:**
- Consumes: `PlanUsageSyncResult` (Task 1, `src/state/types.ts` / `../src/state/types`).
- Produces: `window.aetherElectron.plan.sync(): Promise<PlanUsageSyncResult>`, consumed by Task 9 (`PlanUsageCard.tsx`).

No test file exists for `preload.ts` or `aetherElectron.d.ts` anywhere in this repo (checked) — matches Global Constraints. Verification is `npx tsc -b`.

- [ ] **Step 1: Add the type import and `plan` namespace to `aetherElectron.d.ts`**

In `src/aetherElectron.d.ts`, add to the existing import block at the top:

```typescript
import type { PlanUsageSyncResult } from './state/types';
```

Add to the `aetherElectron` interface, right after the `pty: { ... }` block:

```typescript
      plan: {
        sync: () => Promise<PlanUsageSyncResult>;
      };
```

- [ ] **Step 2: Add the import and implementation to `preload.ts`**

In `electron/preload.ts`, add to the existing import block at the top:

```typescript
import type { PlanUsageSyncResult } from '../src/state/types';
```

Add to the object passed to `contextBridge.exposeInMainWorld('aetherElectron', {...})`, right after the `pty: { ... }` block:

```typescript
  plan: {
    sync: (): Promise<PlanUsageSyncResult> => ipcRenderer.invoke('plan:sync'),
  },
```

- [ ] **Step 3: Run `tsc -b` to confirm both files compile**

Run: `npx tsc -b`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/aetherElectron.d.ts electron/preload.ts
git commit -m "feat: expose window.aetherElectron.plan.sync()"
```

---

### Task 9: Add `PlanUsageCard`

**Files:**
- Create: `src/components/terminal/PlanUsageCard.tsx`
- Test: `src/components/terminal/PlanUsageCard.test.tsx`

**Interfaces:**
- Consumes: `state.statusline` (existing), `state.planUsageTier`/`SET_PLAN_USAGE_TIER` (Task 1, 2), `window.aetherElectron.plan.sync()` (Task 8), `deriveDepletion`/`formatResetCountdown`/`STATUSLINE_STALE_AFTER_MS` (existing, `src/shared/depletion.ts`).
- Produces: `PlanUsageCard` React component, consumed by Task 10 (`TerminalView.tsx`).

- [ ] **Step 1: Write the failing component tests**

Create `src/components/terminal/PlanUsageCard.test.tsx`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { PlanUsageCard } from './PlanUsageCard';
import type { AetherState } from '../../state/types';

afterEach(() => {
  cleanup();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

function Setter({ patch }: { patch: Partial<AetherState> }) {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    if (patch.terminalAlive !== undefined) dispatch({ type: 'SET_TERMINAL_ALIVE', alive: patch.terminalAlive });
    if (patch.planUsageTier !== undefined && patch.planUsageTier !== null) {
      dispatch({ type: 'SET_PLAN_USAGE_TIER', snapshot: patch.planUsageTier });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch]);
  return null;
}

function renderWithState(patch: Partial<AetherState> = {}) {
  return render(
    <AetherStoreProvider>
      <Setter patch={patch} />
      <PlanUsageCard />
    </AetherStoreProvider>,
  );
}

describe('PlanUsageCard', () => {
  it('shows a "—" tier badge and "never synced" when planUsageTier is null', () => {
    renderWithState({ terminalAlive: true });
    expect(screen.getByText('PLAN USAGE')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText(/never synced/)).toBeTruthy();
  });

  it('shows "no reading yet" for Session/Week bars when statusline is null', () => {
    renderWithState({ terminalAlive: true });
    expect(screen.getAllByText('no reading yet').length).toBeGreaterThanOrEqual(2);
  });

  it('shows the PRO tier badge and no model bar after a successful Pro sync', () => {
    renderWithState({ terminalAlive: true, planUsageTier: { tier: 'pro', weekModel: null, capturedAtMs: Date.now() } });
    expect(screen.getByText('PRO')).toBeTruthy();
    expect(screen.queryByText('WEEK (MODEL)')).toBeNull();
  });

  it('shows the MAX tier badge and the model bar after a successful Max sync', () => {
    renderWithState({ terminalAlive: true, planUsageTier: { tier: 'max', weekModel: { pct: 52 }, capturedAtMs: Date.now() } });
    expect(screen.getByText('MAX')).toBeTruthy();
    expect(screen.getByText('WEEK (MODEL)')).toBeTruthy();
    expect(screen.getByText('52%')).toBeTruthy();
  });

  it('disables the Sync button when the Terminal pty is not alive', () => {
    renderWithState({ terminalAlive: false });
    expect(screen.getByText('Sync').closest('button')).toBeDisabled();
  });

  it('clicking Sync calls window.aetherElectron.plan.sync() and dispatches the result on success', async () => {
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      plan: {
        sync: vi.fn().mockResolvedValue({ ok: true, tier: 'max', weekModel: { pct: 61 }, capturedAtMs: Date.now() }),
      },
    };
    renderWithState({ terminalAlive: true });
    fireEvent.click(screen.getByText('Sync'));
    await waitFor(() => expect(screen.getByText('MAX')).toBeTruthy());
    expect(screen.getByText('61%')).toBeTruthy();
  });

  it('shows "last sync failed" and keeps the last-good snapshot on a failed sync', async () => {
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      plan: { sync: vi.fn().mockResolvedValue({ ok: false, error: 'could not read /usage' }) },
    };
    renderWithState({ terminalAlive: true, planUsageTier: { tier: 'pro', weekModel: null, capturedAtMs: Date.now() } });
    fireEvent.click(screen.getByText('Sync'));
    await waitFor(() => expect(screen.getByText(/last sync failed/)).toBeTruthy());
    expect(screen.getByText('PRO')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/terminal/PlanUsageCard.test.tsx`
Expected: FAIL — `./PlanUsageCard` does not exist yet

- [ ] **Step 3: Check `SET_TERMINAL_ALIVE`'s exact action shape before implementing the test's Setter**

Run: `grep -n "SET_TERMINAL_ALIVE" src/state/reducer.ts`
Expected: confirms `{ type: 'SET_TERMINAL_ALIVE'; alive: boolean }` — the shape already assumed in Step 1's `Setter` component above. If the actual field name differs, fix the `Setter` component in the test file to match before proceeding.

- [ ] **Step 4: Implement `PlanUsageCard.tsx`**

Create `src/components/terminal/PlanUsageCard.tsx`:

```tsx
import { useEffect, useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { deriveDepletion, formatResetCountdown, STATUSLINE_STALE_AFTER_MS } from '../../shared/depletion';

export function PlanUsageCard() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const [now, setNow] = useState(() => Date.now());
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'failed'>('idle');

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  async function handleSync() {
    if (syncState === 'syncing' || !state.terminalAlive) return;
    setSyncState('syncing');
    try {
      const res = await window.aetherElectron?.plan.sync();
      if (res?.ok) {
        dispatch({
          type: 'SET_PLAN_USAGE_TIER',
          snapshot: { tier: res.tier!, weekModel: res.weekModel ?? null, capturedAtMs: res.capturedAtMs! },
        });
        setSyncState('idle');
      } else {
        setSyncState('failed');
      }
    } catch {
      setSyncState('failed');
    }
  }

  const session = deriveDepletion(state.statusline, null, now);
  const sevenDay = state.statusline?.sevenDay ?? null;
  const weekStale = state.statusline ? now - state.statusline.capturedAtMs > STATUSLINE_STALE_AFTER_MS : false;

  const tier = state.planUsageTier;
  const tierLabel = tier ? (tier.tier === 'max' ? 'MAX' : 'PRO') : '—';
  const freshnessLabel = !tier
    ? 'never synced — press Sync'
    : `as of ${fmtAgeMinutes(now - tier.capturedAtMs)}${syncState === 'failed' ? ' · last sync failed' : ''}`;

  return (
    <div style={cardStyle(colors)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={titleStyle(colors)}>PLAN USAGE</div>
          <span style={tierBadgeStyle(colors, tier?.tier ?? null)}>{tierLabel}</span>
        </div>
        <Button onClick={handleSync} disabled={!state.terminalAlive || syncState === 'syncing'} style={syncButtonStyle(colors)}>
          {syncState === 'syncing' ? 'Syncing…' : 'Sync'}
        </Button>
      </div>

      <div style={{ marginTop: 12 }}>
        <UsageBar
          label="SESSION (5H)"
          pct={session.usedPercentage}
          resetLabel={session.usedPercentage === null ? 'awaiting the first statusline reading' : `resets ${formatResetCountdown(session.msUntilReset)}`}
          stale={session.stale}
          available={session.usedPercentage !== null}
        />
        <UsageBar
          label="WEEK (7D)"
          pct={sevenDay?.usedPercentage ?? null}
          resetLabel={sevenDay ? `resets ${formatResetCountdown(sevenDay.resetsAtMs - now)}` : 'awaiting the first statusline reading'}
          stale={weekStale}
          available={sevenDay !== null}
        />
        {tier?.weekModel && (
          <UsageBar label="WEEK (MODEL)" pct={tier.weekModel.pct} resetLabel={freshnessLabel} stale={syncState === 'failed'} available={true} />
        )}
      </div>

      {!tier?.weekModel && <div style={{ font: `400 10px/1.3 ${fonts.mono}`, color: colors.textDim, marginTop: 2 }}>{freshnessLabel}</div>}
    </div>
  );
}

function fmtAgeMinutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  return m <= 0 ? 'just now' : `${m}m ago`;
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return { flex: 'none', padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function tierBadgeStyle(colors: ColorPalette, tier: 'pro' | 'max' | null): CSSProperties {
  return {
    font: `700 9px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: tier === 'max' ? colors.accentCyanSoft : colors.textMuted,
    border: `1px solid ${colors.chipBorder}`,
    padding: '2px 6px',
    borderRadius: 4,
  };
}
function syncButtonStyle(colors: ColorPalette): CSSProperties {
  return {
    cursor: 'pointer',
    font: `600 10px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: colors.accentCyanSoft,
    padding: '4px 8px',
    border: `1px solid ${colors.chipBorder}`,
    borderRadius: 6,
  };
}

function UsageBar({
  label,
  pct,
  resetLabel,
  stale,
  available,
}: {
  label: string;
  pct: number | null;
  resetLabel: string;
  stale: boolean;
  available: boolean;
}) {
  const colors = useColors();
  if (!available || pct === null) {
    return (
      <div style={{ marginBottom: 10 }}>
        <div style={{ font: `600 10px/1 ${fonts.ui}`, letterSpacing: 1, color: colors.textMuted }}>{label}</div>
        <div style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, marginTop: 4 }}>no reading yet</div>
      </div>
    );
  }
  const clamped = Math.min(100, Math.max(0, Math.round(pct)));
  const warn = clamped >= 78;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ font: `600 10px/1 ${fonts.ui}`, letterSpacing: 1, color: colors.textMuted }}>{label}</span>
        <span style={{ font: `700 12px/1 ${fonts.mono}`, color: warn ? colors.warn : colors.textBody }}>
          {clamped}%{stale ? ' (stale)' : ''}
        </span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: 'rgba(20,50,64,.7)', overflow: 'hidden', marginTop: 4 }}>
        <div style={{ height: '100%', width: `${clamped}%`, background: warn ? colors.warn : colors.accentCyanDeep }} />
      </div>
      <div style={{ font: `400 9px/1 ${fonts.mono}`, color: colors.textDim, marginTop: 3 }}>{resetLabel}</div>
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/components/terminal/PlanUsageCard.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/terminal/PlanUsageCard.tsx src/components/terminal/PlanUsageCard.test.tsx
git commit -m "feat: add PlanUsageCard component"
```

---

### Task 10: Wire `PlanUsageCard` into `TerminalView`'s rail

**Files:**
- Modify: `src/components/terminal/TerminalView.tsx`

**Interfaces:**
- Consumes: `PlanUsageCard` (Task 9).

- [ ] **Step 1: Add the import**

In `src/components/terminal/TerminalView.tsx`, add:

```typescript
import { PlanUsageCard } from './PlanUsageCard';
```

- [ ] **Step 2: Add the component to the rail**

In `src/components/terminal/TerminalView.tsx`, change:

```tsx
      <div style={railStyle}>
        <ActiveAgentsCard />
        <LiveOutputCard />
      </div>
```

to:

```tsx
      <div style={railStyle}>
        <PlanUsageCard />
        <ActiveAgentsCard />
        <LiveOutputCard />
      </div>
```

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: PASS (all files)

- [ ] **Step 4: Run `tsc -b`**

Run: `npx tsc -b`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/terminal/TerminalView.tsx
git commit -m "feat: add PlanUsageCard to TerminalView's rail"
```

---

### Task 11: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, all files (should include every new test file from Tasks 1-10 plus the full pre-existing suite, 1251+ tests)

- [ ] **Step 2: Run the full type check**

Run: `npx tsc -b`
Expected: PASS, no errors

- [ ] **Step 3: Manual verification (hand this checklist to the user — do not attempt an automated Electron launch)**

This session already hit an Electron-launch dead end earlier today: driving `electron:build`'s output via Playwright's `_electron` launcher crashed on this machine for reasons unrelated to app code (the same class of environment issue noted in this project's own GPU/sandbox history), and the fastest path to a real answer was the user launching the app themselves rather than continuing to debug the launcher. Do the same here — do not spend time standing up an automated Electron/Playwright launch for this checklist. Ask the user to run `npm run electron:dev` and walk through:

1. Open the Terminal tab (pty becomes alive) — Sync button enables.
2. Click Sync with a real Pro-tier `claude` session running; confirm the tier badge shows "PRO", no model bar, and the freshness line updates.
3. (If a Max account is available) confirm the tier badge shows "MAX" and the model bar appears with a real percentage.
4. Confirm Session/Week bars update live (independent of Sync) as `state.statusline` pushes new snapshots.
5. Close the Terminal tab's pty (or never open it) — confirm the Sync button is disabled.
6. Restart the app after a successful sync — confirm the tier badge and freshness line survive (persisted), while Session/Week bars correctly show "no reading yet" until the first fresh statusline snapshot of the new session arrives.

- [ ] **Step 4: Commit any final fixes found during manual verification, then confirm a clean tree**

Run: `git status -sb`
Expected: clean (nothing to commit) once all of Tasks 1-10's commits are in place and any manual-verification fixes are committed individually with their own descriptive messages (do not batch them into this step).
