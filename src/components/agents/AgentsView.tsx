import type { CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { pickSelectedAgent } from './agentsMath';
import { AgentRosterCard } from './AgentRosterCard';
import { AgentDetailCard } from './AgentDetailCard';

export function AgentsView() {
  const { state } = useAetherStore();
  const selectedAgent = pickSelectedAgent(state.agents, state.selected);

  return (
    <div style={rootStyle}>
      <AgentRosterCard selectedName={selectedAgent?.name ?? null} />
      <AgentDetailCard agent={selectedAgent} />
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
