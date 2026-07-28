import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema.js';
import { ingestLine } from './ingest.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-ingest-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return db;
}

describe('ingestLine', () => {
  it('inserts one events row for a valid PreToolUse line and returns true', () => {
    const db = freshDb();
    const line = JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      cwd: '/proj',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    const inserted = ingestLine(db, line, 1000);
    expect(inserted).toBe(true);
    const row: any = db.prepare('SELECT * FROM events').get();
    expect(row.tool_name).toBe('Bash');
    expect(row.had_tool_input).toBe(1);
    expect(JSON.stringify(row)).not.toContain('ls');
    db.close();
  });

  it('returns false and inserts nothing for malformed JSON', () => {
    const db = freshDb();
    const inserted = ingestLine(db, 'not json{{', 1000);
    expect(inserted).toBe(false);
    const count: any = db.prepare('SELECT COUNT(*) as c FROM events').get();
    expect(count.c).toBe(0);
    db.close();
  });

  it('returns false for a well-formed JSON line with an unrecognized hook_event_name', () => {
    const db = freshDb();
    const line = JSON.stringify({ hook_event_name: 'FutureEvent', session_id: 's1' });
    expect(ingestLine(db, line, 1000)).toBe(false);
    db.close();
  });

  it('logs drift for a known event missing a required field, but still returns false (not ingested)', () => {
    const db = freshDb();
    const line = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1' }); // no tool_name
    const inserted = ingestLine(db, line, 1000);
    expect(inserted).toBe(false);
    const drift: any = db.prepare('SELECT COUNT(*) as c FROM drift_log').get();
    expect(drift.c).toBe(1);
    db.close();
  });

  it('never throws on an empty string line', () => {
    const db = freshDb();
    expect(() => ingestLine(db, '', 1000)).not.toThrow();
    expect(ingestLine(db, '', 1000)).toBe(false);
    db.close();
  });
});
