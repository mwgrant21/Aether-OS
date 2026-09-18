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
| `exact_preapproval` | Were exactly three bridge dispatches preapproved, each decided **faster than a human could answer a prompt**? |
| `quiet_inline_get` | Did a long silent tool call stay inline — server-measured, not aborted, under the MCP timeout, with no intervening model response? |
| `payload_integrity` | Did an escaping-heavy payload arrive byte-identical and within the envelope limit, with all receipt markers reported? |

### How `exact_preapproval` discriminates

The property being gated is that `--allowedTools` *still preapproves*. Simply
finding a numeric `permissionDecisionMs` does not show that: if a client stopped
honouring the flag and the operator approved three prompts by hand, every line
would still carry a number. A check asserting only "is numeric" would pass
exactly the regression it exists to catch.

The client emits no decision type or reason -- `permissionDecisionMs` is the only
field on those lines -- so latency is the sole available discriminator, and it is
used as one explicitly. Preapproved decisions on 2.1.270 measured 1-2 ms; a human
reading a prompt cannot answer inside `--preapproval-max-ms` (default 250). This
is a heuristic, named as one, and the raw per-tool values are always reported so
a reviewer can judge them directly. A non-finite or negative threshold is
refused rather than accepted: `Number('250ms')` is `NaN`, every `ms > NaN` is
false, and a typo would otherwise disable the check without saying so.

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
| `trust-workspace.mjs` | Pre-accepts the folder-trust dialog for a scratch workspace this run created, so the probe does not park on a trust screen. Backs up `~/.claude.json`, changes exactly one key, publishes via tmp+rename, verifies, and restores only if the live file is still the one it published. Keys the entry with **forward slashes**, the spelling the client uses — a backslashed key writes an entry the client never reads. |
| `verify-trust-workspace.mjs` | Twelve fixture-only controls for the above; never touches the real `~/.claude.json`. Covers the happy path, idempotency, symlink/unparseable/missing/EISDIR refusals, a pre-publish race, a post-rename race, path-spelling normalisation, and the quiescence gate. |
| `run-probe.ps1` | The one model-bearing step. Launches an interactive session with production's argument shape. |
| `audit.mjs` | Read-only auditor. Per-property verdicts; missing/truncated/mismatched evidence is a failure, never a skip. |
| `verify-auditor.mjs` | Negative control: damages a copy of a known-good run sixteen ways and asserts the auditor fails on the right property each time. Refuses a `--scratch` path that overlaps the reference run, and deletes only the unique child it created. |
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
node scripts/communication-compat/audit.mjs --run <run> [--out report.json] [--preapproval-max-ms 250]
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

**Current pin: `2.1.274`.** Raised from `2.1.270` on 2026-09-17 after this
harness probed it. Full evidence, including what the probe does *not* establish:
[`docs/superpowers/plans/2026-09-16-bridge-claude-2.1.274-probe-results.md`](../../docs/superpowers/plans/2026-09-16-bridge-claude-2.1.274-probe-results.md).

Two valid sessions backed that bump — one in `manual` mode (isolating
`--allowedTools` as the only possible approver) and one in production's argument
shape — both with tool annotations matching `BRIDGE_TOOLS`. Two earlier sessions
were invalidated by an annotation mismatch and are recorded in that document
rather than deleted.

This section states the pin because a stale status here is worse than none: an
operator reading "not yet probed" next to a pin that has already moved will
either repeat the work or mistrust the evidence. **Update it in the same commit
that changes `BRIDGE_CLAUDE_VERSION`.**
