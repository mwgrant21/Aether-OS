import type { Agent, LogEntry, SysMetric } from '../../state/types';

export interface AgentBreakdownRow {
  name: string;
  hue: string;
  pct: number;
  hist: number[];
}

export function computeAgentBreakdown(agents: Agent[]): AgentBreakdownRow[] {
  return [...agents]
    .sort((a, b) => b.share - a.share)
    .map((a) => ({ name: a.name, hue: a.hue, pct: Math.round(a.share * 100), hist: a.hist }));
}

export interface CommandFrequency {
  name: string;
  count: number;
}

export function computeTopCommands(cmdHist: string[], limit = 5): CommandFrequency[] {
  const counts = new Map<string, number>();
  for (const raw of cmdHist) {
    const word = raw.trim().split(/\s+/)[0]?.toLowerCase();
    if (!word) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

export interface SysMetricStats {
  label: string;
  val: number;
  hist: number[];
  min: number;
  max: number;
  avg: number;
}

export function computeSysMetricStats(sys: SysMetric[]): SysMetricStats[] {
  return sys.map((m) => ({
    label: m.label,
    val: m.val,
    hist: m.hist,
    min: Math.min(...m.hist),
    max: Math.max(...m.hist),
    avg: m.hist.reduce((sum, v) => sum + v, 0) / m.hist.length,
  }));
}

export interface LogFrequencyRow {
  color: string;
  label: string;
  count: number;
}

const LOG_BUCKETS: { color: string; label: string }[] = [
  { color: '#3be0a0', label: 'Success' },
  { color: '#7fd8ef', label: 'Info' },
  { color: '#ff9d9d', label: 'Denied' },
  { color: '#5f8a97', label: 'Other' },
];

export function computeLogFrequency(logs: LogEntry[]): LogFrequencyRow[] {
  const known = new Set(LOG_BUCKETS.slice(0, 3).map((b) => b.color));
  const counts = new Map<string, number>(LOG_BUCKETS.map((b) => [b.color, 0]));
  for (const log of logs) {
    const key = known.has(log.c) ? log.c : '#5f8a97';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return LOG_BUCKETS.map((b) => ({ ...b, count: counts.get(b.color) ?? 0 }));
}
