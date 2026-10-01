// electron/severity/baselineMath.ts
// Pure duration-baseline rules shared by the live store and the collector's
// median query. Spec section 6: only completed outcomes with a usage block and
// durationMs > 0 are admitted; last 20 per key; below 5 samples there is no
// median (null) and so no slowness bump.
//
// SOURCE OF TRUTH for collector/src/severity/baselineMath.ts (generated).

import type { DispatchOutcome } from './parseDispatchOutcome';

export const BASELINE_MIN_SAMPLES = 5;
export const BASELINE_WINDOW = 20;

export function isAdmissibleSample(outcome: DispatchOutcome): boolean {
  const d = outcome.usage?.durationMs;
  return outcome.status === 'completed' && typeof d === 'number' && Number.isFinite(d) && d > 0;
}

// samples: oldest first.
export function medianOf(samples: readonly number[]): number | null {
  const valid = samples.filter((n) => Number.isFinite(n) && n > 0).slice(-BASELINE_WINDOW);
  if (valid.length < BASELINE_MIN_SAMPLES) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
