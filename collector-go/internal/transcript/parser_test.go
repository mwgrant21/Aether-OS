package transcript

import (
	"testing"
	"time"
)

func strp(s string) *string { return &s }

func TestParseTranscriptLine_AssistantWithUsage(t *testing.T) {
	line := `{"type":"assistant","sessionId":"sess-1","timestamp":"2026-07-08T09:00:00Z","cwd":"/proj","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":10,"cache_read_input_tokens":20},"content":[]}}`
	result := ParseTranscriptLine(line)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.Kind != "assistant" {
		t.Errorf("kind = %q, want assistant", result.Kind)
	}
	if result.SessionID == nil || *result.SessionID != "sess-1" {
		t.Errorf("sessionId = %v, want sess-1", result.SessionID)
	}
	wantTime, _ := time.Parse(time.RFC3339, "2026-07-08T09:00:00Z")
	if result.Timestamp == nil || !result.Timestamp.Equal(wantTime) {
		t.Errorf("timestamp = %v, want %v", result.Timestamp, wantTime)
	}
	if result.Cwd == nil || *result.Cwd != "/proj" {
		t.Errorf("cwd = %v, want /proj", result.Cwd)
	}
	if result.Model == nil || *result.Model != "claude-sonnet-4-6" {
		t.Errorf("model = %v, want claude-sonnet-4-6", result.Model)
	}
	if result.Usage == nil {
		t.Fatal("expected non-nil usage")
	}
	if result.Usage.InputTokens != 100 || result.Usage.OutputTokens != 50 ||
		result.Usage.CacheCreationInputTokens != 10 || result.Usage.CacheReadInputTokens != 20 {
		t.Errorf("usage = %+v, want {100 50 10 20}", result.Usage)
	}
	if len(result.ToolUses) != 0 || len(result.ToolResults) != 0 {
		t.Errorf("expected empty toolUses/toolResults")
	}
	if result.HumanText != nil {
		t.Errorf("humanText = %v, want nil", result.HumanText)
	}
	if result.OriginKind != nil {
		t.Errorf("originKind = %v, want nil", result.OriginKind)
	}
}

func TestParseTranscriptLine_AssistantMissingUsage(t *testing.T) {
	line := `{"type":"assistant","sessionId":"s1","message":{"model":"x","content":[]}}`
	result := ParseTranscriptLine(line)
	if result == nil || result.Usage != nil {
		t.Errorf("usage = %v, want nil", result.Usage)
	}
}

func TestParseTranscriptLine_UserLine(t *testing.T) {
	line := `{"type":"user","sessionId":"s1","message":{"content":"hello"}}`
	result := ParseTranscriptLine(line)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.Kind != "user" {
		t.Errorf("kind = %q, want user", result.Kind)
	}
	if result.SessionID == nil || *result.SessionID != "s1" {
		t.Errorf("sessionId = %v, want s1", result.SessionID)
	}
	if result.Timestamp != nil || result.Cwd != nil || result.Model != nil || result.Usage != nil {
		t.Errorf("expected nil timestamp/cwd/model/usage on user line, got %+v", result)
	}
	if len(result.ToolUses) != 0 || len(result.ToolResults) != 0 {
		t.Errorf("expected empty toolUses/toolResults")
	}
	if result.HumanText == nil || *result.HumanText != "hello" {
		t.Errorf("humanText = %v, want hello", result.HumanText)
	}
	if result.OriginKind != nil {
		t.Errorf("originKind = %v, want nil", result.OriginKind)
	}
}

func TestParseTranscriptLine_HumanTextFromTextContentItem(t *testing.T) {
	line := `{"type":"user","sessionId":"s1","origin":{"kind":"task-notification"},"message":{"content":[{"type":"text","text":"<tool-use-id>tu_1</tool-use-id>"}]}}`
	result := ParseTranscriptLine(line)
	if result == nil || result.HumanText == nil || *result.HumanText != "<tool-use-id>tu_1</tool-use-id>" {
		t.Errorf("humanText = %v, want <tool-use-id>tu_1</tool-use-id>", result.HumanText)
	}
}

