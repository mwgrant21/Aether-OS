// This file is the Go port of collector/src/anomalyIngest.ts: the three
// anomaly detectors (reReadLoop, writeDeleteRewrite, zeroEditBurn) and the
// ingestion pass that persists newly-closed tool calls plus any freshly
// detected anomalies.
//
// Anomaly dedup: the detectors re-scan a rolling 5-minute window on EVERY
// scan tick (~15s), so one genuine anomaly is re-detected on ~20 consecutive
// ticks. schema.go's unique index on anomalies(kind, tool_use_id) plus the
// INSERT OR IGNORE below collapses those repeats to a single persisted row
// instead of ~20 duplicate timeline entries. A plain INSERT here would
// silently reintroduce duplicate rows -- see schema.go's Migrate doc comment
// for the matching half of this contract.
package anomaly

import (
	"database/sql"
	"fmt"

	"github.com/mwgrant21/aether-os/collector-go/internal/transcript"
)

// Anomaly mirrors anomalyIngest.ts's Anomaly interface. Kind is one of
// "reReadLoop", "writeDeleteRewrite", "zeroEditBurn".
type Anomaly struct {
	Kind      string
	ToolUseID string
	Detail    string
}

// detectReReadLoop mirrors anomalyIngest.ts's detectReReadLoop: flags any
// file path read 3+ times within the supplied window, keyed to the most
// recently closed of those reads.
func detectReReadLoop(events []transcript.ClosedToolCall) []Anomaly {
	byPath := map[string][]transcript.ClosedToolCall{}
	order := []string{}
	for _, event := range events {
		if event.ToolName == "Read" && event.FilePath != nil {
			key := *event.FilePath
			if _, ok := byPath[key]; !ok {
				order = append(order, key)
			}
			byPath[key] = append(byPath[key], event)
		}
	}

	anomalies := []Anomaly{}
	for _, filePath := range order {
		reads := byPath[filePath]
		if len(reads) >= 3 {
			mostRecent := reads[0]
			for _, r := range reads[1:] {
				if r.ClosedAt > mostRecent.ClosedAt {
					mostRecent = r
				}
			}
			anomalies = append(anomalies, Anomaly{
				Kind:      "reReadLoop",
				ToolUseID: mostRecent.ToolUseID,
				Detail:    fmt.Sprintf("%s read %d times", filePath, len(reads)),
			})
		}
	}
	return anomalies
}

// detectWriteDeleteRewrite mirrors anomalyIngest.ts's
// detectWriteDeleteRewrite: flags any file path written (Write or Edit) 3+
// times within the trailing 5-minute window ending at nowMs.
func detectWriteDeleteRewrite(events []transcript.ClosedToolCall, nowMs int64) []Anomaly {
	windowStart := nowMs - 300000
	byPath := map[string][]transcript.ClosedToolCall{}
	order := []string{}
	for _, event := range events {
		if (event.ToolName == "Write" || event.ToolName == "Edit") && event.FilePath != nil && event.ClosedAt >= windowStart {
			key := *event.FilePath
			if _, ok := byPath[key]; !ok {
				order = append(order, key)
			}
			byPath[key] = append(byPath[key], event)
		}
	}

	anomalies := []Anomaly{}
	for _, filePath := range order {
		writes := byPath[filePath]
		if len(writes) >= 3 {
			mostRecent := writes[0]
			for _, w := range writes[1:] {
				if w.ClosedAt > mostRecent.ClosedAt {
					mostRecent = w
				}
			}
			anomalies = append(anomalies, Anomaly{
				Kind:      "writeDeleteRewrite",
				ToolUseID: mostRecent.ToolUseID,
				Detail:    fmt.Sprintf("%s written %d times in 5min", filePath, len(writes)),
			})
		}
	}
	return anomalies
}

// detectZeroEditBurn mirrors anomalyIngest.ts's detectZeroEditBurn: flags a
// window that burned tokensUsed >= 20000 with no Write/Edit/NotebookEdit tool
// call at all. See ingestToolCallsAndAnomalies's caller-side comment: this
// pass always calls it with tokensUsed 0 (no per-window token total is wired
// through the collector yet), so this branch never fires in the collector
// today -- that limitation is intentional, not silently dropped, and is
// preserved verbatim from the TS source.
func detectZeroEditBurn(events []transcript.ClosedToolCall, tokensUsed int64) []Anomaly {
	if tokensUsed < 20000 {
		return []Anomaly{}
	}
	hasEdits := false
	for _, e := range events {
		if e.ToolName == "Write" || e.ToolName == "Edit" || e.ToolName == "NotebookEdit" {
			hasEdits = true
			break
		}
	}
	if !hasEdits {
		return []Anomaly{{
			Kind:      "zeroEditBurn",
			ToolUseID: "",
			Detail:    fmt.Sprintf("%d tokens used with zero file edits", tokensUsed),
		}}
	}
	return []Anomaly{}
}

