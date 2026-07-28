import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema';
import { checkForDrift } from './canary';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-canary-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return db;
}

describe('checkForDrift', () => {
  it('does not log drift for a well-formed PreToolUse payload', () => {
    const db = freshDb();
    checkForDrift(
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash' },
      db,
      1000
    );
    const rows = db.prepare('SELECT * FROM drift_log').all();
    expect(rows.length).toBe(0);
    db.close();
  });

  it('logs drift when a PreToolUse payload is missing tool_name', () => {
    const db = freshDb();
    checkForDrift({ hook_event_name: 'PreToolUse', session_id: 's1' }, db, 2000);
    const rows: any[] = db.prepare('SELECT * FROM drift_log').all();
    expect(rows.length).toBe(1);
    expect(rows[0].detected_at_ms).toBe(2000);
    expect(rows[0].detail).toContain('PreToolUse');
    expect(rows[0].detail).toContain('tool_name');
    db.close();
  });

  it('logs drift when a Notification payload is missing notification_type', () => {
    const db = freshDb();
    checkForDrift({ hook_event_name: 'Notification', session_id: 's1' }, db, 3000);
    const rows: any[] = db.prepare('SELECT * FROM drift_log').all();
    expect(rows.length).toBe(1);
    expect(rows[0].detail).toContain('notification_type');
    db.close();
  });

  it('does not throw and does not log drift for non-object or unrecognized-event input', () => {
    const db = freshDb();
    expect(() => checkForDrift(null, db, 4000)).not.toThrow();
    expect(() => checkForDrift('not an object', db, 4000)).not.toThrow();
    expect(() => checkForDrift({ hook_event_name: 'FutureEvent' }, db, 4000)).not.toThrow();
    const rows = db.prepare('SELECT * FROM drift_log').all();
    expect(rows.length).toBe(0);
    db.close();
  });
});
