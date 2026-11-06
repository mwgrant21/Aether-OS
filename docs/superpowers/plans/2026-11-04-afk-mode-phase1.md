# AFK / Overnight Mode, Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Matt can say "going to bed", get a text pre-flight in an ordinary Aether terminal, approve a night once, and leave behind one machine-readable thing Phase 2's runner can trust: a self-hashing approval record holding the confirmed items, the allowlist and the terms the night runs on, mirrored by a pointer. Nothing runs overnight yet. Phase 1 questions are asked, not resolved in state: an answered question runs tonight only if Matt edits the source line and re-runs `compile` BEFORE any `confirm` (Open item 11). Phase 1 has no add-item verb either (Open item 10).

**Architecture:** Dependency-free ESM modules in `scripts/afk/` (`.mjs`, Node builtins only, same shape as `scripts/aether-hook-emit.mjs`, shipped by the existing `scripts/**/*.mjs` `extraResources` rule; the skill template ships through one added `extraResources` entry, T19). One CLI, `scripts/afk/afk.mjs`, has read verbs anyone can run and write verbs that refuse to run without a real TTY. A skill, `skills/afk-preflight/SKILL.md` (copied into `~/.claude/skills` by `install-skill`, T19), drives the conversation (terms, compile, questions, feasibility, read-back) and tells Matt which TTY-gated command to type. State lives in `~/.aether-os/afk/`. No Electron, renderer, pty, or `.claude` config change (the one `electron-builder.yml` entry in T19 is packaging config, not Electron code).

**Tech Stack:** Node ESM (`.mjs`, builtins only), vitest (`// @vitest-environment node`), tests beside the modules as `scripts/afk/*.test.ts`.

**Spec:** `docs/superpowers/specs/2026-11-04-afk-mode-design.md` (approved by Matt 2026-11-04; sections 4-7, 10-12 govern this phase). Brainstorm record of what Matt said vs Claude's calls: `~/.claude/handoffs/aether-os/2026-11-04-afk-mode-brainstorm-notes.md`.

## Pinned ground

- Written against worktree `C:\Users\Matt\projects\aether-os\.worktrees\afk-design`, branch `docs/afk-mode-design`, HEAD `8ea6b53323326a7357fa6a3e6d182242158233b4` (the design doc commit, 1 ahead of origin/master, clean tree when this plan was written).
- `origin/master` = `dca17c627f4a819cda20a9e1976672f4ab45b131`. HEAD descends from it; the design commit touches docs only, so code here is identical to master.
- Builders: create `feat/afk-phase1` from the commit that contains this plan file. First command of every builder: `git merge-base --is-ancestor 8ea6b53 HEAD` must exit 0, else stop.
- Baseline: NOT RUN when this plan was written (the worktree has no `node_modules`). Builder runs `npm ci --ignore-scripts` (plain `npm ci` if node-pty fails to load), then `npx vitest run` once and quotes the counts before T1. Last count recorded elsewhere (stale, at 24611e3): 4214 pass / 17 skip / 0 fail.
- Scripts tests are collected twice: by the root vitest run and by `collector/vitest.config.ts` (`include: ['../scripts/**/*.test.ts']`). Every test here must pass under both (Node environment, builtins only).

## Global Constraints

- **No model calls, no `claude` launch, no `child_process`** anywhere in `scripts/afk/` (CLAUDE.md "Model calls"; `src/shared/noApiCalls.test.ts` scans `scripts/*.mjs`). No literal matching `/claude-[a-z]+-\d/` in non-test source. Pinned mechanically in T18.
- **`bypassPermissions` appears nowhere** in `scripts/afk/` or `skills/afk-preflight/` (design 12). Pinned in T18.
- **Node builtins only, ESM `.mjs`.** No npm dependency, no import from `src/`, `electron/` or `collector/` (the script runs as plain `node` spawned by Claude Code or PowerShell, outside the asar).
- **Injected clock.** Logic modules take `nowMs`; only `cli.mjs`/`afk.mjs` call `Date.now()`. Times are the machine's local time (design 12 "Clock").
- **Store the signal, not the payload** (docs/privacy-and-data.md). Persist item titles of at most 140 characters, `source.file` as a basename, `project` as the handoff folder name. Never an absolute path, never handoff body text.
- **Never read or print a secret value.** The feasibility probe reads key NAMES and reports booleans. Tests use a sentinel value and assert it never appears in output.
- **Writes only under `~/.aether-os/afk/`**, plus `install-skill` writing `~/.claude/skills/afk-preflight/SKILL.md` when Matt runs it. Tests ALWAYS use a temp home (`mkdtempSync`); a spawned CLI gets both `HOME` and `USERPROFILE` set. A test that touches the real home is a defect.
- **`delete` and `forcePush` can never be true** by any code path: not in the validator, not via amendment, not via `terms set` (T1, T3, T14, T17).
- **Fail closed.** Unreadable or invalid terms read as defaults with a warning. Unknown keys are rejected, not ignored. Because the defaults are permissive (`push: true`), `approve` refuses while the live terms file is unreadable (T15 `terms-invalid`), and `terms show` and `deny-rules` print the warning (T17); `terms set` rewrites a valid file.
- Every test file starts with `// @vitest-environment node` (root default is jsdom).
- `scripts/` is scanned by `electron/remote/noWildcardListener.test.ts` (no `.listen(`, no symlinks inside the repo tree). Do not add either.
- Commit with explicit paths: `git add -- <paths>` then `git commit -m "…" -- <paths>`. Never `git add -A`. End each message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Do not edit `~/.claude/settings.json` or any file under `~/.claude` except through the `install-skill` code path in a test with a temp home. Pasting the `protect` deny rules into settings is Matt's step (T21 M2); the allowlist is printed for his approval and stored in the approval record, and no Phase 1 code installs it anywhere.

## State machine (the whole of it)

State lives in four files under `~/.aether-os/afk/`: `terms.json` (live standing terms, T3), `draft.json` (the ONE draft, T14), `approved.json` (the ONE approved record, T12), `last-approved.json` (a pointer mirroring the record's hash, T12).

1. **One draft slot.** `compile` replaces `draft.json` wholesale: fresh items, nothing confirmed, no amendments. `confirm` and `amend` (TTY) edit only the draft.
2. **One approved record.** `approve` (TTY) re-checks every confirmed item now, prints the summary, and on the typed phrase writes `approved.json` (items, held, allowRules, STANDING terms = the live file before any amendment, the one-night amendments, EFFECTIVE terms, target window, `recordSha256`) and then the pointer. A new approval replaces the old one.
3. **`resolveNightPlan`.** A record that verifies (hash, pointer, terms) and whose target window is current (at most 12h past its start) is `approved`, and the draft is never read. Otherwise a current draft with confirmed items, compiled after that record's approval (`draft.createdAtMs > record.approvedAtMs`: the draft an approval was made from is never its own unfinished night, even when a `window` amendment moved the approved night's target), plus a verifying last record is `unfinished`: the record's STANDING terms, the confirmed items that still re-check. Otherwise `none`. Both kinds return `targetWindowStartMs` (the window the plan is FOR; `null` for `none`), so a caller can tell "tonight's window has not opened" from "tonight's window passed" without recomputing it (`windowFor(now)` points at tomorrow after 07:00).
4. **Fail closed.** Any record, pointer or terms check that fails is `none` with the reason. A crash between the record write and the pointer write reads as a pointer failure until `approve` is run again.

## Review Focus

1. **An approved night is read from `approved.json` alone, and nothing can demote or widen it.** The record hashes itself over everything Phase 2 uses, the pointer mirrors that hash, and a failure of either is `none`. A later `compile`, a live-window edit or a tampered `draft.json` cannot touch it. Pinned in T12 (tamper cases) and T16 (a), (b), (g).
2. **An unfinished pre-flight runs on the STORED standing terms** (the live file as it was at the last approval, before any one-night amendment), for confirmed items only. Never on live terms, never on an unconfirmed amendment, never on a prior night's amended terms. Pinned in T16 (c), (d), (e).
3. **A confirmation only counts against a verdict and feasibility result that still hold.** `compile` drops every confirmation; `confirm`, `approve` and the unfinished path re-check each confirmed item at that moment (verdict `ready`, plan and spec still approved, build items feasible). Pinned in T14, T15 (h) and T16.
4. **TTY gate.** `confirm`, `amend`, `approve`, `terms set` exit 3 and write nothing without a TTY on stdin and stdout. Pinned in T15 and T17 (spawned process, piped stdio).
5. **Classifier conservatism and the "decided" test.** Any `?` or marker word makes an item a question; barred wins over question; unchecked plan checkboxes are NOT evidence of undone work (every shipped plan in this repo has 0 checked boxes). Pinned in T7 and T10.
6. **No secret values leave the feasibility probe**, including via error strings. Pinned in T9.
7. **The allowlist Matt approves is the allowlist stored**, built from the confirmed items only, with both of its limits printed beside it. Pinned in T15.
8. **Staleness is judged against the window Matt actually set, and the window a plan targets is returned.** `compile` passes the live terms window; amending `window` recomputes the draft's `targetWindowStartMs`; `resolveNightPlan` returns the target (an unfinished night's follows the STANDING window, not an unconfirmed window amendment), and `approve` refuses a draft whose target window is already stale and prints the window the approval runs in. Pinned in T14, T15, T16 and T17.
9. **Questions are never resolved in state.** There is no transition from `question` to `ready` in Phase 1: Matt settles a question by editing the source line, and `compile` re-classifies it from scratch before any `confirm`. The agent never edits or rewords a source line to clear a `?`. Pinned in T19 (template test) and by the absence of any such verb in T17.

## Decisions (each answers one of the six planning questions; evidence is file:line at the pinned commit)

**D1. Standing terms: where, who writes.**
- Live file: `~/.aether-os/afk/terms.json`, a strict `v:1` object (T1). It follows the single-owner settings pattern: one module owns the file, fail-closed read, atomic tmp-then-rename write, readback returned instead of the requested value (`electron/controlSettings.ts:10-17` file and shape, `:25-31` fail-closed read, `:65-97` atomic write plus readback; `electron/collectorSettings.ts:36-51`). The dir is `aetherOsDir = ~/.aether-os` (`electron/main.ts:421`), made user-only by `ensurePrivateDir` (`electron/main.ts:956`).
- Deviation from that pattern, on purpose: the owner is `scripts/afk/termsStore.mjs`, not `electron/afkSettings.ts`, because the writer is a CLI Matt runs in a terminal, not the Electron main process, and `scripts/*.mjs` already write `~/.aether-os` (`scripts/aether-hook-emit.mjs`, spool). Phase 2's supervisor will read it; it will not write it.
- Who may write: only `afk terms set`, which needs a TTY (D2); the other TTY verbs write only the draft and the approved record. Agents are blocked by two layers: the TTY gate, and the `protect` group of the deny list (`buildDenyRules(...).protect`, T11: exactly `Edit/Write(~/.aether-os/afk/**)` and `Edit/Write(~/.claude/away*)`) that Matt pastes into global settings (T21 M2). Only that group: the `run` group (delete verbs, force-push) would block the builder and worktree-cleanup loops in every interactive session and is Phase 2's per-run disallow list. Until Matt installs `protect`, only the TTY gate protects an interactive session; this is stated in RISKS, not hidden.
- The file is NOT under `.claude`. Evidence: headless Claude Code hard-denies Write/Edit on any path with a `.claude` segment (`agent-improvement/scripts/away-cmd.ps1:9-15`), so the prototype's `~/.claude/away.json` could not hold a grant that workers must read but never write.
- Snapshot: at `approve`, the record in `~/.aether-os/afk/approved.json` carries the STANDING terms (this file as it was, before any one-night amendment) and the EFFECTIVE terms (T12). There is no separate snapshot file: the record hashes itself and a pointer mirrors the hash. The night runs on those terms (Phase 2); an unfinished pre-flight runs on the stored standing terms.

**D2. How the text-first pre-flight runs in today's terminals.**
- Smallest mechanism: a CLI (`scripts/afk/afk.mjs`) plus a skill (`skills/afk-preflight/SKILL.md`). Aether terminals are plain PowerShell PTYs with `claude` typed into them (`electron/ptyManager.ts:10-12` `buildClaudeLaunchCommand`, `:57` `launchLine`, `:67-82` `spawnPty`); the agent already has Bash, so a skill that calls a CLI needs no Aether code change at all. The repo already ships a skill the same way (`skills/aether-cross-check/SKILL.md`, copied by hand into `~/.claude/skills/`); `install-skill` (T19) automates the copy, bakes in the CLI path, and finds the template beside the scripts in both the repo and the packaged layout (`extraResources`, T19; the current config ships nothing under `skills/`).
- Matt's confirmations go through the TTY-gated verbs so the agent cannot approve on his behalf. `process.stdin.isTTY && process.stdout.isTTY` is false for an agent's Bash tool call. That is a guard against accident and drift, not a sandbox. UNVERIFIED: whether the claude TUI's `!` shell escape has a TTY; T13 measures it with a one-line probe BEFORE T15 (the answer decides where Matt types `confirm`/`approve`, so it must not wait for the last task), and T21/M1 re-checks it with the real CLI. If it does not, Matt runs the gated verbs in a plain PowerShell window (the Aether-hosted slots all run `claude`, so a second shell is not available inside Aether without `/exit`).
- Trigger in Phase 1: Matt types `/afk-preflight`, or the skill's description matches his phrases (model-judged; best effort). The rules-first phrase detector with the tense guard is Phase 4 (design-kit part 7, line 232, `electron/control/inputRouter.ts`). This is a stated gap, not an equivalent.
- Rejected: (a) a `UserPromptSubmit` hook injecting context: hooks cannot hold a question-and-answer round and the detector is Phase 4; (b) Aether main writing the pre-flight into the pty through `terminalHub.writePort()` the way AetherChoice writes `/effort`: needs idle detection and screen watching, touches `main.ts`, and sits in the aether-gui lane; (c) an MCP tool server like `aether-data` (`electron.vite.config.ts:12`, `electron/dashboards/dataServerEntry.ts`): needs a new build entry and `claude mcp add`, adds nothing over CLI plus skill in Phase 1; (d) a slash-command file under `~/.claude/commands`: equivalent to the skill, but the repo has a `skills/` precedent and no commands one.

