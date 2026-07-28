import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startCollector } from './index';
import { openDatabase } from './schema';

describe('startCollector', () => {
  it('picks up a pre-existing spool file, ingests it, and the DB file exists on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-collector-e2e-'));
    const spoolDir = join(dir, 'spool');
    const dbPath = join(dir, 'collector.db');
    mkdirSync(spoolDir, { recursive: true });
    writeFileSync(
      join(spoolDir, 's1.jsonl'),
      JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }) + '\n',
      'utf8'
    );

    const stop = startCollector({ dbPath, spoolDir, tailIntervalMs: 20, compactIntervalMs: 100000 });
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the first tick fire

    expect(existsSync(dbPath)).toBe(true);
    const db = openDatabase(dbPath);
    const count: any = db.prepare('SELECT COUNT(*) as c FROM events').get();
    expect(count.c).toBe(1);
    db.close();
    stop();
  });
});
