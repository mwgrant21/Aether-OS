import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDatabase, migrate } from './schema';
import { startSpoolTailer } from './spoolTailer';
import { compact } from './retention';

export function startCollector(options: {
  dbPath: string;
  spoolDir: string;
  tailIntervalMs: number;
  compactIntervalMs: number;
}): () => void {
  const db = openDatabase(options.dbPath);
  migrate(db);

  const stopTailer = startSpoolTailer(db, options.spoolDir, options.tailIntervalMs);
  const compactTimer = setInterval(() => compact(db, Date.now()), options.compactIntervalMs);

  return () => {
    stopTailer();
    clearInterval(compactTimer);
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
