package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"github.com/kwonikhyeon/mori/internal/core"
	"github.com/kwonikhyeon/mori/internal/hc"
	"github.com/kwonikhyeon/mori/internal/hctest"
	"github.com/kwonikhyeon/mori/internal/store"
)

const wsWait = 15 * time.Second

// wsMsg holds any JSON message of the two WebSockets.
type wsMsg struct {
	Type      string         `json:"type"`
	Core      *core.Status   `json:"core"`
	Connected bool           `json:"connected"`
	Folders   []FolderView   `json:"folders"`
	Terminals []TerminalView `json:"terminals"`
	Terminal  *TerminalView  `json:"terminal"`
	Address   string         `json:"address"`
	Cols      int            `json:"cols"`
	Rows      int            `json:"rows"`
	Reason    string         `json:"reason"`
	ExitCode  *int           `json:"exit_code"`
	Signal    *int           `json:"signal"`
}

// wsClient is a browser in a test: it keeps the output it has read and the
// text messages it has not looked at yet.
type wsClient struct {
	t    *testing.T
	c    *websocket.Conn
	out  strings.Builder
	msgs []wsMsg
}

func (e *testEnv) client(path string) *wsClient {
	e.t.Helper()
	return &wsClient{t: e.t, c: e.dialWS(path)}
}

func attachPath(addr string) string { return "/ws/attach?t=" + url.QueryEscape(addr) }

// read reads one message. It returns the close code once the server has
// closed the socket, else 0.
func (w *wsClient) read(ctx context.Context) websocket.StatusCode {
	w.t.Helper()
	typ, b, err := w.c.Read(ctx)
	if err != nil {
		if code := websocket.CloseStatus(err); code != -1 {
			return code
		}
		w.t.Fatalf("read: %v; output so far %q", err, w.out.String())
	}
	if typ == websocket.MessageBinary {
		w.out.Write(b)
		return 0
	}
	var m wsMsg
	if err := json.Unmarshal(b, &m); err != nil {
		w.t.Fatalf("%v: %s", err, b)
	}
	w.msgs = append(w.msgs, m)
	return 0
}

// untilMsg returns the first text message that matches, dropping the ones
// before it.
func (w *wsClient) untilMsg(what string, match func(wsMsg) bool) wsMsg {
	w.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), wsWait)
	defer cancel()
	for {
		for i, m := range w.msgs {
			if match(m) {
				w.msgs = w.msgs[i+1:]
				return m
			}
		}
		w.msgs = w.msgs[:0]
		if code := w.read(ctx); code != 0 {
			w.t.Fatalf("waiting for %s: closed with %d; output so far %q", what, code, w.out.String())
		}
	}
}

// untilOutput reads until the output holds want.
func (w *wsClient) untilOutput(want string) {
	w.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), wsWait)
	defer cancel()
	for !strings.Contains(w.out.String(), want) {
		if code := w.read(ctx); code != 0 {
			w.t.Fatalf("waiting for %q: closed with %d; output so far %q", want, code, w.out.String())
		}
	}
}

// closed reads until the server closes the socket and returns the code.
func (w *wsClient) closed() websocket.StatusCode {
	w.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), wsWait)
	defer cancel()
	for {
		if code := w.read(ctx); code != 0 {
			return code
		}
	}
}

func (w *wsClient) send(v any) {
	w.t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		w.t.Fatal(err)
	}
	w.write(websocket.MessageText, b)
}

func (w *wsClient) input(s string) { w.t.Helper(); w.write(websocket.MessageBinary, []byte(s)) }

func (w *wsClient) write(typ websocket.MessageType, b []byte) {
	w.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), wsWait)
	defer cancel()
	if err := w.c.Write(ctx, typ, b); err != nil {
		w.t.Fatal(err)
	}
}

func isType(typ string) func(wsMsg) bool { return func(m wsMsg) bool { return m.Type == typ } }

func isTerminal(addr, state string) func(wsMsg) bool {
	return func(m wsMsg) bool {
		return m.Type == "terminal" && m.Terminal != nil && m.Terminal.Address == addr && m.Terminal.State == state
	}
}

