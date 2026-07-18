import type { Agent, Approval } from '../../state/types';

export function pickSelectedAgent(agents: Agent[], selected: string | null): Agent | null {
  if (selected) {
    const match = agents.find((a) => a.name === selected);
    if (match) return match;
  }
  return agents[0] ?? null;
}

export function agentApprovals(approvals: Approval[], agentName: string): Approval[] {
  return approvals.filter((a) => a.agent === agentName);
}

export function agentStatusLabel(agent: Agent): 'PAUSED' | 'ACTIVE' {
  return agent.paused ? 'PAUSED' : 'ACTIVE';
}
