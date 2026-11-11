# Changelog

All notable changes to Aether OS are recorded here. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions follow
pre-1.0 semver as described in `docs/packaging.md`.

## [Unreleased]

### Added
- `scripts/redeploy-collector.ps1` now journals each step (`~\.aether-os\redeploy-journal.json`) and rolls a failed deploy back automatically (exit 1, or 3 with RECOVERY steps when it cannot), adds a `-Rollback` command and a `-VerifySeconds` window (1..60), and refuses more unsafe inputs up front. The database is never restored.
- `backfill-usage` in the Node collector CLI: a dry-run-by-default repair that rebuilds the dedupe key for pre-0.7.6 usage rows from their transcripts and removes streamed duplicates. Rows whose transcripts no longer exist are left unchanged and reported.

### Fixed
- Background agents now appear in the desktop fleet view. Their `claude agents --json` rows carry `state` instead of `status`, which made both collectors report schema drift every poll and drop the card.

## [0.7.6] - 2026-11-10

### Added
- Statusline warns when a session context passes 300k tokens, on the Aether line and on chained lines (#222).
- Boards note a range override on panels whose default range differs (#222).
- CI: a non-required Windows e2e job (#216).

### Changed
- Collector write transactions begin IMMEDIATE and the database opens in WAL mode on a best-effort basis, in both the Node and Go collectors (#218, #219).
- The WAL is checkpointed after a purge VACUUM (#217).
- PTY owner helper: follow-ups, and a helper launched during a quit wait is now ended (#210, #220).

### Fixed
- Streamed assistant usage is counted once, not once per streamed chunk: the widget history scan, the Node collector and the Go collector dedupe on a shared `message_key` unique index. Existing `usage_events` rows keep NULL keys and are not backfilled (#222).
- The cache hit rate starter board includes cache creation tokens in its denominator (#222).
- The Codex ACP client survives child and stdin errors and decodes UTF-8 incrementally (#211).
- Collector interval ticks are guarded, and the Go fleet poll times out (#212).
- Optimize shows $/wk as a per-week average, not the all-time total (#213).
- Thumbnails are requested once, and the Optimize "applied" message is shown (#214).
- The collector rejects STEWARD and non-plain agent ids as memory writers (#215).

## [0.7.5] - 2026-11-09

### Added
- PTY owner helper (Phase B): a detached process that owns the terminal ptys; off by default (#208).
- Phone alerts for turn finished, question and needs-input (#198, #199, #200).
- Android: draggable terminal selection handles with edge auto-scroll (#196).
- Terminal sessions survive a renderer reload (#201, #203, #204).

### Changed
- The Active Agents card scrolls, and abandoned dispatches age out (#209).
- README refreshed for 0.7.4 with synthetic-data screenshots (#202).

### Fixed
- The renderer card is cleared when a permission or post-tool-flag response finds no resolver (#206).
- The installer kills a lone leftover helper under the install directory (#207).

## [0.7.4] - 2026-11-06

### Added
- AetherChoice: a model/effort picker with a host runtime, screen watcher, renderer hook and Settings card; observe-only trace is off by default (#158, #159, #160, #161, #163, #165, #167).
- AFK / overnight mode, Phase 1: terms, classifier, plan compiler, feasibility check, a single draft with amend and re-check, TTY-gated approval, an `afk` CLI and a pre-flight skill (#172 to #177, #179, #180, #184, #188).
- Terminal board: Terminal and Terminal 2 are renamed Terminal Alpha and Terminal Beta, with an `AETHER_TERMINAL` identity variable, a shared terminal board, an `aether-board` CLI and an agent skill (#178, #181, #183, #185, #186, #190, #192).
- Mobile: copy, paste and scroll in the Android terminal (#159).

### Changed
- Memory extraction logs one outcome line per attempt and is fed the subagent's real hand-back report (#162, #166).

### Fixed
- AetherChoice host: a start after a synchronous exit does not mark the slot running, and host calls are guarded (#164, #170).
- AFK: approval is refused if the terms or draft changed while the prompt was open (#177).

## [0.7.3] - 2026-11-02

### Added
- Voice gateway: a tailnet-only server with pairing, a streaming speech filter with secret masking, a `claude -p` session supervisor, replayable event log, hub and Settings card (#149, #150).
- Terminal status markers are colored in all three terminals, with truecolor enabled in the pty environment (#153, #155).

### Changed
- Collector: scanning skips files with no new bytes, extraction runs in a hook-free bounded child, and extraction failures are visible in the drift log (#149).
- Docs: privacy sections and a CLAUDE.md rule for the voice gateway (#156).

### Fixed
- Collector sweep treats the pinned session as live, falls back to transcript mtime for unpinned sessions, and ingests queued task-notification completions (#149, #151, #152).
- Voice speech filter: two PEM masking findings from review (#150).

## [0.7.2] - 2026-10-31

There is no 0.7.1; #148 moved the version from 0.7.0 to 0.7.2.

### Added
- Boards: Claude-authored dashboards over `collector.db` (#119).
- Traffic tab: a read-only agent-to-agent message board (#121, #122).
- Read-only mobile remote access over Tailscale (#124, #125).
- Aether Mobile for Android: locked-down app with dedicated signing, pairing, device auth and a `/ctl` control channel (#129, #130, #131, #132, #133, #134).
- Mobile V2: a headless terminal mirror, terminal protocol and per-slot live terminal view on the phone (#136 to #146).
- Mobile V3: Compose UI in the Aether design language, with a new layout (#147, #148).
- Content Security Policy for the main renderer window (#126).

### Changed
- Collector autostarts via a per-user Run key instead of an ONLOGON task (#118).

### Fixed
- Board masks PGP private key blocks (#123).

## [0.7.0] - 2026-10-06

### Added
- Terminal 2: a second, unmonitored Claude terminal tab (#116).
- Memory extraction is opt-in and off by default, and every claude launch is guarded (#112).

### Changed
- The monitored Claude session is pinned by `--session-id` and the dashboard shows only the pinned terminal's statusline (#116).

### Fixed
- Per-model pricing for Sonnet 5, Sonnet 5.5 and Opus 5.5/5.1 cache reads, and estimates carry the rate they were priced at (#114).
- Security audit leads: the hook and permission server mutually authenticate, the port file is published as a fresh user-only file, symlinked parent directories are refused in the verification snapshot, and the ACP verifier starts read-only (#115).
- Collector scores backfilled dispatches in time order (#109).

## [0.6.0] - 2026-09-30

### Added
- Real dispatch severity (#105).

### Changed
- Dashboard Readiness follow-ups: opens on Dashboard, unified session time, no "n/a" in prose (#103).

## [0.5.2] - 2026-09-30

### Changed
- `~/.aether-os` is enforced user-only, with an explicit ACL on Windows and mode 0700 on POSIX (#101).

## [0.5.1] - 2026-09-30

### Changed
- `[diag]` lines persist to `diag.log`, and the renderer is probed after unlock and resume (#98).

## [0.5.0] - 2026-09-29

### Added
- Quota cost: a subscription-quota cost type with empirical tokens-per-quota-point, a seven-day quota card, a per-dispatch quota column, and a monthly plan price setting.
- Codex rate-limit reading through the app-server without opening a thread.
- Dashboard design pass: idle empty states, a cold-cockpit idle composition, a Readiness column, and screen-reader state (#90, #91, #92, #94).
- Motion scale in `tokens.ts` (#88).
- The release ritual is documented in `docs/packaging.md` (#96).

### Changed
- The bridge client pin is raised to Claude 2.1.274, with the compatibility harness recovered into the repo (#86, #87).
- Approvals dropdown handles focus, Escape and outside-click (#97).

### Removed
- Light mode (#88).
- The user-wait subtraction from measured durations, which could not be made correct (#85).

## [0.4.0] - 2026-09-15

### Added
- Provider-neutral cross-engine adapters with an evidence bundle, a real headless Claude CLI adapter, and a Windows CI lane.
- Visible Claude-to-Codex communication: bridge, Comms rendering and a cross-check composer (#76).
- Local Windows packaging with electron-builder and NSIS, plus icon tooling (#75).
- Collector tests run in CI, and electron/ is type-checked in CI.

### Changed
- Codex app-server turns have an explicit lifecycle, bounded by one deadline and matched by turn id.
- Codex terminal strips npm-injected PATH entries and resolves codex in the profile-loaded shell (#77).
- Pinned codex-acp 1.8.0, and codex-cli 0.154.0 after re-probing its schema (#78).
- The app-server client identity is sourced from `package.json` (#79).

### Fixed
- Safe file writes: atomic replace with unique exclusive temp files, backups that follow symlinks and preserve mode, shared by the collectors, the statusline installer and Optimize apply (#58, #59, #60, #63, #66).
- Collector keeps a spool file when its writes fail and commits each file in one transaction (#57).

## [0.3.0] - 2026-08-19

### Added
- Plan usage: a PlanUsageCard fed by scraping `/usage` from the Terminal pty (tier and per-model week).
- Permission auto-allow at or below a configurable risk threshold, with real notifications for permission, flag, anomaly and completed-dispatch events.
- Per-project scoping of the Ledger and Optimize views, with a top-bar scope indicator and per-project Optimize findings.
- Settings: retention status, a purge of collected data, and a cost guard card.
- Cross-collector parity harness for the Node and Go collectors (#33).

### Changed
- Electron 35.7.5 to 43.4.1.
- Fictional approvals, agent roster and simulated system metrics are replaced by real pending requests and data.
- statusLine commands are chained instead of overwritten.

### Fixed
- The context window renders the real value, and the stale-context marker carries into terminal `status` (#26, #27).
- Collector ingests nested subagent transcript usage, with a backfill on upgrade (#28).
- Go collector matches Node's schema, never stamps the schema version downwards, and persists `tool_calls.source_file_rel` (#35, #36).
- Collector heals databases stamped back to an older version, and attributes usage events to their transcript (#37, #38).
- `busy_timeout` is set in both collectors (#44).
- Usage falls back to the transcript scan when the collector has stopped.
- Dev: Electron sandbox disabled to avoid a GPU crash, and white-screen diagnostics added (#45).

## [0.2.1] - 2026-08-10

### Added
- Codex terminal view (default off), with an idle indicator on the sidebar (#17).

### Changed
- The duplicate top-bar tab strip is removed; the sidebar is the sole navigation (#15).

### Fixed
- Terminal ptys no longer leak shell profile variables (#18).
- Ledger scans subagent transcripts and fixes the day-spanning dispatch filter.
- Usage falls back to the transcript scan when the collector has stopped.

## [0.2.0] - 2026-08-09

The first tagged release. It folds in the 0.1.0 scaffold (history starts 2026-07-16): a React app ported from a design prototype, then grown into an Electron desktop app.

### Added
- Views: Terminal, Dashboard, Agents, Orchestration Grid, Chat, Projects, Memory, Analytics, Settings and Uplinks, plus the reactor core with several renderers.
- Electron app with a real node-pty Claude terminal in xterm.js, frameless window chrome, and bounds persistence.
- Real usage data, live Active Agent dispatches and per-dispatch token and tool-use stats, replacing the prototype's simulated data.
- Attachments library, Optimize view (waste detection, setup grade and apply-fix), and anomaly detection with alert sounds.
- Statusline integration for real rate-limit and context data.
- Standalone aether-collector with a SQLite store, hook installer, transcript tailing, fleet polling, dispatch and anomaly tables, retention with daily rollups, and Scheduled Task autostart; a Go port of the collector.
- Local permission server with a PermissionRequest hook, approval UI, and a post-tool flag-and-block review.
- Memory layer 2: model-extracted memories, scope-based Memory view, and tombstones.
- Voice packs: deterministic narration of dispatches with a verbosity dial.
- Comms: real transcript messages in the thread, with filters and narration of key events.
- Cost Forensics ledger view, per-project cost roll-ups, and a nested project roster.
- Cross-engine verification of dispatch artifacts through a subscription-only Codex ACP connection, opt-in.
- Playwright e2e smoke tests, reduced-motion support, and keyboard access for Grid and Chat.

### Changed
- Notification sounds, focus-aware presence, a since-you-last-looked recap and a transcript density control.
- Dashboard reactor pulse derives from real momentum, and Pressure from real rate-limit usage.

### Removed
- The Anthropic SDK, the model call path and `.env` key loading; chat replies use the local responder (API teardown).

[Unreleased]: https://github.com/mwgrant21/Aether-OS/compare/v0.7.6...HEAD
[0.7.6]: https://github.com/mwgrant21/Aether-OS/compare/v0.7.5...v0.7.6
[0.7.5]: https://github.com/mwgrant21/Aether-OS/compare/v0.7.4...v0.7.5
[0.7.4]: https://github.com/mwgrant21/Aether-OS/compare/v0.7.3...v0.7.4
[0.7.3]: https://github.com/mwgrant21/Aether-OS/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/mwgrant21/Aether-OS/compare/v0.7.0...v0.7.2
[0.7.0]: https://github.com/mwgrant21/Aether-OS/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/mwgrant21/Aether-OS/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/mwgrant21/Aether-OS/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/mwgrant21/Aether-OS/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/mwgrant21/Aether-OS/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mwgrant21/Aether-OS/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mwgrant21/Aether-OS/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/mwgrant21/Aether-OS/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/mwgrant21/Aether-OS/releases/tag/v0.2.0
