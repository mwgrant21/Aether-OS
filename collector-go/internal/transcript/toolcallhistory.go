// This file is the Go port of collector/src/toolCallHistory.ts: an in-memory
// ring buffer of closed tool calls per transcript file, plus the sanitizing
// helper that relativizes a raw tool-input file path the moment it enters the
// history (docs/privacy-and-data.md SS5: never persist a path containing the
// home directory/username).
package transcript

import (
	"path/filepath"
	"strings"
)

// HistoryMaxEvents mirrors toolCallHistory.ts's HISTORY_MAX_EVENTS.
const HistoryMaxEvents = 500

// ClosedToolCall mirrors toolCallHistory.ts's ClosedToolCall.
type ClosedToolCall struct {
	ToolUseID string
	ToolName  string
	FilePath  *string
	StartedAt int64
	ClosedAt  int64
}

// OpenToolCall mirrors the value type of toolCallHistory.ts's
// ToolCallHistory.openByToolUseId map.
type OpenToolCall struct {
	ToolName  string
	FilePath  *string
	StartedAt int64
}

// ToolCallHistory mirrors toolCallHistory.ts's ToolCallHistory.
type ToolCallHistory struct {
	Events         []ClosedToolCall
	OpenByToolUseID map[string]OpenToolCall
}

// CreateEmptyHistory mirrors toolCallHistory.ts's createEmptyHistory.
func CreateEmptyHistory() *ToolCallHistory {
	return &ToolCallHistory{
		Events:          []ClosedToolCall{},
		OpenByToolUseID: map[string]OpenToolCall{},
	}
}

// hasTraversalSegment mirrors toolCallHistory.ts's hasTraversalSegment: a
// relative path segment of exactly '..' (on either / or \ separators)
// indicates traversal outside whatever root the path is relative to.
func hasTraversalSegment(p string) bool {
	segments := strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' })
	for _, seg := range segments {
		if seg == ".." {
			return true
		}
	}
	return false
}

// ToProjectRelative mirrors toolCallHistory.ts's toProjectRelative exactly,
// including its Windows cross-drive guard (see that file's doc comment for
// the full rationale).
func ToProjectRelative(filePath *string, projectRoot *string) *string {
	if filePath == nil {
		return nil
	}
	fp := *filePath
	if !filepath.IsAbs(fp) {
		// Already-relative input is passed through, but still
		// traversal-checked so a crafted '../../secret' can't slip past just
		// because it never went through filepath.Rel.
		if hasTraversalSegment(fp) {
			return nil
		}
		return &fp
	}
	if projectRoot == nil || *projectRoot == "" {
		return nil
	}
	rel, err := filepath.Rel(*projectRoot, fp)
	if err != nil {
		return nil
	}
	if rel == "." {
		return nil
	}
	// On win32, filepath.Rel between paths on different drives errors out
	// rather than silently returning an absolute path (unlike Node's
	// path.relative), but guard defensively anyway in case that ever changes.
	if filepath.IsAbs(rel) {
		return nil
	}
	if hasTraversalSegment(rel) {
		return nil
	}
	return &rel
}

// extractFilePath mirrors toolCallHistory.ts's extractFilePath: reads a
// string file_path field out of a tool_use's arbitrary JSON input, or nil.
func extractFilePath(input interface{}) *string {
	m, ok := input.(map[string]interface{})
	if !ok {
		return nil
	}
	fp, ok := m["file_path"].(string)
	if !ok {
		return nil
	}
	return &fp
}

// UpdateHistory mirrors toolCallHistory.ts's updateHistory: opens a tool call
// on each tool_use, closes it (moving it into Events, sanitizing its file
// path via ToProjectRelative) on the matching tool_result, and caps Events at
// HistoryMaxEvents (oldest dropped first). Returns a new ToolCallHistory;
// history is not mutated in place.
func UpdateHistory(history *ToolCallHistory, events []Event, nowMs int64) *ToolCallHistory {
	newOpen := make(map[string]OpenToolCall, len(history.OpenByToolUseID))
	for k, v := range history.OpenByToolUseID {
		newOpen[k] = v
	}
	newEvents := make([]ClosedToolCall, len(history.Events))
	copy(newEvents, history.Events)

	for _, event := range events {
		for _, toolUse := range event.ToolUses {
			filePath := ToProjectRelative(extractFilePath(toolUse.Input), event.Cwd)
			startedAt := nowMs
			if event.Timestamp != nil {
				startedAt = event.Timestamp.UnixMilli()
			}
			newOpen[toolUse.ID] = OpenToolCall{ToolName: toolUse.Name, FilePath: filePath, StartedAt: startedAt}
		}

		for _, toolResult := range event.ToolResults {
			open, ok := newOpen[toolResult.ToolUseID]
			if !ok {
				continue
			}
			closedAt := nowMs
			if event.Timestamp != nil {
				closedAt = event.Timestamp.UnixMilli()
			}
			newEvents = append(newEvents, ClosedToolCall{
				ToolUseID: toolResult.ToolUseID,
				ToolName:  open.ToolName,
				FilePath:  open.FilePath,
				StartedAt: open.StartedAt,
				ClosedAt:  closedAt,
			})
			delete(newOpen, toolResult.ToolUseID)
		}
	}

	if len(newEvents) > HistoryMaxEvents {
		newEvents = newEvents[len(newEvents)-HistoryMaxEvents:]
	}

	return &ToolCallHistory{Events: newEvents, OpenByToolUseID: newOpen}
}
