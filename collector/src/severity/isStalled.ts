// GENERATED from electron/severity/isStalled.ts by scripts/sync-severity-core.mjs -- do not edit.
// Edit the electron copy, then run: node scripts/sync-severity-core.mjs
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

// How far past nowMs a subagent file's mtime may sit and still count as
// progress. Shared by the collector sweep and the live stall check so the two
// paths cannot differ.
export const FUTURE_MTIME_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Last-progress time for a dispatch: its subagent file's mtime when usable,
 * else its start. nowMs is taken before the stat, so a live subagent's mtime is
 * routinely a little ahead of it: within FUTURE_MTIME_TOLERANCE_MS it counts as
 * progress now (clamped to nowMs); further ahead it is clock skew and ignored.
 */
export function lastProgressMs(startedMs: number, fileMtimeMs: number | null | undefined, nowMs: number): number {
  return typeof fileMtimeMs === 'number' && fileMtimeMs <= nowMs + FUTURE_MTIME_TOLERANCE_MS
    ? Math.max(startedMs, Math.min(fileMtimeMs, nowMs))
    : startedMs;
}
