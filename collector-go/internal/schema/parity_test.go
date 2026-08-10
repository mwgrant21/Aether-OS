package schema

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func freshDB(t *testing.T) *sql.DB {
	t.Helper()
	dir, err := os.MkdirTemp("", "aether-schema-parity-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	db, err := OpenDatabase(filepath.Join(dir, "s.db"))
	if err != nil {
		t.Fatalf("OpenDatabase: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func columns(t *testing.T, db *sql.DB, table string) map[string]bool {
	t.Helper()
	rows, err := db.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		t.Fatalf("pragma_table_info(%s): %v", table, err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out[n] = true
	}
	return out
}

// The Node collector is the reference implementation; these are the columns
// its v5 and v6 migrations add. See collector/src/schema.ts.
var v5DispatchColumns = []string{
	"agent_id", "task_kind", "session_id", "retries", "exit_state", "severity", "median_ms_at_eval",
}

func TestSchemaVersionMatchesNode(t *testing.T) {
	// Node's SCHEMA_VERSION. Both collectors write the SAME database, so a
	// mismatch here is not cosmetic -- see TestMigrateNeverLowersRecordedVersion.
	if SchemaVersion != 7 {
		t.Errorf("SchemaVersion = %d, want 7 to match collector/src/schema.ts", SchemaVersion)
	}
}

func TestMigrateAddsV5DispatchTelemetryColumns(t *testing.T) {
	db := freshDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	cols := columns(t, db, "dispatches")
	for _, c := range v5DispatchColumns {
		if !cols[c] {
			t.Errorf("dispatches is missing v5 column %q", c)
		}
	}
}

func TestMigrateAddsV6SourceFileRel(t *testing.T) {
	db := freshDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	if !columns(t, db, "tool_calls")["source_file_rel"] {
		t.Error("tool_calls is missing v6 column source_file_rel")
	}
}

func TestMigrateNeverLowersRecordedVersion(t *testing.T) {
	// The defect this guards (issue #31): Migrate stamped the version
	// unconditionally, so running this collector against a database migrated
	// by a NEWER one rewrote the recorded version downwards. The next run of
	// that newer collector then re-applied migrations whose columns already
	// existed and threw.
	db := freshDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	// Simulate a future collector having migrated this database.
	if _, err := db.Exec(`UPDATE schema_meta SET value = '99' WHERE key = 'version'`); err != nil {
		t.Fatalf("seed future version: %v", err)
	}

	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate on a newer database: %v", err)
	}

	got, err := GetSchemaVersion(db)
	if err != nil {
		t.Fatalf("GetSchemaVersion: %v", err)
	}
	if got != 99 {
		t.Errorf("recorded version = %d, want it left at 99 -- this collector must never downgrade it", got)
	}
}

func TestMigrateIsIdempotentAcrossRuns(t *testing.T) {
	db := freshDB(t)
	for i := 0; i < 3; i++ {
		if err := Migrate(db); err != nil {
			t.Fatalf("Migrate run %d: %v", i+1, err)
		}
	}
	cols := columns(t, db, "dispatches")
	for _, c := range v5DispatchColumns {
		if !cols[c] {
			t.Errorf("dispatches lost v5 column %q after repeated migrate", c)
		}
	}
}
