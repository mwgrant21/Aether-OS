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
| `npm run dist:dir` | Same, but stops at `release/win-unpacked/`. No installer, no NSIS step -- the fast way to smoke-test a packaging change |
| `npm run icon` | Regenerates `build/icon.png` + `build/icon.ico` from `scripts/make-icon.ps1`. Only needed when the mark changes; the outputs are committed |

Config lives in `electron-builder.yml`; the NSIS install hook is `build/installer.nsh`.

## The four things packaging has to get right

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
