// electron/severity/isStalled.ts
// Pure. Spec section 5: stalled = no progress for longer than STALL_MS, OR the
// owning Claude session has ended while the dispatch is still open. Callers
// decide what "progress" and "session ended" mean on their path.
//
// SOURCE OF TRUTH for collector/src/severity/isStalled.ts (generated).

export const STALL_MS = 30 * 60 * 1000;

export interface StallProbe {
  lastProgressMs: number;
  sessionEnded: boolean;
}

export function isStalled(probe: StallProbe, nowMs: number): boolean {
  if (probe.sessionEnded) return true;
  if (!Number.isFinite(probe.lastProgressMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - probe.lastProgressMs > STALL_MS;
}
