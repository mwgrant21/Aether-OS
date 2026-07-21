import type { CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { pickSelectedRealAgent } from './agentsMath';
import { AgentRosterCard } from './AgentRosterCard';
import { AgentDetailCard } from './AgentDetailCard';

export function AgentsView() {
  const { state } = useAetherStore();
  const selectedAgent = pickSelectedRealAgent(state.realAgents, state.selectedRealAgent);

  return (
    <div style={rootStyle}>
      <AgentRosterCard selectedToolUseId={selectedAgent?.toolUseId ?? null} />
      <AgentDetailCard agent={selectedAgent} />
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
