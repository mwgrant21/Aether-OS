# Readiness Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make READINESS teach (a one-line hint per unmet row, an absolute time per met row, an honest Collector row) and fill the right column, and fix four standby defects: dropdown focus, the doubled desktop-app reason, SESSION INFO at STANDBY with strip count colours, and one shared OPEN TERMINAL.

**Architecture:** The pure decisions (row copy, hints, time formatting, collector freshness, hint command splitting, SESSION INFO at STANDBY) live in `readinessMath.ts` and `dashboardMath.ts`, unit-tested there. The store gains one field, `terminalOpenedAtMs`, stamped in the reducer on the pty's dead-to-alive edge. The components render these: `ReadinessCard` (grid rows plus a bottom-pinned action), `OpenTerminalButton` (gains a `secondary` variant used by the Agents view), and `StandbyStrip` plus `TopBar`, which share a new `useDropdownFocus` hook for focus in, focus return, Escape and outside-click. No new IPC, and no new persisted state.

**Tech Stack:** React 18, TypeScript 5 (strict, `noUnusedLocals`), Vitest 2 + @testing-library/react on jsdom 25, inline styles from `src/styles/tokens.ts`, Electron 43.4.1.

**Spec:** `docs/superpowers/specs/2026-09-29-readiness-pass-design.md` (committed at `4441403`; binding: `DESIGN.md`, `CLAUDE.md`)

## Global Constraints

- Branch `design/readiness-pass` in `C:\Users\IT\Desktop\Aether-OS-next`. Base `master` = `e9e2aca`, spec commit `4441403`. Before starting, a builder checks that `4441403` is an ancestor of its HEAD (`git merge-base --is-ancestor 4441403 HEAD`) and stops if it is not.
- Parallel builders each work on their own branch or worktree, cut from `design/readiness-pass` at the start of their wave. A task edits ONLY the paths in its **Files** block. Commit with `git add -- <own paths>` then `git commit -m "..." -- <own paths>`. Never `git add -A`, `git add .` or `git add -f`. End each commit message with your session's attribution lines. No builder merges or pushes.
- Tests: `npx vitest run <path> [<path>...]` for the task's files; `npm test` for the suite. Before a task is called done, also run `npm run build` (runs `tsc -b`, which typechecks `src/` INCLUDING test files, with `noUnusedLocals`/`noUnusedParameters`) and `npm run typecheck:electron`.
- **Baseline (work-it, measured on `4441403`, 2026-09-29):** `npm test` = `Test Files 198 passed | 1 skipped (199)`, `Tests 2177 passed | 14 skipped (2191)`, about 45s. `npm run build` exits 0 (the `Some chunks are larger than 500 kB` warning is pre-existing, not an error). `npm run typecheck:electron` exits 0.
- **Known flake:** `electron/communicationBridge/launchConfig.test.ts` (real ConPTY; the first baseline run failed at line 319, `waitFor ... INTERRUPT_RESTORED`, and the rerun passed). Re-run that file alone before calling it a regression. None of this plan's tasks touch `electron/`.
- **Skipped tests are environment-conditional. Do not fix them.** Of the 14 skips on work-it, 4 are `it.skipIf(!symlinkSupported)`: `electron/atomicWrite.test.ts:175,195,210` and `electron/guidanceWriter.test.ts:124`. work-it cannot create symlinks (`fs.symlinkSync` -> `EPERM`: no Developer Mode and not elevated). The home machine can, which explains its `2181 passed / 10 skipped` exactly (+4/-4). The rest skip on any Windows box without opt-in env vars: `electron/atomicWrite.test.ts:260,280` (POSIX-only), `electron/communicationBridge/launchConfig.test.ts:122` (`AETHER_LAUNCH_PREFLIGHT=1`), and the one skipped file, `electron/crossEngine/providers/providers.live.test.ts` (`AETHER_LIVE_PROVIDER_SMOKE` / `AETHER_LIVE_PROVIDER_TURN`). A task's "expected" suite result means the skipped count is unchanged (14 on work-it, 10 at home).
- **Reactor/StormCore visuals are untouched (Living Core Rule).** Do not edit anything under `src/components/reactor/`.
- Settled, not reopened: dark-only; one OPEN TERMINAL on the Dashboard, under READINESS; unmet READINESS rows are never amber; glow only while a session is live.
- **Glow-Is-State:** terminal and statusline dots may glow while live; desktop and collector never glow (unchanged).
- **No amber in READINESS.** Met = `colors.success` filled; unmet = hollow ring in `colors.textMuted`.
- **Times are absolute:** `HH:MM` in local time, prefixed with the short date (`Sep 28 14:02`) when not on the current local day. No relative times ("3m ago").
- **Time determinism in tests:** the formatter is pure and takes `nowMs`. It compares the local calendar day (`getFullYear/getMonth/getDate`) of `atMs` and `nowMs`, never `new Date()`. Tests build every instant with the local-time constructor (`new Date(2026, 8, 29, 14, 2).getTime()`), never from an epoch literal or ISO string, so `'14:02'` is the expected output in every timezone. No test sets `TZ`. Month names come from a fixed English table, not `toLocale*`, so OS locale cannot change the output. Component tests that render a live time assert the shape (`/^\d{2}:\d{2}$/`), not the value.
- **Copy is verbatim from the spec:**
  - Desktop: `Desktop app: running.` / `Desktop app: not running.`; hint `Start it with npm run electron:dev.`
  - Terminal: `Terminal: open since {t}.` (defensive `Terminal: open.` when alive but unstamped) / `Terminal: no session yet.`; hint `Use OPEN TERMINAL below.` (desktop) or `Needs the desktop app.` (browser)
  - Statusline: `Statusline: live, {t}.` / `Statusline: no reading yet.` / `Statusline: last reading {t}.`; hints `Install it in Settings, then run a Claude Code turn.` (no snapshot) / `Refreshes on each Claude Code turn.` (stale)
  - Collector: `Collector: last event {t}.` / `Collector: no events since {t}.` / `Collector: no events recorded.`; hint `Start it from the checkout: npm start in collector/.`
- `COLLECTOR_STALE_AFTER_MS = 10 * 60 * 1000`, with the same `<=` comparison as `isStatuslineFresh`.
- **Hint line:** under its row's sentence, indented to the sentence's left edge (clear of the dot), `400 11px/1.5` UI font, `textMuted`; command text (`npm run electron:dev`, `npm start`) in `fonts.mono`. 11px is the floor.
- **Numbers Are Mono; tokens, not literals:** colours via `useColors()`; no new hex/rgba literals in touched code.
- **Button primitive** for every interactive element. `Button` takes no `ref`, no `data-*` props and no `tabIndex`: put refs and data attributes on a wrapper element.
- **The Footer is the only status announcement.** Add no `aria-live`.

## Spec ambiguities resolved in this plan (ASSUMPTIONS / DEVIATIONS)

