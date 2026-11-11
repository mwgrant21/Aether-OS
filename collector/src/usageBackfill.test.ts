import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, migrate } from './schema.js';
import {
  backfillUsageKeys,
  isInsideRoot,
  openDryRunHandle,
  DbChangedError,
  AssertionError,
  type BackfillReport,
} from './usageBackfill.js';

const T0 = Date.parse('2026-10-01T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

interface Env {
  db: DatabaseSync;
  dbPath: string;
  root: string;
}

function freshEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-usagebackfill-'));
  const dbPath = join(dir, 'test.db');
  const db = openDatabase(dbPath);
  migrate(db);
  const root = join(dir, 'projects');
  mkdirSync(root);
  return { db, dbPath, root };
}

interface Line {
  id?: string | null;
  req?: string;
  ms?: number;
  model?: string | null;
  out?: number;
  inp?: number;
}

function assistantLine(l: Line): string {
  const message: any = {
    model: l.model === undefined ? 'claude-x' : l.model,
    usage: { input_tokens: l.inp ?? 10, output_tokens: l.out ?? 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    content: [],
  };
  if (l.id !== null) message.id = l.id ?? 'msg_1';
  const json: any = { type: 'assistant', timestamp: iso(l.ms ?? T0), message };
  if (l.req !== undefined) json.requestId = l.req;
  return JSON.stringify(json);
}

function writeTranscript(env: Env, rel: string, lines: string[], terminate = true): void {
  const p = join(env.root, ...rel.split(/[\\/]/));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.join('\n') + (terminate ? '\n' : ''));
}

// A legacy row: message_key NULL, as written before 0.7.6.
function legacy(env: Env, rel: string | null, l: Line = {}): number {
  const r = env.db
    .prepare(
      `INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, source_file_rel, message_key)
       VALUES (?, ?, ?, ?, 0, 0, ?, NULL)`
    )
    .run(l.ms ?? T0, l.model === undefined ? 'claude-x' : l.model, l.inp ?? 10, l.out ?? 5, rel);
  return Number(r.lastInsertRowid);
}

function keyed(env: Env, key: string, rel = 'k.jsonl'): number {
  const r = env.db
    .prepare(
      `INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, source_file_rel, message_key)
       VALUES (?, 'claude-x', 10, 5, 0, 0, ?, ?)`
    )
    .run(T0, rel, key);
  return Number(r.lastInsertRowid);
}

const rows = (env: Env) =>
  env.db
    .prepare('SELECT id, occurred_at_ms, model, input_tokens, output_tokens, source_file_rel, message_key FROM usage_events ORDER BY id')
    .all() as Array<{ id: number; output_tokens: number; message_key: string | null; source_file_rel: string | null }>;

const run = (env: Env, apply: boolean, testHooks?: Parameters<typeof backfillUsageKeys>[2]['testHooks']) =>
  backfillUsageKeys(env.db, env.root, { apply, testHooks });

const bucketSum = (r: BackfillReport) => r.rowsUnrecoverable + r.rowsNoMatch + r.rowsKeyless + r.rowsAmbiguous + r.rowsMatched;

