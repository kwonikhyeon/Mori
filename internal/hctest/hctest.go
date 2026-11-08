// Package hctest gives a test a herdr-core of its own: its own session,
// socket and XDG directories under .dev/test, stopped and removed when the
// test ends. The user's core is never touched.
package hctest

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/procutil"
)

// Core is one test's core. hc starts it on first use.
type Core struct {
	Dir     string   // .dev/test/<id>
	Session string   // mori-test-<id>
	HC      string   // the hc binary
	Env     []string // points hc at this core and nothing else
}

// Start prepares a core for t, or skips t when hc is not installed.
// MORI_TEST_HC picks the hc binary.
func Start(t testing.TB) *Core {
	t.Helper()
	path, err := hc.Locate(os.Getenv("MORI_TEST_HC"))
	if err != nil {
		t.Skip("hc not installed:", err)
	}
	id := randHex(3) // short: macOS socket paths stop at 103 bytes
	dir := filepath.Join(repoRoot(t), ".dev", "test", id)
	for _, d := range []string{"state", "config", "run"} {
		if err := os.MkdirAll(filepath.Join(dir, d), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	c := &Core{Dir: dir, Session: "mori-test-" + id, HC: path}
	c.Env = append(procutil.WithoutEnv(os.Environ(),
		"HC_TERMINAL_ID", "HC_SESSION", "HC_SOCKET", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"),
		"HC_SESSION="+c.Session,
		"HC_SOCKET="+filepath.Join(dir, "c.sock"),
		"XDG_STATE_HOME="+filepath.Join(dir, "state"),
		"XDG_CONFIG_HOME="+filepath.Join(dir, "config"),
		"XDG_RUNTIME_DIR="+filepath.Join(dir, "run"))
	stopEnv := slices.Clone(c.Env) // a test changing c.Env must not aim the stop elsewhere
	t.Cleanup(func() {
		cmd := exec.Command(c.HC, "server", "stop")
		cmd.Env = stopEnv // this test's session and socket only
		cmd.WaitDelay = time.Second
		procutil.HideWindow(cmd)
		cmd.Run() // it may never have started
		os.RemoveAll(dir)
	})
	return c
}

// Options reach this core with hc.Dial; HC_SESSION in Env picks the session.
func (c *Core) Options() hc.Options { return hc.Options{Path: c.HC, Env: c.Env} }

// Cmd runs hc against this core and returns its stdout. A failure ends the test.
func (c *Core) Cmd(t testing.TB, args ...string) []byte {
	t.Helper()
	cmd := exec.Command(c.HC, args...)
	cmd.Env = c.Env
	cmd.WaitDelay = time.Second
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	procutil.HideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("hc %s: %v\n%s", strings.Join(args, " "), err, stderr.Bytes())
	}
	return out
}

func repoRoot(t testing.TB) string {
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("hctest: no go.mod above the working directory")
		}
		dir = parent
	}
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}
