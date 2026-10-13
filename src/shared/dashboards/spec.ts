/** The on-disk board format (~/.aether-os/dashboards/<id>.json), version 1. See the Boards spec. */
export const PANEL_TYPES = ['line', 'bar', 'stat', 'table'] as const;
export type PanelType = (typeof PANEL_TYPES)[number];
export const RANGES = ['24h', '7d', '30d', '90d', 'all'] as const;
export type Range = (typeof RANGES)[number];

export interface CostSpec { basis: 'exact' | 'estimated'; groupBy: string }
export interface PanelSpec {
  id: string; title: string; type: PanelType; sql: string; range: Range;
  cost?: CostSpec; x?: string; y?: string[];
}
export interface DashboardSpec { version: 1; id: string; title: string; panels: PanelSpec[] }

export const ID_PATTERN = /^[a-z0-9-]{1,64}$/;
// Windows opens these names as devices, so "<id>.json" would never be a file.
const RESERVED_IDS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
export const MAX_PANELS = 12;
/** Series per panel. Chart lines are keyed by column, and the value domain spreads every series. */
export const MAX_SERIES = 8;

export function isBoardId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id) && !RESERVED_IDS.test(id);
}

const DAY_MS = 86_400_000;
const RANGE_MS: Record<Exclude<Range, 'all'>, number> = { '24h': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS, '90d': 90 * DAY_MS };

export function sinceForRange(range: Range, nowMs: number): number {
  return range === 'all' ? 0 : nowMs - RANGE_MS[range];
}

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max;

export function validateSpec(input: unknown): { ok: true; spec: DashboardSpec } | { ok: false; errors: string[] } {
  if (!isObject(input)) return { ok: false, errors: ['Dashboard must be a JSON object.'] };
  const errors: string[] = [];
  if (input.version !== 1) errors.push('version must be 1.');
  if (!isBoardId(input.id)) errors.push("id must match ^[a-z0-9-]{1,64}$ and not be a Windows device name (con, nul, …).");
  if (!isText(input.title, 120)) errors.push('title must be a non-empty string of at most 120 characters.');
  if (!Array.isArray(input.panels) || input.panels.length === 0 || input.panels.length > MAX_PANELS) {
    errors.push(`panels must be an array of 1 to ${MAX_PANELS} panels.`);
    return { ok: false, errors };
  }
  const seen = new Set<string>();
  const panels: PanelSpec[] = [];
  input.panels.forEach((raw, i) => {
    const p = validatePanel(raw, `panels[${i}]`, errors);
    if (!p) return;
    if (seen.has(p.id)) errors.push(`panels[${i}].id "${p.id}" is duplicated.`);
    seen.add(p.id);
    panels.push(p);
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, spec: { version: 1, id: input.id as string, title: input.title as string, panels } };
}

function validatePanel(raw: unknown, at: string, errors: string[]): PanelSpec | null {
  if (!isObject(raw)) { errors.push(`${at} must be an object.`); return null; }
  const before = errors.length;
  const { id, title, type, sql, x, y } = raw;
  const range = raw.range === undefined ? '30d' : raw.range;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) errors.push(`${at}.id must match ^[a-z0-9-]{1,64}$.`);
  if (!isText(title, 120)) errors.push(`${at}.title must be a non-empty string of at most 120 characters.`);
  if (!PANEL_TYPES.includes(type as PanelType)) errors.push(`${at}.type must be one of ${PANEL_TYPES.join(', ')}.`);
  if (!isText(sql, 20_000)) errors.push(`${at}.sql must be a non-empty string of at most 20000 characters.`);
  if (!RANGES.includes(range as Range)) errors.push(`${at}.range must be one of ${RANGES.join(', ')}.`);
  let cost: CostSpec | undefined;
  if (raw.cost !== undefined) {
    const c = raw.cost;
    if (!isObject(c) || (c.basis !== 'exact' && c.basis !== 'estimated') || !isText(c.groupBy, 64)) {
      errors.push(`${at}.cost must be { basis: "exact" | "estimated", groupBy: <column> }.`);
    } else {
      cost = { basis: c.basis, groupBy: c.groupBy };
    }
  }
  if (x !== undefined && !isText(x, 64)) errors.push(`${at}.x must be a column name.`);
  if (y !== undefined && (!Array.isArray(y) || !y.every((v) => isText(v, 64)))) errors.push(`${at}.y must be an array of column names.`);
  const ys = Array.isArray(y) ? (y as string[]) : [];
  if (ys.length > MAX_SERIES) errors.push(`${at}.y has at most ${MAX_SERIES} columns.`);
  if (new Set(ys).size !== ys.length) errors.push(`${at}.y names a column more than once.`);
  if (type === 'line' || type === 'bar') {
    if (x === undefined) errors.push(`${at}: a ${type} panel needs x.`);
    if (ys.length === 0) errors.push(`${at}: a ${type} panel needs at least one y.`);
  }
  if (type === 'stat') {
    if (x !== undefined) errors.push(`${at}: a stat panel has no x.`);
    if (ys.length !== 1) errors.push(`${at}: a stat panel needs exactly one y.`);
  }
  const hasUsd = ys.includes('usd');
  const hasApprox = ys.includes('usdApprox');
  if (hasUsd && hasApprox) errors.push(`${at}: usd and usdApprox cannot share a panel.`);
  else if (hasUsd && cost?.basis !== 'exact') errors.push(`${at}: y "usd" needs cost.basis "exact".`);
  else if (hasApprox && cost?.basis !== 'estimated') errors.push(`${at}: y "usdApprox" needs cost.basis "estimated".`);
  if (errors.length > before) return null;
  return {
    id: id as string, title: title as string, type: type as PanelType, sql: sql as string, range: range as Range,
    ...(cost ? { cost } : {}), ...(x !== undefined ? { x: x as string } : {}), ...(y !== undefined ? { y: ys } : {}),
  };
}
