import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startCollector, pollAndUpsertFleet } from './index.js';
import { openDatabase, migrate } from './schema.js';
import { compact } from './retention.js';
import { scanTranscriptsOnce } from './transcriptScan.js';

// Pass-through spies: every test behaves as before unless it queues a one-off throw.
vi.mock('./retention.js', async (orig) => {
  const real = await orig<typeof import('./retention.js')>();
  return { ...real, compact: vi.fn(real.compact) };
});
vi.mock('./transcriptScan.js', async (orig) => {
  const real = await orig<typeof import('./transcriptScan.js')>();
  return { ...real, scanTranscriptsOnce: vi.fn(real.scanTranscriptsOnce) };
});

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
      memoryDbPath: join(dir, 'memory.db'),
      memoryExtractIntervalMs: 100000,
      collectorSettingsPath: join(dir, 'collector-settings.json'),
    });
    await new Promise((resolve) => setTimeout(resolve, 100)); // let the first tick fire

    expect(existsSync(dbPath)).toBe(true);
    const db = openDatabase(dbPath);
    const count: any = db.prepare('SELECT COUNT(*) as c FROM events').get();
    expect(count.c).toBe(1);
    db.close();
    stop();
  });

  it('does not create memory.db at startup, and stop() is safe when the store was never opened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aether-collector-index-mem-'));
    const stop = startCollector({
      dbPath: join(dir, 'collector.db'),
      spoolDir: join(dir, 'spool'),
      tailIntervalMs: 1_000_000, // effectively never fires during this test
      compactIntervalMs: 1_000_000,
      projectsRoot: join(dir, 'projects'),
      transcriptScanIntervalMs: 1_000_000,
      ownSessionFilePath: join(dir, 'own-session.json'),
      fleetPollIntervalMs: 1_000_000,
      memoryDbPath: join(dir, 'memory.db'),
      memoryExtractIntervalMs: 1_000_000,
      collectorSettingsPath: join(dir, 'collector-settings.json'),
    });

    expect(existsSync(join(dir, 'memory.db'))).toBe(false);
    expect(() => stop()).not.toThrow();
    // A second start against the same path must succeed (proves stop() actually
    // closed the file handle rather than leaking it).
    const stop2 = startCollector({
      dbPath: join(dir, 'collector.db'),
      spoolDir: join(dir, 'spool'),
      tailIntervalMs: 1_000_000,
      compactIntervalMs: 1_000_000,
      projectsRoot: join(dir, 'projects'),
      transcriptScanIntervalMs: 1_000_000,
      ownSessionFilePath: join(dir, 'own-session.json'),
      fleetPollIntervalMs: 1_000_000,
      memoryDbPath: join(dir, 'memory.db'),
      memoryExtractIntervalMs: 1_000_000,
      collectorSettingsPath: join(dir, 'collector-settings.json'),
    });
    expect(() => stop2()).not.toThrow();
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

