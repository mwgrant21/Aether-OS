# Claude 2.1.274 bridge compatibility probe

**Date:** 2026-09-17 (UTC)
**Outcome:** Passed on both launch shapes. `BRIDGE_CLAUDE_VERSION` raised `2.1.270` → `2.1.274`.
**Harness:** `scripts/communication-compat/` (committed, unlike the 2.1.270 probe's)
**Supersedes the gate in:** [Task 9A: Claude 2.1.270 compatibility re-probe](2026-09-13-cross-check-task9a-results.md)

> **Correction, same day.** The first two sessions ran with the harness declaring
> `readOnlyHint: true, openWorldHint: false`, while the real bridge declares the
> opposite (`mcpServer.ts:14`). Those annotations can influence permission
> handling, so their `exact_preapproval` result described a tool shape production
> never ships. Found by Codex review of the harness PR. A **third** session was run
> with the annotations corrected; it is the authoritative one below, and
> `compatHarnessParity.test.ts` now fails the build if the harness drifts from
> `BRIDGE_TOOLS` again.

Three real interactive Claude sessions against the synthetic bridge server. **Zero real
Codex consultations.** Exactly three model-issued fake tool calls per session: ask, one
get, one cancel.

Session ids, transcript paths and client debug logs are deliberately **not** recorded
here; they live in the machine-local run directories under
`%LOCALAPPDATA%\aether-communication-compat\runs\`.

## Why two sessions

The first ran production's launch shape: three separate `--allowedTools` arguments and
**no** `--permission-mode`, so the child inherited this machine's `defaultMode: auto`.
That is faithful to production — Aether sets no mode either — but it means fast
permission decisions cannot be attributed to `--allowedTools` rather than to auto mode
approving everything. `exact_preapproval` is the property the pin most exists to protect,
so evidence that cannot distinguish those two causes is not good enough to bump on.

The second forced `--permission-mode manual`, making `--allowedTools` the only possible
approval source, exactly as the 2.1.270 probe did. No permission prompt appeared
(confirmed live by the operator) and the dispatches stayed sub-millisecond.

## Results

| Property | Run 1 (production shape) | Run 2 (isolating) |
| --- | --- | --- |
| `evidence_complete` | Passed | Passed |
| `transcript_present` | Passed (69 rows) | Passed |
| `direct_tool_presentation` | Passed | Passed |
| `exact_preapproval` | Passed | Passed |
| `quiet_inline_get` | Passed | Passed |
| `payload_integrity` | Passed | Passed |
| `provider_isolation` | Passed | Passed |
| **Verdict** | **Passed** | **Passed** |

### Run 3 — corrected annotations (authoritative)

Manual permission mode, tools declared exactly as production declares them
(`readOnlyHint: false`, `openWorldHint: true` — the shape most likely to prompt).
All seven properties **Passed**.

| Measurement | Run 3 |
| --- | --- |
| requested / effective permission mode | `manual` / `default` |
| permission decisions | 2 / 1 / 2 ms, no prompt |
| tool-search calls / non-bridge tools | 0 / none |
| quiet wait, server-measured | 60,048.203 ms |
| aborted / intervening model responses | no / 0 |
| serialized payload | 32,741 B (limit 32,768), exact text match |
| receipt markers reported | 3/3 |
| usage | 8 in / 79,839 cache-creation / 313,292 cache-read / 577 out |

This is the only run whose `exact_preapproval` evidence describes the tools
production actually ships. The pin bump rests on it.

| Measurement | Run 1 | Run 2 |
| --- | --- | --- |
| requested permission mode | *(none — production shape)* | `manual` |
| effective mode in transcript | `auto` | `default` |
| permission decisions | 2 / 1 / 0 ms | 2 / 1 / 1 ms |
| tool-search calls by the model | 0 | 0 |
| non-bridge tools called | none | none |
| quiet wait, server-measured | 60,058.387 ms | 60,045.394 ms |
| aborted / intervening model responses | no / 0 | no / 0 |
| serialized payload | 32,741 B (limit 32,768) | 32,741 B |
| receipt markers reported | 3/3 | 3/3 |

Usage, summed over unique response ids — a call budget, not a context budget, and not a
dollar estimate:

| | input | cache creation | cache read | output |
| --- | --- | --- | --- | --- |
| Run 1 | 8 | 104,819 | 273,504 | 647 |
| Run 2 | 8 | 106,442 | 278,226 | 935 |

## Finding: 2.1.274 defers the tool roster

The mechanism behind `direct_tool_presentation` changed between versions.

```
2.1.270:  Dynamic tool loading: 0/386 deferred tools included

2.1.274:  [ToolSearch:optimistic] mode=tst, ENABLE_TOOL_SEARCH=undefined, result=true
          Dynamic tool loading: found 3 discovered tools in message history
          Dynamic tool loading: 3/387 deferred tools included
```

2.1.274 enables optimistic tool search by default and defers the roster. The three bridge
tools are included **from** that deferred pool rather than sitting in the base set —
almost certainly because production's `mcp.json` sets `alwaysLoad: true`.

The observable property still holds, and the ordering says so: the tools were included at
`04:27:19.9`, the first dispatch was at `04:27:21.8`, and the model never issued a
tool-search call in either session. But this is a genuine behavioural change, and it is
the kind the pin exists to catch.

**It also invalidated the old probe's assertion.** Task 9A's auditor asserted the literal
string `0/386 deferred tools included`. On 2.1.274 that reads `3/387` and the old auditor
would have failed a client that is actually fine. The generalized check — tools called
directly, in order, with no search indirection and nothing else invoked — passed. Do not
reintroduce a hard-coded roster count.

## What this does not establish

- **Negative permission boundaries.** Neither session tested that tools outside the three
  stay unapproved. Sub-threshold timing is strong evidence of preapproval, not proof that
  nothing else was approved.
- **Real provider cleanup.** The server is synthetic and never launches Codex, so its
  `COMPAT-CLEANUP-OK` receipt is a string. Real Codex process-tree cleanup is a separate
  check on the live path.
- **A production round trip.** No Aether-launched connected session, real consultation or
  retrieval was performed. Live validation remains **Incomplete**.
- **That the packaged app is updated.** A source edit does not change an already-running
  packaged build; the installed 0.4.0 app still carries the old pin until rebuilt.

## Changed by this bump

- `electron/communicationBridge/launchConfig.ts` — `BRIDGE_CLAUDE_VERSION`.
- `e2e/fixtures/connected-client.cs` — fixture version, held aligned by the
  `keeps the native connected fixture version aligned with production` test.
- `electron/communicationBridge/launchVersion.test.ts` — the whitespace/format edge-case
  table. Its negative case is now `2.1.270 (Claude Code)`, i.e. **the previously accepted
  version must now be rejected**, which is what shows the gate actually moved rather than
  widening.

Mismatch rejection and every policy/permission check are unchanged.
