# Analytics View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `Analytics` tab's `null` placeholder with a real Analytics view — a 2×2 grid of four independent summary cards (agent burn breakdown, real top-commands ranking, system-metric statistics, log/alert frequency), all derived from data the app already tracks, with no new state. Bundles a fix for the footer's hardcoded Top Commands fixture and inaccurate "THIS WEEK" label.

**Architecture:** Unlike Projects/Agents/Memory (roster+detail), this is a flat 2×2 CSS grid of independent cards, mirroring `DashboardView.tsx`'s grid layout. A new pure module (`analyticsMath.ts`) provides four functions — `computeAgentBreakdown` (ranks agents by live share), `computeTopCommands` (frequency-counts `cmdHist`'s command words), `computeSysMetricStats` (adds min/max/avg to each system metric's existing history), `computeLogFrequency` (buckets `logs` by their three known colors plus a catch-all "Other") — each consumed by exactly one new card component. `BottomMetricsRow.tsx`'s hardcoded `TOP_COMMANDS` fixture and "THIS WEEK" label are replaced with the same `computeTopCommands` call this view uses, so the footer and the new view can never disagree.

**Tech Stack:** Same as the existing project — React 18, Vite 5, TypeScript 5 (strict), Vitest. No new dependencies.

## Global Constraints

- Project root: `C:\Users\Matt\projects\aether-os` (already scaffolded; this plan extends it).
- Full design spec: `docs/superpowers/specs/2026-07-19-analytics-view-design.md` (commit `44eb5a9`) — this plan implements it task-by-task; consult it for the "why" behind any decision below.
- **Scope for this plan:** `src/components/analytics/` (new: `AnalyticsView.tsx`, `AgentBreakdownCard.tsx`, `TopCommandsCard.tsx`, `SystemMetricsCard.tsx`, `LogFrequencyCard.tsx`, `analyticsMath.ts` + test), `src/components/layout/BottomMetricsRow.tsx` (modified — Top Commands fixture replaced, one label changed, everything else unchanged), `src/viewRegistry.ts` / `src/viewRegistry.test.ts` (modified — flip `Analytics`'s component from `null`).
- **No new state, reducer actions, or persistence changes anywhere in this plan.** Every card reads directly from existing `AetherState` fields (`agents`, `cmdHist`, `sys`, `logs`) via `useAetherStore()`. There is no `selected`-style field to add — none of the four cards has a selectable item.
- **The footer's inert LIVE/DAILY range chips and hardcoded Session Info strings (`"2:15 PM"`, `"3h 42m"`, `"▼ 12% vs last wk"`) are explicitly OUT OF SCOPE.** Only the Top Commands fixture and its "THIS WEEK" label are touched in `BottomMetricsRow.tsx` — everything else in that file is untouched.
- **`computeLogFrequency` always returns exactly four buckets in fixed order** (`Success` `#3be0a0`, `Info` `#7fd8ef`, `Denied` `#ff9d9d`, `Other` `#5f8a97`), zero-filled where nothing matched — never a partial or empty array. This was verified against every log-producing call site in the app (`tick.ts`, `reducer.ts`'s `applyApprovalResolution`) — those three colors are the only ones in use today; "Other" exists purely as a defensive catch-all for any future new color.
- **`computeTopCommands` and `computeAgentBreakdown` handle empty input as empty output** (fresh session, zero active agents) — no crash, matching every other zero-item handling already established in this app (Projects/Agents/Memory's empty states).
- Match established visual/style conventions exactly: inline `CSSProperties` consts, `colors`/`fonts` tokens from `src/styles/tokens.ts`, `useAetherStore()`, the existing `spark()` sparkline util from `src/utils/format.ts` (already used by `AgentDetailCard.tsx`/`SystemOverviewCard.tsx` — reused here, not reimplemented).
- New pure-logic module (`analyticsMath.ts`) gets full Vitest coverage. Presentational components (`AgentBreakdownCard`, `TopCommandsCard`, `SystemMetricsCard`, `LogFrequencyCard`, `AnalyticsView`, and the `BottomMetricsRow.tsx` fix) have no new testable logic of their own and are verified via typecheck + dev server, matching the precedent set by every prior view's roster/detail cards.
- Run `npm test`, `npx tsc -b`, and `npm run build` clean before every commit. Baseline going into this plan: **238 passing tests across 23 files** (confirmed via `npm test` immediately before this plan was written — 215 pre-Memory-view baseline + 23 from the Memory view plan including its post-review fix).

---

## File Structure

```
aether-os/
  src/
    components/
      analytics/
        AnalyticsView.tsx          NEW — 2x2 grid composition, mounted by the view registry
        AgentBreakdownCard.tsx     NEW — agents ranked by live share, sparkline per row
        TopCommandsCard.tsx        NEW — real command-frequency ranking from cmdHist
        SystemMetricsCard.tsx      NEW — CPU/MEM/NET/DISK with min/avg/max added
        LogFrequencyCard.tsx       NEW — log color-bucket counts (Success/Info/Denied/Other)
        analyticsMath.ts           NEW — pure derivation, tested
        analyticsMath.test.ts      NEW
      layout/
        BottomMetricsRow.tsx       MODIFIED — TOP_COMMANDS fixture -> computeTopCommands(cmdHist);
                                   "THIS WEEK" -> "RECENT" label above Top Commands only
    viewRegistry.ts                 MODIFIED — flip Analytics' component from null to AnalyticsView
    viewRegistry.test.ts            MODIFIED — test that Analytics now resolves
```

---

### Task 1: Analytics derivation math (`analyticsMath.ts`)

The four pure functions this view (and the footer fix) need.

**Files:**
- Create: `src/components/analytics/analyticsMath.ts`
- Test: `src/components/analytics/analyticsMath.test.ts`

**Interfaces:**
- Consumes: `Agent`, `LogEntry`, `SysMetric` from `../../state/types`.
- Produces: `computeAgentBreakdown(agents: Agent[]): { name: string; hue: string; pct: number; hist: number[] }[]`, `computeTopCommands(cmdHist: string[], limit?: number): { name: string; count: number }[]`, `computeSysMetricStats(sys: SysMetric[]): { label: string; val: number; hist: number[]; min: number; max: number; avg: number }[]`, `computeLogFrequency(logs: LogEntry[]): { color: string; label: string; count: number }[]` — consumed by Tasks 2-5's cards and Task 7's `BottomMetricsRow.tsx` fix (`computeTopCommands` only).

- [ ] **Step 1: Write the failing tests**

`src/components/analytics/analyticsMath.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeAgentBreakdown, computeTopCommands, computeSysMetricStats, computeLogFrequency } from './analyticsMath';
import { initialState } from '../../state/initialState';

describe('computeAgentBreakdown', () => {
  it('sorts agents by share descending and rounds pct to a whole percent', () => {
    const rows = computeAgentBreakdown(initialState.agents);
    expect(rows[0]).toMatchObject({ name: 'Code Builder', pct: 22 });
    expect(rows[1]).toMatchObject({ name: 'Database Agent', pct: 20 });
    expect(rows[2]).toMatchObject({ name: 'UI Designer', pct: 18 });
    expect(rows[3]).toMatchObject({ name: 'Test Runner', pct: 15 });
    expect(rows[4]).toMatchObject({ name: 'Doc Writer', pct: 13 });
  });

  it('returns an empty array for no agents', () => {
    expect(computeAgentBreakdown([])).toEqual([]);
  });
});

describe('computeTopCommands', () => {
  it('counts and ranks the first word of each entry, case-insensitively, ignoring args', () => {
    const cmdHist = ['spawn Sentinel', 'Kill Sentinel', 'kill code builder', 'status', 'status'];
    const rows = computeTopCommands(cmdHist);
    expect(rows[0]).toEqual({ name: 'kill', count: 2 });
    expect(rows[1]).toEqual({ name: 'status', count: 2 });
    expect(rows[2]).toEqual({ name: 'spawn', count: 1 });
  });

  it('breaks ties alphabetically for determinism', () => {
    const rows = computeTopCommands(['zeta', 'alpha']);
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'zeta']);
  });

  it('respects the limit parameter', () => {
    const rows = computeTopCommands(['a', 'b', 'c', 'd', 'e', 'f'], 3);
    expect(rows).toHaveLength(3);
  });

  it('returns an empty array for no command history', () => {
    expect(computeTopCommands([])).toEqual([]);
  });
});

describe('computeSysMetricStats', () => {
  it('computes min/max/avg over each metric\'s history, one row per input metric', () => {
    const rows = computeSysMetricStats([
      { label: 'CPU', val: 23, hist: [10, 20, 30] },
      { label: 'MEM', val: 41, hist: [40, 40, 40] },
    ]);
    expect(rows).toEqual([
      { label: 'CPU', val: 23, hist: [10, 20, 30], min: 10, max: 30, avg: 20 },
      { label: 'MEM', val: 41, hist: [40, 40, 40], min: 40, max: 40, avg: 40 },
    ]);
  });
});

describe('computeLogFrequency', () => {
  it('buckets logs by known color; an unknown color falls into Other', () => {
    const logs = [
      { t: '', m: '', c: '#3be0a0' },
      { t: '', m: '', c: '#3be0a0' },
      { t: '', m: '', c: '#7fd8ef' },
      { t: '', m: '', c: '#ff9d9d' },
      { t: '', m: '', c: '#ffffff' },
    ];
    expect(computeLogFrequency(logs)).toEqual([
      { color: '#3be0a0', label: 'Success', count: 2 },
      { color: '#7fd8ef', label: 'Info', count: 1 },
      { color: '#ff9d9d', label: 'Denied', count: 1 },
      { color: '#5f8a97', label: 'Other', count: 1 },
    ]);
  });

  it('always returns all four buckets, zero-filled, for empty input', () => {
    expect(computeLogFrequency([])).toEqual([
      { color: '#3be0a0', label: 'Success', count: 0 },
      { color: '#7fd8ef', label: 'Info', count: 0 },
      { color: '#ff9d9d', label: 'Denied', count: 0 },
      { color: '#5f8a97', label: 'Other', count: 0 },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- analyticsMath`
Expected: FAIL — `analyticsMath.ts` doesn't exist yet.

- [ ] **Step 3: Implement `src/components/analytics/analyticsMath.ts`**

```ts
import type { Agent, LogEntry, SysMetric } from '../../state/types';

export interface AgentBreakdownRow {
  name: string;
  hue: string;
  pct: number;
  hist: number[];
}

export function computeAgentBreakdown(agents: Agent[]): AgentBreakdownRow[] {
  return [...agents]
    .sort((a, b) => b.share - a.share)
    .map((a) => ({ name: a.name, hue: a.hue, pct: Math.round(a.share * 100), hist: a.hist }));
}

export interface CommandFrequency {
  name: string;
  count: number;
}

export function computeTopCommands(cmdHist: string[], limit = 5): CommandFrequency[] {
  const counts = new Map<string, number>();
  for (const raw of cmdHist) {
    const word = raw.trim().split(/\s+/)[0]?.toLowerCase();
    if (!word) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

export interface SysMetricStats {
  label: string;
  val: number;
  hist: number[];
  min: number;
  max: number;
  avg: number;
}

export function computeSysMetricStats(sys: SysMetric[]): SysMetricStats[] {
  return sys.map((m) => ({
    label: m.label,
    val: m.val,
    hist: m.hist,
    min: Math.min(...m.hist),
    max: Math.max(...m.hist),
    avg: m.hist.reduce((sum, v) => sum + v, 0) / m.hist.length,
  }));
}

export interface LogFrequencyRow {
  color: string;
  label: string;
  count: number;
}

const LOG_BUCKETS: { color: string; label: string }[] = [
  { color: '#3be0a0', label: 'Success' },
  { color: '#7fd8ef', label: 'Info' },
  { color: '#ff9d9d', label: 'Denied' },
  { color: '#5f8a97', label: 'Other' },
];

export function computeLogFrequency(logs: LogEntry[]): LogFrequencyRow[] {
  const known = new Set(LOG_BUCKETS.slice(0, 3).map((b) => b.color));
  const counts = new Map<string, number>(LOG_BUCKETS.map((b) => [b.color, 0]));
  for (const log of logs) {
    const key = known.has(log.c) ? log.c : '#5f8a97';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return LOG_BUCKETS.map((b) => ({ ...b, count: counts.get(b.color) ?? 0 }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- analyticsMath`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npx tsc -b`
Expected: all PASS (247 total: 238 + 9 new), 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/analytics/analyticsMath.ts src/components/analytics/analyticsMath.test.ts
git commit -m "feat: add Analytics view derivation math (agent breakdown, top commands, sys metric stats, log frequency)"
```

---

### Task 2: Agent Burn Breakdown card

**Files:**
- Create: `src/components/analytics/AgentBreakdownCard.tsx`

**Interfaces:**
- Consumes: `useAetherStore()`; `computeAgentBreakdown` from `./analyticsMath`; `spark` from `../../utils/format`; `colors`, `fonts` from `../../styles/tokens`.
- Produces: `AgentBreakdownCard()` — mounted by Task 6's `AnalyticsView`.

No new unit-testable logic — verify via typecheck (no dev server in this environment; Task 8 covers browser verification).

- [ ] **Step 1: Implement `src/components/analytics/AgentBreakdownCard.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { spark } from '../../utils/format';
import { computeAgentBreakdown } from './analyticsMath';

export function AgentBreakdownCard() {
  const { state } = useAetherStore();
  const rows = computeAgentBreakdown(state.agents);

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>AGENT BURN BREAKDOWN</div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r) => (
          <div key={r.name} style={rowStyle}>
            <span style={swatchStyle(r.hue)} />
            <span style={nameStyle}>{r.name}</span>
            <svg viewBox="0 0 62 22" preserveAspectRatio="none" style={{ width: 62, height: 22, flex: 'none' }}>
              <polyline points={spark(r.hist)} fill="none" stroke={r.hue} strokeWidth={1.4} strokeLinejoin="round" />
            </svg>
            <span style={{ flex: 'none', font: `700 13px/1 ${fonts.mono}`, color: r.hue, width: 40, textAlign: 'right' }}>{r.pct}%</span>
          </div>
        ))}
        {!rows.length && <div style={emptyStyle}>no active agents</div>}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
const titleStyle: CSSProperties = { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 };
function swatchStyle(hue: string): CSSProperties {
  return { width: 10, height: 10, borderRadius: '50%', flex: 'none', background: hue, boxShadow: `0 0 8px ${hue}` };
}
const nameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  font: `600 13px/1 ${fonts.ui}`,
  color: colors.textPrimary,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/analytics/AgentBreakdownCard.tsx
git commit -m "feat: build the Analytics view agent burn breakdown card"
```

---

### Task 3: Top Commands card

**Files:**
- Create: `src/components/analytics/TopCommandsCard.tsx`

**Interfaces:**
- Consumes: `useAetherStore()`; `computeTopCommands` from `./analyticsMath`; `colors`, `fonts` from `../../styles/tokens`.
- Produces: `TopCommandsCard()` — mounted by Task 6's `AnalyticsView`.

No new unit-testable logic — verify via typecheck.

- [ ] **Step 1: Implement `src/components/analytics/TopCommandsCard.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { computeTopCommands } from './analyticsMath';

export function TopCommandsCard() {
  const { state } = useAetherStore();
  const rows = computeTopCommands(state.cmdHist);
  const maxCount = rows[0]?.count ?? 1;

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>TOP COMMANDS</div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 9 }}>
        {rows.map((r, i) => (
          <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, width: 12 }}>{i + 1}</span>
            <span style={{ font: `600 12px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textBody, width: 58 }}>{r.name}</span>
            <span style={{ flex: 1, height: 5, borderRadius: 3, background: 'rgba(20,50,64,.7)', overflow: 'hidden' }}>
              <span
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${(r.count / maxCount) * 100}%`,
                  background: 'linear-gradient(90deg,#0f7f97,#7ef0ff)',
                  boxShadow: '0 0 8px rgba(95,240,255,.5)',
                }}
              />
            </span>
            <span style={{ font: `700 11px/1 ${fonts.mono}`, color: colors.accentCyanSoft, width: 34, textAlign: 'right' }}>{r.count}×</span>
          </div>
        ))}
        {!rows.length && <div style={emptyStyle}>no commands run yet</div>}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
const titleStyle: CSSProperties = { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const emptyStyle: CSSProperties = { font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' };
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/analytics/TopCommandsCard.tsx
git commit -m "feat: build the Analytics view top commands card"
```

---

### Task 4: System Metrics card

**Files:**
- Create: `src/components/analytics/SystemMetricsCard.tsx`

**Interfaces:**
- Consumes: `useAetherStore()`; `computeSysMetricStats` from `./analyticsMath`; `spark` from `../../utils/format`; `colors`, `fonts` from `../../styles/tokens`.
- Produces: `SystemMetricsCard()` — mounted by Task 6's `AnalyticsView`.

No new unit-testable logic — verify via typecheck.

- [ ] **Step 1: Implement `src/components/analytics/SystemMetricsCard.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { spark } from '../../utils/format';
import { computeSysMetricStats } from './analyticsMath';

export function SystemMetricsCard() {
  const { state } = useAetherStore();
  const rows = computeSysMetricStats(state.sys);

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>SYSTEM METRICS</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
        {rows.map((m) => (
          <div key={m.label} style={metricTileStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ font: `600 10px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted }}>{m.label}</span>
              <span style={{ font: `700 15px/1 ${fonts.mono}`, color: colors.textBody }}>{Math.round(m.val)}%</span>
            </div>
            <svg viewBox="0 0 62 22" preserveAspectRatio="none" style={{ width: '100%', height: 22, marginTop: 7, display: 'block' }}>
              <polyline
                points={spark(m.hist)}
                fill="none"
                stroke={colors.accentCyanDeep}
                strokeWidth={1.4}
                strokeLinejoin="round"
                style={{ filter: 'drop-shadow(0 0 3px rgba(95,240,255,.7))' }}
              />
            </svg>
            <div style={{ marginTop: 6, font: `400 9px/1 ${fonts.mono}`, color: colors.textDim }}>
              min {Math.round(m.min)}% · avg {Math.round(m.avg)}% · max {Math.round(m.max)}%
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
const titleStyle: CSSProperties = { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
const metricTileStyle: CSSProperties = { padding: '10px 12px', borderRadius: 9, border: '1px solid rgba(80,190,220,.16)', background: 'rgba(6,20,28,.5)' };
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/analytics/SystemMetricsCard.tsx
git commit -m "feat: build the Analytics view system metrics card"
```

---

### Task 5: Log Frequency card

**Files:**
- Create: `src/components/analytics/LogFrequencyCard.tsx`

**Interfaces:**
- Consumes: `useAetherStore()`; `computeLogFrequency` from `./analyticsMath`; `colors`, `fonts` from `../../styles/tokens`.
- Produces: `LogFrequencyCard()` — mounted by Task 6's `AnalyticsView`.

No new unit-testable logic — verify via typecheck.

- [ ] **Step 1: Implement `src/components/analytics/LogFrequencyCard.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { computeLogFrequency } from './analyticsMath';

export function LogFrequencyCard() {
  const { state } = useAetherStore();
  const rows = computeLogFrequency(state.logs);

  return (
    <div style={cardStyle}>
      <div style={titleStyle}>ALERT / LOG FREQUENCY</div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', flex: 'none', background: r.color, boxShadow: `0 0 8px ${r.color}` }} />
            <span style={{ flex: 1, font: `600 13px/1 ${fonts.ui}`, color: colors.textPrimary }}>{r.label}</span>
            <span style={{ flex: 'none', font: `700 13px/1 ${fonts.mono}`, color: r.color }}>{r.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = { padding: 15, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient, display: 'flex', flexDirection: 'column', minHeight: 0 };
const titleStyle: CSSProperties = { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/analytics/LogFrequencyCard.tsx
git commit -m "feat: build the Analytics view log frequency card"
```

---

### Task 6: Analytics view composition + registry wiring

**Files:**
- Create: `src/components/analytics/AnalyticsView.tsx`
- Modify: `src/viewRegistry.ts`
- Modify: `src/viewRegistry.test.ts`

**Interfaces:**
- Consumes: `AgentBreakdownCard`, `TopCommandsCard`, `SystemMetricsCard`, `LogFrequencyCard`.
- Produces: `AnalyticsView()` — registered in `viewRegistry.ts`, completing the Analytics slice.

- [ ] **Step 1: Implement `src/components/analytics/AnalyticsView.tsx`**

```tsx
import type { CSSProperties } from 'react';
import { AgentBreakdownCard } from './AgentBreakdownCard';
import { TopCommandsCard } from './TopCommandsCard';
import { SystemMetricsCard } from './SystemMetricsCard';
import { LogFrequencyCard } from './LogFrequencyCard';

export function AnalyticsView() {
  return (
    <div style={gridStyle}>
      <AgentBreakdownCard />
      <TopCommandsCard />
      <SystemMetricsCard />
      <LogFrequencyCard />
    </div>
  );
}

const gridStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 14 };
```

- [ ] **Step 2: Wire Analytics into the registry**

In `src/viewRegistry.ts`, add the import:

```ts
import { AnalyticsView } from './components/analytics/AnalyticsView';
```

Change:

```ts
  { id: 'Analytics', inTopBar: true, inSidebar: true, component: null },
```

to:

```ts
  { id: 'Analytics', inTopBar: true, inSidebar: true, component: AnalyticsView },
```

- [ ] **Step 3: Update `src/viewRegistry.test.ts`**

Add a new test confirming Analytics now resolves (after the existing `'getViewComponent resolves Memory now that it is built'` test):

```ts
  it('getViewComponent resolves Analytics now that it is built', () => {
    expect(getViewComponent('Analytics')).not.toBeNull();
  });
```

- [ ] **Step 4: Run the full suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (248 total: 247 + 1 new), 0 type errors, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/analytics/AnalyticsView.tsx src/viewRegistry.ts src/viewRegistry.test.ts
git commit -m "feat: compose the Analytics view and wire it into the view registry"
```

---

### Task 7: Fix the footer's Top Commands fixture

Replaces `BottomMetricsRow.tsx`'s hardcoded `TOP_COMMANDS` array with the same `computeTopCommands` derivation `TopCommandsCard` uses, and relabels "THIS WEEK" to "RECENT" above it — the only two changes in this file (see Global Constraints: the inert range chips and hardcoded Session Info strings are untouched).

**Files:**
- Modify: `src/components/layout/BottomMetricsRow.tsx`

**Interfaces:**
- Consumes: `computeTopCommands` from `../analytics/analyticsMath` (built in Task 1).
- Produces: no new exports — this is a behavior fix to an existing component.

No new unit-testable logic (the derivation it now uses is already tested in Task 1) — verify via typecheck + dev server.

- [ ] **Step 1: Remove the `TOP_COMMANDS` fixture and add the import**

Change:

```ts
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { fmt } from '../../utils/format';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TOP_COMMANDS = [
  { n: 1, name: 'build', count: '128×', w: 100 },
  { n: 2, name: 'deploy', count: '84×', w: 66 },
  { n: 3, name: 'analyze', count: '67×', w: 52 },
  { n: 4, name: 'refactor', count: '52×', w: 41 },
  { n: 5, name: 'doc', count: '41×', w: 32 },
];
```

to:

```ts
import type { CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { fmt } from '../../utils/format';
import { computeTopCommands } from '../analytics/analyticsMath';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
```

- [ ] **Step 2: Compute the real ranking inside the component**

Change:

```ts
export function BottomMetricsRow() {
  const { state } = useAetherStore();

  const maxBar = Math.max(...state.weekRaw);
```

to:

```ts
export function BottomMetricsRow() {
  const { state } = useAetherStore();
  const topCommands = computeTopCommands(state.cmdHist);

  const maxBar = Math.max(...state.weekRaw);
```

- [ ] **Step 3: Replace the Top Commands section's label and list**

Change:

```tsx
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={cardTitleStyle}>TOP COMMANDS</div>
          <div style={{ font: `400 10px/1 ${fonts.mono}`, color: colors.textDim }}>THIS WEEK</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 13 }}>
          {TOP_COMMANDS.map((c) => (
            <div key={c.n} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, width: 12 }}>{c.n}</span>
              <span style={{ font: `600 12px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textBody, width: 58 }}>{c.name}</span>
              <span style={{ flex: 1, height: 5, borderRadius: 3, background: 'rgba(20,50,64,.7)', overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${c.w}%`, background: 'linear-gradient(90deg,#0f7f97,#7ef0ff)', boxShadow: '0 0 8px rgba(95,240,255,.5)' }} />
              </span>
              <span style={{ font: `700 11px/1 ${fonts.mono}`, color: colors.accentCyanSoft, width: 34, textAlign: 'right' }}>{c.count}</span>
            </div>
          ))}
        </div>
      </div>
```

to:

```tsx
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={cardTitleStyle}>TOP COMMANDS</div>
          <div style={{ font: `400 10px/1 ${fonts.mono}`, color: colors.textDim }}>RECENT</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 13 }}>
          {topCommands.map((c, i) => (
            <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, width: 12 }}>{i + 1}</span>
              <span style={{ font: `600 12px/1 ${fonts.ui}`, letterSpacing: 0.5, color: colors.textBody, width: 58 }}>{c.name}</span>
              <span style={{ flex: 1, height: 5, borderRadius: 3, background: 'rgba(20,50,64,.7)', overflow: 'hidden' }}>
                <span
                  style={{
                    display: 'block',
                    height: '100%',
                    width: `${(c.count / (topCommands[0]?.count ?? 1)) * 100}%`,
                    background: 'linear-gradient(90deg,#0f7f97,#7ef0ff)',
                    boxShadow: '0 0 8px rgba(95,240,255,.5)',
                  }}
                />
              </span>
              <span style={{ font: `700 11px/1 ${fonts.mono}`, color: colors.accentCyanSoft, width: 34, textAlign: 'right' }}>{c.count}×</span>
            </div>
          ))}
          {!topCommands.length && <div style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, padding: '4px 2px' }}>no commands run yet</div>}
        </div>
      </div>
```

Everything else in `BottomMetricsRow.tsx` (the Token Usage weekly bar chart, Context Window donut, Session Info card, all style consts) is unchanged.

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b`
Expected: exits 0. (Confirms the removed `TOP_COMMANDS` fixture isn't referenced anywhere else and the new import resolves.)

- [ ] **Step 5: Run the full suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (248/248, unchanged — this task adds no new tests), 0 type errors, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/BottomMetricsRow.tsx
git commit -m "fix: replace the footer's hardcoded Top Commands fixture with a real cmdHist-derived ranking"
```

---

### Task 8: Final integration QA

**Files:** none (verification-only task).

- [ ] **Step 1: Run the full automated suite**

Run: `npm test && npx tsc -b && npm run build`
Expected: all PASS (248/248), 0 type errors, build succeeds.

- [ ] **Step 2: Manual QA checklist**

Run: `npm run dev`, open the browser.

- [ ] Clicking the top bar's or sidebar's "Analytics" entry shows the 2×2 grid with all four cards populated from the live seed state.
- [ ] Agent Burn Breakdown ranks the seed agents by share descending (Code Builder 22%, Database Agent 20%, UI Designer 18%, Test Runner 15%, Doc Writer 13%), each with a visible sparkline.
- [ ] Top Commands (Analytics tab) is empty ("no commands run yet") on a fresh session; after typing a few different terminal commands, it populates.
- [ ] The footer's Top Commands section (visible below every tab) now shows the *same* ranking/counts as the Analytics tab's Top Commands card for the same session, and its label reads "RECENT" instead of "THIS WEEK".
- [ ] The footer's other sections (Token Usage weekly bars, Context Window donut, Session Info, the LIVE/DAILY/WEEKLY chips) look exactly as before this plan — no regression from the Top Commands fix.
- [ ] System Metrics card shows all four metrics with current value, sparkline, and a `min / avg / max` line.
- [ ] Alert/Log Frequency card shows all four buckets (Success/Info/Denied/Other) with plausible counts against the session's log history — trigger a few HIGH-risk approvals (approve some, deny some) and confirm the Denied count increases correctly on denial.
- [ ] Zero-agents edge case: temporarily set `agents: []` in `src/state/initialState.ts` (local, uncommitted edit), reload the dev server, confirm Agent Burn Breakdown shows "no active agents" without error, and the other three cards are unaffected. Revert the edit (`git checkout -- src/state/initialState.ts`) before continuing.
- [ ] Confirm no regressions elsewhere: Terminal, Dashboard, Agents, Grid, Chat, Projects, Memory, and remaining placeholder tabs still route and highlight correctly.

- [ ] **Step 3: Address any regression found in Step 2**

If Step 2 surfaces a real regression (not a pre-existing, already-documented quirk), fix it and commit separately with a `fix:` message before considering this plan done. If nothing was found, skip this step.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-19-analytics-view.md`. Executed via the same per-task pipeline as prior plans in this repo: a fresh implementer subagent per task, a fresh reviewer subagent (spec compliance + code quality) before commit, then one whole-branch review after all tasks land.

### Critical Files for Implementation
- C:\Users\Matt\projects\aether-os\src\components\analytics\analyticsMath.ts
- C:\Users\Matt\projects\aether-os\src\components\analytics\AnalyticsView.tsx
- C:\Users\Matt\projects\aether-os\src\components\layout\BottomMetricsRow.tsx
- C:\Users\Matt\projects\aether-os\src\viewRegistry.ts
