import type { RealAgentDispatch } from '../../state/liveAgentsMath';
import type { Anomaly } from '../../shared/anomalyDetectors';

export interface RosterGroup {
  label: 'NEEDS INPUT' | 'WORKING' | 'DONE';
  dispatches: RealAgentDispatch[];
  collapsible: boolean;
}

// state.realAgents only ever carries currently-open dispatches (see
// useRealAgentsSync's SET_REAL_AGENTS wiring) -- there is no "done but still
// shown" dispatch in this array today, so the DONE group is always empty
// until/unless a future stage feeds completed-but-recently-visible dispatches
// into this function. It's still modeled explicitly (not omitted) because the
// design spec's survival rule is specifically about DONE being the only
// collapsible group -- that rule needs a group to apply to even if it's
// empty today.
export function groupDispatches(dispatches: RealAgentDispatch[], anomalies: Anomaly[]): RosterGroup[] {
  const anomalyToolUseIds = new Set(anomalies.map((a) => a.toolUseId));
  const needsInput = dispatches.filter((d) => anomalyToolUseIds.has(d.toolUseId));
  const working = dispatches.filter((d) => !anomalyToolUseIds.has(d.toolUseId));

  return [
    { label: 'NEEDS INPUT', dispatches: needsInput, collapsible: false },
    { label: 'WORKING', dispatches: working, collapsible: false },
    { label: 'DONE', dispatches: [], collapsible: true },
  ];
}
