package anomaly

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/mwgrant21/aether-os/collector-go/internal/schema"
	"github.com/mwgrant21/aether-os/collector-go/internal/transcript"
)

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	db, err := schema.OpenDatabase(dbPath)
	if err != nil {
		t.Fatalf("OpenDatabase: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := schema.Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	return db
}

func readEvent(id, name, path string, tsMs int64, cwd *string) transcript.Event {
	ts := time.UnixMilli(tsMs)
	return transcript.Event{
		Kind:      "assistant",
		Timestamp: &ts,
		Cwd:       cwd,
		ToolUses:  []transcript.ToolUse{{ID: id, Name: name, Input: map[string]interface{}{"file_path": path}}},
	}
}

func resultEvent(id string, tsMs int64) transcript.Event {
	ts := time.UnixMilli(tsMs)
	return transcript.Event{
		Kind:        "user",
		Timestamp:   &ts,
		ToolResults: []transcript.ToolResult{{ToolUseID: id, ResultLength: 5}},
	}
}

func TestIngest_PersistsClosedToolCallsAndFlagsReReadLoopOnThirdRead(t *testing.T) {
	db := openTestDB(t)
	history := transcript.CreateEmptyHistory()

	events := []transcript.Event{}
	for i := 0; i < 3; i++ {
		id := fmt.Sprintf("tu_%d", i)
		events = append(events, readEvent(id, "Read", "src/foo.ts", int64(1000+i*100), nil))
		events = append(events, resultEvent(id, int64(1050+i*100)))
	}

	result, err := IngestToolCallsAndAnomalies(db, history, events, 2000)
	if err != nil {
		t.Fatalf("IngestToolCallsAndAnomalies: %v", err)
	}

	if result.ToolCallsIngested != 3 {
		t.Fatalf("expected 3 tool calls ingested, got %d", result.ToolCallsIngested)
	}
	if result.AnomaliesIngested != 1 {
		t.Fatalf("expected 1 anomaly ingested, got %d", result.AnomaliesIngested)
	}

	rows, err := db.Query(`SELECT tool_name, file_path_rel FROM tool_calls ORDER BY id`)
	if err != nil {
		t.Fatalf("query tool_calls: %v", err)
	}
	defer rows.Close()
	var got []struct{ toolName, filePathRel string }
	for rows.Next() {
		var toolName, filePathRel string
		if err := rows.Scan(&toolName, &filePathRel); err != nil {
			t.Fatalf("scan: %v", err)
		}
		got = append(got, struct{ toolName, filePathRel string }{toolName, filePathRel})
	}
	if len(got) != 3 {
		t.Fatalf("expected 3 tool_calls rows, got %d", len(got))
	}
	if got[0].toolName != "Read" || got[0].filePathRel != "src/foo.ts" {
		t.Fatalf("unexpected first row: %+v", got[0])
	}

	anomRows, err := db.Query(`SELECT kind, detail FROM anomalies`)
	if err != nil {
		t.Fatalf("query anomalies: %v", err)
	}
	defer anomRows.Close()
	var kind, detail string
	count := 0
	for anomRows.Next() {
		if err := anomRows.Scan(&kind, &detail); err != nil {
			t.Fatalf("scan: %v", err)
		}
		count++
	}
	if count != 1 {
		t.Fatalf("expected 1 anomaly row, got %d", count)
	}
	if kind != "reReadLoop" {
		t.Fatalf("expected kind reReadLoop, got %q", kind)
	}
	if !strings.Contains(detail, "src/foo.ts") {
		t.Fatalf("expected detail to contain src/foo.ts, got %q", detail)
	}
}

func TestIngest_NullsTraversalRelativePath(t *testing.T) {
	db := openTestDB(t)
	history := transcript.CreateEmptyHistory()

	events := []transcript.Event{
		readEvent("tu_0", "Read", "../../secret", 1000, nil),
		resultEvent("tu_0", 1050),
	}

	result, err := IngestToolCallsAndAnomalies(db, history, events, 2000)
	if err != nil {
		t.Fatalf("IngestToolCallsAndAnomalies: %v", err)
	}
	if result.ToolCallsIngested != 1 {
		t.Fatalf("expected 1 tool call ingested, got %d", result.ToolCallsIngested)
	}

	var filePathRel sql.NullString
	row := db.QueryRow(`SELECT file_path_rel FROM tool_calls`)
	if err := row.Scan(&filePathRel); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if filePathRel.Valid {
		t.Fatalf("expected NULL file_path_rel, got %q", filePathRel.String)
	}
}

func TestIngest_NewlyClosedDiffedByToolUseIdNotArrayIndex(t *testing.T) {
	db := openTestDB(t)

	// Simulate a history already at the 500-event cap from prior ticks
	// (those tool_calls rows were already persisted by those earlier calls,
	// not by this test). An index-based diff would see length 500 -> 500 and
	// either emit zero newly-closed rows or reprocess stale entries.
	priorEvents := make([]transcript.ClosedToolCall, 500)
	for i := 0; i < 500; i++ {
		fp := fmt.Sprintf("file_%d.ts", i)
		priorEvents[i] = transcript.ClosedToolCall{
			ToolUseID: fmt.Sprintf("tu_%d", i),
			ToolName:  "Read",
			FilePath:  &fp,
			StartedAt: int64(i),
			ClosedAt:  int64(i),
		}
	}
	priorHistory := &transcript.ToolCallHistory{Events: priorEvents, OpenByToolUseID: map[string]transcript.OpenToolCall{}}

	events := []transcript.Event{
		readEvent("tu_500", "Read", "src/new-file.ts", 5000, nil),
		resultEvent("tu_500", 5050),
	}

	result, err := IngestToolCallsAndAnomalies(db, priorHistory, events, 6000)
	if err != nil {
		t.Fatalf("IngestToolCallsAndAnomalies: %v", err)
	}

	if len(result.History.Events) != 500 {
		t.Fatalf("expected history capped at 500, got %d", len(result.History.Events))
	}
	last := result.History.Events[len(result.History.Events)-1]
	if last.ToolUseID != "tu_500" {
		t.Fatalf("expected last event tu_500, got %q", last.ToolUseID)
	}
	// Exactly the one genuinely new closure was ingested -- not zero (missed
	// closure) and not 500+ (duplicate/stale re-insert).
	if result.ToolCallsIngested != 1 {
		t.Fatalf("expected 1 tool call ingested, got %d", result.ToolCallsIngested)
	}

	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM tool_calls`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected 1 tool_calls row, got %d", count)
	}
	var toolUseID string
	if err := db.QueryRow(`SELECT tool_use_id FROM tool_calls`).Scan(&toolUseID); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if toolUseID != "tu_500" {
		t.Fatalf("expected tu_500, got %q", toolUseID)
	}
}

func TestIngest_RelativizesAbsoluteFilePathAgainstCwd(t *testing.T) {
	db := openTestDB(t)

	cwd := "/home/matt/projects/foo"
	if runtime.GOOS == "windows" {
		cwd = `C:\Users\Matt\projects\foo`
	}
	abs := filepath.Join(cwd, "src", "bar.ts")
	wantRel := filepath.Join("src", "bar.ts")

	events := []transcript.Event{}
	for i := 0; i < 3; i++ {
		id := fmt.Sprintf("tu_%d", i)
		events = append(events, readEvent(id, "Read", abs, int64(1000+i*100), &cwd))
		events = append(events, resultEvent(id, int64(1050+i*100)))
	}

	result, err := IngestToolCallsAndAnomalies(db, transcript.CreateEmptyHistory(), events, 2000)
	if err != nil {
		t.Fatalf("IngestToolCallsAndAnomalies: %v", err)
	}
	if result.AnomaliesIngested != 1 {
		t.Fatalf("expected 1 anomaly ingested, got %d", result.AnomaliesIngested)
	}

	rows, err := db.Query(`SELECT file_path_rel FROM tool_calls`)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	rowCount := 0
	for rows.Next() {
		var rel string
		if err := rows.Scan(&rel); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if rel != wantRel {
			t.Fatalf("expected file_path_rel %q, got %q", wantRel, rel)
		}
		if strings.Contains(rel, cwd) {
			t.Fatalf("file_path_rel leaked cwd: %q", rel)
		}
		rowCount++
	}
	if rowCount != 3 {
		t.Fatalf("expected 3 rows, got %d", rowCount)
	}

	var detail string
	if err := db.QueryRow(`SELECT detail FROM anomalies`).Scan(&detail); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if strings.Contains(detail, cwd) {
		t.Fatalf("anomaly detail leaked cwd: %q", detail)
	}
	if !strings.Contains(detail, wantRel) {
		t.Fatalf("expected anomaly detail to contain %q, got %q", wantRel, detail)
	}
}

func TestIngest_NullsAbsoluteFilePathWithNoCwd(t *testing.T) {
	db := openTestDB(t)

	abs := "/home/matt/secret.ts"
	if runtime.GOOS == "windows" {
		abs = `C:\Users\Matt\secret.ts`
	}

	events := []transcript.Event{
		readEvent("tu_0", "Read", abs, 1000, nil),
		resultEvent("tu_0", 1050),
	}

	if _, err := IngestToolCallsAndAnomalies(db, transcript.CreateEmptyHistory(), events, 2000); err != nil {
		t.Fatalf("IngestToolCallsAndAnomalies: %v", err)
	}

	var filePathRel sql.NullString
	if err := db.QueryRow(`SELECT file_path_rel FROM tool_calls`).Scan(&filePathRel); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if filePathRel.Valid {
		t.Fatalf("expected NULL file_path_rel, got %q", filePathRel.String)
	}
}

func TestIngest_DoesNotReinsertSameAnomalyOnSecondScanTick(t *testing.T) {
	db := openTestDB(t)

	events := []transcript.Event{}
	for i := 0; i < 3; i++ {
		id := fmt.Sprintf("tu_%d", i)
		events = append(events, readEvent(id, "Read", "src/foo.ts", int64(1000+i*100), nil))
		events = append(events, resultEvent(id, int64(1050+i*100)))
	}

	first, err := IngestToolCallsAndAnomalies(db, transcript.CreateEmptyHistory(), events, 2000)
	if err != nil {
		t.Fatalf("first IngestToolCallsAndAnomalies: %v", err)
	}
	if first.AnomaliesIngested != 1 {
		t.Fatalf("expected 1 anomaly ingested on first tick, got %d", first.AnomaliesIngested)
	}

	// Second tick: no new transcript events, but the same closures are still
	// inside the 5-minute window, so the detectors fire again.
	second, err := IngestToolCallsAndAnomalies(db, first.History, []transcript.Event{}, 3000)
	if err != nil {
		t.Fatalf("second IngestToolCallsAndAnomalies: %v", err)
	}
	if second.AnomaliesIngested != 0 {
		t.Fatalf("expected 0 anomalies ingested on second tick, got %d", second.AnomaliesIngested)
	}

	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM anomalies`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected 1 anomaly row total, got %d", count)
	}
}
