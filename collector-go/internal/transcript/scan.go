// This file is the Go port of collector/src/transcriptScan.ts: the
// orchestration that discovers project directories under the transcripts
// root, tails each *.jsonl file for newly-appended lines, parses them, and
// ingests usage events and dispatch completions.
//
// anomalyIngest.ts's tool-call/anomaly ingestion (ingestToolCallsAndAnomalies)
// is wired in via the AnomalyIngestFunc parameter below, injected by the
// caller (internal/collector, Task 8) rather than called directly from this
// package. This package cannot import internal/anomaly itself: the anomaly
// package already imports this package's types (Event, ToolCallHistory,
// ClosedToolCall), so a direct import here would be a cycle. When
// ingestAnomalies is nil (every pre-existing test in this file passes nil),
// ScanTranscriptsOnce falls back to a plain UpdateHistory call with no
// anomaly detection, preserving this package's original Task 4 behavior
// exactly.
package transcript

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"

	"github.com/mwgrant21/aether-os/collector-go/internal/schema"
)

func getLastOffset(db *sql.DB, filePath string) (int64, error) {
	var offset int64
	err := db.QueryRow(`SELECT last_offset FROM transcript_files WHERE file_path = ?`, filePath).Scan(&offset)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return offset, nil
}

func recordOffset(db *sql.DB, filePath string, offset int64, nowMs int64) error {
	_, err := db.Exec(
		`INSERT INTO transcript_files (file_path, last_offset, last_scanned_ms) VALUES (?, ?, ?)
		 ON CONFLICT(file_path) DO UPDATE SET last_offset = excluded.last_offset, last_scanned_ms = excluded.last_scanned_ms`,
		filePath, offset, nowMs,
	)
	return err
}

// AnomalyIngestFunc matches the shape of anomaly.IngestToolCallsAndAnomalies
// (db, priorHistory, parsedEvents, nowMs) -> (newHistory, error), minus that
// package's own IngestResult wrapper type (which also carries
// ToolCallsIngested/AnomaliesIngested counts -- not needed by this package's
// return value, since ScanTranscriptsOnce, like transcriptScan.ts's Go port,
// only returns an error, not the TS original's stats object). Defined here
// (not in internal/anomaly) purely to break the import cycle described in
// this file's top doc comment: internal/collector supplies a closure that
// adapts anomaly.IngestToolCallsAndAnomalies to this signature.
type AnomalyIngestFunc func(db *sql.DB, history *ToolCallHistory, events []Event, nowMs int64, sourceFileRel string) (*ToolCallHistory, error)

