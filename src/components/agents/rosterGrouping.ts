import type { RealAgentDispatch } from '../../state/liveAgentsMath';
import type { Anomaly } from '../../shared/anomalyDetectors';

export interface RosterGroup {
  label: 'NEEDS INPUT' | 'WORKING' | 'DONE';
  dispatches: RealAgentDispatch[];
  collapsible: boolean;
}

// The DONE group is sourced from state.recentCompletedDispatches (populated
// by the SET_REAL_AGENTS reducer case via detectCompletedDispatches, capped
// at 20 entries there) -- state.realAgents only ever carries currently-open
// dispatches, so DONE can never be derived from it directly.
export function groupDispatches(
  dispatches: RealAgentDispatch[],
  anomalies: Anomaly[],
  completedDispatches: RealAgentDispatch[],
): RosterGroup[] {
  const anomalyToolUseIds = new Set(anomalies.map((a) => a.toolUseId));
  const needsInput = dispatches.filter((d) => anomalyToolUseIds.has(d.toolUseId));
  const working = dispatches.filter((d) => !anomalyToolUseIds.has(d.toolUseId));

  return [
    { label: 'NEEDS INPUT', dispatches: needsInput, collapsible: false },
    { label: 'WORKING', dispatches: working, collapsible: false },
    { label: 'DONE', dispatches: completedDispatches, collapsible: true },
  ];
}
