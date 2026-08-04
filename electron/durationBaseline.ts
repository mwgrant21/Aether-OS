// Per-subagent-type rolling duration baseline, in-memory, session-lifetime
// only. Feeds narrationGenerator.ts's medianMsAtEval so severity can react
// to "this run took much longer than usual for this task kind" (spec §4's
// median_ms_at_eval snapshot), instead of the hardcoded null this stage
// shipped with. Deliberately not persisted or shared with the collector's
// own SQLite telemetry (a separate, already-named gap) -- Phase 1 only
// needs a baseline that improves as the current session runs, matching how
// STEWARD's own baselines are described in spec §8 as runtime telemetry,
// not cross-session memory.
const MAX_SAMPLES_PER_KEY = 20;

export interface DurationBaseline {
  samplesByKey: Map<string, number[]>;
}

export function createDurationBaseline(): DurationBaseline {
  return { samplesByKey: new Map() };
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Snapshot BEFORE recording this run's own duration -- a run must never be
// compared against a baseline it has already contributed to, or every run
// looks nominal relative to itself.
export function getMedianMs(baseline: DurationBaseline, key: string): number | null {
  const samples = baseline.samplesByKey.get(key);
  if (!samples || samples.length === 0) return null;
  return median([...samples].sort((a, b) => a - b));
}

export function recordDuration(baseline: DurationBaseline, key: string, durationMs: number): void {
  const samples = baseline.samplesByKey.get(key) ?? [];
  samples.push(durationMs);
  if (samples.length > MAX_SAMPLES_PER_KEY) samples.shift();
  baseline.samplesByKey.set(key, samples);
}
