import type { TranscriptEvent } from '../../electron/transcriptParser';

// Same formula shape as liveAgentTracker.ts's own session-level cacheHitRatio
// (cumulativeCacheRead / (cumulativeInput + cumulativeCacheRead), where
// "input" is e.usage.inputTokens only, not cacheCreationInputTokens) so the
// Optimize panel's "Context hygiene" row and the reactor's live cache
// visualization never disagree over what "cache hit rate" means -- they
// differ only in scope (all-time historical events here vs. the live
// session there), not in definition.
export function computeCacheHitRate(events: TranscriptEvent[]): number {
  let totalCacheRead = 0;
  let totalInput = 0;
  for (const e of events) {
    if (!e.usage) continue;
    totalCacheRead += e.usage.cacheReadInputTokens;
    totalInput += e.usage.inputTokens;
  }
  return totalInput + totalCacheRead > 0 ? totalCacheRead / (totalInput + totalCacheRead) : 0;
}
