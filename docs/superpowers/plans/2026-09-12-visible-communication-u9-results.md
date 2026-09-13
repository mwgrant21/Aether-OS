# U9 verification and documentation

Base: `7468060`, branch `feat/visible-communication-u1`. No real model request, push, or merge. This report distinguishes tested components from the still-unverified complete production connected-launch workflow.

## Changes

- Added real-Electron tests using the production bridge/controller/IPC, built MCP helper over stdio and the authenticated pipe, mounted renderer/preload, and a deterministic provider running in a real child process.
- Added a 126-second consultation proving two 60-second get waits remain blocked despite output deltas, and a deliberate stalled-run test proving bounded parent watchdog termination of live helper/provider descendants.
- Existing production-main smoke now isolates home, userData and configuration, supplies harmless CLI fixtures, retains a real native PTY, suppresses shell profiles, and blocks embedded model spawns. It tests actual built main/preload/renderer; the shell environment is deliberately instrumented.
- Added native Windows Keep open dialog automation around the production quit gate and the same delayed cleanup promise.
- Added narrow provider-construction/turn-call guards and documented controls, exact limits, allowance, lease cancellation, advisory semantics, retention and separate CLI histories.

## Final command results

- **Passed:** `npm test` — 1,719 passed, seven skipped; 160 test files passed, one skipped.
- **Passed:** `npm run typecheck:electron`, `npm run build`, `npm run electron:build`.
- **Passed:** `npm run test:e2e` — all eight tests passed in 2.6 minutes. This includes production-main smoke, the real-helper flow, slow consultation, watchdog, and native quit fixture.
- **Passed:** dark/light captures visually inspected. The light image shows a retained, unserved follow-up after helper loss, not proof of delivery for that follow-up.

## Acceptance evidence

Each row states its evidence scope; a unit-test result is not represented as a complete live product demonstration.

| Example | Verdict and evidence |
| --- | --- |
| AE1 slow waits | **Passed:** real helper + fake child provider, 126-second turn and two measured 60-second waits despite deltas. |
| AE2 lost acknowledgement | **Passed:** full helper retry returns the same ID and creates one provider process. |
| AE3 ready versus served | **Passed:** helper flow and rendered Comms; finish/open leaves pages served at zero, subsequent gets serve actual pages. |
| AE4 Unicode paging | **Passed:** complete ordered multi-page Unicode output and every encoded MCP response within 32 KiB. Prior boundary tests remain in the full suite. |
| AE5 stop paths | **Passed at tested scopes:** helper-flow operator cancellation and observed process exit, watchdog tree cleanup, native quit-gate fixture, and unit/process regressions for remaining cancellation sources. **Incomplete:** all stop sources exercised through production connected-launch UI. |
| AE6 parallel callers | **Passed at unit/protocol scope:** one active slot, shared credit budget and bounded concurrent waiters. Not a new multi-client production-launch demonstration. |
| AE7 installed-client launch | **Passed prior U0/U6 scopes:** 2.1.269 presentation/permission probe and real launch/PTY fixtures. Installed version rechecked as 2.1.269. **Incomplete:** production Start fresh connected Claude through the full consultation in one run. |
| AE8 privacy | **Passed at tested scopes:** helper/UI question-context-answer sentinels absent from persisted state; U6 launch/echo/ACL evidence and serialization guards. CLI histories and restricted manifests retain their separately documented scope. |
| AE9 credits/grants | **Passed:** helper flow exhausts three starts; repeated main-side confirmation ID grants exactly three once. Unit tests cover remaining grant/reconnect/tombstone boundaries. Native production grant confirmation is not claimed by this fixture. |
| AE10 retained answers | **Passed at tested scopes:** full answer survives helper loss, with U8 exact ten-minute expiry and renderer evidence. The U9 helper test does not wait ten wall-clock minutes. |
| AE11 waiter ownership | **Passed at unit/protocol scope:** owner/follower, read cancellation and lease boundaries. Not a new multi-client production demonstration. |
| AE12 success cooldown | **Passed:** two immediate distinct successful follow-ups accepted through the real helper. |
| AE13 background threshold | **Passed prior U0/U6 scopes:** hostile-profile override/restoration and actual installed-client blocking probe. No newly authorized model probe was run. |
| AE14 recovery | **Passed:** same-launch retrieval costs no extra credit; replacement launch rejects the predecessor ID; U8 recovery copy tested. Physical clipboard write remains unverified (explicit action tested against a mock). |

## Review and limitations

Independent review found and closed a test watchdog weakness: a hung Electron root could leave descendants. The correction bounds the parent wait and taskkill, observes root exit, and independently verifies recorded helper/provider PIDs are live before forced termination and gone afterward. Independent watchdog rerun: **Passed**, one test in 15.7 seconds. Independent focused lifecycle/privacy/provider-guard rerun: **Passed**, 62 tests. No remaining blocking source findings were reported.

The native dialog test recorded actual Keep open response 1, a retained window, two waits on the same cleanup promise, and clean quit after resolution. This proves the production gate with a real native dialog and deterministic timing; it is not a production-main delayed-provider reproduction.

**Still Incomplete:** the complete production fresh-connected-Claude workflow; live Claude-to-Codex smoke (separate explicit one-consultation allowance); physical clipboard integration. U9 therefore has substantial passing verification but is not represented as fully closed or fully live-verified.

## Evidence index

- `u9-flow-2026-09-12.json`: production communication modules + real helper + deterministic child provider.
- `u9-slow-2026-09-12.json`: real 126-second consultation and bounded waits.
- `u9-native-quit-2026-09-12.json`: actual native dialog and quit-gate result.
- `u9-ready-dark-2026-09-12.png`, `u9-retained-light-2026-09-12.png`: rendered real-helper exchanges; light image is a retained follow-up with no pages served.
- `u9-e2e-2026-09-12.txt`: complete final e2e command output, including watchdog result.
- `u9-acceptance-inventory.md`: prior evidence map; its pending notes describe the pre-U9 inventory and are superseded by this report.

The test fixture source is committed under `e2e/`; full unit/build/typecheck logs remain in the chat's `work/u9-*.txt`. Early fixture-only failures (ESM require lookup and CommonJS import.meta URL handling) were diagnosed before protocol checks and corrected. No product permission or billing boundary was weakened.
