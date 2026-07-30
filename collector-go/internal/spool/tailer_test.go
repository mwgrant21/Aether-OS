package spool

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func freshSpoolDir(t *testing.T) string {
	t.Helper()
	return t.TempDir()
}

func writeSpoolFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write spool file: %v", err)
	}
	return path
}

func eventCount(t *testing.T, db *sql.DB) int {
	t.Helper()
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM events").Scan(&count); err != nil {
		t.Fatalf("count events: %v", err)
	}
	return count
}

func TestTailSpoolOnce_IngestsEveryLineAndDeletesEachFile(t *testing.T) {
	db := freshDB(t)
	spoolDir := freshSpoolDir(t)
	line1, _ := json.Marshal(map[string]interface{}{"hook_event_name": "PreToolUse", "session_id": "s1", "tool_name": "Bash"})
	line2, _ := json.Marshal(map[string]interface{}{"hook_event_name": "Stop", "session_id": "s1"})
	filePath := writeSpoolFile(t, spoolDir, "s1.jsonl", string(line1)+"\n"+string(line2)+"\n")

	result := TailSpoolOnce(db, spoolDir, 1000)
	if result.FilesProcessed != 1 || result.LinesIngested != 2 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if _, err := os.Stat(filePath); !os.IsNotExist(err) {
		t.Fatalf("expected spool file to be deleted, stat err: %v", err)
	}
	if got := eventCount(t, db); got != 2 {
		t.Fatalf("expected 2 events, got %d", got)
	}
}

func TestTailSpoolOnce_IgnoresNonJsonlFiles(t *testing.T) {
	db := freshDB(t)
	spoolDir := freshSpoolDir(t)
	notesPath := writeSpoolFile(t, spoolDir, "notes.txt", "irrelevant")

	result := TailSpoolOnce(db, spoolDir, 1000)
	if result.FilesProcessed != 0 || result.LinesIngested != 0 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if _, err := os.Stat(notesPath); err != nil {
		t.Fatalf("expected notes.txt to still exist: %v", err)
	}
}

func TestTailSpoolOnce_MissingSpoolDir_ReturnsZeroCountsWithoutPanic(t *testing.T) {
	db := freshDB(t)
	missingDir := filepath.Join(t.TempDir(), "does-not-exist")

	result := TailSpoolOnce(db, missingDir, 1000)
	if result.FilesProcessed != 0 || result.LinesIngested != 0 {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestTailSpoolOnce_SkipsBlankLinesWithoutCountingThem(t *testing.T) {
	db := freshDB(t)
	spoolDir := freshSpoolDir(t)
	line, _ := json.Marshal(map[string]interface{}{"hook_event_name": "Stop", "session_id": "s1"})
	writeSpoolFile(t, spoolDir, "s1.jsonl", "\n"+string(line)+"\n\n")

	result := TailSpoolOnce(db, spoolDir, 1000)
	if result.LinesIngested != 1 {
		t.Fatalf("expected 1 line ingested, got %d", result.LinesIngested)
	}
}

func TestTailSpoolOnce_ProcessesMultipleSpoolFilesInOnePass(t *testing.T) {
	db := freshDB(t)
	spoolDir := freshSpoolDir(t)
	line1, _ := json.Marshal(map[string]interface{}{"hook_event_name": "Stop", "session_id": "s1"})
	line2, _ := json.Marshal(map[string]interface{}{"hook_event_name": "Stop", "session_id": "s2"})
	writeSpoolFile(t, spoolDir, "s1.jsonl", string(line1)+"\n")
	writeSpoolFile(t, spoolDir, "s2.jsonl", string(line2)+"\n")

	result := TailSpoolOnce(db, spoolDir, 1000)
	if result.FilesProcessed != 2 || result.LinesIngested != 2 {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestStartSpoolTailer_PollsAndIngestsThenStopStopsFurtherPolling(t *testing.T) {
	db := freshDB(t)
	spoolDir := freshSpoolDir(t)
	line, _ := json.Marshal(map[string]interface{}{"hook_event_name": "Stop", "session_id": "s1"})
	writeSpoolFile(t, spoolDir, "s1.jsonl", string(line)+"\n")

	stop := StartSpoolTailer(db, spoolDir, 20*time.Millisecond)
	deadline := time.Now().Add(2 * time.Second)
	for eventCount(t, db) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := eventCount(t, db); got != 1 {
		t.Fatalf("expected 1 event ingested via poll, got %d", got)
	}
	stop()

	// Give any in-flight tick a moment to settle, then confirm no further
	// files are processed after stop (nothing left to ingest anyway, but
	// this also exercises that stop() does not panic or deadlock).
	time.Sleep(50 * time.Millisecond)
	if got := eventCount(t, db); got != 1 {
		t.Fatalf("expected event count to remain 1 after stop, got %d", got)
	}
}

func TestStartSpoolTailer_StopWaitsForGoroutineToExit(t *testing.T) {
	db := freshDB(t)
	spoolDir := freshSpoolDir(t)

	stop := StartSpoolTailer(db, spoolDir, 5*time.Millisecond)
	time.Sleep(20 * time.Millisecond) // let a few ticks happen
	stop()

	// Once stop() returns, the polling goroutine has fully exited, so no
	// TailSpoolOnce pass can be in flight or start later. A spool file dropped
	// in after stop() must therefore survive untouched.
	markerPath := filepath.Join(spoolDir, "marker-after-stop.jsonl")
	if err := os.WriteFile(markerPath, []byte(`{"hook_event_name":"Stop","session_id":"x"}`+"\n"), 0644); err != nil {
		t.Fatalf("write marker: %v", err)
	}
	time.Sleep(30 * time.Millisecond) // bounded wait, not indefinite

	if _, err := os.Stat(markerPath); err != nil {
		t.Fatalf("marker file should still exist (no tailer pass ran after stop()): %v", err)
	}
	if got := eventCount(t, db); got != 0 {
		t.Fatalf("expected no events ingested after stop(), got %d", got)
	}
}