// createShell starts /bin/sh in a new folder through the API.
func (e *testEnv) createShell() TerminalView {
	e.t.Helper()
	f := e.addFolder(e.t.TempDir())
	if !slices.ContainsFunc(e.store.Get().Presets, func(p store.Preset) bool { return p.ID == "sh" }) {
		e.addPreset(store.Preset{ID: "sh", Name: "sh", Argv: []string{"/bin/sh"}})
	}
	var tv TerminalView
	e.json("POST", "/api/terminals", map[string]any{"folder_id": f.ID, "preset": "sh"}, 201, &tv)
	return tv
}

func TestCloseCodeFor(t *testing.T) {
	seven, nine := 7, 9
	closed := func(r hc.CloseReason) error { return &hc.ClosedError{CloseReason: r} }

	code, msg := closeCodeFor(closed(hc.CloseReason{Reason: "exited", ExitCode: &seven}), true)
	if code != websocket.StatusNormalClosure || msg == nil || msg.Type != "closed" || msg.Reason != "exited" || *msg.ExitCode != 7 {
		t.Fatal(code, msg)
	}
	if code, msg := closeCodeFor(closed(hc.CloseReason{Reason: "killed", Signal: &nine}), true); code != websocket.StatusNormalClosure || *msg.Signal != 9 {
		t.Fatal(code, msg)
	}
	// A keep terminal comes back after anything but exit and kill.
	for _, r := range []string{"signaled", "holder_lost", "server_stop", "host_shutdown", "stopped_by_restart"} {
		if code, msg := closeCodeFor(closed(hc.CloseReason{Reason: r}), true); code != closeUnavailable || msg != nil {
			t.Fatal(r, code, msg)
		}
		if code, msg := closeCodeFor(closed(hc.CloseReason{Reason: r}), false); code != websocket.StatusNormalClosure || msg.Reason != r {
			t.Fatal(r, code, msg)
		}
	}
	if code, _ := closeCodeFor(fmt.Errorf("read: %w", hc.ErrClosed), true); code != closeCoreLost {
		t.Fatal(code)
	}
	if code, _ := closeCodeFor(core.ErrUnavailable, false); code != closeCoreLost {
		t.Fatal(code)
	}
	if code, _ := closeCodeFor(errors.New("hc: stream backlog exceeded"), true); code != websocket.StatusInternalError {
		t.Fatal(code)
	}
}

func TestWSReasonFitsCloseFrame(t *testing.T) {
	if r := wsReason("짧다"); r != "짧다" {
		t.Fatal(r)
	}
	long := strings.Repeat("가", 100) // 300 bytes
	if r := wsReason(long); len(r) > 123 || !utf8.ValidString(r) || !strings.HasPrefix(long, r) || len(r) < 120 {
		t.Fatal(len(r))
	}
}

func TestAttachRefusals(t *testing.T) {
	e := newTestEnv(t) // the core is down
	c, res, err := e.tryWS(e.srv.URL, attachPath("t1"))
	if err != nil {
		t.Fatalf("%v (%v)", err, res)
	}
	defer c.CloseNow()
	if code := readUntilClosed(t, c); code != closeUnauthorized {
		t.Fatal("unpaired:", code)
	}

	e.pair()
	for _, q := range []string{"", "?cols=80", "?t=t1&cols=wide", "?t=t1&rows=1.5", "?t=t1&cols=-80",
		"?t=t1&history=-1", "?t=t1&history=lots", "?t=t1&observe=maybe", "?t=t1&resumed=2"} {
		if code := e.client("/ws/attach" + q).closed(); code != closeBadRequest {
			t.Errorf("%q: %d", q, code)
		}
	}
	// A good query, but there is no core to attach to.
	if code := e.client(attachPath("t1") + "&history=99999&cols=5000").closed(); code != closeCoreLost {
		t.Fatal(code)
	}
}

func TestEventsWithCoreDown(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	ev := e.client("/ws/events")
	snap := ev.untilMsg("snapshot", isType("snapshot"))
	if snap.Core == nil || snap.Core.Connected || snap.Terminals == nil || len(snap.Terminals) != 0 || snap.Folders == nil {
		t.Fatalf("%+v", snap)
	}
	f := e.addFolder(t.TempDir())
	e.s.FoldersChanged()
	m := ev.untilMsg("folders", isType("folders"))
	if len(m.Folders) != 1 || m.Folders[0].ID != f.ID {
		t.Fatalf("%+v", m)
	}
}

