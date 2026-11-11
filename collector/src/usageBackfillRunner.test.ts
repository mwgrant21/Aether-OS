import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { openDatabase, migrate } from './schema.js';
import { runUsageBackfill, USAGE_TEXT, type RunnerEnv } from './usageBackfillRunner.js';
import { DbChangedError, AssertionError } from './usageBackfill.js';

const require = createRequire(import.meta.url);
const T0 = Date.parse('2026-10-01T00:00:00Z');
const NOW = Date.parse('2026-11-11T12:00:00Z');

interface Fx {
  dir: string;
  dbPath: string;
  root: string;
  out: string[];
  err: string[];
  env: RunnerEnv;
}

// A DB with two legacy rows for one transcript message, so apply has work to do.
function fixture(heartbeatMs: number | null, extra: RunnerEnv = {}): Fx {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-usagebackfillrunner-'));
  const dbPath = join(dir, 'collector.db');
  const db = openDatabase(dbPath);
  migrate(db);
  const root = join(dir, 'projects');
  mkdirSync(join(root, 'p'), { recursive: true });
  const line = JSON.stringify({
    type: 'assistant',
    requestId: 'req_1',
    timestamp: new Date(T0).toISOString(),
    message: {
      id: 'msg_1',
      model: 'claude-x',
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [],
    },
  });
  writeFileSync(join(root, 'p', 's.jsonl'), line + '\n');
  const ins = db.prepare(
    `INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, source_file_rel, message_key)
     VALUES (?, 'claude-x', 10, 5, 0, 0, 'p/s.jsonl', NULL)`
  );
  ins.run(T0);
  ins.run(T0);
  if (heartbeatMs !== null) {
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('transcript_last_scan_ms', ?)").run(String(heartbeatMs));
  }
  db.close();
  const out: string[] = [];
  const err: string[] = [];
  const env: RunnerEnv = { out: (l) => out.push(l), err: (l) => err.push(l), now: () => NOW, ...extra };
  return { dir, dbPath, root, out, err, env };
}

const args = (f: Fx, ...more: string[]) => ['--db', f.dbPath, '--projects-root', f.root, ...more];
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

