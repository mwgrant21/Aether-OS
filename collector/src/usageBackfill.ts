import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { closeSync, lstatSync, openSync, readSync, realpathSync } from 'fs';
import { isAbsolute, join, sep } from 'path';
import { parseTranscriptLine } from './transcriptParser.js';

/**
 * One-time repair of usage_events rows written before 0.7.6 (message_key NULL,
 * one row per streamed transcript line). Re-reads each row's own transcript,
 * rebuilds the dedupe key for rows whose exact tuple (occurred_at_ms, model, 4
 * token columns) matches a line, keeps the lowest id per key and deletes the
 * repeats. Rows it cannot prove are left untouched and counted. See
 * the 2026-11-11 usage-backfill spec (sections 3, 4, 7).
 *
 * Contract with the runner (T1b): this runs on an already-open handle and
 * never migrates, never backs up, never checks the collector heartbeat. For an
 * apply, `onSnapshot(snapshot)` is called after the snapshot and the plan and
 * BEFORE BEGIN IMMEDIATE, so the runner can take and verify its backup against
 * snapshot.count / snapshot.tokensTotal; if it throws, nothing was written and
 * the error propagates unchanged. `testHooks` are test-only.
 *
 * Dry-run forces PRAGMA query_only = ON for its duration (restored after), so a
 * dry-run never writes even on a writable handle; `openDryRunHandle` is the
 * read-only opener the runner uses.
 *
 * Token compare: lines are matched with Number() coercion and NaN is a
 * non-match. The Go collector's int parsing differs for non-numeric token
 * values, so parity on that edge is not guaranteed and not tested.
 */

// Runtime require, not a static import: same Vite workaround as schema.ts openDatabase.
const require = createRequire(import.meta.url);

const TOKEN_COLS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;
const TOKEN_SUM_SQL = TOKEN_COLS.map((c) => `COALESCE(SUM(${c}), 0)`).join(' + ');
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

export class DbChangedError extends Error {
  constructor() {
    super('db changed during run, nothing written, re-run');
    this.name = 'DbChangedError';
  }
}

/** Thrown before COMMIT when a post-write assertion fails; carries only the assertion id. */
export class AssertionError extends Error {
  readonly assertion: string;
  constructor(assertion: string) {
    super(`assertion ${assertion} failed, nothing written`);
    this.name = 'AssertionError';
    this.assertion = assertion;
  }
}

export interface BackfillSnapshot {
  maxId: number;
  count: number;
  nullKeyCount: number;
  tokensTotal: number;
  heartbeat: string | null;
}

export interface BackfillReport {
  mode: 'dry-run' | 'apply';
  legacyRows: number;
  legacyRowsNoSource: number;
  filesReferenced: number;
  filesPresent: number;
  filesUnusable: number;
  rowsUnrecoverable: number;
  unrecoverableMinMs: number | null;
  unrecoverableMaxMs: number | null;
  rowsNoMatch: number;
  rowsKeyless: number;
  rowsAmbiguous: number;
  rowsMatched: number;
  keysDistinct: number;
  keysAlreadyInTable: number;
  keysUsageDiffers: number;
  keysUsageDiffersOutputDelta: number;
  rowsToKey: number;
  rowsToDelete: number;
  totalTokensBefore: number;
  totalTokensAfter: number;
}

export interface BackfillOptions {
  apply: boolean;
  onSnapshot?: (snapshot: BackfillSnapshot) => void;
  testHooks?: { beforeLock?: () => void; afterWrites?: (db: DatabaseSync) => void };
}

/**
 * Read-only handle for a dry-run. `readOnly: true` is honoured on the Node
 * this was written on; its support at the engines floor (22.5.0) is
 * unverified, so query_only is also set, which does not depend on the option.
 */