func TestEventsAnswerPingsOnly(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	ev := e.client("/ws/events")
	ev.untilMsg("snapshot", isType("snapshot"))
	for range 2 {
		ev.send(map[string]any{"type": "ping"})
		ev.untilMsg("pong", isType("pong"))
	}
	ev.send(map[string]any{"type": "resize", "cols": 80, "rows": 24})
	if code := ev.closed(); code != websocket.StatusPolicyViolation {
		t.Fatal(code)
	}
	bin := e.client("/ws/events")
	bin.untilMsg("snapshot", isType("snapshot"))
	bin.input("ping")
	if code := bin.closed(); code != websocket.StatusPolicyViolation {
		t.Fatal(code)
	}
}

func TestEventFeed(t *testing.T) {
	e := newTestEnv(t)
	one := e.addFolder(filepath.FromSlash("/w/one"))
	now := time.Now()
	old := now.Add(-2 * recentFinished).UnixMilli()
	f := newEventFeed(e.s)

	snap := f.snapshot([]hc.Terminal{{Address: "t1", State: "live", Cwd: filepath.FromSlash("/w/one/a")},
		{Address: "t2", State: "live", Cwd: filepath.FromSlash("/w/one/b")},
		{Address: "t3", State: "finished", FinishedMs: &old}}, core.Status{Connected: true}, now)
	var got []string
	for _, v := range snap.Terminals {
		if v.FolderID != one.ID {
			t.Fatalf("%s in %q", v.Address, v.FolderID)
		}
		got = append(got, v.Address)
	}
	if !slices.Equal(got, []string{"t1", "t2"}) || !snap.Core.Connected || len(snap.Folders) != 1 || snap.Folders[0].Worktrees == nil {
		t.Fatalf("%v %+v", got, snap)
	}

	// A folder registered inside the first takes the terminal that started there.
	two := e.addFolder(filepath.FromSlash("/w/one/b"))
	msgs := f.foldersChanged()
	if len(msgs) != 2 {
		t.Fatalf("%+v", msgs)
	}
	if m, ok := msgs[0].(foldersMsg); !ok || len(m.Folders) != 2 {
		t.Fatalf("%+v", msgs[0])
	}
	if m, ok := msgs[1].(terminalMsg); !ok || m.Terminal.Address != "t2" || m.Terminal.FolderID != two.ID {
		t.Fatalf("%+v", msgs[1])
	}
	if msgs := f.foldersChanged(); len(msgs) != 1 {
		t.Fatalf("nothing moved since: %+v", msgs)
	}

	t3 := hc.Terminal{Address: "t3", State: "finished", FinishedMs: &old}
	if m := f.update(core.Update{Change: &core.Change{Address: "t3", New: &t3}}, now); m != nil {
		t.Fatalf("finished long ago: %+v", m)
	}
	if m := f.update(core.Update{Change: &core.Change{Address: "t3", Old: &t3}}, now); m != nil {
		t.Fatalf("never shown: %+v", m)
	}
	t4 := hc.Terminal{Address: "t4", State: "live"}
	if m, ok := f.update(core.Update{Change: &core.Change{Address: "t4", New: &t4}}, now).(terminalMsg); !ok || m.Terminal.Address != "t4" || m.Type != "terminal" {
		t.Fatalf("%+v", m)
	}
	if m, ok := f.update(core.Update{Change: &core.Change{Address: "t4", Old: &t4}}, now).(removedMsg); !ok || m.Address != "t4" || m.Type != "removed" {
		t.Fatalf("%+v", m)
	}
	// Once finished, a terminal the browser has seen stays in the feed.
	finished := hc.Terminal{Address: "t1", State: "finished", FinishedMs: &old}
	if m, ok := f.update(core.Update{Change: &core.Change{Address: "t1", New: &finished}}, now).(terminalMsg); !ok || m.Terminal.State != "finished" {
		t.Fatalf("%+v", m)
	}
	if m, ok := f.update(core.Update{Core: &core.Status{Error: "gone"}}, now).(coreMsg); !ok || m.Connected || m.Type != "core" {
		t.Fatalf("%+v", m)
	}
}

