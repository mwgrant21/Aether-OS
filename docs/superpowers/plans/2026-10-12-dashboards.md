# Boards (Dashboards) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ask Claude in the Terminal tab for a chart over `collector.db`. Claude saves it as a board through a local `aether-data` MCP server, and a new **Boards** tab renders and refreshes it locally, with no model calls.

**Architecture:** Pure shared logic lives in `src/shared/dashboards/`: the query guard, the board file format, and cost post-processing. Electron-side I/O lives in `electron/dashboards/`: a worker-thread query runner, panel evaluation, the board store, the MCP server, and its stdio entry. The MCP server is a second electron-vite main entry (`out/main/aether-data-mcp.js`), run as `Aether OS.exe` with `ELECTRON_RUN_AS_NODE=1`, exactly like `communication-mcp.js` for `aether-bridge`. Boards are JSON files in `~/.aether-os/dashboards/`. Main watches that folder and talks to the renderer by board id only. The renderer draws hand-built SVG charts.

**Tech Stack:** TypeScript, Electron 43 (main + preload), React, `node:sqlite` `DatabaseSync`, `node:worker_threads` (eval workers), `@modelcontextprotocol/sdk` 1.30.0 (already a root dependency), vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-10-11-dashboards-design.md` (amended 2026-10-12). Read it before starting any task.

## Global Constraints

- No model calls. Do not import `@anthropic-ai/sdk`. Do not launch `claude` from code, because `src/shared/noApiCalls.test.ts` must stay green. The string `claude mcp add …` is clipboard text, never something the app executes.
- Read-only: every `collector.db` handle opened by this feature uses `{ readOnly: true }` and `PRAGMA busy_timeout = 5000`.
- No absolute path crosses IPC. Boards are addressed by `id` matching `^[a-z0-9-]{1,64}$`.
- Exact (`usd`) and estimated (`usdApprox`) never share a panel. A bucket with no data is `null`, never `0`. In the UI, `usdApprox` always shows `~`, and `usd` never does.
- Row caps: 1000 for rendering (`RENDER_ROW_CAP`), 200 for MCP tool output (`TOOL_ROW_CAP`). Query timeout is 5 s. The watcher debounce is 250 ms.
- The view id is `Boards`, in `src/components/boards/`, placed between `Ledger` and `Attachments` in `src/viewRegistry.ts`.
- Theming uses `useColors()`, and every interactive element is the `Button` primitive. Never use `window.confirm` or `alert`.
- Never cross-import runtime code between `collector/` and the app. Nothing in `collector/` changes in this plan.
- Electron tests that spawn workers or open SQLite start with `// @vitest-environment node`. The root vitest default is jsdom.
- Commit with explicit paths: `git add -- <paths>` and `git commit -m "…" -- <paths>`. Never use `git add -A`. End each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A cost panel whose SQL returns raw event rows beyond the row cap.** It must refuse with an "aggregate in SQL" error rather than show a partial dollar total. Pinned in Task 5.
2. **SQL ending in a `-- comment`, or containing `;` or a keyword inside a string literal.** It must run, because the wrapper cannot be commented out and literals are not misread. Pinned in Task 1.
3. **A hand-edited board with broken JSON, or an `id` that does not match its file name.** That tab shows `invalid: …` and every other board still lists and refreshes. Pinned in Task 9.
4. **Panel SQL that never references `:since`.** It runs and ignores the range, rather than failing with node:sqlite's "Unknown named parameter 'since'". Pinned in Task 4.
5. **The collector holding a write lock during refresh.** That panel reports `busy` and keeps its last good data, while the other panels render. Pinned in Task 4 (runner) and Task 12 (view merge).

---

## File map

| File | Responsibility |
|---|---|
| `src/shared/dashboards/queryGuard.ts` (+test) | Accept one SELECT/WITH statement, reject writes/ATTACH/PRAGMA, wrap with LIMIT |
| `src/shared/dashboards/spec.ts` (+test) | Board file types, `validateSpec`, `sinceForRange` |
| `src/shared/dashboards/costing.ts` (+test) | `applyCost` (exact/estimated), `fillDailyGaps` |
| `src/shared/dashboards/types.ts` | IPC/result types shared by main, MCP server, renderer |
| `src/shared/dashboards/starters.ts` (+test) | The two starter boards |
| `electron/dashboards/collectorDb.fixture.ts` | Test-only fixture `collector.db` builder |
| `electron/dashboards/runQuery.ts` (+test) | Guard + eval-worker execution with timeout and busy detection |
| `electron/dashboards/evaluatePanel.ts` (+test) | Query → cost → column check → gap fill → `PanelResult` |
| `electron/dashboards/dataServer.ts` (+test) | MCP tools `describe_schema`, `run_query`, `save_dashboard`, `update_chart` |
| `electron/dashboards/dataServerEntry.ts` | stdio executable entry |
| `electron/dashboards/registerCommand.ts` (+test) | Builds the `claude mcp add` clipboard text |
| `electron/dashboards/buildEntry.test.ts` | Asserts the electron-vite entry exists |
| `electron/dashboards/dashboardsStore.ts` (+test) | List, seed, refresh, delete, watch |
| `electron/collectorStore.ts`, `electron/main.ts` | busy_timeout on existing readers; IPC wiring |
| `electron/preload.ts`, `src/aetherElectron.d.ts` | `window.aetherElectron.dashboards` |
| `electron.vite.config.ts` | `aether-data-mcp` entry |
| `src/components/boards/formatValue.ts`, `chartMath.ts`, `boardsState.ts` (+tests) | Pure renderer helpers |
| `src/components/boards/LinePanel.tsx`, `BarPanel.tsx`, `StatPanel.tsx`, `TablePanel.tsx` | Charts |
| `src/components/boards/BoardPanel.tsx`, `useBoards.ts`, `BoardsView.tsx` (+render test) | View |
| `src/viewRegistry.ts` (+test) | Register `Boards` |
| `docs/privacy-and-data.md`, `PROGRESS.md` | Document the new boundary and the feature |

---

### Task 1: Query guard

**Files:**
- Create: `src/shared/dashboards/queryGuard.ts`
- Test: `src/shared/dashboards/queryGuard.test.ts`

**Interfaces:**
- Produces: `RENDER_ROW_CAP = 1000`, `TOOL_ROW_CAP = 200`, `type GuardResult = { ok: true; sql: string; usesSince: boolean } | { ok: false; reason: string }`, `guardQuery(sql: string, rowCap: number): GuardResult`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { guardQuery } from './queryGuard';

