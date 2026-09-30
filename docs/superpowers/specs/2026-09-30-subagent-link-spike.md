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

## Round 2: JSON-parse match

Script: node one-off, JSON.parse of every parent line, collect tool_use blocks named Agent or Task by id (any key order), match each recent meta toolUseId. Shapes and counts only.

- Parse-based match against the parent transcript: 199 / 211 = 94.3%. Identical to the regex result, so the 12 misses were NOT a regex artifact.
- Miss classes (12): 8 parent transcript missing (all spawnDepth 1; session jsonl rotated or deleted, subagents dir remains); 4 id absent from the parent transcript, all spawnDepth 2 (nested dispatch: the Agent tool_use lives in a sibling subagent jsonl of the same session, and the id was found there for 4 / 4, by substring match on the id key, name not parsed). No id-under-other-tool-name, no tool_result-only cases.
- With nested dispatches resolved by also scanning sibling subagent files: 203 / 211 = 96.2%. Among sessions whose parent transcript exists: 203 / 203 = 100%.

## Decision: GO

Unchanged rule: withMeta/recent 99.5% (pass), link rate 96.2% with the nested-scan (pass, >= 95%), isErrorResults 191 (pass). Without the nested scan the rate is 94.3% and fails, so the GO depends on the nested scan. The link is still meta.json toolUseId == Agent tool_use.id. Task 8 delta: the tool_use lookup must cover the parent transcript AND the session sibling subagent jsonls (spawnDepth >= 2), and a dispatch whose parent transcript is missing (8 / 211 = 3.8%) stays unlinked and must degrade gracefully.

## Side finding

The CLAUDE.md "0 isSidechain lines" gotcha is wrong. Fact for Task 11: 26274 lines containing the string "isSidechain":true across the 212 subagent files modified in the last 30 days (work-it, 2026-09-30).
