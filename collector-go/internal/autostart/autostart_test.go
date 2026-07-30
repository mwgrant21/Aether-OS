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

func TestBuildScheduledTaskCommand_Delete_ByTaskNameOnly(t *testing.T) {
	argv := BuildScheduledTaskCommand("delete", "unused", "unused")
	want := []string{"/Delete", "/TN", "AetherCollector", "/F"}
	if !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %#v, want %#v", argv, want)
	}
}
