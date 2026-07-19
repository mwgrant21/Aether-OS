import type { MemoryStub } from '../../state/types';

export function pickSelectedMemory(memories: MemoryStub[], selected: string | null): MemoryStub | null {
  if (selected) {
    const match = memories.find((m) => String(m.id) === selected);
    if (match) return match;
  }
  return memories[0] ?? null;
}

export function groupMemoriesForRoster(memories: MemoryStub[]): { pinned: MemoryStub[]; unpinned: MemoryStub[] } {
  const pinned = memories.filter((m) => m.pinned);
  const unpinned = memories.filter((m) => !m.pinned).sort((a, b) => b.strength - a.strength);
  return { pinned, unpinned };
}

export function STRENGTH_TIER_COLOR(strength: number): string {
  if (strength > 60) return '#3be0a0';
  if (strength > 30) return '#f5c66b';
  return '#4e7c8b';
}
