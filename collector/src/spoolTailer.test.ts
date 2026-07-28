import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema.js';
import { tailSpoolOnce } from './spoolTailer.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-tailer-db-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return db;
}

function freshSpoolDir(): string {
  return mkdtempSync(join(tmpdir(), 'aether-collector-tailer-spool-'));
}

describe('tailSpoolOnce', () => {
  it('ingests every line in every .jsonl file and deletes each file after processing', () => {
    const db = freshDb();
    const spoolDir = freshSpoolDir();
    const line1 = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash' });
    const line2 = JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' });
    const file1 = join(spoolDir, 's1.jsonl');
    writeFileSync(file1, `${line1}\n${line2}\n`, 'utf8');

    const result = tailSpoolOnce(db, spoolDir, 1000);
    expect(result).toEqual({ filesProcessed: 1, linesIngested: 2 });
    expect(existsSync(file1)).toBe(false);

    const count: any = db.prepare('SELECT COUNT(*) as c FROM events').get();
    expect(count.c).toBe(2);
    db.close();
  });

  it('ignores non-.jsonl files in the spool directory', () => {
    const db = freshDb();
    const spoolDir = freshSpoolDir();
    writeFileSync(join(spoolDir, 'notes.txt'), 'irrelevant', 'utf8');

    const result = tailSpoolOnce(db, spoolDir, 1000);
    expect(result).toEqual({ filesProcessed: 0, linesIngested: 0 });
    expect(existsSync(join(spoolDir, 'notes.txt'))).toBe(true);
    db.close();
  });

  it('returns zero counts and does not throw when the spool directory does not exist', () => {
    const db = freshDb();
    const missingDir = join(tmpdir(), 'aether-collector-does-not-exist-' + Date.now());
    expect(() => tailSpoolOnce(db, missingDir, 1000)).not.toThrow();
    expect(tailSpoolOnce(db, missingDir, 1000)).toEqual({ filesProcessed: 0, linesIngested: 0 });
    db.close();
  });

  it('skips blank lines within a file without counting them as ingested', () => {
    const db = freshDb();
    const spoolDir = freshSpoolDir();
    const line = JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' });
    writeFileSync(join(spoolDir, 's1.jsonl'), `\n${line}\n\n`, 'utf8');

    const result = tailSpoolOnce(db, spoolDir, 1000);
    expect(result.linesIngested).toBe(1);
    db.close();
  });

  it('processes multiple spool files in one pass', () => {
    const db = freshDb();
    const spoolDir = freshSpoolDir();
    writeFileSync(join(spoolDir, 's1.jsonl'), JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }) + '\n', 'utf8');
    writeFileSync(join(spoolDir, 's2.jsonl'), JSON.stringify({ hook_event_name: 'Stop', session_id: 's2' }) + '\n', 'utf8');

    const result = tailSpoolOnce(db, spoolDir, 1000);
    expect(result).toEqual({ filesProcessed: 2, linesIngested: 2 });
    db.close();
  });
});
