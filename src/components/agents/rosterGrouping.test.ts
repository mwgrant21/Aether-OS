import { describe, it, expect } from 'vitest';
import { groupDispatches } from './rosterGrouping';

const dispatch = (toolUseId: string) => ({
  toolUseId,
  subagentType: 'general-purpose',
  description: 'x',
  startedAt: '2026-01-01T00:00:00.000Z',
  prompt: 'x',
  model: null,
});

describe('groupDispatches', () => {
  it('places a dispatch with an active anomaly in NEEDS INPUT', () => {
    const groups = groupDispatches([dispatch('t1')], [{ kind: 'reReadLoop', toolUseId: 't1', detail: 'x' }], []);
    const needsInput = groups.find((g) => g.label === 'NEEDS INPUT')!;
    expect(needsInput.dispatches.map((d) => d.toolUseId)).toEqual(['t1']);
  });

  it('places a dispatch with no anomaly in WORKING', () => {
    const groups = groupDispatches([dispatch('t1')], [], []);
    const working = groups.find((g) => g.label === 'WORKING')!;
    expect(working.dispatches.map((d) => d.toolUseId)).toEqual(['t1']);
  });

  it('orders NEEDS INPUT before WORKING before DONE, always, regardless of input order', () => {
    const groups = groupDispatches([dispatch('t1')], [{ kind: 'reReadLoop', toolUseId: 't1', detail: 'x' }], []);
    expect(groups.map((g) => g.label)).toEqual(['NEEDS INPUT', 'WORKING', 'DONE']);
  });

  it('only DONE is ever collapsible', () => {
    const groups = groupDispatches([dispatch('t1')], [{ kind: 'reReadLoop', toolUseId: 't1', detail: 'x' }], []);
    for (const g of groups) {
      expect(g.collapsible).toBe(g.label === 'DONE');
    }
  });

  it('populates DONE from the completedDispatches argument', () => {
    const groups = groupDispatches([], [], [dispatch('t2')]);
    const done = groups.find((g) => g.label === 'DONE')!;
    expect(done.dispatches.map((d) => d.toolUseId)).toEqual(['t2']);
  });
});
