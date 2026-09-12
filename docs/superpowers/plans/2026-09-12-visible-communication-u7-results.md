# U7 implementation and verification

Implemented on `feat/visible-communication-u1`, based on `73823c6`.

The global TopBar indicator distinguishes request direction, provider output, answer readiness, and pages actually served. Cleanup and disconnection remain separate. Its native button opens Comms only on activation and selects an exchange ID in transient state. The full exchange view remains U8 work.

The renderer copies only validated operational metadata into its store. Extra content properties are discarded; malformed rows, duplicate IDs, and oversized snapshots invalidate the whole snapshot rather than falsely showing an idle bridge. Runtime snapshots, errors, and exchange selection are excluded from persistence and hydration. Settings explains when the saved preference differs from the stopped bridge, retaining the existing privacy disclosures.

## Verification

- **Passed:** full suite: 1,707 tests passed, seven skipped; 159 test files passed, one skipped.
- **Passed:** Electron typecheck, TypeScript/renderer build, Electron build, and diff whitespace check.
- **Passed:** isolated sandboxed Electron using the built renderer/preload and synthetic main IPC metadata: request/reply labels, answer-ready versus page delivery, no automatic navigation, disconnection and cleanup labels, longest tested status fitting the TopBar at 1200×900, and static indicator under reduced-motion emulation.
- **Passed:** dark-theme screenshot visually inspected; indicator fits alongside existing controls.
- **Incomplete:** native Enter/Space activation and light-theme runtime capture. Initial harness attempts timed out waiting for persisted navigation; the revised direct-input/DOM harness encountered `UnknownVizError` during capture before keyboard assertions. These attempts do not establish an application keyboard defect or successful keyboard navigation. Unit tests cover focusability and activation dispatch, not native key delivery.
- **Passed:** independent post-fix review confirmed whole-snapshot rejection for malformed rows, duplicate IDs, and oversized metadata; the reviewer reran all four focused tests with no remaining findings.
- **Incomplete:** production-main startup, native held-quit dialog automation, and live Claude/Codex communication remain outside this unit's evidence. No model calls were made.

## Evidence and next step

`u7-dark.png` records the actual renderer. `u7-runtime-evidence.json` records the latest failed runtime attempt; prior attempt evidence and full build/test logs remain in the chat's `work/` directory. Do not interpret the latest failed run as negating earlier individually observed assertions or as a full runtime pass.

U7 implementation is ready for side review. Finish the keyboard/light-theme runtime gate before treating U7 as fully verified. U8 has not started. No push or merge was performed.

Background daily triage could not run because the selected agent model was at capacity; no triage result is claimed.
