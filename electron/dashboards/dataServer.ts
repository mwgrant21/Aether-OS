import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomically } from '../atomicWrite';
import { runQuery } from './runQuery';
import { evaluatePanel } from './evaluatePanel';
import { applyCost } from '../../src/shared/dashboards/costing';
import { ID_PATTERN, isBoardId, RANGES, sinceForRange, validateSpec, type CostSpec, type Range } from '../../src/shared/dashboards/spec';
import { BLOCKED_COLUMNS, RENDER_ROW_CAP, TOOL_ROW_CAP } from '../../src/shared/dashboards/queryGuard';
import { STARTER_BOARDS } from '../../src/shared/dashboards/starters';

export interface DataServerDeps { dbPath: string; dashboardsDir: string; now: () => number }
export interface ToolReply { text: string; isError: boolean }

export const KNOWN_GAPS = [
  'collector.db stores tokens, never dollars. Request dollars with a panel "cost" ({ basis: "exact", groupBy } on model + the four token columns -> usd; { basis: "estimated", groupBy } on a tokens column -> usdApprox). Never compute prices in SQL.',
  'usage_events has no project or session column: spend by project or session is not possible.',
  'dispatches.task_kind (and agent_id) is the subagent type, so "which subagent" works; dispatches has no model, so dispatch cost is always a blended-tier estimate.',
  'Cost panels need every row: aggregate in SQL (GROUP BY <groupBy>, model with SUM() of the token columns) so the result stays under 1000 rows.',
  'Path and path-bearing columns (file_path_rel, project_rel_path, file_path, source_file_rel, detail) are blocked, and "*" is allowed only as COUNT(*): name the columns you need.',
];
const NO_COLLECTOR = 'No collector data: ~/.aether-os/collector.db does not exist. The operator must start the collector (collector/README.md).';
const NOTES = [
  'All *_ms columns are epoch milliseconds. Use :since (epoch ms, bound from the panel range) e.g. WHERE occurred_at_ms >= :since.',
  "Group by day with date(<col>_ms/1000,'unixepoch','localtime') AS day; day columns get gap-filled on line/bar charts.",
  'Columns named *_rate render as percentages. usd renders as $x.xx, usdApprox as ~$x.xx.',
  'Panel types: line, bar (x + one or more y), stat (exactly one y, no x), table (all columns). Ranges: 24h, 7d, 30d, 90d, all (default 30d).',
];

const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const costSchema = { type: 'object' as const, properties: { basis: { type: 'string' as const, enum: ['exact', 'estimated'] }, groupBy: { type: 'string' as const } }, required: ['basis', 'groupBy'], additionalProperties: false };

export const DATA_TOOLS = [
  { name: 'describe_schema', description: 'Describe the Aether collector database: tables, columns, row counts, known gaps, and the board file format with an example. Call this first.',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false }, annotations: { ...annotations, readOnlyHint: true } },
  { name: 'run_query', description: 'Run one read-only SELECT/WITH query against collector.db and return up to 200 rows. Optional range binds :since; optional cost adds a usd or usdApprox column exactly as a panel would.',
    inputSchema: { type: 'object' as const, properties: { sql: { type: 'string' as const }, range: { type: 'string' as const, enum: [...RANGES] }, cost: costSchema }, required: ['sql'], additionalProperties: false },
    annotations: { ...annotations, readOnlyHint: true } },
  { name: 'save_dashboard', description: 'Validate a whole board, dry-run every panel, and save it to the Boards tab (overwrites the same id). Writes nothing if any panel fails; returns per-panel errors to fix.',
    inputSchema: { type: 'object' as const, properties: { spec: { type: 'object' as const } }, required: ['spec'], additionalProperties: false }, annotations },
  { name: 'update_chart', description: 'Change one panel of an existing board by merging patch into it (a new panelId appends a panel), then validate, dry-run and save like save_dashboard.',
    inputSchema: { type: 'object' as const, properties: { dashboardId: { type: 'string' as const }, panelId: { type: 'string' as const }, patch: { type: 'object' as const } }, required: ['dashboardId', 'panelId', 'patch'], additionalProperties: false },
    annotations },
];

const reply = (body: unknown, isError = false): ToolReply => ({ text: typeof body === 'string' ? body : JSON.stringify(body, null, 2), isError });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function describeSchema(deps: DataServerDeps): Promise<ToolReply> {
  if (!existsSync(deps.dbPath)) return reply(NO_COLLECTOR);
  const cols = await runQuery({ dbPath: deps.dbPath, since: 0, rowCap: RENDER_ROW_CAP,
    sql: "SELECT m.name AS tbl, p.name AS col, p.type AS type FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name <> 'transcript_files' ORDER BY m.name, p.cid" });
  if (!cols.ok) return reply(cols.error, true);
  const tables = new Map<string, { name: string; type: string; blocked?: true }[]>();
  for (const r of cols.rows) {
    const tbl = String(r.tbl);
    if (!/^[a-z_][a-z0-9_]*$/.test(tbl)) continue;
    const col = String(r.col);
    tables.set(tbl, [...(tables.get(tbl) ?? []), { name: col, type: String(r.type), ...((BLOCKED_COLUMNS as readonly string[]).includes(col) ? { blocked: true } : {}) }]);
  }
  const names = [...tables.keys()];
  const counts = new Map<string, number>();
  if (names.length) {
    const c = await runQuery({ dbPath: deps.dbPath, since: 0, rowCap: RENDER_ROW_CAP,
      sql: names.map((n) => `SELECT '${n}' AS tbl, COUNT(*) AS n FROM ${n}`).join(' UNION ALL ') });
    if (c.ok) for (const r of c.rows) counts.set(String(r.tbl), Number(r.n));
  }
  return reply({
    tables: names.map((name) => ({ name, rows: counts.get(name) ?? null, columns: tables.get(name) })),
    knownGaps: KNOWN_GAPS, notes: NOTES, exampleBoard: STARTER_BOARDS[0],
  });
}

