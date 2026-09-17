# Claude 2.1.274 bridge compatibility probe

**Date:** 2026-09-17 (UTC)
**Outcome:** Passed on both launch shapes with production-accurate tool definitions.
`BRIDGE_CLAUDE_VERSION` raised `2.1.270` → `2.1.274`.
**Harness:** `scripts/communication-compat/` (committed, unlike the 2.1.270 probe's)
**Supersedes the gate in:** [Task 9A: Claude 2.1.270 compatibility re-probe](2026-09-13-cross-check-task9a-results.md)

Four real interactive Claude sessions against the synthetic bridge server. **Zero real
Codex consultations.** Exactly three model-issued fake tool calls per session: ask, one
get, one cancel.

Session ids, transcript paths and client debug logs are deliberately **not** recorded
here; they live in the machine-local run directories under
`%LOCALAPPDATA%\aether-communication-compat\runs\`.

## Two variables, and why four runs

Two things independently affect how a client presents and approves these tools:

- **Tool annotations.** The harness originally declared `readOnlyHint: true` and
  `openWorldHint: false`; the real bridge declares the opposite (`mcpServer.ts:14`). A
  client may treat a read-only tool differently from an open-world one, so a probe using
  the wrong annotations validates a tool shape production never ships.
- **Argument shape.** Production passes three separate `--allowedTools` arguments and
  **no** `--permission-mode`, so the child inherits this machine's `defaultMode: auto`.
  Under `auto`, a fast permission decision cannot be attributed to `--allowedTools`
  rather than to auto approving everything — which is why an isolating `manual` run is
  also needed.

Only a run with **correct annotations** is evidence at all, and both argument shapes
must be covered. That takes two valid runs:

| Run | Argument shape | Annotations | Status |
| --- | --- | --- | --- |
| 1 | production (no mode) | wrong | **invalidated** |
| 2 | `manual` | wrong | **invalidated** |
| 3 | `manual` | correct | **valid** — isolates `--allowedTools` |
| 4 | production (no mode) | correct | **valid** — production's real launch |

Runs 1 and 2 are kept here rather than deleted, because the correction is part of the
record. Their numbers are not evidence for anything.

The annotation defect was found by Codex reviewing the harness PR, not by this probe.
The gap that only run 3 had correct annotations *and* that run 3 was not production's
shape was also found by Codex, reviewing this PR. `compatHarnessParity.test.ts` now
fails the build if the harness drifts from `BRIDGE_TOOLS` again.

## Results — the two valid runs

All seven properties **Passed** in both.

| Measurement | Run 3 (isolating) | Run 4 (production shape) |
| --- | --- | --- |
| annotations | `readOnlyHint: false`, `openWorldHint: true` | same |
| requested permission mode | `manual` | *(none — production)* |
| effective mode in transcript | `default` | `auto` |
| permission decisions | 2 / 1 / 2 ms, no prompt | 1 / 1 / 1 ms |
| tool-search calls by the model | 0 | 0 |
| non-bridge tools called | none | none |
| quiet wait, server-measured | 60,048.203 ms | 60,068.125 ms |
| aborted / intervening model responses | no / 0 | no / 0 |
| serialized payload | 32,741 B (limit 32,768), exact match | same |
| receipt markers reported | 3/3 | 3/3 |

Run 3 is what shows `--allowedTools` still preapproves: with `manual` in force, it is the
only possible approval source, and the tools were declared in the shape most likely to
prompt (not read-only, open-world). No prompt appeared and dispatches stayed at 2/1/2 ms.

Run 4 is what shows production's actual launch works unchanged.

Usage, summed over unique response ids — a call budget, not a context budget, and not a
dollar estimate:

| | input | cache creation | cache read | output |
| --- | --- | --- | --- | --- |
| Run 3 | 8 | 79,839 | 313,292 | 577 |
| Run 4 | 8 | 109,157 | 279,904 | 462 |

## Finding: 2.1.274 defers the tool roster

```
2.1.270:  Dynamic tool loading: 0/386 deferred tools included

2.1.274:  [ToolSearch:optimistic] mode=tst, ENABLE_TOOL_SEARCH=undefined, result=true
          Dynamic tool loading: found 3 discovered tools in message history
          Dynamic tool loading: 3/387 deferred tools included
```

2.1.274 enables optimistic tool search by default and defers the roster. The three bridge
tools are included **from** that deferred pool rather than sitting in the base set —
almost certainly because production's `mcp.json` sets `alwaysLoad: true`.

The observable property still holds, and the ordering says so: tools included at
`04:27:19.9`, first dispatch at `04:27:21.8`, and no tool-search call by the model in any
session. But this is a genuine behavioural change, and it is the kind the pin exists to
catch.

**It also invalidated the old probe's assertion.** Task 9A's auditor asserted the literal
string `0/386 deferred tools included`. On 2.1.274 that reads `3/387`, so the old auditor
would have failed a client that is fine. The generalized check — tools called directly, in
order, with no search indirection and nothing else invoked — passed. Do not reintroduce a
hard-coded roster count.

## What this does not establish

- **Negative permission boundaries.** No session tested that tools outside the three stay
  unapproved. Sub-threshold timing is strong evidence of preapproval, not proof that
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
  widened.

Mismatch rejection and every policy/permission check are unchanged.