func TestParseTranscriptLine_HumanTextNilWhenNoTextItem(t *testing.T) {
	line := `{"type":"user","sessionId":"s1","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"ok"}]}}`
	result := ParseTranscriptLine(line)
	if result == nil || result.HumanText != nil {
		t.Errorf("humanText = %v, want nil", result.HumanText)
	}
}

func TestParseTranscriptLine_HumanTextNilOnAssistantAndOther(t *testing.T) {
	assistant := `{"type":"assistant","message":{"model":"x","content":[{"type":"text","text":"not a human prompt"}]}}`
	if r := ParseTranscriptLine(assistant); r == nil || r.HumanText != nil {
		t.Errorf("assistant humanText = %v, want nil", r.HumanText)
	}
	other := `{"type":"summary"}`
	if r := ParseTranscriptLine(other); r == nil || r.HumanText != nil {
		t.Errorf("other humanText = %v, want nil", r.HumanText)
	}
}

func TestParseTranscriptLine_UnrecognizedTypeIsOther(t *testing.T) {
	line := `{"type":"summary","sessionId":"s1"}`
	result := ParseTranscriptLine(line)
	if result == nil || result.Kind != "other" {
		t.Errorf("kind = %v, want other", result)
	}
}

func TestParseTranscriptLine_EmptyOrWhitespace(t *testing.T) {
	if ParseTranscriptLine("") != nil {
		t.Error("expected nil for empty line")
	}
	if ParseTranscriptLine("   \n") != nil {
		t.Error("expected nil for whitespace-only line")
	}
}

func TestParseTranscriptLine_MalformedJSON(t *testing.T) {
	if ParseTranscriptLine("not json{{") != nil {
		t.Error("expected nil for malformed JSON, must never panic")
	}
}

func TestParseTranscriptLine_DefaultsMissingFieldsToNil(t *testing.T) {
	line := `{"type":"assistant","message":{"content":[]}}`
	result := ParseTranscriptLine(line)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.SessionID != nil || result.Cwd != nil || result.Timestamp != nil {
		t.Errorf("expected nil sessionId/cwd/timestamp, got %+v", result)
	}
}

func TestParseTranscriptLine_SnakeCaseSessionIDFallback(t *testing.T) {
	line := `{"type":"user","session_id":"s2","message":{"content":""}}`
	result := ParseTranscriptLine(line)
	if result == nil || result.SessionID == nil || *result.SessionID != "s2" {
		t.Errorf("sessionId = %v, want s2", result.SessionID)
	}
}

func TestParseTranscriptLine_NullArrayPrimitiveJSON(t *testing.T) {
	if ParseTranscriptLine("null") != nil {
		t.Error("expected nil for JSON null")
	}
	if ParseTranscriptLine("[]") != nil {
		t.Error("expected nil for bare array")
	}
	if ParseTranscriptLine("123") != nil {
		t.Error("expected nil for bare primitive")
	}
}

func TestParseTranscriptLine_ExtractsToolUsesFromAssistant(t *testing.T) {
	line := `{"type":"assistant","timestamp":"2026-07-28T00:00:00.000Z","message":{"model":"claude-sonnet-5","content":[{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"/abs/path/foo.ts"}},{"type":"text","text":"reading"}]}}`
	result := ParseTranscriptLine(line)
	if result == nil || len(result.ToolUses) != 1 {
		t.Fatalf("toolUses = %v, want 1 item", result)
	}
	tu := result.ToolUses[0]
	if tu.ID != "tu_1" || tu.Name != "Read" {
		t.Errorf("toolUse = %+v, want id=tu_1 name=Read", tu)
	}
	inputMap, ok := tu.Input.(map[string]interface{})
	if !ok || inputMap["file_path"] != "/abs/path/foo.ts" {
		t.Errorf("toolUse.Input = %v, want file_path=/abs/path/foo.ts", tu.Input)
	}
}

