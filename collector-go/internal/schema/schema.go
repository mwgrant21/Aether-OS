// Package schema owns the collector's SQLite schema: opening the database,
// running migrations, and stamping/reading the heartbeat and version rows in
// schema_meta. This is the Go port of collector/src/schema.ts -- every other
// package that touches the database imports this one and uses these
// functions rather than opening its own connection or redefining the schema.
package schema

import (
	"database/sql"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	_ "modernc.org/sqlite"
)

// SchemaVersion mirrors schema.ts's SCHEMA_VERSION. Both collectors write
// the SAME database, so these MUST move together -- see issue #31 and
// internal/schema/parity_test.go.
const SchemaVersion = 8

// tableColumns returns the columns physically present on a table, regardless
// of what schema_meta claims. Migrations are driven off THIS, not off the
// recorded version.
//
// A database can be physically ahead of its recorded version: this collector
// used to stamp the version back to 4 on a v6/v7 database (issue #31), which
// made the version-gated ALTERs re-run against existing columns and throw
// `duplicate column name`. That threw at the Node collector's index.ts:49,
// unguarded, so an affected machine could not be rescued by upgrading either
// collector. Checking the column set heals that state rather than merely
// refusing to create more of it.
func tableColumns(db *sql.DB, table string) (map[string]bool, error) {
	rows, err := db.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out[n] = true
	}
	return out, rows.Err()
}

func addColumnIfMissing(db *sql.DB, table, column, ddl string) error {
	cols, err := tableColumns(db, table)
	if err != nil {
		return err
	}
	if cols[column] {
		return nil
	}
	_, err = db.Exec("ALTER TABLE " + table + " ADD COLUMN " + ddl)
	return err
}

// OpenDatabase opens (creating if necessary) the SQLite database at dbPath,
// creating the parent directory first. Matches schema.ts:14's
// mkdirSync(dirname(dbPath), { recursive: true }).
func OpenDatabase(dbPath string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0755); err != nil {
		return nil, err
	}
	// modernc.org/sqlite's default busy_timeout is 0: a writer that finds the
	// file locked by another connection (a concurrent collector process, a
	// reader on the Electron side, or -- in tests -- a second *sql.DB opened
	// against the same file) gets an immediate SQLITE_BUSY instead of
	// retrying. Every OpenDatabase caller shares one file with other
	// processes/handles by design.
	//
	// This MUST be a DSN parameter, not a post-open `db.Exec("PRAGMA ...")`.
	// A PRAGMA applies only to the connection that ran it, and database/sql
	// hands later queries whichever pooled connection is free -- one that
	// never saw it. The previous Exec form therefore protected exactly one
	// connection, and only looked correct here because the single production
	// caller also sets SetMaxOpenConns(1) for its own unrelated reason (see
	// collector.go: restoring the TS original's serialized-access model).
	// Any second caller, or any future pool > 1, silently got busy_timeout=0.
	// A DSN pragma is applied by the driver as each connection is opened, so
	// it holds for every connection in the pool regardless of caller.
	db, err := sql.Open("sqlite", dbPath+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	return db, nil
}

