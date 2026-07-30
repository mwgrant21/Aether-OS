// Package fleet is the Go port of collector/src/fleetPoll.ts: shelling out to
// `claude agents --json`, parsing and validating each row, and upserting the
// result into the fleet_sessions table (schema owned by the schema package --
// see this package's task brief for why fleet does not touch schema DDL).
package fleet

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

// FleetSession mirrors fleetPoll.ts's FleetSession interface.
type FleetSession struct {
	SessionID   string
	PID         *int64 // nil when the row had no numeric pid, matching TS's `pid: number | null`.
	ProjectName string
	Kind        string
	Status      string
	Name        string
	StartedAtMs int64
}

// requiredStringFields mirrors fleetPoll.ts's REQUIRED_STRING_FIELDS.
var requiredStringFields = []string{"sessionId", "cwd", "kind", "name", "status"}

// missingFieldsOf mirrors fleetPoll.ts's missingFieldsOf. row is one element
// decoded from a `claude agents --json` JSON array; JSON objects decode to
// map[string]interface{} via encoding/json, so anything else (array, string,
// number, bool, null) fails the type assertion the same way TS's
// `typeof row !== 'object' || row === null || Array.isArray(row)` guard does.
func missingFieldsOf(row interface{}) []string {
	obj, ok := row.(map[string]interface{})
	if !ok {
		return []string{"row is not an object"}
	}

	var missing []string
	for _, field := range requiredStringFields {
		v, exists := obj[field]
		if !exists {
			missing = append(missing, field)
			continue
		}
		if _, isString := v.(string); !isString {
			missing = append(missing, field)
		}
	}
	if v, exists := obj["startedAt"]; !exists {
		missing = append(missing, "startedAt")
	} else if _, isNumber := v.(float64); !isNumber {
		missing = append(missing, "startedAt")
	}
	return missing
}

// winBasename is the Go equivalent of Node's `path.win32.basename` -- the
// TS source deliberately imports the win32 variant (not the platform-default
// basename) because `claude agents --json`'s cwd is always a Windows-style
// path on this Windows-only personal app, and using the platform-default
// would make fleetPoll.ts's own tests non-deterministic across dev machines
// running vitest on a different host OS (see fleetPoll.ts's comment on
// toFleetSession). Go's path/filepath is host-OS-dependent in the same way
// (backslash is only a separator when GOOS=windows), so this package defines
// its own separator-explicit basename instead of relying on path/filepath,
// to stay deterministic regardless of the host OS running `go test`. Scope
// note: unlike Node's path.win32.basename, this does not special-case bare
// drive roots (e.g. "C:\" -> ""); claude agents --json's cwd is always a real
// project directory, never a drive root, so this was never exercised by the
// TS original either. Worth revisiting if this helper is ever reused for
// input that isn't a live agent's cwd.
func winBasename(p string) string {
	for len(p) > 0 {
		last := p[len(p)-1]
		if last != '\\' && last != '/' {
			break
		}
		p = p[:len(p)-1]
	}
	idx := strings.LastIndexAny(p, `\/`)
	if idx == -1 {
		return p
	}
	return p[idx+1:]
}

// toFleetSession mirrors fleetPoll.ts's toFleetSession. Caller must have
// already validated obj via missingFieldsOf.
func toFleetSession(obj map[string]interface{}) FleetSession {
	var pid *int64
	if v, ok := obj["pid"]; ok {
		if f, isNumber := v.(float64); isNumber {
			iv := int64(f)
			pid = &iv
		}
	}
	cwd, _ := obj["cwd"].(string)
	startedAt, _ := obj["startedAt"].(float64)
	return FleetSession{
		SessionID:   obj["sessionId"].(string),
		PID:         pid,
		ProjectName: winBasename(cwd),
		Kind:        obj["kind"].(string),
		Status:      obj["status"].(string),
		Name:        obj["name"].(string),
		StartedAtMs: int64(startedAt),
	}
}

// ParseResult mirrors fleetPoll.ts's parseFleetJson return shape.
type ParseResult struct {
	Sessions     []FleetSession
	DriftDetails []string
}

