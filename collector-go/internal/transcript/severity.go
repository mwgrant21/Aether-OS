// Go port of electron/severity/computeSeverity.ts and baselineMath.ts (source
// of truth; the collector/src copies are generated), plus medianDurationMsFor
// from collector/src/usageIngest.ts. Edit the TS first, then mirror here. No
// Go sync script exists.
//
// Not ported: the toolErrors floor (needs the subagent transcript metadata)
// and findingWeights (nothing in the collector supplies them).
package transcript

import (
	"database/sql"
	"math"
	"sort"
)

// ExitState is the dispatches.exit_state vocabulary.
type ExitState string

const (
	ExitOK      ExitState = "ok"
	ExitPartial ExitState = "partial"
	ExitError   ExitState = "error"
	ExitFatal   ExitState = "fatal"
	ExitTimeout ExitState = "timeout"
	ExitBlocked ExitState = "blocked"
	ExitKilled  ExitState = "killed"
)

const (
	SlowFactor         = 3
	SlownessCap        = 2
	BaselineMinSamples = 5
	BaselineWindow     = 20
)

// ExitStateForStatus maps a notification status to an exit state: failed ->
// error, killed -> killed, everything else (completed, unknown) -> ok.
func ExitStateForStatus(status DispatchStatus) ExitState {
	switch status {
	case StatusFailed:
		return ExitError
	case StatusKilled:
		return ExitKilled
	}
	return ExitOK
}

// ComputeSeverity returns the 0..4 severity and the median that was actually
// used (nil when medianMs is nil, not finite or not > 0).
func ComputeSeverity(exit ExitState, elapsedMs int64, medianMs *float64) (int, *float64) {
	var median *float64
	if medianMs != nil && !math.IsNaN(*medianMs) && !math.IsInf(*medianMs, 0) && *medianMs > 0 {
		median = medianMs
	}

	sev := 1
	if median != nil && float64(elapsedMs) > float64(SlowFactor)*(*median) {
		sev = min(sev+1, SlownessCap)
	}

	switch exit {
	case ExitPartial:
		sev = max(sev, 2)
	case ExitTimeout:
		sev = max(sev, 3)
	case ExitError, ExitFatal:
		sev = max(sev, 4)
	case ExitBlocked:
		sev = 4
	}

	// Last on purpose: a kill is informational and must never reach the
	// severity >= 3 floor, whatever else is true.
	if exit == ExitKilled {
		sev = 2
	}
	return min(4, max(0, sev)), median
}

// MedianOf takes duration samples oldest first: non-positive values are
// dropped, the last BaselineWindow kept, and fewer than BaselineMinSamples
// means no median (nil). An even count averages the two middle values.
func MedianOf(samplesOldestFirst []int64) *float64 {
	valid := make([]int64, 0, len(samplesOldestFirst))
	for _, n := range samplesOldestFirst {
		if n > 0 {
			valid = append(valid, n)
		}
	}
	if len(valid) > BaselineWindow {
		valid = valid[len(valid)-BaselineWindow:]
	}
	if len(valid) < BaselineMinSamples {
		return nil
	}
	sort.Slice(valid, func(i, j int) bool { return valid[i] < valid[j] })
	mid := len(valid) / 2
	var m float64
	if len(valid)%2 == 0 {
		m = (float64(valid[mid-1]) + float64(valid[mid])) / 2
	} else {
		m = float64(valid[mid])
	}
	return &m
}

// MedianDurationMsFor is the median of this agent type's own successful
// history: completed (or pre-status NULL) ok rows with duration_ms > 0, last
// BaselineWindow, minimum BaselineMinSamples. The row being ingested is
// excluded and only rows that ended before beforeMs count, so a row is never
// scored against itself or its own future. A nil agentID has no baseline.
func MedianDurationMsFor(db *sql.DB, agentID *string, excludeToolUseID string, beforeMs int64) (*float64, error) {
	if agentID == nil {
		return nil, nil
	}
	rows, err := db.Query(
		`SELECT duration_ms FROM dispatches
		  WHERE agent_id = ? AND exit_state = 'ok' AND (dispatch_status = 'completed' OR dispatch_status IS NULL)
		    AND duration_ms > 0 AND tool_use_id != ? AND ended_at_ms < ?
		  ORDER BY ended_at_ms DESC LIMIT ?`,
		*agentID, excludeToolUseID, beforeMs, BaselineWindow,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var newestFirst []int64
	for rows.Next() {
		var d int64
		if err := rows.Scan(&d); err != nil {
			return nil, err
		}
		newestFirst = append(newestFirst, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	oldestFirst := make([]int64, len(newestFirst))
	for i, d := range newestFirst {
		oldestFirst[len(newestFirst)-1-i] = d
	}
	return MedianOf(oldestFirst), nil
}
