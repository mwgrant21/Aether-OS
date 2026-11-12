# aether-collector

A standalone, headless Node process that ingests Claude Code hook events into a local SQLite
store. Runs independently of the Aether OS Electron app -- see `docs/roadmap.md` Stage 2 and
`docs/privacy-and-data.md` for the full design rationale.

## Run

```
npm install
npm run build
npm start
```

## Backfilling legacy usage rows

Usage rows written before 0.7.6 have no `message_key`, and streamed messages were counted once
per chunk. `backfill-usage` rebuilds the key for those rows from their transcript files and
removes the duplicates. Rows whose transcript no longer exists (or has no matching line) are
left unchanged and counted in the report; history is not fully repaired.

Dry-run (the default, reads only, prints one line of JSON):

```
node dist/cli.js backfill-usage
```

Apply:

1. Stop the collector, then wait more than 60 seconds. `--apply` is refused (exit 3) while
   `schema_meta.transcript_last_scan_ms` is younger than 60 seconds. `--allow-running` skips
   that check and is for tests only.
2. Check the collector you will restart is a 0.7.6 or later build (an older one has no
   `message_key` dedupe and recreates the duplicates). Fix the autostart target first if not.
3. Run `node dist/cli.js backfill-usage --apply`. It first writes and verifies a backup next
   to the database, `collector.db.pre-usage-backfill-<UTC yyyymmddHHMMSS>.bak` (free space,
   `quick_check`, row count and token sum). It never overwrites a backup, so a second apply
   in the same second exits 4. A second apply that finds nothing to do still takes another
   backup; delete the extras by hand.
4. Restart the collector.

Rollback: stop the collector and copy the `.bak` over `collector.db` (remove any `-wal` and
`-shm` files beside it). This is clean ONLY before the collector restarts. After a restart the
gap re-ingest duplicates `tool_calls`, and hook spool files already consumed are lost.
Decide go/no-go from the dry-run numbers before applying.

Report fields: `legacyRows`, `legacyRowsNoSource`, `filesReferenced`, `filesPresent`,
`filesUnusable`, `rowsUnrecoverable` (with `unrecoverableMinMs`/`MaxMs`), `rowsNoMatch`,
`rowsKeyless`, `rowsAmbiguous`, `rowsMatched`, `keysDistinct`, `keysAlreadyInTable`,
`keysUsageDiffers` (keys whose duplicate lines carried different usage; the first row keeps
its own usage) with `keysUsageDiffersOutputDelta`, `rowsToKey`, `rowsToDelete`,
`totalTokensBefore` and `totalTokensAfter`. A second run reports zero matched rows.

Exit codes: 0 ok; 1 error, rolled back, or post-write assertion mismatch; 2 `message_key`
column missing (run the collector once to migrate); 3 collector alive; 4 backup or free-space
failure; 5 database changed during the run (nothing written, re-run). `--help` prints the
full text.

## Deduplicating the unrecoverable legacy rows (approximate)

`dedupe-legacy-usage` is a manual operator command. Nothing runs it automatically (not the
collector, not Aether, not a settings action). The dry-run is the default and writes nothing.

Why: `backfill-usage` cannot fix rows whose transcript file no longer exists, so those rows
stay without a `message_key` and streamed messages stay counted once per chunk. Run
`backfill-usage` first: `--apply` is refused (exit 2) until its `usage_backfill_v1` marker
exists. That marker is an ordering guard, not a security boundary.

The rule is APPROXIMATE and reads no transcript. Among rows with no `message_key` and a
`source_file_rel`, rows of one transcript file with the same model and the same four token
counts, each within 60 seconds of the previous one, are treated as one streamed message: the
earliest row is kept and the rest are deleted. Rows with all four token counts at zero are
never touched. Keyed rows are never touched. Candidates are limited to rows older than
2026-11-09T04:40:00Z and no newer than the marker's `unrecoverableMaxMs`; if the marker has no
numeric `unrecoverableMaxMs` there are no candidates.

What is and is not known:

- On rows whose true message was recoverable, the rule found 98.5% of known duplicates, on
  2026-10-13+ data, approximate; individual deletes are not verified. Its false positives
  there carried no token mass, but that ground truth excludes rows whose
  (timestamp, model, tokens) tuple maps to more than one message id, so "0 false positives on
  163k rows" is biased and is not a guarantee.
