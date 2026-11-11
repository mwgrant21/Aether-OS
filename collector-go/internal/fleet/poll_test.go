package fleet

import (
	"bytes"
	"database/sql"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
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

func strp(s string) *string { return &s }
func i64p(v int64) *int64   { return &v }

// realRowJSON is captured directly from `claude agents --json` on a real
// machine, matching fleetPoll.test.ts's REAL_ROW fixture exactly (same field
// values) so the two suites stay comparable.
const realRowJSON = `{
	"pid": 6824,
	"cwd": "C:\\Users\\IT",
	"kind": "interactive",
	"startedAt": 1785255815376,
	"sessionId": "37d95054-b8c3-44c2-8422-06d7fd9d52d7",
	"name": "it-68",
	"status": "busy"
}`

func wantRealSession(overrides func(*FleetSession)) FleetSession {
	s := FleetSession{
		SessionID:   "37d95054-b8c3-44c2-8422-06d7fd9d52d7",
		PID:         i64p(6824),
		ProjectName: "IT",
		Kind:        "interactive",
		Status:      "busy",
		Name:        "it-68",
		StartedAtMs: 1785255815376,
	}
	if overrides != nil {
		overrides(&s)
	}
	return s
}

func TestParseFleetJSON_ParsesRealRow_DerivingProjectNameFromCwdViaWinBasename(t *testing.T) {
	result := ParseFleetJSON("[" + realRowJSON + "]")
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if len(result.DriftDetails) != 0 {
		t.Fatalf("expected no drift details, got %v", result.DriftDetails)
	}
	want := []FleetSession{wantRealSession(nil)}
	if !reflect.DeepEqual(result.Sessions, want) {
		t.Fatalf("sessions mismatch:\n got  %+v\n want %+v", result.Sessions, want)
	}
}

// backgroundRowJSON is captured from `claude agents --json` (CLI 2.1.322):
// background-kind rows carry "state" instead of "status" and have no pid.
const backgroundRowJSON = `{
	"id": "2c6f5a02",
	"cwd": "C:\\Users\\Matt\\.local\\bin",
	"kind": "background",
	"startedAt": 1779693438903,
	"sessionId": "2c6f5a02-d627-4035-9e69-b52ddc6cc740",
	"name": "agent definition builder",
	"state": "blocked"
}`

func TestParseFleetJSON_BackgroundRowWithStateInsteadOfStatus_NoDrift(t *testing.T) {
	result := ParseFleetJSON("[" + realRowJSON + "," + backgroundRowJSON + "]")
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if len(result.DriftDetails) != 0 {
		t.Fatalf("expected no drift details, got %v", result.DriftDetails)
	}
	want := []FleetSession{wantRealSession(nil), {
		SessionID:   "2c6f5a02-d627-4035-9e69-b52ddc6cc740",
		PID:         nil,
		ProjectName: "bin",
		Kind:        "background",
		Status:      "blocked",
		Name:        "agent definition builder",
		StartedAtMs: 1779693438903,
	}}
	if !reflect.DeepEqual(result.Sessions, want) {
		t.Fatalf("sessions mismatch:\n got  %+v\n want %+v", result.Sessions, want)
	}
}

func TestParseFleetJSON_NeitherStatusNorState_ReportsStatusMissing(t *testing.T) {
	raw := `[{
		"pid": 6824,
		"cwd": "C:\\Users\\IT",
		"kind": "interactive",
		"startedAt": 1785255815376,
		"sessionId": "x",
		"name": "it-68"
	}]`
	result := ParseFleetJSON(raw)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if len(result.Sessions) != 0 {
		t.Fatalf("expected 0 sessions, got %d", len(result.Sessions))
	}
	want := []string{"claude agents --json row missing/invalid field(s): status"}
	if !reflect.DeepEqual(result.DriftDetails, want) {
		t.Fatalf("drift mismatch: got %v want %v", result.DriftDetails, want)
	}
}

func TestParseFleetJSON_EmptyArray_ZeroSessionsZeroDrift(t *testing.T) {
	result := ParseFleetJSON("[]")
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if len(result.Sessions) != 0 {
		t.Fatalf("expected 0 sessions, got %d", len(result.Sessions))
	}
	if len(result.DriftDetails) != 0 {
		t.Fatalf("expected 0 drift details, got %d", len(result.DriftDetails))
	}
}

func TestParseFleetJSON_TreatsMissingPidAsNilRatherThanDroppingRow(t *testing.T) {
	raw := `[{
		"cwd": "C:\\Users\\IT",
		"kind": "interactive",
		"startedAt": 1785255815376,
		"sessionId": "37d95054-b8c3-44c2-8422-06d7fd9d52d7",
		"name": "it-68",
		"status": "busy"
	}]`
	result := ParseFleetJSON(raw)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if len(result.Sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(result.Sessions))
	}
	if result.Sessions[0].PID != nil {
		t.Fatalf("expected nil PID, got %v", *result.Sessions[0].PID)
	}
	if len(result.DriftDetails) != 0 {
		t.Fatalf("expected 0 drift details, got %v", result.DriftDetails)
	}
}

