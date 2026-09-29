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

## Versioning

The version lives in one place, `package.json`, and everything else derives from
it: the installer name (`Aether OS Setup <version>.exe`), `latest.yml`, the
lockfile's two root `version` fields, and the `clientInfo` the Codex app-server
client sends (#79). It only moves when someone moves it -- nothing in the merge
flow asks for a bump -- so it once sat at 0.3.0 for 77 commits and at 0.4.0 for
another 44. The ritual, when a batch of PRs is worth a number:

```
npm version 0.5.0 --no-git-tag-version   # bumps package.json + package-lock.json together
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
