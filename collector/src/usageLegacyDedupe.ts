import type { DatabaseSync } from 'node:sqlite';
import { AssertionError, DbChangedError, sameSnapshot, snapshotOf, type BackfillSnapshot } from './usageBackfill.js';

/**
 * Opt-in, APPROXIMATE dedupe of the legacy NULL-key usage_events rows that the
 * exact `backfill-usage` repair could not recover (their transcripts are gone).
 * No transcript is read: rows are clustered purely from their own columns.
 *
 * Rule: partition NULL-key rows by (source_file_rel, model, input, output,
 * cache_creation, cache_read); within a partition sort by (occurred_at_ms, id)
 * and chain rows while the gap to the previous row is <= WINDOW_MS; keep the
 * first row of each chain, delete the rest. Survivors keep message_key NULL
 * (no key is invented), so a second run finds nothing. All-zero-token rows are
 * never clustered. It is a heuristic: individual deletes are not verified.
 *
 * Candidate population: message_key IS NULL, source_file_rel IS NOT NULL,
 * occurred_at_ms < min(LEGACY_CUTOFF_MS, the usage_backfill_v1 marker's
 * unrecoverableMaxMs + 1), so the delete is tied to the rows #229 declared
 * unrecoverable. With no marker (dry-run only) the bound is LEGACY_CUTOFF_MS;
 * with a marker whose unrecoverableMaxMs is not a number there is nothing
 * unrecoverable and the candidate set is empty.
 *
 * Contract with the runner: runs on an already-open handle, never migrates,
 * never backs up, never checks the heartbeat. `onSnapshot` is called after the
 * plan and every bound check, BEFORE BEGIN IMMEDIATE.
 */

export const LEGACY_CUTOFF_MS = Date.parse('2026-11-09T04:40:00Z');
export const WINDOW_MS = 60_000;
export const MAX_DELETE_FRACTION = 0.6;
export const MAX_CLUSTER_SIZE = 30;
export const MAX_CLUSTER_SPAN_MS = 300_000;
export const RULE = 'file+model+tokens within 60 s chain';

export class PrerequisiteError extends Error {
  constructor() {
    super('usage backfill marker missing');
    this.name = 'PrerequisiteError';
  }
}

export type OutOfBoundsReason = 'expect-required' | 'expect-delete' | 'expect-token-mass' | 'cluster-size' | 'cluster-span' | 'fraction';

/** Thrown before onSnapshot (so before any backup) when the plan is outside what the operator or the code allows. */
export class PlanOutOfBoundsError extends Error {
  readonly reason: OutOfBoundsReason;
  constructor(reason: OutOfBoundsReason) {
    super(`plan out of bounds: ${reason}`);
    this.name = 'PlanOutOfBoundsError';
    this.reason = reason;
  }
}

export interface LegacyDedupeReport {
  mode: 'dry-run' | 'apply';
  rule: string;
  approximate: true;
  windowMs: number;
  cutoffMs: number;
  upperBoundMs: number;
  backfillMarkerPresent: boolean;
  legacyRows: number;
  legacyRowsNoSource: number;
  rowsZeroMass: number;
  rowsConsidered: number;
  clusters: number;
  clusterPairs: number;
  clusterTriples: number;
  maxClusterSize: number;
  maxClusterSpanMs: number;
  rowsToDelete: number;
  deleteTokenMass: number;
  candidateOldestMs: number | null;
  candidateNewestMs: number | null;
  totalRowsBefore: number;
  totalRowsAfter: number;
  totalTokensBefore: number;
  totalTokensAfter: number;
}

export interface LegacyDedupeOptions {
  apply: boolean;
  /** Required with apply: the operator's expected plan, compared before any backup. */
  expectDelete?: number;
  expectTokenMass?: number;
  onSnapshot?: (snapshot: BackfillSnapshot) => void;
  testHooks?: { beforeLock?: () => void; afterWrites?: (db: DatabaseSync) => void };
}

interface Cand {
  id: number;
  ms: number;
  mass: number;
}

interface Plan {
  snap: BackfillSnapshot;
  report: LegacyDedupeReport;
  deleteIds: number[];
  keptIds: number[];
}

