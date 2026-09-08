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