// ParseFleetJSON mirrors fleetPoll.ts's parseFleetJson: returns nil when raw
// is not valid JSON or its top-level value is not an array (matching TS's
// `| null` return), otherwise a ParseResult whose Sessions holds every
// well-formed row and DriftDetails holds one entry per malformed row that was
// dropped.
func ParseFleetJSON(raw string) *ParseResult {
	var parsed interface{}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil
	}
	arr, ok := parsed.([]interface{})
	if !ok {
		return nil
	}

	sessions := []FleetSession{}
	driftDetails := []string{}
	for _, row := range arr {
		missing := missingFieldsOf(row)
		if len(missing) > 0 {
			driftDetails = append(driftDetails, fmt.Sprintf(
				"claude agents --json row missing/invalid field(s): %s", strings.Join(missing, ", ")))
			continue
		}
		sessions = append(sessions, toFleetSession(row.(map[string]interface{})))
	}
	return &ParseResult{Sessions: sessions, DriftDetails: driftDetails}
}

// FilterOwnSession mirrors fleetPoll.ts's filterOwnSession.
func FilterOwnSession(sessions []FleetSession, ownSessionID *string) []FleetSession {
	if ownSessionID == nil {
		return sessions
	}
	out := []FleetSession{}
	for _, s := range sessions {
		if s.SessionID != *ownSessionID {
			out = append(out, s)
		}
	}
	return out
}

// staleMs mirrors fleetPoll.ts's STALE_MS: twice the 15s poll interval,
// matching retention.ts's staleness convention.
const staleMs = 30000

// UpsertFleetSessions mirrors fleetPoll.ts's upsertFleetSessions: upserts
// every session by session_id, stamping last_seen_ms to nowMs, then prunes
// any fleet_sessions row (including ones not part of this call's sessions)
// whose last_seen_ms has fallen more than staleMs behind nowMs. The prune
// runs unconditionally, even when sessions is empty.
func UpsertFleetSessions(db *sql.DB, sessions []FleetSession, nowMs int64) error {
	stmt, err := db.Prepare(
		`INSERT INTO fleet_sessions (session_id, pid, project_name, kind, status, name, started_at_ms, last_seen_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(session_id) DO UPDATE SET
		   pid = excluded.pid,
		   project_name = excluded.project_name,
		   kind = excluded.kind,
		   status = excluded.status,
		   name = excluded.name,
		   started_at_ms = excluded.started_at_ms,
		   last_seen_ms = excluded.last_seen_ms`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, s := range sessions {
		var pid interface{}
		if s.PID != nil {
			pid = *s.PID
		}
		if _, err := stmt.Exec(s.SessionID, pid, s.ProjectName, s.Kind, s.Status, s.Name, s.StartedAtMs, nowMs); err != nil {
			return err
		}
	}

	_, err = db.Exec(`DELETE FROM fleet_sessions WHERE last_seen_ms < ?`, nowMs-staleMs)
	return err
}

// logDrift mirrors canary.ts's logDrift for this package, matching the
// spool package's own local best-effort port (internal/spool/ingest.go): a
// failure to write the drift_log row must never stop pollFleet from
// otherwise completing correctly, so the error is intentionally discarded.
func logDrift(db *sql.DB, nowMs int64, detail string) {
	_, _ = db.Exec(`INSERT INTO drift_log (detected_at_ms, detail) VALUES (?, ?)`, nowMs, detail)
}

// FleetExecFn mirrors fleetPoll.ts's FleetExecFn type: the injectable
// subprocess call, so tests can stub `claude agents --json` without shelling
// out to a real binary (matching index.ts:16-19's precedent of taking this
// same type as an optional parameter).
type FleetExecFn func() (stdout string, err error)

// defaultFleetExec mirrors fleetPoll.ts's defaultFleetExec.
func defaultFleetExec() (string, error) {
	out, err := exec.Command("claude", "agents", "--json").Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// PollFleet mirrors fleetPoll.ts's pollFleet. execFn defaults to
// defaultFleetExec when nil, matching TS's default-parameter behavior. On
// any failure (exec error, invalid JSON, non-array JSON) a drift_log row is
// written via logDrift and PollFleet returns nil, matching TS's `| null`
// return; on success, every malformed row's drift detail is also logged
// before the valid, self-filtered sessions are returned.
func PollFleet(db *sql.DB, ownSessionID *string, nowMs int64, execFn FleetExecFn) []FleetSession {
	if execFn == nil {
		execFn = defaultFleetExec
	}

	stdout, err := execFn()
	if err != nil {
		logDrift(db, nowMs, fmt.Sprintf("claude agents --json failed to run: %s", err.Error()))
		return nil
	}

	parsed := ParseFleetJSON(stdout)
	if parsed == nil {
		logDrift(db, nowMs, "claude agents --json output was not a valid JSON array")
		return nil
	}
	for _, detail := range parsed.DriftDetails {
		logDrift(db, nowMs, detail)
	}

	return FilterOwnSession(parsed.Sessions, ownSessionID)
}
