package hc_test

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/hctest"
)

// A real core of the test's own: run a shell, type into it, see the output
// and the events, and see the stream end with the shell's exit code.
func TestIntegrationShellEchoAndEvents(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh; Windows is checked by hand (spec §15)")
	}
	core := hctest.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c, err := hc.Dial(ctx, core.Options())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if h := c.Hello(); h.Generation != 1 || !h.Framed {
		t.Fatalf("%+v", h)
	}
	ev, _, err := c.Subscribe(ctx, hc.SubscribeParams{})
	if err != nil {
		t.Fatal(err)
	}
	defer ev.Close()
	var run hc.Terminal
	if err := c.Call(ctx, "terminal.run", hc.RunParams{Argv: []string{"/bin/sh"}, NoParent: true, Size: &hc.Size{Cols: 80, Rows: 24}}, &run); err != nil {
		t.Fatal(err)
	}
	if run.Address == "" {
		t.Fatalf("%+v", run)
	}
	waitEvent(ctx, t, ev, "created", run.Address)
	s, res, err := c.Attach(ctx, hc.AttachParams{Terminal: run.Address, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if res.Terminal.Address != run.Address {
		t.Fatalf("%+v", res)
	}
	s.Write([]byte("echo mori-$((40+2))\r")) // the echoed command line itself does not contain mori-42
	waitOutput(ctx, t, s, "mori-42")
	s.Write([]byte("exit 3\r"))
	waitEvent(ctx, t, ev, "finished", run.Address)
	var ce *hc.ClosedError
	if err := drain(ctx, s); !errors.As(err, &ce) || ce.Reason != "exited" || ce.ExitCode == nil || *ce.ExitCode != 3 {
		t.Fatal(err)
	}
}

func waitEvent(ctx context.Context, t *testing.T, ev *hc.Events, typ, addr string) {
	t.Helper()
	for {
		n, err := ev.Recv(ctx)
		if err != nil {
			t.Fatalf("waiting for %s of %s: %v", typ, addr, err)
		}
		if n.Event != nil && n.Event.Type == typ && n.Event.Terminal == addr {
			return
		}
	}
}

func waitOutput(ctx context.Context, t *testing.T, s *hc.Stream, want string) {
	t.Helper()
	var out strings.Builder
	for !strings.Contains(out.String(), want) {
		m, err := s.Recv(ctx)
		if err != nil {
			t.Fatalf("waiting for %q: %v; got %q", want, err, out.String())
		}
		out.Write(m.Data)
		s.Credit(len(m.Data))
	}
}

// drain reads to the end and returns why the stream ended.
func drain(ctx context.Context, s *hc.Stream) error {
	for {
		m, err := s.Recv(ctx)
		if err != nil {
			return err
		}
		s.Credit(len(m.Data))
	}
}
