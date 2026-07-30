// Package autostart is the Go port of collector/src/autostart.ts:
// registering (and unregistering) the collector as a Windows scheduled task
// that runs on logon, at standard (non-admin) privilege. Windows-specific,
// matching this project's established platform scope from prior stages.
package autostart

import (
	"fmt"
	"os/exec"
)

// taskName mirrors autostart.ts's TASK_NAME.
const taskName = "AetherCollector"

// BuildScheduledTaskCommand is a pure argv builder for schtasks.exe -- kept
// separate from the actual exec.Command call below so this logic is testable
// without ever touching the real Windows Task Scheduler. /RL LIMITED
// explicitly requests standard (non-admin) privilege. Mirrors autostart.ts's
// buildScheduledTaskCommand exactly, including that action values other than
// "delete" (i.e. "create") take the /Create branch.
func BuildScheduledTaskCommand(action string, nodePath string, entrypointPath string) []string {
	if action == "delete" {
		return []string{"/Delete", "/TN", taskName, "/F"}
	}
	return []string{
		"/Create",
		"/TN", taskName,
		"/TR", fmt.Sprintf(`"%s" "%s"`, nodePath, entrypointPath),
		"/SC", "ONLOGON",
		"/RL", "LIMITED",
		"/F",
	}
}

// Result mirrors installAutostart/uninstallAutostart's TS return shape.
type Result struct {
	OK    bool
	Error string
}

// InstallAutostart mirrors autostart.ts's installAutostart.
func InstallAutostart(nodePath, entrypointPath string) Result {
	cmd := exec.Command("schtasks.exe", BuildScheduledTaskCommand("create", nodePath, entrypointPath)...)
	if err := cmd.Run(); err != nil {
		return Result{OK: false, Error: err.Error()}
	}
	return Result{OK: true}
}

// UninstallAutostart mirrors autostart.ts's uninstallAutostart.
func UninstallAutostart() Result {
	cmd := exec.Command("schtasks.exe", BuildScheduledTaskCommand("delete", "unused", "unused")...)
	if err := cmd.Run(); err != nil {
		return Result{OK: false, Error: err.Error()}
	}
	return Result{OK: true}
}