- The rule was calibrated on 2026-10-13+ rows and is applied to rows from 2026-09-11 to
  2026-10-12 (older Claude Code builds). That transfer is unverified. The only check is yours,
  and it is made against the TARGET shape, not the calibration shape. Calibration set (163k
  ground-truthed rows from 2026-10-13 onward): 52,392 pairs, 5,865 triples, largest cluster
  19. Expected target (about 50.8k rows; a PREDICTION with no ground truth): about 16.5k
  pairs, about 3.4k triples, largest cluster about 14, about 25.9k rows to delete and about
  5e9 tokens. Compare your dry-run `clusterPairs`, `clusterTriples`, `maxClusterSize`,
  `rowsToDelete` and `deleteTokenMass` with the target figures. A large departure (far more
  deletes, or a largest cluster beyond about 30, which the code refuses anyway) means do not
  apply.
- Survivors are the earliest streamed row and may carry partial output (943 groups in the
  calibration differed). They keep a NULL `message_key`. Duplicates of one message across two
  transcript files are not caught. Totals will not be exact.

Dry-run (the default, reads only, prints one line of JSON):

```
node dist/cli.js dedupe-legacy-usage
```

Apply:

1. Run the dry-run and read it. `--apply` requires `--expect-delete <n>` and
   `--expect-token-mass <n>`, taken from your own dry-run's `rowsToDelete` and
   `deleteTokenMass`. A mismatch exits 6 before anything is backed up. Exit 6 also covers a
   cluster over 30 rows (`maxClusterSize`), a cluster spanning over 300 seconds
   (`maxClusterSpanMs`), and a plan deleting more than 60% of `rowsConsidered`.
2. Stop the collector, then wait more than 60 seconds. `--apply` is refused (exit 3) while
   `schema_meta.transcript_last_scan_ms` is younger than 60 seconds, and also when it is missing
   or not a number (it fails closed). `--allow-running` skips that check and is for tests only.
3. Check the collector you will restart is a 0.7.6 or later build.
4. Run `node dist/cli.js dedupe-legacy-usage --apply --expect-delete <n> --expect-token-mass <n>`.
   It first writes and verifies a backup next to the database,
   `collector.db.pre-legacy-dedupe-<UTC yyyymmddHHMMSS>.bak` (free space, `quick_check`, row
   count and token sum). It never overwrites an existing path, including a dangling symlink,
   so a rerun in the same second exits 4. After the delete it re-runs the plan under the write
   lock and rolls back unless nothing further would be deleted and every kept row is present.
5. Restart the collector.

Retry notes: after exit 5 (database changed, nothing written) a verified `.bak` is left behind,
and a same-second rerun exits 4 until you keep or delete that file. If the database stays locked
for the 5 second busy timeout at the start of the write, the run exits 1 and also leaves a
verified `.bak`. A run that finds nothing to delete still takes a backup; delete the extras by
hand. `wal_checkpoint(TRUNCATE)` after the commit is best effort, and the database file does not
shrink (no VACUUM).

A crash between claiming the backup name and the `VACUUM INTO` leaves a 0-byte `.bak`; a same-second rerun then exits 4 and leaves it untouched. A 0-byte `.bak` is a crash leftover to delete, never a valid backup (a verified backup has the same `usage_events` row count and token sum as the database).

Rollback: stop the collector, move aside `<db>-wal` and `<db>-shm` beside the database (a
stale WAL replayed over a restored main file corrupts it), then copy the `.bak` over
`collector.db`. This is clean ONLY before the collector restarts. After a restart the gap
re-ingest duplicates `tool_calls`, and hook spool files already consumed are lost.

Report fields: `mode`, `rule`, `approximate`, `windowMs`, `cutoffMs`, `upperBoundMs`,
`backfillMarkerPresent`, `legacyRows`, `legacyRowsNoSource`, `rowsZeroMass`, `rowsConsidered`,
`clusters`, `clusterPairs`, `clusterTriples`, `maxClusterSize`, `maxClusterSpanMs`,
`rowsToDelete`, `deleteTokenMass`, `candidateOldestMs`, `candidateNewestMs`, `totalRowsBefore`,
`totalRowsAfter`, `totalTokensBefore` and `totalTokensAfter`. A second run reports zero
`rowsToDelete`.

Exit codes: 0 ok; 1 error, rolled back, or post-write assertion mismatch; 2 `message_key`
column or backfill marker missing; 3 collector alive or heartbeat unreadable; 4 backup or
free-space failure; 5 database changed during the run (nothing written, re-run); 6 plan out of
bounds. `--help` prints the full text.

## Privacy

This process derives a minimal signal from each hook event (file paths, tool names, timestamps,
small counts) and never persists raw command strings, file contents, tool output, or message
text. See `../docs/privacy-and-data.md` for the full policy this process implements.

## Requires

Node.js 22.5 or later (`node:sqlite`).
