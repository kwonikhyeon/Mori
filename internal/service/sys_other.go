//go:build !windows

package service

import (
	"errors"
	"io"
	"syscall"
	"time"
)

func runKeyValue() (string, error) { return "", ErrNotInstalled }

// waitExit waits up to d for the process pid to end and reports whether it
// has.
func waitExit(pid int, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func startDetached(io.Writer, string, []string, string) error {
	return errors.New("Windows에서만 쓰입니다")
}
