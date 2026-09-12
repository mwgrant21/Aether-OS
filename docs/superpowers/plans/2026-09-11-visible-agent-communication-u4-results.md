# Visible communication U4 checkpoint

U4 is implemented on `feat/visible-communication-u1`, after `38795ea`. No Electron main/preload activation or real Codex call occurred. One separately authorized Claude Max session repeated the U0 fake-client checks.

## Implemented

- `pipeServer.ts` provides authenticated local IPC bound to a main-owned launch facade. Clients cannot select launch identity, enable the feature, or grant credits. Authentication uses an opaque capability; connections, pending requests, partial UTF-8 frames and write queues are bounded. No question/context or capability is logged.
- Calls multiplex over the connection so a waiting get cannot serialize cancel. Read cancellation aborts only that read. Ask cancellation targets only an accepted exchange ID, including a late acknowledgment; aborting a rejected request cannot cancel an earlier exchange with the same key. EOF aborts pending reads and invokes the owning launch's disconnect callback.
- Connection and short-call timers allow 900 ms each, within the two-second ask/cancel budget. Get retains its longer transport timeout. Missing/unresponsive main returns a safe error. Reconnection cannot construct a new launch or grant credit.
- `mcpServer.ts` advertises exactly ask_codex, get_codex_exchange and cancel_codex_exchange through official SDK **1.30.0**, pinned in package and lockfile. It uses the U0-proven `_meta` size annotation, plain object schemas and main's strict argument validation. Discovery is independent of main/provider startup. Omitted optional MCP arguments normalize to an empty object and produce a validation error rather than tearing down the transport.
- Responses contain one versioned JSON text item, without a structured-content duplicate. Pending is non-error; terminal failures include safe codes and prescribed guidance. A finished answer with cleanup failure retains its text/status and explains that cleanup is unconfirmed, without falsely claiming the answer failed.
- All 21 shared error codes now match the approved v4 guidance table, verified by a document-parity test. `mcpEntry.ts` receives endpoint/capability through environment, removes those environment entries after capture, and handles stdio EOF/signals. The build emits `out/main/communication-mcp.js` alongside the unchanged main entry.

## Verification

| Check | Verdict | Evidence |
| --- | --- | --- |
| Claude 2.1.269 re-probe | **Passed** | All four U0 checks; exactly three fake tool calls in one authorized interactive session |
| Pipe transport | **Passed** | 12 real local-pipe tests, including invalid auth/framing, cancellation races, EOF and production short-call defaults |
| Official SDK integration | **Passed** | 10 SDK tests with real stdio helper and fake provider, discovery, validation, waiting/cancel concurrency, paging, cleanup/failure guidance |
| Guidance contract | **Passed** | Exact parity for 21 error codes in the v4 table |
| Independent review | **Passed** | 22 pipe/protocol tests rerun; all actionable findings resolved |
| Full root suite | **Passed** | 1,602 passed, 6 skipped; 147 passing files and 1 skipped file |
| Electron TypeScript | **Passed** | npm run typecheck:electron |
| Renderer / Electron builds | **Passed** | npm run build; npm run electron:build |
| Actual built helper | **Passed** | Spawned out/main/communication-mcp.js, parsed all 5 raw stdout lines as JSON-RPC; initialize/list/ask/get/cancel, one fake turn, one disposal, EOF disconnect; stderr empty and no capability in stdout |

Review corrections included two-second aggregate timing, accepted-only ask cancellation, U0-compatible annotation placement, omitted arguments preserving active work, and guidance on actual terminal results. Existing optimizeRules node:path and bundle-size warnings remain. No packaging, Electron UI launch, collector suite, merge or push is claimed.

## Client re-probe evidence

Claude Code **2.1.269**, checked before/after; session `42aca8a8-b9a4-4b40-9176-fefec6117dca`, 2026-09-11 approximately 22:55-22:58 America/Denver. Manual permission mode and the exact three allowlisted tools, with the existing roster preserved. Debug evidence shows 0/386 deferred tools included and no ToolSearch. Each permission decision took 1 ms without a prompt. Server quiet wait was 60,063.9186 ms; client completion 60,070 ms. The 32,724-byte escaping-heavy response matched the transcript exactly and all three receipt markers were reproduced. The session/helper closed; the helper PID was confirmed absent.

Usage: 8 input, 110,630 cache-creation input, 291,156 cache-read input and 450 output tokens. This is subscription usage, not a zero-usage test or a dollar estimate. Existing hook errors did not prevent the checks. CLI transcripts/hook records remain outside Aether's memory-only retention guarantee. Detailed report/audit are `outputs/u0-reprobe-results.md` and `outputs/u0-reprobe-evidence.json` in the implementation chat workspace.

## Remaining integration

- U5 must create the single controller, bind authenticated helpers to existing launch facades, supply the disconnect callback and real provider factory, revoke capabilities, and implement bounded shutdown. Tool listing alone is not authenticated readiness; the helper currently connects lazily on a tool call. Show connected readiness only with both discovery and authenticated-main evidence.
- U6 owns fresh-session permission/config launch, private manifest/capability lifecycle, billing-variable stripping, post-profile environment pin/restoration and operator grants. No persistent user/global MCP configuration was changed here.
- U7 onward owns metadata indicator and Comms UI. Empty cwd remains no proof of filesystem read confinement; Codex-managed history remains outside Aether memory retention.
- **Incomplete:** packaged/live end-to-end bridge and real Codex smoke. The client-version re-probe gate is now satisfied on 2.1.269; other launch/UI cases remain with their planned units.