export function openDryRunHandle(dbPath: string): DatabaseSync {
  const db: DatabaseSync = new (require('node:sqlite').DatabaseSync)(dbPath, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return db;
}

/** True iff realTarget is strictly inside realRoot (separator boundary; case-insensitive on win32 only). */
export function isInsideRoot(realRoot: string, realTarget: string, platform: string): boolean {
  const win = platform === 'win32';
  const s = win ? '\\' : '/';
  const trim = (p: string) => p.replace(win ? /[\\/]+$/ : /\/+$/, '');
  let root = trim(realRoot);
  let target = win ? realTarget.replace(/\//g, '\\') : realTarget;
  if (win) {
    root = root.replace(/\//g, '\\').toLowerCase();
    target = target.toLowerCase();
  }
  if (target === root) return false;
  return target.startsWith(root + s);
}

// Resolves a stored source_file_rel to a real regular file inside the projects
// root, or null when anything about it is untrustworthy.
function resolveTranscript(rel: string, realRoot: string | null): string | null {
  if (realRoot === null) return null;
  if (rel === '' || rel.includes('\0')) return null;
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel)) return null;
  const segments = rel.split(/[\\/]/);
  if (segments.some((s) => s === '..')) return null;
  const normalised = segments.join(sep);
  if (isAbsolute(normalised)) return null;
  try {
    const candidate = join(realRoot, normalised);
    const st = lstatSync(candidate);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const real = realpathSync(candidate);
    return isInsideRoot(realRoot, real, process.platform) ? real : null;
  } catch {
    return null;
  }
}

// Calls fn once per COMPLETE (newline-terminated) line, decoding whole lines
// only, so a multi-byte character split across a chunk boundary is intact. A
// final unterminated line is ignored (the collector does the same). A line over
// MAX_LINE_BYTES is skipped. Throws on any read error; the caller discards the file.
function forEachCompleteLine(path: string, fn: (line: string) => void): void {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let pending: Buffer[] = [];
    let pendingLen = 0;
    let skipping = false;
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK_BYTES, null);
      if (n === 0) break;
      const chunk = buf.subarray(0, n);
      let start = 0;
      for (;;) {
        const idx = chunk.indexOf(0x0a, start);
        if (idx === -1) {
          if (!skipping) {
            pending.push(Buffer.from(chunk.subarray(start)));
            pendingLen += n - start;
            if (pendingLen > MAX_LINE_BYTES) {
              skipping = true;
              pending = [];
              pendingLen = 0;
            }
          }
          break;
        }
        if (!skipping) {
          const seg = chunk.subarray(start, idx);
          if (pendingLen + seg.length <= MAX_LINE_BYTES) {
            fn(Buffer.concat([...pending, seg]).toString('utf8'));
          }
        }
        pending = [];
        pendingLen = 0;
        skipping = false;
        start = idx + 1;
      }
    }
  } finally {
    closeSync(fd);
  }
}

interface LegacyRow {
  id: number;
  ms: number;
  model: string | null;
  tokens: [number, number, number, number];
}

const tupleKey = (ms: number, model: string | null, t: number[]) => JSON.stringify([ms, model, t[0], t[1], t[2], t[3]]);

export function snapshotOf(db: DatabaseSync): BackfillSnapshot {
  const r = db
    .prepare(
      `SELECT COALESCE(MAX(id), 0) AS maxId, COUNT(*) AS count,
              COALESCE(SUM(CASE WHEN message_key IS NULL THEN 1 ELSE 0 END), 0) AS nullKeyCount,
              ${TOKEN_SUM_SQL} AS tokensTotal
       FROM usage_events`
    )
    .get() as { maxId: number; count: number; nullKeyCount: number; tokensTotal: number };
  const hb = db.prepare("SELECT value FROM schema_meta WHERE key = 'transcript_last_scan_ms'").get() as
    | { value: string }
    | undefined;
  return {
    maxId: Number(r.maxId),
    count: Number(r.count),
    nullKeyCount: Number(r.nullKeyCount),
    tokensTotal: Number(r.tokensTotal),
    heartbeat: hb ? String(hb.value) : null,
  };
}

export const sameSnapshot = (a: BackfillSnapshot, b: BackfillSnapshot) =>
  a.maxId === b.maxId &&
  a.count === b.count &&
  a.nullKeyCount === b.nullKeyCount &&
  a.tokensTotal === b.tokensTotal &&
  a.heartbeat === b.heartbeat;

