# Backfill severity (#106) and v0.6.0: handoff

Written 2026-10-01 on the home machine (titan), for picking the work up on work-it.

## Where it stands
- **master is `1da9981`**: #109 squash-merged, which closed #106. Nothing is in flight: no open PRs, no unmerged work branches from this session.
- **v0.6.0 is released**: #108 squash-merged as `501d98a`, annotated tag `v0.6.0` on it, pushed. The 0.6.0 installer is installed on the home machine.
- **The installed 0.6.0 does NOT contain #109.** It was built from `501d98a`. Seeing the #106 fix in the running app needs a v0.6.1 bump and a rebuild (release ritual: `docs/packaging.md`; build outside the dev tree).
- **Tests at `f20e090` (= `1da9981`)**: collector 433 passed + 2 skipped, `tsc --noEmit` clean, all 11 CI checks green. The root suite was not touched by #109.
- **This file travels on branch `docs/handoff-2026-10-01`**, not master. Master requires four status checks, and opening a PR triggers a paid Codex review, so no PR was opened for a docs-only change. Read it with `git fetch && git show origin/docs/handoff-2026-10-01:docs/superpowers/plans/2026-10-01-backfill-severity-handoff.md`, or merge it via a PR if you want it on master. The branch also adds the PROGRESS.md entry for #106.

## What #109 changed (collector only)
Problem: a dispatch was scored when its file was read, and `medianDurationMsFor` only sees rows already stored. On a first scan files come in `readdirSync` order, so a run could miss earlier baseline samples and keep an order-dependent `severity` / `median_ms_at_eval`.

As shipped:
- **Per-file transaction** (`inTransaction` in `collector/src/transcriptScan.ts`). Each file's usage rows, tool calls, dispatch rows, stale sweep and offset commit together. A failure rolls that file back, so the offset never passes unwritten rows and a retry never double-counts `usage_events` (it has no unique key). Subagent tool-error counts are read before the transaction opens (`resolveToolErrors`).
- **Durable rescore watermark.** `ingestDispatchEvent` lowers `schema_meta` key `dispatch_rescore_from_ms` to the run's end time, in the same transaction as its row. At the end of every scan, `rescorePendingDispatches` (`collector/src/usageIngest.ts`) rescores every row with a non-NULL `dispatch_status` that ended at or after the watermark, from stored columns only, and deletes the key. A crash before the rescore leaves the key for the next scan. This also covers old transcripts that appear in a later scan.
- **Tool-error stand-in.** The tool-error count is not stored. It only acts as a floor of 3 on a completed run, and slowness is capped at 2, so a stored completed severity >= 3 is treated as "floor applied". **This holds only while those two rules hold.** If `computeSeverity` ever lets slowness reach 3, or adds another completed-run input that is not stored, the rescore becomes wrong.
- **Parser.** An unparseable transcript timestamp is now `null`, not an Invalid Date (`collector/src/transcriptParser.ts`). Its NaN failed NOT NULL columns.

Why this shape: three earlier designs each failed a Codex review, all real findings. The full history is in the #109 description:
- Buffering all completions to the end of the pass checkpointed offsets before the work ran.
- One transaction for the whole pass held the writer lock across the whole read, and Electron's purge handle (`electron/retentionStore.ts`, 5 s `busy_timeout`) would fail behind it.
- Staging all reads first would hold the transcript corpus in memory (725 MB on titan).
- An in-memory rescore list was lost if the process died after offsets committed.

## Next steps (at work)
1. `git fetch --prune && git checkout master && git pull`, then `npm ci` (and `cd collector && npm ci`). Watch out for worktrees that borrow `node_modules` through a junction.
2. Leftover chores from #105, work machine only:
   - Remove the worktree `Desktop\Aether-OS-severity`. Unlink its `node_modules` junction first with `[IO.Directory]::Delete(<path>)`, never a recursive delete.
   - Delete the local `docs/real-severity-design` branch (merged in #105) and fast-forward livetest master.
3. Pick the next item (the user's call):
   - **#107, Go collector dispatch ingest** (stores 0 for missing usage, ignores `<status>`). **Interaction with #109:** Go rows have NULL `dispatch_status`, so the rescore skips them today. If #107 makes Go write `dispatch_status`, those rows enter the rescore. Then Go must also lower `dispatch_rescore_from_ms`, and must use the same severity rules, or the tool-error stand-in above breaks for Go-written rows. Extend the parity fixture to cover it.
   - **#104, collector runs `claude -p --model haiku` every 15 s** on dispatch result text, and the `noApiCalls` guard misses `execFile`. This touches the CLAUDE.md "no billed model calls" rule, so it is arguably higher priority than #107.
   - Smaller items: #65 (Go/Node parity on dispatch rows), #67, #69, #71, #72, #73.
4. If the user wants the #106 fix live: bump to v0.6.1, build the installer outside the dev tree, and tag the squash commit after the release PR merges.

## Open risks and notes
- **Rescore cost.** Every scan opens one short transaction for the rescore, even when there is no watermark (one SELECT). A first scan rescores every row once. In steady state each completion only rescores rows that ended after it, normally just itself.
- **Test-run noise.** The collector suite prints `fleet poll failed: Error: database is not open` three times, from `index.test.ts` teardown. It predates #109 (checked against master).
- **pr-review-watch.** The background watcher hit the 2 h background-task limit and was not restarted, because there are no open PRs. Start a new one when a PR opens.
- **Codex review cost.** Every PR open triggers a paid Codex review, and each `@codex review` costs money. List every review and thread before calling a PR clean; a BLOCKED status with green CI means an unresolved thread.
