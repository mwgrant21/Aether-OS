import type { CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { pickSelectedMemory } from './memoryMath';
import { MemoryRosterCard } from './MemoryRosterCard';
import { MemoryDetailCard } from './MemoryDetailCard';

export function MemoryView() {
  const { state } = useAetherStore();

  if (state.memoryShowTombstones) {
    const selected =
      (state.selectedMemory && state.memoryTombstones.find((t) => String(t.id) === state.selectedMemory)) ||
      state.memoryTombstones[0] ||
      null;
    return (
      <div style={rootStyle}>
        <MemoryRosterCard selectedId={selected?.id ?? null} />
        <MemoryDetailCard memory={null} tombstone={selected} />
      </div>
    );
  }

  const selectedMemory = pickSelectedMemory(state.memories, state.selectedMemory);

  return (
    <div style={rootStyle}>
      <MemoryRosterCard selectedId={selectedMemory?.id ?? null} />
      <MemoryDetailCard memory={selectedMemory} tombstone={null} />
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
