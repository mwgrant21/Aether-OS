//go:build windows

package hookinstall

import (
	"os"
	"syscall"
)

// linkCountOf reports how many directory entries point at this file. NTFS has
// hard links too, and Node reports nlink on Windows, so the Go side must not
// be blind to them or the two implementations would diverge (#63).
func linkCountOf(path string) uint64 {
	f, err := os.Open(path)
	if err != nil {
		return 1
	}
	defer f.Close()
	var d syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(syscall.Handle(f.Fd()), &d); err != nil {
		return 1
	}
	if d.NumberOfLinks == 0 {
		return 1
	}
	return uint64(d.NumberOfLinks)
}
