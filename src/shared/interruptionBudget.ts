// STEWARD's interruption-budget MECHANISM only (spec §8): window,
// single-spend, ranking-on-severity is the caller's job (it must pick the
// single highest-ranked item before calling spendBudget, per spec). The
// window value N itself and anomaly-based ranking are Phase 3 -- unknowable
// without observed traffic, so this stage only builds the buildable half.
// Responses to direct questions never call spendBudget (spec: "direct-answer
// exemption") -- that exemption is the caller simply not calling this module
// at all for that path, not a flag here.
export interface InterruptionBudgetState {
  lastVolunteeredAtMs: number | null;
}

export function createInterruptionBudget(): InterruptionBudgetState {
  return { lastVolunteeredAtMs: null };
}

export function canVolunteer(state: InterruptionBudgetState, nowMs: number, windowMs: number): boolean {
  if (state.lastVolunteeredAtMs === null) return true;
  return nowMs - state.lastVolunteeredAtMs >= windowMs;
}

export function spendBudget(_state: InterruptionBudgetState, nowMs: number): InterruptionBudgetState {
  return { lastVolunteeredAtMs: nowMs };
}
