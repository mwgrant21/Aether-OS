package spool

import (
	"encoding/json"
	"strings"
	"testing"
)

func mustJSON(t *testing.T, v interface{}) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal test payload: %v", err)
	}
	return b
}

func strPtr(s string) *string { return &s }

func TestParseHookPayload_PreToolUse_DerivesHadToolInputWithoutKeepingIt(t *testing.T) {
	raw := map[string]interface{}{
		"hook_event_name": "PreToolUse",
		"session_id":      "sess-1",
		"cwd":             `C:\Users\test\project`,
		"tool_name":       "Bash",
		"tool_input":      map[string]interface{}{"command": "rm -rf /", "foo": "bar"},
	}
	event, err := ParseHookPayload(mustJSON(t, raw))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if event.HookEventName != "PreToolUse" || event.SessionID != "sess-1" {
		t.Fatalf("unexpected event: %+v", event)
	}
	if event.CWD == nil || *event.CWD != `C:\Users\test\project` {
		t.Fatalf("unexpected cwd: %v", event.CWD)
	}
	if event.ToolName == nil || *event.ToolName != "Bash" {
		t.Fatalf("unexpected toolName: %v", event.ToolName)
	}
	if !event.HadToolInput {
		t.Fatalf("expected hadToolInput true")
	}
	if event.HadToolResponse {
		t.Fatalf("expected hadToolResponse false")
	}
	if event.NotificationType != nil {
		t.Fatalf("expected nil notificationType")
	}

	serialized, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	if strings.Contains(string(serialized), "rm -rf") {
		t.Fatalf("serialized event leaked tool_input content: %s", serialized)
	}
}

func TestParseHookPayload_PostToolUse_WithToolResponsePresent(t *testing.T) {
	raw := map[string]interface{}{
		"hook_event_name": "PostToolUse",
		"session_id":      "sess-1",
		"cwd":             nil,
		"tool_name":       "Read",
		"tool_input":      map[string]interface{}{"file_path": "/x"},
		"tool_response":   map[string]interface{}{"content": "secret file contents"},
	}
	event, err := ParseHookPayload(mustJSON(t, raw))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !event.HadToolResponse {
		t.Fatalf("expected hadToolResponse true")
	}
	serialized, _ := json.Marshal(event)
	if strings.Contains(string(serialized), "secret file contents") {
		t.Fatalf("serialized event leaked tool_response content: %s", serialized)
	}
}

func TestParseHookPayload_Notification_KeepsOnlyNotificationTypeEnum(t *testing.T) {
	raw := map[string]interface{}{
		"hook_event_name":   "Notification",
		"session_id":        "sess-2",
		"cwd":               nil,
		"notification_type": "agent_needs_input",
		"message":           "the agent is waiting on a decision only the user can make",
	}
	event, err := ParseHookPayload(mustJSON(t, raw))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if event.HookEventName != "Notification" || event.SessionID != "sess-2" {
		t.Fatalf("unexpected event: %+v", event)
	}
	if event.CWD != nil {
		t.Fatalf("expected nil cwd")
	}
	if event.ToolName != nil {
		t.Fatalf("expected nil toolName")
	}
	if event.HadToolInput || event.HadToolResponse {
		t.Fatalf("expected no tool input/response")
	}
	if event.NotificationType == nil || *event.NotificationType != "agent_needs_input" {
		t.Fatalf("unexpected notificationType: %v", event.NotificationType)
	}
	serialized, _ := json.Marshal(event)
	if strings.Contains(string(serialized), "waiting on a decision") {
		t.Fatalf("serialized event leaked message content: %s", serialized)
	}
}

func TestParseHookPayload_Stop_NoToolOrNotificationFields(t *testing.T) {
	raw := map[string]interface{}{"hook_event_name": "Stop", "session_id": "sess-3", "cwd": nil}
	event, err := ParseHookPayload(mustJSON(t, raw))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if event.HookEventName != "Stop" {
		t.Fatalf("unexpected hookEventName: %v", event.HookEventName)
	}
	if event.ToolName != nil {
		t.Fatalf("expected nil toolName")
	}
}

func TestParseHookPayload_UnrecognizedEventName(t *testing.T) {
	raw := map[string]interface{}{"hook_event_name": "SomeFutureEvent", "session_id": "sess-1"}
	if _, err := ParseHookPayload(mustJSON(t, raw)); err == nil {
		t.Fatalf("expected error for unrecognized hook_event_name")
	}
}

func TestParseHookPayload_MissingOrNonStringSessionID(t *testing.T) {
	if _, err := ParseHookPayload(mustJSON(t, map[string]interface{}{"hook_event_name": "Stop"})); err == nil {
		t.Fatalf("expected error for missing session_id")
	}
	if _, err := ParseHookPayload(mustJSON(t, map[string]interface{}{"hook_event_name": "Stop", "session_id": 42})); err == nil {
		t.Fatalf("expected error for non-string session_id")
	}
}

func TestParseHookPayload_NonObjectInputs(t *testing.T) {
	cases := [][]byte{
		[]byte("null"),
		[]byte(`"not an object"`),
		[]byte("[1,2,3]"),
	}
	for _, c := range cases {
		if _, err := ParseHookPayload(c); err == nil {
			t.Fatalf("expected error for non-object input %s", c)
		}
	}
	// Go has no direct "undefined"; an empty line is the closest analog and
	// is covered by TestParseHookPayload_EmptyLine.
}

func TestParseHookPayload_EmptyLine(t *testing.T) {
	if _, err := ParseHookPayload([]byte("")); err == nil {
		t.Fatalf("expected error for empty line")
	}
	if _, err := ParseHookPayload([]byte("   ")); err == nil {
		t.Fatalf("expected error for whitespace-only line")
	}
}

func TestParseHookPayload_MalformedJSON(t *testing.T) {
	if _, err := ParseHookPayload([]byte("not json{{")); err == nil {
		t.Fatalf("expected error for malformed json")
	}
}

func TestParseHookPayload_DefaultsAbsentFieldsToNil(t *testing.T) {
	raw := map[string]interface{}{"hook_event_name": "PreToolUse", "session_id": "sess-1", "tool_name": "Edit"}
	event, err := ParseHookPayload(mustJSON(t, raw))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if event.CWD != nil {
		t.Fatalf("expected nil cwd, got %v", *event.CWD)
	}
	if event.NotificationType != nil {
		t.Fatalf("expected nil notificationType, got %v", *event.NotificationType)
	}
}
