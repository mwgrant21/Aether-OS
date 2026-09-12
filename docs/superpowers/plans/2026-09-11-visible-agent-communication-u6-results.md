# U6 results

The four implementation checkpoints are committed locally on feat/visible-communication-u1. No push, merge, live Claude model probe, or real Codex consultation occurred.

## Checkpoints

1. **37b91bd — preference/bootstrap and shutdown correction.** Default-off boolean preference is persisted; runtime state is excluded. App-wide synchronization works without visiting Settings and makes no launch or consultation. Rejected enable rolls the checkbox back. SHUTTING_DOWN, DISPOSED and CLEANUP_FAILED are distinct. Timeout keeps ownership of the same cleanup operation; late completion is observed, and later bounded waits do not duplicate disposal.
2. **31a22c4 — restricted launch configuration.** Windows launch files receive a current-user-only ACL before credentials are written. The launch uses a quoted script path, exact three MCP approvals, alwaysLoad and a 90-second server timeout, without strict MCP configuration. Native Claude 2.1.269 is checked without a model call. Profiles run normally; billing variables are removed afterward and the client-wide 120000 ms threshold is pinned and later restored. True native-child completion is observed independently of the shell. Stale cleanup preserves live or unknown owners.
3. **f540485 — explicit fresh session and lifecycle.** Main confirms replacement, prepares before replacing the terminal, revokes scoped authority, and owns late-created launch files during disable. Terminal attachment is idempotent. Settings prepares the existing xterm subscription before launch so startup output survives until Terminal is opened. Successful launch never fabricates authenticated readiness.
4. **97c5520 — operator grants.** Grant 3 more requires native confirmation bound to the current launch. Repeated confirmation IDs, concurrent submissions, cancellation and stale launch confirmations cannot grant twice. Credits come from main snapshots; grants do not start work, restart Claude, clear cooldown or erase request history.

## U5 review requirements

All three have implementations and regression coverage. A timeout no longer permanently latches failure. Actual cleanup rejection remains a failure. Held quit displays an explanation and offers another wait, keeping the app open, or a separately confirmed quit without cleanup proof. The force-quit warning accurately says provider processes **may** remain running. Forced exit is never relabelled confirmed cleanup.

Final review also fixed failed rollback of partially prepared launch files: LAUNCH_CONFIG_CLEANUP_FAILED remains owned by the service and blocks re-enabling rather than silently reporting confirmed cleanup. The adjacent Cost Guard wording now distinguishes direct Anthropic calls from subscription consultations.

## Verification

| Check | Verdict | Evidence |
| --- | --- | --- |
| Full suite | Passed | 1,691 tests passed, 7 skipped; 157 files passed, 1 skipped |
| Electron TypeScript | Passed | npm run typecheck:electron |
| Renderer and Electron builds | Passed | npm run build and npm run electron:build |
| Independent checkpoint reviews | Passed | Lifecycle, preference, launch configuration, session coordination and grants reviewed separately from their implementation |
| Real Windows launch checks | Passed | Native PowerShell ACL, quoting, absent/failed/profile overrides, billing strip, threshold restoration, output/history sentinels; ConPTY input reached fake native CLI with isTTY true; ordinary exit and Ctrl+C observed with reusable shell and restored threshold; partial-file rollback failure retained |
| Installed-client preflight | Passed | Native Claude 2.1.269 and local configuration/policy preflight; no model call. Opt-in test is skipped in the default full suite but was run separately |
| Sandboxed Electron lifecycle | Passed | Actual built renderer/preload with production service/IPC/quit gate in an isolated main harness; enable caused zero provider calls; one fake consultation, one disposal, visible held window, late completion, successful retry and process exit |
| Native held-quit dialog interaction | Incomplete | Dialog was listed, but computer-use targeting failed in two attempts. No UI input was sent; controlled callback verification is not native button verification. Owned test processes were stopped after fake cleanup |
| Entire production main startup | Incomplete | Runtime verification uses an isolated main harness, not an unrestricted launch of the production main process |
| Live model communication | Incomplete | Intentionally not activated. Prior U0 client evidence remains separate; later live smoke requires its own allowance |

The Electron runtime initially failed with a GPU-process STATUS_BREAKPOINT. The repository's prescribed AppContainer RX repair was applied only to this worktree's dependency runtime. The successful runtime used normal sandbox settings. A diagnostic no-sandbox attempt is not counted as verification. Build warnings remain for optimizeRules node:path browser externalization and renderer chunk size.

Evidence is copied to the chat outputs: u6-runtime-evidence.json, u6-runtime-exit.txt, u6-settings.png and u6-held-quit.png. Screenshots show the isolated final-controls renderer; the subsequent Cost Guard wording correction is source-tested, not recaptured. Native modal imagery is not claimed.

## Limits and next step

Connected launch currently supports Windows and the verified native client in inherited PATH. A CLI available only through profile PATH setup, a custom CLAUDE_CONFIG_DIR, or managed policy requiring review fails closed. Local policy checks do not claim authority over remote policy; Claude still enforces effective managed denies. There is no wildcard approval or permission-policy bypass.

Empty cwd does not confine reads. Claude transcripts/tool output and Codex-managed history may retain content after Aether clears its memory; this is disclosed in Settings and must survive into U7 copy.

Next is U7: global metadata/activity presentation. U6 does not implement the full exchange display or claim live end-to-end delivery.
