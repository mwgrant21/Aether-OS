import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { openDatabase, migrate } from './schema.js';
import { runLegacyUsageDedupe, LEGACY_DEDUPE_USAGE_TEXT, type LegacyDedupeRunnerEnv } from './usageLegacyDedupeRunner.js';

const require = createRequire(import.meta.url);
const T0 = Date.parse('2026-10-01T00:00:00Z');
const NOW = Date.parse('2026-11-11T12:00:00Z');
const MASS = 115; // 10 + 5 + 0 + 100

interface Fx {
  dir: string;
  dbPath: string;
  out: string[];
  err: string[];
  env: LegacyDedupeRunnerEnv;
}

const INSERT = `INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, source_file_rel, message_key)
                VALUES (?, 'claude-x', 10, 5, 0, ?, 'p/s.jsonl', NULL)`;

// A DB with one legacy pair 2 s apart (plan: delete 1 row, mass 115), the backfill marker, and the given heartbeat.
function fixture(heartbeat: number | string | null, extra: LegacyDedupeRunnerEnv = {}, marker = true): Fx {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-legacydedupe-runner-'));
  const dbPath = join(dir, 'collector.db');
  const db = openDatabase(dbPath);
  migrate(db);
  db.prepare(INSERT).run(T0, 100);
  db.prepare(INSERT).run(T0 + 2000, 100);
  if (marker) {
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('usage_backfill_v1', ?)").run(JSON.stringify({ unrecoverableMaxMs: T0 + 1_000_000 }));
  }
  if (heartbeat !== null) {
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('transcript_last_scan_ms', ?)").run(String(heartbeat));
  }
  db.close();
  const out: string[] = [];
  const err: string[] = [];
  const env: LegacyDedupeRunnerEnv = { out: (l) => out.push(l), err: (l) => err.push(l), now: () => NOW, ...extra };
  return { dir, dbPath, out, err, env };
}

const APPLY = ['--apply', '--expect-delete', '1', '--expect-token-mass', String(MASS)];
const args = (f: Fx, ...more: string[]) => ['--db', f.dbPath, ...more];
const baks = (f: Fx) => readdirSync(f.dir).filter((n) => n.endsWith('.bak'));

function stats(dbPath: string): { count: number; nullKeys: number; sum: number } {
  const db: DatabaseSync = new (require('node:sqlite').DatabaseSync)(dbPath, { readOnly: true });
  try {
    const r = db
      .prepare(
        `SELECT COUNT(*) c, SUM(CASE WHEN message_key IS NULL THEN 1 ELSE 0 END) n,
                SUM(input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens) s FROM usage_events`
      )
      .get() as any;
    return { count: Number(r.c), nullKeys: Number(r.n), sum: Number(r.s) };
  } finally {
    db.close();
  }
}

function insertRow(dbPath: string, cr: number): void {
  const db: DatabaseSync = new (require('node:sqlite').DatabaseSync)(dbPath);
  db.prepare(INSERT).run(T0, cr);
  db.close();
}

