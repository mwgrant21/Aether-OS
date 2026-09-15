# Cross-check Task 6A — transient intent and request formatter

**Passed.** Implemented against `b76629c`. The new shared helper validates exact question/context values using the bridge policy, derives the full lowercase SHA-256 request key from UTF-8 `JSON.stringify([question, context ?? ''])`, and formats a self-contained request restricted to Aether's three bridge tools.

Identical content, retries, omitted/empty context, and edit-undo retain content identity. Each edit or discard advances a separate revision; stale hash success and failure return stale rather than publishing against a newer draft. JSON escaping preserves multiline text, quotes, delimiter-like text, and Unicode as data. Errors contain no payload. Formatting is not a guarantee of model compliance.

## Verification

- **Passed:** implementer focused suite, 8/8 tests, including the production Web Crypto path against a fixed reference hash, byte-limit boundaries, exact JSON round-trip, identity changes, stale async completion, and error handling.
- **Passed:** parent helper plus shared bridge lifecycle tests, 43/43 in two files. Log: chat `work/task6a-parent-tests.txt`.
- **Passed:** implementer `npm run build`, including TypeScript. Existing Vite externalization/chunk warnings remain.
- **Passed:** independent spec and quality review; no blocking findings.

One non-blocking review observation is retained for Task 8 and the Task 6 completion assessment: tests assert only selected instruction text. The complete binding no-fallback, ask-once, partial-retrieval, and non-authorization policies are present in source, but should receive comprehensive instruction-fragment assertions to protect future prose edits. This is missing regression coverage, not a current formatter defect.

## Handoff to 6B

Files: `src/shared/crossCheckIntent.ts` and its test. `CrossCheckIntentOwner` exposes `revise`, `discard`, `snapshot`, and asynchronous `prepare`, returning ready/stale/error. Keep one owner in a dedicated transient React owner outside global state and persistence. Use `prepare()` as the validated path; the low-level exported formatter assumes validated input.

Task 6B still owns target refresh, current revision checks at clipboard completion, copy serialization, close/replacement races, and terminal focus. No UI, App wiring, clipboard, IPC, client launch, model call, logging, or persistence was added. This helper is not yet exposed in the application.

**Incomplete:** composer UI (6B), native paste/clipboard verification (6C), fresh installed-Claude compatibility, and remaining U9 live gates. No such gate is closed by helper tests. No push or merge.
