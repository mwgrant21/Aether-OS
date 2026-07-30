// Package spool is the Go port of collector/src/spoolTailer.ts,
// collector/src/hookPayload.ts, and collector/src/ingest.ts: it tails the
// spool directory for new .jsonl hook-event files, parses each line into a
// typed HookEvent, and inserts it into the events table.
package spool

import (
	"bytes"
	"encoding/json"
	"errors"
)

// ErrEmptyLine is returned by ParseHookPayload for a blank/whitespace-only line.
var ErrEmptyLine = errors.New("spool: empty line")

// ErrMalformedJSON is returned by ParseHookPayload when the line is not valid JSON.
var ErrMalformedJSON = errors.New("spool: malformed json")

// ErrInvalidPayload is returned by ParseHookPayload when the parsed JSON is
// not a recognizable hook-event payload (not an object, unknown/missing
// hook_event_name, or missing session_id).
var ErrInvalidPayload = errors.New("spool: invalid hook payload")

var knownEventNames = map[string]bool{
	"PreToolUse":   true,
	"PostToolUse":  true,
	"Notification": true,
	"Stop":         true,
}

// HookEvent is the Go port of hookPayload.ts's ParsedHookEvent: the minimal
// derived shape this collector persists. Deliberately drops tool_input /
// tool_response / message content entirely -- only their *presence* is
// recorded (privacy-and-data.md SS4: store the signal, not the payload).
type HookEvent struct {
	HookEventName    string
	SessionID        string
	CWD              *string
	ToolName         *string
	HadToolInput     bool
	HadToolResponse  bool
	NotificationType *string

	// rawHadToolName / rawHadNotificationType mirror canary.ts's
	// checkForDrift semantics exactly: true when the raw JSON field was
	// present and non-null, regardless of type or emptiness (so
	// `"tool_name": ""` counts as present here, even though ToolName above
	// is nil for it -- stringField's stricter "non-empty string" rule is
	// hookPayload.ts's own semantics, a different, unrelated notion of
	// "missing" from canary.ts's). Unexported: internal to the drift check
	// in ingest.go, not part of the public HookEvent contract.
	rawHadToolName         bool
	rawHadNotificationType bool
}

// ParseHookPayload parses one raw hook JSON line (as Claude Code sends it on
// stdin, one JSON object per spool line) into the minimal derived shape this
// collector persists. Never panics: any malformed or unrecognized shape
// returns a non-nil error, which callers must treat as "skip this line," not
// a fatal error. occurred_at_ms is NOT part of HookEvent -- callers (see
// IngestHookEvent) supply the receive timestamp at ingest time.
func ParseHookPayload(line []byte) (*HookEvent, error) {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 {
		return nil, ErrEmptyLine
	}

	var raw interface{}
	if err := json.Unmarshal(trimmed, &raw); err != nil {
		return nil, ErrMalformedJSON
	}

	obj, ok := raw.(map[string]interface{})
	if !ok {
		return nil, ErrInvalidPayload
	}

	hookEventName := stringField(obj, "hook_event_name")
	if hookEventName == nil || !knownEventNames[*hookEventName] {
		return nil, ErrInvalidPayload
	}

	sessionID := stringField(obj, "session_id")
	if sessionID == nil {
		return nil, ErrInvalidPayload
	}

	return &HookEvent{
		HookEventName:    *hookEventName,
		SessionID:        *sessionID,
		CWD:              stringField(obj, "cwd"),
		ToolName:         stringField(obj, "tool_name"),
		HadToolInput:     presentField(obj, "tool_input"),
		HadToolResponse:  presentField(obj, "tool_response"),
		NotificationType: stringField(obj, "notification_type"),

		rawHadToolName:         presentField(obj, "tool_name"),
		rawHadNotificationType: presentField(obj, "notification_type"),
	}, nil
}

// stringField mirrors hookPayload.ts's stringField: returns nil unless the
// key holds a non-empty string.
func stringField(obj map[string]interface{}, key string) *string {
	v, ok := obj[key]
	if !ok {
		return nil
	}
	s, ok := v.(string)
	if !ok || s == "" {
		return nil
	}
	return &s
}

// presentField mirrors the `obj[key] !== undefined && obj[key] !== null`
// presence checks used for hadToolInput / hadToolResponse.
func presentField(obj map[string]interface{}, key string) bool {
	v, ok := obj[key]
	return ok && v != nil
}
