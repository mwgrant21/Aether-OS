package canary

import (
	"database/sql"
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

func TestCheckForDrift_NoDriftForWellFormedPreToolUsePayload(t *testing.T) {
	db := freshDB(t)
	CheckForDrift(map[string]interface{}{
		"hook_event_name": "PreToolUse",
		"session_id":      "s1",
		"tool_name":       "Bash",
	}, db, 1000)

	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM drift_log`).Scan(&count); err != nil {
		t.Fatalf("count drift_log: %v", err)
	}
	if count != 0 {
		t.Errorf("drift_log count = %d, want 0", count)
	}
}

func TestCheckForDrift_LogsDriftWhenPreToolUseMissingToolName(t *testing.T) {
	db := freshDB(t)
	CheckForDrift(map[string]interface{}{
		"hook_event_name": "PreToolUse",
		"session_id":      "s1",
	}, db, 2000)

	rows, err := db.Query(`SELECT detected_at_ms, detail FROM drift_log`)
	if err != nil {
		t.Fatalf("query drift_log: %v", err)
	}
	defer rows.Close()
	var got []struct {
		detectedAtMs int64
		detail       string
	}
	for rows.Next() {
		var r struct {
			detectedAtMs int64
			detail       string
		}
		if err := rows.Scan(&r.detectedAtMs, &r.detail); err != nil {
			t.Fatalf("scan: %v", err)
		}
		got = append(got, r)
	}
	if len(got) != 1 {
		t.Fatalf("drift_log rows = %d, want 1", len(got))
	}
	if got[0].detectedAtMs != 2000 {
		t.Errorf("detected_at_ms = %d, want 2000", got[0].detectedAtMs)
	}
	if !containsAll(got[0].detail, "PreToolUse", "tool_name") {
		t.Errorf("detail = %q, want to contain PreToolUse and tool_name", got[0].detail)
	}
}

func TestCheckForDrift_LogsDriftWhenNotificationMissingNotificationType(t *testing.T) {
	db := freshDB(t)
	CheckForDrift(map[string]interface{}{
		"hook_event_name": "Notification",
		"session_id":      "s1",
	}, db, 3000)

	var count int
	var detail string
	if err := db.QueryRow(`SELECT COUNT(*), COALESCE(MAX(detail), '') FROM drift_log`).Scan(&count, &detail); err != nil {
		t.Fatalf("query drift_log: %v", err)
	}
	if count != 1 {
		t.Fatalf("drift_log rows = %d, want 1", count)
	}
	if !containsAll(detail, "notification_type") {
		t.Errorf("detail = %q, want to contain notification_type", detail)
	}
}

func TestCheckForDrift_DoesNotPanicOrLogForNonObjectOrUnrecognizedEvent(t *testing.T) {
	db := freshDB(t)

	// Must not panic for any of these.
	CheckForDrift(nil, db, 4000)
	CheckForDrift("not an object", db, 4000)
	CheckForDrift(map[string]interface{}{"hook_event_name": "FutureEvent"}, db, 4000)

	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM drift_log`).Scan(&count); err != nil {
		t.Fatalf("count drift_log: %v", err)
	}
	if count != 0 {
		t.Errorf("drift_log count = %d, want 0", count)
	}
}

func containsAll(s string, subs ...string) bool {
	for _, sub := range subs {
		if !strings.Contains(s, sub) {
			return false
		}
	}
	return true
}