// IngestResult mirrors the object literal returned by
// ingestToolCallsAndAnomalies in the TS source.
type IngestResult struct {
	History           *transcript.ToolCallHistory
	ToolCallsIngested int
	AnomaliesIngested int
}

// IngestToolCallsAndAnomalies mirrors anomalyIngest.ts's
// ingestToolCallsAndAnomalies: advances history via transcript.UpdateHistory,
// persists the newly-closed tool calls (diffed by toolUseId membership, not
// array index/length -- see updateHistory's HISTORY_MAX_EVENTS truncation
// comment in toolcallhistory.go), runs the three anomaly detectors over the
// trailing 5-minute window, and persists any freshly detected anomalies via
// INSERT OR IGNORE so repeat detections across scan ticks collapse to one row.
// sourceFileRel is the project-relative transcript path the events came from
// (never absolute -- docs/privacy-and-data.md SS5). It is persisted on each
// tool_calls row so resolveDispatchEvidence can correlate a dispatch to the
// exact file its tool calls were observed in. Mirrors anomalyIngest.ts's
// fifth parameter; before issue #32 this collector had no such parameter and
// left the column NULL for EVERY tool call, top-level and nested alike.
func IngestToolCallsAndAnomalies(db *sql.DB, history *transcript.ToolCallHistory, events []transcript.Event, nowMs int64, sourceFileRel string) (*IngestResult, error) {
	newHistory := transcript.UpdateHistory(history, events, nowMs)

	priorToolUseIDs := make(map[string]bool, len(history.Events))
	for _, e := range history.Events {
		priorToolUseIDs[e.ToolUseID] = true
	}
	newlyClosed := []transcript.ClosedToolCall{}
	for _, e := range newHistory.Events {
		if !priorToolUseIDs[e.ToolUseID] {
			newlyClosed = append(newlyClosed, e)
		}
	}

	insertToolCall, err := db.Prepare(
		`INSERT INTO tool_calls (tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms, source_file_rel) VALUES (?, ?, ?, ?, ?, ?)`,
	)
	if err != nil {
		return nil, err
	}
	defer insertToolCall.Close()

	for _, call := range newlyClosed {
		// call.FilePath is already project-relative-or-nil by construction:
		// toolcallhistory.go's UpdateHistory sanitizes it against the event's
		// own cwd the moment it enters the history, so no per-call-site
		// sanitization is needed here (and none can be forgotten in the
		// anomaly detail builders either).
		if _, err := insertToolCall.Exec(call.ToolUseID, call.ToolName, call.FilePath, call.StartedAt, call.ClosedAt, sourceFileRel); err != nil {
			return nil, err
		}
	}

	windowStart := nowMs - 300000
	recentWindow := []transcript.ClosedToolCall{}
	for _, e := range newHistory.Events {
		if e.ClosedAt >= windowStart {
			recentWindow = append(recentWindow, e)
		}
	}

	anomalies := []Anomaly{}
	anomalies = append(anomalies, detectReReadLoop(recentWindow)...)
	anomalies = append(anomalies, detectWriteDeleteRewrite(recentWindow, nowMs)...)
	// detectZeroEditBurn is called with tokensUsed 0 here deliberately -- see
	// its doc comment above.
	anomalies = append(anomalies, detectZeroEditBurn(recentWindow, 0)...)

	insertAnomaly, err := db.Prepare(
		`INSERT OR IGNORE INTO anomalies (kind, tool_use_id, detail, detected_at_ms) VALUES (?, ?, ?, ?)`,
	)
	if err != nil {
		return nil, err
	}
	defer insertAnomaly.Close()

	anomaliesIngested := 0
	for _, a := range anomalies {
		res, err := insertAnomaly.Exec(a.Kind, a.ToolUseID, a.Detail, nowMs)
		if err != nil {
			return nil, err
		}
		affected, err := res.RowsAffected()
		if err != nil {
			return nil, err
		}
		if affected > 0 {
			anomaliesIngested++
		}
	}

	return &IngestResult{
		History:           newHistory,
		ToolCallsIngested: len(newlyClosed),
		AnomaliesIngested: anomaliesIngested,
	}, nil
}
