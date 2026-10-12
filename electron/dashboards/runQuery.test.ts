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
