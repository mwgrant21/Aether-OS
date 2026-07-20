export interface UsageEventUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface UsageEvent {
  kind: 'assistant' | 'user' | 'other';
  timestamp: Date | null;
  usage: UsageEventUsage | null;
}

const BURN_WINDOW_MIN = 10;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function usageTokens(usage: UsageEventUsage | null): number {
  if (!usage) return 0;
  return usage.inputTokens + usage.outputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
}

function mondayOf(d: Date): Date {
  const dayOfWeek = d.getDay(); // 0=Sun..6=Sat
  const offset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
}

export function computeWeeklyTokens(events: UsageEvent[], now: Date): number[] {
  const monday = mondayOf(now);
  const buckets = [0, 0, 0, 0, 0, 0, 0];
  for (const e of events) {
    if (e.kind !== 'assistant' || !e.usage || !e.timestamp) continue;
    for (let i = 0; i < 7; i++) {
      const bucketStart = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
      const bucketEnd = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i + 1);
      if (e.timestamp >= bucketStart && e.timestamp < bucketEnd) {
        buckets[i] += usageTokens(e.usage);
        break;
      }
    }
  }
  return buckets;
}

export function computeUsedThisMonth(events: UsageEvent[], now: Date): number {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  let total = 0;
  for (const e of events) {
    if (e.kind !== 'assistant' || !e.usage || !e.timestamp) continue;
    if (e.timestamp >= monthStart && e.timestamp <= now) total += usageTokens(e.usage);
  }
  return total;
}

export function computeBurnRatePerMin(events: UsageEvent[], now: Date): number {
  const windowStart = new Date(now.getTime() - BURN_WINDOW_MIN * 60 * 1000);
  let total = 0;
  for (const e of events) {
    if (e.kind !== 'assistant' || !e.usage || !e.timestamp) continue;
    if (e.timestamp >= windowStart && e.timestamp <= now) total += usageTokens(e.usage);
  }
  return total / BURN_WINDOW_MIN;
}

// Compares this week-so-far against the SAME partial period last week (not
// last week's full total), so a mid-week check doesn't read as a misleading
// "down 80%" just because the current week isn't over yet.
export function computeWeekOverWeekPct(events: UsageEvent[], now: Date): number | null {
  const thisMonday = mondayOf(now);
  const lastMonday = new Date(thisMonday.getTime() - WEEK_MS);
  const lastSamePoint = new Date(lastMonday.getTime() + (now.getTime() - thisMonday.getTime()));

  let thisWeekTotal = 0;
  let lastWeekTotal = 0;
  for (const e of events) {
    if (e.kind !== 'assistant' || !e.usage || !e.timestamp) continue;
    const t = e.timestamp;
    if (t >= thisMonday && t <= now) thisWeekTotal += usageTokens(e.usage);
    else if (t >= lastMonday && t <= lastSamePoint) lastWeekTotal += usageTokens(e.usage);
  }
  if (lastWeekTotal === 0) return null;
  return Math.round(((thisWeekTotal - lastWeekTotal) / lastWeekTotal) * 100);
}
