package schema

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

var expectedTables = map[string]bool{
	"schema_meta":           true,
	"events":                true,
	"daily_rollups":         true,
	"drift_log":             true,
	"usage_events":          true,
	"transcript_files":      true,
	"fleet_sessions":        true,
	"tool_calls":            true,
	"dispatches":            true,
	"anomalies":             true,
	"daily_anomaly_rollups": true,
}

func TestMigrateCreatesAllTables(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "sub", "test.db")
	db, err := OpenDatabase(dbPath)
	if err != nil {
		t.Fatalf("OpenDatabase: %v", err)
	}
	defer db.Close()

	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	rows, err := db.Query("SELECT name FROM sqlite_master WHERE type = 'table'")
	if err != nil {
		t.Fatalf("query sqlite_master: %v", err)
	}
	defer rows.Close()

	found := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan: %v", err)
		}
		found[name] = true
	}

	for table := range expectedTables {
		if !found[table] {
			t.Errorf("expected table %q not found; found tables: %v", table, found)
		}
	}
}

func TestGetSchemaVersionAfterMigrate(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	db, err := OpenDatabase(dbPath)
	if err != nil {
		t.Fatalf("OpenDatabase: %v", err)
	}
	defer db.Close()

	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	v, err := GetSchemaVersion(db)
	if err != nil {
		t.Fatalf("GetSchemaVersion: %v", err)
	}
	if v != SchemaVersion {
		t.Errorf("expected version %d, got %d", SchemaVersion, v)
	}
	// The literal is pinned deliberately in exactly one place --
	// TestSchemaVersionMatchesNode in parity_test.go -- so a bump does not
	// break unrelated assertions. Asserting SchemaVersion above is the check
	// that belongs here.
}

func TestGetSchemaVersionNoRowReturnsZero(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	db, err := OpenDatabase(dbPath)
	if err != nil {
		t.Fatalf("OpenDatabase: %v", err)
	}
	defer db.Close()

	// No Migrate call -- schema_meta table doesn't even exist yet.
	v, err := GetSchemaVersion(db)
	if err != nil {
		t.Fatalf("GetSchemaVersion on empty db should not error: %v", err)
	}
	if v != 0 {
		t.Errorf("expected version 0 on empty db, got %d", v)
	}
}

func TestStampFleetHeartbeat(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	db, err := OpenDatabase(dbPath)
	if err != nil {
		t.Fatalf("OpenDatabase: %v", err)
	}
	defer db.Close()

	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	if err := StampFleetHeartbeat(db, 1000); err != nil {
		t.Fatalf("StampFleetHeartbeat: %v", err)
	}
	var value string
	if err := db.QueryRow("SELECT value FROM schema_meta WHERE key = 'fleet_last_poll_ms'").Scan(&value); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if value != "1000" {
		t.Errorf("expected 1000, got %s", value)
	}

	if err := StampFleetHeartbeat(db, 2000); err != nil {
		t.Fatalf("StampFleetHeartbeat second call: %v", err)
	}
	if err := db.QueryRow("SELECT value FROM schema_meta WHERE key = 'fleet_last_poll_ms'").Scan(&value); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if value != "2000" {
		t.Errorf("expected 2000, got %s", value)
	}

	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM schema_meta WHERE key = 'fleet_last_poll_ms'").Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("expected exactly 1 row for fleet_last_poll_ms, got %d", count)
	}
}

func TestStampTranscriptScanHeartbeat(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	db, err := OpenDatabase(dbPath)
	if err != nil {
		t.Fatalf("OpenDatabase: %v", err)
	}
	defer db.Close()

	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	if err := StampTranscriptScanHeartbeat(db, 3000); err != nil {
		t.Fatalf("StampTranscriptScanHeartbeat: %v", err)
	}
	var value string
	if err := db.QueryRow("SELECT value FROM schema_meta WHERE key = 'transcript_last_scan_ms'").Scan(&value); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if value != "3000" {
		t.Errorf("expected 3000, got %s", value)
	}

	if err := StampTranscriptScanHeartbeat(db, 4000); err != nil {
		t.Fatalf("StampTranscriptScanHeartbeat second call: %v", err)
	}
	if err := db.QueryRow("SELECT value FROM schema_meta WHERE key = 'transcript_last_scan_ms'").Scan(&value); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if value != "4000" {
		t.Errorf("expected 4000, got %s", value)
	}

	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM schema_meta WHERE key = 'transcript_last_scan_ms'").Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Errorf("expected exactly 1 row for transcript_last_scan_ms, got %d", count)
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	db, err := OpenDatabase(dbPath)
	if err != nil {
		t.Fatalf("OpenDatabase: %v", err)
	}
	defer db.Close()

	if err := Migrate(db); err != nil {
		t.Fatalf("first Migrate: %v", err)
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("second Migrate should not error: %v", err)
	}

	var indexCount int
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_anomalies_kind_tool_use_id'",
	).Scan(&indexCount); err != nil {
		t.Fatalf("count index: %v", err)
	}
	if indexCount != 1 {
		t.Errorf("expected exactly 1 anomaly dedup index, got %d", indexCount)
	}

	v, err := GetSchemaVersion(db)
	if err != nil {
		t.Fatalf("GetSchemaVersion: %v", err)
	}
	if v != SchemaVersion {
		t.Errorf("expected version %d after idempotent migrate, got %d", SchemaVersion, v)
	}
}

// Regression for issue #41. The point is NOT that busy_timeout is set at all --
// the previous `db.Exec("PRAGMA busy_timeout = 5000")` did set it, on exactly
// one connection. database/sql pools connections and hands later queries
// whichever is free, so a post-open PRAGMA leaves every other connection at the
// driver default of 0. This test holds SEVERAL connections open simultaneously
// and asserts each one carries the timeout, which only a DSN pragma can do.
//
// It fails against the Exec form: the first connection reports 5000 and the
// rest report 0.
func TestOpenDatabaseAppliesBusyTimeoutToEveryPooledConnection(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "pool.db")
	db, err := OpenDatabase(dbPath)
	if err != nil {
		t.Fatalf("OpenDatabase: %v", err)
	}
	defer db.Close()

	// Deliberately NOT calling SetMaxOpenConns(1). Production sets it for an
	// unrelated reason (serialized-access model, see collector.go), and this
	// helper must be correct for callers that do not.
	const want = 5000
	const conns = 4

	ctx := context.Background()
	held := make([]*sql.Conn, 0, conns)
	defer func() {
		for _, c := range held {
			_ = c.Close()
		}
	}()

	// Hold every connection open at once, so the pool is forced to create
	// distinct physical connections rather than handing back the same one.
	for i := 0; i < conns; i++ {
		c, err := db.Conn(ctx)
		if err != nil {
			t.Fatalf("conn %d: %v", i, err)
		}
		held = append(held, c)
	}

	for i, c := range held {
		var got int
		if err := c.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&got); err != nil {
			t.Fatalf("conn %d: read busy_timeout: %v", i, err)
		}
		if got != want {
			t.Errorf("conn %d: busy_timeout = %d, want %d "+
				"(a post-open PRAGMA protects only the connection that ran it)", i, got, want)
		}
	}
}
