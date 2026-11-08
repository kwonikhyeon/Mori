//go:build !windows

package server

import "io/fs"

// hiddenAttr reports whether the file system marks the file hidden. Here
// only a leading dot hides a name.
func hiddenAttr(fs.FileInfo) bool { return false }
