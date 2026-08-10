import { describe, it, expect } from 'vitest';
import { chooseUsageSource, COLLECTOR_LAG_GRACE_MS } from './collectorFreshness';

const at = (iso: string) => ({ timestamp: new Date(iso) });
const ms = (iso: string) => new Date(iso).getTime();

describe('chooseUsageSource', () => {
  it('falls back to the transcript scan when the collector store is unreadable', () => {
    // readUsageEventsSince returns null for an absent DB or a schema older
    // than MIN_SCHEMA_VERSION_FOR_USAGE_EVENTS -- pre-existing behavior.
    expect(chooseUsageSource(null, ms('2026-08-10T09:00:00Z'))).toBe('scan');
  });

  it('falls back to the transcript scan when the collector has stopped writing', () => {
    // The reported defect: a collector that died 11 days ago still returns
    // thousands of in-window rows, so a null check alone keeps trusting it
    // and every current-month tile renders 0.
    const stale = [at('2026-07-28T00:00:00Z'), at('2026-07-30T00:17:02Z')];
    expect(chooseUsageSource(stale, ms('2026-08-10T09:00:00Z'))).toBe('scan');
  });

  it('falls back to the transcript scan when the collector is installed but has no rows', () => {
    expect(chooseUsageSource([], ms('2026-08-10T09:00:00Z'))).toBe('scan');
  });

  it('uses the collector when it is merely lagging the transcripts by less than the grace window', () => {
    // The collector tails incrementally, so it is always slightly behind a
    // transcript being written right now. That is not staleness.
    const newestTranscript = ms('2026-08-10T09:00:00Z');
    const lagging = [at(new Date(newestTranscript - COLLECTOR_LAG_GRACE_MS / 2).toISOString())];
    expect(chooseUsageSource(lagging, newestTranscript)).toBe('collector');
  });

  it('uses the collector when there are no transcripts at all to be behind of', () => {
    const events = [at('2026-08-10T09:00:00Z')];
    expect(chooseUsageSource(events, null)).toBe('collector');
  });

  it('uses the collector when its newest row is ahead of the newest transcript mtime', () => {
    // Clock skew or a transcript rewritten with an older mtime must not be
    // read as the collector being behind.
    const events = [at('2026-08-10T09:05:00Z')];
    expect(chooseUsageSource(events, ms('2026-08-10T09:00:00Z'))).toBe('collector');
  });

  it('reads the newest row regardless of the order rows come back from SQLite', () => {
    // The SELECT carries no ORDER BY, so freshness must not assume row order.
    const newestTranscript = ms('2026-08-10T09:00:00Z');
    const unordered = [
      at('2026-07-01T00:00:00Z'),
      at(new Date(newestTranscript - 1000).toISOString()),
      at('2026-07-15T00:00:00Z'),
    ];
    expect(chooseUsageSource(unordered, newestTranscript)).toBe('collector');
  });
});
