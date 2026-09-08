package spool

import (
	"database/sql"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// TailResult mirrors spoolTailer.ts's tailSpoolOnce return shape.
type TailResult struct {
	// Files whose lines were all committed (or had nothing to commit) and
	// were deleted.
	FilesProcessed int
	LinesIngested  int
	// Files kept for the next pass because the database refused a write.
	FilesRetained int
}

// TailSpoolOnce is the Go port of spoolTailer.ts's tailSpoolOnce: reads every
// *.jsonl file in spoolDir, writes each file's events inside ONE transaction,
// and deletes the file only after that transaction commits.
//
// A spool file is the only copy of its hook events, so the delete has to be
// conditional on the write. Before this, every line's outcome collapsed into
// a bool and the file was removed regardless -- a collector.db held past
// busy_timeout by another reader (the Electron app, the Node collector) made
// every INSERT fail, and the whole file vanished with nothing logged.
//
// Two kinds of "not ingested" are treated differently on purpose:
//   - a line that can NEVER ingest (blank, malformed JSON, unknown shape,
//     missing required field) is skipped and does not hold the file back;
//   - a write the database REFUSED rolls the file's transaction back, keeps
//     the file, logs once, and lets the next pass retry it from scratch.
//
// The transaction is what makes that retry safe: events has no unique key,
// so committing half a file and retrying would duplicate the first half.
//
// A missing spoolDir, or a file that cannot be read (e.g. an in-progress
// append racing this read), is treated as "nothing to do this pass" rather
// than an error -- the tailer must never panic. If file deletion fails after
// a successful commit, the file's lines get re-ingested next pass; a rare
// duplicate insert there is a strictly safer failure mode than silently
// losing the file.
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

		// Decode (and run the drift canary) for every line BEFORE opening
		// the transaction: with SetMaxOpenConns(1) the transaction holds the
		// only connection, and a canary write from inside it would deadlock.
		var events []*HookEvent
		for _, line := range strings.Split(string(raw), "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" {
				continue
			}
			if event := decodeLine(db, trimmed, nowMs); event != nil {
				events = append(events, event)
			}
		}

		if len(events) > 0 {
			if err := writeAll(db, events, nowMs); err != nil {
				log.Printf("[aether-collector] spool: keeping %s, %d event(s) not written: %v", entry.Name(), len(events), err)
				result.FilesRetained++
				continue
			}
		}

		result.LinesIngested += len(events)
		result.FilesProcessed++

		_ = os.Remove(filePath)
	}

	return result
}

// writeAll is all-or-nothing: every event committed, or none and the error
// returned. decodeLine has already applied the missing-required-field guard,
// so any error here is a refused write, not a skip.
func writeAll(db *sql.DB, events []*HookEvent, nowMs int64) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	for _, event := range events {
		if err := IngestHookEvent(tx, event, nowMs); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// StartSpoolTailer starts a poll-based tailer that calls TailSpoolOnce every
// tailInterval, matching spoolTailer.ts's setInterval-based startSpoolTailer
// (poll-based, not fs-event-based). The returned stop function stops the
// ticker and must be called to release the goroutine.
//
// stop() blocks until the polling goroutine has fully exited before it
// returns. That guarantee closes a race: without it, a TailSpoolOnce pass
// could start (or still be in flight) after stop() returned and the caller had
// closed the database. TailSpoolOnce now keeps a file whose writes fail, so
// that race no longer loses data -- but a pass running against a closed
// database would still log a spurious "keeping" line per file, and closing
// the database under an open transaction is undefined territory. Once stop()
// returns, no further pass can begin and none is in progress, so it is safe
// to close db.
func StartSpoolTailer(db *sql.DB, spoolDir string, tailInterval time.Duration) (stop func()) {
	ticker := time.NewTicker(tailInterval)
	done := make(chan struct{})
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
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
		wg.Wait()
	}
}