func TestParseFleetJSON_DropsRowMissingRequiredField_RecordsDrift_KeepsOtherValidRows(t *testing.T) {
	missingSessionID := `{
		"pid": 6824,
		"cwd": "C:\\Users\\IT",
		"kind": "interactive",
		"startedAt": 1785255815376,
		"name": "it-68",
		"status": "busy"
	}`
	secondRow := `{
		"pid": 6824,
		"cwd": "C:\\Users\\IT",
		"kind": "interactive",
		"startedAt": 1785255815376,
		"sessionId": "other-session",
		"name": "it-68",
		"status": "busy"
	}`
	raw := "[" + missingSessionID + "," + secondRow + "]"
	result := ParseFleetJSON(raw)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	want := []FleetSession{wantRealSession(func(s *FleetSession) { s.SessionID = "other-session" })}
	if !reflect.DeepEqual(result.Sessions, want) {
		t.Fatalf("sessions mismatch:\n got  %+v\n want %+v", result.Sessions, want)
	}
	if len(result.DriftDetails) != 1 {
		t.Fatalf("expected 1 drift detail, got %d: %v", len(result.DriftDetails), result.DriftDetails)
	}
	if !strings.Contains(result.DriftDetails[0], "sessionId") {
		t.Fatalf("expected drift detail to mention sessionId, got %q", result.DriftDetails[0])
	}
}

func TestParseFleetJSON_ReturnsNilForMalformedJSON(t *testing.T) {
	if result := ParseFleetJSON("not json{{"); result != nil {
		t.Fatalf("expected nil, got %+v", result)
	}
}

func TestParseFleetJSON_ReturnsNilWhenTopLevelIsNotAnArray(t *testing.T) {
	if result := ParseFleetJSON(`{"not":"an array"}`); result != nil {
		t.Fatalf("expected nil, got %+v", result)
	}
}

func fixtureSessions() []FleetSession {
	return []FleetSession{
		{SessionID: "own", PID: i64p(1), ProjectName: "IT", Kind: "interactive", Status: "busy", Name: "it-1", StartedAtMs: 1000},
		{SessionID: "other", PID: i64p(2), ProjectName: "proj", Kind: "interactive", Status: "idle", Name: "it-2", StartedAtMs: 2000},
	}
}

