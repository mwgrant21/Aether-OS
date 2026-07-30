// Package transcript is the Go port of collector/src/transcriptParser.ts and
// transcriptTailer.ts: parsing a single Claude Code transcript JSONL line
// into a typed event, and byte-offset-aware incremental file reading.
//
// Dispatch-completion detection is the most behaviorally subtle part of this
// package -- see PROGRESS.md's Stage 5 entry ("mid-plan course correction").
// An earlier version of this project assumed dispatch completion was
// signaled by an assistant event's usage field; that was wrong. The real
// mechanism, preserved exactly here, is a 'user'-kind event whose
// OriginKind is "task-notification", carrying XML-tagged completion data in
// HumanText, with dispatch opens tracked under tool name "Agent" (not
// "Task"). This package only parses the event shape -- callers (Task 4's
// scan orchestration) are responsible for interpreting OriginKind/HumanText
// to detect completions and for tracking "Agent" tool-use opens.
package transcript

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"
)

// Usage mirrors transcriptParser.ts's TranscriptUsage.
type Usage struct {
	InputTokens              int
	OutputTokens             int
	CacheCreationInputTokens int
	CacheReadInputTokens     int
}

// ToolUse mirrors transcriptParser.ts's TranscriptToolUse.
type ToolUse struct {
	ID    string
	Name  string
	Input interface{}
}

// ToolResult mirrors transcriptParser.ts's TranscriptToolResult.
type ToolResult struct {
	ToolUseID    string
	ResultLength int
}

// Event mirrors transcriptParser.ts's TranscriptEvent. Kind is one of
// "assistant", "user", "other".
type Event struct {
	Kind        string
	SessionID   *string
	Timestamp   *time.Time
	Cwd         *string
	Model       *string
	Usage       *Usage
	ToolUses    []ToolUse
	ToolResults []ToolResult
	// HumanText is plain text content of a 'user'-kind message, populated
	// ONLY on the 'user' branch, mirroring transcriptParser.ts. Dispatch
	// completions arrive as user-kind 'task-notification' events whose text
	// carries the <tool-use-id>/<subagent_tokens>/<tool_uses>/<duration_ms>
	// tags Claude Code itself computes. The text itself is transient and
	// MUST NEVER be persisted (docs/privacy-and-data.md).
	HumanText *string
	// OriginKind is json.origin.kind, e.g. "task-notification". Read on
	// every branch (matching transcriptParser.ts); only the 'user' branch's
	// value is load-bearing -- it marks dispatch completions.
	OriginKind *string
}

// ParseTranscriptLine parses one raw JSONL line into an Event. Returns nil
// (never an error/panic) for a blank line, malformed JSON, or JSON that
// doesn't parse to a plain object (null, array, primitive) -- matching
// transcriptParser.ts's parseTranscriptLine exactly.
func ParseTranscriptLine(rawLine string) *Event {
	trimmed := strings.TrimSpace(rawLine)
	if trimmed == "" {
		return nil
	}

	var raw interface{}
	if err := json.Unmarshal([]byte(trimmed), &raw); err != nil {
		return nil
	}

	obj, ok := raw.(map[string]interface{})
	if !ok {
		return nil
	}

	sessionID := stringField(obj, "sessionId")
	if sessionID == nil {
		sessionID = stringField(obj, "session_id")
	}
	timestamp := parseTimestamp(obj["timestamp"])
	cwd := stringField(obj, "cwd")
	originKind := originKindOf(obj)

	typ, _ := obj["type"].(string)
	message, hasMessage := obj["message"].(map[string]interface{})

	if typ == "assistant" && hasMessage {
		usage := parseUsage(message["usage"])
		content := asArray(message["content"])
		toolUses := extractToolUses(content)
		return &Event{
			Kind:        "assistant",
			SessionID:   sessionID,
			Timestamp:   timestamp,
			Cwd:         cwd,
			Model:       stringField(message, "model"),
			Usage:       usage,
			ToolUses:    toolUses,
			ToolResults: []ToolResult{},
			HumanText:   nil,
			OriginKind:  originKind,
		}
	}

	if typ == "user" && hasMessage {
		content := normalizeUserContent(message["content"])
		toolResults := extractToolResults(content)
		humanText := findHumanText(content)
		return &Event{
			Kind:        "user",
			SessionID:   sessionID,
			Timestamp:   timestamp,
			Cwd:         cwd,
			Model:       nil,
			Usage:       nil,
			ToolUses:    []ToolUse{},
			ToolResults: toolResults,
			HumanText:   humanText,
			OriginKind:  originKind,
		}
	}

	return &Event{
		Kind:        "other",
		SessionID:   sessionID,
		Timestamp:   timestamp,
		Cwd:         cwd,
		Model:       nil,
		Usage:       nil,
		ToolUses:    []ToolUse{},
		ToolResults: []ToolResult{},
		HumanText:   nil,
		OriginKind:  originKind,
	}
}

