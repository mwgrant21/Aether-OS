package fleet

import (
	"os"
	"path/filepath"
	"testing"
)

func tempFileWith(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	filePath := filepath.Join(dir, "own-session.json")
	if err := os.WriteFile(filePath, []byte(content), 0644); err != nil {
		t.Fatalf("write temp file: %v", err)
	}
	return filePath
}

func TestReadOwnSessionID_ReturnsSessionIDFromWellFormedFile(t *testing.T) {
	filePath := tempFileWith(t, `{"sessionId":"sess-abc","updatedAtMs":1000}`)
	got := ReadOwnSessionID(filePath)
	if got == nil || *got != "sess-abc" {
		t.Fatalf("expected sess-abc, got %v", got)
	}
}

func TestReadOwnSessionID_ReturnsNilWhenSessionIDExplicitlyNull(t *testing.T) {
	filePath := tempFileWith(t, `{"sessionId":null,"updatedAtMs":1000}`)
	if got := ReadOwnSessionID(filePath); got != nil {
		t.Fatalf("expected nil, got %v", *got)
	}
}

func TestReadOwnSessionID_ReturnsNilWhenFileDoesNotExist(t *testing.T) {
	missingPath := filepath.Join(t.TempDir(), "does-not-exist", "own-session.json")
	if got := ReadOwnSessionID(missingPath); got != nil {
		t.Fatalf("expected nil, got %v", *got)
	}
}

func TestReadOwnSessionID_ReturnsNilForMalformedJSON_NeverPanics(t *testing.T) {
	filePath := tempFileWith(t, "not json{{")
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("ReadOwnSessionID panicked: %v", r)
		}
	}()
	if got := ReadOwnSessionID(filePath); got != nil {
		t.Fatalf("expected nil, got %v", *got)
	}
}

func TestReadOwnSessionID_ReturnsNilWhenSessionIDMissingOrNotString(t *testing.T) {
	missing := tempFileWith(t, `{"updatedAtMs":1000}`)
	if got := ReadOwnSessionID(missing); got != nil {
		t.Fatalf("expected nil for missing sessionId, got %v", *got)
	}
	notString := tempFileWith(t, `{"sessionId":42}`)
	if got := ReadOwnSessionID(notString); got != nil {
		t.Fatalf("expected nil for non-string sessionId, got %v", *got)
	}
}
