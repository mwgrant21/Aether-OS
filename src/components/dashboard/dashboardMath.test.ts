import { describe, expect, it } from 'vitest';
import {
  NO_DATA,
  computeContextReading,
  computeDashKpis,
  computeDashPulseMode,
  computeDashStatus,
  computeRateLine,
  computeRateReadout,
  computeSessionInfoRows,
  computeSidebarReactorRate,
  computeSidebarReactorStatus,
  computeTodayCost,
  computeUsageBar,
  computeUsageRangeTotal,
  isSessionLive,
  sessionCommandHistory,
  statusDotGlows,
  type DashKpi,
} from './dashboardMath';
import { computeTopCommands } from '../analytics/analyticsMath';
import { reducer } from '../../state/reducer';
import { initialState } from '../../state/initialState';
import { STATUSLINE_STALE_AFTER_MS } from '../../shared/depletion';
import { deriveContextWindowCard } from '../layout/contextWindowCard';
import type { StatuslineSnapshot } from '../../shared/statuslinePayload';
import type { AetherState } from '../../state/types';
import { buildLedgerSnapshot, type LedgerSnapshot } from '../../shared/ledgerMath';

const NOW = 1_800_000_000_000;
const SCANNED = { ...initialState.realUsage, lastScanAt: '2026-09-28T12:00:00.000Z' };

describe('computeDashStatus', () => {
  it('maps each alarm level to its Dashboard-specific label when live', () => {
    expect(computeDashStatus('ok', true)).toBe('NOMINAL');
    expect(computeDashStatus('warn', true)).toBe('ELEVATED');
    expect(computeDashStatus('crit', true)).toBe('BURN ALARM');
  });
  it('reads STANDBY instead of NOMINAL when no session is live', () => {
    expect(computeDashStatus('ok', false)).toBe('STANDBY');
  });
  it('still surfaces an alarm when no session is live', () => {
    expect(computeDashStatus('warn', false)).toBe('ELEVATED');
    expect(computeDashStatus('crit', false)).toBe('BURN ALARM');
  });
});

describe('isSessionLive', () => {
  it('is false for a fresh state (browser mode has no live feeds)', () => {
    expect(isSessionLive(initialState, NOW)).toBe(false);
  });
  it('is not made live by an open terminal pty alone', () => {
    expect(isSessionLive({ ...initialState, terminalAlive: true }, NOW)).toBe(false);
  });
  it('is live when tokens are burning', () => {
    expect(isSessionLive({ ...initialState, realUsage: { ...initialState.realUsage, burnRatePerMin: 1 } }, NOW)).toBe(true);
  });
  it('is live while a dispatch is running', () => {
    const agent = {} as AetherState['realAgents'][number];
    expect(isSessionLive({ ...initialState, realAgents: [agent], terminalAlive: true }, NOW)).toBe(true);
  });
  it('is not live on a dispatch left open by a pty that has exited', () => {
    const agent = {} as AetherState['realAgents'][number];
    expect(isSessionLive({ ...initialState, realAgents: [agent], terminalAlive: false }, NOW)).toBe(false);
  });
  it('is live on a fresh statusline capture and not on a stale one', () => {
    const snap = (capturedAtMs: number) => ({ capturedAtMs }) as NonNullable<AetherState['statusline']>;
    expect(isSessionLive({ ...initialState, statusline: snap(NOW - STATUSLINE_STALE_AFTER_MS) }, NOW)).toBe(true);
    expect(isSessionLive({ ...initialState, statusline: snap(NOW - STATUSLINE_STALE_AFTER_MS - 1) }, NOW)).toBe(false);
  });
  it('is live when the collector reports a busy session, not on an empty fleet', () => {
    const row = { sessionId: 's', pid: 1, projectName: 'p', kind: 'interactive', status: 'busy', name: 'n', startedAtMs: 0 };
    expect(isSessionLive({ ...initialState, fleet: [row] }, NOW)).toBe(true);
    expect(isSessionLive({ ...initialState, fleet: [] }, NOW)).toBe(false);
  });
  it('is not live on an idle fleet session (open, waiting on input)', () => {
    const row = { sessionId: 's', pid: 1, projectName: 'p', kind: 'interactive', status: 'idle', name: 'n', startedAtMs: 0 };
    expect(isSessionLive({ ...initialState, fleet: [row] }, NOW)).toBe(false);
  });
});