1. **Where `terminalOpenedAtMs` is stamped.** The reducer's `SET_TERMINAL_ALIVE` case, the one place `terminalAlive` becomes true (`src/state/reducer.ts:174-175`), sets it with `Date.now()`. It restamps only on a dead-to-alive edge. `electron/main.ts:1145` re-sends `pty:alive` for an already-running pty on every `pty:start` (each Terminal-tab mount), so stamping on every `alive: true` would make "open since" jump to the moment the tab was last visited. `useTerminalAliveSync.ts` is unchanged. `terminalOpenedAtMs` also gets a `PERSISTENCE_EXCLUSIONS` entry, because `src/state/persistence.test.ts:102` fails for any `AetherState` key that is neither persisted nor excluded.
2. **"OpenTerminalButton's wrapper gets `marginTop: 'auto'`"** is implemented as a wrapper `div` inside `ReadinessCard` (`data-testid="readiness-action"`), not as a change to `OpenTerminalButton`'s internal `wrapStyle`. The rendered result is the same. This keeps the auto margin out of the Agents view's `secondary` instance, and lets Task 2 and Task 3 own disjoint files.
3. **Focus return on close** happens only when focus would otherwise be lost: `document.activeElement` is `body`, null, or detached (a panel that held focus has just unmounted). If the user activated another control, focus stays there. This case is real: pressing the approvals button closes notifications through the #91 mutual exclusion, and focus must stay on approvals. If the opener has unmounted (the strip's Alerts item disappears once an alert arrives, because the alerts digest then has data), focus goes to the top-bar bell.
4. **Both triggers are "inside".** A pointer-down on the bell's wrapper or on the strip's Alerts item is not an outside click. Otherwise the outside handler would close the panel on pointer-down and the trigger's click would reopen it. Both carry `data-notif-trigger` (`NOTIF_TRIGGER_ATTR`). Because `Button` takes no data props, the strip wraps its Alerts button in a `display: contents` span.
5. **Close uses the existing `TOGGLE_NOTIFS`.** It clears `unread`, as a bell close always has. No new reducer action.
6. **"No other component renders the literal `OPEN TERMINAL`"** is a TypeScript-AST scan of non-test `src/**/*.ts(x)` for string literals and JSX text whose TRIMMED value equals `OPEN TERMINAL`. Comments are never visited. An exact match is required because the spec's own hint `Use OPEN TERMINAL below.` lives in `readinessMath.ts` and names the control without rendering it.
7. **`EmptyState` gains `actionSlot?: ReactNode`**, so the Agents empty state keeps its 6px focus-ring clearance (`FOCUS_RING_CLEARANCE`) while rendering `OpenTerminalButton`. The `secondary` variant keeps the `⊕` glyph, so every OPEN TERMINAL looks alike. In browser mode the Agents view's button is now aria-disabled with the reason, which is the intended shared check.
8. **Short date format** is `Mon D HH:MM`: a 3-letter English month, an unpadded day, no year, and 24-hour zero-padded time. An instant from another year on the same month and day still gets the prefix.
9. **SESSION INFO's live gate is `isSessionLive`**, the same predicate that decides STANDBY. Out of scope, recorded as a Known Gap in Task 6: the Footer's `Uptime` (`src/components/layout/Footer.tsx:23`) still ticks at STANDBY. `src/utils/format.ts:55`'s "so they cannot disagree" is no longer true at STANDBY.
10. **The Collector row can only see 24h.** `electron/main.ts:602` reads diagnostics for the last 24h, so a collector whose newest event is older than that reads `Collector: no events recorded.`, not `no events since {t}`. This is the spec's copy; flagged, not changed.
11. **Not on this branch:** the handoff that the spec sources (`docs/superpowers/plans/2026-09-29-idle-composition-handoff.md`, PR #93, commit `385a9fa`) is not merged into `e9e2aca`. The plan does not need it.
12. **The critique baseline** is `.impeccable/critique/2026-09-29T07-50-27Z__src-components-dashboard-dashboardview-tsx.md` (`total_score: 22`), the latest snapshot and the one taken after #92. An older 22/40 (`2026-09-28T20-35-01Z`) exists; do not compare against it.

## Review Focus

- **The Terminal tab is revisited while its pty is still running.** main re-sends `pty:alive`, and `Terminal: open since {t}.` must keep the original time, not jump to now. Covered in Task 1, reducer test `keeps the first stamp when main re-announces pty:alive`.
- **The app stays open across local midnight.** A time from yesterday must gain its date prefix (`Sep 29 23:59` read at 00:01), and a time from today at 00:00 must not. Covered in Task 1, `formatReadinessTime` test `rolls over at local midnight`.
- **Notifications opened from the strip, then an alert arrives.** The Alerts strip item unmounts, so Escape must not throw or focus a detached node; focus lands on the bell. Covered in Task 4, StandbyStrip test `falls back to the bell when the opening strip item has gone`.
- **With notifications open, the user presses the approvals button.** Mutual exclusion closes notifications. Focus must stay on approvals, not be yanked back to the notifications opener. Covered in Task 4, TopBar test `does not pull focus off the approvals button`.
- **With notifications opened from the bell, the user clicks the strip's Alerts item (or the reverse).** The panel must close, not close on pointer-down and reopen on click. Covered in Task 4, StandbyStrip test `closes from the strip when the bell opened it`, and TopBar test `closes, not close-then-reopens`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/state/types.ts`, `src/state/initialState.ts`, `src/state/reducer.ts`, `src/state/persistence.ts` (+ `src/state/reducer.test.ts`) | `terminalOpenedAtMs` field, edge-stamped | 1 |
| `src/components/dashboard/readinessMath.ts` (+ `.test.ts`) | Row copy + hints, `formatReadinessTime`, collector freshness, `splitHintCommands` | 1 |
| `src/components/dashboard/ReadinessCard.test.tsx` | Task 1: expected strings only. Task 2: rewritten | 1, then 2 |
| `src/components/dashboard/ReadinessCard.tsx` | Fills the column, grid rows with hint line, bottom-pinned action | 2 |
| `src/components/dashboard/OpenTerminalButton.tsx` (+ `.test.tsx`) | `variant` prop | 3 |
| `src/components/dashboard/openTerminalLiteral.test.ts` **new** | Single-renderer AST guard | 3 |
| `src/components/shared/EmptyState.tsx` (+ `.test.tsx`) | `actionSlot` | 3 |
| `src/components/agents/AgentRosterCard.tsx` (+ `AgentRosterCard.narration.test.tsx`) | Uses `OpenTerminalButton variant="secondary"` | 3 |
| `src/components/layout/useDropdownFocus.ts` **new** | Focus in/return, Escape, outside pointer-down | 4 |
| `src/components/layout/TopBar.tsx` (+ `TopBar.test.tsx`) | Wires the hook to the notifications panel | 4 |
| `src/components/dashboard/StandbyStrip.tsx` (+ `.test.tsx`) | Alerts toggle + `aria-expanded` + trigger marker; count colours | 4 |
| `src/components/dashboard/dashboardMath.ts` (+ `.test.ts`), `src/components/layout/BottomMetricsRow.tsx` (+ `.test.tsx`) | SESSION INFO `—` at STANDBY | 5 |
| `DESIGN.md` | Documents what shipped + Known Gap | 6 |
| `.impeccable/critique/<new snapshot>.md` **new** | Critique re-run | 8 |

## Dependency graph (for parallel builders)

Each wave's tasks touch disjoint files and can run concurrently. A task starts once every task it depends on is merged into `design/readiness-pass`.

| Wave | Task | Depends on |
|---|---|---|
| 1 | 1 Readiness data (store field + readinessMath) | none |
| 1 | 3 One OPEN TERMINAL everywhere | none |
| 1 | 4 Alerts dropdown focus + strip | none |
| 1 | 5 SESSION INFO at STANDBY | none |
| 2 | 2 READINESS card fills the column | 1 |
| 3 | 6 DESIGN.md | 1-5 |
| 4 | 7 Final verification | 1-6 |
| 4 | 8 `/impeccable critique` re-run | 1-6 (can run beside 7) |
| 5 | 9 Live `electron:dev` check | 7 |

Only one pair of tasks touches the same file: Task 1 and Task 2 both edit `ReadinessCard.test.tsx`, and they run in different waves. Task 3 and Task 1 both read `DESKTOP_APP_REASON`, whose name and value do not change.

---

### Task 1: Readiness data: `terminalOpenedAtMs`, collector freshness, row copy with hints

**Files:**
- Modify: `src/state/types.ts:224` (after `terminalAlive: boolean;`)
- Modify: `src/state/initialState.ts:57` (after `terminalAlive: false,`)
- Modify: `src/state/reducer.ts:174-175` (`SET_TERMINAL_ALIVE` case)
- Modify: `src/state/persistence.ts:51` (`PERSISTENCE_EXCLUSIONS`, after the `terminalAlive` entry)
- Modify: `src/components/dashboard/readinessMath.ts:1-67` (everything above `export interface DigestPresence`; leave the rest untouched)
- Test: `src/state/reducer.test.ts`, `src/components/dashboard/readinessMath.test.ts`
- Modify (expected strings only): `src/components/dashboard/ReadinessCard.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `AetherState.terminalOpenedAtMs: number | null` (initial `null`).
  - `ReadinessRow` gains `readonly hint: string | null` (null exactly when `met`).
  - `computeReadiness(state: Pick<AetherState, 'terminalAlive' | 'terminalOpenedAtMs' | 'statusline' | 'diagnostics'>, desktop: boolean, nowMs: number): ReadinessRow[]`
  - `formatReadinessTime(atMs: number, nowMs: number): string`
  - `COLLECTOR_STALE_AFTER_MS: number` (= 600000)
  - `newestCollectorEventMs(diagnostics: AetherState['diagnostics']): number | null`
  - `isCollectorFresh(newestMs: number | null, nowMs: number): boolean`
  - `HINT_COMMANDS: readonly ['npm run electron:dev', 'npm start']`
  - `interface HintPart { readonly text: string; readonly command: boolean }` and `splitHintCommands(hint: string): HintPart[]`
  - `DESKTOP_APP_REASON` unchanged (name and value); the Desktop row stops using it.

- [ ] **Step 1: Write the failing reducer tests.** In `src/state/reducer.test.ts`, change line 1 to `import { afterEach, describe, expect, it, vi } from 'vitest';` and append at the end of the file:

```ts
describe('reducer — terminalOpenedAtMs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('starts null', () => {
    expect(initialState.terminalOpenedAtMs).toBeNull();
  });

  it('stamps Date.now() when the pty reports alive', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const next = reducer(initialState, { type: 'SET_TERMINAL_ALIVE', alive: true });
    expect(next.terminalAlive).toBe(true);
    expect(next.terminalOpenedAtMs).toBe(1_000);
  });

  it('keeps the first stamp when main re-announces pty:alive for the same pty', () => {
    // electron/main.ts re-sends pty:alive on every pty:start while a pty is running.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const open = reducer(initialState, { type: 'SET_TERMINAL_ALIVE', alive: true });
    now.mockReturnValue(9_000);
    expect(reducer(open, { type: 'SET_TERMINAL_ALIVE', alive: true }).terminalOpenedAtMs).toBe(1_000);
  });

  it('clears on pty exit and restamps for the next pty', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const open = reducer(initialState, { type: 'SET_TERMINAL_ALIVE', alive: true });
    const closed = reducer(open, { type: 'SET_TERMINAL_ALIVE', alive: false });
    expect(closed.terminalAlive).toBe(false);
    expect(closed.terminalOpenedAtMs).toBeNull();
    now.mockReturnValue(5_000);
    expect(reducer(closed, { type: 'SET_TERMINAL_ALIVE', alive: true }).terminalOpenedAtMs).toBe(5_000);
  });
});
```

- [ ] **Step 2: Write the failing readinessMath tests.** In `src/components/dashboard/readinessMath.test.ts`, replace the import block, the `NOW`/`snap`/`DIAG`/`row` constants and the whole `describe('computeReadiness', ...)` block (current lines 1-81) with the code below. Leave `describe('computeDigestPresence')` and `describe('computeStripItems')` unchanged. They use `NOW` only as a number.

```ts
import { describe, expect, it } from 'vitest';
import {
  COLLECTOR_STALE_AFTER_MS,
  DESKTOP_APP_REASON,
  HINT_COMMANDS,
  computeDigestPresence,
  computeReadiness,
  computeStripItems,
  formatReadinessTime,
  isCollectorFresh,
  newestCollectorEventMs,
  splitHintCommands,
  type ReadinessKey,
  type ReadinessRow,
} from './readinessMath';
import { isSessionLive } from './dashboardMath';
import { initialState } from '../../state/initialState';
import { STATUSLINE_STALE_AFTER_MS } from '../../shared/depletion';
import type { StatuslineSnapshot } from '../../shared/statuslinePayload';
import type { AetherState } from '../../state/types';

// Every instant is built from LOCAL wall-clock parts, so '14:30' is the
// expected output in any timezone. Never use an epoch literal or ISO string here.
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime();
const NOW = at(2026, 8, 29, 14, 30); // Sep 29 2026, 14:30 local
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
type Diag = NonNullable<AetherState['diagnostics']>;
const EMPTY_DIAG: AetherState['diagnostics'] = { toolCalls: [], dispatches: [], anomalies: [] };
const anomalyAt = (detectedAtMs: number): AetherState['diagnostics'] => ({
  toolCalls: [],
  dispatches: [],
  anomalies: [{ kind: 'k', toolUseId: 't', detail: 'd', detectedAtMs }],
});
const COLD = { ...initialState, terminalOpenedAtMs: null };
const row = (rows: ReadinessRow[], key: ReadinessKey) => rows.find((r) => r.key === key)!;

describe('formatReadinessTime', () => {
  it('prints zero-padded 24-hour HH:MM for an instant on the same local day', () => {
    expect(formatReadinessTime(at(2026, 8, 29, 9, 5), NOW)).toBe('09:05');
    expect(formatReadinessTime(at(2026, 8, 29, 0, 0), NOW)).toBe('00:00');
    expect(formatReadinessTime(at(2026, 8, 29, 23, 59), NOW)).toBe('23:59');
  });

  it('prefixes the short date for an earlier local day', () => {
    expect(formatReadinessTime(at(2026, 8, 28, 14, 2), NOW)).toBe('Sep 28 14:02');
    expect(formatReadinessTime(at(2026, 8, 5, 7, 0), NOW)).toBe('Sep 5 07:00');
  });

  it('rolls over at local midnight', () => {
    const justAfterMidnight = at(2026, 8, 30, 0, 1);
    expect(formatReadinessTime(at(2026, 8, 29, 23, 59), justAfterMidnight)).toBe('Sep 29 23:59');
    expect(formatReadinessTime(at(2026, 8, 30, 0, 0), justAfterMidnight)).toBe('00:00');
  });

  it('prefixes the date for the same day-of-month in another month or year', () => {
    expect(formatReadinessTime(at(2026, 7, 29, 14, 2), NOW)).toBe('Aug 29 14:02');
    expect(formatReadinessTime(at(2025, 8, 29, 14, 2), NOW)).toBe('Sep 29 14:02');
  });
});

describe('collector freshness', () => {
  it('finds the newest event across tool calls, dispatches and anomalies', () => {
    const diag: Diag = {
      toolCalls: [{ toolUseId: 'a', toolName: 'Read', filePathRel: null, startedAtMs: 1, closedAtMs: 50 }],
      dispatches: [{ endedAtMs: 70 } as Diag['dispatches'][number]],
      anomalies: [{ kind: 'k', toolUseId: 't', detail: 'd', detectedAtMs: 60 }],
    };
    expect(newestCollectorEventMs(diag)).toBe(70);
    expect(newestCollectorEventMs({ ...diag, dispatches: [] })).toBe(60);
  });

  it('has no newest event with no snapshot or an empty one', () => {
    expect(newestCollectorEventMs(null)).toBeNull();
    expect(newestCollectorEventMs(EMPTY_DIAG)).toBeNull();
  });

  it('is fresh at exactly COLLECTOR_STALE_AFTER_MS and stale 1ms later', () => {
    expect(COLLECTOR_STALE_AFTER_MS).toBe(10 * 60 * 1000);
    expect(isCollectorFresh(NOW - COLLECTOR_STALE_AFTER_MS, NOW)).toBe(true);
    expect(isCollectorFresh(NOW - COLLECTOR_STALE_AFTER_MS - 1, NOW)).toBe(false);
    expect(isCollectorFresh(null, NOW)).toBe(false);
  });
});

describe('splitHintCommands', () => {
  it('marks exactly the known commands so the card can set them in mono', () => {
    expect(HINT_COMMANDS).toEqual(['npm run electron:dev', 'npm start']);
    expect(splitHintCommands('Start it with npm run electron:dev.')).toEqual([
      { text: 'Start it with ', command: false },
      { text: 'npm run electron:dev', command: true },
      { text: '.', command: false },
    ]);
    expect(splitHintCommands('Start it from the checkout: npm start in collector/.')).toEqual([
      { text: 'Start it from the checkout: ', command: false },
      { text: 'npm start', command: true },
      { text: ' in collector/.', command: false },
    ]);
    expect(splitHintCommands('Needs the desktop app.')).toEqual([{ text: 'Needs the desktop app.', command: false }]);
  });
});