async function runQueryTool(args: Record<string, unknown>, deps: DataServerDeps): Promise<ToolReply> {
  if (typeof args.sql !== 'string') return reply('sql must be a string.', true);
  const range: Range = RANGES.includes(args.range as Range) ? (args.range as Range) : '30d';
  const q = await runQuery({ dbPath: deps.dbPath, sql: args.sql, since: sinceForRange(range, deps.now()), rowCap: TOOL_ROW_CAP });
  if (!q.ok) return reply(`${q.kind}: ${q.error}`, true);
  if (args.cost === undefined) return reply({ columns: q.columns, rows: q.rows, truncated: q.truncated });
  const cost = args.cost as CostSpec;
  if (q.truncated) return reply(`Cost needs every row, but the query returned more than ${TOOL_ROW_CAP}. ${KNOWN_GAPS[3]}`, true);
  const c = applyCost(q.columns, q.rows, cost);
  if (!c.ok) return reply(c.error, true);
  return reply({ columns: c.columns, rows: c.rows, unpricedRows: c.unpricedRows, truncated: false });
}

async function saveSpec(input: unknown, deps: DataServerDeps): Promise<ToolReply> {
  const v = validateSpec(input);
  if (!v.ok) return reply({ saved: false, errors: v.errors }, true);
  const nowMs = deps.now();
  const results = await Promise.all(v.spec.panels.map((p) => evaluatePanel(p, { dbPath: deps.dbPath, nowMs, rowCap: RENDER_ROW_CAP })));
  const failures = results.filter((r) => r.error !== null).map((r) => ({ panel: r.panelId, kind: r.errorKind, error: r.error }));
  if (failures.length) return reply({ saved: false, panelErrors: failures }, true);
  mkdirSync(deps.dashboardsDir, { recursive: true });
  await writeFileAtomically(join(deps.dashboardsDir, `${v.spec.id}.json`), `${JSON.stringify(v.spec, null, 2)}\n`);
  return reply({ saved: true, id: v.spec.id, panels: results.map((r) => ({ panel: r.panelId, rows: r.rows.length, columns: r.columns, unpricedRows: r.unpricedRows })) });
}

async function updateChart(args: Record<string, unknown>, deps: DataServerDeps): Promise<ToolReply> {
  const { dashboardId, panelId, patch } = args;
  if (!isBoardId(dashboardId)) return reply('dashboardId must match ^[a-z0-9-]{1,64}$.', true);
  if (typeof panelId !== 'string' || !ID_PATTERN.test(panelId)) return reply('panelId must match ^[a-z0-9-]{1,64}$.', true);
  if (!isObject(patch)) return reply('patch must be an object.', true);
  const path = join(deps.dashboardsDir, `${dashboardId}.json`);
  if (!existsSync(path)) return reply(`No board "${dashboardId}". Create it with save_dashboard.`, true);
  let current: unknown;
  try { current = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return reply(`Board "${dashboardId}" is not valid JSON (${(e as Error).message}). Replace it with save_dashboard.`, true); }
  if (!isObject(current) || !Array.isArray(current.panels)) return reply(`Board "${dashboardId}" has no panels array. Replace it with save_dashboard.`, true);
  const panels = current.panels as unknown[];
  const index = panels.findIndex((p) => isObject(p) && p.id === panelId);
  const merged = index === -1 ? { ...patch, id: panelId } : { ...(panels[index] as object), ...patch, id: panelId };
  const nextPanels = index === -1 ? [...panels, merged] : panels.map((p, i) => (i === index ? merged : p));
  return saveSpec({ ...current, panels: nextPanels }, deps);
}

export async function handleDataTool(name: string, args: unknown, deps: DataServerDeps): Promise<ToolReply> {
  const a = isObject(args) ? args : {};
  try {
    switch (name) {
      case 'describe_schema': return await describeSchema(deps);
      case 'run_query': return await runQueryTool(a, deps);
      case 'save_dashboard': return await saveSpec(a.spec, deps);
      case 'update_chart': return await updateChart(a, deps);
      default: return reply(`Unknown tool "${name}".`, true);
    }
  } catch (e) {
    return reply(`Unexpected error: ${(e as Error).message}`, true);
  }
}

export function createDataMcpServer(deps: DataServerDeps): Server {
  const server = new Server({ name: 'aether-data', version: '1.0.0' }, {
    capabilities: { tools: {} },
    instructions: 'aether-data builds Aether OS Boards from the local collector database. Call describe_schema first, explore with run_query, then save_dashboard. Dollar columns come only from a panel "cost", never SQL.',
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: DATA_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const r = await handleDataTool(request.params.name, request.params.arguments, deps);
    return { content: [{ type: 'text', text: r.text }], isError: r.isError };
  });
  return server;
}