describe('sessionCommandHistory', () => {
  // Mirrors store.tsx's hydration merge: cmdHist is persisted, commandsRun is not.
  const hydrated = (): AetherState => ({ ...initialState, ...{ cmdHist: ['ls', 'ls', 'ls'] } });
  const count = (st: AetherState) => computeTopCommands(sessionCommandHistory(st)).reduce((n, c) => n + c.count, 0);

  it('keeps a restored cmdHist out of this session, so Commands run and TOP COMMANDS agree at 0', () => {
    const st = hydrated();
    expect(st.commandsRun).toBe(0);
    expect(sessionCommandHistory(st)).toEqual([]);
    expect(count(st)).toBe(st.commandsRun);
  });
  it('counts only commands run after the restore', () => {
    const st = reducer(hydrated(), { type: 'RUN_COMMAND', raw: 'ls' });
    expect(st.commandsRun).toBe(1);
    expect(computeTopCommands(sessionCommandHistory(st))).toEqual([{ name: 'ls', count: 1 }]);
    expect(count(st)).toBe(st.commandsRun);
  });
  it('returns the whole capped history once the session has outrun it', () => {
    const cmdHist = new Array(30).fill('ls');
    expect(sessionCommandHistory({ cmdHist, commandsRun: 45 })).toHaveLength(30);
  });
});

describe('computeRateReadout', () => {
  it('never prints the reactor visual rate (state.rate) as tok/min', () => {
    expect(computeRateReadout({ ...initialState, rate: 92000 }, false)).toBe(`${NO_DATA} tok/min`);
  });
  it('shows a dash when live but no transcript scan has landed', () => {
    expect(computeRateReadout(initialState, true)).toBe(`${NO_DATA} tok/min`);
  });
  it('shows the real transcript burn rate when live and scanned', () => {
    expect(computeRateReadout({ ...initialState, realUsage: { ...SCANNED, burnRatePerMin: 1234 } }, true)).toBe('1,234 tok/min');
  });
});

describe('computeDashPulseMode', () => {
  it('describes live-rate pulse with the active theme when live', () => {
    expect(computeDashPulseMode({ ...initialState.cfg, pulseMode: 'live', theme: 'cyan' }, true)).toBe('live-rate pulse · cyan core');
  });
  it('describes ambient pulse when live', () => {
    expect(computeDashPulseMode({ ...initialState.cfg, pulseMode: 'ambient', theme: 'violet' }, true)).toBe('ambient pulse · violet core');
  });
  it('reads just "standby" when idle, so "live-rate pulse" never sits beside it', () => {
    expect(computeDashPulseMode({ ...initialState.cfg, pulseMode: 'live', theme: 'cyan' }, false)).toBe('standby');
    expect(computeDashPulseMode({ ...initialState.cfg, pulseMode: 'ambient', theme: 'violet' }, false)).toBe('standby');
  });
});

describe('computeSidebarReactorRate', () => {
  it('never prints the reactor visual rate (state.rate) as the legend rate', () => {
    expect(computeSidebarReactorRate({ ...initialState, rate: 92000 }, false)).toBe(NO_DATA);
  });
  it('shows a dash when live but no transcript scan has landed', () => {
    expect(computeSidebarReactorRate(initialState, true)).toBe(NO_DATA);
  });
  it('shows the compact real transcript burn rate when live and scanned', () => {
    expect(computeSidebarReactorRate({ ...initialState, realUsage: { ...SCANNED, burnRatePerMin: 92000 } }, true)).toBe('92.0K');
  });
});

describe('computeSidebarReactorStatus', () => {
  it('reports the agent count as nominal when live', () => {
    expect(computeSidebarReactorStatus(true, 3)).toBe('Reactor nominal — 3 agents drawing power.');
  });
  it('reads standby when not live, regardless of a stale agent count', () => {
    expect(computeSidebarReactorStatus(false, 3)).toBe('Reactor on standby');
  });
});

