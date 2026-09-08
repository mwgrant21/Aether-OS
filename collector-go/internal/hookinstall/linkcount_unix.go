//go:build !windows

package hookinstall

import (
	"os"
	"syscall"
)

// linkCountOf reports how many directory entries point at this file. Go does
// not expose it portably, so it is split per platform; a failure to determine
// it answers 1 (treat as not hard-linked), which keeps the atomic path.
func linkCountOf(path string) uint64 {
	info, err := os.Stat(path)
	if err != nil {
		return 1
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Nlink)
	}
	return 1
}