func TestParseTranscriptLine_ExtractsToolResultsFromUser(t *testing.T) {
	line := `{"type":"user","timestamp":"2026-07-28T00:00:01.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"file contents here"}]}}`
	result := ParseTranscriptLine(line)
	if result == nil || len(result.ToolResults) != 1 {
		t.Fatalf("toolResults = %v, want 1 item", result)
	}
	tr := result.ToolResults[0]
	if tr.ToolUseID != "tu_1" {
		t.Errorf("toolUseId = %q, want tu_1", tr.ToolUseID)
	}
	// resultLength mirrors JSON.stringify(item.content ?? '').length -- for a
	// bare string "file contents here" (18 chars) that's the quoted length: 20,
	// matching transcriptParser.test.ts's expectation exactly.
	if tr.ResultLength != 20 {
		t.Errorf("resultLength = %d, want 20", tr.ResultLength)
	}
}

// TestParseTranscriptLine_ResultLengthNoHTMLEscaping locks in that
// stringifiedLength mirrors JSON.stringify's length exactly for strings
// containing '<', '>', or '&', rather than Go's encoding/json default of
// HTML-escaping those characters (e.g. '>' becomes the 6-byte \u003e).
// JSON.stringify("a > b") is 7 bytes (the 2 quotes plus the 5 literal
// characters); a naive json.Marshal("a > b") HTML-escapes the '>' and
// produces 12.
func TestParseTranscriptLine_ResultLengthNoHTMLEscaping(t *testing.T) {
	line := `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","content":"a > b"}]}}`
	result := ParseTranscriptLine(line)
	if result == nil || len(result.ToolResults) != 1 {
		t.Fatalf("toolResults = %v, want 1 item", result)
	}
	tr := result.ToolResults[0]
	if tr.ResultLength != 7 {
		t.Errorf("resultLength = %d, want 7 (JSON.stringify(\"a > b\").length, unescaped)", tr.ResultLength)
	}
}

func TestParseTranscriptLine_EmptyArraysForNoToolActivity(t *testing.T) {
	line := `{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}`
	result := ParseTranscriptLine(line)
	if result == nil || len(result.ToolUses) != 0 || len(result.ToolResults) != 0 {
		t.Errorf("expected empty toolUses/toolResults, got %+v", result)
	}
}

// This is the single most important test case in this file: it proves the
// CORRECTED dispatch-completion signal shape (see PROGRESS.md's Stage 5
// entry). Dispatch completion is a 'user'-kind event with
// originKind == "task-notification" -- NOT an assistant event's usage field,
// which was the original, wrong assumption that shipped and was later
// caught and fixed. This test locks in the corrected mechanism.
func TestParseTranscriptLine_OriginKindOnUserLine_DispatchCompletionSignal(t *testing.T) {
	line := `{"type":"user","origin":{"kind":"task-notification"},"message":{"content":"done"}}`
	result := ParseTranscriptLine(line)
	if result == nil || result.Kind != "user" {
		t.Fatalf("expected kind=user, got %+v", result)
	}
	if result.OriginKind == nil || *result.OriginKind != "task-notification" {
		t.Errorf("originKind = %v, want task-notification", result.OriginKind)
	}
}

func TestParseTranscriptLine_OriginKindOnAssistantLine(t *testing.T) {
	line := `{"type":"assistant","origin":{"kind":"task-notification"},"message":{"model":"claude-sonnet-5","usage":{"input_tokens":1,"output_tokens":1},"content":[]}}`
	result := ParseTranscriptLine(line)
	if result == nil || result.OriginKind == nil || *result.OriginKind != "task-notification" {
		t.Errorf("originKind = %v, want task-notification", result.OriginKind)
	}
}

func TestParseTranscriptLine_OriginKindDefaultsToNil(t *testing.T) {
	line := `{"type":"assistant","message":{"content":[]}}`
	result := ParseTranscriptLine(line)
	if result == nil || result.OriginKind != nil {
		t.Errorf("originKind = %v, want nil", result.OriginKind)
	}
}