// ScanTranscriptsOnce mirrors transcriptScan.ts's scanTranscriptsOnce.
// toolCallHistoryByFile is keyed by the same project-relative path stored in
// transcript_files (never an absolute path -- docs/privacy-and-data.md SS5).
// ingestAnomalies, when non-nil, replaces the plain UpdateHistory call with a
// call that also runs anomaly detection and persists tool_calls/anomalies
// rows (matching transcriptScan.ts:112's call to ingestToolCallsAndAnomalies);
// pass nil to get the pre-Task-8 behavior (history tracking only, no anomaly
// detection) -- see this file's top doc comment.
func ScanTranscriptsOnce(db *sql.DB, projectsRoot string, nowMs int64, toolCallHistoryByFile map[string]*ToolCallHistory, ingestAnomalies AnomalyIngestFunc) error {
	// Stamped first and unconditionally: the heartbeat proves the scan cycle
	// is alive, not that it succeeded, so the unreadable-projects-root early
	// return below must not skip it.
	if err := schema.StampTranscriptScanHeartbeat(db, nowMs); err != nil {
		return err
	}

	entries, err := os.ReadDir(projectsRoot)
	if err != nil {
		return nil
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dirName := entry.Name()
		dirPath := filepath.Join(projectsRoot, dirName)
		files, err := os.ReadDir(dirPath)
		if err != nil {
			continue
		}

		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			file := f.Name()
			// filePath is absolute and used for all actual filesystem
			// operations; relativePath is what's stored in (and looked up
			// from) the transcript_files table, per docs/privacy-and-data.md
			// SS5 -- that table must never persist a path containing the
			// home directory/username.
			filePath := filepath.Join(dirPath, file)
			relativePath := filepath.Join(dirName, file)

			offset, err := getLastOffset(db, relativePath)
			if err != nil {
				return err
			}

			lines, newOffset, err := ReadNewLines(filePath, offset)
			if err != nil {
				continue
			}

			parsedEvents := make([]Event, 0, len(lines))
			for _, l := range lines {
				if e := ParseTranscriptLine(l); e != nil {
					parsedEvents = append(parsedEvents, *e)
				}
			}

			for i := range parsedEvents {
				if _, err := IngestUsageEvent(db, &parsedEvents[i]); err != nil {
					return err
				}
			}

			priorHistory := toolCallHistoryByFile[relativePath]
			if priorHistory == nil {
				priorHistory = CreateEmptyHistory()
			}
			var newHistory *ToolCallHistory
			if ingestAnomalies != nil {
				newHistory, err = ingestAnomalies(db, priorHistory, parsedEvents, nowMs, relativePath)
				if err != nil {
					return err
				}
			} else {
				newHistory = UpdateHistory(priorHistory, parsedEvents, nowMs)
			}
			toolCallHistoryByFile[relativePath] = newHistory

			// Dispatch (Agent subagent) completion. IngestDispatchEvent
			// applies its own guards and no-ops unless the event is a
			// genuine 'user'-kind 'task-notification' carrying a
			// <tool-use-id> that matches a still-open 'Agent' tool call, so
			// it is simply offered every parsed event -- no loop over
			// OpenByToolUseID, which would fan one completion out across
			// every open dispatch.
			for i := range parsedEvents {
				if _, err := IngestDispatchEvent(db, newHistory, &parsedEvents[i]); err != nil {
					return err
				}
			}

			if err := recordOffset(db, relativePath, newOffset, nowMs); err != nil {
				return err
			}

			// Nested subagent transcripts, mirroring transcriptScan.ts:200-227.
			// A dispatched subagent's own turns live in
			//   <dirPath>/<sessionBase>/subagents/agent-<id>.jsonl
			// and carry their own token usage and tool calls. This collector
			// previously had no subagents/ handling at all, so it missed that
			// entire path -- usage, tool calls and anomalies alike -- while
			// the Node collector read it. See issue #29 and the parity harness
			// in test-fixtures/collector-parity/.
			//
			// IngestDispatchEvent is deliberately NOT called here, matching the
			// Node nested loop: a dispatch completion appears in the PARENT
			// transcript as a task-notification, never in the subagent's own
			// file. Sharing one helper between the two loops would wrongly add
			// dispatch ingestion to nested files.
			//
			// relativePath must be keyed exactly as the Node collector keys it
			// -- both write the same transcript_files table, so a file keyed
			// two ways is scanned twice and its usage double counted.
			sessionBase := strings.TrimSuffix(file, ".jsonl")
			subDirPath := filepath.Join(dirPath, sessionBase, "subagents")
			subFiles, err := os.ReadDir(subDirPath)
			if err != nil {
				// No subagents directory is the expected, common case (most
				// sessions dispatch nothing).
				continue
			}

			for _, sf := range subFiles {
				if sf.IsDir() || !strings.HasSuffix(sf.Name(), ".jsonl") {
					continue
				}
				subFilePath := filepath.Join(subDirPath, sf.Name())
				subRelativePath := filepath.Join(dirName, sessionBase, "subagents", sf.Name())

				subOffset, err := getLastOffset(db, subRelativePath)
				if err != nil {
					return err
				}

				subLines, subNewOffset, err := ReadNewLines(subFilePath, subOffset)
				if err != nil {
					continue
				}

				subParsedEvents := make([]Event, 0, len(subLines))
				for _, l := range subLines {
					if e := ParseTranscriptLine(l); e != nil {
						subParsedEvents = append(subParsedEvents, *e)
					}
				}

				for i := range subParsedEvents {
					if _, err := IngestUsageEvent(db, &subParsedEvents[i]); err != nil {
						return err
					}
				}

				subPriorHistory := toolCallHistoryByFile[subRelativePath]
				if subPriorHistory == nil {
					subPriorHistory = CreateEmptyHistory()
				}
				var subNewHistory *ToolCallHistory
				if ingestAnomalies != nil {
					subNewHistory, err = ingestAnomalies(db, subPriorHistory, subParsedEvents, nowMs, subRelativePath)
					if err != nil {
						return err
					}
				} else {
					subNewHistory = UpdateHistory(subPriorHistory, subParsedEvents, nowMs)
				}
				toolCallHistoryByFile[subRelativePath] = subNewHistory

				if err := recordOffset(db, subRelativePath, subNewOffset, nowMs); err != nil {
					return err
				}
			}
		}
	}

	return nil
}
