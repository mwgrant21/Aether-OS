import type { CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { pickSelectedMemory } from './memoryMath';
import { MemoryRosterCard } from './MemoryRosterCard';
import { MemoryDetailCard } from './MemoryDetailCard';

export function MemoryView() {
  const { state } = useAetherStore();
  const selectedMemory = pickSelectedMemory(state.memories, state.selectedMemory);

  return (
    <div style={rootStyle}>
      <MemoryRosterCard selectedId={selectedMemory?.id ?? null} />
      <MemoryDetailCard memory={selectedMemory} />
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
