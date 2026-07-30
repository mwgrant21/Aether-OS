package retention

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

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

func insertEvent(t *testing.T, db *sql.DB, occurredAtMs int64, toolName string) {
	t.Helper()
	_, err := db.Exec(
		`INSERT INTO events (hook_event_name, session_id, project_rel_path, tool_name, had_tool_input, had_tool_response, notification_type, occurred_at_ms)
		 VALUES ('PreToolUse', 's1', NULL, ?, 1, 0, NULL, ?)`,
		toolName, occurredAtMs,
	)
	if err != nil {
		t.Fatalf("insert event: %v", err)
	}
}

func insertEventNoTool(t *testing.T, db *sql.DB, hookEventName string, occurredAtMs int64) {
	t.Helper()
	_, err := db.Exec(
		`INSERT INTO events (hook_event_name, session_id, project_rel_path, tool_name, had_tool_input, had_tool_response, notification_type, occurred_at_ms)
		 VALUES (?, 's1', NULL, NULL, 0, 0, NULL, ?)`,
		hookEventName, occurredAtMs,
	)
	if err != nil {
		t.Fatalf("insert event (no tool): %v", err)
	}
}

func mustParse(t *testing.T, layout, value string) int64 {
	t.Helper()
	tm, err := time.Parse(layout, value)
	if err != nil {
		t.Fatalf("parse time %q: %v", value, err)
	}
	return tm.UnixMilli()
}

