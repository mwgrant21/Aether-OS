import { costForEvent } from '../modelPricing';
import { blendedRateForModel } from '../ledgerMath';
import type { CostSpec } from './spec';

/**
 * Dollar columns for Boards. collector.db stores tokens, never dollars, so
 * cost is added after the query, here, with the same pricing code the Ledger
 * uses. `usd` (exact) and `usdApprox` (estimated) are distinct column names on
 * purpose, mirroring ExactCost/EstimatedCost: a panel can never mix them.
 */
export type Row = Record<string, unknown>;
export const EXACT_COST_COLUMNS = ['model', 'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;

export type CostOutcome = { ok: true; columns: string[]; rows: Row[]; unpricedRows: number } | { ok: false; error: string };

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function exactRowCost(row: Row): number | null {
  // A row with no model is excluded, not priced at a default rate: a
  // default-rate figure is an estimate, and this column claims to be exact.
  if (typeof row.model !== 'string' || row.model === '') return null;
  return costForEvent({
    model: row.model,
    usage: {
      inputTokens: num(row.input_tokens),
      outputTokens: num(row.output_tokens),
      cacheCreationInputTokens: num(row.cache_creation_input_tokens),
      cacheReadInputTokens: num(row.cache_read_input_tokens),
    },
  });
}

function estimatedRowCost(row: Row): number | null {
  if (typeof row.tokens !== 'number' || !Number.isFinite(row.tokens) || row.tokens < 0) return null;
  // dispatches has no model column, so this is always the defaulted tier --
  // the same rate estimateDispatchCost uses for a dispatch with no model.
  return (row.tokens / 1_000_000) * blendedRateForModel(null);
}

export function applyCost(columns: string[], rows: Row[], cost: CostSpec): CostOutcome {
  const required = cost.basis === 'exact' ? [...EXACT_COST_COLUMNS, cost.groupBy] : ['tokens', cost.groupBy];
  const missing = required.filter((c) => !columns.includes(c));
  if (missing.length) return { ok: false, error: `cost.basis "${cost.basis}" needs column(s): ${missing.join(', ')}.` };
  const out = cost.basis === 'exact' ? 'usd' : 'usdApprox';
  const groups = new Map<unknown, number | null>();
  let unpricedRows = 0;
  for (const row of rows) {
    const key = row[cost.groupBy];
    if (!groups.has(key)) groups.set(key, null);
    const value = cost.basis === 'exact' ? exactRowCost(row) : estimatedRowCost(row);
    if (value === null) { unpricedRows++; continue; }
    groups.set(key, (groups.get(key) ?? 0) + value);
  }
  return {
    ok: true,
    columns: [cost.groupBy, out],
    rows: [...groups].map(([k, v]) => ({ [cost.groupBy]: k, [out]: v })),
    unpricedRows,
  };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FILL_DAYS = 4000;

export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Line and bar charts over days: a day with no rows becomes an explicit null
 * row, so a quiet or collector-down day shows as a gap rather than vanishing.
 * Rows whose x is not a YYYY-MM-DD day, or that repeat a day (several series
 * per day), are returned unchanged.
 */
export function fillDailyGaps(x: string, yColumns: string[], rows: Row[], sinceMs: number, nowMs: number): Row[] {
  if (!rows.every((r) => typeof r[x] === 'string' && DAY_RE.test(r[x] as string))) return rows;
  const byDay = new Map(rows.map((r) => [r[x] as string, r]));
  if (byDay.size !== rows.length) return rows;
  const present = [...byDay.keys()].sort();
  const first = sinceMs === 0 ? present[0] : localDay(sinceMs);
  if (!first) return rows;
  const days = new Set(present);
  let d = first;
  for (let n = 0; d <= localDay(nowMs) && n < MAX_FILL_DAYS; n++, d = nextDay(d)) days.add(d);
  return [...days].sort().map((day) => byDay.get(day) ?? { [x]: day, ...Object.fromEntries(yColumns.map((c) => [c, null])) });
}
