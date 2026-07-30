package spool

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// TailResult mirrors spoolTailer.ts's tailSpoolOnce return shape.
type TailResult struct {
	FilesProcessed int
	LinesIngested  int
}

// TailSpoolOnce is the Go port of spoolTailer.ts's tailSpoolOnce: reads every
// *.jsonl file in spoolDir, ingests each non-blank line, and deletes the file
// once its lines have been processed. A missing spoolDir, or a file that
// cannot be read (e.g. an in-progress append racing this read), is treated
// as "nothing to do this pass" rather than an error -- the tailer must never
// throw. If file deletion fails, the file's lines get re-ingested next pass;
// events is not unique-constrained on content, so a rare duplicate insert
// here is a strictly safer failure mode than silently losing the file.
func TailSpoolOnce(db *sql.DB, spoolDir string, nowMs int64) TailResult {
	entries, err := os.ReadDir(spoolDir)
	if err != nil {
		return TailResult{}
	}

	result := TailResult{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}

		filePath := filepath.Join(spoolDir, entry.Name())
		raw, err := os.ReadFile(filePath)
		if err != nil {
			// Racing an in-progress append -- leave the file for the next poll.
			continue
		}

		for _, line := range strings.Split(string(raw), "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" {
				continue
			}
			if ingestLine(db, trimmed, nowMs) {
				result.LinesIngested++
			}
		}
		result.FilesProcessed++

		_ = os.Remove(filePath)
	}

	return result
}

// StartSpoolTailer starts a poll-based tailer that calls TailSpoolOnce every
// tailInterval, matching spoolTailer.ts's setInterval-based startSpoolTailer
// (poll-based, not fs-event-based). The returned stop function stops the
// ticker and must be called to release the goroutine.
func StartSpoolTailer(db *sql.DB, spoolDir string, tailInterval time.Duration) (stop func()) {
	ticker := time.NewTicker(tailInterval)
	done := make(chan struct{})

	go func() {
		for {
			select {
			case <-ticker.C:
				TailSpoolOnce(db, spoolDir, time.Now().UnixMilli())
			case <-done:
				ticker.Stop()
				return
			}
		}
	}()

	return func() {
		close(done)
	}
}
