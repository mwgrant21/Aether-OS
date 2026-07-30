// Reader-side parity check: runs the UNMODIFIED electron/collectorStore.ts
// against BOTH the Node collector's collector.db and the Go collector's
// collector.db and compares what it returns. Proves the reader's queries
// execute, its schema-version and 45s liveness-heartbeat gates both pass, and
// the resulting domain objects are identical. Does NOT prove pixels -- for
// that, launch the app twice with each collector live behind it.
//
// Usage (from collector-go/), against a work dir left behind by
// `node scripts/parity/run-parity.mjs --keep`:
//   node scripts/parity/reader-check.mjs <work-dir> ../electron/collectorStore.ts
//
// Must be run within ~45s of the collectors' last heartbeat, or
// readDiagnostics/readFleetSessions correctly return null for BOTH databases.
// run-parity.mjs runs the two collectors CONCURRENTLY partly for this reason:
// with the default 50s run window their final heartbeats both land ~5s before
// the harness exits, so this script is usable for roughly the next 40s. If you
// wait longer, or if you set a much larger AETHER_PARITY_RUN_MS, re-run the
// harness rather than trusting a null-vs-non-null result here.
// Requires a Node with TypeScript type-stripping (24.x): collectorStore.ts's
// only imports are type-only and erase cleanly.
import { join } from 'node:path';

const workRoot = process.argv[2];
const storePath = process.argv[3];

const store = await import('file:///' + storePath.replace(/\\/g, '/'));

const dbA = join(workRoot, 'home-node', '.aether-os', 'collector.db');
const dbB = join(workRoot, 'home-go', '.aether-os', 'collector.db');

function snapshot(db) {
  const usage = store.readUsageEventsSince(db, 0);
  const diag = store.readDiagnostics(db, 0);
  const fleet = store.readFleetSessions(db);
  return {
    usage,
    diagnostics: diag && {
      toolCalls: diag.toolCalls,
      dispatches: diag.dispatches,
      // detectedAtMs is the scan tick's wall clock -- the one excluded field,
      // same exclusion the row-level parity diff documents for `anomalies`.
      anomalies: diag.anomalies.map((a) => ({ ...a, detectedAtMs: '<wall-clock>' })),
    },
    fleet,
  };
}

const a = snapshot(dbA);
const b = snapshot(dbB);

const stable = (v) => JSON.stringify(v, null, 2);

console.log('--- reader output against the NODE collector db ---');
console.log(stable(a));
console.log('\n--- null-check (a null return means the reader rejected the db) ---');
for (const [label, snap] of [['node', a], ['go', b]]) {
  console.log(
    `  ${label}: usage=${snap.usage === null ? 'NULL' : snap.usage.length + ' rows'} ` +
      `diagnostics=${snap.diagnostics === null ? 'NULL' : Object.entries(snap.diagnostics).map(([k, v]) => k + ':' + v.length).join(' ')} ` +
      `fleet=${snap.fleet === null ? 'NULL' : snap.fleet.length + ' rows'}`
  );
}

console.log('\nIDENTICAL:', stable(a) === stable(b));
if (stable(a) !== stable(b)) {
  console.log('node:', stable(a));
  console.log('go:  ', stable(b));
  process.exitCode = 1;
}
