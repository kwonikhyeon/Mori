package hc

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/kwonikhyeon/mori/internal/procutil"
)

// Options say how to reach a core through `hc connect`.
type Options struct {
	Path    string    // the hc binary; empty means Locate("")
	Session string    // --session; empty leaves it to HC_SESSION in Env
	Env     []string  // hc's environment; nil means os.Environ()
	Stderr  io.Writer // gets hc's own messages; a short tail goes into Dial errors either way
}

// Dial starts `hc connect` and opens a framed connection over its stdin
// and stdout. If no core is running, hc starts one that does not depend on
// this process. ctx bounds the handshake only; Close ends hc connect.
func Dial(ctx context.Context, o Options) (*Conn, error) {
	path := o.Path
	if path == "" {
		p, err := Locate("")
		if err != nil {
			return nil, err
		}
		path = p
	}
	args := []string{"connect"}
	if o.Session != "" {
		args = append(args, "--session", o.Session)
	}
	cmd := exec.Command(path, args...)
	env := o.Env
	if env == nil {
		env = os.Environ()
	}
	// Inside an hc terminal, HC_TERMINAL_ID would make Mori's calls that terminal's own.
	cmd.Env = procutil.WithoutEnv(env, "HC_TERMINAL_ID")
	tail := &tailWriter{max: 2048, also: o.Stderr}
	cmd.Stderr = tail
	cmd.WaitDelay = time.Second // a child holding stderr open must not stall Close
	procutil.HideWindow(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("hc connect: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("hc connect: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("hc connect: %w", err)
	}
	rw := &procRW{r: stdout, w: stdin, cmd: cmd}
	c, err := Open(ctx, rw)
	if err != nil {
		rw.Close() // also collects the rest of stderr
		if msg := tail.String(); msg != "" {
			return nil, fmt.Errorf("hc connect: %w: %s", err, msg)
		}
		return nil, fmt.Errorf("hc connect: %w", err)
	}
	return c, nil
}

// Locate finds hc: the explicit path, then PATH, then ~/.local/bin, where
// the installer puts it.
func Locate(explicit string) (string, error) {
	if explicit != "" {
		p, err := exec.LookPath(explicit)
		if err != nil {
			return "", fmt.Errorf("hc %q: %w", explicit, err)
		}
		return filepath.Abs(p)
	}
	if p, err := exec.LookPath("hc"); err == nil {
		return filepath.Abs(p)
	}
	name := "hc"
	if runtime.GOOS == "windows" {
		name = "hc.exe"
	}
	if home, err := os.UserHomeDir(); err == nil {
		p := filepath.Join(home, ".local", "bin", name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, nil
		}
	}
	return "", errors.New("hc not found: install herdr-core or pass --hc")
}

// procRW is hc connect's stdout and stdin as one stream.
type procRW struct {
	r    io.Reader
	w    io.WriteCloser
	cmd  *exec.Cmd
	once sync.Once
}

func (p *procRW) Read(b []byte) (int, error)  { return p.r.Read(b) }
func (p *procRW) Write(b []byte) (int, error) { return p.w.Write(b) }

// Close closes hc's stdin, which ends it; after two seconds it is killed.
func (p *procRW) Close() error {
	p.once.Do(func() {
		p.w.Close()
		exited := make(chan struct{})
		go func() { p.cmd.Wait(); close(exited) }()
		select {
		case <-exited:
		case <-time.After(2 * time.Second):
			p.cmd.Process.Kill()
			<-exited
		}
	})
	return nil
}

// tailWriter keeps the last max bytes written to it and copies everything
// to also, whose errors it ignores so a failing log never stalls hc.
type tailWriter struct {
	mu   sync.Mutex
	max  int
	buf  []byte
	also io.Writer
}

func (w *tailWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf = append(w.buf, p...)
	if over := len(w.buf) - w.max; over > 0 {
		w.buf = append(w.buf[:0], w.buf[over:]...)
	}
	if w.also != nil {
		w.also.Write(p)
	}
	return len(p), nil
}

func (w *tailWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return strings.TrimSpace(string(w.buf))
}