// Migrate creates all 11 tables (if not already present), the anomaly-dedup
// unique index, and stamps the schema_meta 'version' row. Safe to call
// repeatedly (idempotent).
func Migrate(db *sql.DB) error {
	const ddl = `
	CREATE TABLE IF NOT EXISTS schema_meta (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		hook_event_name TEXT NOT NULL,
		session_id TEXT NOT NULL,
		project_rel_path TEXT,
		tool_name TEXT,
		had_tool_input INTEGER NOT NULL,
		had_tool_response INTEGER NOT NULL,
		notification_type TEXT,
		occurred_at_ms INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS daily_rollups (
		day TEXT NOT NULL,
		hook_event_name TEXT NOT NULL,
		tool_name TEXT,
		event_count INTEGER NOT NULL,
		PRIMARY KEY (day, hook_event_name, tool_name)
	);
	CREATE TABLE IF NOT EXISTS drift_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		detected_at_ms INTEGER NOT NULL,
		detail TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS usage_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		occurred_at_ms INTEGER NOT NULL,
		model TEXT,
		input_tokens INTEGER NOT NULL,
		output_tokens INTEGER NOT NULL,
		cache_creation_input_tokens INTEGER NOT NULL,
		cache_read_input_tokens INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS transcript_files (
		file_path TEXT PRIMARY KEY,
		last_offset INTEGER NOT NULL,
		last_scanned_ms INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS fleet_sessions (
		session_id TEXT PRIMARY KEY,
		pid INTEGER,
		project_name TEXT NOT NULL,
		kind TEXT NOT NULL,
		status TEXT NOT NULL,
		name TEXT NOT NULL,
		started_at_ms INTEGER NOT NULL,
		last_seen_ms INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS tool_calls (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		tool_use_id TEXT NOT NULL,
		tool_name TEXT NOT NULL,
		file_path_rel TEXT,
		started_at_ms INTEGER NOT NULL,
		closed_at_ms INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS dispatches (
		tool_use_id TEXT PRIMARY KEY,
		tokens INTEGER NOT NULL,
		tool_uses INTEGER NOT NULL,
		duration_ms INTEGER NOT NULL,
		started_at_ms INTEGER NOT NULL,
		ended_at_ms INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS anomalies (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		kind TEXT NOT NULL,
		tool_use_id TEXT NOT NULL,
		detail TEXT NOT NULL,
		detected_at_ms INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS daily_anomaly_rollups (
		day TEXT NOT NULL,
		kind TEXT NOT NULL,
		anomaly_count INTEGER NOT NULL,
		PRIMARY KEY (day, kind)
	);
	`
	if _, err := db.Exec(ddl); err != nil {
		return err
	}

	// Anomaly dedup: the detectors re-scan a rolling 5-minute window on every
	// ~15s scan tick, so one real anomaly is re-detected on ~20 consecutive
	// ticks. This unique index (together with the INSERT OR IGNORE in
	// anomalyIngest.ts) collapses those repeats to a single row. Duplicates
	// written by an earlier build of this branch are collapsed first so the
	// index can be created on an existing dev database. Deliberately NO
	// SCHEMA_VERSION bump: an index adds no column or table, and readers gated
	// on version >= 4 see the identical row shape.
	const dedup = `
	DELETE FROM anomalies WHERE id NOT IN (
		SELECT MIN(id) FROM anomalies GROUP BY kind, tool_use_id
	);
	CREATE UNIQUE INDEX IF NOT EXISTS idx_anomalies_kind_tool_use_id
		ON anomalies (kind, tool_use_id);
	`
	if _, err := db.Exec(dedup); err != nil {
		return err
	}

	// Conditional migrations, mirroring schema.ts's v5/v6/v7 blocks. Read the
	// recorded version once, before applying any of them.
	current, err := GetSchemaVersion(db)
	if err != nil {
		return err
	}

	// v5: dispatches telemetry columns. Column-driven, not version-gated --
	// see tableColumns above. Safe on a database physically ahead of its
	// recorded version.
	if current < 5 {
		for _, c := range [][2]string{
			{"agent_id", "agent_id TEXT"},
			{"task_kind", "task_kind TEXT"},
			{"session_id", "session_id TEXT"},
			{"retries", "retries INTEGER NOT NULL DEFAULT 0"},
			{"exit_state", "exit_state TEXT NOT NULL DEFAULT 'ok'"},
			{"severity", "severity INTEGER"},
			{"median_ms_at_eval", "median_ms_at_eval INTEGER"},
		} {
			if err := addColumnIfMissing(db, "dispatches", c[0], c[1]); err != nil {
				return err
			}
		}
	}

	// v6: the source-file correlation column. Rows written under schema < 6
	// keep it NULL, which readers must treat as "predates exact correlation",
	// not "not part of a dispatch". This collector does not yet POPULATE it --
	// that is issue #32 -- but the column must exist so the two collectors
	// agree on shape.
	if current < 6 {
		if err := addColumnIfMissing(db, "tool_calls", "source_file_rel", "source_file_rel TEXT"); err != nil {
			return err
		}
	}

	// v8: attribute each usage event to the transcript it came from, mirroring
	// tool_calls.source_file_rel. Rows written before v8 keep it NULL, which
	// readers must treat as "predates attribution", never as "unattached".
	//
	// This REPLACES the v7 one-time nested-usage backfill, which is
	// deliberately gone. That backfill decided whether history was missing by
	// asking only whether a nested offset existed -- and a nested offset looks
	// identical whether written by a legacy Node collector (usage never
	// ingested) or by a usage-aware Go collector (usage already ingested).
	// Replaying the second case double counts real spend, and no pre-v8
	// database carries the attribution needed to tell them apart. Guessing was
	// the defect; the flag is cleared rather than acted on.
	if current < 8 {
		if err := addColumnIfMissing(db, "usage_events", "source_file_rel", "source_file_rel TEXT"); err != nil {
			return err
		}
		if _, err := db.Exec(
			`INSERT INTO schema_meta (key, value) VALUES ('subagent_usage_backfill_pending', '0')
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		); err != nil {
			return err
		}
	}

	// NEVER lower the recorded version. This collector shares its database
	// with collector/ (Node), which has been ahead before. Stamping
	// unconditionally rewrote a newer database's version downwards, after
	// which the newer collector re-applied migrations whose columns already
	// existed and threw on a duplicate column -- unguarded at its own
	// startup. See issue #31. A database newer than this binary understands
	// is left exactly as found.
	if current >= SchemaVersion {
		return nil
	}

	_, err = db.Exec(
		`INSERT INTO schema_meta (key, value) VALUES ('version', ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		SchemaVersion,
	)
	return err
}

// GetSchemaVersion returns the stamped schema version, or 0 if schema_meta
// has no 'version' row (or does not exist yet). Matches schema.ts:122-127's
// `row ? Number(row.value) : 0` fallback.
func GetSchemaVersion(db *sql.DB) (int, error) {
	var value string
	err := db.QueryRow("SELECT value FROM schema_meta WHERE key = 'version'").Scan(&value)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		// schema_meta table may not exist yet (no migration run) -- treat
		// that as "no version" too, matching the JS behavior of returning 0.
		if strings.Contains(err.Error(), "no such table") {
			return 0, nil
		}
		return 0, err
	}
	version, err := strconv.Atoi(value)
	if err != nil {
		return 0, err
	}
	return version, nil
}

// StampFleetHeartbeat stamps "the collector's fleet-poll cycle is alive and
// cycling," independent of whether the poll itself succeeded. Callers must
// invoke this after EVERY fleet-poll cycle (success or failure) -- the
// reader side (electron/collectorStore.ts's readFleetSessions) treats a
// missing or stale heartbeat as "collector isn't running," which is what
// lets stale fleet_sessions rows correctly stop rendering as live sessions
// when the collector process itself has died or been stopped.
func StampFleetHeartbeat(db *sql.DB, nowMs int64) error {
	_, err := db.Exec(
		`INSERT INTO schema_meta (key, value) VALUES ('fleet_last_poll_ms', ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		nowMs,
	)
	return err
}

// StampTranscriptScanHeartbeat is the transcript-scan cycle's equivalent of
// StampFleetHeartbeat: "the collector's transcript scanning is alive and
// cycling," stamped on EVERY scan tick regardless of whether the scan found
// or ingested anything. electron/collectorStore.ts's readDiagnostics treats
// a missing or stale value as "collector isn't running," so a dead collector
// stops serving up-to-24h-old tool_calls/dispatches/anomalies rows as if
// they were current activity -- the same "looks alive, isn't" failure mode
// the fleet heartbeat closes.
func StampTranscriptScanHeartbeat(db *sql.DB, nowMs int64) error {
	_, err := db.Exec(
		`INSERT INTO schema_meta (key, value) VALUES ('transcript_last_scan_ms', ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		nowMs,
	)
	return err
}