function upperBoundOf(db: DatabaseSync): { present: boolean; upper: number } {
  const m = db.prepare("SELECT value FROM schema_meta WHERE key = 'usage_backfill_v1'").get() as { value: string } | undefined;
  if (!m) return { present: false, upper: LEGACY_CUTOFF_MS };
  let max: unknown = null;
  try {
    max = (JSON.parse(String(m.value)) as { unrecoverableMaxMs?: unknown } | null)?.unrecoverableMaxMs;
  } catch {
    max = null;
  }
  if (typeof max !== 'number' || !Number.isFinite(max)) return { present: true, upper: 0 };
  return { present: true, upper: Math.min(LEGACY_CUTOFF_MS, max + 1) };
}

// Reads only. Callers provide the transaction (deferred for dry-run/plan, the write lock for the re-plan).
function computePlan(db: DatabaseSync, mode: 'dry-run' | 'apply'): Plan {
  const snap = snapshotOf(db);
  const { present, upper } = upperBoundOf(db);
  const noSource = (
    db.prepare('SELECT COUNT(*) AS c FROM usage_events WHERE message_key IS NULL AND source_file_rel IS NULL').get() as { c: number }
  ).c;

  let legacyRows = 0;
  let rowsZeroMass = 0;
  let rowsConsidered = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  const parts = new Map<string, Cand[]>();
  for (const r of db
    .prepare(
      `SELECT id, occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, source_file_rel
       FROM usage_events WHERE message_key IS NULL AND source_file_rel IS NOT NULL AND occurred_at_ms < ? ORDER BY id`
    )
    .iterate(upper) as Iterable<any>) {
    legacyRows++;
    const t = [Number(r.input_tokens), Number(r.output_tokens), Number(r.cache_creation_input_tokens), Number(r.cache_read_input_tokens)];
    const mass = t[0] + t[1] + t[2] + t[3];
    if (mass === 0) {
      rowsZeroMass++;
      continue;
    }
    rowsConsidered++;
    const ms = Number(r.occurred_at_ms);
    if (oldest === null || ms < oldest) oldest = ms;
    if (newest === null || ms > newest) newest = ms;
    const key = JSON.stringify([String(r.source_file_rel), r.model === null ? null : String(r.model), t[0], t[1], t[2], t[3]]);
    const list = parts.get(key);
    const c: Cand = { id: Number(r.id), ms, mass };
    if (list) list.push(c);
    else parts.set(key, [c]);
  }

  let clusters = 0;
  let pairs = 0;
  let triples = 0;
  let maxSize = 0;
  let maxSpan = 0;
  let deleteTokenMass = 0;
  const deleteIds: number[] = [];
  const keptIds: number[] = [];
  const close = (first: Cand, last: Cand, size: number) => {
    clusters++;
    if (size === 2) pairs++;
    else if (size === 3) triples++;
    if (size > maxSize) maxSize = size;
    if (last.ms - first.ms > maxSpan) maxSpan = last.ms - first.ms;
  };
  for (const rows of parts.values()) {
    rows.sort((a, b) => a.ms - b.ms || a.id - b.id);
    let first = rows[0];
    let prev = rows[0];
    let size = 1;
    keptIds.push(first.id);
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.ms - prev.ms <= WINDOW_MS) {
        size++;
        deleteIds.push(r.id);
        deleteTokenMass += r.mass;
      } else {
        close(first, prev, size);
        first = r;
        size = 1;
        keptIds.push(r.id);
      }
      prev = r;
    }
    close(first, prev, size);
  }

  const report: LegacyDedupeReport = {
    mode,
    rule: RULE,
    approximate: true,
    windowMs: WINDOW_MS,
    cutoffMs: LEGACY_CUTOFF_MS,
    upperBoundMs: upper,
    backfillMarkerPresent: present,
    legacyRows,
    legacyRowsNoSource: Number(noSource),
    rowsZeroMass,
    rowsConsidered,
    clusters,
    clusterPairs: pairs,
    clusterTriples: triples,
    maxClusterSize: maxSize,
    maxClusterSpanMs: maxSpan,
    rowsToDelete: deleteIds.length,
    deleteTokenMass,
    candidateOldestMs: oldest,
    candidateNewestMs: newest,
    totalRowsBefore: snap.count,
    totalRowsAfter: snap.count - deleteIds.length,
    totalTokensBefore: snap.tokensTotal,
    totalTokensAfter: snap.tokensTotal - deleteTokenMass,
  };
  return { snap, report, deleteIds, keptIds };
}

