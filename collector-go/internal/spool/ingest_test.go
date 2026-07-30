package spool

import (
	"database/sql"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mwgrant21/aether-os/collector-go/internal/schema"
)

func freshDB(t *testing.T) *sql.DB {
	t.Helper()
	dir := t.TempDir()
	db, err := schema.OpenDatabase(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	if err := schema.Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestIngestLine_InsertsRowForValidPreToolUseLine(t *testing.T) {
	db := freshDB(t)
	line, err := json.Marshal(map[string]interface{}{
		"hook_event_name": "PreToolUse",
		"session_id":      "s1",
		"cwd":             "/proj",
		"tool_name":       "Bash",
		"tool_input":      map[string]interface{}{"command": "ls"},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	inserted := ingestLine(db, string(line), 1000)
	if !inserted {
		t.Fatalf("expected line to be ingested")
	}

	var toolName string
	var hadToolInput int
	if err := db.QueryRow("SELECT tool_name, had_tool_input FROM events").Scan(&toolName, &hadToolInput); err != nil {
		t.Fatalf("query events: %v", err)
	}
	if toolName != "Bash" {
		t.Fatalf("unexpected tool_name: %s", toolName)
	}
	if hadToolInput != 1 {
		t.Fatalf("expected had_tool_input=1, got %d", hadToolInput)
	}

	var projectRelPath sql.NullString
	if err := db.QueryRow("SELECT project_rel_path FROM events").Scan(&projectRelPath); err != nil {
		t.Fatalf("query project_rel_path: %v", err)
	}
	if strings.Contains(projectRelPath.String, "ls") {
		t.Fatalf("row unexpectedly contains raw tool_input content: %q", projectRelPath.String)
	}
}

func TestIngestLine_MalformedJSON_ReturnsFalseAndInsertsNothing(t *testing.T) {
	db := freshDB(t)
	if ingestLine(db, "not json{{", 1000) {
		t.Fatalf("expected malformed json to not be ingested")
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM events").Scan(&count); err != nil {
		t.Fatalf("count events: %v", err)
	}
	if count != 0 {
		t.Fatalf("expected 0 events, got %d", count)
	}
}

func TestIngestLine_UnrecognizedHookEventName_ReturnsFalse(t *testing.T) {
	db := freshDB(t)
	line, _ := json.Marshal(map[string]interface{}{"hook_event_name": "FutureEvent", "session_id": "s1"})
	if ingestLine(db, string(line), 1000) {
		t.Fatalf("expected unrecognized event name to not be ingested")
	}
}

func TestIngestLine_MissingRequiredField_LogsDriftButReturnsFalse(t *testing.T) {
	db := freshDB(t)
	line, _ := json.Marshal(map[string]interface{}{"hook_event_name": "PreToolUse", "session_id": "s1"}) // no tool_name
	if ingestLine(db, string(line), 1000) {
		t.Fatalf("expected missing-required-field line to not be ingested")
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM drift_log").Scan(&count); err != nil {
		t.Fatalf("count drift_log: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected 1 drift_log row, got %d", count)
	}
}

func TestIngestLine_EmptyString_NeverPanicsReturnsFalse(t *testing.T) {
	db := freshDB(t)
	if ingestLine(db, "", 1000) {
		t.Fatalf("expected empty line to not be ingested")
	}
}
