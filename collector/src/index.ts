import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, migrate, stampFleetHeartbeat } from './schema.js';
import { startSpoolTailer } from './spoolTailer.js';
import { compact } from './retention.js';
import { scanTranscriptsOnce } from './transcriptScan.js';
import type { ToolCallHistory } from './toolCallHistory.js';
import { createHandbackReportStore } from './dispatchResultText.js';
import { pollFleet, upsertFleetSessions, type FleetExecFn } from './fleetPoll.js';
import { logDrift } from './canary.js';
import { readOwnSessionId } from './ownSessionFile.js';
import { createMemoryStore } from './memoryStore.js';
import {
  createMemoryExtractQueue,
  drainMemoryExtractQueue,
  type MemoryExtractQueue,
} from './memoryExtractQueue.js';
import type { ExtractExecFn } from './memoryExtract.js';
import type { MemoryStore } from './memoryStore.js';
import { COLLECTOR_SETTINGS_FILE, readMemoryExtractionEnabled } from './collectorSettings.js';

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

// Memory extraction calls a model (claude -p), so it is opt-in, default OFF (#104).
// The setting is re-read at every tick, and gated at BOTH ends: the scan only
// stages work while it is on, and the drain re-checks it before EVERY item. The
// queue is taken into a local batch and each item runs through its own one-item
// queue, so an item staged while on and still waiting when the user turns it off
// (including mid-batch, while an earlier item's `claude -p` is awaited) is dropped
// without reaching the extractor: "off" means off at the moment of each exec.
// The store may be a getter, resolved only after that per-item check, so a collector
// with extraction off (or on with nothing to extract) never opens memory.db.
export async function memoryExtractionTick(
  store: MemoryStore | (() => MemoryStore),
  queue: MemoryExtractQueue,
  settingsPath: string,
  execFn?: ExtractExecFn,
  onIssue?: (detail: string) => void
): Promise<void> {
  const batch = queue.drain();
  for (const item of batch) {
    if (!readMemoryExtractionEnabled(settingsPath)) return;
    const single = createMemoryExtractQueue();
    single.push(item);
    const s = typeof store === 'function' ? store() : store;
    await drainMemoryExtractQueue(s, single, execFn, onIssue);
  }
}

// Reason shown in the log: an error code (fs ENOENT, ERR_SQLITE_ERROR) or the error class
// name, never err.message or the stack -- those can carry absolute paths and SQL text.
function tickErrorReason(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  return err instanceof Error ? err.name : 'non-error thrown';
}

// The two synchronous interval bodies have no .catch, so one throw would be an
// uncaught exception and kill the daemon. Log a fixed line and keep ticking.
function guardTick(label: string, fn: () => void): () => void {
  return () => {
    try {
      fn();
    } catch (err) {
      console.error(`[aether-collector] ${label} failed: ${tickErrorReason(err)}`);
    }
  };
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
  memoryDbPath: string;
  memoryExtractIntervalMs: number;
  collectorSettingsPath: string;
}): () => void {
  const db = openDatabase(options.dbPath);
  migrate(db);

  // Opened on the first drained item while extraction is ON, not at startup, so
  // memory.db does not exist for installs that never enable it.
  let memoryStore: MemoryStore | null = null;
  const getMemoryStore = (): MemoryStore => (memoryStore ??= createMemoryStore(options.memoryDbPath));
  const extractQueue = createMemoryExtractQueue();

  const stopTailer = startSpoolTailer(db, options.spoolDir, options.tailIntervalMs);
  const compactTimer = setInterval(
    guardTick('compaction', () => {
      compact(db, Date.now());
    }),
    options.compactIntervalMs
  );
  const toolCallHistoryByFile = new Map<string, ToolCallHistory>();
  // Survives across ticks so a hand-back and its later notification still link.
  const handbackReports = createHandbackReportStore();
  // Passing no queue skips enqueueing entirely, so dispatch result text is not even
  // staged in memory while memory extraction is off.
  const scanQueue = () => (readMemoryExtractionEnabled(options.collectorSettingsPath) ? extractQueue : undefined);
  // The pin changes at runtime, so it is re-read on every scan, never captured once.
  const scan = () =>
    scanTranscriptsOnce(
      db,
      options.projectsRoot,
      Date.now(),
      toolCallHistoryByFile,
      scanQueue(),
      readOwnSessionId(options.ownSessionFilePath),
      handbackReports
    );
  const guardedScan = guardTick('transcript scan', () => {
    scan();
  });
  guardedScan();
  const transcriptScanTimer = setInterval(guardedScan, options.transcriptScanIntervalMs);

  pollAndUpsertFleet(db, options.ownSessionFilePath).catch((err) =>
    console.error('[aether-collector] fleet poll failed:', err)
  );
  const fleetPollTimer = setInterval(() => {
    pollAndUpsertFleet(db, options.ownSessionFilePath).catch((err) =>
      console.error('[aether-collector] fleet poll failed:', err)
    );
  }, options.fleetPollIntervalMs);

  memoryExtractionTick(getMemoryStore, extractQueue, options.collectorSettingsPath, undefined, (d) =>
    logDrift(db, Date.now(), d)
  ).catch((err) =>
    console.error('[aether-collector] memory extraction failed:', err)
  );
  const memoryExtractTimer = setInterval(() => {
    memoryExtractionTick(getMemoryStore,extractQueue, options.collectorSettingsPath, undefined, (d) =>
      logDrift(db, Date.now(), d)
    ).catch((err) =>
      console.error('[aether-collector] memory extraction failed:', err)
    );
  }, options.memoryExtractIntervalMs);

  return () => {
    stopTailer();
    clearInterval(compactTimer);
    clearInterval(transcriptScanTimer);
    clearInterval(fleetPollTimer);
    clearInterval(memoryExtractTimer);
    memoryStore?.close();
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
    memoryDbPath: join(aetherDir, 'memory.db'),
    memoryExtractIntervalMs: 15000,
    collectorSettingsPath: join(aetherDir, COLLECTOR_SETTINGS_FILE),
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
