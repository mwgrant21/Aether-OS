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
