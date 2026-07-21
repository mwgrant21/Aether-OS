import type { RealAgentDispatch } from '../../state/liveAgentsMath';

export function pickSelectedRealAgent(agents: RealAgentDispatch[], selected: string | null): RealAgentDispatch | null {
  if (selected) {
    const match = agents.find((a) => a.toolUseId === selected);
    if (match) return match;
  }
  return agents[0] ?? null;
}