describe('runUsageBackfill', () => {
  it('refuses with exit 3 on a fresh heartbeat, writes nothing, and proceeds with --allow-running', () => {
    const f = fixture(NOW - 5_000);
    const before = stats(f.dbPath);
    expect(runUsageBackfill(args(f, '--apply'), f.env)).toBe(3);
    expect(stats(f.dbPath)).toEqual(before);
    expect(baks(f)).toEqual([]);
    expect(runUsageBackfill(args(f, '--apply', '--allow-running'), f.env)).toBe(0);
    expect(stats(f.dbPath).nullKeys).toBe(0);
  });

  it('treats a 30 s old heartbeat as alive and a 90 s old one as stopped', () => {
    const young = fixture(NOW - 30_000);
    expect(runUsageBackfill(args(young, '--apply'), young.env)).toBe(3);
    const old = fixture(NOW - 90_000);
    expect(runUsageBackfill(args(old, '--apply'), old.env)).toBe(0);
    expect(stats(old.dbPath).count).toBe(1);
  });

  it('creates a matching backup and refuses to overwrite one that exists (exit 4)', () => {
    const f = fixture(NOW - 90_000);
    const before = stats(f.dbPath);
    expect(runUsageBackfill(args(f, '--apply'), f.env)).toBe(0);
    const names = baks(f);
    expect(names).toEqual(['collector.db.pre-usage-backfill-20261111120000.bak']);
    expect(stats(join(f.dir, names[0]))).toEqual(before);
    const bytes = readFileSync(join(f.dir, names[0]));
    // Second apply in the same second: restore a legacy row so there is work, then run again.
    const db: DatabaseSync = new (require('node:sqlite').DatabaseSync)(f.dbPath);
    db.prepare(
      `INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, source_file_rel, message_key)
       VALUES (?, 'claude-x', 10, 5, 0, 0, 'p/s.jsonl', NULL)`
    ).run(T0);
    db.close();
    expect(runUsageBackfill(args(f, '--apply'), f.env)).toBe(4);
    expect(readFileSync(join(f.dir, names[0])).equals(bytes)).toBe(true);
    expect(stats(f.dbPath).nullKeys).toBe(1);
  });

  it('exits 4 on a free-space shortfall with no .bak and the DB unchanged', () => {
    const f = fixture(NOW - 90_000, { freeBytes: () => 0 });
    const before = stats(f.dbPath);
    expect(runUsageBackfill(args(f, '--apply'), f.env)).toBe(4);
    expect(baks(f)).toEqual([]);
    expect(stats(f.dbPath)).toEqual(before);
  });

  it('exits 4 and deletes the partial .bak it created when verification fails', () => {
    const f = fixture(NOW - 90_000, { verifyBackup: () => false });
    const before = stats(f.dbPath);
    expect(runUsageBackfill(args(f, '--apply'), f.env)).toBe(4);
    expect(baks(f)).toEqual([]);
    expect(stats(f.dbPath)).toEqual(before);
  });

  it('does not delete a pre-existing .bak when the target name is taken', () => {
    const f = fixture(NOW - 90_000);
    const p = join(f.dir, 'collector.db.pre-usage-backfill-20261111120000.bak');
    writeFileSync(p, 'precious');
    expect(runUsageBackfill(args(f, '--apply'), f.env)).toBe(4);
    expect(readFileSync(p, 'utf8')).toBe('precious');
  });

  it('maps DbChangedError to exit 5 and AssertionError to exit 1 with fixed text and no path', () => {
    const a = fixture(NOW - 90_000, {
      testHooks: {
        beforeLock: () => {
          throw new DbChangedError();
        },
      },
    });
    expect(runUsageBackfill(args(a, '--apply'), a.env)).toBe(5);
    const b = fixture(NOW - 90_000, {
      testHooks: {
        afterWrites: () => {
          throw new AssertionError('ii');
        },
      },
    });
    expect(runUsageBackfill(args(b, '--apply'), b.env)).toBe(1);
    for (const f of [a, b]) {
      const text = f.err.join('\n');
      expect(text).toContain('exit');
      expect(text).not.toContain(f.dir);
      expect(text).not.toContain('tmp');
    }
    expect(stats(b.dbPath).count).toBe(2);
  });

  it('exits 2 without writing when usage_events.message_key is missing', () => {
    const f = fixture(NOW - 90_000);
    const p = join(f.dir, 'old.db');
    const db: DatabaseSync = new (require('node:sqlite').DatabaseSync)(p);
    db.exec(
      `CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT);
       CREATE TABLE usage_events (id INTEGER PRIMARY KEY, occurred_at_ms INTEGER, model TEXT, input_tokens INTEGER,
         output_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER, source_file_rel TEXT);`
    );
    db.close();
    expect(runUsageBackfill(['--db', p, '--projects-root', f.root, '--apply'], f.env)).toBe(2);
    expect(readdirSync(f.dir).filter((n) => n.endsWith('.bak'))).toEqual([]);
  });

  it('dry-run reports JSON and writes nothing', () => {
    const f = fixture(NOW - 5_000);
    const before = stats(f.dbPath);
    expect(runUsageBackfill(args(f), f.env)).toBe(0);
    const rep = JSON.parse(f.out[0]);
    expect(rep.mode).toBe('dry-run');
    expect(rep.rowsToKey).toBe(1);
    expect(stats(f.dbPath)).toEqual(before);
    expect(baks(f)).toEqual([]);
  });

  it('prints usage with the rollback caveat and backup name pattern on --help; bad args exit 1', () => {
    const f = fixture(null);
    expect(runUsageBackfill(['--help'], f.env)).toBe(0);
    const t = f.out.join('\n');
    expect(t).toBe(USAGE_TEXT);
    expect(t).toContain('collector.db.pre-usage-backfill-<UTC yyyymmddHHMMSS>.bak');
    expect(t).toMatch(/ONLY before the collector restarts/);
    expect(t).toMatch(/tool_calls/);
    expect(runUsageBackfill(['--bogus'], f.env)).toBe(1);
    expect(existsSync(f.dbPath)).toBe(true);
  });
});