export function dedupeLegacyUsage(db: DatabaseSync, opts: LegacyDedupeOptions): LegacyDedupeReport {
  const apply = opts.apply;
  const colCheck = db.prepare('PRAGMA table_info(usage_events)').all() as Array<{ name: string }>;
  if (!colCheck.some((c) => c.name === 'message_key')) {
    throw new Error('usage_events.message_key missing');
  }

  const queryOnlyBefore = (db.prepare('PRAGMA query_only').get() as { query_only: number }).query_only;
  if (!apply) db.exec('PRAGMA query_only = ON');
  try {
    let plan: Plan;
    db.exec('BEGIN');
    try {
      plan = computePlan(db, apply ? 'apply' : 'dry-run');
    } finally {
      db.exec('COMMIT');
    }
    const { snap, report } = plan;
    if (!apply) return report;

    if (!report.backfillMarkerPresent) throw new PrerequisiteError();
    if (!Number.isInteger(opts.expectDelete) || !Number.isInteger(opts.expectTokenMass)) {
      throw new PlanOutOfBoundsError('expect-required');
    }
    if (report.maxClusterSize > MAX_CLUSTER_SIZE) throw new PlanOutOfBoundsError('cluster-size');
    if (report.maxClusterSpanMs > MAX_CLUSTER_SPAN_MS) throw new PlanOutOfBoundsError('cluster-span');
    if (report.rowsToDelete > MAX_DELETE_FRACTION * report.rowsConsidered) throw new PlanOutOfBoundsError('fraction');
    if (report.rowsToDelete !== opts.expectDelete) throw new PlanOutOfBoundsError('expect-delete');
    if (report.deleteTokenMass !== opts.expectTokenMass) throw new PlanOutOfBoundsError('expect-token-mass');

    opts.onSnapshot?.(snap);
    opts.testHooks?.beforeLock?.();

    db.exec('BEGIN IMMEDIATE');
    try {
      if (!sameSnapshot(snap, snapshotOf(db))) throw new DbChangedError();
      const del = db.prepare('DELETE FROM usage_events WHERE id = ? AND message_key IS NULL');
      let deleted = 0;
      for (const id of plan.deleteIds) deleted += Number(del.run(id).changes);
      db.prepare("INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('usage_legacy_dedupe_v1', ?)").run(
        JSON.stringify({
          atMs: Date.now(),
          rowsDeleted: report.rowsToDelete,
          deleteTokenMass: report.deleteTokenMass,
          windowMs: WINDOW_MS,
          rule: RULE,
        })
      );
      opts.testHooks?.afterWrites?.(db);
      const after = snapshotOf(db);
      if (deleted !== report.rowsToDelete) throw new AssertionError('i');
      if (after.count !== snap.count - report.rowsToDelete) throw new AssertionError('ii');
      if (after.tokensTotal !== report.totalTokensAfter) throw new AssertionError('iii');
      // Keyed rows untouched and exactly the planned number of NULL-key rows gone.
      if (after.nullKeyCount !== snap.nullKeyCount - report.rowsToDelete) throw new AssertionError('iv');
      if (after.count - after.nullKeyCount !== snap.count - snap.nullKeyCount) throw new AssertionError('iv');
      // Independent of the plan's bookkeeping: re-run the planner under the lock.
      // A correct delete leaves nothing further to delete.
      if (computePlan(db, 'apply').report.rowsToDelete !== 0) throw new AssertionError('v');
      // Every cluster's kept row is still there and every deleted row is gone.
      const has = db.prepare('SELECT 1 AS x FROM usage_events WHERE id = ?');
      for (const id of plan.keptIds) if (has.get(id) === undefined) throw new AssertionError('vi');
      for (const id of plan.deleteIds) if (has.get(id) !== undefined) throw new AssertionError('vi');
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
