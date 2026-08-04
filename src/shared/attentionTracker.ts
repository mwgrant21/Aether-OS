// Instrumented, unconsumed (spec §8: "the hook ships in Phase 1 even if
// nothing consumes it"). STEWARD's real value -- flagging what the user
// ISN'T looking at -- needs this data, but nothing in Phase 1 reads it yet;
// wiring a render-layer caller (e.g. AgentRosterCard's mount/focus
// lifecycle) into recordFocus/recordInteraction is future work once
// STEWARD's fleet-level narration is built, which is out of this stage's
// scope (this stage narrates per-dispatch, not per-fleet -- see Task 8).
export interface AttentionState {
  focusedPanel: string | null;
  lastInteractionAtMs: number | null;
}

export function createAttentionState(): AttentionState {
  return { focusedPanel: null, lastInteractionAtMs: null };
}

export function recordFocus(state: AttentionState, panel: string, nowMs: number): AttentionState {
  return { ...state, focusedPanel: panel };
}

export function recordInteraction(state: AttentionState, nowMs: number): AttentionState {
  return { ...state, lastInteractionAtMs: nowMs };
}
