import { describe, it, expect } from 'vitest';
import type { MemoryRow } from '../../state/types';
import { pickSelectedMemory, groupMemoriesByScope, KIND_TIER_COLOR } from './memoryMath';

function row(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: 1, scope: 'private', ownerAgent: 'CINDER', kind: 'habit', content: 'x',
    status: null, salience: 3, subject: null, createdAtMs: 0, updatedAtMs: 0,
    referenceCount: 0, ...overrides,
  };
}

describe('pickSelectedMemory', () => {
  it('returns the memory matching the stringified selected id', () => {
    const memories = [row({ id: 1 }), row({ id: 2 })];
    expect(pickSelectedMemory(memories, '2')?.id).toBe(2);
  });

  it('falls back to the first memory when selected is null', () => {
    const memories = [row({ id: 5 }), row({ id: 6 })];
    expect(pickSelectedMemory(memories, null)?.id).toBe(5);
  });

  it('falls back to the first memory when selected matches nothing', () => {
    const memories = [row({ id: 5 })];
    expect(pickSelectedMemory(memories, '999')?.id).toBe(5);
  });

  it('returns null for an empty list', () => {
    expect(pickSelectedMemory([], null)).toBeNull();
  });
});

describe('groupMemoriesByScope', () => {
  it('splits shared rows and groups private rows by ownerAgent', () => {
    const memories = [
      row({ id: 1, scope: 'shared', ownerAgent: null, kind: 'decision' }),
      row({ id: 2, scope: 'private', ownerAgent: 'CINDER' }),
      row({ id: 3, scope: 'private', ownerAgent: 'FORGE' }),
      row({ id: 4, scope: 'private', ownerAgent: 'CINDER' }),
    ];
    const { shared, byAgent } = groupMemoriesByScope(memories);
    expect(shared.map((m) => m.id)).toEqual([1]);
    expect(byAgent.get('CINDER')?.map((m) => m.id)).toEqual([2, 4]);
    expect(byAgent.get('FORGE')?.map((m) => m.id)).toEqual([3]);
  });

  it('skips a private row with a null ownerAgent rather than throwing', () => {
    const memories = [row({ scope: 'private', ownerAgent: null })];
    const { byAgent } = groupMemoriesByScope(memories);
    expect(byAgent.size).toBe(0);
  });

  it('returns an empty shared array and empty map for no memories', () => {
    const { shared, byAgent } = groupMemoriesByScope([]);
    expect(shared).toEqual([]);
    expect(byAgent.size).toBe(0);
  });
});

describe('KIND_TIER_COLOR', () => {
  it('returns a color for every MemoryKind without throwing', () => {
    const kinds: MemoryRow['kind'][] = ['decision', 'preference', 'overrule', 'habit', 'revision'];
    for (const kind of kinds) {
      expect(typeof KIND_TIER_COLOR(kind)).toBe('string');
      expect(KIND_TIER_COLOR(kind).length).toBeGreaterThan(0);
    }
  });
});
