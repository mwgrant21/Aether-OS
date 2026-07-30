// Command aether-collector is the Go port of collector/src/index.ts's real
// process entrypoint (index.ts:74-100, the isMainModule guard block): a thin
// wrapper around internal/collector.StartCollector that supplies the same
// hardcoded paths and interval values index.ts:79-89 uses, prints the same
// startup/shutdown log lines, and handles SIGINT/SIGTERM for graceful
// shutdown.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/mwgrant21/aether-os/collector-go/internal/collector"
)

func main() {
	home, err := os.UserHomeDir()
	if err != nil {
		log.Fatalf("[aether-collector] failed to resolve home directory: %v", err)
	}
	defaultAetherHome := filepath.Join(home, ".aether-os")
	defaultProjectsRoot := filepath.Join(home, ".claude", "projects")

	// -aether-home and -projects-root override the two hardcoded path bases
	// index.ts:79-89 uses (join(homedir(), '.aether-os') and
	// join(homedir(), '.claude', 'projects')). They exist solely so this
	// binary can be smoke-tested against a temp directory instead of a real
	// user's home directory; end users never need to pass either flag, since
	// both default to the exact real paths index.ts hardcodes.
	aetherHome := flag.String("aether-home", defaultAetherHome, "base directory for collector.db, spool/, and own-session.json")
	projectsRoot := flag.String("projects-root", defaultProjectsRoot, "root directory to scan for Claude Code transcript *.jsonl files")
	flag.Parse()

	stop, err := collector.StartCollector(collector.Options{
		DBPath:                 filepath.Join(*aetherHome, "collector.db"),
		SpoolDir:               filepath.Join(*aetherHome, "spool"),
		TailInterval:           2000 * time.Millisecond,
		CompactInterval:        time.Hour, // hourly, matching index.ts:84
		ProjectsRoot:           *projectsRoot,
		TranscriptScanInterval: 15000 * time.Millisecond,
		OwnSessionFilePath:     filepath.Join(*aetherHome, "own-session.json"),
		FleetPollInterval:      15000 * time.Millisecond,
	})
	if err != nil {
		log.Fatalf("[aether-collector] failed to start: %v", err)
	}

	fmt.Println("[aether-collector] running")

	// Matches index.ts:93-99's process.on('SIGINT'/'SIGTERM', shutdown).
	// os.Interrupt is delivered on Windows via Go's runtime Ctrl+C handling
	// (Ctrl+C in the owning console, or CTRL_BREAK_EVENT/GenerateConsoleCtrlEvent
	// for a detached process); syscall.SIGTERM is registered for parity with
	// the TS handler set but Windows has no native SIGTERM delivery path for
	// an arbitrary process the way POSIX kill(2) does, so in practice only
	// os.Interrupt is reliably exercised on this platform -- see this task's
	// report for the disclosed follow-up.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	<-sigCh

	fmt.Println("[aether-collector] shutting down")
	stop()
	os.Exit(0)
}
