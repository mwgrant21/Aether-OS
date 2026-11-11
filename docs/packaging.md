# Packaging (Windows)

`npm run dist` produces `release/Aether OS Setup <version>.exe` -- a per-user NSIS
installer that puts Aether OS in the Start menu and on the desktop, so the app no
longer has to be started with `npm run electron:dev`.

This is a **local convenience, not distribution.** The build is unsigned, there is
no publisher identity, no update feed, and no release channel. Fleet-view and
multi-machine distribution remain out of scope (see `CLAUDE.md`).

## Commands

| Command | What it does |
|---|---|
| `npm run dist` | `electron-vite build`, then `electron-builder --win` -> `release/Aether OS Setup <ver>.exe` |
| `npm run dist:dir` | Same, but stops at `release/win-unpacked/`, then grants that directory the AppContainer ACE (see #3). No installer, no NSIS step -- the fast way to smoke-test a packaging change |
| `npm run icon` | Regenerates `build/icon.png` + `build/icon.ico` from `scripts/make-icon.ps1`. Only needed when the mark changes; the outputs are committed |

Config lives in `electron-builder.yml`; the NSIS install hook is `build/installer.nsh`.

## The six things packaging has to get right

Each of these is a real failure this repo either already hit or would hit. None
of them are guessable from a default electron-builder config.

### 1. `scripts/` must live outside the asar

`electron/main.ts` writes `node "<path>/aether-statusline.mjs"` into
`~/.claude/settings.json`. Claude Code -- a **separate process with no asar
support** -- then spawns it. A path inside `resources/app.asar` reads fine from
Electron and is invisible to everything else, so the statusline would silently
never run.

Fix: `extraResources` copies `scripts/*.mjs` to `resources/scripts/`, and
`main.ts` resolves `process.resourcesPath` when `app.isPackaged`. In dev there is
no asar and `app.getAppPath()` is the project root, where `scripts/` already sits.

The skill template rides along: `extraResources` also copies
`skills/afk-preflight/SKILL.md` to `resources/skills/afk-preflight/`, so
`afk install-skill` is meant to work from an installed build (UNVERIFIED until
T21 M3, which runs the packaged build; AFK Phase 1; `scripts/afk/*.mjs` is copied
to `resources/scripts/afk/`).

### 2. `node-pty` must be unpacked, but must NOT be rebuilt

node-pty 1.1.0 is an **N-API** (`node-addon-api`) addon shipping prebuilds for
`win32-x64`. N-API is ABI-stable across both Node and Electron versions, so the
binary already in `node_modules` runs under Electron 43 unchanged -- there is no
`electron-rebuild` tax here. `npmRebuild: false` keeps electron-builder from
invoking node-gyp against a working prebuild.

It still cannot live inside the archive: `windowsPtyAgent.js` loads `conpty.dll`
by filesystem path and forks `conpty_console_list_agent` as a child process, and
Windows cannot map a DLL out of an asar. Hence
`asarUnpack: '**/node_modules/node-pty/**'`.

### 3. The install directory needs the AppContainer ACE

Electron's GPU and renderer children run in a Windows AppContainer sandbox, and
an AppContainer token can only map DLLs from a directory granting read+execute to
ALL APPLICATION PACKAGES (`S-1-15-2-1`). A per-user install into
`%LOCALAPPDATA%\Programs` inherits no such ACE, so without it the sandboxed
children die on first launch (`exit_code=-1073741515`, "GPU process isn't
usable. Goodbye.").

`build/installer.nsh` runs `icacls` on `$INSTDIR` during install. This is the
packaged-install counterpart to `scripts/grant-appcontainer-acl.js`, which does
the same to `node_modules/electron/dist` for `npm run electron:dev`. Chrome ships
the same ACE on its own install directory, for the same reason.

**`--dir` builds need it too, and skip NSIS to get it.** `npm run dist:dir` never
runs `customInstall`, so on any machine where the checkout does not already
inherit the ACE, the `release/win-unpacked` build this file advertises as the
fast smoke-test path dies exactly the same way. `dist:dir` therefore chains
`node scripts/grant-appcontainer-acl.js release/win-unpacked`. Given an explicit
target directory that script fails loudly rather than skipping -- a build that
cannot be launched must not be handed back as a successful one.

If the app ever opens blank or exits immediately after an install, run:

```
icacls "%LOCALAPPDATA%\Programs\aether-os" /grant *S-1-15-2-1:(OI)(CI)(RX) /T /C
```

### 4. Size: ~300 MB of it is the Codex CLI

`electron/crossEngine/acpProcess.ts` resolves and spawns
`@agentclientprotocol/codex-acp`, whose `@openai/codex-win32-x64` dependency
vendors `codex.exe` (~298 MB) and `codex-code-mode-host.exe` (~57 MB). That is
most of the 739 MB unpacked / ~187 MB installer.

electron-builder always bundles production `dependencies`, regardless of the
`files` list, so this cannot be trimmed by config alone. Dropping it would mean
making the cross-engine Codex verifier depend on a separately-installed `codex`
on PATH -- a real feature change, not a packaging tweak. Not done.

Those bytes do have to sit outside the archive, though -- see 6 below. That
moves them beside `app.asar` rather than inside it; it does not add weight.

### 5. Uninstalling has to undo what the app wrote outside `$INSTDIR`

Enabling the statusline writes `node "$INSTDIR\resources\scripts\aether-statusline.mjs"`
into `~/.claude/settings.json` -- a file NSIS neither owns nor tracks. Deleting
the install directory without touching it leaves every subsequent Claude Code
session invoking a script that is gone, and never restores whatever statusline
tool Aether was chained through.

`build/installer.nsh`'s `customUnInstall` runs the app once with
`--uninstall-statusline` before `RMDir /r $INSTDIR`, which is the last moment the
executable still exists. `electron/statuslineUninstallCli.ts` handles that flag:
it opens no window, reuses the same `uninstallStatusline` path the in-app toggle
uses -- so the backup and atomic-replace rules in `electron/atomicWrite.ts` are
not reimplemented in NSIS script -- and refuses to touch a `statusLine` that
belongs to some other tool. A watchdog bounds the run so a wedged filesystem can
never leave the uninstaller blocked.

The hook is guarded on `${isUpdated}`, because electron-builder runs the same
uninstall section when a newer installer replaces an existing install. Turning
the user's statusline off on every upgrade would not be an uninstall.

A second path exists that the uninstall hook cannot cover. Because
`allowToChangeInstallationDirectory` is enabled, an update may land in a new
directory; the old tree is then deleted while `settings.json` still names the old
script. The `${isUpdated}` guard skips cleanup for exactly that run, and the
uninstaller could not fix it anyway -- app-builder-lib invokes it as
`_?=<OLD dir>` and never passes the new path, so there is nothing to migrate to.

The app repairs it on next start: `migrateStatuslineScriptPath()` re-points a
command it can prove it wrote, naming a script that no longer exists, at its own
current path, carrying any chained third-party tool across. It refuses if the
existing command is foreign, if the old script still resolves (a live second
install), if the file cannot be parsed, or if this install's own script is
missing -- that last one mirroring the `statusline:install` guard, since swapping
one dead path for another is not a repair.

#### A lone leftover helper under `$INSTDIR`

The template's app-running check ends in `(Get-CimInstance ...).Count -gt 0`.
Under Windows PowerShell 5.1 a single CimInstance has no `.Count`, so when
EXACTLY ONE process lives under `$INSTDIR` the check says "not running" (two or
more work). A lone detached helper would then keep node-pty and exe files open
through an update or uninstall. `build/installer.nsh` defines
`customCheckAppRunning`: it runs the template's default check first (so the
"close Aether?" prompt is unchanged), then sweeps every process whose image is
under `$INSTDIR\` with `Stop-Process -Id -Force`, no `.Count`. Guards: PowerShell
path only, the app exe must exist in `$INSTDIR`, a trailing-backslash match
(so a sibling `Aether OS Dev` is safe), the installer's own PID is skipped, and
paths travel in environment variables so a quote in the path is harmless. It is
best effort: a failure prints a warning and the install continues. It fires on
install, update and uninstall. Covered by `electron/installerLoneHelper.test.ts`
(drives real PowerShell 5.1). Caveat: the first update that carries this fix
still runs the OLD installed uninstaller with its old check, and a plain
uninstall of a pre-fix build has the old behaviour until a fixed build is
installed.

### 6. The Codex entry points must be unpacked AND their resolved paths rewritten

Two separate halves, and either one alone still fails to spawn.

`spawnAcpProcess()` and `codexAppServer.ts`'s `defaultSpawn()` both launch a
SEPARATE process -- `spawn(process.execPath, [script])`. A child process has no
asar support: to anything outside the Electron process, `app.asar` is a single
file, not a directory. And `@openai/codex`'s `bin/codex.js` goes on to spawn the
vendored `codex.exe`, which Windows cannot execute from inside an archive at
all. So `asarUnpack` has to cover `@openai/**` and
`@agentclientprotocol/codex-acp/**` alongside `node-pty`.

That alone is not enough. `require.resolve()` still reports the *in-archive*
path for a file electron-builder has unpacked, so the resolved path has to be
rewritten to `app.asar.unpacked` before it is handed to the child.
`toUnpackedPath()` in `electron/crossEngine/acpProcess.ts` does that, and both
resolvers run their result through it.

The failure this prevents is invisible in development: nothing resolves through
an `.asar` path under `npm run electron:dev`, so Connect Codex and Verify
Dispatch work there and break in every packaged build -- installed and
`win-unpacked` alike. Found by review on PR #75, not by testing.

## The PTY owner helper (optional, off by default)

With `AETHER_PTY_OWNER=1` on Windows, main launches a detached helper: the installed `Aether OS.exe` with `ELECTRON_RUN_AS_NODE=1`, running `out/main/pty-owner.js`. It is a second entry in `electron.vite.config.ts` (`'pty-owner'` -> `electron/ptyOwner/ownerEntry.ts`); `electron/asarUnpackClosure.test.ts` pins that entry. There is no `asarUnpack` change: `**/node_modules/**` is already unpacked (#2), which is where the helper's `node-pty` must resolve from.

Update and uninstall: the helper is an `Aether OS.exe` process under `$INSTDIR`, so the install-directory kill/sweep in `build/installer.nsh` (`customCheckAppRunning`, the lone-helper sweep) is the mechanism meant to stop it before files are replaced. That it actually does so on a real update or uninstall is UNVERIFIED: no spike result covers the installer, and the live T8 report (item 4) does not exist yet. If it does not, the installer will report the app as running or a file as in use.

UNVERIFIED / UNEXERCISED until the live T8 report: that a packaged `Aether OS.exe` with `ELECTRON_RUN_AS_NODE=1` loads the built ESM `app.asar/out/main/pty-owner.js` and resolves `node-pty` from the unpacked tree; that the helper survives a Quit-less main death when started from the packaged app (job breakaway, both the Start-menu and post-install launch routes); helper cold-start latency. See `docs/privacy-and-data.md` section 21.

## Redeploying the collector (Windows)

`scripts/redeploy-collector.ps1` replaces the by-hand redeploy: from a clean checkout it runs `npm ci` and `npm run build` in `collector/`, stages the full `dist` tree (minus `*.test.js`) plus `package.json` at `D:\AetherBuilds\<version>\collector`, checks free disk space, stops the old collector (only `node.exe` and `conhost.exe` processes whose command line matches the staged `index.js` or the `index.js` in the old Run value, node first, then it fails if any collector `node.exe` survives), backs up `~/.aether-os/collector.db` and its `-wal`, reads the `usage_events` baseline, repoints the HKCU Run key `AetherCollector`, starts the collector headless via `conhost.exe`, and checks that the new collector is alive and `usage_events` grows (alive with no new rows in the window is a success, a dead collector is a failure). Before changing anything it refuses (exit 2, `-DryRun` included) when: the stage dir is non-empty or is the one the current Run value uses; `-DbPath` is not `~\.aether-os\collector.db`; the Run command would exceed 260 characters; an unfinished journal exists; the current Run value is not REG_SZ; or `-VerifySeconds` is outside 1..60. `-DryRun` (alias `-WhatIf`) prints every step and changes nothing; `-Version` defaults to `package.json`. Tests: `Invoke-Pester scripts\redeploy-collector.Tests.ps1`.
**Rollback.** From the stop onward the script writes `~\.aether-os\redeploy-journal.json` (the phase before each irreversible step, the old and new Run values, the db backup path, whether the old collector was running). A verified deploy deletes it. If the deploy fails once the journal is open, the same rollback as `-Rollback` runs automatically: it stops the new collector (exact `index.js` match), restores the old Run value only if the key still holds the value the script wrote (otherwise it prints both values and leaves it to you), relaunches the old collector once (never a second copy, and not when the old Run value was empty or the collector was not running before), renames the stage dir to `collector.failed-<timestamp>`, then deletes the journal and prints `ROLLBACK COMPLETE`. A failure before the journal opens only renames the stage dir aside. `scripts\redeploy-collector.ps1 -Rollback` runs the same undo by hand against a leftover journal (after Ctrl+C, a logoff or a crash); it is idempotent, needs no running collector, and on a journal whose phase is `verified` it just removes the file. While a journal is open the next deploy is refused. Exit codes: 0 success (or a dry run, or a rollback that finished), 1 the deploy failed and was fully rolled back (or failed before anything but the stage dir changed), 2 bad input or a preflight refusal (`-Rollback` with no readable journal also exits 2), 3 rollback incomplete (exit 3 prints `ROLLBACK INCOMPLETE` and `RECOVERY:` lines with the manual steps and leaves the journal open; re-run `-Rollback` after fixing).

**`-VerifySeconds`** is the length of the verify window (default 30, allowed 1..60). Everything after the build is budgeted at 120 s; that figure is documentary, nothing enforces it, and a slow row-count sample can overrun the window because `Get-RowCount` has no timeout. A sample that throws counts as no sample; only a dead collector fails the verify. The script is manual and interactive only: run it from a plain PowerShell window, not an Aether terminal, because it stops `node.exe` and `conhost.exe` and would kill the terminal running it.

**Rollback does NOT cover:** the database. It never restores `collector.db`; the backup (`.bak` plus `-wal`) path is recorded and printed. The new collector may have migrated the db in place, and whether the old collector tolerates that is UNVERIFIED, so if the old collector exits right after relaunch, restore the backup by hand (with both collectors stopped). `memory.db` is neither backed up nor restored. A Run value changed by someone else after the script wrote it is left alone (exit 3). A collector instance whose path is spelled differently (8.3, forward slashes, relative) is only caught by the broad survivor check, which fails the rollback with exit 3. The "was the old collector running" flag uses the same StageRoot-wide matcher as the stop, so it may describe a different version than the one the old Run value names (a 0.7.4 left running while the Run value names 0.7.5); rollback relaunches only what the old Run value names. Ctrl+C in PowerShell 5.1 is not handled in-process: treat it as a hard stop and run `-Rollback`.

**Known gap:** the stage-in-use guard compares paths literally, so 8.3 short names and junction aliases of the stage dir are not compared (only a reparse-point stage dir is detected, and then it is not renamed aside). **Two writers:** never leave two collectors running against one db; the rollback and its RECOVERY text stop the new collector before starting the old one for that reason.

## Versioning

The version lives in one place, `package.json`, and everything else derives from
it: the installer name (`Aether OS Setup <version>.exe`), `latest.yml`, the
lockfile's two root `version` fields, and the `clientInfo` the Codex app-server
client sends (#79). It only moves when someone moves it -- nothing in the merge
flow asks for a bump -- so it once sat at 0.3.0 for 77 commits and at 0.4.0 for
another 44. The ritual, when a batch of PRs is worth a number:

```
npm version 0.5.0 --no-git-tag-version   # bumps package.json + package-lock.json together
# in the same commit: update CHANGELOG.md (move the Unreleased entries under a new
# `## [0.5.0] - YYYY-MM-DD` heading, add its compare link at the bottom), before tagging
# commit on a branch and open a PR: master requires CI, and admins are included
# after the squash merge, tag the SQUASH commit on master, not the PR branch's commit:
git fetch origin && git tag -a v0.5.0 -m "v0.5.0: <one line of what changed>" origin/master
git push origin v0.5.0
```

Pre-1.0 semver as practised here: a minor bump (0.4 -> 0.5) for a batch that adds
capability, a patch bump for fixes only. `git describe --tags` then answers
"which build is this and how far past the last version is it" from any clone
(`v0.4.0-44-g6b925c4` means 44 commits past v0.4.0). Tags v0.2.0, v0.2.1, v0.3.0
and v0.4.0 (at #79, c313c12) were placed retroactively at their bump commits and
first pushed on 2026-09-29.

To tell whether an installed build is current, do not trust the version string:
compare `resources\app.asar`'s timestamp under `%LOCALAPPDATA%\Programs\Aether OS`
against the build, or search it for a string that only the newest PR added.

## Known limitations

- **Unsigned.** SmartScreen warns on first run of a freshly built installer
  ("More info" -> "Run anyway"). Signing needs a code-signing certificate.
- **No auto-update.** `latest.yml` and `.blockmap` are produced as a side effect
  of the NSIS target; nothing consumes them. A new version means running the new
  installer over the old one.
- **x64 only.** Add `arch: [x64, arm64]` in `electron-builder.yml` if that ever
  matters; node-pty ships an arm64 prebuild already.
- **The packaged app and `npm run electron:dev` share state** -- both read and
  write `~/.aether-os` and `~/.claude`. Running both at once is not something
  the single-instance lock prevents, since they are different executables.
