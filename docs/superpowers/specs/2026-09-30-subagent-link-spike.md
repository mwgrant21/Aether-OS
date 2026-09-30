# Spike: subagent transcript link for real severity

## Question

Can an Agent dispatch in a parent transcript be linked to its subagent transcript, with per-dispatch tool errors countable (spec section 8)?

## Method

Script `aether-spike.mjs` (from task-1-brief, unchanged; kept in scratch, not committed) walks `~/.claude/projects/*/<session>/subagents/agent-<id>.jsonl` plus `.meta.json`, restricted to files modified in the last 30 days. Run 2026-09-30 on machine `work-it`. Counts only; no transcript content recorded. The status follow-up used a node one-off over `<task-notification>` blocks (instead of a cross-line grep).

## Counts

```json
{
  "subFiles": 625,
  "recent": 212,
  "withMeta": 211,
  "metaHasToolUseId": 211,
  "toolUseIdIsParentAgentCall": 199,
  "parentAgentIdAgrees": 199,
  "filesWithIsError": 77,
  "isErrorResults": 191,
  "sidechainLines": 26274
}
```

## Link

Link is `<session>/subagents/agent-<agentId>.meta.json` string `toolUseId` == parent Agent `tool_use.id`.

- withMeta / recent = 211 / 212 = 99.5%
- toolUseIdIsParentAgentCall / metaHasToolUseId = 199 / 211 = 94.3%
- parentAgentIdAgrees (parent tool_result carries the same agentId) = 199 / 211 = 94.3%

The same 199 match on both checks. The 12 misses (5.7%) are unexplained by this spike; likely the parent transcript is absent or does not hold the Agent call in the `"id":..."name":"Agent"` shape the regex expects (for example the tool_use key order, or the dispatch was made from a different session file). Not investigated further within the time box.

## Tool errors

`is_error: true` tool_results DO appear in subagent files: 191 results across 77 of 212 recent files (36%). They sit inside each subagent's own jsonl, which is keyed to one dispatch by agentId, so they can be counted per dispatch.

## Status values

Task-notification `<status>` counts (all parent transcripts): completed 2102, failed 105, killed 22. The literal `<status>running</status>` occurs 6 times in 4 files, but in none of them inside a `<task-notification>` block (0 notification ids carry `running`), so there is no running-then-final sequence to reconcile. Follow-up result: 0 running notifications, 0 superseded.

## Decision: NO-GO

Rule: withMeta/recent >= 95% (99.5%, pass) AND toolUseIdIsParentAgentCall/metaHasToolUseId >= 95% (94.3%, FAIL by 0.7 points) AND isErrorResults > 0 (191, pass).

Strictly applied, the second threshold fails, so the rule gives NO-GO. Recommended: **NO-GO as written by the rule, with a cheap path to GO**: the 12 misses are probably a regex artifact (key order in the tool_use JSON), not a real link failure. The orchestrator should either (a) accept a parse-based match for Task 8 (JSON-parse parent lines, look for tool_use with name Agent and id == toolUseId) and re-run to confirm >= 95%, or (b) rule GO on the 94.3% figure. The link field for Task 8 is confirmed as meta.json `toolUseId` (string present in 211/211 metas).

## Side finding

The CLAUDE.md "0 isSidechain lines" gotcha is wrong: 26274 `"isSidechain":true` lines in recent subagent files. Task 11 corrects it.
