# Real Live Output (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `state.logs`'s only producer (`tick.ts`'s `Math.random()` pick from a hardcoded `LOG_MESSAGES` pool) with three real event kinds — dispatch started, dispatch completed (with real token/tool-use/duration usage), dispatch channel opened — and make `LiveOutputCard` show an honest idle state instead of an always-on "STREAMING" badge.

**Architecture:** A new pure function `detectStartedDispatches` (symmetric to the existing `detectCompletedDispatches`) in `src/state/liveAgentsMath.ts`; three reducer case bodies in `src/state/reducer.ts` (`SET_REAL_AGENTS`, `RECORD_DISPATCH_USAGE`, `CREATE_DISPATCH_CHANNEL`) gain a `logs` write sourced from data they already receive; `src/state/tick.ts` loses its only two `state.logs` writers; `LiveOutputCard.tsx` gains an empty/idle state matching `ActiveAgentsCard.tsx`'s established convention.

**Tech Stack:** No new dependencies — pure renderer-side state/reducer logic and one presentational component, like Memory's Phase 3 slice 5.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-24-real-live-output-phase4.md` — every requirement below is copied verbatim from it.
- Baseline (confirmed by running `npm test -- --run` before this plan was written): **356 passing tests across 29 files**, `tsc -b` clean.
- **Do not touch `state.notifs`/`state.approvals`/`APPROVAL_POOL`** — the fictional approval/notification simulation stays exactly as-is; only `state.logs`'s writers change.
- **Do not add a log line for plain dispatch completion inside `SET_REAL_AGENTS`** — only `RECORD_DISPATCH_USAGE` emits the "completed" line (it alone carries real usage numbers). This is a deliberate, spec'd decision, not an oversight — see the spec's Context section on independent pipelines.
- **No `state.activeWork` (tool-use-level) log lines this phase** — explicit non-goal.
- The repo's working tree has pre-existing, unrelated uncommitted changes (confirmed via `git status` before this plan was written — modifications to `electron/activeSessionFinder.ts`, `electron/liveAgentTracker.ts`, `electron/main.ts`, `electron/preload.ts`, `src/aetherElectron.d.ts`, `src/components/grid/*`, `src/state/initialState.ts`, `src/state/liveAgentsMath.ts`, `src/state/liveAgentsMath.test.ts`, `src/state/reducer.ts`, `src/state/types.ts`, plus untracked `src/state/projectDirName.ts`/`.test.ts` and some stray `.jpg` files). **Every `git add` in this plan lists exact file paths, never `-A`/`.`** — do not stage or commit any file not explicitly named in a task's commit step, and do not let this plan's edits to shared files (`liveAgentsMath.ts`, `reducer.ts`, `types.ts`) clobber whatever the pre-existing uncommitted changes were doing to those same files. **Before Task 1's first step, re-run `git status` and `git diff` on `src/state/liveAgentsMath.ts` and `src/state/reducer.ts` specifically** — if the pre-existing uncommitted diff already touches the exact functions/cases this plan modifies, stop and flag it to the user rather than guessing how to merge; if it touches unrelated parts of those files, proceed and simply preserve those unrelated pre-existing hunks (don't revert them).

---

### Task 1: `detectStartedDispatches` pure function

**Files:**
- Modify: `src/state/liveAgentsMath.ts`
- Test: `src/state/liveAgentsMath.test.ts`

**Interfaces:**
- Produces: `detectStartedDispatches(oldAgents: RealAgentDispatch[], newAgents: RealAgentDispatch[]): RealAgentDispatch[]` — consumed by Task 2's `SET_REAL_AGENTS` reducer case.

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `src/state/liveAgentsMath.test.ts`, placed immediately after the existing `describe('detectCompletedDispatches', ...)` block (around line 191, before `describe('applyLinesToOpenDispatches — completedOut parameter', ...)`):

```ts
describe('detectStartedDispatches', () => {
  const tu1: RealAgentDispatch = {
    toolUseId: 'tu_1',
    subagentType: 'general-purpose',
    description: 'first',
    startedAt: '2026-07-20T10:00:00.000Z',
    prompt: '',
    model: null,
  };
  const tu2: RealAgentDispatch = {
    toolUseId: 'tu_2',
    subagentType: 'Explore',
    description: 'second',
    startedAt: '2026-07-20T10:00:05.000Z',
    prompt: '',
    model: null,
  };

  it('returns an empty array when the two lists are identical', () => {
    expect(detectStartedDispatches([tu1, tu2], [tu1, tu2])).toEqual([]);
  });

  it('returns the one dispatch that newly appeared', () => {
    expect(detectStartedDispatches([tu1], [tu1, tu2])).toEqual([tu2]);
  });

  it('returns multiple dispatches when several appear at once', () => {
    expect(detectStartedDispatches([], [tu1, tu2])).toEqual([tu1, tu2]);
  });

  it('returns an empty array when a dispatch is only removed, not added', () => {
    expect(detectStartedDispatches([tu1, tu2], [tu1])).toEqual([]);
  });

  it('separates a simultaneous add and remove correctly', () => {
    expect(detectStartedDispatches([tu1], [tu2])).toEqual([tu2]);
  });
});
```

Also add `detectStartedDispatches` to this test file's existing import from `./liveAgentsMath` (the import block starting at line 2, which already imports `detectCompletedDispatches`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/state/liveAgentsMath.test.ts`
Expected: FAIL — `detectStartedDispatches is not exported` / `is not defined`.

- [ ] **Step 3: Implement `detectStartedDispatches`**

In `src/state/liveAgentsMath.ts`, add this function immediately after the existing `detectCompletedDispatches` function (currently ending at line 77):

```ts
export function detectStartedDispatches(oldAgents: RealAgentDispatch[], newAgents: RealAgentDispatch[]): RealAgentDispatch[] {
  const wasOpen = new Set(oldAgents.map((a) => a.toolUseId));
  return newAgents.filter((a) => !wasOpen.has(a.toolUseId));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/state/liveAgentsMath.test.ts`
Expected: PASS, all tests in the file including the 5 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/state/liveAgentsMath.ts src/state/liveAgentsMath.test.ts
git commit -m "feat: add detectStartedDispatches, symmetric to detectCompletedDispatches"
```

---

### Task 2: Real log lines in the reducer

**Files:**
- Modify: `src/state/reducer.ts`
- Test: `src/state/reducer.test.ts`

**Interfaces:**
- Consumes: `detectStartedDispatches` (Task 1).
- Produces: `SET_REAL_AGENTS`, `RECORD_DISPATCH_USAGE`, and `CREATE_DISPATCH_CHANNEL` now each append to `state.logs` (shape unchanged: `{ t: string; m: string; c: string }`, capped `.slice(-14)`, matching the cap `tick.ts`'s removed code used) — consumed by Task 4's `LiveOutputCard.tsx` (already reads `state.logs`, no interface change needed there) and already-existing `LogFrequencyCard`/`Analytics` (no change needed — same `logs` shape, same color palette).

- [ ] **Step 1: Update reducer.ts's imports**

Change line 2 from:

```ts
import { detectCompletedDispatches, type CompletedDispatchUsage, type RealAgentDispatch, type RealActiveWork } from './liveAgentsMath';
```

to:

```ts
import { detectCompletedDispatches, detectStartedDispatches, type CompletedDispatchUsage, type RealAgentDispatch, type RealActiveWork } from './liveAgentsMath';
```

Change line 5 from:

```ts
import { nowShort } from '../utils/format';
```

to:

```ts
import { nowShort, nowLong, short, fmtElapsed } from '../utils/format';
```

- [ ] **Step 2: Write the failing tests**

Add these test cases to `src/state/reducer.test.ts`. First, inside the existing `describe('SET_REAL_AGENTS pool and auto-create', ...)` block (after the last `it` block, before its closing `});` at line 290), add:

```ts
    it('appends a log line for a newly-started dispatch', () => {
      const next = reducer(initialState, { type: 'SET_REAL_AGENTS', agents: [completedDispatch] });
      const last = next.logs.at(-1);
      expect(last?.m).toBe('general-purpose: Explore the repo');
      expect(last?.c).toBe('#7fd8ef');
    });

    it('appends no log line when nothing started or completed', () => {
      const withOpenDispatch = { ...initialState, realAgents: [completedDispatch] };
      const next = reducer(withOpenDispatch, { type: 'SET_REAL_AGENTS', agents: [completedDispatch] });
      expect(next.logs).toEqual(withOpenDispatch.logs);
    });

    it('appends a log line when auto-creating a dispatch channel', () => {
      const withAutoCreate = { ...initialState, cfg: { ...initialState.cfg, autoCreateDispatchChannels: true }, realAgents: [completedDispatch] };
      const next = reducer(withAutoCreate, { type: 'SET_REAL_AGENTS', agents: [] });
      const last = next.logs.at(-1);
      expect(last?.m).toBe('general-purpose: dispatch channel opened');
      expect(last?.c).toBe('#7fd8ef');
    });
