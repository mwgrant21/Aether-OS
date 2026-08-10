package spool

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"io"
	"os"
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
	// Tailer tests read this handle while the tailer's own goroutine writes to
	// the same file, so a read can land while the writer holds the lock. With
	// no busy_timeout that surfaces as an immediate
	// `database is locked (5) (SQLITE_BUSY)` rather than a wait -- the latent
	// cause of the spool flake in issue #34.
	//
	// SetMaxOpenConns(1) is required for the pragma to mean anything: a
	// PRAGMA applies to the CONNECTION that ran it, and database/sql hands
	// later queries whichever pooled connection is free -- one that never saw
	// it. Setting the pragma alone leaves the flake in place, which is exactly
	// what happened on the first attempt at this fix.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA busy_timeout = 5000"); err != nil {
		t.Fatalf("set busy_timeout: %v", err)
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

func TestIngestLine_EmptyToolNameString_IsNotDrift_IngestsWithNullToolName(t *testing.T) {
	// canary.ts's checkForDrift operates on the raw JSON payload, where
	// "tool_name": "" is present (not undefined/null) -- so it must NOT be
	// flagged as drift, even though hookPayload.ts's own stringField (a
	// separate, stricter "non-empty string" rule) turns "" into a null
	// tool_name column. This is the regression test for the gap where the
	// Go port originally re-derived "missing" from the already-typed
	// ToolName pointer instead of raw presence.
	db := freshDB(t)
	line, _ := json.Marshal(map[string]interface{}{
		"hook_event_name": "PreToolUse",
		"session_id":      "s1",
		"tool_name":       "",
	})
	if !ingestLine(db, string(line), 1000) {
		t.Fatalf("expected empty-string tool_name to be ingested, not treated as drift")
	}

	var driftCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM drift_log").Scan(&driftCount); err != nil {
		t.Fatalf("count drift_log: %v", err)
	}
	if driftCount != 0 {
		t.Fatalf("expected 0 drift_log rows, got %d", driftCount)
	}

	var toolName sql.NullString
	if err := db.QueryRow("SELECT tool_name FROM events").Scan(&toolName); err != nil {
		t.Fatalf("query events: %v", err)
	}
	if toolName.Valid {
		t.Fatalf("expected null tool_name column, got %q", toolName.String)
	}
}

// The double-parse refactor (Task 5, Minor #11) moved the raw-JSON ->
// map[string]interface{} shape assertion out of ParseHookPayload and into
// ingestLine itself (so ingestLine can hand the already-parsed map straight
// to parseHookPayloadFromObj instead of re-unmarshaling the same bytes).
// This is the regression test for that moved assertion: a syntactically
// valid but non-object top-level JSON value (an array here) must still be
// skipped, not passed to parseHookPayloadFromObj as if it were a map.
func TestIngestLine_NonObjectTopLevelJSON_ReturnsFalse(t *testing.T) {
	db := freshDB(t)
	if ingestLine(db, "[1,2,3]", 1000) {
		t.Fatalf("expected non-object top-level JSON to not be ingested")
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM events").Scan(&count); err != nil {
		t.Fatalf("count events: %v", err)
	}
	if count != 0 {
		t.Fatalf("expected 0 events, got %d", count)
	}
}

func TestIngestLine_EmptyString_NeverPanicsReturnsFalse(t *testing.T) {
	db := freshDB(t)
	if ingestLine(db, "", 1000) {
		t.Fatalf("expected empty line to not be ingested")
	}
}

// captureStderr swaps os.Stderr for a pipe for the duration of fn and returns
// everything written to it. canary.LogDrift reads os.Stderr at call time, so
// swapping the package variable is enough. Not parallel-safe -- callers must
// not t.Parallel().
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	orig := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	os.Stderr = w
	done := make(chan string, 1)
	go func() {
		var buf bytes.Buffer
		_, _ = io.Copy(&buf, r)
		done <- buf.String()
	}()
	fn()
	w.Close()
	os.Stderr = orig
	out := <-done
	r.Close()
	return out
}

// Regression test for a real port bug found by Task 9's golden-file parity
// run. ingest.ts runs canary.ts's checkForDrift against the RAW payload
// (ingest.ts:22) BEFORE parseHookPayload (ingest.ts:37), so a known hook
// event that is missing both its required field AND its session_id still
// produces a drift_log row even though the line is then skipped as
// unparseable. The Go port originally folded the drift check into
// IngestHookEvent, which only ever runs on a successfully-parsed payload --
// so this class of line silently produced no drift row at all.
func TestIngestLine_KnownEventMissingRequiredFieldAndUnparseable_StillLogsDrift(t *testing.T) {
	cases := []map[string]interface{}{
		// PostToolUse with no tool_name and no session_id.
		{"hook_event_name": "PostToolUse", "cwd": `C:\projects\x`},
		// Notification with an explicitly-null notification_type and an
		// empty-string session_id (stringField treats "" as absent).
		{"hook_event_name": "Notification", "session_id": "", "notification_type": nil},
	}
	for _, raw := range cases {
		db := freshDB(t)
		line, _ := json.Marshal(raw)
		if ingestLine(db, string(line), 1000) {
			t.Fatalf("expected unparseable line to not be ingested: %s", line)
		}

		var driftCount int
		if err := db.QueryRow("SELECT COUNT(*) FROM drift_log").Scan(&driftCount); err != nil {
			t.Fatalf("count drift_log: %v", err)
		}
		if driftCount != 1 {
			t.Fatalf("expected 1 drift_log row for %s, got %d", line, driftCount)
		}

		var eventCount int
		if err := db.QueryRow("SELECT COUNT(*) FROM events").Scan(&eventCount); err != nil {
			t.Fatalf("count events: %v", err)
		}
		if eventCount != 0 {
			t.Fatalf("expected the line to be skipped, got %d events rows", eventCount)
		}
	}
}

// canary.ts's logDrift is loud on purpose: console.error plus the drift_log
// row. The Go port's spool package originally wrote the row with a bare
// db.Exec and emitted nothing, so a live contract drift left no
// operator-visible trace in the collector's console output.
func TestIngestLine_Drift_WritesLoudStderrLine(t *testing.T) {
	db := freshDB(t)
	line, _ := json.Marshal(map[string]interface{}{"hook_event_name": "PreToolUse", "session_id": "s1"})
	out := captureStderr(t, func() { ingestLine(db, string(line), 1000) })
	const want = "[aether-collector] contract drift detected: PreToolUse payload missing expected field(s): tool_name"
	if !strings.Contains(out, want) {
		t.Fatalf("expected stderr to contain %q, got %q", want, out)
	}
}