func TestCompact_RollsUpAndDeletesRowsOlderThanWindow_LeavesRecentUntouched(t *testing.T) {
	db := freshDB(t)
	now := mustParse(t, time.RFC3339, "2026-08-01T00:00:00Z")
	oldDay := mustParse(t, time.RFC3339, "2026-06-01T10:00:00Z") // well past 30 days
	recentDay := now - 60_000                                    // 1 minute ago

	insertEvent(t, db, oldDay, "Bash")
	insertEvent(t, db, oldDay, "Bash")
	insertEvent(t, db, oldDay, "Read")
	insertEvent(t, db, recentDay, "Bash")

	result, err := Compact(db, now)
	if err != nil {
		t.Fatalf("compact: %v", err)
	}
	if result.RolledUpDays != 1 {
		t.Errorf("RolledUpDays = %d, want 1", result.RolledUpDays)
	}
	if result.DeletedRows != 3 {
		t.Errorf("DeletedRows = %d, want 3", result.DeletedRows)
	}

	var remaining int
	if err := db.QueryRow(`SELECT COUNT(*) FROM events`).Scan(&remaining); err != nil {
		t.Fatalf("count events: %v", err)
	}
	if remaining != 1 {
		t.Errorf("remaining events = %d, want 1 (only the recent row survives)", remaining)
	}

	rows, err := db.Query(`SELECT day, hook_event_name, tool_name, event_count FROM daily_rollups ORDER BY tool_name`)
	if err != nil {
		t.Fatalf("query rollups: %v", err)
	}
	defer rows.Close()
	type rollup struct {
		day, hookEventName, toolName string
		count                        int
	}
	var got []rollup
	for rows.Next() {
		var r rollup
		if err := rows.Scan(&r.day, &r.hookEventName, &r.toolName, &r.count); err != nil {
			t.Fatalf("scan rollup: %v", err)
		}
		got = append(got, r)
	}
	want := []rollup{
		{day: "2026-06-01", hookEventName: "PreToolUse", toolName: "Bash", count: 2},
		{day: "2026-06-01", hookEventName: "PreToolUse", toolName: "Read", count: 1},
	}
	if len(got) != len(want) {
		t.Fatalf("rollups = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("rollup[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestCompact_IsIdempotent(t *testing.T) {
	db := freshDB(t)
	now := mustParse(t, time.RFC3339, "2026-08-01T00:00:00Z")
	oldDay := mustParse(t, time.RFC3339, "2026-06-01T10:00:00Z")
	insertEvent(t, db, oldDay, "Bash")

	if _, err := Compact(db, now); err != nil {
		t.Fatalf("first compact: %v", err)
	}
	second, err := Compact(db, now)
	if err != nil {
		t.Fatalf("second compact: %v", err)
	}
	if second.RolledUpDays != 0 {
		t.Errorf("second.RolledUpDays = %d, want 0", second.RolledUpDays)
	}
	if second.DeletedRows != 0 {
		t.Errorf("second.DeletedRows = %d, want 0", second.DeletedRows)
	}

	var count int
	if err := db.QueryRow(`SELECT event_count FROM daily_rollups`).Scan(&count); err != nil {
		t.Fatalf("query rollup count: %v", err)
	}
	if count != 1 {
		t.Errorf("rollup event_count = %d, want 1", count)
	}
}

func TestCompact_LeavesDayWithNoStaleEventsUntouched(t *testing.T) {
	db := freshDB(t)
	now := mustParse(t, time.RFC3339, "2026-08-01T00:00:00Z")
	result, err := Compact(db, now)
	if err != nil {
		t.Fatalf("compact: %v", err)
	}
	if result != (CompactResult{RolledUpDays: 0, DeletedRows: 0}) {
		t.Errorf("result = %+v, want zero value", result)
	}
}

func TestRetentionWindowMs_IsExactly30Days(t *testing.T) {
	want := int64(30 * 24 * 60 * 60 * 1000)
	if RetentionWindowMs != want {
		t.Errorf("RetentionWindowMs = %d, want %d", RetentionWindowMs, want)
	}
}

func TestCompact_DedupesRollupsForNullToolNameAcrossRepeatedCompaction(t *testing.T) {
	// Regression test: SQLite treats NULL as distinct from every other NULL in
	// a PRIMARY KEY, so ON CONFLICT(day, hook_event_name, tool_name) never
	// fired when tool_name was left as raw NULL, producing duplicate rollup
	// rows on a second Compact() call. tool_name must be normalized to '' for
	// every row before it is ever written to daily_rollups.
	db := freshDB(t)
	now := mustParse(t, time.RFC3339, "2026-08-01T00:00:00Z")
	oldDay1 := mustParse(t, time.RFC3339, "2026-06-01T10:00:00Z")
	oldDay2 := mustParse(t, time.RFC3339, "2026-06-01T11:00:00Z")

	insertEventNoTool(t, db, "Stop", oldDay1)
	first, err := Compact(db, now)
	if err != nil {
		t.Fatalf("first compact: %v", err)
	}
	if first.RolledUpDays != 1 || first.DeletedRows != 1 {
		t.Errorf("first = %+v, want {RolledUpDays:1 DeletedRows:1}", first)
	}

	// A second, later compaction with more stale events on the SAME
	// day/event must merge into the existing rollup row, not create a
	// duplicate.
	insertEventNoTool(t, db, "Stop", oldDay2)
	second, err := Compact(db, now)
	if err != nil {
		t.Fatalf("second compact: %v", err)
	}
	if second.RolledUpDays != 1 || second.DeletedRows != 1 {
		t.Errorf("second = %+v, want {RolledUpDays:1 DeletedRows:1}", second)
	}

	rows, err := db.Query(`SELECT day, hook_event_name, tool_name, event_count FROM daily_rollups WHERE day = '2026-06-01' AND hook_event_name = 'Stop'`)
	if err != nil {
		t.Fatalf("query rollups: %v", err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var day, hookEventName, toolName string
		var eventCount int
		if err := rows.Scan(&day, &hookEventName, &toolName, &eventCount); err != nil {
			t.Fatalf("scan: %v", err)
		}
		count++
		if day != "2026-06-01" || hookEventName != "Stop" || toolName != "" || eventCount != 2 {
			t.Errorf("row = {%q %q %q %d}, want {2026-06-01 Stop \"\" 2}", day, hookEventName, toolName, eventCount)
		}
	}
	if count != 1 {
		t.Errorf("row count = %d, want 1 (no duplicate rollup row)", count)
	}
}

func TestCompact_DeletesStaleDriftLogRowsLeavingRecentUntouched(t *testing.T) {
	// Regression test: fleet-poll failures (fleet.PollFleet) can write a
	// drift_log row every 15s indefinitely on a sustained failure, unlike the
	// pre-existing rare hook-payload-drift writes this table was originally
	// sized for. drift_log needs the same 30-day retention `events` already
	// has, or it grows unbounded.
	db := freshDB(t)
	now := mustParse(t, time.RFC3339, "2026-08-01T00:00:00Z")
	oldDay := mustParse(t, time.RFC3339, "2026-06-01T10:00:00Z") // well past 30 days
	recent := now - 60_000                                       // 1 minute ago

	if _, err := db.Exec(`INSERT INTO drift_log (detected_at_ms, detail) VALUES (?, ?)`, oldDay, "old drift"); err != nil {
		t.Fatalf("insert old drift: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO drift_log (detected_at_ms, detail) VALUES (?, ?)`, recent, "recent drift"); err != nil {
		t.Fatalf("insert recent drift: %v", err)
	}

	if _, err := Compact(db, now); err != nil {
		t.Fatalf("compact: %v", err)
	}

	rows, err := db.Query(`SELECT detail FROM drift_log ORDER BY detected_at_ms`)
	if err != nil {
		t.Fatalf("query drift_log: %v", err)
	}
	defer rows.Close()
	var details []string
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			t.Fatalf("scan: %v", err)
		}
		details = append(details, d)
	}
	if len(details) != 1 || details[0] != "recent drift" {
		t.Errorf("details = %v, want [recent drift]", details)
	}
}

func TestCompact_DeletesStaleDriftLogEvenWithZeroStaleEvents(t *testing.T) {
	// Regression test for the early-return trap: compact() must not return
	// immediately when `events` has no stale rows -- that would skip the
	// drift_log deletion entirely on a cycle where only drift_log (not
	// events) had aged-out rows.
	db := freshDB(t)
	now := mustParse(t, time.RFC3339, "2026-08-01T00:00:00Z")
	oldDay := mustParse(t, time.RFC3339, "2026-06-01T10:00:00Z")

	if _, err := db.Exec(`INSERT INTO drift_log (detected_at_ms, detail) VALUES (?, ?)`, oldDay, "old drift"); err != nil {
		t.Fatalf("insert old drift: %v", err)
	}

	result, err := Compact(db, now)
	if err != nil {
		t.Fatalf("compact: %v", err)
	}
	if result != (CompactResult{RolledUpDays: 0, DeletedRows: 0}) {
		t.Errorf("result = %+v, want zero value", result)
	}

	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM drift_log`).Scan(&count); err != nil {
		t.Fatalf("count drift_log: %v", err)
	}
	if count != 0 {
		t.Errorf("drift_log count = %d, want 0", count)
	}
}

func TestCompact_RollsUpAnomaliesAndDeletesStaleToolCallsAndDispatchesUnconditionally(t *testing.T) {
	db := freshDB(t)
	oldMs := time.Now().UnixMilli() - RetentionWindowMs - 1000

	if _, err := db.Exec(`INSERT INTO anomalies (kind, tool_use_id, detail, detected_at_ms) VALUES ('reReadLoop', 'tu_1', 'x', ?)`, oldMs); err != nil {
		t.Fatalf("insert anomaly: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO tool_calls (tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms) VALUES ('tu_2', 'Read', 'a.ts', ?, ?)`, oldMs, oldMs); err != nil {
		t.Fatalf("insert tool_call: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO dispatches (tool_use_id, tokens, tool_uses, duration_ms, started_at_ms, ended_at_ms) VALUES ('tu_3', 100, 1, 500, ?, ?)`, oldMs, oldMs); err != nil {
		t.Fatalf("insert dispatch: %v", err)
	}

	if _, err := Compact(db, time.Now().UnixMilli()); err != nil {
		t.Fatalf("compact: %v", err)
	}

	var anomalies, toolCalls, dispatches int
	if err := db.QueryRow(`SELECT COUNT(*) FROM anomalies`).Scan(&anomalies); err != nil {
		t.Fatalf("count anomalies: %v", err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM tool_calls`).Scan(&toolCalls); err != nil {
		t.Fatalf("count tool_calls: %v", err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM dispatches`).Scan(&dispatches); err != nil {
		t.Fatalf("count dispatches: %v", err)
	}
	if anomalies != 0 || toolCalls != 0 || dispatches != 0 {
		t.Errorf("anomalies=%d toolCalls=%d dispatches=%d, want all 0", anomalies, toolCalls, dispatches)
	}

	var rollupCount int
	if err := db.QueryRow(`SELECT anomaly_count FROM daily_anomaly_rollups WHERE kind = 'reReadLoop'`).Scan(&rollupCount); err != nil {
		t.Fatalf("query daily_anomaly_rollups: %v", err)
	}
	if rollupCount != 1 {
		t.Errorf("rollupCount = %d, want 1", rollupCount)
	}
}
