import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, migrate, stampFleetHeartbeat } from './schema.js';
import { startSpoolTailer } from './spoolTailer.js';
import { compact } from './retention.js';
import { scanTranscriptsOnce } from './transcriptScan.js';
import type { ToolCallHistory } from './toolCallHistory.js';
import { pollFleet, upsertFleetSessions, type FleetExecFn } from './fleetPoll.js';
import { readOwnSessionId } from './ownSessionFile.js';

// Exported (not just module-private) so tests can drive it directly with an
// injected execFn, matching pollFleet's own injectable-exec-function
// precedent, instead of going through startCollector's real setInterval
// wiring and a real `claude` child-process spawn.
export async function pollAndUpsertFleet(
  db: DatabaseSync,
  ownSessionFilePath: string,
  execFn?: FleetExecFn
): Promise<void> {
  const ownSessionId = readOwnSessionId(ownSessionFilePath);
  const nowMs = Date.now();
  try {
    const sessions = await pollFleet(db, ownSessionId, nowMs, execFn);
    upsertFleetSessions(db, sessions ?? [], nowMs);
  } finally {
    // Stamped regardless of success/failure above -- the heartbeat's job is
    // to prove "the collector process is alive and cycling," not "the last
    // poll succeeded." See schema.ts's stampFleetHeartbeat doc comment.
    stampFleetHeartbeat(db, nowMs);
  }
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
  const toolCallHistoryByFile = new Map<string, ToolCallHistory>();
  scanTranscriptsOnce(db, options.projectsRoot, Date.now(), toolCallHistoryByFile);
  const transcriptScanTimer = setInterval(
    () => scanTranscriptsOnce(db, options.projectsRoot, Date.now(), toolCallHistoryByFile),
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