describe('backfillUsageKeys', () => {
  it('keeps the lowest id of three streamed lines, sets its key and deletes the other two', () => {
    const env = freshEnv();
    writeTranscript(env, 'p/a.jsonl', [assistantLine({ id: 'm1', req: 'r1' })]);
    const ids = [legacy(env, 'p/a.jsonl'), legacy(env, 'p/a.jsonl'), legacy(env, 'p/a.jsonl')];
    const report = run(env, true);
    expect(report.rowsToKey).toBe(1);
    expect(report.rowsToDelete).toBe(2);
    expect(rows(env).map((r) => [r.id, r.message_key])).toEqual([[ids[0], 'm1:r1']]);
  });

  it('keeps the first row with its own usage when repeats carry different usage', () => {
    const env = freshEnv();
    writeTranscript(env, 'p/a.jsonl', [
      assistantLine({ id: 'm1', req: 'r', out: 5 }),
      assistantLine({ id: 'm1', req: 'r', out: 9 }),
    ]);
    const first = legacy(env, 'p/a.jsonl', { out: 5 });
    legacy(env, 'p/a.jsonl', { out: 9 });
    run(env, true);
    const left = rows(env);
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(first);
    expect(left[0].output_tokens).toBe(5);
  });

  it('deletes every legacy row of a key that a keyed row already holds and leaves the keyed row', () => {
    const env = freshEnv();
    writeTranscript(env, 'p/a.jsonl', [assistantLine({ id: 'm1', req: 'r' })]);
    const k = keyed(env, 'm1:r');
    legacy(env, 'p/a.jsonl');
    legacy(env, 'p/a.jsonl');
    const report = run(env, true);
    expect(report.keysAlreadyInTable).toBe(1);
    expect(rows(env).map((r) => [r.id, r.message_key])).toEqual([[k, 'm1:r']]);
  });

  it('leaves one row when the same key appears in two files', () => {
    const env = freshEnv();
    writeTranscript(env, 'p/a.jsonl', [assistantLine({ id: 'm1', req: 'r' })]);
    writeTranscript(env, 'p/b.jsonl', [assistantLine({ id: 'm1', req: 'r' })]);
    const a = legacy(env, 'p/a.jsonl');
    legacy(env, 'p/b.jsonl');
    run(env, true);
    expect(rows(env).map((r) => [r.id, r.message_key])).toEqual([[a, 'm1:r']]);
  });

  it('collapses a line that was ingested twice into one row', () => {
    const env = freshEnv();
    writeTranscript(env, 'p/a.jsonl', [assistantLine({ id: 'm1', req: 'r' })]);
    const a = legacy(env, 'p/a.jsonl');
    legacy(env, 'p/a.jsonl');
    const report = run(env, true);
    expect(report.rowsMatched).toBe(2);
    expect(rows(env).map((r) => r.id)).toEqual([a]);
  });

  it('leaves rows of a missing transcript untouched and reports them unrecoverable with min/max', () => {
    const env = freshEnv();
    legacy(env, 'gone/a.jsonl', { ms: T0 + 1000 });
    legacy(env, 'gone/a.jsonl', { ms: T0 + 5000 });
    const report = run(env, true);
    expect(report.rowsUnrecoverable).toBe(2);
    expect(report.unrecoverableMinMs).toBe(T0 + 1000);
    expect(report.unrecoverableMaxMs).toBe(T0 + 5000);
    expect(report.filesUnusable).toBe(1);
    expect(rows(env)).toHaveLength(2);
  });

  it('treats a .. path and an absolute path as unusable and reads nothing outside the root', () => {
    const env = freshEnv();
    const outside = join(dirname(env.root), 'outside.jsonl');
    writeFileSync(outside, assistantLine({ id: 'm1', req: 'r' }) + '\n');
    legacy(env, '../outside.jsonl');
    legacy(env, outside);
    const report = run(env, true);
    expect(report.filesUnusable).toBe(2);
    expect(report.rowsUnrecoverable).toBe(2);
    expect(rows(env).every((r) => r.message_key === null)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('treats a symlinked transcript as unusable', () => {
    const env = freshEnv();
    const target = join(dirname(env.root), 'target.jsonl');
    writeFileSync(target, assistantLine({ id: 'm1', req: 'r' }) + '\n');
    symlinkSync(target, join(env.root, 'link.jsonl'));
    legacy(env, 'link.jsonl');
    const report = run(env, true);
    expect(report.filesUnusable).toBe(1);
    expect(rows(env)[0].message_key).toBeNull();
  });

  it('matches a row whose source_file_rel uses backslashes', () => {
    const env = freshEnv();
    writeTranscript(env, 'p/a.jsonl', [assistantLine({ id: 'm1', req: 'r' })]);
    legacy(env, 'p\\a.jsonl');
    expect(run(env, true).rowsToKey).toBe(1);
  });

  it('counts a line without message.id as keyless and leaves the row', () => {
    const env = freshEnv();
    writeTranscript(env, 'p/a.jsonl', [assistantLine({ id: null })]);
    legacy(env, 'p/a.jsonl');
    const report = run(env, true);
    expect(report.rowsKeyless).toBe(1);
    expect(rows(env)[0].message_key).toBeNull();
  });

  it('counts a present file with no matching line as rowsNoMatch', () => {
    const env = freshEnv();
    writeTranscript(env, 'p/a.jsonl', [assistantLine({ id: 'm1', req: 'r', out: 99 })]);
    legacy(env, 'p/a.jsonl');
    const report = run(env, true);
    expect(report.rowsNoMatch).toBe(1);
    expect(rows(env)).toHaveLength(1);
  });

  it('leaves a row alone when two lines share its tuple but carry different keys', () => {
    const env = freshEnv();
    writeTranscript(env, 'p/a.jsonl', [assistantLine({ id: 'm1', req: 'r' }), assistantLine({ id: 'm2', req: 'r' })]);
    legacy(env, 'p/a.jsonl');
    const report = run(env, true);
    expect(report.rowsAmbiguous).toBe(1);
    expect(rows(env)[0].message_key).toBeNull();
  });

  it('builds the key id: when requestId is absent', () => {
    const env = freshEnv();
    writeTranscript(env, 'p/a.jsonl', [assistantLine({ id: 'm1' })]);
    legacy(env, 'p/a.jsonl');
    run(env, true);
    expect(rows(env)[0].message_key).toBe('m1:');
  });

  it('ignores a final unterminated line and decodes a multi-byte character split across a chunk boundary', () => {
    const env = freshEnv();
    // The reader uses 1 MiB chunks: place the first byte of a 3-byte character one byte before the boundary.
    const build = (n: number) => assistantLine({ id: 'm1', req: 'r', model: 'a'.repeat(n) + '€' });
    const probe = build(10);
    const n = 10 + (1024 * 1024 - 1 - Buffer.from(probe).indexOf(Buffer.from('€')));
    const first = build(n);
    expect(Buffer.from(first).indexOf(Buffer.from('€'))).toBe(1024 * 1024 - 1);
    writeTranscript(env, 'p/a.jsonl', [first, assistantLine({ id: 'm2', req: 'r', out: 77 })], false);
    legacy(env, 'p/a.jsonl', { model: 'a'.repeat(n) + '€' });
    legacy(env, 'p/a.jsonl', { out: 77 });
    const report = run(env, true);
    expect(report.rowsToKey).toBe(1);
    expect(report.rowsNoMatch).toBe(1);
  });

  it('dry-run leaves every row unchanged and writes no marker', () => {
    const env = freshEnv();
    writeTranscript(env, 'p/a.jsonl', [assistantLine({ id: 'm1', req: 'r' })]);
    legacy(env, 'p/a.jsonl');
    legacy(env, 'p/a.jsonl');
    const before = JSON.stringify(rows(env));
    const report = run(env, false);
    expect(report.mode).toBe('dry-run');
    expect(report.rowsToDelete).toBe(1);
    expect(JSON.stringify(rows(env))).toBe(before);
    expect(env.db.prepare("SELECT 1 FROM schema_meta WHERE key = 'usage_backfill_v1'").get()).toBeUndefined();
  });

  it('dry-run on a read-only handle cannot write', () => {
    const env = freshEnv();
    env.db.close();
    const ro = openDryRunHandle(env.dbPath);
    expect(() => ro.exec('DELETE FROM usage_events')).toThrow();
    ro.close();
  });

  it('a second apply finds nothing to do and keeps the marker as first written', () => {
    const env = freshEnv();
    writeTranscript(env, 'p/a.jsonl', [assistantLine({ id: 'm1', req: 'r' })]);
    legacy(env, 'p/a.jsonl');
    legacy(env, 'p/a.jsonl');
    run(env, true);
    const marker = env.db.prepare("SELECT value FROM schema_meta WHERE key = 'usage_backfill_v1'").get() as { value: string };
    expect(JSON.parse(marker.value)).toMatchObject({ rowsToKey: 1, rowsToDelete: 1, rowsUnrecoverable: 0, unrecoverableMaxMs: null });
    const after1 = JSON.stringify(rows(env));
    const second = run(env, true);
    expect(second.rowsMatched).toBe(0);
    expect(JSON.stringify(rows(env))).toBe(after1);
    expect((env.db.prepare("SELECT value FROM schema_meta WHERE key = 'usage_backfill_v1'").get() as { value: string }).value).toBe(marker.value);
  });

  it('every legacy row lands in exactly one bucket on a mixed fixture', () => {
    const env = freshEnv();
    writeTranscript(env, 'p/a.jsonl', [
      assistantLine({ id: 'm1', req: 'r' }),
      assistantLine({ id: null, out: 6 }),
      assistantLine({ id: 'm2', req: 'r', out: 7 }),
      assistantLine({ id: 'm3', req: 'r', out: 7 }),
    ]);
    legacy(env, 'p/a.jsonl');
    legacy(env, 'p/a.jsonl');
    legacy(env, 'p/a.jsonl', { out: 6 });
    legacy(env, 'p/a.jsonl', { out: 7 });
    legacy(env, 'p/a.jsonl', { out: 8 });
    legacy(env, 'gone.jsonl');
    legacy(env, null);
    const report = run(env, false);
    expect(report.legacyRows).toBe(6);
    expect(report.legacyRowsNoSource).toBe(1);
    expect(bucketSum(report)).toBe(report.legacyRows);
    expect([report.rowsMatched, report.rowsKeyless, report.rowsAmbiguous, report.rowsNoMatch, report.rowsUnrecoverable]).toEqual([2, 1, 1, 1, 1]);
  });

  it('reports usage-differs keys with the output delta and keeps the first row unchanged', () => {
    const env = freshEnv();
    writeTranscript(env, 'p/a.jsonl', [
      assistantLine({ id: 'm1', req: 'r', out: 5 }),
      assistantLine({ id: 'm1', req: 'r', out: 12 }),
    ]);
    legacy(env, 'p/a.jsonl', { out: 5 });
    legacy(env, 'p/a.jsonl', { out: 12 });
    const report = run(env, true);
    expect(report.keysUsageDiffers).toBe(1);
    expect(report.keysUsageDiffersOutputDelta).toBe(7);
    expect(rows(env)[0].output_tokens).toBe(5);
  });

  it('reports totalTokensAfter equal to an independent SUM after apply', () => {
    const env = freshEnv();
    writeTranscript(env, 'p/a.jsonl', [assistantLine({ id: 'm1', req: 'r' })]);
    legacy(env, 'p/a.jsonl');
    legacy(env, 'p/a.jsonl');
    legacy(env, 'gone.jsonl');
    const report = run(env, true);
    const sum = env.db
      .prepare('SELECT SUM(input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens) AS s FROM usage_events')
      .get() as { s: number };
    expect(report.totalTokensBefore).toBe(45);
    expect(report.totalTokensAfter).toBe(sum.s);
  });

  it('throws DbChangedError and writes nothing when a row appears between snapshot and lock', () => {
    const env = freshEnv();
    writeTranscript(env, 'p/a.jsonl', [assistantLine({ id: 'm1', req: 'r' })]);
    legacy(env, 'p/a.jsonl');
    legacy(env, 'p/a.jsonl');
    const before = JSON.stringify(rows(env));
    let injected = 0;
    expect(() =>
      run(env, true, {
        beforeLock: () => {
          injected = keyed(env, 'other:r');
        },
      })
    ).toThrow(DbChangedError);
    expect(JSON.stringify(rows(env).filter((r) => r.id !== injected))).toBe(before);
    expect(rows(env)).toHaveLength(3);
  });

  it('throws AssertionError and rolls back when an extra row is deleted inside the transaction', () => {
    const env = freshEnv();
    writeTranscript(env, 'p/a.jsonl', [assistantLine({ id: 'm1', req: 'r' })]);
    legacy(env, 'p/a.jsonl');
    legacy(env, 'p/a.jsonl');
    const extra = legacy(env, 'gone.jsonl');
    const before = JSON.stringify(rows(env));
    expect(() =>
      run(env, true, { afterWrites: (db) => db.prepare('DELETE FROM usage_events WHERE id = ?').run(extra) })
    ).toThrow(AssertionError);
    expect(JSON.stringify(rows(env))).toBe(before);
    expect(env.db.prepare("SELECT 1 FROM schema_meta WHERE key = 'usage_backfill_v1'").get()).toBeUndefined();
  });
});

describe('isInsideRoot', () => {
  it('requires a separator boundary and excludes the root itself', () => {
    expect(isInsideRoot('C:\\x\\projects', 'C:\\x\\projects\\a.jsonl', 'win32')).toBe(true);
    expect(isInsideRoot('C:\\x\\projects', 'C:\\x\\projects-evil\\a.jsonl', 'win32')).toBe(false);
    expect(isInsideRoot('C:\\x\\projects', 'C:\\x\\projects', 'win32')).toBe(false);
    expect(isInsideRoot('C:\\x\\projects\\', 'C:\\x\\projects\\a.jsonl', 'win32')).toBe(true);
    expect(isInsideRoot('/x/projects', '/x/projects-evil/a.jsonl', 'linux')).toBe(false);
  });

  it('is case-insensitive on win32 and case-sensitive on linux', () => {
    expect(isInsideRoot('C:\\X\\Projects', 'c:\\x\\projects\\a.jsonl', 'win32')).toBe(true);
    expect(isInsideRoot('/x/Projects', '/x/projects/a.jsonl', 'linux')).toBe(false);
    expect(isInsideRoot('/x/projects', '/x/projects/a.jsonl', 'linux')).toBe(true);
  });
});
