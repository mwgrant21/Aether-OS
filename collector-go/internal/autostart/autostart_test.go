package autostart

import (
	"reflect"
	"strings"
	"testing"
)

const wantRunKey = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

func TestBuildRunKeyCommand_Create_HeadlessConhostQuotedPaths(t *testing.T) {
	argv := BuildRunKeyCommand("create", `C:\Program Files\nodejs\node.exe`, `C:\Users\test\aether-os\collector\dist\index.js`)
	want := []string{
		"add", wantRunKey,
		"/v", "AetherCollector",
		"/t", "REG_SZ",
		"/d", `conhost.exe --headless "C:\Program Files\nodejs\node.exe" "C:\Users\test\aether-os\collector\dist\index.js"`,
		"/f",
	}
	if !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %#v, want %#v", argv, want)
	}
}

func TestBuildRunKeyCommand_Create_SelfContainedBinary_NoTrailingEmptyArg(t *testing.T) {
	// A self-contained Go binary (e.g. aether-collector.exe) needs no
	// separate interpreter argument, unlike Node's "<node.exe>" "<index.js>"
	// pair -- entrypointPath == "" must produce a single-path command, not
	// one with a stray trailing empty-string argument. This is what
	// cmd/aether-collector-cli's install-autostart handling relies on.
	argv := BuildRunKeyCommand("create", `C:\Users\test\aether-os\collector-go\dist\aether-collector.exe`, "")
	want := []string{
		"add", wantRunKey,
		"/v", "AetherCollector",
		"/t", "REG_SZ",
		"/d", `conhost.exe --headless "C:\Users\test\aether-os\collector-go\dist\aether-collector.exe"`,
		"/f",
	}
	if !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %#v, want %#v", argv, want)
	}
}

func TestCheckRunCommandLength_260Accepted_261Rejected(t *testing.T) {
	// `conhost.exe --headless "` + node + `" "` + entry + `"` = 28 chars of framing.
	entryFor := func(total int) string { return strings.Repeat("a", total-28-len("node.exe")) }
	if msg := CheckRunCommandLength(BuildRunKeyCommand("create", "node.exe", entryFor(260))); msg != "" {
		t.Errorf("260 chars rejected: %s", msg)
	}
	if msg := CheckRunCommandLength(BuildRunKeyCommand("create", "node.exe", entryFor(261))); !strings.Contains(msg, "261 characters") {
		t.Errorf("261 chars not rejected, got %q", msg)
	}
}

func TestBuildRunKeyCommand_Delete_ByValueNameOnly(t *testing.T) {
	argv := BuildRunKeyCommand("delete", "unused", "unused")
	want := []string{"delete", wantRunKey, "/v", "AetherCollector", "/f"}
	if !reflect.DeepEqual(argv, want) {
		t.Errorf("argv = %#v, want %#v", argv, want)
	}
}