```

Next, inside the existing `describe('CREATE_DISPATCH_CHANNEL', ...)` block (after the last `it` block, before its closing `});` at line 334), add:

```ts
    it('appends a log line when a channel is created', () => {
      const withPool = { ...initialState, recentCompletedDispatches: [pooled] };
      const next = reducer(withPool, { type: 'CREATE_DISPATCH_CHANNEL', toolUseId: 'tu_2' });
      const last = next.logs.at(-1);
      expect(last?.m).toBe('Explore: dispatch channel opened');
      expect(last?.c).toBe('#7fd8ef');
    });
```

Finally, inside the existing `describe('RECORD_DISPATCH_USAGE', ...)` block (after the last `it` block, before its closing `});` at line 406), add:

```ts
    it('appends a log line with real usage figures', () => {
      const next = reducer(initialState, {
        type: 'RECORD_DISPATCH_USAGE',
        completed: [
          {
            toolUseId: 'tu_1',
            subagentType: 'general-purpose',
            description: 'desc',
            startedAt: '2026-07-20T10:00:00.000Z',
            prompt: '',
            model: null,
            tokens: 12500,
            toolUses: 5,
            durationMs: 8000,
          },
        ],
      });
      const last = next.logs.at(-1);
      expect(last?.m).toBe('general-purpose: 12.5K tok · 5 tool calls · 8s');
      expect(last?.c).toBe('#3be0a0');
    });

    it('uses singular "tool call" for exactly one tool use', () => {
      const next = reducer(initialState, {
        type: 'RECORD_DISPATCH_USAGE',
        completed: [
          { toolUseId: 'tu_1', subagentType: 'a', description: '', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null, tokens: 1, toolUses: 1, durationMs: 1000 },
        ],
      });
      expect(next.logs.at(-1)?.m).toBe('a: 1 tok · 1 tool call · 1s');
    });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/state/reducer.test.ts`
Expected: FAIL — the new assertions on `next.logs` fail (empty/unchanged `logs`), since the reducer doesn't write to `logs` in these cases yet.

- [ ] **Step 4: Implement the three reducer case changes**

Replace the `SET_REAL_AGENTS` case body with:

```ts
    case 'SET_REAL_AGENTS': {
      const completed = detectCompletedDispatches(state.realAgents, action.agents);
      const started = detectStartedDispatches(state.realAgents, action.agents);
      let memories = state.memories;
      let memSeq = state.memSeq;
      let recentCompletedDispatches = state.recentCompletedDispatches;
      let dispatchChannels = state.dispatchChannels;
      let logs = state.logs;

      for (const dispatch of started) {
        logs = logs.concat({ t: nowLong(), m: `${dispatch.subagentType}: ${dispatch.description || 'dispatch started'}`, c: '#7fd8ef' }).slice(-14);
      }

      for (const dispatch of completed) {
        const label = dispatch.description || dispatch.subagentType;
        memories = [
          ...memories,
          {
            id: memSeq,
            name: label,
            content: `${dispatch.subagentType} dispatch completed: ${dispatch.description || 'no description'}`,
            source: dispatch.subagentType,
            ts: nowShort(),
            pinned: false,
            strength: 100,
            toolUseId: dispatch.toolUseId,
          },
        ];
        memSeq += 1;

        recentCompletedDispatches = [dispatch, ...recentCompletedDispatches].slice(0, 20);

        if (state.cfg.autoCreateDispatchChannels && !dispatchChannels.some((d) => d.toolUseId === dispatch.toolUseId)) {
          dispatchChannels = [
            ...dispatchChannels,
            {
              toolUseId: dispatch.toolUseId,
              subagentType: dispatch.subagentType,
              description: dispatch.description,
              prompt: dispatch.prompt,
              model: dispatch.model,
              startedAt: dispatch.startedAt,
              createdAt: nowShort(),
            },
          ];
          logs = logs.concat({ t: nowLong(), m: `${dispatch.subagentType}: dispatch channel opened`, c: '#7fd8ef' }).slice(-14);
        }
      }
      return { ...state, realAgents: action.agents, memories, memSeq, recentCompletedDispatches, dispatchChannels, logs };
    }
