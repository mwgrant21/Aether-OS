package spool

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/mwgrant21/aether-os/collector-go/internal/canary"
)

// ErrSkipped is returned by IngestHookEvent when a known event is missing a
// field this collector depends on -- collector/src/ingest.ts:30-35's
// missing-required-field guard. This check uses HookEvent's unexported
// rawHad* fields (raw JSON presence: not undefined/null), NOT the exported
// ToolName/NotificationType pointers -- ingest.ts's guard runs against the
// raw untyped payload, where e.g. `"tool_name": ""` counts as present, even
// though hookPayload.ts's own stringField (which does produce ToolName)
// treats an empty string as absent. Conflating the two would skip
// `"tool_name": ""`, which the TS original does not.
//
// Writing the drift_log row is NOT this function's job: canary.ts's
// checkForDrift is a SEPARATE, earlier step in ingest.ts (ingest.ts:22, run
// against the raw payload before parseHookPayload) and is invoked from
// decodeLine below. Folding the two together here was wrong -- it made drift
// logging conditional on the payload also being parseable, so a known event
// missing BOTH its required field and its session_id (unparseable) silently
// produced no drift row at all, where the TS original logs one. See this
// branch's Task 9 parity report.
var ErrSkipped = errors.New("spool: event skipped (missing required field)")

// dbExecer is the subset of *sql.DB and *sql.Tx that IngestHookEvent needs.
// Accepting the interface is what lets the spool tailer write a whole file
// inside one transaction (see TailSpoolOnce) while single-event callers keep
// passing the *sql.DB directly.
type dbExecer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

// missingRequiredField reports whether a known event lacks a field this
// collector depends on. Shared by IngestHookEvent (which turns it into
// ErrSkipped) and decodeLine (which turns it into a nil event), so the two
// can never disagree about what counts as a permanent skip.
func missingRequiredField(event *HookEvent) bool {
	required, ok := canary.RequiredFieldsByEvent[event.HookEventName]
	if !ok {
		return false
	}
	for _, field := range required {
		switch field {
		case "tool_name":
			if !event.rawHadToolName {
				return true
			}
		case "notification_type":
			if !event.rawHadNotificationType {
				return true
			}
		}
	}
	return false
}

// IngestHookEvent writes one already-parsed HookEvent into the events table,
// using nowMs as occurred_at_ms. Before inserting, it re-checks the event
// against canary.RequiredFieldsByEvent (the same table canary.ts exports and
// ingest.ts imports from it): if a known event is missing a field this
// collector depends on, ErrSkipped is returned instead of inserting --
// matching ingest.ts:30-35's missing-required-field skip, which never throws
// and never blocks the caller from moving on to the next line. The
// corresponding drift_log row is written earlier, by decodeLine's
// canary.CheckForDrift call (ingest.ts:22) -- see ErrSkipped's doc comment.
//
// Any other error is a REFUSED WRITE (SQLITE_BUSY, disk full, schema drift)
// and is returned as-is: the caller decides whether to roll back and retry.
func IngestHookEvent(db dbExecer, event *HookEvent, nowMs int64) error {
	if event == nil || missingRequiredField(event) {
		return ErrSkipped
	}

	_, err := db.Exec(
		`INSERT INTO events (hook_event_name, session_id, project_rel_path, tool_name, had_tool_input, had_tool_response, notification_type, occurred_at_ms)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		event.HookEventName,
		event.SessionID,
		event.CWD,
		event.ToolName,
		boolToInt(event.HadToolInput),
		boolToInt(event.HadToolResponse),
		event.NotificationType,
		nowMs,
	)
	return err
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// decodeLine is the Go port of ingest.ts's decodeLine: the parse half of
// ingesting a spool line, in the same order the TS original runs its steps:
// (1) trim + JSON.parse, bailing on anything unparseable; (2) run the drift
// canary against the RAW parsed payload, regardless of whether the payload
// turns out to be ingestible; (3) parse into the derived shape, applying the
// missing-required-field guard. A nil return is a PERMANENT verdict on the
// line -- retrying can never make it ingest -- which is what lets the tailer
// tell "drop this line" apart from "the database refused a write".
//
// Step 2's placement is load-bearing and was the subject of a real port bug:
// the canary must run on the raw payload BEFORE the typed parse (ingest.ts:22
// vs. ingest.ts:37), so that a known hook event missing both its required
// field and its session_id still produces the loud drift signal it does in
// the TS collector.
//
// The line is JSON-unmarshaled exactly once here (matching ingest.ts:37's
// parseHookPayload(parsed, receivedAtMs), which passes the already-parsed
// object rather than re-parsing): the resulting raw value feeds both the
// drift check and, via a single map-shape assertion, spool.
// parseHookPayloadFromObj -- ParseHookPayload's exported re-parsing entry
// point is not used here, since it would unmarshal the same bytes again.
//
// The canary write goes to db directly, never inside the tailer's
// transaction: with SetMaxOpenConns(1) an open *sql.Tx holds the only
// connection, so a db.Exec from within it would deadlock. Decode everything
// first, then open the transaction.
func decodeLine(db *sql.DB, rawLine string, nowMs int64) *HookEvent {
	trimmed := bytes.TrimSpace([]byte(rawLine))
	if len(trimmed) == 0 {
		return nil
	}
	var raw interface{}
	if err := json.Unmarshal(trimmed, &raw); err != nil {
		return nil
	}

	canary.CheckForDrift(raw, db, nowMs)

	obj, ok := raw.(map[string]interface{})
	if !ok {
		return nil
	}
	event, err := parseHookPayloadFromObj(obj)
	if err != nil || missingRequiredField(event) {
		return nil
	}
	return event
}

// ingestLine is decodeLine + IngestHookEvent with the write failure folded
// into false -- the Go port of ingest.ts's ingestLine. Kept for single-line
// callers and tests; TailSpoolOnce deliberately uses the two halves directly
// so that a refused write keeps the spool file instead of being
// indistinguishable from a corrupt line.
func ingestLine(db *sql.DB, rawLine string, nowMs int64) bool {
	event := decodeLine(db, rawLine, nowMs)
	if event == nil {
		return false
	}
	return IngestHookEvent(db, event, nowMs) == nil
}
