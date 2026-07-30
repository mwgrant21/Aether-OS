package transcript

import (
	"runtime"
	"testing"
	"time"
)

func assistantToolUseEvent(toolUseID, toolName string, filePath *string, timestamp time.Time) Event {
	input := map[string]interface{}{}
	if filePath != nil {
		input["file_path"] = *filePath
	}
	return Event{
		Kind:      "assistant",
		Timestamp: &timestamp,
		ToolUses:  []ToolUse{{ID: toolUseID, Name: toolName, Input: input}},
	}
}

func userResultEvent(toolUseID string, timestamp time.Time) Event {
	return Event{
		Kind:        "user",
		Timestamp:   &timestamp,
		ToolResults: []ToolResult{{ToolUseID: toolUseID, ResultLength: 10}},
	}
}

func TestUpdateHistory_OpensAndClosesOnMatchingToolResult(t *testing.T) {
	t0 := time.Date(2026, 7, 28, 0, 0, 0, 0, time.UTC)
	t1 := time.Date(2026, 7, 28, 0, 0, 1, 0, time.UTC)

	history := CreateEmptyHistory()
	history = UpdateHistory(history, []Event{assistantToolUseEvent("tu_1", "Read", strp("src/foo.ts"), t0)}, t0.UnixMilli())
	if len(history.Events) != 0 {
		t.Fatalf("expected no closed events yet, got %d", len(history.Events))
	}
	open, ok := history.OpenByToolUseID["tu_1"]
	if !ok {
		t.Fatalf("expected tu_1 to be open")
	}
	if open.ToolName != "Read" || open.FilePath == nil || *open.FilePath != "src/foo.ts" || open.StartedAt != t0.UnixMilli() {
		t.Fatalf("unexpected open entry: %+v", open)
	}

	history = UpdateHistory(history, []Event{userResultEvent("tu_1", t1)}, t1.UnixMilli())
	if len(history.Events) != 1 {
		t.Fatalf("expected 1 closed event, got %d", len(history.Events))
	}
	closed := history.Events[0]
	if closed.ToolUseID != "tu_1" || closed.ToolName != "Read" || closed.FilePath == nil || *closed.FilePath != "src/foo.ts" {
		t.Fatalf("unexpected closed event: %+v", closed)
	}
	if closed.StartedAt != t0.UnixMilli() || closed.ClosedAt != t1.UnixMilli() {
		t.Fatalf("unexpected timestamps: %+v", closed)
	}
	if _, ok := history.OpenByToolUseID["tu_1"]; ok {
		t.Fatalf("expected tu_1 to no longer be open")
	}
}

func TestToProjectRelative_CrossDriveWindowsOnly(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("windows-only cross-drive guard")
	}
	// On win32, path.relative()/filepath.Rel() between paths on different
	// drives cannot produce a usable relative path -- must be rejected, not
	// silently passed through as an absolute path.
	result := ToProjectRelative(strp(`D:\Secrets\Matt\x.ts`), strp(`C:\Users\Matt\projects\foo`))
	if result != nil {
		t.Fatalf("expected nil for cross-drive path, got %q", *result)
	}
}

func TestToProjectRelative_PosixStyleAbsoluteAgainstWindowsRoot(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("windows-only: exercises filepath.IsAbs vs Node's win32 isAbsolute divergence")
	}
	// A POSIX-style path (no drive letter) is absolute per Node's win32
	// path.isAbsolute (leading separator alone suffices), so it must be
	// routed through Rel-and-traversal-guard and rejected -- never passed
	// through unredacted just because Go's filepath.IsAbs says it's relative.
	result := ToProjectRelative(strp(`/home/matt/secret.ts`), strp(`C:\projects\x`))
	if result != nil {
		t.Fatalf("expected nil for POSIX-style absolute path against Windows root, got %q", *result)
	}
}

func TestToProjectRelative_CaseInsensitiveDriveLetter(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("windows-only: exercises drive-letter case normalization")
	}
	// Node's win32 path.relative is case-insensitive on the drive letter;
	// filepath.Rel is not. A lowercase-drive file path against an
	// uppercase-drive root should still relativize successfully.
	result := ToProjectRelative(strp(`c:\projects\x\src\a.ts`), strp(`C:\projects\x`))
	if result == nil {
		t.Fatalf("expected non-nil result for case-varied drive letter")
	}
	if *result != `src\a.ts` {
		t.Fatalf("expected %q, got %q", `src\a.ts`, *result)
	}
}

func TestToProjectRelative_RelativizesUnderRoot(t *testing.T) {
	root := `/home/matt/projects/foo`
	abs := `/home/matt/projects/foo/src/bar.ts`
	if runtime.GOOS == "windows" {
		root = `C:\Users\Matt\projects\foo`
		abs = `C:\Users\Matt\projects\foo\src\bar.ts`
	}
	result := ToProjectRelative(&abs, &root)
	if result == nil {
		t.Fatalf("expected non-nil result")
	}
}

func TestToProjectRelative_RejectsTraversal(t *testing.T) {
	p := "../../secret"
	result := ToProjectRelative(&p, strp("/whatever"))
	if result != nil {
		t.Fatalf("expected nil for traversal path, got %q", *result)
	}
}

func TestToProjectRelative_NilFilePath(t *testing.T) {
	if ToProjectRelative(nil, strp("/root")) != nil {
		t.Fatalf("expected nil")
	}
}

func TestToProjectRelative_AbsoluteWithNoRoot(t *testing.T) {
	p := "/some/abs/path"
	if runtime.GOOS == "windows" {
		p = `C:\some\abs\path`
	}
	if ToProjectRelative(&p, nil) != nil {
		t.Fatalf("expected nil when projectRoot is nil")
	}
	empty := ""
	if ToProjectRelative(&p, &empty) != nil {
		t.Fatalf("expected nil when projectRoot is empty")
	}
}

func TestUpdateHistory_CapsAtHistoryMaxEvents(t *testing.T) {
	history := CreateEmptyHistory()
	base := time.Date(2026, 7, 28, 0, 0, 0, 0, time.UTC)
	for i := 0; i < HistoryMaxEvents+10; i++ {
		id := "tu_" + string(rune('a'+i%26)) + string(rune(i))
		ts := base.Add(time.Duration(i) * time.Second)
		history = UpdateHistory(history, []Event{assistantToolUseEvent(id, "Read", nil, ts)}, ts.UnixMilli())
		history = UpdateHistory(history, []Event{userResultEvent(id, ts)}, ts.UnixMilli())
	}
	if len(history.Events) != HistoryMaxEvents {
		t.Fatalf("expected history capped at %d, got %d", HistoryMaxEvents, len(history.Events))
	}
}
