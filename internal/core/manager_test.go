package core

import (
	"context"
	"errors"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/hctest"
)

// startManager runs m until the test ends; the core of hctest.Start, if
// any, is stopped after it.
func startManager(t *testing.T, o Options) (*Manager, context.Context) {
	t.Helper()
	m := New(o)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return m, ctx
}

func waitFor(t *testing.T, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !f() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// waitUpdate reads w until f accepts an update.
func waitUpdate(t *testing.T, w *Watcher, what string, f func(Update) bool) {
	t.Helper()
	timeout := time.After(20 * time.Second)
	for {
		select {
		case u := <-w.C:
			if f(u) {
				return
			}
		case <-w.Lost():
			t.Fatal("watcher dropped while waiting for", what)
		case <-timeout:
			t.Fatal("timed out waiting for", what)
		}
	}
}

func isCore(connected bool) func(Update) bool {
	return func(u Update) bool { return u.Core != nil && u.Core.Connected == connected }
}

func TestManagerReconnectsAfterCoreRestart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	core := hctest.Start(t)
	var mu sync.Mutex
	var changes []Change
	m, ctx := startManager(t, Options{HC: core.HC, Env: core.Env, MinBackoff: 100 * time.Millisecond, MaxBackoff: 500 * time.Millisecond,
		OnChange: func(c Change) { mu.Lock(); changes = append(changes, c); mu.Unlock() }})
	w := m.Watch(4096)
	defer w.Close()
	if !w.Core.Connected {
		waitUpdate(t, w, "connected", isCore(true))
	}
	if st := m.Status(); !st.Connected || st.Version == "" || st.Error != "" {
		t.Fatalf("%+v", st)
	}
	var run hc.Terminal
	if err := m.Call(ctx, "terminal.run", hc.RunParams{Argv: []string{"/bin/sh"}, Keep: true, NoParent: true, Size: &hc.Size{Cols: 80, Rows: 24}}, &run); err != nil {
		t.Fatal(err)
	}
	waitUpdate(t, w, "created", func(u Update) bool { return u.Change != nil && u.Change.Address == run.Address && u.Change.Old == nil })
	mu.Lock()
	heard := len(changes)
	mu.Unlock()
	if heard == 0 {
		t.Fatal("events must reach OnChange")
	}

	core.Cmd(t, "server", "restart") // its terminals keep running
	waitUpdate(t, w, "core down", isCore(false))
	waitUpdate(t, w, "core up again", isCore(true))
	got, ok := m.Terminal(run.Address)
	if !ok || got.State != "live" {
		t.Fatalf("cache after restart: %+v %v", got, ok)
	}
	var list struct {
		Terminals []hc.Terminal `json:"terminals"`
	}
	if err := m.Call(ctx, "terminal.list", map[string]any{}, &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Terminals) != len(m.Terminals()) || len(list.Terminals) != 1 {
		t.Fatalf("cache differs from core: %d vs %d", len(list.Terminals), len(m.Terminals()))
	}
}

func TestFirstSnapshotDoesNotNotify(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	core := hctest.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c, err := hc.Dial(ctx, core.Options())
	if err != nil {
		t.Fatal(err)
	}
	var run hc.Terminal
	if err := c.Call(ctx, "terminal.run", hc.RunParams{Argv: []string{"/bin/sh"}, NoParent: true}, &run); err != nil {
		t.Fatal(err)
	}
	c.Close()

	var mu sync.Mutex
	var created []string
	m, _ := startManager(t, Options{HC: core.HC, Env: core.Env, OnChange: func(c Change) {
		if c.Old == nil {
			mu.Lock()
			created = append(created, c.Address)
			mu.Unlock()
		}
	}})
	waitFor(t, "the snapshot", func() bool { _, ok := m.Terminal(run.Address); return ok })
	mu.Lock()
	defer mu.Unlock()
	if len(created) != 0 {
		t.Fatal("the first snapshot must not notify:", created)
	}
}

func TestManagerUnavailableWithoutCore(t *testing.T) {
	m, ctx := startManager(t, Options{HC: filepath.Join(t.TempDir(), "no-hc"), MinBackoff: 50 * time.Millisecond})
	if err := m.Call(ctx, "terminal.list", nil, nil); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
	if _, _, err := m.Attach(ctx, hc.AttachParams{Terminal: "t1", Cols: 80, Rows: 24}); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
	waitFor(t, "an error status", func() bool { st := m.Status(); return !st.Connected && st.Error != "" })
}

func TestSlowWatcherIsDropped(t *testing.T) {
	m := New(Options{})
	slow, fine := m.Watch(1), m.Watch(8)
	m.mu.Lock()
	m.setStatusLocked(Status{Error: "a"})
	m.setStatusLocked(Status{Error: "b"}) // slow is full now
	m.mu.Unlock()
	select {
	case <-slow.Lost():
	default:
		t.Fatal("a full watcher must be dropped, not waited for")
	}
	if len(fine.C) != 2 {
		t.Fatal("others still hear everything")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.watchers[slow]; ok || len(m.watchers) != 1 {
		t.Fatal("dropped watcher kept")
	}
}

func TestWatchStartsFromCurrentState(t *testing.T) {
	m := New(Options{})
	m.mu.Lock()
	m.replaceLocked(hc.Snapshot{Terminals: []hc.Terminal{{Address: "t2", CreatedMs: 2}, {Address: "t1", CreatedMs: 1}}})
	m.mu.Unlock()
	w := m.Watch(4)
	if len(w.Terminals) != 2 || w.Terminals[0].Address != "t1" || len(w.C) != 0 {
		t.Fatalf("%+v", w.Terminals)
	}
	m.apply(ev("title", "t2", `{"title":"x"}`))
	if u := <-w.C; u.Change == nil || u.Change.New.Title != "x" {
		t.Fatalf("%+v", u)
	}
}
