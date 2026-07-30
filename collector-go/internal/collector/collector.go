// Package collector is the Go port of collector/src/index.ts's orchestration
// layer: opening the SQLite database, migrating it, and starting the four
// independent periodic loops (spool tail, compaction, transcript scan, fleet
// poll) that make up the running collector process. It is the testable core
// consumed by cmd/aether-collector/main.go's thin process wrapper, matching
// index.ts's own separation between the exported startCollector function and
// the isMainModule guard block that only runs in the real process.
package collector

import (
	"database/sql"
	"log"
	"sync"
	"time"

	"github.com/mwgrant21/aether-os/collector-go/internal/anomaly"
	"github.com/mwgrant21/aether-os/collector-go/internal/fleet"
	"github.com/mwgrant21/aether-os/collector-go/internal/retention"
	"github.com/mwgrant21/aether-os/collector-go/internal/schema"
	"github.com/mwgrant21/aether-os/collector-go/internal/spool"
	"github.com/mwgrant21/aether-os/collector-go/internal/transcript"
)

// Options mirrors the options object index.ts's startCollector takes
// (index.ts:34-43), with Go-idiomatic time.Duration fields in place of the TS
// "*IntervalMs number" fields.
type Options struct {
	DBPath                 string
	SpoolDir               string
	TailInterval           time.Duration
	CompactInterval        time.Duration
	ProjectsRoot           string
	TranscriptScanInterval time.Duration
	OwnSessionFilePath     string
	FleetPollInterval      time.Duration

	// FleetExecFn is the injectable `claude agents --json` subprocess call,
	// matching fleetPoll.ts's FleetExecFn / index.ts:16-19's precedent of
	// taking it as an optional parameter so tests never shell out to a real
	// binary. Nil uses fleet's real default exec (a live `claude` process).
	FleetExecFn fleet.FleetExecFn
}

// ingestAnomalies adapts anomaly.IngestToolCallsAndAnomalies to
// transcript.AnomalyIngestFunc's signature. This is the one place
// internal/collector imports BOTH internal/transcript and internal/anomaly,
// which is exactly why scan.go could not call anomaly directly (that would
// be a transcript -> anomaly -> transcript import cycle, since anomaly
// already depends on transcript's types) -- see scan.go's top doc comment.
func ingestAnomalies(db *sql.DB, history *transcript.ToolCallHistory, events []transcript.Event, nowMs int64) (*transcript.ToolCallHistory, error) {
	result, err := anomaly.IngestToolCallsAndAnomalies(db, history, events, nowMs)
	if err != nil {
		return nil, err
	}
	return result.History, nil
}

// PollAndUpsertFleet mirrors index.ts's exported pollAndUpsertFleet
// (index.ts:16-32): reads the own-session id, polls the fleet, and upserts
// the resulting sessions (an empty slice on any poll failure, since
// fleet.PollFleet returns nil on failure and that is normalized to []
// here -- matching upsertFleetSessions(db, sessions ?? [], nowMs)). The fleet
// heartbeat is stamped unconditionally via defer, exactly mirroring the TS
// original's try/finally: the heartbeat proves the poll cycle is alive, not
// that it succeeded, so it must be stamped even when UpsertFleetSessions
// itself errors below.
func PollAndUpsertFleet(db *sql.DB, ownSessionFilePath string, execFn fleet.FleetExecFn) error {
	ownSessionID := fleet.ReadOwnSessionID(ownSessionFilePath)
	nowMs := time.Now().UnixMilli()

	var upsertErr error
	defer func() {
		if hbErr := schema.StampFleetHeartbeat(db, nowMs); hbErr != nil && upsertErr == nil {
			upsertErr = hbErr
		}
	}()

	sessions := fleet.PollFleet(db, ownSessionID, nowMs, execFn)
	if sessions == nil {
		sessions = []fleet.FleetSession{}
	}
	upsertErr = fleet.UpsertFleetSessions(db, sessions, nowMs)
	return upsertErr
}

// startTickerLoop runs fn on every tick of a time.NewTicker(interval) until
// done is closed, then stops the ticker and returns. Shared by the
// compaction, transcript-scan, and fleet-poll loops below, all three of
// which are simple "tick -> run fn" loops in the TS original
// (index.ts:48,51-54,59-63) built directly on setInterval.
func startTickerLoop(wg *sync.WaitGroup, done <-chan struct{}, interval time.Duration, fn func()) {
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				fn()
			case <-done:
				return
			}
		}
	}()
}

