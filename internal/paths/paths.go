// Package paths resolves where Mori keeps its state on this host.
package paths

import (
	"fmt"
	"os"
	"path/filepath"
)

// Home returns the state directory: the --home flag, then MORI_HOME, then
// <user config dir>/Mori. It does not create the directory.
func Home(flag string) (string, error) {
	if flag != "" {
		return filepath.Abs(flag)
	}
	if env := os.Getenv("MORI_HOME"); env != "" {
		return filepath.Abs(env)
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("locate config dir: %w", err)
	}
	return filepath.Join(dir, "Mori"), nil
}

// State is the path of state.json inside home.
func State(home string) string { return filepath.Join(home, "state.json") }

// Socket is the path of the admin socket inside home.
func Socket(home string) string { return filepath.Join(home, "mori.sock") }

// Log is the path of the service log inside home.
func Log(home string) string { return filepath.Join(home, "mori.log") }
