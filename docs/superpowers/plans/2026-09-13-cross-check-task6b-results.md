# Cross-check Task 6B — terminal composer

**Passed.** Implemented against `29fac46`. The Terminal toolbar now opens **Cross-check with Codex**, with question/context fields, displayed instance/session target, separate **Copy request** and **Focus connected terminal** actions, and navigation to communication settings.

The draft lives in a dedicated transient React provider above changing views. Navigation preserves it; explicit discard and provider teardown clear it. Opening focuses the question field; discard restores the opener only if it still exists. Copy uses Task 6A's validated formatter, refreshes launch state, and requires explicit review of a replacement target. The proposed target is displayed with a reminder that idempotency is scoped to a launch.

Copies are serialized across edits and close/reopen. Revision, target, operation, and lifetime guards suppress stale feedback and delayed focus. Copy success followed by a target change is reported honestly; a failed post-copy status check is reported as unverified. Clipboard unavailable/failure preserves the draft. Existing client-status copy distinguishes launch availability from input readiness. No action pastes, submits, enables communication, starts a client, grants consultations, or creates an exchange.

## Verification

- **Passed:** full formatter-policy assertions added and tested before UI integration, closing the Task 6A coverage finding (9 tests).
- **Passed:** final focused formatter/composer/existing-status suite, 34 tests. Includes default-off, enabled/no launch, trust/unknown states, helper disconnection, exit, target replacement, clipboard failures and races, explicit discard, unmount, StrictMode, keyboard focus, and persistence.
- **Passed:** parent final full suite, **1,856 passed / 7 skipped**, 166 test files passed / one skipped, 17.08 seconds. Log: chat `work/task6b-full-tests.txt`. This final run supersedes the earlier unreconciled 1,849 report; the count matches the base plus 22 composer tests and one formatter test.
- **Passed:** production renderer TypeScript/Vite build after review fixes. Existing externalization/chunk warnings remain.
- **Passed:** independent specification and quality re-review, no remaining findings. Reports: chat `work/task6b-review.md` and `work/task6b-rereview.md`.

Review required keyboard focus handling and clipboard-failure tests before completion. The persistence test was also strengthened: it prepares a real request, computes its expected key independently, confirms normal state was actually persisted, and excludes the question, context, and key from both saved and global state.

## Scope and next step

Changed `src/App.tsx`, `src/components/terminal/TerminalView.tsx`, new `CrossCheckComposer.tsx` and its tests, and the formatter test. No bridge, Electron, PTY, global reducer, or persistence production code changed. The shared provider exposes `useCrossCheckComposer().open()` for Task 6C's Comms entry.

**Incomplete:** actual renderer clipboard/paste/xterm/ConPTY payload-integrity verification, dark/light native visual inspection, and the Comms entry (Task 6C). This checkpoint's component tests use mocked clipboard and terminal-focus interfaces; they do not prove real terminal input preservation or native payload delivery. No serialized-size cap was invented. Fresh installed-Claude compatibility, original ConPTY replay investigation, and remaining U9 gates stay open. No live model calls, trust input, push, or merge.

Next: Task 6C. Task 8 should verify the now-closed formatter-policy coverage item and still review the Task 5B first-positive-assertion observation.
