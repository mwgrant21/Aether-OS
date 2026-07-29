import type { LiveAgentTick } from './liveAgentTracker';
import type { CompletedDispatchUsage } from '../src/state/liveAgentsMath';

export interface RecapEntry {
  kind: 'dispatchCompleted' | 'anomalyDetected' | 'anomalyCleared';
  detail: string;
  atMs: number;
}

export interface RecapAccumulator {
  entries: RecapEntry[];
  tokensBurned: number;
}

export function createEmptyAccumulator(): RecapAccumulator {
  return { entries: [], tokensBurned: 0 };
}

function completedEntry(d: CompletedDispatchUsage, atMs: number): RecapEntry {
  return { kind: 'dispatchCompleted', detail: `${d.subagentType}: ${d.description}`, atMs };
}

// Diffs two consecutive tick() results and folds any newly-observable
// dispatch completions / anomaly transitions into the running accumulator.
// Pure -- callers (main.ts) are responsible for only invoking this while
// !isWindowFocused, and for resetting the accumulator on refocus.
export function accumulate(
  prevAcc: RecapAccumulator,
  nextTick: LiveAgentTick,
  prevTick: LiveAgentTick,
  nowMs: number
): RecapAccumulator {
  const entries = [...prevAcc.entries];
  let tokensBurned = prevAcc.tokensBurned;

  // completed[] is cumulative per liveAgentTracker's own contract (each tick
  // carries dispatches completed since the tracker started, not just this
  // tick) -- diff by toolUseId membership, not array length.
  const prevCompletedIds = new Set(prevTick.completed.map((d) => d.toolUseId));
  for (const d of nextTick.completed) {
    if (!prevCompletedIds.has(d.toolUseId)) {
      entries.push(completedEntry(d, nowMs));
      tokensBurned += d.tokens;
    }
  }

  const prevAnomalyIds = new Map(prevTick.anomalies.map((a) => [a.toolUseId, a] as const));
  const nextAnomalyIds = new Map(nextTick.anomalies.map((a) => [a.toolUseId, a] as const));
  for (const [id, a] of nextAnomalyIds) {
    if (!prevAnomalyIds.has(id)) entries.push({ kind: 'anomalyDetected', detail: a.detail, atMs: nowMs });
  }
  for (const [id, a] of prevAnomalyIds) {
    if (!nextAnomalyIds.has(id)) entries.push({ kind: 'anomalyCleared', detail: a.detail, atMs: nowMs });
  }

  return { entries, tokensBurned };
}
