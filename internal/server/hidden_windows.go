//go:build windows

package server

import (
	"io/fs"
	"syscall"
)

// hiddenAttr reports whether Windows marks the file hidden, as it does the
// junctions a profile keeps for old programs, such as Application Data.
func hiddenAttr(info fs.FileInfo) bool {
	d, ok := info.Sys().(*syscall.Win32FileAttributeData)
	return ok && d.FileAttributes&syscall.FILE_ATTRIBUTE_HIDDEN != 0
}