func TestCloseSocketsSaysGoingAway(t *testing.T) {
	e := newTestEnv(t)
	e.pair()
	ev := e.client("/ws/events")
	ev.untilMsg("snapshot", isType("snapshot"))
	ctx, cancel := context.WithTimeout(context.Background(), wsWait)
	defer cancel()
	done := make(chan struct{})
	go func() { e.s.CloseSockets(ctx); close(done) }()
	if code := ev.closed(); code != websocket.StatusGoingAway {
		t.Fatal(code)
	}
	<-done
	if ctx.Err() != nil {
		t.Fatal("CloseSockets waited for its deadline")
	}
	for _, p := range []string{"/ws/events", attachPath("t1")} {
		if code := e.client(p).closed(); code != websocket.StatusGoingAway {
			t.Fatal(p, code)
		}
	}
}

func TestAttachRoundTripSizeAndClose(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	c := hctest.Start(t)
	e := newTestEnv(t, withCore(t, c))
	e.pair()
	tv := e.createShell()

	a := e.client(attachPath(tv.Address) + "&cols=80&rows=24")
	at := a.untilMsg("attached", isType("attached"))
	if at.Terminal == nil || at.Terminal.Address != tv.Address || at.Terminal.FolderID != tv.FolderID || at.Cols != 80 || at.Rows != 24 {
		t.Fatalf("%+v", at)
	}
	a.input("echo ws-$((2+3))\r")
	a.untilOutput("ws-5")
	a.send(map[string]any{"type": "resize", "cols": 100, "rows": 30})
	a.untilMsg("size", func(m wsMsg) bool { return m.Type == "size" && m.Cols == 100 && m.Rows == 30 })
	a.send(map[string]any{"type": "focus", "focused": true})
	e.eventually(func() bool { return e.s.d.Presence.Focused(tv.Address) })
	a.send(map[string]any{"type": "display", "fg": "#ddeeff", "bg": "#112233", "cell": []int{8, 16}})
	a.send(map[string]any{"type": "ping"})
	a.untilMsg("pong", isType("pong"))
	a.send(map[string]any{"type": "nonsense"})
	a.write(websocket.MessageText, []byte("{not json"))
	a.input("echo still-$((5+5))\r") // what the browser got wrong did not end the session
	a.untilOutput("still-10")

	a.input("exit 7\r")
	cl := a.untilMsg("closed", isType("closed"))
	if cl.Reason != "exited" || cl.ExitCode == nil || *cl.ExitCode != 7 {
		t.Fatalf("%+v", cl)
	}
	if code := a.closed(); code != websocket.StatusNormalClosure {
		t.Fatal(code)
	}
	e.eventually(func() bool { return !e.s.d.Presence.Focused(tv.Address) })

	// The core refuses a finished terminal; the browser hears how it ended.
	again := e.client(attachPath(tv.Address))
	cl = again.untilMsg("closed", isType("closed"))
	if cl.Reason != "exited" || cl.ExitCode == nil || *cl.ExitCode != 7 {
		t.Fatalf("%+v", cl)
	}
	if code := again.closed(); code != websocket.StatusNormalClosure {
		t.Fatal(code)
	}
	if code := e.client(attachPath("t999")).closed(); code != closeNotFound {
		t.Fatal(code)
	}
}

func TestAttachObserver(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	c := hctest.Start(t)
	e := newTestEnv(t, withCore(t, c))
	e.pair()
	tv := e.createShell()

	active := e.client(attachPath(tv.Address))
	active.untilMsg("attached", isType("attached"))
	obs := e.client(attachPath(tv.Address) + "&observe=1")
	obs.untilMsg("attached", isType("attached"))

	active.send(map[string]any{"type": "resize", "cols": 100, "rows": 30})
	isSize := func(m wsMsg) bool { return m.Type == "size" && m.Cols == 100 && m.Rows == 30 }
	obs.untilMsg("size", isSize) // the observer follows the active viewer's size
	active.untilMsg("size", isSize)

	obs.send(map[string]any{"type": "resize", "cols": 50, "rows": 20})
	obs.input("echo observer-$((3+4))\r")
	obs.send(map[string]any{"type": "focus", "focused": true})
	// The server reads a socket in order: once the focus is in, so was the rest.
	e.eventually(func() bool { return e.s.d.Presence.Focused(tv.Address) })

	active.input("stty size; echo active-$((1+2))\r")
	obs.untilOutput("active-3")
	active.untilOutput("active-3")
	if strings.Contains(obs.out.String(), "observer-7") || strings.Contains(active.out.String(), "observer-7") {
		t.Fatal("an observer typed into the terminal")
	}
	if !strings.Contains(active.out.String(), "30 100") {
		t.Fatalf("an observer resized the terminal: %q", active.out.String())
	}
}

