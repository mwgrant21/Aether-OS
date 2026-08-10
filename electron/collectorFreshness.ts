/**
 * Decides whether the collector's usage_events store is fresh enough to back
 * the dashboard tiles, or whether they must fall back to a full transcript
 * scan.
 *
 * See docs/roadmap.md Stage 3: the collector is the preferred source and the
 * 60s scan is the fallback, taken "only when the collector hasn't run yet,
 * isn't installed, or predates this schema". A collector that ran and then
 * STOPPED belongs in that same list -- a null check alone cannot see it,
 * because a dead collector still returns every row it wrote before it died.
 *
 * Staleness is measured against the transcripts on disk rather than against a
 * fixed age, so a genuinely idle machine (no new transcripts, no new rows) is
 * never mistaken for a dead collector.
 */

/**
 * The collector tails incrementally, so its newest row always trails a
 * transcript being appended right now. Only a lag beyond this window means it
 * has stopped rather than merely caught mid-write.
 */
export const COLLECTOR_LAG_GRACE_MS = 5 * 60 * 1000;

export type UsageSource = 'collector' | 'scan';

export function chooseUsageSource(
  collectorEvents: { timestamp: Date }[] | null,
  newestTranscriptMs: number | null,
  graceMs: number = COLLECTOR_LAG_GRACE_MS,
): UsageSource {
  // Absent DB, or a schema predating usage_events.
  if (collectorEvents === null) return 'scan';

  // No transcripts on disk: there is nothing for the collector to be behind
  // of, and a full scan would find nothing either.
  if (newestTranscriptMs === null) return 'collector';

  // The SELECT carries no ORDER BY -- never assume row order.
  let newestCollectorMs: number | null = null;
  for (const e of collectorEvents) {
    const t = e.timestamp.getTime();
    if (newestCollectorMs === null || t > newestCollectorMs) newestCollectorMs = t;
  }

  // Installed, readable, current schema -- and empty. The collector has not
  // run, which is exactly the documented fallback case.
  if (newestCollectorMs === null) return 'scan';

  return newestCollectorMs + graceMs < newestTranscriptMs ? 'scan' : 'collector';
}
