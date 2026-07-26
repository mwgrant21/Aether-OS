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

// Deliberately excludes cacheCreationInputTokens/cacheReadInputTokens. Every
// turn in a conversation re-reads the entire accumulated context from cache,
// so cacheReadInputTokens alone compounds into billions over a real month of
// use (confirmed against this machine's actual ~/.claude/projects data: 4.68B
// cache-read tokens vs. 25.5M input+output) despite representing cheap
// (~10% cost) re-reads of context that already existed, not new work. Input
// + output is the standard "tokens used" definition (actual new work done).
function usageTokens(usage: UsageEventUsage | null): number {
  if (!usage) return 0;
  return usage.inputTokens + usage.outputTokens;
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

// 24 hourly buckets covering the current local calendar day.
export function computeDailyTokens(events: UsageEvent[], now: Date): number[] {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const buckets = new Array(24).fill(0);
  for (const e of events) {
    if (e.kind !== 'assistant' || !e.usage || !e.timestamp) continue;
    if (e.timestamp < dayStart || e.timestamp > now) continue;
    buckets[e.timestamp.getHours()] += usageTokens(e.usage);
  }
  return buckets;
}

// 12 one-minute buckets covering the trailing 12 minutes, oldest first.
export function computeLiveTokens(events: UsageEvent[], now: Date): number[] {
  const buckets = new Array(12).fill(0);
  const windowStart = new Date(now.getTime() - 12 * 60 * 1000);
  for (const e of events) {
    if (e.kind !== 'assistant' || !e.usage || !e.timestamp) continue;
    if (e.timestamp < windowStart || e.timestamp > now) continue;
    const minutesAgo = Math.floor((now.getTime() - e.timestamp.getTime()) / 60000);
    const idx = 11 - minutesAgo;
    if (idx >= 0 && idx < 12) buckets[idx] += usageTokens(e.usage);
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
// Context window fill = the input+cache+output tokens on the most recent
// assistant turn (whichever project/session it belongs to). That single turn's
// usage already reflects the full accumulated context sent to the model, so
// unlike the other compute* functions here this does NOT sum across events.
export function computeContextWindow(events: UsageEvent[], now: Date): number {
  let latest: UsageEvent | null = null;
  for (const e of events) {
    if (e.kind !== 'assistant' || !e.usage || !e.timestamp || e.timestamp > now) continue;
    if (!latest || !latest.timestamp || e.timestamp > latest.timestamp) latest = e;
  }
  if (!latest || !latest.usage) return 0;
  const u = latest.usage;
  return u.inputTokens + u.outputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens;
}

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