describe('runLegacyUsageDedupe', () => {
  it('defaults to a dry-run: one JSON line, no .bak, db unchanged', () => {
    const f = fixture(null);
    const before = stats(f.dbPath);
    expect(runLegacyUsageDedupe(args(f), f.env)).toBe(0);
    expect(f.out).toHaveLength(1);
    const r = JSON.parse(f.out[0]);
    expect(r.mode).toBe('dry-run');
    expect(r.approximate).toBe(true);
    expect(r.rowsToDelete).toBe(1);
    expect(baks(f)).toEqual([]);
    expect(stats(f.dbPath)).toEqual(before);
  });

  it('refuses a 5 s and a 30 s old heartbeat (exit 3), proceeds at 90 s, and --allow-running bypasses', () => {
    const young = fixture(NOW - 5_000);
    const before = stats(young.dbPath);
    expect(runLegacyUsageDedupe(args(young, ...APPLY), young.env)).toBe(3);
    expect(stats(young.dbPath)).toEqual(before);
    expect(baks(young)).toEqual([]);
    const mid = fixture(NOW - 30_000);
    expect(runLegacyUsageDedupe(args(mid, ...APPLY), mid.env)).toBe(3);
    const old = fixture(NOW - 90_000);
    expect(runLegacyUsageDedupe(args(old, ...APPLY), old.env)).toBe(0);
    expect(stats(old.dbPath).count).toBe(1);
    expect(runLegacyUsageDedupe(args(young, ...APPLY, '--allow-running'), young.env)).toBe(0);
    expect(stats(young.dbPath).count).toBe(1);
  });

  it('fails closed (exit 3) on a missing or non-numeric heartbeat', () => {
    for (const hb of [null, 'not-a-number', '']) {
      const f = fixture(hb);
      const before = stats(f.dbPath);
      expect(runLegacyUsageDedupe(args(f, ...APPLY), f.env), String(hb)).toBe(3);
      expect(stats(f.dbPath)).toEqual(before);
      expect(baks(f)).toEqual([]);
    }
  });

  it('takes a matching, correctly named backup before the write', () => {
    const f = fixture(NOW - 90_000);
    const before = stats(f.dbPath);
    expect(runLegacyUsageDedupe(args(f, ...APPLY), f.env)).toBe(0);
    const names = baks(f);
    expect(names).toEqual(['collector.db.pre-legacy-dedupe-20261111120000.bak']);
    expect(names[0]).toMatch(/^collector\.db\.pre-legacy-dedupe-\d{14}\.bak$/);
    expect(stats(join(f.dir, names[0]))).toEqual(before);
    expect(stats(f.dbPath).count).toBe(before.count - 1);
  });

  it('refuses to overwrite an existing backup (exit 4) and leaves it untouched', () => {
    const f = fixture(NOW - 90_000);
    expect(runLegacyUsageDedupe(args(f, ...APPLY), f.env)).toBe(0);
    const name = baks(f)[0];
    const bytes = readFileSync(join(f.dir, name));
    insertRow(f.dbPath, 100); // a third twin, so a second apply has work
    expect(runLegacyUsageDedupe(args(f, ...APPLY), f.env)).toBe(4);
    expect(readFileSync(join(f.dir, name)).equals(bytes)).toBe(true);
    expect(stats(f.dbPath).count).toBe(2);
  });

  it('treats a dangling symlink at the backup path as taken (exit 4)', () => {
    const f = fixture(NOW - 90_000);
    try {
      symlinkSync(join(f.dir, 'nowhere'), join(f.dir, 'collector.db.pre-legacy-dedupe-20261111120000.bak'));
    } catch {
      return; // symlinks need a privilege on this host; the lstat branch is unreachable here
    }
    const before = stats(f.dbPath);
    expect(runLegacyUsageDedupe(args(f, ...APPLY), f.env)).toBe(4);
    expect(stats(f.dbPath)).toEqual(before);
  });

  it('exits 4 on a free-space shortfall with no .bak and the DB unchanged', () => {
    const f = fixture(NOW - 90_000, { freeBytes: () => 0 });
    const before = stats(f.dbPath);
    expect(runLegacyUsageDedupe(args(f, ...APPLY), f.env)).toBe(4);
    expect(baks(f)).toEqual([]);
    expect(stats(f.dbPath)).toEqual(before);
  });

  it('deletes nothing and removes the partial backup when verification fails (exit 4)', () => {
    const f = fixture(NOW - 90_000, { verifyBackup: () => false });
    const before = stats(f.dbPath);
    expect(runLegacyUsageDedupe(args(f, ...APPLY), f.env)).toBe(4);
    expect(baks(f)).toEqual([]);
    expect(stats(f.dbPath)).toEqual(before);
  });

  it('exits 5 when the db changes before the lock, and 1 with fixed text on an assertion failure', () => {
    const a = fixture(NOW - 90_000, { testHooks: { beforeLock: () => insertRow(join(a.dir, 'collector.db'), 7) } });
    expect(runLegacyUsageDedupe(args(a, ...APPLY), a.env)).toBe(5);
    expect(stats(a.dbPath).count).toBe(3);
    const b = fixture(NOW - 90_000, { testHooks: { afterWrites: (db) => void db.prepare('DELETE FROM usage_events WHERE id = 1').run() } });
    const before = stats(b.dbPath);
    expect(runLegacyUsageDedupe(args(b, ...APPLY), b.env)).toBe(1);
    expect(stats(b.dbPath)).toEqual(before);
    const text = b.err.join('\n');
    expect(text).toContain('post-write assertion');
    expect(text).not.toContain(b.dir);
  });

  it('exits 2 with no .bak and the DB unchanged when the backfill marker is missing', () => {
    const f = fixture(NOW - 90_000, {}, false);
    const before = stats(f.dbPath);
    expect(runLegacyUsageDedupe(args(f, ...APPLY), f.env)).toBe(2);
    expect(baks(f)).toEqual([]);
    expect(stats(f.dbPath)).toEqual(before);
  });

  it('exits 6 before any backup on an expected-count mismatch, a missing expectation or a plan over the bound', () => {
    const f = fixture(NOW - 90_000);
    const before = stats(f.dbPath);
    for (const a of [
      ['--apply', '--expect-delete', '2', '--expect-token-mass', String(MASS)],
      ['--apply', '--expect-delete', '1', '--expect-token-mass', '114'],
      ['--apply', '--expect-token-mass', String(MASS)],
      ['--apply', '--expect-delete', '1'],
    ]) {
      expect(runLegacyUsageDedupe(args(f, ...a), f.env), a.join(' ')).toBe(6);
      expect(baks(f)).toEqual([]);
      expect(stats(f.dbPath)).toEqual(before);
    }
    const g = fixture(NOW - 90_000);
    insertRow(g.dbPath, 100); // triple: 2 of 3 rows deleted is above 60%
    expect(runLegacyUsageDedupe(args(g, '--apply', '--expect-delete', '2', '--expect-token-mass', String(2 * MASS)), g.env)).toBe(6);
    expect(baks(g)).toEqual([]);
    expect(stats(g.dbPath).count).toBe(3);
  });

  it('rejects a non-integer expectation and unknown flags with the usage text (exit 1)', () => {
    const f = fixture(NOW - 90_000);
    expect(runLegacyUsageDedupe(args(f, '--apply', '--expect-delete', 'x'), f.env)).toBe(1);
    expect(runLegacyUsageDedupe(args(f, '--bogus'), f.env)).toBe(1);
    expect(f.err.join('\n')).toContain('Usage: dedupe-legacy-usage');
    expect(baks(f)).toEqual([]);
  });

  it('documents the approximate rule, the backup name, the rollback caveat and the run order', () => {
    const t = LEGACY_DEDUPE_USAGE_TEXT;
    expect(t).toContain('APPROXIMATE');
    expect(t).toContain('collector.db.pre-legacy-dedupe-<UTC yyyymmddHHMMSS>.bak');
    expect(t).toContain('Rollback: restoring the .bak is clean ONLY before the collector restarts');
    expect(t).toContain('<db>-wal');
    expect(t).toContain('Run backfill-usage first');
    const f = fixture(null);
    expect(runLegacyUsageDedupe(['--help'], f.env)).toBe(0);
    expect(f.out[0]).toBe(t);
  });
});
