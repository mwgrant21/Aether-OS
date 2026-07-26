import { describe, expect, it } from 'vitest';
import { computeWeeklyTokens, computeDailyTokens, computeLiveTokens, computeUsedThisMonth, computeBurnRatePerMin, computeWeekOverWeekPct, computeContextWindow, type UsageEvent } from './realUsageMath';

const NOW = new Date(2026, 0, 7, 12, 0, 0); // Wednesday, Jan 7 2026, noon

function assistantEvent(timestamp: Date, tokens: number): UsageEvent {
  return { kind: 'assistant', timestamp, usage: { inputTokens: tokens, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } };
}

describe('computeWeeklyTokens', () => {
  it('buckets tokens into the correct day of the current Mon-Sun week', () => {
    const events = [
      assistantEvent(new Date(2026, 0, 5, 9, 0), 100), // Monday
      assistantEvent(new Date(2026, 0, 7, 10, 0), 50), // Wednesday
      assistantEvent(new Date(2026, 0, 7, 11, 0), 25), // Wednesday, same bucket
    ];
    expect(computeWeeklyTokens(events, NOW)).toEqual([100, 0, 75, 0, 0, 0, 0]);
  });

  it('returns all zeros for an empty event array', () => {
    expect(computeWeeklyTokens([], NOW)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('ignores non-assistant events and events with no usage', () => {
    const events: UsageEvent[] = [
      { kind: 'user', timestamp: new Date(2026, 0, 7, 9, 0), usage: null },
      { kind: 'assistant', timestamp: new Date(2026, 0, 7, 9, 0), usage: null },
    ];
    expect(computeWeeklyTokens(events, NOW)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('ignores events from outside the current week', () => {
    const events = [assistantEvent(new Date(2025, 11, 29, 9, 0), 100)]; // prior Monday
    expect(computeWeeklyTokens(events, NOW)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('computeDailyTokens', () => {
  it('buckets tokens into the correct hour of the current day', () => {
    const events = [
      assistantEvent(new Date(2026, 0, 7, 9, 15), 100), // 9am
      assistantEvent(new Date(2026, 0, 7, 11, 30), 50), // 11am hour
      assistantEvent(new Date(2026, 0, 7, 11, 45), 25), // 11am hour, same bucket
    ];
    const buckets = computeDailyTokens(events, NOW);
    expect(buckets).toHaveLength(24);
    expect(buckets[9]).toBe(100);
    expect(buckets[11]).toBe(75);
  });

  it('ignores events from a previous day', () => {
    const events = [assistantEvent(new Date(2026, 0, 6, 9, 0), 100)];
    expect(computeDailyTokens(events, NOW)).toEqual(new Array(24).fill(0));
  });
});

describe('computeLiveTokens', () => {
  it('buckets tokens into the correct trailing minute, oldest first', () => {
    const events = [
      assistantEvent(new Date(NOW.getTime() - 0), 10), // this minute -> last bucket
      assistantEvent(new Date(NOW.getTime() - 5 * 60000), 20), // 5 min ago
      assistantEvent(new Date(NOW.getTime() - 11 * 60000), 30), // 11 min ago -> first bucket
    ];
    const buckets = computeLiveTokens(events, NOW);
    expect(buckets).toHaveLength(12);
    expect(buckets[11]).toBe(10);
    expect(buckets[6]).toBe(20);
    expect(buckets[0]).toBe(30);
  });

  it('ignores events older than the 12-minute window', () => {
    const events = [assistantEvent(new Date(NOW.getTime() - 13 * 60000), 100)];
    expect(computeLiveTokens(events, NOW)).toEqual(new Array(12).fill(0));
  });
});

describe('computeUsedThisMonth', () => {
  it('sums tokens since the start of the current month', () => {
    const events = [assistantEvent(new Date(2026, 0, 1, 0, 0), 200), assistantEvent(new Date(2026, 0, 7, 9, 0), 300)];
    expect(computeUsedThisMonth(events, NOW)).toBe(500);
  });

  it('excludes tokens from the previous month', () => {
    const events = [assistantEvent(new Date(2025, 11, 31, 23, 59), 999), assistantEvent(new Date(2026, 0, 7, 9, 0), 100)];
    expect(computeUsedThisMonth(events, NOW)).toBe(100);
  });

  it('returns 0 for an empty event array', () => {
    expect(computeUsedThisMonth([], NOW)).toBe(0);
  });

  it('excludes cacheCreationInputTokens and cacheReadInputTokens from the total', () => {
    const events: UsageEvent[] = [
      {
        kind: 'assistant',
        timestamp: new Date(2026, 0, 7, 9, 0),
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 10_000, cacheReadInputTokens: 5_000_000 },
      },
    ];
    expect(computeUsedThisMonth(events, NOW)).toBe(150);
  });
});

describe('computeBurnRatePerMin', () => {
  it('averages tokens from the last 10 minutes over 10 minutes', () => {
    const events = [assistantEvent(new Date(NOW.getTime() - 5 * 60 * 1000), 100)];
    expect(computeBurnRatePerMin(events, NOW)).toBe(10);
  });

  it('excludes tokens older than the 10-minute window', () => {
    const events = [assistantEvent(new Date(NOW.getTime() - 15 * 60 * 1000), 1000)];
    expect(computeBurnRatePerMin(events, NOW)).toBe(0);
  });

  it('returns 0 for an empty event array', () => {
    expect(computeBurnRatePerMin([], NOW)).toBe(0);
  });
});

describe('computeWeekOverWeekPct', () => {
  it('returns null when there is no prior-week data to compare against', () => {
    const events = [assistantEvent(new Date(2026, 0, 7, 9, 0), 100)];
    expect(computeWeekOverWeekPct(events, NOW)).toBeNull();
  });

  it('computes a positive percent change when this week is higher', () => {
    const events = [
      assistantEvent(new Date(2025, 11, 31, 9, 0), 100), // last Wed (same relative point)
      assistantEvent(new Date(2026, 0, 7, 9, 0), 150), // this Wed
    ];
    expect(computeWeekOverWeekPct(events, NOW)).toBe(50);
  });

  it('computes a negative percent change when this week is lower', () => {
    const events = [assistantEvent(new Date(2025, 11, 31, 9, 0), 200), assistantEvent(new Date(2026, 0, 7, 9, 0), 100)];
    expect(computeWeekOverWeekPct(events, NOW)).toBe(-50);
  });
});

describe('computeContextWindow', () => {
  it('returns 0 when there are no assistant events', () => {
    expect(computeContextWindow([], NOW)).toBe(0);
  });

  it('returns the full usage total of the most recent assistant turn, not a sum across turns', () => {
    const events = [
      assistantEvent(new Date(2026, 0, 7, 10, 0), 5000),
      assistantEvent(new Date(2026, 0, 7, 11, 0), 8000),
    ];
    expect(computeContextWindow(events, NOW)).toBe(8000);
  });

  it('sums input, output, and cache tokens on the latest turn', () => {
    const events: UsageEvent[] = [
      {
        kind: 'assistant',
        timestamp: new Date(2026, 0, 7, 11, 30),
        usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 20, cacheReadInputTokens: 30 },
      },
    ];
    expect(computeContextWindow(events, NOW)).toBe(200);
  });

  it('ignores events after "now" and non-assistant events', () => {
    const events: UsageEvent[] = [
      assistantEvent(new Date(2026, 0, 7, 9, 0), 4000),
      { kind: 'assistant', timestamp: new Date(2026, 0, 7, 13, 0), usage: { inputTokens: 9999, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
      { kind: 'user', timestamp: new Date(2026, 0, 7, 11, 0), usage: null },
    ];
    expect(computeContextWindow(events, NOW)).toBe(4000);
  });
});
