package server

import (
	"bytes"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// lockedBuffer takes log lines from any goroutine.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func TestSlowRequestsAreLogged(t *testing.T) { // spec §3 #192
	var logs lockedBuffer
	e := newTestEnv(t, func(d *Deps) { d.Logger = slog.New(slog.NewTextHandler(&logs, nil)) })
	e.s.slow = 0 // every request is slow
	e.at("127.0.0.1:7761", "GET", "/api/fs?path=/Users/someone/secret")
	e.at("127.0.0.1:7761", "POST", "/api/relay/s3cr3t-path")
	e.at("127.0.0.1:7761", "GET", "/ws/events")
	e.at("127.0.0.1:7761", "GET", "/h/h_desk0001/ws/attach")
	got := logs.String()
	lines := strings.Split(strings.TrimSpace(got), "\n")
	if len(lines) != 2 {
		t.Fatalf("want a line for each of the two calls, none for sockets:\n%s", got)
	}
	if !strings.Contains(lines[0], "느린 요청") || !strings.Contains(lines[0], "method=GET path=/api/fs status=401 ms=") {
		t.Errorf("fs: %s", lines[0])
	}
	if !strings.Contains(lines[1], "method=POST path=/api/relay/… status=410") {
		t.Errorf("relay: %s", lines[1])
	}
	if strings.Contains(got, "secret") || strings.Contains(got, "s3cr3t") {
		t.Errorf("a query or a relay secret reached the log:\n%s", got)
	}

	e.s.slow = time.Hour
	e.at("127.0.0.1:7761", "GET", "/api/hello")
	if logs.String() != got {
		t.Errorf("a quick request was logged:\n%s", logs.String())
	}
}
