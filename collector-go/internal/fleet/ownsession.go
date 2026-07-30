package fleet

import (
	"encoding/json"
	"os"
)

// ReadOwnSessionID mirrors ownSessionFile.ts's readOwnSessionId: reads the
// pty-pinned own-session-id file and returns its sessionId, or nil for any
// failure (missing file, malformed JSON, wrong shape, empty/non-string
// sessionId) -- never an error, matching the TS original's blanket
// try/catch-to-null behavior.
func ReadOwnSessionID(filePath string) *string {
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return nil
	}

	var parsed interface{}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil
	}

	obj, ok := parsed.(map[string]interface{})
	if !ok {
		return nil
	}

	sessionID, ok := obj["sessionId"].(string)
	if !ok || sessionID == "" {
		return nil
	}
	return &sessionID
}
