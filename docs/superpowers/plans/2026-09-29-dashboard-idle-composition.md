# Dashboard Idle Composition ("Cold cockpit") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the idle dashboard's four empty digest panels with a READINESS panel and a STANDBY STRIP, make every standby signal agree, and swap the reactor card's CONTEXT tile for an exact TODAY cost, without touching the reactor's visuals.

**Architecture:** The pure decisions (the readiness rows, which digests have data, strip items, the TODAY figure, the rate line, the status-dot glow gate) go into two pure modules, `readinessMath.ts` (new) and `dashboardMath.ts` (existing), and each is unit-tested there. Thin React components render them: `ReadinessCard`, `StandbyStrip`, `OpenTerminalButton` and `DigestSlot` (the enter/exit wrapper). `DashboardView` then becomes a two-column layout, with the reactor on the left and READINESS, the digests that have data and the strip on the right. No new IPC and no new persisted state: every signal is already in the store or on `window.aetherElectron`.

**Tech Stack:** React 18, TypeScript, Vitest + @testing-library/react (jsdom), inline styles from `src/styles/tokens.ts`.

**Spec:** `docs/superpowers/specs/2026-09-29-dashboard-idle-composition-design.md` (binding: `DESIGN.md`, `CLAUDE.md`)

## Global Constraints

