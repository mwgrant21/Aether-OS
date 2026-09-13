# Task 8: combined verification and whole-change review

Base: `86b7c1b`. Implementation and fixture verification: **Passed**. Full real-client acceptance: **Incomplete**. No production application code, installed skill, Claude configuration, or permission rules changed in this task.

## What changed

- Added a two-instance Electron integration test using separate profiles, production renderer/preload, bridge/controller/IPC, and the built authenticated MCP helper.
- Combined actual clipboard copy and xterm focus with deterministic PTY events and provider completion. Test code submits the copied JSON; Claude does not read or execute it.
- Updated privacy and usage documentation to include the transient App-level composer draft, explicit clipboard copies, manual submission, and the separate user-skill installation/discovery boundary.

## Verification

| Check | Verdict and evidence |
| --- | --- |
| Unit suite | **Passed**: 1,861 tests, 7 skipped; 167 files passed, 1 skipped. Run on unchanged product source before adding the new e2e fixture. |
| Renderer build, Electron typecheck, Electron build | **Passed**. Build retains the existing large-bundle warning. |
| Existing complete Electron suite | **Passed**: 12/12 in 3.0 minutes, including real native PTY delivery, large paste, production-entrypoint replacement/prompt/exit, long helper waits and cleanup. |
| New combined test | **Passed**: implementer run and independent parent run, each 1/1 in 5.8 seconds. These are separate from the 12-test suite, not a claimed single 13-test run. Final discovery lists 13 tests in six files. |
| Two-instance isolation | **Passed**: distinct profiles/instance labels; one deterministic provider turn in A and zero in B; A uses one credit while B retains three; B cannot retrieve A's exchange. |
| Actual clipboard and focus | **Passed**: each copy contains its own supplied question/context; focus targets that window's xterm. Recorded additional writes are only ESC[I focus reports following ESC[O reports, not user-input writes. This is not a zero-bytes claim. |
| Delivery | **Passed**: real helper tools/list and calls; pending then visible 0/3, 1/3 and 3/3 pages served; exact reconstructed answer; duplicate-key admission creates no second provider turn. The duplicate ask is a protocol idempotency check, not the skill's prescribed workflow. |
| Replacement and prompt lifecycle | **Passed, fixture scope**: replacing A requires composer target review, rejects lookup of the old exchange, ignores superseded PTY events, and leaves B connected. Prompt clearing and exit update visible copy. Separate native production test also passed. |
| Cleanup | **Passed**: independent PID inventory plus bounded cleanup and fallback. Parent additionally checked helper PIDs 63868, 66340 and 54884 after its run: none remained alive. |
| Visual inspection | **Passed**: parent inspected dark/light composer screenshots and the combined partial-delivery screenshot. The latter shows 1 of 3 pages served and the open composer. |
| Installed skill drift | **Passed**: 6,171 bytes, source/installed SHA-256 `E4B1BDBDFA7AAD5BD7173AD387D6D19A2D4F8D1249024FE076ED6F359F9FD084`. Name/description metadata present. No skill edits or reinstall. |
| Independent whole-change review | **Passed**: reviewed cross-check range `3a2ca1c..86b7c1b` and final Task 8 additions. No remaining actionable findings. |

Saved evidence is in `outputs/task8-evidence/`: dark/light composer and folder-trust screenshots, native measurements, partial-delivery screenshot, combined evidence, and raw copy/focus write arrays. Native paste again preserved four payloads exactly after the documented Windows clipboard CRLF-to-xterm-CR conversion; largest clipboard content was 296,337 bytes, received UTF-8 296,328 bytes. This proves the harmless native receiver path, not a real model client's input handling.

## Corrections and qualifications

Review caught an invalid wait_ms 0 before it was credited as evidence; the final test uses 1000. Cleanup was corrected to retain helper PID evidence before handshake success, attempt all shutdown stages, bound waiting, and verify owned process exit.

Initial combined attempts **Failed** on a test assumption that copy/focus would produce no terminal writes. A diagnostic captured the exact focus reports; the final assertion uses the established explicit protocol classifier, not blanket control-character removal. A subsequent run **Failed** because the fake provider omitted required TurnResult.usage; adding explicit unknown/null usage fixed the fixture contract. Final runs passed after those corrections. A stalled non-escalated launch wrapper produced no test verdict and is not counted as a product test failure.

The earlier Task 6C recognition timeout did not recur in this Task 8 run. Its cause remains unresolved; one passing run does not establish a fix. The earlier captured-PTY-through-ConPTY compatibility gap is also not resolved by this combined fixture.

## Still Incomplete

- Actual connected-Claude discovery/invocation of `/aether-cross-check`, ordinary permission behavior, and compliance with the skill. File presence and synthetic helper calls do not prove these.
- Fresh positive real-Claude trust-prompt recognition after the layout/resize changes. `claude --version` was checked and reported **2.1.270**; this is version evidence only.
- Fresh full production connected-launch acceptance and the separately authorized U9 live Claude-to-Codex consultation, actual retrieved-page summary, and cleanup evidence. No live Claude or Codex model request occurred in Task 8.

These live checks need a separately specified probe allowance under the agreed plan. No push, merge, dotclaude commit, or distributed-file maintenance was performed.
