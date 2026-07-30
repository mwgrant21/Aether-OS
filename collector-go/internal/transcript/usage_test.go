package transcript

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/mwgrant21/aether-os/collector-go/internal/schema"
)

func freshUsageDB(t *testing.T) *sql.DB {
	t.Helper()
	dir, err := os.MkdirTemp("", "aether-collector-usageingest-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	db, err := schema.OpenDatabase(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("OpenDatabase: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := schema.Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	return db
}

func assistantUsageEvent(overrides func(*Event)) *Event {
	ts := time.Date(2026, 7, 8, 9, 0, 0, 0, time.UTC)
	model := "claude-sonnet-4-6"
	e := &Event{
		Kind:      "assistant",
		Timestamp: &ts,
		Model:     &model,
		Usage:     &Usage{InputTokens: 100, OutputTokens: 50, CacheCreationInputTokens: 0, CacheReadInputTokens: 0},
	}
	if overrides != nil {
		overrides(e)
	}
	return e
}

func openDispatch(toolUseID string, startedAtMs int64, toolName string) *ToolCallHistory {
	ts := time.UnixMilli(startedAtMs).UTC()
	if toolName == "" {
		toolName = "Agent"
	}
	event := Event{
		Kind:      "assistant",
		Timestamp: &ts,
		ToolUses:  []ToolUse{{ID: toolUseID, Name: toolName, Input: map[string]interface{}{"subagent_type": "general-purpose"}}},
	}
	return UpdateHistory(CreateEmptyHistory(), []Event{event}, startedAtMs)
}

func completionEvent(toolUseID string, endedAtMs int64, tokens, toolUses, durationMs int) *Event {
	ts := time.UnixMilli(endedAtMs).UTC()
	origin := "task-notification"
	text := "<tool-use-id>" + toolUseID + "</tool-use-id>" +
		"<subagent_tokens>" + itoa(tokens) + "</subagent_tokens>" +
		"<tool_uses>" + itoa(toolUses) + "</tool_uses>" +
		"<duration_ms>" + itoa(durationMs) + "</duration_ms>"
	return &Event{
		Kind:       "user",
		Timestamp:  &ts,
		OriginKind: &origin,
		HumanText:  &text,
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func TestIngestUsageEvent_InsertsForAssistantWithUsage(t *testing.T) {
	db := freshUsageDB(t)
	inserted, err := IngestUsageEvent(db, assistantUsageEvent(nil))
	if err != nil {
		t.Fatalf("IngestUsageEvent: %v", err)
	}
	if !inserted {
		t.Fatalf("expected inserted=true")
	}
	var model string
	var inputTokens int
	var occurredAt int64
	if err := db.QueryRow("SELECT model, input_tokens, occurred_at_ms FROM usage_events").Scan(&model, &inputTokens, &occurredAt); err != nil {
		t.Fatalf("query: %v", err)
	}
	if model != "claude-sonnet-4-6" || inputTokens != 100 {
		t.Fatalf("unexpected row: model=%s inputTokens=%d", model, inputTokens)
	}
	want := time.Date(2026, 7, 8, 9, 0, 0, 0, time.UTC).UnixMilli()
	if occurredAt != want {
		t.Fatalf("occurredAt=%d want %d", occurredAt, want)
	}
}

func TestIngestUsageEvent_SkipsUserKind(t *testing.T) {
	db := freshUsageDB(t)
	inserted, err := IngestUsageEvent(db, assistantUsageEvent(func(e *Event) { e.Kind = "user" }))
	if err != nil || inserted {
		t.Fatalf("expected inserted=false, err=nil, got inserted=%v err=%v", inserted, err)
	}
	assertCount(t, db, "usage_events", 0)
}

func TestIngestUsageEvent_SkipsNilUsage(t *testing.T) {
	db := freshUsageDB(t)
	inserted, _ := IngestUsageEvent(db, assistantUsageEvent(func(e *Event) { e.Usage = nil }))
	if inserted {
		t.Fatalf("expected inserted=false")
	}
}

func TestIngestUsageEvent_SkipsNilTimestamp(t *testing.T) {
	db := freshUsageDB(t)
	inserted, _ := IngestUsageEvent(db, assistantUsageEvent(func(e *Event) { e.Timestamp = nil }))
	if inserted {
		t.Fatalf("expected inserted=false")
	}
}

func TestIngestUsageEvent_NilModelStoredAsSQLNull(t *testing.T) {
	db := freshUsageDB(t)
	IngestUsageEvent(db, assistantUsageEvent(func(e *Event) { e.Model = nil }))
	var model sql.NullString
	if err := db.QueryRow("SELECT model FROM usage_events").Scan(&model); err != nil {
		t.Fatalf("query: %v", err)
	}
	if model.Valid {
		t.Fatalf("expected NULL model, got %q", model.String)
	}
}

func assertCount(t *testing.T, db *sql.DB, table string, want int) {
	t.Helper()
	var got int
	if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&got); err != nil {
		t.Fatalf("count query: %v", err)
	}
	if got != want {
		t.Fatalf("%s count = %d, want %d", table, got, want)
	}
}

func TestIngestDispatchEvent_RecordsExactTagValues(t *testing.T) {
	db := freshUsageDB(t)
	history := openDispatch("tu_1", 1000, "")
	ingested, err := IngestDispatchEvent(db, history, completionEvent("tu_1", 13000, 12345, 7, 4321))
	if err != nil {
		t.Fatalf("IngestDispatchEvent: %v", err)
	}
	if !ingested {
		t.Fatalf("expected ingested=true")
	}
	var tokens, toolUses, durationMs int
	var startedAt, endedAt int64
	err = db.QueryRow("SELECT tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms FROM dispatches WHERE tool_use_id = ?", "tu_1").
		Scan(&tokens, &toolUses, &durationMs, &startedAt, &endedAt)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if tokens != 12345 || toolUses != 7 || durationMs != 4321 || startedAt != 1000 || endedAt != 13000 {
		t.Fatalf("unexpected row: tokens=%d toolUses=%d durationMs=%d startedAt=%d endedAt=%d", tokens, toolUses, durationMs, startedAt, endedAt)
	}
}

func TestIngestDispatchEvent_NoMatchingOpenDispatch(t *testing.T) {
	db := freshUsageDB(t)
	history := openDispatch("tu_1", 1000, "")
	ingested, _ := IngestDispatchEvent(db, history, completionEvent("tu_other", 13000, 1, 1, 1))
	if ingested {
		t.Fatalf("expected ingested=false")
	}
	assertCount(t, db, "dispatches", 0)
}

func TestIngestDispatchEvent_NoToolUseIDTag(t *testing.T) {
	db := freshUsageDB(t)
	history := openDispatch("tu_1", 1000, "")
	text := "subagent finished"
	event := completionEvent("tu_1", 13000, 1, 1, 1)
	event.HumanText = &text
	ingested, _ := IngestDispatchEvent(db, history, event)
	if ingested {
		t.Fatalf("expected ingested=false")
	}
	assertCount(t, db, "dispatches", 0)
}

func TestIngestDispatchEvent_NonUserOrNonTaskNotification(t *testing.T) {
	db := freshUsageDB(t)
	history := openDispatch("tu_1", 1000, "")

	asAssistant := completionEvent("tu_1", 13000, 1, 1, 1)
	asAssistant.Kind = "assistant"
	if ingested, _ := IngestDispatchEvent(db, history, asAssistant); ingested {
		t.Fatalf("expected ingested=false for non-user event")
	}

	wrongOrigin := completionEvent("tu_1", 13000, 1, 1, 1)
	wrongOrigin.OriginKind = nil
	if ingested, _ := IngestDispatchEvent(db, history, wrongOrigin); ingested {
		t.Fatalf("expected ingested=false for wrong origin")
	}
	assertCount(t, db, "dispatches", 0)
}

func TestIngestDispatchEvent_NotAgentToolName(t *testing.T) {
	db := freshUsageDB(t)
	history := openDispatch("tu_1", 1000, "Bash")
	ingested, _ := IngestDispatchEvent(db, history, completionEvent("tu_1", 13000, 1, 1, 1))
	if ingested {
		t.Fatalf("expected ingested=false for non-Agent open tool call")
	}
}

func TestIngestDispatchEvent_NoTimestamp(t *testing.T) {
	db := freshUsageDB(t)
	history := openDispatch("tu_1", 1000, "")
	event := completionEvent("tu_1", 13000, 1, 1, 1)
	event.Timestamp = nil
	ingested, _ := IngestDispatchEvent(db, history, event)
	if ingested {
		t.Fatalf("expected ingested=false when timestamp is nil")
	}
}

func TestIngestDispatchEvent_DefaultsMissingNumericTagsToZero(t *testing.T) {
	db := freshUsageDB(t)
	history := openDispatch("tu_1", 1000, "")
	text := "<tool-use-id>tu_1</tool-use-id>"
	event := completionEvent("tu_1", 13000, 1, 1, 1)
	event.HumanText = &text
	ingested, err := IngestDispatchEvent(db, history, event)
	if err != nil || !ingested {
		t.Fatalf("expected ingested=true, err=nil, got ingested=%v err=%v", ingested, err)
	}
	var tokens, toolUses, durationMs int
	db.QueryRow("SELECT tokens, tool_uses, duration_ms FROM dispatches WHERE tool_use_id = ?", "tu_1").Scan(&tokens, &toolUses, &durationMs)
	if tokens != 0 || toolUses != 0 || durationMs != 0 {
		t.Fatalf("expected zero defaults, got tokens=%d toolUses=%d durationMs=%d", tokens, toolUses, durationMs)
	}
}

func TestIngestDispatchEvent_ClosesOnlyTaggedDispatch(t *testing.T) {
	db := freshUsageDB(t)
	history := openDispatch("tu_a", 1000, "")
	ts2 := time.UnixMilli(2000).UTC()
	history = UpdateHistory(history, []Event{{
		Kind:      "assistant",
		Timestamp: &ts2,
		ToolUses:  []ToolUse{{ID: "tu_b", Name: "Agent", Input: map[string]interface{}{}}},
	}}, 2000)
	if len(history.OpenByToolUseID) != 2 {
		t.Fatalf("expected 2 open dispatches, got %d", len(history.OpenByToolUseID))
	}

	ingested, err := IngestDispatchEvent(db, history, completionEvent("tu_a", 13000, 500, 1, 1))
	if err != nil || !ingested {
		t.Fatalf("expected ingested=true, got %v err=%v", ingested, err)
	}
	assertCount(t, db, "dispatches", 1)
	var toolUseID string
	var tokens int
	db.QueryRow("SELECT tool_use_id, tokens FROM dispatches").Scan(&toolUseID, &tokens)
	if toolUseID != "tu_a" || tokens != 500 {
		t.Fatalf("unexpected row: toolUseID=%s tokens=%d", toolUseID, tokens)
	}
}

func TestIngestDispatchEvent_UpsertsOnRepeatedCompletion(t *testing.T) {
	db := freshUsageDB(t)
	history := openDispatch("tu_1", 1000, "")
	IngestDispatchEvent(db, history, completionEvent("tu_1", 13000, 100, 1, 1))
	IngestDispatchEvent(db, history, completionEvent("tu_1", 14000, 250, 1, 1))
	assertCount(t, db, "dispatches", 1)
	var tokens int
	var endedAt int64
	db.QueryRow("SELECT tokens, ended_at_ms FROM dispatches").Scan(&tokens, &endedAt)
	if tokens != 250 || endedAt != 14000 {
		t.Fatalf("unexpected row: tokens=%d endedAt=%d", tokens, endedAt)
	}
}

func TestIngestDispatchEvent_NeverPersistsRawText(t *testing.T) {
	db := freshUsageDB(t)
	history := openDispatch("tu_1", 1000, "")
	IngestDispatchEvent(db, history, completionEvent("tu_1", 13000, 1, 1, 1))
	rows, err := db.Query("SELECT * FROM dispatches WHERE tool_use_id = ?", "tu_1")
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	for _, c := range cols {
		if c == "raw_text" || c == "notification_text" {
			t.Fatalf("unexpected raw-text column persisted: %s", c)
		}
	}
}
