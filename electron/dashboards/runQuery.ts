import { spawn, type ChildProcess } from 'node:child_process';
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
  /** Test hook: called with each spawned query process pid. */
  onSpawn?: (pid: number) => void;
}

// A child process, not a worker thread: node:sqlite is synchronous and
// worker.terminate() cannot interrupt a running statement (the thread keeps
// spinning, holds its read lock, and can even hang process exit). Only killing
// a process stops a runaway query. ELECTRON_RUN_AS_NODE makes the packaged
// "Aether OS.exe" behave as plain Node, as the aether-bridge MCP helper does.
const CHILD_SOURCE = `
const { DatabaseSync } = require('node:sqlite');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let db;
  let out;
  try {
    const job = JSON.parse(input);
    db = new DatabaseSync(job.dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = ' + Number(job.busyTimeoutMs));
    const stmt = db.prepare(job.sql);
    const rows = job.params ? stmt.all(job.params) : stmt.all();
    const columns = typeof stmt.columns === 'function'
      ? stmt.columns().map((c) => c.name)
      : (rows[0] ? Object.keys(rows[0]) : []);
    out = { ok: true, columns, rows: rows.map((r) => ({ ...r })) };
  } catch (e) {
    out = { ok: false, error: String((e && e.message) || e) };
  } finally {
    try { if (db) db.close(); } catch {}
  }
  process.stdout.write(JSON.stringify(out) + '\\n');
});
`;

type ChildReply = { ok: true; columns: string[]; rows: Record<string, unknown>[] } | { ok: false; error: string };

export const MAX_CONCURRENT_QUERIES = 3;
let running = 0;
const waiting: Array<() => void> = [];
function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT_QUERIES) { running++; return Promise.resolve(); }
  return new Promise((r) => waiting.push(r));
}
function release(): void {
  const next = waiting.shift();
  if (next) next(); else running--;
}

export async function executeIsolated(
  dbPath: string, wrappedSql: string, params: Record<string, number> | null,
  rowCap: number, timeoutMs: number, busyTimeoutMs: number, onSpawn?: (pid: number) => void,
): Promise<RunQueryResult> {
  await acquire();
  try {
    return await spawnOne(dbPath, wrappedSql, params, rowCap, timeoutMs, busyTimeoutMs, onSpawn);
  } finally {
    release();
  }
}

function spawnOne(
  dbPath: string, wrappedSql: string, params: Record<string, number> | null,
  rowCap: number, timeoutMs: number, busyTimeoutMs: number, onSpawn?: (pid: number) => void,
): Promise<RunQueryResult> {
  // Error text crosses IPC and can reach a model conversation: never carry the path.
  const scrub = (t: string) => (dbPath ? t.split(dbPath).join('collector.db') : t);
  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (r: RunQueryResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!r.ok) r = { ...r, error: scrub(r.error) };
      resolve(r);
    };
    try {
      child = spawn(process.execPath, ['-e', CHILD_SOURCE], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      finish({ ok: false, kind: 'sql', error: String((e as Error).message ?? e) });
      return;
    }
    const proc = child;
    if (proc.pid !== undefined) onSpawn?.(proc.pid);
    timer = setTimeout(() => {
      proc.kill();
      finish({ ok: false, kind: 'timeout', error: `Query ran longer than ${timeoutMs / 1000}s and was stopped.` });
    }, timeoutMs);
    let stdout = '';
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (c: string) => { stdout += c; });
    let stderr = '';
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (c: string) => { stderr += c; });
    proc.stdin!.on('error', () => { /* child died early; 'close' reports it */ });
    proc.once('error', (e: Error) => finish({ ok: false, kind: 'sql', error: e.message }));
    proc.once('close', () => {
      let m: ChildReply | undefined;
      try { m = JSON.parse(stdout.trim()) as ChildReply; } catch { m = undefined; }
      if (!m) { finish({ ok: false, kind: 'sql', error: 'Query process ended without a result.' + (stderr ? ' ' + stderr.slice(0, 300) : '') }); return; }
      if (!m.ok) {
        finish({ ok: false, kind: /database is locked|SQLITE_BUSY/i.test(m.error) ? 'busy' : 'sql', error: m.error });
        return;
      }
      const truncated = m.rows.length > rowCap;
      finish({ ok: true, columns: m.columns, rows: truncated ? m.rows.slice(0, rowCap) : m.rows, truncated });
    });
    proc.stdin!.end(JSON.stringify({ dbPath, sql: wrappedSql, params, busyTimeoutMs }));
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
  return executeIsolated(opts.dbPath, guarded.sql, params, opts.rowCap,
    opts.timeoutMs ?? QUERY_TIMEOUT_MS, opts.busyTimeoutMs ?? BUSY_TIMEOUT_MS, opts.onSpawn);
}
