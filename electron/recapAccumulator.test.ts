import { describe, it, expect } from 'vitest';
import { createEmptyAccumulator, accumulate } from './recapAccumulator';
import type { LiveAgentTick } from './liveAgentTracker';

function tick(overrides: Partial<LiveAgentTick> = {}): LiveAgentTick {
  return { open: [], completed: [], work: [], anomalies: [], cacheHitRatio: 1, ...overrides };
}

describe('recapAccumulator.accumulate', () => {
  it('starts empty', () => {
    const acc = createEmptyAccumulator();
    expect(acc.entries).toEqual([]);
    expect(acc.tokensBurned).toBe(0);
  });

  it('records a dispatchCompleted entry when a new completed dispatch appears', () => {
    const prevTick = tick();
    const nextTick = tick({
      completed: [{ toolUseId: 't1', subagentType: 'general-purpose', description: 'do the thing', startedAt: '2026-01-01T00:00:00.000Z', prompt: 'x', model: null, tokens: 500, toolUses: 2, durationMs: 1000 }],
    });
    const acc = accumulate(createEmptyAccumulator(), nextTick, prevTick, Date.now());
    expect(acc.entries).toEqual([{ kind: 'dispatchCompleted', detail: 'general-purpose: do the thing', atMs: expect.any(Number) }]);
    expect(acc.tokensBurned).toBe(500);
  });

  it('records an anomalyDetected entry for a newly-seen anomaly toolUseId', () => {
    const prevTick = tick();
    const nextTick = tick({ anomalies: [{ kind: 'reReadLoop', toolUseId: 'a1', detail: 'foo.ts read 3 times' }] });
    const acc = accumulate(createEmptyAccumulator(), nextTick, prevTick, Date.now());
    expect(acc.entries).toEqual([{ kind: 'anomalyDetected', detail: 'foo.ts read 3 times', atMs: expect.any(Number) }]);
  });

  it('records an anomalyCleared entry when a previously-seen anomaly toolUseId disappears', () => {
    const prevTick = tick({ anomalies: [{ kind: 'reReadLoop', toolUseId: 'a1', detail: 'foo.ts read 3 times' }] });
    const nextTick = tick({ anomalies: [] });
    const acc = accumulate(createEmptyAccumulator(), nextTick, prevTick, Date.now());
    expect(acc.entries).toEqual([{ kind: 'anomalyCleared', detail: 'foo.ts read 3 times', atMs: expect.any(Number) }]);
  });

  it('does not re-record an anomaly still present in both ticks', () => {
    const anomaly = { kind: 'reReadLoop' as const, toolUseId: 'a1', detail: 'foo.ts read 3 times' };
    const prevTick = tick({ anomalies: [anomaly] });
    const nextTick = tick({ anomalies: [anomaly] });
    const acc = accumulate(createEmptyAccumulator(), nextTick, prevTick, Date.now());
    expect(acc.entries).toEqual([]);
  });

  it('accumulates across multiple calls rather than replacing', () => {
    let acc = createEmptyAccumulator();
    const nextTick1 = tick({ anomalies: [{ kind: 'reReadLoop', toolUseId: 'a1', detail: 'x' }] });
    acc = accumulate(acc, nextTick1, tick(), Date.now());
    const nextTick2 = tick({ anomalies: [] });
    acc = accumulate(acc, nextTick2, nextTick1, Date.now());
    expect(acc.entries).toHaveLength(2);
    expect(acc.entries.map((e) => e.kind)).toEqual(['anomalyDetected', 'anomalyCleared']);
  });
});
