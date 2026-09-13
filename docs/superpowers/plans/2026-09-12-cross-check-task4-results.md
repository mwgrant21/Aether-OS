# Cross-check Task 4: connected prompt wiring

**Passed.** Implementation, verification, and independent review completed against base `7644c34`. Task 4 only. No model calls, push, or merge.

## Changes

- Added `ConnectedPromptObserver`, a main-process owner for a matcher belonging to one physical PTY and captured bridge launch ID. New physical sessions receive fresh matchers; replacement invalidates observer ownership before outgoing callbacks can run.
- Wired the connected Claude spawn callback and Claude resize IPC to that observer. Ordinary Claude and Codex output do not feed prompt recognition. Existing PTY rendering, usage ingestion, and lifecycle behavior remain in place.
- Positive recognition publishes `folder-trust`; every other matcher result publishes `unknown`. Historical `seenAt` never supplies current readiness, prompt absence, or client-exit evidence. The existing bridge seam emits snapshots only when state changes.
- Matcher geometry follows the physical connected spawn (100 columns by 30 rows), then each resize. Evidence is invalidated before native resize can emit output. A thrown native resize leaves geometry unsupported until a later successful resize; resizing cannot clear persistent parser uncertainty.
- Positive publication is held while the owning native resize is in flight, then released only after successful return and a fresh ownership check. Nested same-owner resizes remain uncertain until an independent successful resize; a replacement owner is not suppressed by an outgoing resize.
- Added 21 deterministic production-callback regressions, bringing the consumer suite to 23. They execute source-selected main callbacks with fake physical PTYs and a bridge observation stub, alongside the real lifecycle and matcher.

The companion plan's global matcher and per-chunk lookup of the current launch ID were not used: output must retain its original owner, and reset must represent a fresh physical terminal. The canonical task list and Task 3 review disposition govern the implementation.

## Verification

| Check | Verdict | Evidence |
| --- | --- | --- |
| Full unit suite | Passed | 1,795 tests; 7 skipped; 162 files passed, 1 skipped |
| Focused consumer/lifecycle/matcher suites | Passed | Implementer ran 76 tests; parent full suite includes them |
| Renderer build / referenced TypeScript projects | Passed | `npm run build`, exit 0 |
| Electron TypeScript | Passed | `npm run typecheck:electron`, exit 0 |
| Electron main/preload/renderer bundle | Passed | `npm run electron:build`, exit 0 |
| Rebuilt native PTY plumbing | Passed | Existing Claude output and repeated Codex start smokes, 2/2; harmless CLI fixtures with model spawns blocked |
| Independent Task 4 review | Passed | Initial 91 focused tests; after the review correction, 65 consumer/matcher tests and standalone event-order probes passed; no remaining findings |
| Live connected-client prompt behavior | Incomplete | No live client probe performed; deterministic tests and plumbing smokes do not establish this |

Regression coverage includes synchronous and delayed old callbacks, failed spawn and old cleanup, normal exit, revoked launch, nonconnected output exclusion, geometry changes, persistent-mode uncertainty, unfinished controls, synchronized output, erase/repaint, synchronous resize output, and failed native resize.

One review finding was reproduced and fixed: a synthetic native resize could emit a recognizable redraw and then throw, briefly publishing `folder-trust` before returning to unknown. Final-state-only assertions missed this. The final regression checks publication order: failure produces only unknown observations; success publishes positive evidence after native return. Native reachability and visible UI impact of the original ordering were not reproduced. Independent probes also verified caught nested resize failure and replacement during an outgoing resize.

An optional standalone real-bridge reviewer probe failed during module loading (`Cannot access 'require' before initialization`), before its assertions ran; that probe is Incomplete. The existing main-integration suite passed independently and in the final full suite. The observer-only adversarial probes ran successfully.

## Limits and next step

Task 5 remains responsible for actionable UI copy/focus and positive client-exit evidence. Helper disconnect or prompt disappearance must not become “Client exited.” The matcher still supports only its bounded captured layout; unsupported dimensions or terminal controls yield unknown. No U9 live gate is closed here.

Evidence logs are in the chat's `work/`: `cross-check-t4-tests.txt`, `cross-check-t4-build.txt`, `cross-check-t4-types.txt`, `cross-check-t4-electron-build.txt`, and `cross-check-t4-e2e.txt`.
