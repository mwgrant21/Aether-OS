import { runQuery } from './runQuery';
import { applyCost, fillDailyGaps } from '../../src/shared/dashboards/costing';
import { sinceForRange, type PanelSpec, type Range } from '../../src/shared/dashboards/spec';
import type { PanelResult } from '../../src/shared/dashboards/types';

export interface EvalContext {
  dbPath: string; nowMs: number; rowCap: number; rangeOverride?: Range; timeoutMs?: number; busyTimeoutMs?: number;
}

/** One panel, start to finish. Shared by refresh (main) and the save dry-run (MCP server) so they cannot disagree. */
export async function evaluatePanel(panel: PanelSpec, ctx: EvalContext): Promise<PanelResult> {
  const since = sinceForRange(ctx.rangeOverride ?? panel.range, ctx.nowMs);
  const fail = (errorKind: NonNullable<PanelResult['errorKind']>, error: string): PanelResult => ({
    panelId: panel.id, columns: [], rows: [], truncated: false, unpricedRows: 0, error, errorKind, refreshedAt: ctx.nowMs,
  });

  const q = await runQuery({ dbPath: ctx.dbPath, sql: panel.sql, since, rowCap: ctx.rowCap, timeoutMs: ctx.timeoutMs, busyTimeoutMs: ctx.busyTimeoutMs });
  if (!q.ok) return fail(q.kind, q.error);

  let { columns, rows } = q;
  let unpricedRows = 0;
  if (panel.cost) {
    // A dollar total over a truncated result is a wrong number that looks right.
    if (q.truncated) {
      return fail('cost', `Cost needs every row, but the query returned more than ${ctx.rowCap}. Aggregate in SQL: GROUP BY ${panel.cost.groupBy}${panel.cost.basis === 'exact' ? ', model' : ''} with SUM() of the token columns.`);
    }
    const c = applyCost(columns, rows, panel.cost);
    if (!c.ok) return fail('cost', c.error);
    ({ columns, rows, unpricedRows } = c);
  }

  const needed = panel.type === 'table' ? [] : [...(panel.x ? [panel.x] : []), ...(panel.y ?? [])];
  const missing = needed.filter((c) => !columns.includes(c));
  if (missing.length) {
    return fail('columns', `Column(s) not in the result: ${missing.join(', ')}. The result has: ${columns.join(', ') || '(no columns)'}.`);
  }
  if ((panel.type === 'line' || panel.type === 'bar') && panel.x) rows = fillDailyGaps(panel.x, panel.y ?? [], rows, since, ctx.nowMs);
  return { panelId: panel.id, columns, rows, truncated: q.truncated, unpricedRows, error: null, errorKind: null, refreshedAt: ctx.nowMs };
}
