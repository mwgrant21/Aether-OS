import { describe, expect, it } from 'vitest';
import { guardQuery } from './queryGuard';

describe('guardQuery', () => {
  it.each([
    ['plain select', 'SELECT 1 AS a'],
    ['with cte', 'WITH t AS (SELECT 1 AS a) SELECT a FROM t'],
    ['one trailing semicolon', 'SELECT 1;'],
    ['lowercase', 'select model from usage_events'],
    ['keyword inside string literal', "SELECT 'DROP TABLE x; DELETE' AS s"],
    ['semicolon inside string literal', "SELECT ';' AS s"],
    ['escaped quote in literal', "SELECT 'it''s' AS s"],
    ['replace() function', "SELECT replace(model, '-', ' ') AS m FROM usage_events"],
    ['pragma table-valued function', "SELECT name FROM pragma_table_info('usage_events')"],
  ])('accepts %s', (_name, sql) => {
    expect(guardQuery(sql, 10).ok).toBe(true);
  });

  it.each([
    ['empty', '   ', 'empty'],
    ['two statements', 'SELECT 1; SELECT 2', 'one statement'],
    ['statement hidden after comment', 'SELECT 1 /* x */; DROP TABLE usage_events', 'one statement'],
    ['attach', "ATTACH DATABASE 'x.db' AS x", 'SELECT or WITH'],
    ['attach inside select', "SELECT 1 FROM (SELECT 1) WHERE 1 = (ATTACH 'x' AS y)", 'ATTACH'],
    ['pragma', 'PRAGMA journal_mode', 'SELECT or WITH'],
    ['insert', 'INSERT INTO usage_events DEFAULT VALUES', 'SELECT or WITH'],
    ['with then insert', 'WITH t AS (SELECT 1) INSERT INTO x SELECT * FROM t', 'INSERT'],
    ['with then delete', 'WITH t AS (SELECT 1) DELETE FROM usage_events', 'DELETE'],
    ['replace into', 'WITH t AS (SELECT 1) REPLACE INTO x SELECT * FROM t', 'REPLACE INTO'],
    ['load_extension', "SELECT load_extension('evil')", 'LOAD_EXTENSION'],
    ['unterminated string', "SELECT 'abc", 'unterminated'],
    ['unterminated block comment', 'SELECT 1 /* never closed', 'unterminated'],
  ])('rejects %s', (_name, sql, reasonPart) => {
    const r = guardQuery(sql, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.toLowerCase()).toContain(reasonPart.toLowerCase());
  });

  it.each([
    ['a path column by name', 'SELECT file_path_rel FROM tool_calls', 'file_path_rel'],
    ['a quoted path column', 'SELECT "project_rel_path" FROM events', 'project_rel_path'],
    ['the transcript path', 'SELECT file_path FROM transcript_files', 'file_path'],
    ['star on a path table', 'SELECT * FROM tool_calls', 'name the columns'],
    ['qualified star on a quoted path table', 'SELECT t.* FROM "tool_calls" t', 'name the columns'],
    ['star hidden in a CTE', 'WITH t AS (SELECT * FROM tool_calls) SELECT tool_name FROM t', 'name the columns'],
  ])('blocks %s', (_name, sql, reasonPart) => {
    const r = guardQuery(sql, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.toLowerCase()).toContain(reasonPart.toLowerCase());
  });

  it.each([
    ['COUNT(*) on a path table', 'SELECT COUNT(*) AS n FROM tool_calls'],
    ['named non-path columns', 'SELECT tool_name, started_at_ms FROM tool_calls'],
    ['star on a table with no path column', 'SELECT * FROM usage_events'],
    ['multiplication on usage_events', 'SELECT SUM(cache_read_input_tokens) * 1.0 AS r FROM usage_events'],
  ])('still accepts %s', (_name, sql) => {
    expect(guardQuery(sql, 10).ok).toBe(true);
  });

  it('wraps with LIMIT rowCap+1 so truncation is detectable', () => {
    const r = guardQuery('SELECT 1 AS a', 10);
    expect(r).toEqual({ ok: true, sql: 'SELECT * FROM (SELECT 1 AS a) LIMIT 11', usesSince: false });
  });

  it('a trailing line comment cannot comment out the wrapper', () => {
    const r = guardQuery('SELECT 1 AS a -- note', 10);
    expect(r.ok && r.sql.endsWith(') LIMIT 11')).toBe(true);
    expect(r.ok && r.sql.includes('--')).toBe(false);
  });

  it('detects :since outside literals only', () => {
    const uses = guardQuery('SELECT 1 FROM usage_events WHERE occurred_at_ms >= :since', 10);
    const literal = guardQuery("SELECT ':since' AS s", 10);
    expect(uses.ok && uses.usesSince).toBe(true);
    expect(literal.ok && literal.usesSince).toBe(false);
  });
});
