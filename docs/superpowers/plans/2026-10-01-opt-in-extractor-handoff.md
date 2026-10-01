# Opt-in memory extraction (#104): handoff

Written 2026-10-01 (evening) on the work machine (work-it), for continuing on the home machine.

## Where it stands
- **master is `7ee6856`**: PR #112 squash-merged, closing #104. Nothing is in flight: no open PRs, and no unmerged work branches from this session.
- **No release yet.** The latest tag is still `v0.6.0` (`501d98a`). It contains neither #109 (the backfill severity fix) nor #112. The installed 0.6.0 collector **still extracts unconditionally**. The opt-in gate only takes effect once the collector is rebuilt, so shipping it needs a v0.6.1.
- **Tests at #112's head (`68a686c`, the same tree as `7ee6856`)**: root 217 files + 1 skipped, 2467 passed + 19 skipped; collector 35 files, 449 passed + 5 skipped. typecheck:electron, collector `tsc --noEmit` and `npm run build` are clean. There is no lint script.
- **This file travels on branch `docs/handoff-2026-10-01-evening`**, not master. As with the previous handoff, no PR was opened for a docs-only change, because opening one triggers a paid Codex review. Read it with `git fetch && git show origin/docs/handoff-2026-10-01-evening:docs/superpowers/plans/2026-10-01-opt-in-extractor-handoff.md`.

## What #112 changed
- **Collector (T1).** `~/.aether-os/collector-settings.json` (`memoryExtractionEnabled`) is re-read on every scan and drain tick. Only an exact `=== true` counts as ON.
  - There are two gates: an OFF setting means nothing is enqueued, and the drain re-checks the setting before every item.
  - `scrubbedEnv` removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` **case-insensitively**. This was proven end to end on Windows with the real `process.env`.
- **Guard.** `src/shared/noApiCalls.test.ts` flags any launch of `claude`: `spawn`, `exec`, `execFile`, `fork`, the sync variants, `promisify(...)` forms, typed aliases and destructure-renames. It allow-lists three exact paths: `claudeHeadlessCli.ts`, `fleetPoll.ts` (argv pinned) and `memoryExtract.ts`.
- **App (T2).** A Settings > Memory Extraction card with a confirm-before-enable step, a CostGuard row, and the Ledger "Aether OS itself" note.
  - The store field is tri-state (`null` = unknown, the default). No surface shows OFF or ENABLE until the on-disk value has been read. A rejected or hanging read stays neutral.
- **Docs (T3).** `docs/privacy-and-data.md` §14, plus scoped corrections across the privacy doc, roadmap, README, CLAUDE.md and standing decisions.
- **Review history.** Three tasks, ten refuter rounds, a CodeQL fix (regex escaping) and two Codex P2 fixes (the tri-state status and the case-insensitive scrub). Full detail is in the #112 description.

## Next steps (at home)
1. `git fetch --prune && git checkout master && git pull --ff-only`, then `npm ci` and `cd collector && npm ci`.
2. Pick the next item (your call). Suggested order:
   - **#113 (billing leak, small).** `electron/ptyManager.ts:20` and `electron/codexPtyManager.ts:143` still delete billing variables by exact uppercase name, so a mixed-case spelling reaches the terminal `claude` / `codex` sessions on Windows. The fix is the #112 `scrubbedEnv` approach, ideally one shared helper. Write the red test first.
   - **v0.6.1 release.** It ships #109 and #112, and is the only way the extraction gate reaches an installed app. Follow the ritual in `docs/packaging.md`, build outside the dev tree, and tag the squash commit after the release PR merges. If #113 lands first, it rides along too.
   - **#111.** Decide whether to isolate the extractor's `claude -p` from the user's CLAUDE.md, hooks and credentials. Verify any Claude Code flag against current docs before relying on it.
   - **#107.** Go dispatch ingest. Its interaction with #109's rescore watermark is described in the 2026-10-01 backfill-severity handoff.
   - Smaller items: #65, #67, #69, #71, #72, #73.

## Open risks and notes
- **The extractor's sessions are billed and visible.** `claude -p` runs without `--no-session-persistence`, so each extraction is an ordinary Claude Code session. It counts in the Ledger's all-transcripts totals and fires the user's Stop hooks. #111 tracks this.
- **Without a timeout.** With the setting ON, `claude -p` has no timeout, and `memory.db` is created even when the setting is OFF. Both are recorded in the spec and not yet ticketed.
- **Two red intermediate commits.** The branch history has `c7e4c96` and `480e225`, but master only has the squash, so this does not affect bisecting master.
- **Codex review cost.** Each PR open triggers a paid Codex review. List every review thread before calling a PR clean: branch protection blocks a merge on any unresolved conversation, including CodeQL's.
