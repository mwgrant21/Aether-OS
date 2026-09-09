; build/installer.nsh -- NSIS hooks for the Aether OS installer.
;
; Electron's GPU and renderer children run inside a Windows AppContainer
; sandbox. An AppContainer token can only map DLLs from a directory that grants
; read+execute to ALL APPLICATION PACKAGES (S-1-15-2-1). A per-user install into
; %LOCALAPPDATA%\Programs inherits no such ACE, so without this the sandboxed
; children fail to load their DLLs and the GPU process dies on first launch
; (exit_code=-1073741515 / "GPU process isn't usable. Goodbye.").
;
; This is the packaged-install counterpart to scripts/grant-appcontainer-acl.js,
; which does the same thing to node_modules/electron/dist for `npm run
; electron:dev`. Chrome ships the same ACE on its own install directory.

!macro customInstall
  DetailPrint "Granting ALL APPLICATION PACKAGES read+execute on $INSTDIR"
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR" /grant *S-1-15-2-1:(OI)(CI)(RX) /T /C /Q'
  Pop $0
  StrCmp $0 "0" acl_ok 0
    DetailPrint "WARNING: icacls exited $0. If the window opens blank or the app"
    DetailPrint "exits immediately, run this in a terminal and reinstall:"
    DetailPrint '  icacls "$INSTDIR" /grant *S-1-15-2-1:(OI)(CI)(RX) /T /C'
  acl_ok:
!macroend

; Uninstall counterpart. electron-builder inserts customUnInstall at the TOP of
; the uninstall section -- before `RMDir /r $INSTDIR` -- so the app is still on
; disk here and can undo its own footprint outside the install tree.
;
; What it undoes: enabling the statusline writes
; `node "$INSTDIR\resources\scripts\aether-statusline.mjs"` into
; ~/.claude/settings.json, and that file is NOT ours to leave behind. Without
; this hook, uninstalling leaves every subsequent Claude Code session invoking a
; script this uninstaller just deleted, and any statusline tool Aether was
; chained through (base64 --chain) is never restored.
;
; Delegating to the app rather than editing settings.json from NSIS is
; deliberate: the backup and atomic-replace rules for that file live in
; electron/atomicWrite.ts and already have three implementations kept in step by
; test (#59, #60, #63). A fourth written in NSIS script -- exercised only during
; an uninstall, where nobody would see it drift -- is not a trade worth making.
; The app's own guard means a foreign statusLine command is left alone.
;
; Guarded on ${isUpdated} because electron-builder runs this SAME uninstall
; section when a newer installer replaces an existing install. Silently turning
; the user's statusline off on every upgrade is not an uninstall.
;
; That guard deliberately leaves ONE case to the app. An update installed into a
; DIFFERENT directory (allowToChangeInstallationDirectory is enabled) deletes the
; old tree while settings.json still names the old script. This hook cannot
; repair that: app-builder-lib runs the old uninstaller as `_?=<OLD dir>` and
; never tells it the new path, so there is nothing here to migrate TO. The app
; fixes it on next start instead -- migrateStatuslineScriptPath() in
; electron/statuslineInstaller.ts -- which is also where the backup and
; atomic-replace rules for settings.json already live.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DetailPrint "Removing the Aether OS statusline from settings.json"
    ; /TIMEOUT is the outer bound on an uninstall that must always finish. The app
    ; has its own watchdog (STATUSLINE_UNINSTALL_TIMEOUT_MS), but that only helps
    ; once its JavaScript is running: an Electron binary that wedges before main.js
    ; loads -- a broken GPU driver, a half-deleted install -- would otherwise leave
    ; nsExec waiting on it forever and the uninstaller frozen with it. On timeout
    ; nsExec pushes "timeout", which is not "0", so the manual-fix note below prints.
    nsExec::ExecToLog /TIMEOUT=30000 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-statusline'
    Pop $0
    StrCmp $0 "0" statusline_ok 0
      DetailPrint "WARNING: statusline cleanup exited $0. If Claude Code reports a"
      DetailPrint "missing statusline command, delete the statusLine key from:"
      DetailPrint "  $PROFILE\.claude\settings.json"
    statusline_ok:
  ${endIf}
!macroend
