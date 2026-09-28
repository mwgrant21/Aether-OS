import { describe, expect, it } from 'vitest';
import {
  NO_DATA,
  computeDashKpis,
  computeDashPulseMode,
  computeDashStatus,
  computeRateReadout,
  computeSidebarReactorRate,
  computeSidebarReactorStatus,
  computeUsageRangeTotal,
  isSessionLive,
  sessionCommandHistory,
} from './dashboardMath';
import { computeTopCommands } from '../analytics/analyticsMath';
import { reducer } from '../../state/reducer';
import { initialState } from '../../state/initialState';
import { STATUSLINE_STALE_AFTER_MS } from '../../shared/depletion';
import type { AetherState } from '../../state/types';

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
  it('says standby instead of naming the theme core when not live', () => {
    expect(computeDashPulseMode({ ...initialState.cfg, pulseMode: 'live', theme: 'cyan' }, false)).toBe('live-rate pulse · standby');
    expect(computeDashPulseMode({ ...initialState.cfg, pulseMode: 'ambient', theme: 'violet' }, false)).toBe('ambient pulse · standby');
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

describe('computeDashKpis', () => {
  it('derives all four KPI tiles from a scanned state', () => {
    const kpis = computeDashKpis({
      ...initialState,
      realUsage: { ...SCANNED, usedThisMonth: 24391, burnRatePerMin: 92000 },
      ctxUsed: 78432,
      cfg: { ...initialState.cfg, capM: 2.0 },
    });
    expect(kpis).toHaveLength(4);
    // A monthly value is labelled as one.
    expect(kpis[0]).toEqual({ k: 'MONTH TOKENS', v: '24.4K', s: 'this month' });
    expect(kpis[1].k).toBe('BUDGET LEFT');
    expect(kpis[1].v).toBe('98.8%');
    expect(kpis[1].s).toBe('of 2.0M cap');
    expect(kpis[2].k).toBe('DEPLETION ETA');
    expect(kpis[2].v.startsWith('~')).toBe(true);
    // 78432 / 200000 = 39%, an estimate against the assumed window, so it keeps `~`.
    expect(kpis[3]).toEqual({ k: 'CONTEXT', v: '~39%', s: '78.4K / 200K' });
  });

  it('renders a dash, never a seeded or zero value, before any scan', () => {
    const kpis = computeDashKpis(initialState);
    expect(kpis.map((k) => k.v)).toEqual([NO_DATA, NO_DATA, NO_DATA, NO_DATA]);
    expect(kpis[3].s).toBe('no reading yet');
  });

  it('renders a dash for DEPLETION ETA when nothing is being drawn', () => {
    const kpis = computeDashKpis({ ...initialState, realUsage: { ...SCANNED, burnRatePerMin: 0 } });
    expect(kpis[2].v).toBe(NO_DATA);
  });

  it('clamps budget-left at 0% instead of going negative', () => {
    const kpis = computeDashKpis({
      ...initialState,
      realUsage: { ...SCANNED, usedThisMonth: 5_000_000 },
      cfg: { ...initialState.cfg, capM: 2.0 },
    });
    expect(kpis[1].v).toBe('0.0%');
  });
});