describe('startCollector -- pinned session reaches the stale-dispatch sweep', () => {
  function runInitialScan(pin: string | null): number {
    const dir = mkdtempSync(join(tmpdir(), 'aether-collector-index-pin-'));
    const projectsRoot = join(dir, 'projects');
    mkdirSync(join(projectsRoot, 'proj'), { recursive: true });
    const ownSessionFilePath = join(dir, 'own-session.json');
    if (pin !== null) writeFileSync(ownSessionFilePath, JSON.stringify({ sessionId: pin, updatedAtMs: 1 }), 'utf8');
    writeFileSync(
      join(projectsRoot, 'proj', 's1.jsonl'),
      JSON.stringify({
        type: 'assistant',
        sessionId: 's1',
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        message: { model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id: 'tu_pin', name: 'Agent', input: {} }] },
      }) + '\n',
      'utf8'
    );
    // The transcript has been silent for 60 s (a session with no fleet row is only
    // swept once its transcript mtime is older than 30 s).
    const silent = new Date(Date.now() - 60_000);
    utimesSync(join(projectsRoot, 'proj', 's1.jsonl'), silent, silent);
    const dbPath = join(dir, 'collector.db');
    const stop = startCollector({
      dbPath,
      spoolDir: join(dir, 'spool'),
      tailIntervalMs: 1_000_000,
      compactIntervalMs: 1_000_000,
      projectsRoot,
      transcriptScanIntervalMs: 1_000_000,
      ownSessionFilePath,
      fleetPollIntervalMs: 1_000_000,
      memoryDbPath: join(dir, 'memory.db'),
      memoryExtractIntervalMs: 1_000_000,
      collectorSettingsPath: join(dir, 'collector-settings.json'),
    });
    const db = openDatabase(dbPath);
    const c: any = db.prepare('SELECT COUNT(*) AS c FROM dispatches').get();
    db.close();
    stop();
    return c.c;
  }

  it('the initial scan does not fatal an open dispatch from the session named in own-session.json', () => {
    expect(runInitialScan('s1')).toBe(0);
  });

  it('with no own-session.json the same dispatch is swept as fatal (behaviour unchanged)', () => {
    expect(runInitialScan(null)).toBe(1);
  });
});

describe('startCollector interval guards', () => {
  function startWithTick(which: 'compact' | 'scan') {
    const dir = mkdtempSync(join(tmpdir(), 'aether-collector-guard-'));
    return startCollector({
      dbPath: join(dir, 'collector.db'),
      spoolDir: join(dir, 'spool'),
      tailIntervalMs: 1_000_000,
      compactIntervalMs: which === 'compact' ? 1000 : 1_000_000,
      projectsRoot: join(dir, 'projects'),
      transcriptScanIntervalMs: which === 'scan' ? 1000 : 1_000_000,
      ownSessionFilePath: join(dir, 'own-session.json'),
      fleetPollIntervalMs: 1_000_000,
      memoryDbPath: join(dir, 'memory.db'),
      memoryExtractIntervalMs: 1_000_000,
      collectorSettingsPath: join(dir, 'collector-settings.json'),
    });
  }

  it('a compaction tick that throws is logged and does not escape the interval', () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = vi.mocked(compact).mock.calls.length;
    const stop = startWithTick('compact');
    try {
      vi.mocked(compact).mockImplementationOnce(() => {
        throw new Error('C:\\Users\\x\\secret.db locked');
      });
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('compaction failed');
      expect(logged).not.toContain('secret.db');
      vi.advanceTimersByTime(1000);
      expect(vi.mocked(compact).mock.calls.length - before).toBe(2);
    } finally {
      stop();
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a transcript scan tick that throws is logged and does not escape the interval', () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const zero = { filesScanned: 0, eventsIngested: 0, toolCallsIngested: 0, anomaliesIngested: 0 };
    vi.mocked(scanTranscriptsOnce)
      .mockImplementationOnce(() => zero as ReturnType<typeof scanTranscriptsOnce>) // initial scan at startup
      .mockImplementationOnce(() => {
        throw new Error('C:\\Users\\x\\secret.jsonl unreadable');
      });
    const before = vi.mocked(scanTranscriptsOnce).mock.calls.length;
    const stop = startWithTick('scan');
    try {
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('transcript scan failed');
      expect(logged).not.toContain('secret.jsonl');
      vi.advanceTimersByTime(1000);
      expect(vi.mocked(scanTranscriptsOnce).mock.calls.length - before).toBe(3);
    } finally {
      stop();
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a throw in the initial transcript scan is logged and startCollector still returns a stop handle', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(scanTranscriptsOnce).mockImplementationOnce(() => {
      throw new Error('C:\\Users\\x\\secret.jsonl unreadable');
    });
    let stop: (() => void) | undefined;
    try {
      expect(() => {
        stop = startWithTick('scan');
      }).not.toThrow();
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('transcript scan failed');
      expect(logged).not.toContain('secret.jsonl');
      expect(typeof stop).toBe('function');
    } finally {
      stop?.();
      errSpy.mockRestore();
    }
  });
});
