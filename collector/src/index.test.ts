import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startCollector, pollAndUpsertFleet } from './index.js';
import { openDatabase, migrate } from './schema.js';

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

    const projectsRoot = join(dir, 'projects');
    mkdirSync(projectsRoot, { recursive: true });
    const stop = startCollector({
      dbPath,
      spoolDir,
      tailIntervalMs: 20,
      compactIntervalMs: 100000,
      projectsRoot,
      transcriptScanIntervalMs: 100000,
      ownSessionFilePath: join(dir, 'own-session.json'),
      fleetPollIntervalMs: 100000,
    });
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the first tick fire

    expect(existsSync(dbPath)).toBe(true);
    const db = openDatabase(dbPath);
    const count: any = db.prepare('SELECT COUNT(*) as c FROM events').get();
    expect(count.c).toBe(1);
    db.close();
    stop();
  });
});

describe('pollAndUpsertFleet', () => {
  function freshDb() {
    const dir = mkdtempSync(join(tmpdir(), 'aether-collector-fleetheartbeat-'));
    const db = openDatabase(join(dir, 'test.db'));
    migrate(db);
    return { db, dir };
  }

  it('stamps fleet_last_poll_ms in schema_meta after a successful poll', async () => {
    const { db, dir } = freshDb();
    await pollAndUpsertFleet(db, join(dir, 'own-session.json'), async () => ({ stdout: '[]' }));

    const row: any = db.prepare("SELECT value FROM schema_meta WHERE key = 'fleet_last_poll_ms'").get();
    expect(row).toBeDefined();
    expect(Number(row.value)).toBeGreaterThan(0);
    db.close();
  });

  it('stamps fleet_last_poll_ms even when the poll fails (e.g. claude missing from PATH)', async () => {
    const { db, dir } = freshDb();
    await pollAndUpsertFleet(db, join(dir, 'own-session.json'), async () => {
      throw new Error('spawn claude ENOENT');
    });

    const row: any = db.prepare("SELECT value FROM schema_meta WHERE key = 'fleet_last_poll_ms'").get();
    expect(row).toBeDefined();
    // The poll itself failed, so fleet_sessions should have been pruned to
    // empty via the unconditional upsertFleetSessions(db, [], nowMs) call --
    // confirms the heartbeat write didn't skip or short-circuit that path.
    const count: any = db.prepare('SELECT COUNT(*) as c FROM fleet_sessions').get();
    expect(count.c).toBe(0);
    db.close();
  });

  it('updates fleet_last_poll_ms on each successive call rather than accumulating rows', async () => {
    const { db, dir } = freshDb();
    const ownSessionFilePath = join(dir, 'own-session.json');
    await pollAndUpsertFleet(db, ownSessionFilePath, async () => ({ stdout: '[]' }));
    const first: any = db.prepare("SELECT value FROM schema_meta WHERE key = 'fleet_last_poll_ms'").get();

    await new Promise((resolve) => setTimeout(resolve, 5));
    await pollAndUpsertFleet(db, ownSessionFilePath, async () => ({ stdout: '[]' }));
    const second: any = db.prepare("SELECT value FROM schema_meta WHERE key = 'fleet_last_poll_ms'").get();

    expect(Number(second.value)).toBeGreaterThanOrEqual(Number(first.value));
    const count: any = db
      .prepare("SELECT COUNT(*) as c FROM schema_meta WHERE key = 'fleet_last_poll_ms'")
      .get();
    expect(count.c).toBe(1);
    db.close();
  });
});
