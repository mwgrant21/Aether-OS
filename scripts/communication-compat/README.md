# Communication bridge client-compatibility harness

Checks that a given Claude Code CLI version still behaves the way the
communication bridge needs it to, before `BRIDGE_CLAUDE_VERSION`
(`electron/communicationBridge/launchConfig.ts`) is raised to accept it.

The pin is deliberately exact and fails closed. It exists because the bridge
pre-approves three tool names into a Claude child process, and a CLI release can
change tool presentation, permission handling, long-call behaviour or payload
limits without any change to `--help`. CLI 2.1.272 shipped exactly that kind of
silent change this year (mouse tracking on by default, which broke paste in the
embedded terminal).

## Why this lives in the repo

The 2.1.269 → 2.1.270 bump was validated by a harness that was never committed.
It survived only in a personal Codex workspace and was nearly reported as lost,
which made the next bump look far more expensive than it was and briefly made a
weaker probe look acceptable. **Every bump was starting from zero.** That is the
recurring cost this directory removes.

## What it proves, and what it does not

Four behavioural properties, each reported separately:

| Property | Question |
| --- | --- |
| `direct_tool_presentation` | Did the model reach all three bridge tools directly, in order, with no tool-search indirection and nothing else called? |
| `exact_preapproval` | Were exactly three bridge dispatches preapproved, each with a recorded permission decision? |
| `quiet_inline_get` | Did a long silent tool call stay inline — server-measured, not aborted, under the MCP timeout, with no intervening model response? |
| `payload_integrity` | Did an escaping-heavy payload arrive byte-identical and within the envelope limit, with all receipt markers reported? |

It does **not** prove:

- Anything about a real Codex consultation. The server here is synthetic and
  never launches a provider, so its "cleanup receipt" is a string. Real provider
  cleanup is a separate check on the live path.
- Negative permission boundaries. Fast permission decisions are consistent with
  preapproval but do not show that unrelated tools stayed unapproved.
- That the packaged application is updated. A source edit does not change an
  already-running packaged build.

## Files

| File | Role |
| --- | --- |
| `fake-bridge-server.mjs` | Synthetic stdio MCP server exposing the three bridge tool names. Writes evidence into `AETHER_COMPAT_RUN_DIR`. |
| `prepare-run.mjs` | Creates a **fresh** run directory, resolves the client the way production does, and writes `mcp.json` + `session.json`. Refuses to reuse a directory. |
| `run-probe.ps1` | The one model-bearing step. Launches an interactive session with production's argument shape. |
| `audit.mjs` | Read-only auditor. Per-property verdicts; missing/truncated/mismatched evidence is a failure, never a skip. |
| `verify-auditor.mjs` | Negative control: damages a copy of a known-good run nine ways and asserts the auditor fails on the right property each time. |
| `check-server.mjs` | Protocol smoke test for the synthetic server. No model session. |

Run directories are created **outside the repository** (under
`%LOCALAPPDATA%\aether-communication-compat\runs\<timestamp>` by default). They
contain a real session id, a client debug log and machine-specific paths; none
of that should be committed.

## Usage

Everything except step 3 is free and starts no model session.

```bash
# 1. Does the synthetic server still speak MCP?
node scripts/communication-compat/check-server.mjs

# 2. Does the auditor still detect tampering? (point at any known-good run)
node scripts/communication-compat/verify-auditor.mjs --reference <known-good-run-dir>

# 3. Prepare a fresh run for the target version
node scripts/communication-compat/prepare-run.mjs --expect-version 2.1.274
```

```powershell
# 4. Dry run: print the exact launch shape, start nothing
powershell -NoProfile -File scripts/communication-compat/run-probe.ps1 -RunDir <run> -WhatIfSyntaxOnly

# 5. THE MODEL-BEARING STEP. Spends real subscription usage.
#    Needs explicit operator approval every time.
powershell -NoProfile -File scripts/communication-compat/run-probe.ps1 -RunDir <run>
```

```bash
# 6. Audit. Read-only unless --out is given, and --out refuses to overwrite.
node scripts/communication-compat/audit.mjs --run <run> [--out report.json]
```

Only after step 6 reports `"verdict": "Passed"` with every property passing
should `BRIDGE_CLAUDE_VERSION` change — together with the fixture version in
`e2e/fixtures/connected-client.cs`, which `launchConfig.test.ts` holds aligned.

## Deliberate differences from the 2.1.270 probe

- **Production argument shape.** The old runner passed one comma-joined
  `--allowedTools` value and forced `--permission-mode manual`. Production passes
  three separate allowlist arguments and sets no mode, so the old probe validated
  a launch shape production never uses. This runner defaults to production's
  shape; `-PermissionMode` can reproduce the old one on purpose, and whatever is
  requested is recorded for the auditor to report alongside the effective mode.
- **No hard-coded roster count.** The old auditor asserted the literal string
  `0/386 deferred tools included`. That is a property of one machine's plugin set
  on one day, not an invariant. The loading lines are now recorded as evidence
  while the assertion checks what actually matters: the bridge tools were called
  directly, with no tool-search call and nothing else invoked.
- **Read-only by default.** The old auditor wrote its report into a shared
  `outputs/` path, so merely inspecting old evidence would have overwritten it.
- **Fresh directory per run**, never appended to an existing one.
- **Timing is server-measured.** The synthetic payload carries a nominal
  elapsed value; the auditor ignores it and uses the server's own measurement.

## Status

The harness is recovered, generalized and self-verified. The **2.1.274
behavioural probe has not been run** — `BRIDGE_CLAUDE_VERSION` is unchanged at
`2.1.270`, and the bridge correctly refuses to launch against the installed
2.1.274 client until a passing probe says otherwise.
