package push_test

import (
	"context"
	"encoding/base64"
	"log/slog"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/hctest"
)

func waitFor(t *testing.T, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !f() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestNotifierWithCore has a program report its state the way agents do,
// with OSC 7501 (spec §2.3), and checks what the devices hear.
func TestNotifierWithCore(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	hcc := hctest.Start(t)
	e := newEnv(t)
	e.subscribe(t, "d1", "https://push.example.com/a")
	// asks are the questions as a device sees them, once the turn event
	// has come after the status event.
	var mu sync.Mutex
	var asks []string
	onChange := func(c core.Change) {
		if c.Event != nil && c.Event.Type == "turn" && c.New != nil {
			if a := core.AskID(*c.New); a != "" {
				mu.Lock()
				asks = append(asks, a)
				mu.Unlock()
			}
		}
		e.n.OnChange(c)
	}
	m := core.New(core.Options{HC: hcc.HC, Env: hcc.Env, MinBackoff: 100 * time.Millisecond, MaxBackoff: 500 * time.Millisecond,
		Logger: slog.New(slog.DiscardHandler), OnChange: onChange})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done; e.n.Wait() })
	waitFor(t, "the core", func() bool { return m.Status().Connected })

	report := func(kv string) string { return `printf '\033]7501;` + kv + `\007'; sleep 0.3; ` }
	msg := base64.StdEncoding.EncodeToString([]byte("Allow Bash?"))
	script := report("state=working") + report("state=blocked:kind=permission:msg="+msg) +
		report("state=working") + report("state=done") + "sleep 30"
	cctx, ccancel := context.WithTimeout(ctx, 20*time.Second)
	defer ccancel()
	var run hc.Terminal
	if err := m.Call(cctx, "terminal.run", hc.RunParams{Argv: []string{"/bin/sh", "-c", script}, NoParent: true, Size: &hc.Size{Cols: 80, Rows: 24}}, &run); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "two notifications", func() bool { return len(e.sender.all()) >= 2 })
	time.Sleep(500 * time.Millisecond) // nothing more may follow
	got := e.sender.all()
	if len(got) != 2 {
		t.Fatalf("sent %d notifications, want 2: %+v", len(got), got)
	}
	if p := got[0].Payload; p.Title != "macmini · 승인 대기" || !strings.HasSuffix(p.Body, " — Allow Bash?") || p.Tag != run.Address {
		t.Errorf("first %+v; want 승인 대기 with the program's message", p)
	}
	if p := got[1].Payload; p.Title != "macmini · 입력 대기" || p.Tag != run.Address {
		t.Errorf("second %+v; want 입력 대기", p)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(asks) != 1 || got[0].Payload.Ask != asks[0] {
		t.Errorf("the notification names %q; devices saw %q", got[0].Payload.Ask, asks)
	}
}
