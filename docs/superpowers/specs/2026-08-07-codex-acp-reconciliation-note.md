# Codex ACP Verification — Reconciliation Note

Written per spec §15 Task 0, before any implementation code.

## 1. Dispatch-to-file correlation

No exact link exists today. `tool_calls` (`collector/src/schema.ts`) has no
`dispatch_id`/`session_id` column, and `tool_calls.tool_use_id` names the
Edit/Write/Read call itself, not the enclosing Task dispatch.

**Root cause, not previously documented:** `scanTranscriptsOnce`
(`collector/src/transcriptScan.ts`) lists only top-level `<sessionId>.jsonl`
files per project directory (`readdirSync(dirPath).filter(f =>
f.endsWith('.jsonl'))`, non-recursive). A dispatch's own tool calls live in a
*separate* file, `<sessionDir>/<sessionId>/subagents/agent-<agentId>.jsonl`
(confirmed in `electron/transcriptReader.ts`'s own on-disk-layout comment,
verified against real transcripts for Stage 14). The collector has never
scanned these files, so today's `tool_calls` rows can only ever be top-level-
session tool calls, never a subagent dispatch's own edits.

**Decision:** two changes, not the `dispatch_tool_use_id`-at-ingest-time
approach the spec sketched:

1. `transcriptScan.ts` must also scan each pinned session's
   `<sessionId>/subagents/*.jsonl` files (extending the existing per-file loop
   to a second pass per session directory, reusing `readNewLinesSync`/
   `getLastOffset`/`recordOffset` unchanged — they're already keyed by
   relative file path, which works identically for a nested path).
2. Schema v6 adds `tool_calls.source_file_rel TEXT` — the relative path of the
   file a tool call was parsed from (already known in `transcriptScan.ts` as
   `relativePath`, just not threaded through `ingestToolCallsAndAnomalies` →
   `insertToolCall` today).

At verification time, `dispatchEvidence.ts` maps a dispatch's `tool_use_id` to
its subagent file exactly the way `transcriptReader.ts`'s
`listTranscriptSources` already does (read the pinned session's
`subagents/*.meta.json` files, match `toolUseId`, get the `.jsonl` basename),
then filters `tool_calls` rows by `source_file_rel` equal to that file's
relative path. This reuses existing, tested path-resolution logic instead of
inventing new ingest-time correlation, and it generalizes correctly: a tool
call whose `source_file_rel` is the top-level session file is (correctly)
never attributable to any dispatch.

## 2. On-demand claim extraction

Confirmed reusable: `electron/transcriptReader.ts`'s `resolveSourcePath` +
`readTranscript` already resolve and read a dispatch's own transcript file
from a `dispatch:<parentSessionId>:<agentFileBase>` source id, and
`toDisplayMessage` already extracts assistant text from a parsed line. No
existing function returns "just the final assistant message", so
`dispatchEvidence.ts` adds a small caller-side loop: read the dispatch's
transcript from the tail, paging backward via `nextBefore` until a
`role: 'assistant'` message with non-null text is found. Never written to
SQLite, matching `transcriptReader.ts`'s own no-persistent-cache header.

## 3. Project-root resolution

No `cwd` column exists in any collector table. `resolveProject`
(`src/shared/projectIdentity.ts`) and `buildProjectsSnapshot`
(`src/shared/projectsSnapshot.ts`) operate on live parsed transcript events,
which do carry `cwd` per line. `dispatchEvidence.ts` resolves a single
dispatch's project root by reading its own transcript file (same file
resolved for claim extraction above), taking `cwd` off any one parsed event
line in it, and feeding that into the existing, unmodified `resolveProject`.

## Conclusion

None of the three requires storing a raw payload. All three resolve through
either a single new narrow column (`source_file_rel`) or reuse of existing,
already-tested resolution code. Proceeding to Task 1.
