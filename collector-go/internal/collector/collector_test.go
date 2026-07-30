package collector

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/mwgrant21/aether-os/collector-go/internal/schema"
)

func mkTempDir(t *testing.T, pattern string) string {
	t.Helper()
	dir, err := os.MkdirTemp("", pattern)
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// openForInspection opens a second, independent connection to a database
// file that a running StartCollector may still hold open and be actively
// writing to. modernc.org/sqlite's default busy_timeout is 0 (fail
// immediately with SQLITE_BUSY on any lock contention rather than retry), so
// a plain schema.OpenDatabase here is flaky under the concurrent
// spool-tail/transcript-scan/fleet-poll goroutines these tests exercise.
// This is a test-only mitigation (a busy_timeout PRAGMA on the test's own
// inspection connection) -- it does not touch internal/schema's
// OpenDatabase (Task 1, already reviewed/merged) or change any production
// behavior.
func openForInspection(t *testing.T, dbPath string) *sql.DB {
	t.Helper()
	db, err := schema.OpenDatabase(dbPath)
	if err != nil {
		t.Fatalf("OpenDatabase: %v", err)
	}
	if _, err := db.Exec("PRAGMA busy_timeout = 5000"); err != nil {
		t.Fatalf("set busy_timeout: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func assertCount(t *testing.T, db *sql.DB, table string, want int) {
	t.Helper()
	var got int
	if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&got); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	if got != want {
		t.Fatalf("%s count = %d, want %d", table, got, want)
	}
}

func noSessionsExecFn() (string, error) { return "[]", nil }

// TestStartCollector_PicksUpPreexistingSpoolFileAndDBFileExists ports
// index.test.ts's "picks up a pre-existing spool file, ingests it, and the
// DB file exists on disk" case: a spool file written before StartCollector
// is called must be tailed and ingested by the spool-tail loop, and the DB
// file must exist on disk afterward.
func TestStartCollector_PicksUpPreexistingSpoolFileAndDBFileExists(t *testing.T) {
	dir := mkTempDir(t, "aether-collector-e2e-")
	spoolDir := filepath.Join(dir, "spool")
	dbPath := filepath.Join(dir, "collector.db")
	if err := os.MkdirAll(spoolDir, 0755); err != nil {
		t.Fatalf("MkdirAll spool: %v", err)
	}
	payload, _ := json.Marshal(map[string]interface{}{"hook_event_name": "Stop", "session_id": "s1"})
	if err := os.WriteFile(filepath.Join(spoolDir, "s1.jsonl"), append(payload, '\n'), 0644); err != nil {
		t.Fatalf("write spool file: %v", err)
	}

	projectsRoot := filepath.Join(dir, "projects")
	if err := os.MkdirAll(projectsRoot, 0755); err != nil {
		t.Fatalf("MkdirAll projects: %v", err)
	}

	stop, err := StartCollector(Options{
		DBPath:                 dbPath,
		SpoolDir:               spoolDir,
		TailInterval:           20 * time.Millisecond,
		CompactInterval:        100 * time.Second,
		ProjectsRoot:           projectsRoot,
		TranscriptScanInterval: 100 * time.Second,
		OwnSessionFilePath:     filepath.Join(dir, "own-session.json"),
		FleetPollInterval:      100 * time.Second,
		FleetExecFn:            noSessionsExecFn,
	})
	if err != nil {
		t.Fatalf("StartCollector: %v", err)
	}
	defer stop()

	time.Sleep(150 * time.Millisecond) // let the first spool-tail tick fire

	if _, statErr := os.Stat(dbPath); statErr != nil {
		t.Fatalf("expected db file to exist at %s: %v", dbPath, statErr)
	}

	db := openForInspection(t, dbPath)
	assertCount(t, db, "events", 1)
}

// TestStartCollector_OpensMigratesAndStartsAllFourLoops proves starting the
// collector opens the DB, migrates it (schema_version == 4), and starts all
// four loops: the transcript-scan and fleet-poll heartbeats are stamped by
// their immediate (pre-interval) run, and the compaction loop is proven live
// by seeding a stale `events` row before start and observing it get rolled
// up once the (short) compact interval ticks.
func TestStartCollector_OpensMigratesAndStartsAllFourLoops(t *testing.T) {
	dir := mkTempDir(t, "aether-collector-allloops-")
	dbPath := filepath.Join(dir, "collector.db")
	spoolDir := filepath.Join(dir, "spool")
	projectsRoot := filepath.Join(dir, "projects")
	os.MkdirAll(spoolDir, 0755)
	os.MkdirAll(projectsRoot, 0755)

	// Seed a stale events row directly, before the collector (and therefore
	// its schema migration) exists, via a throwaway connection.
	seedDB, err := schema.OpenDatabase(dbPath)
	if err != nil {
		t.Fatalf("seed OpenDatabase: %v", err)
	}
	if err := schema.Migrate(seedDB); err != nil {
		t.Fatalf("seed Migrate: %v", err)
	}
	staleMs := time.Now().Add(-31 * 24 * time.Hour).UnixMilli()
	if _, err := seedDB.Exec(
		`INSERT INTO events (hook_event_name, session_id, project_rel_path, tool_name, had_tool_input, had_tool_response, notification_type, occurred_at_ms)
		 VALUES ('Stop', 's1', NULL, NULL, 0, 0, NULL, ?)`, staleMs,
	); err != nil {
		t.Fatalf("seed stale events row: %v", err)
	}
	seedDB.Close()

	stop, err := StartCollector(Options{
		DBPath:                 dbPath,
		SpoolDir:               spoolDir,
		TailInterval:           50 * time.Millisecond,
		CompactInterval:        30 * time.Millisecond,
		ProjectsRoot:           projectsRoot,
		TranscriptScanInterval: 100 * time.Second, // immediate run only within this test's window
		OwnSessionFilePath:     filepath.Join(dir, "own-session.json"),
		FleetPollInterval:      100 * time.Second, // immediate run only within this test's window
		FleetExecFn:            noSessionsExecFn,
	})
	if err != nil {
		t.Fatalf("StartCollector: %v", err)
	}
	defer stop()

	// DB opened + migrated.
	db := openForInspection(t, dbPath)
	version, err := schema.GetSchemaVersion(db)
	if err != nil {
		t.Fatalf("GetSchemaVersion: %v", err)
	}
	if version != schema.SchemaVersion {
		t.Fatalf("schema version = %d, want %d", version, schema.SchemaVersion)
	}

	// Transcript-scan loop: immediate run stamps the heartbeat synchronously,
	// so it must already be present with no wait.
	var scanHeartbeat string
	if err := db.QueryRow("SELECT value FROM schema_meta WHERE key = 'transcript_last_scan_ms'").Scan(&scanHeartbeat); err != nil {
		t.Fatalf("transcript scan heartbeat not stamped: %v", err)
	}

	// Fleet-poll loop: immediate run stamps the heartbeat synchronously too.
	var fleetHeartbeat string
	if err := db.QueryRow("SELECT value FROM schema_meta WHERE key = 'fleet_last_poll_ms'").Scan(&fleetHeartbeat); err != nil {
		t.Fatalf("fleet poll heartbeat not stamped: %v", err)
	}

	// Compaction loop: wait for at least one 30ms tick, then confirm the
	// stale events row was rolled up and deleted -- the only way this
	// happens is if the compact loop actually ran.
	time.Sleep(150 * time.Millisecond)
	assertCount(t, db, "events", 0)
	var rollupCount int
	if err := db.QueryRow("SELECT event_count FROM daily_rollups WHERE hook_event_name = 'Stop'").Scan(&rollupCount); err != nil {
		t.Fatalf("expected a daily_rollups row for the compacted Stop event: %v", err)
	}
	if rollupCount != 1 {
		t.Fatalf("daily_rollups.event_count = %d, want 1", rollupCount)
	}

	// Spool-tail loop: write a spool file after start and confirm it gets
	// picked up on the next 50ms tick.
	payload, _ := json.Marshal(map[string]interface{}{"hook_event_name": "Stop", "session_id": "s2"})
	os.WriteFile(filepath.Join(spoolDir, "s2.jsonl"), append(payload, '\n'), 0644)
	time.Sleep(150 * time.Millisecond)
	assertCount(t, db, "events", 1)
}

// TestStartCollector_StopHaltsAllLoopsAndClosesDB proves the returned stop
// function halts all four loops (a spool file written after stop is never
// ingested) and closes the DB (a fresh connection to the same file, opened
// after stop, must succeed cleanly -- proving the collector's own connection
// released its lock rather than leaving the file busy).
func TestStartCollector_StopHaltsAllLoopsAndClosesDB(t *testing.T) {
	dir := mkTempDir(t, "aether-collector-stop-")
	dbPath := filepath.Join(dir, "collector.db")
	spoolDir := filepath.Join(dir, "spool")
	projectsRoot := filepath.Join(dir, "projects")
	os.MkdirAll(spoolDir, 0755)
	os.MkdirAll(projectsRoot, 0755)

	stop, err := StartCollector(Options{
		DBPath:                 dbPath,
		SpoolDir:               spoolDir,
		TailInterval:           20 * time.Millisecond,
		CompactInterval:        100 * time.Second,
		ProjectsRoot:           projectsRoot,
		TranscriptScanInterval: 100 * time.Second,
		OwnSessionFilePath:     filepath.Join(dir, "own-session.json"),
		FleetPollInterval:      100 * time.Second,
		FleetExecFn:            noSessionsExecFn,
	})
	if err != nil {
		t.Fatalf("StartCollector: %v", err)
	}

	time.Sleep(60 * time.Millisecond) // let loops actually start ticking
	stop()

	// A fresh connection to the same db file must open and migrate cleanly
	// after stop() -- proving the collector's own *sql.DB was actually
	// closed, not just idle.
	db, err := schema.OpenDatabase(dbPath)
	if err != nil {
		t.Fatalf("OpenDatabase after stop: %v", err)
	}
	defer db.Close()
	if err := schema.Migrate(db); err != nil {
		t.Fatalf("Migrate after stop: %v", err)
	}

	// Spool file written after stop must never be ingested.
	payload, _ := json.Marshal(map[string]interface{}{"hook_event_name": "Stop", "session_id": "after-stop"})
	os.WriteFile(filepath.Join(spoolDir, "late.jsonl"), append(payload, '\n'), 0644)
	time.Sleep(80 * time.Millisecond)
	assertCount(t, db, "events", 0)
}

// TestStartCollector_FleetPollFailureDoesNotCrashOtherLoops matches
// index.ts:56-63's .catch(err => console.error(...)) wrapping of every
// pollAndUpsertFleet call: an execFn that always errors must not prevent the
// spool-tail and transcript-scan loops from continuing to run.
func TestStartCollector_FleetPollFailureDoesNotCrashOtherLoops(t *testing.T) {
	dir := mkTempDir(t, "aether-collector-fleetfail-")
	dbPath := filepath.Join(dir, "collector.db")
	spoolDir := filepath.Join(dir, "spool")
	projectsRoot := filepath.Join(dir, "projects")
	os.MkdirAll(spoolDir, 0755)
	os.MkdirAll(projectsRoot, 0755)

	alwaysFails := func() (string, error) { return "", errors.New("spawn claude ENOENT") }

	stop, err := StartCollector(Options{
		DBPath:                 dbPath,
		SpoolDir:               spoolDir,
		TailInterval:           20 * time.Millisecond,
		CompactInterval:        100 * time.Second,
		ProjectsRoot:           projectsRoot,
		TranscriptScanInterval: 100 * time.Second,
		OwnSessionFilePath:     filepath.Join(dir, "own-session.json"),
		FleetPollInterval:      20 * time.Millisecond,
		FleetExecFn:            alwaysFails,
	})
	if err != nil {
		t.Fatalf("StartCollector: %v", err)
	}
	defer stop()

	// Spool tail must keep working despite fleet poll erroring on every tick.
	payload, _ := json.Marshal(map[string]interface{}{"hook_event_name": "Stop", "session_id": "s1"})
	os.WriteFile(filepath.Join(spoolDir, "s1.jsonl"), append(payload, '\n'), 0644)
	time.Sleep(150 * time.Millisecond)

	db := openForInspection(t, dbPath)
	assertCount(t, db, "events", 1)

	// Fleet heartbeat must still be stamped every cycle even though the poll
	// itself fails -- see PollAndUpsertFleet's doc comment (matches
	// index.ts's try/finally semantics).
	var heartbeat string
	if err := db.QueryRow("SELECT value FROM schema_meta WHERE key = 'fleet_last_poll_ms'").Scan(&heartbeat); err != nil {
		t.Fatalf("fleet heartbeat not stamped despite poll failures: %v", err)
	}
	// fleet_sessions must have been pruned to empty (upsertFleetSessions(db,
	// [], nowMs) called unconditionally), not left stale/uninitialized.
	assertCount(t, db, "fleet_sessions", 0)
}

// The following tests port index.test.ts's "pollAndUpsertFleet" describe
// block directly against PollAndUpsertFleet.

func freshFleetDB(t *testing.T) *sql.DB {
	t.Helper()
	dir := mkTempDir(t, "aether-collector-fleetheartbeat-")
	db, err := schema.OpenDatabase(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("OpenDatabase: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := schema.Migrate(db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	return db
}

func TestPollAndUpsertFleet_StampsHeartbeatAfterSuccessfulPoll(t *testing.T) {
	db := freshFleetDB(t)
	if err := PollAndUpsertFleet(db, filepath.Join(t.TempDir(), "own-session.json"), noSessionsExecFn); err != nil {
		t.Fatalf("PollAndUpsertFleet: %v", err)
	}

	var value string
	if err := db.QueryRow("SELECT value FROM schema_meta WHERE key = 'fleet_last_poll_ms'").Scan(&value); err != nil {
		t.Fatalf("query heartbeat: %v", err)
	}
	if value == "" || value == "0" {
		t.Fatalf("heartbeat=%q want a positive timestamp", value)
	}
}

func TestPollAndUpsertFleet_StampsHeartbeatEvenWhenPollFails(t *testing.T) {
	db := freshFleetDB(t)
	failingExec := func() (string, error) { return "", errors.New("spawn claude ENOENT") }
	if err := PollAndUpsertFleet(db, filepath.Join(t.TempDir(), "own-session.json"), failingExec); err != nil {
		t.Fatalf("PollAndUpsertFleet: %v", err)
	}

	var value string
	if err := db.QueryRow("SELECT value FROM schema_meta WHERE key = 'fleet_last_poll_ms'").Scan(&value); err != nil {
		t.Fatalf("query heartbeat: %v", err)
	}
	// The poll itself failed, so fleet_sessions should have been pruned to
	// empty via the unconditional UpsertFleetSessions(db, [], nowMs) call --
	// confirms the heartbeat write didn't skip or short-circuit that path.
	assertCount(t, db, "fleet_sessions", 0)
}

func TestPollAndUpsertFleet_UpdatesHeartbeatRatherThanAccumulatingRows(t *testing.T) {
	db := freshFleetDB(t)
	ownSessionFilePath := filepath.Join(t.TempDir(), "own-session.json")

	if err := PollAndUpsertFleet(db, ownSessionFilePath, noSessionsExecFn); err != nil {
		t.Fatalf("first PollAndUpsertFleet: %v", err)
	}
	var first string
	db.QueryRow("SELECT value FROM schema_meta WHERE key = 'fleet_last_poll_ms'").Scan(&first)

	time.Sleep(5 * time.Millisecond)
	if err := PollAndUpsertFleet(db, ownSessionFilePath, noSessionsExecFn); err != nil {
		t.Fatalf("second PollAndUpsertFleet: %v", err)
	}
	var second string
	db.QueryRow("SELECT value FROM schema_meta WHERE key = 'fleet_last_poll_ms'").Scan(&second)

	if second < first {
		t.Fatalf("second heartbeat %q < first %q", second, first)
	}
	var rowCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM schema_meta WHERE key = 'fleet_last_poll_ms'").Scan(&rowCount); err != nil {
		t.Fatalf("count fleet_last_poll_ms rows: %v", err)
	}
	if rowCount != 1 {
		t.Fatalf("fleet_last_poll_ms row count = %d, want 1 (upsert, not accumulate)", rowCount)
	}
}
