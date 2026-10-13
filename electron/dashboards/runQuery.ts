import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { BLOCKED_COLUMNS, guardQuery } from '../../src/shared/dashboards/queryGuard';
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
const { DatabaseSync, constants: C } = require('node:sqlite');
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
    // The authorizer and queryGuard enforce read-only / blocked columns TOGETHER.
    // SQLite resolves quoting, aliases and CTEs itself, so the authorizer sees
    // through them; it cannot see the merged column of a USING / NATURAL join, so
    // the guard refuses those keywords and SELECT *. Set after the busy_timeout
    // PRAGMA, because PRAGMA is denied once it is on.
    const blocked = new Set(job.blockedColumns);
    db.setAuthorizer((action, a1, a2) => {
      if (action === C.SQLITE_SELECT || action === C.SQLITE_RECURSIVE) return C.SQLITE_OK;
      if (action === C.SQLITE_FUNCTION) return String(a2).toLowerCase() === 'load_extension' ? C.SQLITE_DENY : C.SQLITE_OK;
      // pragma_table_info() is a table-valued pragma and SQLite authorizes it as a PRAGMA too.
      if (action === C.SQLITE_PRAGMA) return String(a1).toLowerCase() === 'table_info' ? C.SQLITE_OK : C.SQLITE_DENY;
      if (action === C.SQLITE_READ) {
        const table = String(a1 == null ? '' : a1).toLowerCase();
        const column = String(a2 == null ? '' : a2).toLowerCase();
        // Any column named like a path is denied too: a generated column over a blocked one bypasses the per-column check.
        if (blocked.has(column) || column.includes('path') || table === 'transcript_files') return C.SQLITE_DENY;
        if (table.startsWith('sqlite_') && table !== 'sqlite_master') return C.SQLITE_DENY;
        if (table.startsWith('pragma_') && table !== 'pragma_table_info') return C.SQLITE_DENY;
        return C.SQLITE_OK;
      }
      return C.SQLITE_DENY;
    });
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
export const MAX_QUERY_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Error text crosses IPC and can reach a model conversation: never carry the db path. */
export function scrubPath(message: string, dbPath: string): string {
  return dbPath ? message.split(dbPath).join('collector.db') : message;
}
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
  const run = spawnOne(dbPath, wrappedSql, params, rowCap, timeoutMs, busyTimeoutMs, onSpawn);
  // The caller gets a timeout or too-large result at once, but the slot stays
  // taken until the killed process has really exited.
  void run.exited.then(release);
  return run.result;
}

function spawnOne(
  dbPath: string, wrappedSql: string, params: Record<string, number> | null,
  rowCap: number, timeoutMs: number, busyTimeoutMs: number, onSpawn?: (pid: number) => void,
): { result: Promise<RunQueryResult>; exited: Promise<void> } {
  let markExited!: () => void;
  const exited = new Promise<void>((r) => { markExited = r; });
  const result = new Promise<RunQueryResult>((resolve) => {
    let settled = false;
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (r: RunQueryResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!r.ok) r = { ...r, error: scrubPath(r.error, dbPath) };
      resolve(r);
    };
    try {
      child = spawn(process.execPath, ['-e', CHILD_SOURCE], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      // Fixed text: a spawn error message can carry process.execPath (an install path).
      finish({ ok: false, kind: 'sql', error: 'Query process failed.' });
      markExited();
      return;
    }
    const proc = child;
    if (proc.pid !== undefined) onSpawn?.(proc.pid);
    // Lock wait (busy_timeout, inside the child) and execution each get their own
    // budget; a shared deadline would report a held write lock as 'timeout', not 'busy'.
    timer = setTimeout(() => {
      proc.kill();
      finish({ ok: false, kind: 'timeout', error: `Query was stopped after ${(timeoutMs + busyTimeoutMs) / 1000}s (lock wait plus run time).` });
    }, timeoutMs + busyTimeoutMs);
    let stdout = '';
    let outBytes = 0;
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (c: string) => {
      stdout += c;
      outBytes += Buffer.byteLength(c);
      if (outBytes > MAX_QUERY_OUTPUT_BYTES) {
        proc.kill();
        finish({ ok: false, kind: 'sql', error: 'Query result is too large.' });
      }
    });
    proc.stderr!.resume();
    proc.stdin!.on('error', () => { /* child died early; 'close' reports it */ });
    proc.once('error', () => {
      finish({ ok: false, kind: 'sql', error: 'Query process failed.' });
      // No pid means it never started, so no 'close' is coming.
      if (proc.pid === undefined) markExited();
    });
    proc.once('close', () => {
      markExited();
      let m: ChildReply | undefined;
      try { m = JSON.parse(stdout.trim()) as ChildReply; } catch { m = undefined; }
      if (!m) { finish({ ok: false, kind: 'sql', error: 'Query process failed.' }); return; }
      if (!m.ok) {
        finish({ ok: false, kind: /database is locked|SQLITE_BUSY/i.test(m.error) ? 'busy' : 'sql', error: m.error });
        return;
      }
      const truncated = m.rows.length > rowCap;
      finish({ ok: true, columns: m.columns, rows: truncated ? m.rows.slice(0, rowCap) : m.rows, truncated });
    });
    proc.stdin!.end(JSON.stringify({ dbPath, sql: wrappedSql, params, busyTimeoutMs, blockedColumns: BLOCKED_COLUMNS }));
  });
  return { result, exited };
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
