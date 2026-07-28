import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, migrate } from './schema.js';
import { startSpoolTailer } from './spoolTailer.js';
import { compact } from './retention.js';
import { scanTranscriptsOnce } from './transcriptScan.js';
import { pollFleet, upsertFleetSessions } from './fleetPoll.js';
import { readOwnSessionId } from './ownSessionFile.js';

async function pollAndUpsertFleet(db: DatabaseSync, ownSessionFilePath: string): Promise<void> {
  const ownSessionId = readOwnSessionId(ownSessionFilePath);
  const nowMs = Date.now();
  const sessions = await pollFleet(db, ownSessionId, nowMs);
  upsertFleetSessions(db, sessions ?? [], nowMs);
}

export function startCollector(options: {
  dbPath: string;
  spoolDir: string;
  tailIntervalMs: number;
  compactIntervalMs: number;
  projectsRoot: string;
  transcriptScanIntervalMs: number;
  ownSessionFilePath: string;
  fleetPollIntervalMs: number;
}): () => void {
  const db = openDatabase(options.dbPath);
  migrate(db);

  const stopTailer = startSpoolTailer(db, options.spoolDir, options.tailIntervalMs);
  const compactTimer = setInterval(() => compact(db, Date.now()), options.compactIntervalMs);
  scanTranscriptsOnce(db, options.projectsRoot, Date.now());
  const transcriptScanTimer = setInterval(
    () => scanTranscriptsOnce(db, options.projectsRoot, Date.now()),
    options.transcriptScanIntervalMs
  );

  pollAndUpsertFleet(db, options.ownSessionFilePath).catch((err) =>
    console.error('[aether-collector] fleet poll failed:', err)
  );
  const fleetPollTimer = setInterval(() => {
    pollAndUpsertFleet(db, options.ownSessionFilePath).catch((err) =>
      console.error('[aether-collector] fleet poll failed:', err)
    );
  }, options.fleetPollIntervalMs);

  return () => {
    stopTailer();
    clearInterval(compactTimer);
    clearInterval(transcriptScanTimer);
    clearInterval(fleetPollTimer);
    db.close();
  };
}

// Only run the real process wiring when this module is the actual entrypoint
// (not when imported by index.test.ts), so tests can import startCollector
// without a second background process spinning up alongside the test's own.
const isMainModule = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts');
if (isMainModule) {
  const aetherDir = join(homedir(), '.aether-os');
  const stop = startCollector({
    dbPath: join(aetherDir, 'collector.db'),
    spoolDir: join(aetherDir, 'spool'),
    tailIntervalMs: 2000,
    compactIntervalMs: 60 * 60 * 1000, // hourly
    projectsRoot: join(homedir(), '.claude', 'projects'),
    transcriptScanIntervalMs: 15000,
    ownSessionFilePath: join(aetherDir, 'own-session.json'),
    fleetPollIntervalMs: 15000,
  });

  console.log('[aether-collector] running');

  const shutdown = () => {
    console.log('[aether-collector] shutting down');
    stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
