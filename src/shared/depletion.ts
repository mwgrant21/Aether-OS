import type { StatuslineSnapshot } from './statuslinePayload';

export type DepletionSource = 'statusline' | 'estimate' | 'none';

export interface DepletionReadout {
  source: DepletionSource;
  usedPercentage: number | null; // 0-100
  resetsAtMs: number | null;
  msUntilReset: number | null;
  /** Projected ms until the window is exhausted at the current consumption pace, or null
   *  when it will not deplete before the window resets. */
  msUntilDepleted: number | null;
  /** True when the projection says the limit runs out before the window resets. */
  depletesBeforeReset: boolean;
  stale: boolean;
}

// Statusline updates are event-driven with a 300ms debounce, not timer-driven, so a
// payload can legitimately be several minutes old during one long tool call. Ten
// minutes is comfortably past that without being so long that a genuinely dead feed
// reads as live.
export const STATUSLINE_STALE_AFTER_MS = 10 * 60 * 1000;

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

function emptyReadout(stale: boolean): DepletionReadout {
  return {
    source: 'none',
    usedPercentage: null,
    resetsAtMs: null,
    msUntilReset: null,
    msUntilDepleted: null,
    depletesBeforeReset: false,
    stale,
  };
}

export function deriveDepletion(
  snapshot: StatuslineSnapshot | null,
  windowStartMs: number | null,
  nowMs: number,
): DepletionReadout {
  if (snapshot === null || snapshot.fiveHour === null) {
    // No snapshot means no capturedAtMs to judge freshness against; a snapshot
    // without a fiveHour window still has a real capturedAtMs, so staleness can
    // (and should) still be reported even though there is nothing to project.
    const stale = snapshot !== null ? nowMs - snapshot.capturedAtMs > STATUSLINE_STALE_AFTER_MS : false;
    return emptyReadout(stale);
  }

  const { usedPercentage, resetsAtMs } = snapshot.fiveHour;
  const stale = nowMs - snapshot.capturedAtMs > STATUSLINE_STALE_AFTER_MS;
  const msUntilReset = resetsAtMs - nowMs;

  // The caller may not know when the current 5-hour window started; derive it from
  // the reset time when not supplied.
  const windowStart = windowStartMs !== null ? windowStartMs : resetsAtMs - FIVE_HOUR_MS;
  const elapsedMs = nowMs - windowStart;

  let msUntilDepleted: number | null;
  let depletesBeforeReset: boolean;

  if (usedPercentage >= 100) {
    msUntilDepleted = 0;
    depletesBeforeReset = true;
  } else if (elapsedMs <= 0 || usedPercentage <= 0) {
    msUntilDepleted = null;
    depletesBeforeReset = false;
  } else {
    const pacePerMs = usedPercentage / elapsedMs;
    msUntilDepleted = (100 - usedPercentage) / pacePerMs;
    depletesBeforeReset = msUntilDepleted < msUntilReset;
  }

  return {
    source: 'statusline',
    usedPercentage,
    resetsAtMs,
    msUntilReset,
    msUntilDepleted,
    depletesBeforeReset,
    stale,
  };
}

/**
 * Formats a countdown to a reset time. Deliberately not built on top of
 * `fmtElapsed` in `src/utils/format.ts`: that helper always includes seconds for
 * sub-hour durations (`"42m 7s"`), whereas this needs whole minutes only
 * (`"42m"`) to match the brief's display shape. The hour+minute composition
 * mirrors `fmtElapsed`'s `${h}h ${m}m` convention exactly.
 */
export function formatResetCountdown(msUntilReset: number | null): string {
  if (msUntilReset === null) return '—';
  if (msUntilReset <= 0) return 'now';

  const totalMinutes = Math.floor(msUntilReset / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
