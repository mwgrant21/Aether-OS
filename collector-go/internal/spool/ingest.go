package spool

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// ErrSkipped is returned by IngestHookEvent when a known event is missing a
// field this collector depends on -- the drift canary case from
// collector/src/canary.ts's checkForDrift + collector/src/ingest.ts's
// missing-required-field guard, both folded in here. This check uses
// HookEvent's unexported rawHad* fields (raw JSON presence: not
// undefined/null), NOT the exported ToolName/NotificationType pointers --
// canary.ts's checkForDrift runs against the raw untyped payload, where e.g.
// `"tool_name": ""` counts as present, even though hookPayload.ts's own
// stringField (which does produce ToolName) treats an empty string as
// absent. Conflating the two would flag `"tool_name": ""` as drift, which
// the TS original does not. A drift_log row is written before this is
// returned; the event is never inserted.
var ErrSkipped = errors.New("spool: event skipped (missing required field)")

// requiredFieldsByEvent mirrors canary.ts's REQUIRED_FIELDS_BY_EVENT: the
// fields this collector depends on for each known hook event type.
var requiredFieldsByEvent = map[string][]string{
	"PreToolUse":   {"tool_name"},
	"PostToolUse":  {"tool_name"},
	"Notification": {"notification_type"},
	"Stop":         {},
}

// IngestHookEvent writes one already-parsed HookEvent into the events table,
// using nowMs as occurred_at_ms. Before inserting, it re-checks the event
// against requiredFieldsByEvent (the drift canary): if a known event is
// missing a field this collector depends on, a drift_log row is written and
// ErrSkipped is returned instead of inserting -- matching ingest.ts's
// checkForDrift + missing-required-field skip, which never throws and never
// blocks the caller from moving on to the next line.
func IngestHookEvent(db *sql.DB, event *HookEvent, nowMs int64) error {
	if event == nil {
		return ErrSkipped
	}

	if required, ok := requiredFieldsByEvent[event.HookEventName]; ok {
		var missing []string
		for _, field := range required {
			switch field {
			case "tool_name":
				if !event.rawHadToolName {
					missing = append(missing, field)
				}
			case "notification_type":
				if !event.rawHadNotificationType {
					missing = append(missing, field)
				}
			}
		}
		if len(missing) > 0 {
			detail := fmt.Sprintf("%s payload missing expected field(s): %s", event.HookEventName, strings.Join(missing, ", "))
			// Best-effort: a failure to log drift must never stop ingest
			// from correctly skipping the event, mirroring canary.ts's own
			// try/catch backstop.
			_, _ = db.Exec(`INSERT INTO drift_log (detected_at_ms, detail) VALUES (?, ?)`, nowMs, detail)
			return ErrSkipped
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

// ingestLine is the Go port of ingest.ts's ingestLine: parses one raw spool
// line and, if valid, inserts it. Any failure at any stage (empty line,
// malformed JSON, unrecognized shape, missing required field, DB error)
// simply skips the line and returns false -- a single corrupt line must
// never stop the tailer from processing the rest of the spool.
func ingestLine(db *sql.DB, rawLine string, nowMs int64) bool {
	event, err := ParseHookPayload([]byte(rawLine))
	if err != nil {
		return false
	}
	if err := IngestHookEvent(db, event, nowMs); err != nil {
		return false
	}
	return true
}
