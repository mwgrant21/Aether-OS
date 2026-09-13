# Cross-check Task 1: PTY callback ownership

Date: 2026-09-12. Base: `3a2ca1c`, branch `feat/visible-communication-u1`.

## Result

**Passed:** Task 1 implementation and required verification. `PtyLifecycle` now drops data when the emitting PTY is no longer the active owner, including after its observed exit. The shared correction applies to ordinary Claude, connected Claude, and Codex terminals. Existing spawn/kill/exit ordering and start policies remain unchanged.

## Changes

- `electron/ptyLifecycle.ts`: active-instance data guard and ownership comment.
- `electron/ptyLifecycle.test.ts`: five additional deterministic tests for late callbacks, synchronous exit during kill, failed spawn, and failed old-process cleanup.
- `electron/ptyLifecycle.consumers.test.ts`: executes the actual source-selected main-process callbacks with fake PTYs. Confirms old data cannot reach Claude rendering/usage ingestion or Codex output after replacement; exercises direct repeated Codex start.
- `e2e/app.spec.ts`: adds real native-PTY Codex replacement verification through production preload/IPC. Two starts must emit the harmless Codex fixture marker and report different shell PIDs. The PID marker is assembled in the shell so command echo cannot satisfy the assertion.

## Verification

| Check | Verdict | Evidence |
| --- | --- | --- |
| Lifecycle, consumer, Claude/Codex manager regressions | Passed | 22 tests across 4 files |
| Connected-session control regressions | Passed | 6 tests |
| Electron typecheck after all test files landed | Passed | `npm run typecheck:electron`, exit 0 |
| Fresh main/preload/renderer build before e2e | Passed | `npm run electron:build`, exit 0 |
| Existing Claude terminal real-PTY rendering smoke | Passed | 1.3 seconds; actual rendered fixture output |
| Codex repeated-start real-PTY smoke | Passed | 2.0 seconds; production IPC output and distinct shell PIDs |
| Guard-removal negative control | Passed | Implementer observed 5 failures out of 13 tests with guard removed, including both consumer tests; restored guard returned 13/13 green |
| Independent Task 1 review | Passed | No blocking findings; reviewer independently ran 13/13 lifecycle/consumer tests |

The initial focused command included a non-existent `sessionCoordinator.test.ts` selector; Vitest ran only the four other matching files. The intended `sessionControl.test.ts` suite was subsequently run explicitly: 6/6 passed. Counts above reflect executed files, not requested selectors.

## Limits

**Incomplete:** native late-output timing and its visible impact were not reproduced. Controlled event-order tests prove callback ownership; real-PTY checks prove normal plumbing with harmless CLI fixtures. The Codex test observes preload/IPC output, not Codex-pane rendering. No actual Claude/Codex model request was made.

This task does not implement trust detection or its reset lifecycle, the composer, or the skill. U9's full production connected-launch and live-provider smoke gaps remain open. No push or merge.

## Evidence files

Chat workspace `work/`: `cross-check-t1-tests.txt`, `cross-check-t1-session-tests.txt`, `cross-check-t1-types.txt`, `cross-check-t1-electron-build.txt`, and `cross-check-t1-e2e.txt`.

## Next task

Task 2: derived session status and a non-secret display identity, preserving the distinction between bridge readiness and terminal prompt/input state.
