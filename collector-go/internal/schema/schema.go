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

// SchemaVersion mirrors schema.ts's SCHEMA_VERSION.
const SchemaVersion = 4

// OpenDatabase opens (creating if necessary) the SQLite database at dbPath,
// creating the parent directory first. Matches schema.ts:14's
// mkdirSync(dirname(dbPath), { recursive: true }).
func OpenDatabase(dbPath string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", dbPath)
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

	_, err := db.Exec(
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
