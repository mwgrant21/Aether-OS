package autostart

import (
	"reflect"
	"testing"
)

func TestBuildScheduledTaskCommand_Create_OnLogonNoElevationQuotedPaths(t *testing.T) {
	argv := BuildScheduledTaskCommand("create", `C:\Program Files\nodejs\node.exe`, `C:\Users\test\aether-os\collector\dist\index.js`)
	want := []string{
		"/Create",
		"/TN", "AetherCollector",
		"/TR", `"C:\Program Files\nodejs\node.exe" "C:\Users\test\aether-os\collector\dist\index.js"`,
		"/SC", "ONLOGON",
		"/RL", "LIMITED",
		"/F",
	}
	if !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %#v, want %#v", argv, want)
	}
}

func TestBuildScheduledTaskCommand_Create_SelfContainedBinary_NoTrailingEmptyArg(t *testing.T) {
	// A self-contained Go binary (e.g. aether-collector.exe) needs no
	// separate interpreter argument, unlike Node's "<node.exe>" "<index.js>"
	// pair -- entrypointPath == "" must produce a single-path /TR value, not
	// a /TR with a stray trailing empty-string argument. This is what
	// cmd/aether-collector-cli's install-autostart handling relies on.
	argv := BuildScheduledTaskCommand("create", `C:\Users\test\aether-os\collector-go\dist\aether-collector.exe`, "")
	want := []string{
		"/Create",
		"/TN", "AetherCollector",
		"/TR", `"C:\Users\test\aether-os\collector-go\dist\aether-collector.exe"`,
		"/SC", "ONLOGON",
		"/RL", "LIMITED",
		"/F",
	}
	if !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %#v, want %#v", argv, want)
	}
}

func TestBuildScheduledTaskCommand_Delete_ByTaskNameOnly(t *testing.T) {
	argv := BuildScheduledTaskCommand("delete", "unused", "unused")
	want := []string{"/Delete", "/TN", "AetherCollector", "/F"}
	if !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %#v, want %#v", argv, want)
	}
}
