import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { openDatabase, migrate } from './schema.js';
import { openDryRunHandle, DbChangedError, AssertionError } from './usageBackfill.js';
import {
  dedupeLegacyUsage,
  LEGACY_CUTOFF_MS,
  WINDOW_MS,
  PrerequisiteError,
  PlanOutOfBoundsError,
  type LegacyDedupeOptions,
} from './usageLegacyDedupe.js';

const require = createRequire(import.meta.url);
const T0 = Date.parse('2026-10-01T00:00:00Z');

interface Env {
  db: DatabaseSync;
  dbPath: string;
}

function freshEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-usagelegacydedupe-'));
  const dbPath = join(dir, 'test.db');
  const db = openDatabase(dbPath);
  migrate(db);
  return { db, dbPath };
}

interface Row {
  rel?: string | null;
  model?: string | null;
  ms?: number;
  inp?: number;
  out?: number;
  cc?: number;
  cr?: number;
  key?: string | null;
}

function ins(env: Env, r: Row = {}): number {
  const res = env.db
    .prepare(
      `INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, source_file_rel, message_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      r.ms ?? T0,
      r.model === undefined ? 'claude-x' : r.model,
      r.inp ?? 10,
      r.out ?? 5,
      r.cc ?? 0,
      r.cr ?? 100,
      r.rel === undefined ? 'p/s.jsonl' : r.rel,
      r.key === undefined ? null : r.key
    );
  return Number(res.lastInsertRowid);
}

const MASS = 115; // default row: 10 + 5 + 0 + 100

function dump(db: DatabaseSync): string {
  return JSON.stringify([
    db.prepare('SELECT * FROM usage_events ORDER BY id').all(),
    db.prepare('SELECT * FROM schema_meta ORDER BY key').all(),
  ]);
}

describe('dedupeLegacyUsage planning (dry-run)', () => {
  it('plans one deletion for a pair 2 s apart and keeps the lowest id', () => {
    const e = freshEnv();
    const a = ins(e, { ms: T0 });
    ins(e, { ms: T0 + 2000 });
    const r = dedupeLegacyUsage(e.db, { apply: false });
    expect(r.rule).toBe('file+model+tokens within 60 s chain');
    expect(r.approximate).toBe(true);
    expect(r.mode).toBe('dry-run');
    expect(r.rowsToDelete).toBe(1);
    expect(r.deleteTokenMass).toBe(MASS);
    expect(r.clusters).toBe(1);
    expect(r.clusterPairs).toBe(1);
    expect(a).toBe(1);
  });

  it('merges a gap of exactly 60000 ms and not 60001 ms', () => {
    const e = freshEnv();
    ins(e, { ms: T0 });
    ins(e, { ms: T0 + WINDOW_MS });
    expect(dedupeLegacyUsage(e.db, { apply: false }).rowsToDelete).toBe(1);
    const e2 = freshEnv();
    ins(e2, { ms: T0 });
    ins(e2, { ms: T0 + WINDOW_MS + 1 });
    const r = dedupeLegacyUsage(e2.db, { apply: false });
    expect(r.rowsToDelete).toBe(0);
    expect(r.clusters).toBe(2);
  });

  it('chains three rows 50 s apart into one cluster with its span', () => {
    const e = freshEnv();
    ins(e, { ms: T0 });
    ins(e, { ms: T0 + 50_000 });
    ins(e, { ms: T0 + 100_000 });
    const r = dedupeLegacyUsage(e.db, { apply: false });
    expect(r.clusters).toBe(1);
    expect(r.clusterTriples).toBe(1);
    expect(r.rowsToDelete).toBe(2);
    expect(r.maxClusterSize).toBe(3);
    expect(r.maxClusterSpanMs).toBe(100_000);
  });

  it('never clusters rows that differ in any one of file, model or the four token columns', () => {
    const variants: Row[] = [{ rel: 'p/other.jsonl' }, { model: 'claude-y' }, { inp: 11 }, { out: 6 }, { cc: 1 }, { cr: 101 }];
    for (const v of variants) {
      const e = freshEnv();
      ins(e, { ms: T0 });
      ins(e, { ...v, ms: T0 + 1000 });
      const r = dedupeLegacyUsage(e.db, { apply: false });
      expect(r.rowsToDelete, JSON.stringify(v)).toBe(0);
      expect(r.clusters).toBe(2);
    }
    const e = freshEnv();
    ins(e, { model: null, ms: T0 });
    ins(e, { model: null, ms: T0 + 1000 });
    expect(dedupeLegacyUsage(e.db, { apply: false }).rowsToDelete).toBe(1);
  });

  it('excludes all-zero-token rows from clustering', () => {
    const e = freshEnv();
    ins(e, { inp: 0, out: 0, cc: 0, cr: 0, ms: T0 });
    ins(e, { inp: 0, out: 0, cc: 0, cr: 0, ms: T0 + 1000 });
    const r = dedupeLegacyUsage(e.db, { apply: false });
    expect(r.rowsZeroMass).toBe(2);
    expect(r.rowsConsidered).toBe(0);
    expect(r.rowsToDelete).toBe(0);
  });

  it('never considers keyed rows, rows at or after the cutoff, or NULL-source rows', () => {
    const e = freshEnv();
    ins(e, { ms: T0, key: 'k:1' });
    ins(e, { ms: T0 + 1000, key: 'k:2' });
    ins(e, { ms: LEGACY_CUTOFF_MS });
    ins(e, { ms: LEGACY_CUTOFF_MS + 1000 });
    ins(e, { ms: T0, rel: null });
    ins(e, { ms: T0 + 1000, rel: null });
    const r = dedupeLegacyUsage(e.db, { apply: false });
    expect(r.legacyRowsNoSource).toBe(2);
    expect(r.legacyRows).toBe(0);
    expect(r.rowsToDelete).toBe(0);
    expect(r.candidateOldestMs).toBeNull();
    expect(r.candidateNewestMs).toBeNull();
  });

  it('ties the candidate bound to the backfill marker unrecoverableMaxMs', () => {
    const e = freshEnv();
    ins(e, { ms: T0 });
    ins(e, { ms: T0 + 1000 });
    const set = (v: string) => e.db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('usage_backfill_v1', ?)").run(v);
    set(JSON.stringify({ unrecoverableMaxMs: T0 }));
    let r = dedupeLegacyUsage(e.db, { apply: false });
    expect(r.backfillMarkerPresent).toBe(true);
    expect(r.legacyRows).toBe(1);
    expect(r.rowsToDelete).toBe(0);
    set(JSON.stringify({ unrecoverableMaxMs: T0 + 1000 }));
    expect(dedupeLegacyUsage(e.db, { apply: false }).rowsToDelete).toBe(1);
    set(JSON.stringify({ unrecoverableMaxMs: null }));
    r = dedupeLegacyUsage(e.db, { apply: false });
    expect(r.legacyRows).toBe(0);
  });

  it('keeps the lowest id when occurred_at_ms is equal', () => {
    const e = freshEnv();
    const a = ins(e, { ms: T0 });
    const b = ins(e, { ms: T0 });
    expect(b).toBeGreaterThan(a);
    const r = dedupeLegacyUsage(e.db, { apply: false });
    expect(r.rowsToDelete).toBe(1);
    expect(r.maxClusterSpanMs).toBe(0);
  });

  it('writes nothing in a dry-run, restores query_only, and works on a read-only handle', () => {
    const e = freshEnv();
    ins(e, { ms: T0 });
    ins(e, { ms: T0 + 1000 });
    const before = dump(e.db);
    dedupeLegacyUsage(e.db, { apply: false });
    expect(dump(e.db)).toBe(before);
    expect((e.db.prepare('PRAGMA query_only').get() as { query_only: number }).query_only).toBe(0);
    const ro = openDryRunHandle(e.dbPath);
    try {
      expect(dedupeLegacyUsage(ro, { apply: false }).rowsToDelete).toBe(1);
    } finally {
      ro.close();
    }
  });

  it('keeps the row, token and cluster invariants on a mixed fixture', () => {
    const e = freshEnv();
    ins(e, { ms: T0 });
    ins(e, { ms: T0 + 1000 });
    ins(e, { ms: T0 + 2000 });
    ins(e, { ms: T0 + 500_000 });
    ins(e, { cr: 7, ms: T0 });
    ins(e, { inp: 0, out: 0, cc: 0, cr: 0 });
    ins(e, { key: 'k:1' });
    ins(e, { rel: null });
    const r = dedupeLegacyUsage(e.db, { apply: false });
    expect(r.rowsConsidered).toBe(r.clusters + r.rowsToDelete);
    expect(r.legacyRows).toBe(r.rowsZeroMass + r.rowsConsidered);
    expect(r.totalTokensAfter).toBe(r.totalTokensBefore - r.deleteTokenMass);
    expect(r.totalRowsAfter).toBe(r.totalRowsBefore - r.rowsToDelete);
    expect(r.rowsToDelete).toBe(2);
    expect(r.totalRowsBefore).toBe(8);
  });

  it('throws the exact message when usage_events has no message_key column', () => {
    const db: DatabaseSync = new (require('node:sqlite').DatabaseSync)(':memory:');
    db.exec('CREATE TABLE usage_events (id INTEGER PRIMARY KEY, occurred_at_ms INTEGER)');
    expect(() => dedupeLegacyUsage(db, { apply: false })).toThrow('usage_events.message_key missing');
  });
});

// Marker as #229 writes it; unrecoverableMaxMs well past every fixture row.
function markBackfilled(e: Env): void {
  e.db
    .prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('usage_backfill_v1', ?)")
    .run(JSON.stringify({ unrecoverableMaxMs: T0 + 10_000_000 }));
}

// pair (ids 1,2), triple (3,4,5), a lone row (6), a keyed twin (7), an all-zero row (8): plan = 3 deletes, mass 159.
function seed(): Env {
  const e = freshEnv();
  markBackfilled(e);
  ins(e, { ms: T0 });
  ins(e, { ms: T0 + 2000 });
  ins(e, { cr: 7, ms: T0 });
  ins(e, { cr: 7, ms: T0 + 10_000 });
  ins(e, { cr: 7, ms: T0 + 20_000 });
  ins(e, { cr: 9, ms: T0 });
  ins(e, { ms: T0, key: 'k:1' });
  ins(e, { inp: 0, out: 0, cc: 0, cr: 0 });
  return e;
}
const PLAN = { expectDelete: 3, expectTokenMass: 159 };
const run = (e: Env, extra: Partial<LegacyDedupeOptions> = {}) => dedupeLegacyUsage(e.db, { apply: true, ...PLAN, ...extra });
const ids = (e: Env) => (e.db.prepare('SELECT id FROM usage_events ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id);
const sum = (e: Env) =>
  Number(
    (e.db.prepare('SELECT SUM(input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens) AS s FROM usage_events').get() as { s: number }).s
  );
const refusal = (e: Env, o: Partial<LegacyDedupeOptions>): { err: unknown; called: boolean } => {
  let called = false;
  let err: unknown;
  try {
    dedupeLegacyUsage(e.db, { apply: true, ...o, onSnapshot: () => void (called = true) });
  } catch (x) {
    err = x;
  }
  return { err, called };
};

describe('dedupeLegacyUsage apply', () => {
  it('deletes exactly the planned rows, keeps the lowest id per cluster and leaves keyed rows alone', () => {
    const e = seed();
    const r = run(e);
    expect(r.mode).toBe('apply');
    expect(ids(e)).toEqual([1, 3, 6, 7, 8]);
    const nulls = e.db.prepare('SELECT id FROM usage_events WHERE message_key IS NULL ORDER BY id').all() as Array<{ id: number }>;
    expect(nulls.map((x) => x.id)).toEqual([1, 3, 6, 8]);
    expect((e.db.prepare('SELECT message_key FROM usage_events WHERE id = 7').get() as { message_key: string }).message_key).toBe('k:1');
    const m = JSON.parse((e.db.prepare("SELECT value FROM schema_meta WHERE key = 'usage_legacy_dedupe_v1'").get() as { value: string }).value);
    expect(m.rowsDeleted).toBe(3);
  });

  it('is idempotent: a second apply deletes nothing and leaves the marker unchanged', () => {
    const e = seed();
    run(e);
    const before = dump(e.db);
    const r = dedupeLegacyUsage(e.db, { apply: true, expectDelete: 0, expectTokenMass: 0 });
    expect(r.rowsToDelete).toBe(0);
    expect(dump(e.db)).toBe(before);
  });

  it('hands onSnapshot the snapshot before any write, and a throw there writes nothing', () => {
    const e = seed();
    const before = dump(e.db);
    let seen: unknown;
    expect(() =>
      run(e, {
        onSnapshot: (s) => {
          seen = s;
          expect(dump(e.db)).toBe(before);
          throw new Error('backup failed');
        },
      })
    ).toThrow('backup failed');
    expect((seen as { count: number }).count).toBe(8);
    expect(dump(e.db)).toBe(before);
  });

  it('throws DbChangedError and writes nothing when a row appears between plan and lock', () => {
    const e = seed();
    expect(() => run(e, { testHooks: { beforeLock: () => void ins(e, { cr: 55 }) } })).toThrow(DbChangedError);
    expect(ids(e)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('throws DbChangedError, not a silent delete, when a planned row is keyed before the lock', () => {
    const e = seed();
    expect(() =>
      run(e, { testHooks: { beforeLock: () => void e.db.prepare("UPDATE usage_events SET message_key = 'k:2' WHERE id = 2").run() } })
    ).toThrow(DbChangedError);
    expect(ids(e)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('rolls back everything when a post-write assertion fails', () => {
    const e = seed();
    const before = dump(e.db);
    expect(() => run(e, { testHooks: { afterWrites: (db) => void db.prepare('DELETE FROM usage_events WHERE id = 6').run() } })).toThrow(AssertionError);
    expect(dump(e.db)).toBe(before);
  });

  it('catches a delete of the wrong row even when count and token mass match (kept row swapped for a clone)', () => {
    const e = seed();
    const before = dump(e.db);
    let err: unknown;
    try {
      run(e, {
        testHooks: {
          afterWrites: (db) => {
            db.prepare('DELETE FROM usage_events WHERE id = 1').run();
            db.prepare(
              `INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, source_file_rel, message_key)
               VALUES (?, 'claude-x', 10, 5, 0, 100, 'p/s.jsonl', NULL)`
            ).run(T0 + 5000);
          },
        },
      });
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(AssertionError);
    expect(['v', 'vi']).toContain((err as AssertionError).assertion);
    expect(dump(e.db)).toBe(before);
  });

  it('reports totalTokensAfter equal to an independent SUM after the apply', () => {
    const e = seed();
    const r = run(e);
    expect(sum(e)).toBe(r.totalTokensAfter);
    expect(r.totalTokensAfter).toBe(r.totalTokensBefore - 159);
  });

  it('refuses a plan above the delete-fraction bound before onSnapshot', () => {
    const e = freshEnv();
    markBackfilled(e);
    for (let i = 0; i < 3; i++) ins(e, { ms: T0 + i * 1000 });
    const before = dump(e.db);
    const { err, called } = refusal(e, { expectDelete: 2, expectTokenMass: 230 });
    expect((err as PlanOutOfBoundsError).reason).toBe('fraction');
    expect(called).toBe(false);
    expect(dump(e.db)).toBe(before);
  });

  it('refuses a missing backfill marker with PrerequisiteError while a dry-run still reports it', () => {
    const e = seed();
    e.db.prepare("DELETE FROM schema_meta WHERE key = 'usage_backfill_v1'").run();
    const before = dump(e.db);
    expect(() => run(e)).toThrow(PrerequisiteError);
    expect(dump(e.db)).toBe(before);
    expect(dedupeLegacyUsage(e.db, { apply: false }).backfillMarkerPresent).toBe(false);
  });

  it('requires the expected counts and refuses a mismatch before onSnapshot', () => {
    for (const bad of [
      { expectDelete: 2, expectTokenMass: 159, reason: 'expect-delete' },
      { expectDelete: 3, expectTokenMass: 158, reason: 'expect-token-mass' },
      { expectDelete: undefined, expectTokenMass: 159, reason: 'expect-required' },
      { expectDelete: 3, expectTokenMass: undefined, reason: 'expect-required' },
    ]) {
      const e = seed();
      const before = dump(e.db);
      const { err, called } = refusal(e, { expectDelete: bad.expectDelete, expectTokenMass: bad.expectTokenMass });
      expect(err).toBeInstanceOf(PlanOutOfBoundsError);
      expect((err as PlanOutOfBoundsError).reason).toBe(bad.reason);
      expect(called).toBe(false);
      expect(dump(e.db)).toBe(before);
    }
  });

  it('refuses a cluster over 30 rows or spanning over 300 s before onSnapshot', () => {
    const big = freshEnv();
    markBackfilled(big);
    for (let i = 0; i < 31; i++) ins(big, { ms: T0 + i * 1000 });
    const wide = freshEnv();
    markBackfilled(wide);
    for (let i = 0; i < 8; i++) ins(wide, { ms: T0 + i * 50_000 });
    const a = refusal(big, { expectDelete: 30, expectTokenMass: 30 * MASS });
    expect((a.err as PlanOutOfBoundsError).reason).toBe('cluster-size');
    expect(a.called).toBe(false);
    const b = refusal(wide, { expectDelete: 7, expectTokenMass: 7 * MASS });
    expect((b.err as PlanOutOfBoundsError).reason).toBe('cluster-span');
    expect(b.called).toBe(false);
  });
});