export function backfillUsageKeys(db: DatabaseSync, projectsRoot: string, opts: BackfillOptions): BackfillReport {
  const apply = opts.apply;
  const colCheck = db.prepare('PRAGMA table_info(usage_events)').all() as Array<{ name: string }>;
  if (!colCheck.some((c) => c.name === 'message_key')) {
    throw new Error('usage_events.message_key missing');
  }

  const queryOnlyBefore = (db.prepare('PRAGMA query_only').get() as { query_only: number }).query_only;
  if (!apply) db.exec('PRAGMA query_only = ON');
  try {
    // Steps 2-3 inside ONE deferred read transaction: one consistent view.
    let snap: BackfillSnapshot;
    const legacy: LegacyRow[] = [];
    const rowsByFile = new Map<string, LegacyRow[]>();
    const existingKeys = new Set<string>();
    let legacyRowsNoSource = 0;
    db.exec('BEGIN');
    try {
      snap = snapshotOf(db);
      for (const r of db
        .prepare(
          `SELECT id, occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, source_file_rel
           FROM usage_events WHERE message_key IS NULL AND source_file_rel IS NOT NULL ORDER BY id`
        )
        .iterate() as Iterable<any>) {
        const row: LegacyRow = {
          id: Number(r.id),
          ms: Number(r.occurred_at_ms),
          model: r.model === null ? null : String(r.model),
          tokens: [Number(r.input_tokens), Number(r.output_tokens), Number(r.cache_creation_input_tokens), Number(r.cache_read_input_tokens)],
        };
        legacy.push(row);
        const rel = String(r.source_file_rel);
        const list = rowsByFile.get(rel);
        if (list) list.push(row);
        else rowsByFile.set(rel, [row]);
      }
      legacyRowsNoSource = (
        db.prepare('SELECT COUNT(*) AS c FROM usage_events WHERE message_key IS NULL AND source_file_rel IS NULL').get() as { c: number }
      ).c;
      for (const r of db.prepare('SELECT message_key FROM usage_events WHERE message_key IS NOT NULL').iterate() as Iterable<any>) {
        existingKeys.add(String(r.message_key));
      }
    } finally {
      db.exec('COMMIT');
    }

    let realRoot: string | null = null;
    try {
      realRoot = realpathSync(projectsRoot);
    } catch {
      realRoot = null;
    }

    let filesPresent = 0;
    let filesUnusable = 0;
    let rowsUnrecoverable = 0;
    let unrecoverableMinMs: number | null = null;
    let unrecoverableMaxMs: number | null = null;
    let rowsNoMatch = 0;
    let rowsKeyless = 0;
    let rowsAmbiguous = 0;
    const groups = new Map<string, LegacyRow[]>(); // key -> matched rows

    const markUnrecoverable = (rows: LegacyRow[]) => {
      filesUnusable++;
      for (const row of rows) {
        rowsUnrecoverable++;
        if (unrecoverableMinMs === null || row.ms < unrecoverableMinMs) unrecoverableMinMs = row.ms;
        if (unrecoverableMaxMs === null || row.ms > unrecoverableMaxMs) unrecoverableMaxMs = row.ms;
      }
    };

    for (const [rel, rows] of rowsByFile) {
      const path = resolveTranscript(rel, realRoot);
      if (path === null) {
        markUnrecoverable(rows);
        continue;
      }
      // tuple -> rows sharing it, and the set of outcomes (key or null = keyless) seen on matching lines.
      const byTuple = new Map<string, { rows: LegacyRow[]; outcomes: Set<string | null> }>();
      for (const row of rows) {
        const k = tupleKey(row.ms, row.model, row.tokens);
        const entry = byTuple.get(k);
        if (entry) entry.rows.push(row);
        else byTuple.set(k, { rows: [row], outcomes: new Set() });
      }
      try {
        forEachCompleteLine(path, (line) => {
          const ev = parseTranscriptLine(line);
          if (ev === null || ev.kind !== 'assistant' || ev.usage === null || ev.timestamp === null) return;
          const t = [ev.usage.inputTokens, ev.usage.outputTokens, ev.usage.cacheCreationInputTokens, ev.usage.cacheReadInputTokens].map(Number);
          if (t.some((x) => Number.isNaN(x))) return;
          const entry = byTuple.get(tupleKey(ev.timestamp.getTime(), ev.model, t));
          if (entry) entry.outcomes.add(ev.messageKey ?? null);
        });
      } catch {
        markUnrecoverable(rows);
        continue;
      }
      filesPresent++;
      for (const entry of byTuple.values()) {
        for (const row of entry.rows) {
          if (entry.outcomes.size === 0) rowsNoMatch++;
          else if (entry.outcomes.size > 1) rowsAmbiguous++;
          else {
            const key = [...entry.outcomes][0];
            if (key === null) rowsKeyless++;
            else {
              const g = groups.get(key);
              if (g) g.push(row);
              else groups.set(key, [row]);
            }
          }
        }
      }
    }

    // Plan: keep the lowest id per key (unless the key is already in the table), delete the rest.
    const deleteIds: number[] = [];
    const keyUpdates: Array<[string, number]> = [];
    let keysAlreadyInTable = 0;
    let keysUsageDiffers = 0;
    let keysUsageDiffersOutputDelta = 0;
    let deletedTokens = 0;
    let rowsMatched = 0;
    for (const [key, rows] of groups) {
      rows.sort((a, b) => a.id - b.id);
      rowsMatched += rows.length;
      if (existingKeys.has(key)) {
        keysAlreadyInTable++;
        for (const r of rows) {
          deleteIds.push(r.id);
          deletedTokens += r.tokens[0] + r.tokens[1] + r.tokens[2] + r.tokens[3];
        }
        continue;
      }
      const kept = rows[0];
      keyUpdates.push([key, kept.id]);
      let differs = false;
      let maxOut = kept.tokens[1];
      for (const r of rows) {
        if (r.tokens.some((v, i) => v !== kept.tokens[i])) differs = true;
        if (r.tokens[1] > maxOut) maxOut = r.tokens[1];
      }
      if (differs) {
        keysUsageDiffers++;
        keysUsageDiffersOutputDelta += maxOut - kept.tokens[1];
      }
      for (const r of rows.slice(1)) {
        deleteIds.push(r.id);
        deletedTokens += r.tokens[0] + r.tokens[1] + r.tokens[2] + r.tokens[3];
      }
    }

    const report: BackfillReport = {
      mode: apply ? 'apply' : 'dry-run',
      legacyRows: legacy.length,
      legacyRowsNoSource,
      filesReferenced: rowsByFile.size,
      filesPresent,
      filesUnusable,
      rowsUnrecoverable,
      unrecoverableMinMs,
      unrecoverableMaxMs,
      rowsNoMatch,
      rowsKeyless,
      rowsAmbiguous,
      rowsMatched,
      keysDistinct: groups.size,
      keysAlreadyInTable,
      keysUsageDiffers,
      keysUsageDiffersOutputDelta,
      rowsToKey: keyUpdates.length,
      rowsToDelete: deleteIds.length,
      totalTokensBefore: snap.tokensTotal,
      totalTokensAfter: snap.tokensTotal - deletedTokens,
    };
    if (!apply) return report;

    opts.onSnapshot?.(snap);
    opts.testHooks?.beforeLock?.();

    db.exec('BEGIN IMMEDIATE');
    try {
      if (!sameSnapshot(snap, snapshotOf(db))) throw new DbChangedError();
      const del = db.prepare('DELETE FROM usage_events WHERE id = ?');
      const upd = db.prepare('UPDATE usage_events SET message_key = ? WHERE id = ? AND message_key IS NULL');
      let deleted = 0;
      let updated = 0;
      for (const id of deleteIds) deleted += Number(del.run(id).changes);
      for (const [key, id] of keyUpdates) updated += Number(upd.run(key, id).changes);
      db.prepare("INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('usage_backfill_v1', ?)").run(
        JSON.stringify({
          atMs: Date.now(),
          rowsToKey: report.rowsToKey,
          rowsToDelete: report.rowsToDelete,
          rowsUnrecoverable,
          unrecoverableMaxMs,
        })
      );
      opts.testHooks?.afterWrites?.(db);
      const after = snapshotOf(db);
      if (deleted !== report.rowsToDelete || updated !== report.rowsToKey) throw new AssertionError('i');
      if (after.count !== snap.count - report.rowsToDelete) throw new AssertionError('ii');
      if (after.nullKeyCount !== snap.nullKeyCount - report.rowsToKey - report.rowsToDelete) throw new AssertionError('iii');
      if (after.tokensTotal !== report.totalTokensAfter) throw new AssertionError('iv');
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // already rolled back
      }
      throw err;
    }
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // best effort
    }
    return report;
  } finally {
    if (!apply && queryOnlyBefore === 0) db.exec('PRAGMA query_only = OFF');
  }
}
