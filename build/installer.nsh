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

; Lone-helper sweep. The template's default app-running check (FIND_PROCESS in
; allowOnlyOneInstallerInstance.nsh) tests
; `(Get-CimInstance ... | ? {...}).Count -gt 0` under Windows PowerShell 5.1.
; A single CimInstance has no .Count there, so FIND reports "not running" when
; EXACTLY ONE process lives under $INSTDIR (with two or more it works). A lone
; detached helper (the app's own exe run as node) then keeps node-pty and exe
; files open through an update or uninstall.
;
; customCheckAppRunning replaces the template check wholesale, so it must run
; the default check itself (prompt + kill + retry) and then sweep. The sweep
; goes AFTER so a running app still gets the "close it?" prompt first; what is
; left under $INSTDIR at that point is the lone-helper case or nothing. This
; hook fires on install, update and uninstall (un.checkAppRunning).
;
; Defining the macro makes the template skip its own getProcessInfo include and
; `Var pid`, which _CHECK_APP_RUNNING needs, so they are supplied here.
;
; Guards: only on the PowerShell path (the fallback already kills by image
; name); only if the app exe exists in $INSTDIR (a user-picked dir such as a
; profile root must not be swept); match on $INSTDIR plus a trailing backslash
; (a bare prefix also matches a sibling "Aether OS Dev"); skip our own PID (an
; uninstaller runs from inside $INSTDIR); pass the paths as environment
; variables, not command-line text (a quote in the path breaks a literal).
; Best effort: a failure only DetailPrints a warning. Every PowerShell `$` is
; doubled because NSIS expands `$$` and makensis runs with -WX.
!include "getProcessInfo.nsh"
Var pid

!define AETHER_SWEEP_PS "$$d = $$env:AETHER_INSTDIR.TrimEnd('\') + '\'; $$me = [int]$$env:AETHER_SELF_PID; $$bad = 0; foreach ($$p in @(Get-CimInstance -ClassName Win32_Process)) { if ($$p.Path -and $$p.ProcessId -ne $$me -and $$p.Path.StartsWith($$d, [StringComparison]::OrdinalIgnoreCase)) { try { Stop-Process -Id $$p.ProcessId -Force -ErrorAction Stop; Write-Output ('stopped ' + $$p.ProcessId + ' ' + $$p.Name) } catch { Write-Output ('could not stop ' + $$p.ProcessId + ': ' + $$_.Exception.Message); $$bad = 1 } } }; exit $$bad"

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  ${if} $IsPowerShellAvailable == 0
  ${andIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    Push $0
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    System::Call 'kernel32::SetEnvironmentVariable(t "AETHER_SELF_PID", t "$0")'
    System::Call 'kernel32::SetEnvironmentVariable(t "AETHER_INSTDIR", t "$INSTDIR")'
    DetailPrint "Stopping any helper process left running from $INSTDIR"
    nsExec::ExecToLog /TIMEOUT=60000 `"$PowerShellPath" -NoProfile -NonInteractive -C "${AETHER_SWEEP_PS}"`
    Pop $0
    ${if} $0 != 0
      DetailPrint "WARNING: could not stop every process under $INSTDIR (exit $0); continuing."
    ${endIf}
    Sleep 500  ; let handles release before files are touched
    Pop $0
  ${endIf}
!macroend
