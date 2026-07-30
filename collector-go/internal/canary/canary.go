// Package canary is the Go port of collector/src/canary.ts: a best-effort
// "contract drift" detector that flags when a raw hook payload for a KNOWN
// event type is missing a field this collector depends on, signalling that
// Claude Code's hook payload shape drifted since this was written. It never
// blocks ingest and never panics past its own boundary.
package canary

import (
	"database/sql"
	"fmt"
	"os"
	"strings"
)

// RequiredFieldsByEvent mirrors canary.ts's REQUIRED_FIELDS_BY_EVENT: the
// fields this collector depends on for each known hook event type.
var RequiredFieldsByEvent = map[string][]string{
	"PreToolUse":   {"tool_name"},
	"PostToolUse":  {"tool_name"},
	"Notification": {"notification_type"},
	"Stop":         {},
}

// LogDrift mirrors canary.ts's logDrift: writes a loud stderr line (matching
// console.error, not the Write-Host-equivalent trap) plus a drift_log row.
func LogDrift(db *sql.DB, nowMs int64, detail string) error {
	fmt.Fprintf(os.Stderr, "[aether-collector] contract drift detected: %s\n", detail)
	_, err := db.Exec(`INSERT INTO drift_log (detected_at_ms, detail) VALUES (?, ?)`, nowMs, detail)
	return err
}

// CheckForDrift mirrors canary.ts's checkForDrift: checks a raw (unparsed)
// hook payload against the fields this collector depends on for its KNOWN
// event types, logging loudly (stderr + a drift_log row) when a known event
// is missing a field it should have. Never panics and never blocks ingest --
// a wholly unrecognized event name is parseHookPayload's concern (silently
// skipped there), not drift here. A failure to write the drift_log row
// itself is swallowed, mirroring canary.ts's own try/catch backstop: a
// canary bug (or a DB write failure) must never break ingest.
func CheckForDrift(raw interface{}, db *sql.DB, nowMs int64) {
	defer func() {
		_ = recover()
	}()

	obj, ok := raw.(map[string]interface{})
	if !ok {
		return
	}

	eventNameVal, exists := obj["hook_event_name"]
	if !exists {
		return
	}
	eventName, ok := eventNameVal.(string)
	if !ok {
		return
	}

	required, known := RequiredFieldsByEvent[eventName]
	if !known {
		return
	}

	var missing []string
	for _, field := range required {
		v, exists := obj[field]
		if !exists || v == nil {
			missing = append(missing, field)
		}
	}
	if len(missing) > 0 {
		_ = LogDrift(db, nowMs, fmt.Sprintf("%s payload missing expected field(s): %s", eventName, strings.Join(missing, ", ")))
	}
}