- Branch `design/idle-composition`. Base `f48b4d4`. Execute in a worktree off that branch (`.worktrees/idle-composition`, per CLAUDE.md's workflow) or in the main checkout if the orchestrator says so. Never switch the main checkout's branch.
- Tests: `npx vitest run <path>` for one file; `npm test` for the suite. Before any task is called done, also run `npm run typecheck:electron` and `npm run build`. Record the baseline once, in Task 14 Step 1. Note that a stray `.worktrees/codex-terminal-path/` exists and can inflate a main-checkout run (CLAUDE.md, Gotchas).
- Commit only your task's files, staging them by explicit path. Never use `git add -A` or `git add .`, because parallel builders share the tree. End each commit message with your session's attribution lines.
- **Reactor/StormCore visuals are untouched (Living Core Rule).** Do not edit anything under `src/components/reactor/`. Only the REACTOR STATUS panel's size changes. `DASH_REACTOR_SIZE` stays 360.
- **Glow-Is-State:** a surface is flat at rest. A dot glows only for a live or alarmed signal. Desktop app and Collector readiness dots never glow.
- **No amber in READINESS.** Met = `colors.success` filled; unmet = hollow ring in `colors.textMuted`.
- **Numbers Are Mono:** every count and dollar figure in Space Mono (`fonts.mono`); words in Rajdhani (`fonts.ui`).
- **11px floor** for all functional text.
- **Tokens, not literals:** colours via `useColors()` (`colors.*`), glows via `glows.*` or the new `dotGlow()`, motion via `motion.duration.slow` + `motion.easing.decelerate`. No new hex/rgba literals in touched code.
- **Button primitive** (`src/components/shared/Button.tsx`) for every new interactive element; never a clickable `div`/`span`.
- **Exactly one `h1` per view** (AppShell's). New panels use `h2`.
- **The Footer is the only status announcement.** Add no `aria-live` anywhere in this plan.
- **Cost-figure rules (CLAUDE.md, binding):** TODAY is an `ExactCost`-semantics figure: no `~`, `null` renders `—` (`NO_DATA`), never `$0.00` for no data, caption `API rate, not paid`.
- **Reduced motion:** respect `useReducedMotion()`; a digest appears and disappears without animation under it.
- Copy is verbatim from the spec: `Desktop app: running.` / `Desktop app: not running. The Terminal and live tracking need the desktop app.` / `Terminal: session running.` / `Terminal: no session yet.` / `Statusline: live.` / `Statusline: no reading yet.` / `Statusline: last reading is stale.` / `Collector: running.` / `Collector: not running.` / rate line `— tok/min · standby`.
- Tests go in the existing test file that covers the component, else in a new sibling `*.test.tsx`. Write one per behaviour. Each must fail if its fix is reverted.

## Spec ambiguities resolved in this plan

1. **CTRL+K chip (spec item 8) is not built.** No command palette exists: no `keydown` handler for Ctrl+K, no palette component, action or state, and no Electron accelerator. The SYSTEMS card's "CTRL+K jumps anywhere" hint was already false. Retiring SYSTEMS removes the hint, and Task 13 records the missing palette as a DESIGN.md Known Gap. Moving a dead hint into the top bar would violate the repo's "honest readouts" rule. **Needs a decision from the operator** if a palette is wanted.
2. **"Height and opacity" vs "transform/opacity only" (Digest arrival).** These conflict. The plan animates opacity + `translateY` only. The right column reflows at once. DESIGN.md Known Gaps already flags a `height` animation as a defect (`BottomMetricsRow.tsx:215`).
3. **Memory in the strip.** Memory has no digest panel, so the `Memory N engrams` item shows whenever the strip shows. The strip hides only when Agents, Projects and Alerts all have data. `1 engram` is singular.
4. **Strip heading.** The spec wants the strip to be a "landmark-in-panel with an h2", but the narration shows no visible heading. It gets a visually hidden `h2` "Standby" (`srOnlyStyle`).
5. **No-agents copy (item 9).** The Dashboard's ACTIVE AGENTS panel now renders only with data. Its empty branch still shows during the exit fade, so its sentence changes to `No agents are running.` to match Agents and Terminal.
6. **Alert-row colours (item 9).** Notifs persist their colour string (`Notif.c`), so the fix maps at render time: success/warn/danger hexes map to `colors.success`/`colors.warn`/`colors.danger`, and anything else (the cyan info rows, legacy values) maps to `colors.textSecondary`. This applies in both RECENT ALERTS and the top-bar notifications dropdown.
7. **Terminal header (item 7)** is the Claude Terminal view only. `CodexTerminalView`'s "session active" is a separate pty that `isSessionLive` does not describe, so it is left alone.
8. **Collector met = `state.diagnostics !== null`**, as the spec says. That means "the collector DB was readable on the last push", not a heartbeat-checked process. The fleet feed's heartbeat is not used.
9. **SYSTEMS rows not re-homed:** "Pending approvals" is already the top-bar ⛉ badge, and "Sound" is a Settings toggle. Both disappear from the Dashboard with the card.
10. **TODAY freshness:** a ledger computed on an earlier local day (in `ledger.timeZone`) renders `—` rather than yesterday's spend under TODAY.

## Review Focus

- A keyboard user tabs to the aria-disabled OPEN TERMINAL in browser mode and presses Enter. `aria-disabled` does not block activation natively, so the Button primitive must drop the click and the view must not switch (Task 1, Task 4).
- A statusline capture exactly `STATUSLINE_STALE_AFTER_MS` old. The Statusline row and the reactor's NOMINAL/STANDBY must agree at the boundary, and the row must not read "live" while the reactor reads STANDBY (Task 3).
- A digest regains data while its exit fade is running (alerts cleared, then a new alert within 0.5s). The panel must stay mounted, and the stale exit timer must not remove it (Task 7).
- A day with real priced activity that rounds to nothing. `rollups.today === 0` renders `$0.00` (a real zero), a sub-cent day renders `<$0.01`, and `null` renders `—` (Task 2).
- The app is left open across local midnight, or main stops pushing ledger snapshots. TODAY must not show the previous day's total (Task 2).

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/components/shared/Button.tsx` (+ `.test.tsx`) | Adds `aria-disabled` (focusable, click-inert) and `aria-describedby` | 1 |
| `src/styles/tokens.ts` | Adds `dotGlow(color)` | 2 |
| `src/components/dashboard/dashboardMath.ts` (+ `.test.ts`) | Tile order + TODAY, `computeTodayCost`, `computeRateLine`, idle `computeDashPulseMode`, `statusDotGlows` | 2 |
| `src/components/dashboard/readinessMath.ts` (+ `.test.ts`) **new** | Readiness rows, desktop detection, statusline freshness, digest presence, strip items | 3 |
| `src/components/dashboard/OpenTerminalButton.tsx` (+ `.test.tsx`) **new** | The one OPEN TERMINAL control: enabled / aria-disabled + reason | 4 |
| `src/components/dashboard/ReadinessCard.tsx` (+ `.test.tsx`) **new** | READINESS panel | 5 |
| `src/components/dashboard/StandbyStrip.tsx` (+ `.test.tsx`) **new** | STANDBY STRIP | 6 |
| `src/components/dashboard/DigestSlot.tsx` (+ `.test.tsx`) **new**, `src/styles/global.css` | Enter/exit wrapper for a digest panel; `digestEnter` keyframe | 7 |
| `src/components/dashboard/ReactorStatusCard.tsx` (+ `.test.tsx`) | TODAY tile, rate line, no MEMORY SWEEP, shared OPEN TERMINAL, no row span | 8 |
| `src/components/dashboard/DashboardView.tsx` (+ `.test.tsx` new), delete `SystemsCard.tsx` | Two-column layout | 9 |
| `src/components/layout/Footer.tsx` (+ `Footer.test.tsx` new) | Dot glow gate | 10 |
| `src/components/terminal/TerminalView.tsx` (+ `TerminalView.test.tsx` new) | Header "session active" / "standby" | 11 |
| `src/components/dashboard/ActiveAgentsDigest.tsx`, `RecentAlertsCard.tsx`, `src/components/layout/TopBar.tsx` (+ their tests) | Copy and colour drift | 12 |
| `DESIGN.md` | Layout, components, Known Gaps | 13 |

## Dependency graph (for parallel builders)

Each wave's tasks touch disjoint files and can run concurrently. A task may start once every task it lists as a dependency is merged.

| Wave | Task | Depends on |
|---|---|---|
| 1 | 1 Button aria-disabled | none |
| 1 | 2 dashboardMath + dotGlow | none |
| 1 | 3 readinessMath | none |
| 1 | 7 DigestSlot | none |
| 1 | 11 Terminal header | none |
| 1 | 12 Copy and colour drift | none |
| 2 | 4 OpenTerminalButton | 1, 3 |
| 2 | 6 StandbyStrip | 3 |
| 2 | 10 Footer glow | 2 |
| 3 | 5 ReadinessCard | 2, 3, 4 |
| 3 | 8 ReactorStatusCard | 2, 4 |
| 4 | 9 DashboardView | 3, 5, 6, 7, 8 |
| 5 | 13 DESIGN.md | 1–12 |
| 5 | 14 Final verification | 1–13 |

---

### Task 1: Button supports `aria-disabled` and `aria-describedby`

**Files:**
- Modify: `src/components/shared/Button.tsx`
- Test: `src/components/shared/Button.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `Button` accepts `'aria-disabled'?: AriaAttributes['aria-disabled']` and `'aria-describedby'?: string`. When `aria-disabled` is `true` or `'true'`, the button stays focusable (no native `disabled`) and ignores clicks, including Enter/Space activation, which the browser delivers as `click`.

- [ ] **Step 1: Write the failing test.** Append inside the top-level `describe('Button', ...)` in `src/components/shared/Button.test.tsx`:

```tsx
  it('stays focusable but ignores activation while aria-disabled, and forwards aria-describedby', () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <AetherStoreProvider>
        <Button onClick={onClick} style={{}} aria-disabled aria-describedby="why">
          label
        </Button>
      </AetherStoreProvider>,
    );
    const btn = getByRole('button');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('aria-describedby')).toBe('why');
    expect(btn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/shared/Button.test.tsx`
Expected: FAIL. TypeScript/JSX accepts the props at runtime, but `aria-disabled` is not rendered (`null`), so the assertion is `expected null to be 'true'`.

- [ ] **Step 3: Implement.** In `src/components/shared/Button.tsx`, add to `ButtonProps` (after `'aria-controls'`):

```tsx
  /**
   * Disabled but still focusable, so assistive tech can reach it and read why
   * (pair with aria-describedby). Clicks, including keyboard Enter/Space, are
   * ignored while set. Use this instead of `disabled` when the reason matters.
   */
  'aria-disabled'?: AriaAttributes['aria-disabled'];
  /** id of the element that explains this button, e.g. why it is disabled. */
  'aria-describedby'?: string;
```

Destructure them in the function signature (after `'aria-controls': ariaControls,`):

```tsx
  'aria-disabled': ariaDisabled,
  'aria-describedby': ariaDescribedby,
```

Add after `const colors = useColors();`:

```tsx
  const inert = ariaDisabled === true || ariaDisabled === 'true';
```

On the `<button>`, replace `onClick={onClick}` with `onClick={inert ? undefined : onClick}`, and add after `aria-controls={ariaControls}`:

```tsx
      aria-disabled={ariaDisabled}
      aria-describedby={ariaDescribedby}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/components/shared/Button.test.tsx`
Expected: PASS (all Button tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/shared/Button.tsx src/components/shared/Button.test.tsx
git commit -m "feat(button): aria-disabled keeps focus but ignores activation; forward aria-describedby"
```

---

### Task 2: dashboardMath: TODAY tile, rate line, status-dot gate; `dotGlow` token

**Files:**
- Modify: `src/styles/tokens.ts` (after the `glows` object, ~line 134)
- Modify: `src/components/dashboard/dashboardMath.ts`
- Test: `src/components/dashboard/dashboardMath.test.ts`

**Interfaces:**
- Consumes: `isSameLocalDay(iso, timeZone, nowMs)` and `type LedgerSnapshot` from `src/shared/ledgerMath.ts`; `usdPrecise` from `src/components/ledger/format.ts`.
- Produces:
  - `dotGlow(color: string): string` in `tokens.ts` → `` `0 0 8px ${color}` ``
  - `computeTodayCost(ledger: LedgerSnapshot | null, nowMs: number): string`
  - `computeRateLine(state: AetherState, live: boolean): string` (idle → `'— tok/min · standby'`)
  - `statusDotGlows(alarmLevel: AlarmLevel, live: boolean): boolean`
  - `computeDashPulseMode(cfg, false)` now returns `'standby'`
  - `computeDashKpis` returns keys in order `['MONTH TOKENS', 'DEPLETION ETA', 'TODAY', 'BUDGET LEFT']`; TODAY's `s` is `'API rate, not paid'`. There is no CONTEXT tile. `computeContextReading` is unchanged and still exported (BottomMetricsRow uses it).

- [ ] **Step 1: Write the failing tests.** In `src/components/dashboard/dashboardMath.test.ts`:

(a) Extend the import from `./dashboardMath` with `computeRateLine`, `computeTodayCost`, `statusDotGlows`, `type DashKpi`, and add:

```ts
import { buildLedgerSnapshot, type LedgerSnapshot } from '../../shared/ledgerMath';
```

(b) Replace the test `it('says standby instead of naming the theme core when not live', ...)` inside `describe('computeDashPulseMode')` with:

```ts
  it('reads just "standby" when idle, so "live-rate pulse" never sits beside it', () => {
    expect(computeDashPulseMode({ ...initialState.cfg, pulseMode: 'live', theme: 'cyan' }, false)).toBe('standby');
    expect(computeDashPulseMode({ ...initialState.cfg, pulseMode: 'ambient', theme: 'violet' }, false)).toBe('standby');
  });
```

(c) Replace the whole `describe('computeDashKpis', ...)` block with:

```ts
const tile = (kpis: DashKpi[], k: string): DashKpi => kpis.find((x) => x.k === k)!;

describe('computeDashKpis', () => {
  it('orders the tiles MONTH TOKENS, DEPLETION ETA, TODAY, BUDGET LEFT (context lives in the bottom row)', () => {
    expect(computeDashKpis(initialState, NOW).map((x) => x.k)).toEqual(['MONTH TOKENS', 'DEPLETION ETA', 'TODAY', 'BUDGET LEFT']);
  });

  it('derives the scan-backed tiles from a scanned state', () => {
    const kpis = computeDashKpis(
      { ...initialState, realUsage: { ...SCANNED, usedThisMonth: 24391, burnRatePerMin: 92000 }, cfg: { ...initialState.cfg, capM: 2.0 } },
      NOW,
    );
    expect(tile(kpis, 'MONTH TOKENS')).toEqual({ k: 'MONTH TOKENS', v: '24.4K', s: 'this month' });
    expect(tile(kpis, 'BUDGET LEFT')).toEqual({ k: 'BUDGET LEFT', v: '98.8%', s: 'of 2.0M cap' });
    expect(tile(kpis, 'DEPLETION ETA').v.startsWith('~')).toBe(true);
  });

  it('renders a dash, never a seeded or zero value, with no source', () => {
    const kpis = computeDashKpis(initialState, NOW);
    expect(kpis.map((k) => k.v)).toEqual([NO_DATA, NO_DATA, NO_DATA, NO_DATA]);
  });

  it('captions TODAY with its API-rate basis', () => {
    expect(tile(computeDashKpis(initialState, NOW), 'TODAY').s).toBe('API rate, not paid');
  });

  it('renders a dash for DEPLETION ETA when nothing is being drawn', () => {
    const kpis = computeDashKpis({ ...initialState, realUsage: { ...SCANNED, burnRatePerMin: 0 } }, NOW);
    expect(tile(kpis, 'DEPLETION ETA').v).toBe(NO_DATA);
  });

  it('never renders "n/a" for DEPLETION ETA once the cap is already spent', () => {
    const kpis = computeDashKpis(
      { ...initialState, realUsage: { ...SCANNED, usedThisMonth: 11_534_188, burnRatePerMin: 5000 }, cfg: { ...initialState.cfg, capM: 2.0 } },
      NOW,
    );
    expect(tile(kpis, 'DEPLETION ETA').v).toBe('now');
    expect(kpis.every((k) => !k.v.includes('n/a'))).toBe(true);
  });

  it('clamps budget-left at 0% instead of going negative', () => {
    const kpis = computeDashKpis(
      { ...initialState, realUsage: { ...SCANNED, usedThisMonth: 5_000_000 }, cfg: { ...initialState.cfg, capM: 2.0 } },
      NOW,
    );
    expect(tile(kpis, 'BUDGET LEFT').v).toBe('0.0%');
  });
});

const ledgerWithToday = (today: number | null, computedAtMs: number = NOW): LedgerSnapshot => ({
  ...buildLedgerSnapshot([], 'UTC', computedAtMs),
  rollups: { today, week: today, month: today },
});

describe('computeTodayCost', () => {
  it('is NO_DATA with no ledger or no priced activity today, never $0.00', () => {
    expect(computeTodayCost(null, NOW)).toBe(NO_DATA);
    expect(computeTodayCost(ledgerWithToday(null), NOW)).toBe(NO_DATA);
  });

  it('prints an exact figure with no ~', () => {
    expect(computeTodayCost(ledgerWithToday(1.5), NOW)).toBe('$1.50');
  });

  it('keeps a real $0 day distinct from no data, and a sub-cent day off $0.00', () => {
    expect(computeTodayCost(ledgerWithToday(0), NOW)).toBe('$0.00');
    expect(computeTodayCost(ledgerWithToday(0.004), NOW)).toBe('<$0.01');
  });

  it('is NO_DATA when the ledger was computed on an earlier local day', () => {
    expect(computeTodayCost(ledgerWithToday(3.25, NOW - 36 * 60 * 60 * 1000), NOW)).toBe(NO_DATA);
  });
});

describe('computeRateLine', () => {
  it('reads exactly "— tok/min · standby" when idle', () => {
    expect(computeRateLine({ ...initialState, realUsage: { ...SCANNED, burnRatePerMin: 0 } }, false)).toBe('— tok/min · standby');
  });

  it('keeps the live rate and pulse mode when live', () => {
    const state = { ...initialState, realUsage: { ...SCANNED, burnRatePerMin: 1234 }, cfg: { ...initialState.cfg, pulseMode: 'live' as const, theme: 'cyan' as const } };
    expect(computeRateLine(state, true)).toBe('1,234 tok/min · live-rate pulse · cyan core');
  });
});

describe('statusDotGlows', () => {
  it('is flat only at STANDBY: lit when live or alarmed', () => {
    expect(statusDotGlows('ok', false)).toBe(false);
    expect(statusDotGlows('ok', true)).toBe(true);
    expect(statusDotGlows('warn', false)).toBe(true);
    expect(statusDotGlows('crit', false)).toBe(true);
  });
});
```

(d) In `describe('computeContextReading', ...)`, replace the first two tests (the ones that read `kpis[3]`) with:

```ts
  it('is null with no statusline', () => {
    expect(computeContextReading(null, NOW)).toBeNull();
  });

  it('gives the footer card a reading that matches its ring', () => {
    const snap = ctxSnap();
    const reading = computeContextReading(snap, NOW);
    expect(reading).toEqual({ pct: 48, pctLabel: '48%', usedLabel: '480.0K / 1.00M', stale: false });
    expect(deriveContextWindowCard(snap, NOW).ringPct).toBe(reading!.pct);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/dashboard/dashboardMath.test.ts`
Expected: FAIL. `computeTodayCost`/`computeRateLine`/`statusDotGlows` are not exported, and the order test gets `['MONTH TOKENS','BUDGET LEFT','DEPLETION ETA','CONTEXT']`.

- [ ] **Step 3: Implement.**

In `src/styles/tokens.ts`, directly after the closing `} as const;` of `glows`:

```ts
/**
 * A small status dot's glow in its own state colour (the reactor status dot,
 * the footer dot, READINESS dots). Glow-Is-State: apply it only while the dot
 * reports a live or alarmed signal; a resting dot is flat.
 */
export function dotGlow(color: string): string {
  return `0 0 8px ${color}`;
}
```

In `src/components/dashboard/dashboardMath.ts`:

Add imports:

```ts
import { isSameLocalDay, type LedgerSnapshot } from '../../shared/ledgerMath';
import { usdPrecise } from '../ledger/format';
```

Replace `computeDashPulseMode` with:

```ts
/**
 * Live: which pulse the reactor follows and which core is lit. Idle: just
 * "standby" -- "live-rate pulse" beside "standby" contradicted itself.
 */
export function computeDashPulseMode(cfg: Cfg, live: boolean): string {
  if (!live) return 'standby';
  const mode = cfg.pulseMode === 'ambient' ? 'ambient pulse' : 'live-rate pulse';
  return `${mode} · ${cfg.theme} core`;
}

/** The line under the reactor. Idle it reads exactly "— tok/min · standby". */
export function computeRateLine(state: AetherState, live: boolean): string {
  return `${computeRateReadout(state, live)} · ${computeDashPulseMode(state.cfg, live)}`;
}

/**
 * Glow-Is-State for the reactor card's and the footer's status dots: lit
 * while a session is live or an alarm is up, flat at STANDBY. One gate, so
 * the two dots cannot disagree.
 */
export function statusDotGlows(alarmLevel: AlarmLevel, live: boolean): boolean {
  return live || alarmLevel !== 'ok';
}

/**
 * The TODAY tile: today's cost at published API rates (ledger.rollups.today).
 * Exact to the pricing table, so no `~`. `null` (no priced activity observed)
 * is NO_DATA, never "$0.00"; a real zero day prints "$0.00". A snapshot
 * computed on an earlier local day is not today's figure, so it is NO_DATA too.
 */
export function computeTodayCost(ledger: LedgerSnapshot | null, nowMs: number): string {
  if (ledger === null || ledger.rollups.today === null) return NO_DATA;
  if (!isSameLocalDay(new Date(ledger.computedAtMs).toISOString(), ledger.timeZone, nowMs)) return NO_DATA;
  return usdPrecise(ledger.rollups.today);
}
```

In `computeDashKpis`, delete the line `const ctx = computeContextReading(state.statusline, nowMs);` and replace the `return [...]` with:

```ts
  return [
    { k: 'MONTH TOKENS', v: scanned ? short(used) : NO_DATA, s: 'this month' },
    { k: 'DEPLETION ETA', v: eta, s: 'at current draw' },
    // Context moved to the bottom row's CONTEXT WINDOW card (the one source).
    { k: 'TODAY', v: computeTodayCost(state.ledger, nowMs), s: 'API rate, not paid' },
    { k: 'BUDGET LEFT', v: scanned ? `${budgetLeftPct.toFixed(1)}%` : NO_DATA, s: `of ${state.cfg.capM.toFixed(1)}M cap` },
  ];
```

Update the comment at the top of `computeDashKpis` to: `// MONTH TOKENS, DEPLETION ETA and BUDGET LEFT derive from the transcript scan; before the first scan lands (and always in browser mode) there is no reading, so render NO_DATA rather than a 0 that reads as "nothing used". TODAY reads the ledger.`

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/dashboard/dashboardMath.test.ts`
Expected: PASS.
Then run `npx tsc -b --noEmit 2>&1 | head -20` (or `npm run build`). Expected: the only errors are in `ReactorStatusCard.tsx`, if it still imports `computeContextReading` for the CONTEXT override. That file is Task 8's. If this task runs alone, `ReactorStatusCard` still compiles, because `computeContextReading` remains exported. Its `deriveTileOverride('CONTEXT')` branch just becomes dead until Task 8.

- [ ] **Step 5: Commit**

```bash
git add src/styles/tokens.ts src/components/dashboard/dashboardMath.ts src/components/dashboard/dashboardMath.test.ts
git commit -m "feat(dashboard): TODAY tile, idle rate line, shared status-dot glow gate"
```

---

### Task 3: readinessMath: readiness rows, digest presence, strip items

**Files:**
- Create: `src/components/dashboard/readinessMath.ts`
- Test: `src/components/dashboard/readinessMath.test.ts`

**Interfaces:**
- Consumes: `STATUSLINE_STALE_AFTER_MS` (`src/shared/depletion.ts`), `AetherState`, `StatuslineSnapshot`.
- Produces:
  - `type ReadinessKey = 'desktop' | 'terminal' | 'statusline' | 'collector'`
  - `interface ReadinessRow { readonly key: ReadinessKey; readonly met: boolean; readonly glows: boolean; readonly text: string }`
  - `const DESKTOP_APP_REASON = 'The Terminal and live tracking need the desktop app.'`
  - `hasDesktopApp(): boolean`
  - `isStatuslineFresh(snap: StatuslineSnapshot | null, nowMs: number): boolean`
  - `computeReadiness(state: Pick<AetherState, 'terminalAlive' | 'statusline' | 'diagnostics'>, desktop: boolean, nowMs: number): ReadinessRow[]` (order: desktop, terminal, statusline, collector)
  - `interface DigestPresence { readonly agents: boolean; readonly projects: boolean; readonly alerts: boolean }`
  - `computeDigestPresence(state: Pick<AetherState, 'realAgents' | 'projectsSnapshot' | 'notifs'>): DigestPresence`
  - `type StripItemKey = 'agents' | 'projects' | 'alerts' | 'memory'`
  - `interface StripItem { readonly key: StripItemKey; readonly label: string; readonly count: number; readonly unit: string | null }`
  - `computeStripItems(presence: DigestPresence, memoryCount: number): StripItem[]` (`[]` when all three digests have data)

- [ ] **Step 1: Write the failing test.** Create `src/components/dashboard/readinessMath.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DESKTOP_APP_REASON,
  computeDigestPresence,
  computeReadiness,
  computeStripItems,
  type ReadinessKey,
} from './readinessMath';
import { isSessionLive } from './dashboardMath';
import { initialState } from '../../state/initialState';
import { STATUSLINE_STALE_AFTER_MS } from '../../shared/depletion';
import type { StatuslineSnapshot } from '../../shared/statuslinePayload';
import type { AetherState } from '../../state/types';

const NOW = 1_800_000_000_000;
const snap = (capturedAtMs: number): StatuslineSnapshot => ({
  capturedAtMs,
  sessionId: null,
  modelId: null,
  modelDisplayName: null,
  fiveHour: null,
  sevenDay: null,
  contextUsedPercentage: null,
  contextWindowSize: null,
  contextUsage: null,
  totalCostUsd: null,
  currentDir: null,
  projectDir: null,
});
const DIAG: AetherState['diagnostics'] = { toolCalls: [], dispatches: [], anomalies: [] };
const row = (rows: ReturnType<typeof computeReadiness>, key: ReadinessKey) => rows.find((r) => r.key === key)!;

describe('computeReadiness', () => {
  it('lists Desktop app, Terminal, Statusline, Collector in that order', () => {
    expect(computeReadiness(initialState, false, NOW).map((r) => r.key)).toEqual(['desktop', 'terminal', 'statusline', 'collector']);
  });

  it('Desktop app: met copy in Electron, unmet copy with the reason in the browser', () => {
    expect(row(computeReadiness(initialState, true, NOW), 'desktop')).toMatchObject({ met: true, text: 'Desktop app: running.' });
    expect(row(computeReadiness(initialState, false, NOW), 'desktop')).toMatchObject({
      met: false,
      text: `Desktop app: not running. ${DESKTOP_APP_REASON}`,
    });
    expect(DESKTOP_APP_REASON).toBe('The Terminal and live tracking need the desktop app.');
  });

  it('Terminal: met when the pty is alive', () => {
    expect(row(computeReadiness({ ...initialState, terminalAlive: true }, true, NOW), 'terminal')).toMatchObject({ met: true, text: 'Terminal: session running.' });
    expect(row(computeReadiness(initialState, true, NOW), 'terminal')).toMatchObject({ met: false, text: 'Terminal: no session yet.' });
  });

  it('Statusline: live, no reading yet, or stale', () => {
    expect(row(computeReadiness({ ...initialState, statusline: snap(NOW) }, true, NOW), 'statusline')).toMatchObject({ met: true, text: 'Statusline: live.' });
    expect(row(computeReadiness(initialState, true, NOW), 'statusline')).toMatchObject({ met: false, text: 'Statusline: no reading yet.' });
    expect(
      row(computeReadiness({ ...initialState, statusline: snap(NOW - STATUSLINE_STALE_AFTER_MS - 1) }, true, NOW), 'statusline'),
    ).toMatchObject({ met: false, text: 'Statusline: last reading is stale.' });
  });

  it('Collector: met when a diagnostics snapshot has arrived', () => {
    expect(row(computeReadiness({ ...initialState, diagnostics: DIAG }, true, NOW), 'collector')).toMatchObject({ met: true, text: 'Collector: running.' });
    expect(row(computeReadiness(initialState, true, NOW), 'collector')).toMatchObject({ met: false, text: 'Collector: not running.' });
  });

  it('lets only met live signals glow: Terminal and Statusline, never Desktop app or Collector', () => {
    const rows = computeReadiness({ ...initialState, terminalAlive: true, statusline: snap(NOW), diagnostics: DIAG }, true, NOW);
    expect(rows.map((r) => [r.key, r.glows])).toEqual([
      ['desktop', false],
      ['terminal', true],
      ['statusline', true],
      ['collector', false],
    ]);
    expect(computeReadiness(initialState, false, NOW).some((r) => r.glows)).toBe(false);
  });

  it('agrees with isSessionLive at the statusline freshness boundary', () => {
    for (const age of [STATUSLINE_STALE_AFTER_MS, STATUSLINE_STALE_AFTER_MS + 1]) {
      const state = { ...initialState, statusline: snap(NOW - age) };
      expect(row(computeReadiness(state, true, NOW), 'statusline').met).toBe(isSessionLive(state, NOW));
    }
  });
});

describe('computeDigestPresence', () => {
  it('marks a digest present only when it has something to show', () => {
    expect(computeDigestPresence(initialState)).toEqual({ agents: false, projects: false, alerts: false });
    const agent = {} as AetherState['realAgents'][number];
    const root = {} as NonNullable<AetherState['projectsSnapshot']>['roots'][number];
    expect(
      computeDigestPresence({
        realAgents: [agent],
        projectsSnapshot: { roots: [root], unscoped: null, computedAtMs: NOW },
        notifs: [{ t: '10:00', m: 'x', c: '#3be0a0' }],
      }),
    ).toEqual({ agents: true, projects: true, alerts: true });
    expect(computeDigestPresence({ ...initialState, projectsSnapshot: { roots: [], unscoped: null, computedAtMs: NOW } }).projects).toBe(false);
  });
});

describe('computeStripItems', () => {
  const none = { agents: false, projects: false, alerts: false };

  it('lists every digest without data, then the memory count', () => {
    expect(computeStripItems(none, 12)).toEqual([
      { key: 'agents', label: 'Agents', count: 0, unit: null },
      { key: 'projects', label: 'Projects', count: 0, unit: null },
      { key: 'alerts', label: 'Alerts', count: 0, unit: null },
      { key: 'memory', label: 'Memory', count: 12, unit: 'engrams' },
    ]);
  });

  it('drops a digest that has data', () => {
    expect(computeStripItems({ ...none, agents: true }, 0).map((i) => i.key)).toEqual(['projects', 'alerts', 'memory']);
  });

  it('is empty when every digest has data', () => {
    expect(computeStripItems({ agents: true, projects: true, alerts: true }, 5)).toEqual([]);
  });

  it('says "1 engram", singular', () => {
    expect(computeStripItems(none, 1).slice(-1)[0]).toEqual({ key: 'memory', label: 'Memory', count: 1, unit: 'engram' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/dashboard/readinessMath.test.ts`
Expected: FAIL with `Failed to resolve import "./readinessMath"`.

- [ ] **Step 3: Implement.** Create `src/components/dashboard/readinessMath.ts`:

```ts
import type { AetherState } from '../../state/types';
import type { StatuslineSnapshot } from '../../shared/statuslinePayload';
import { STATUSLINE_STALE_AFTER_MS } from '../../shared/depletion';

export type ReadinessKey = 'desktop' | 'terminal' | 'statusline' | 'collector';

export interface ReadinessRow {
  readonly key: ReadinessKey;
  readonly met: boolean;
  /**
   * Light Is Energy: only a met row backed by a live signal (Terminal,
   * Statusline) may glow. Desktop app and Collector are static facts.
   */
  readonly glows: boolean;
  readonly text: string;
}

/** One sentence, two places: after "Desktop app: not running." and under a disabled OPEN TERMINAL. */
export const DESKTOP_APP_REASON = 'The Terminal and live tracking need the desktop app.';

/** True inside Electron, where preload exposes window.aetherElectron; plain `npm run dev` has none. */
export function hasDesktopApp(): boolean {
  return typeof window !== 'undefined' && window.aetherElectron !== undefined;
}

/** Same threshold and comparison as isSessionLive's statusline signal (dashboardMath.ts). */
export function isStatuslineFresh(snap: StatuslineSnapshot | null, nowMs: number): boolean {
  return snap !== null && nowMs - snap.capturedAtMs <= STATUSLINE_STALE_AFTER_MS;
}

/**
 * The READINESS rows. Every signal is already in the store or on
 * window.aetherElectron (passed in as `desktop` so this stays pure). None of
 * these is a request for the operator, so none is amber: met or not met.
 */
export function computeReadiness(
  state: Pick<AetherState, 'terminalAlive' | 'statusline' | 'diagnostics'>,
  desktop: boolean,
  nowMs: number,
): ReadinessRow[] {
  const statuslineFresh = isStatuslineFresh(state.statusline, nowMs);
  const collector = state.diagnostics !== null;
  return [
    {
      key: 'desktop',
      met: desktop,
      glows: false,
      text: desktop ? 'Desktop app: running.' : `Desktop app: not running. ${DESKTOP_APP_REASON}`,
    },
    {
      key: 'terminal',
      met: state.terminalAlive,
      glows: state.terminalAlive,
      text: state.terminalAlive ? 'Terminal: session running.' : 'Terminal: no session yet.',
    },
    {
      key: 'statusline',
      met: statuslineFresh,
      glows: statuslineFresh,
      text: statuslineFresh
        ? 'Statusline: live.'
        : state.statusline === null
          ? 'Statusline: no reading yet.'
          : 'Statusline: last reading is stale.',
    },
    { key: 'collector', met: collector, glows: false, text: collector ? 'Collector: running.' : 'Collector: not running.' },
  ];
}

export interface DigestPresence {
  readonly agents: boolean;
  readonly projects: boolean;
  readonly alerts: boolean;
}

/** A digest earns a panel only when it has something to show. */
export function computeDigestPresence(state: Pick<AetherState, 'realAgents' | 'projectsSnapshot' | 'notifs'>): DigestPresence {
  return {
    agents: state.realAgents.length > 0,
    projects: (state.projectsSnapshot?.roots.length ?? 0) > 0,
    alerts: state.notifs.length > 0,
  };
}

export type StripItemKey = 'agents' | 'projects' | 'alerts' | 'memory';

export interface StripItem {
  readonly key: StripItemKey;
  readonly label: string;
  readonly count: number;
  readonly unit: string | null;
}

/**
 * The STANDBY STRIP: one item per digest without data, then the memory count
 * (memory has no dashboard panel, so it rides along whenever the strip shows).
 * Empty -- the strip hides -- once every digest has a panel.
 */
export function computeStripItems(presence: DigestPresence, memoryCount: number): StripItem[] {
  if (presence.agents && presence.projects && presence.alerts) return [];
  const items: StripItem[] = [];
  if (!presence.agents) items.push({ key: 'agents', label: 'Agents', count: 0, unit: null });
  if (!presence.projects) items.push({ key: 'projects', label: 'Projects', count: 0, unit: null });
  if (!presence.alerts) items.push({ key: 'alerts', label: 'Alerts', count: 0, unit: null });
  items.push({ key: 'memory', label: 'Memory', count: memoryCount, unit: memoryCount === 1 ? 'engram' : 'engrams' });
  return items;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/dashboard/readinessMath.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/readinessMath.ts src/components/dashboard/readinessMath.test.ts
git commit -m "feat(dashboard): readiness rows, digest presence and standby-strip items (pure)"
```

---

### Task 4: OpenTerminalButton, the one OPEN TERMINAL control

**Files:**
- Create: `src/components/dashboard/OpenTerminalButton.tsx`
- Test: `src/components/dashboard/OpenTerminalButton.test.tsx`

**Interfaces:**
- Consumes: `Button` with `aria-disabled`/`aria-describedby` (Task 1); `DESKTOP_APP_REASON`, `hasDesktopApp` (Task 3); `glows.active`, `glows.primaryHover`.
- Produces: `OpenTerminalButton({ live }: { live: boolean })`. It renders a Button named "OPEN TERMINAL". In the desktop app it dispatches `SET_ACTIVE_TAB` → `'Terminal'`, with the resting `glows.active` only when `live`. In the browser it is `aria-disabled="true"` and `aria-describedby` points at a `<p>` directly beneath it that reads `DESKTOP_APP_REASON`. Its styles move here from `ReactorStatusCard.tsx`, so Task 8 must not keep its own copies.

- [ ] **Step 1: Write the failing test.** Create `src/components/dashboard/OpenTerminalButton.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { OpenTerminalButton } from './OpenTerminalButton';
import { DESKTOP_APP_REASON } from './readinessMath';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function StartOnDashboard() {
  const { state, dispatch } = useAetherStore();
  useEffect(() => {
    dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Dashboard' });
  }, [dispatch]);
  return <div data-testid="active-tab">{state.activeTab}</div>;
}

function renderButton(live = false) {
  return render(
    <AetherStoreProvider>
      <StartOnDashboard />
      <OpenTerminalButton live={live} />
    </AetherStoreProvider>,
  );
}

describe('OpenTerminalButton', () => {
  it('in browser mode is aria-disabled (not removed), says why beneath, and does not navigate', () => {
    renderButton();
    const btn = screen.getByRole('button', { name: 'OPEN TERMINAL' });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    const reason = screen.getByText(DESKTOP_APP_REASON);
    expect(btn.getAttribute('aria-describedby')).toBe(reason.id);
    expect(reason.id).not.toBe('');
    fireEvent.click(btn);
    expect(screen.getByTestId('active-tab').textContent).toBe('Dashboard');
  });

  it('in the desktop app switches to the Terminal view and shows no reason', () => {
    vi.stubGlobal('aetherElectron', {});
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'OPEN TERMINAL' }));
    expect(screen.getByTestId('active-tab').textContent).toBe('Terminal');
    expect(screen.queryByText(DESKTOP_APP_REASON)).toBeNull();
  });

  it('glows at rest only while a session is live', () => {
    vi.stubGlobal('aetherElectron', {});
    const { unmount } = renderButton(false);
    expect(screen.getByRole('button', { name: 'OPEN TERMINAL' }).style.boxShadow).toBe('');
    unmount();
    renderButton(true);
    expect(screen.getByRole('button', { name: 'OPEN TERMINAL' }).style.boxShadow).not.toBe('');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/dashboard/OpenTerminalButton.test.tsx`
Expected: FAIL with `Failed to resolve import "./OpenTerminalButton"`.

- [ ] **Step 3: Implement.** Create `src/components/dashboard/OpenTerminalButton.tsx`:

```tsx
import { useId, type CSSProperties } from 'react';
import { fonts, glows, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { DESKTOP_APP_REASON, hasDesktopApp } from './readinessMath';

/**
 * The Dashboard's one primary action, shared by the reactor card and
 * READINESS. In browser mode there is no pty to open, so it stays in place,
 * aria-disabled (still focusable, so a screen reader reaches it and hears
 * why), with the Desktop-app reason directly beneath it. Nothing about it
 * reads as an error.
 */
export function OpenTerminalButton({ live }: { live: boolean }) {
  const colors = useColors();
  const { dispatch } = useAetherStore();
  const reasonId = useId();
  const desktop = hasDesktopApp();
  return (
    <div style={wrapStyle}>
      <Button
        onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Terminal' })}
        aria-disabled={desktop ? undefined : true}
        aria-describedby={desktop ? undefined : reasonId}
        style={desktop ? primaryActionStyle(colors, live) : disabledActionStyle(colors)}
        hoverStyle={desktop ? primaryActionHoverStyle : NO_HOVER}
      >
        <span aria-hidden="true">⊕</span> OPEN TERMINAL
      </Button>
      {!desktop && (
        <p id={reasonId} style={reasonStyle(colors)}>
          {DESKTOP_APP_REASON}
        </p>
      )}
    </div>
  );
}

const wrapStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 14 };

// Primary stays the filled cyan switch; per Glow-Is-State it only glows when
// a session is live (the terminal it opens is doing work) or when hovered /
// keyboard-focused (Button applies hoverStyle for both). Flat at STANDBY rest.
function primaryActionStyle(colors: ColorPalette, live: boolean): CSSProperties {
  return {
    textAlign: 'center',
    cursor: 'pointer',
    font: `600 11px/1 ${fonts.ui}`,
    letterSpacing: 1.5,
    color: colors.inkOnCyan,
    background: `linear-gradient(180deg, ${colors.accentCyan}, ${colors.accentCyanDeep})`,
    padding: '10px 0',
    borderRadius: 8,
    boxShadow: live ? glows.active : undefined,
  };
}
// DESIGN.md Buttons > Hover: brighter, a stronger glow, a 1px lift.
const primaryActionHoverStyle: CSSProperties = {
  filter: 'brightness(1.1)',
  boxShadow: glows.primaryHover,
  transform: 'translateY(-1px)',
};
// DESIGN.md button-primary-disabled: inset background, Text Dim label, no glow.
function disabledActionStyle(colors: ColorPalette): CSSProperties {
  return {
    textAlign: 'center',
    cursor: 'default',
    font: `600 11px/1 ${fonts.ui}`,
    letterSpacing: 1.5,
    color: colors.textDim,
    background: colors.panelInset,
    border: `1px solid ${colors.chromeBorder}`,
    padding: '10px 0',
    borderRadius: 8,
  };
}
// An empty hover style: a disabled control doesn't light up under the pointer.
// (Button's default hover would otherwise brighten it.) Keyboard focus still
// gets the ring.
const NO_HOVER: CSSProperties = {};
function reasonStyle(colors: ColorPalette): CSSProperties {
  return { margin: 0, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textMuted };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/dashboard/OpenTerminalButton.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/OpenTerminalButton.tsx src/components/dashboard/OpenTerminalButton.test.tsx
git commit -m "feat(dashboard): shared OPEN TERMINAL control, aria-disabled with its reason in browser mode"
```

---

### Task 5: READINESS panel

**Files:**
- Create: `src/components/dashboard/ReadinessCard.tsx`
- Test: `src/components/dashboard/ReadinessCard.test.tsx`

**Interfaces:**
- Consumes: `computeReadiness`, `hasDesktopApp` (Task 3); `OpenTerminalButton` (Task 4); `dotGlow` (Task 2); `isSessionLive` (existing).
- Produces: `ReadinessCard()`: a `<section aria-labelledby>` with `h2` READINESS, a `ul` of 4 `li` (`data-testid="readiness-<key>"`, dot `data-testid="readiness-dot-<key>"`), then `<OpenTerminalButton live={...} />`. Its root style has `flex: 'none'`, so it sits at its natural height in the right column.

- [ ] **Step 1: Write the failing test.** Create `src/components/dashboard/ReadinessCard.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { ReadinessCard } from './ReadinessCard';
import { DESKTOP_APP_REASON } from './readinessMath';
import type { StatuslineSnapshot } from '../../shared/statuslinePayload';

const freshStatusline = (): StatuslineSnapshot => ({
  capturedAtMs: Date.now(),
  sessionId: null,
  modelId: null,
  modelDisplayName: null,
  fiveHour: null,
  sevenDay: null,
  contextUsedPercentage: null,
  contextWindowSize: null,
  contextUsage: null,
  totalCostUsd: null,
  currentDir: null,
  projectDir: null,
});

let dispatchRef: ReturnType<typeof useAetherStore>['dispatch'] | null = null;
function DispatchProbe() {
  dispatchRef = useAetherStore().dispatch;
  return null;
}
function renderCard() {
  const utils = render(
    <AetherStoreProvider>
      <DispatchProbe />
      <ReadinessCard />
    </AetherStoreProvider>,
  );
  return utils;
}
function allMet() {
  act(() => {
    dispatchRef!({ type: 'SET_TERMINAL_ALIVE', alive: true });
    dispatchRef!({ type: 'SET_STATUSLINE', snapshot: freshStatusline() });
    dispatchRef!({ type: 'SET_DIAGNOSTICS', diagnostics: { toolCalls: [], dispatches: [], anomalies: [] } });
  });
}
const rowText = (key: string) => screen.getByTestId(`readiness-${key}`).textContent;
const dot = (key: string) => screen.getByTestId(`readiness-dot-${key}`);

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReadinessCard', () => {
  it('is an h2-headed list of four rows', () => {
    renderCard();
    expect(screen.getByRole('heading', { level: 2, name: 'READINESS' })).toBeTruthy();
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(4);
  });

  it('reads the cold browser-mode sentences', () => {
    renderCard();
    expect(rowText('desktop')).toBe(`Desktop app: not running. ${DESKTOP_APP_REASON}`);
    expect(rowText('terminal')).toBe('Terminal: no session yet.');
    expect(rowText('statusline')).toBe('Statusline: no reading yet.');
    expect(rowText('collector')).toBe('Collector: not running.');
  });

  it('reads all four met sentences in the desktop app with a session, a statusline and the collector', () => {
    vi.stubGlobal('aetherElectron', {});
    renderCard();
    allMet();
    expect(rowText('desktop')).toBe('Desktop app: running.');
    expect(rowText('terminal')).toBe('Terminal: session running.');
    expect(rowText('statusline')).toBe('Statusline: live.');
    expect(rowText('collector')).toBe('Collector: running.');
  });

  it('updates a row within one store update', () => {
    renderCard();
    act(() => dispatchRef!({ type: 'SET_TERMINAL_ALIVE', alive: true }));
    expect(rowText('terminal')).toBe('Terminal: session running.');
  });

  it('lights only the live signals: Terminal and Statusline glow, Desktop app and Collector stay flat', () => {
    vi.stubGlobal('aetherElectron', {});
    renderCard();
    allMet();
    expect(dot('terminal').style.boxShadow).not.toBe('');
    expect(dot('statusline').style.boxShadow).not.toBe('');
    expect(dot('desktop').style.boxShadow).toBe('');
    expect(dot('collector').style.boxShadow).toBe('');
  });

  it('draws an unmet row as a flat hollow ring', () => {
    renderCard();
    expect(dot('terminal').style.background).toBe('transparent');
    expect(dot('terminal').style.boxShadow).toBe('');
  });

  it('holds the OPEN TERMINAL action', () => {
    renderCard();
    expect(screen.getByRole('button', { name: 'OPEN TERMINAL' })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/dashboard/ReadinessCard.test.tsx`
Expected: FAIL with `Failed to resolve import "./ReadinessCard"`.

- [ ] **Step 3: Implement.** Create `src/components/dashboard/ReadinessCard.tsx`:

```tsx
import { useId, type CSSProperties } from 'react';
import { dotGlow, fonts, radii, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { isSessionLive } from './dashboardMath';
import { computeReadiness, hasDesktopApp } from './readinessMath';
import { OpenTerminalButton } from './OpenTerminalButton';

/**
 * READINESS: what the console needs before it can show live work, as four
 * plain sentences. Met is Nominal Green; unmet is a hollow muted ring -- never
 * amber, because none of these asks the operator for anything. No aria-live:
 * the Footer is the one status announcement.
 */
export function ReadinessCard() {
  const colors = useColors();
  const { state } = useAetherStore();
  const headingId = useId();
  const now = Date.now();
  const rows = computeReadiness(state, hasDesktopApp(), now);
  return (
    <section aria-labelledby={headingId} style={cardStyle(colors)}>
      <h2 id={headingId} style={{ ...titleStyle(colors), margin: 0 }}>
        READINESS
      </h2>
      <ul style={listStyle}>
        {rows.map((r) => (
          <li key={r.key} data-testid={`readiness-${r.key}`} style={rowStyle(colors)}>
            <span aria-hidden="true" data-testid={`readiness-dot-${r.key}`} style={dotStyle(colors, r.met, r.glows)} />
            <span>{r.text}</span>
          </li>
        ))}
      </ul>
      <OpenTerminalButton live={isSessionLive(state, now)} />
    </section>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 'none',
    padding: 15,
    borderRadius: radii.panel,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
    display: 'flex',
    flexDirection: 'column',
  };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
const listStyle: CSSProperties = { listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 9 };
function rowStyle(colors: ColorPalette): CSSProperties {
  return { display: 'flex', alignItems: 'center', gap: 10, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textBody };
}
function dotStyle(colors: ColorPalette, met: boolean, glows: boolean): CSSProperties {
  return {
    flex: 'none',
    width: 8,
    height: 8,
    borderRadius: '50%',
    boxSizing: 'border-box',
    background: met ? colors.success : 'transparent',
    border: `1px solid ${met ? colors.success : colors.textMuted}`,
    boxShadow: met && glows ? dotGlow(colors.success) : undefined,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/dashboard/ReadinessCard.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/ReadinessCard.tsx src/components/dashboard/ReadinessCard.test.tsx
git commit -m "feat(dashboard): READINESS panel with four plain-sentence rows"
```

---

### Task 6: STANDBY STRIP

**Files:**
- Create: `src/components/dashboard/StandbyStrip.tsx`
- Test: `src/components/dashboard/StandbyStrip.test.tsx`

**Interfaces:**
- Consumes: `computeDigestPresence`, `computeStripItems`, `StripItemKey` (Task 3); `srOnlyStyle`.
- Produces: `StandbyStrip()`, which returns `null` when there are no items. Otherwise it renders a `<section aria-labelledby>` with a visually hidden `h2` "Standby" and one `Button` per item. Each button's accessible name is `"<Label> <count>"` (plus `" <unit>"` for memory), and items are separated by `aria-hidden` `·`. Navigation: Agents → `SET_ACTIVE_TAB 'Agents'`; Projects → `'Projects'`; Memory → `'Memory'`; Alerts → `TOGGLE_NOTIFS`, only when `notifOpen` is false. Root style has `flex: 'none'`.

- [ ] **Step 1: Write the failing test.** Create `src/components/dashboard/StandbyStrip.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import type { Action } from '../../state/reducer';
import type { MemoryRow } from '../../state/types';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';
import { StandbyStrip } from './StandbyStrip';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function DispatchOnMount({ actions, children }: { actions: Action[]; children: ReactNode }) {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    actions.forEach((a) => dispatch(a));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <>{children}</>;
}
function Probe() {
  const { state } = useAetherStore();
  return <div data-testid="probe" data-tab={state.activeTab} data-notif-open={String(state.notifOpen)} />;
}
function renderStrip(actions: Action[] = []) {
  return render(
    <AetherStoreProvider>
      <DispatchOnMount actions={[{ type: 'SET_ACTIVE_TAB', tab: 'Dashboard' }, ...actions]}>
        <StandbyStrip />
        <Probe />
      </DispatchOnMount>
    </AetherStoreProvider>,
  );
}

const AGENT = { toolUseId: 'tu-1', subagentType: 'Explore', description: 'scan', startedAt: new Date().toISOString(), prompt: 'p', model: null };
const PROJECTS: ProjectsSnapshot = { roots: [{ key: 'r1' } as ProjectsSnapshot['roots'][number]], unscoped: null, computedAtMs: 0 };

describe('StandbyStrip', () => {
  it('lists each digest without data, then the memory count, as buttons', () => {
    renderStrip([{ type: 'SET_MEMORIES', memories: [{ id: 1 } as MemoryRow, { id: 2 } as MemoryRow] }]);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Agents 0', 'Projects 0', 'Alerts 0', 'Memory 2 engrams']);
    expect(screen.getByRole('heading', { level: 2, name: 'Standby' })).toBeTruthy();
  });

  it('drops the Agents item while an agent is running', () => {
    renderStrip([{ type: 'SET_REAL_AGENTS', agents: [AGENT] }]);
    expect(screen.queryByRole('button', { name: 'Agents 0' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Projects 0' })).toBeTruthy();
  });

  it('is hidden when agents, projects and alerts all have data', () => {
    renderStrip([
      { type: 'SET_REAL_AGENTS', agents: [AGENT] },
      { type: 'SET_PROJECTS_SNAPSHOT', snapshot: PROJECTS },
      { type: 'SET_OP_MODE', mode: 'EDITS' }, // pushes a notif
    ]);
    expect(screen.queryByRole('heading', { name: 'Standby' })).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('navigates each item to its view, and Alerts opens the alerts dropdown', () => {
    renderStrip();
    const probe = () => screen.getByTestId('probe');
    fireEvent.click(screen.getByRole('button', { name: 'Agents 0' }));
    expect(probe().dataset.tab).toBe('Agents');
    fireEvent.click(screen.getByRole('button', { name: 'Projects 0' }));
    expect(probe().dataset.tab).toBe('Projects');
    fireEvent.click(screen.getByRole('button', { name: 'Memory 0 engrams' }));
    expect(probe().dataset.tab).toBe('Memory');
    fireEvent.click(screen.getByRole('button', { name: 'Alerts 0' }));
    expect(probe().dataset.notifOpen).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Alerts 0' }));
    expect(probe().dataset.notifOpen).toBe('true'); // never toggles it shut
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/dashboard/StandbyStrip.test.tsx`
Expected: FAIL with `Failed to resolve import "./StandbyStrip"`.

- [ ] **Step 3: Implement.** Create `src/components/dashboard/StandbyStrip.tsx`:

```tsx
import { Fragment, useId, type CSSProperties } from 'react';
import { fonts, radii, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { srOnlyStyle } from '../shared/srOnly';
import { computeDigestPresence, computeStripItems, type StripItemKey } from './readinessMath';

const TAB_BY_KEY: Record<Exclude<StripItemKey, 'alerts'>, string> = { agents: 'Agents', projects: 'Projects', memory: 'Memory' };

/**
 * One thin line for every digest with nothing to show, so an idle console
 * doesn't draw empty panels. Each count links to where that data will live.
 * Hidden once every digest has its own panel.
 */
export function StandbyStrip() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const headingId = useId();
  const items = computeStripItems(computeDigestPresence(state), state.memories.length);
  if (items.length === 0) return null;

  function go(key: StripItemKey) {
    if (key === 'alerts') {
      if (!state.notifOpen) dispatch({ type: 'TOGGLE_NOTIFS' });
      return;
    }
    dispatch({ type: 'SET_ACTIVE_TAB', tab: TAB_BY_KEY[key] });
  }

  return (
    <section aria-labelledby={headingId} style={stripStyle(colors)}>
      <h2 id={headingId} style={srOnlyStyle}>
        Standby
      </h2>
      {items.map((it, i) => (
        <Fragment key={it.key}>
          {i > 0 && (
            <span aria-hidden="true" style={sepStyle(colors)}>
              ·
            </span>
          )}
          <Button onClick={() => go(it.key)} style={itemStyle}>
            <span style={labelStyle(colors)}>{it.label}</span> <span style={countStyle(colors)}>{it.count}</span>
            {it.unit !== null && (
              <>
                {' '}
                <span style={labelStyle(colors)}>{it.unit}</span>
              </>
            )}
          </Button>
        </Fragment>
      ))}
    </section>
  );
}

function stripStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 'none',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    padding: '10px 15px',
    borderRadius: radii.panel,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
  };
}
const itemStyle: CSSProperties = { cursor: 'pointer', padding: '4px 6px', borderRadius: radii.chip };
function labelStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 1, color: colors.textSecondary };
}
// Numbers Are Mono; memory's count drops its old #8ab6ff for Soft Signal.
function countStyle(colors: ColorPalette): CSSProperties {
  return { font: `700 12px/1 ${fonts.mono}`, color: colors.accentCyanSoft };
}
function sepStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 12px/1 ${fonts.mono}`, color: colors.textDim };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/dashboard/StandbyStrip.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/StandbyStrip.tsx src/components/dashboard/StandbyStrip.test.tsx
git commit -m "feat(dashboard): STANDBY STRIP of empty digests and the memory count"
```

---

### Task 7: DigestSlot, the enter/exit wrapper for a digest panel

**Files:**
- Create: `src/components/dashboard/DigestSlot.tsx`
- Modify: `src/styles/global.css` (add a keyframe after `@keyframes slideIn`)
- Test: `src/components/dashboard/DigestSlot.test.tsx`

**Interfaces:**
- Consumes: `motion.duration.slow`, `motion.easing.decelerate`, `useReducedMotion`.
- Produces: `DigestSlot({ present, children }: { present: boolean; children: ReactNode })` and `DIGEST_EXIT_MS: number` (= 500). It renders `null` while absent. A panel present at first render is `data-phase="steady"`. Gaining data sets `data-phase="entering"` (the `digestEnter` animation). Losing data sets `data-phase="leaving"`: opacity 0 + translateY over slow/decelerate, `aria-hidden`, and unmount after `DIGEST_EXIT_MS`. Under reduced motion there is no animation, and it unmounts at once. The wrapper is `flex: '1 1 0'` with a one-row grid, so the child panel fills it.

- [ ] **Step 1: Write the failing test.** Create `src/components/dashboard/DigestSlot.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { DigestSlot, DIGEST_EXIT_MS } from './DigestSlot';

function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
}
const slot = (present: boolean) => (
  <DigestSlot present={present}>
    <div>panel</div>
  </DigestSlot>
);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('DigestSlot', () => {
  it('renders nothing while its digest has no data, and a steady panel when it has data from the start', () => {
    stubReducedMotion(false);
    const { unmount } = render(slot(false));
    expect(screen.queryByText('panel')).toBeNull();
    unmount();
    render(slot(true));
    expect(screen.getByTestId('digest-slot').dataset.phase).toBe('steady');
  });

  it('enters with the digestEnter animation when its digest gains data', () => {
    stubReducedMotion(false);
    const { rerender } = render(slot(false));
    rerender(slot(true));
    expect(screen.getByTestId('digest-slot').dataset.phase).toBe('entering');
  });

  it('fades out on opacity and transform only, then unmounts after motion.duration.slow', () => {
    stubReducedMotion(false);
    const { rerender } = render(slot(true));
    rerender(slot(false));
    const el = screen.getByTestId('digest-slot');
    expect(el.dataset.phase).toBe('leaving');
    expect(el.style.opacity).toBe('0');
    expect(el.style.transition).toContain('opacity');
    expect(el.style.transition).toContain('transform');
    expect(el.style.transition).not.toContain('height');
    act(() => {
      vi.advanceTimersByTime(DIGEST_EXIT_MS - 1);
    });
    expect(screen.getByText('panel')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('panel')).toBeNull();
  });

  it('under reduced motion appears and disappears without animating', () => {
    stubReducedMotion(true);
    const { rerender } = render(slot(false));
    rerender(slot(true));
    expect(screen.getByTestId('digest-slot').dataset.phase).toBe('steady');
    rerender(slot(false));
    expect(screen.queryByText('panel')).toBeNull();
  });

  it('stays mounted when its digest regains data mid-exit', () => {
    stubReducedMotion(false);
    const { rerender } = render(slot(true));
    rerender(slot(false));
    act(() => {
      vi.advanceTimersByTime(DIGEST_EXIT_MS / 2);
    });
    rerender(slot(true));
    act(() => {
      vi.advanceTimersByTime(DIGEST_EXIT_MS);
    });
    expect(screen.getByText('panel')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/dashboard/DigestSlot.test.tsx`
Expected: FAIL with `Failed to resolve import "./DigestSlot"`.

- [ ] **Step 3: Implement.**

In `src/styles/global.css`, directly after the closing `}` of `@keyframes slideIn`:

```css
/* DigestSlot: a dashboard digest arriving. Transform/opacity only -- the
   column reflows at once; height is never animated. */
@keyframes digestEnter {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
```

Create `src/components/dashboard/DigestSlot.tsx`:

```tsx
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { motion } from '../../styles/tokens';
import { useReducedMotion } from '../shared/useReducedMotion';

type Phase = 'steady' | 'entering' | 'leaving';

/** How long a leaving digest stays mounted while it fades: motion.duration.slow, in ms. */
export const DIGEST_EXIT_MS = parseFloat(motion.duration.slow) * 1000;

/**
 * Wraps one dashboard digest. A digest is drawn only while it has data;
 * gaining data brings it in (opacity + a short rise), losing data fades it
 * out before it unmounts. Transform/opacity only (the column reflows at
 * once), and under reduced motion it simply appears and disappears.
 */
export function DigestSlot({ present, children }: { present: boolean; children: ReactNode }) {
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const [mounted, setMounted] = useState(present);
  const [phase, setPhase] = useState<Phase>('steady');
  // Compare with the last value rather than skipping the first run: StrictMode
  // re-runs mount effects, and a first-run flag would animate a panel that
  // was there from the start.
  const prevPresent = useRef(present);

  useEffect(() => {
    if (prevPresent.current === present) return;
    prevPresent.current = present;
    if (present) {
      setMounted(true);
      setPhase(reducedRef.current ? 'steady' : 'entering');
      return;
    }
    if (reducedRef.current) {
      setMounted(false);
      setPhase('steady');
      return;
    }
    setPhase('leaving');
    // Cleared by the next run if the digest regains data mid-exit.
    const t = setTimeout(() => {
      setMounted(false);
      setPhase('steady');
    }, DIGEST_EXIT_MS);
    return () => clearTimeout(t);
  }, [present]);

  if (!mounted) return null;
  return (
    <div data-testid="digest-slot" data-phase={phase} aria-hidden={phase === 'leaving' ? true : undefined} style={slotStyle(phase)}>
      {children}
    </div>
  );
}

const EASE = motion.easing.decelerate;
function slotStyle(phase: Phase): CSSProperties {
  const base: CSSProperties = { flex: '1 1 0', minHeight: 0, display: 'grid', gridTemplateRows: 'minmax(0, 1fr)' };
  if (phase === 'entering') return { ...base, animation: `digestEnter ${motion.duration.slow} ${EASE} both` };
  if (phase === 'leaving') {
    return {
      ...base,
      opacity: 0,
      transform: 'translateY(8px)',
      pointerEvents: 'none',
      transition: `opacity ${motion.duration.slow} ${EASE}, transform ${motion.duration.slow} ${EASE}`,
    };
  }
  return base;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/dashboard/DigestSlot.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/DigestSlot.tsx src/components/dashboard/DigestSlot.test.tsx src/styles/global.css
git commit -m "feat(dashboard): DigestSlot enter/exit on transform+opacity, reduced-motion aware"
```

---

### Task 8: Reactor card: TODAY tile, idle rate line, OPEN TERMINAL only

**Files:**
- Modify: `src/components/dashboard/ReactorStatusCard.tsx` (full replacement below)
- Test: `src/components/dashboard/ReactorStatusCard.test.tsx`

**Interfaces:**
- Consumes: `computeDashKpis` (new order and TODAY), `computeRateLine`, `statusDotGlows` (Task 2); `dotGlow` (Task 2); `OpenTerminalButton` (Task 4).
- Produces: `ReactorStatusCard()` with an unchanged export name. Its panel no longer sets `gridRow: 'span 2'`, and it renders exactly one button. New test hooks: each tile is `data-testid="kpi-tile"` with `data-kpi="<key>"`, containing `kpi-value` and `kpi-caption`; the rate line is `data-testid="reactor-rate-line"`. `computeReactorAriaLabel` is unchanged.

- [ ] **Step 1: Write the failing tests.** In `src/components/dashboard/ReactorStatusCard.test.tsx`:

(a) Add to the imports:

```tsx
import { within } from '@testing-library/react';
import { buildLedgerSnapshot } from '../../shared/ledgerMath';
```

(b) In `describe('ReactorStatusCard live state', ...)`, add as its first statement:

```tsx
  // A live session implies the desktop app; without it OPEN TERMINAL is aria-disabled and never glows.
  beforeEach(() => vi.stubGlobal('aetherElectron', {}));
```

(c) Append a new describe block at the end of the file:

```tsx
describe('ReactorStatusCard idle composition', () => {
  let dispatchRef: ReturnType<typeof useAetherStore>['dispatch'] | null = null;
  function DispatchProbe() {
    dispatchRef = useAetherStore().dispatch;
    return null;
  }
  function renderCard() {
    return render(
      <AetherStoreProvider>
        <DispatchProbe />
        <ReactorStatusCard />
      </AetherStoreProvider>,
    );
  }
  const tile = (k: string) => screen.getAllByTestId('kpi-tile').find((t) => t.dataset.kpi === k)!;

  it('orders the tiles MONTH TOKENS, DEPLETION ETA, TODAY, BUDGET LEFT, each — with no source', () => {
    renderCard();
    const tiles = screen.getAllByTestId('kpi-tile');
    expect(tiles.map((t) => t.dataset.kpi)).toEqual(['MONTH TOKENS', 'DEPLETION ETA', 'TODAY', 'BUDGET LEFT']);
    expect(tiles.map((t) => within(t).getByTestId('kpi-value').textContent)).toEqual(['—', '—', '—', '—']);
  });

  it("shows TODAY as today's exact API-rate cost with its caption", () => {
    renderCard();
    act(() =>
      dispatchRef!({
        type: 'SET_LEDGER',
        ledger: { ...buildLedgerSnapshot([], 'UTC', Date.now()), rollups: { today: 1.5, week: 1.5, month: 1.5 } },
      }),
    );
    expect(within(tile('TODAY')).getByTestId('kpi-value').textContent).toBe('$1.50');
    expect(within(tile('TODAY')).getByTestId('kpi-caption').textContent).toBe('API rate, not paid');
  });

  it('reads exactly "— tok/min · standby" under the reactor when idle', () => {
    renderCard();
    expect(screen.getByTestId('reactor-rate-line').textContent).toBe('— tok/min · standby');
  });

  it('offers OPEN TERMINAL as its only action (MEMORY SWEEP is gone)', () => {
    renderCard();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'OPEN TERMINAL' })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/dashboard/ReactorStatusCard.test.tsx`
Expected: FAIL. `kpi-tile` is not found, the rate line reads `— tok/min · live-rate pulse · standby` (or `standby` after Task 2, but without the test id), and there are 2 buttons.

- [ ] **Step 3: Implement.** Replace the contents of `src/components/dashboard/ReactorStatusCard.tsx` with:

```tsx
import type { CSSProperties } from 'react';
import { dotGlow, fonts, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { fmt, fmtEta } from '../../utils/format';
import { NO_DATA, computeDashKpis, computeDashStatus, computeRateLine, isSessionLive, statusDotGlows } from './dashboardMath';
import { Reactor, reactorNativeSize } from '../reactor/Reactor';
import { deriveDepletion, formatResetCountdown } from '../../shared/depletion';
import type { AetherState } from '../../state/types';
import { OpenTerminalButton } from './OpenTerminalButton';

type TileSource = 'live' | 'stale' | 'est';

/**
 * DEPLETION ETA is the one dashboard tile backed by the statusline, which is
 * what earns it a LIVE/STALE source chip. This derives its override
 * (value/detail/source/stale); every other tile from computeDashKpis renders
 * unchanged. Freshness is judged off the capture's age against
 * STATUSLINE_STALE_AFTER_MS, the same rule the footer's CONTEXT WINDOW card uses.
 */
function deriveDepletionOverride(state: AetherState): { v: string; s: string; source: TileSource; stale: boolean } | null {
  const depletion = deriveDepletion(state.statusline, null, Date.now());
  const stale = depletion.stale;
  if (depletion.source !== 'statusline') return null; // fall back to today's estimate
  const etaPart =
    depletion.msUntilDepleted === null ? NO_DATA : depletion.msUntilDepleted <= 0 ? 'now' : fmtEta(depletion.msUntilDepleted / 1000);
  // `~` marks a stale value; with no value there is nothing to qualify.
  const prefix = stale && etaPart !== NO_DATA ? '~' : '';
  return {
    v: `${prefix}${etaPart} · resets ${formatResetCountdown(depletion.msUntilReset)}`,
    s: 'server rate limit',
    source: stale ? 'stale' : 'live',
    stale,
  };
}

/**
 * The reactor is a canvas instrument, so assistive tech gets its reading as a
 * static image label built from the same status and source the card prints:
 * the status from computeDashStatus, the rate from
 * state.realUsage.burnRatePerMin under computeRateReadout's own gating (live
 * and scanned). Built from the field, not by re-parsing the printed readout.
 *
 * Not a live region. The card adds no aria-live of its own; the always-mounted
 * Footer carries the reactor status announcement. (The shell has other polite
 * regions -- TopBar's approvals and notifications counts, the Sidebar legend --
 * but none of them repeats this status.)
 */
export function computeReactorAriaLabel(state: AetherState, live: boolean): string {
  const status = computeDashStatus(state.alarmLevel, live);
  const hasRate = live && state.realUsage.lastScanAt !== null;
  const rate = hasRate ? `${fmt(state.realUsage.burnRatePerMin)} tokens per minute` : 'no live rate';
  return `Reactor: ${status}, ${rate}`;
}

export function ReactorStatusCard() {
  const colors = useColors();
  const { state } = useAetherStore();
  const live = isSessionLive(state, Date.now());
  // Standby reads muted: a live colour on an idle console would claim a session (DESIGN.md).
  const statusC =
    state.alarmLevel === 'crit' ? colors.danger : state.alarmLevel === 'warn' ? colors.warn : live ? colors.success : colors.textMuted;
  const kpis = computeDashKpis(state);

  return (
    <div style={cardStyle(colors)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ ...titleStyle(colors), margin: 0 }}>REACTOR STATUS</h2>
        {/* Not aria-live: the always-mounted Footer carries the status
            announcement, so a transition isn't announced twice while the
            Dashboard is open. */}
        <div data-testid="reactor-status-label" style={{ display: 'flex', alignItems: 'center', gap: 6, font: `400 11px/1 ${fonts.mono}`, color: statusC }}>
          {/* Glow-Is-State: the dot glows only when live or alarmed; flat at STANDBY. Same gate as the Footer's dot. */}
          <span
            data-testid="reactor-status-dot"
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: statusC,
              boxShadow: statusDotGlows(state.alarmLevel, live) ? dotGlow(statusC) : undefined,
            }}
          />
          {computeDashStatus(state.alarmLevel, live)}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: DASH_REACTOR_SIZE, display: 'grid', placeItems: 'center', padding: '8px 0' }}>
        <div role="img" aria-label={computeReactorAriaLabel(state, live)} style={{ position: 'relative', width: DASH_REACTOR_SIZE, height: DASH_REACTOR_SIZE }}>
          <div style={reactorInnerStyle(reactorNativeSize(state.cfg.renderer))}>
            <Reactor />
          </div>
        </div>
      </div>
      <div data-testid="reactor-rate-line" style={{ textAlign: 'center', font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>
        {computeRateLine(state, live)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginTop: 16 }}>
        {kpis.map((dk) => {
          const override = dk.k === 'DEPLETION ETA' ? deriveDepletionOverride(state) : null;
          const source: TileSource = override ? override.source : 'est';
          const v = override ? override.v : dk.v;
          const s = override ? override.s : dk.s;
          // A tile with no reading has nothing to attribute, so no source chip.
          const hasSourceChip = dk.k === 'DEPLETION ETA' && v !== NO_DATA;
          const isWarn = override?.stale ?? false;
          return (
            <div key={dk.k} data-testid="kpi-tile" data-kpi={dk.k} style={kpiTileStyle(colors)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ font: `600 11px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted }}>{dk.k}</div>
                {hasSourceChip && (
                  <span style={sourceChipStyle(colors, source)}>{source === 'live' ? 'LIVE' : source === 'stale' ? 'STALE' : 'EST'}</span>
                )}
              </div>
              <div data-testid="kpi-value" style={kpiValueStyle(colors, isWarn)}>
                {v}
              </div>
              <div data-testid="kpi-caption" style={{ font: `400 11px/1 ${fonts.mono}`, color: colors.textDim, marginTop: 5 }}>
                {s}
              </div>
            </div>
          );
        })}
      </div>

      {/* MEMORY SWEEP moved off the dashboard (it lives on the Memory view). */}
      <OpenTerminalButton live={live} />
    </div>
  );
}

// No gridRow span: the Dashboard is two columns now and this card fills the left one.
function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: 16,
    borderRadius: 14,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
// The dashboard centrepiece. The frame is a fixed 1536x1024 design scaled as a
// whole (frameScale.ts), so a fixed size here fills the panel's free band
// between the header and the KPI tiles at every window size.
const DASH_REACTOR_SIZE = 360;
function reactorInnerStyle([nativeWidth, nativeHeight]: [number, number]): CSSProperties {
  const scale = DASH_REACTOR_SIZE / Math.max(nativeWidth, nativeHeight);
  return {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: nativeWidth,
    height: nativeHeight,
    // Same centring as Sidebar.tsx's reactorMiniInnerStyle: ReactorCore's
    // glow/core canvases have no offsets and rely on a grid/placeItems:center
    // parent, and StormCore centres itself the same way. Scale only through
    // this transform, never by resizing the reactor.
    display: 'grid',
    placeItems: 'center',
    transform: `translate(-50%, -50%) scale(${scale})`,
  };
}
function kpiTileStyle(colors: ColorPalette): CSSProperties {
  // No fixed height: the DEPLETION ETA value can be a much longer live string
  // (e.g. "~2h 14m · resets 3h 01m") than the estimate it replaces ("3h 12m"),
  // and this tile must be able to grow to an intrinsic, wrapped height rather
  // than clip or force the grid to blow out. minWidth: 0 keeps a long
  // unbroken value from forcing the 2-column grid's track wider than
  // intended; the reactor slot above is flex: 1, so it gives up its spare
  // height (down to DASH_REACTOR_SIZE) before this row pushes anything off.
  return { padding: '11px 12px', borderRadius: 9, border: `1px solid ${colors.chromeBorder}`, background: colors.panelInset, minWidth: 0 };
}
function kpiValueStyle(colors: ColorPalette, isWarn: boolean): CSSProperties {
  return {
    font: `700 17px/1.25 ${fonts.mono}`,
    color: isWarn ? colors.warn : colors.textPrimary,
    marginTop: 7,
    overflowWrap: 'break-word',
  };
}
function sourceChipStyle(colors: ColorPalette, source: TileSource): CSSProperties {
  return {
    font: `700 11px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: source === 'live' ? colors.success : source === 'stale' ? colors.warn : colors.textMuted,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelInset,
    padding: '2px 5px',
    borderRadius: 4,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/dashboard/ReactorStatusCard.test.tsx`
Expected: PASS. That includes the pre-existing tests: STANDBY label, single live region in the footer, the aria image label, flat OPEN TERMINAL at rest, glow when live with the desktop stub, and the dot flat/lit.

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/ReactorStatusCard.tsx src/components/dashboard/ReactorStatusCard.test.tsx
git commit -m "feat(dashboard): reactor card TODAY tile, idle rate line, OPEN TERMINAL as the only action"
```

---

### Task 9: Dashboard two-column layout; retire SYSTEMS

**Files:**
- Modify: `src/components/dashboard/DashboardView.tsx` (full replacement)
- Delete: `src/components/dashboard/SystemsCard.tsx`
- Test: `src/components/dashboard/DashboardView.test.tsx` (new)

**Interfaces:**
- Consumes: `computeDigestPresence` (Task 3), `ReadinessCard` (Task 5), `StandbyStrip` (Task 6), `DigestSlot` (Task 7), `ReactorStatusCard` (Task 8), and the existing `ActiveAgentsDigest`, `ProjectsDigest`, `RecentAlertsCard`.
- Produces: `DashboardView()`. The left column is the reactor card. The right column (`data-testid="dashboard-right-column"`) holds READINESS, the agents/projects/alerts slots, then the strip.

- [ ] **Step 1: Write the failing test.** Create `src/components/dashboard/DashboardView.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import type { Action } from '../../state/reducer';
import { DashboardView } from './DashboardView';

// ReactorStatusCard renders <Reactor> and DigestSlot reads prefers-reduced-motion.
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function DispatchOnMount({ actions, children }: { actions: Action[]; children: ReactNode }) {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    actions.forEach((a) => dispatch(a));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <>{children}</>;
}
function renderDashboard(actions: Action[] = []) {
  return render(
    <AetherStoreProvider>
      <DispatchOnMount actions={actions}>
        <DashboardView />
      </DispatchOnMount>
    </AetherStoreProvider>,
  );
}
const AGENT = { toolUseId: 'tu-1', subagentType: 'Explore', description: 'scan', startedAt: new Date().toISOString(), prompt: 'p', model: null };

describe('DashboardView layout', () => {
  it('at a cold STANDBY shows READINESS and the strip beside the reactor, and no digest or SYSTEMS panel', () => {
    renderDashboard();
    const right = screen.getByTestId('dashboard-right-column');
    expect(within(right).getByRole('heading', { name: 'READINESS' })).toBeTruthy();
    expect(within(right).getAllByRole('button').map((b) => b.textContent)).toContain('Agents 0');
    expect(within(right).queryByRole('heading', { name: 'REACTOR STATUS' })).toBeNull();
    for (const name of ['ACTIVE AGENTS', 'PROJECTS', 'RECENT ALERTS', 'SYSTEMS']) {
      expect(screen.queryByRole('heading', { name })).toBeNull();
    }
  });

  it('turns a digest with data into a panel in the right column and drops it from the strip', () => {
    renderDashboard([{ type: 'SET_REAL_AGENTS', agents: [AGENT] }]);
    const right = screen.getByTestId('dashboard-right-column');
    expect(within(right).getByRole('heading', { name: 'ACTIVE AGENTS' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Agents 0' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Projects 0' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Alerts 0' })).toBeTruthy();
  });

  it('adds no heading level 1 (the shell owns the one h1)', () => {
    const { container } = renderDashboard();
    expect(container.querySelectorAll('h1')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/dashboard/DashboardView.test.tsx`
Expected: FAIL with `Unable to find an element by: [data-testid="dashboard-right-column"]`.

- [ ] **Step 3: Implement.** Replace `src/components/dashboard/DashboardView.tsx` with:

```tsx
import type { CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { ReactorStatusCard } from './ReactorStatusCard';
import { ReadinessCard } from './ReadinessCard';
import { StandbyStrip } from './StandbyStrip';
import { DigestSlot } from './DigestSlot';
import { ActiveAgentsDigest } from './ActiveAgentsDigest';
import { ProjectsDigest } from './ProjectsDigest';
import { RecentAlertsCard } from './RecentAlertsCard';
import { computeDigestPresence } from './readinessMath';

/**
 * Two columns. The reactor fills the left half. The right half is READINESS,
 * then a panel for each digest that has data, then the STANDBY STRIP listing
 * the ones that don't -- so an idle console draws no empty boxes.
 */
export function DashboardView() {
  const { state } = useAetherStore();
  const presence = computeDigestPresence(state);
  return (
    <div style={gridStyle}>
      <ReactorStatusCard />
      <div data-testid="dashboard-right-column" style={rightColumnStyle}>
        <ReadinessCard />
        <DigestSlot present={presence.agents}>
          <ActiveAgentsDigest />
        </DigestSlot>
        <DigestSlot present={presence.projects}>
          <ProjectsDigest />
        </DigestSlot>
        <DigestSlot present={presence.alerts}>
          <RecentAlertsCard />
        </DigestSlot>
        <StandbyStrip />
      </div>
    </div>
  );
}

const gridStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gridTemplateRows: 'minmax(0, 1fr)',
  gap: 14,
};
const rightColumnStyle: CSSProperties = { minHeight: 0, display: 'flex', flexDirection: 'column', gap: 14 };
```

Then delete the retired card:

```bash
git rm src/components/dashboard/SystemsCard.tsx
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/dashboard/`
Expected: PASS (all dashboard tests).
Run: `grep -rn "SystemsCard" src` and expect no output.

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/DashboardView.tsx src/components/dashboard/DashboardView.test.tsx
git commit -m "feat(dashboard): two-column idle composition; retire the SYSTEMS card"
```

(`git rm` in Step 3 already staged the deletion.)

---

### Task 10: Footer dot glows only when live or alarmed

**Files:**
- Modify: `src/components/layout/Footer.tsx`
- Test: `src/components/layout/Footer.test.tsx` (new)

**Interfaces:**
- Consumes: `statusDotGlows` (Task 2), `dotGlow` (Task 2).
- Produces: the footer dot gets `data-testid="footer-status-dot"`. Nothing else changes, and the `aria-live` span stays exactly where it is.

- [ ] **Step 1: Write the failing test.** Create `src/components/layout/Footer.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Footer } from './Footer';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { initialState } from '../../state/initialState';

let dispatchRef: ReturnType<typeof useAetherStore>['dispatch'] | null = null;
function DispatchProbe() {
  dispatchRef = useAetherStore().dispatch;
  return null;
}
function renderFooter() {
  return render(
    <AetherStoreProvider>
      <DispatchProbe />
      <Footer />
    </AetherStoreProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('Footer status dot', () => {
  it('is flat at STANDBY', () => {
    renderFooter();
    expect(screen.getByText('STANDBY')).toBeTruthy();
    expect(screen.getByTestId('footer-status-dot').style.boxShadow).toBe('');
  });

  it('glows once a session is live (ALL GOOD)', () => {
    renderFooter();
    act(() =>
      dispatchRef!({
        type: 'SET_REAL_USAGE',
        snapshot: { ...initialState.realUsage, burnRatePerMin: 1234, lastScanAt: new Date().toISOString() },
      }),
    );
    expect(screen.getByText('ALL GOOD')).toBeTruthy();
    expect(screen.getByTestId('footer-status-dot').style.boxShadow).not.toBe('');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/layout/Footer.test.tsx`
Expected: FAIL with `Unable to find an element by: [data-testid="footer-status-dot"]`.

- [ ] **Step 3: Implement.** In `src/components/layout/Footer.tsx`, change the imports:

```tsx
import { dotGlow, fonts, type ColorPalette } from '../../styles/tokens';
import { isSessionLive, statusDotGlows } from '../dashboard/dashboardMath';
```

Replace the dot span:

```tsx
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: c, boxShadow: `0 0 8px ${c}` }} />
```

with:

```tsx
        {/* Glow-Is-State: same gate as the reactor card's dot -- flat at STANDBY. */}
        <span
          data-testid="footer-status-dot"
          style={{ width: 7, height: 7, borderRadius: '50%', background: c, boxShadow: statusDotGlows(state.alarmLevel, live) ? dotGlow(c) : undefined }}
        />
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/layout/Footer.test.tsx src/components/dashboard/ReactorStatusCard.test.tsx`
Expected: PASS. The reactor test's "single live region in the footer" still holds.

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/Footer.tsx src/components/layout/Footer.test.tsx
git commit -m "fix(footer): status dot glows only when live or alarmed"
```

---

### Task 11: Terminal view header reads "standby" when idle

**Files:**
- Modify: `src/components/terminal/TerminalView.tsx`
- Test: `src/components/terminal/TerminalView.test.tsx` (new)

**Interfaces:**
- Consumes: `isSessionLive` (existing, `../dashboard/dashboardMath`), `glows.hot`.
- Produces: the header text `:~$ session active` when `isSessionLive`, else `:~$ standby` (`data-testid="terminal-session-status"`). The header dot glows (`glows.hot`) only when live and is flat `textMuted` otherwise (`data-testid="terminal-session-dot"`).

- [ ] **Step 1: Write the failing test.** Create `src/components/terminal/TerminalView.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { initialState } from '../../state/initialState';

// xterm needs a real canvas; the header is what's under test.
vi.mock('./PtyTerminal', () => ({ PtyTerminal: () => null, focusClaudeTerminal: () => {} }));
import { TerminalView } from './TerminalView';

let dispatchRef: ReturnType<typeof useAetherStore>['dispatch'] | null = null;
function DispatchProbe() {
  dispatchRef = useAetherStore().dispatch;
  return null;
}
function renderView() {
  return render(
    <AetherStoreProvider>
      <DispatchProbe />
      <TerminalView />
    </AetherStoreProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('TerminalView header', () => {
  it('reads "standby" with a flat dot when no session is live, not "session active"', () => {
    renderView();
    expect(screen.getByTestId('terminal-session-status').textContent).toBe(':~$ standby');
    expect(screen.getByTestId('terminal-session-dot').style.boxShadow).toBe('');
  });

  it('reads "session active" with a lit dot once a session is live', () => {
    renderView();
    act(() =>
      dispatchRef!({
        type: 'SET_REAL_USAGE',
        snapshot: { ...initialState.realUsage, burnRatePerMin: 500, lastScanAt: new Date().toISOString() },
      }),
    );
    expect(screen.getByTestId('terminal-session-status').textContent).toBe(':~$ session active');
    expect(screen.getByTestId('terminal-session-dot').style.boxShadow).not.toBe('');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/terminal/TerminalView.test.tsx`
Expected: FAIL with `Unable to find an element by: [data-testid="terminal-session-status"]`. If a rail card throws in jsdom instead, mock it the same way as `PtyTerminal`, e.g. `vi.mock('./LiveOutputCard', () => ({ LiveOutputCard: () => null }))`, and note that in the commit message.

- [ ] **Step 3: Implement.** In `src/components/terminal/TerminalView.tsx`:

Change the tokens import and add two imports:

```tsx
import { fonts, glows, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { isSessionLive } from '../dashboard/dashboardMath';
```

In `TerminalView()`, after `const composer = useCrossCheckComposer();`:

```tsx
  const { state } = useAetherStore();
  // Same signal as the dashboard: an open pty is a shell, not a Claude session.
  const live = isSessionLive(state, Date.now());
```

Replace the two header spans:

```tsx
          <span style={liveDotStyle(colors)} />
```
```tsx
          <span style={{ font: `400 13px/1 ${fonts.mono}`, color: colors.textDim }}>:~$ session active</span>
```

with:

```tsx
          <span data-testid="terminal-session-dot" style={liveDotStyle(colors, live)} />
```
```tsx
          <span data-testid="terminal-session-status" style={{ font: `400 13px/1 ${fonts.mono}`, color: colors.textDim }}>
            :~$ {live ? 'session active' : 'standby'}
          </span>
```

Replace `liveDotStyle`:

```tsx
// Glow-Is-State: lit only while a session is live; flat and muted at standby.
function liveDotStyle(colors: ColorPalette, live: boolean): CSSProperties {
  return { width: 10, height: 10, borderRadius: '50%', background: live ? colors.accentCyanDeep : colors.textMuted, boxShadow: live ? glows.hot : undefined };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/terminal/TerminalView.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/terminal/TerminalView.tsx src/components/terminal/TerminalView.test.tsx
git commit -m "fix(terminal): header reads standby unless a session is live"
```

---

### Task 12: Copy and colour drift

**Files:**
- Modify: `src/components/dashboard/ActiveAgentsDigest.tsx:34`
- Modify: `src/components/dashboard/RecentAlertsCard.tsx`
- Modify: `src/components/layout/TopBar.tsx:177`
- Test: `src/components/dashboard/ActiveAgentsDigest.test.tsx`, `src/components/dashboard/RecentAlertsCard.test.tsx`, `src/components/layout/TopBar.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `alertToneColor(c: string, colors: ColorPalette): string`, exported from `RecentAlertsCard.tsx`. It maps `'#3be0a0'`→`colors.success`, `'#f5c66b'`→`colors.warn`, `'#ff6b7a'`/`'#ff9d9d'`→`colors.danger`, and anything else→`colors.textSecondary` (case-insensitive). ActiveAgentsDigest's empty sentence becomes `No agents are running.`

- [ ] **Step 1: Write the failing tests.**

In `src/components/dashboard/ActiveAgentsDigest.test.tsx`, replace the one test with:

```tsx
  it('uses the same no-agents sentence as the Agents and Terminal views, with no action of its own', () => {
    render(
      <AetherStoreProvider>
        <ActiveAgentsDigest />
      </AetherStoreProvider>,
    );
    expect(screen.getByText('No agents are running.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
```

In `src/components/dashboard/RecentAlertsCard.test.tsx`, change the import to `import { RecentAlertsCard, alertToneColor, notifKeys } from './RecentAlertsCard';`, add `import { colors } from '../../styles/tokens';`, add this helper below the imports:

```tsx
// jsdom normalizes colours (hex -> rgb), so compare through the same parser.
function cssColor(value: string): string {
  const el = document.createElement('span');
  el.style.color = value;
  return el.style.color;
}
```

and append inside `describe('RecentAlertsCard', ...)`:

```tsx
  it('maps an alert to the success/warn/danger tokens, and anything else to neutral text', () => {
    expect(alertToneColor('#3be0a0', colors)).toBe(colors.success);
    expect(alertToneColor('#F5C66B', colors)).toBe(colors.warn);
    expect(alertToneColor('#ff6b7a', colors)).toBe(colors.danger);
    expect(alertToneColor('#7fd8ef', colors)).toBe(colors.textSecondary);
    expect(alertToneColor('#8ab6ff', colors)).toBe(colors.textSecondary);
  });

  it('paints a row in its tone token, not the colour stored on the notif', () => {
    render(
      <AetherStoreProvider>
        <DispatchProbe />
        <RecentAlertsCard />
      </AetherStoreProvider>,
    );
    act(() => setMode('EDITS')); // stored with c: '#7fd8ef'
    // getAll: an earlier test in this file may have raised the same message.
    expect(screen.getAllByText('Operating mode set to EDITS')[0].style.color).toBe(cssColor(colors.textSecondary));
  });
```

In `src/components/layout/TopBar.test.tsx`, add `import { colors } from '../../styles/tokens';`, the same `cssColor` helper, and append a new describe block:

```tsx
describe('TopBar notifications dropdown', () => {
  it('paints alert rows from tone tokens, not the stored notif colour', () => {
    renderTopBar();
    fireEvent.click(screen.getByRole('button', { name: 'AUTO' })); // pushes "Operating mode set to AUTO", c: '#7fd8ef'
    fireEvent.click(screen.getByRole('button', { name: /^Notifications/ }));
    // getAll: earlier tests in this file also switch to AUTO.
    expect(screen.getAllByText('Operating mode set to AUTO')[0].style.color).toBe(cssColor(colors.textSecondary));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/dashboard/ActiveAgentsDigest.test.tsx src/components/dashboard/RecentAlertsCard.test.tsx src/components/layout/TopBar.test.tsx`
Expected: FAIL. The old sentence is still rendered, `alertToneColor` is not exported, and the rows render `rgb(127, 216, 239)`.

- [ ] **Step 3: Implement.**

`src/components/dashboard/ActiveAgentsDigest.tsx`: replace the empty-state block (the comment and `<EmptyState message="Agents dispatched from the Terminal will appear here." />`) with:

```tsx
          // Shown only while the panel fades out on the Dashboard (DigestSlot);
          // the same sentence the Agents and Terminal views use. No action: the
          // Dashboard's OPEN TERMINAL lives in the reactor card and READINESS.
          <EmptyState message="No agents are running." />
```

`src/components/dashboard/RecentAlertsCard.tsx`: change the tokens import to `import { fonts, type ColorPalette } from '../../styles/tokens';` (unchanged if already so), and add below `notifKeys`:

```tsx
// Notifs persist the colour string they were raised with (Notif.c), so old
// rows and new ones both carry raw hex. Map the known tones onto the palette
// at render time; anything else -- the cyan info rows, legacy values -- reads
// as neutral text rather than an arbitrary colour.
const TONE_BY_STORED_COLOUR: Record<string, 'success' | 'warn' | 'danger'> = {
  '#3be0a0': 'success',
  '#f5c66b': 'warn',
  '#ff6b7a': 'danger',
  '#ff9d9d': 'danger',
};

export function alertToneColor(c: string, colors: ColorPalette): string {
  const tone = TONE_BY_STORED_COLOUR[c.toLowerCase()];
  return tone ? colors[tone] : colors.textSecondary;
}
```

and in the row, replace `<span style={{ color: nf.c }}>{nf.m}</span>` with:

```tsx
            <span style={{ color: alertToneColor(nf.c, colors) }}>{nf.m}</span>
```

`src/components/layout/TopBar.tsx`: add `import { alertToneColor } from '../dashboard/RecentAlertsCard';` and in the notifications panel replace `<span style={{ color: nf.c }}>{nf.m}</span>` with:

```tsx
                <span style={{ color: alertToneColor(nf.c, colors) }}>{nf.m}</span>
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/dashboard/ActiveAgentsDigest.test.tsx src/components/dashboard/RecentAlertsCard.test.tsx src/components/layout/TopBar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/ActiveAgentsDigest.tsx src/components/dashboard/ActiveAgentsDigest.test.tsx src/components/dashboard/RecentAlertsCard.tsx src/components/dashboard/RecentAlertsCard.test.tsx src/components/layout/TopBar.tsx src/components/layout/TopBar.test.tsx
git commit -m "fix(dashboard): one no-agents sentence; alert rows use tone tokens"
```

---

### Task 13: DESIGN.md updates

**Files:**
- Modify: `DESIGN.md`

**Interfaces:**
- Consumes: everything shipped in Tasks 1–12. Describe what shipped; run the Step 2 checks against the code.
- Produces: documentation only.

- [ ] **Step 1: Edit `DESIGN.md`.**

(a) **Layout**: replace the sentence beginning `The dashboard's main area is a panel grid:` (through `...along the bottom.`) with:

```markdown
The dashboard's main area is two columns. REACTOR STATUS fills the left half. The right half is READINESS on top, then a panel for each digest that has data (ACTIVE AGENTS, PROJECTS, RECENT ALERTS), then the STANDBY STRIP, which lists the digests that don't. At a cold STANDBY the right half is just READINESS and the strip, so an idle console draws no empty boxes, and a live console with no alerts shows no empty alerts panel. A row of metric cards runs along the bottom.
```

(b) **Components → Empty States**: replace its last sentence (`The reactor card holds the one primary action, OPEN TERMINAL, at STANDBY, so an empty panel elsewhere on the Dashboard never competes with it.`) with:

```markdown
On the Dashboard a digest with nothing to show is not drawn as an empty panel at all: it becomes an item in the STANDBY STRIP. OPEN TERMINAL, in the reactor card and in READINESS, is the Dashboard's only primary action.
```

(c) **Components**: add a new subsection directly after `### Empty States`:

```markdown
### Readiness and Standby Strip
The idle dashboard's right column (`src/components/dashboard/`).
- **READINESS** (`ReadinessCard.tsx`): an `h2` and a list of four rows, each a status dot and one plain sentence: Desktop app, Terminal, Statusline, Collector (copy in `readinessMath.ts`). A met row's dot is filled Nominal Green; only the live signals (Terminal, Statusline) glow, while Desktop app and Collector are static facts and stay flat. An unmet row is a hollow Text Muted ring. **No amber:** none of these asks the operator for anything. OPEN TERMINAL sits under the list.
- **OPEN TERMINAL** (`OpenTerminalButton.tsx`): the primary button. In browser mode it stays in place, `aria-disabled` (still focusable) in the disabled treatment, with the Desktop-app reason directly beneath it in Rajdhani 12px Text Muted, so it reads as unavailable, not broken.
- **STANDBY STRIP** (`StandbyStrip.tsx`): one thin panel with a visually hidden `h2`. It holds one link-style button per digest without data, then `Memory N engrams`, separated by `·`. Labels are Rajdhani Text Secondary; counts are Space Mono Soft Signal. Each item opens its view (the alerts item opens the notifications dropdown). It is hidden once every digest has a panel.
- **Digest arrival** (`DigestSlot.tsx`): a digest that gains data rises in on opacity and an 8px `translateY` over `motion.duration.slow` with `motion.easing.decelerate`; one that loses data fades the same way, then unmounts. Height is never animated (the column reflows at once), and under reduced motion it appears and disappears without animation.
```

(d) **Storm Core → Placement**: replace `it fills the REACTOR STATUS panel, scaled by its wrapper only.` with `it fills the REACTOR STATUS panel, which takes the left half of the dashboard's main area; the reactor itself stays 360px, scaled by its wrapper only.`

(e) **Storm Core → Standby: dark and cold**: replace the bullet `- Status text reads STANDBY in Text Muted, never cyan, in both the panel and the footer.` with:

```markdown
- Status text reads STANDBY in Text Muted, never cyan, in both the panel and the footer, and both status dots are flat until a session is live or an alarm is up (`statusDotGlows`).
- The line under the reactor reads exactly `— tok/min · standby`; the Terminal view's prompt line reads `standby` instead of `session active`.
```

and replace the bullet `- Readouts with no real source show \`—\`, never a simulated number or a zero.` with:

```markdown
- Readouts with no real source show `—`, never a simulated number or a zero. The KPI tiles are MONTH TOKENS, DEPLETION ETA, TODAY and BUDGET LEFT; TODAY is today's cost at API rates (`API rate, not paid`), exact (no `~`), and `—` when no priced activity was observed.
```

(f) **Known Gaps**: change `Updated 2026-09-28 after polish passes 1 and 2.` to `Updated 2026-09-29 after the idle composition.` and append to the end of that intro paragraph: `The idle composition closed the idle dashboard's empty digest panels (now READINESS and the STANDBY STRIP), the contradictory standby signals (rate line, footer dot, Terminal header), and the stray \`#8ab6ff\`.` Then add a new bullet at the end of the list:

```markdown
- **No command palette.** The retired SYSTEMS card advertised "CTRL+K jumps anywhere", but no palette or shortcut exists in the code (no key handler, no Electron accelerator). The hint was removed rather than moved to the top bar. A palette needs its own spec before a keycap chip can point at it.
```

- [ ] **Step 2: Verify the doc against the code**

Run: `grep -n "SYSTEMS\|systems around it\|MEMORY SWEEP" DESIGN.md`
Expected: only the new Known Gaps bullet mentions SYSTEMS; no MEMORY SWEEP.
Run: `grep -rn "8ab6ff\|MEMORY SWEEP\|live-rate pulse · standby\|CTRL+K" src --include=*.ts --include=*.tsx`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add DESIGN.md
git commit -m "docs(design): idle composition layout, Readiness/Standby Strip, Known Gaps"
```

---

### Task 14: Final full verification

**Files:** none modified.

- [ ] **Step 1: Baseline (record before Task 1 if running in order; otherwise record here from the base commit).** On `f48b4d4`, run `npm test` and note `Test Files N passed` / `Tests M passed`. The expected delta is roughly +45 tests: +12 readinessMath, +5 DigestSlot, +7 ReadinessCard, +4 StandbyStrip, +3 OpenTerminalButton, +3 DashboardView, +2 Footer, +2 TerminalView, +4 ReactorStatusCard, about +10 net dashboardMath, +1 Button, +3 alerts/TopBar. Nothing should fail.

- [ ] **Step 2: Full suite**

Run: `npm test`
Expected: all passing (the skipped count is unchanged). Known environmental flake: `electron/communicationBridge/launchConfig.test.ts` "real ConPTY Ctrl+C" can fail with `AttachConsole failed` in a console-less shell. Re-run it in a normal terminal before calling it a regression.

- [ ] **Step 3: Electron typecheck**

Run: `npm run typecheck:electron`
Expected: exit 0, no errors.

- [ ] **Step 4: Renderer build**

Run: `npm run build`
Expected: `tsc -b` clean, and `vite build` completes.

- [ ] **Step 5: Invariant greps**

Run each; every one should produce the stated output:
- `grep -rn "aria-live" src/components/dashboard src/components/terminal/TerminalView.tsx`, which should print nothing (the Footer stays the only status announcement).
- `grep -rln "<h1" src/components/dashboard`, which should print nothing.
- `git diff f48b4d4 --stat -- src/components/reactor`, which should print nothing (Living Core Rule).
- `grep -rn "warn" src/components/dashboard/ReadinessCard.tsx src/components/dashboard/StandbyStrip.tsx`, which should print nothing (no amber in readiness).

- [ ] **Step 6: Visual check (browser mode)**

Run `npm run dev`, open http://localhost:5173 at 1536×1024 and go to Dashboard. Confirm the reactor fills the left half. The right half should show READINESS (Desktop app unmet, with its reason; Terminal/Statusline/Collector hollow), OPEN TERMINAL disabled with the reason beneath it, and the strip reading `Agents 0 · Projects 0 · Alerts 0 · Memory N engrams`. The rate line reads `— tok/min · standby`, and the footer shows STANDBY with a flat dot. If nobody can open a browser in this session, report this step as **Incomplete** (not Passed) and hand it to `electron-ui-verifier` for the desktop-app states (all four met, NOMINAL power-up, digest arrival).

- [ ] **Step 7: Report**

Report each check as Passed, Incomplete (with what blocked it) or Failed, with the real output lines (test counts, build result).