func TestFilterOwnSession_ExcludesSessionMatchingOwnSessionID(t *testing.T) {
	sessions := fixtureSessions()
	got := FilterOwnSession(sessions, strp("own"))
	want := []FleetSession{sessions[1]}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestFilterOwnSession_ReturnsEveryUnchangedWhenOwnSessionIDIsNil(t *testing.T) {
	sessions := fixtureSessions()
	got := FilterOwnSession(sessions, nil)
	if !reflect.DeepEqual(got, sessions) {
		t.Fatalf("got %+v, want %+v", got, sessions)
	}
}

func TestFilterOwnSession_ReturnsEveryUnchangedWhenOwnSessionIDMatchesNothing(t *testing.T) {
	sessions := fixtureSessions()
	got := FilterOwnSession(sessions, strp("no-such-session"))
	if !reflect.DeepEqual(got, sessions) {
		t.Fatalf("got %+v, want %+v", got, sessions)
	}
}

func testSession(overrides func(*FleetSession)) FleetSession {
	s := FleetSession{
		SessionID:   "s1",
		PID:         i64p(100),
		ProjectName: "proj",
		Kind:        "interactive",
		Status:      "busy",
		Name:        "it-1",
		StartedAtMs: 1000,
	}
	if overrides != nil {
		overrides(&s)
	}
	return s
}

func TestUpsertFleetSessions_InsertsNewSessionWithLastSeenMsStampedToNowMs(t *testing.T) {
	db := freshDB(t)
	if err := UpsertFleetSessions(db, []FleetSession{testSession(nil)}, 5000); err != nil {
		t.Fatalf("UpsertFleetSessions: %v", err)
	}
	var sessionID string
	var lastSeenMs int64
	if err := db.QueryRow(`SELECT session_id, last_seen_ms FROM fleet_sessions`).Scan(&sessionID, &lastSeenMs); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if sessionID != "s1" {
		t.Fatalf("expected session_id s1, got %q", sessionID)
	}
	if lastSeenMs != 5000 {
		t.Fatalf("expected last_seen_ms 5000, got %d", lastSeenMs)
	}
}

func TestUpsertFleetSessions_UpdatesExistingSessionInPlace_NotDuplicating(t *testing.T) {
	db := freshDB(t)
	if err := UpsertFleetSessions(db, []FleetSession{testSession(func(s *FleetSession) { s.Status = "busy" })}, 1000); err != nil {
		t.Fatalf("UpsertFleetSessions (1st): %v", err)
	}
	if err := UpsertFleetSessions(db, []FleetSession{testSession(func(s *FleetSession) { s.Status = "idle" })}, 2000); err != nil {
		t.Fatalf("UpsertFleetSessions (2nd): %v", err)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM fleet_sessions`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected 1 row, got %d", count)
	}
	var status string
	var lastSeenMs int64
	if err := db.QueryRow(`SELECT status, last_seen_ms FROM fleet_sessions`).Scan(&status, &lastSeenMs); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if status != "idle" {
		t.Fatalf("expected status idle, got %q", status)
	}
	if lastSeenMs != 2000 {
		t.Fatalf("expected last_seen_ms 2000, got %d", lastSeenMs)
	}
}

func TestUpsertFleetSessions_PrunesRowOlderThan30sBeforeNowMs(t *testing.T) {
	db := freshDB(t)
	if err := UpsertFleetSessions(db, []FleetSession{testSession(func(s *FleetSession) { s.SessionID = "stale" })}, 1000); err != nil {
		t.Fatalf("UpsertFleetSessions (stale): %v", err)
	}
	if err := UpsertFleetSessions(db, []FleetSession{testSession(func(s *FleetSession) { s.SessionID = "fresh" })}, 40000); err != nil {
		t.Fatalf("UpsertFleetSessions (fresh): %v", err)
	}
	rows, err := db.Query(`SELECT session_id FROM fleet_sessions`)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		ids = append(ids, id)
	}
	want := []string{"fresh"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("got %v, want %v", ids, want)
	}
}

func TestUpsertFleetSessions_PruneRunsEvenWithEmptySessionsArray(t *testing.T) {
	db := freshDB(t)
	if err := UpsertFleetSessions(db, []FleetSession{testSession(func(s *FleetSession) { s.SessionID = "stale" })}, 1000); err != nil {
		t.Fatalf("UpsertFleetSessions (stale): %v", err)
	}
	if err := UpsertFleetSessions(db, []FleetSession{}, 40000); err != nil {
		t.Fatalf("UpsertFleetSessions (empty): %v", err)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM fleet_sessions`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 0 {
		t.Fatalf("expected 0 rows, got %d", count)
	}
}

func TestPollFleet_ReturnsParsedSelfFilteredSessionsOnSuccessfulPoll(t *testing.T) {
	db := freshDB(t)
	stdout := `[
		{"pid": 6824, "cwd": "C:\\Users\\IT", "kind": "interactive", "startedAt": 1785255815376, "sessionId": "own-session", "name": "it-68", "status": "busy"},
		{"pid": 6824, "cwd": "C:\\Users\\IT", "kind": "interactive", "startedAt": 1785255815376, "sessionId": "other-session", "name": "it-99", "status": "busy"}
	]`
	result := PollFleet(db, strp("own-session"), 1000, func() (string, error) { return stdout, nil })
	want := []FleetSession{
		{SessionID: "other-session", PID: i64p(6824), ProjectName: "IT", Kind: "interactive", Status: "busy", Name: "it-99", StartedAtMs: 1785255815376},
	}
	if !reflect.DeepEqual(result, want) {
		t.Fatalf("got %+v, want %+v", result, want)
	}
}

func TestPollFleet_ReturnsNilAndLogsDrift_WhenExecFnFails(t *testing.T) {
	db := freshDB(t)
	result := PollFleet(db, nil, 1000, func() (string, error) { return "", errors.New("spawn claude ENOENT") })
	if result != nil {
		t.Fatalf("expected nil, got %+v", result)
	}
	rows, err := db.Query(`SELECT detail FROM drift_log`)
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
	if len(details) != 1 {
		t.Fatalf("expected 1 drift_log row, got %d", len(details))
	}
	if !strings.Contains(details[0], "ENOENT") {
		t.Fatalf("expected drift detail to contain ENOENT, got %q", details[0])
	}
}

func TestPollFleet_ReturnsNilAndLogsDrift_WhenStdoutIsNotValidJSON(t *testing.T) {
	db := freshDB(t)
	result := PollFleet(db, nil, 1000, func() (string, error) { return "not json{{", nil })
	if result != nil {
		t.Fatalf("expected nil, got %+v", result)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM drift_log`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected 1 drift_log row, got %d", count)
	}
}

func TestPollFleet_LogsOneDriftRowPerMalformedRow_ButStillReturnsValidOnes(t *testing.T) {
	db := freshDB(t)
	missingSessionID := `{"pid": 6824, "cwd": "C:\\Users\\IT", "kind": "interactive", "startedAt": 1785255815376, "name": "it-68", "status": "busy"}`
	okRow := `{"pid": 6824, "cwd": "C:\\Users\\IT", "kind": "interactive", "startedAt": 1785255815376, "sessionId": "ok-session", "name": "it-68", "status": "busy"}`
	stdout := "[" + missingSessionID + "," + okRow + "]"
	result := PollFleet(db, nil, 1000, func() (string, error) { return stdout, nil })
	if len(result) != 1 {
		t.Fatalf("expected 1 session, got %d: %+v", len(result), result)
	}
	if result[0].SessionID != "ok-session" {
		t.Fatalf("expected ok-session, got %q", result[0].SessionID)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM drift_log`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("expected 1 drift_log row, got %d", count)
	}
}

// Regression test for a real port bug found by Task 9's golden-file parity
// run. fleetPoll.ts imports logDrift from canary.ts, which is loud on purpose
// (console.error + a drift_log row). This package originally reimplemented
// logDrift locally as a bare INSERT, so a live `claude agents --json`
// contract drift landed a row but produced no operator-visible console
// output at all -- exactly the signal a canary exists to raise.
func TestPollFleet_Drift_WritesLoudStderrLine(t *testing.T) {
	db := freshDB(t)

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

	PollFleet(db, nil, 1000, func() (string, error) { return "", errors.New("spawn claude ENOENT") })

	w.Close()
	os.Stderr = orig
	out := <-done
	r.Close()

	const want = "[aether-collector] contract drift detected: claude agents --json failed to run: spawn claude ENOENT"
	if !strings.Contains(out, want) {
		t.Fatalf("expected stderr to contain %q, got %q", want, out)
	}
}

// TestFleetExecHelperProcess is the re-exec target for the runFleetExec tests.
// It is a no-op unless FLEET_EXEC_HELPER is set.
func TestFleetExecHelperProcess(t *testing.T) {
	switch os.Getenv("FLEET_EXEC_HELPER") {
	case "":
		return
	case "echo":
		os.Stdout.WriteString("[]")
		os.Exit(0)
	case "sleep":
		sleepUntilStopped()
		os.Exit(0)
	case "grandchild":
		// Inherits this process's stdout pipe but not go-test's stderr.
		gc := exec.Command(os.Args[0], "-test.run=^TestFleetExecHelperProcess$")
		gc.Env = append(os.Environ(), "FLEET_EXEC_HELPER=sleep")
		gc.Stdout = os.Stdout
		gc.Stderr = nil
		if err := gc.Start(); err != nil {
			os.Exit(2)
		}
		sleepUntilStopped()
		os.Exit(0)
	}
}

// sleepUntilStopped sleeps up to 10s but exits early once the sentinel file named
// by FLEET_EXEC_STOP exists, so no orphan outlives the test binary (on Windows a
// running orphan makes go test fail to delete fleet.test.exe).
func sleepUntilStopped() {
	stop := os.Getenv("FLEET_EXEC_STOP")
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if stop != "" {
			if _, err := os.Stat(stop); err == nil {
				return
			}
		}
	}
}

func runHelper(t *testing.T, mode string, timeout time.Duration) (string, error, time.Duration) {
	t.Helper()
	t.Setenv("FLEET_EXEC_HELPER", mode)
	// Registered after t.TempDir's own cleanup, so it runs first: create the sentinel
	// and give any still-sleeping helper or grandchild time to see it and exit.
	stop := filepath.Join(t.TempDir(), "stop")
	t.Setenv("FLEET_EXEC_STOP", stop)
	t.Cleanup(func() {
		os.WriteFile(stop, nil, 0o600)
		time.Sleep(300 * time.Millisecond)
	})
	start := time.Now()
	out, err := runFleetExec(timeout, 300*time.Millisecond, os.Args[0], "-test.run=^TestFleetExecHelperProcess$")
	return out, err, time.Since(start)
}

func TestRunFleetExec_ReturnsStdoutFromHealthyChild(t *testing.T) {
	out, err, _ := runHelper(t, "echo", 10*time.Second)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out != "[]" {
		t.Errorf("stdout = %q, want %q", out, "[]")
	}
}

func TestRunFleetExec_KillsHungChildAndReturnsTimeoutError(t *testing.T) {
	_, err, elapsed := runHelper(t, "sleep", 300*time.Millisecond)
	if err == nil {
		t.Fatal("expected a timeout error, got nil")
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Errorf("error = %q, want it to contain %q", err.Error(), "timed out")
	}
	if strings.Contains(err.Error(), os.Args[0]) {
		t.Errorf("error leaks the executable path: %q", err.Error())
	}
	if elapsed > 4*time.Second {
		t.Errorf("returned after %s, want < 4s", elapsed)
	}
}

func TestRunFleetExec_ReturnsWhenGrandchildKeepsStdoutOpen(t *testing.T) {
	_, err, elapsed := runHelper(t, "grandchild", 300*time.Millisecond)
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if elapsed > 4*time.Second {
		t.Errorf("returned after %s, want < 4s (WaitDelay should abandon the held pipe)", elapsed)
	}
}
