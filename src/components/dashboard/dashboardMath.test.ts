import { describe, expect, it } from 'vitest';
import { computeDashKpis, computeDashPulseMode, computeDashStatus } from './dashboardMath';
import { initialState } from '../../state/initialState';

describe('computeDashStatus', () => {
  it('maps each alarm level to its Dashboard-specific label', () => {
    expect(computeDashStatus('ok')).toBe('NOMINAL');
    expect(computeDashStatus('warn')).toBe('ELEVATED');
    expect(computeDashStatus('crit')).toBe('BURN ALARM');
  });
});

describe('computeDashPulseMode', () => {
  it('describes live-rate pulse with the active theme', () => {
    expect(computeDashPulseMode({ ...initialState.cfg, pulseMode: 'live', theme: 'cyan' })).toBe('live-rate pulse · cyan core');
  });
  it('describes ambient pulse', () => {
    expect(computeDashPulseMode({ ...initialState.cfg, pulseMode: 'ambient', theme: 'violet' })).toBe('ambient pulse · violet core');
  });
});

describe('computeDashKpis', () => {
  it('derives all four KPI tiles from state', () => {
    const kpis = computeDashKpis({ ...initialState, used: 24391, rate: 92000, ctxUsed: 78432, cfg: { ...initialState.cfg, capM: 2.0 } });
    expect(kpis).toHaveLength(4);
    expect(kpis[0]).toEqual({ k: 'SESSION TOKENS', v: '24.4K', s: '$0.44 spend' });
    expect(kpis[1].k).toBe('BUDGET LEFT');
    expect(kpis[1].v).toBe('98.8%');
    expect(kpis[1].s).toBe('of 2.0M cap');
    expect(kpis[2].k).toBe('DEPLETION ETA');
    expect(kpis[3]).toEqual({ k: 'CONTEXT', v: '63%', s: '78.4K / 125K' });
  });

  it('clamps budget-left at 0% instead of going negative', () => {
    const kpis = computeDashKpis({ ...initialState, used: 5_000_000, cfg: { ...initialState.cfg, capM: 2.0 } });
    expect(kpis[1].v).toBe('0.0%');
  });
});