```

Replace the `RECORD_DISPATCH_USAGE` case body with:

```ts
    case 'RECORD_DISPATCH_USAGE': {
      let dispatchUsage = state.dispatchUsage;
      let logs = state.logs;
      for (const c of action.completed) {
        dispatchUsage = { ...dispatchUsage, [c.toolUseId]: { tokens: c.tokens, toolUses: c.toolUses, durationMs: c.durationMs } };
        logs = logs.concat({ t: nowLong(), m: `${c.subagentType}: ${short(c.tokens)} tok · ${c.toolUses} tool call${c.toolUses === 1 ? '' : 's'} · ${fmtElapsed(c.durationMs)}`, c: '#3be0a0' }).slice(-14);
      }
      const keys = Object.keys(dispatchUsage);
      if (keys.length > 100) {
        const toEvict = new Set(keys.slice(0, keys.length - 100));
        dispatchUsage = Object.fromEntries(Object.entries(dispatchUsage).filter(([k]) => !toEvict.has(k)));
      }
      return { ...state, dispatchUsage, logs };
    }
```

Replace the `CREATE_DISPATCH_CHANNEL` case body with:

```ts
    case 'CREATE_DISPATCH_CHANNEL': {
      const alreadyExists = state.dispatchChannels.some((d) => d.toolUseId === action.toolUseId);
      const dispatch = state.recentCompletedDispatches.find((d) => d.toolUseId === action.toolUseId);
      if (alreadyExists || !dispatch) return state;
      const stub: DispatchChannelStub = {
        toolUseId: dispatch.toolUseId,
        subagentType: dispatch.subagentType,
        description: dispatch.description,
        prompt: dispatch.prompt,
        model: dispatch.model,
        startedAt: dispatch.startedAt,
        createdAt: nowShort(),
      };
      const logs = state.logs.concat({ t: nowLong(), m: `${dispatch.subagentType}: dispatch channel opened`, c: '#7fd8ef' }).slice(-14);
      return { ...state, dispatchChannels: [...state.dispatchChannels, stub], logs };
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/state/reducer.test.ts`
Expected: PASS, all tests including the 6 new ones. Verify no pre-existing `SET_REAL_AGENTS`/`RECORD_DISPATCH_USAGE`/`CREATE_DISPATCH_CHANNEL` test broke (they don't assert on `logs`, so they should be unaffected, but confirm).

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/state/reducer.ts src/state/reducer.test.ts
git commit -m "feat: emit real Live Output log lines from dispatch start/completion/channel-open"
```

---

### Task 3: Remove `tick.ts`'s fictional log producers

**Files:**
- Modify: `src/state/tick.ts`
- Test: `src/state/tick.test.ts` (verify only — see Step 1)

**Interfaces:**
- Removes: `LOG_MESSAGES` const; `computeTick`'s `logs` local variable and its two write sites; `logs` from `computeTick`'s returned `Partial<AetherState>`.
- After this task, `computeTick` never reads or writes `state.logs` at all — `TICK`'s reducer case (`{ ...state, ...computeTick(state) }`) leaves `state.logs` completely untouched by ticks, so it only ever changes via Task 2's real-event writers.

- [ ] **Step 1: Confirm no existing test depends on `computeTick`'s `logs` output**

Run: `grep -n logs src/state/tick.test.ts`
Expected: no matches (confirmed during spec-writing; re-verify here in case the pre-existing uncommitted changes on the branch touched this file). If any match is found, stop and read the surrounding test before proceeding — it will need updating to assert `logs` is absent from `computeTick`'s return, not asserting on old random content.

- [ ] **Step 2: Remove the dead `LOG_MESSAGES` const**

Delete lines 4-13 of `src/state/tick.ts` (the entire `const LOG_MESSAGES = [...]` block) and the blank line immediately after it, so the file goes directly from the `import` line to `const APPROVAL_POOL = [...]`.

- [ ] **Step 3: Remove the random log-push block**

Delete these lines (originally 50-54, now shifted up by the Step 2 removal):

```ts
  let logs = state.logs;
  if (Math.random() < 0.3) {
    const msg = LOG_MESSAGES[Math.floor(Math.random() * LOG_MESSAGES.length)];
    logs = logs.concat({ t: nowLong(), m: msg, c: Math.random() < 0.2 ? '#3be0a0' : '#7fd8ef' }).slice(-14);
  }
```

and the blank line immediately after them, so `const memories = ...` is followed directly by `const alarm = state.cfg.alarm;`.

- [ ] **Step 4: Remove the one `logs` write inside the AUTO-mode auto-approval branch**

Change:

```ts
    if (mode === 'AUTO' && req.risk !== 'HIGH') {
      logs = logs.concat({ t: nowLong(), m: `${ag.name}: auto-approved — ${req.action.toLowerCase()}`, c: '#3be0a0' }).slice(-14);
      notifs = [{ t: nowShort(), m: `Auto-approved: ${req.action} (${ag.name})`, c: '#3be0a0' }, ...notifs].slice(0, 12);
      unread += 1;
    } else {
```

to:

```ts
    if (mode === 'AUTO' && req.risk !== 'HIGH') {
      notifs = [{ t: nowShort(), m: `Auto-approved: ${req.action} (${ag.name})`, c: '#3be0a0' }, ...notifs].slice(0, 12);
      unread += 1;
    } else {
```

- [ ] **Step 5: Remove `logs` from the return statement**

Change the final `return` line from:

```ts
  return { rate, used, ctxUsed, weekRaw, agents, sys, logs, alarmLevel: level, notifs, unread, approvals, apprSeq, memories };
```

to:

```ts
  return { rate, used, ctxUsed, weekRaw, agents, sys, alarmLevel: level, notifs, unread, approvals, apprSeq, memories };
```

- [ ] **Step 6: Remove the now-unused `nowLong` import**

Change the top import line from:

```ts
import { nowLong, nowShort } from '../utils/format';
```

to:

```ts
import { nowShort } from '../utils/format';
```

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test -- --run && npx tsc -b`
Expected: 356/356 tests still passing (no test in this file asserted on `logs`, per Step 1's confirmation — if that changed, adjust first), 29 files, 0 type errors. `noUnusedLocals` (this project's established tsconfig setting) would fail the build if `nowLong` or `LOG_MESSAGES` were left referenced anywhere — a clean `tsc -b` here is the proof they weren't.

- [ ] **Step 8: Commit**

```bash
git add src/state/tick.ts
git commit -m "refactor: remove tick.ts's fictional Live Output log producers"
```

---

### Task 4: Honest idle state in `LiveOutputCard`

**Files:**
- Modify: `src/components/terminal/LiveOutputCard.tsx`

**Interfaces:** None — presentational only, reads the same `state.logs` it always has.

- [ ] **Step 1: Replace the component**

Replace the full contents of `src/components/terminal/LiveOutputCard.tsx` with:

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function LiveOutputCard() {
  const { state } = useAetherStore();
  const logs = state.logs.slice(-8);
  const isActive = logs.length > 0;
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flex: 'none' }}>
        <div style={titleStyle}>LIVE OUTPUT</div>
        {isActive ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 10px/1 ${fonts.mono}`, color: colors.accentCyan }}>
            <span style={blinkDotStyle} />
            STREAMING
          </div>
        ) : (
          <div style={{ font: `400 10px/1 ${fonts.mono}`, color: colors.textDim }}>IDLE</div>
        )}
      </div>
      <div style={logListStyle}>
        {logs.map((l, idx) => (
          <div key={idx} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ color: colors.textDim }}>[{l.t}]</span> <span style={{ color: l.c }}>{l.m}</span>
          </div>
        ))}
        {!isActive && <div style={emptyStyle}>no activity yet</div>}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  flex: 'none',
  height: 152,
  padding: '12px 15px',
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
};
const titleStyle: CSSProperties = { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const blinkDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: colors.accentCyan,
  boxShadow: '0 0 8px rgba(126,240,255,.9)',
  animation: 'blink 1.2s step-end infinite',
};
const logListStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
  marginTop: 7,
  font: `400 10.5px/1.7 ${fonts.mono}`,
};
const emptyStyle: CSSProperties = {
  font: `500 12px/1.4 ${fonts.ui}`,
  color: colors.textDim,
  padding: '8px 2px',
};
```

- [ ] **Step 2: Run the full suite, typecheck, and build**

Run: `npm test -- --run && npx tsc -b && npm run build`
Expected: 356/356 tests (no test file exists for this component, matching this project's precedent of not requiring dedicated tests for presentational components — confirmed by `ls src/components/terminal/*.test.ts*` showing none), 29 files, 0 type errors, build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/terminal/LiveOutputCard.tsx
git commit -m "feat: show an honest idle state in LiveOutputCard instead of always STREAMING"
```

---

### Task 5: Final integration QA

**Files:** None (verification only).

- [ ] **Step 1: Re-run the full automated suite**

Run: `npm test -- --run && npx tsc -b && npm run build`
Expected: 356/356 tests (0 net change — this phase adds log-line side effects to existing state, no new pure-logic files besides Task 1's small addition, whose 5 tests are already included in the 356), 29 files, 0 type errors, build succeeds.

- [ ] **Step 2: Manual GUI verification checklist**

Using `npm run electron:dev`:
1. With no dispatch currently running, confirm LiveOutputCard shows "no activity yet" and an "IDLE" badge, not "STREAMING".
2. From the real pty terminal, prompt Claude to spawn a real subagent (an `Agent`-tool dispatch). Confirm a "`<subagentType>`: `<description>`" line appears in Live Output in real time, and the badge flips to "STREAMING".
3. Let the dispatch finish. Confirm a second line appears with real token/tool-call/duration figures (e.g. "`general-purpose: 12.5K tok · 5 tool calls · 8s`").
4. If `cfg.autoCreateDispatchChannels` is on (Settings view), confirm a "dispatch channel opened" line also appears; if off, manually create a dispatch channel from a completed dispatch (Chat view's "+ NEW" picker) and confirm the same line appears from that path instead.
5. Confirm Analytics' `LogFrequencyCard` totals still update for the two colors used (`#7fd8ef`/`#3be0a0`).
6. Trigger the fictional AUTO-mode auto-approval (Settings → `opMode: AUTO`, wait for a LOW/MED-risk approval to auto-resolve) and confirm the TopBar notification bell still gets a new entry, but Live Output does **not** — proving the fictional simulation no longer writes to `state.logs`.
7. Navigate away from Terminal and back; confirm Live Output's content persists (it's plain `state.logs`, no special persistence needed — same as before this phase).

- [ ] **Step 3: Update `PROGRESS.md`**

Add a new entry to the top of "Shipped plans" (newest-first, matching every existing entry's format) once the manual QA in Step 2 passes, summarizing: what changed, the test-count delta, the independent-pipelines decision (dispatch-completed sourced only from `RECORD_DISPATCH_USAGE`, not `SET_REAL_AGENTS`'s diff) and why, and the accepted limitation (a dispatch whose `agents:completed` event never fires gets no "completed" line). Follow this file's own established voice and level of technical detail (see any existing entry, e.g. the "Real Dispatch Completions in Memory (Phase 3, slice 5)" entry, as the closest structural precedent — smallest prior slice, also renderer-only, also with an accepted-limitation callout).

- [ ] **Step 4: Report results**

No additional commit for this task unless the manual QA in Step 2 finds a regression, in which case fix it, re-run Step 1, and commit the fix separately before updating `PROGRESS.md`.
