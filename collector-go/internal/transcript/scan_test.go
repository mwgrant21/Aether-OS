package transcript

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/mwgrant21/aether-os/collector-go/internal/schema"
)

func freshScanDB(t *testing.T) *sql.DB {
	t.Helper()
	dir, err := os.MkdirTemp("", "aether-collector-scan-db-")
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

func mkTempDir(t *testing.T, pattern string) string {
	t.Helper()
	dir, err := os.MkdirTemp("", pattern)
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func assistantScanLine(inputTokens int) string {
	m := map[string]interface{}{
		"type":      "assistant",
		"sessionId": "s1",
		"timestamp": "2026-07-08T09:00:00Z",
		"message": map[string]interface{}{
			"model": "claude-sonnet-4-6",
			"usage": map[string]interface{}{
				"input_tokens": inputTokens, "output_tokens": 10,
				"cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
			},
			"content": []interface{}{},
		},
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func TestScanTranscriptsOnce_DiscoversAndIngestsAndRecordsOffset(t *testing.T) {
	projectsRoot := mkTempDir(t, "aether-collector-scan-projects-")
	projDir := filepath.Join(projectsRoot, "my-project")
	os.Mkdir(projDir, 0755)
	content := assistantScanLine(100) + "\n" + assistantScanLine(200) + "\n"
	os.WriteFile(filepath.Join(projDir, "session.jsonl"), []byte(content), 0644)

	db := freshScanDB(t)
	if err := ScanTranscriptsOnce(db, projectsRoot, 1000, map[string]*ToolCallHistory{}, nil); err != nil {
		t.Fatalf("ScanTranscriptsOnce: %v", err)
	}
	assertCount(t, db, "usage_events", 2)

	var lastOffset, lastScannedMs int64
	var filePath string
	if err := db.QueryRow("SELECT file_path, last_offset, last_scanned_ms FROM transcript_files").
		Scan(&filePath, &lastOffset, &lastScannedMs); err != nil {
		t.Fatalf("query transcript_files: %v", err)
	}
	if lastScannedMs != 1000 {
		t.Fatalf("last_scanned_ms=%d want 1000", lastScannedMs)
	}
	if lastOffset <= 0 {
		t.Fatalf("expected last_offset > 0, got %d", lastOffset)
	}
	want := filepath.Join("my-project", "session.jsonl")
	if filePath != want {
		t.Fatalf("file_path=%q want %q", filePath, want)
	}
}

func TestScanTranscriptsOnce_SecondCallOnlyIngestsNewLines(t *testing.T) {
	projectsRoot := mkTempDir(t, "aether-collector-scan-projects-")
	projDir := filepath.Join(projectsRoot, "my-project")
	os.Mkdir(projDir, 0755)
	filePath := filepath.Join(projDir, "session.jsonl")
	os.WriteFile(filePath, []byte(assistantScanLine(100)+"\n"), 0644)

	db := freshScanDB(t)
	historyByFile := map[string]*ToolCallHistory{}
	if err := ScanTranscriptsOnce(db, projectsRoot, 1000, historyByFile, nil); err != nil {
		t.Fatalf("first scan: %v", err)
	}

	f, err := os.OpenFile(filePath, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatalf("open for append: %v", err)
	}
	f.WriteString(assistantScanLine(200) + "\n")
	f.Close()

	beforeCount := 0
	db.QueryRow("SELECT COUNT(*) FROM usage_events").Scan(&beforeCount)

	if err := ScanTranscriptsOnce(db, projectsRoot, 2000, historyByFile, nil); err != nil {
		t.Fatalf("second scan: %v", err)
	}
	assertCount(t, db, "usage_events", 2)
	_ = beforeCount
}

func TestScanTranscriptsOnce_IgnoresNonJsonlAndNonDirs(t *testing.T) {
	projectsRoot := mkTempDir(t, "aether-collector-scan-projects-")
	os.WriteFile(filepath.Join(projectsRoot, "not-a-dir.txt"), []byte("irrelevant"), 0644)
	projDir := filepath.Join(projectsRoot, "my-project")
	os.Mkdir(projDir, 0755)
	os.WriteFile(filepath.Join(projDir, "notes.txt"), []byte("irrelevant"), 0644)

	db := freshScanDB(t)
	if err := ScanTranscriptsOnce(db, projectsRoot, 1000, map[string]*ToolCallHistory{}, nil); err != nil {
		t.Fatalf("ScanTranscriptsOnce: %v", err)
	}
	assertCount(t, db, "usage_events", 0)
	assertCount(t, db, "transcript_files", 0)
}

func TestScanTranscriptsOnce_MissingProjectsRootDoesNotError(t *testing.T) {
	db := freshScanDB(t)
	missingRoot := filepath.Join(os.TempDir(), "aether-collector-does-not-exist-scan")
	os.RemoveAll(missingRoot)
	if err := ScanTranscriptsOnce(db, missingRoot, 1000, map[string]*ToolCallHistory{}, nil); err != nil {
		t.Fatalf("expected no error for missing projects root, got %v", err)
	}
	assertCount(t, db, "usage_events", 0)
}

func TestScanTranscriptsOnce_SkipsNonAssistantOrUsagelessLines(t *testing.T) {
	projectsRoot := mkTempDir(t, "aether-collector-scan-projects-")
	projDir := filepath.Join(projectsRoot, "my-project")
	os.Mkdir(projDir, 0755)
	userLine, _ := json.Marshal(map[string]interface{}{
		"type": "user", "sessionId": "s1",
		"message": map[string]interface{}{"content": "hi"},
	})
	content := string(userLine) + "\n" + assistantScanLine(100) + "\n"
	os.WriteFile(filepath.Join(projDir, "session.jsonl"), []byte(content), 0644)

	db := freshScanDB(t)
	if err := ScanTranscriptsOnce(db, projectsRoot, 1000, map[string]*ToolCallHistory{}, nil); err != nil {
		t.Fatalf("ScanTranscriptsOnce: %v", err)
	}
	assertCount(t, db, "usage_events", 1)
}

func TestScanTranscriptsOnce_RecordsDispatchOnAgentCompletion(t *testing.T) {
	projectsRoot := mkTempDir(t, "aether-collector-scan-projects-")
	projDir := filepath.Join(projectsRoot, "my-project")
	os.Mkdir(projDir, 0755)

	agentLine, _ := json.Marshal(map[string]interface{}{
		"type": "assistant", "sessionId": "s1", "timestamp": "2026-07-08T09:00:00Z",
		"message": map[string]interface{}{
			"model": "claude-sonnet-4-6",
			"content": []interface{}{
				map[string]interface{}{"type": "tool_use", "id": "tu_agent_1", "name": "Agent", "input": map[string]interface{}{"subagent_type": "general-purpose"}},
			},
		},
	})
	completionLine, _ := json.Marshal(map[string]interface{}{
		"type": "user", "sessionId": "s1", "timestamp": "2026-07-08T09:00:12Z",
		"origin": map[string]interface{}{"kind": "task-notification"},
		"message": map[string]interface{}{
			"content": []interface{}{
				map[string]interface{}{
					"type": "text",
					"text": "Agent finished. <tool-use-id>tu_agent_1</tool-use-id>" +
						"<subagent_tokens>5000</subagent_tokens><tool_uses>3</tool_uses><duration_ms>12000</duration_ms>",
				},
			},
		},
	})
	content := string(agentLine) + "\n" + string(completionLine) + "\n"
	os.WriteFile(filepath.Join(projDir, "session.jsonl"), []byte(content), 0644)

	db := freshScanDB(t)
	nowMs := time.Date(2026, 7, 8, 9, 0, 30, 0, time.UTC).UnixMilli()
	if err := ScanTranscriptsOnce(db, projectsRoot, nowMs, map[string]*ToolCallHistory{}, nil); err != nil {
		t.Fatalf("ScanTranscriptsOnce: %v", err)
	}
	assertCount(t, db, "dispatches", 1)
	var toolUseID string
	var tokens, toolUses, durationMs int
	var startedAt, endedAt int64
	db.QueryRow("SELECT tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms FROM dispatches").
		Scan(&toolUseID, &tokens, &toolUses, &durationMs, &startedAt, &endedAt)
	if toolUseID != "tu_agent_1" || tokens != 5000 || toolUses != 3 || durationMs != 12000 {
		t.Fatalf("unexpected dispatch row: %s tokens=%d toolUses=%d durationMs=%d", toolUseID, tokens, toolUses, durationMs)
	}
	wantStarted := time.Date(2026, 7, 8, 9, 0, 0, 0, time.UTC).UnixMilli()
	wantEnded := time.Date(2026, 7, 8, 9, 0, 12, 0, time.UTC).UnixMilli()
	if startedAt != wantStarted || endedAt != wantEnded {
		t.Fatalf("startedAt=%d endedAt=%d want %d/%d", startedAt, endedAt, wantStarted, wantEnded)
	}
}

func TestScanTranscriptsOnce_NoDispatchRowWithoutCompletion(t *testing.T) {
	projectsRoot := mkTempDir(t, "aether-collector-scan-projects-")
	projDir := filepath.Join(projectsRoot, "my-project")
	os.Mkdir(projDir, 0755)

	agentLine := func(id string) string {
		m := map[string]interface{}{
			"type": "assistant", "sessionId": "s1", "timestamp": "2026-07-08T09:00:00Z",
			"message": map[string]interface{}{
				"model": "claude-sonnet-4-6",
				"content": []interface{}{
					map[string]interface{}{"type": "tool_use", "id": id, "name": "Agent", "input": map[string]interface{}{}},
				},
			},
		}
		b, _ := json.Marshal(m)
		return string(b)
	}
	completionLine, _ := json.Marshal(map[string]interface{}{
		"type": "user", "sessionId": "s1", "timestamp": "2026-07-08T09:00:12Z",
		"origin": map[string]interface{}{"kind": "task-notification"},
		"message": map[string]interface{}{
			"content": []interface{}{
				map[string]interface{}{"type": "text", "text": "<tool-use-id>tu_a</tool-use-id><subagent_tokens>90</subagent_tokens>"},
			},
		},
	})
	content := agentLine("tu_a") + "\n" + agentLine("tu_b") + "\n" + string(completionLine) + "\n"
	os.WriteFile(filepath.Join(projDir, "session.jsonl"), []byte(content), 0644)

	db := freshScanDB(t)
	nowMs := time.Date(2026, 7, 8, 9, 0, 30, 0, time.UTC).UnixMilli()
	if err := ScanTranscriptsOnce(db, projectsRoot, nowMs, map[string]*ToolCallHistory{}, nil); err != nil {
		t.Fatalf("ScanTranscriptsOnce: %v", err)
	}
	assertCount(t, db, "dispatches", 1)
	var toolUseID string
	db.QueryRow("SELECT tool_use_id FROM dispatches").Scan(&toolUseID)
	if toolUseID != "tu_a" {
		t.Fatalf("toolUseID=%q want tu_a", toolUseID)
	}
}

func TestScanTranscriptsOnce_StampsHeartbeatEvenWhenRootUnreadable(t *testing.T) {
	db := freshScanDB(t)
	missingRoot := filepath.Join(os.TempDir(), "aether-does-not-exist-scan-hb")
	os.RemoveAll(missingRoot)
	if err := ScanTranscriptsOnce(db, missingRoot, 12345, map[string]*ToolCallHistory{}, nil); err != nil {
		t.Fatalf("ScanTranscriptsOnce: %v", err)
	}
	var value string
	if err := db.QueryRow("SELECT value FROM schema_meta WHERE key = 'transcript_last_scan_ms'").Scan(&value); err != nil {
		t.Fatalf("query heartbeat: %v", err)
	}
	if value != "12345" {
		t.Fatalf("heartbeat=%q want 12345", value)
	}
}

// TestScanTranscriptsOnce_UsesInjectedAnomalyIngestFuncWhenProvided proves the
// Task 8 wiring point: when a non-nil AnomalyIngestFunc is supplied,
// ScanTranscriptsOnce calls it (instead of the plain UpdateHistory path) with
// the prior history and this tick's parsed events, and stores its returned
// history back into toolCallHistoryByFile for the next tick. This is exactly
// the seam internal/collector uses to inject anomaly.IngestToolCallsAndAnomalies
// without an import cycle (see this file's top doc comment).
func TestScanTranscriptsOnce_UsesInjectedAnomalyIngestFuncWhenProvided(t *testing.T) {
	projectsRoot := mkTempDir(t, "aether-collector-scan-projects-")
	projDir := filepath.Join(projectsRoot, "my-project")
	os.Mkdir(projDir, 0755)
	os.WriteFile(filepath.Join(projDir, "session.jsonl"), []byte(assistantScanLine(100)+"\n"), 0644)

	db := freshScanDB(t)
	historyByFile := map[string]*ToolCallHistory{}

	var gotEvents int
	var gotPriorHistory *ToolCallHistory
	var gotSourceFileRel string
	sentinelHistory := CreateEmptyHistory()
	stub := func(db *sql.DB, history *ToolCallHistory, events []Event, nowMs int64, sourceFileRel string) (*ToolCallHistory, error) {
		gotPriorHistory = history
		gotEvents = len(events)
		gotSourceFileRel = sourceFileRel
		return sentinelHistory, nil
	}

	if err := ScanTranscriptsOnce(db, projectsRoot, 1000, historyByFile, stub); err != nil {
		t.Fatalf("ScanTranscriptsOnce: %v", err)
	}

	// The source-relative path must reach the ingester -- without it every
	// tool_calls row lands with source_file_rel NULL and downstream dispatch
	// evidence reports no file-touch correlation (issue #32). It must be the
	// PROJECT-relative path, never absolute (docs/privacy-and-data.md SS5).
	if want := filepath.Join("my-project", "session.jsonl"); gotSourceFileRel != want {
		t.Errorf("sourceFileRel = %q, want %q", gotSourceFileRel, want)
	}
	if gotEvents != 1 {
		t.Fatalf("injected func saw %d events, want 1", gotEvents)
	}
	if gotPriorHistory == nil {
		t.Fatalf("injected func was not called with a non-nil prior history")
	}
	relPath := filepath.Join("my-project", "session.jsonl")
	if historyByFile[relPath] != sentinelHistory {
		t.Fatalf("toolCallHistoryByFile[%q] was not updated to the injected func's returned history", relPath)
	}
}
