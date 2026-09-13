# Cross-check Task 2: session status and safe display identity

Date: 2026-09-12. Base: `8af470b`, branch `feat/visible-communication-u1`.

## Result

**Passed:** Task 2 implementation and verification. Settings displays an independently generated instance label and numbered current bridge-launch label. The runtime snapshot keeps prompt observation separate from bridge readiness. No terminal detector or model request was added.

The required `sessionStatus` contract contains only `instanceLabel`, `sessionLabel` (nullable), and `prompt` (`unknown` or `folder-trust`). A new launch begins unknown; replacement/revocation clears previous observations and stale launch observations are rejected. Main's observation method is not exposed through renderer IPC. Display labels grant no authority and are unrelated to the pipe endpoint/capability.

Explicit snapshot projection validates and copies only permitted fields; unexpected properties are discarded. Existing runtime-snapshot non-persistence remains enforced. Settings explains that bridge connection does not establish Claude's input readiness and shows No active launch when appropriate.

## Verification

| Check | Verdict | Evidence |
| --- | --- | --- |
| Full unit suite | Passed | 1,732 tests; 7 skipped; 161 files passed, 1 skipped |
| Renderer build/typecheck | Passed | `npm run build`, exit 0 |
| Electron typecheck | Passed | `npm run typecheck:electron`, exit 0 |
| Fresh Electron main/preload/renderer build | Passed | `npm run electron:build`, exit 0 |
| Real Electron app smoke | Passed | 6 tests, including distinct visible labels in two simultaneously open isolated instances with communication disabled |
| Real helper / fake-provider communication flow | Passed | 1 flow test through existing built helper and renderer |
| Independent source review | Passed | No blocking findings; reviewer independently ran 38 focused tests |

Lifecycle tests cover prompt/readiness independence, unchanged credits, invalid raw observations, stale ownership, replacement, helper disconnect, disable, exit invalidation, and failed listener startup. Serialization tests cover the field allowlist, malformed labels/status, extra-property stripping, and persistence exclusion.

## Correction discovered during verification

The renderer build exposed a Task 1 e2e typing omission: its browser callback's `window` name resolved to Playwright's Page, and the separate e2e TypeScript project lacks the renderer Window augmentation. The final test uses a narrow structural `SmokeBridge` view of the injected preload object obtained with `Reflect.get`, with an object-presence check. Earlier type fixes and one leftover wrapper produced failed build attempts; the final renderer build and real Codex replacement test both passed. No application permissions or compiler checks were weakened.

## Limits and next task

**Incomplete:** actual trust detection and positive client-exit evidence are not implemented. Prompt observations were driven directly in tests; normal runtime remains unknown until Tasks 3–4 provide the detector and wiring. A helper disconnect, failed launch, and actual client exit currently all revoke a bridge launch. Task 5 must obtain positive client-exit evidence rather than interpreting disconnected readiness as Client exited.

The two-instance e2e verifies displayed instance identities with communication disabled; it does not prove a simultaneous connected-session consultation in both instances. The helper flow uses a deterministic provider, not a live model. This work does not itself close U9's remaining production/live verification gates.

Task 3 is next: bounded current-prompt recognition, with no selected-option parsing or automatic terminal input.

## Evidence

Chat workspace `work/`: `cross-check-t2-tests.txt`, `cross-check-t2-build.txt`, `cross-check-t2-types.txt`, `cross-check-t2-electron-build.txt`, `cross-check-t2-ui-tests.txt`, `cross-check-t2-e2e.txt`, and `cross-check-t2-helper-e2e.txt`.
