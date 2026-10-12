// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureCollectorDb } from './collectorDb.fixture';
import { DATA_TOOLS, handleDataTool, type DataServerDeps } from './dataServer';

const now = Date.now();
function deps(): DataServerDeps {
  return { dbPath: createFixtureCollectorDb(now), dashboardsDir: join(mkdtempSync(join(tmpdir(), 'aether-boards-dir-')), 'dashboards'), now: () => now };
}
const tablePanel = { id: 'calls', title: 'Calls', type: 'table', sql: 'SELECT tool_name, COUNT(*) AS calls FROM tool_calls GROUP BY tool_name', range: '7d' };

describe('aether-data tools', () => {
  it('lists exactly the four tools', () => {
    expect(DATA_TOOLS.map((t) => t.name)).toEqual(['describe_schema', 'run_query', 'save_dashboard', 'update_chart']);
  });

  it('describe_schema lists tables, row counts and the known gaps', async () => {
    const r = await handleDataTool('describe_schema', {}, deps());
    const body = JSON.parse(r.text);
    expect(r.isError).toBe(false);
    expect(body.tables.find((t: { name: string }) => t.name === 'usage_events')).toMatchObject({ rows: 3 });
    expect(body.knownGaps.join(' ')).toContain('project');
    const toolCalls = body.tables.find((t: { name: string }) => t.name === 'tool_calls');
    expect(toolCalls.columns.find((c: { name: string }) => c.name === 'file_path_rel')).toMatchObject({ blocked: true });
  });

  it('run_query refuses path columns', async () => {
    const r = await handleDataTool('run_query', { sql: 'SELECT file_path_rel FROM tool_calls' }, deps());
    expect(r.isError).toBe(true);
    expect(r.text).toContain('blocked');
  });

  it('describe_schema without a collector db says so', async () => {
    const d = { ...deps(), dbPath: join(tmpdir(), 'missing-aether-collector.db') };
    const r = await handleDataTool('describe_schema', {}, d);
    expect(r.text).toContain('No collector data');
  });

  it('run_query returns rows and applies cost when asked', async () => {
    const d = deps();
    const plain = JSON.parse((await handleDataTool('run_query', { sql: 'SELECT COUNT(*) AS n FROM usage_events' }, d)).text);
    expect(plain.rows).toEqual([{ n: 3 }]);
    const costed = JSON.parse((await handleDataTool('run_query', {
      sql: 'SELECT model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_creation_input_tokens) AS cache_creation_input_tokens, SUM(cache_read_input_tokens) AS cache_read_input_tokens FROM usage_events GROUP BY model',
      cost: { basis: 'exact', groupBy: 'model' },
    }, d)).text);
    expect(costed.columns).toEqual(['model', 'usd']);
    expect(costed.unpricedRows).toBe(1);
  });

  it('run_query reports guard rejections as errors', async () => {
    const r = await handleDataTool('run_query', { sql: 'DELETE FROM usage_events' }, deps());
    expect(r.isError).toBe(true);
  });

  it('save_dashboard writes a valid board atomically', async () => {
    const d = deps();
    const r = await handleDataTool('save_dashboard', { spec: { version: 1, id: 'mine', title: 'Mine', panels: [tablePanel] } }, d);
    expect(r.isError).toBe(false);
    expect(JSON.parse(readFileSync(join(d.dashboardsDir, 'mine.json'), 'utf8')).panels[0].id).toBe('calls');
  });

  it('save_dashboard writes nothing when any panel fails its dry run', async () => {
    const d = deps();
    const r = await handleDataTool('save_dashboard', { spec: { version: 1, id: 'mine', title: 'Mine', panels: [tablePanel, { ...tablePanel, id: 'bad', sql: 'SELECT nope FROM tool_calls' }] } }, d);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('bad');
    let files: string[] = [];
    try { files = readdirSync(d.dashboardsDir); } catch { /* dir never created */ }
    expect(files.filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('update_chart merges a patch into one panel, and appends an unknown panel id', async () => {
    const d = deps();
    await handleDataTool('save_dashboard', { spec: { version: 1, id: 'mine', title: 'Mine', panels: [tablePanel] } }, d);
    const r1 = await handleDataTool('update_chart', { dashboardId: 'mine', panelId: 'calls', patch: { title: 'Renamed', id: 'ignored' } }, d);
    expect(r1.isError).toBe(false);
    const r2 = await handleDataTool('update_chart', { dashboardId: 'mine', panelId: 'n', patch: { title: 'Count', type: 'table', sql: 'SELECT COUNT(*) AS n FROM usage_events' } }, d);
    expect(r2.isError).toBe(false);
    const saved = JSON.parse(readFileSync(join(d.dashboardsDir, 'mine.json'), 'utf8'));
    expect(saved.panels.map((p: { id: string; title: string }) => [p.id, p.title])).toEqual([['calls', 'Renamed'], ['n', 'Count']]);
  });

  it('update_chart on a missing board points at save_dashboard', async () => {
    const r = await handleDataTool('update_chart', { dashboardId: 'nope', panelId: 'p', patch: {} }, deps());
    expect(r.isError).toBe(true);
    expect(r.text).toContain('save_dashboard');
  });

  it('update_chart reports a corrupt board file instead of throwing', async () => {
    const d = deps();
    await handleDataTool('save_dashboard', { spec: { version: 1, id: 'mine', title: 'Mine', panels: [tablePanel] } }, d);
    writeFileSync(join(d.dashboardsDir, 'mine.json'), '{ not json');
    const r = await handleDataTool('update_chart', { dashboardId: 'mine', panelId: 'calls', patch: { title: 'x' } }, d);
    expect(r.isError).toBe(true);
  });

  it('describe_schema omits transcript_files and still counts the other tables', async () => {
    const body = JSON.parse((await handleDataTool('describe_schema', {}, deps())).text);
    expect(body.tables.map((t: { name: string }) => t.name)).not.toContain('transcript_files');
    expect(body.tables.find((t: { name: string }) => t.name === 'usage_events')).toMatchObject({ rows: 3 });
  });

  it('save_dashboard failures carry no absolute path', async () => {
    const d = deps();
    mkdirSync(join(d.dashboardsDir, '..'), { recursive: true });
    writeFileSync(d.dashboardsDir, 'in the way');
    const r = await handleDataTool('save_dashboard', { spec: { version: 1, id: 'mine', title: 'Mine', panels: [tablePanel] } }, d);
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain(tmpdir());
    expect(r.text).not.toContain(d.dashboardsDir);
  });

  it('run_query rejects a malformed cost', async () => {
    const d = deps();
    for (const cost of [{ basis: 'bogus', groupBy: 'model' }, null]) {
      const r = await handleDataTool('run_query', { sql: 'SELECT COUNT(*) AS n FROM usage_events', cost }, d);
      expect(r.isError).toBe(true);
      expect(r.text).toContain('cost must be');
    }
  });

  it('concurrent update_chart calls on one board keep both edits', async () => {
    const d = deps();
    const second = { ...tablePanel, id: 'second', title: 'Second' };
    await handleDataTool('save_dashboard', { spec: { version: 1, id: 'mine', title: 'Mine', panels: [tablePanel, second] } }, d);
    const [a, b] = await Promise.all([
      handleDataTool('update_chart', { dashboardId: 'mine', panelId: 'calls', patch: { title: 'A' } }, d),
      handleDataTool('update_chart', { dashboardId: 'mine', panelId: 'second', patch: { title: 'B' } }, d),
    ]);
    expect([a.isError, b.isError]).toEqual([false, false]);
    const saved = JSON.parse(readFileSync(join(d.dashboardsDir, 'mine.json'), 'utf8'));
    expect(saved.panels.map((p: { title: string }) => p.title)).toEqual(['A', 'B']);
  });
});
