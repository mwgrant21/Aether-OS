# Task 9A: Claude 2.1.270 compatibility re-probe

One explicitly approved Claude Max subscription session ran in a real interactive terminal, using the existing trusted U0 scratch folder. Exactly three model-issued tool calls reached the fake server: ask, get, cancel. No real Codex consultation was performed. Session: `3c5ee786-8ec6-448f-9993-beb9c3264e2b`.

| Compatibility check | Verdict |
| --- | --- |
| Tools presented with existing roster | **Passed**: client logged `0/386 deferred tools included`; all three bridge tools called directly, with no ToolSearch or other model tool calls. No strict MCP config or trimmed tool roster was used. |
| Exact preapproval in interactive terminal | **Passed for this run**: requested `--permission-mode manual`, actual terminal displayed manual mode, and exactly three bridge names were preapproved. Permission decisions were 2, 1 and 1 ms with no tool prompts. Transcript records the internal mode as `default`; the audit preserves that separately rather than assuming alias semantics. |
| Quiet 60-second inline get | **Passed**: server measured **60,061.2886 ms**, client dispatch **60,066 ms**, no abort, no intervening model response or background handle. Child background threshold was 120000 and MCP timeout 90000. |
| Escaping-heavy result and receipts | **Passed**: all **32,724 serialized UTF-8 bytes** fit the envelope; client text exactly matched the server's 19,951 UTF-16 code units. All three fresh UUIDs and `U0-CLEANUP-OK` appeared in the final answer. |

The final transcript was audited again after exiting the client. The fake server logged stdin closure; process checks found neither its PID 50952 nor the matching Claude session alive. The launch command exited 0. This is fake-server/client cleanup, not production Codex process-tree cleanup.

## Qualifications

- **Failed — receipt-only formatting:** Claude added headings and explanatory prose despite the request for receipts only. This does not invalidate the four transport/permission checks and is not evidence that the cross-check skill follows every instruction.
- Its claim of “exactly 60000 ms” is not the measured duration. The fake payload contains a nominal elapsed_ms of 60000; timing above comes from server/client logs.
- Existing hooks reported startup/prompt errors; the session-end hook reported cancellation on exit. They did not prevent this exchange. Three model-issued tool calls does not mean no automatic hook activity occurred. No unrelated hook/config fixes were attempted.
- This was a small tool-call budget, not a small context budget. Reported usage summed over unique response IDs: 8 input tokens, 112,323 cache-creation input tokens, 296,210 cache-read input tokens, 481 output tokens. No dollar estimate is inferred.
- The probe did not invoke `/aether-cross-check` or the production Aether bridge/provider. Actual skill discovery/invocation, real prompt recognition, and live consultation/retrieval/cleanup remain **Incomplete**.

## Evidence and follow-through

Machine-readable audit: `task9-version-probe-evidence.json`. Reproducible offline auditor, session receipt, fake server, events, and private client debug log are in `work/u0/task9-2.1.270/`. Independent review reran the offline audit and checked the narrow version-pin change; no blocking source finding remained.

Aether's exact pin is updated from 2.1.269 to the now-probed 2.1.270, retaining mismatch rejection and all policy/permission checks. Focused launch tests: **27 passed, 1 skipped**. Parent then explicitly ran the previously skipped installed-client preflight: **1 passed, 27 filtered out**, checking the actual executable/version and local policy without a model call. This is preflight evidence, not a production connected session.

**Passed:** Electron typecheck, renderer build, and Electron build. The first renderer build **Failed** on Task 8's `requests.at(-1)` because the configured TypeScript library lacks Array.at. Replacing that one test expression with equivalent indexed access fixed compilation; no compiler setting or application behavior changed. Final builds passed. Task 8's earlier builds preceded the addition of that test, so they did not catch this compile gap.

No additional model probe, trust decision, production session, real consultation, push, or merge is authorized by the completed three-call probe. Subsequent Task 9 steps retain their defined boundaries.
