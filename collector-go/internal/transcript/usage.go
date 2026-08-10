// This file is the Go port of collector/src/usageIngest.ts: writing
// usage_events rows for assistant-turn token usage, and closing dispatch
// (Agent subagent) completions into the dispatches table.
package transcript

import (
	"database/sql"
	"regexp"
	"strconv"
)

// IngestUsageEvent mirrors usageIngest.ts's ingestUsageEvent. Returns
// (false, nil) for any event that is not an assistant event with usage and a
// timestamp -- no error, just a no-op, matching the TS boolean-return shape.
// sourceFileRel is the project-relative transcript this turn was read from
// (never absolute -- docs/privacy-and-data.md SS5). See schema.go's v8 block
// for why attribution exists: without it, "has this file already been
// counted?" is unanswerable.
func IngestUsageEvent(db *sql.DB, event *Event, sourceFileRel string) (bool, error) {
	if event.Kind != "assistant" || event.Usage == nil || event.Timestamp == nil {
		return false, nil
	}

	_, err := db.Exec(
		`INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, source_file_rel)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		event.Timestamp.UnixMilli(),
		event.Model,
		event.Usage.InputTokens,
		event.Usage.OutputTokens,
		event.Usage.CacheCreationInputTokens,
		event.Usage.CacheReadInputTokens,
		sourceFileRel,
	)
	if err != nil {
		return false, err
	}
	return true, nil
}

var (
	toolUseIDTag  = regexp.MustCompile(`<tool-use-id>(.*?)</tool-use-id>`)
	tokensTag     = regexp.MustCompile(`<subagent_tokens>(\d+)</subagent_tokens>`)
	toolUsesTag   = regexp.MustCompile(`<tool_uses>(\d+)</tool_uses>`)
	durationMsTag = regexp.MustCompile(`<duration_ms>(\d+)</duration_ms>`)
)

// IngestDispatchEvent mirrors usageIngest.ts's ingestDispatchEvent, ported
// from the already-shipped reference implementation in
// src/state/liveAgentsMath.ts (applyLinesToOpenDispatches):
//   - a dispatch OPENS on an assistant tool_use named 'Agent' (not 'Task')
//   - it CLOSES on a 'user'-kind event with OriginKind 'task-notification',
//     whose text carries <tool-use-id>/<subagent_tokens>/<tool_uses>/
//     <duration_ms> tags Claude Code computes itself.
//
// The tool-use-id is an exact correlation id, so one completion event closes
// exactly one dispatch -- never a fan-out over everything currently open --
// and the token/tool-use/duration values are real, not estimated. The
// notification text is read here and discarded; only the extracted numbers
// are persisted (never the raw text itself).
func IngestDispatchEvent(db *sql.DB, history *ToolCallHistory, event *Event) (bool, error) {
	if event.Kind != "user" || event.OriginKind == nil || *event.OriginKind != "task-notification" {
		return false, nil
	}
	content := ""
	if event.HumanText != nil {
		content = *event.HumanText
	}
	idMatch := toolUseIDTag.FindStringSubmatch(content)
	if idMatch == nil {
		return false, nil
	}
	dispatchToolUseID := idMatch[1]
	open, ok := history.OpenByToolUseID[dispatchToolUseID]
	if !ok || open.ToolName != "Agent" {
		return false, nil
	}
	if event.Timestamp == nil {
		return false, nil
	}

	tokens := 0
	if m := tokensTag.FindStringSubmatch(content); m != nil {
		tokens, _ = strconv.Atoi(m[1])
	}
	toolUses := 0
	if m := toolUsesTag.FindStringSubmatch(content); m != nil {
		toolUses, _ = strconv.Atoi(m[1])
	}
	durationMs := 0
	if m := durationMsTag.FindStringSubmatch(content); m != nil {
		durationMs, _ = strconv.Atoi(m[1])
	}
	endedAtMs := event.Timestamp.UnixMilli()

	_, err := db.Exec(
		`INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(tool_use_id) DO UPDATE SET tokens = excluded.tokens, tool_uses = excluded.tool_uses,
		   duration_ms = excluded.duration_ms, ended_at_ms = excluded.ended_at_ms`,
		dispatchToolUseID, tokens, toolUses, durationMs, open.StartedAt, endedAtMs,
	)
	if err != nil {
		return false, err
	}
	return true, nil
}
