import { describe, expect, it } from 'vitest';
import { computeRealAgentBreakdown, computeTopCommands, computeSysMetricStats, computeLogFrequency, computeCompletedDispatchBurn } from './analyticsMath';
import type { RealAgentDispatch } from '../../state/liveAgentsMath';

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

describe('computeCompletedDispatchBurn', () => {
  it('sorts by tokens descending and filters out pool entries with no matching usage data', () => {
    const pool = [
      mockRealAgent('tu_1', '2026-07-22T10:00:00.000Z', 'general-purpose', 'low'),
      mockRealAgent('tu_2', '2026-07-22T10:00:00.000Z', 'Explore', 'high'),
      mockRealAgent('tu_3', '2026-07-22T10:00:00.000Z', 'fork', 'no-usage-yet'),
    ];
    const usage = {
      tu_1: { tokens: 1000, toolUses: 2, durationMs: 5000 },
      tu_2: { tokens: 5000, toolUses: 4, durationMs: 10000 },
    };
    const rows = computeCompletedDispatchBurn(pool, usage);
    expect(rows.map((r) => r.toolUseId)).toEqual(['tu_2', 'tu_1']);
  });

  it('respects the display limit', () => {
    const pool = Array.from({ length: 10 }, (_, i) => mockRealAgent(`tu_${i}`, '2026-07-22T10:00:00.000Z'));
    const usage = Object.fromEntries(pool.map((d, i) => [d.toolUseId, { tokens: i, toolUses: 1, durationMs: 1000 }]));
    expect(computeCompletedDispatchBurn(pool, usage, 5)).toHaveLength(5);
  });

  it('returns an empty array for an empty pool', () => {
    expect(computeCompletedDispatchBurn([], {})).toEqual([]);
  });
});
