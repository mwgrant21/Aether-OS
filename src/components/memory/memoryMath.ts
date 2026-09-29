import type { MemoryRow } from '../../state/types';
import type { ColorPalette } from '../../styles/tokens';

export function pickSelectedMemory(memories: MemoryRow[], selected: string | null): MemoryRow | null {
  if (selected) {
    const match = memories.find((m) => String(m.id) === selected);
    if (match) return match;
  }
  return memories[0] ?? null;
}

export function groupMemoriesByScope(memories: MemoryRow[]): { shared: MemoryRow[]; byAgent: Map<string, MemoryRow[]> } {
  const shared = memories.filter((m) => m.scope === 'shared');
  const byAgent = new Map<string, MemoryRow[]>();
  for (const m of memories) {
    if (m.scope !== 'private' || !m.ownerAgent) continue;
    const list = byAgent.get(m.ownerAgent) ?? [];
    list.push(m);
    byAgent.set(m.ownerAgent, list);
  }
  return { shared, byAgent };
}

// `colors` is threaded in (rather than importing the static palette directly)
// so the habit/default tier follows tokens.ts's colors.textDim -- including
// its AC4 contrast fix -- instead of a hardcoded duplicate of the old value
// that the fix would otherwise never reach. The other three tiers are
// one-off tier colors, not token duplicates, so they stay literal.
export function KIND_TIER_COLOR(kind: MemoryRow['kind'], colors: ColorPalette): string {
  switch (kind) {
    case 'overrule': return '#f5c66b'; // highest-priority private signal
    case 'decision':
    case 'preference': return '#3be0a0'; // shared, in force
    case 'revision': return '#8fd6ff';
    case 'habit':
    default: return colors.textDim;
  }
}
