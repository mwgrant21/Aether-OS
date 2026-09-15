# Visible communication U3 checkpoint

U3 is implemented on `feat/visible-communication-u1`. Commit order: `ea7734d` (U2 review record), `898722d` (U3 process follow-up), then `a883e1d` (U3 controller). The new controller is not wired into Electron main, MCP, or UI; no live model calls occurred.

## Implemented

- Main-only ExchangeController starts disabled. A launch receives a scoped ask/get/cancel facade; it cannot enable the feature, grant credits, or supply another launch identity. Replacing a launch revokes old access while retaining its completed answer for Comms.
- Synchronous admission reserves credit, the app slot, and payload capacity before asynchronous preparation. U1 transitions enforce duplicates, aliases, cooldown, three initial starts and operator grants. Rejected asks include current credits and next-eligible time.
- Each exchange prepares a fresh empty temporary cwd and uses a caller-supplied provider factory. Production integration must use `cwd => new CodexAppServerAdapter(undefined, undefined, cwd)`. Cwd now reaches both the supervisor and native CreateProcess before initialization. A real child test verifies this with the production sanitized environment.
- Server-side waits use independent timers and abort signals, with one lease owner and at most 16 waiters. Followers do not renew or promote automatically. Chunks do not wake waits; cancellation wakes existing waiters once, and later gets can wait for termination. The absolute five-minute deadline never extends.
- Cancellation during preparation or a turn retains ownership until cleanup. Late workspace allocation is removed before reuse. Failed provider disposal or workspace removal keeps the slot blocked, including across disable or launch replacement. Main can await dispose; it rejects unconfirmed cleanup.
- Answers and supplied text stay in controller memory. Admission conservatively reserves both authoritative answer text and page copies, plus framing, under 2 MiB and at most 20 retained content records. Live-launch identity/budget tombstones survive expiry; ended-launch records are pruned after content expiry and confirmed cleanup. Capacity may reject before 20 records because of conservative byte reservation.
- Final-only and streamed output are bounded at 64 KiB. Immutable page text/cursors preserve Unicode and JSON escaping. Pages fit both the inner JSON and the actual MCP text-content wrapper within 32 KiB, with source pages at most 24 KiB. Current status accompanies each page, including cleanup, credits and cooldown; those status fields can change on replay while page content remains stable.
- Completed content survives lease callbacks and client loss for its original ten-minute retention. Clear/disable erase payloads. Supervisor diagnostic files are reaped after host close, including failed cleanup, while the failure remains latched in memory. Active-host files are preserved; this is not a general orphan sweep after application crash.

## Verification

| Check | Verdict | Result |
| --- | --- | --- |
| Controller scenarios | **Passed** | 21 worker tests and 7 independent boundary tests |
| Independent review | **Passed** | 63 controller/U1 tests, 15 process/policy tests; final controller recheck passed with no blockers |
| Process/provider checks | **Passed** | 116 tests: 6 process, 9 policy, 101 provider regressions |
| Full root suite | **Passed** | 1,578 passed, 6 skipped; 144 passing files and 1 skipped file |
| Electron TypeScript | **Passed** | npm run typecheck:electron |
| Renderer build | **Passed** | npm run build |
| Electron build | **Passed** | npm run electron:build |

Tests cover 45/60-second waits, the five-minute deadline, owner abort/follower nonrenewal, new-owner admission, waiter capacity, cancellation during every provider preparation stage, late workspace allocation, cleanup failure and delayed completion, grants/replay, retention pressure, expiry, Unicode/surrogate boundaries, final-only output overflow and subscription-only auth. Review found and corrected cancellation notification ordering, page-memory reservation, cleanup confirmation ordering, MCP wrapper overflow, and missing status/budget fields. Regression assertions reproduced wrapper overflow and missing cooldown fields before their fixes.

Existing build warnings about optimizeRules node:path and bundle size remain. Skipped/live tests are not counted as passed. No packaging, app launch, collector suite, live model calls, merge or push was performed.

## Integration responsibilities

Claude accepted `a883e1d` and independently reproduced the checkpoint counts and builds above. Its latent defensive-branch finding is now fixed: response construction computes prospective page-served accounting, validates the full encoded envelope, and only then commits that accounting. A fault-injection regression supplies an oversized internal page, verifies OUTPUT_LIMIT leaves served count at zero, and verifies a subsequent valid page increments it once. No production injection API was added. **Passed:** 64 focused controller/U1 tests (21 controller, 8 boundary, 35 lifecycle), Electron typecheck, and whitespace check for this follow-up. The full suite/build counts above belong to the original U3 checkpoint and were not rerun for this small ordering fix.

- U4 must map authenticated connections to the existing launch facade; a helper reconnect must never call openLaunch or reset credits. It must cancel an accepted exchange if transport cancellation occurs after synchronous ask returns but before its acknowledgment is delivered. Wrap pages once as a single text item; preserve status and encoded-size bounds. Align exact error guidance with v4.
- U5 must instantiate the single app controller, wire the real factory and enforce a bounded shutdown around dispose. A delayed filesystem allocation remains owned; a shutdown timeout is not cleanup proof. Do not release the slot or delete cwd after a cleanup failure.
- Repeat U0 against the target Claude client before U4/U5 integration. The original runtime evidence is for 2.1.267; the reviewed 2.1.269 addendum is static evidence only.
- **Incomplete:** MCP transport, UI, packaged end-to-end execution and authorized live-provider smoke. Those are later units. Empty cwd avoids inherited project context but is not filesystem read confinement; Codex-managed history remains outside Aether's memory-only retention claim.