func stringField(obj map[string]interface{}, key string) *string {
	if v, ok := obj[key].(string); ok && v != "" {
		return &v
	}
	return nil
}

func parseTimestamp(v interface{}) *time.Time {
	s, ok := v.(string)
	if !ok || s == "" {
		return nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		// Fall back to RFC3339Nano to accept fractional seconds, mirroring
		// JavaScript's permissive `new Date(string)` parsing.
		t, err = time.Parse(time.RFC3339Nano, s)
		if err != nil {
			return nil
		}
	}
	return &t
}

func originKindOf(obj map[string]interface{}) *string {
	origin, ok := obj["origin"].(map[string]interface{})
	if !ok {
		return nil
	}
	return stringField(origin, "kind")
}

func parseUsage(v interface{}) *Usage {
	m, ok := v.(map[string]interface{})
	if !ok {
		return nil
	}
	return &Usage{
		InputTokens:              intField(m, "input_tokens"),
		OutputTokens:             intField(m, "output_tokens"),
		CacheCreationInputTokens: intField(m, "cache_creation_input_tokens"),
		CacheReadInputTokens:     intField(m, "cache_read_input_tokens"),
	}
}

func intField(m map[string]interface{}, key string) int {
	if n, ok := m[key].(float64); ok {
		return int(n)
	}
	return 0
}

func asArray(v interface{}) []interface{} {
	if arr, ok := v.([]interface{}); ok {
		return arr
	}
	return nil
}

// normalizeUserContent mirrors transcriptParser.ts: a bare string
// message.content is treated as a single text item so humanText is derived
// consistently regardless of which shape the transcript line uses.
func normalizeUserContent(v interface{}) []interface{} {
	if arr, ok := v.([]interface{}); ok {
		return arr
	}
	if s, ok := v.(string); ok {
		return []interface{}{map[string]interface{}{"type": "text", "text": s}}
	}
	return nil
}

func extractToolUses(content []interface{}) []ToolUse {
	toolUses := []ToolUse{}
	for _, item := range content {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		if t, _ := m["type"].(string); t != "tool_use" {
			continue
		}
		id, _ := m["id"].(string)
		name, _ := m["name"].(string)
		toolUses = append(toolUses, ToolUse{ID: id, Name: name, Input: m["input"]})
	}
	return toolUses
}

func extractToolResults(content []interface{}) []ToolResult {
	toolResults := []ToolResult{}
	for _, item := range content {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		if t, _ := m["type"].(string); t != "tool_result" {
			continue
		}
		toolUseID, _ := m["tool_use_id"].(string)
		toolResults = append(toolResults, ToolResult{
			ToolUseID:    toolUseID,
			ResultLength: stringifiedLength(m["content"]),
		})
	}
	return toolResults
}

// stringifiedLength mirrors JSON.stringify(item.content ?? '').length. It
// must not use json.Marshal directly: Go's encoding/json HTML-escapes `<`,
// `>`, and `&` in strings by default, while JSON.stringify never does --
// e.g. JSON.stringify("a > b") is 9 bytes but json.Marshal("a > b") produces
// 13 (`>`). This mirrors the same fix hookinstall's marshalSettingsJSON
// applies for the same root cause, simplified since only a byte length is
// needed here (no indentation).
func stringifiedLength(content interface{}) int {
	if content == nil {
		content = ""
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(content); err != nil {
		return 0
	}
	// json.Encoder.Encode appends a trailing newline that json.Marshal does
	// not; trim it so the length matches JSON.stringify's output exactly.
	return len(bytes.TrimRight(buf.Bytes(), "\n"))
}

func findHumanText(content []interface{}) *string {
	for _, item := range content {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		if t, _ := m["type"].(string); t != "text" {
			continue
		}
		if text, ok := m["text"].(string); ok {
			return &text
		}
		return nil
	}
	return nil
}
