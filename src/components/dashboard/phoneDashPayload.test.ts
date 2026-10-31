import { describe, it, expect } from 'vitest';
import { phoneDashPayload } from './phoneDashPayload';
import { isSessionLive } from './dashboardMath';
import { initialState } from '../../state/initialState';
import { STATUSLINE_STALE_AFTER_MS } from '../../shared/depletion';
import type { AetherState } from '../../state/types';
import type { StatuslineSnapshot } from '../../shared/statuslinePayload';

const NOW = 1_800_000_000_000;
const SCANNED = { ...initialState.realUsage, lastScanAt: '2026-09-28T12:00:00.000Z', usedThisMonth: 1e6, burnRatePerMin: 600 };
const line = (ageMs: number): StatuslineSnapshot =>
  ({ ...({} as StatuslineSnapshot), capturedAtMs: NOW - ageMs, fiveHour: { usedPercentage: 50, resetsAtMs: NOW + 3_600_000 } }) as StatuslineSnapshot;
const get = (s: AetherState) => phoneDashPayload(s, true, NOW) as any;

describe('phoneDashPayload', () => {
  it('stamps the publish instant so the phone can show the age of the reading', () => {
    expect(get(initialState).computedAtMs).toBe(NOW);
  });
  it('agrees with isSessionLive at the publish instant, on both sides of the statusline staleness edge', () => {
    for (const age of [0, STATUSLINE_STALE_AFTER_MS, STATUSLINE_STALE_AFTER_MS + 1]) {
      const s = { ...initialState, statusline: line(age) } as AetherState;
      expect(get(s).live).toBe(isSessionLive(s, NOW));
    }
    expect(get({ ...initialState, statusline: line(STATUSLINE_STALE_AFTER_MS + 1) } as AetherState).live).toBe(false);
  });
  it('reports not-measured as null, never 0, before the first scan', () => {
    const p = get(initialState);
    expect(p.ratePerMin).toBeNull();
    expect(p.kpis.monthTokens).toBeNull();
    expect(p.kpis.todayUsd).toBeNull();
    expect(p.kpis.budgetLeftPct).toBeNull();
    expect(p.kpis.eta).toEqual({ kind: 'none', secs: null, source: 'scan', resetsInMs: null });
    expect(p.recap).toBeNull();
  });
  it('uses the scan estimate for the ETA and the statusline once it has a reading', () => {
    const scan = get({ ...initialState, realUsage: SCANNED } as AetherState).kpis;
    expect(scan.monthTokens).toBe(1e6);
    expect(scan.eta.source).toBe('scan');
    expect(scan.eta.kind).toBe('secs');
    const sl = get({ ...initialState, realUsage: SCANNED, statusline: line(0) } as AetherState).kpis.eta;
    expect(sl).toMatchObject({ kind: 'secs', source: 'live', resetsInMs: 3_600_000 });
    expect(get({ ...initialState, realUsage: SCANNED, statusline: line(STATUSLINE_STALE_AFTER_MS + 1) } as AetherState).kpis.eta.source).toBe('stale');
  });
  it('carries readiness as keys, flags and times, and the cap as capM only', () => {
    const p = get({ ...initialState, statusline: line(0) } as AetherState);
    expect(p.readiness.map((r: any) => r.key)).toEqual(['desktop', 'terminal', 'statusline', 'collector']);
    expect(p.readiness.map((r: any) => Object.keys(r).sort().join())).toEqual(Array(4).fill('atMs,glows,key,met'));
    expect(p.readiness[2]).toMatchObject({ met: true, glows: true, atMs: NOW });
    expect(p.kpis.capM).toBe(initialState.cfg.capM);
    expect(JSON.stringify(p)).not.toContain('cfg');
  });
  it('sends recap and strip as counts only', () => {
    const recap = { tokensBurned: 5, entries: [
      { kind: 'dispatchCompleted', detail: 'SECRET-DETAIL', atMs: 1 }, { kind: 'dispatchCompleted', detail: 'x', atMs: 2 },
      { kind: 'anomalyDetected', detail: 'x', atMs: 3 }, { kind: 'anomalyCleared', detail: 'x', atMs: 4 },
    ] };
    const p = get({ ...initialState, recap } as unknown as AetherState);
    expect(p.recap).toEqual({ dispatches: 2, anomaliesDetected: 1, anomaliesCleared: 1, tokensBurned: 5 });
    expect(JSON.stringify(p)).not.toContain('SECRET-DETAIL');
    expect(Object.keys(p.strip)).toEqual(['agents', 'alerts', 'memory']);
  });
});
