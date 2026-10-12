// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createFixtureCollectorDb } from './collectorDb.fixture';
import { evaluatePanel } from './evaluatePanel';
import type { PanelSpec } from '../../src/shared/dashboards/spec';

const now = Date.now();
const DAILY_EXACT = `SELECT date(occurred_at_ms/1000,'unixepoch','localtime') AS day, model,
  SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
  SUM(cache_creation_input_tokens) AS cache_creation_input_tokens, SUM(cache_read_input_tokens) AS cache_read_input_tokens
  FROM usage_events WHERE occurred_at_ms >= :since GROUP BY day, model`;
const spend: PanelSpec = { id: 'spend', title: 'Spend', type: 'line', sql: DAILY_EXACT, range: '7d', x: 'day', y: ['usd'], cost: { basis: 'exact', groupBy: 'day' } };

describe('evaluatePanel', () => {
  it('produces usd per day, fills empty days with null, counts unpriced rows', async () => {
    const r = await evaluatePanel(spend, { dbPath: createFixtureCollectorDb(now), nowMs: now, rowCap: 1000 });
    expect(r.error).toBeNull();
    expect(r.columns).toEqual(['day', 'usd']);
    expect(r.rows.length).toBe(8); // 7 days back through today
    expect(r.rows.filter((row) => row.usd === null).length).toBe(6);
    expect(r.unpricedRows).toBe(1);
  });

  it('refuses a cost panel whose result was truncated (Review Focus 1)', async () => {
    const raw: PanelSpec = { ...spend, sql: "SELECT date(occurred_at_ms/1000,'unixepoch','localtime') AS day, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens FROM usage_events" };
    const r = await evaluatePanel(raw, { dbPath: createFixtureCollectorDb(now), nowMs: now, rowCap: 2 });
    expect(r.errorKind).toBe('cost');
    expect(r.error).toContain('GROUP BY');
    expect(r.rows).toEqual([]);
  });

  it('names missing x/y columns', async () => {
    const bad: PanelSpec = { id: 'b', title: 'B', type: 'bar', sql: 'SELECT tool_name FROM tool_calls', range: '7d', x: 'tool_name', y: ['calls'] };
    const r = await evaluatePanel(bad, { dbPath: createFixtureCollectorDb(now), nowMs: now, rowCap: 1000 });
    expect(r.errorKind).toBe('columns');
    expect(r.error).toContain('calls');
  });

  it('passes runner errors through and honours rangeOverride', async () => {
    const dbPath = createFixtureCollectorDb(now);
    const guard = await evaluatePanel({ ...spend, sql: 'DROP TABLE usage_events' }, { dbPath, nowMs: now, rowCap: 1000 });
    expect(guard.errorKind).toBe('guard');
    const all = await evaluatePanel({ id: 't', title: 'T', type: 'table', sql: 'SELECT COUNT(*) AS n FROM usage_events WHERE occurred_at_ms >= :since', range: '24h' },
      { dbPath, nowMs: now, rowCap: 1000, rangeOverride: 'all' });
    expect(all.rows[0].n).toBe(3);
  });
});
