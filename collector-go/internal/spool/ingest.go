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
// ingestLine below. Folding the two together here was wrong -- it made drift
// logging conditional on the payload also being parseable, so a known event
// missing BOTH its required field and its session_id (unparseable) silently
// produced no drift row at all, where the TS original logs one. See this
// branch's Task 9 parity report.
var ErrSkipped = errors.New("spool: event skipped (missing required field)")

// IngestHookEvent writes one already-parsed HookEvent into the events table,
// using nowMs as occurred_at_ms. Before inserting, it re-checks the event
// against canary.RequiredFieldsByEvent (the same table canary.ts exports and
// ingest.ts imports from it): if a known event is missing a field this
// collector depends on, ErrSkipped is returned instead of inserting --
// matching ingest.ts:30-35's missing-required-field skip, which never throws
// and never blocks the caller from moving on to the next line. The
// corresponding drift_log row is written earlier, by ingestLine's
// canary.CheckForDrift call (ingest.ts:22) -- see ErrSkipped's doc comment.
func IngestHookEvent(db *sql.DB, event *HookEvent, nowMs int64) error {
	if event == nil {
		return ErrSkipped
	}

	if required, ok := canary.RequiredFieldsByEvent[event.HookEventName]; ok {
		for _, field := range required {
			switch field {
			case "tool_name":
				if !event.rawHadToolName {
					return ErrSkipped
				}
			case "notification_type":
				if !event.rawHadNotificationType {
					return ErrSkipped
				}
			}
		}
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

// ingestLine is the Go port of ingest.ts's ingestLine, in the same order the
// TS original runs its steps: (1) trim + JSON.parse, bailing on anything
// unparseable; (2) run the drift canary against the RAW parsed payload,
// regardless of whether the payload turns out to be ingestible; (3) parse
// into the derived shape and insert, skipping on any guard. Any failure at
// any stage (empty line, malformed JSON, unrecognized shape, missing
// required field, DB error) simply skips the line and returns false -- a
// single corrupt line must never stop the tailer from processing the rest of
// the spool.
//
// Step 2's placement is load-bearing and was the subject of a real port bug:
// the canary must run on the raw payload BEFORE the typed parse (ingest.ts:22
// vs. ingest.ts:37), so that a known hook event missing both its required
// field and its session_id still produces the loud drift signal it does in
// the TS collector.
func ingestLine(db *sql.DB, rawLine string, nowMs int64) bool {
	trimmed := bytes.TrimSpace([]byte(rawLine))
	if len(trimmed) == 0 {
		return false
	}
	var raw interface{}
	if err := json.Unmarshal(trimmed, &raw); err != nil {
		return false
	}

	canary.CheckForDrift(raw, db, nowMs)

	event, err := ParseHookPayload(trimmed)
	if err != nil {
		return false
	}
	if err := IngestHookEvent(db, event, nowMs); err != nil {
		return false
	}
	return true
}
