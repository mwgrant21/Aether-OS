// Command aether-collector-cli is the Go port of collector/src/cli.ts: the
// install/uninstall/status CLI for wiring the collector's hooks into Claude
// Code's settings.json (internal/hookinstall) and registering/unregistering
// the collector as a Windows logon autostart task (internal/autostart).
//
// Deliberate adaptation from the TS original (disclosed, not silent): cli.ts
// resolves scriptPath relative to its own compiled file location under the
// assumption that collector/dist/cli.js sits at a fixed depth below the repo
// root (cli.ts:9-11: fileURLToPath(import.meta.url) -> '..' x3 ->
// repo-root/scripts/aether-hook-emit.mjs). This binary mirrors that same
// relative-depth assumption from ITS OWN executable path (exe -> '..' x3),
// which holds if aether-collector-cli is built to collector-go/dist/ (the
// same depth collector/dist/cli.js sits at) -- but unlike the TS original,
// this binary's actual install/deployment location is not yet decided
// anywhere in this plan (packaging/distribution of the Go binary is
// explicitly out of scope per the design spec's "Out of scope" section), so
// -script-path is exposed as an explicit override for whatever the real
// install location turns out to be. install-autostart similarly adapts: TS
// registers "<node.exe>" "<index.js>" as the scheduled task's command since
// Node needs an interpreter; a Go binary is self-contained, so this CLI
// passes its sibling aether-collector executable's path as autostart's
// nodePath argument with an empty entrypointPath (see main()'s
// install-autostart case for the resulting /TR value).
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/mwgrant21/aether-os/collector-go/internal/autostart"
	"github.com/mwgrant21/aether-os/collector-go/internal/hookinstall"
)

func main() {
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to resolve home directory: %v\n", err)
		os.Exit(1)
	}
	settingsPath := filepath.Join(home, ".claude", "settings.json")

	exePath, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to resolve own executable path: %v\n", err)
		os.Exit(1)
	}
	// exe -> dist -> collector-go -> repo root, then into scripts/ -- see
	// this file's top doc comment for why this mirrors cli.ts's own
	// relative-depth assumption rather than something more robust.
	defaultScriptPath := filepath.Join(filepath.Dir(exePath), "..", "..", "scripts", "aether-hook-emit.mjs")

	args := os.Args[1:]
	scriptPath := defaultScriptPath
	var command string
	for i := 0; i < len(args); i++ {
		if args[i] == "-script-path" && i+1 < len(args) {
			scriptPath = args[i+1]
			i++
			continue
		}
		if command == "" {
			command = args[i]
		}
	}

	if _, err := os.Stat(scriptPath); err != nil {
		fmt.Fprintf(os.Stderr, "aether-hook-emit.mjs not found at %s -- refusing to modify settings.json\n", scriptPath)
		os.Exit(1)
	}

	switch command {
	case "status":
		state := hookinstall.ReadHookInstallState(settingsPath, scriptPath)
		fmt.Printf("settings.json: %s\n", settingsPath)
		fmt.Printf("script: %s\n", scriptPath)
		for _, eventName := range hookinstall.ManagedHookEvents {
			installed := "not installed"
			for _, e := range state.InstalledEvents {
				if e == eventName {
					installed = "installed"
					break
				}
			}
			fmt.Printf("  %s: %s\n", eventName, installed)
		}
		return

	case "install-hooks":
		result := hookinstall.InstallHooks(settingsPath, scriptPath)
		if !result.OK {
			fmt.Fprintf(os.Stderr, "install failed: %s\n", result.Error)
			os.Exit(1)
		}
		if result.BackupPath != nil {
			fmt.Printf("installed (backup: %s)\n", *result.BackupPath)
		} else {
			fmt.Println("installed")
		}
		return

	case "uninstall-hooks":
		result := hookinstall.UninstallHooks(settingsPath)
		if !result.OK {
			fmt.Fprintf(os.Stderr, "uninstall failed: %s\n", result.Error)
			os.Exit(1)
		}
		if result.BackupPath != nil {
			fmt.Printf("uninstalled (backup: %s)\n", *result.BackupPath)
		} else {
			fmt.Println("uninstalled (nothing was installed)")
		}
		return

	case "install-autostart":
		collectorExePath := filepath.Join(filepath.Dir(exePath), "aether-collector.exe")
		// autostart.BuildScheduledTaskCommand formats /TR as `"<nodePath>"
		// "<entrypointPath>"` when entrypointPath is non-empty, but collapses
		// to a single-path `"<nodePath>"` when it's ""; passing the
		// collector's own exe path as nodePath and "" as entrypointPath thus
		// yields /TR `"<exe>"` with no trailing empty argument -- a
		// self-contained Go binary needs no separate interpreter argument,
		// unlike TS's "<node.exe>" "<index.js>" pair. See this file's top
		// doc comment.
		result := autostart.InstallAutostart(collectorExePath, "")
		if result.OK {
			fmt.Println("autostart installed")
		} else {
			fmt.Printf("autostart install failed: %s\n", result.Error)
			os.Exit(1)
		}
		return

	case "uninstall-autostart":
		result := autostart.UninstallAutostart()
		if result.OK {
			fmt.Println("autostart uninstalled")
		} else {
			fmt.Printf("autostart uninstall failed: %s\n", result.Error)
			os.Exit(1)
		}
		return
	}

	fmt.Fprintln(os.Stderr, "usage: aether-collector-cli <status|install-hooks|uninstall-hooks|install-autostart|uninstall-autostart> [-script-path <path>]")
	os.Exit(1)
}
