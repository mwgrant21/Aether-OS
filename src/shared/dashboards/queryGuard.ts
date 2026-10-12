/**
 * Defense in depth for Boards queries. The primary guard is the read-only
 * connection (electron/dashboards/runQuery.ts opens collector.db with
 * readOnly: true); this module keeps a write from ever reaching SQLite and
 * gives Claude an error that names the rule.
 */
export const RENDER_ROW_CAP = 1000;
export const TOOL_ROW_CAP = 200;

export type GuardResult = { ok: true; sql: string; usesSince: boolean } | { ok: false; reason: string };

const FORBIDDEN =
  /\b(ATTACH|DETACH|PRAGMA|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|VACUUM|REINDEX|SAVEPOINT|RELEASE|BEGIN|COMMIT|ROLLBACK|LOAD_EXTENSION)\b|\bREPLACE\s+INTO\b/i;

/**
 * Path or path-bearing columns never leave the app through Boards: query results
 * reach the model conversation, and paths are the store's remaining sensitive
 * surface (docs/privacy-and-data.md). `detail` carries file paths in anomaly
 * text. Matched against `code` (quoted identifiers kept), so quoting a name does
 * not get past it; a string literal containing one of these names is also
 * refused, which is an acceptable false positive.
 */
export const BLOCKED_COLUMNS = ['file_path_rel', 'project_rel_path', 'file_path', 'source_file_rel', 'detail'] as const;

// Select-star is banned in every table: a collector update can add a path
// column anywhere, and a star would return it without the query naming it.
const SELECT_STAR = /(\bSELECT|\bDISTINCT|\bALL|,|\.)\s*\*/i;

interface Scanned { code: string; skeleton: string; unterminated: boolean }

/**
 * `code` is the SQL with comments replaced by a space (literals kept), safe to
 * wrap. `skeleton` additionally blanks literal and quoted-identifier contents,
 * so keyword and `;` checks never see text inside them. Both stay the same
 * length outside comments, so trimming them in step is safe.
 */
function scan(sql: string): Scanned {
  let code = '';
  let skeleton = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      code += ' ';
      skeleton += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return { code, skeleton, unterminated: true };
      i = end + 2;
      code += ' ';
      skeleton += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) return { code, skeleton, unterminated: true };
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) { j += 2; continue; }
          break;
        }
        j++;
      }
      code += sql.slice(i, j + 1);
      skeleton += c + ' '.repeat(j - i - 1) + close;
      i = j + 1;
      continue;
    }
    code += c;
    skeleton += c;
    i++;
  }
  return { code, skeleton, unterminated: false };
}

export function guardQuery(sql: string, rowCap: number): GuardResult {
  if (typeof sql !== 'string' || sql.trim() === '') return { ok: false, reason: 'Query is empty.' };
  const scanned = scan(sql);
  if (scanned.unterminated) {
    return { ok: false, reason: 'Query has an unterminated string, identifier or comment.' };
  }
  let code = scanned.code.trim();
  let skeleton = scanned.skeleton.trim();
  if (skeleton.endsWith(';')) {
    skeleton = skeleton.slice(0, -1).trim();
    code = code.slice(0, -1).trim();
  }
  if (skeleton.includes(';')) return { ok: false, reason: 'Only one statement is allowed.' };
  if (!/^(SELECT|WITH)\b/i.test(skeleton)) {
    return { ok: false, reason: 'Only SELECT or WITH … SELECT queries are allowed.' };
  }
  const bad = FORBIDDEN.exec(skeleton);
  if (bad) return { ok: false, reason: `"${bad[0].toUpperCase()}" is not allowed in a Boards query.` };
  const lowerCode = code.toLowerCase();
  const blocked = BLOCKED_COLUMNS.find((c) => lowerCode.includes(c));
  if (blocked) return { ok: false, reason: `Path column ${blocked} is blocked in Boards: paths stay out of model conversations.` };
  if (SELECT_STAR.test(skeleton)) {
    return { ok: false, reason: 'Name the columns you need: "*" is not allowed in Boards queries (COUNT(*) is), because new columns, including path columns, can appear in any table.' };
  }
  return { ok: true, sql: `SELECT * FROM (${code}) LIMIT ${rowCap + 1}`, usesSince: /:since\b/.test(skeleton) };
}
