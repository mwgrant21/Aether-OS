// This file is the Go port of collector/src/transcriptScan.ts: the
// orchestration that discovers project directories under the transcripts
// root, tails each *.jsonl file for newly-appended lines, parses them, and
// ingests usage events and dispatch completions.
//
// anomalyIngest.ts's tool-call/anomaly ingestion (ingestToolCallsAndAnomalies)
// is NOT ported here -- that is a later task's scope. This function still
// updates the per-file ToolCallHistory (via UpdateHistory) on every scan tick
// so Agent-dispatch open/close tracking (and therefore IngestDispatchEvent)
// works correctly independent of that later task.
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

// ScanTranscriptsOnce mirrors transcriptScan.ts's scanTranscriptsOnce.
// toolCallHistoryByFile is keyed by the same project-relative path stored in
// transcript_files (never an absolute path -- docs/privacy-and-data.md SS5).
func ScanTranscriptsOnce(db *sql.DB, projectsRoot string, nowMs int64, toolCallHistoryByFile map[string]*ToolCallHistory) error {
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
			newHistory := UpdateHistory(priorHistory, parsedEvents, nowMs)
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
		}
	}

	return nil
}
