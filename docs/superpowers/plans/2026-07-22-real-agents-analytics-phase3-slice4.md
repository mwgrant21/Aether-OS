# Real Active Agents in Analytics (Phase 3, slice 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Analytics' `AgentBreakdownCard` with a real, duration-sorted list of active Claude Code `Agent` dispatches, reframed from "burn breakdown" to "longest-running."

**Architecture:** Add a real-data breakdown function to `analyticsMath.ts` alongside the existing fictional-agent one (additive at first), then rewrite `AgentBreakdownCard.tsx` to use it and remove the now-dead fictional function once the card no longer needs it. `AnalyticsView.tsx` needs no changes — `AgentBreakdownCard` takes no props and reads state internally.

**Tech Stack:** TypeScript, React 18, Vitest.

## Global Constraints

- Only `AgentBreakdownCard.tsx` and `analyticsMath.ts` (+ its test file) change. `TopCommandsCard`/`SystemMetricsCard`/`LogFrequencyCard` and their `analyticsMath.ts` functions (`computeTopCommands`/`computeSysMetricStats`/`computeLogFrequency`) are untouched — none read agent data. `AnalyticsView.tsx` is untouched — `AgentBreakdownCard` takes no props.
- No sparkline, real or placeholder. No new sort/filter controls — duration-descending, unconditional, matching the existing card's own lack of controls.
- Card title changes from `"AGENT BURN BREAKDOWN"` to `"LONGEST-RUNNING AGENTS"` — distinct wording from "ACTIVE AGENTS" (used elsewhere), since this card's specific value is the duration ordering.
- `computeRealAgentBreakdown(agents, now)` takes `now` as an explicit parameter — pure math never calls `Date.now()` internally, matching the pattern already established by Grid's `computeRealFeedLinks`/`computeRealGridLayout`.
- Dead code (`computeAgentBreakdown`, `AgentBreakdownRow`) is removed only once `AgentBreakdownCard.tsx` has already stopped using it and the build is confirmed clean — never removed first.
- Baseline before this plan: 289 passing tests across 28 files, clean `tsc -b` (plain, not `--noEmit` — this project's composite tsconfig setup errors on that flag combination), clean `electron:build`, working tree clean (aside from pre-existing unrelated untracked screenshot `.jpg` files) at commit `57b2500` (the spec commit).

---

## File Structure

| File | Change |
|---|---|
| `src/components/analytics/analyticsMath.ts` | Add `RealAgentBreakdownRow` type and `computeRealAgentBreakdown` (Task 1, additive). Remove `computeAgentBreakdown`/`AgentBreakdownRow` (Task 2, once safe). |
| `src/components/analytics/analyticsMath.test.ts` | Add tests for the new function (Task 1). Remove the old `describe('computeAgentBreakdown', ...)` block (Task 2). |
| `src/components/analytics/AgentBreakdownCard.tsx` | Rewrite: real-dispatch data, live elapsed-time ticking, new title/copy, no sparkline (Task 2). |

---

### Task 1: Real-data breakdown function in `analyticsMath.ts`

**Files:**
- Modify: `src/components/analytics/analyticsMath.ts`
- Modify: `src/components/analytics/analyticsMath.test.ts`

**Interfaces:**
- Consumes: `RealAgentDispatch` from `src/state/liveAgentsMath.ts` (existing, shipped in an earlier Phase 3 slice).
- Produces: `RealAgentBreakdownRow { toolUseId: string; subagentType: string; description: string; elapsedMs: number }`; `computeRealAgentBreakdown(agents: RealAgentDispatch[], now: number): RealAgentBreakdownRow[]`. Task 2's `AgentBreakdownCard.tsx` calls this.

This task is purely additive — `computeAgentBreakdown`/`AgentBreakdownRow` are NOT touched or removed here (that happens in Task 2, once `AgentBreakdownCard.tsx` has actually stopped using them).

- [ ] **Step 1: Write the failing tests**

Add this import and `describe` block to `src/components/analytics/analyticsMath.test.ts` (add the import alongside the existing ones at the top; append the block after the existing `computeLogFrequency` describe block, which is the last one in the file):

```typescript
import type { RealAgentDispatch } from '../../state/liveAgentsMath';
```

```typescript
function mockRealAgent(toolUseId: string, startedAt: string, subagentType = 'general-purpose', description = 'Working'): RealAgentDispatch {
  return { toolUseId, subagentType, description, startedAt, prompt: 'do work', model: null };
}

describe('computeRealAgentBreakdown', () => {
  it('sorts real dispatches by elapsed time descending (longest-running first)', () => {
    const now = new Date('2026-07-22T10:10:00.000Z').getTime();
    const rows = computeRealAgentBreakdown(
      [
        mockRealAgent('tu_1', '2026-07-22T10:08:00.000Z', 'general-purpose', 'short one'),
        mockRealAgent('tu_2', '2026-07-22T10:00:00.000Z', 'Explore', 'long one'),
        mockRealAgent('tu_3', '2026-07-22T10:05:00.000Z', 'fork', 'mid one'),
      ],
      now,
    );
    expect(rows.map((r) => r.toolUseId)).toEqual(['tu_2', 'tu_3', 'tu_1']);
  });

  it('computes elapsedMs against the provided now, not the real wall clock', () => {
    const now = new Date('2026-07-22T10:05:00.000Z').getTime();
    const [row] = computeRealAgentBreakdown([mockRealAgent('tu_1', '2026-07-22T10:00:00.000Z')], now);
    expect(row.elapsedMs).toBe(5 * 60 * 1000);
  });

  it('returns an empty array for no real dispatches', () => {
    expect(computeRealAgentBreakdown([], Date.now())).toEqual([]);
  });
});
```

Also add `computeRealAgentBreakdown` to the existing `import { computeAgentBreakdown, computeTopCommands, computeSysMetricStats, computeLogFrequency } from './analyticsMath';` line (do not add a second import statement for `analyticsMath`):

```typescript
import { computeAgentBreakdown, computeRealAgentBreakdown, computeTopCommands, computeSysMetricStats, computeLogFrequency } from './analyticsMath';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/components/analytics/analyticsMath.test.ts`
Expected: FAIL — `computeRealAgentBreakdown is not exported`.

- [ ] **Step 3: Implement `computeRealAgentBreakdown`**

Add this to `src/components/analytics/analyticsMath.ts`, alongside the existing `computeAgentBreakdown` (do not modify `computeAgentBreakdown`/`AgentBreakdownRow` — add this as a new, additional export). Add the import at the top of the file, alongside the existing `import type { Agent, LogEntry, SysMetric } from '../../state/types';` line:

```typescript
import type { RealAgentDispatch } from '../../state/liveAgentsMath';
```

```typescript
export interface RealAgentBreakdownRow {
  toolUseId: string;
  subagentType: string;
  description: string;
  elapsedMs: number;
}

export function computeRealAgentBreakdown(agents: RealAgentDispatch[], now: number): RealAgentBreakdownRow[] {
  return agents
    .map((a) => ({
      toolUseId: a.toolUseId,
      subagentType: a.subagentType,
      description: a.description,
      elapsedMs: now - new Date(a.startedAt).getTime(),
    }))
    .sort((a, b) => b.elapsedMs - a.elapsedMs);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/components/analytics/analyticsMath.test.ts`
Expected: PASS — all tests in the file green, including the 3 new `computeRealAgentBreakdown` tests plus the existing `computeAgentBreakdown`/`computeTopCommands`/`computeSysMetricStats`/`computeLogFrequency` tests (still present, still passing — not removed in this task).

- [ ] **Step 5: Run the full suite and type checker**

Run: `npm test && npx tsc -b`
Expected: 292 tests pass (289 baseline + 3 new); `tsc -b` clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/analytics/analyticsMath.ts src/components/analytics/analyticsMath.test.ts
git commit -m "feat: add real-dispatch breakdown function to analyticsMath"
```

---

### Task 2: Rewrite `AgentBreakdownCard.tsx`, remove dead code, manual verification

**Files:**
- Modify: `src/components/analytics/AgentBreakdownCard.tsx`
- Modify: `src/components/analytics/analyticsMath.ts`
- Modify: `src/components/analytics/analyticsMath.test.ts`

**Interfaces:**
- Consumes: `computeRealAgentBreakdown`, `RealAgentBreakdownRow` from `./analyticsMath` (Task 1, already merged); `fmtElapsed` from `src/utils/format.ts` (existing); `colors`/`fonts` from `../../styles/tokens` (existing).
- Produces: nothing new — this is the final integration point. `AgentBreakdownCard` still takes no props; `AnalyticsView.tsx` needs no changes.

Unlike Grid/the Agents view, there is no separate "view wiring" file to update here — `AgentBreakdownCard` reads `useAetherStore()` internally and `AnalyticsView.tsx` just renders `<AgentBreakdownCard />` with no props. This means the dead-code removal becomes safe within this SAME task, immediately after the card itself is rewritten (Step 2) and confirmed to compile clean (Step 3) — not a separate later task. Do not remove `computeAgentBreakdown`/`AgentBreakdownRow` before Step 3 passes.

- [ ] **Step 1: Read the current file**

Read `src/components/analytics/AgentBreakdownCard.tsx` in full before editing (required by this project's CLAUDE.md: read before editing).

- [ ] **Step 2: Rewrite the component**

Replace the full contents of `src/components/analytics/AgentBreakdownCard.tsx` with:

```tsx
import { useEffect, useState, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { fmtElapsed } from '../../utils/format';
import { computeRealAgentBreakdown } from './analyticsMath';

export function AgentBreakdownCard() {
  const { state } = useAetherStore();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const rows = computeRealAgentBreakdown(state.realAgents, now);

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>LONGEST-RUNNING AGENTS</div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r) => (
          <div key={r.toolUseId} style={rowStyle}>
            <span style={avatarStyle}>{r.subagentType.slice(0, 2).toUpperCase()}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={nameStyle}>{r.subagentType}</div>
              <div style={descStyle}>{r.description}</div>
            </div>
            <span style={{ flex: 'none', font: `700 13px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>{fmtElapsed(r.elapsedMs)}</span>
          </div>
        ))}
        {!rows.length && <div style={emptyStyle}>no agents currently running</div>}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  padding: 15,
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};
const titleStyle: CSSProperties = { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
const avatarStyle: CSSProperties = {
  width: 26,
  height: 26,
  flex: 'none',
  borderRadius: 7,
  display: 'grid',
  placeItems: 'center',
  font: `700 10px/1 ${fonts.mono}`,
  color: colors.accentCyanSoft,
  background: 'rgba(127,216,239,0.12)',
  border: `1px solid ${colors.accentCyanSoft}`,
};
const nameStyle: CSSProperties = {
  font: `600 13px/1 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const descStyle: CSSProperties = {
  marginTop: 2,
  font: `400 11px/1.3 ${fonts.ui}`,
  color: colors.textDim,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
```

This reuses `cardStyle`/`titleStyle`/`rowStyle`/`emptyStyle` structurally from the file's current content (same layout shape) — if your Step 1 read shows any of these four differ from what's printed here (e.g. a different padding/border value), keep the file's actual current values for those four, not the ones shown above (this project's cards have accumulated small per-file styling differences; do not silently "correct" them). The old `swatchStyle(hue)` function and the `spark` import are removed (no sparkline, no per-agent hue). `nameStyle` is repurposed to show `subagentType` instead of `Agent.name`; `descStyle` is new, filling the space the sparkline used to occupy. `avatarStyle` is new, matching the fixed-accent-color avatar convention used by every other real-data card in this app.

- [ ] **Step 3: Run the full suite and type checker to confirm the card compiles**

Run: `npm test && npx tsc -b`
Expected: all 292 tests pass (no test file for this component, matching this project's convention of no tests for presentational card components); `tsc -b` clean — no errors, since (unlike Grid/the Agents view) there is no separate wiring file left pointing at the old prop shape. If `tsc -b` is NOT clean at this point, stop and fix before proceeding to Step 4 — do not remove the dead code below while the build is still broken.

- [ ] **Step 4: Remove the now-dead `computeAgentBreakdown`/`AgentBreakdownRow`**

Confirm (e.g. via `grep -rn "computeAgentBreakdown\|AgentBreakdownRow" src/`) that after Steps 1-3 of this task, these have zero remaining references anywhere in `src/` outside their own definition and `analyticsMath.test.ts` — `AgentBreakdownCard.tsx` has already been rewritten by this task to no longer use them.

In `src/components/analytics/analyticsMath.ts`, remove the `computeAgentBreakdown` function and the `AgentBreakdownRow` interface. Keep `RealAgentBreakdownRow`/`computeRealAgentBreakdown` and everything else (`computeTopCommands`/`computeSysMetricStats`/`computeLogFrequency` and their types) untouched. Check whether the `import type { Agent, LogEntry, SysMetric } from '../../state/types';` line still needs `Agent` after this removal — `Agent` is not used by anything else in this file, so remove it from that import line, keeping `LogEntry, SysMetric`.

In `src/components/analytics/analyticsMath.test.ts`, remove the `describe('computeAgentBreakdown', ...)` block in full, and remove `computeAgentBreakdown` from the top `import { computeAgentBreakdown, computeRealAgentBreakdown, computeTopCommands, computeSysMetricStats, computeLogFrequency } from './analyticsMath';` line (keep `computeRealAgentBreakdown, computeTopCommands, computeSysMetricStats, computeLogFrequency`). The file also has `import { initialState } from '../../state/initialState';` — `initialState` is used ONLY by the `computeAgentBreakdown` test you're removing (`computeAgentBreakdown(initialState.agents)`); no other describe block in this file references it. Remove that import line entirely once the `computeAgentBreakdown` block is gone — this project's `tsconfig.json` has `noUnusedLocals: true`, so leaving it in would fail `tsc -b` at Step 5, not just be untidy. Double-check by searching the file for `initialState` after your edit — it should have zero remaining occurrences.

- [ ] **Step 5: Run the full suite and type checker**

Run: `npm test && npx tsc -b`
Expected: 290 tests pass (292 minus the 2 removed tests in the `computeAgentBreakdown` describe block — 292 - 2 = 290). Count the actual removed tests from your Step 4 edit and confirm the final number matches exactly — don't assume this arithmetic is right without checking against what you actually deleted. `tsc -b` clean.

- [ ] **Step 6: Manual verification**

Run: `npm run dev` (plain browser) or `npm run electron:dev` (if available in your environment).

1. With `state.realAgents` empty (default): confirm the Analytics tab's top-left card shows the title `"LONGEST-RUNNING AGENTS"` and the empty state `"no agents currently running"`.
2. If you have access to a real Claude Code session actively dispatching subagents (this session dispatching a research/implementer subagent is sufficient, if your environment can observe it): confirm dispatches appear ordered longest-running first, each showing subagent type, description, and a live-ticking elapsed-time readout.
3. Confirm `TopCommandsCard`/`SystemMetricsCard`/`LogFrequencyCard` (the other three Analytics cards) show zero regression — all three still render exactly as before.
4. Confirm Files, Memory, and Chat show zero regression — all three still reference the fictional `state.agents` roster exactly as before.

If your environment lacks GUI/browser inspection tooling, note in your report which of the above you could not verify and that it's deferred to the controller — this project's established convention for implementers without visual tooling.

- [ ] **Step 7: Commit**

```bash
git add src/components/analytics/AgentBreakdownCard.tsx src/components/analytics/analyticsMath.ts src/components/analytics/analyticsMath.test.ts
git commit -m "feat: show real Active Agent dispatches, sorted by duration, in Analytics; remove dead computeAgentBreakdown"
```

---

## Self-Review Notes

**Spec coverage:** Task 1 covers the new `computeRealAgentBreakdown` function, `now`-parameterized for testability matching Grid's established pattern. Task 2 covers the full card rewrite (title change, no sparkline, fixed accent-color avatar, elapsed-time readout, new empty-state copy), the dead-code removal (correctly sequenced within a single task since there's no separate wiring file blocking it, unlike Grid/the Agents view), and the spec's full manual verification checklist including the three non-agent Analytics cards' non-regression check. No spec section is without a task.

**Placeholder scan:** no TBD/TODO; every step has complete, runnable code or an exact command with an expected result — including the one place a plan can't know an exact number in advance (Task 2 Step 5's test count), handled by telling the implementer exactly how to verify it against what they actually deleted, not a vague placeholder.

**Type consistency:** `RealAgentBreakdownRow`/`computeRealAgentBreakdown(agents, now)` are defined once in Task 1 and used identically in Task 2's `AgentBreakdownCard.tsx` (same field names: `toolUseId`, `subagentType`, `description`, `elapsedMs`). The card's `key={r.toolUseId}` matches the row shape exactly. `fmtElapsed(r.elapsedMs)` matches `fmtElapsed`'s existing `(ms: number): string` signature, already used identically by every other real-data card in this app.
