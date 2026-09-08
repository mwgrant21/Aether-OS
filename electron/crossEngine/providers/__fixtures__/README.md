# `__fixtures__/codexRateLimits.real.json`

Captured from the **raw stdout** of a real `codex app-server` (codex-cli 0.153.2),
2026-09-07, in response to `account/rateLimits/read` with no thread opened. The
account id and the credit-grant id were redacted (replaced with all-zero
placeholders of the same shape/length); everything else, including key order,
is byte-for-byte identical to what the server sent.

## No `jsonrpc` field -- verified against the wire, not inferred

The top-level keys of a real response are exactly `["id", "result"]`. There is
**no `jsonrpc: "2.0"` field**, even though this codebase's own `JsonRpcLine`
type and its outgoing requests carry one. This was re-confirmed by printing
the raw stdout line before any parsing and checking
`hasOwnProperty('jsonrpc')` (false) on both this response and the
`initialize` response. Don't "fix" the fixture to add a `jsonrpc` field to match `JsonRpcLine` -- the
fixture is faithful to the real server. `JsonRpcLine` in this file's own
`codexAppServer.ts` already declares `jsonrpc?: '2.0'` as optional, so this is
harmless here; the sibling `JsonRpcLine` in `electron/crossEngine/acpClient.ts`
(a different provider) declares it non-optional, which is a separate,
already-tracked latent mismatch for a future task, not a defect in this
fixture.
