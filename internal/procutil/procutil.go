//go:build !windows

// Package procutil adjusts child processes for the host OS.
package procutil

import "os/exec"

// HideWindow keeps a child process from opening a console window. It only
// matters on Windows, where moriw.exe has no console of its own.
func HideWindow(cmd *exec.Cmd) {}
