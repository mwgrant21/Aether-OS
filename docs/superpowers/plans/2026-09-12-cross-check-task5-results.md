# Cross-check Task 5: client status and terminal focus

**Passed.** Implementation, independent code review, and verification completed against base `73a6389`. No model calls, push, or merge.

## Behavior

Settings and Terminal now show the same derived client status:

- **Action required: folder trust** only with current positive prompt evidence, followed by “Review the folder-trust prompt in the terminal to continue.” No selected option, default choice, or keystroke advice is inferred.
- **Client not ready — check terminal** when client input readiness is unresolved, including when bridge discovery has succeeded. Bridge status remains a separate field.
- **Client exited** only with positive client-exit evidence. Launch failures get separate failure copy; `REVOKED` retains its existing specific launch-error explanation.
- **Focus connected terminal** refreshes the displayed instance/session identity, navigates within the current Aether window, and focuses the terminal without starting a session or submitting user input. Focus-only mounting also survives React StrictMode effect replay. The terminal status panel has a fixed height to avoid resizing the terminal whenever status text changes.

## Evidence and ownership

The snapshot adds allowlisted client lifecycle and a current-launch-authority boolean. Display evidence survives helper loss independently of revoked authority. Replacement and disable discard it; delayed old observations cannot update a successor. No raw terminal text, PID, path, or credential is added to renderer status or persisted state.

The launch receipt, or disappearance of a previously observed launched PID, establishes client exit. Helper disconnection, PTY shell exit, prompt disappearance, and unreadable status do not. Cleanup samples evidence before deleting credential files; main can retain an observed PID in memory for later exit observation. Reads have a one-second deadline. Read error/timeout clears authority and leaves client status unknown. If cleanup happens before a PID or exit receipt is observed, later exit cannot be confirmed.

The legacy companion plan's trust-configuration inference, historical prompt attribution, and elapsed-time suspicion were not required for canonical Task 5. Its old examples are explicitly marked historical; the implemented contract uses current prompt evidence and observed lifecycle directly.

## Verification

| Check | Verdict | Evidence |
| --- | --- | --- |
| Full unit suite after review fixes | Passed | 1,814 tests, 7 skipped; 164 files passed, 1 skipped |
| Renderer build / e2e TypeScript | Passed | `npm run build`, exit 0 |
| Electron TypeScript | Passed | `npm run typecheck:electron`, exit 0 |
| Production Electron bundle | Passed | `npm run electron:build`, exit 0 |
| Independent code review | Passed | 47 focused tests and two launch-status/PID tests; after fixes, 18 copy/focus/Settings tests independently passed |
| Full isolated e2e suite | Passed | 11/11 tests in 2.9 minutes; after fixture cleanup hardening, the native production test passed again in 8.5 seconds and the referenced TypeScript build passed |
| Visual inspection | Passed | Parent inspected dark/light prompt status and full focused-terminal screenshot; text and focus control rendered without clipping |
| Installed Claude rendering / live bridge consultation | Incomplete | Not performed or inferred from fixtures |

Review corrected two issues before completion: generic guidance must remain even when bridge readiness is ready; and consuming a global focus flag in the first effect setup could let StrictMode's second setup request a PTY start. The final mount-scoped focus guard is covered by a StrictMode regression asserting no start request.

## Native fixture boundaries

The new test imports the actual built production main/preload/renderer. It goes through production connected-session control, preflight, private launch script, a real native PTY, prompt observation, resize IPC, and UI. A locally compiled harmless native client supplies deterministic output and exits through an isolated control file; it never starts a model or MCP client. The separate communication e2e retains its real-helper/fake-provider protocol role and does not substitute for this production-path test.

A direct replay of the captured post-PTY stream through ConPTY again remained unknown. After two small fixture corrections did not establish recognition, the fixture was redesigned to paint a documented supported synthetic frame, omitting the full-width decorative rule. Actual PTY output is not intercepted or normalized. This frame produced positive recognition and dark/light screenshots. Replaying a post-PTY capture through ConPTY twice does not establish installed-client compatibility or a client defect.

Actual terminal resizing emitted `CSI 8;29;117 t`, which the bounded matcher does not support. Recognition therefore remained unknown through later resize/repaint until a fresh physical session. This limitation is explicit; the test must verify generic fallback and fresh-session recovery rather than claim recognition survived the resize.

Focusing may generate terminal-protocol device replies or focus reports. The final native write log contained only focus reports (`ESC[O`, `ESC[I`, `ESC[O`, `ESC[O`), not Enter, trust acceptance, pasted text, or other user input. The fixture verified two distinct shell PIDs, a surviving shell after positive client exit, and termination of the recorded client/shell processes after cleanup. Final snapshot: Session 2, client exited, prompt unknown, connected false, readiness disconnected, cleanup confirmed. Authenticated helper loss is covered separately by deterministic backend tests, not by this native client fixture, which never registers a helper.

Evidence logs: chat `work/cross-check-t5-tests.txt`, `cross-check-t5-build.txt`, `cross-check-t5-types.txt`, `cross-check-t5-electron-build.txt`, `cross-check-t5-e2e.txt`, and `cross-check-t5-native-final.txt`. Screenshots and final native diagnostics are in `outputs/task5-native/`. Fixture construction and native limitations are also documented in `e2e/fixtures/connected-client-design.md`.

Task 6 remains the cross-check composer and copy/focus request flow. Task 5 does not close U9's separately bounded real-client/provider gates.
