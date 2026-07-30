package transcript

import (
	"os"
	"strings"
)

// ReadNewLines is the Go port of transcriptTailer.ts's readNewLines: reads
// only the bytes appended to filePath since offset, returns the complete
// (newline-terminated) lines found in that span, and the new byte offset to
// resume from next call. A trailing line still being written (no terminating
// newline yet) is never returned -- it will be picked up complete on a later
// call once the newline lands. offset >= file size is a no-op, returning no
// lines and the unchanged offset.
func ReadNewLines(filePath string, offset int64) (lines []string, newOffset int64, err error) {
	info, err := os.Stat(filePath)
	if err != nil {
		return nil, 0, err
	}
	if info.Size() <= offset {
		return []string{}, offset, nil
	}

	length := info.Size() - offset
	f, err := os.Open(filePath)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()

	buf := make([]byte, length)
	if _, err := f.ReadAt(buf, offset); err != nil {
		return nil, 0, err
	}

	text := string(buf)
	lastNewline := strings.LastIndex(text, "\n")
	if lastNewline == -1 {
		return []string{}, offset, nil
	}

	complete := text[:lastNewline]
	newOffset = offset + int64(len(complete)) + 1
	return strings.Split(complete, "\n"), newOffset, nil
}