**D3. Night-list compiler: parse rules and the "decided" test (design 12).**
- Sources per project folder name (the handoff skill names it as the repo folder name): (1) the newest eligible handoff in `~/.claude/handoffs/<project>/`: file mtime within `maxAgeDays` (default 3), name not starting `ledger-|verdict-|scratch-|debug-`, containing a `## Next steps` heading; Matt may name more with `--handoff`. Items are the numbered lines under that heading until the next heading of level 1-2. (2) The newest `ledger-*.md`: lines `- [todo] …` and `- [pending …] …`. (3) Plans: only when a handoff/ledger item names the plan file, or Matt passes `--plan`. A plan's checkboxes are NOT read as progress: `docs/superpowers/plans/2026-10-12-dashboards.md` has 74 unchecked and 0 checked boxes and shipped as PR #119 (git `c4344ae`, "feat: Boards - Claude-authored dashboards over collector.db (#119)", which adds the plan file); `2026-09-30-real-severity.md` has 77/0, `2026-09-29-readiness-pass.md` 57/0.
- **Decided** means all of: it comes from one of those sources; its text carries no question or needs-Matt marker; it is not barred (delete, force-push, cleanup); if it references a plan, that plan's linked spec (`**Spec:**` line) has a Status line that says approved (not draft/awaiting/superseded) in its first 15 lines; and, for an APK/installer item, the feasibility check passes. Matt's per-item `confirm` at pre-flight is the final gate; nothing runs unconfirmed.
- Verdicts: `ready`, `question` (becomes a clarifying question), `barred` (never goes on the night; reported as cleanup/needs-Matt). Scope is explicit `--project` names; deriving them from the running terminals (design 12) is deferred to Phase 2, where Aether knows its terminals (UNVERIFIED mapping; the prototype's `session-pids/<id>.json` carries `cwd`).
- Stale-handoff risk: several handoffs in a lane can all carry Next steps, and nothing marks an old one DONE. Taking only the newest per project plus explicit `--handoff` is the conservative rule; Matt's confirmation catches the rest.

**D4. Feasibility check (design 7 step 4) and recipe table.** Phase 1 recipes exist only for the artifacts Matt named (APK, EXE/installer). Preconditions are probed by presence only. The commands are data for Phase 2; Phase 1 never runs them.

| Project | Artifact | cwd | Command | Preconditions probed (presence only) | Evidence |
|---|---|---|---|---|---|
| aether-os | installer | `.` | `npm run dist -- -c.directories.output={SCRATCH}` | `{SCRATCH}` supplied by the runner and outside any checkout the running dev instance watches | `CLAUDE.md` Run/test/build (`npm run dist`); `docs/packaging.md:15`; memory `aether-os-package-build-outside-dev-tree`. Arg forwarding through `npm run dist --` is UNVERIFIED on this install |
| aether-os | apk (aethermobile) | `android` | `gradlew.bat assembleDebug -PAETHER_TITAN_TAILNET_IP=100.84.175.105` | `local.properties` or env has `AETHER_KEYSTORE_PATH` (file exists), `AETHER_KEYSTORE_PASSWORD`, `AETHER_KEY_ALIAS`, `AETHER_KEY_PASSWORD`; `sdk.dir` | `android/app/build.gradle:12-19` (signing keys), `:25` (IP property), `:120-130` (release-only IP guard: a build without it silently yields an APK that says "TITAN ADDRESS NOT CONFIGURED"), `:143-151` (every package/sign/bundle task, any variant, needs the signing keys); memory `aether-android-titan-ip-build-prop`. Debug vs release as "the expected APK" is UNVERIFIED (Matt's call) |
| TarotApp | apk | `.` | `gradlew.bat assembleDebug` | none documented | `TarotApp/README.md:102-109`; phone is debug-signed (memory `tarotapp-phone-debug-signed`). Installing to the phone is never part of a night: "ready to install" is the goal |
| TokenMonitor | installer | `.` | `npm run dist` | file `codesign/pfx-password.txt` exists (presence only, never read) | `TokenMonitor/CLAUDE.md:25-36`. The PDQ deploy that `dist` mentions is outside the grant and not part of the recipe |

Projects with NO documented build recipe, so an APK/EXE item for them is held (`no build recipe`): MobileCrawler (Godot 4.7.2 export; CLAUDE.md:7,41 say paths live in Editor Settings and no export command is written down; Claude works in `MobileCrawler-t5`), nmmtools (`build.ps1` makes a script artifact, not an APK/EXE; tests must not run on the workstation, `nmmtools/CLAUDE.md:14-16`), tarot, Miriels-publish, TokenMonitorV2, uigen, cve-desk, and the rest of `~/projects`. Adding a row is a one-line change in `recipes.mjs`.

**D5. Aether-OS app vs the aether-gui lane.** Phase 1 touches NO file the lane owns. New files only: `scripts/afk/`, `skills/afk-preflight/`; plus one added `extraResources` entry in `electron-builder.yml` (T19: packaging config so the skill template ships, not Electron code, and not a file the lane owns); plus three shared doc files (`CLAUDE.md`, `PROGRESS.md`, `docs/privacy-and-data.md`) that the lane also edits, so T20 should rebase on master immediately before it commits, and one sentence in `docs/packaging.md` (T20). The lane owns (design-kit-v1 part 7, lines 231-245; aetherchoice host spec): phrase detection in `electron/control/inputRouter.ts` (design-kit line 232), the thread host and AetherChoice (`electron/aetherChoice/`, with `awayMode(): boolean` at `applyEngine.ts:50` stubbed `() => false` at `pickHost.ts:229`), and the away banner, possible-away timer and return-summary UI (Phase 3-4). The Aether-OS side owns the supervisor, runner, delete queue and morning-report data (Phase 2-3, future `electron/afk/`). Phase 1 can therefore run in parallel with the lane's open PRs (they touch `main.ts`, `ptyManager.ts`, `terminalHub.ts`; this plan touches none). Phase 2 must wire `awayMode` through `runtime.ts`: coordinate with the lane then.

**D6. Prototype status and reuse** (`agent-improvement`, read at its `master` 69c8f59).
- `away-t1-lib` through `away-t5-prekill` are ancestors of master. `away-t6-handoff-write` is not an ancestor, but its single unique commit `22bd64f` has an identical added/removed-line set to master's `58553ce` (same subject; compared by hashing the sorted diff lines), so its content landed. The runner is DRY-RUN ONLY: live cycles print "not implemented" (`scripts/away-runner.ps1:66`).
- **Phase 1 reuses (as knowledge or vocabulary, not code):** the delete-verb entries and the `Edit/Write(~/.claude/away*)` entries of the deny list (`away-cmd.ps1:27-39`) feed `buildDenyRules` (T11, the `run` group); the finding that `.claude` paths are never writable headless (`away-cmd.ps1:9-15`) decides where the terms live (D1) and tells Phase 2 that workers write handoffs to `~/away-handoffs/<leaf>/` (`away-cmd.ps1:20-22`); the measured cost of about $0.30 per cold `claude -p` turn (`away-runner.ps1:7-9`) informs Phase 2 budgets.
- **Phase 1 must NOT reuse:** `~/.claude/away.json` as a grant store (wrong location, holds run state not authority); the prototype's blanket denial of `git push`, `git merge`, `gh`, `git checkout`, `git switch`, `git stash`, `git worktree` (`away-cmd.ps1:27-37`): design 5 and 11 supersede it (push and merge are allowed), so `buildDenyRules` denies pushes only when `terms.push` is false; `Get-AwayPaths`/`Write-AwayState` (they write under `.claude`); any `claude -p` exit-code branching (the prototype measured exit 0 on failure, `away-runner.ps1:11-13`). `pre-kill-check.ps1`, `away-relaunch.ps1` and `session-pid-onstart.mjs` are Phase 2 supervisor references with no Phase 1 use.
- No PowerShell is written in Phase 1, so `~/.claude/rules/powershell.md` and `ps51-verifier` are not triggered. If Phase 2 reuses the `.ps1` scripts, they must follow it.

**D7. Permission mode and allowlist (design 12 "Enforcement is layered"; added after review, Matt's call 2026-11-04: build a minimal one now, do not defer).** Design 12 requires permission mode + an explicit allowlist + a deny list, with the allowlist approved up front because there is no human at 3am. Phase 1 builds the allowlist as data: `buildAllowRules(terms, items)` (T11). The T15 approve summary prints it, so Matt approves the exact rules, and the approval record stores it (`allowRules`), so Phase 2 uses what he saw and not a recomputation. Derivation: (a) read-only git/gh needs, always; (b) `git push` only when `terms.push`; `git merge --ff-only` only when `terms.merge === 'gated'`; (c) per confirmed build item, the command prefix of its recipe (the leading argv tokens before the first `-` flag, e.g. `npm run dist`, `gradlew.bat assembleDebug`). What it does NOT do: it does not choose the permission mode, it does not derive the Edit/Write/test rules that `work` and `plan` items need (handoff text does not name them; Phase 2 decides; Matt's direction 2026-11-05: `acceptEdits` scoped to the item's worktree, Open item 7), and a string in a list is not enforcement. **UNVERIFIED until T21 M2/M5:** (1) that a headless `claude -p` run with an allowlist denies an unlisted call instead of hanging on a prompt; (2) the flag names `--permission-mode`, `--allowedTools`, `--disallowedTools` on the installed version; (3) that a deny rule beats the existing global `allow` entries in `~/.claude/settings.json`; (4) how `Bash(prefix:*)` rules treat compound commands (`cd x && cmd`); (5) that the recipe prefixes match how Phase 2 will actually invoke the build; (6) that `Bash(...)` rules cover the PowerShell tool this machine also has: M2 runs `git branch -D` and `Remove-Item` through EACH tool, and if the PowerShell tool is not covered, `buildDenyRules` must emit mirrored PowerShell rules (a follow-up change to T11, syntax taken from what M2 observes) and privacy section 19 says so. Delete and force-push are barred in the terms, but the rules that enforce that rest on this untested path until M2 runs. Open item 7.

## Interfaces Phase 1 exposes to Phase 2

Phase 2 imports these three things. Everything else in `scripts/afk/` is internal to Phase 1.

| Interface | Module | Contract |
|---|---|---|
| **What to run tonight** | `resolvePlan.mjs` `resolveNightPlan({aetherDir, homeDir, repoRoots?, probes?, nowMs})` (the optional two default to the real probes) | `{kind:'approved'\|'unfinished'\|'none', nightId, targetWindowStartMs, terms, termsSha256, items, held, allowRules, reason}`; never throws. `items[]` = `{id,project,kind,artifact,title,source}`, `held[]` = `{id,title,verdict,reason}`. `approved`: all of it from the verified `approved.json` (`targetWindowStartMs` is the record's). `unfinished`: `terms` are the stored STANDING terms of the last approval, `items` the confirmed items that still re-check, `allowRules` recomputed for them by `unfinishedSelection` (T16; `confirm` prints the same list, Open item 9), `targetWindowStartMs` the draft's target re-anchored to the standing window (T16). `none`: `items` and `allowRules` empty, `targetWindowStartMs` and `nightId` null, `reason` says why. `nightId` is an audit label only (the record's id, or the draft's label for `unfinished`); nothing is keyed on it |
| **Enforcement vocabulary** | `denyRules.mjs` `buildDenyRules(terms): {protect, run}`, `buildAllowRules(terms, items)` | Permission-rule strings. `protect` = the four afk-dir/away path rules (installed globally by Matt); `run` = delete verbs, force-push, conditional push/merge (Phase 2's per-run disallow list, never global). The allowlist is data only: how a headless run treats it is UNVERIFIED until T21 M5 |
| **Build recipes** | `recipes.mjs` `getRecipe(project, artifact)` | `{cwd, argv, requires, evidence, verified}` |

**Time contract for Phase 2** (the result has no "started" state; the caller owns it): (1) call `resolveNightPlan` ONCE at window start and persist what it returned; do not re-resolve to decide what is running. (2) One run per `targetWindowStartMs`: Phase 2 marks that window started, and a second call that returns the same `targetWindowStartMs` must not start a second run. `nightId` is an audit label for logs and the morning report only: for `unfinished` it is the draft label, which every `compile` replaces while the target stays the same, so it cannot be the run-once key. (3) `isNightCurrent`'s 12h grace means "may still START", not "may keep running": design 8 lets work continue past 07:00 with no cap, so a relaunch after the grace sees `none` and re-resolving between 07:00 and the grace end returns the same plan again; neither says whether a run is in progress or done. (4) Compare `now` with `targetWindowStartMs` to tell "window not yet open" (`now` before it) from "window open or passed".

Phase 2 adds `.d.mts` declarations beside these files when `electron/` first imports them (precedent: `scripts/sync-severity-core.d.mts`); Phase 1 documents shapes with JSDoc `@typedef`.

## File map

| File | Responsibility |
|---|---|
| `scripts/afk/terms.mjs` (+test) | Terms schema, defaults, validation, amendments, canonical hash |
| `scripts/afk/fsJson.mjs` (+test) | Safe JSON read, atomic write |
| `scripts/afk/termsStore.mjs` (+test) | The live terms file: single owner |
| `scripts/afk/nightWindow.mjs` (+test) | Night label, window maths |
| `scripts/afk/parseSources.mjs`, `planRefs.mjs`, `classify.mjs` (+tests) | Handoff and ledger parsers, spec-approved test, the "decided" classifier |
| `scripts/afk/recipes.mjs`, `feasibility.mjs` (+tests) | Build recipe table, presence-only probes |
| `scripts/afk/compileNightList.mjs` (+test) | Compiler |
| `scripts/afk/denyRules.mjs` (+test) | Deny-rule and allow-rule builders |
| `scripts/afk/approval.mjs` (+test) | The self-hashing approved record and its pointer |
| `scripts/afk/draft.mjs` (+test), `scripts/afk/draftFixture.ts` | The one draft: replace, confirm, amend, re-check; the fixture is shared test setup for T14, T15, T16 (not a test file, so not collected) |
| `scripts/afk/approveFlow.mjs` (+test) | Approval flow, TTY and phrase gate |
| `scripts/afk/resolvePlan.mjs` (+test) | `resolveNightPlan` and `unfinishedSelection` (the one computation of an unfinished night's terms, items, held and allowlist) |
| `scripts/afk/cli.mjs`, `afk.mjs` (+test) | Verb dispatch and the executable entry; `confirm` prints the unfinished-night allowlist via `unfinishedSelection` |
| `scripts/afk/afkBoundary.test.ts` | Guard test for the directory |
| `scripts/afk/installSkill.mjs` (+test), `skills/afk-preflight/SKILL.md`, `electron-builder.yml` (one `extraResources` entry) | Skill, installer, and the packaging entry that ships the template |
| `docs/privacy-and-data.md`, `docs/packaging.md`, `CLAUDE.md`, `PROGRESS.md` | Document the new persisted state and the shipped template |

## Order and parallelism

Dependencies (each task's Consumes line lists exactly its own): T2 none; T3 <- T1, T2; T4 none; T5, T6, T7, T8 none; T9 <- T8; T10 <- T4, T5, T6, T7, T8; T11 <- T1, T8; T12 <- T1, T2, T3; T13 none (Matt, no code); T14 <- T1, T2, T3, T4, T9, T10; T15 <- T1, T3, T4, T11, T12, T14; T16 <- T1, T4, T9, T11, T12, T14, T15; T17 <- T1, T3, T4, T9, T10, T11, T12, T14, T15, T16; T18 <- T17; T19 <- T17; T20, T21 last.

Sequential spine, which is also numeric order: T1 -> T2 -> T3 -> T4 -> T5 -> T6 -> T7 -> T8 -> T9 -> T10 -> T11 -> T12 -> T13 -> T14 -> T15 -> T16 -> T17 -> T18 -> T19 -> T20 -> T21. T13 (Matt's two-minute TTY probe, no code) can run any time before T15; its answer is wanted by T15's refusal wording and T19's skill step 7. Safe in separate worktrees, disjoint files, merge in numeric order: T5, T6, T7 and T8 -> T9 (all independent of the rest of the spine), and T11 (after T8) and T12 (after T3). Subagent-driven execution is sequential by default: follow numeric order unless dispatching those groups in parallel.
---

### Task 1: Terms schema

**Files (all created, except where an Interfaces line says modified):**
```owned T1
scripts/afk/terms.mjs
scripts/afk/terms.test.ts
```

**Interfaces:**
- Produces: `DEFAULT_TERMS` (deep-frozen), `AMENDABLE_KEYS = ['window','push','merge','codexReviewsPerPush','opusEscalation','fableElevation']`, `validateTerms(input: unknown): {ok:true; terms} | {ok:false; errors: string[]}`, `applyAmendments(base, patch): same result shape`, `canonicalJson(value): string` (keys sorted recursively), `canonicalSha256(value): string` (hex SHA-256 of `canonicalJson`; T12 hashes its record with it), `termsSha256(terms) = canonicalSha256(terms)`.
- Shape: `{v:1, window:{start:'HH:MM', end:'HH:MM'}, push:boolean, merge:'gated'|'off', delete:false, forcePush:false, codexReviewsPerPush:0..3 integer, opusEscalation:boolean, fableElevation:boolean, notifications:'silent'}`. Exactly these keys; unknown keys rejected.
- Rules: `start !== end`; `fableElevation` requires `opusEscalation` (design 5: Fable follows three failed Opus reviews; this is Claude's call, kept by Matt 2026-11-05, Open item 3); `codexReviewsPerPush` capped at 3 (Matt approved up to 3); `delete`/`forcePush` must be exactly `false` (force-push counts as delete; design 13 open item, kept barred). `merge:'gated'` means only with a refuter ACCEPT for the exact head via merge-gate (design 5); the flag is a promise Phase 2 enforces.
- `applyAmendments` only accepts `AMENDABLE_KEYS` (a whole `window` object, not a half), returns a new object, and re-runs `validateTerms` on the result.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMS, applyAmendments, canonicalSha256, termsSha256, validateTerms } from './terms.mjs';
const w = (over: Record<string, unknown>) => ({ ...DEFAULT_TERMS, ...over });
describe('DEFAULT_TERMS', () => {
  it('matches design section 5 and is frozen', () => {
    expect(DEFAULT_TERMS).toMatchObject({
      window: { start: '01:00', end: '07:00' }, push: true, merge: 'gated', delete: false, forcePush: false,
      codexReviewsPerPush: 3, opusEscalation: false, fableElevation: false, notifications: 'silent',
    });
    expect(Object.isFrozen(DEFAULT_TERMS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TERMS.window)).toBe(true);
  });
});
describe('validateTerms', () => {
  it('accepts the defaults', () => {
    const r = validateTerms(structuredClone(DEFAULT_TERMS));
    expect(r.ok && r.terms).toEqual(DEFAULT_TERMS);
  });
  it.each([
    ['delete true', w({ delete: true }), 'delete'],
    ['forcePush true', w({ forcePush: true }), 'forcePush'],
    ['4 reviews', w({ codexReviewsPerPush: 4 }), 'codexReviewsPerPush'],
    ['fractional reviews', w({ codexReviewsPerPush: 1.5 }), 'codexReviewsPerPush'],
    ['bad clock', w({ window: { start: '25:00', end: '07:00' } }), 'window'],
    ['zero-length window', w({ window: { start: '01:00', end: '01:00' } }), 'window'],
    ['fable without opus', w({ fableElevation: true, opusEscalation: false }), 'fableElevation'],
    ['unknown key', w({ bypassPermissions: true }), 'bypassPermissions'],
    ['loud notifications', w({ notifications: 'toast' }), 'notifications'],
    ['bad merge mode', w({ merge: 'always' }), 'merge'],
    ['missing key', (() => { const { push: _p, ...rest } = DEFAULT_TERMS; return rest; })(), 'push'],
    ['not an object', 'x', 'object'],
    ['array', [], 'object'],
  ])('rejects %s', (_n, input, key) => {
    const r = validateTerms(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain(key);
  });
});
describe('applyAmendments', () => {
  it('applies an amendable key without mutating the base', () => {
    const r = applyAmendments(DEFAULT_TERMS, { opusEscalation: true, window: { start: '00:30', end: '06:00' } });
    expect(r.ok && r.terms.opusEscalation).toBe(true);
    expect(r.ok && r.terms.window.start).toBe('00:30');
    expect(DEFAULT_TERMS.opusEscalation).toBe(false);
  });
  it.each(['delete', 'forcePush', 'notifications', 'v'])('refuses to amend %s', (k) => {
    const r = applyAmendments(DEFAULT_TERMS, { [k]: k === 'v' ? 2 : true });
    expect(r.ok).toBe(false);
  });
  it('re-validates the merged result (fable on with opus off)', () => {
    expect(applyAmendments(DEFAULT_TERMS, { fableElevation: true }).ok).toBe(false);
    expect(applyAmendments(DEFAULT_TERMS, { fableElevation: true, opusEscalation: true }).ok).toBe(true);
  });
});
describe('termsSha256', () => {
  it('ignores key order and changes with any value', () => {
    const a = termsSha256(DEFAULT_TERMS);
    const reordered = Object.fromEntries(Object.entries(DEFAULT_TERMS).reverse());
    expect(termsSha256(reordered as typeof DEFAULT_TERMS)).toBe(a);
    expect(termsSha256({ ...DEFAULT_TERMS, push: false })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalSha256({ b: { y: 1, x: 2 }, a: [1] })).toBe(canonicalSha256({ a: [1], b: { x: 2, y: 1 } }));   // nested key order is ignored too
  });
});
```

Carry (build review): `terms.mjs` should clone its input first and use `Object.hasOwn` for key checks, so a hostile or inherited key (`__proto__`, `constructor`) is never trusted; pin that with a test.

- [ ] **Steps 2-5:** run `npx vitest run scripts/afk/terms.test.ts` (expect FAIL: cannot resolve the module). Implement `terms.mjs` to the interface above. Deep-freeze the defaults. No logic beyond the stated rules. Rerun (expect PASS). Commit: `git add -- scripts/afk/terms.mjs scripts/afk/terms.test.ts && git commit -m "feat(afk): standing terms schema, validation and amendments" -- scripts/afk/terms.mjs scripts/afk/terms.test.ts`.

---

### Task 2: Safe JSON file helpers

**Files (all created, except where an Interfaces line says modified):**
```owned T2
scripts/afk/fsJson.mjs
scripts/afk/fsJson.test.ts
```

**Interfaces:**
- Produces: `readJsonSafe(path): {ok:true; value} | {ok:false; reason:'missing'|'unreadable'|'invalid-json'}` (never throws); `writeJsonAtomic(path, value): void` (creates parents, writes a sibling `*.afktmp-<pid>-<hex>` then renames over the target, removes the tmp on failure, **throws** if the target is a symlink). There is no write-once helper: the approved record is replaced by design (T12) and `readApproved` verifies it instead.
- Notes: JSON is written as `JSON.stringify(value, null, 2) + '\n'`, UTF-8, no BOM. Symlink refusal exists because the atomic replace would otherwise swap a link for a regular file (memory `atomic-file-replace-edge-cases`); the afk dir is Aether's own, so refusing is simpler than following.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './fsJson.mjs';
const tmp = () => mkdtempSync(join(tmpdir(), 'afk-fsjson-'));
describe('readJsonSafe', () => {
  it('reports missing, invalid-json and ok without throwing', () => {
    const d = tmp();
    expect(readJsonSafe(join(d, 'nope.json'))).toEqual({ ok: false, reason: 'missing' });
    writeFileSync(join(d, 'bad.json'), '{oops');
    expect(readJsonSafe(join(d, 'bad.json'))).toEqual({ ok: false, reason: 'invalid-json' });
    writeFileSync(join(d, 'ok.json'), '{"a":1}');
    expect(readJsonSafe(join(d, 'ok.json'))).toEqual({ ok: true, value: { a: 1 } });
  });
});
describe('writeJsonAtomic', () => {
  it('creates parents, replaces the file and leaves no temp file', () => {
    const d = tmp();
    const p = join(d, 'a', 'b', 'x.json');
    writeJsonAtomic(p, { n: 1 });
    writeJsonAtomic(p, { n: 2 });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ n: 2 });
    expect(readdirSync(join(d, 'a', 'b'))).toEqual(['x.json']);
  });
  it('refuses a symlink target', (ctx) => {
    const d = tmp();
    writeFileSync(join(d, 'real.json'), '{}');
    try { symlinkSync(join(d, 'real.json'), join(d, 'link.json')); } catch { ctx.skip(); return; }
    expect(() => writeJsonAtomic(join(d, 'link.json'), { n: 1 })).toThrow(/symlink/i);
  });
});
```

Carry (build review): `readJsonSafe` has no size cap and no symlink check; a huge or symlinked file is read as-is. Matt decides whether Phase 1 adds a cap and an `lstat` check or leaves this as a known gap (the directory is Matt's own).

- [ ] **Steps 2-5:** run `npx vitest run scripts/afk/fsJson.test.ts` (expect FAIL: cannot resolve the module). Implement `fsJson.mjs` to the interface. Rerun (expect PASS; the symlink case may report skipped without symlink rights, say so in the report). Commit: `git add -- scripts/afk/fsJson.mjs scripts/afk/fsJson.test.ts && git commit -m "feat(afk): safe JSON read and atomic write helpers" -- scripts/afk/fsJson.mjs scripts/afk/fsJson.test.ts`.

---

### Task 3: Live terms store (the single owner)

**Files (all created, except where an Interfaces line says modified):**
```owned T3
scripts/afk/termsStore.mjs
scripts/afk/termsStore.test.ts
```

**Interfaces:**
- Consumes: `validateTerms`, `DEFAULT_TERMS` (T1); `readJsonSafe`, `writeJsonAtomic` (T2).
- Produces: `afkDir(aetherDir) = join(aetherDir,'afk')`, `termsPath(aetherDir) = join(afkDir,'terms.json')`, `readLiveTerms(aetherDir): {terms, source:'file'|'defaults', warnings: string[]}` (never throws; missing file = defaults with no warning; unreadable, invalid JSON or invalid terms = defaults plus one warning naming the reason, never the file content), `writeLiveTerms(aetherDir, terms): {ok:boolean; terms; errors: string[]}` (validates first; invalid input writes nothing; returns the READBACK from disk, following the `controlSettings.ts:65-97` rule).

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_TERMS } from './terms.mjs';
import { readLiveTerms, termsPath, writeLiveTerms } from './termsStore.mjs';
const tmp = () => mkdtempSync(join(tmpdir(), 'afk-terms-'));
const put = (dir: string, text: string) => { mkdirSync(dirname(termsPath(dir)), { recursive: true }); writeFileSync(termsPath(dir), text); };
describe('readLiveTerms', () => {
  it('missing file reads as defaults with no warning', () => {
    expect(readLiveTerms(tmp())).toEqual({ terms: DEFAULT_TERMS, source: 'defaults', warnings: [] });
  });
  it('corrupt JSON fails closed to defaults with a warning', () => {
    const d = tmp(); put(d, '{nope');
    const r = readLiveTerms(d);
    expect(r.source).toBe('defaults'); expect(r.terms).toEqual(DEFAULT_TERMS); expect(r.warnings.length).toBe(1);
  });
  it('a file that tries delete:true fails closed to defaults', () => {
    const d = tmp(); put(d, JSON.stringify({ ...DEFAULT_TERMS, delete: true }));
    const r = readLiveTerms(d);
    expect(r.terms.delete).toBe(false); expect(r.source).toBe('defaults'); expect(r.warnings.join(' ')).toContain('delete');
  });
});
describe('writeLiveTerms', () => {
  it('round-trips and returns the readback', () => {
    const d = tmp();
    const r = writeLiveTerms(d, { ...DEFAULT_TERMS, codexReviewsPerPush: 2 });
    expect(r.ok).toBe(true); expect(r.terms.codexReviewsPerPush).toBe(2);
    expect(readLiveTerms(d)).toMatchObject({ source: 'file', terms: { codexReviewsPerPush: 2 } });
  });
  it('writes nothing for invalid terms', () => {
    const d = tmp();
    const r = writeLiveTerms(d, { ...DEFAULT_TERMS, forcePush: true });
    expect(r.ok).toBe(false); expect(r.errors.join(' ')).toContain('forcePush');
    expect(existsSync(termsPath(d))).toBe(false);
  });
});
```

Carry (build review): `readLiveTerms` echoes unknown keys from the file (decide: drop them or surface them as a warning; do not pass them through silently). `writeLiveTerms` throws on EPERM (and other fs errors); T17 must wrap every call and turn the throw into a clean exit with a message that carries no file content.

- [ ] **Steps 2-5:** run `npx vitest run scripts/afk/termsStore.test.ts` (expect FAIL: cannot resolve the module). Implement `termsStore.mjs`. Rerun (expect PASS). Commit: `git add -- scripts/afk/termsStore.mjs scripts/afk/termsStore.test.ts && git commit -m "feat(afk): live standing-terms store with fail-closed read" -- scripts/afk/termsStore.mjs scripts/afk/termsStore.test.ts`.

---

### Task 4: Night label and window maths

**Files (all created, except where an Interfaces line says modified):**
```owned T4
scripts/afk/nightWindow.mjs
scripts/afk/nightWindow.test.ts
```

**Interfaces:**
- Produces: `newNightId(nowMs): string` (local time, `n20261104T231509`; a display label only, nothing is keyed or looked up by it); `windowFor(nowMs, {start,end}): {startMs, endMs}` = the window containing `nowMs`, else the next one (an `end <= start` window crosses midnight; `nowMs === endMs` counts as over); `GRACE_MS = 12*3600*1000`; `isNightCurrent(nowMs, targetWindowStartMs, graceMs = GRACE_MS): boolean` = `nowMs <= target + graceMs`.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isNightCurrent, newNightId, windowFor } from './nightWindow.mjs';
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const W = { start: '01:00', end: '07:00' };
describe('newNightId', () => {
  it('formats local time', () => {
    expect(newNightId(new Date(2026, 10, 4, 23, 15, 9).getTime())).toBe('n20261104T231509');
  });
});
describe('windowFor', () => {
  it('before bed: the next 01:00', () => {
    expect(windowFor(at(4, 23), W)).toEqual({ startMs: at(5, 1), endMs: at(5, 7) });
  });
  it('inside the window: the current one', () => {
    expect(windowFor(at(5, 2), W)).toEqual({ startMs: at(5, 1), endMs: at(5, 7) });
  });
  it('exactly at the start is inside that window; exactly at the end counts as over', () => {
    expect(windowFor(at(5, 1), W)).toEqual({ startMs: at(5, 1), endMs: at(5, 7) });
    expect(windowFor(at(5, 7), W).startMs).toBe(at(6, 1));
  });
  it('a window that crosses midnight', () => {
    expect(windowFor(at(4, 23), { start: '22:00', end: '06:00' })).toEqual({ startMs: at(4, 22), endMs: at(5, 6) });
    expect(windowFor(at(4, 12), { start: '22:00', end: '06:00' }).startMs).toBe(at(4, 22));
    expect(windowFor(at(5, 3), { start: '22:00', end: '06:00' })).toEqual({ startMs: at(4, 22), endMs: at(5, 6) });   // 03:00 is inside the window that began the evening before
  });
});
describe('isNightCurrent', () => {
  it('valid until 12h after the targeted window start', () => {
    expect(isNightCurrent(at(5, 13), at(5, 1))).toBe(true);
    expect(isNightCurrent(at(5, 13, 1), at(5, 1))).toBe(false);
  });
});
```

- [ ] **Steps 2-5:** run `npx vitest run scripts/afk/nightWindow.test.ts` (expect FAIL: cannot resolve the module). Implement `nightWindow.mjs`. Local-time maths via `new Date(y,m,d,h,mi)`; no timezone library. Rerun (expect PASS). Commit: `git add -- scripts/afk/nightWindow.mjs scripts/afk/nightWindow.test.ts && git commit -m "feat(afk): night label and window maths" -- scripts/afk/nightWindow.mjs scripts/afk/nightWindow.test.ts`.

---

### Task 5: Handoff and ledger parsers

**Files (all created, except where an Interfaces line says modified):**
```owned T5
scripts/afk/parseSources.mjs
scripts/afk/parseSources.test.ts
```

**Interfaces:**
- Produces: `parseNextSteps(markdown): {found:boolean; headingNote: string|null; items: {n:number; text:string}[]}`; `parseLedgerTodos(markdown): {state:'todo'|'pending'; note:string|null; text:string}[]`.
- Rules (D3): the section starts at a line matching `/^#{2,3}\s+Next steps\b(.*)$/i` (text after `Next steps`, e.g. `(all need Matt)`, becomes `headingNote` with the surrounding parentheses removed) and ends at the next heading of level 1 or 2 (a `##` such as `## Update 12:50 - …` ends it; `###` does not). Items start at a line `^\s{0,1}(\d+)\.\s+(.*)$`; following non-blank lines that are not a new item are joined with single spaces. Lines inside a fenced code block are ignored. Ledger: `^- \[(todo|pending[^\]]*)\]\s*(.*)$`, case-insensitive; `pending Matt` gives `state:'pending', note:'Matt'`; `[done]`, `[running]`, `[MERGED …]` are not returned.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseLedgerTodos, parseNextSteps } from './parseSources.mjs';
describe('parseNextSteps', () => {
  it('collects numbered items, joins continuation lines, stops at the next ## heading', () => {
    const md = '# H\n\n## Next steps\n1. First thing\n   continues here\n2. Second thing\n\n## Decisions\n- not me\n';
    expect(parseNextSteps(md)).toEqual({
      found: true, headingNote: null,
      items: [{ n: 1, text: 'First thing continues here' }, { n: 2, text: 'Second thing' }],
    });
  });
  it('a ## Update heading ends the section but ### does not', () => {
    const md = '## Next steps\n1. A\n### Sub\n2. B\n## Update 12:50 - x\n3. C\n';
    expect(parseNextSteps(md).items.map((i) => i.text)).toEqual(['A', 'B']);
  });
  it('keeps the heading note', () => {
    expect(parseNextSteps('## Next steps (all need Matt)\n1. Do it\n').headingNote).toBe('all need Matt');
  });
  it('ignores numbered lines in code fences', () => {
    const md = '## Next steps\n1. Real\n```\n2. fake\n```\n';
    expect(parseNextSteps(md).items.map((i) => i.text)).toEqual(['Real']);
  });
  it('reports not found', () => {
    expect(parseNextSteps('# nothing here\n')).toEqual({ found: false, headingNote: null, items: [] });
  });
});
describe('parseLedgerTodos', () => {
  it('returns todo and pending, nothing else', () => {
    const md = '- [todo] read-only tally\n- [done] x\n- [pending Matt] collector restart\n- [running] y\n- [MERGED 22c5f68] z\n';
    expect(parseLedgerTodos(md)).toEqual([
      { state: 'todo', note: null, text: 'read-only tally' },
      { state: 'pending', note: 'Matt', text: 'collector restart' },
    ]);
  });
});
```

- [ ] **Steps 2-5:** run `npx vitest run scripts/afk/parseSources.test.ts` (expect FAIL: cannot resolve the module). Implement `parseSources.mjs`. Rerun (expect PASS). Commit: `git add -- scripts/afk/parseSources.mjs scripts/afk/parseSources.test.ts && git commit -m "feat(afk): parse handoff Next steps and ledger todos" -- scripts/afk/parseSources.mjs scripts/afk/parseSources.test.ts`.

---

### Task 6: Plan references and the spec-approved test

**Files (all created, except where an Interfaces line says modified):**
```owned T6
scripts/afk/planRefs.mjs
scripts/afk/planRefs.test.ts
```

**Interfaces:**
- Produces: `specIsApproved(markdown): boolean`; `specPathOfPlan(markdown): string|null`; `planRefsIn(text): string[]` (plan file basenames, in order, de-duplicated).
- `specIsApproved`: look only at the first 15 lines for a line containing `status` (case-insensitive, optional `**`/`-`/`:` decoration) whose text matches `/\bapproved\b/i` and does NOT match `/\b(awaiting|not approved|unapproved|draft|superseded|rejected)\b/i`.
- `specPathOfPlan`: the first backticked path on a line starting `**Spec:**`.
- `planRefsIn`: matches `docs/superpowers/plans/<name>.md` or `plans/<name>.md`, `<name>` limited to `[\w.-]+`.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { planRefsIn, specIsApproved, specPathOfPlan } from './planRefs.mjs';
describe('specIsApproved', () => {
  it.each([
    ['plain', '# T\n\nStatus: APPROVED by Matt 2026-11-04 as written.\n', true],
    ['bold with comma', '# T\n**Status:** Approved, pending implementation plan\n', true],
    ['lowercase with date', 'Status: approved 2026-10-11. Amended\n', true],
    ['bullet', '- **Status:** design approved in conversation, awaiting written-spec review\n', false],
    ['draft', 'Status: DRAFT\n', false],
    ['superseded', 'Status: approved, superseded by x\n', false],
    ['no status line', '# T\nsome text\n', false],
    ['status after line 15', '\n'.repeat(16) + 'Status: approved\n', false],
  ])('%s', (_n, md, want) => { expect(specIsApproved(md)).toBe(want); });
});
describe('specPathOfPlan', () => {
  it('takes the first backticked path on the **Spec:** line', () => {
    expect(specPathOfPlan('x\n**Spec:** `docs/superpowers/specs/a-design.md` (note `b`)\n')).toBe('docs/superpowers/specs/a-design.md');
  });
  it('null when absent', () => { expect(specPathOfPlan('no spec line')).toBeNull(); });
});
describe('planRefsIn', () => {
  it('finds plan files by either prefix, de-duplicated', () => {
    expect(planRefsIn('see docs/superpowers/plans/2026-10-12-dashboards.md T3 and plans/other.md and plans/other.md'))
      .toEqual(['2026-10-12-dashboards.md', 'other.md']);
  });
  it('none', () => { expect(planRefsIn('nothing')).toEqual([]); });
});
```

- [ ] **Steps 2-5:** run `npx vitest run scripts/afk/planRefs.test.ts` (expect FAIL: cannot resolve the module). Implement `planRefs.mjs`. Rerun (expect PASS). Commit: `git add -- scripts/afk/planRefs.mjs scripts/afk/planRefs.test.ts && git commit -m "feat(afk): plan references and spec-approved test" -- scripts/afk/planRefs.mjs scripts/afk/planRefs.test.ts`.

---

### Task 7: The "decided" classifier

**Files (all created, except where an Interfaces line says modified):**
```owned T7
scripts/afk/classify.mjs
scripts/afk/classify.test.ts
```

**Interfaces:**
- Produces: `classifyItem(text): {verdict:'ready'|'question'|'barred'; reasons: string[]}`. Order: barred first, then question, else ready. Reasons are stable codes: `barred:delete`, `barred:force-push`, `barred:cleanup`, `question:marker`, `question:needs-matt`, `question:mark`.
- Barred (case-insensitive), as a denylist of stems and bare command tokens, not an exact-phrase word list (an exact list was tried over three build rounds and cannot work: each spelling it missed was a false `ready`). Text is normalised first: NFKD, zero-width and combining marks dropped, unicode hyphens U+2010-2015 and U+2212 (and a few look-alikes) folded to `-`, `_` folded to a space (so `old_delete.md` is seen), a short Cyrillic/Greek homoglyph table folded to ASCII, whitespace runs to one space. Then three families, each a list of case-insensitive regexes with bounded `.{0,400}` gaps (linear time on long input):
  - `barred:delete`: word-prefix stems `delet|remov|prun|eras|unlink|destroy|wip|nuk|trash|shred|truncat|purg|discard`; bare tokens `rm rmi del erase rd rmdir rimraf`; `Format-Volume`, `Clear-(Content|RecycleBin|Disk|Item)`, `drop table|database|schema|index`; git forms `git ... clean|rm`, `clean -[fd]`, `stash drop|clear`, `tag -d|--delete`, `update-ref -d`, `remote rm|remove`, `worktree remove`, `branch ... -d|-f|-m` flags, `--delete`, `reset ... --hard` and `hard reset` spellings, `checkout -f` / `checkout -- .`, `restore .`, `filter-branch|filter-repo`, `reflog expire`, `push :ref`, `push -d`.
  - `barred:force-push`: `force`/`forced`/`forcing`/`forcibly`/`forcefully` followed by `push` (any gap of space, `_`, `-`), `push ... with force`, `--force`, `--mirror`, `push -f` (flag cluster containing `f`), `push +ref`.
  - `barred:cleanup`: stems `clean*` and `tidy*` (so `clean up`, `cleaning`, `make clean` all match).
  - Verdict order is unchanged: any barred match wins; reasons list each matching family code once (`barred:delete`, `barred:force-push`, `barred:cleanup`, in that order).
  - **Known limit, stated in the module header and in RISKS: this is a denylist.** The homoglyph table is short and is not a confusables list, so other lookalike characters, leetspeak (`d3lete`), and exotic hyphens not in the fold set can still slip through as `ready`. False positives are accepted (held, never run); a false negative is the defect, and it is caught only by the allowlist/deny rules (T11) and Matt's per-item `confirm`, which are the real gates. The classifier is a first filter, not a security boundary.
- Question: a `?` anywhere; needs-Matt phrases (`ask Matt`, `needs? (a )?(fresh )?(go|approval)`, `Matt'?s? (call|decision|go|approval)`, `pending Matt`, `awaiting Matt`, `fresh go`, `all need Matt`); marker words `TBD`, `UNVERIFIED`, `unconfirmed`, `unclear`, `decide`, `open question`, `option(s)`, `either`, `whether`, `optional`, `maybe`, `consider`, `possibly`.

- [ ] **Step 1: Write the failing test.** Cases are taken verbatim from real handoffs (2026-11-04 handback and AFK handoffs) so the rules are checked against the text they will meet.

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { classifyItem } from './classify.mjs';
describe('classifyItem', () => {
  it.each([
    ['Delete .worktrees/collector-build: DECIDED option A (Matt, 2026-11-04) - leave it until the collector next restarts', 'barred'],
    ['Force-push the rebased branch', 'barred'],
    ['git branch -D feat/x after the merge', 'barred'],
    ['Ask Matt (one message) whether to push docs/afk-mode-design and open a docs-only PR; do not push without his go', 'question'],
    ['Tell Matt the outcome of step 1. If mostly `[]`, options B and C go to Matt, not decided here.', 'question'],
    ['Optional follow-up ticket: s14 sentence + parser nits. Do not push commits onto merged work.', 'question'],
    ['Which approach should the runner take?', 'question'],
    ['collector rebuild from merged master needs a fresh go', 'question'],
    ['Before planning Phase 2, verify the prototype: run git branch -a and check which branches are merged', 'ready'],
    ['Run npm test and fix the two failing starters tests in src/shared/dashboards', 'ready'],
    ['Build the APK for aethermobile with the titan IP', 'ready'],
    ['Remove the stale worktree directories', 'barred'],
    ['Purge old logs from the spool', 'barred'],
    ['git clean -fdx the checkout', 'barred'],
    ['git rm the generated file', 'barred'],
  ])('%s -> %s', (text, verdict) => {
    expect(classifyItem(text).verdict).toBe(verdict);
  });
  it('barred beats question and reports why', () => {
    const r = classifyItem('Delete the worktree; ask Matt first?');
    expect(r.verdict).toBe('barred');
    expect(r.reasons[0]).toBe('barred:delete');
  });
  it.each([
    'git push -f origin x', 'git push origin HEAD:master -f', 'git push origin +master',
  ])('force-push variant is barred: %s', (text) => {
    const r = classifyItem(text);
    expect(r.verdict).toBe('barred');
    expect(r.reasons).toContain('barred:force-push');
  });
  it.each([
    'git push origin :old-branch', 'rm -fr build', 'git -C x clean -fd', 'Deleted the stale branch',
    'del /s /q build', 'rd /s /q build', 'git stash drop', 'Deletion of old files', 'removal of old logs',
    'Pruning stale branches', 'rm x.txt', 'rimraf dist', 'git reset origin/master --hard',
    'git branch -vd x', 'git branch -fD x', 'git tag -d v1', 'git update-ref -d refs/heads/x', 'git remote rm origin',
    'docker rm -f web', 'wipe the disk', 'nuke the cache', 'destroy the VM', 'shred secrets.txt',
    'Format-Volume -DriveLetter E', 'Clear-Content log.txt', 'git checkout -f', 'git checkout -- .', 'git restore .',
    'git filter-branch --all', 'git reflog expire --all', 'git push -d origin x', 'Hard-reset the repo', 'reset hard',
    'git push\norigin\n:old', 'rm\u00A0x', '\uFF52\uFF4D -rf x', 'dele\u200Bte the logs', 'dele\u0301te the logs',
  ])('delete variant is barred (broad stems): %s', (text) => {
    expect(classifyItem(text).verdict).toBe('barred');
  });
  it.each([
    'git push origin master -fu', 'Force  push', 'force_push', 'forcepush', 'Forcibly push', 'push with force',
    'force\u00A0push', 'force\npush', 'git push --mirror', 'git push -f -u origin x',
  ])('force-push variant is barred (broad): %s', (text) => {
    const r = classifyItem(text);
    expect(r.verdict).toBe('barred');
    expect(r.reasons).toContain('barred:force-push');
  });
  it.each([
    'Clean up the worktree', 'cleaning up', 'clean   up', 'npm run clean', 'make clean', 'gradlew clean', 'tidy up',
  ])('cleanup variant is barred (stem): %s', (text) => {
    expect(classifyItem(text).reasons).toContain('barred:cleanup');
  });
  it.each([
    'force\u2011push it', 'git push\u2011\u2011force', 'force\u2212push it', 'git push \u2043\u2043force',
  ])('unicode-hyphen force-push is barred: %s', (text) => {
    expect(classifyItem(text).reasons).toContain('barred:force-push');
  });
  it.each(['old_delete.md', 'old_cleanup.md', 'git_clean'])('underscore-hidden stem is barred: %s', (text) => {
    expect(classifyItem(text).verdict).toBe('barred');
  });
  it.each(['D\u0435lete the logs', 'r\u043C -rf x', 'F\u043Erce push', 'cl\u0435an up',
    'tr\u03B1sh the build', '\u03C1urge old logs', 'trun\u03F2ate the log'])('homoglyph spelling is barred: %s', (text) => {
    expect(classifyItem(text).verdict).toBe('barred');
  });
  it.each(['wire up my_feature_flag', 'git push -u origin x'])('ordinary text stays ready: %s', (text) => {
    expect(classifyItem(text).verdict).toBe('ready');
  });
  it('long input classifies fast', () => {
    const t0 = Date.now();
    expect(classifyItem('push '.repeat(10000)).verdict).toBe('ready');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('full-width question mark is a question', () => {
    expect(classifyItem('Which one\uFF1F').verdict).toBe('question');
  });
  it('ready carries no reasons', () => {
    expect(classifyItem('Run npm test').reasons).toEqual([]);
  });
});
```

The block above is a summary of `scripts/afk/classify.test.ts` as built (it carries more rows per family, same categories: extra force-push, delete, cleanup, unicode-hyphen and homoglyph spellings). The `\uXXXX` escapes are real characters in the test file.

- [ ] **Steps 2-5:** run `npx vitest run scripts/afk/classify.test.ts` (expect FAIL: cannot resolve the module). Implement `classify.mjs` with the normalise step and the stem tables above, plus the question tables (needs-Matt phrases, marker words, `?` or full-width `?`). Rerun (expect PASS). Commit: `git add -- scripts/afk/classify.mjs scripts/afk/classify.test.ts && git commit -m "feat(afk): decided/question/barred item classifier" -- scripts/afk/classify.mjs scripts/afk/classify.test.ts`.

---

### Task 8: Build recipe table

**Files (all created, except where an Interfaces line says modified):**
```owned T8
scripts/afk/recipes.mjs
scripts/afk/recipes.test.ts
```

**Interfaces:**
- Produces: `RECIPES` (object keyed `"<project>/<artifact>"`), `getRecipe(project, artifact): Recipe|null`, `detectArtifact(text): 'apk'|'installer'|'both'|null`.
- `Recipe = {cwd: string, argv: string[], requires: Requirement[], evidence: string, verified: boolean}`; `Requirement = {kind:'propKeys', file: string, keys: string[]} | {kind:'propPath', file: string, key: string} | {kind:'file', path: string} | {kind:'scratchDir'}`. Paths are repo-relative. `{SCRATCH}` in argv is a placeholder the runner fills.
- Rows: exactly the four in D4 (aether-os/installer, aether-os/apk, TarotApp/apk, TokenMonitor/installer). `verified:false` on all four (none has been run unattended). `evidence` quotes the file:line from D4. The aether-os/apk row's `requires` also carries `{kind:'propPath', file:'android/local.properties', key:'sdk.dir'}` (the D4 `sdk.dir` precondition; CLAUDE.md says the Android build needs the untracked `android/local.properties`). `argv` is the D4 Command column split on spaces, and D4 is its only source (T11 derives allow-rule prefixes from the leading tokens up to the first `-` flag).
- `detectArtifact`: `/\b(apk|aab)\b/i` -> apk; `/\b(exe|installer)\b/i` -> installer (not `setup`: "setup fixtures" is not a build); both matching -> `'both'`, which T10 turns into a question instead of silently building one of them.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RECIPES, detectArtifact, getRecipe } from './recipes.mjs';
describe('recipes', () => {
  it('aethermobile APK bakes in the titan IP and runs in android/', () => {
    const r = getRecipe('aether-os', 'apk');
    expect(r?.cwd).toBe('android');
    expect(r?.argv).toContain('-PAETHER_TITAN_TAILNET_IP=100.84.175.105');
    const keys = r?.requires.flatMap((q) => (q.kind === 'propKeys' ? q.keys : []));
    expect(keys).toEqual(expect.arrayContaining(['AETHER_KEYSTORE_PASSWORD', 'AETHER_KEY_ALIAS', 'AETHER_KEY_PASSWORD']));
    expect(r?.requires.some((q) => q.kind === 'propPath' && q.key === 'AETHER_KEYSTORE_PATH')).toBe(true);
    expect(r?.requires.some((q) => q.kind === 'propPath' && q.key === 'sdk.dir')).toBe(true);
    expect(r?.argv.slice(0, 2)).toEqual(['gradlew.bat', 'assembleDebug']);
  });
  it('Aether packaging builds outside the dev tree', () => {
    const r = getRecipe('aether-os', 'installer');
    expect(r?.argv.join(' ')).toContain('-c.directories.output={SCRATCH}');
    expect(r?.requires).toContainEqual({ kind: 'scratchDir' });
  });
  it('TokenMonitor needs the pfx password file present', () => {
    expect(getRecipe('TokenMonitor', 'installer')?.requires).toContainEqual({ kind: 'file', path: 'codesign/pfx-password.txt' });
  });
  it.each(['MobileCrawler', 'nmmtools', 'unknown-project'])('%s has no recipe', (p) => {
    expect(getRecipe(p, 'apk')).toBeNull(); expect(getRecipe(p, 'installer')).toBeNull();
  });
  it('every recipe cites evidence and is unverified', () => {
    for (const [k, r] of Object.entries(RECIPES)) {
      expect(r.evidence.length, k).toBeGreaterThan(10); expect(r.verified, k).toBe(false);
    }
  });
  it.each([
    ['Build the APK for aethermobile', 'apk'], ['cut a new installer', 'installer'],
    ['produce the exe', 'installer'], ['ship apk and installer', 'both'], ['fix the tests', null], ['setup fixtures for the tests', null],
  ])('detectArtifact %j -> %s', (t, want) => { expect(detectArtifact(t)).toBe(want); });
});
```

- [ ] **Steps 2-5:** run `npx vitest run scripts/afk/recipes.test.ts` (expect FAIL: cannot resolve the module). Implement `recipes.mjs` from the D4 table. The Titan IP is a Tailscale address, not a secret (memory `aether-android-titan-ip-build-prop`). Rerun (expect PASS). Commit: `git add -- scripts/afk/recipes.mjs scripts/afk/recipes.test.ts && git commit -m "feat(afk): per-project build recipe table" -- scripts/afk/recipes.mjs scripts/afk/recipes.test.ts`.

---

### Task 9: Feasibility check (presence only)

**Files (all created, except where an Interfaces line says modified):**
```owned T9
scripts/afk/feasibility.mjs
scripts/afk/feasibility.test.ts
```

**Interfaces:**
- Consumes: `getRecipe` (T8).
- Produces: `checkFeasibility(item, probes): {ok:boolean; checks:{name:string; ok:boolean; detail:string}[]; warnings:string[]}`; `realProbes({homeDir, repoRoots = {}, env = process.env}): Probes`.
- `Probes = {repoRoot(project): string|null, fileExists(absPath): boolean, propKeysPresent(absFile, keys): Record<string,boolean>, propPathExists(absFile, key): boolean}`.
- Behaviour: an item whose `kind` is not `'build'` returns `{ok:true, checks:[], warnings:[]}`. A build item with no recipe returns `ok:false` with check `no build recipe for <project>/<artifact>`. Otherwise one check per requirement; `ok` = all pass; an unverified recipe adds the warning `recipe not yet verified unattended`. A `scratchDir` requirement is NOT probed in Phase 1 (the runner supplies `{SCRATCH}`): it yields a passing check with detail `not probed: runner supplies the scratch dir` AND the warning `scratch dir is not probed until Phase 2`, so Matt can see it is unchecked rather than assume it passed. **Details name keys, never values.** `propKeysPresent` is true for a key that has a non-empty value in the file OR a non-empty entry in `env` (Gradle's `signingValue` order, `android/app/build.gradle:14`); comment lines and empty values are false. `propPathExists` reads one value only to test that the path exists and never returns it. Its semantics: if the properties file has a non-empty value for the key, that value wins (and is unescaped, `\x` -> `x`, as Java properties are) and the environment is NOT consulted; otherwise the environment value is the fallback and is used RAW, not unescaped, so a Windows path with backslashes (`C:\keys\a.jks`) in the environment works. Empty value, missing file or key, and any read or stat error return `false`; nothing throws a message that carries file content. The properties parser reads `KEY=value` and `KEY: value` lines and skips blank lines and lines starting with `#` or `!`. `realProbes.fileExists` is `existsSync` with errors as `false`. `realProbes.repoRoot` = `repoRoots[project] ?? join(homeDir,'projects',project)` if it exists, else null.
- Item `kind` is `'build'` when `detectArtifact(title)` is `'apk'` or `'installer'`; T10 sets it at compile. Key checks have the detail `<KEY> present` or `<KEY> missing`.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFeasibility, realProbes } from './feasibility.mjs';
const apk = { project: 'aether-os', kind: 'build', artifact: 'apk', title: 'Build the APK' };
const probes = (over: Record<string, unknown> = {}) => ({
  repoRoot: () => 'C:/r', fileExists: () => true,
  propKeysPresent: (_f: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, true])),
  propPathExists: () => true, ...over,
});
describe('checkFeasibility (fake probes)', () => {
  it('non-build items are trivially feasible', () => {
    expect(checkFeasibility({ ...apk, kind: 'work' }, probes())).toEqual({ ok: true, checks: [], warnings: [] });
  });
  it('a build item with no recipe is blocked', () => {
    const r = checkFeasibility({ ...apk, project: 'MobileCrawler' }, probes());
    expect(r.ok).toBe(false); expect(r.checks[0].detail).toContain('no build recipe');
  });
  it('all present: ok, with the unverified-recipe warning', () => {
    const r = checkFeasibility(apk, probes());
    expect(r.ok).toBe(true); expect(r.warnings.join(' ')).toContain('not yet verified');
  });
  it('a missing signing key blocks and names the KEY only', () => {
    const r = checkFeasibility(apk, probes({ propKeysPresent: (_f: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, k !== 'AETHER_KEY_ALIAS'])) }));
    expect(r.ok).toBe(false); expect(r.checks.find((c: any) => !c.ok)?.detail).toBe('AETHER_KEY_ALIAS missing');
  });
  it('a missing sdk.dir blocks the APK and names the key', () => {
    const r = checkFeasibility(apk, probes({ propPathExists: (_f: string, key: string) => key !== 'sdk.dir' }));
    expect(r.ok).toBe(false); expect(JSON.stringify(r)).toContain('sdk.dir');
  });
  it('a scratchDir requirement passes but warns that it was not probed', () => {
    const r = checkFeasibility({ ...apk, artifact: 'installer' }, probes());
    expect(r.ok).toBe(true); expect(r.warnings.join(' ')).toContain('scratch dir is not probed');
  });
});
describe('realProbes', () => {
  it('reports presence and never leaks a value', () => {
    const home = mkdtempSync(join(tmpdir(), 'afk-feas-'));
    const root = join(home, 'projects', 'aether-os'); mkdirSync(join(root, 'android'), { recursive: true });
    const ks = join(home, 'ks.jks'); writeFileSync(ks, 'x');
    writeFileSync(join(root, 'android', 'local.properties'),
      `# AETHER_KEY_ALIAS=commented\nAETHER_KEYSTORE_PASSWORD=S3CR3T-SENTINEL\nAETHER_KEY_ALIAS=\nAETHER_KEYSTORE_PATH=${ks.replace(/\\/g, '/')}\n`);
    const p = realProbes({ homeDir: home, env: {} });
    const file = join(root, 'android', 'local.properties');
    expect(p.repoRoot('aether-os')).toBe(root);
    expect(p.propKeysPresent(file, ['AETHER_KEYSTORE_PASSWORD', 'AETHER_KEY_ALIAS', 'AETHER_KEY_PASSWORD']))
      .toEqual({ AETHER_KEYSTORE_PASSWORD: true, AETHER_KEY_ALIAS: false, AETHER_KEY_PASSWORD: false });
    expect(p.propPathExists(file, 'AETHER_KEYSTORE_PATH')).toBe(true);
    const full = checkFeasibility(apk, p);
    // JSON doubles backslashes, so a bare Windows path never matches: check every spelling of each secret-ish string.
    const leaks = (obj: unknown, s: string) => [s, s.replace(/\\/g, '/'), JSON.stringify(s).slice(1, -1)].some((v) => JSON.stringify(obj).includes(v));
    expect(leaks({ k: ks }, ks)).toBe(true);   // control: the matcher does fire on a path inside JSON
    expect(leaks(full, 'S3CR3T-SENTINEL')).toBe(false);
    expect(leaks(full, ks)).toBe(false);
  });
  it('an env entry satisfies a key absent from the file', () => {
    const home = mkdtempSync(join(tmpdir(), 'afk-feas-'));
    const p = realProbes({ homeDir: home, env: { AETHER_KEY_PASSWORD: 'x' } });
    expect(p.propKeysPresent(join(home, 'missing.properties'), ['AETHER_KEY_PASSWORD'])).toEqual({ AETHER_KEY_PASSWORD: true });
  });
  it('propPathExists tests the path: file value wins over env, env is the fallback', () => {
    const home = mkdtempSync(join(tmpdir(), 'afk-feas-'));
    const real = join(home, 'real.jks'); writeFileSync(real, 'x');
    const gone = join(home, 'gone.jks');
    const fwd = (s: string) => s.replace(/\\/g, '/'); // the file value is unescaped, so use forward slashes
    const file = join(home, 'a.properties');
    writeFileSync(file, `AETHER_KEYSTORE_PATH=${fwd(gone)}\n`);
    expect(realProbes({ homeDir: home, env: {} }).propPathExists(file, 'AETHER_KEYSTORE_PATH')).toBe(false);
    // file value wins: a good env value does not rescue a bad file value
    expect(realProbes({ homeDir: home, env: { AETHER_KEYSTORE_PATH: fwd(real) } }).propPathExists(file, 'AETHER_KEYSTORE_PATH')).toBe(false);
    const none = join(home, 'none.properties'); // missing file: env is the fallback
    expect(realProbes({ homeDir: home, env: { AETHER_KEYSTORE_PATH: fwd(gone) } }).propPathExists(none, 'AETHER_KEYSTORE_PATH')).toBe(false);
    expect(realProbes({ homeDir: home, env: { AETHER_KEYSTORE_PATH: fwd(real) } }).propPathExists(none, 'AETHER_KEYSTORE_PATH')).toBe(true);
    writeFileSync(file, `AETHER_KEYSTORE_PATH=${fwd(real)}\n`);
    expect(realProbes({ homeDir: home, env: {} }).propPathExists(file, 'AETHER_KEYSTORE_PATH')).toBe(true);
  });
  it('propPathExists does not unescape an env value (a backslash in the path is kept)', () => {
    // Platform-neutral: the directory name holds a backslash. On Windows join() makes it a nested
    // dir a\b; on POSIX it is one dir literally named a\b. Either way the native path contains
    // a backslash that unescaping would mangle, and the file exists only at the raw path.
    const home = mkdtempSync(join(tmpdir(), 'afk-feas-'));
    const dir = join(home, 'a\\b'); mkdirSync(dir, { recursive: true });
    const real = join(dir, 'real.jks'); writeFileSync(real, 'x');
    expect(real).toContain('\\');
    const none = join(home, 'none.properties');
    expect(realProbes({ homeDir: home, env: { AETHER_KEYSTORE_PATH: real } }).propPathExists(none, 'AETHER_KEYSTORE_PATH')).toBe(true);
  });
  it('fileExists is true for a real file and false for a missing one', () => {
    const home = mkdtempSync(join(tmpdir(), 'afk-feas-'));
    const f = join(home, 'pfx-password.txt'); writeFileSync(f, 'x');
    const p = realProbes({ homeDir: home, env: {} });
    expect(p.fileExists(f)).toBe(true);
    expect(p.fileExists(join(home, 'missing.txt'))).toBe(false);
  });
  it('a "KEY: value" line counts as present', () => {
    const home = mkdtempSync(join(tmpdir(), 'afk-feas-'));
    const file = join(home, 'a.properties');
    writeFileSync(file, 'AETHER_KEY_ALIAS: somealias\n');
    expect(realProbes({ homeDir: home, env: {} }).propKeysPresent(file, ['AETHER_KEY_ALIAS'])).toEqual({ AETHER_KEY_ALIAS: true });
  });
  it('commented lines (# and !, spaced or not) never count as present', () => {
    const home = mkdtempSync(join(tmpdir(), 'afk-feas-'));
    const file = join(home, 'a.properties');
    writeFileSync(file, '# AETHER_KEY_ALIAS=commented\n#AETHER_KEY_PASSWORD=x\n!AETHER_KEYSTORE_PASSWORD=x\n');
    expect(realProbes({ homeDir: home, env: {} }).propKeysPresent(file, ['AETHER_KEY_ALIAS', 'AETHER_KEY_PASSWORD', 'AETHER_KEYSTORE_PASSWORD']))
      .toEqual({ AETHER_KEY_ALIAS: false, AETHER_KEY_PASSWORD: false, AETHER_KEYSTORE_PASSWORD: false });
  });
});
```

- [ ] **Steps 2-5:** run `npx vitest run scripts/afk/feasibility.test.ts` (expect FAIL: cannot resolve the module). Implement `feasibility.mjs`. Any read error is a `false`, never a thrown message containing file content. Rerun (expect PASS). Commit: `git add -- scripts/afk/feasibility.mjs scripts/afk/feasibility.test.ts && git commit -m "feat(afk): presence-only feasibility probes for APK/EXE items" -- scripts/afk/feasibility.mjs scripts/afk/feasibility.test.ts`.

---

### Task 10: Night-list compiler

**Files (all created, except where an Interfaces line says modified):**
```owned T10
scripts/afk/compileNightList.mjs
scripts/afk/compileNightList.test.ts
```

**Interfaces:**
- Consumes: T4 (`windowFor`), T5, T6, T7, T8 (`detectArtifact`).
- Produces: `compileNightList({homeDir, projects: string[], plans?: string[], handoffs?: string[], repoRoots?: Record<string,string>, nowMs, maxAgeDays = 3, window = {start:'01:00', end:'07:00'}}): NightList`.
- Also produces `checkPlan({homeDir, repoRoots, project, file}): {found:boolean; specApproved:boolean}` (plan file looked up under the repo root, then the spec named on its `**Spec:**` line), used here and by T14's `recheckItem`.
- `NightList = {v:1, createdAtMs, targetWindowStartMs, projects, warnings: string[], items: Item[]}` (T14's `replaceDraft` adds the draft label and the empty amendments). `targetWindowStartMs = windowFor(nowMs, window).startMs`. The default `window` exists for tests only: callers pass the LIVE terms window (T17 does), and T14 `amendDraft` recomputes the field when a draft amends `window`.
- `Item = {id, project, kind:'work'|'plan'|'build', artifact:'apk'|'installer'|null, title, source:{kind:'handoff'|'ledger'|'plan', file, n?}, verdict, reasons, planRef?:{file, specApproved}, confirmed:false}`. `kind:'build'` and `artifact` come from `detectArtifact(title)`; `'both'` makes the item a `question` with reason `question:two-artifacts`. `id` = first 12 hex of sha256 of `project|normalised full text` (lowercase, whitespace collapsed; NOT the source kind, so the same text from a handoff and a ledger collapses); stable across recompiles. `title` = the first 140 characters of the normalised text. Items with the same id from two sources are de-duplicated (first wins). Two different items of one project with identical text are one item by design.
- Handoff choice, per D3: newest eligible handoff by mtime per project (see D3 for the filters) plus `handoffs` paths; ledger = newest `ledger-*.md` within `maxAgeDays`. Handoffs with `headingNote` containing `need Matt` make every item `question` with reason `question:needs-matt`. Ledger `pending` items are `question` with reason `question:needs-matt` (a `question` item always carries a reason, so `held[].reason` never falls back to `not-confirmed` for one).
- Plans: for each plan file named in an item's text (`planRefsIn`) or in `plans`, look in `<repoRoots[project] ?? join(homeDir,'projects',project)>/docs/superpowers/plans/<file>`. Missing file: item becomes `question`, reason `question:plan-not-found`, plus a warning. Every reason code carries the T7 prefix (`barred:` / `question:`), so one filter works on all of them. Found: read its `**Spec:**` path (relative to the same repo root); spec missing or not approved: `question`, reason `question:spec-not-approved`; `planRef = {file, specApproved}` (also on `kind:'plan'` items). A plan named by `plans` becomes its own item: `kind:'plan'`, title `Execute plan <file>`, `verdict` `ready` only if the spec is approved. **Checkboxes inside plans are never read.**
- A project with no handoff folder, or none inside `maxAgeDays`, adds a warning and compiles the rest; the function never throws on missing inputs.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compileNightList } from './compileNightList.mjs';
const NOW = new Date(2026, 10, 4, 23, 0).getTime();
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'afk-compile-'));
  const put = (rel: string, text: string, ageDays = 0) => {
    const p = join(home, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text);
    const t = new Date(NOW - ageDays * 864e5); utimesSync(p, t, t); return p;
  };
  return { home, put };
}
const HANDOFF = '# H\n\n## Next steps\n1. Run npm test and fix the failing starters test\n2. Ask Matt whether to push\n3. Delete .worktrees/old\n\n## Decisions\n- x\n';
const base = (home: string, extra = {}) => ({ homeDir: home, projects: ['aether-os'], nowMs: NOW, ...extra });
// JSON doubles backslashes, so a bare Windows path never matches inside JSON.stringify output: check every spelling.
const leaks = (obj: unknown, s: string) => [s, s.replace(/\\/g, '/'), JSON.stringify(s).slice(1, -1)].some((v) => JSON.stringify(obj).includes(v));
describe('compileNightList', () => {
  it('compiles the newest eligible handoff and ledger todos, with verdicts', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/2026-11-04-new-handoff.md', HANDOFF);
    put('.claude/handoffs/aether-os/2026-10-20-old-handoff.md', '## Next steps\n1. stale item\n', 10);
    put('.claude/handoffs/aether-os/verdict-x.md', '## Next steps\n1. should be ignored\n');
    put('.claude/handoffs/aether-os/ledger-2026-11-04.md', '- [todo] Build the APK for aethermobile\n- [done] finished\n');
    const l = compileNightList(base(home));
    const byTitle = Object.fromEntries(l.items.map((i) => [i.title, i]));
    expect(byTitle['Run npm test and fix the failing starters test'].verdict).toBe('ready');
    expect(byTitle['Ask Matt whether to push'].verdict).toBe('question');
    expect(byTitle['Delete .worktrees/old'].verdict).toBe('barred');
    expect(byTitle['Build the APK for aethermobile']).toMatchObject({ kind: 'build', artifact: 'apk' });
    expect(byTitle['Build the APK for aethermobile'].source.kind).toBe('ledger');
    expect(l.items.some((i) => i.title.includes('stale') || i.title.includes('ignored'))).toBe(false);
  });
  it('stores signal not payload: basename source, short title, stable distinct ids, unconfirmed', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/h.md', '## Next steps\n1. ' + 'x'.repeat(300) + '\n');
    const a = compileNightList(base(home)); const b = compileNightList(base(home));
    expect(a.items[0].title.length).toBe(140);
    expect(a.items[0].source.file).toBe('h.md');
    expect(leaks({ p: home }, home)).toBe(true);   // control: the matcher can fail, so the next line is not vacuous
    expect(leaks(a, home)).toBe(false);
    expect(a.items[0].id).toMatch(/^[0-9a-f]{12}$/); expect(a.items[0].id).toBe(b.items[0].id);
    expect(a.items[0]).toMatchObject({ confirmed: false, kind: 'work', artifact: null });
  });
  it('de-duplicates the same text from handoff and ledger', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/h.md', '## Next steps\n1. Run npm test\n');
    put('.claude/handoffs/aether-os/ledger-2026-11-04.md', '- [todo] Run npm test\n');
    expect(compileNightList(base(home)).items.length).toBe(1);
  });
  it('a handoff older than maxAgeDays is not compiled even when it is the only one', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/old.md', '## Next steps\n1. stale item\n', 10);
    const l = compileNightList(base(home));
    expect(l.items).toEqual([]); expect(l.warnings.join(' ')).toContain('aether-os');
    expect(compileNightList(base(home, { maxAgeDays: 30 })).items.map((i) => i.title)).toEqual(['stale item']);
  });
  it('tags build items, makes a two-artifact item a question, and does not treat "setup" as a build', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/h.md', '## Next steps\n1. Build the APK\n2. Ship the apk and the installer\n3. Prepare setup fixtures\n');
    const [apk, both, setup] = compileNightList(base(home)).items;
    expect(apk).toMatchObject({ kind: 'build', artifact: 'apk', verdict: 'ready' });
    expect(both).toMatchObject({ artifact: null, verdict: 'question' }); expect(both.reasons).toContain('question:two-artifacts');
    expect(setup).toMatchObject({ kind: 'work', artifact: null });
  });
  it('heading "(all need Matt)" and ledger pending make questions', () => {
    const { home, put } = fixture();
    put('.claude/handoffs/aether-os/h.md', '## Next steps (all need Matt)\n1. Run npm test\n');
    put('.claude/handoffs/aether-os/ledger-2026-11-04.md', '- [pending Matt] restart collector\n');
    const l = compileNightList(base(home));
    expect(l.items.every((i) => i.verdict === 'question')).toBe(true);
    expect(l.items.every((i) => i.reasons.includes('question:needs-matt'))).toBe(true);
  });
  it('plan reference: approved spec stays ready, unapproved or missing plan is a question', () => {
    const { home, put } = fixture();
    put('projects/aether-os/docs/superpowers/plans/p-ok.md', '# P\n**Spec:** `docs/superpowers/specs/ok.md`\n- [ ] unchecked step\n');
    put('projects/aether-os/docs/superpowers/specs/ok.md', '# S\nStatus: approved\n');
    put('projects/aether-os/docs/superpowers/plans/p-draft.md', '# P\n**Spec:** `docs/superpowers/specs/draft.md`\n');
    put('projects/aether-os/docs/superpowers/specs/draft.md', '# S\nStatus: DRAFT\n');
    put('.claude/handoffs/aether-os/h.md',
      '## Next steps\n1. Execute docs/superpowers/plans/p-ok.md\n2. Execute docs/superpowers/plans/p-draft.md\n3. Execute docs/superpowers/plans/gone.md\n');
    const l = compileNightList(base(home)); const [ok, draft, gone] = l.items;
    expect(leaks(l, home)).toBe(false);   // the plan-not-found warning must not carry the home path either
    expect(ok).toMatchObject({ verdict: 'ready', planRef: { file: 'p-ok.md', specApproved: true } });
    expect(draft.reasons).toContain('question:spec-not-approved');
    expect(gone.reasons).toContain('question:plan-not-found');
  });
  it('unchecked plan boxes alone put nothing on the list', () => {
    const { home, put } = fixture();
    put('projects/aether-os/docs/superpowers/plans/shipped.md', '**Spec:** `s.md`\n' + '- [ ] step\n'.repeat(50));
    put('.claude/handoffs/aether-os/h.md', '## Next steps\n1. Run npm test\n');
    expect(compileNightList(base(home)).items.map((i) => i.title)).toEqual(['Run npm test']);
  });
  it('a plan named by Matt becomes its own item', () => {
    const { home, put } = fixture();
    const plan = put('projects/aether-os/docs/superpowers/plans/named.md', '**Spec:** `docs/superpowers/specs/n.md`\n');
    put('projects/aether-os/docs/superpowers/specs/n.md', 'Status: approved\n');
    put('.claude/handoffs/aether-os/h.md', '## Next steps\n1. Run npm test\n');
    const l = compileNightList(base(home, { plans: [plan] }));
    expect(l.items.find((i) => i.kind === 'plan')).toMatchObject({ title: 'Execute plan named.md', verdict: 'ready' });
  });
  it('targets the window it is given, not the 01:00 default', () => {
    const { home } = fixture();
    const l = compileNightList(base(home, { window: { start: '22:00', end: '06:00' } }));
    expect(l.targetWindowStartMs).toBe(new Date(2026, 10, 4, 22, 0).getTime());   // NOW is 23:00, inside that window
  });
  it('a project with no handoff folder warns instead of throwing; target window is the next 01:00', () => {
    const { home } = fixture();
    const l = compileNightList(base(home));
    expect(l.items).toEqual([]); expect(l.warnings.join(' ')).toContain('aether-os');
    expect(l.targetWindowStartMs).toBe(new Date(2026, 10, 5, 1, 0).getTime());
  });
});
```

- [ ] **Steps 2-5:** run `npx vitest run scripts/afk/compileNightList.test.ts` (expect FAIL: cannot resolve the module). Implement `compileNightList.mjs`. Use `readdirSync` plus `statSync().mtimeMs`; unreadable files add a warning. Rerun (expect PASS). Commit: `git add -- scripts/afk/compileNightList.mjs scripts/afk/compileNightList.test.ts && git commit -m "feat(afk): night-list compiler with the decided test" -- scripts/afk/compileNightList.mjs scripts/afk/compileNightList.test.ts`.

---

### Task 11: Deny-rule and allow-rule builders

**Files (all created, except where an Interfaces line says modified):**
```owned T11
scripts/afk/denyRules.mjs
scripts/afk/denyRules.test.ts
```

**Interfaces:**
- Consumes: `DEFAULT_TERMS` shape (T1); `getRecipe` (T8, for the build-command prefixes in the allowlist). Consumed by T15 (both builders), T16 (`buildAllowRules` only) and T17 (`deny-rules` verb).
- Produces: `buildDenyRules(terms): {protect: string[]; run: string[]}` (the ONE definition of the split) and `buildAllowRules(terms, items): string[]` (allowlist, below), both in Claude Code permission-rule syntax (the same strings the prototype used, `away-cmd.ps1:27-39`); every list de-duplicated, stable order.
  - **`protect`** = the four path rules `Edit(~/.aether-os/afk/**)`, `Write(~/.aether-os/afk/**)`, `Edit(~/.claude/away*)`, `Write(~/.claude/away*)`. The same four for any terms. SAFE TO INSTALL GLOBALLY in `~/.claude/settings.json`: they block no ordinary work. This is the only group M2, D1 and privacy section 19 have Matt paste into settings.
  - **`run`** = every other deny rule below (delete verbs, force-push, the `HEAD:master`/`HEAD:main` exact-form pushes, the conditional push/merge rules). It is Phase 2's per-run disallow list (the supervisor passes it to the headless run). It must NOT be pasted into global settings: `Bash(rm:*)`, `git branch -d`, `git worktree remove` and `git rm` would block the builder and worktree-cleanup loops in every interactive session.
- `run` rules, always: delete verbs `Bash(rm:*)`, `Bash(rmdir:*)`, `Bash(del:*)`, `Bash(rd:*)`, `Bash(erase:*)`, `Bash(Remove-Item:*)`, `Bash(ri:*)`, `Bash(git clean:*)`, `Bash(git rm:*)`, `Bash(git branch -D:*)`, `Bash(git branch -d:*)`, `Bash(git branch --delete:*)`, `Bash(git worktree remove:*)`, `Bash(git worktree prune:*)`; force-push `Bash(git push --force:*)`, `Bash(git push -f:*)`, `Bash(git push --force-with-lease:*)`, `Bash(git push --delete:*)`; plus the exact-form pushes `Bash(git push origin HEAD:master:*)` and `Bash(git push origin HEAD:main:*)` (a cheap partial guard while `merge` is gated: they stop only that exact spelling, see Limits).
- `run` rules, conditional: `terms.push === false` adds `Bash(git push:*)`; `terms.merge === 'off'` adds `Bash(git merge:*)` and `Bash(gh pr merge:*)`. With the defaults NONE of the push/merge/`gh` rules appear (design 5 supersedes the prototype's blanket denial).
- Limits (stated in the module header and in RISKS): prefix rules cannot catch `git push origin +main` or `git push origin :branch`, and they also miss `git push origin main --force` and `git push origin main -f` (the flag comes after the remote, so the `--force`/`-f` prefix rules do not match). The allowlist's `Bash(git push:*)` also permits a push straight to master that skips merge-gate: the two exact-form `run` rules stop `git push origin HEAD:master` and `HEAD:main` as typed, but `git push origin HEAD:refs/heads/master`, `git push origin main`, `git push upstream HEAD:master` and any other spelling still pass; no prefix rule stops them all (Open item 7). The existing Safety Net hook (cc-safety-net) is the second layer: its git rules reportedly catch `+refspec`, `:branch`, `--force` and `--mirror` pushes (`cc-safety-net src/gate/analyzer/git/rules.ts:539-545`, read by the refuter on 2026-11-04), but nothing here has exercised that, so T21 M2 pushes `+main` to a throwaway remote and records whether it is blocked. Bash redirection into the terms file is not expressible as a rule. Every rule above is `Bash(...)`, and this machine also has a PowerShell tool; whether `Bash(...)` rules cover it is UNVERIFIED (D7, T21 M2). If M2 shows they do not, a follow-up change here adds a PowerShell mirror of each `run` rule (tool name and syntax from M2's observation) and extends the exact-list test; Phase 1 does not guess the syntax. `git rm` is listed because deletion is barred; removing a tracked file inside a spec'd commit stays barred (Matt kept it, 2026-11-05, Open item 2).
- **Allowlist (`buildAllowRules(terms, items)`, D7).** `items` are approval-style items `{project, kind, artifact}`. Returns a sorted, de-duplicated list. Always (read-only or ref-fetching): `Bash(git status:*)`, `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git show:*)`, `Bash(git rev-parse:*)`, `Bash(git merge-base:*)`, `Bash(git fetch:*)`, `Bash(gh pr view:*)`, `Bash(gh pr list:*)`, `Bash(gh pr checks:*)`, `Bash(gh pr diff:*)`, `Bash(gh run list:*)`, `Bash(gh run view:*)`. `terms.push === true`: `Bash(git push:*)` (the force and delete variants stay in the deny list; that a deny rule beats this allow rule is UNVERIFIED until T21 M2). `terms.merge === 'gated'`: `Bash(git merge --ff-only:*)`; deliberately NOT `gh pr merge`, because a gated merge goes through merge-gate, which Phase 2's runner enforces and a permission rule cannot. Per item with `kind === 'build'` and a recipe (`getRecipe(project, artifact)`): `Bash(<prefix>:*)` where prefix = the recipe's leading `argv` tokens up to, excluding, the first token that starts with `-` (so `npm run dist` and `gradlew.bat assembleDebug`). Never: bare `Bash`, `Bash(*)`, any `Edit` or `Write` rule (Phase 2's call, D7), any string that is also a deny rule, anything containing `bypass`. `work` and `plan` items add nothing.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMS } from './terms.mjs';
import { buildAllowRules, buildDenyRules } from './denyRules.mjs';
describe('buildDenyRules', () => {
  const base = buildDenyRules(DEFAULT_TERMS);
  // Both groups in full, so a dropped or renamed rule (rmdir, del, rd, erase, ri, git rm, branch -d/--delete, worktree prune) fails here.
  const PROTECT = ['Edit(~/.aether-os/afk/**)', 'Write(~/.aether-os/afk/**)', 'Edit(~/.claude/away*)', 'Write(~/.claude/away*)'];
  const ALWAYS = [
    'Bash(rm:*)', 'Bash(rmdir:*)', 'Bash(del:*)', 'Bash(rd:*)', 'Bash(erase:*)', 'Bash(Remove-Item:*)', 'Bash(ri:*)',
    'Bash(git clean:*)', 'Bash(git rm:*)', 'Bash(git branch -D:*)', 'Bash(git branch -d:*)', 'Bash(git branch --delete:*)',
    'Bash(git worktree remove:*)', 'Bash(git worktree prune:*)',
    'Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(git push --force-with-lease:*)', 'Bash(git push --delete:*)',
    'Bash(git push origin HEAD:master:*)', 'Bash(git push origin HEAD:main:*)',
  ];
  it('under the defaults protect is exactly the four path rules and run is exactly the stated list: delete verbs, force-push variants, HEAD:master/main', () => {
    expect([...base.protect].sort()).toEqual([...PROTECT].sort());
    expect([...base.run].sort()).toEqual([...ALWAYS].sort());
  });
  it('the split is clean: no path rule in run, no Bash rule in protect, no rule in both, and protect does not depend on terms', () => {
    expect(base.run.some((r) => /^(Edit|Write)\(/.test(r))).toBe(false);
    expect(base.protect.some((r) => r.startsWith('Bash('))).toBe(false);
    expect(base.run.filter((r) => base.protect.includes(r))).toEqual([]);
    expect(buildDenyRules({ ...DEFAULT_TERMS, push: false, merge: 'off' }).protect).toEqual(base.protect);
  });
  it('does NOT carry the prototype blanket push/merge/gh denial under the defaults', () => {
    for (const r of ['Bash(git push:*)', 'Bash(git merge:*)', 'Bash(gh:*)', 'Bash(gh pr merge:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)'])
      expect(base.run).not.toContain(r);
  });
  it('push:false and merge:off add exactly the matching rules, to run only', () => {
    const r = buildDenyRules({ ...DEFAULT_TERMS, push: false, merge: 'off' });
    expect([...r.run].sort()).toEqual([...ALWAYS, 'Bash(git push:*)', 'Bash(git merge:*)', 'Bash(gh pr merge:*)'].sort());
    expect([...r.protect].sort()).toEqual([...PROTECT].sort());
  });
});
describe('buildAllowRules', () => {
  const apk = { project: 'aether-os', kind: 'build', artifact: 'apk' };
  const exe = { project: 'aether-os', kind: 'build', artifact: 'installer' };
  const work = { project: 'aether-os', kind: 'work', artifact: null };
  it('defaults: read-only git/gh, push and ff-only merge, and no Edit/Write rule for a work item', () => {
    const r = buildAllowRules(DEFAULT_TERMS, [work]);
    expect(r).toEqual(expect.arrayContaining(['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(gh pr view:*)', 'Bash(git push:*)', 'Bash(git merge --ff-only:*)']));
    expect(r.some((x) => /^(Edit|Write)/.test(x))).toBe(false);
    expect(r).not.toContain('Bash(gh pr merge:*)');
  });
  it('build items add their recipe command prefix, without flags, and nothing else', () => {
    const r = buildAllowRules(DEFAULT_TERMS, [apk, exe]);
    expect(r).toEqual(expect.arrayContaining(['Bash(gradlew.bat assembleDebug:*)', 'Bash(npm run dist:*)']));
    expect(buildAllowRules(DEFAULT_TERMS, [apk]).join(' ')).not.toContain('npm run dist');
    expect(r.join(' ')).not.toContain('AETHER_TITAN');
  });
  it('a build item with no recipe adds nothing', () => {
    expect(buildAllowRules(DEFAULT_TERMS, [{ project: 'MobileCrawler', kind: 'build', artifact: 'apk' }])).toEqual(buildAllowRules(DEFAULT_TERMS, []));
  });
  it('push:false and merge:off remove the push and merge rules', () => {
    const r = buildAllowRules({ ...DEFAULT_TERMS, push: false, merge: 'off' }, []);
    expect(r).not.toContain('Bash(git push:*)'); expect(r).not.toContain('Bash(git merge --ff-only:*)');
  });
  it('is sorted, de-duplicated, never broad, never overlaps the deny list, never mentions bypass', () => {
    const r = buildAllowRules(DEFAULT_TERMS, [apk, apk, exe]);
    expect(r).toEqual([...new Set(r)].sort());
    expect(r).not.toContain('Bash'); expect(r).not.toContain('Bash(*)');
    const d = buildDenyRules(DEFAULT_TERMS);
    for (const x of r) { expect(d.run).not.toContain(x); expect(d.protect).not.toContain(x); }
    expect(JSON.stringify(r).toLowerCase()).not.toContain('bypass');
  });
});
```

- [ ] **Steps 2-5:** run `npx vitest run scripts/afk/denyRules.test.ts` (expect FAIL: cannot resolve the module). Implement `denyRules.mjs`. Rerun (expect PASS). Commit: `git add -- scripts/afk/denyRules.mjs scripts/afk/denyRules.test.ts && git commit -m "feat(afk): terms-derived deny-rule and allow-rule builders" -- scripts/afk/denyRules.mjs scripts/afk/denyRules.test.ts`.

---

### Task 12: The approved record and its pointer

**Files (all created, except where an Interfaces line says modified):**
```owned T12
scripts/afk/approval.mjs
scripts/afk/approval.test.ts
```

**Interfaces:**
- Consumes: T1 (`canonicalSha256`, `termsSha256`, `validateTerms`), T2 (`readJsonSafe`, `writeJsonAtomic`), T3 (`afkDir`).
- Produces (files `<afk>/approved.json` and `<afk>/last-approved.json`):
  - `approvedPath(aetherDir)`, `pointerPath(aetherDir)`.
  - `buildRecord({nightId, approvedAtMs, targetWindowStartMs, standingTerms, amendments, terms, items, held, allowRules}): Approved`. Stamps `v:1`, `via:'tty'`, `termsSha256 = termsSha256(terms)` and `recordSha256`; round-trips through JSON first so an `undefined` field cannot make the hash differ from the file. Throws if either terms object fails `validateTerms` or `allowRules` is not an array of strings. `standingTerms` is the live file at approval, before amendments; `terms` is the effective set the night runs on; there is no separate snapshot file, this record IS the snapshot.
  - `recordHash(record): string` = `canonicalSha256` of the record without its `recordSha256` field.
  - `writeApproved(aetherDir, record): void`: atomic `approved.json` (replacing any earlier approval), THEN atomic pointer `{v:1, nightId, recordSha256, approvedAtMs}`, in that order.
  - `readApproved(aetherDir): {ok:true; record} | {ok:false; reason}` with `reason` one of `missing`, `invalid` (bad JSON or shape), `hash-mismatch` (`recordHash` differs from the stored `recordSha256`), `terms-invalid` (either terms object invalid, or `termsSha256(terms) !== record.termsSha256`), `pointer-missing`, `pointer-mismatch` (pointer's `recordSha256` differs). Checks run in that order.
- `Approved.items[]` = `{id, project, kind, artifact, title, source}` (confirmed items only); `held[]` = `{id, title, verdict, reason}`; `allowRules[]` = exactly the list the approve summary printed (T15).

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TERMS } from './terms.mjs';
import { approvedPath, buildRecord, pointerPath, readApproved, recordHash, writeApproved } from './approval.mjs';
const tmp = () => mkdtempSync(join(tmpdir(), 'afk-appr-'));
const item = { id: 'a1b2c3d4e5f6', project: 'aether-os', kind: 'work', artifact: null, title: 't', source: { kind: 'handoff', file: 'h.md' } };
const fields = (over: Record<string, unknown> = {}) => ({
  nightId: 'n20261104T231509', approvedAtMs: 5, targetWindowStartMs: 9, standingTerms: DEFAULT_TERMS, amendments: {},
  terms: DEFAULT_TERMS, items: [item], held: [], allowRules: ['Bash(git status:*)'], ...over,
});
const stored = (d: string) => JSON.parse(readFileSync(approvedPath(d), 'utf8'));
// Rewrite approved.json after `fn` edits it; rehash recomputes recordSha256; repoint makes the pointer agree (a thorough tamperer).
const edit = (d: string, fn: (r: any) => void, o: { rehash?: boolean; repoint?: boolean } = {}) => {
  const j = stored(d); fn(j);
  if (o.rehash) j.recordSha256 = recordHash(j);
  writeFileSync(approvedPath(d), JSON.stringify(j));
  if (o.repoint) writeFileSync(pointerPath(d), JSON.stringify({ ...JSON.parse(readFileSync(pointerPath(d), 'utf8')), recordSha256: j.recordSha256 }));
};
const approved = () => { const d = tmp(); writeApproved(d, buildRecord(fields())); return d; };
describe('write and read', () => {
  it('round-trips, stamps version/via/hashes, and verifies', () => {
    const d = approved(); const r = readApproved(d);
    expect(r.ok && r.record).toMatchObject({ v: 1, via: 'tty', nightId: 'n20261104T231509', items: [item], allowRules: ['Bash(git status:*)'] });
    expect(r.ok && r.record.recordSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.ok && r.record.recordSha256).toBe(recordHash(stored(d)));
  });
  it('a later approval replaces the earlier one (one approved slot)', () => {
    const d = approved(); writeApproved(d, buildRecord(fields({ nightId: 'n20261105T231509', approvedAtMs: 6 })));
    const r = readApproved(d); expect(r.ok && r.record.nightId).toBe('n20261105T231509');
  });
  it('refuses to build from invalid terms or a non-array allowRules', () => {
    expect(() => buildRecord(fields({ terms: { ...DEFAULT_TERMS, delete: true } }))).toThrow();
    expect(() => buildRecord(fields({ standingTerms: { ...DEFAULT_TERMS, forcePush: true } }))).toThrow();
    expect(() => buildRecord(fields({ allowRules: 'Bash(git status:*)' }))).toThrow();
  });
  it('missing and invalid JSON read as missing and invalid', () => {
    expect(readApproved(tmp())).toEqual({ ok: false, reason: 'missing' });
    const d = approved(); writeFileSync(approvedPath(d), '{oops');
    expect(readApproved(d)).toEqual({ ok: false, reason: 'invalid' });
  });
});
describe('tamper detection', () => {
  it.each([
    ['allowRules', (r: any) => r.allowRules.push('Bash(rm:*)')],
    ['items', (r: any) => { r.items = []; }],
    ['nightId', (r: any) => { r.nightId = 'n20991231T000000'; }],
    ['held', (r: any) => { r.held.push({ id: 'z', title: 'x', verdict: 'question', reason: 'question:needs-matt' }); }],
    ['approvedAtMs', (r: any) => { r.approvedAtMs += 1; }],
    ['targetWindowStartMs', (r: any) => { r.targetWindowStartMs += 1; }],
    ['standingTerms', (r: any) => { r.standingTerms.opusEscalation = true; }],
    ['amendments', (r: any) => { r.amendments.push = false; }],
    ['effective terms', (r: any) => { r.terms.push = false; }],
  ])('editing %s fails with hash-mismatch', (_n, fn) => {
    const d = approved(); edit(d, fn);
    expect(readApproved(d)).toEqual({ ok: false, reason: 'hash-mismatch' });
  });
  it('an editor who recomputes recordSha256 still fails against the pointer', () => {
    const d = approved(); edit(d, (r) => r.allowRules.push('Bash(rm:*)'), { rehash: true });
    expect(readApproved(d)).toEqual({ ok: false, reason: 'pointer-mismatch' });
  });
  it('an editor who also fixes the pointer but not termsSha256 fails with terms-invalid', () => {
    const d = approved(); edit(d, (r) => { r.terms.opusEscalation = true; }, { rehash: true, repoint: true });
    expect(readApproved(d)).toEqual({ ok: false, reason: 'terms-invalid' });
  });
  it('a missing pointer fails closed (the crash between the two writes)', () => {
    const d = approved(); rmSync(pointerPath(d));
    expect(readApproved(d)).toEqual({ ok: false, reason: 'pointer-missing' });
  });
});
```

Carry (build review): T12 has two unpinned behaviors, the write order of the record and the pointer, and the `v` / `via` checks on read; add a test for each, or record them as accepted gaps.

- [ ] **Steps 2-5:** run `npx vitest run scripts/afk/approval.test.ts` (expect FAIL: cannot resolve the module). Implement `approval.mjs`. Rerun (expect PASS). Commit: `git add -- scripts/afk/approval.mjs scripts/afk/approval.test.ts && git commit -m "feat(afk): self-hashing approved record with a mirrored pointer" -- scripts/afk/approval.mjs scripts/afk/approval.test.ts`.

---

### Task 13: TTY probe (no code, no commit; run BEFORE T15)

**Files:** none. Output: a "T13" section in the result note `~/.claude/handoffs/aether-os/2026-11-04-afk-phase1-live-check.md` (outside the repo). Needs Matt at the keyboard for about two minutes. Why it is a task of its own: its answer decides the wording of the T19 skill step 7 and of the T15 refusal message, and T21 runs last. It touches no repo file, so it can run at any time before T15.

```owned T13
```

- [ ] **Step 1:** In an Aether terminal with `claude` running, type `! node -e "console.log(process.stdin.isTTY, process.stdout.isTTY)"` and record the printed pair. `true true` means the `!` escape has a TTY.
- [ ] **Step 2:** In a plain PowerShell window run the same `node -e` command. Expected: `true true`.
- [ ] **Step 3:** Ask the claude session to run the same command through its own Bash tool. Expected: NOT `true true`. This is the premise the whole TTY gate rests on.
- [ ] **Step 4:** Record the three results. Decision rule: if Step 3 prints `true true`, STOP and report to the orchestrator before T15 is built (the TTY gate would not separate the agent from Matt on this machine). Otherwise: Step 1 `true true` means Matt may type the gated verbs after `!` inside Aether; anything else means the skill tells him to use a plain PowerShell window (every Aether slot runs `claude`, so a second shell is not available there without `/exit`).

---

### Task 14: The one draft (replace, confirm, amend, re-check)

**Files (all created, except where an Interfaces line says modified):**
```owned T14
scripts/afk/draft.mjs
scripts/afk/draft.test.ts
scripts/afk/draftFixture.ts
```

**Interfaces:**
- Consumes: T1 (`applyAmendments`), T2, T3 (`afkDir`, `readLiveTerms`), T4 (`isNightCurrent`, `newNightId`, `windowFor`), T9 (`checkFeasibility`), T10 (`checkPlan`).
- Produces (file `<afk>/draft.json`, the only draft there is):
  - `draftPath(aetherDir)`, `readDraft(aetherDir): Draft|null` (null on a missing file, unparseable JSON, or a file with no `items` array: a torn write reads as no draft).
  - `replaceDraft(aetherDir, compiled, nowMs): Draft`. Writes `{v:1, draftId: newNightId(nowMs), createdAtMs, targetWindowStartMs, projects, warnings, items, amendments: {}}` atomically with every item `confirmed:false`, replacing whatever was there: confirmations and amendments never survive a compile, so a confirmation cannot outlive the verdict it was made against.
  - `recheckItem(item, ctx): {ok:boolean; reason: string|null}` with `ctx = {homeDir, repoRoots?, probes}`. Checks in order: `item.verdict === 'ready'` (else `not-ready:<verdict>`); if `item.planRef`, `checkPlan` must find the plan (`plan-not-found`) and its spec must be approved (`spec-not-approved`); if `item.kind === 'build'`, `checkFeasibility(item, ctx.probes).ok` (else `feasibility`). It reads the world as it is now; it does not re-read handoffs (Risks).
  - `confirmItems(aetherDir, ids, ctx, nowMs): {confirmed: string[]; refused: {id, reason}[]}`. Refuses with `no-draft`, `stale-draft` (every id, when `!isNightCurrent(nowMs, draft.targetWindowStartMs)`: a draft whose window passed more than 12h ago cannot be confirmed into; compile again), `unknown`, or the `recheckItem` reason. Atomic write.
  - `amendDraft(aetherDir, patch, nowMs): {ok:boolean; errors: string[]}`. Validates `applyAmendments(readLiveTerms().terms, {...draft.amendments, ...patch})`, stores the merged patch in `draft.amendments`; when the INCOMING patch contains `window` it also sets `targetWindowStartMs = windowFor(nowMs, effective.window).startMs`. The test is on the incoming patch, not the merged one: with the merged patch, any later unrelated amendment would recompute from a stored `window` and silently move the draft to the next night (Codex review of PR #175). No draft: `{ok:false, errors:['no draft']}`. A stale draft (`!isNightCurrent(nowMs, draft.targetWindowStartMs)`, checked before the patch is applied, so a `window` patch cannot revive it): `{ok:false, errors:['stale-draft']}` and nothing is written.

- [ ] **Step 1a: Write the shared fixture** `scripts/afk/draftFixture.ts` (no test in it; T15 and T16 import it and do not edit it)

```ts
// Shared setup for draft.test.ts, approveFlow.test.ts and resolvePlan.test.ts. Not a *.test.ts file, so neither vitest
// config collects it. Logic modules take nowMs, so every test pins the same evening.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceDraft } from './draft.mjs';
export const NOW = new Date(2026, 10, 4, 23, 0).getTime();   // 23:00, the evening before the window
export const WIN = new Date(2026, 10, 5, 1, 0).getTime();    // the 01:00 window that follows
export const DAY = 864e5;
export const A = 'a'.repeat(12), B = 'b'.repeat(12), C = 'c'.repeat(12), D = 'd'.repeat(12);
export const tmp = (tag = 'afk-draft') => mkdtempSync(join(tmpdir(), `${tag}-`));
export const mkItem = (id: string, title: string, verdict = 'ready', extra: Record<string, unknown> = {}) => ({
  id, project: 'aether-os', kind: 'work', artifact: null, title, source: { kind: 'handoff', file: 'h.md' }, verdict,
  reasons: verdict === 'ready' ? [] : [verdict === 'barred' ? 'barred:delete' : 'question:marker'], confirmed: false, ...extra,
});
export const mkCompiled = (items: unknown[], over: Record<string, unknown> = {}) =>
  ({ v: 1, createdAtMs: NOW, targetWindowStartMs: WIN, projects: ['aether-os'], warnings: [], items, ...over });
export const draftWith = (d: string, items: unknown[], nowMs = NOW, over: Record<string, unknown> = {}) =>
  replaceDraft(d, mkCompiled(items, over) as any, nowMs);
export const okProbes = {
  repoRoot: () => 'C:/r', fileExists: () => true,
  propKeysPresent: (_f: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, true])), propPathExists: () => true,
};
export const ctxFor = (home: string, probes: unknown = okProbes) => ({ homeDir: home, probes });
// A plan item whose plan and spec exist under a temp home; `specStatus` is the spec's Status text ('approved' or 'DRAFT').
export function putPlan(home: string, specStatus: string) {
  const root = join(home, 'projects', 'aether-os', 'docs', 'superpowers');
  mkdirSync(join(root, 'plans'), { recursive: true }); mkdirSync(join(root, 'specs'), { recursive: true });
  writeFileSync(join(root, 'plans', 'p.md'), '# P\n**Spec:** `docs/superpowers/specs/s.md`\n');
  writeFileSync(join(root, 'specs', 's.md'), `# S\nStatus: ${specStatus}\n`);
  return mkItem(D, 'Execute plan p.md', 'ready', { kind: 'plan', planRef: { file: 'p.md', specApproved: true } });
}
```

- [ ] **Step 1b: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { amendDraft, confirmItems, draftPath, readDraft, recheckItem } from './draft.mjs';
import { A, B, C, DAY, NOW, WIN, ctxFor, draftWith, mkItem, okProbes, putPlan, tmp } from './draftFixture';
const noKeys = { ...okProbes, propKeysPresent: (_f: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, false])) };
describe('replaceDraft', () => {
  it('writes the one draft with a fresh label, every item unconfirmed', () => {
    const d = tmp(); const dr = draftWith(d, [mkItem(A, 'Run npm test', 'ready', { confirmed: true })]);
    expect(dr.draftId).toMatch(/^n\d{8}T\d{6}$/); expect(dr.items[0].confirmed).toBe(false);
    expect(readDraft(d)).toEqual(dr); expect(readdirSync(dirname(draftPath(d)))).toEqual(['draft.json']);
  });
  it('a second compile REPLACES the draft: confirmations and amendments are gone, even for an id whose verdict changed', () => {
    const d = tmp(); draftWith(d, [mkItem(A, 'x'), mkItem(B, 'y')]);
    confirmItems(d, [A, B], ctxFor(tmp()), NOW); amendDraft(d, { opusEscalation: true }, NOW);
    draftWith(d, [mkItem(A, 'x', 'question'), mkItem(C, 'z')], NOW + 1000);   // A's verdict changed; B vanished
    const dr = readDraft(d)!;
    expect(dr.items.map((i: any) => [i.id.slice(0, 1), i.verdict, i.confirmed])).toEqual([['a', 'question', false], ['c', 'ready', false]]);
    expect(dr.amendments).toEqual({});
  });
  it('readDraft is null for a torn or malformed draft file and for no file', () => {
    const d = tmp(); draftWith(d, [mkItem(A, 'x')]);
    writeFileSync(draftPath(d), '{oops'); expect(readDraft(d)).toBeNull();
    writeFileSync(draftPath(d), JSON.stringify({ v: 1, draftId: 'n20261104T230000' })); expect(readDraft(d)).toBeNull();   // valid JSON, no items array
    expect(readDraft(tmp())).toBeNull();
  });
});
describe('confirmItems', () => {
  it('confirms a ready item and refuses unknown, question and barred ones with their reasons', () => {
    const d = tmp(); const [x, y, z] = [A, B, C];
    draftWith(d, [mkItem(x, 'Run npm test'), mkItem(y, 'Ask?', 'question'), mkItem(z, 'Delete x', 'barred')]);
    const r = confirmItems(d, [x, y, z, 'f'.repeat(12)], ctxFor(tmp()), NOW);
    expect(r.confirmed).toEqual([x]);
    expect(Object.fromEntries(r.refused.map((q) => [q.id.slice(0, 1), q.reason]))).toEqual({ b: 'not-ready:question', c: 'not-ready:barred', f: 'unknown' });
    expect(readDraft(d)!.items.map((i: any) => i.confirmed)).toEqual([true, false, false]);
  });
  it('a build item is confirmed only while its feasibility check passes now', () => {
    const d = tmp(); draftWith(d, [mkItem(A, 'Build the APK', 'ready', { kind: 'build', artifact: 'apk' })]);
    expect(confirmItems(d, [A], ctxFor(tmp(), noKeys), NOW).refused).toEqual([{ id: A, reason: 'feasibility' }]);
    expect(confirmItems(d, [A], ctxFor(tmp()), NOW).confirmed).toEqual([A]);
  });
  it('refuses everything when there is no draft', () => {
    expect(confirmItems(tmp(), [A], ctxFor(tmp()), NOW)).toEqual({ confirmed: [], refused: [{ id: A, reason: 'no-draft' }] });
  });
  it('refuses a stale draft (its window passed more than 12h ago) with stale-draft and writes nothing', () => {
    const d = tmp(); draftWith(d, [mkItem(A, 'Run npm test')]);
    expect(confirmItems(d, [A], ctxFor(tmp()), WIN + 12 * 3600e3 + 1)).toEqual({ confirmed: [], refused: [{ id: A, reason: 'stale-draft' }] });
    expect(readDraft(d)!.items[0].confirmed).toBe(false);
    expect(confirmItems(d, [A], ctxFor(tmp()), WIN + 12 * 3600e3).confirmed).toEqual([A]);   // control: exactly at the 12h edge it is still current
  });
});
describe('recheckItem', () => {
  it('a plan item passes while its spec is approved and fails once the spec goes back to draft', () => {
    const home = tmp(); const item = putPlan(home, 'approved');
    expect(recheckItem(item, ctxFor(home))).toEqual({ ok: true, reason: null });
    putPlan(home, 'DRAFT');
    expect(recheckItem(item, ctxFor(home))).toEqual({ ok: false, reason: 'spec-not-approved' });
  });
  it('a plan that vanished fails with plan-not-found', () => {
    expect(recheckItem(putPlan(tmp(), 'approved'), ctxFor(tmp()))).toEqual({ ok: false, reason: 'plan-not-found' });   // item from one home, checked against an empty one
  });
  it('an item stored as non-ready fails with not-ready', () => {
    expect(recheckItem(mkItem(A, 'Ask?', 'question'), ctxFor(tmp()))).toEqual({ ok: false, reason: 'not-ready:question' });
  });
});
describe('amendDraft', () => {
  it('stores a valid amendment and leaves the target window alone', () => {
    const d = tmp(); draftWith(d, []);
    expect(amendDraft(d, { opusEscalation: true }, NOW).ok).toBe(true);
    expect(readDraft(d)).toMatchObject({ amendments: { opusEscalation: true }, targetWindowStartMs: WIN });
  });
  it('amending the window recomputes the draft\'s target window', () => {
    const d = tmp(); draftWith(d, []);
    expect(amendDraft(d, { window: { start: '22:00', end: '06:00' } }, NOW).ok).toBe(true);
    expect(readDraft(d)!.targetWindowStartMs).toBe(new Date(2026, 10, 4, 22).getTime());   // NOW (23:00) is inside it
  });
  it('a later unrelated amendment does not recompute the target window', () => {
    const d = tmp(); draftWith(d, []);
    amendDraft(d, { window: { start: '22:00', end: '06:00' } }, NOW);
    const target = new Date(2026, 10, 4, 22).getTime();
    expect(readDraft(d)!.targetWindowStartMs).toBe(target);
    expect(amendDraft(d, { push: false }, new Date(2026, 10, 5, 7).getTime()).ok).toBe(true);   // inside the 12h grace
    expect(readDraft(d)).toMatchObject({ amendments: { push: false }, targetWindowStartMs: target });
  });
  it('rejects delete and an incoherent merge, keeping the stored amendments', () => {
    const d = tmp(); draftWith(d, []);
    expect(amendDraft(d, { delete: true }, NOW).ok).toBe(false);
    expect(amendDraft(d, { fableElevation: true }, NOW).ok).toBe(false);
    expect(readDraft(d)!.amendments).toEqual({});
  });
  it('without a draft it says so', () => { expect(amendDraft(tmp(), { push: false }, NOW)).toEqual({ ok: false, errors: ['no draft'] }); });
  it('refuses a stale draft, even for a window patch that would revive it, and writes nothing', () => {
    const d = tmp(); draftWith(d, []);
    const later = NOW + 2 * DAY;
    expect(amendDraft(d, { window: { start: '22:00', end: '06:00' } }, later)).toEqual({ ok: false, errors: ['stale-draft'] });
    expect(readDraft(d)).toMatchObject({ amendments: {}, targetWindowStartMs: WIN });
    expect(amendDraft(d, { opusEscalation: true }, WIN + 12 * 3600e3).ok).toBe(true);   // control: at the 12h edge it is still current
  });
});
```

Carry (build review): `replaceDraft` takes `createdAtMs` from `compiled.createdAtMs` (not from its `nowMs` argument); the fixture's `draftWith` does NOT override it: `mkCompiled` hardcodes `createdAtMs: NOW`, and `draftWith`'s `nowMs` only labels the draft (`draftId`). A test that needs another `createdAtMs` passes it through the fixture's `over` argument. State this in `draft.mjs`'s header so the two are not confused.

- [ ] **Steps 2-5:** run `npx vitest run scripts/afk/draft.test.ts` (expect FAIL: cannot resolve the module). Implement `draft.mjs`. Rerun (expect PASS). Commit: `git add -- scripts/afk/draft.mjs scripts/afk/draft.test.ts scripts/afk/draftFixture.ts && git commit -m "feat(afk): the one draft with confirm, amend and live re-check" -- scripts/afk/draft.mjs scripts/afk/draft.test.ts scripts/afk/draftFixture.ts`.

---

### Task 15: Approval flow (TTY and phrase gate)

**Files (all created, except where an Interfaces line says modified):**
```owned T15
scripts/afk/approveFlow.mjs
scripts/afk/approveFlow.test.ts
```

**Interfaces:**
- Consumes: T1 (`applyAmendments`, `termsSha256`, `DEFAULT_TERMS`), T3 (`readLiveTerms`), T4 (`isNightCurrent`), T11 (`buildAllowRules`, `buildDenyRules`), T12 (`buildRecord`, `writeApproved`, `readApproved`), T14 (`readDraft`, `recheckItem`); test setup from `draftFixture.ts` (T14).
- Produces: `expectedPhrase(termsSha256): string` = `APPROVE ` + first 8 hex of the EFFECTIVE terms' hash (so approving a stale printed summary after the terms changed fails); `approveNight({aetherDir, homeDir, repoRoots?, probes, nowMs, isTty, readLine, print}): Promise<{ok:true; record} | {ok:false; code:'not-tty'|'no-draft'|'stale-draft'|'terms-invalid'|'no-confirmed-items'|'recheck-failed'|'phrase-mismatch'|'state-changed'|'verify-failed'; message}>`.
- Order (each early return writes nothing): (1) `!isTty` -> `not-tty`, `print` and `readLine` never called; (2) a draft exists; (3) `live = readLiveTerms()`; a non-empty `live.warnings` -> `terms-invalid` (a corrupt or invalid terms file reads as the permissive defaults, which is not something to approve; the message gives the warning and says `terms set` rewrites a valid file); effective terms = `applyAmendments(live.terms, draft.amendments)`, invalid -> `terms-invalid`; (4) at least one confirmed item (else `no-confirmed-items`, checked BEFORE `stale-draft`), and `isNightCurrent(nowMs, draft.targetWindowStartMs)` else `stale-draft` (a draft compiled for a window that is already more than 12h past would produce a record Phase 2 resolves to `none`; the message names that window start in local time and says to re-run `compile`, then `confirm`); (5) `recheckItem` on EVERY confirmed item with `{homeDir, repoRoots, probes}`; any failure -> `recheck-failed`, the message lists each failing id, title and reason, and says to re-run `compile` and `confirm`; (6) `print` the summary, whose first line is `runs in the window starting <YYYY-MM-DD HH:MM local>` from `draft.targetWindowStartMs`: every effective term with the ones that differ from defaults marked; the one-night amendments as a separate block, with the sentence `amendments apply to tonight only; an unfinished night falls back to the standing terms`; `delete: NOT ALLOWED`; each confirmed item's id and title; each held item with its reason (first of `reasons`, else `not-confirmed`); the **allowlist** (`allowRules = buildAllowRules(effective, confirmedItems)`, one rule per line, with the sentence that Phase 2 will pass exactly these); then **both limits** beside it: (i) `Bash(git push:*)` is a prefix rule and also permits `+refspec`, `:branch`, `origin main --force` and `origin HEAD:master` pushes (the last is a push straight to master that skips merge-gate; the deny list stops only the exact forms `git push origin HEAD:master` and `HEAD:main`, not other spellings), which only the deny list's `--force`/`-f` prefixes and exact-form rules (for the forms they match) and the Safety Net hook may stop, and force-push is barred by the terms, not by this list; (ii) there are no Edit/Write/test rules in this list, so work and plan items cannot edit files unattended unless Phase 2 adds them and will go yellow; then the deny list (`buildDenyRules(effective)`, `protect` and `run` printed as two labelled groups); and, if `readApproved` verifies a record, `replaces approval <nightId> (window start <local time>)`; (7) `readLine("Type exactly: <phrase>")`, compared after trim (`phrase-mismatch` is reported first); then (7b) the live terms and the draft are re-read and compared with what was printed (the whole draft by canonical JSON, the live terms, and the effective-terms hash): any difference returns `state-changed`, writes nothing, and says to run `approve` again, because the prompt can stay open while another terminal edits either; (8) `writeApproved(buildRecord({...}))` with `standingTerms = live.terms`, `amendments = draft.amendments`, `items` = confirmed items only (`{id, project, kind, artifact, title, source}`), `held` = the rest, `allowRules` = the list printed in (6), `nightId = draft.draftId`; (9) `readApproved` must verify what was just written, else `verify-failed` (and the pointer-missing case is repaired by running `approve` again: it always rewrites both files).

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_TERMS, termsSha256 } from './terms.mjs';
import { termsPath, writeLiveTerms } from './termsStore.mjs';
import { amendDraft, confirmItems } from './draft.mjs';
import { approvedPath, pointerPath, readApproved } from './approval.mjs';
import { buildAllowRules } from './denyRules.mjs';
import { approveNight, expectedPhrase } from './approveFlow.mjs';
import { A, B, DAY, NOW, WIN, ctxFor, draftWith, mkItem, okProbes, putPlan, tmp } from './draftFixture';
const HOME = tmp('afk-home');   // no plans under it, so plain items never touch a plan file
const phrase = (terms = DEFAULT_TERMS) => expectedPhrase(termsSha256(terms));
const apk = (id: string, verdict = 'ready') => mkItem(id, 'Build the APK', verdict, { kind: 'build', artifact: 'apk' });
const exe = (id: string) => mkItem(id, 'Cut a new installer', 'ready', { kind: 'build', artifact: 'installer' });
function setup(items = [mkItem(A, 'Run npm test'), mkItem(B, 'Ask Matt?', 'question')], confirm = [A]) {
  const d = tmp('afk-approve'); draftWith(d, items); confirmItems(d, confirm, ctxFor(HOME), NOW); return d;
}
const run = (d: string, over: Record<string, unknown> = {}) => {
  const printed: string[] = []; let asked = 0;
  const p = approveNight({ aetherDir: d, homeDir: HOME, probes: okProbes, nowMs: NOW, isTty: true, print: (s: string) => printed.push(s),
    readLine: async () => { asked++; return phrase(); }, ...over } as any);
  return { p, text: () => printed.join('\n'), printed, asked: () => asked };
};
describe('approveNight gates', () => {
  it('without a TTY refuses, prints nothing, asks nothing, writes nothing', async () => {
    const d = setup(); const r = run(d, { isTty: false });
    expect(await r.p).toMatchObject({ ok: false, code: 'not-tty' });
    expect(r.printed).toEqual([]); expect(r.asked()).toBe(0); expect(existsSync(approvedPath(d))).toBe(false);
  });
  it('with no draft, or nothing confirmed, it refuses and writes nothing', async () => {
    expect(await run(tmp('afk-approve')).p).toMatchObject({ ok: false, code: 'no-draft' });
    const d = setup(undefined, []);
    expect(await run(d).p).toMatchObject({ ok: false, code: 'no-confirmed-items' });
    expect(existsSync(approvedPath(d))).toBe(false);
  });
  it('a draft compiled 3 days earlier is refused as stale-draft, naming the window; nothing is asked or written', async () => {
    const d = tmp('afk-approve'); draftWith(d, [mkItem(A, 'Run npm test')], NOW - 3 * DAY, { targetWindowStartMs: WIN - 3 * DAY });
    confirmItems(d, [A], ctxFor(HOME), NOW - 3 * DAY);   // confirmed on the draft's own evening, so the stale draft carries a confirmation
    const r = run(d);
    expect(await r.p).toMatchObject({ ok: false, code: 'stale-draft' }); expect((await r.p as any).message).toMatch(/compile/);
    expect(r.asked()).toBe(0); expect(existsSync(approvedPath(d))).toBe(false); expect(existsSync(pointerPath(d))).toBe(false);
    const ok = run(setup()); expect((await ok.p).ok).toBe(true);                          // control: a draft for tonight's window approves, and its summary names that window
    expect(ok.text()).toMatch(/runs in the window starting 2026-11-05 01:00/);
  });
  it('a wrong phrase writes nothing', async () => {
    const d = setup();
    expect(await run(d, { readLine: async () => 'yes' }).p).toMatchObject({ ok: false, code: 'phrase-mismatch' });
    expect(existsSync(approvedPath(d))).toBe(false); expect(existsSync(pointerPath(d))).toBe(false);
  });
});
describe('approveNight record', () => {
  it('writes a verifying record: confirmed items only, the rest held, standing terms = the live file', async () => {
    const d = setup(); const r = run(d);
    expect((await r.p).ok).toBe(true);
    const rec = readApproved(d);
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    expect(rec.record.items.map((i: any) => i.id)).toEqual([A]);
    expect(rec.record.held).toEqual([{ id: B, title: 'Ask Matt?', verdict: 'question', reason: 'question:marker' }]);
    expect(rec.record.standingTerms).toEqual(DEFAULT_TERMS); expect(rec.record.terms).toEqual(DEFAULT_TERMS);
    expect(rec.record.targetWindowStartMs).toBe(new Date(2026, 10, 5, 1).getTime());
    expect(rec.record.allowRules).toEqual(buildAllowRules(DEFAULT_TERMS, rec.record.items));   // the list stored is the list computed...
    for (const x of rec.record.allowRules) expect(r.text()).toContain(x);                        // ...and the list printed
    expect(r.text()).toContain('Run npm test'); expect(r.text()).toContain('delete: NOT ALLOWED');
  });
  it('the allowlist comes from CONFIRMED items only: a held question APK item adds nothing, a confirmed installer adds npm run dist', async () => {
    const d = setup([apk(A, 'question'), exe(B)], [B]); const r = run(d);
    expect((await r.p).ok).toBe(true);
    const rules = (readApproved(d) as any).record.allowRules as string[];
    expect(rules).toContain('Bash(npm run dist:*)');
    expect(rules.join(' ')).not.toContain('gradlew.bat'); expect(r.text()).not.toContain('gradlew.bat');
  });
  it('prints both limits beside the allowlist and no longer claims force-push is not allowed', async () => {
    const r = run(setup()); await r.p;
    expect(r.text()).toMatch(/\+refspec/); expect(r.text()).toMatch(/origin main --force/); expect(r.text()).toMatch(/HEAD:master/);
    expect(r.text()).toContain('Bash(git push origin HEAD:master:*)'); expect(r.text()).toContain('Edit(~/.aether-os/afk/**)');   // both deny groups are printed
    expect(r.text()).toMatch(/no Edit\/Write\/test rules/); expect(r.text()).toMatch(/yellow/);
    expect(r.text()).not.toContain('force-push: NOT ALLOWED');
  });
  it('a one-night amendment lands in terms but not in standingTerms or the live file', async () => {
    const d = setup(); writeLiveTerms(d, DEFAULT_TERMS);
    const before = readFileSync(termsPath(d), 'utf8');
    amendDraft(d, { opusEscalation: true }, NOW);
    const amended = { ...DEFAULT_TERMS, opusEscalation: true };
    const r = run(d, { readLine: async () => phrase(amended) });
    expect((await r.p).ok).toBe(true);
    expect(r.text()).toMatch(/tonight only/); expect(r.text()).toMatch(/standing terms/);        // the printed amendments block says what an amendment is
    const rec = (readApproved(d) as any).record;
    expect(rec.terms.opusEscalation).toBe(true); expect(rec.standingTerms.opusEscalation).toBe(false);
    expect(rec.amendments).toEqual({ opusEscalation: true });
    expect(readFileSync(termsPath(d), 'utf8')).toBe(before);
  });
  it('corrupt live terms refuse the approval: nothing is printed, asked or written', async () => {
    const d = setup(); mkdirSync(dirname(termsPath(d)), { recursive: true }); writeFileSync(termsPath(d), '{nope');
    const r = run(d);
    expect(await r.p).toMatchObject({ ok: false, code: 'terms-invalid' });
    expect(r.printed).toEqual([]); expect(r.asked()).toBe(0); expect(existsSync(approvedPath(d))).toBe(false);
    writeLiveTerms(d, DEFAULT_TERMS);                                                         // control: `terms set` rewrites a valid file and approval works again
    expect((await run(d).p).ok).toBe(true);
  });
  it('approving again replaces the record and says so', async () => {
    const d = setup(); await run(d).p;
    const second = run(d); expect((await second.p).ok).toBe(true);
    expect(second.text()).toMatch(/replaces approval n\d{8}T\d{6}/);
  });
});
describe('approveNight state changed during the prompt', () => {
  const nothing = (d: string) => { expect(existsSync(approvedPath(d))).toBe(false); expect(existsSync(pointerPath(d))).toBe(false); };
  it('live terms changed while the prompt is open: the old phrase is refused as state-changed', async () => {
    const d = setup();
    const r = await run(d, { readLine: async () => { writeLiveTerms(d, { ...DEFAULT_TERMS, push: false }); return phrase(); } }).p;
    expect(r).toMatchObject({ ok: false, code: 'state-changed' }); nothing(d);
  });
  it('draft recompiled while the prompt is open: state-changed', async () => {
    const d = setup();
    const r = await run(d, { readLine: async () => { draftWith(d, [mkItem(A, 'Run npm test')]); return phrase(); } }).p;
    expect(r).toMatchObject({ ok: false, code: 'state-changed' }); nothing(d);
  });
  it('another confirmation made while the prompt is open: state-changed', async () => {
    const d = setup([mkItem(A, 'Run npm test'), mkItem(B, 'Run lint')], [A]);
    const r = await run(d, { readLine: async () => { confirmItems(d, [B], ctxFor(HOME), NOW); return phrase(); } }).p;
    expect(r).toMatchObject({ ok: false, code: 'state-changed' }); nothing(d);
  });
  it('control: nothing changes during the prompt and the approval succeeds', async () => {
    expect((await run(setup()).p).ok).toBe(true);
  });
});
describe('approveNight re-check', () => {
  it('(h) a confirmed item whose spec went back to draft is refused, and the earlier approval is untouched', async () => {
    const home = tmp('afk-home'); const plan = putPlan(home, 'approved');
    const d = tmp('afk-approve'); draftWith(d, [plan, mkItem(A, 'Run npm test')]); confirmItems(d, [plan.id, A], ctxFor(home), NOW);
    expect((await run(d, { homeDir: home }).p).ok).toBe(true);                          // control: the same draft approves while the spec is approved
    const hash = (readApproved(d) as any).record.recordSha256;
    putPlan(home, 'DRAFT');                                                              // the spec goes back to draft after the confirmation
    const r = await run(d, { homeDir: home }).p;
    expect(r).toMatchObject({ ok: false, code: 'recheck-failed' }); expect((r as any).message).toContain('spec-not-approved');
    expect((readApproved(d) as any).record.recordSha256).toBe(hash);
  });
  it('a confirmed build item whose probes now fail is refused', async () => {
    const d = setup([apk(A)], [A]);
    const noKeys = { ...okProbes, propKeysPresent: (_f: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, false])) };
    expect(await run(d, { probes: noKeys }).p).toMatchObject({ ok: false, code: 'recheck-failed' });
    expect(existsSync(approvedPath(d))).toBe(false);
  });
});
```

- [ ] **Steps 2-5:** run `npx vitest run scripts/afk/approveFlow.test.ts` (expect FAIL: cannot resolve the module). Implement `approveFlow.mjs`. Rerun (expect PASS). Commit: `git add -- scripts/afk/approveFlow.mjs scripts/afk/approveFlow.test.ts && git commit -m "feat(afk): TTY-gated approval flow writing the self-hashing record" -- scripts/afk/approveFlow.mjs scripts/afk/approveFlow.test.ts`.

---

### Task 16: `resolveNightPlan`, the Phase 2 entry point

**Files (all created, except where an Interfaces line says modified):**
```owned T16
scripts/afk/resolvePlan.mjs
scripts/afk/resolvePlan.test.ts
```

**Interfaces:**
- Consumes: T1 (`termsSha256`), T4 (`isNightCurrent`, `windowFor`), T9 (`realProbes`), T11 (`buildAllowRules`), T12 (`readApproved`), T14 (`readDraft`, `recheckItem`); tests also use T3, T15 and `draftFixture.ts` (T14).
- Produces: `resolveNightPlan({aetherDir, homeDir, repoRoots?, probes?, nowMs}): {kind:'approved'|'unfinished'|'none'; nightId: string|null; targetWindowStartMs: number|null; terms: Terms|null; termsSha256: string|null; items; held; allowRules: string[]; reason: string}`. `probes` defaults to `realProbes({homeDir, repoRoots, env: process.env})`. Never throws. `targetWindowStartMs` is the start of the window the plan is FOR, returned in both non-`none` kinds (and `null` with `nightId: null` for `none`), so a caller can tell "not yet open" from "open or passed" and key a one-run-per-window record on it (Interfaces table, time contract).
- Also produces `unfinishedSelection({draft, record, ctx}): {terms, termsSha256, items, held, allowRules}` with `ctx = {homeDir, repoRoots?, probes}` and `record` the verified `a.record`. It is THE one computation of what an unfinished night runs: `terms = record.standingTerms`, `termsSha256` its hash, `items` = the draft's confirmed items for which `recheckItem` passes now, projected to `{id, project, kind, artifact, title, source}`, `held` as rule 3 describes, `allowRules = buildAllowRules(terms, items)`. It applies no window gate and has no `none` case (the caller decides that). `resolveNightPlan` rule 3 calls it, and T17's `confirm` calls it to print the list (Open item 9, decided 2026-11-05); nothing else computes these five values.
- Rules, in order:
  1. `a = readApproved(aetherDir)`. If it failed for any reason other than `missing`, return `none` with `reason: 'approval record failed: <reason>'` (a tampered record is never rescued by a draft, and with no verifying record there are no last-approved terms to run an unfinished night on).
  2. **approved**: `a.ok` and `isNightCurrent(nowMs, record.targetWindowStartMs)`. `terms`, `termsSha256`, `items`, `held`, `allowRules`, `nightId` and `targetWindowStartMs` come from the record; `draft.json` is not read (a torn or missing draft changes nothing here).
  3. **unfinished**: otherwise, a draft exists (`readDraft` non-null; a torn file is no draft), it has at least one `confirmed` item, `a.ok`, **`draft.createdAtMs > a.record.approvedAtMs`** (the draft was compiled after the last approval; a record that lapsed its 12h gate was approved FROM the draft still on disk, and without this clause that same confirmed item would come back as `unfinished` with a different `targetWindowStartMs` whenever the approval carried a `window` amendment, so Phase 2's run-once key would not dedupe it and the item would run twice), and `isNightCurrent(nowMs, target)` where **`target = windowFor(draft.targetWindowStartMs, a.record.standingTerms.window).startMs`**. Why that source: the draft's own target was computed from the LIVE window at `compile`, or moved by an unconfirmed `window` amendment, yet this night runs on the STANDING terms, so its window is the standing window's start for the window that contains (or next follows) the draft's target. The gate and the returned `targetWindowStartMs` use the same value. `nightId` = `draft.draftId`; `terms` = `a.record.standingTerms` (NOT the live file, NOT `draft.amendments`, NOT the prior night's effective `terms`); `termsSha256` = its hash; `items` = the confirmed items for which `recheckItem` passes now, each projected to `{id, project, kind, artifact, title, source}` (the same key set as an approved record's items, so Phase 2 reads both kinds alike); `held` = every other draft item with `reason` = `recheck:<reason>` for a confirmed item that failed, else its first `reasons` entry, else `not-confirmed`; `allowRules = buildAllowRules(terms, items)`. These five values (`terms`, `termsSha256`, `items`, `held`, `allowRules`) come from `unfinishedSelection`; this rule adds only the gates, `nightId` and `targetWindowStartMs`. Matt sees this same list when he runs `confirm` (Open item 9). No verifying last record -> `none`, `reason: 'no last-approved terms'` (Open item 8).
  4. Otherwise `none` (`reason: 'no current approved night and nothing confirmed'`), `items` and `allowRules` empty, `nightId` and `targetWindowStartMs` null (also for every `none` above).

- [ ] **Step 1: Write the failing test.** Scenarios (a) to (g) are named as the review's scenarios; (h) is in T15.

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DEFAULT_TERMS, termsSha256 } from './terms.mjs';
import { termsPath, writeLiveTerms } from './termsStore.mjs';
import { amendDraft, confirmItems, draftPath, readDraft } from './draft.mjs';
import { approvedPath, pointerPath, readApproved } from './approval.mjs';
import { buildAllowRules } from './denyRules.mjs';
import { approveNight, expectedPhrase } from './approveFlow.mjs';
import { resolveNightPlan, unfinishedSelection } from './resolvePlan.mjs';
import { A, B, DAY, NOW, WIN, ctxFor, draftWith, mkItem, okProbes, putPlan, tmp } from './draftFixture';
const HOME = tmp('afk-home');
const two = () => [mkItem(A, 'item a'), mkItem(B, 'item b')];
const approve = (d: string, terms = DEFAULT_TERMS, nowMs = NOW) => approveNight({ aetherDir: d, homeDir: HOME, probes: okProbes, nowMs, isTty: true, print: () => {},
  readLine: async () => expectedPhrase(termsSha256(terms)) });
const resolve = (d: string, nowMs: number, homeDir = HOME) => resolveNightPlan({ aetherDir: d, homeDir, probes: okProbes, nowMs });
const confirm = (d: string, ids: string[], home = HOME, nowMs = NOW) => confirmItems(d, ids, ctxFor(home), nowMs);
const ids = (xs: any[]) => xs.map((i) => i.id);
const ITEM_KEYS = ['artifact', 'id', 'kind', 'project', 'source', 'title'];
// A night approved yesterday on the defaults (its window start was WIN - DAY).
async function approvedYesterday(d: string, amend?: Record<string, unknown>) {
  draftWith(d, two(), NOW - DAY, { targetWindowStartMs: WIN - DAY }); confirm(d, [A], HOME, NOW - DAY);
  if (amend) amendDraft(d, amend, NOW - DAY);
  await approve(d, { ...DEFAULT_TERMS, ...amend } as any, NOW - DAY);
}
describe('resolveNightPlan: approved', () => {
  it('(a) compile, confirm, approve, compile again the same evening: the approved work still resolves as approved', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]); await approve(d);
    draftWith(d, two(), NOW + 5000); confirm(d, [B]);                  // the re-compile, and a confirmation of its own
    const r = resolve(d, WIN);
    expect(r.kind).toBe('approved'); expect(ids(r.items)).toEqual([A]); expect(ids(r.held)).toEqual([B]);
    expect(r.targetWindowStartMs).toBe(WIN);
    expect(r.terms).toEqual(DEFAULT_TERMS); expect(r.allowRules).toEqual(buildAllowRules(DEFAULT_TERMS, r.items as any));
    expect(Object.keys(r.items[0]).sort()).toEqual(ITEM_KEYS);
  });
  it('(b) approve, then change the live window and compile: the approved record still resolves', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]); await approve(d);
    writeLiveTerms(d, { ...DEFAULT_TERMS, window: { start: '00:00', end: '06:00' } });
    draftWith(d, two(), NOW + 5000, { targetWindowStartMs: new Date(2026, 10, 5, 0).getTime() });   // a compile under the new window
    const r = resolve(d, WIN);
    expect(r.kind).toBe('approved'); expect(ids(r.items)).toEqual([A]); expect(r.terms?.window.start).toBe('01:00');
  });
  it('a hand-edited draft cannot add work to an approved night', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]); await approve(d);
    const j = JSON.parse(readFileSync(draftPath(d), 'utf8')); j.items[1].confirmed = true; writeFileSync(draftPath(d), JSON.stringify(j));
    expect(ids(resolve(d, WIN).items)).toEqual([A]);
  });
  it('(g) an approval record with edited allowRules returns none and names the hash', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]); await approve(d);
    const j = JSON.parse(readFileSync(approvedPath(d), 'utf8')); j.allowRules.push('Bash(rm:*)'); writeFileSync(approvedPath(d), JSON.stringify(j));
    const r = resolve(d, WIN);
    expect(r).toMatchObject({ kind: 'none', items: [], allowRules: [], nightId: null, targetWindowStartMs: null }); expect(r.reason).toMatch(/hash-mismatch/);
  });
  it('(f) a crash between the record write and the pointer write reads as none, and retrying approve heals it', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]); await approve(d);
    rmSync(pointerPath(d));                                            // the state a crash between the two writes leaves
    expect(resolve(d, WIN)).toMatchObject({ kind: 'none', reason: expect.stringMatching(/pointer-missing/) });
    expect((await approve(d)).ok).toBe(true);
    expect(resolve(d, WIN)).toMatchObject({ kind: 'approved' });
  });
  it('a record more than 12h past its window start is not an approved night', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]); await approve(d);
    expect(resolve(d, WIN + 12 * 3600e3 + 1).kind).toBe('none');
  });
});
describe('resolveNightPlan: window and torn files', () => {
  it('returns the window it is FOR: tonight\'s start before it opens and still at 09:00; the same plan twice; none after the grace', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]); await approve(d);
    const before = resolve(d, NOW), early = resolve(d, WIN), late = resolve(d, WIN + 8 * 3600e3);   // 23:00, 01:00, 09:00
    expect(before.kind).toBe('approved'); expect(before.targetWindowStartMs).toBe(WIN); expect(before.targetWindowStartMs!).toBeGreaterThan(NOW);   // not yet open
    expect(late).toEqual(early);                                         // no started-state: the caller owns run-once, keyed on targetWindowStartMs
    expect(late.targetWindowStartMs).toBe(WIN);                          // windowFor(09:00) would be tomorrow's 01:00
    expect(late.nightId).toMatch(/^n\d{8}T\d{6}$/);
    expect(resolve(d, WIN + 12 * 3600e3 + 1)).toMatchObject({ kind: 'none', nightId: null, targetWindowStartMs: null });
  });
  it('(k) a torn draft: an approved night still resolves; an unfinished night and a first night do not', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]); await approve(d);
    writeFileSync(draftPath(d), '{oops');
    const r = resolve(d, WIN);
    expect(r).toMatchObject({ kind: 'approved', targetWindowStartMs: WIN }); expect(ids(r.items)).toEqual([A]);
    const e = tmp('afk-resolve'); draftWith(e, two()); confirm(e, [A]); writeFileSync(draftPath(e), JSON.stringify({ v: 1 }));   // valid JSON, no items array
    expect(resolve(e, WIN)).toMatchObject({ kind: 'none', items: [], allowRules: [], nightId: null, targetWindowStartMs: null });
    const f = tmp('afk-resolve'); await approvedYesterday(f); writeFileSync(draftPath(f), '{oops');
    expect(resolve(f, WIN).kind).toBe('none');                           // control for the next line: the same setup with an intact draft is unfinished
    draftWith(f, two()); confirm(f, [A]);
    expect(resolve(f, WIN).kind).toBe('unfinished');
  });
});
describe('resolveNightPlan: unfinished', () => {
  it('(c) an unfinished night with an unconfirmed amendment runs only the confirmed items, on the stored standing terms', async () => {
    const d = tmp('afk-resolve'); await approvedYesterday(d);
    writeLiveTerms(d, { ...DEFAULT_TERMS, opusEscalation: true });     // the live file was edited after that approval
    draftWith(d, two()); confirm(d, [A]); amendDraft(d, { push: false }, NOW);   // tonight: A confirmed, an amendment never approved
    const r = resolve(d, WIN);
    expect(r.kind).toBe('unfinished'); expect(r.terms).toEqual(DEFAULT_TERMS);   // not opus (live), not push:false (amendment)
    expect(r.targetWindowStartMs).toBe(WIN); expect(r.nightId).toMatch(/^n\d{8}T\d{6}$/);
    expect(ids(r.items)).toEqual([A]); expect(ids(r.held)).toEqual([B]);
    expect(r.allowRules).toEqual(buildAllowRules(DEFAULT_TERMS, r.items as any));
    expect(Object.keys(r.items[0]).sort()).toEqual(ITEM_KEYS);        // the draft's verdict/reasons/confirmed fields do not leak into an unfinished night's items
  });
  it('(d) a previous night approved with {opusEscalation:true}: the next unfinished night reads opus=false', async () => {
    const d = tmp('afk-resolve'); await approvedYesterday(d, { opusEscalation: true });
    const rec = resolve(d, WIN - DAY); expect(rec.kind).toBe('approved'); expect(rec.terms?.opusEscalation).toBe(true);   // that night did run on opus
    draftWith(d, two()); confirm(d, [A]);
    const r = resolve(d, WIN);
    expect(r.kind).toBe('unfinished'); expect(r.terms?.opusEscalation).toBe(false);
  });
  it('the unfinished target follows the STANDING window: an unconfirmed window amendment does not move it or its 12h gate', async () => {
    const d = tmp('afk-resolve'); await approvedYesterday(d); draftWith(d, two()); confirm(d, [A]);
    expect(amendDraft(d, { window: { start: '22:00', end: '06:00' } }, NOW).ok).toBe(true);   // never approved
    expect(JSON.parse(readFileSync(draftPath(d), 'utf8')).targetWindowStartMs).toBe(new Date(2026, 10, 4, 22).getTime());   // control: the draft's own target moved to 22:00
    const r = resolve(d, WIN);
    expect(r.kind).toBe('unfinished'); expect(r.terms?.window).toEqual({ start: '01:00', end: '07:00' });
    expect(r.targetWindowStartMs).toBe(WIN);                                                  // the standing 01:00, not the amended 22:00
    expect(resolve(d, new Date(2026, 10, 5, 11).getTime()).kind).toBe('unfinished');         // 11:00 is past 22:00+12h but inside 01:00+12h
  });
  it('the draft an approval was made from is never its own unfinished night, even when the approval amended the window', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]);
    expect(amendDraft(d, { window: { start: '22:00', end: '06:00' } }, NOW).ok).toBe(true);
    await approve(d, { ...DEFAULT_TERMS, window: { start: '22:00', end: '06:00' } } as any);   // approved at NOW: record target 22:00, gate 10:00 next day
    const at = new Date(2026, 10, 5, 9).getTime();
    expect(resolve(d, at)).toMatchObject({ kind: 'approved', targetWindowStartMs: new Date(2026, 10, 4, 22).getTime() });   // control: still inside the approved night's 12h gate
    expect(resolve(d, new Date(2026, 10, 5, 10, 30).getTime())).toMatchObject({ kind: 'none', items: [], targetWindowStartMs: null });   // lapsed; without the createdAtMs clause this is unfinished for target 01:00
  });
  it('(l) a corrupt live terms.json changes neither an approved nor an unfinished result (resolve never reads it)', async () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]); await approve(d);
    const before = resolve(d, WIN); writeFileSync(termsPath(d), '{nope');
    expect(resolve(d, WIN)).toEqual(before); expect(before.kind).toBe('approved');
    const e = tmp('afk-resolve'); await approvedYesterday(e); draftWith(e, two()); confirm(e, [A]);
    const u = resolve(e, WIN); writeFileSync(termsPath(e), '{nope');
    expect(resolve(e, WIN)).toEqual(u); expect(u.kind).toBe('unfinished');
  });
  it('unfinishedSelection is the one computation: it returns exactly what an unfinished night resolves to', async () => {
    const d = tmp('afk-resolve'); await approvedYesterday(d); draftWith(d, two()); confirm(d, [A]);
    const r = resolve(d, WIN); const a = readApproved(d);
    expect(r.kind).toBe('unfinished'); expect(a.ok).toBe(true);
    const s = unfinishedSelection({ draft: readDraft(d)!, record: (a as any).record, ctx: ctxFor(HOME) });
    expect({ terms: r.terms, termsSha256: r.termsSha256, items: r.items, held: r.held, allowRules: r.allowRules }).toEqual(s);
  });
  it('(e) the first-ever night, with no last-approved terms, returns none', () => {
    const d = tmp('afk-resolve'); draftWith(d, two()); confirm(d, [A]);
    expect(resolve(d, WIN)).toMatchObject({ kind: 'none', items: [], allowRules: [], nightId: null, targetWindowStartMs: null, reason: expect.stringMatching(/last-approved/) });
  });
  it('a confirmed plan item whose spec went back to draft is held, not run', async () => {
    const home = tmp('afk-home'); const plan = putPlan(home, 'approved');
    const d = tmp('afk-resolve'); await approvedYesterday(d);
    draftWith(d, [plan, mkItem(A, 'item a')]); confirm(d, [plan.id, A], home);
    putPlan(home, 'DRAFT');
    const r = resolve(d, WIN, home);
    expect(r.kind).toBe('unfinished'); expect(ids(r.items)).toEqual([A]);
    expect(r.held).toEqual([{ id: plan.id, title: plan.title, verdict: 'ready', reason: 'recheck:spec-not-approved' }]);
  });
  it('nothing confirmed, or a stale draft, resolves to none', async () => {
    const d = tmp('afk-resolve'); await approvedYesterday(d); draftWith(d, two());
    expect(resolve(d, WIN).kind).toBe('none');
    confirm(d, [A]);
    expect(resolve(d, WIN + 12 * 3600e3 + 1).kind).toBe('none');
  });
  it('an empty directory is none, not an error', () => {
    expect(resolve(tmp('afk-resolve'), NOW)).toMatchObject({ kind: 'none', allowRules: [] });
  });
});
```

As built (checked against `resolvePlan.mjs` and `skills/afk-preflight/SKILL.md` step 8): the catch-all in `resolveNightPlan` turns any thrown error into `kind: 'none'` with a `reason` that starts with `resolve failed:`. Consumers (the skill, any later runner) must show that prefix as an error, because it means a code defect and not an ordinary empty night. An `unfinished` result with `items: []` means nothing will run.

- [ ] **Steps 2-5:** run `npx vitest run scripts/afk/resolvePlan.test.ts` (expect FAIL: cannot resolve the module). Implement `resolvePlan.mjs`. Rerun (expect PASS). Commit: `git add -- scripts/afk/resolvePlan.mjs scripts/afk/resolvePlan.test.ts && git commit -m "feat(afk): resolveNightPlan, the approved/unfinished/none entry point" -- scripts/afk/resolvePlan.mjs scripts/afk/resolvePlan.test.ts`.

---

### Task 17: CLI verbs and the TTY gate

**Files (all created, except where an Interfaces line says modified):**
```owned T17
scripts/afk/cli.mjs
scripts/afk/afk.mjs
scripts/afk/cli.test.ts
```

**Interfaces:**
- Consumes: T1, T3, T4 (`isNightCurrent`), T9 (`realProbes`, `checkFeasibility`), T10 (`compileNightList`), T11, T12 (`readApproved`), T14 (`readDraft`, `confirmItems`), T15, T16 (`resolveNightPlan`, `unfinishedSelection`); tests also use `draftFixture.ts` (`okProbes`), `denyRules.mjs` (`buildAllowRules`) and `terms.mjs` (`DEFAULT_TERMS`).
- `cli.mjs` exports `VERBS` (array of verb names), `TTY_VERBS = ['terms set','amend','confirm','approve']`, `isInteractive(stdin, stdout): boolean` = `Boolean(stdin?.isTTY && stdout?.isTTY)` (the one TTY predicate, so a unit test can pin the AND) and `main(argv, deps): Promise<number>` with `deps = {homeDir, nowMs, isTty, readLine, print, env, probes?}` (`probes` defaults to `realProbes({homeDir, env})`; tests inject). `aetherDir = join(homeDir,'.aether-os')`. `afk.mjs` is the executable entry only: reads `os.homedir()`, `Date.now()`, `isInteractive(process.stdin, process.stdout)`, a `readline` question helper, then `process.exit(await main(...))`. Shebang `#!/usr/bin/env node`.
- Verbs:
  - `terms show` (prints the effective live terms, `delete: NOT ALLOWED`, the hash, and any `live.warnings` as `WARNING live terms: ...`); `terms set <key> <value>` (TTY; keys: any amendable key, plus `window.start`/`window.end`; booleans `true|false`; `delete`/`forcePush`/`notifications` refused with exit 4).
  - `compile --project <leaf>... [--plan <path>...] [--handoff <path>...] [--max-age-days N] [--json]`: passes the LIVE terms window (`readLiveTerms(aetherDir).terms.window`) to `compileNightList`, never its default; REPLACES the draft via `replaceDraft`; prints the items grouped ready/question/barred with ids and the draft label, and says that confirmations and amendments start over. If `readApproved` verifies and `isNightCurrent(nowMs, record.targetWindowStartMs)`, it also prints, and adds to the `--json` `warnings`, `night <id> is approved and will run; this new draft does not replace it until you approve it`.
  - `feasibility`: read-only; runs `checkFeasibility` on each build item of the draft with the probes and prints the result per item; stores nothing.
  - `confirm <id>... | --all-ready` (TTY): `confirmItems(aetherDir, ids, {homeDir, probes}, nowMs)`; prints each refusal (including `stale-draft` for every id when the draft's window passed more than 12h ago: compile again) with its reason; exit 4 if any id was refused. Last, when the re-read draft has at least one confirmed item, it prints the **unfinished-night allowlist** (Open item 9, decided 2026-11-05), after the approved-night note if there is one. Header: `if this night ends unfinished (no approve), it would run on the last-approved standing terms with this allowlist:`. It calls `readApproved(aetherDir)`. If that is not `ok`, it prints `no unfinished-night allowlist exists yet: ` plus `no night has ever been approved, so an unfinished night would run nothing` for `reason: 'missing'` (Open item 8), else `the last approval record failed: <reason>`. If `ok`, it calls `unfinishedSelection({draft: readDraft(aetherDir), record: a.record, ctx: {homeDir, probes}})` (the same function `resolveNightPlan` uses; `cli.mjs` computes no rule itself) and prints the first 8 hex of `termsSha256`, each item's id and title, and `allowRules` one per line, then `these are the last-approved terms, not tonight's amendments; approve prints the list for the whole night`. The block is advisory: it does not change the exit code and ignores the 12h window gate.
  - `amend <key> <value>` (TTY; same key spellings as `terms set`, so `window.start`/`window.end` merge into the effective window): `amendDraft(aetherDir, patch, nowMs)`, which recomputes the draft's target window; a stale draft is refused with `stale-draft` (exit 4).
  - After `confirm` and `amend` succeed, when a verifying approved record is current (the same test `compile` uses), each prints `night <id> is approved and will run; this change edits only the draft and does not alter it (only approve does)`, so Matt is not left thinking a confirmation joined tonight's run.
  - `approve` (TTY): `approveNight` with the draft, probes and `readLine`.
  - `plan [--json]` (prints `resolveNightPlan` for now); `deny-rules` (prints `buildDenyRules(readLiveTerms().terms)` as one JSON object `{"protect": [...], "run": [...]}`; `protect` is what Matt pastes into global settings, `run` is for Phase 2's per-run disallow list; any live-terms warning goes to stderr so stdout stays parseable); `install-skill` (T19 wires it; here it exits 4 `not available yet`).
- Exit codes: 0 ok, 2 usage/unknown verb, 3 TTY required and absent (nothing written, nothing read from stdin), 4 refused or invalid, 1 unexpected error (message only, no stack with paths).

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TTY_VERBS, VERBS, isInteractive, main } from './cli.mjs';
import { readLiveTerms, termsPath } from './termsStore.mjs';
import { readDraft } from './draft.mjs';
import { buildAllowRules } from './denyRules.mjs';
import { DEFAULT_TERMS } from './terms.mjs';
import { okProbes } from './draftFixture';
const entry = fileURLToPath(new URL('./afk.mjs', import.meta.url));
const tmpHome = () => mkdtempSync(join(tmpdir(), 'afk-cli-'));
const run = (home: string, args: string[]) =>
  spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', input: '', env: { ...process.env, HOME: home, USERPROFILE: home } });
const aether = (home: string) => join(home, '.aether-os');
const T0 = new Date(2026, 10, 4, 23).getTime();   // the pinned evening of the in-process tests
// Handoff eligibility is judged against nowMs by file mtime, so a test with a pinned clock stamps the file with that clock;
// spawned tests run on the real clock and take the default.
const putHandoff = (home: string, atMs = Date.now(), project = 'p', steps = '1. Run npm test\n') => {
  const d = join(home, '.claude', 'handoffs', project); mkdirSync(d, { recursive: true });
  const f = join(d, 'h.md'); writeFileSync(f, `## Next steps\n${steps}`); utimesSync(f, new Date(atMs), new Date(atMs));
};
describe('TTY gate (spawned, piped stdio)', () => {
  // A spawned child has BOTH stdio ends piped, so it cannot tell `stdin && stdout` from `stdin || stdout`; the predicate test below pins the AND.
  it('isInteractive needs both ends to be a TTY', () => {
    expect(isInteractive({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(isInteractive({ isTTY: true }, { isTTY: false })).toBe(false);
    expect(isInteractive({ isTTY: false }, { isTTY: true })).toBe(false);
    expect(isInteractive({}, {})).toBe(false); expect(isInteractive(undefined as any, undefined as any)).toBe(false);
  });
  it.each([
    [['terms', 'set', 'opusEscalation', 'true']],
    [['amend', 'opusEscalation', 'true']],
    [['confirm', '--all-ready']],
    [['approve']],
  ])('%j exits 3 and writes nothing', (args) => {
    const home = tmpHome(); const r = run(home, args);
    expect(r.status).toBe(3);
    expect(existsSync(aether(home))).toBe(false);
  });
});
describe('read verbs (spawned)', () => {
  it('terms show prints defaults and the hash; delete is shown as not allowed', () => {
    const r = run(tmpHome(), ['terms', 'show']);
    expect(r.status).toBe(0); expect(r.stdout).toMatch(/[0-9a-f]{64}/); expect(r.stdout).toContain('delete: NOT ALLOWED');
  });
  it('plan with nothing on disk is none', () => {
    const r = run(tmpHome(), ['plan', '--json']);
    expect(r.status).toBe(0); expect(JSON.parse(r.stdout).kind).toBe('none');
  });
  it('deny-rules prints a JSON object with the protect and run groups', () => {
    const o = JSON.parse(run(tmpHome(), ['deny-rules']).stdout);
    expect(o.protect).toContain('Edit(~/.aether-os/afk/**)'); expect(o.protect).not.toContain('Bash(rm:*)'); expect(o.run).toContain('Bash(rm:*)');
  });
  it('a corrupt terms file is surfaced by terms show and deny-rules, and deny-rules keeps stdout parseable JSON', () => {
    const home = tmpHome(); mkdirSync(join(aether(home), 'afk'), { recursive: true }); writeFileSync(termsPath(aether(home)), '{nope');
    expect(run(home, ['terms', 'show']).stdout).toMatch(/WARNING live terms/);
    const r = run(home, ['deny-rules']);
    expect(r.stderr).toMatch(/WARNING live terms/); expect(JSON.parse(r.stdout).run).toContain('Bash(rm:*)');
  });
  it('unknown verb exits 2', () => { expect(run(tmpHome(), ['frobnicate']).status).toBe(2); });
  it('compile writes the one draft under ~/.aether-os/afk', () => {
    const home = tmpHome(); putHandoff(home);
    const r = run(home, ['compile', '--project', 'p', '--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.draftId).toMatch(/^n\d{8}T\d{6}$/); expect(out.items[0].title).toBe('Run npm test');
    expect(readDraft(aether(home))?.draftId).toBe(out.draftId);
  });
});
describe('main() with a TTY (in process)', () => {
  // readLine answers the "Type exactly: <phrase>" prompt with the phrase it was shown (the gate itself is tested in approveFlow.test.ts)
  const deps = (home: string, out: string[] = [], nowMs = T0) => ({ homeDir: home, nowMs, isTty: true, readLine: async (q: string) => q.split(': ').pop()!.trim(), print: (s: string) => { out.push(s); }, env: {} });
  it('terms set writes through the store', async () => {
    const home = tmpHome();
    expect(await main(['terms', 'set', 'codexReviewsPerPush', '2'], deps(home))).toBe(0);
    expect(readLiveTerms(aether(home)).terms.codexReviewsPerPush).toBe(2);
  });
  it.each([['delete', 'true'], ['forcePush', 'true'], ['notifications', 'toast']])('terms set %s %s is refused (exit 4)', async (k, v) => {
    const home = tmpHome();
    expect(await main(['terms', 'set', k, v], deps(home))).toBe(4);
    expect(existsSync(termsPath(aether(home)))).toBe(false);
  });
  it('compile targets the live terms window, not the 01:00 default', async () => {
    const home = tmpHome(); putHandoff(home, T0);
    expect(await main(['terms', 'set', 'window.start', '22:00'], deps(home))).toBe(0);
    expect(await main(['compile', '--project', 'p'], deps(home))).toBe(0);
    expect(readDraft(aether(home))?.targetWindowStartMs).toBe(new Date(2026, 10, 4, 22).getTime());
  });
  it('amend window.start recomputes the draft\'s target window', async () => {
    const home = tmpHome(); putHandoff(home, T0);
    await main(['compile', '--project', 'p'], deps(home));
    expect(await main(['amend', 'window.start', '21:00'], deps(home))).toBe(0);
    expect(readDraft(aether(home))?.targetWindowStartMs).toBe(new Date(2026, 10, 4, 21).getTime());
  });
  it('a second compile replaces the draft: one draft, a new label, nothing confirmed', async () => {
    const home = tmpHome(); putHandoff(home, T0);
    await main(['compile', '--project', 'p'], deps(home)); await main(['confirm', '--all-ready'], deps(home));
    expect(readDraft(aether(home))?.items[0].confirmed).toBe(true);
    await main(['compile', '--project', 'p'], deps(home, [], T0 + 5000));
    const dr = readDraft(aether(home));
    expect(dr?.items.map((i: any) => i.confirmed)).toEqual([false]); expect(dr?.createdAtMs).toBe(T0 + 5000);
  });
  it('compile after approval says the approved night stands, and plan still returns it as approved', async () => {
    const home = tmpHome(); putHandoff(home, T0);
    await main(['compile', '--project', 'p'], deps(home));
    await main(['confirm', '--all-ready'], deps(home));
    expect(await main(['approve'], deps(home))).toBe(0);
    const out: string[] = [];
    expect(await main(['compile', '--project', 'p'], deps(home, out, T0 + 5000))).toBe(0);
    expect(out.join('\n')).toMatch(/is approved and will run/);
    const plan: string[] = [];
    expect(await main(['plan', '--json'], deps(home, plan, T0 + 6000))).toBe(0);
    expect(JSON.parse(plan.join('\n'))).toMatchObject({ kind: 'approved', targetWindowStartMs: new Date(2026, 10, 5, 1).getTime(), items: [{ title: 'Run npm test' }] });
  });
  it('confirm and amend after approval say the approved night is unchanged', async () => {
    const home = tmpHome(); putHandoff(home, T0);
    await main(['compile', '--project', 'p'], deps(home)); await main(['confirm', '--all-ready'], deps(home)); await main(['approve'], deps(home));
    const a: string[] = []; const b: string[] = [];
    expect(await main(['confirm', '--all-ready'], deps(home, a, T0 + 5000))).toBe(0);
    expect(await main(['amend', 'opusEscalation', 'true'], deps(home, b, T0 + 6000))).toBe(0);
    expect(a.join('\n')).toMatch(/is approved and will run/); expect(b.join('\n')).toMatch(/is approved and will run/);
  });
  it('confirm prints the allowlist an unfinished night would run on: the confirmed build item\'s rules, none for a held one', async () => {
    const home = tmpHome(); putHandoff(home, T0, 'aether-os', '1. Build the APK for aether-os\n2. Build the installer for aether-os\n');
    const d = (out: string[] = [], t = T0) => ({ ...deps(home, out, t), probes: okProbes });
    await main(['compile', '--project', 'aether-os'], d()); await main(['confirm', '--all-ready'], d()); await main(['approve'], d());   // creates the last-approved terms
    await main(['compile', '--project', 'aether-os'], d([], T0 + 5000));
    const apk = readDraft(aether(home))!.items.find((i: any) => /APK/.test(i.title))!;
    const out: string[] = [];
    expect(await main(['confirm', apk.id], d(out, T0 + 6000))).toBe(0);            // only the APK; the installer item stays held (not confirmed)
    const text = out.join('\n');
    for (const rule of buildAllowRules(DEFAULT_TERMS, [{ project: 'aether-os', kind: 'build', artifact: 'apk' }])) expect(text).toContain(rule);
    expect(text).toContain('Bash(gradlew.bat assembleDebug:*)'); expect(text).not.toContain('Bash(npm run dist:*)');
  });
  it('confirm with no last-approved terms says no unfinished allowlist exists yet and prints no rule', async () => {
    const home = tmpHome(); putHandoff(home, T0, 'aether-os', '1. Build the APK for aether-os\n'); const out: string[] = [];
    await main(['compile', '--project', 'aether-os'], { ...deps(home), probes: okProbes });
    expect(await main(['confirm', '--all-ready'], { ...deps(home, out), probes: okProbes })).toBe(0);
    expect(out.join('\n')).toMatch(/no unfinished-night allowlist exists yet/); expect(out.join('\n')).not.toContain('Bash(');
  });
  it('TTY_VERBS is exactly the write set, and every verb is declared', () => {
    expect([...TTY_VERBS].sort()).toEqual(['amend', 'approve', 'confirm', 'terms set']);
    for (const v of ['terms show', 'compile', 'feasibility', 'plan', 'deny-rules', 'install-skill', ...TTY_VERBS]) expect(VERBS).toContain(v);
  });
});
```

Carry (build review): (1) `confirm`'s unfinished-night allowlist preview must skip itself, or say so, when `draft.createdAtMs <= record.approvedAtMs` (the last approval is newer than the draft, so it is not an unfinished night for this draft). Add a cli test: compile at T0, then `confirm` and `amend` at T0 + 2*DAY must exit 4 with the stale-draft text. (2) Every `writeLiveTerms` call (T3) is wrapped: an EPERM or other fs error becomes a clean nonzero exit with a message that carries no file content.

As built (checked against `cli.mjs`, `afk.mjs` and `cli.test.ts` after merge): `afk.mjs` sets `process.exitCode` instead of calling `process.exit`, so piped output is not truncated. An unknown or non-amendable key in `terms set` or `amend` exits 4 (not 2). `confirm --all-ready` with nothing ready prints `nothing is ready to confirm` and exits 0 (no test pins that exit). `approve` prints the refusal `message` and exits 4 for ANY `approveNight` refusal, including `state-changed` and any code the CLI does not know. `terms set` on an invalid terms file prints `WARNING live terms: <warning>` for each warning and a line saying the file was rewritten from the defaults plus the one change, before the success line, and exits 0.

- [ ] **Steps 2-5:** run `npx vitest run scripts/afk/cli.test.ts` (expect FAIL: cannot resolve the module). Implement `cli.mjs` and `afk.mjs`. Dispatch table keyed by verb; a verb in `TTY_VERBS` checks `deps.isTty` BEFORE reading anything or creating any directory. The in-process tests that confirm or approve inject no `probes` (their items are plain `work` items, so no probe runs), except the two allowlist tests, which inject `okProbes` because their items are build items. `cli.mjs` imports `unfinishedSelection` from `resolvePlan.mjs`; it must not recompute an allowlist. Rerun (expect PASS). Commit: `git add -- scripts/afk/cli.mjs scripts/afk/afk.mjs scripts/afk/cli.test.ts && git commit -m "feat(afk): afk CLI with TTY-gated write verbs" -- scripts/afk/cli.mjs scripts/afk/afk.mjs scripts/afk/cli.test.ts`.

---

### Task 18: Directory boundary guard

**Files (all created, except where an Interfaces line says modified):**
```owned T18
scripts/afk/afkBoundary.test.ts
```

**Carry (build review):** add a `strip` test: `const r = 'Edit(~/.aether-os/afk/**)'; /* c */ writeFileSync(p)` must still leave `writeFileSync(p)` visible so the WRITE pattern matches (a `/*` inside a string literal must not swallow the code after it). That input alone does not bite: with the string-literal guard removed, the lazy comment match still ends at the later `*/`. As built, the test (in `afkBoundary.test.ts`) also asserts an input that does bite, an unclosed `/*` in a string followed by a real comment:

```ts
  it('strip keeps code after a /* inside a string literal visible', () => {
    const out = strip("const r = 'Edit(~/.aether-os/afk/**)'; /* c */ writeFileSync(p)");
    expect(out).toContain('writeFileSync(p)');
    expect(out).toMatch(WRITE);
    // The input above survives even an unguarded strip; this one (an unclosed /* in a string, then a real comment) does not.
    expect(strip("const g = '/*'; writeFileSync(p) /* c */")).toMatch(WRITE);
  });
```

**Interfaces:** a test only, in the style of `electron/aetherChoice/aetherChoiceBoundary.test.ts` and `electron/voice/voiceBoundary.test.ts`: it pins design rules mechanically so a later edit cannot quietly break them. Source files are the non-test `.mjs` in `scripts/afk/`, comments stripped (a simple `//` and `/* */` strip is enough; strings still count; a `/*` opens a comment only at line start or after whitespace, so the quoted rule `'Edit(~/.aether-os/afk/**)'` in `denyRules.mjs` cannot open a fake comment and blind the scan).

- [ ] **Step 1: Write the failing test.** It passes immediately if T1-T17 obeyed the constraints; "fails first" is demonstrated by the red-proof below, not by a missing module.

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
const strip = (s: string) => s.replace(/(^|\s)\/\*[\s\S]*?\*\//gm, '$1').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const src = Object.fromEntries(files.map((f) => [f, strip(readFileSync(join(dir, f), 'utf8'))]));
const WRITERS = ['fsJson.mjs', 'installSkill.mjs'];
const DELETERS = ['fsJson.mjs'];   // may remove only its own *.afktmp-* file after a failed atomic write
// Call forms only: the quoted rule string 'Bash(rmdir:*)' in denyRules.mjs and RegExp.exec() must not match.
// Bare `truncate(` is deliberately NOT here: it is the natural name for the 140-character title cut. `truncateSync` and `ftruncate` are.
const WRITE = /\b(writeFile|appendFile|rename|copyFile|cp|open|truncateSync|ftruncate|mkdir|mkdtemp|symlink|link|utimes|chmod|createWriteStream)(Sync)?\s*\(/;
const DELETE = /\b(unlink|rm|rmdir)(Sync)?\s*\(/;
describe('the guard patterns', () => {
  it('match call forms', () => {
    for (const s of ['fs.unlinkSync(p)', 'rmSync(p, {})', 'fs.promises.rm(p)', 'fs.rmdirSync(d)']) expect(s).toMatch(DELETE);
    for (const s of ['writeFileSync(p, x)', 'fs.renameSync(a, b)', 'openSync(p, "w")', 'fs.truncateSync(p, 0)', 'mkdirSync(d)']) expect(s).toMatch(WRITE);
  });
  it('do not match rule strings, RegExp.exec or prose', () => {
    for (const s of ["'Bash(rmdir:*)'", "'Bash(rm:*)'", "'Bash(git rm:*)'", '/x/.exec(s)', 'the removed rename note', 'truncate(title, 140)']) {
      expect(s).not.toMatch(DELETE); expect(s).not.toMatch(WRITE);
    }
  });
});
describe('scripts/afk boundary', () => {
  it('is non-empty', () => { expect(files.length).toBeGreaterThan(10); });
  it('no child_process, no claude launch, no model id', () => {
    for (const [f, s] of Object.entries(src)) {
      expect(s, f).not.toMatch(/child_process/);
      expect(s, f).not.toMatch(/claude-[a-z]+-\d/);
    }
  });
  it('bypassPermissions and dangerous flags appear nowhere', () => {
    for (const [f, s] of Object.entries(src)) expect(s, f).not.toMatch(/bypassPermissions|dangerously-skip|--dangerously/i);
  });
  it('filesystem writes happen only in the reviewed writer modules', () => {
    for (const [f, s] of Object.entries(src)) if (!WRITERS.includes(f)) expect(s, f).not.toMatch(WRITE);
  });
  it('nothing deletes outside the one reviewed exception', () => {
    for (const [f, s] of Object.entries(src)) if (!DELETERS.includes(f)) expect(s, f).not.toMatch(DELETE);
  });
  it('no network listener or fetch', () => {
    for (const [f, s] of Object.entries(src)) expect(s, f).not.toMatch(/\.listen\(|createServer|\bfetch\(|node:http|node:net/);
  });
});
```

Both lists are closed: `fsJson.mjs` is the only module allowed to delete (its own `*.afktmp-*` temp file) and, with `installSkill.mjs`, the only one allowed to write. If any other module needs to write or delete, stop and report instead of widening either list.

- [ ] **Step 2: Red-proof.** Temporarily add `import 'node:child_process';` to `cli.mjs`; run `npx vitest run scripts/afk/afkBoundary.test.ts` and see "no child_process" fail; revert.
- [ ] **Step 3:** `npx vitest run scripts/afk` -> PASS for the whole directory (T1-T18). Also run `npx vitest run src/shared/noApiCalls.test.ts electron/remote/noWildcardListener.test.ts` -> PASS.
- [ ] **Step 4: Commit**

```bash
P="scripts/afk/afkBoundary.test.ts"
git add -- $P && git commit -m "test(afk): directory boundary guard" -- $P
```

---

### Task 19: The pre-flight skill and its installer

**Files (all created, except where an Interfaces line says modified):**
```owned T19
skills/afk-preflight/SKILL.md
scripts/afk/installSkill.mjs
scripts/afk/installSkill.test.ts
scripts/afk/cli.mjs
electron-builder.yml
```

**Interfaces:**
- `cli.mjs` is MODIFIED here (wire `install-skill`), as is `electron-builder.yml` (one added `extraResources` entry, Step 3b); everything else in this task is created.
- `installSkill.mjs` exports `renderSkill(template, cliPath): string` (replaces every `{{AFK_CLI}}` token; throws if the token is absent or `cliPath` contains a quote, newline or backtick) and `installSkill({homeDir, templatePath, cliPath}): string` (writes `<homeDir>/.claude/skills/afk-preflight/SKILL.md`, returns the path). `install-skill` is run by Matt; it is the only code that writes under `~/.claude`.
- **Template location (packaging).** `installSkill.mjs` imports Node builtins only (so a copy of it runs from the packaged `resources/scripts/afk/`) and also exports `defaultTemplatePath(): string` = `fileURLToPath(new URL('../../skills/afk-preflight/SKILL.md', import.meta.url))`. That one relative path is correct in both layouts: dev `<repo>/scripts/afk/` -> `<repo>/skills/afk-preflight/SKILL.md`; packaged `<resources>/scripts/afk/` -> `<resources>/skills/afk-preflight/SKILL.md`. The packaged file exists only because of the `electron-builder.yml` entry in Step 3b: the current config puts only `out/**/*` and `package.json` in the asar and copies only `scripts/**/*.mjs` through `extraResources`, and nothing under `skills/` is referenced by the config or the build scripts, so without the entry an installed build has the CLI but no template. `install-skill` passes `templatePath: defaultTemplatePath()`; a missing template exits 4 naming the path and writes nothing.
- `SKILL.md` frontmatter: `name: afk-preflight`; `description` lists Matt's confirmed phrases ("going to bed", "heading to bed", "off to bed", "going afk"; part 8 of the GUI design also lists "going to work", "stepping away", "heading out", "brb", "be right back": only the overnight ones belong here) and says it prepares an overnight run. Body, in this order, each as a short numbered step: (1) run `node "{{AFK_CLI}}" terms show` and show the terms; (2) ask which projects tonight covers (default: this repo's folder name; the handoff folder name, not a worktree name); (3) run `compile --project …` before any `confirm` or `amend` (every run starts the draft over and drops every confirmation and amendment), show ready / question / barred; (4) ask the clarifying questions for `question` items, at most 3 rounds of at most 4 questions, then stop and say "no open doubts" or list what stays held. An answer changes nothing in state (Open item 11): when Matt settles a question he edits the source himself (the handoff's Next steps line, the ledger line, or the plan), and the agent then runs compile again (the template carries the sentence "compile again after editing the source line, BEFORE any confirm" verbatim). The edited line is a new item with a new id and nothing is confirmed yet. The skill names the two edits one line cannot do: a `question:needs-matt` that comes from the handoff's `## Next steps` HEADING note (for example `(all need Matt)`) is cleared by removing that note from the heading, not by editing an item; one that comes from a ledger line's `[pending ...]` state (for example `[pending Matt]`) is cleared by changing that state to `[todo]`. A question about an unapproved spec or a missing plan is settled by approving the spec or adding the plan, then compiling again. Whatever Matt does not settle stays held. The agent never edits or rewords a handoff, ledger or plan line to clear a `?`; (5) run `feasibility`; (6) state back what will run, what is set aside, which terms apply, and that `confirm` prints the allowlist an unfinished night would run on (from the last-approved terms) and `approve` will print the exact allowlist rules for him to approve, with the two limits printed beside it (the push rule is a prefix, and no Edit/Write rules are included so file-editing items may go yellow); (7) if Matt edited any source line since the last `compile`, run `compile` again first; then tell Matt to type `node "{{AFK_CLI}}" confirm --all-ready` (or specific ids), optionally `amend`, then `approve`, **himself in a shell with a TTY** (which shell, the claude `!` escape or a plain PowerShell window, is the T13 result and goes into the skill text) and to say "done" afterwards; (8) after "done" run `plan` and report what it returned. Rules block: never run `terms set`, `amend`, `confirm` or `approve` (they refuse without a TTY and trying is a violation); never edit anything under `~/.aether-os/afk`; never guess past an ambiguity; never edit or reword a handoff, ledger or plan line to make a question disappear; deletion, force-push and cleanup are never on the night; a task Matt names that is in no handoff, ledger or plan is added by him to the handoff's Next steps and `compile` is re-run (Phase 1 has no add-item verb, Open item 10); an unfinished pre-flight still runs the confirmed items on the last-approved STANDING terms and everything else is held.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VERBS } from './cli.mjs';
import { defaultTemplatePath, installSkill, renderSkill } from './installSkill.mjs';
const templatePath = fileURLToPath(new URL('../../skills/afk-preflight/SKILL.md', import.meta.url));
const template = readFileSync(templatePath, 'utf8');
describe('renderSkill', () => {
  it('replaces every token', () => {
    const out = renderSkill('a {{AFK_CLI}} b {{AFK_CLI}}', 'C:/x/afk.mjs');
    expect(out).toBe('a C:/x/afk.mjs b C:/x/afk.mjs');
  });
  it.each(['C:/x"y', 'a\nb', 'a`b'])('rejects a path containing %j', (p) => { expect(() => renderSkill('{{AFK_CLI}}', p)).toThrow(); });
  it('throws when the template has no token', () => { expect(() => renderSkill('nothing', 'C:/x')).toThrow(); });
});
describe('installSkill', () => {
  it('writes under the given home only', () => {
    const home = mkdtempSync(join(tmpdir(), 'afk-skill-'));
    const dest = installSkill({ homeDir: home, templatePath, cliPath: 'C:/r/scripts/afk/afk.mjs' });
    expect(dest).toBe(join(home, '.claude', 'skills', 'afk-preflight', 'SKILL.md'));
    expect(readFileSync(dest, 'utf8')).toContain('C:/r/scripts/afk/afk.mjs');
    expect(readFileSync(dest, 'utf8')).not.toContain('{{AFK_CLI}}');
  });
});
describe('template location', () => {
  // Resolved from this file, not process.cwd(): collector/vitest.config.ts runs these tests from collector/.
  const yml = readFileSync(fileURLToPath(new URL('../../electron-builder.yml', import.meta.url)), 'utf8');
  it('electron-builder.yml ships SKILL.md to the folder defaultTemplatePath() reads in a packaged install', () => {
    const m = yml.match(/- from: skills\/afk-preflight\r?\n\s+to: (\S+)\r?\n\s+filter:\r?\n\s+- '?SKILL\.md'?\r?\n/);
    expect(m, 'extraResources has no skills/afk-preflight entry for SKILL.md').not.toBeNull();
    // <resources>/scripts/afk/installSkill.mjs + ../../skills/afk-preflight/SKILL.md
    expect(posix.normalize('scripts/afk/../../skills/afk-preflight/SKILL.md')).toBe(`${m![1]}/SKILL.md`);
  });
  it('in the repo, defaultTemplatePath() is the real template', () => {
    expect(defaultTemplatePath()).toBe(templatePath); expect(existsSync(defaultTemplatePath())).toBe(true);
  });
  it('a copy laid out like resources/ finds the template beside it', () => {
    const res = mkdtempSync(join(tmpdir(), 'afk-res-'));
    mkdirSync(join(res, 'scripts', 'afk'), { recursive: true }); mkdirSync(join(res, 'skills', 'afk-preflight'), { recursive: true });
    const copy = join(res, 'scripts', 'afk', 'installSkill.mjs');
    copyFileSync(fileURLToPath(new URL('./installSkill.mjs', import.meta.url)), copy);
    copyFileSync(templatePath, join(res, 'skills', 'afk-preflight', 'SKILL.md'));
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(copy).href)}).then((m) => console.log(m.defaultTemplatePath()))`], { encoding: 'utf8', cwd: tmpdir() });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(r.stdout.trim(), 'utf8')).toBe(template);
  });
});

describe('SKILL.md template', () => {
  it('has the frontmatter name and the overnight phrases', () => {
    expect(template).toMatch(/^---\r?\nname: afk-preflight\r?\n/);
    for (const p of ['going to bed', 'heading to bed', 'off to bed', 'going afk']) expect(template).toContain(p);
  });
  it('every `afk.mjs <verb>` it tells the agent to run is a real verb', () => {
    const verbs = [...template.matchAll(/\{\{AFK_CLI\}\}"\s+([a-z-]+(?: set| show)?)/g)].map((m) => m[1]);
    expect(verbs.length).toBeGreaterThan(3);
    for (const v of verbs) expect(VERBS, v).toContain(v);
  });
  it('forbids the agent from the TTY verbs and from editing the afk dir', () => {
    expect(template).toMatch(/never run[^.]*terms set[^.]*amend[^.]*confirm[^.]*approve/i);
    expect(template).toContain('~/.aether-os/afk');
  });
  it('settles answered questions by a source edit and a fresh compile before any confirm, and never edits a source line itself', () => {
    expect(template).toContain('compile again after editing the source line, BEFORE any confirm');
    expect(template).toMatch(/never edit or reword[^.]*(handoff|ledger|plan)/i);
    expect(template).toMatch(/heading/i); expect(template).toContain('[pending'); expect(template).toContain('[todo]');   // the two edits one line cannot do
    expect(VERBS).not.toContain('resolve');   // Phase 1 has no state transition from question to ready (Open item 11)
  });
  it('never mentions bypassPermissions', () => { expect(template).not.toMatch(/bypassPermissions/i); });
  it('sends Matt to a plain PowerShell window and never suggests the ! escape', () => {
    expect(template).toContain('plain PowerShell window');
    expect(template).not.toMatch(/`!|\s!\s|the !|! escape/);
  });
  it('step 8 reports a resolve-failed reason as an error, and what unfinished and none mean', () => {
    expect(template).toContain('resolve failed:');
    expect(template).toMatch(/resolve failed:[^.]*error/i);
    expect(template).toMatch(/unfinished[^.]*no items[^.]*nothing will run/i);
    expect(template).toMatch(/none[^.]*no night is approved/i);
  });
});
```

- [ ] **Steps 2-5:** run `npx vitest run scripts/afk/installSkill.test.ts` (expect FAIL: cannot resolve the module). Implement `installSkill.mjs`, write `skills/afk-preflight/SKILL.md` to the outline above (plain prose, ASCII punctuation, no emojis), and wire `install-skill` in `cli.mjs` (`cliPath` = the absolute path of `afk.mjs` itself via `import.meta.url`, forward slashes; `templatePath` = `defaultTemplatePath()`). Add `installSkill.mjs` to `WRITERS` in T18's guard (already listed). Update the T17 test if the stub's exit-4 case was asserted. Do Step 3b (below) before the rerun and the commit. Rerun (expect PASS). Commit: `git add -- skills/afk-preflight/SKILL.md scripts/afk/installSkill.mjs scripts/afk/installSkill.test.ts scripts/afk/cli.mjs electron-builder.yml && git commit -m "feat(afk): afk-preflight skill, install-skill verb and packaged template" -- skills/afk-preflight/SKILL.md scripts/afk/installSkill.mjs scripts/afk/installSkill.test.ts scripts/afk/cli.mjs electron-builder.yml`.
- [ ] **Step 3b: Ship the template (part of Steps 2-5).** In `electron-builder.yml`, add this entry to the `extraResources:` list directly after the existing `scripts` entry, and extend the comment above the list (it talks about scripts only) with one line saying the AFK skill template rides along for `install-skill`:

```yaml
  - from: skills/afk-preflight
    to: skills/afk-preflight
    filter:
      - SKILL.md
```

  Only `SKILL.md` is listed, so nothing else under `skills/` ships. This is a packaging config line, not Electron code; nothing in `electron/`, `src/` or the build scripts changes. The first test in `describe('template location')` fails if the entry is removed.

  As built: `install-skill` is not TTY-gated (it is not in `TTY_VERBS`; it writes one file under the home and asks nothing). When the template is missing it prints `install-skill: template not found at <path>. Nothing was written.` and exits 4. The test file needs the `cwd: tmpdir()` in the `spawnSync` call (so a cwd-based `defaultTemplatePath` fails there) and the CRLF-tolerant frontmatter regex shown above: the LF-only form went RED on the Windows CI runner (CRLF checkout).

---

### Task 20: Documentation

**Files:**
- Modify: `docs/privacy-and-data.md` (add `## 20. AFK standing terms and night state`; `## 19.` is already taken by the terminal board, PR #183), `docs/packaging.md` (a few lines, not one sentence, in section 1: `extraResources` also copies `skills/afk-preflight/SKILL.md` to `resources/skills/afk-preflight/`, and `install-skill` is meant to work from an installed build; UNVERIFIED until T21 M3), `CLAUDE.md` (one line in the architecture map for `scripts/afk/` and `skills/afk-preflight/`), `PROGRESS.md` (a "Shipped plans" entry, written when the branch merges, in the style of the entries at `PROGRESS.md:60-70`)

```owned T20
docs/privacy-and-data.md
docs/packaging.md
CLAUDE.md
PROGRESS.md
```

No new test. Content requirements for §20: what is persisted and where (`~/.aether-os/afk/`: `terms.json`, the one `draft.json` with titles of at most 140 characters, the one `approved.json` with its items, held items, allowlist, standing and effective terms and its own hash, and the `last-approved.json` pointer; no handoff bodies, no absolute paths, no secrets); that the feasibility probe reads key names and a keystore path's existence but never prints or stores a value; that the CLI makes no network call and no model call; that the write verbs need a TTY and why that is a drift guard and not a sandbox; the deny rules in two groups: the four `protect` path rules Matt installs globally (list them), and the `run` rules that belong only in Phase 2's per-run disallow list (list them, and say they are not installed globally because they would block ordinary delete and worktree-cleanup work); say plainly that both are UNVERIFIED as enforcement until T21 M2 has been run and its result recorded (do not describe them as protection before that), and that every rule is a `Bash(...)` rule whose coverage of the PowerShell tool is also unverified until M2, so Phase 2 may need mirrored PowerShell rules, and the allowlist stored in the approval record (data only; how a headless run treats it is UNVERIFIED until T21 M5); the install-skill write to `~/.claude/skills`; and that retention is "until Matt deletes the `afk` directory" (nothing in Phase 1 purges; the agent cannot, by design), and that the record's hashes detect accidental or partial edits only. Also say that titles are unmasked copies of source lines (they can hold paths and secrets). Statements about CLI output were deliberately left out of the doc after review (they kept being false).

- [ ] **Steps 1-3:** make the four edits; run `npx vitest run src/shared/noApiCalls.test.ts scripts/afk` (expect PASS), `grep -n "^## 20\." docs/privacy-and-data.md` (expect one line; `grep -n "^## 19\."` must still be one line, the terminal board) and `grep -n "skills/afk-preflight" docs/packaging.md` (expect one line); commit: `git add -- docs/privacy-and-data.md docs/packaging.md CLAUDE.md PROGRESS.md && git commit -m "docs(afk): privacy section 20, packaging note, architecture map and progress entry for Phase 1" -- docs/privacy-and-data.md docs/packaging.md CLAUDE.md PROGRESS.md`.

---

### Task 21: Live verification (no code, no commit)

**Files:** none. Output: a result note at `~/.claude/handoffs/aether-os/2026-11-04-afk-phase1-live-check.md` (outside the repo). This task needs Matt at the keyboard; the builder prepares the checklist and reports it, then stops.

```owned T21
```

- [ ] **M1: TTY reality, re-checked with the real CLI.** T13 already measured whether `!` has a TTY with a one-line probe. Here repeat it with the real verb: in an Aether terminal with `claude` running, type `! node scripts/afk/afk.mjs terms set opusEscalation false` and record the exit; then run the same in a plain PowerShell window. Expected: plain window exit 0 (or 4 if refused for no change); record what `!` does and whether it matches the T13 result. Also ask the agent to run the same command through its own Bash tool; expected exit 3.
- [ ] **M2: Deny rules.** `node scripts/afk/afk.mjs deny-rules` prints `{protect, run}`. Matt pastes ONLY the `protect` group (the four Edit/Write path rules) into the `permissions.deny` array of `~/.claude/settings.json` himself; the `run` group is NOT installed globally (it blocks `rm`, `git branch -d`, `git worktree remove` and `git rm` in every session). Then, in a fresh claude session, ask the agent to append a line to `~/.aether-os/afk/terms.json`. Expected: denied. For the `run` rules, paste them temporarily into the throwaway repo's `.claude/settings.local.json` only (remove them afterwards) and confirm a deny rule beats the existing global `allow` entries by trying `git branch -D` on a throwaway branch of that repo. Then repeat the delete test through EACH tool: `git branch -D` and `Remove-Item <throwaway file>` via the Bash tool and again via the PowerShell tool. Record whether the `Bash(...)` rules block the PowerShell tool's calls. If they do not, `buildDenyRules` needs mirrored PowerShell rules (a follow-up change to T11; record the tool name and rule syntax that worked) and Phase 2 must not rely on the `run` group until it has them. Record all results. **M2b (Safety Net layer):** in a throwaway repo with a throwaway bare remote (`git init --bare` in a temp dir), ask the agent to run `git push origin +main`, then `git push origin main --force`, then `git push origin :scratch`, then `git push origin HEAD:main` (a push straight to the branch that skips merge-gate). The prefix deny rules alone miss the first three, and catch the fourth only because `Bash(git push origin HEAD:main:*)` is an exact-form rule in the temporary paste; also try `git push origin HEAD:refs/heads/main` to see the exact-form rule miss. Record which ones the Safety Net hook blocks. UNVERIFIED until run.
- [ ] **M3: Skill.** `node scripts/afk/afk.mjs install-skill`, start a new claude session, run `/afk-preflight` (fall back to the phrase "I'm going to bed" if the slash form is not offered; if neither works, move the skill to `~/.claude/commands/afk-preflight.md` and note it). Walk a full pre-flight on a THROWAWAY project with one ready item, one question item and one barred item. Expected end state: `afk plan` prints `kind: approved` with exactly the one confirmed item, and `held` lists the other two with reasons. **Question handling:** before confirming, check that the skill asks Matt to edit the question item's line in the throwaway handoff and does not edit it itself; after his edit and a second `compile` the item is `ready` with a new id and nothing is confirmed yet, and the agent's own Bash call to `confirm` exits 3. **Packaged check:** build with `npm run dist:dir` outside the dev tree (D4 installer row; argument forwarding is UNVERIFIED), confirm `win-unpacked/resources/skills/afk-preflight/SKILL.md` sits beside `resources/scripts/afk/`, then run that copy's `afk.mjs install-skill` with `HOME` and `USERPROFILE` pointed at a temp folder. Expected: exit 0 and a rendered `SKILL.md` there.
- [ ] **M4: The bad morning, then the unfinished path.** Straight after M3's approval, run `compile --project ...` again and then `afk plan`. Expected: `kind: approved` for the night just approved (the new draft does not replace it) and the compile output says `is approved and will run`. Unfinished path, on a later evening (the approved record's window start plus 12h has passed): compile, confirm one item, do not approve, run `afk plan`. Expected: `kind: unfinished`, `terms` equal to the previous approval's STANDING terms, only the confirmed item in `items`; and the `confirm` output listed the same `allowRules` under the unfinished-night header (a held item's rules absent).
- [ ] **M5: Permission-mode semantics (D7, UNVERIFIED until run).** Matt runs this by hand in a throwaway repo; it is one cheap turn (`--model haiku`), never run by the plan's code. First run `claude --help` and record whether `--permission-mode`, `--allowedTools` and `--disallowedTools` exist on the installed version. Then run a headless `claude -p` with `--allowedTools` set to the rules from `afk plan --json` and ask it to run an allowed command (`git status`) and a command outside the list (`git clean -fd`). Record: is the unlisted call denied or does the run hang on a prompt; does a compound command (`cd x && git status`) match `Bash(git status:*)`; does the existing global `allow` list in `~/.claude/settings.json` widen the effective allowlist; do the recipe prefixes (`npm run dist`, `gradlew.bat assembleDebug`) match the real invocation. If any of these fails, the allowlist stays data and Phase 2 must not rely on it.

Report PASS/FAIL per check with the real output lines. Nothing here is committed.

(The empty `owned T21` block above is valid for `scope-check.mjs`: `parseOwned` counts the block and returns zero entries; it errors only on zero blocks, more than one, or an unterminated fence. Read at `~/agent-improvement/scripts/scope-check.mjs:36-72`, 2026-11-04.)

---

## Open items: decided by Matt 2026-11-05

Matt approved all of Claude's recommended answers on 2026-11-05. Item 9 changed the plan (T16 and T17); the rest keep the plan as written. Each item keeps its explanation.

1. **DECIDED: keep barred. Force-push counts as delete** (design 13): kept barred in `terms.mjs` and `buildDenyRules`. Prefix rules cannot catch `+refspec` or `:branch` pushes, nor `git push origin main --force` (flag after the remote), so the Safety Net hook is the real second layer; T21 M2b tests that on a throwaway remote.
2. **DECIDED: keep barred. `git rm` of a tracked file inside a spec'd change**: Phase 1 lists it as barred (the prototype did), so a refactor that deletes a file goes yellow. Revisit only if tracked-file deletion in a commit should be allowed.
3. **DECIDED: keep. Fable requires Opus** (`fableElevation` rejected unless `opusEscalation`): Claude's call to keep the ladder coherent; design 5 only says Fable follows three failed Opus reviews.
4. **DECIDED: keep. Reviews per push capped at 3** in the validator (Matt approved up to 3).
5. **DECIDED: keep `assembleDebug`. Debug vs release APK** is "the expected APK": recipe uses `assembleDebug` (what Matt installs on the S25 per memory); `verifyAetherSigning` makes both need the signing keys.
6. **DECIDED: keep, recipe stays unrun until the throwaway-repo test. The recipe for `npm run dist -- -c.directories.output=…`** has not been run; first real use is the throwaway-repo test with Matt present (design 11).
7. **DECIDED: Phase 2 uses `acceptEdits` scoped to the worktree, and push stays the broad `Bash(git push:*)`, with the exact-form `run` rules and Safety Net behind it. Phase 1 still does not choose the permission mode in code; this is the Phase 2 direction, not built here. Allowlist and permission mode** (Matt's call 2026-11-04: build a minimal `buildAllowRules` now). Phase 1 prints it in the approve summary and stores it in the approval record, but does not choose the permission mode and does not derive Edit/Write/test rules for `work`/`plan` items. The broad push allow leans on the deny list and Safety Net for force variants, and it also permits pushes to master that skip merge-gate: the exact-form `run` rules stop `HEAD:master` and `HEAD:main` as typed, no prefix rule stops every spelling: T21 M2b tries them. How a headless run treats the list is UNVERIFIED until T21 M2/M5.
8. **DECIDED: keep. First-ever night with no last-approved terms runs nothing.** An unfinished pre-flight on a machine that has never approved a night resolves to `none` (`no last-approved terms`) rather than running on the defaults. `confirm` says so (item 9) instead of printing an allowlist.
9. **DECIDED: `confirm` prints the unfinished-night allowlist (plan changed: T16 `unfinishedSelection`, T17 `confirm`). An unfinished night's allowlist is computed, not approved.** For `kind: unfinished`, `resolveNightPlan` returns `allowRules` computed from the last-approved standing terms and the confirmed items, so Matt never sees it as one list at approve time. After items are confirmed, `confirm` now prints that list, labelled as what an unfinished night would run on, from the same single computation (`unfinishedSelection`, which `resolveNightPlan` also calls); with no last-approved terms it prints that no unfinished allowlist exists yet (item 8).
10. **DECIDED: add-item deferred. No `add-item` verb in Phase 1** (design 6: "anything Matt names at bedtime"; review 2 must-fix 9). Deferred, not built: a typed item is agent-relayed free text entering the grant path, it needs its own source kind, id and tests, and Matt can already put the line under `## Next steps` in the project's handoff and re-run `compile`. Revisit if it is wanted anyway (about 25 lines plus 3 tests in T14).
11. **DECIDED: no `resolve` verb; edit the source, then `compile` before `confirm`. Answered questions are not resolved in state** (design 7 step 3; Codex review of PR #171). Clarifying questions are a conversation, not a state change: Phase 1 has no `resolve` verb, so `confirm` refuses every non-`ready` item. An answered question runs tonight only if Matt edits the source line into a decided statement (which changes its id) and the agent re-runs `compile` BEFORE any `confirm`, because `compile` replaces the draft and drops confirmations. The skill says so (T19 and its template test). The review asked for either a human-gated resolution operation or this explicit source-update and recompile flow; this plan builds the flow, because a `resolve` verb adds a TTY verb, a `resolved` flag that must survive or expire across recompiles, and a route into the grant path whose only evidence is a chat answer. The alternative, not built: `resolve <id>` (TTY, clarifiable reasons only, never `question:spec-not-approved` or `question:plan-not-found`).
12. **DECIDED: keep. An unfinished night ignores a tightening `terms set` made after the last approval.** It runs on the STORED standing terms (design 7: the last-approved terms), so setting `push: false` tomorrow does not apply to an unfinished night until Matt approves again. Option, not built: per key, the most restrictive of the stored and live value (`push`, `opusEscalation`, `fableElevation` AND; `merge` off beats gated; the smaller review count), at the cost of the live file narrowing a night Matt approved.
13. **DECIDED: keep, builds only; revisit before Phase 2. Feasibility (design 7 step 4) covers build items only.** D4 recipes probe APK and EXE items. `work` and `plan` items are re-checked for plan and spec approval but not for tools, accounts, paths or permissions. Add more probes if Phase 2 needs them.

## Risks recorded

- Until Matt installs the `protect` rules (T21 M2), an interactive agent could write `~/.aether-os/afk/` directly; the TTY gate protects only the verbs. The record hash and pointer catch accidental or partial edits (`resolveNightPlan` returns `none`), not a writer who rewrites `approved.json` and the pointer with valid hashes; only the `protect` rule stops that. A hand-edited draft can mark items confirmed that Matt did not (unfinished path only); the re-check and the confirmed-only rule bound the damage, nothing proves who wrote it.
- The `/afk-preflight` auto-trigger is model-judged. It is not the rules-first detector with a tense guard (Phase 4).
- The compiler's stale-handoff problem (D3) and the classifier's heuristics produce false `question`/`barred`, never silent `ready` for a marked item; a false `ready` is caught only by Matt's confirmation.
- Scripts tests run under two vitest configs; a test that needs a root-only dependency would pass in one and fail in the other.
- A crash between the record write and the pointer write makes the night resolve to `none` (`pointer-missing`) until `approve` is run again (it always rewrites both, and verifies what it wrote); if that happens while Matt is asleep, nothing runs. This is the fail-closed choice.
- The single approved slot: approving a second night replaces the first even if the first's window is still current (the summary says so). `approve` also refuses the whole approval when one confirmed item fails its re-check; Matt re-runs `compile` and `confirm`. The re-check covers plan, spec and feasibility as they are now; a handoff edited after `compile` (an item removed or done) is not seen.
- The deny rules are all `Bash(...)`; whether they cover the PowerShell tool is unverified until T21 M2, and "delete barred" and "force-push barred" rest on it. The `run` group is never installed globally; Phase 2 passes it per run.
- `buildAllowRules` is data. Whether a headless run denies an unlisted call, honours the flag names, lets deny beat the global allow list, and matches compound commands is unverified until T21 M2/M5; Phase 2 must not rely on it before then.
- Time and run-once: `resolveNightPlan` is a pure read with no started-state. Phase 2 resolves ONCE at window start and persists the result; the run-once key is `targetWindowStartMs` (Phase 2 marks that window started; `nightId` is an audit label only); the 12h grace (`isNightCurrent`) means "may still start", not "may keep running" (design 8 has no total-night cap). Between the end of the window and the grace end a re-resolve returns the same plan again, and after the grace it returns `none`; neither says a run is in progress or done. For an unfinished night `nightId` is the draft label and every `compile` mints a new one for the same window, which is why it cannot be the key (Phase 2 owns the started-state; not built here).
- Bare word matches: `detectArtifact` turns "fix the installer bug" into a build item, which adds `Bash(npm run dist:*)` to the allowlist; the allowlist is not project-scoped (aether-os and TokenMonitor both use `npm run dist`); and the barred classifier is a denylist (T7): it still misses `uninstall`, leetspeak, homoglyphs outside its short fold table and exotic hyphens. Matt's `confirm` and the printed allowlist are the catch.