// StartCollector is the Go port of index.ts's startCollector (index.ts:34-72):
// opens the database, migrates it, and starts all four periodic loops --
// spool tail, compaction, transcript scan (now wired to run anomaly
// detection every tick via ingestAnomalies above, matching
// transcriptScan.ts:112's call to ingestToolCallsAndAnomalies), and fleet
// poll. Matching index.ts:50 and :56-63, the transcript scan and fleet poll
// loops each run once immediately (synchronously, before this function
// returns) in addition to their interval; the spool tail and compaction
// loops are interval-only, with no immediate run, matching index.ts:47-48.
//
// A failure in any one loop's tick is logged and does not stop the others --
// matching index.ts:56-63's .catch(err => console.error(...)) wrapping of
// every pollAndUpsertFleet call; retention.Compact and
// transcript.ScanTranscriptsOnce errors are logged the same way here for the
// same reason (a single-loop failure must never take down the process or the
// other three loops).
//
// The returned stop function halts all four loops and closes the database,
// matching index.ts:65-71's returned () => void. Unlike the TS original
// (where the immediate pollAndUpsertFleet call is fired without being
// awaited, per index.ts:56-58), this port runs the immediate transcript-scan
// and fleet-poll calls synchronously before returning stop, so that calling
// stop immediately after StartCollector returns can never race an in-flight
// call against db.Close() -- a deliberate, disclosed safety improvement for
// goroutine/DB-handle safety, not a steady-state behavior change (see this
// task's report).
func StartCollector(options Options) (stop func(), err error) {
	db, err := schema.OpenDatabase(options.DBPath)
	if err != nil {
		return nil, err
	}
	if err := schema.Migrate(db); err != nil {
		db.Close()
		return nil, err
	}

	// index.ts's four loops never truly run concurrently: Node is
	// single-threaded, so each setInterval callback's DB calls run to
	// completion before the next callback can start -- there is no
	// equivalent in the TS original of two loops writing to the database at
	// the same instant. Go's goroutines are real parallelism, and
	// modernc.org/sqlite's default busy_timeout is 0 (a second writer gets
	// an immediate SQLITE_BUSY rather than waiting), so without this, the
	// four loops started below can race for the file lock -- observed
	// directly during this task's own test-writing: a spool-tail tick's
	// INSERT INTO events failing with SQLITE_BUSY while a concurrent
	// fleet-poll tick held the write lock, after which TailSpoolOnce still
	// deleted the now-unrecoverably-lost spool file (spool/tailer.go deletes
	// unconditionally once a file's lines have been processed, successfully
	// or not). SetMaxOpenConns(1) makes database/sql serialize every caller
	// through one physical connection, which is what actually restores the
	// TS original's serialized-DB-access model on top of Go's real
	// concurrency -- not a new behavior, the correct port of an assumption
	// the TS runtime made implicitly. See this task's report.
	db.SetMaxOpenConns(1)

	stopTailer := spool.StartSpoolTailer(db, options.SpoolDir, options.TailInterval)

	done := make(chan struct{})
	var wg sync.WaitGroup

	// Compaction: interval-only, no immediate run (index.ts:48).
	startTickerLoop(&wg, done, options.CompactInterval, func() {
		if _, compactErr := retention.Compact(db, time.Now().UnixMilli()); compactErr != nil {
			log.Printf("[aether-collector] compaction failed: %v", compactErr)
		}
	})

	// Transcript scan: immediate run + interval (index.ts:50-54). Now wired
	// to anomaly detection via ingestAnomalies (see that function's doc
	// comment) -- this is the Task 8 wiring the anomaly package's own report
	// flagged as not yet done.
	toolCallHistoryByFile := map[string]*transcript.ToolCallHistory{}
	runScan := func() {
		scanErr := transcript.ScanTranscriptsOnce(db, options.ProjectsRoot, time.Now().UnixMilli(), toolCallHistoryByFile, ingestAnomalies)
		if scanErr != nil {
			log.Printf("[aether-collector] transcript scan failed: %v", scanErr)
		}
	}
	runScan()
	startTickerLoop(&wg, done, options.TranscriptScanInterval, runScan)

	// Fleet poll: immediate run + interval (index.ts:56-63).
	runFleetPoll := func() {
		if pollErr := PollAndUpsertFleet(db, options.OwnSessionFilePath, options.FleetExecFn); pollErr != nil {
			log.Printf("[aether-collector] fleet poll failed: %v", pollErr)
		}
	}
	runFleetPoll()
	startTickerLoop(&wg, done, options.FleetPollInterval, runFleetPoll)

	stop = func() {
		stopTailer()
		close(done)
		wg.Wait()
		db.Close()
	}
	return stop, nil
}
