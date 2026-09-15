# U8 — actual exchange content in Comms

**Side-review update, 2026-09-12:** U8 accepted with no code findings. Independent full-suite/typecheck execution now Passed using approved command escalation. U7's keyboard/light-theme gate was already closed before U8 by `u7-keyboard-theme-2026-09-12-review.json` and `u7-review-disposition.md`; its omission here was a tracking error. See `u8-review-disposition.md` for the correction and remaining gates. The original checkpoint below is retained as history.

Implemented on `feat/visible-communication-u1`, based on `04286d9`. U9 has not started. No live model calls, push, or merge.

## What changed

Comms now has Channels and Agent exchanges views. The global indicator opens its selected exchange; the exchange list supports explicit selection. The mounted view renders the supplied question/context and actual advisory output as text, with provider state, independent page-delivery state, elapsed time, active lease/deadline, retention countdown, cancellation, explicit Copy answer, partial-failure labeling, and unavailable/expired content handling.

Payloads are pulled from main only while the exchange view is mounted. Reads are serialized and scheduled 500 ms after settlement, validated against the existing byte limits, and held only in component state. Selection/launch changes, expiry, and unmount invalidate late results. Viewing does not renew Claude's lease or fetch a Claude answer page.

The badge now counts answers the operator has not opened, independently of Claude's pages served. Viewed IDs are bounded and transient; payloads never enter reducer state or persistence. The recovery copy gives the selected exchange ID, explains same-launch retrieval without another credit, and states that a replacement launch cannot retrieve the old exchange. No terminal injection is performed.

Retention copy explicitly names the ten-minute window and early removal on clear, bridge disable, or Aether exit. Separate CLI transcripts/tool output/Codex history may persist.

## Verification

- **Passed:** 1,717 tests; seven existing skips. 160 test files passed, one skipped.
- **Passed:** Electron typecheck, TypeScript/renderer build, Electron build, whitespace check.
- **Passed:** nine new hook/UI regression tests covering pre-mount completed answers, stale/rapid selections, final answer refresh, launch replacement, ten-minute expiry, late completion, unmount, byte limits/errors, markup as text, explicit copy/cancel, partial failures, page progress/client loss, and persistence sentinels. One additional source guard protects the state/persistence surfaces.
- **Passed:** independent source review. Its retention-copy finding was fixed. No remaining concrete findings.
- **Incomplete:** independent reviewer test execution could not start because esbuild encountered sandbox access denial while resolving `vite.config.ts`. The parent's successful test execution is separate evidence.
- **Passed:** real sandboxed Electron with the built renderer/preload and synthetic main IPC: eleven runtime assertions, including indicator navigation, operator-unread versus Claude receipt, literal markup, full answer retention after client loss, polling teardown on Settings/Channels, exchange remount, explicit cancellation, expiry removal, and persisted-sentinel absence.
- **Passed:** dark/light screenshots captured and visually inspected. Text wraps in a scrollable article; the existing TopBar and navigation remain visible. Probe processes exited.
- **Incomplete / separate gate:** production main plus real helper/provider lifecycle remains U9 work. Native quit-dialog automation and live Claude-to-Codex smoke are not established by these synthetic IPC checks. Clipboard behavior was verified with a mocked clipboard in unit tests, not by modifying the operator's live clipboard.

## Evidence index

| File | Scope |
| --- | --- |
| `u8-runtime-2026-09-12.json` | Current full runtime result: Passed, eleven assertions. |
| `u8-exchange-dark-2026-09-12.png` | Actual dark renderer showing a retained answer, partial page delivery, disconnected client, and literal markup. |
| `u8-exchange-light-2026-09-12.png` | Same exchange in light mode. |
| `u8-runtime-2026-09-12.cjs` | Reproducible isolated harness; references the existing worktree build. |
| `u8-runtime-2026-09-12-attempt1.json` | Historical failed harness lookup: case-sensitive LIGHT text after five passed checks. No application change was required. |
| `u8-runtime-2026-09-12-attempt2.json` | Passed nine-check run before the reviewer-requested Channels switching assertions were added. |

Full logs remain in the chat's `work/u8-tests.txt`, `work/u8-build.txt`, and `work/u8-electron-build.txt`. The hook tests are colocated in `ExchangeView.test.tsx` so content ownership and rendered behavior are verified together.

U8 is ready for Claude-side review. Next is U9's full-path deterministic verification; a live model smoke still requires its separate allowance.