describe('guardQuery', () => {
  it.each([
    ['plain select', 'SELECT 1 AS a'],
    ['with cte', 'WITH t AS (SELECT 1 AS a) SELECT a FROM t'],
    ['one trailing semicolon', 'SELECT 1;'],
    ['lowercase', 'select model from usage_events'],
    ['keyword inside string literal', "SELECT 'DROP TABLE x; DELETE' AS s"],
    ['semicolon inside string literal', "SELECT ';' AS s"],
    ['escaped quote in literal', "SELECT 'it''s' AS s"],
    ['replace() function', "SELECT replace(model, '-', ' ') AS m FROM usage_events"],
    ['pragma table-valued function', "SELECT name FROM pragma_table_info('usage_events')"],
  ])('accepts %s', (_name, sql) => {
    expect(guardQuery(sql, 10).ok).toBe(true);
  });

  it.each([
    ['empty', '   ', 'empty'],
    ['two statements', 'SELECT 1; SELECT 2', 'one statement'],
    ['statement hidden after comment', 'SELECT 1 /* x */; DROP TABLE usage_events', 'one statement'],
    ['attach', "ATTACH DATABASE 'x.db' AS x", 'SELECT or WITH'],
    ['attach inside select', "SELECT 1 FROM (SELECT 1) WHERE 1 = (ATTACH 'x' AS y)", 'ATTACH'],
    ['pragma', 'PRAGMA journal_mode', 'SELECT or WITH'],
    ['insert', 'INSERT INTO usage_events DEFAULT VALUES', 'SELECT or WITH'],
    ['with then insert', 'WITH t AS (SELECT 1) INSERT INTO x SELECT * FROM t', 'INSERT'],
    ['with then delete', 'WITH t AS (SELECT 1) DELETE FROM usage_events', 'DELETE'],
    ['replace into', 'WITH t AS (SELECT 1) REPLACE INTO x SELECT * FROM t', 'REPLACE INTO'],
    ['load_extension', "SELECT load_extension('evil')", 'LOAD_EXTENSION'],
    ['unterminated string', "SELECT 'abc", 'unterminated'],
    ['unterminated block comment', 'SELECT 1 /* never closed', 'unterminated'],
  ])('rejects %s', (_name, sql, reasonPart) => {
    const r = guardQuery(sql, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.toLowerCase()).toContain(reasonPart.toLowerCase());
  });

  it('wraps with LIMIT rowCap+1 so truncation is detectable', () => {
    const r = guardQuery('SELECT 1 AS a', 10);
    expect(r).toEqual({ ok: true, sql: 'SELECT * FROM (SELECT 1 AS a) LIMIT 11', usesSince: false });
  });

  it('a trailing line comment cannot comment out the wrapper', () => {
    const r = guardQuery('SELECT 1 AS a -- note', 10);
    expect(r.ok && r.sql.endsWith(') LIMIT 11')).toBe(true);
    expect(r.ok && r.sql.includes('--')).toBe(false);
  });

  it('detects :since outside literals only', () => {
    const uses = guardQuery('SELECT 1 FROM usage_events WHERE occurred_at_ms >= :since', 10);
    const literal = guardQuery("SELECT ':since' AS s", 10);
    expect(uses.ok && uses.usesSince).toBe(true);
    expect(literal.ok && literal.usesSince).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/dashboards/queryGuard.test.ts`
Expected: FAIL, cannot resolve `./queryGuard`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Defense in depth for Boards queries. The primary guard is the read-only
 * connection (electron/dashboards/runQuery.ts opens collector.db with
 * readOnly: true); this module keeps a write from ever reaching SQLite and
 * gives Claude an error that names the rule.
 */
export const RENDER_ROW_CAP = 1000;
export const TOOL_ROW_CAP = 200;

export type GuardResult = { ok: true; sql: string; usesSince: boolean } | { ok: false; reason: string };

const FORBIDDEN =
  /\b(ATTACH|DETACH|PRAGMA|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|VACUUM|REINDEX|SAVEPOINT|RELEASE|BEGIN|COMMIT|ROLLBACK|LOAD_EXTENSION)\b|\bREPLACE\s+INTO\b/i;

interface Scanned { code: string; skeleton: string; unterminated: boolean }

/**
 * `code` is the SQL with comments replaced by a space (literals kept), safe to
 * wrap. `skeleton` additionally blanks literal and quoted-identifier contents,
 * so keyword and `;` checks never see text inside them. Both stay the same
 * length outside comments, so trimming them in step is safe.
 */
function scan(sql: string): Scanned {
  let code = '';
  let skeleton = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      code += ' ';
      skeleton += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return { code, skeleton, unterminated: true };
      i = end + 2;
      code += ' ';
      skeleton += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) return { code, skeleton, unterminated: true };
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) { j += 2; continue; }
          break;
        }
        j++;
      }
      code += sql.slice(i, j + 1);
      skeleton += c + ' '.repeat(j - i - 1) + close;
      i = j + 1;
      continue;
    }
    code += c;
    skeleton += c;
    i++;
  }
  return { code, skeleton, unterminated: false };
}

export function guardQuery(sql: string, rowCap: number): GuardResult {
  if (typeof sql !== 'string' || sql.trim() === '') return { ok: false, reason: 'Query is empty.' };
  const scanned = scan(sql);
  if (scanned.unterminated) {
    return { ok: false, reason: 'Query has an unterminated string, identifier or comment.' };
  }
  let code = scanned.code.trim();
  let skeleton = scanned.skeleton.trim();
  if (skeleton.endsWith(';')) {
    skeleton = skeleton.slice(0, -1).trim();
    code = code.slice(0, -1).trim();
  }
  if (skeleton.includes(';')) return { ok: false, reason: 'Only one statement is allowed.' };
  if (!/^(SELECT|WITH)\b/i.test(skeleton)) {
    return { ok: false, reason: 'Only SELECT or WITH … SELECT queries are allowed.' };
  }
  const bad = FORBIDDEN.exec(skeleton);
  if (bad) return { ok: false, reason: `"${bad[0].toUpperCase()}" is not allowed in a Boards query.` };
  return { ok: true, sql: `SELECT * FROM (${code}) LIMIT ${rowCap + 1}`, usesSince: /:since\b/.test(skeleton) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/dashboards/queryGuard.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
P="src/shared/dashboards/queryGuard.ts src/shared/dashboards/queryGuard.test.ts"
git add -- $P && git commit -m "feat(boards): read-only query guard" -- $P
```

---

### Task 2: Board file format

**Files:**
- Create: `src/shared/dashboards/spec.ts`
- Test: `src/shared/dashboards/spec.test.ts`

**Interfaces:**
- Produces:
  - `PANEL_TYPES`, `type PanelType = 'line' | 'bar' | 'stat' | 'table'`
  - `RANGES`, `type Range = '24h' | '7d' | '30d' | '90d' | 'all'`
  - `interface CostSpec { basis: 'exact' | 'estimated'; groupBy: string }`
  - `interface PanelSpec { id: string; title: string; type: PanelType; sql: string; range: Range; cost?: CostSpec; x?: string; y?: string[] }`
  - `interface DashboardSpec { version: 1; id: string; title: string; panels: PanelSpec[] }`
  - `ID_PATTERN`, `MAX_PANELS = 12`
  - `validateSpec(input: unknown): { ok: true; spec: DashboardSpec } | { ok: false; errors: string[] }`
  - `sinceForRange(range: Range, nowMs: number): number`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { sinceForRange, validateSpec } from './spec';

const panel = (over: Record<string, unknown> = {}) => ({
  id: 'p1', title: 'Spend by day', type: 'line', sql: 'SELECT 1', x: 'day', y: ['usd'],
  cost: { basis: 'exact', groupBy: 'day' }, ...over,
});
const board = (over: Record<string, unknown> = {}) => ({ version: 1, id: 'b1', title: 'Board', panels: [panel()], ...over });

describe('validateSpec', () => {
  it('accepts a valid board and defaults range to 30d', () => {
    const r = validateSpec(board());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.panels[0].range).toBe('30d');
  });

  it.each([
    ['non-object', 'x', 'JSON object'],
    ['wrong version', board({ version: 2 }), 'version'],
    ['bad id', board({ id: 'Bad Id' }), 'id must match'],
    ['empty title', board({ title: '' }), 'title'],
    ['no panels', board({ panels: [] }), 'panels'],
    ['13 panels', board({ panels: Array.from({ length: 13 }, (_, i) => panel({ id: `p${i}` })) }), 'panels'],
    ['duplicate panel ids', board({ panels: [panel(), panel()] }), 'duplicated'],
    ['bad type', board({ panels: [panel({ type: 'pie' })] }), 'type must be one of'],
    ['bad range', board({ panels: [panel({ range: '1y' })] }), 'range'],
    ['line without x', board({ panels: [panel({ x: undefined })] }), 'needs x'],
    ['stat with x', board({ panels: [panel({ type: 'stat' })] }), 'stat panel has no x'],
    ['stat with two y', board({ panels: [panel({ type: 'stat', x: undefined, y: ['usd', 'n'] })] }), 'exactly one y'],
    ['usd and usdApprox together', board({ panels: [panel({ y: ['usd', 'usdApprox'] })] }), 'cannot share'],
    ['usd without exact cost', board({ panels: [panel({ cost: undefined })] }), 'needs cost.basis "exact"'],
    ['usdApprox with exact cost', board({ panels: [panel({ y: ['usdApprox'] })] }), 'needs cost.basis "estimated"'],
    ['malformed cost', board({ panels: [panel({ cost: { basis: 'guess', groupBy: 'day' } })] }), 'cost must be'],
  ])('rejects %s', (_n, input, part) => {
    const r = validateSpec(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' | ')).toContain(part);
  });

  it('a table panel needs neither x nor y', () => {
    expect(validateSpec(board({ panels: [{ id: 't', title: 'T', type: 'table', sql: 'SELECT 1' }] })).ok).toBe(true);
  });
});

describe('sinceForRange', () => {
  it('maps ranges to epoch ms and all to 0', () => {
    const now = 10 * 86_400_000;
    expect(sinceForRange('24h', now)).toBe(now - 86_400_000);
    expect(sinceForRange('7d', now)).toBe(now - 7 * 86_400_000);
    expect(sinceForRange('all', now)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/dashboards/spec.test.ts`
Expected: FAIL, cannot resolve `./spec`.

- [ ] **Step 3: Write the implementation**

```ts
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
export const MAX_PANELS = 12;

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
  if (typeof input.id !== 'string' || !ID_PATTERN.test(input.id)) errors.push('id must match ^[a-z0-9-]{1,64}$.');
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/dashboards/spec.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
P="src/shared/dashboards/spec.ts src/shared/dashboards/spec.test.ts"
git add -- $P && git commit -m "feat(boards): board file format and validator" -- $P
```

---

### Task 3: Cost post-processing and day gaps

**Files:**
- Create: `src/shared/dashboards/costing.ts`
- Test: `src/shared/dashboards/costing.test.ts`

**Interfaces:**
- Consumes: `CostSpec` (Task 2); `costForEvent` from `src/shared/modelPricing.ts`; `blendedRateForModel` from `src/shared/ledgerMath.ts`
- Produces:
  - `type Row = Record<string, unknown>`
  - `EXACT_COST_COLUMNS`
  - `applyCost(columns: string[], rows: Row[], cost: CostSpec): { ok: true; columns: string[]; rows: Row[]; unpricedRows: number } | { ok: false; error: string }`
  - `fillDailyGaps(x: string, yColumns: string[], rows: Row[], sinceMs: number, nowMs: number): Row[]`
  - `localDay(ms: number): string` (YYYY-MM-DD, local time)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { applyCost, fillDailyGaps, localDay } from './costing';
import { costForEvent } from '../modelPricing';
import { blendedRateForModel } from '../ledgerMath';

const ev = (day: string, model: string | null, i = 1000, o = 500, cw = 0, cr = 0) => ({
  day, model, input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr,
});
const EXACT_COLS = ['day', 'model', 'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
const price = (model: string, i: number, o: number) =>
  costForEvent({ model, usage: { inputTokens: i, outputTokens: o, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } });

describe('applyCost exact', () => {
  it('sums usd per group in first-seen order', () => {
    const r = applyCost(EXACT_COLS, [ev('2026-10-01', 'claude-opus-5-5'), ev('2026-10-02', 'claude-opus-5-5'), ev('2026-10-01', 'claude-sonnet-5-5', 10, 10)], { basis: 'exact', groupBy: 'day' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.columns).toEqual(['day', 'usd']);
    expect(r.rows[0].day).toBe('2026-10-01');
    expect(r.rows[0].usd).toBeCloseTo(price('claude-opus-5-5', 1000, 500) + price('claude-sonnet-5-5', 10, 10), 10);
    expect(r.rows[1].usd).toBeCloseTo(price('claude-opus-5-5', 1000, 500), 10);
    expect(r.unpricedRows).toBe(0);
  });

  it('excludes and counts rows with no model; a group of only those is null, not 0', () => {
    const r = applyCost(EXACT_COLS, [ev('2026-10-01', null), ev('2026-10-02', 'claude-opus-5-5')], { basis: 'exact', groupBy: 'day' });
    expect(r.ok && r.unpricedRows).toBe(1);
    expect(r.ok && r.rows[0].usd).toBeNull();
  });

  it('names missing columns', () => {
    const r = applyCost(['day', 'model'], [], { basis: 'exact', groupBy: 'day' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('input_tokens');
  });
});

describe('applyCost estimated', () => {
  it('prices tokens at the default blended rate into usdApprox; null tokens are unpriced', () => {
    const r = applyCost(['day', 'tokens'], [{ day: 'd1', tokens: 1_000_000 }, { day: 'd1', tokens: null }], { basis: 'estimated', groupBy: 'day' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.columns).toEqual(['day', 'usdApprox']);
    expect(r.rows[0].usdApprox).toBeCloseTo(blendedRateForModel(null), 10);
    expect(r.unpricedRows).toBe(1);
  });
});

describe('fillDailyGaps', () => {
  const now = new Date(2026, 9, 5, 12).getTime(); // 2026-10-05 local noon
  const since = new Date(2026, 9, 3, 12).getTime();

  it('adds null rows for missing days across the range', () => {
    const rows = fillDailyGaps('day', ['usd'], [{ day: '2026-10-04', usd: 1 }], since, now);
    expect(rows).toEqual([
      { day: '2026-10-03', usd: null },
      { day: '2026-10-04', usd: 1 },
      { day: '2026-10-05', usd: null },
    ]);
  });

  it('leaves non-day x values and duplicate days untouched', () => {
    const cats = [{ day: 'Read', usd: 1 }];
    expect(fillDailyGaps('day', ['usd'], cats, since, now)).toBe(cats);
    const dup = [{ day: '2026-10-04', usd: 1 }, { day: '2026-10-04', usd: 2 }];
    expect(fillDailyGaps('day', ['usd'], dup, since, now)).toBe(dup);
  });

  it('localDay formats local dates', () => {
    expect(localDay(now)).toBe('2026-10-05');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/dashboards/costing.test.ts`
Expected: FAIL, cannot resolve `./costing`.

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/dashboards/costing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
P="src/shared/dashboards/costing.ts src/shared/dashboards/costing.test.ts"
git add -- $P && git commit -m "feat(boards): exact/estimated cost columns and day gap fill" -- $P
```

---

### Task 4: Shared result types, fixture db, worker query runner

**Files:**
- Create: `src/shared/dashboards/types.ts`
- Create: `electron/dashboards/collectorDb.fixture.ts`
- Create: `electron/dashboards/runQuery.ts`
- Test: `electron/dashboards/runQuery.test.ts`

**Interfaces:**
- Consumes: `guardQuery` (Task 1)
- Produces:
  - in `types.ts`:
    - `type QueryErrorKind = 'guard' | 'missing-db' | 'busy' | 'timeout' | 'sql'`
    - `interface PanelResult { panelId: string; columns: string[]; rows: Record<string, unknown>[]; truncated: boolean; unpricedRows: number; error: string | null; errorKind: QueryErrorKind | 'columns' | 'cost' | null; refreshedAt: number }`
    - `interface PanelSummary { id; title; type: PanelType; range: Range; sql; costBasis: 'exact' | 'estimated' | null; x: string | null; y: string[] }`
    - `interface BoardSummary { id: string; title: string; error: string | null; panels: PanelSummary[] }`
    - `interface BoardsListing { collectorAvailable: boolean; boards: BoardSummary[] }`
    - `type RefreshResponse = { ok: true; panels: PanelResult[] } | { ok: false; error: string }`
  - in `runQuery.ts`:
    - `QUERY_TIMEOUT_MS = 5000`, `BUSY_TIMEOUT_MS = 5000`
    - `type RunQueryResult = { ok: true; columns: string[]; rows: Record<string, unknown>[]; truncated: boolean } | { ok: false; kind: QueryErrorKind; error: string }`
    - `interface RunQueryOptions { dbPath: string; sql: string; since: number; rowCap: number; timeoutMs?: number; busyTimeoutMs?: number }`
    - `runQuery(opts: RunQueryOptions): Promise<RunQueryResult>`
    - `executeInWorker(dbPath: string, wrappedSql: string, params: Record<string, number> | null, rowCap: number, timeoutMs: number, busyTimeoutMs: number): Promise<RunQueryResult>`
  - in the fixture: `DAY_MS`, `createFixtureCollectorDb(nowMs: number): string`

- [ ] **Step 1: Write the types and the fixture (no logic to test on their own)**

`src/shared/dashboards/types.ts`:

```ts
import type { PanelType, Range } from './spec';

/** Shapes that cross the Boards IPC and MCP boundaries. Ids only, never paths. */
export type QueryErrorKind = 'guard' | 'missing-db' | 'busy' | 'timeout' | 'sql';

export interface PanelResult {
  panelId: string;
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  unpricedRows: number;
  error: string | null;
  errorKind: QueryErrorKind | 'columns' | 'cost' | null;
  refreshedAt: number;
}

export interface PanelSummary {
  id: string; title: string; type: PanelType; range: Range; sql: string;
  costBasis: 'exact' | 'estimated' | null; x: string | null; y: string[];
}
export interface BoardSummary { id: string; title: string; error: string | null; panels: PanelSummary[] }
export interface BoardsListing { collectorAvailable: boolean; boards: BoardSummary[] }
export type RefreshResponse = { ok: true; panels: PanelResult[] } | { ok: false; error: string };
```

`electron/dashboards/collectorDb.fixture.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// Test-only. Columns copied from collector/src/schema.ts (never imported:
// the app and the collector do not share runtime code).
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

export const DAY_MS = 86_400_000;

export function createFixtureCollectorDb(nowMs: number): string {
  const path = join(mkdtempSync(join(tmpdir(), 'aether-boards-')), 'collector.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at_ms INTEGER NOT NULL, model TEXT,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_creation_input_tokens INTEGER NOT NULL, cache_read_input_tokens INTEGER NOT NULL);
    CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      file_path_rel TEXT, started_at_ms INTEGER NOT NULL, closed_at_ms INTEGER NOT NULL);
    CREATE TABLE dispatches (tool_use_id TEXT PRIMARY KEY, tokens INTEGER, tool_uses INTEGER, duration_ms INTEGER,
      started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER NOT NULL);
    CREATE TABLE anomalies (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, tool_use_id TEXT NOT NULL,
      detail TEXT NOT NULL, detected_at_ms INTEGER NOT NULL);
    CREATE TABLE daily_anomaly_rollups (day TEXT NOT NULL, kind TEXT NOT NULL, anomaly_count INTEGER NOT NULL,
      PRIMARY KEY (day, kind));
  `);
  const usage = db.prepare('INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) VALUES (?, ?, ?, ?, ?, ?)');
  usage.run(nowMs - 3_600_000, 'claude-opus-5-5', 1000, 500, 200, 3000);
  usage.run(nowMs - 3_600_000, null, 10, 10, 0, 0);
  usage.run(nowMs - 2 * DAY_MS, 'claude-sonnet-5-5', 2000, 100, 0, 1000);
  const tool = db.prepare('INSERT INTO tool_calls (tool_use_id, tool_name, started_at_ms, closed_at_ms) VALUES (?, ?, ?, ?)');
  ['Read', 'Read', 'Read', 'Bash'].forEach((name, i) => tool.run(`tu${i}`, name, nowMs - 3_600_000, nowMs - 3_590_000));
  const dispatch = db.prepare('INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms) VALUES (?, ?, ?, ?, ?, ?)');
  dispatch.run('d1', 50_000, 12, 90_000, nowMs - 7_200_000, nowMs - 7_110_000);
  dispatch.run('d2', null, null, 30_000, nowMs - DAY_MS, nowMs - DAY_MS + 30_000);
  const d = new Date(nowMs);
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  db.prepare('INSERT INTO daily_anomaly_rollups (day, kind, anomaly_count) VALUES (?, ?, ?)').run(today, 'loop', 2);
  db.close();
  return path;
}
```

- [ ] **Step 2: Write the failing test**

`electron/dashboards/runQuery.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixtureCollectorDb } from './collectorDb.fixture';
import { executeInWorker, runQuery } from './runQuery';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const now = Date.now();

describe('runQuery', () => {
  it('returns columns and rows', async () => {
    const dbPath = createFixtureCollectorDb(now);
    const r = await runQuery({ dbPath, sql: 'SELECT tool_name, COUNT(*) AS n FROM tool_calls GROUP BY tool_name ORDER BY n DESC', since: 0, rowCap: 10 });
    expect(r).toEqual({ ok: true, columns: ['tool_name', 'n'], rows: [{ tool_name: 'Read', n: 3 }, { tool_name: 'Bash', n: 1 }], truncated: false });
  });

  it('binds :since when used', async () => {
    const dbPath = createFixtureCollectorDb(now);
    const r = await runQuery({ dbPath, sql: 'SELECT COUNT(*) AS n FROM usage_events WHERE occurred_at_ms >= :since', since: now - 86_400_000, rowCap: 10 });
    expect(r.ok && r.rows[0].n).toBe(2);
  });

  it('runs SQL that never references :since (Review Focus 4)', async () => {
    const dbPath = createFixtureCollectorDb(now);
    const r = await runQuery({ dbPath, sql: 'SELECT COUNT(*) AS n FROM usage_events', since: now, rowCap: 10 });
    expect(r.ok && r.rows[0].n).toBe(3);
  });

  it('flags truncation at the row cap', async () => {
    const dbPath = createFixtureCollectorDb(now);
    const r = await runQuery({ dbPath, sql: 'SELECT id FROM usage_events', since: 0, rowCap: 2 });
    expect(r.ok && r.rows.length).toBe(2);
    expect(r.ok && r.truncated).toBe(true);
  });

  it('reports guard rejections without touching the db', async () => {
    const r = await runQuery({ dbPath: 'nope.db', sql: 'DELETE FROM usage_events', since: 0, rowCap: 10 });
    expect(r).toMatchObject({ ok: false, kind: 'guard' });
  });

  it('reports a missing collector db', async () => {
    const r = await runQuery({ dbPath: join(tmpdir(), 'definitely-missing-aether.db'), sql: 'SELECT 1', since: 0, rowCap: 10 });
    expect(r).toMatchObject({ ok: false, kind: 'missing-db' });
  });

  it('reports SQL errors', async () => {
    const dbPath = createFixtureCollectorDb(now);
    const r = await runQuery({ dbPath, sql: 'SELECT nope FROM usage_events', since: 0, rowCap: 10 });
    expect(r).toMatchObject({ ok: false, kind: 'sql' });
  });

  it('reports busy while another connection holds an exclusive lock (Review Focus 5)', async () => {
    const dbPath = createFixtureCollectorDb(now);
    const writer = new DatabaseSync(dbPath);
    writer.exec('BEGIN EXCLUSIVE');
    try {
      const r = await runQuery({ dbPath, sql: 'SELECT COUNT(*) AS n FROM usage_events', since: 0, rowCap: 10, busyTimeoutMs: 50 });
      expect(r).toMatchObject({ ok: false, kind: 'busy' });
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
  });

  it('stops a runaway query at the timeout', async () => {
    const dbPath = createFixtureCollectorDb(now);
    const slow = 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c) SELECT MAX(i) AS m FROM c';
    const r = await runQuery({ dbPath, sql: slow, since: 0, rowCap: 10, timeoutMs: 300 });
    expect(r).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('the connection itself is read-only even if a write got past the guard', async () => {
    const dbPath = createFixtureCollectorDb(now);
    const r = await executeInWorker(dbPath, 'DELETE FROM usage_events', null, 10, 5000, 5000);
    expect(r.ok).toBe(false);
    const check = new DatabaseSync(dbPath, { readOnly: true });
    expect(check.prepare('SELECT COUNT(*) AS n FROM usage_events').get().n).toBe(3);
    check.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run electron/dashboards/runQuery.test.ts`
Expected: FAIL, cannot resolve `./runQuery`.

- [ ] **Step 4: Write the implementation**

`electron/dashboards/runQuery.ts`:

```ts
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { guardQuery } from '../../src/shared/dashboards/queryGuard';
import type { QueryErrorKind } from '../../src/shared/dashboards/types';

export const QUERY_TIMEOUT_MS = 5000;
export const BUSY_TIMEOUT_MS = 5000;

export type RunQueryResult =
  | { ok: true; columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }
  | { ok: false; kind: QueryErrorKind; error: string };

export interface RunQueryOptions {
  dbPath: string; sql: string; since: number; rowCap: number; timeoutMs?: number; busyTimeoutMs?: number;
}

// Eval'd source, not a bundled file: an eval worker needs no extra build entry
// and no file inside app.asar. node:sqlite is synchronous, so terminating the
// worker is the only way to stop a runaway query.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let db;
try {
  db = new DatabaseSync(workerData.dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = ' + Number(workerData.busyTimeoutMs));
  const stmt = db.prepare(workerData.sql);
  const rows = workerData.params ? stmt.all(workerData.params) : stmt.all();
  const columns = typeof stmt.columns === 'function'
    ? stmt.columns().map((c) => c.name)
    : (rows[0] ? Object.keys(rows[0]) : []);
  parentPort.postMessage({ ok: true, columns, rows: rows.map((r) => ({ ...r })) });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
} finally {
  try { if (db) db.close(); } catch {}
}
`;

type WorkerReply = { ok: true; columns: string[]; rows: Record<string, unknown>[] } | { ok: false; error: string };

export function executeInWorker(
  dbPath: string, wrappedSql: string, params: Record<string, number> | null,
  rowCap: number, timeoutMs: number, busyTimeoutMs: number,
): Promise<RunQueryResult> {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { dbPath, sql: wrappedSql, params, busyTimeoutMs } });
    let settled = false;
    const finish = (r: RunQueryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ ok: false, kind: 'timeout', error: `Query ran longer than ${timeoutMs / 1000}s and was stopped.` }),
      timeoutMs,
    );
    worker.once('message', (m: WorkerReply) => {
      if (!m.ok) {
        finish({ ok: false, kind: /database is locked|SQLITE_BUSY/i.test(m.error) ? 'busy' : 'sql', error: m.error });
        return;
      }
      const truncated = m.rows.length > rowCap;
      finish({ ok: true, columns: m.columns, rows: truncated ? m.rows.slice(0, rowCap) : m.rows, truncated });
    });
    worker.once('error', (e) => finish({ ok: false, kind: 'sql', error: e.message }));
    worker.once('exit', (code) => finish({ ok: false, kind: 'sql', error: `Query worker exited (${code}).` }));
  });
}

export function runQuery(opts: RunQueryOptions): Promise<RunQueryResult> {
  const guarded = guardQuery(opts.sql, opts.rowCap);
  if (!guarded.ok) return Promise.resolve({ ok: false, kind: 'guard', error: guarded.reason });
  if (!existsSync(opts.dbPath)) {
    return Promise.resolve({ ok: false, kind: 'missing-db', error: 'No collector data. Start the collector (collector/README.md).' });
  }
  // node:sqlite throws "Unknown named parameter" for a parameter the SQL does
  // not use, so :since is bound only when the query references it.
  const params = guarded.usesSince ? { since: opts.since } : null;
  return executeInWorker(opts.dbPath, guarded.sql, params, opts.rowCap,
    opts.timeoutMs ?? QUERY_TIMEOUT_MS, opts.busyTimeoutMs ?? BUSY_TIMEOUT_MS);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run electron/dashboards/runQuery.test.ts`
Expected: PASS (10 tests).

If the busy test returns `ok: true`, the fixture db is in WAL mode. It should not be, since `journal_mode` defaults to `delete`. Check `PRAGMA journal_mode` on the fixture before changing anything else.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck:electron`
Expected: no errors.

```bash
P="src/shared/dashboards/types.ts electron/dashboards/collectorDb.fixture.ts electron/dashboards/runQuery.ts electron/dashboards/runQuery.test.ts"
git add -- $P && git commit -m "feat(boards): read-only worker query runner with timeout and busy detection" -- $P
```

---

### Task 5: Panel evaluation

**Files:**
- Create: `electron/dashboards/evaluatePanel.ts`
- Test: `electron/dashboards/evaluatePanel.test.ts`

**Interfaces:**
- Consumes: `runQuery` (Task 4), `applyCost`, `fillDailyGaps` (Task 3), `sinceForRange`, `PanelSpec`, `Range` (Task 2), `PanelResult` (Task 4)
- Produces:
  - `interface EvalContext { dbPath: string; nowMs: number; rowCap: number; rangeOverride?: Range; timeoutMs?: number; busyTimeoutMs?: number }`
  - `evaluatePanel(panel: PanelSpec, ctx: EvalContext): Promise<PanelResult>`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/dashboards/evaluatePanel.test.ts`
Expected: FAIL, cannot resolve `./evaluatePanel`.

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/dashboards/evaluatePanel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
P="electron/dashboards/evaluatePanel.ts electron/dashboards/evaluatePanel.test.ts"
git add -- $P && git commit -m "feat(boards): panel evaluation (query, cost, columns, gaps)" -- $P
```

---

### Task 6: Starter boards

**Files:**
- Create: `src/shared/dashboards/starters.ts`
- Test: `electron/dashboards/starters.test.ts` (in `electron/` because it evaluates panels against the fixture db)

**Interfaces:**
- Consumes: `DashboardSpec`, `validateSpec` (Task 2), `evaluatePanel` (Task 5)
- Produces: `STARTER_BOARDS: DashboardSpec[]` (ids `spend-cache`, `agent-fleet`)

Deviations from the spec's starter list are deliberate, because SQLite has no `MEDIAN`:
- "dispatches per day with median duration" becomes two panels, *Dispatches per day* and *Average dispatch duration (s)*.
- "anomalies by kind per day" becomes *Anomalies by kind (30d)*, totals per kind, since a bar of per-day series per kind needs a pivot the chart does not support.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { STARTER_BOARDS } from '../../src/shared/dashboards/starters';
import { validateSpec } from '../../src/shared/dashboards/spec';
import { createFixtureCollectorDb } from './collectorDb.fixture';
import { evaluatePanel } from './evaluatePanel';

describe('starter boards', () => {
  it('are spend-cache and agent-fleet and pass validation', () => {
    expect(STARTER_BOARDS.map((b) => b.id)).toEqual(['spend-cache', 'agent-fleet']);
    for (const b of STARTER_BOARDS) expect(validateSpec(b)).toEqual({ ok: true, spec: b });
  });

  it('every panel evaluates without error against a collector-shaped db', async () => {
    const now = Date.now();
    const dbPath = createFixtureCollectorDb(now);
    for (const board of STARTER_BOARDS) {
      for (const panel of board.panels) {
        const r = await evaluatePanel(panel, { dbPath, nowMs: now, rowCap: 1000 });
        expect({ board: board.id, panel: panel.id, error: r.error }).toEqual({ board: board.id, panel: panel.id, error: null });
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/dashboards/starters.test.ts`
Expected: FAIL, cannot resolve `starters`.

- [ ] **Step 3: Write the implementation**

```ts
import type { DashboardSpec } from './spec';

const DAY = "date(occurred_at_ms/1000,'unixepoch','localtime')";
const TOKEN_SUMS = `SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
  SUM(cache_creation_input_tokens) AS cache_creation_input_tokens, SUM(cache_read_input_tokens) AS cache_read_input_tokens`;
const DISPATCH_DAY = "date(started_at_ms/1000,'unixepoch','localtime')";

/** Seeded once into ~/.aether-os/dashboards/ (see dashboardsStore.seedStarters); never overwritten. */
export const STARTER_BOARDS: DashboardSpec[] = [
  {
    version: 1, id: 'spend-cache', title: 'Spend & cache',
    panels: [
      { id: 'daily-spend', title: 'Spend by day (API rate)', type: 'line', range: '30d',
        sql: `SELECT ${DAY} AS day, model, ${TOKEN_SUMS} FROM usage_events WHERE occurred_at_ms >= :since GROUP BY day, model`,
        cost: { basis: 'exact', groupBy: 'day' }, x: 'day', y: ['usd'] },
      { id: 'spend-by-model', title: 'Spend by model (API rate)', type: 'bar', range: '30d',
        sql: `SELECT model, ${TOKEN_SUMS} FROM usage_events WHERE occurred_at_ms >= :since GROUP BY model`,
        cost: { basis: 'exact', groupBy: 'model' }, x: 'model', y: ['usd'] },
      { id: 'cache-hit-rate', title: 'Cache hit rate by day', type: 'line', range: '30d',
        // Same definition as src/shared/cacheHitRate.ts: reads / (input + reads); cache creation excluded.
        sql: `SELECT ${DAY} AS day, SUM(cache_read_input_tokens) * 1.0 / NULLIF(SUM(input_tokens) + SUM(cache_read_input_tokens), 0) AS hit_rate
          FROM usage_events WHERE occurred_at_ms >= :since GROUP BY day ORDER BY day`,
        x: 'day', y: ['hit_rate'] },
      { id: 'spend-24h', title: 'Spend, last 24h (API rate)', type: 'stat', range: '24h',
        sql: `SELECT 'last 24h' AS period, model, ${TOKEN_SUMS} FROM usage_events WHERE occurred_at_ms >= :since GROUP BY model`,
        cost: { basis: 'exact', groupBy: 'period' }, y: ['usd'] },
    ],
  },
  {
    version: 1, id: 'agent-fleet', title: 'Agent fleet',
    panels: [
      { id: 'tool-calls', title: 'Tool calls by tool (top 15)', type: 'bar', range: '7d',
        sql: 'SELECT tool_name, COUNT(*) AS calls FROM tool_calls WHERE started_at_ms >= :since GROUP BY tool_name ORDER BY calls DESC LIMIT 15',
        x: 'tool_name', y: ['calls'] },
      { id: 'dispatches-per-day', title: 'Dispatches per day', type: 'line', range: '30d',
        sql: `SELECT ${DISPATCH_DAY} AS day, COUNT(*) AS dispatches FROM dispatches WHERE started_at_ms >= :since GROUP BY day ORDER BY day`,
        x: 'day', y: ['dispatches'] },
      { id: 'dispatch-duration', title: 'Average dispatch duration (s)', type: 'line', range: '30d',
        sql: `SELECT ${DISPATCH_DAY} AS day, ROUND(AVG(duration_ms) / 1000.0, 1) AS avg_duration_s FROM dispatches WHERE started_at_ms >= :since GROUP BY day ORDER BY day`,
        x: 'day', y: ['avg_duration_s'] },
      { id: 'dispatch-spend', title: 'Dispatch spend by day (estimate)', type: 'line', range: '30d',
        sql: `SELECT ${DISPATCH_DAY} AS day, SUM(tokens) AS tokens FROM dispatches WHERE started_at_ms >= :since GROUP BY day`,
        cost: { basis: 'estimated', groupBy: 'day' }, x: 'day', y: ['usdApprox'] },
      { id: 'anomalies-by-kind', title: 'Anomalies by kind', type: 'bar', range: '30d',
        sql: "SELECT kind, SUM(anomaly_count) AS anomalies FROM daily_anomaly_rollups WHERE day >= date(:since / 1000, 'unixepoch', 'localtime') GROUP BY kind ORDER BY anomalies DESC",
        x: 'kind', y: ['anomalies'] },
      { id: 'slowest-dispatches', title: 'Slowest dispatches', type: 'table', range: '7d',
        sql: `SELECT ${DISPATCH_DAY} AS day, ROUND(duration_ms / 1000.0, 1) AS duration_s, tokens, tool_uses FROM dispatches WHERE started_at_ms >= :since ORDER BY duration_ms DESC LIMIT 20` },
    ],
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/dashboards/starters.test.ts`
Expected: PASS.

The `toEqual({ ok: true, spec: b })` assertion requires every starter panel to carry an explicit `range`, because the validator fills in a default. All of the panels above do.

- [ ] **Step 5: Commit**

```bash
P="src/shared/dashboards/starters.ts electron/dashboards/starters.test.ts"
git add -- $P && git commit -m "feat(boards): Spend & cache and Agent fleet starter boards" -- $P
```

---

### Task 7: MCP data server tools

**Files:**
- Create: `electron/dashboards/dataServer.ts`
- Test: `electron/dashboards/dataServer.test.ts`

**Interfaces:**
- Consumes: `runQuery` (Task 4), `evaluatePanel` (Task 5), `validateSpec`, `ID_PATTERN`, `RANGES`, `CostSpec` (Task 2), `applyCost` (Task 3), `STARTER_BOARDS` (Task 6), `TOOL_ROW_CAP`, `RENDER_ROW_CAP` (Task 1), `writeFileAtomically` from `electron/atomicWrite.ts`
- Produces:
  - `interface DataServerDeps { dbPath: string; dashboardsDir: string; now: () => number }`
  - `interface ToolReply { text: string; isError: boolean }`
  - `DATA_TOOLS` (4 tool definitions)
  - `KNOWN_GAPS: string[]`
  - `handleDataTool(name: string, args: unknown, deps: DataServerDeps): Promise<ToolReply>`
  - `createDataMcpServer(deps: DataServerDeps): Server`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/dashboards/dataServer.test.ts`
Expected: FAIL, cannot resolve `./dataServer`.

- [ ] **Step 3: Write the implementation**

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomically } from '../atomicWrite';
import { runQuery } from './runQuery';
import { evaluatePanel } from './evaluatePanel';
import { applyCost } from '../../src/shared/dashboards/costing';
import { ID_PATTERN, RANGES, sinceForRange, validateSpec, type CostSpec, type Range } from '../../src/shared/dashboards/spec';
import { RENDER_ROW_CAP, TOOL_ROW_CAP } from '../../src/shared/dashboards/queryGuard';
import { STARTER_BOARDS } from '../../src/shared/dashboards/starters';

export interface DataServerDeps { dbPath: string; dashboardsDir: string; now: () => number }
export interface ToolReply { text: string; isError: boolean }

export const KNOWN_GAPS = [
  'collector.db stores tokens, never dollars. Request dollars with a panel "cost" ({ basis: "exact", groupBy } on model + the four token columns -> usd; { basis: "estimated", groupBy } on a tokens column -> usdApprox). Never compute prices in SQL.',
  'usage_events has no project or session column: spend by project or session is not possible.',
  'dispatches has no agent type or model: "which subagent" is not possible, and dispatch cost is always a blended-tier estimate.',
  'Cost panels need every row: aggregate in SQL (GROUP BY <groupBy>, model with SUM() of the token columns) so the result stays under 1000 rows.',
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
    sql: "SELECT m.name AS tbl, p.name AS col, p.type AS type FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid" });
  if (!cols.ok) return reply(cols.error, true);
  const tables = new Map<string, { name: string; type: string }[]>();
  for (const r of cols.rows) {
    const tbl = String(r.tbl);
    if (!/^[a-z_][a-z0-9_]*$/.test(tbl)) continue;
    tables.set(tbl, [...(tables.get(tbl) ?? []), { name: String(r.col), type: String(r.type) }]);
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
  if (typeof dashboardId !== 'string' || !ID_PATTERN.test(dashboardId)) return reply('dashboardId must match ^[a-z0-9-]{1,64}$.', true);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/dashboards/dataServer.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck:electron`
Expected: no errors.

```bash
P="electron/dashboards/dataServer.ts electron/dashboards/dataServer.test.ts"
git add -- $P && git commit -m "feat(boards): aether-data MCP tools" -- $P
```

---

### Task 8: MCP entry, build entry, register command

**Files:**
- Create: `electron/dashboards/dataServerEntry.ts`
- Create: `electron/dashboards/registerCommand.ts`
- Test: `electron/dashboards/registerCommand.test.ts`
- Test: `electron/dashboards/buildEntry.test.ts`
- Modify: `electron.vite.config.ts` (main `lib.entry`)

**Interfaces:**
- Consumes: `createDataMcpServer` (Task 7)
- Produces: `DATA_SERVER_ENTRY_FILE = 'aether-data-mcp.js'`, `buildRegisterCommand(execPath: string, entryPath: string): string`

- [ ] **Step 1: Write the failing tests**

`electron/dashboards/registerCommand.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildRegisterCommand } from './registerCommand';

describe('buildRegisterCommand', () => {
  it('registers aether-data with Electron running as node, name first so -e cannot swallow it', () => {
    expect(buildRegisterCommand('C:\\Apps\\Aether OS\\Aether OS.exe', 'C:\\Apps\\Aether OS\\resources\\app.asar\\out\\main\\aether-data-mcp.js')).toBe(
      'claude mcp add aether-data --scope user -e ELECTRON_RUN_AS_NODE=1 -- "C:\\Apps\\Aether OS\\Aether OS.exe" "C:\\Apps\\Aether OS\\resources\\app.asar\\out\\main\\aether-data-mcp.js"',
    );
  });
});
```

`electron/dashboards/buildEntry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The registered command points at out/main/aether-data-mcp.js. If this entry
// disappears from the build, registration silently breaks at Claude startup.
describe('electron-vite build', () => {
  it('builds the aether-data MCP entry', () => {
    const config = readFileSync(join(__dirname, '..', '..', 'electron.vite.config.ts'), 'utf8');
    expect(config).toContain("'aether-data-mcp': resolve(__dirname, 'electron/dashboards/dataServerEntry.ts')");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run electron/dashboards/registerCommand.test.ts electron/dashboards/buildEntry.test.ts`
Expected: FAIL. `./registerCommand` cannot be resolved, and the config does not contain the entry.

- [ ] **Step 3: Implement**

`electron/dashboards/registerCommand.ts`:

```ts
export const DATA_SERVER_ENTRY_FILE = 'aether-data-mcp.js';

/**
 * Clipboard text the operator pastes into a terminal to opt in. Aether never
 * runs it. The server name comes before `-e` because claude's `-e` takes a
 * variable number of values; the `--` then ends the option list.
 */
export function buildRegisterCommand(execPath: string, entryPath: string): string {
  return `claude mcp add aether-data --scope user -e ELECTRON_RUN_AS_NODE=1 -- "${execPath}" "${entryPath}"`;
}
```

`electron/dashboards/dataServerEntry.ts`:

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createDataMcpServer } from './dataServer';

// Executable entry only. Import dataServer for side-effect-free testing.
const aetherDir = join(homedir(), '.aether-os');
const server = createDataMcpServer({
  dbPath: join(aetherDir, 'collector.db'),
  dashboardsDir: join(aetherDir, 'dashboards'),
  now: () => Date.now(),
});
const close = () => { void server.close(); };
process.stdin.once('end', close);
process.once('SIGTERM', close);
process.once('SIGINT', close);
server.connect(new StdioServerTransport()).catch(() => { process.exitCode = 1; close(); });
```

In `electron.vite.config.ts`, change the main `lib.entry` object to:

```ts
      lib: { entry: {
        main: resolve(__dirname, 'electron/main.ts'),
        'communication-mcp': resolve(__dirname, 'electron/communicationBridge/mcpEntry.ts'),
        'aether-data-mcp': resolve(__dirname, 'electron/dashboards/dataServerEntry.ts'),
      } },
```

- [ ] **Step 4: Run tests and the build**

Run: `npx vitest run electron/dashboards/registerCommand.test.ts electron/dashboards/buildEntry.test.ts`
Expected: PASS.

Run: `npm run electron:build`, then `ls out/main/aether-data-mcp.js`
Expected: build succeeds, and the file exists.

Smoke test the stdio server through Electron-as-node:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe out/main/aether-data-mcp.js | head -c 600
```

Expected: a JSON-RPC response whose `tools` names include `describe_schema`. If Electron's bundled Node lacks `node:sqlite`, `describe_schema` fails later rather than here. Check this by also sending a `tools/call` for `describe_schema` and confirming the response is not an error, or is the "No collector data" message.

- [ ] **Step 5: Commit**

```bash
P="electron/dashboards/dataServerEntry.ts electron/dashboards/registerCommand.ts electron/dashboards/registerCommand.test.ts electron/dashboards/buildEntry.test.ts electron.vite.config.ts"
git add -- $P && git commit -m "feat(boards): aether-data stdio entry, build entry, register command" -- $P
```

---

### Task 9: Board store

**Files:**
- Create: `electron/dashboards/dashboardsStore.ts`
- Test: `electron/dashboards/dashboardsStore.test.ts`

**Interfaces:**
- Consumes: `validateSpec`, `ID_PATTERN`, `DashboardSpec`, `Range` (Task 2), `evaluatePanel` (Task 5), `RENDER_ROW_CAP` (Task 1), `BoardSummary`, `BoardsListing`, `RefreshResponse` (Task 4)
- Produces:
  - `interface DashboardsStoreOptions { dir: string; dbPath: string; starters?: DashboardSpec[]; now?: () => number; debounceMs?: number }`
  - `interface DashboardsStore { list(): BoardsListing; refresh(id: string, rangeOverride?: Range): Promise<RefreshResponse>; remove(id: string): { ok: boolean; error?: string }; seedStarters(): void; startWatching(onChange: (ids: string[]) => void): () => void }`
  - `createDashboardsStore(opts: DashboardsStoreOptions): DashboardsStore`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureCollectorDb } from './collectorDb.fixture';
import { createDashboardsStore } from './dashboardsStore';
import type { DashboardSpec } from '../../src/shared/dashboards/spec';

const now = Date.now();
const starter: DashboardSpec = { version: 1, id: 'starter', title: 'Starter', panels: [{ id: 'n', title: 'N', type: 'table', range: '7d', sql: 'SELECT COUNT(*) AS n FROM usage_events' }] };
const dirs: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aether-boards-store-'));
  dirs.push(root);
  const dir = join(root, 'dashboards');
  return { dir, store: createDashboardsStore({ dir, dbPath: createFixtureCollectorDb(now), starters: [starter], now: () => now, debounceMs: 20 }) };
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('dashboardsStore', () => {
  it('seeds starters once and never overwrites or re-seeds', () => {
    const { dir, store } = setup();
    store.seedStarters();
    expect(store.list().boards.map((b) => b.id)).toEqual(['starter']);
    writeFileSync(join(dir, 'starter.json'), JSON.stringify({ ...starter, title: 'Edited' }));
    store.seedStarters();
    expect(store.list().boards[0].title).toBe('Edited');
    unlinkSync(join(dir, 'starter.json'));
    store.seedStarters();
    expect(store.list().boards).toEqual([]);
  });

  it('lists an invalid board with its first error, without hiding valid ones (Review Focus 3)', () => {
    const { dir, store } = setup();
    store.seedStarters();
    writeFileSync(join(dir, 'broken.json'), '{ nope');
    writeFileSync(join(dir, 'renamed.json'), JSON.stringify({ ...starter, id: 'other' }));
    const boards = store.list().boards;
    expect(boards.map((b) => [b.id, b.error === null])).toEqual([['broken', false], ['renamed', false], ['starter', true]]);
    expect(boards.find((b) => b.id === 'renamed')?.error).toContain('does not match');
  });

  it('refresh returns one result per panel, and one failing panel does not fail the rest', async () => {
    const { dir, store } = setup();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'two.json'), JSON.stringify({ ...starter, id: 'two', panels: [starter.panels[0], { ...starter.panels[0], id: 'bad', sql: 'SELECT nope FROM usage_events' }] }));
    const r = await store.refresh('two');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.panels.map((p) => [p.panelId, p.error === null])).toEqual([['n', true], ['bad', false]]);
  });

  it('refresh and remove refuse ids that are not board ids', async () => {
    const { store } = setup();
    expect(await store.refresh('../x')).toEqual({ ok: false, error: 'Unknown board.' });
    expect(store.remove('../x')).toEqual({ ok: false, error: 'Unknown board.' });
  });

  it('remove deletes the board file', () => {
    const { dir, store } = setup();
    store.seedStarters();
    expect(store.remove('starter')).toEqual({ ok: true });
    expect(existsSync(join(dir, 'starter.json'))).toBe(false);
  });

  it('nothing it returns contains an absolute path', async () => {
    const { dir, store } = setup();
    store.seedStarters();
    const payload = JSON.stringify([store.list(), await store.refresh('starter')]);
    expect(payload).not.toContain(dir);
    expect(payload).not.toMatch(/[A-Za-z]:\\\\|\/Users\/|\/home\//);
  });

  it('watching reports changed board ids, debounced', async () => {
    const { dir, store } = setup();
    store.seedStarters();
    const seen: string[][] = [];
    const stop = store.startWatching((ids) => seen.push(ids));
    writeFileSync(join(dir, 'starter.json'), readFileSync(join(dir, 'starter.json'), 'utf8'));
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(seen.flat()).toContain('starter');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/dashboards/dashboardsStore.test.ts`
Expected: FAIL, cannot resolve `./dashboardsStore`.

- [ ] **Step 3: Write the implementation**

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ID_PATTERN, validateSpec, type DashboardSpec, type Range } from '../../src/shared/dashboards/spec';
import { RENDER_ROW_CAP } from '../../src/shared/dashboards/queryGuard';
import type { BoardSummary, BoardsListing, RefreshResponse } from '../../src/shared/dashboards/types';
import { evaluatePanel } from './evaluatePanel';

export interface DashboardsStoreOptions { dir: string; dbPath: string; starters?: DashboardSpec[]; now?: () => number; debounceMs?: number }
export interface DashboardsStore {
  list(): BoardsListing;
  refresh(id: string, rangeOverride?: Range): Promise<RefreshResponse>;
  remove(id: string): { ok: boolean; error?: string };
  seedStarters(): void;
  startWatching(onChange: (ids: string[]) => void): () => void;
}

const SEEDED_MARKER = '.seeded';

export function createDashboardsStore(opts: DashboardsStoreOptions): DashboardsStore {
  const now = opts.now ?? Date.now;
  const ensureDir = () => mkdirSync(opts.dir, { recursive: true });
  const fileFor = (id: string) => join(opts.dir, `${id}.json`);

  function readBoard(id: string): { spec: DashboardSpec } | { error: string } {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(fileFor(id), 'utf8')); } catch (e) { return { error: `invalid JSON: ${(e as Error).message}` }; }
    const v = validateSpec(raw);
    if (!v.ok) return { error: v.errors[0] };
    if (v.spec.id !== id) return { error: `id "${v.spec.id}" does not match its file name "${id}.json"` };
    return { spec: v.spec };
  }

  function summarize(id: string): BoardSummary {
    const r = readBoard(id);
    if ('error' in r) return { id, title: id, error: r.error, panels: [] };
    return {
      id, title: r.spec.title, error: null,
      panels: r.spec.panels.map((p) => ({ id: p.id, title: p.title, type: p.type, range: p.range, sql: p.sql,
        costBasis: p.cost?.basis ?? null, x: p.x ?? null, y: p.y ?? [] })),
    };
  }

  return {
    list() {
      ensureDir();
      const ids = readdirSync(opts.dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((id) => ID_PATTERN.test(id)).sort();
      return { collectorAvailable: existsSync(opts.dbPath), boards: ids.map(summarize) };
    },

    async refresh(id, rangeOverride) {
      if (!ID_PATTERN.test(id)) return { ok: false, error: 'Unknown board.' };
      const r = readBoard(id);
      if ('error' in r) return { ok: false, error: r.error };
      const nowMs = now();
      const panels = await Promise.all(r.spec.panels.map((p) => evaluatePanel(p, { dbPath: opts.dbPath, nowMs, rowCap: RENDER_ROW_CAP, rangeOverride })));
      return { ok: true, panels };
    },

    remove(id) {
      if (!ID_PATTERN.test(id)) return { ok: false, error: 'Unknown board.' };
      try { unlinkSync(fileFor(id)); return { ok: true }; } catch (e) { return { ok: false, error: (e as Error).message }; }
    },

    seedStarters() {
      ensureDir();
      const markerPath = join(opts.dir, SEEDED_MARKER);
      let seeded: string[] = [];
      try {
        const v: unknown = JSON.parse(readFileSync(markerPath, 'utf8'));
        if (Array.isArray(v)) seeded = v.filter((s): s is string => typeof s === 'string');
      } catch { /* first run */ }
      let changed = false;
      for (const s of opts.starters ?? []) {
        if (seeded.includes(s.id)) continue;
        // Seeded once: an edited starter is never overwritten and a deleted one never returns.
        try { if (!existsSync(fileFor(s.id))) writeFileSync(fileFor(s.id), `${JSON.stringify(s, null, 2)}\n`, { flag: 'wx' }); } catch { /* raced a writer; keep theirs */ }
        seeded.push(s.id);
        changed = true;
      }
      if (changed) writeFileSync(markerPath, JSON.stringify(seeded));
    },

    startWatching(onChange) {
      ensureDir();
      const pending = new Set<string>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watcher = watch(opts.dir, (_event, filename) => {
        const name = filename ? String(filename) : '';
        if (!name.endsWith('.json')) return;
        const id = name.slice(0, -5);
        if (!ID_PATTERN.test(id)) return;
        pending.add(id);
        clearTimeout(timer);
        timer = setTimeout(() => { const ids = [...pending]; pending.clear(); onChange(ids); }, opts.debounceMs ?? 250);
      });
      return () => { clearTimeout(timer); watcher.close(); };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/dashboards/dashboardsStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
P="electron/dashboards/dashboardsStore.ts electron/dashboards/dashboardsStore.test.ts"
git add -- $P && git commit -m "feat(boards): board store (list, seed, refresh, delete, watch)" -- $P
```

---

### Task 10: busy_timeout on the existing collector.db readers

**Files:**
- Modify: `electron/collectorStore.ts:139-147` (`openReadOnly`), exported for the test
- Modify: `electron/main.ts:1080-1088` (`openCollectorDbReadOnly`)
- Test: `electron/collectorStore.test.ts` (append)

**Interfaces:**
- Produces: `export const READ_BUSY_TIMEOUT_MS = 5000` and `export function openReadOnly(dbPath: string): DatabaseSync | null` in `collectorStore.ts`

- [ ] **Step 1: Write the failing test** (append to `electron/collectorStore.test.ts`, and add `openReadOnly` to its import from `./collectorStore.js`)

```ts
describe('openReadOnly', () => {
  it('sets a 5s busy timeout so reads wait out a collector write instead of failing', () => {
    const db = openReadOnly(tempDbWithUsageEvents([]));
    expect(db).not.toBeNull();
    expect(db!.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    db!.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/collectorStore.test.ts`
Expected: FAIL. `openReadOnly` is not exported (or the timeout is 0).

- [ ] **Step 3: Implement**

In `electron/collectorStore.ts`, replace the `openReadOnly` function with:

```ts
// The collector writes collector.db in journal_mode=delete; a reader without a
// busy timeout fails immediately with "database is locked" during a large
// write (seen during backfill, 2026-10-11).
export const READ_BUSY_TIMEOUT_MS = 5000;

export function openReadOnly(dbPath: string): DatabaseSync | null {
  if (!existsSync(dbPath)) return null;
  try {
    const sqlite = require('node:sqlite');
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${READ_BUSY_TIMEOUT_MS}`);
    return db;
  } catch {
    return null;
  }
}
```

In `electron/main.ts`, change the body of `openCollectorDbReadOnly` to:

```ts
function openCollectorDbReadOnly(): DatabaseSync | null {
  if (!existsSync(collectorDbPath)) return null;
  try {
    const sqlite = require('node:sqlite');
    const db = new sqlite.DatabaseSync(collectorDbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000'); // same reason as collectorStore.openReadOnly
    return db;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run electron/collectorStore.test.ts && npm run typecheck:electron`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
P="electron/collectorStore.ts electron/collectorStore.test.ts electron/main.ts"
git add -- $P && git commit -m "fix(collector-read): 5s busy timeout on read-only collector.db handles" -- $P
```

---

### Task 11: IPC, preload, and renderer typing

**Files:**
- Modify: `electron/main.ts` (imports; store creation near the path constants ~line 390; IPC handlers next to the `retention:*` handlers; seeding and watching inside the `app.whenReady().then(async () => {` block at ~line 811, after the `isStatuslineUninstallRun` early return; stopping the watcher in `app.on('before-quit', …)` at ~line 1024)
- Modify: `electron/preload.ts` (add a `dashboards` block after `ledger`)
- Modify: `src/aetherElectron.d.ts` (add the matching `dashboards` block after `ledger`)

**Interfaces:**
- Consumes: `createDashboardsStore` (Task 9), `buildRegisterCommand`, `DATA_SERVER_ENTRY_FILE` (Task 8), `STARTER_BOARDS` (Task 6), `RANGES`, `Range` (Task 2), the types from Task 4
- Produces: `window.aetherElectron.dashboards`:
  - `list(): Promise<BoardsListing>`
  - `refresh(id: string, range?: Range): Promise<RefreshResponse>`
  - `remove(id: string): Promise<{ ok: boolean; error?: string }>`
  - `copyRegisterCommand(): Promise<{ ok: boolean }>`
  - `onChanged(cb: (ids: string[]) => void): () => void`

- [ ] **Step 1: Wire main**

Add `clipboard` to the existing `import { app, BrowserWindow, ipcMain, … } from 'electron';` line. Add these imports:

```ts
import { createDashboardsStore } from './dashboards/dashboardsStore';
import { buildRegisterCommand, DATA_SERVER_ENTRY_FILE } from './dashboards/registerCommand';
import { STARTER_BOARDS } from '../src/shared/dashboards/starters';
import { RANGES, type Range } from '../src/shared/dashboards/spec';
```

After `const aetherOsDir = join(os.homedir(), '.aether-os');`:

```ts
const dashboardsStore = createDashboardsStore({ dir: join(aetherOsDir, 'dashboards'), dbPath: collectorDbPath, starters: STARTER_BOARDS });
let stopDashboardsWatch: (() => void) | null = null;
```

Next to the `retention:*` handlers:

```ts
// Boards. Ids only cross IPC; the register command is built and copied here so
// its absolute paths never reach the renderer.
const fromMainWindow = (event: Electron.IpcMainInvokeEvent) =>
  !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
ipcMain.handle('dashboards:list', () => dashboardsStore.list());
ipcMain.handle('dashboards:refresh', (_event, id: unknown, range: unknown) =>
  typeof id === 'string'
    ? dashboardsStore.refresh(id, RANGES.includes(range as Range) ? (range as Range) : undefined)
    : { ok: false, error: 'Unknown board.' });
ipcMain.handle('dashboards:delete', (event, id: unknown) =>
  fromMainWindow(event) && typeof id === 'string' ? dashboardsStore.remove(id) : { ok: false, error: 'Refused.' });
ipcMain.handle('dashboards:copyRegisterCommand', (event) => {
  if (!fromMainWindow(event)) return { ok: false };
  clipboard.writeText(buildRegisterCommand(process.execPath, join(__dirname, DATA_SERVER_ENTRY_FILE)));
  return { ok: true };
});
```

Inside `app.whenReady().then(async () => {`, after `if (isStatuslineUninstallRun) return;`:

```ts
  try {
    dashboardsStore.seedStarters();
    stopDashboardsWatch = dashboardsStore.startWatching((ids) => sendToWindow('dashboards:changed', ids));
  } catch (e) {
    diagLog.write(`[diag] boards init failed: ${(e as Error).message}`);
  }
```

Inside `app.on('before-quit', event => {`, after `isQuitting = true;`:

```ts
  stopDashboardsWatch?.();
  stopDashboardsWatch = null;
```

- [ ] **Step 2: Wire preload** (`electron/preload.ts`, after the `ledger` block; add the type imports at the top)

```ts
import type { BoardsListing, RefreshResponse } from '../src/shared/dashboards/types';
import type { Range } from '../src/shared/dashboards/spec';
```

```ts
  dashboards: {
    list: (): Promise<BoardsListing> => ipcRenderer.invoke('dashboards:list'),
    refresh: (id: string, range?: Range): Promise<RefreshResponse> => ipcRenderer.invoke('dashboards:refresh', id, range),
    remove: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('dashboards:delete', id),
    copyRegisterCommand: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('dashboards:copyRegisterCommand'),
    onChanged: (callback: (ids: string[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, ids: string[]) => callback(ids);
      ipcRenderer.on('dashboards:changed', listener);
      return () => ipcRenderer.removeListener('dashboards:changed', listener);
    },
  },
```

- [ ] **Step 3: Type the renderer surface** (`src/aetherElectron.d.ts`, after the `ledger` block; add the imports at the top with the others)

```ts
import type { BoardsListing, RefreshResponse } from './shared/dashboards/types';
import type { Range as BoardRange } from './shared/dashboards/spec';
```

```ts
      dashboards: {
        list: () => Promise<BoardsListing>;
        refresh: (id: string, range?: BoardRange) => Promise<RefreshResponse>;
        remove: (id: string) => Promise<{ ok: boolean; error?: string }>;
        copyRegisterCommand: () => Promise<{ ok: boolean }>;
        onChanged: (callback: (ids: string[]) => void) => () => void;
      };
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck:electron && npm run build && npx vitest run src/shared/noApiCalls.test.ts`
Expected: no type errors, the build succeeds, and noApiCalls passes.

- [ ] **Step 5: Commit**

```bash
P="electron/main.ts electron/preload.ts src/aetherElectron.d.ts"
git add -- $P && git commit -m "feat(boards): IPC, preload and renderer typing" -- $P
```

---

### Task 12: Renderer pure helpers

**Files:**
- Create: `src/components/boards/formatValue.ts`, `src/components/boards/chartMath.ts`, `src/components/boards/boardsState.ts`
- Test: `src/components/boards/formatValue.test.ts`, `src/components/boards/chartMath.test.ts`, `src/components/boards/boardsState.test.ts`

**Interfaces:**
- Consumes: `usdPrecise`, `approxUsd` from `src/components/ledger/format.ts`; `PanelResult` (Task 4)
- Produces:
  - `NO_DATA = 'no data'`, `formatValue(column: string, value: unknown): string`, `formatLabel(value: unknown): string`
  - `interface Series { column: string; values: (number | null)[] }`, `seriesFrom(rows, x, ys): { labels: string[]; series: Series[] }`, `niceMax(max: number): number`, `pointX(i, n, width)`, `pointY(v, height, max)`, `linePaths(values, width, height, max): string[]`
  - `type ShownPanel = PanelResult & { staleBusy: boolean }`, `mergeRefresh(prev: Record<string, ShownPanel>, next: PanelResult[]): Record<string, ShownPanel>`
  - `AUTO_REFRESH = { off: 0, '60s': 60_000, '5m': 300_000 } as const`, `type AutoRefresh = keyof typeof AUTO_REFRESH`

- [ ] **Step 1: Write the failing tests**

`formatValue.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatLabel, formatValue, NO_DATA } from './formatValue';

describe('formatValue', () => {
  it('null is "no data", never $0.00', () => {
    expect(formatValue('usd', null)).toBe(NO_DATA);
    expect(formatValue('usdApprox', undefined)).toBe(NO_DATA);
  });
  it('usd has no tilde; usdApprox always does', () => {
    expect(formatValue('usd', 1.234)).toBe('$1.23');
    expect(formatValue('usd', 0.001)).toBe('<$0.01');
    expect(formatValue('usdApprox', 1.234)).toBe('~$1.23');
    expect(formatValue('usdApprox', 0.001)).toBe('~<$0.01');
  });
  it('*_rate is a percent; integers get separators', () => {
    expect(formatValue('hit_rate', 0.4567)).toBe('45.7%');
    expect(formatValue('calls', 12345)).toBe('12,345');
  });
  it('labels show (none) for null', () => {
    expect(formatLabel(null)).toBe('(none)');
    expect(formatLabel('Read')).toBe('Read');
  });
});
```

`chartMath.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { linePaths, niceMax, seriesFrom } from './chartMath';

describe('chartMath', () => {
  it('niceMax rounds up to 1/2/5 × 10^n and is 1 for empty data', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(0.032)).toBeCloseTo(0.05);
    expect(niceMax(120)).toBe(200);
  });
  it('linePaths breaks at null so missing days show as gaps', () => {
    expect(linePaths([1, null, 2, 3], 30, 10, 4)).toEqual(['M0.0 7.5', 'M20.0 5.0 L30.0 2.5']);
  });
  it('seriesFrom turns non-numbers into null', () => {
    expect(seriesFrom([{ d: 'a', v: 1 }, { d: 'b', v: null }], 'd', ['v'])).toEqual({ labels: ['a', 'b'], series: [{ column: 'v', values: [1, null] }] });
  });
});
```

`boardsState.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mergeRefresh } from './boardsState';
import type { PanelResult } from '../../shared/dashboards/types';

const ok = (id: string, n: number): PanelResult => ({ panelId: id, columns: ['n'], rows: [{ n }], truncated: false, unpricedRows: 0, error: null, errorKind: null, refreshedAt: n });
const busy = (id: string): PanelResult => ({ panelId: id, columns: [], rows: [], truncated: false, unpricedRows: 0, error: 'database is locked', errorKind: 'busy', refreshedAt: 9 });

describe('mergeRefresh', () => {
  it('a busy panel keeps its last good data, flagged stale (Review Focus 5)', () => {
    const first = mergeRefresh({}, [ok('a', 1), ok('b', 1)]);
    const second = mergeRefresh(first, [busy('a'), ok('b', 2)]);
    expect(second.a).toMatchObject({ rows: [{ n: 1 }], staleBusy: true });
    expect(second.b).toMatchObject({ rows: [{ n: 2 }], staleBusy: false });
  });
  it('busy with no prior good data shows the error', () => {
    expect(mergeRefresh({}, [busy('a')]).a).toMatchObject({ errorKind: 'busy', staleBusy: false });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/boards`
Expected: FAIL, the modules don't exist.

- [ ] **Step 3: Implement**

`formatValue.ts`:

```ts
import { approxUsd, usdPrecise } from '../ledger/format';

/** "No data" and "$0.00" are different answers (Stage 15); null always renders as this. */
export const NO_DATA = 'no data';

export function formatValue(column: string, value: unknown): string {
  if (value === null || value === undefined) return NO_DATA;
  if (typeof value !== 'number') return String(value);
  if (column === 'usd') return usdPrecise(value);
  if (column === 'usdApprox') return value > 0 && value < 0.005 ? '~<$0.01' : approxUsd(value);
  if (column.endsWith('_rate')) return `${(value * 100).toFixed(1)}%`;
  return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function formatLabel(value: unknown): string {
  return value === null || value === undefined ? '(none)' : String(value);
}
```

`chartMath.ts`:

```ts
import { formatLabel } from './formatValue';

export interface Series { column: string; values: (number | null)[] }

export function seriesFrom(rows: Record<string, unknown>[], x: string, ys: string[]): { labels: string[]; series: Series[] } {
  return {
    labels: rows.map((r) => formatLabel(r[x])),
    series: ys.map((column) => ({
      column,
      values: rows.map((r) => (typeof r[column] === 'number' && Number.isFinite(r[column]) ? (r[column] as number) : null)),
    })),
  };
}

export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  const f = max / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

export const pointX = (i: number, n: number, width: number) => (n <= 1 ? width / 2 : (i / (n - 1)) * width);
export const pointY = (v: number, height: number, max: number) => height - (Math.max(0, v) / max) * height;

/** One SVG path per run of non-null values: a null breaks the line, so a no-data day is a visible gap. */
export function linePaths(values: (number | null)[], width: number, height: number, max: number): string[] {
  const paths: string[] = [];
  let current = '';
  values.forEach((v, i) => {
    if (v === null) { if (current) paths.push(current); current = ''; return; }
    current += `${current ? ' L' : 'M'}${pointX(i, values.length, width).toFixed(1)} ${pointY(v, height, max).toFixed(1)}`;
  });
  if (current) paths.push(current);
  return paths;
}
```

`boardsState.ts`:

```ts
import type { PanelResult } from '../../shared/dashboards/types';

export type ShownPanel = PanelResult & { staleBusy: boolean };
export const AUTO_REFRESH = { off: 0, '60s': 60_000, '5m': 300_000 } as const;
export type AutoRefresh = keyof typeof AUTO_REFRESH;

/** A busy panel keeps its last good result (flagged) instead of blanking while the collector writes. */
export function mergeRefresh(prev: Record<string, ShownPanel>, next: PanelResult[]): Record<string, ShownPanel> {
  const out: Record<string, ShownPanel> = {};
  for (const r of next) {
    const before = prev[r.panelId];
    out[r.panelId] = r.errorKind === 'busy' && before && before.error === null
      ? { ...before, staleBusy: true }
      : { ...r, staleBusy: false };
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/boards`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
P="src/components/boards/formatValue.ts src/components/boards/formatValue.test.ts src/components/boards/chartMath.ts src/components/boards/chartMath.test.ts src/components/boards/boardsState.ts src/components/boards/boardsState.test.ts"
git add -- $P && git commit -m "feat(boards): value formatting, chart math, busy-aware refresh merge" -- $P
```

---

### Task 13: Chart components

**Files:**
- Create: `src/components/boards/LinePanel.tsx`, `BarPanel.tsx`, `StatPanel.tsx`, `TablePanel.tsx`

**Interfaces:**
- Consumes: Task 12 helpers, `useColors`, `fonts`
- Produces:
  - `LinePanel({ rows, x, y })`
  - `BarPanel({ rows, x, y })`
  - `StatPanel({ rows, y })`
  - `TablePanel({ columns, rows })`
  - All props are `rows: Record<string, unknown>[]`, `x: string`, `y: string[]`, `columns: string[]`.

Visuals are not unit-tested, per the repo convention. They are exercised by the Task 14 render test and the Task 15 visual check.

- [ ] **Step 1: Implement**

`LinePanel.tsx`:

```tsx
import { useColors } from '../shared/useColors';
import { fonts } from '../../styles/tokens';
import { linePaths, niceMax, pointX, pointY, seriesFrom } from './chartMath';
import { formatValue } from './formatValue';

const W = 640;
const H = 200;
const PAD_L = 72;
const PAD_B = 22;

export function LinePanel({ rows, x, y }: { rows: Record<string, unknown>[]; x: string; y: string[] }) {
  const colors = useColors();
  const { labels, series } = seriesFrom(rows, x, y);
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null))));
  const plotW = W - PAD_L;
  const plotH = H - PAD_B;
  const axisText = { fill: colors.textMuted, fontFamily: fonts.mono, fontSize: 10 };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${y.join(', ')} by ${x}`}>
      <line x1={PAD_L} y1={plotH} x2={W} y2={plotH} stroke={colors.chromeBorder} />
      <text x={PAD_L - 6} y={10} textAnchor="end" {...axisText}>{formatValue(y[0], max)}</text>
      <text x={PAD_L - 6} y={plotH} textAnchor="end" {...axisText}>{formatValue(y[0], 0)}</text>
      {labels.length > 0 && <text x={PAD_L} y={H - 6} {...axisText}>{labels[0]}</text>}
      {labels.length > 1 && <text x={W} y={H - 6} textAnchor="end" {...axisText}>{labels[labels.length - 1]}</text>}
      {series.map((s, i) => {
        const color = colors.agentHues[i % colors.agentHues.length];
        return (
          <g key={s.column} transform={`translate(${PAD_L},0)`}>
            {linePaths(s.values, plotW, plotH, max).map((d, j) => <path key={j} d={d} fill="none" stroke={color} strokeWidth={2} />)}
            {s.values.map((v, j) => v === null ? null : (
              <circle key={j} cx={pointX(j, s.values.length, plotW)} cy={pointY(v, plotH, max)} r={2.5} fill={color}>
                <title>{`${labels[j]}: ${formatValue(s.column, v)}`}</title>
              </circle>
            ))}
          </g>
        );
      })}
    </svg>
  );
}
```

`BarPanel.tsx`:

```tsx
import { useColors } from '../shared/useColors';
import { fonts } from '../../styles/tokens';
import { niceMax, seriesFrom } from './chartMath';
import { formatValue } from './formatValue';

export function BarPanel({ rows, x, y }: { rows: Record<string, unknown>[]; x: string; y: string[] }) {
  const colors = useColors();
  const { labels, series } = seriesFrom(rows, x, y);
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null))));
  return (
    <div style={{ display: 'grid', gap: 4, fontFamily: fonts.mono, fontSize: 11 }}>
      {labels.map((label, i) => (
        <div key={`${label}-${i}`} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 110px', alignItems: 'center', gap: 8 }}>
          <span title={label} style={{ color: colors.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          <div style={{ display: 'grid', gap: 2 }}>
            {series.map((s, j) => {
              const v = s.values[i];
              return <div key={s.column} style={{ height: 8, width: v === null ? 0 : `${(Math.max(0, v) / max) * 100}%`, background: colors.agentHues[j % colors.agentHues.length] }} />;
            })}
          </div>
          <span style={{ color: colors.textBody, textAlign: 'right' }}>{series.map((s) => formatValue(s.column, s.values[i])).join(' / ')}</span>
        </div>
      ))}
    </div>
  );
}
```

`StatPanel.tsx`:

```tsx
import { useColors } from '../shared/useColors';
import { fonts } from '../../styles/tokens';
import { formatValue } from './formatValue';

export function StatPanel({ rows, y }: { rows: Record<string, unknown>[]; y: string[] }) {
  const colors = useColors();
  const column = y[0];
  return (
    <div>
      <div style={{ fontFamily: fonts.mono, fontSize: 32, color: colors.textPrimary }}>{formatValue(column, rows[0]?.[column] ?? null)}</div>
      {rows.length > 1 && <div style={{ color: colors.textMuted, fontSize: 11 }}>first of {rows.length} rows</div>}
    </div>
  );
}
```

`TablePanel.tsx`:

```tsx
import { useColors } from '../shared/useColors';
import { fonts } from '../../styles/tokens';
import { formatValue } from './formatValue';

export function TablePanel({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  const colors = useColors();
  const cell = { padding: '2px 8px', borderBottom: `1px solid ${colors.chromeBorder}`, textAlign: 'left' as const };
  return (
    <div style={{ maxHeight: 260, overflow: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: fonts.mono, fontSize: 11, color: colors.textBody }}>
        <thead><tr>{columns.map((c) => <th key={c} style={{ ...cell, color: colors.textSecondary }}>{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{columns.map((c) => <td key={c} style={cell}>{formatValue(c, r[c])}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
P="src/components/boards/LinePanel.tsx src/components/boards/BarPanel.tsx src/components/boards/StatPanel.tsx src/components/boards/TablePanel.tsx"
git add -- $P && git commit -m "feat(boards): SVG line/bar, stat and table panels" -- $P
```

---

### Task 14: Boards view and registration

**Files:**
- Create: `src/components/boards/BoardPanel.tsx`, `src/components/boards/useBoards.ts`, `src/components/boards/BoardsView.tsx`
- Test: `src/components/boards/BoardsView.render.test.tsx`
- Modify: `src/viewRegistry.ts` (import + entry after `Ledger`), `src/viewRegistry.test.ts` (insert `'Boards'` after `'Ledger'`)

**Interfaces:**
- Consumes: Tasks 11–13
- Produces: `BoardsView` (registered as view id `Boards`)

- [ ] **Step 1: Write the failing render test**

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BoardsView } from './BoardsView';
import type { BoardsListing, RefreshResponse } from '../../shared/dashboards/types';

const listing: BoardsListing = {
  collectorAvailable: true,
  boards: [
    { id: 'spend-cache', title: 'Spend & cache', error: null, panels: [
      { id: 'today', title: 'Spend today', type: 'stat', range: '24h', sql: 'SELECT 1', costBasis: 'exact', x: null, y: ['usd'] },
      { id: 'disp', title: 'Dispatch spend', type: 'table', range: '7d', sql: 'SELECT 2', costBasis: 'estimated', x: null, y: [] },
    ] },
    { id: 'broken', title: 'broken', error: 'invalid JSON: Unexpected token', panels: [] },
  ],
};
const refreshed: RefreshResponse = { ok: true, panels: [
  { panelId: 'today', columns: ['period', 'usd'], rows: [{ period: 'last 24h', usd: null }], truncated: false, unpricedRows: 2, error: null, errorKind: null, refreshedAt: 1 },
  { panelId: 'disp', columns: ['day', 'usdApprox'], rows: [{ day: '2026-10-11', usdApprox: 1.5 }], truncated: false, unpricedRows: 0, error: null, errorKind: null, refreshedAt: 1 },
] };

function mockApi(overrides: Partial<BoardsListing> = {}) {
  const api = {
    list: vi.fn().mockResolvedValue({ ...listing, ...overrides }),
    refresh: vi.fn().mockResolvedValue(refreshed),
    remove: vi.fn().mockResolvedValue({ ok: true }),
    copyRegisterCommand: vi.fn().mockResolvedValue({ ok: true }),
    onChanged: vi.fn().mockReturnValue(() => {}),
  };
  (window as unknown as { aetherElectron: unknown }).aetherElectron = { dashboards: api };
  return api;
}
afterEach(() => { cleanup(); delete (window as unknown as { aetherElectron?: unknown }).aetherElectron; });

describe('BoardsView', () => {
  it('renders boards as tabs, refreshes the first, and shows null cost as "no data" not $0.00', async () => {
    const api = mockApi();
    render(<BoardsView />);
    expect(await screen.findByText('Spend & cache')).toBeTruthy();
    expect(await screen.findByText('no data')).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(screen.getByText(/2 rows unpriced/)).toBeTruthy();
    expect(screen.getByText('~$1.50')).toBeTruthy();
    expect(api.refresh).toHaveBeenCalledWith('spend-cache', undefined);
  });

  it('an invalid board shows its error', async () => {
    mockApi();
    render(<BoardsView />);
    fireEvent.click(await screen.findByText('broken'));
    expect(await screen.findByText(/invalid: invalid JSON/)).toBeTruthy();
  });

  it('shows the no-collector banner', async () => {
    mockApi({ collectorAvailable: false });
    render(<BoardsView />);
    expect(await screen.findByText(/No collector data/)).toBeTruthy();
  });

  it('delete needs an in-page confirmation', async () => {
    const api = mockApi();
    render(<BoardsView />);
    fireEvent.click(await screen.findByText('Delete board'));
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Confirm delete'));
    expect(api.remove).toHaveBeenCalledWith('spend-cache');
  });

  it('the + tab copies the register command', async () => {
    const api = mockApi();
    render(<BoardsView />);
    fireEvent.click(await screen.findByLabelText('New board'));
    fireEvent.click(screen.getByText('Copy register command'));
    expect(api.copyRegisterCommand).toHaveBeenCalled();
    expect(await screen.findByText(/Copied/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/boards/BoardsView.render.test.tsx`
Expected: FAIL, cannot resolve `./BoardsView`.

- [ ] **Step 3: Implement**

`useBoards.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import type { BoardsListing } from '../../shared/dashboards/types';

/** Pull-based, view-local (like useTranscriptSource): board rows never enter the store. */
export function useBoards() {
  const api = window.aetherElectron?.dashboards;
  const [listing, setListing] = useState<BoardsListing | null>(null);
  const [changed, setChanged] = useState<{ ids: string[]; n: number }>({ ids: [], n: 0 });
  const reload = useCallback(() => { void api?.list().then(setListing); }, [api]);
  useEffect(() => {
    reload();
    if (!api) return undefined;
    return api.onChanged((ids) => { reload(); setChanged((c) => ({ ids, n: c.n + 1 })); });
  }, [api, reload]);
  return { api, listing, changed, reload };
}
```

`BoardPanel.tsx`:

```tsx
import { useState } from 'react';
import { Button } from '../shared/Button';
import { useColors } from '../shared/useColors';
import { fonts } from '../../styles/tokens';
import type { PanelSummary } from '../../shared/dashboards/types';
import type { ShownPanel } from './boardsState';
import { NO_DATA } from './formatValue';
import { LinePanel } from './LinePanel';
import { BarPanel } from './BarPanel';
import { StatPanel } from './StatPanel';
import { TablePanel } from './TablePanel';

export function BoardPanel({ panel, result, refreshing }: { panel: PanelSummary; result: ShownPanel | undefined; refreshing: boolean }) {
  const colors = useColors();
  const [showSql, setShowSql] = useState(false);
  const notes: string[] = [];
  if (result?.staleBusy) notes.push('collector busy: showing last good data, retry');
  if (result?.truncated) notes.push(`truncated at ${result.rows.length}`);
  if (result && result.unpricedRows > 0) notes.push(`${result.unpricedRows} rows unpriced (no model)`);
  if (panel.costBasis === 'estimated') notes.push('est. (blended tier rate)');
  if (panel.costBasis === 'exact') notes.push('API rate (not paid)');

  let body: JSX.Element;
  if (!result) body = <div style={{ color: colors.textMuted }}>{refreshing ? 'Loading…' : 'Not refreshed yet.'}</div>;
  else if (result.error && !result.staleBusy) {
    body = <div role="alert" style={{ color: colors.danger, fontFamily: fonts.mono, fontSize: 11 }}>{result.errorKind === 'busy' ? 'Collector is busy, retry.' : result.error}</div>;
  } else if (result.rows.length === 0) body = <div style={{ color: colors.textMuted }}>{NO_DATA}</div>;
  else if (panel.type === 'line') body = <LinePanel rows={result.rows} x={panel.x ?? ''} y={panel.y} />;
  else if (panel.type === 'bar') body = <BarPanel rows={result.rows} x={panel.x ?? ''} y={panel.y} />;
  else if (panel.type === 'stat') body = <StatPanel rows={result.rows} y={panel.y} />;
  else body = <TablePanel columns={result.columns} rows={result.rows} />;

  return (
    <section aria-label={panel.title} style={{ background: colors.panelGradient, border: `1px solid ${colors.panelBorder}`, padding: 12, display: 'grid', gap: 8, minWidth: 0 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <h3 style={{ margin: 0, fontFamily: fonts.ui, fontSize: 14, color: colors.textPrimary, letterSpacing: 1 }}>{panel.title}</h3>
        <Button aria-pressed={showSql} onClick={() => setShowSql((v) => !v)} style={{ fontSize: 11, color: colors.textSecondary, background: colors.panelInset, border: `1px solid ${colors.chipBorder}`, padding: '2px 8px' }}>
          {showSql ? 'Hide query' : 'Show query'}
        </Button>
      </header>
      {showSql && <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: fonts.mono, fontSize: 11, color: colors.textSecondary, background: colors.panelInset, padding: 8 }}>{panel.sql}</pre>}
      {body}
      {notes.length > 0 && <div style={{ color: colors.textMuted, fontSize: 11 }}>{notes.join(' · ')}</div>}
    </section>
  );
}
```

`BoardsView.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../shared/Button';
import { useColors } from '../shared/useColors';
import { fonts } from '../../styles/tokens';
import { RANGES, type Range } from '../../shared/dashboards/spec';
import { AUTO_REFRESH, mergeRefresh, type AutoRefresh, type ShownPanel } from './boardsState';
import { BoardPanel } from './BoardPanel';
import { useBoards } from './useBoards';

const PLUS = '+'; // never a board id: ids match ^[a-z0-9-]+$

function readAuto(id: string): AutoRefresh {
  try { const v = localStorage.getItem(`boards.autoRefresh.${id}`); return v && v in AUTO_REFRESH ? (v as AutoRefresh) : 'off'; } catch { return 'off'; }
}
function writeAuto(id: string, v: AutoRefresh) {
  try { localStorage.setItem(`boards.autoRefresh.${id}`, v); } catch { /* per-viewer convenience only */ }
}

export function BoardsView() {
  const colors = useColors();
  const { api, listing, changed, reload } = useBoards();
  const [picked, setPicked] = useState<string | null>(null);
  const [range, setRange] = useState<Range | null>(null);
  const [results, setResults] = useState<Record<string, ShownPanel>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [auto, setAuto] = useState<AutoRefresh>('off');

  const boards = listing?.boards ?? [];
  const current = picked !== null && (picked === PLUS || boards.some((b) => b.id === picked)) ? picked : boards[0]?.id ?? PLUS;
  const board = boards.find((b) => b.id === current) ?? null;
  const boardId = board && !board.error ? board.id : null;

  const refresh = useCallback(async () => {
    if (!api || !boardId) return;
    setRefreshing(true);
    const r = await api.refresh(boardId, range ?? undefined);
    setRefreshing(false);
    if (!r.ok) { setBoardError(r.error); return; }
    setBoardError(null);
    setResults((prev) => mergeRefresh(prev, r.panels));
    setLastRefreshed(Date.now());
  }, [api, boardId, range]);

  useEffect(() => { setResults({}); setConfirmDelete(false); setBoardError(null); setAuto(readAuto(current)); }, [current]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (boardId && changed.ids.includes(boardId)) void refresh(); }, [changed.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ms = AUTO_REFRESH[auto];
    if (!ms) return undefined;
    const t = setInterval(() => { void refresh(); }, ms);
    return () => clearInterval(t);
  }, [auto, refresh]);

  const chip = (on: boolean) => ({
    fontSize: 12, padding: '3px 10px', color: on ? colors.inkOnCyan : colors.textSecondary,
    background: on ? colors.accentCyan : colors.panelInset, border: `1px solid ${on ? colors.activeBorder : colors.chipBorder}`,
  });

  if (!api) return <div style={{ padding: 16, color: colors.textMuted }}>Boards needs the desktop app.</div>;

  return (
    <div style={{ padding: 16, display: 'grid', gap: 12, fontFamily: fonts.ui, color: colors.textBody, alignContent: 'start' }}>
      {listing && !listing.collectorAvailable && (
        <div role="status" style={{ border: `1px solid ${colors.warnDeep}`, color: colors.warn, padding: 8 }}>
          No collector data: start the collector (see collector/README.md). Boards fill in once it has run.
        </div>
      )}
      <nav aria-label="Boards" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {boards.map((b) => (
          <Button key={b.id} aria-current={current === b.id ? 'page' : undefined} onClick={() => setPicked(b.id)} style={chip(current === b.id)}>{b.title}</Button>
        ))}
        <Button aria-label="New board" aria-current={current === PLUS ? 'page' : undefined} onClick={() => setPicked(PLUS)} style={chip(current === PLUS)}>+</Button>
      </nav>

      {current === PLUS && (
        <div style={{ display: 'grid', gap: 8, maxWidth: 720 }}>
          <p style={{ margin: 0 }}>Ask Claude in the Terminal tab, for example: "Make a board of my token spend by model per day this month."</p>
          <p style={{ margin: 0, color: colors.textSecondary }}>
            Claude needs the aether-data tool server, registered once. Copy the command, paste it into the Terminal tab, then restart Claude there.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button onClick={() => { void api.copyRegisterCommand().then((r) => setCopied(r.ok ? 'copied' : 'failed')); }} style={chip(false)}>Copy register command</Button>
            {copied === 'copied' && <span style={{ color: colors.success }}>Copied. Paste it into the Terminal tab.</span>}
            {copied === 'failed' && <span style={{ color: colors.danger }}>Could not copy.</span>}
          </div>
        </div>
      )}

      {board?.error && <div role="alert" style={{ color: colors.danger }}>invalid: {board.error}</div>}

      {board && !board.error && (
        <>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button aria-pressed={range === null} onClick={() => setRange(null)} style={chip(range === null)}>Panel default</Button>
            {RANGES.map((r) => <Button key={r} aria-pressed={range === r} onClick={() => setRange(r)} style={chip(range === r)}>{r}</Button>)}
            <Button onClick={() => { void refresh(); }} disabled={refreshing} style={chip(false)}>{refreshing ? 'Refreshing…' : 'Refresh'}</Button>
            {(Object.keys(AUTO_REFRESH) as AutoRefresh[]).map((a) => (
              <Button key={a} aria-pressed={auto === a} onClick={() => { setAuto(a); writeAuto(board.id, a); }} style={chip(auto === a)}>auto {a}</Button>
            ))}
            {lastRefreshed !== null && <span style={{ color: colors.textMuted, fontSize: 12 }}>last refreshed {new Date(lastRefreshed).toLocaleTimeString()}</span>}
            <span style={{ flex: 1 }} />
            {confirmDelete ? (
              <>
                <span style={{ color: colors.warn, fontSize: 12 }}>Delete "{board.title}"? This removes its file.</span>
                <Button onClick={() => { void api.remove(board.id).then((r) => { setConfirmDelete(false); if (!r.ok) setBoardError(r.error ?? 'Delete failed.'); else { setPicked(null); reload(); } }); }} style={{ ...chip(false), color: colors.danger }}>Confirm delete</Button>
                <Button onClick={() => setConfirmDelete(false)} style={chip(false)}>Cancel</Button>
              </>
            ) : (
              <Button onClick={() => setConfirmDelete(true)} style={chip(false)}>Delete board</Button>
            )}
          </div>
          {boardError && <div role="alert" style={{ color: colors.danger }}>{boardError}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
            {board.panels.map((p) => <BoardPanel key={p.id} panel={p} result={results[p.id]} refreshing={refreshing} />)}
          </div>
        </>
      )}
    </div>
  );
}
```

`src/viewRegistry.ts`: add `import { BoardsView } from './components/boards/BoardsView';`, and add `{ id: 'Boards', inSidebar: true, component: BoardsView },` directly after the `Ledger` entry. In `src/viewRegistry.test.ts`, add `'Boards',` directly after `'Ledger',`.

- [ ] **Step 4: Run tests and build**

Run: `npx vitest run src/components/boards src/viewRegistry.test.ts && npm run build`
Expected: PASS, and the build succeeds. If `JSX.Element` does not resolve under this tsconfig, use `ReactElement` from `react`.

- [ ] **Step 5: Commit**

```bash
P="src/components/boards/BoardPanel.tsx src/components/boards/useBoards.ts src/components/boards/BoardsView.tsx src/components/boards/BoardsView.render.test.tsx src/viewRegistry.ts src/viewRegistry.test.ts"
git add -- $P && git commit -m "feat(boards): Boards view, tabs, toolbar, panels, + tab" -- $P
```

---

### Task 15: Docs, full verification, live check

**Files:**
- Modify: `docs/privacy-and-data.md` (new section after the last numbered section)
- Modify: `PROGRESS.md` ("Shipped plans": one paragraph)

- [ ] **Step 1: Privacy section.** Append to `docs/privacy-and-data.md`, numbered after the last existing section:

```markdown
## §15 Boards and the aether-data MCP server (2026-10-12)

- **Boundary:** an operator-driven terminal. The `aether-data` MCP server is registered only when the
  operator pastes the command from the Boards "+" tab. Once registered, the Claude session it serves
  can read `collector.db` (read-only) and send query results to the model as part of that conversation.
- **What is reachable:** everything in `collector.db`, which by design holds signal, not payload: token
  counts, tool names, durations and anomaly kinds. Its path columns (`tool_calls.file_path_rel`,
  `events.project_rel_path`, `transcript_files.file_path`) are reachable too; queries are not filtered by column.
- **What is stored:** board definitions (title, SQL, chart layout) in `~/.aether-os/dashboards/*.json`.
  No query results are persisted. Refresh runs locally and makes no model call.
- **Writes:** none to `collector.db`. The connection is opened read-only and every query passes the guard
  in `src/shared/dashboards/queryGuard.ts`.
- **Opt out:** `claude mcp remove aether-data --scope user`.
```

- [ ] **Step 2: PROGRESS entry.** Add one paragraph under "Shipped plans", in the format of the most recent entries. Cover: what Boards does; the spec and plan paths; the deliberate deviations (median → average, anomalies totals per kind); the busy_timeout fix to the existing readers; and what is not verified by unit tests (charts, the Electron-as-node MCP run inside the packaged `app.asar`).

- [ ] **Step 3: Full verification**

Run: `npm test && npm run typecheck:electron && npm run build && npm run electron:build`
Expected: every suite passes, including `src/shared/noApiCalls.test.ts`; no type errors; both builds succeed. Record the test counts.

- [ ] **Step 4: Live check (manual or electron-ui-verifier)**

1. Launch the dev app and open **Boards**. Confirm both starter tabs render with real data and screenshot each one.
2. On the "+" tab, click **Copy register command**, run the copied command in a terminal, then start Claude and run `/mcp`. Confirm `aether-data` is connected.
3. Ask Claude for "a board of tool calls per day this week". Confirm a new tab appears without restarting Aether (the watcher) and that its query is visible under "Show query".
4. Delete that board through the in-page confirm. Confirm the file is gone from `~/.aether-os/dashboards/`.

Record each result as Passed, Failed, or Incomplete with the reason. The registration step against the *packaged* build (inside `app.asar`) stays Incomplete until a packaged build is installed.

- [ ] **Step 5: Commit**

```bash
P="docs/privacy-and-data.md PROGRESS.md"
git add -- $P && git commit -m "docs(boards): privacy boundary and progress entry" -- $P
```
