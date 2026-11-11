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

## Privacy

This process derives a minimal signal from each hook event (file paths, tool names, timestamps,
small counts) and never persists raw command strings, file contents, tool output, or message
text. See `../docs/privacy-and-data.md` for the full policy this process implements.

## Requires

Node.js 22.5 or later (`node:sqlite`).
