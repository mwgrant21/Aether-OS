package transcript

import (
	"os"
	"path/filepath"
	"testing"
)

func tempFile(t *testing.T, initialContent string) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "aether-collector-tailer-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	filePath := filepath.Join(dir, "session.jsonl")
	if err := os.WriteFile(filePath, []byte(initialContent), 0644); err != nil {
		t.Fatal(err)
	}
	return filePath
}

func TestReadNewLines_AllCompleteLinesFromOffsetZero(t *testing.T) {
	filePath := tempFile(t, "line1\nline2\n")
	lines, newOffset, err := ReadNewLines(filePath, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 || lines[0] != "line1" || lines[1] != "line2" {
		t.Errorf("lines = %v, want [line1 line2]", lines)
	}
	if newOffset != int64(len("line1\nline2\n")) {
		t.Errorf("newOffset = %d, want %d", newOffset, len("line1\nline2\n"))
	}
}

func TestReadNewLines_OnlyNewLinesOnSubsequentCall(t *testing.T) {
	filePath := tempFile(t, "line1\n")
	_, firstOffset, err := ReadNewLines(filePath, 0)
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(filePath, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("line2\n"); err != nil {
		t.Fatal(err)
	}
	f.Close()

	lines, _, err := ReadNewLines(filePath, firstOffset)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || lines[0] != "line2" {
		t.Errorf("lines = %v, want [line2]", lines)
	}
}

func TestReadNewLines_DoesNotReturnTrailingIncompleteLine(t *testing.T) {
	filePath := tempFile(t, "line1\npartial-no-newline-yet")
	lines, newOffset, err := ReadNewLines(filePath, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || lines[0] != "line1" {
		t.Errorf("lines = %v, want [line1]", lines)
	}
	if newOffset != int64(len("line1\n")) {
		t.Errorf("newOffset = %d, want %d", newOffset, len("line1\n"))
	}
}

func TestReadNewLines_NoLinesUnchangedOffsetWhenNothingNew(t *testing.T) {
	filePath := tempFile(t, "line1\n")
	_, firstOffset, err := ReadNewLines(filePath, 0)
	if err != nil {
		t.Fatal(err)
	}
	lines, newOffset, err := ReadNewLines(filePath, firstOffset)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 0 {
		t.Errorf("lines = %v, want empty", lines)
	}
	if newOffset != firstOffset {
		t.Errorf("newOffset = %d, want %d", newOffset, firstOffset)
	}
}

func TestReadNewLines_OffsetAtOrPastFileSize(t *testing.T) {
	filePath := tempFile(t, "short")
	lines, newOffset, err := ReadNewLines(filePath, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 0 {
		t.Errorf("lines = %v, want empty", lines)
	}
	if newOffset != 1000 {
		t.Errorf("newOffset = %d, want 1000", newOffset)
	}
}
