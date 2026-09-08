import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema.js';
import { tailSpoolOnce, startSpoolTailer } from './spoolTailer.js';

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
    expect(result).toEqual({ filesProcessed: 1, linesIngested: 2, filesRetained: 0 });
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
    expect(result).toEqual({ filesProcessed: 0, linesIngested: 0, filesRetained: 0 });
    expect(existsSync(join(spoolDir, 'notes.txt'))).toBe(true);
    db.close();
  });

  it('returns zero counts and does not throw when the spool directory does not exist', () => {
    const db = freshDb();
    const missingDir = join(tmpdir(), 'aether-collector-does-not-exist-' + Date.now());
    expect(() => tailSpoolOnce(db, missingDir, 1000)).not.toThrow();
    expect(tailSpoolOnce(db, missingDir, 1000)).toEqual({ filesProcessed: 0, linesIngested: 0, filesRetained: 0 });
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

  it('keeps the spool file and writes nothing when any line fails to insert, then ingests it whole once the failure clears', () => {
    const db = freshDb();
    const spoolDir = freshSpoolDir();
    // Stand-in for SQLITE_BUSY / disk full / schema drift: make one specific
    // insert fail so the test can prove the whole file is rolled back, not
    // just the failing line.
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON events WHEN NEW.tool_name = 'BOOM' BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    const ok = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash' });
    const bad = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'BOOM' });
    const file = join(spoolDir, 's1.jsonl');
    writeFileSync(file, `${ok}\n${bad}\n${ok}\n`, 'utf8');

    const first = tailSpoolOnce(db, spoolDir, 1000);
    expect(first).toEqual({ filesProcessed: 0, linesIngested: 0, filesRetained: 1 });
    expect(existsSync(file)).toBe(true);
    const afterFailure: any = db.prepare('SELECT COUNT(*) as c FROM events').get();
    expect(afterFailure.c).toBe(0);

    db.exec('DROP TRIGGER boom');
    const second = tailSpoolOnce(db, spoolDir, 2000);
    expect(second).toEqual({ filesProcessed: 1, linesIngested: 3, filesRetained: 0 });
    expect(existsSync(file)).toBe(false);
    const afterRetry: any = db.prepare('SELECT COUNT(*) as c FROM events').get();
    expect(afterRetry.c).toBe(3);
    db.close();
  });

  it('skips a malformed line, ingests the rest, and still deletes the file', () => {
    const db = freshDb();
    const spoolDir = freshSpoolDir();
    const ok = JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' });
    const file = join(spoolDir, 's1.jsonl');
    writeFileSync(file, `${ok}\n{not json\n${ok}\n`, 'utf8');

    const result = tailSpoolOnce(db, spoolDir, 1000);
    expect(result).toEqual({ filesProcessed: 1, linesIngested: 2, filesRetained: 0 });
    expect(existsSync(file)).toBe(false);
    db.close();
  });

  it('processes multiple spool files in one pass', () => {
    const db = freshDb();
    const spoolDir = freshSpoolDir();
    writeFileSync(join(spoolDir, 's1.jsonl'), JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }) + '\n', 'utf8');
    writeFileSync(join(spoolDir, 's2.jsonl'), JSON.stringify({ hook_event_name: 'Stop', session_id: 's2' }) + '\n', 'utf8');

    const result = tailSpoolOnce(db, spoolDir, 1000);
    expect(result).toEqual({ filesProcessed: 2, linesIngested: 2, filesRetained: 0 });
    db.close();
  });
});

// Added 2026-09-07 after a Stryker run (collector, run 2: 81.8% on this file).
describe('tailSpoolOnce / startSpoolTailer: unreadable entries, retention log, stop function', () => {
  it('skips an unreadable .jsonl entry (a directory) without throwing and leaves it in place', () => {
    const db = freshDb();
    const spoolDir = freshSpoolDir();
    const dirEntry = join(spoolDir, 'weird.jsonl');
    mkdirSync(dirEntry);
    const good = join(spoolDir, 's1.jsonl');
    writeFileSync(good, JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }) + '\n', 'utf8');

    let result: ReturnType<typeof tailSpoolOnce> | undefined;
    expect(() => {
      result = tailSpoolOnce(db, spoolDir, 1000);
    }).not.toThrow();
    expect(result).toEqual({ filesProcessed: 1, linesIngested: 1, filesRetained: 0 });
    expect(existsSync(dirEntry)).toBe(true);
    expect(existsSync(good)).toBe(false);
    db.close();
  });

  it('logs one line naming the retained file and its event count when the write is refused', () => {
    const db = freshDb();
    const spoolDir = freshSpoolDir();
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON events WHEN NEW.tool_name = 'BOOM' BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    const ok = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash' });
    const bad = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'BOOM' });
    writeFileSync(join(spoolDir, 'keepme.jsonl'), `${ok}\n${bad}\n`, 'utf8');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      tailSpoolOnce(db, spoolDir, 1000);
      expect(errSpy).toHaveBeenCalledTimes(1);
      const line = String(errSpy.mock.calls[0][0]);
      expect(line).toContain('keepme.jsonl');
      expect(line).toContain('2 event(s)');
      expect(line).toContain('boom');
    } finally {
      errSpy.mockRestore();
      db.close();
    }
  });

  it('startSpoolTailer polls on the interval and the returned stop function ends polling', () => {
    vi.useFakeTimers();
    const db = freshDb();
    const spoolDir = freshSpoolDir();
    const count = () => (db.prepare('SELECT COUNT(*) as c FROM events').get() as any).c;
    try {
      const stop = startSpoolTailer(db, spoolDir, 100);
      writeFileSync(join(spoolDir, 'a.jsonl'), JSON.stringify({ hook_event_name: 'Stop', session_id: 'a' }) + '\n', 'utf8');
      expect(count()).toBe(0);
      vi.advanceTimersByTime(100);
      expect(count()).toBe(1);

      stop();
      writeFileSync(join(spoolDir, 'b.jsonl'), JSON.stringify({ hook_event_name: 'Stop', session_id: 'b' }) + '\n', 'utf8');
      vi.advanceTimersByTime(1000);
      expect(count()).toBe(1);
      expect(existsSync(join(spoolDir, 'b.jsonl'))).toBe(true);
    } finally {
      vi.useRealTimers();
      db.close();
    }
  });
});
