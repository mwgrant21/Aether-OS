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
    worker.once('error', (e: Error) => finish({ ok: false, kind: 'sql', error: e.message }));
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