describe('computeUsageBar', () => {
  it('renders a flat 2px baseline tick for a zero value, even when scanned', () => {
    expect(computeUsageBar(0, 100, true)).toEqual({ height: 2, baseline: true });
  });
  it('renders a flat 2px baseline tick for every bar when unscanned, regardless of value', () => {
    expect(computeUsageBar(100, 100, false)).toEqual({ height: 2, baseline: true });
  });
  it('scales a real positive value up to the 72px max at maxBar', () => {
    expect(computeUsageBar(100, 100, true)).toEqual({ height: 72, baseline: false });
  });
  it('scales a real positive value below maxBar proportionally', () => {
    expect(computeUsageBar(50, 100, true)).toEqual({ height: 46, baseline: false });
  });
});

describe('computeUsageRangeTotal', () => {
  it('renders NO_DATA before the first scan, never a confident 0', () => {
    expect(computeUsageRangeTotal([0, 0, 0], false)).toBe(NO_DATA);
  });
  it('sums the values once scanned', () => {
    expect(computeUsageRangeTotal([100, 200, 300], true)).toBe('600');
  });
  it('still renders a real 0 once scanned, distinct from NO_DATA', () => {
    expect(computeUsageRangeTotal([0, 0, 0], true)).toBe('0');
  });
});

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

  it('is NO_DATA for a snapshot only hours old if it was computed before local midnight', () => {
    const justAfterMidnightUtc = Date.UTC(2027, 0, 15, 0, 30);
    const twoHoursEarlier = justAfterMidnightUtc - 2 * 60 * 60 * 1000;
    expect(computeTodayCost(ledgerWithToday(3.25, twoHoursEarlier), justAfterMidnightUtc)).toBe(NO_DATA);
    expect(computeTodayCost(ledgerWithToday(3.25, justAfterMidnightUtc - 60 * 1000), justAfterMidnightUtc)).toBe('$3.25');
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

const ctxSnap = (over: Partial<StatuslineSnapshot> = {}): StatuslineSnapshot => ({
  capturedAtMs: NOW,
  sessionId: null,
  modelId: null,
  modelDisplayName: null,
  fiveHour: null,
  sevenDay: null,
  contextUsedPercentage: 48,
  contextWindowSize: 1_000_000,
  contextUsage: { inputTokens: 1_000, outputTokens: 500, cacheCreationInputTokens: 9_000, cacheReadInputTokens: 470_000 },
  totalCostUsd: null,
  currentDir: null,
  projectDir: null,
  ...over,
});

describe('computeContextReading', () => {
  it('is null with no statusline', () => {
    expect(computeContextReading(null, NOW)).toBeNull();
  });

  it('gives the footer card a reading that matches its ring', () => {
    const snap = ctxSnap();
    const reading = computeContextReading(snap, NOW);
    expect(reading).toEqual({ pct: 48, pctLabel: '48%', usedLabel: '480.0K / 1.00M', stale: false });
    expect(deriveContextWindowCard(snap, NOW).ringPct).toBe(reading!.pct);
  });

  it('clamps an over-100 raw percentage to 100', () => {
    const reading = computeContextReading(ctxSnap({ contextUsedPercentage: 245 }), NOW);
    expect(reading!.pct).toBe(100);
    expect(reading!.pctLabel).toBe('100%');
  });

  it('marks a stale capture with `~`', () => {
    const reading = computeContextReading(ctxSnap({ capturedAtMs: NOW - STATUSLINE_STALE_AFTER_MS - 1 }), NOW);
    expect(reading!.pctLabel).toBe('~48%');
    expect(reading!.stale).toBe(true);
  });
});

describe('computeSessionInfoRows', () => {
  it('has no month-scoped "Tokens used" row', () => {
    const rows = computeSessionInfoRows(
      { ...initialState, realUsage: { ...SCANNED, usedThisMonth: 11_534_188 } } as AetherState,
      new Date(NOW),
    );
    expect(rows.map((r) => r.k)).toEqual(['Session start', 'Uptime', 'Commands run', 'Agents active']);
    expect(rows.some((r) => r.v === '11,534,188')).toBe(false);
  });
});