describe('computeReadiness', () => {
  it('lists Desktop app, Terminal, Statusline, Collector in that order', () => {
    expect(computeReadiness(COLD, false, NOW).map((r) => r.key)).toEqual(['desktop', 'terminal', 'statusline', 'collector']);
  });

  it('Desktop app: states the fact once, with no appended reason, and hints how to start it', () => {
    expect(row(computeReadiness(COLD, true, NOW), 'desktop')).toMatchObject({ met: true, text: 'Desktop app: running.', hint: null });
    const unmet = row(computeReadiness(COLD, false, NOW), 'desktop');
    expect(unmet).toMatchObject({ met: false, text: 'Desktop app: not running.', hint: 'Start it with npm run electron:dev.' });
    expect(unmet.text).not.toContain(DESKTOP_APP_REASON);
  });

  it('Terminal: open since the stamped time; defensive "open." when unstamped', () => {
    const open = { ...COLD, terminalAlive: true, terminalOpenedAtMs: at(2026, 8, 29, 14, 2) };
    expect(row(computeReadiness(open, true, NOW), 'terminal')).toMatchObject({ met: true, text: 'Terminal: open since 14:02.', hint: null });
    const yesterday = { ...open, terminalOpenedAtMs: at(2026, 8, 28, 22, 15) };
    expect(row(computeReadiness(yesterday, true, NOW), 'terminal').text).toBe('Terminal: open since Sep 28 22:15.');
    expect(row(computeReadiness({ ...COLD, terminalAlive: true }, true, NOW), 'terminal')).toMatchObject({ met: true, text: 'Terminal: open.' });
  });

  it('Terminal: with no session, points at OPEN TERMINAL only in the desktop app', () => {
    expect(row(computeReadiness(COLD, true, NOW), 'terminal')).toMatchObject({ met: false, text: 'Terminal: no session yet.', hint: 'Use OPEN TERMINAL below.' });
    expect(row(computeReadiness(COLD, false, NOW), 'terminal')).toMatchObject({ met: false, text: 'Terminal: no session yet.', hint: 'Needs the desktop app.' });
  });

  it('Statusline: live with its capture time, no reading yet, or stale with its last time', () => {
    expect(row(computeReadiness({ ...COLD, statusline: snap(at(2026, 8, 29, 14, 29)) }, true, NOW), 'statusline')).toMatchObject({
      met: true,
      text: 'Statusline: live, 14:29.',
      hint: null,
    });
    expect(row(computeReadiness(COLD, true, NOW), 'statusline')).toMatchObject({
      met: false,
      text: 'Statusline: no reading yet.',
      hint: 'Install it in Settings, then run a Claude Code turn.',
    });
    expect(row(computeReadiness({ ...COLD, statusline: snap(at(2026, 8, 28, 14, 2)) }, true, NOW), 'statusline')).toMatchObject({
      met: false,
      text: 'Statusline: last reading Sep 28 14:02.',
      hint: 'Refreshes on each Claude Code turn.',
    });
  });

  it('Collector: last event when fresh, no events since when stale, no events recorded when empty or absent', () => {
    const hint = 'Start it from the checkout: npm start in collector/.';
    expect(row(computeReadiness({ ...COLD, diagnostics: anomalyAt(at(2026, 8, 29, 14, 25)) }, true, NOW), 'collector')).toMatchObject({
      met: true,
      text: 'Collector: last event 14:25.',
      hint: null,
    });
    expect(row(computeReadiness({ ...COLD, diagnostics: anomalyAt(at(2026, 8, 29, 13, 0)) }, true, NOW), 'collector')).toMatchObject({
      met: false,
      text: 'Collector: no events since 13:00.',
      hint,
    });
    expect(row(computeReadiness({ ...COLD, diagnostics: EMPTY_DIAG }, true, NOW), 'collector')).toMatchObject({ met: false, text: 'Collector: no events recorded.', hint });
    expect(row(computeReadiness(COLD, true, NOW), 'collector')).toMatchObject({ met: false, text: 'Collector: no events recorded.', hint });
  });

  it('Collector row is met at exactly COLLECTOR_STALE_AFTER_MS and unmet 1ms later', () => {
    const met = (age: number) => row(computeReadiness({ ...COLD, diagnostics: anomalyAt(NOW - age) }, true, NOW), 'collector').met;
    expect(met(COLLECTOR_STALE_AFTER_MS)).toBe(true);
    expect(met(COLLECTOR_STALE_AFTER_MS + 1)).toBe(false);
  });

  it('lets only met live signals glow: Terminal and Statusline, never Desktop app or Collector', () => {
    const rows = computeReadiness(
      { ...COLD, terminalAlive: true, terminalOpenedAtMs: NOW, statusline: snap(NOW), diagnostics: anomalyAt(NOW) },
      true,
      NOW,
    );
    expect(rows.map((r) => [r.key, r.glows])).toEqual([
      ['desktop', false],
      ['terminal', true],
      ['statusline', true],
      ['collector', false],
    ]);
    expect(computeReadiness(COLD, false, NOW).some((r) => r.glows)).toBe(false);
  });

  it('agrees with isSessionLive at the statusline freshness boundary', () => {
    for (const age of [STATUSLINE_STALE_AFTER_MS, STATUSLINE_STALE_AFTER_MS + 1]) {
      const state = { ...COLD, statusline: snap(NOW - age) };
      expect(row(computeReadiness(state, true, NOW), 'statusline').met).toBe(isSessionLive(state, NOW));
    }
  });
});

describe('READINESS honesty rules', () => {
  const cases: { desktop: boolean; rows: ReadinessRow[] }[] = [];
  for (const desktop of [false, true])
    for (const terminalAlive of [false, true])
      for (const statusline of [null, snap(NOW), snap(NOW - STATUSLINE_STALE_AFTER_MS - 1)])
        for (const diagnostics of [null, EMPTY_DIAG, anomalyAt(NOW), anomalyAt(NOW - COLLECTOR_STALE_AFTER_MS - 1)])
          cases.push({
            desktop,
            rows: computeReadiness({ terminalAlive, terminalOpenedAtMs: terminalAlive ? NOW : null, statusline, diagnostics }, desktop, NOW),
          });

  it('rule 1: names OPEN TERMINAL in a hint only when the desktop app is present', () => {
    for (const { desktop, rows } of cases) for (const r of rows) if (r.hint?.includes('OPEN TERMINAL')) expect(desktop).toBe(true);
    expect(cases.some(({ rows }) => rows.some((r) => r.hint === 'Use OPEN TERMINAL below.'))).toBe(true);
  });

  it('rule 2: the collector copy never says "running"', () => {
    for (const { rows } of cases) expect(row(rows, 'collector').text.toLowerCase()).not.toContain('running');
  });

  it('rule 4: a met row never has a hint, an unmet row always does', () => {
    for (const { rows } of cases) for (const r of rows) expect(r.hint === null).toBe(r.met);
  });
});
```

- [ ] **Step 3: Run the new tests and verify they fail**

Run: `npx vitest run src/state/reducer.test.ts src/components/dashboard/readinessMath.test.ts`
Expected: FAIL. `terminalOpenedAtMs` tests fail with `expected undefined to be null` / `expected undefined to be 1000`. readinessMath fails with `TypeError: ... formatReadinessTime is not a function` (and similar for the other new exports), plus copy mismatches such as `Collector: running.`.

- [ ] **Step 4: Add the store field.**

`src/state/types.ts`, directly after `terminalAlive: boolean;` (line 224):

```ts
  // When the current pty became alive (Date.now() at SET_TERMINAL_ALIVE's
  // dead->alive edge), for READINESS's "Terminal: open since HH:MM.". Null
  // whenever terminalAlive is false. main re-sends pty:alive for a running pty
  // on every pty:start, so a repeat alive keeps the original stamp.
  terminalOpenedAtMs: number | null;
```

`src/state/initialState.ts`, directly after `terminalAlive: false,` (line 57):

```ts
  terminalOpenedAtMs: null,
```

`src/state/reducer.ts`, replace lines 174-175:

```ts
    case 'SET_TERMINAL_ALIVE':
      if (!action.alive) return { ...state, terminalAlive: false, terminalOpenedAtMs: null };
      // Only a dead->alive edge restamps: electron/main.ts re-sends pty:alive
      // for an already-running pty on every pty:start (each Terminal mount).
      return {
        ...state,
        terminalAlive: true,
        terminalOpenedAtMs: state.terminalAlive && state.terminalOpenedAtMs !== null ? state.terminalOpenedAtMs : Date.now(),
      };
```

`src/state/persistence.ts`, directly after the `terminalAlive:` entry (line 51):

```ts
  terminalOpenedAtMs: "stamped by this session's own pty:alive edge (SET_TERMINAL_ALIVE) and cleared on pty:exit; a persisted value would date a previous session's terminal as this one's, same reasoning as terminalAlive",
```

- [ ] **Step 5: Rewrite the top of `readinessMath.ts`.** Replace lines 1-67 (the imports through the end of `computeReadiness`) with the code below. Keep everything from `export interface DigestPresence` down unchanged.

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
  /** How to make an unmet row true, in one line. Null on a met row, never null on an unmet one. */
  readonly hint: string | null;
}

/** Printed once, under a disabled OPEN TERMINAL (OpenTerminalButton). The Desktop row no longer repeats it. */
export const DESKTOP_APP_REASON = 'The Terminal and live tracking need the desktop app.';

/** A collector whose newest recorded event is older than this reads as not ready. */
export const COLLECTOR_STALE_AFTER_MS = 10 * 60 * 1000;

/** The commands a hint may name; ReadinessCard sets these in the mono font. */
export const HINT_COMMANDS = ['npm run electron:dev', 'npm start'] as const;

/** True inside Electron, where preload exposes window.aetherElectron; plain `npm run dev` has none. */
export function hasDesktopApp(): boolean {
  return typeof window !== 'undefined' && window.aetherElectron !== undefined;
}

/** Same threshold and comparison as isSessionLive's statusline signal (dashboardMath.ts). */
export function isStatuslineFresh(snap: StatuslineSnapshot | null, nowMs: number): boolean {
  return snap !== null && nowMs - snap.capturedAtMs <= STATUSLINE_STALE_AFTER_MS;
}

// A fixed table, not toLocale*: the OS locale must not change READINESS copy.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Absolute local time, `HH:MM`, prefixed with the short date (`Sep 28 14:02`)
 * when `atMs` is not on `nowMs`'s local calendar day. Pure: compares against
 * `nowMs`, never `new Date()`, so a test fixes both ends. No relative times --
 * they would need a ticking re-render and go stale on screen.
 */
export function formatReadinessTime(atMs: number, nowMs: number): string {
  const t = new Date(atMs);
  const now = new Date(nowMs);
  const hhmm = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  const sameDay = t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
  return sameDay ? hhmm : `${MONTHS[t.getMonth()]} ${t.getDate()} ${hhmm}`;
}

/**
 * The newest event the collector recorded, across tool calls, dispatches and
 * anomalies. This is what the app can observe about the collector: it never
 * starts or watches the collector process, so it cannot claim "running".
 */
export function newestCollectorEventMs(diagnostics: AetherState['diagnostics']): number | null {
  if (diagnostics === null) return null;
  let newest: number | null = null;
  const stamps = [
    ...diagnostics.toolCalls.map((t) => t.closedAtMs),
    ...diagnostics.dispatches.map((d) => d.endedAtMs),
    ...diagnostics.anomalies.map((a) => a.detectedAtMs),
  ];
  for (const ms of stamps) if (newest === null || ms > newest) newest = ms;
  return newest;
}

/** Same `<=` comparison as isStatuslineFresh. */
export function isCollectorFresh(newestMs: number | null, nowMs: number): boolean {
  return newestMs !== null && nowMs - newestMs <= COLLECTOR_STALE_AFTER_MS;
}

export interface HintPart {
  readonly text: string;
  readonly command: boolean;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HINT_COMMAND_SPLIT = new RegExp(`(${HINT_COMMANDS.map(escapeRegExp).join('|')})`);

/** Splits a hint into plain text and HINT_COMMANDS runs, in order, dropping empty pieces. */
export function splitHintCommands(hint: string): HintPart[] {
  return hint
    .split(HINT_COMMAND_SPLIT)
    .filter((text) => text !== '')
    .map((text) => ({ text, command: (HINT_COMMANDS as readonly string[]).includes(text) }));
}

/**
 * The READINESS rows. Every signal is already in the store or on
 * window.aetherElectron (passed in as `desktop` so this stays pure). None of
 * these is a request for the operator, so none is amber: met or not met. A
 * met row says when it was last true; an unmet row says how to fix it.
 */
export function computeReadiness(
  state: Pick<AetherState, 'terminalAlive' | 'terminalOpenedAtMs' | 'statusline' | 'diagnostics'>,
  desktop: boolean,
  nowMs: number,
): ReadinessRow[] {
  const time = (ms: number) => formatReadinessTime(ms, nowMs);
  const statuslineFresh = isStatuslineFresh(state.statusline, nowMs);
  const newest = newestCollectorEventMs(state.diagnostics);
  const collectorFresh = isCollectorFresh(newest, nowMs);
  return [
    {
      key: 'desktop',
      met: desktop,
      glows: false,
      text: desktop ? 'Desktop app: running.' : 'Desktop app: not running.',
      hint: desktop ? null : 'Start it with npm run electron:dev.',
    },
    {
      key: 'terminal',
      met: state.terminalAlive,
      glows: state.terminalAlive,
      text: !state.terminalAlive
        ? 'Terminal: no session yet.'
        : state.terminalOpenedAtMs === null
          ? 'Terminal: open.'
          : `Terminal: open since ${time(state.terminalOpenedAtMs)}.`,
      // Rule 1: name OPEN TERMINAL only when it can actually open one.
      hint: state.terminalAlive ? null : desktop ? 'Use OPEN TERMINAL below.' : 'Needs the desktop app.',
    },
    {
      key: 'statusline',
      met: statuslineFresh,
      glows: statuslineFresh,
      text:
        state.statusline === null
          ? 'Statusline: no reading yet.'
          : statuslineFresh
            ? `Statusline: live, ${time(state.statusline.capturedAtMs)}.`
            : `Statusline: last reading ${time(state.statusline.capturedAtMs)}.`,
      hint: state.statusline === null ? 'Install it in Settings, then run a Claude Code turn.' : statuslineFresh ? null : 'Refreshes on each Claude Code turn.',
    },
    {
      key: 'collector',
      met: collectorFresh,
      glows: false,
      text:
        newest === null
          ? 'Collector: no events recorded.'
          : collectorFresh
            ? `Collector: last event ${time(newest)}.`
            : `Collector: no events since ${time(newest)}.`,
      hint: collectorFresh ? null : 'Start it from the checkout: npm start in collector/.',
    },
  ];
}
```

