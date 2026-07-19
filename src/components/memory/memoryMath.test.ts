import { describe, expect, it } from 'vitest';
import { STRENGTH_TIER_COLOR, groupMemoriesForRoster, pickSelectedMemory } from './memoryMath';
import { initialState } from '../../state/initialState';

describe('pickSelectedMemory', () => {
  it('returns the memory matching selected (by id, as a string) when present', () => {
    const memory = pickSelectedMemory(initialState.memories, '2');
    expect(memory?.id).toBe(2);
  });

  it('falls back to the first memory when selected is null', () => {
    const memory = pickSelectedMemory(initialState.memories, null);
    expect(memory?.id).toBe(initialState.memories[0].id);
  });

  it('falls back to the first memory when selected does not match any id', () => {
    const memory = pickSelectedMemory(initialState.memories, '999');
    expect(memory?.id).toBe(initialState.memories[0].id);
  });

  it('returns null when there are no memories at all', () => {
    expect(pickSelectedMemory([], 'Anything')).toBeNull();
  });
});

describe('groupMemoriesForRoster', () => {
  it('splits the seed memories into pinned (array order) and unpinned (strength descending)', () => {
    const { pinned, unpinned } = groupMemoriesForRoster(initialState.memories);
    expect(pinned.map((m) => m.id)).toEqual([1]);
    expect(unpinned.map((m) => m.id)).toEqual([2, 3, 4]);
  });

  it('returns an empty pinned array when nothing is pinned', () => {
    const allUnpinned = initialState.memories.map((m) => ({ ...m, pinned: false }));
    const { pinned } = groupMemoriesForRoster(allUnpinned);
    expect(pinned).toEqual([]);
  });

  it('returns both empty for an empty input', () => {
    expect(groupMemoriesForRoster([])).toEqual({ pinned: [], unpinned: [] });
  });
});

describe('STRENGTH_TIER_COLOR', () => {
  it('returns the healthy color above 60', () => {
    expect(STRENGTH_TIER_COLOR(92)).toBe('#3be0a0');
    expect(STRENGTH_TIER_COLOR(61)).toBe('#3be0a0');
  });

  it('returns the fading color from 31 to 60 inclusive', () => {
    expect(STRENGTH_TIER_COLOR(60)).toBe('#f5c66b');
    expect(STRENGTH_TIER_COLOR(31)).toBe('#f5c66b');
  });

  it('returns the dim/at-sweep-threshold color at 30 and below', () => {
    expect(STRENGTH_TIER_COLOR(30)).toBe('#4e7c8b');
    expect(STRENGTH_TIER_COLOR(0)).toBe('#4e7c8b');
  });
});
