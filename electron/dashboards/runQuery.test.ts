// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixtureCollectorDb } from './collectorDb.fixture';
import { MAX_CONCURRENT_QUERIES, MAX_QUERY_OUTPUT_BYTES, executeIsolated, runQuery, scrubPath } from './runQuery';

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
    let pid = 0;
    const r = await runQuery({ dbPath, sql: slow, since: 0, rowCap: 10, timeoutMs: 300, onSpawn: (p) => { pid = p; } });
    expect(r).toMatchObject({ ok: false, kind: 'timeout' });
    expect(pid).toBeGreaterThan(0);
    // The process must really be gone, not just abandoned.
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 50)); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  });

  it('never runs more than MAX_CONCURRENT_QUERIES query processes at once', async () => {
    const dbPath = createFixtureCollectorDb(now);
    const work = 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 2000000) SELECT MAX(i) AS m FROM c';
    const pids: number[] = [];
    let maxAlive = 0;
    const onSpawn = (pid: number) => {
      pids.push(pid);
      const alive = pids.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } }).length;
      maxAlive = Math.max(maxAlive, alive);
    };
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      runQuery({ dbPath, sql: work, since: 0, rowCap: 10, timeoutMs: 20000, onSpawn })));
    expect(results.every((r) => r.ok && r.rows[0].m === 2000000)).toBe(true);
    expect(pids.length).toBe(5);
    expect(maxAlive).toBeLessThanOrEqual(MAX_CONCURRENT_QUERIES);
  });

  it('scrubs the db path out of messages', () => {
    expect(scrubPath('unable to open /tmp/x/collector.db now', '/tmp/x/collector.db')).toBe('unable to open collector.db now');
  });

  it('caps the output a query process may produce', async () => {
    const dbPath = createFixtureCollectorDb(now);
    const r = await runQuery({ dbPath, sql: "SELECT printf('%.*c', 40000000, 'x') AS s", since: 0, rowCap: 10 });
    expect(MAX_QUERY_OUTPUT_BYTES).toBe(32 * 1024 * 1024);
    expect(r).toMatchObject({ ok: false, kind: 'sql', error: 'Query result is too large.' });
  });

  it.each([
    ['NATURAL FULL JOIN', 'SELECT tool_name FROM tool_calls NATURAL FULL JOIN tool_calls'],
    ['FULL JOIN USING', "WITH g(file_path_rel) AS (VALUES ('zz')) SELECT tool_name FROM g FULL JOIN tool_calls USING (file_path_rel)"],
  ])('guard and authorizer together refuse %s', async (_n, sql) => {
    const r = await runQuery({ dbPath: createFixtureCollectorDb(now), sql, since: 0, rowCap: 10 });
    expect(r.ok).toBe(false);
  });

  describe('authorizer (executeIsolated bypasses the text guard)', () => {
    const run = (sql: string) => executeIsolated(createFixtureCollectorDb(now), sql, null, 10, 5000, 5000);

    it('denies pragma table-valued functions other than pragma_table_info', async () => {
      expect((await run('SELECT file FROM "pragma_database_list"')).ok).toBe(false);
    });
    it('denies blocked columns even when quoted', async () => {
      expect((await run('SELECT file_path_rel FROM "tool_calls"')).ok).toBe(false);
    });
    it('denies blocked columns behind an alias', async () => {
      expect((await run('SELECT tool_name, file_path_rel AS x FROM tool_calls')).ok).toBe(false);
    });
    it('denies SELECT * over a table with a blocked column', async () => {
      expect((await run('SELECT * FROM tool_calls')).ok).toBe(false);
    });
    it('denies source_file_rel', async () => {
      expect((await run('SELECT source_file_rel FROM usage_events')).ok).toBe(false);
    });
    it('allows pragma_table_info', async () => {
      expect((await run("SELECT name FROM pragma_table_info('tool_calls')")).ok).toBe(true);
    });
    it('allows recursive CTEs', async () => {
      const r = await run('WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 3) SELECT i FROM c');
      expect(r.ok && r.rows.length).toBe(3);
    });
  });
});