- [ ] **Step 6: Update the card test's expected strings** (the card still renders `r.text` only until Task 2). In `src/components/dashboard/ReadinessCard.test.tsx`:

(a) In `allMet()`, replace the `SET_DIAGNOSTICS` line with:

```ts
    dispatchRef!({
      type: 'SET_DIAGNOSTICS',
      diagnostics: { toolCalls: [], dispatches: [], anomalies: [{ kind: 'k', toolUseId: 't', detail: 'd', detectedAtMs: Date.now() }] },
    });
```

(b) Replace the body of `it('reads the cold browser-mode sentences', ...)` with:

```ts
    renderCard();
    expect(rowText('desktop')).toBe('Desktop app: not running.');
    expect(rowText('desktop')).not.toContain(DESKTOP_APP_REASON);
    expect(rowText('terminal')).toBe('Terminal: no session yet.');
    expect(rowText('statusline')).toBe('Statusline: no reading yet.');
    expect(rowText('collector')).toBe('Collector: no events recorded.');
```

(c) In `it('reads all four met sentences ...')`, replace the four `expect` lines with:

```ts
    expect(rowText('desktop')).toBe('Desktop app: running.');
    expect(rowText('terminal')).toMatch(/^Terminal: open since \d{2}:\d{2}\.$/);
    expect(rowText('statusline')).toMatch(/^Statusline: live, \d{2}:\d{2}\.$/);
    expect(rowText('collector')).toMatch(/^Collector: last event \d{2}:\d{2}\.$/);
```

(d) In `it('updates a row within one store update', ...)` and `it('keeps a met Terminal dot flat green ...', ...)`, replace `expect(rowText('terminal')).toBe('Terminal: open.');` with:

```ts
    expect(rowText('terminal')).toMatch(/^Terminal: open since \d{2}:\d{2}\.$/);
```

- [ ] **Step 7: Run the task's tests and verify they pass**

Run: `npx vitest run src/state/reducer.test.ts src/state/persistence.test.ts src/components/dashboard/readinessMath.test.ts src/components/dashboard/ReadinessCard.test.tsx src/components/dashboard/DashboardView.test.tsx`
Expected: PASS, 0 failed.

- [ ] **Step 8: Typecheck and build**

Run: `npm run build`
Expected: exit 0 (`tsc -b` clean; `✓ built in`).
Run: `npm run typecheck:electron`
Expected: exit 0, no output after the script banner.

- [ ] **Step 9: Commit**

```bash
git add -- src/state/types.ts src/state/initialState.ts src/state/reducer.ts src/state/persistence.ts src/state/reducer.test.ts src/components/dashboard/readinessMath.ts src/components/dashboard/readinessMath.test.ts src/components/dashboard/ReadinessCard.test.tsx
git commit -m "feat(readiness): honest collector row, times and hints; terminalOpenedAtMs" -- src/state/types.ts src/state/initialState.ts src/state/reducer.ts src/state/persistence.ts src/state/reducer.test.ts src/components/dashboard/readinessMath.ts src/components/dashboard/readinessMath.test.ts src/components/dashboard/ReadinessCard.test.tsx
```

---

### Task 2: READINESS card fills the column and prints hints

**Files:**
- Modify: `src/components/dashboard/ReadinessCard.tsx` (whole file)
- Test: `src/components/dashboard/ReadinessCard.test.tsx` (whole file)

**Interfaces:**
- Consumes (Task 1): `computeReadiness(...)` returning rows with `hint: string | null`; `splitHintCommands(hint): HintPart[]`; `DESKTOP_APP_REASON`.
- Consumes (unchanged): `OpenTerminalButton({ live })`. Task 3 makes `live` optional and adds `variant`, and passing `live` stays valid.
- Produces: DOM test ids `readiness-{key}` (li), `readiness-dot-{key}`, `readiness-text-{key}`, `readiness-hint-{key}` (only on unmet rows), `readiness-action` (the bottom-pinned wrapper).

- [ ] **Step 1: Write the failing tests.** Replace `src/components/dashboard/ReadinessCard.test.tsx` with:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { ReadinessCard } from './ReadinessCard';
import { DESKTOP_APP_REASON } from './readinessMath';
import { colors, fonts } from '../../styles/tokens';
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
  return render(
    <AetherStoreProvider>
      <DispatchProbe />
      <ReadinessCard />
    </AetherStoreProvider>,
  );
}
function allMet() {
  act(() => {
    dispatchRef!({ type: 'SET_TERMINAL_ALIVE', alive: true });
    dispatchRef!({ type: 'SET_STATUSLINE', snapshot: freshStatusline() });
    dispatchRef!({
      type: 'SET_DIAGNOSTICS',
      diagnostics: { toolCalls: [], dispatches: [], anomalies: [{ kind: 'k', toolUseId: 't', detail: 'd', detectedAtMs: Date.now() }] },
    });
  });
}

// jsdom normalizes colours (hex -> rgb) and font lists (quote style), so compare through the same parser.
function cssColor(value: string): string {
  const el = document.createElement('span');
  el.style.color = value;
  return el.style.color;
}
function cssFontFamily(value: string): string {
  const el = document.createElement('span');
  el.style.fontFamily = value;
  return el.style.fontFamily;
}

