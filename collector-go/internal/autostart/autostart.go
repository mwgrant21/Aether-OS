// Package autostart is the Go port of collector/src/autostart.ts:
// registering (and unregistering) the collector as a per-user Windows
// Run-key value, so it starts at logon without elevation. Windows-specific,
// matching this project's established platform scope from prior stages.
package autostart

import (
	"fmt"
	"os/exec"
)

// valueName and runKey mirror autostart.ts's VALUE_NAME and RUN_KEY.
const (
	valueName = "AetherCollector"
	runKey    = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
)

// BuildRunKeyCommand is a pure argv builder for reg.exe -- kept separate
// from the actual exec.Command call below so this logic is testable without
// ever touching the real registry. Mirrors autostart.ts's buildRunKeyCommand
// exactly, including that action values other than "delete" (i.e. "create")
// take the add branch; see that file for why this is a Run-key value behind
// `conhost.exe --headless` rather than an ONLOGON scheduled task.
//
// entrypointPath == "" is a Go-specific accommodation with no TS equivalent:
// TS always needs a `"<node.exe>" "<index.js>"` pair since Node requires a
// separate interpreter, but a self-contained Go binary (nodePath) does not,
// so an empty entrypointPath produces a single-path command instead of one
// with a stray trailing empty argument.
func BuildRunKeyCommand(action string, nodePath string, entrypointPath string) []string {
	if action == "delete" {
		return []string{"delete", runKey, "/v", valueName, "/f"}
	}
	command := fmt.Sprintf(`conhost.exe --headless "%s" "%s"`, nodePath, entrypointPath)
	if entrypointPath == "" {
		command = fmt.Sprintf(`conhost.exe --headless "%s"`, nodePath)
	}
	return []string{
		"add", runKey,
		"/v", valueName,
		"/t", "REG_SZ",
		"/d", command,
		"/f",
	}
}

// Result mirrors installAutostart/uninstallAutostart's TS return shape.
type Result struct {
	OK    bool
	Error string
}

// InstallAutostart mirrors autostart.ts's installAutostart.
func InstallAutostart(nodePath, entrypointPath string) Result {
	cmd := exec.Command("reg.exe", BuildRunKeyCommand("create", nodePath, entrypointPath)...)
	if err := cmd.Run(); err != nil {
		return Result{OK: false, Error: err.Error()}
	}
	return Result{OK: true}
}

// UninstallAutostart mirrors autostart.ts's uninstallAutostart.
func UninstallAutostart() Result {
	cmd := exec.Command("reg.exe", BuildRunKeyCommand("delete", "unused", "unused")...)
	if err := cmd.Run(); err != nil {
		return Result{OK: false, Error: err.Error()}
	}
	return Result{OK: true}
}
