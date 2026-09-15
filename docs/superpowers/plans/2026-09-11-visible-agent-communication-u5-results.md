# U5 results

U5 main/preload integration: **Passed** for the implemented backend scope. The bridge remains disabled by default. No live Claude or Codex calls, push, merge, or installed-client configuration changes were made.

## Delivered

- Main constructs one integration service independently of Settings. Its production provider factory passes the private process cwd to CodexAppServerAdapter.
- Main-only prepareLaunch waits for the local listener before returning a fresh 32-byte random capability and endpoint. Launch preparation is serialized. Replacement, helper disconnect, explicit Claude-exit notification, disable, and shutdown revoke old authority.
- Ready requires pipe authentication and tools/list. Helper discovery remains available when main is unavailable; listing before authentication is remembered and reported after authentication.
- Preload exposes snapshot subscription, snapshot read, bounded payload read, enable/disable, cancel, and clear. IPC validates exact arguments and the current main-window main-frame sender. It exposes no capability, launch preparation, or credit grant.
- Disable erases payloads synchronously and waits for listener/provider cleanup. Cleanup failure survives payload clearing and absence of a UI subscriber. Timeout or failure stays failed and refuses re-enable.
- Quit waits for cleanup, bounded to 12 seconds. Unconfirmed cleanup holds the app open. On Windows/Linux, window close enters this gate before destroying the window. This intentionally has no automatic force-quit fallback.

## Verification

| Check | Verdict | Evidence |
| --- | --- | --- |
| Full Vitest suite | Passed | 151 files passed, 1 skipped; 1,630 tests passed, 6 skipped |
| Electron TypeScript | Passed | npm run typecheck:electron |
| Renderer build | Passed | npm run build |
| Electron build | Passed | npm run electron:build; main, helper and CommonJS preload emitted |
| Built helper smoke | Passed | Actual emitted helper; 3 tools, 5 JSON response lines, 1 fake turn, 1 provider disposal, 1 disconnect, protocol-only stdout |
| Independent review | Passed | Service/readiness/IPC/quit review; cleanup retention findings corrected |
| Actual Electron window/frame execution | Incomplete | Production wiring source-reviewed and unit-tested; Electron was not launched in U5 |
| Live Claude/Codex communication | Incomplete | Not exercised in U5; later authorized activation stages own this |

Build warnings remain for node:path browser externalization in optimizeRules and renderer chunk size. Initial new test failures were test-harness issues (jsdom import URL, callback annotations, source assertion syntax); corrected before the full passing run.

## U6 handoff

Wire the persisted preference and operator UI, fresh Claude launch configuration/manifest protections, pinned client launch, explicit credit confirmation, and actual Claude lifetime callback. prepareLaunch and notifyClaudeExit are main-only service APIs; the current pty:start path does not invoke them yet. A listener close result alone is not provider-exit evidence: observe aggregate cleanup state or await disable/dispose. Shutdown failure is sticky; there is no in-app recovery UI yet.

The prior U4 client probe remains the existing capability evidence. U5 performed no additional model probe. Whole-branch and live end-to-end review remain later gates.