const KEYS = ['desktop', 'terminal', 'statusline', 'collector'] as const;
const text = (key: string) => screen.getByTestId(`readiness-text-${key}`).textContent;
const hint = (key: string) => screen.queryByTestId(`readiness-hint-${key}`);
const dot = (key: string) => screen.getByTestId(`readiness-dot-${key}`);
const card = () => screen.getByRole('heading', { name: 'READINESS' }).closest('section')!;

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

  it('reads the cold browser-mode sentences, with the desktop reason printed once (under the button)', () => {
    renderCard();
    expect(text('desktop')).toBe('Desktop app: not running.');
    expect(text('terminal')).toBe('Terminal: no session yet.');
    expect(text('statusline')).toBe('Statusline: no reading yet.');
    expect(text('collector')).toBe('Collector: no events recorded.');
    expect(within(card()).getAllByText(DESKTOP_APP_REASON)).toHaveLength(1);
  });

  it('prints a hint under every unmet row in browser mode', () => {
    renderCard();
    expect(hint('desktop')!.textContent).toBe('Start it with npm run electron:dev.');
    expect(hint('terminal')!.textContent).toBe('Needs the desktop app.');
    expect(hint('statusline')!.textContent).toBe('Install it in Settings, then run a Claude Code turn.');
    expect(hint('collector')!.textContent).toBe('Start it from the checkout: npm start in collector/.');
  });

  it('in the desktop app points the Terminal hint at OPEN TERMINAL and drops the Desktop hint', () => {
    vi.stubGlobal('aetherElectron', {});
    renderCard();
    expect(hint('desktop')).toBeNull();
    expect(hint('terminal')!.textContent).toBe('Use OPEN TERMINAL below.');
  });

  it('reads all four met sentences with absolute times, and no hints', () => {
    vi.stubGlobal('aetherElectron', {});
    renderCard();
    allMet();
    expect(text('desktop')).toBe('Desktop app: running.');
    expect(text('terminal')).toMatch(/^Terminal: open since \d{2}:\d{2}\.$/);
    expect(text('statusline')).toMatch(/^Statusline: live, \d{2}:\d{2}\.$/);
    expect(text('collector')).toMatch(/^Collector: last event \d{2}:\d{2}\.$/);
    for (const key of KEYS) expect(hint(key)).toBeNull();
  });

  it('indents the hint to the sentence edge, clear of the dot, in 11px Text Muted UI type', () => {
    renderCard();
    expect(dot('desktop').style.gridColumn).toBe('1');
    expect(screen.getByTestId('readiness-text-desktop').style.gridColumn).toBe('2');
    const h = hint('desktop')!;
    expect(h.style.gridColumn).toBe('2');
    expect(h.style.gridRow).toBe('2');
    expect(h.style.fontSize).toBe('11px');
    expect(h.style.fontWeight).toBe('400');
    expect(h.style.color).toBe(cssColor(colors.textMuted));
    expect(h.style.fontFamily).toBe(cssFontFamily(fonts.ui));
  });

  it('sets command text in the mono font, and only command text', () => {
    renderCard();
    const desktopCmd = hint('desktop')!.querySelector('code')!;
    expect(desktopCmd.textContent).toBe('npm run electron:dev');
    expect(desktopCmd.style.fontFamily).toBe(cssFontFamily(fonts.mono));
    expect(hint('collector')!.querySelector('code')!.textContent).toBe('npm start');
    expect(hint('terminal')!.querySelector('code')).toBeNull();
  });

  it('fills the column and pins OPEN TERMINAL to the bottom; the stretch is not between rows', () => {
    renderCard();
    expect(card().style.flexGrow).toBe('1');
    const action = screen.getByTestId('readiness-action');
    expect(action.style.marginTop).toBe('auto');
    expect(within(action).getByRole('button', { name: 'OPEN TERMINAL' })).toBeTruthy();
    const list = screen.getByRole('list');
    expect(list.style.gap).toBe('9px');
    expect(list.style.flexGrow).toBe('');
  });

  it('updates a row within one store update', () => {
    renderCard();
    act(() => dispatchRef!({ type: 'SET_TERMINAL_ALIVE', alive: true }));
    expect(text('terminal')).toMatch(/^Terminal: open since \d{2}:\d{2}\.$/);
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

  it('keeps a met Terminal dot flat green while the console is idle (STANDBY)', () => {
    renderCard();
    act(() => dispatchRef!({ type: 'SET_TERMINAL_ALIVE', alive: true }));
    expect(dot('terminal').style.background).not.toBe('transparent');
    expect(dot('terminal').style.boxShadow).toBe('');
  });

  it('rule 3: draws every unmet dot as a hollow Text Muted ring, and uses no amber anywhere', () => {
    const noAmber = () => {
      const html = card().outerHTML.toLowerCase();
      expect(html).not.toContain(cssColor(colors.warn));
      expect(html).not.toContain(colors.warn.toLowerCase());
    };
    const { unmount } = renderCard();
    for (const key of KEYS) {
      expect(dot(key).style.background).toBe('transparent');
      expect(dot(key).style.border).toContain(cssColor(colors.textMuted));
      expect(dot(key).style.boxShadow).toBe('');
    }
    noAmber();
    unmount();
    vi.stubGlobal('aetherElectron', {});
    renderCard();
    allMet();
    noAmber();
  });

  it('holds the OPEN TERMINAL action', () => {
    renderCard();
    expect(screen.getByRole('button', { name: 'OPEN TERMINAL' })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/components/dashboard/ReadinessCard.test.tsx`
Expected: FAIL with `Unable to find an element by: [data-testid="readiness-text-desktop"]` (and `readiness-hint-*`, `readiness-action`). `flexGrow` is `'0'`, not `'1'`, because the card currently has `flex: none`.

- [ ] **Step 3: Implement.** Replace `src/components/dashboard/ReadinessCard.tsx` with:

```tsx
import { Fragment, useId, type CSSProperties } from 'react';
import { dotGlow, fonts, radii, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { isSessionLive } from './dashboardMath';
import { computeReadiness, hasDesktopApp, splitHintCommands } from './readinessMath';
import { OpenTerminalButton } from './OpenTerminalButton';

/**
 * READINESS: what the console needs before it can show live work. Each met
 * row says when it was last true; each unmet row adds one hint line saying
 * how to fix it. Met is Nominal Green; unmet is a hollow muted ring -- never
 * amber, because none of these asks the operator for anything. A dot glows
 * only while the session is live (Glow Is State). No live-region
 * announcements here: the Footer is the one status announcement.
 *
 * The card fills the right column beside the reactor (flex: 1). The rows keep
 * their rhythm at the top; the stretch goes between the last row and OPEN
 * TERMINAL, which is pinned to the card's bottom edge.
 */
export function ReadinessCard() {
  const colors = useColors();
  const { state } = useAetherStore();
  const headingId = useId();
  const now = Date.now();
  const live = isSessionLive(state, now);
  const rows = computeReadiness(state, hasDesktopApp(), now);
  return (
    <section aria-labelledby={headingId} style={cardStyle(colors)}>
      <h2 id={headingId} style={{ ...titleStyle(colors), margin: 0 }}>
        READINESS
      </h2>
      <ul style={listStyle}>
        {rows.map((r) => (
          <li key={r.key} data-testid={`readiness-${r.key}`} style={rowStyle(colors)}>
            <span aria-hidden="true" data-testid={`readiness-dot-${r.key}`} style={dotStyle(colors, r.met, r.glows && live)} />
            <span data-testid={`readiness-text-${r.key}`} style={sentenceStyle}>
              {r.text}
            </span>
            {r.hint !== null && (
              <span data-testid={`readiness-hint-${r.key}`} style={hintStyle(colors)}>
                {splitHintCommands(r.hint).map((part, i) =>
                  part.command ? (
                    <code key={i} style={commandStyle}>
                      {part.text}
                    </code>
                  ) : (
                    <Fragment key={i}>{part.text}</Fragment>
                  ),
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div data-testid="readiness-action" style={actionWrapStyle}>
        <OpenTerminalButton live={live} />
      </div>
    </section>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 1,
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
// Two columns: the 8px dot, then the sentence with its hint beneath it, so a
// wrapped or hinted line stays indented clear of the dot.
function rowStyle(colors: ColorPalette): CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: '8px 1fr',
    columnGap: 10,
    rowGap: 2,
    alignItems: 'center',
    font: `400 12px/1.5 ${fonts.ui}`,
    color: colors.textBody,
  };
}
const sentenceStyle: CSSProperties = { gridColumn: 2, gridRow: 1 };
function hintStyle(colors: ColorPalette): CSSProperties {
  // Longhands, not the `font` shorthand, so the 11px floor is checkable.
  return { gridColumn: 2, gridRow: 2, fontFamily: fonts.ui, fontWeight: 400, fontSize: 11, lineHeight: 1.5, color: colors.textMuted };
}
const commandStyle: CSSProperties = { fontFamily: fonts.mono, fontSize: 11 };
const actionWrapStyle: CSSProperties = { marginTop: 'auto' };
function dotStyle(colors: ColorPalette, met: boolean, glowing: boolean): CSSProperties {
  return {
    gridColumn: 1,
    gridRow: 1,
    width: 8,
    height: 8,
    borderRadius: '50%',
    boxSizing: 'border-box',
    background: met ? colors.success : 'transparent',
    border: `1px solid ${met ? colors.success : colors.textMuted}`,
    boxShadow: met && glowing ? dotGlow(colors.success) : undefined,
  };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/components/dashboard/ReadinessCard.test.tsx src/components/dashboard/DashboardView.test.tsx`
Expected: PASS, 0 failed.

- [ ] **Step 5: Typecheck and build**

Run: `npm run build`
Expected: exit 0.
Run: `npm run typecheck:electron`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -- src/components/dashboard/ReadinessCard.tsx src/components/dashboard/ReadinessCard.test.tsx
git commit -m "feat(readiness): card fills the column, hint line per unmet row, button pinned to the base" -- src/components/dashboard/ReadinessCard.tsx src/components/dashboard/ReadinessCard.test.tsx
```

---

### Task 3: One OPEN TERMINAL everywhere

**Files:**
- Modify: `src/components/dashboard/OpenTerminalButton.tsx` (whole file)
- Test: `src/components/dashboard/OpenTerminalButton.test.tsx` (whole file)
- Create: `src/components/dashboard/openTerminalLiteral.test.ts`
- Modify: `src/components/shared/EmptyState.tsx:1-31` (imports, props, component)
- Test: `src/components/shared/EmptyState.test.tsx` (append one test)
- Modify: `src/components/agents/AgentRosterCard.tsx:1-10` (import) and `:65` (empty state)
- Test: `src/components/agents/AgentRosterCard.narration.test.tsx` (imports, `afterEach`, the `AgentRosterCard empty state` describe)

**Interfaces:**
- Consumes: `DESKTOP_APP_REASON`, `hasDesktopApp` from `readinessMath.ts`. Their names and values are unchanged by Task 1.
- Produces:
  - `export type OpenTerminalVariant = 'primary' | 'secondary'`
  - `OpenTerminalButton({ live = false, variant = 'primary' }: { live?: boolean; variant?: OpenTerminalVariant })`. Primary is the current look. Secondary is the DESIGN.md Secondary treatment. Both share the desktop-app check (`aria-disabled` + reason with `aria-describedby`).
  - `EmptyState` props become a union: `{ message; action?: EmptyStateAction }` or `{ message; actionSlot: ReactNode }`. Either one gets the `FOCUS_RING_CLEARANCE` padding.

- [ ] **Step 1: Write the failing single-renderer guard.** Create `src/components/dashboard/openTerminalLiteral.test.ts`:

```ts
// @vitest-environment node
//
// Spec 2026-09-29-readiness-pass item 5: every OPEN TERMINAL renders through
// OpenTerminalButton, so the desktop-app check (aria-disabled + reason) is
// shared. This scans the TypeScript AST of every non-test source file under
// src/ for a string literal or JSX text whose trimmed value IS the label.
// Comments are never visited. A sentence that names the control (READINESS's
// "Use OPEN TERMINAL below.") is not a rendering of it, hence exact match.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const LABEL = 'OPEN TERMINAL';
const OWNER = path.join('src', 'components', 'dashboard', 'OpenTerminalButton.tsx');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function labelLiterals(file: string): number {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind);
  let hits = 0;
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) && node.text.trim() === LABEL) hits++;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe('OPEN TERMINAL has one renderer', () => {
  const files = sourceFiles('src');

  it('scans a real tree (never passes vacuously)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(OWNER);
  });

  it('only OpenTerminalButton.tsx carries the OPEN TERMINAL label', () => {
    expect(files.filter((f) => f !== OWNER && labelLiterals(f) > 0)).toEqual([]);
    expect(labelLiterals(OWNER)).toBe(1);
  });
});
```

- [ ] **Step 2: Write the failing variant tests.** Replace `src/components/dashboard/OpenTerminalButton.test.tsx` with:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { OpenTerminalButton, type OpenTerminalVariant } from './OpenTerminalButton';
import { DESKTOP_APP_REASON } from './readinessMath';
import { colors } from '../../styles/tokens';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function cssColor(value: string): string {
  const el = document.createElement('span');
  el.style.color = value;
  return el.style.color;
}

function StartOnDashboard() {
  const { state, dispatch } = useAetherStore();
  useEffect(() => {
    dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Dashboard' });
  }, [dispatch]);
  return <div data-testid="active-tab">{state.activeTab}</div>;
}

function renderButton({ live, variant }: { live?: boolean; variant?: OpenTerminalVariant } = {}) {
  return render(
    <AetherStoreProvider>
      <StartOnDashboard />
      <OpenTerminalButton live={live} variant={variant} />
    </AetherStoreProvider>,
  );
}
const button = () => screen.getByRole('button', { name: 'OPEN TERMINAL' });

describe('OpenTerminalButton', () => {
  it('in browser mode is aria-disabled (not removed), says why beneath, and does not navigate', () => {
    renderButton();
    const btn = button();
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
    fireEvent.click(button());
    expect(screen.getByTestId('active-tab').textContent).toBe('Terminal');
    expect(screen.queryByText(DESKTOP_APP_REASON)).toBeNull();
  });

  it('glows at rest only while a session is live', () => {
    vi.stubGlobal('aetherElectron', {});
    const { unmount } = renderButton({ live: false });
    expect(button().style.boxShadow).toBe('');
    unmount();
    renderButton({ live: true });
    expect(button().style.boxShadow).not.toBe('');
  });

  it('defaults to the primary look: the cyan gradient', () => {
    vi.stubGlobal('aetherElectron', {});
    renderButton();
    expect(button().style.background).toContain('linear-gradient');
  });

  it('secondary: the inset Secondary treatment, same navigation, never a resting glow', () => {
    vi.stubGlobal('aetherElectron', {});
    renderButton({ variant: 'secondary', live: true });
    const btn = button();
    expect(btn.style.background).not.toContain('linear-gradient');
    expect(btn.style.padding).toBe('7px 12px');
    expect(btn.style.color).toBe(cssColor(colors.accentCyan));
    expect(btn.style.boxShadow).toBe('');
    fireEvent.click(btn);
    expect(screen.getByTestId('active-tab').textContent).toBe('Terminal');
  });

  it('secondary shares the desktop-app check: aria-disabled, the reason beneath, no navigation', () => {
    renderButton({ variant: 'secondary' });
    const btn = button();
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('aria-describedby')).toBe(screen.getByText(DESKTOP_APP_REASON).id);
    fireEvent.click(btn);
    expect(screen.getByTestId('active-tab').textContent).toBe('Dashboard');
  });
});
```

- [ ] **Step 3: Write the failing EmptyState and Agents tests.**

Append inside `describe('EmptyState', ...)` in `src/components/shared/EmptyState.test.tsx`:

```tsx
  it('takes a ready-made action in actionSlot and reserves the same focus-ring room for it', () => {
    const { container } = render(<EmptyState message="No agents are running." actionSlot={<button type="button">GO</button>} />);
    const root = container.querySelector<HTMLElement>('[data-empty-state]')!;
    expect(root.style.padding).toBe(`${FOCUS_RING_CLEARANCE}px`);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'GO' })).toBeTruthy();
  });
```

In `src/components/agents/AgentRosterCard.narration.test.tsx`: change line 1 to `import { afterEach, describe, it, expect, vi } from 'vitest';`, add `import { DESKTOP_APP_REASON } from '../dashboard/readinessMath';` after the existing imports, and replace `afterEach(cleanup);` with:

```ts
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
```

Then, in `describe('AgentRosterCard empty state', ...)`, make `vi.stubGlobal('aetherElectron', {});` the first line of the existing `it('says no agents are running and offers OPEN TERMINAL, which switches to the Terminal tab', ...)`, and append this test after it, inside the same describe:

```tsx
  it('renders OPEN TERMINAL through the shared button, so browser mode gets aria-disabled and the reason', () => {
    render(
      <AetherStoreProvider>
        <Setter agents={[]} narrations={{}} />
        <TabProbe />
        <AgentRosterCard selectedToolUseId={null} />
      </AetherStoreProvider>,
    );
    const btn = screen.getByRole('button', { name: 'OPEN TERMINAL' });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('aria-describedby')).toBe(screen.getByText(DESKTOP_APP_REASON).id);
    fireEvent.click(btn);
    expect(screen.getByTestId('active-tab').textContent).toBe('Agents');
  });
```

- [ ] **Step 4: Run the tests and verify they fail**

Run: `npx vitest run src/components/dashboard/openTerminalLiteral.test.ts src/components/dashboard/OpenTerminalButton.test.tsx src/components/shared/EmptyState.test.tsx src/components/agents/AgentRosterCard.narration.test.tsx`
Expected: FAIL. The literal guard lists `src\components\agents\AgentRosterCard.tsx`. The secondary tests fail (`expected '' to be '7px 12px'`, or the gradient is still present). The actionSlot test finds no `GO` button. The Agents browser-mode test gets `aria-disabled` `null`.

- [ ] **Step 5: Implement `OpenTerminalButton`.** Replace `src/components/dashboard/OpenTerminalButton.tsx` with:

```tsx
import { useId, type CSSProperties } from 'react';
import { fonts, glows, radii, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { DESKTOP_APP_REASON, hasDesktopApp } from './readinessMath';

export type OpenTerminalVariant = 'primary' | 'secondary';

/**
 * The one OPEN TERMINAL in the app; openTerminalLiteral.test.ts fails if any
 * other file carries the label. `primary` is the Dashboard's action under
 * READINESS; `secondary` (DESIGN.md Buttons > Secondary) is for empty states
 * such as the Agents roster. In browser mode there is no pty to open, so
 * either variant stays in place, aria-disabled (still focusable, so a screen
 * reader reaches it and hears why), with the Desktop-app reason directly
 * beneath it. Nothing about it reads as an error.
 */
export function OpenTerminalButton({ live = false, variant = 'primary' }: { live?: boolean; variant?: OpenTerminalVariant }) {
  const colors = useColors();
  const { dispatch } = useAetherStore();
  const reasonId = useId();
  const desktop = hasDesktopApp();
  const secondary = variant === 'secondary';
  const style = !desktop ? disabledActionStyle(colors, variant) : secondary ? secondaryActionStyle(colors) : primaryActionStyle(colors, live);
  const hoverStyle = !desktop ? NO_HOVER : secondary ? secondaryActionHoverStyle(colors) : primaryActionHoverStyle;
  return (
    <div style={secondary ? secondaryWrapStyle : primaryWrapStyle}>
      <Button
        onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Terminal' })}
        aria-disabled={desktop ? undefined : true}
        aria-describedby={desktop ? undefined : reasonId}
        style={style}
        hoverStyle={hoverStyle}
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

const primaryWrapStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 14 };
// Secondary sits inside an EmptyState that already spaces it; it keeps its own width.
const secondaryWrapStyle: CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 };

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
// DESIGN.md Buttons > Secondary: inset surface, Reactor Cyan label, Active
// Edge border; hover takes a solid cyan edge and the outer + inner glow.
function secondaryActionStyle(colors: ColorPalette): CSSProperties {
  return {
    cursor: 'pointer',
    font: `600 11px/1 ${fonts.ui}`,
    letterSpacing: 2,
    color: colors.accentCyan,
    background: colors.panelInset,
    border: `1px solid ${colors.activeBorder}`,
    borderRadius: radii.tile,
    padding: '7px 12px',
  };
}
function secondaryActionHoverStyle(colors: ColorPalette): CSSProperties {
  return { border: `1px solid ${colors.accentCyan}`, boxShadow: `${glows.active}, ${glows.innerCharge}` };
}
// DESIGN.md button-primary-disabled: inset background, Text Dim label, no glow.
// The secondary shape keeps its own padding and radius so it does not jump.
function disabledActionStyle(colors: ColorPalette, variant: OpenTerminalVariant): CSSProperties {
  const base: CSSProperties = {
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
  return variant === 'secondary' ? { ...base, letterSpacing: 2, padding: '7px 12px', borderRadius: radii.tile } : base;
}
// An empty hover style: a disabled control doesn't light up under the pointer.
// (Button's default hover would otherwise brighten it.) Keyboard focus still
// gets the ring.
const NO_HOVER: CSSProperties = {};
function reasonStyle(colors: ColorPalette): CSSProperties {
  return { margin: 0, font: `400 12px/1.5 ${fonts.ui}`, color: colors.textMuted };
}
```

- [ ] **Step 6: Implement `EmptyState.actionSlot`.** In `src/components/shared/EmptyState.tsx`, replace lines 1-31 (the imports through the end of the `EmptyState` function) with:

```tsx
import type { CSSProperties, ReactNode } from 'react';
import { fonts, glows, radii, type ColorPalette } from '../../styles/tokens';
import { useColors } from './useColors';
import { Button } from './Button';

interface EmptyStateAction {
  label: string;
  onClick: () => void;
}

// At most one action: a label + handler rendered as the Secondary button, or a
// ready-made control in `actionSlot` (the Agents roster's OpenTerminalButton,
// which carries its own desktop-app check).
type EmptyStateProps =
  | { message: string; action?: EmptyStateAction; actionSlot?: never }
  | { message: string; action?: never; actionSlot: ReactNode };

// The one empty-state voice across views: a single plain sentence saying what
// will appear and where it comes from, plus at most one next action. Flat at
// rest (Glow-Is-State): only the action lights, and only on hover or keyboard
// focus.
export function EmptyState({ message, action, actionSlot }: EmptyStateProps) {
  const colors = useColors();
  const hasAction = action !== undefined || actionSlot !== undefined;
  return (
    <div data-empty-state="true" style={hasAction ? rootWithActionStyle : rootStyle}>
      <p style={messageStyle(colors)}>{message}</p>
      {action && (
        <Button onClick={action.onClick} style={actionStyle(colors)} hoverStyle={actionHoverStyle(colors)}>
          {action.label}
        </Button>
      )}
      {actionSlot}
    </div>
  );
}
```

- [ ] **Step 7: Route the Agents empty state through it.** In `src/components/agents/AgentRosterCard.tsx`, add after the `import { Button } from '../shared/Button';` line:

```tsx
import { OpenTerminalButton } from '../dashboard/OpenTerminalButton';
```

and replace line 65 with:

```tsx
        {!state.realAgents.length && <EmptyState message="No agents are running." actionSlot={<OpenTerminalButton variant="secondary" />} />}
```

(`dispatch` stays in use at line 49, so `noUnusedLocals` is satisfied.)

- [ ] **Step 8: Run the tests and verify they pass**

Run: `npx vitest run src/components/dashboard/openTerminalLiteral.test.ts src/components/dashboard/OpenTerminalButton.test.tsx src/components/shared/EmptyState.test.tsx src/components/agents/AgentRosterCard.narration.test.tsx src/components/dashboard/ReadinessCard.test.tsx src/components/dashboard/DashboardView.test.tsx`
Expected: PASS, 0 failed.

- [ ] **Step 9: Typecheck and build**

Run: `npm run build`
Expected: exit 0.
Run: `npm run typecheck:electron`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add -- src/components/dashboard/OpenTerminalButton.tsx src/components/dashboard/OpenTerminalButton.test.tsx src/components/dashboard/openTerminalLiteral.test.ts src/components/shared/EmptyState.tsx src/components/shared/EmptyState.test.tsx src/components/agents/AgentRosterCard.tsx src/components/agents/AgentRosterCard.narration.test.tsx
git commit -m "feat(open-terminal): secondary variant; every OPEN TERMINAL renders through OpenTerminalButton" -- src/components/dashboard/OpenTerminalButton.tsx src/components/dashboard/OpenTerminalButton.test.tsx src/components/dashboard/openTerminalLiteral.test.ts src/components/shared/EmptyState.tsx src/components/shared/EmptyState.test.tsx src/components/agents/AgentRosterCard.tsx src/components/agents/AgentRosterCard.narration.test.tsx
```

---

### Task 4: Alerts dropdown focus, Escape and outside-click; strip toggle and count colours

**Files:**
- Create: `src/components/layout/useDropdownFocus.ts`
- Modify: `src/components/layout/TopBar.tsx:1` (react import), `:15` (new import), `:44` (after `const notifPanelId = useId();`), `:155` (notifications wrapper div), `:172-173` (notifications panel div)
- Test: `src/components/layout/TopBar.test.tsx` (append a describe)
- Modify: `src/components/dashboard/StandbyStrip.tsx` (whole file)
- Test: `src/components/dashboard/StandbyStrip.test.tsx` (imports, last test, new tests)

**Interfaces:**
- Consumes: reducer `TOGGLE_NOTIFS` (unchanged: toggles `notifOpen`, closes approvals, zeroes `unread`).
- Produces:
  - `export const NOTIF_TRIGGER_ATTR = 'data-notif-trigger'` (in `useDropdownFocus.ts`). Any element carrying it, and anything inside it, counts as a trigger, not as "outside".
  - `export interface DropdownFocusOptions { open: boolean; panelRef: RefObject<HTMLElement>; triggerAttr: string; fallbackTrigger: () => HTMLElement | null; close: () => void }`
  - `export function useDropdownFocus(options: DropdownFocusOptions): void`
  - DOM: the notifications panel has `tabIndex={-1}`. The bell's wrapper `div` and a `display: contents` span around the strip's Alerts button both carry `data-notif-trigger=""`. The strip's Alerts button carries `aria-expanded`. Strip counts carry `data-testid="strip-count-{key}"`.

- [ ] **Step 1: Write the failing TopBar tests.** In `src/components/layout/TopBar.test.tsx`, add `import { NOTIF_TRIGGER_ATTR } from './useDropdownFocus';` after the existing imports and append:

```tsx
describe('TopBar notifications focus', () => {
  const bell = () => screen.getByRole('button', { name: /^Notifications/ });
  const appr = () => screen.getByRole('button', { name: /pending approval/ });
  const panel = () => document.getElementById(bell().getAttribute('aria-controls')!)!;
  function openFromBell() {
    bell().focus();
    fireEvent.click(bell());
  }

  it('marks the bell as a notifications trigger', () => {
    renderTopBar();
    expect(bell().closest(`[${NOTIF_TRIGGER_ATTR}]`)).not.toBeNull();
  });

  it('moves focus into the panel on open, and back to the bell on Escape', () => {
    renderTopBar();
    openFromBell();
    expect(panel().getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(panel());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(bell());
  });

  it('closes on a pointer-down outside the panel and its trigger, not on one inside the panel', () => {
    renderTopBar();
    openFromBell();
    fireEvent.pointerDown(panel());
    expect(bell().getAttribute('aria-expanded')).toBe('true');
    fireEvent.pointerDown(document.body);
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(bell());
  });

  it('closes, not close-then-reopens, when the bell is pressed while open', () => {
    renderTopBar();
    openFromBell();
    fireEvent.pointerDown(bell());
    fireEvent.click(bell());
    expect(bell().getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps approvals and notifications exclusive under real pointer input', () => {
    renderTopBar();
    openFromBell();
    fireEvent.pointerDown(appr());
    appr().focus();
    fireEvent.click(appr());
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    expect(appr().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(appr());
  });

  it('does not pull focus off the approvals button when opening approvals closes notifications', () => {
    renderTopBar();
    openFromBell();
    appr().focus(); // keyboard: Tab to approvals, then Enter
    fireEvent.click(appr());
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(appr());
  });
});
```

- [ ] **Step 2: Write the failing StandbyStrip tests.** In `src/components/dashboard/StandbyStrip.test.tsx`:

(a) Replace the import lines with:

```tsx
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import type { Action } from '../../state/reducer';
import type { MemoryRow } from '../../state/types';
import type { ProjectsSnapshot } from '../../shared/projectsSnapshot';
import { colors } from '../../styles/tokens';
import { TopBar } from '../layout/TopBar';
import { NOTIF_TRIGGER_ATTR } from '../layout/useDropdownFocus';
import { StandbyStrip } from './StandbyStrip';
```

(b) Replace the last four lines of `it('navigates each item to its view, and Alerts opens the alerts dropdown', ...)` (from `fireEvent.click(screen.getByRole('button', { name: 'Alerts 0' }));` to the end of that test) with:

```tsx
    const alerts = screen.getByRole('button', { name: 'Alerts 0' });
    expect(alerts.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(alerts);
    expect(probe().dataset.notifOpen).toBe('true');
    expect(alerts.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(alerts);
    expect(probe().dataset.notifOpen).toBe('false'); // a second click closes it
    expect(alerts.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: 'Agents 0' }).getAttribute('aria-expanded')).toBeNull();
```

(c) Append, after the existing `describe('StandbyStrip', ...)` block:

```tsx
// jsdom normalizes colours (hex -> rgb), so compare through the same parser.
function cssColor(value: string): string {
  const el = document.createElement('span');
  el.style.color = value;
  return el.style.color;
}

describe('StandbyStrip counts', () => {
  it('draws 0 in Text Muted and a count above 0 in Soft Signal, memory included', () => {
    renderStrip([{ type: 'SET_MEMORIES', memories: [{ id: 1 } as MemoryRow, { id: 2 } as MemoryRow] }]);
    expect(screen.getByTestId('strip-count-agents').style.color).toBe(cssColor(colors.textMuted));
    expect(screen.getByTestId('strip-count-alerts').style.color).toBe(cssColor(colors.textMuted));
    expect(screen.getByTestId('strip-count-memory').style.color).toBe(cssColor(colors.accentCyanSoft));
  });

  it('draws a 0 memory count in Text Muted too', () => {
    renderStrip();
    expect(screen.getByTestId('strip-count-memory').style.color).toBe(cssColor(colors.textMuted));
  });
});

let dispatchRef: ReturnType<typeof useAetherStore>['dispatch'] | null = null;
function DispatchProbe() {
  dispatchRef = useAetherStore().dispatch;
  return null;
}
function renderWithTopBar() {
  return render(
    <AetherStoreProvider>
      <DispatchOnMount actions={[{ type: 'SET_ACTIVE_TAB', tab: 'Dashboard' }]}>
        <DispatchProbe />
        <TopBar />
        <StandbyStrip />
      </DispatchOnMount>
    </AetherStoreProvider>,
  );
}

describe('StandbyStrip Alerts and the notifications dropdown', () => {
  const bell = () => screen.getByRole('button', { name: /^Notifications/ });
  const stripAlerts = () => screen.getByRole('button', { name: 'Alerts 0' });
  const panel = () => document.getElementById(bell().getAttribute('aria-controls')!)!;

  it('marks the strip Alerts item as a notifications trigger', () => {
    renderWithTopBar();
    const marker = stripAlerts().closest<HTMLElement>(`[${NOTIF_TRIGGER_ATTR}]`)!;
    expect(marker).not.toBeNull();
    expect(marker.style.display).toBe('contents');
  });

  it('moves focus into the panel when opened from the strip, and back to the strip item on Escape', () => {
    renderWithTopBar();
    stripAlerts().focus();
    fireEvent.click(stripAlerts());
    expect(document.activeElement).toBe(panel());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(stripAlerts());
  });

  it('closes from the strip when the bell opened it (no close-then-reopen)', () => {
    renderWithTopBar();
    bell().focus();
    fireEvent.click(bell());
    fireEvent.pointerDown(stripAlerts());
    fireEvent.click(stripAlerts());
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    expect(stripAlerts().getAttribute('aria-expanded')).toBe('false');
  });

  it('falls back to the bell when the opening strip item has gone', () => {
    renderWithTopBar();
    stripAlerts().focus();
    fireEvent.click(stripAlerts());
    act(() => dispatchRef!({ type: 'SET_OP_MODE', mode: 'EDITS' })); // pushes a notif: the Alerts item leaves the strip
    expect(screen.queryByRole('button', { name: 'Alerts 0' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(bell());
  });
});
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `npx vitest run src/components/layout/TopBar.test.tsx src/components/dashboard/StandbyStrip.test.tsx`
Expected: FAIL at import resolution: `Failed to resolve import "./useDropdownFocus"` (and `../layout/useDropdownFocus`). Once the hook file exists, the focus assertions fail (`expected <body> to be <div id=...>`), the strip's second click leaves `notifOpen` `'true'`, and the count colours fail.

- [ ] **Step 4: Create the hook.** Create `src/components/layout/useDropdownFocus.ts`:

```ts
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Marks a notifications trigger. Button takes no data props, so this goes on a
 * wrapper: the bell's wrapper div in TopBar, a `display: contents` span around
 * the STANDBY STRIP's Alerts button. A pointer-down inside any marked element
 * is not "outside": otherwise pointer-down would close the panel and the
 * trigger's click would reopen it.
 */
export const NOTIF_TRIGGER_ATTR = 'data-notif-trigger';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DropdownFocusOptions {
  open: boolean;
  panelRef: RefObject<HTMLElement>;
  triggerAttr: string;
  /** Where focus returns when the trigger that opened the panel has unmounted. */
  fallbackTrigger: () => HTMLElement | null;
  close: () => void;
}

/**
 * Focus management for a disclosure panel with more than one trigger.
 * - Open: remember the focused trigger, then focus the panel's first focusable
 *   element, else the panel itself (give it tabIndex={-1}).
 * - Close: return focus to that trigger (or fallbackTrigger() if it has gone),
 *   but only when focus would otherwise be lost (on <body> or detached, as
 *   when the panel that held it unmounts). If the user activated another
 *   control -- e.g. the approvals button, whose TOGGLE_APPROVALS closes this
 *   panel -- focus stays there.
 * - While open: Escape closes; a pointer-down outside the panel and outside
 *   every triggerAttr element closes.
 */
export function useDropdownFocus({ open, panelRef, triggerAttr, fallbackTrigger, close }: DropdownFocusOptions): void {
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  // Layout effect: runs after the panel mounts or unmounts but before paint.
  useLayoutEffect(() => {
    if (open === wasOpenRef.current) return;
    wasOpenRef.current = open;
    if (open) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      const panel = panelRef.current;
      if (panel) (panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel).focus();
      return;
    }
    const opener = openerRef.current;
    openerRef.current = null;
    const active = document.activeElement;
    const focusLost = active === null || active === document.body || !active.isConnected;
    if (!focusLost) return;
    const target = opener !== null && opener.isConnected ? opener : fallbackTrigger();
    target?.focus();
  }, [open, panelRef, fallbackTrigger]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
    }
    function onPointerDown(e: Event) {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(`[${triggerAttr}]`)) return;
      close();
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, panelRef, triggerAttr, close]);
}
```

- [ ] **Step 5: Wire it into `TopBar.tsx`.**

Line 1 becomes:

```tsx
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
```

After `import { OP_MODES, opModeOnSkin } from '../shared/opModes';` (line 15) add:

```tsx
import { NOTIF_TRIGGER_ATTR, useDropdownFocus } from './useDropdownFocus';
```

Directly after `const notifPanelId = useId();` (line 44) add:

```tsx
  // Notifications: focus in on open, back to the opener on close, Escape and
  // outside pointer-down close it. The STANDBY STRIP's Alerts item is the
  // second trigger (StandbyStrip.tsx); both carry NOTIF_TRIGGER_ATTR.
  const notifWrapRef = useRef<HTMLDivElement>(null);
  const notifPanelRef = useRef<HTMLDivElement>(null);
  const closeNotifs = useCallback(() => dispatch({ type: 'TOGGLE_NOTIFS' }), [dispatch]);
  const notifBell = useCallback(() => notifWrapRef.current?.querySelector<HTMLElement>('button') ?? null, []);
  useDropdownFocus({ open: state.notifOpen, panelRef: notifPanelRef, triggerAttr: NOTIF_TRIGGER_ATTR, fallbackTrigger: notifBell, close: closeNotifs });
```

Replace the notifications wrapper opening tag (line 155, the second `<div style={{ position: 'relative', flex: 'none', marginRight: 10 }}>`, the one holding `title="Notifications"`) with:

```tsx
      <div ref={notifWrapRef} data-notif-trigger="" style={{ position: 'relative', flex: 'none', marginRight: 10 }}>
```

Replace `<div id={notifPanelId} style={notifPanelStyle(colors)}>` (line 173) with:

```tsx
          <div id={notifPanelId} ref={notifPanelRef} tabIndex={-1} style={notifPanelStyle(colors)}>
```

- [ ] **Step 6: Rewrite `StandbyStrip.tsx`.** Replace the file with:

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
 * doesn't draw empty panels. Each count links to where that data will live;
 * Alerts toggles the top bar's notifications dropdown (a second trigger for
 * it: TopBar's useDropdownFocus moves focus in and back, and treats this item
 * as inside, via the data-notif-trigger wrapper). Hidden once every digest
 * has its own panel.
 */
export function StandbyStrip() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const headingId = useId();
  const items = computeStripItems(computeDigestPresence(state), state.memories.length);
  if (items.length === 0) return null;

  function go(key: StripItemKey) {
    if (key === 'alerts') {
      dispatch({ type: 'TOGGLE_NOTIFS' });
      return;
    }
    dispatch({ type: 'SET_ACTIVE_TAB', tab: TAB_BY_KEY[key] });
  }

  return (
    <section aria-labelledby={headingId} style={stripStyle(colors)}>
      <h2 id={headingId} style={srOnlyStyle}>
        Standby
      </h2>
      {items.map((it, i) => {
        const button = (
          <Button onClick={() => go(it.key)} style={itemStyle} aria-expanded={it.key === 'alerts' ? state.notifOpen : undefined}>
            <span style={labelStyle(colors)}>{it.label}</span>{' '}
            <span data-testid={`strip-count-${it.key}`} style={countStyle(colors, it.count)}>
              {it.count}
            </span>
            {it.unit !== null && (
              <>
                {' '}
                <span style={labelStyle(colors)}>{it.unit}</span>
              </>
            )}
          </Button>
        );
        return (
          <Fragment key={it.key}>
            {i > 0 && (
              <span aria-hidden="true" style={sepStyle(colors)}>
                ·
              </span>
            )}
            {it.key === 'alerts' ? (
              <span data-notif-trigger="" style={triggerWrapStyle}>
                {button}
              </span>
            ) : (
              button
            )}
          </Fragment>
        );
      })}
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
// display: contents keeps the marker out of the flex layout: the button stays a direct flex item.
const triggerWrapStyle: CSSProperties = { display: 'contents' };
const itemStyle: CSSProperties = { cursor: 'pointer', padding: '4px 6px', borderRadius: radii.chip };
function labelStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 1, color: colors.textSecondary };
}
// Numbers Are Mono. A zero is a resting fact in Text Muted; Soft Signal only
// for a count above 0, so an idle strip does not read as cyan activity.
function countStyle(colors: ColorPalette, count: number): CSSProperties {
  return { font: `700 12px/1 ${fonts.mono}`, color: count > 0 ? colors.accentCyanSoft : colors.textMuted };
}
function sepStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 12px/1 ${fonts.mono}`, color: colors.textDim };
}
```

(The original rendered `{it.label}</span> <span` with a literal space. `{' '}` keeps the accessible names `Agents 0` / `Memory 2 engrams` identical.)

- [ ] **Step 7: Run the tests and verify they pass**

Run: `npx vitest run src/components/layout/TopBar.test.tsx src/components/dashboard/StandbyStrip.test.tsx src/components/dashboard/DashboardView.test.tsx src/state/reducer.test.ts`
Expected: PASS, 0 failed. The existing `are mutually exclusive` and `aria-expanded ... aria-controls` TopBar tests still pass unchanged.

- [ ] **Step 8: Typecheck and build**

Run: `npm run build`
Expected: exit 0.
Run: `npm run typecheck:electron`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add -- src/components/layout/useDropdownFocus.ts src/components/layout/TopBar.tsx src/components/layout/TopBar.test.tsx src/components/dashboard/StandbyStrip.tsx src/components/dashboard/StandbyStrip.test.tsx
git commit -m "feat(alerts): dropdown takes and returns focus, Escape/outside close; strip Alerts toggles; muted zero counts" -- src/components/layout/useDropdownFocus.ts src/components/layout/TopBar.tsx src/components/layout/TopBar.test.tsx src/components/dashboard/StandbyStrip.tsx src/components/dashboard/StandbyStrip.test.tsx
```

---

### Task 5: SESSION INFO reads `—` at STANDBY

**Files:**
- Modify: `src/components/dashboard/dashboardMath.ts:220-230` (`computeSessionInfoRows`)
- Test: `src/components/dashboard/dashboardMath.test.ts:320-329` (the `computeSessionInfoRows` describe)
- Modify: `src/components/layout/BottomMetricsRow.tsx:7` (import) and `:54` (call)
- Test: `src/components/layout/BottomMetricsRow.test.tsx`

**Interfaces:**
- Consumes: `isSessionLive(state: AetherState, nowMs: number): boolean` and `NO_DATA` (`'—'`), both already in `dashboardMath.ts`.
- Produces: `computeSessionInfoRows(state: Pick<AetherState, 'sessionStartedAt' | 'commandsRun' | 'realAgents'>, now: Date, live: boolean): SessionInfoRow[]`. When `!live`, `Session start` and `Uptime` are `NO_DATA`. `Commands run` and `Agents active` are unchanged (a real 0 stays 0). The only other caller is `BottomMetricsRow.tsx:54` (grep-verified).

- [ ] **Step 1: Write the failing tests.** In `src/components/dashboard/dashboardMath.test.ts`, replace the whole `describe('computeSessionInfoRows', ...)` block (lines 320-329) with:

```ts
describe('computeSessionInfoRows', () => {
  it('has no month-scoped "Tokens used" row', () => {
    const rows = computeSessionInfoRows(
      { ...initialState, realUsage: { ...SCANNED, usedThisMonth: 11_534_188 } } as AetherState,
      new Date(NOW),
      true,
    );
    expect(rows.map((r) => r.k)).toEqual(['Session start', 'Uptime', 'Commands run', 'Agents active']);
    expect(rows.some((r) => r.v === '11,534,188')).toBe(false);
  });

  const started = { ...initialState, sessionStartedAt: new Date(NOW - 3_600_000).toISOString() };
  const value = (rows: ReturnType<typeof computeSessionInfoRows>, k: string) => rows.find((r) => r.k === k)!.v;

  it('shows the no-data mark for Session start and Uptime at STANDBY, and real values while live', () => {
    const idle = computeSessionInfoRows(started, new Date(NOW), false);
    expect(value(idle, 'Session start')).toBe(NO_DATA);
    expect(value(idle, 'Uptime')).toBe(NO_DATA);
    expect(value(idle, 'Commands run')).toBe('0');
    const live = computeSessionInfoRows(started, new Date(NOW), true);
    expect(value(live, 'Session start')).not.toBe(NO_DATA);
    expect(value(live, 'Uptime')).not.toBe(NO_DATA);
  });

  it('does not tick at STANDBY: a minute later the rows are identical', () => {
    expect(computeSessionInfoRows(started, new Date(NOW + 60_000), false)).toEqual(computeSessionInfoRows(started, new Date(NOW), false));
  });
});
```

In `src/components/layout/BottomMetricsRow.test.tsx`, replace line 4 (`import { AetherStoreProvider } from '../../state/store';`) with:

```tsx
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import type { StatuslineSnapshot } from '../../shared/statuslinePayload';
```

Then append inside `describe('BottomMetricsRow', ...)`:

```tsx
  it('reads — for Session start and Uptime at STANDBY, and real values once a session is live', () => {
    const value = (k: string) => screen.getByText(k).nextElementSibling!.textContent;
    const { unmount } = renderRow();
    expect(value('Session start')).toBe(NO_DATA);
    expect(value('Uptime')).toBe(NO_DATA);
    unmount();

    // A fresh statusline capture is one of isSessionLive's signals.
    const fresh: StatuslineSnapshot = {
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
    };
    function GoLive() {
      const { dispatch } = useAetherStore();
      useEffect(() => {
        dispatch({ type: 'SET_STATUSLINE', snapshot: fresh });
      }, [dispatch]);
      return null;
    }
    render(
      <AetherStoreProvider>
        <GoLive />
        <BottomMetricsRow />
      </AetherStoreProvider>,
    );
    expect(value('Session start')).not.toBe(NO_DATA);
    expect(value('Uptime')).not.toBe(NO_DATA);
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/components/dashboard/dashboardMath.test.ts src/components/layout/BottomMetricsRow.test.tsx`
Expected: FAIL: `expected '2:30 PM' to be '—'` (or similar local-time text) for Session start, and `expected '1h 00m' to be '—'` for Uptime.

- [ ] **Step 3: Implement.** In `src/components/dashboard/dashboardMath.ts`, replace lines 220-230 with:

```ts
/**
 * SESSION INFO. At STANDBY (`live` false, i.e. !isSessionLive) there is no
 * session to date, so Session start and Uptime read NO_DATA and do not tick.
 */
export function computeSessionInfoRows(
  state: Pick<AetherState, 'sessionStartedAt' | 'commandsRun' | 'realAgents'>,
  now: Date,
  live: boolean,
): SessionInfoRow[] {
  return [
    { k: 'Session start', v: live ? new Date(state.sessionStartedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : NO_DATA },
    { k: 'Uptime', v: live ? formatUptime(state.sessionStartedAt, now) : NO_DATA },
    { k: 'Commands run', v: fmt(state.commandsRun) },
    { k: 'Agents active', v: String(state.realAgents.length) },
  ];
}
```

In `src/components/layout/BottomMetricsRow.tsx`, line 7 becomes:

```tsx
import { NO_DATA, computeContextReading, computeSessionInfoRows, computeUsageBar, computeUsageRangeTotal, isSessionLive, sessionCommandHistory } from '../dashboard/dashboardMath';
```

and line 54 becomes:

```tsx
  const session = computeSessionInfoRows(state, now, isSessionLive(state, now.getTime()));
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/components/dashboard/dashboardMath.test.ts src/components/layout/BottomMetricsRow.test.tsx`
Expected: PASS, 0 failed.

- [ ] **Step 5: Typecheck and build**

Run: `npm run build`
Expected: exit 0.
Run: `npm run typecheck:electron`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -- src/components/dashboard/dashboardMath.ts src/components/dashboard/dashboardMath.test.ts src/components/layout/BottomMetricsRow.tsx src/components/layout/BottomMetricsRow.test.tsx
git commit -m "fix(session-info): Session start and Uptime read the no-data mark at STANDBY" -- src/components/dashboard/dashboardMath.ts src/components/dashboard/dashboardMath.test.ts src/components/layout/BottomMetricsRow.tsx src/components/layout/BottomMetricsRow.test.tsx
```

---

### Task 6: DESIGN.md records what shipped

**Files:**
- Modify: `DESIGN.md:257` (Empty States paragraph), `:261-263` (Readiness and Standby Strip bullets), Known Gaps list (append after the last bullet, `- **Existing profiles keep their saved renderer.** ...`)

**Interfaces:**
- Consumes: everything shipped in Tasks 1-5. Describe what the code does, and check it with Step 2.
- Produces: documentation only.

- [ ] **Step 1: Edit `DESIGN.md`.**

(a) Empty States paragraph (line 257): append this sentence at its end:

```markdown
The Agents view's `No agents are running.` state takes its OPEN TERMINAL from `OpenTerminalButton` (`variant="secondary"`, through `EmptyState`'s `actionSlot`), so the desktop-app check is the same everywhere.
```

(b) Replace the **READINESS** bullet (line 261) with:

```markdown
- **READINESS** (`ReadinessCard.tsx`): an `h2` and a list of four rows, each a status dot and one plain sentence: Desktop app, Terminal, Statusline, Collector (copy in `readinessMath.ts`). A met row says when it was last true, as an absolute local `HH:MM` (prefixed with the short date, `Sep 28 14:02`, when not today; never a relative time). An unmet row adds one hint line under its sentence, indented clear of the dot, in Rajdhani 11px Text Muted, with commands (`npm run electron:dev`, `npm start`) in Space Mono; a met row has no hint. The Collector row reports the newest event the collector recorded (ready within 10 minutes), never that it is "running": the app does not start or watch the collector process. A met row's dot is filled Nominal Green; only the live signals (Terminal, Statusline) glow, and only while a session is live, so a met row at STANDBY is flat green. Desktop app and Collector are static facts and never glow. An unmet row is a hollow Text Muted ring. **No amber:** none of these asks the operator for anything. The card fills the right column beside the reactor; the rows keep their rhythm at the top and OPEN TERMINAL is pinned to the card's bottom edge, level with the reactor's base.
```

(c) In the **OPEN TERMINAL** bullet (line 262), append:

```markdown
 Two variants: `primary` (this one) and `secondary` (the Secondary button treatment, used by the Agents view's empty state). Every OPEN TERMINAL renders through `OpenTerminalButton`; `openTerminalLiteral.test.ts` fails if any other file carries the label.
```

(d) In the **STANDBY STRIP** bullet (line 263), replace `counts are Space Mono Soft Signal.` with `counts are Space Mono, Text Muted at 0 and Soft Signal only above 0.`, and replace `(the alerts item opens the notifications dropdown)` with `(the alerts item toggles the notifications dropdown and carries \`aria-expanded\`)`. Then append:

```markdown
 The notifications dropdown, opened from the strip or the top-bar bell, takes focus on open (its first focusable element, else the panel), closes on Escape or on a pointer-down outside the panel and both triggers, and returns focus to the trigger that opened it (the bell, if that trigger has gone). It never pulls focus back from a control the user just activated.
```

(e) Known Gaps: append after the last bullet:

```markdown
- **Footer uptime ticks at STANDBY.** SESSION INFO shows `—` for Session start and Uptime until a session is live, but the Footer's `Uptime` (`Footer.tsx`) still counts from app launch, so the two disagree at STANDBY.
```

- [ ] **Step 2: Verify the doc against the code**

Run: `grep -n "counts are Space Mono Soft Signal\|Collector: running" DESIGN.md`
Expected: no output.
Run: `grep -rn "Collector: running" src --include=*.ts --include=*.tsx`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add -- DESIGN.md
git commit -m "docs(design): READINESS hints and times, shared OPEN TERMINAL, dropdown focus, Known Gap" -- DESIGN.md
```

---

### Task 7: Final verification

**Files:** none modified.

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: 0 failed. `Test Files 199 passed | 1 skipped (200)`: the 198 baseline files plus the one new test file, `openTerminalLiteral.test.ts`. `Tests` = 2177 plus this plan's net additions, with `14 skipped` on work-it (10 at home) unchanged. The net additions are about +44 (so about 2221 passed): +4 reducer, +13 readinessMath (20 tests replacing 7), +5 ReadinessCard (13 replacing 8), +3 OpenTerminalButton, +2 literal guard, +1 EmptyState, +1 AgentRoster, +6 TopBar, +6 StandbyStrip, +2 dashboardMath, +1 BottomMetricsRow. Record the real numbers. If `launchConfig.test.ts` fails, re-run it alone first (known ConPTY flake).

- [ ] **Step 2: Renderer build + typecheck**

Run: `npm run build`
Expected: exit 0; `tsc -b` clean; `✓ built in`.

- [ ] **Step 3: Electron typecheck**

Run: `npm run typecheck:electron`
Expected: exit 0.

- [ ] **Step 4: Invariant greps** (`<base>` = the commit that added this plan)

- `grep -rn "aria-live" src/components/dashboard --include=*.tsx | grep -v "\.test\."` should print nothing (the Footer stays the one announcement).
- `grep -n "warn" src/components/dashboard/ReadinessCard.tsx src/components/dashboard/StandbyStrip.tsx` should print nothing (no amber).
- `git diff <base> --stat -- src/components/reactor` should print nothing (Living Core Rule).
- `grep -rn "DESKTOP_APP_REASON" src --include=*.ts --include=*.tsx | grep -v "\.test\."` should print only `readinessMath.ts` (the definition) and `OpenTerminalButton.tsx`.
- `grep -rn "Collector: running" src` should print nothing.

- [ ] **Step 5: Report** each check as Passed or Failed, with the real output lines (test counts, build result).

---

### Task 8: `/impeccable critique` re-run against the #92 snapshot

**Files:**
- Create: `.impeccable/critique/<timestamp>__src-components-dashboard-dashboardview-tsx.md` (the skill writes it)

- [ ] **Step 1: Run the critique.** In a session on the merged branch, invoke `/impeccable critique` on `src/components/dashboard/DashboardView.tsx`.

- [ ] **Step 2: Compare** the new snapshot's `total_score` and heuristic table against `.impeccable/critique/2026-09-29T07-50-27Z__src-components-dashboard-dashboardview-tsx.md` (22/40). Report: old and new total; each heuristic whose score moved; whether the critique still flags any of this spec's five items (READINESS column fill/teaching, alerts focus, doubled reason, standby contradictions, OPEN TERMINAL consistency). The spec's Out-of-scope list is expected to reappear (region semantics, 17px KPI, radius/padding drift, literal rgba, Projects copy, orphan sidebar label, DispatchTimeline panel); list those as carried, not regressions.

- [ ] **Step 3: Commit the snapshot**

```bash
git add -- .impeccable/critique/<new-file>.md
git commit -m "chore(critique): DashboardView after readiness pass" -- .impeccable/critique/<new-file>.md
```

---

### Task 9: Live `electron:dev` check

**Files:** none modified.

- [ ] **Step 1: Confirm the Electron binary exists.** `npm ci` printed allow-scripts warnings, and `package.json`'s `allowScripts` lists only `node-pty` and `esbuild`. The root `postinstall` (`install-electron && node scripts/grant-appcontainer-acl.js`) is what fetches the binary and grants the ACE, so check its results rather than assuming it ran:

Run: `ls node_modules/electron/dist/electron.exe && cat node_modules/electron/path.txt`
Expected: the path prints, and `path.txt` reads `electron.exe`. (Verified on work-it at `4441403`.)

- [ ] **Step 2: Confirm the AppContainer ACE.**

Run (PowerShell): `icacls node_modules\electron\dist | Select-String 'ALL APPLICATION PACKAGES'`
Expected: `APPLICATION PACKAGE AUTHORITY\ALL APPLICATION PACKAGES:(OI)(CI)(RX)`. (Verified on work-it at `4441403`.)
If either check fails, re-run the postinstall halves: `npx install-electron`, then `node scripts/grant-appcontainer-acl.js`, then re-check. Without the ACE the GPU process dies at launch with `exit_code=-1073741515` (see the script header).

- [ ] **Step 3: STANDBY check.** Run `npm run electron:dev`. On the Dashboard with no terminal open, confirm:
  - The READINESS card's top and bottom edges line up with the REACTOR STATUS card beside it.
  - OPEN TERMINAL sits level with the reactor card's base.
  - The rows are tight at the top, with the gap between the last row and the button.
  - Terminal reads `Terminal: no session yet.` with the hint `Use OPEN TERMINAL below.`.
  - The Collector row shows one of the three honest sentences, never "running".
  - SESSION INFO shows `—` for Session start and Uptime.
  - The strip's `0` counts are muted.

- [ ] **Step 4: Alerts check.** Tab to the strip's Alerts item and press Enter: focus moves into the dropdown, and Escape returns it to the strip item. Open from the bell: a click outside closes it and focus returns to the bell. Click Alerts while open: it closes, with no flicker. With notifications open, click the approvals button: approvals opens and notifications closes.

- [ ] **Step 5: Terminal open.** Press OPEN TERMINAL. Back on the Dashboard, Terminal reads `Terminal: open since HH:MM.`. Leave and return to the Terminal tab, then back: the time has not changed. With an agent running (a digest present), note how READINESS shares the column with the digest panel. `flex: 1` splits the column equally with each present `DigestSlot` (`flex: 1 1 0`); report what you see, do not change it.

- [ ] **Step 6: Report** each check as Passed, Failed, or Incomplete (with what blocked it: e.g. no GUI in this session, in which case hand Steps 3-5 to `electron-ui-verifier`), with screenshots where possible.
