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

func TestTailSpoolOnce_KeepsFileAndWritesNothingWhenAnInsertFails_ThenIngestsWholeFileOnRetry(t *testing.T) {
	db := freshDB(t)
	spoolDir := freshSpoolDir(t)
	// Stand-in for SQLITE_BUSY / disk full / schema drift: make one specific
	// insert fail so the test proves the whole file is rolled back, not just
	// the failing line.
	if _, err := db.Exec(`CREATE TRIGGER boom BEFORE INSERT ON events WHEN NEW.tool_name = 'BOOM' BEGIN SELECT RAISE(ABORT, 'boom'); END;`); err != nil {
		t.Fatalf("create trigger: %v", err)
	}
	ok, _ := json.Marshal(map[string]interface{}{"hook_event_name": "PreToolUse", "session_id": "s1", "tool_name": "Bash"})
	bad, _ := json.Marshal(map[string]interface{}{"hook_event_name": "PreToolUse", "session_id": "s1", "tool_name": "BOOM"})
	filePath := writeSpoolFile(t, spoolDir, "s1.jsonl", string(ok)+"\n"+string(bad)+"\n"+string(ok)+"\n")

	first := TailSpoolOnce(db, spoolDir, 1000)
	if first.FilesProcessed != 0 || first.LinesIngested != 0 || first.FilesRetained != 1 {
		t.Fatalf("expected the file to be retained with nothing ingested, got %+v", first)
	}
	if _, err := os.Stat(filePath); err != nil {
		t.Fatalf("expected spool file to survive the failed pass, stat err: %v", err)
	}
	if got := eventCount(t, db); got != 0 {
		t.Fatalf("expected rollback to leave 0 events, got %d", got)
	}

	if _, err := db.Exec(`DROP TRIGGER boom`); err != nil {
		t.Fatalf("drop trigger: %v", err)
	}
	second := TailSpoolOnce(db, spoolDir, 2000)
	if second.FilesProcessed != 1 || second.LinesIngested != 3 || second.FilesRetained != 0 {
		t.Fatalf("expected the retry to ingest all 3 lines, got %+v", second)
	}
	if _, err := os.Stat(filePath); !os.IsNotExist(err) {
		t.Fatalf("expected spool file to be deleted after the successful retry, stat err: %v", err)
	}
	if got := eventCount(t, db); got != 3 {
		t.Fatalf("expected exactly 3 events after retry (no duplicates), got %d", got)
	}
}

func TestTailSpoolOnce_SkipsMalformedLineButStillIngestsRestAndDeletesFile(t *testing.T) {
	db := freshDB(t)
	spoolDir := freshSpoolDir(t)
	ok, _ := json.Marshal(map[string]interface{}{"hook_event_name": "Stop", "session_id": "s1"})
	filePath := writeSpoolFile(t, spoolDir, "s1.jsonl", string(ok)+"\n{not json\n"+string(ok)+"\n")

	result := TailSpoolOnce(db, spoolDir, 1000)
	if result.FilesProcessed != 1 || result.LinesIngested != 2 || result.FilesRetained != 0 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if _, err := os.Stat(filePath); !os.IsNotExist(err) {
		t.Fatalf("expected spool file to be deleted, stat err: %v", err)
	}
	if got := eventCount(t, db); got != 2 {
		t.Fatalf("expected 2 events, got %d", got)
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
	// 5s, and a 25ms poll rather than 10ms: this reader shares the SQLite
	// file with the tailer's writer, and polling too hard starves it. The 2s
	// deadline here is the one that expired on master at 52d558f1 (issue #34).
	deadline := time.Now().Add(5 * time.Second)
	for eventCount(t, db) == 0 && time.Now().Before(deadline) {
		time.Sleep(25 * time.Millisecond)
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

func TestTailSpoolOnce_FailedCommitIsRolledBackSoLaterWritesStillWork(t *testing.T) {
	db := freshDB(t)
	// Production setting (collector.go). It is what turns a poisoned
	// connection into a poisoned collector: the one connection in the pool is
	// the only connection every later write can get.
	db.SetMaxOpenConns(1)
	spoolDir := freshSpoolDir(t)
	// Make COMMIT itself fail while every INSERT succeeds: a deferred foreign
	// key is checked at COMMIT, and SQLite leaves the transaction OPEN when
	// COMMIT fails -- the same post-condition as SQLITE_BUSY at COMMIT, which
	// is what an external reader outliving busy_timeout produces in
	// production. database/sql marks the *sql.Tx done and hands the connection
	// back regardless, so if nothing issued a ROLLBACK on that same connection,
	// every later Begin would fail with "cannot start a transaction within a
	// transaction" until the process restarts.
	//
	// What makes this pass today is the DRIVER, not writeAll: modernc.org/sqlite's
	// tx.Commit checks sqlite3_get_autocommit after a failed COMMIT and forces a
	// rollback itself (tx.go, "database/sql expects the connection to be clean").
	// Verified 2026-09-06 against v1.55.0 with both a deferred-FK failure and a
	// real SQLITE_BUSY from a second handle holding a SHARED lock. This test
	// pins that guarantee: a driver upgrade that drops it turns this red
	// instead of turning the collector read-only until restart.
	for _, stmt := range []string{
		`PRAGMA foreign_keys = ON`,
		`CREATE TABLE parent (id INTEGER PRIMARY KEY)`,
		`CREATE TABLE child (pid INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`,
		`CREATE TRIGGER defer_boom AFTER INSERT ON events WHEN NEW.tool_name = 'BOOM' BEGIN INSERT INTO child (pid) VALUES (999); END;`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	ok, _ := json.Marshal(map[string]interface{}{"hook_event_name": "PreToolUse", "session_id": "s1", "tool_name": "Bash"})
	bad, _ := json.Marshal(map[string]interface{}{"hook_event_name": "PreToolUse", "session_id": "s1", "tool_name": "BOOM"})
	filePath := writeSpoolFile(t, spoolDir, "s1.jsonl", string(ok)+"\n"+string(bad)+"\n"+string(ok)+"\n")

	first := TailSpoolOnce(db, spoolDir, 1000)
	if first.FilesProcessed != 0 || first.LinesIngested != 0 || first.FilesRetained != 1 {
		t.Fatalf("expected the file to be retained after the failed COMMIT, got %+v", first)
	}
	if _, err := os.Stat(filePath); err != nil {
		t.Fatalf("expected spool file to survive the failed COMMIT, stat err: %v", err)
	}
	if got := eventCount(t, db); got != 0 {
		t.Fatalf("expected the failed COMMIT to be rolled back (0 events), got %d", got)
	}

	// The connection must be clean for whoever writes next -- here the retry.
	if _, err := db.Exec(`DROP TRIGGER defer_boom`); err != nil {
		t.Fatalf("drop trigger: %v", err)
	}
	second := TailSpoolOnce(db, spoolDir, 2000)
	if second.FilesProcessed != 1 || second.LinesIngested != 3 || second.FilesRetained != 0 {
		t.Fatalf("expected the retry on a clean connection to ingest all 3 lines, got %+v", second)
	}
	if got := eventCount(t, db); got != 3 {
		t.Fatalf("expected exactly 3 events after retry, got %d", got)
	}
}
