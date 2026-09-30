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
	if SchemaVersion != 9 {
		t.Errorf("SchemaVersion = %d, want 9 to match collector/src/schema.ts", SchemaVersion)
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

func TestMigrateHealsAnAlreadyDowngradedDatabase(t *testing.T) {
	// The state the pre-#31 Go collector left behind: physically at v6/v7,
	// recorded as 4. Version-gated ALTERs then re-ran against existing
	// columns and threw `duplicate column name`, so an affected machine could
	// not be rescued by upgrading. #31's guard stopped new occurrences but
	// healed nothing already broken.
	db := freshDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	if _, err := db.Exec(`UPDATE schema_meta SET value = '4' WHERE key = 'version'`); err != nil {
		t.Fatalf("simulate downgrade: %v", err)
	}

	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate on an already-downgraded database: %v", err)
	}

	got, err := GetSchemaVersion(db)
	if err != nil {
		t.Fatalf("GetSchemaVersion: %v", err)
	}
	if got != SchemaVersion {
		t.Errorf("recorded version = %d, want %d after healing", got, SchemaVersion)
	}
	cols := columns(t, db, "dispatches")
	for _, c := range v5DispatchColumns {
		if !cols[c] {
			t.Errorf("dispatches lost v5 column %q while healing", c)
		}
	}
}

func usageNotNull(t *testing.T, db *sql.DB) map[string]int {
	t.Helper()
	rows, err := db.Query(`SELECT name, "notnull" FROM pragma_table_info('dispatches') WHERE name IN ('tokens','tool_uses','duration_ms')`)
	if err != nil {
		t.Fatalf("pragma: %v", err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var n string
		var nn int
		if err := rows.Scan(&n, &nn); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out[n] = nn
	}
	if len(out) != 3 {
		t.Fatalf("pragma returned %d usage columns, want 3 (tokens, tool_uses, duration_ms): %v", len(out), out)
	}
	return out
}

func TestMigrateMakesDispatchUsageNullable(t *testing.T) {
	db := freshDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	for c, nn := range usageNotNull(t, db) {
		if nn != 0 {
			t.Errorf("dispatches.%s notnull = %d, want 0", c, nn)
		}
	}
}

func TestMigrateRebuildsNotNullDispatchesPreservingRows(t *testing.T) {
	db := freshDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	// One statement per Exec: do not rely on the driver running a multi-statement string.
	for _, stmt := range []string{
		`DROP TABLE dispatches`,
		`CREATE TABLE dispatches (tool_use_id TEXT PRIMARY KEY, tokens INTEGER NOT NULL, tool_uses INTEGER NOT NULL,
		duration_ms INTEGER NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER NOT NULL, agent_id TEXT, task_kind TEXT,
		session_id TEXT, retries INTEGER NOT NULL DEFAULT 0, exit_state TEXT NOT NULL DEFAULT 'ok', severity INTEGER, median_ms_at_eval INTEGER)`,
		`INSERT INTO dispatches VALUES ('tu_a', 1200, 7, 65000, 1000, 66000, 'x', 'x', 's1', 0, 'ok', 1, NULL)`,
		`UPDATE schema_meta SET value = '8' WHERE key = 'version'`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("seed v8 shape: %v", err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := Migrate(db); err != nil {
			t.Fatalf("Migrate run %d: %v", i+1, err)
		}
	}
	for c, nn := range usageNotNull(t, db) {
		if nn != 0 {
			t.Errorf("after rebuild dispatches.%s notnull = %d, want 0", c, nn)
		}
	}
	var tokens, dur int
	if err := db.QueryRow(`SELECT tokens, duration_ms FROM dispatches WHERE tool_use_id = 'tu_a'`).Scan(&tokens, &dur); err != nil {
		t.Fatalf("row lost in rebuild: %v", err)
	}
	if tokens != 1200 || dur != 65000 {
		t.Errorf("row values changed: tokens=%d duration=%d", tokens, dur)
	}
}

// A database stamped 9 (by the Node collector) but physically NOT NULL must heal.
func TestMigrateHealsStamped9NotNullDispatches(t *testing.T) {
	db := freshDB(t)
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	for _, stmt := range []string{
		`DROP TABLE dispatches`,
		`CREATE TABLE dispatches (tool_use_id TEXT PRIMARY KEY, tokens INTEGER NOT NULL, tool_uses INTEGER NOT NULL,
		duration_ms INTEGER NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER NOT NULL, agent_id TEXT, task_kind TEXT,
		session_id TEXT, retries INTEGER NOT NULL DEFAULT 0, exit_state TEXT NOT NULL DEFAULT 'ok', severity INTEGER, median_ms_at_eval INTEGER)`,
		`INSERT INTO dispatches VALUES ('tu_a', 1200, 7, 65000, 1000, 66000, 'x', 'x', 's1', 0, 'ok', 1, NULL)`,
		`UPDATE schema_meta SET value = '9' WHERE key = 'version'`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	for c, nn := range usageNotNull(t, db) {
		if nn != 0 {
			t.Errorf("dispatches.%s notnull = %d, want 0", c, nn)
		}
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM dispatches`).Scan(&n); err != nil || n != 1 {
		t.Errorf("rows = %d err=%v, want 1", n, err)
	}
}
