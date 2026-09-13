# Cross-check Task 5B — narrow resize handling

Implemented against `4741296`. This checkpoint narrowly ignores complete `CSI 8;digits;digits t` sequences under Aether's current xterm configuration. Installed xterm defaults `windowOptions` to `{}` and ignores operation 8 when its option is disabled; Aether supplies no override. Other window controls remain conservative. The sequence neither changes matcher dimensions nor clears unrelated persistent uncertainty. Actual PTY resize remains the source of geometry.

## Verification

- **Passed:** 76 focused matcher/consumer tests, including split controls, unrelated/partial `t` forms, unsupported geometry, no geometry inferred from text, and preserved prior mode uncertainty.
- **Passed:** full unit suite — 1,825 passed, 7 skipped; 164 passed test files, one skipped file.
- **Passed:** renderer/e2e TypeScript build, Electron typecheck, and Electron production build. Renderer build was rerun after the final e2e assertion change. Existing build-size/line-ending advisories do not represent a new failure.
- **Passed:** rebuilt production native fixture — 1/1 test in 8.8 seconds. The fixture loads the real production entrypoint, observer, native PTY, preload, and renderer with a harmless native client, not a model.
- **Passed:** independent spec and quality review. One non-blocking observation: the first positive assertion can observe an earlier positive state, so it is not standalone proof of a new redraw. The later explicitly asserted unknown-to-positive transition at 161×30 then 100×30, within the same session, is the decisive recovery check. Retain this observation for the combined Task 8 review.

Native evidence records actual `CSI 8;29;117t` output and resize calls `117×29 → 100×30 → 161×30 → 100×30`. The test observes positive recognition after supported redraw, unknown at the unsupported geometry, and positive recognition after returning to supported geometry without replacing the session. The post-recovery screenshot visibly shows **Action required: folder trust**.

The first native attempt placed its output checkpoint after the relevant resize sequence and failed its sequence assertion. Inspecting the diagnostics showed the real sequence was present; the final assertion examines the recorded stream and the native run passed. Production code was unchanged between those runs. No fixture output was intercepted or normalized, and no helper/C# fixture edits were needed.

The fixture later verifies replacement and explicit fake-client exit. Final recorded snapshot: Session 2, client exited, prompt unknown, bridge disconnected, cleanup confirmed. Both recorded shell PIDs were absent after the run. Focus/input and cleanup assertions remain in the native test.

## Evidence and limits

Saved artifacts: `task5b-native/focused-terminal-light.png` and `task5b-native/native-fixture-diagnostics.json` beside this report. Logs/reviews in this chat's `work/`: `task5b-implement.md`, `task5b-review.md`, `task5b-tests.txt`, and `task5b-types.txt`.

**Incomplete:** a fresh installed-Claude run with the combined detector fixes, Claude 2.1.270 compatibility, the separately unisolated original-capture-through-ConPTY replay failure, and remaining U9 gates. The synthetic native frame proves only the exercised path. No real client/model launch or trust response occurred during 5B. Changes to xterm's window-operation configuration would require rechecking this assumption.

Next: Task 6A, followed by 6B and 6C. No push or merge.