func TestAttachCoreLoss4503(t *testing.T) { // Review Focus 4
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	c := hctest.Start(t)
	e := newTestEnv(t, withCore(t, c))
	e.pair()
	tv := e.createShell()
	ev := e.client("/ws/events")
	ev.untilMsg("snapshot", isType("snapshot"))
	a := e.client(attachPath(tv.Address))
	a.untilMsg("attached", isType("attached"))

	c.Cmd(t, "server", "restart")
	if code := a.closed(); code != closeCoreLost {
		t.Fatal(code)
	}
	ev.untilMsg("core down", func(m wsMsg) bool { return m.Type == "core" && !m.Connected })
	ev.untilMsg("core back", func(m wsMsg) bool { return m.Type == "core" && m.Connected })

	// The session lives on in the core; the browser attaches again.
	b := e.client(attachPath(tv.Address) + "&resumed=1")
	b.untilMsg("attached", isType("attached"))
	b.input("echo back-$((6+6))\r")
	b.untilOutput("back-12")
}

func TestEventsSnapshotThenTerminalUpdates(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	c := hctest.Start(t)
	e := newTestEnv(t, withCore(t, c))
	e.pair()
	ev := e.client("/ws/events")
	snap := ev.untilMsg("snapshot", isType("snapshot"))
	if snap.Core == nil || !snap.Core.Connected || snap.Core.Version == "" || snap.Terminals == nil || snap.Folders == nil {
		t.Fatalf("%+v", snap)
	}

	tv := e.createShell()
	m := ev.untilMsg("new terminal", isTerminal(tv.Address, "live"))
	if m.Terminal.FolderID != tv.FolderID || m.Terminal.DisplayTitle == "" || m.Terminal.Preset != "sh" {
		t.Fatalf("%+v", m.Terminal)
	}
	term := "/api/terminals/" + url.PathEscape(tv.Address)
	e.json("POST", term+"/kill", nil, 200, nil)
	m = ev.untilMsg("finished", isTerminal(tv.Address, "finished"))
	if m.Terminal.FinishedMs == nil {
		t.Fatalf("%+v", m.Terminal)
	}
	e.json("DELETE", term, nil, 204, nil)
	ev.untilMsg("removed", func(m wsMsg) bool { return m.Type == "removed" && m.Address == tv.Address })
}

func TestSessionSurvivesMoriRestart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses /bin/sh")
	}
	c := hctest.Start(t)
	m1, stop1 := runManager(t, c)
	e1 := newTestEnv(t, withManager(m1))
	e1.pair()
	tv := e1.createShell()
	a := e1.client(attachPath(tv.Address))
	a.untilMsg("attached", isType("attached"))
	a.input("MORI_T=survived; echo set-$((4+4))\r")
	a.untilOutput("set-8")

	// Mori stops the way serve does: sockets first, then the core link.
	ctx, cancel := context.WithTimeout(context.Background(), wsWait)
	defer cancel()
	done := make(chan struct{})
	go func() { e1.s.CloseSockets(ctx); close(done) }()
	if code := a.closed(); code != websocket.StatusGoingAway {
		t.Fatal(code)
	}
	<-done
	e1.srv.Close()
	stop1()

	m2, _ := runManager(t, c)
	e2 := newTestEnv(t, withManager(m2), withStore(e1.store))
	e2.token = e1.token
	if v := e2.waitTerminal(tv.Address); v.State != "live" || v.FolderID != tv.FolderID {
		t.Fatalf("%+v", v)
	}
	b := e2.client(attachPath(tv.Address) + "&resumed=1")
	b.untilMsg("attached", isType("attached"))
	b.input("echo $MORI_T-$((1+1))\r")
	b.untilOutput("survived-2")
}
